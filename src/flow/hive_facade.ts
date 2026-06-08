// HiveFacade — the substrate-neutral surface a Flow run() function operates on.
//
// Owns:
//   - spawn (delegates to spawnBeeForFlow; tracks BeeHandle bindings)
//   - send/brief/wait/waitForSeal/kill (delegate to substrate + wait/readiness)
//   - seal (delegates to recordSeal so flows can deposit handoff artifacts)
//   - collect (returns the latest seal for a bee — used by flows that gather)
//   - log (appends to the run's log.txt)
//   - buzSend/buzInbox/buzAwait (delegates to src/buz.ts)
//   - killAll (used for cleanup=kill-on-end at end-of-flow)
//
// Substrate-neutral: BeeHandle has no tmuxTarget; the facade resolves
// substrate via substrateForRecord under the hood. Remote bees Just Work.

import { appendFile } from "node:fs/promises";
import {
  type BuzMessage,
  type BuzSender,
  type BuzTier,
  listMessages,
  sendBuzMessage,
} from "../buz.js";
import { transactionalKill } from "../kill.js";
import { LOCAL_NODE_NAME, loadNodeSync, type NodeRecord } from "../node.js";
import { listSeals, loadLatestSeal, recordSeal, type SealArtifact, type SealRecord } from "../seal.js";
import { resolveSelector } from "../selectors.js";
import { appendLedger, loadSession, saveSession, type SessionRecord } from "../store.js";
import { substrateFor, substrateForRecord } from "../substrates/index.js";
import { spawnBeeForFlow, type SpawnBeeOptions } from "../agents.js";
import { waitForIdle } from "../wait.js";
import { buildLoopConfig } from "../loop/context.js";
import { loopFlow } from "../loop/flow.js";
import {
  ensureLoopDir,
  type LoopConfig,
  readLoopConfig,
  requestStop,
  writeLoopConfig,
} from "../loop/state.js";
import type { BeeHandle, FlowSpawnInput } from "./index.js";
import { cancelRun, spawnDetachedRun } from "./background.js";
import { generateRunId } from "./runs.js";
import { runLogPath } from "./runs.js";

/** Identifier for a bee that the facade can resolve to a SessionRecord. */
export type BeeRef = BeeHandle | string;

export type HiveFacadeOptions = {
  /** Logical name of the flow being executed. */
  flowName: string;
  /** Allocated runId for this execution. */
  runId: string;
  /** Cleanup policy at end-of-flow. */
  cleanup?: "keep" | "kill-on-end";
  /** Optional abort signal forwarded to long-waiting verbs. */
  signal?: AbortSignal;
  /**
   * Override for default swarmId given to spawn() calls.
   * Defaults to `flow:<flowName>:run:<runId>` so the cohort is addressable.
   */
  defaultSwarmId?: string;
};

export type FacadeWaitOptions = {
  idleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
};

export type FacadeSealOptions = {
  timeoutMs?: number;
  pollMs?: number;
};

/** Input to HiveFacade.loop() — the programmatic surface for starting a loop. */
export type LoopSpawnInput = {
  bee: string;
  cwd: string;
  context: "persistent" | "ralph" | "rolling";
  prompt: string;
  until?: string;
  max?: number;
  maxDuration?: string;
  forever?: boolean;
  stopOnSeal?: string;
  stopOnSentinel?: string;
  judge?: string;
  summarizer?: "self" | "bee";
  yolo?: boolean;
};

/**
 * HiveFacade — concrete implementation of the FlowHive interface plus
 * runtime-only surface (buz primitives, collect, killAll). Authored as a
 * class so listeners (SIGINT, cleanup) can call killAll() after the run
 * function resolves or rejects.
 */
export class HiveFacade {
  readonly flowName: string;
  readonly runId: string;
  readonly cleanup: "keep" | "kill-on-end";
  readonly defaultSwarmId: string;
  private readonly signal: AbortSignal | undefined;
  /** Bees the facade has spawned during this run — used for killAll. */
  private readonly spawned: SessionRecord[] = [];

  constructor(options: HiveFacadeOptions) {
    this.flowName = options.flowName;
    this.runId = options.runId;
    this.cleanup = options.cleanup ?? "keep";
    this.signal = options.signal;
    this.defaultSwarmId = options.defaultSwarmId ?? `flow:${options.flowName}:run:${options.runId}`;
  }

  /** Names of every bee spawned during this run. Useful for callers. */
  spawnedNames(): string[] {
    return this.spawned.map((r) => r.name);
  }

  /** ---------------------- spawn ---------------------- */

  async spawn(spec: FlowSpawnInput): Promise<BeeHandle> {
    this.assertNotAborted();
    const node = resolveNode(spec.node);
    const swarmId = spec.swarmId ?? this.defaultSwarmId;
    const cwd = spec.cwd ?? process.cwd();
    const spawnOptions: SpawnBeeOptions = {
      agent: spec.bee,
      extraArgs: [],
      cwd,
      yolo: false,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      ...(spec.colony !== undefined ? { colony: spec.colony } : {}),
      swarmId,
      ...(spec.home !== undefined ? { home: spec.home } : {}),
      ...(node ? { node } : {}),
      runId: this.runId,
      flowName: this.flowName,
    };
    const record = await spawnBeeForFlow(spawnOptions);
    this.spawned.push(record);

    const handle: BeeHandle = {
      id: record.id ?? record.name,
      name: record.name,
      agent: record.agent,
      cwd: record.cwd,
    };
    if (record.node) handle.node = record.node;

    await appendLedger({
      type: "flow.spawn",
      flowName: this.flowName,
      runId: this.runId,
      session: record.name,
      agent: record.agent,
      node: record.node ?? LOCAL_NODE_NAME,
    });

    return handle;
  }

  /** ---------------------- send / brief ---------------------- */

  async send(target: BeeRef, text: string): Promise<void> {
    this.assertNotAborted();
    const record = await this.resolveRecord(target);
    await substrateFor(record).sendText(record.tmuxTarget, text);
    const now = new Date().toISOString();
    await saveSession({ ...record, updatedAt: now, status: "running", lastPrompt: text, lastPromptAt: now });
    await appendLedger({
      type: "flow.send",
      flowName: this.flowName,
      runId: this.runId,
      session: record.name,
      chars: text.length,
    });
  }

  async brief(target: BeeRef, text: string): Promise<void> {
    this.assertNotAborted();
    const record = await this.resolveRecord(target);
    await substrateFor(record).sendText(record.tmuxTarget, text);
    const now = new Date().toISOString();
    await saveSession({
      ...record,
      updatedAt: now,
      status: "running",
      brief: text,
      briefedAt: now,
    });
    await appendLedger({
      type: "flow.brief",
      flowName: this.flowName,
      runId: this.runId,
      session: record.name,
      chars: text.length,
    });
  }

  /** ---------------------- wait / waitForSeal ---------------------- */

  async wait(target: BeeRef, options: FacadeWaitOptions = {}): Promise<void> {
    this.assertNotAborted();
    const record = await this.resolveRecord(target);
    await waitForIdle({
      record,
      idleMs: options.idleMs ?? 3_000,
      timeoutMs: options.timeoutMs ?? 600_000,
      pollMs: options.pollMs ?? 750,
      output: "pane",
      rows: 0,
      json: false,
    });
  }

  /**
   * Poll listSeals for the bee until a new seal appears, or timeoutMs lapses.
   * Mirrors waitForSeal() in cli.ts. Honors the facade abort signal.
   */
  async waitForSeal(target: BeeRef, options: FacadeSealOptions = {}): Promise<SealRecord> {
    this.assertNotAborted();
    const record = await this.resolveRecord(target);
    const timeoutMs = options.timeoutMs ?? 600_000;
    const pollMs = Math.max(100, options.pollMs ?? 1_000);
    const baseline = (await listSeals(record.name))[0]?.sealedAt;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.signal?.aborted) throw new Error(`waitForSeal aborted: ${record.name}`);
      const latest = await loadLatestSeal(record.name);
      if (latest && latest.sealedAt !== baseline) return latest;
      await sleep(pollMs);
    }
    throw new Error(`Timed out waiting for seal on ${record.name} after ${timeoutMs}ms`);
  }

  /** ---------------------- kill ---------------------- */

  async kill(target: BeeRef): Promise<void> {
    this.assertNotAborted();
    const record = await this.resolveRecord(target);
    const outcome = await transactionalKill(record);
    if (!outcome.ok) {
      throw new Error(`kill failed for ${record.name}: ${outcome.lastError}`);
    }
    // Drop from the spawned list so killAll() doesn't double-kill.
    const idx = this.spawned.findIndex((r) => r.name === record.name);
    if (idx >= 0) this.spawned.splice(idx, 1);
  }

  /** ---------------------- seal / collect ---------------------- */

  async seal(target: BeeRef, artifactPath: string): Promise<SealRecord> {
    // The signature mirrors FlowHive.seal: artifactPath is a path to a JSON
    // file containing a SealArtifact. Read + validate happens in src/seal.ts
    // via recordSeal, but we accept either a path or an in-memory artifact
    // object — agents implementing flows may want both.
    const record = await this.resolveRecord(target);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(artifactPath, "utf8");
    const parsed = JSON.parse(raw) as SealArtifact;
    const stored = await recordSeal(record.name, parsed);
    return stored;
  }

  /** Return the latest seal for `target`, or null. */
  async collect(target: BeeRef): Promise<SealRecord | null> {
    const record = await this.resolveRecord(target);
    return loadLatestSeal(record.name);
  }

  /** ---------------------- log ---------------------- */

  async log(message: string): Promise<void> {
    const path = runLogPath(this.flowName, this.runId);
    const stamp = new Date().toISOString();
    await appendFile(path, `[${stamp}] ${message}\n`, { mode: 0o600 });
  }

  /** ---------------------- buz primitives ---------------------- */

  async buzSend(
    target: BeeRef,
    body: string,
    options: { tier?: BuzTier; subject?: string; sender: BuzSender },
  ): Promise<void> {
    this.assertNotAborted();
    const record = await this.resolveRecord(target);
    const tier: BuzTier = options.tier ?? "queue";
    const transport = tier === "interrupt"
      ? { substrate: substrateFor(record), tmuxTarget: record.tmuxTarget }
      : undefined;
    await sendBuzMessage({
      recipient: record,
      sender: options.sender,
      tier,
      body,
      ...(options.subject ? { subject: options.subject } : {}),
      ...(transport ? { transport } : {}),
      ...(record.node ? { node: record.node } : {}),
    });
  }

  async buzInbox(target: BeeRef): Promise<BuzMessage[]> {
    const record = await this.resolveRecord(target);
    const listing = await listMessages(record.name, "inbox");
    return listing.map((entry) => entry.message);
  }

  /**
   * Poll the bee's inbox until a new message arrives or timeoutMs elapses.
   * Returns the new message. Honors the facade abort signal.
   */
  async buzAwait(target: BeeRef, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<BuzMessage> {
    const record = await this.resolveRecord(target);
    const timeoutMs = options.timeoutMs ?? 600_000;
    const pollMs = Math.max(100, options.pollMs ?? 1_000);
    const baseline = (await listMessages(record.name, "inbox"))[0]?.message.id;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.signal?.aborted) throw new Error(`buzAwait aborted: ${record.name}`);
      const top = (await listMessages(record.name, "inbox"))[0]?.message;
      if (top && top.id !== baseline) return top;
      await sleep(pollMs);
    }
    throw new Error(`Timed out waiting for buz message to ${record.name} after ${timeoutMs}ms`);
  }

  /** ---------------------- loop ---------------------- */

  /**
   * Start a detached loop — the in-flow / in-agent surface mirroring
   * `hive loop start`. Pre-allocates a loopId (== runId), writes the initial
   * loop.json, then spawns the built-in `loop` flow as a detached background
   * run. Returns the loopId immediately; the while-loop driver runs in the
   * child, not inline. Validates the spec eagerly so callers surface bad input
   * before a process is forked.
   */
  async loop(spec: LoopSpawnInput): Promise<string> {
    const loopId = generateRunId();
    // Build/validate the config eagerly; buildLoopConfig throws on bad input.
    const cfg = buildLoopConfig({ ...(spec as Record<string, unknown>), loopId });
    cfg.loopId = loopId;
    await ensureLoopDir(loopId);
    await writeLoopConfig(cfg);
    const args = loopArgsFromSpec(spec, loopId);
    await spawnDetachedRun(loopFlow, args, { runId: loopId });
    await appendLedger({ type: "loop.start", loopId, bee: cfg.bee, context: cfg.context });
    return loopId;
  }

  /** Read a loop's current config + live state, or null if unknown. */
  async loopStatus(loopId: string): Promise<LoopConfig | null> {
    return readLoopConfig(loopId);
  }

  /**
   * Stop a loop. Default is graceful (write the stop-request sentinel; the
   * driver halts after the current iteration). `now:true` cancels the detached
   * run immediately (SIGTERM→SIGKILL on the process group), killing the
   * in-flight bee.
   */
  async loopStop(loopId: string, opts: { now?: boolean } = {}): Promise<void> {
    if (opts.now) {
      await cancelRun("loop", loopId);
      return;
    }
    await requestStop(loopId);
  }

  /** ---------------------- killAll ---------------------- */

  /**
   * Kill every bee spawned by this facade in best-effort fashion. Used by
   * flow cleanup=kill-on-end and by SIGINT handlers. Errors are logged but
   * not re-thrown — we want all spawned bees attempted even when one fails.
   */
  async killAll(): Promise<{ killed: string[]; failed: { name: string; error: string }[] }> {
    const killed: string[] = [];
    const failed: { name: string; error: string }[] = [];
    // Snapshot the list so we can mutate it while iterating.
    const snapshot = [...this.spawned];
    for (const record of snapshot) {
      try {
        const fresh = await loadSession(record.name);
        if (!fresh) continue;
        const outcome = await transactionalKill(fresh);
        if (outcome.ok) {
          killed.push(record.name);
          const idx = this.spawned.findIndex((r) => r.name === record.name);
          if (idx >= 0) this.spawned.splice(idx, 1);
        } else {
          failed.push({ name: record.name, error: outcome.lastError });
        }
      } catch (error) {
        failed.push({ name: record.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { killed, failed };
  }

  /** ---------------------- internals ---------------------- */

  private assertNotAborted(): void {
    if (this.signal?.aborted) throw new Error(`Flow ${this.flowName} (run ${this.runId}) aborted`);
  }

  /**
   * Resolve a BeeRef into the latest SessionRecord. Accepts:
   *  - BeeHandle: looks up by id, falling back to name
   *  - string: routed through resolveSelector (must yield a single bee)
   */
  private async resolveRecord(target: BeeRef): Promise<SessionRecord> {
    if (typeof target === "string") {
      const resolved = await resolveSelector(target);
      if (resolved.kind !== "bee") {
        throw new Error(`HiveFacade target must resolve to a single bee, got ${resolved.kind}: ${target}`);
      }
      return resolved.record;
    }
    // BeeHandle: spawn always tracks by name; prefer name lookup first since
    // it is the unique session-record key.
    const byName = await loadSession(target.name);
    if (byName) return byName;
    // Fallback: try to resolve by id via the selector.
    const ref = target.id ?? target.name;
    const resolved = await resolveSelector(ref);
    if (resolved.kind !== "bee") throw new Error(`Could not resolve bee handle: ${ref}`);
    return resolved.record;
  }
}

function resolveNode(name: string | undefined): NodeRecord | undefined {
  if (!name || name === LOCAL_NODE_NAME) return undefined;
  const node = loadNodeSync(name);
  if (!node) throw new Error(`Unknown node: ${name}`);
  return node;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Translate a LoopSpawnInput into the flow arg record consumed by loopFlow.
 * Only defined fields are forwarded so loopFlow's arg defaults still apply.
 */
function loopArgsFromSpec(spec: LoopSpawnInput, loopId: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    bee: spec.bee,
    cwd: spec.cwd,
    context: spec.context,
    prompt: spec.prompt,
    loopId,
  };
  if (spec.until !== undefined) args.until = spec.until;
  if (spec.max !== undefined) args.max = spec.max;
  if (spec.maxDuration !== undefined) args.maxDuration = spec.maxDuration;
  if (spec.forever !== undefined) args.forever = spec.forever;
  if (spec.stopOnSeal !== undefined) args.stopOnSeal = spec.stopOnSeal;
  if (spec.stopOnSentinel !== undefined) args.stopOnSentinel = spec.stopOnSentinel;
  if (spec.judge !== undefined) args.judge = spec.judge;
  if (spec.summarizer !== undefined) args.summarizer = spec.summarizer;
  if (spec.yolo !== undefined) args.yolo = spec.yolo;
  return args;
}

// Re-export for cli/tests so callers don't have to import substrateForRecord
// directly when threading through the facade.
export { substrateForRecord };
