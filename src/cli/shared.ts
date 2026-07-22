// Reusable CLI helpers shared across command modules (HIVE-15 decomposition).
// Flag/env parsing, session resolution, spawn support, substrate resolution,
// brief delivery, and per-bee state-context building. No command handlers live
// here — those are in src/commands/*.ts; this module holds only the pieces they
// share so cli.ts stays a thin dispatcher.
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { autoAccountTool, type AccountRecord } from "../accounts.js";
import { agentDefaultsToYolo, canonicalAgentKind } from "../agents.js";
import { parseAge } from "../clean.js";
import { loadColony } from "../colony.js";
import { mapWithConcurrency } from "../concurrency.js";
import { beeConfig, briefFooter, spawnDefaultSubstrate } from "../config.js";
import { autoAliasForcesYolo, bootMsForAgent } from "../drivers.js";
import { actionLine, bold, cyan, dim, formatRelativeTime, green, isPretty, note, red, tildify, yellow } from "../format.js";
import { writeHiveState } from "../hiveState.js";
import { hsrObservations, type HsrObservation } from "../hsr/observe.js";
import { enqueueTurnForBootingHsrHost } from "../hsr/pendingTurns.js";
import { matchesSessionReference } from "../ids.js";
import { LOCAL_NODE_NAME, loadNode, loadNodeSync, supportsCapability, type NodeRecord } from "../node.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { AgentReadinessError, waitForAgentReady } from "../readiness.js";
import { sealedBeeNames as sealedBeeNamesImpl } from "../seal.js";
import { ensureSessionLive } from "../sessionLiveness.js";
import { liveTargetKey, type BeeState, type StateContext } from "../state.js";
import { appendLedger, listSessions, loadSession, updateSession, type SessionRecord } from "../store.js";
import { localSubstrate, substrateFor, substrateForRecord } from "../substrates/index.js";
import { generateSwarmId, validSwarmId } from "../swarm.js";
import { tmux } from "../tmux.js";

export const VERSION = "0.0.1";

export const APP_NAME = "hive";


/**
 * `--ttl <age>`: maximum acceptable age for cached provider limits (e.g. 30m,
 * 2h; 0 forces a live read). Undefined when the flag is absent, so callers
 * keep their own defaults (limits: live; auto pick: 1h).
 */
export function ttlFlagMs(parsed: Parsed): number | undefined {
  const raw = flag(parsed, "ttl");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("--ttl needs a duration (e.g. 30m, 2h; 0 forces a live read)");
  if (raw.trim() === "0") return 0;
  return parseAge(raw);
}


/** `--include-paused`: let the auto/rr pools consider paused accounts (excluded by default). */
export function includePausedFlag(parsed: Parsed): boolean {
  return truthy(flag(parsed, "include-paused"));
}


/**
 * Gate spawn-side commands (spawn/x/xa/open/fork) on a paused account: the
 * account stays usable, but only deliberately. `--yes` skips the question
 * (`--include-paused` too — asking for paused pool members and then vetoing
 * the pick would be circular); an interactive session asks y/N; a non-TTY
 * caller gets a hard error naming the resume command. No-op when no account
 * is bound or the account is active.
 */
export async function confirmPausedAccount(account: AccountRecord | undefined, parsed: Parsed): Promise<void> {
  if (!account?.pausedAt) return;
  const since = formatRelativeTime(account.pausedAt);
  if (truthy(flag(parsed, "yes")) || includePausedFlag(parsed)) {
    console.error(actionLine("warn", "account", [bold(account.id), `paused ${since} ago — proceeding`]));
    return;
  }
  const resumeHint = `resume with: hive account resume ${account.id}`;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(`Account ${account.id} is paused (${since} ago); ${resumeHint}, or pass --yes to use it anyway`);
  }
  // The question goes to stderr: spawn's stdout is machine-readable
  // (`name\tagent\tcwd`) and must stay clean for pipelines.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let answer: string;
  try {
    const mark = isPretty() ? yellow("⚠") : "!";
    answer = (await rl.question(`${mark} account ${bold(account.id)} was paused ${since} ago — use it anyway? [y/N] `)).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (answer === "y" || answer === "yes") return;
  throw new Error(`Aborted: account ${account.id} is paused; ${resumeHint}`);
}


export async function deliverBrief(parsed: Parsed, record: SessionRecord, briefText: string): Promise<SessionRecord> {
  // HSR bees have no pane to scrape for readiness; their brief rides the
  // durable pending-turn queue (deliverPromptText) and is handed to the harness
  // when its host finishes booting.
  if (record.substrate !== "hsr") {
    try {
      await waitForAgentReady(record, {
        timeoutMs: numberFlag(parsed, ["boot-ms"], bootMsForAgent(record.agent)),
        acceptTrust: acceptsTrust(parsed),
        raiseDroidAutonomy: dangerousMode(parsed, record.agent, record.requestedAgent),
      });
    } catch (error) {
      if (!(error instanceof AgentReadinessError) || error.reason !== "timeout" || !truthy(flag(parsed, "force-send"))) throw error;
      console.error(actionLine("warn", "force", [`readiness timeout for ${bold(record.name)}, briefing anyway`]));
    }
  }
  const delivered = augmentBrief(parsed, briefText);
  await deliverPromptText(record, delivered);
  await writeHiveState(record, "working");
  const now = new Date().toISOString();
  const persisted = await updateSession(record.name, {
    updatedAt: now,
    status: "running",
    brief: briefText,
    briefedAt: now,
    lastPrompt: delivered,
    lastPromptAt: now,
  });
  if (!persisted) {
    // The record vanished mid-brief (concurrent kill/clean). The text was
    // already delivered to the pane, but nothing recorded it — say so instead
    // of silently returning an in-memory merge that looks persisted.
    console.error(note(`warn ${record.name}: session record disappeared while briefing; brief delivered but not recorded`));
  }
  const updated: SessionRecord = persisted ?? {
    ...record,
    updatedAt: now,
    status: "running",
    brief: briefText,
    briefedAt: now,
    lastPrompt: delivered,
    lastPromptAt: now,
  };
  await appendLedger({ type: "brief", session: record.name, agent: record.agent, node: record.node ?? LOCAL_NODE_NAME, chars: delivered.length, briefChars: briefText.length });
  if (isPretty()) console.log(actionLine("ok", "brief", [bold(record.name), `${briefText.length} chars`]));
  else console.log(`briefed\t${record.name}\t${briefText.length} chars`);
  return updated;
}


export async function deliverSpawnBrief(parsed: Parsed, record: SessionRecord, briefText: string): Promise<{ record: SessionRecord; sent: boolean }> {
  try {
    return { record: await deliverBrief(parsed, record, briefText), sent: true };
  } catch (error) {
    if (!(error instanceof AgentReadinessError)) throw error;
    warnSpawnReadiness(record, error);
    return { record, sent: false };
  }
}


export function warnSpawnReadiness(record: SessionRecord, error: AgentReadinessError): void {
  if (isPretty()) console.error(actionLine("warn", "spawn", [`${bold(record.name)} not confirmed ready (${error.reason})`]));
  else console.error(`warn\tspawn\t${record.name}\t${error.reason}`);
}


/**
 * How long HSR prompt delivery keeps retrying while the runner host boots.
 * Codex's bounded app-server respawn/backoff handshake can legitimately take
 * over 30s when its online model refresh is slow, especially in burst spawns.
 */
export const HSR_PROMPT_BOOT_TIMEOUT_MS = 90_000;

/**
 * Retry `attempt` with backoff until it succeeds or `timeoutMs` lapses, then
 * rethrow the last error. Built for the HSR host-boot race: the detached
 * runner host takes seconds to write meta + open its control socket (longer
 * under burst spawns, where host boots serialize), so any error inside the
 * boot window — "no live runner host", a connect refusal on a not-yet-listening
 * socket — is treated as transient. Backoff: 250ms doubling to a 2s cap,
 * clamped to the remaining budget. `onRetry` fires once, on the first failure.
 */
export async function retryWhileHsrHostBoots<T>(
  attempt: () => Promise<T>,
  opts: { timeoutMs?: number; sleepFn?: (ms: number) => Promise<unknown>; onRetry?: (error: unknown) => void } = {},
): Promise<T> {
  const wait = opts.sleepFn ?? sleep;
  const deadline = Date.now() + (opts.timeoutMs ?? HSR_PROMPT_BOOT_TIMEOUT_MS);
  let delayMs = 250;
  let retried = false;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      if (!retried) {
        retried = true;
        opts.onRetry?.(error);
      }
      await wait(Math.min(delayMs, remaining));
      delayMs = Math.min(delayMs * 2, 2_000);
    }
  }
}

/** Send a prompt, tolerating a detached HSR host's bounded startup window. */
export async function deliverPromptText(record: SessionRecord, prompt: string): Promise<void> {
  const substrate = substrateFor(record);
  const attempt = () => substrate.sendText(record.tmuxTarget, prompt, record.agentPaneId);
  if (substrate.kind !== "hsr" && substrate.kind !== "remote-hsr") {
    await attempt();
    return;
  }
  // Local HSR fast path: spawn no longer waits for the detached host's cold
  // start, so a fresh bee's first prompt usually arrives before meta.json
  // exists. The pending-turn queue is durable from birth — persist the turn and
  // return instead of polling the boot. (remote-hsr keeps the retry loop:
  // runnerPid there is a pid on the remote node, unverifiable here.)
  if (substrate.kind === "hsr" && record.runnerPid !== undefined) {
    if (await enqueueTurnForBootingHsrHost(record.tmuxTarget, record.runnerPid, prompt)) return;
  }
  await retryWhileHsrHostBoots(attempt, {
    onRetry: () => {
      if (isPretty()) console.error(actionLine("warn", "send", [bold(record.name), "waiting for the hsr runner host to boot"]));
      else console.error(`wait\tsend\t${record.name}\thsr runner host still booting`);
    },
  });
}

/**
 * Deliver an initial prompt to a freshly spawned HSR bee over its control
 * socket, WITHOUT a readiness poll.
 *
 * HSR adapters ignore a caller prompt in argv: server-tier codex runs
 * `codex app-server` (fixed argv — CODEX_APP_SERVER_ARGS — turns start only on
 * a `turn/start` RPC) and stream-tier claude runs `claude -p --input-format
 * stream-json` (turns arrive only as stdin JSON; an argv prompt is ignored and
 * the child waits forever). So a prompt handed to `hive spawn <bee> "…"` was
 * silently dropped and the bee wedged in "booting". This delivers it through
 * the same `sendText` → `send` RPC path `hive x`/`hive run` use
 * (deliverPromptToBee) — the only channel an HSR bee acts on.
 *
 * No `waitForAgentReady`: HSR bees have no pane to scrape. And the runner host
 * is NOT guaranteed live yet — spawnBee returns as soon as the record is
 * durable, without waiting for the detached host's cold start. deliverPromptText
 * handles that window: it persists the turn into the host's pending-turn queue
 * (enqueueTurnForBootingHsrHost) and falls back to a bounded retry only when
 * the queue is not usable, so spawn+prompt stays atomic across host boot.
 */
export async function deliverHsrPrompt(record: SessionRecord, prompt: string): Promise<SessionRecord> {
  await deliverPromptText(record, prompt);
  await writeHiveState(record, "working");
  const now = new Date().toISOString();
  const persisted = await updateSession(record.name, { updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now });
  await appendLedger({ type: "prompt.run", session: record.name, agent: record.agent, node: record.node ?? LOCAL_NODE_NAME, cwd: record.cwd, chars: prompt.length });
  if (isPretty()) console.log(actionLine("ok", "send", [bold(record.name), `${prompt.length} chars`]));
  else console.log(`sent\t${record.name}\t${prompt.length} chars`);
  return persisted ?? { ...record, updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now };
}


/**
 * After a bare spawn, wait for the freshly spawned bee to reach its prompt,
 * auto-accepting any startup trust/safety prompt along the way (e.g. codex's
 * "Do you trust the contents of this directory?"). Without this, a plain
 * `hive spawn codex` sits forever at the trust prompt with nobody to press
 * Enter. The bee is already spawned and persisted, so readiness problems are
 * surfaced as warnings rather than failing the spawn. Opt out of the wait with
 * `--no-wait`, or out of trust acceptance specifically with `--no-accept-trust`.
 */
export async function confirmSpawnReady(parsed: Parsed, record: SessionRecord): Promise<void> {
  if (truthy(flag(parsed, "no-wait"))) return;
  // HSR bees have no interactive TUI to poll — the runner host was already
  // confirmed live at spawn. Mark it waiting (its "ready" state) and return.
  if (record.substrate === "hsr") {
    await writeHiveState(record, "waiting");
    return;
  }
  // Remote-HSR bees likewise have no pane: the spawn RPC already confirmed the
  // remote runner-host forked the bee, so the pane readiness poll below would
  // always time out and emit a spurious "warn spawn <bee> timeout".
  if (record.node && record.node !== LOCAL_NODE_NAME && loadNodeSync(record.node)?.kind === "remote-hsr") {
    await writeHiveState(record, "waiting");
    return;
  }
  try {
    await waitForAgentReady(record, {
      timeoutMs: numberFlag(parsed, ["boot-ms"], bootMsForAgent(record.agent)),
      acceptTrust: acceptsTrust(parsed),
      raiseDroidAutonomy: dangerousMode(parsed, record.agent, record.requestedAgent),
    });
    // The agent reached its prompt: it is waiting for input until briefed/prompted.
    await writeHiveState(record, "waiting");
  } catch (error) {
    if (!(error instanceof AgentReadinessError)) throw error;
    warnSpawnReadiness(record, error);
  }
}


export async function confirmSpawnReadyAll(parsed: Parsed, records: SessionRecord[]): Promise<void> {
  if (truthy(flag(parsed, "no-wait"))) return;
  await Promise.all(records.map((record) => confirmSpawnReady(parsed, record)));
}


export function augmentBrief(parsed: Parsed, briefText: string): string {
  if (truthy(flag(parsed, "no-wait-footer")) || truthy(flag(parsed, "no-footer"))) return briefText;
  const customFooter = flag(parsed, "wait-footer") ?? flag(parsed, "footer");
  const footer = typeof customFooter === "string" ? customFooter : briefFooter();
  if (!footer) return briefText;
  return briefText.endsWith(footer) ? briefText : `${briefText}${footer}`;
}


export async function resolveSpawnCwd(parsed: Parsed, profileCwd?: string): Promise<string> {
  // Precedence FLAG > PROFILE > process cwd.
  const requested = resolve((stringFlag(parsed, ["cwd"]) ?? profileCwd ?? process.cwd()).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  return realpath(requested);
}


export function resolveSwarmIdHint(parsed: Parsed, prefix?: string): string {
  const explicit = flag(parsed, "swarm-id") ?? flag(parsed, "swarm");
  if (typeof explicit === "string") {
    if (!validSwarmId(explicit)) throw new Error(`Invalid swarm id: ${explicit}`);
    return explicit;
  }
  return generateSwarmId(prefix);
}


export const DEFAULT_NODE_PROBE_TIMEOUT_MS = 2_500;


export type MultiNodeLiveProbe = {
  /** Live tmux sessions keyed by liveTargetKey(node, target). */
  liveTargets: Set<string>;
  unreachableNodes: Set<string>;
  perNode: Map<string, string[]>;
  /** Live @hive_state per session, keyed like liveTargets (empty string when unset). */
  states: Map<string, string>;
};


export async function liveTargetsAcrossNodes(nodes: NodeRecord[], nodeFilter?: string): Promise<MultiNodeLiveProbe> {
  const rawTimeout = Number(process.env.HIVE_NODE_PROBE_MS ?? DEFAULT_NODE_PROBE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_NODE_PROBE_TIMEOUT_MS;
  const liveTargets = new Set<string>();
  const unreachableNodes = new Set<string>();
  const perNode = new Map<string, string[]>();
  const states = new Map<string, string>();
  const targetNodes = nodeFilter ? nodes.filter((n) => n.name === nodeFilter) : nodes;
  const queries = targetNodes.map(async (node) => {
    try {
      const substrate = substrateForRecord(node);
      // probe() distinguishes reachable-but-empty (returns []) from unreachable
      // (returns { ok: false }). listSessions() alone hides this because the
      // local-tmux/ssh-tmux implementations return [] on any failure mode.
      const probeResult = await withTimeout(substrate.probe(), timeoutMs);
      if (!probeResult.ok) {
        unreachableNodes.add(node.name);
        return;
      }
      // One list-sessions call per node delivers liveness AND live @hive_state.
      const result = await withTimeout(substrate.listSessionStates(), timeoutMs);
      perNode.set(node.name, [...result.keys()]);
      for (const [target, state] of result) {
        const key = liveTargetKey(node.name, target);
        liveTargets.add(key);
        states.set(key, state);
      }
    } catch {
      unreachableNodes.add(node.name);
    }
  });
  await Promise.allSettled(queries);
  return { liveTargets, unreachableNodes, perNode, states };
}


export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}


export function formatHiveStateCell(state: string): string {
  switch (state) {
    case "working":
      return `${green("●")} ${green(state)}`;
    case "waiting":
      return `${yellow("●")} ${yellow(state)}`;
    case "done":
      return `${dim("●")} ${state}`;
    case "failed":
      return `${red("●")} ${red(state)}`;
    default:
      return `${dim("●")} ${state}`;
  }
}


// Each capture forks a subprocess (tmux locally, a full ssh round-trip for
// remote bees), so an uncapped fan-out over a large hive spawns dozens of
// simultaneous ssh connections per `hive ls`/clean pass (HIVE-62).
export const PANE_CAPTURE_CONCURRENCY = 8;


export async function capturePanesFor(records: SessionRecord[], liveTargets: Set<string>): Promise<Map<string, string>> {
  const liveRecords = records.filter((record) => liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)));
  const entries = await mapWithConcurrency(
    liveRecords,
    PANE_CAPTURE_CONCURRENCY,
    // Re-key by the bee's own pane (agentPaneId) so sub-bees sharing one comb's
    // tmuxTarget keep distinct captures; legacy solo bees with no pane fall back
    // to tmuxTarget. deriveState reads with the same `agentPaneId ?? tmuxTarget`.
    async (record) => [record.agentPaneId ?? record.tmuxTarget, await substrateFor(record).capture(record.tmuxTarget, 80, record.agentPaneId).catch(() => "")] as const,
  );
  return new Map(entries);
}


export async function listSealedBeeNames(records?: readonly SessionRecord[]): Promise<Set<string>> {
  return sealedBeeNamesImpl(records).catch(() => new Set<string>());
}


/**
 * Fold the run-dir HSR observations into the StateContext slices. HSR bees are
 * pane-less — observed from run dirs, not tmux. Best-effort: a bad/absent HSR
 * root never breaks the tmux path. Also used standalone by `clean --dead`,
 * which needs HSR liveness without a full StateContext.
 */
export async function observeHsrLiveness(): Promise<{ hsrLive: Set<string>; hsrStates: Map<string, BeeState>; hsrSnapshots: Map<string, string> }> {
  const hsrObs = await hsrObservations().catch(() => new Map<string, HsrObservation>());
  const hsrLive = new Set<string>();
  const hsrStates = new Map<string, BeeState>();
  const hsrSnapshots = new Map<string, string>();
  for (const [bee, observation] of hsrObs) {
    if (observation.live) hsrLive.add(bee);
    if (observation.state) hsrStates.set(bee, observation.state);
    hsrSnapshots.set(bee, observation.snapshot);
  }
  return { hsrLive, hsrStates, hsrSnapshots };
}


/**
 * Assemble the full StateContext for deriveState from one node-probe pass.
 * Every liveness input — captured panes, seal markers, local pane ids, and the
 * pane-less HSR run-dir observations — is gathered here and ONLY here, so
 * list/TUI/clean can never drift on which inputs feed deriveState (the clean
 * path once omitted the HSR observations and reaped live HSR bees — HIVE-1).
 * `unreachableNodes` overrides the probe's set for callers that widen it
 * (clean treats unregistered nodes as unreachable, never dead).
 */
export async function buildStateContext(
  records: SessionRecord[],
  probe: MultiNodeLiveProbe,
  options: { unreachableNodes?: Set<string> } = {},
): Promise<StateContext & { hsrLive: Set<string>; now: number }> {
  const panes = await capturePanesFor(records, probe.liveTargets);
  const seals = await listSealedBeeNames(records);
  const livePanes = await localSubstrate().listPanes().catch(() => new Set<string>());
  const { hsrLive, hsrStates, hsrSnapshots } = await observeHsrLiveness();
  return {
    liveTargets: probe.liveTargets,
    livePanes,
    panes,
    seals,
    unreachableNodes: options.unreachableNodes ?? probe.unreachableNodes,
    hsrLive,
    hsrStates,
    hsrSnapshots,
    now: Date.now(),
  };
}


/**
 * Resolve the bee owning the current tmux pane:
 *   1. $TMUX_PANE → match a record by agentPaneId (the precise, pane-pinned path)
 *   2. fallback: tmux display-message → the bee whose tmuxTarget is this session
 *      (solo combs / legacy bees that were never pinned)
 * Returns undefined when not inside tmux or no record matches.
 */
export async function resolveBeeInCurrentPane(): Promise<SessionRecord | undefined> {
  const records = await listSessions();
  // HIVE_BEE is stamped into every HSR child env (and can be added to tmux
  // spawns too), so `hive here`/`hive fork`/self-seal resolve the current bee
  // pane-lessly (APIA-82). It takes precedence — it is the most direct signal.
  const hiveBee = process.env.HIVE_BEE;
  if (hiveBee && hiveBee.length > 0) {
    const byEnv = records.find((record) => record.name === hiveBee);
    if (byEnv) return byEnv;
  }
  if (!process.env.TMUX) return undefined;
  const paneId = process.env.TMUX_PANE;
  if (paneId && paneId.length > 0) {
    const byPane = records.find((record) => record.agentPaneId === paneId);
    if (byPane) return byPane;
  }
  const sessionName = await currentTmuxSessionName();
  if (sessionName) {
    const bySession = records.find((record) => record.tmuxTarget === sessionName && !record.node);
    if (bySession) return bySession;
  }
  return undefined;
}


/**
 * Whether this process is running INSIDE a bee — the agent-origin signal for
 * resolveSpawnSubstrate. Unlike resolveBeeInCurrentPane, this requires a
 * DIRECT anchor: the HIVE_BEE stamp (HSR children) or TMUX_PANE matching a
 * bee's own agent pane (a tmux bee's subprocesses inherit its pane id). The
 * session-name fallback is deliberately not consulted: a display-popup
 * (tmux strips TMUX_PANE from popup commands) or an operator shell pane
 * inside a comb shares the bee's session without BEING the bee, and treating
 * those as agent spawns routed human picks onto pane-less HSR where no prompt
 * ever arrives (stuck "booting").
 */
export async function spawnOriginIsAgent(): Promise<boolean> {
  const hiveBee = process.env.HIVE_BEE;
  const paneId = process.env.TMUX ? process.env.TMUX_PANE : undefined;
  if (!hiveBee && !paneId) return false;
  // HIVE_BEE names the record directly (HSR children — the agent-spawn hot
  // path): one record read instead of a full store scan.
  if (hiveBee && (await loadSession(hiveBee))) return true;
  if (!paneId) return false;
  const records = await listSessions();
  return records.some((record) => record.agentPaneId === paneId);
}


/** The session name of the current pane, via `tmux display-message`. */
export async function currentTmuxSessionName(): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined;
  const result = await tmux(["display-message", "-p", "#{session_name}"], { reject: false });
  if (result.ok) {
    const name = result.stdout.trim();
    return name.length > 0 ? name : undefined;
  }
  return undefined;
}


/**
 * Whether the DEFAULT substrate (the implicit/aliased "local" node) is ssh-tmux.
 *
 * The pickers and explicit-selector verbs read the LOCAL store but, run from a
 * `display-popup` under `ssh-tmux`, execute in the *remote* shell — so they must
 * hard-error rather than target the wrong fleet (KEYBINDINGS_PRD §8.1/§13).
 *
 * The ONLY reliable runtime signal is the same one `substrateForNode` honors:
 * the operator explicitly aliasing the local node to a remote endpoint
 * (`hive node register local --kind ssh-tmux …`). hive running on the local box
 * always otherwise sees `local-tmux`; there is no in-band signal that a given
 * tmux client is itself the far end of someone else's ssh-tmux popup. We guard
 * on the alias signal and accept that limitation (documented here per §13): a
 * popup opened on a remote host whose local node is plain local-tmux is not
 * detectable from inside hive and is the operator's collision call.
 */
export function defaultSubstrateIsSshTmux(): boolean {
  const overlay = loadNodeSync(LOCAL_NODE_NAME, { tolerateInvalid: true });
  return overlay?.kind === "ssh-tmux";
}


export function assertLocalFleetReadable(verb: string): void {
  if (defaultSubstrateIsSshTmux()) {
    // dim stderr + non-zero so a popup's `xargs -r` no-ops and the popup closes.
    throw new Error(
      `hive ${verb}: refusing to run under an ssh-tmux default substrate — ` +
        `pickers read the LOCAL store and would target the wrong fleet (§13).`,
    );
  }
}


/**
 * Consistent `-n/--lines` parsing for the flow/loop/daemon log commands (they
 * had each grown their own variant): first of -n/--lines wins, non-negative
 * integers only, anything else falls back.
 */
export function logLinesFlag(parsed: Parsed, fallback: number): number {
  const n = numberFlag(parsed, ["n", "lines"], fallback);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}


/** Consistent `-f/--follow` parsing for the loop/daemon log commands. */
export function followFlag(parsed: Parsed): boolean {
  return truthy(flag(parsed, "follow")) || truthy(flag(parsed, "f"));
}


/**
 * Shared flow/loop log emitter: trim to the last `lines` lines (0/omitted =
 * the full log), newline-terminate, and hint the on-disk path for tail -f
 * users on pretty stderr.
 */
export async function emitLog(opts: { text: string; path: string; lines?: number }): Promise<void> {
  let text = opts.text;
  if (opts.lines !== undefined && opts.lines > 0) {
    const parts = text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    text = parts.slice(-opts.lines).join("\n");
  }
  process.stdout.write(text);
  if (text.length > 0 && !text.endsWith("\n")) process.stdout.write("\n");
  if (isPretty(process.stderr)) console.error(dim(`# ${opts.path}`));
}


/**
 * `--substrate hsr` (or bare `hsr` / `hsr:local`) selects the local runner-host
 * substrate. HSR is NOT a node, so callers short-circuit node resolution when
 * this is true and set opts.substrate="hsr" instead.
 */
export function hsrSubstrateRequested(parsed: Parsed): boolean {
  const raw = flag(parsed, "substrate");
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "hsr" || trimmed === "hsr:local";
}


/**
 * Resolve which substrate a `hive spawn`/`x`/`new` bee lands on
 * (HSR_EXPLORATION.md §5). Precedence, highest first:
 *   1. Explicit `--substrate hsr` (or `hsr:local`)            → HSR.
 *   2. Explicit `--substrate local|tmux|ssh:...` or `--node`  → tmux (node
 *      resolution). An explicit choice by an agent overrides the agent default.
 *   3. Nothing explicit → origin default: agent-initiated spawns (the spawning
 *      process is itself a bee — a direct HIVE_BEE/agent-pane anchor, see
 *      spawnOriginIsAgent) follow `spawn.defaultSubstrate.agent` (default
 *      "hsr"); human/terminal spawns follow `.user` (default "local-tmux").
 * Only the `spawnSingleBee` path uses this; flows/swarms/fork keep prior
 * behavior for now (follow-ups: APIA-85 fork, flow/swarm defaults).
 */
export async function resolveSpawnSubstrate(parsed: Parsed, agentKind: string): Promise<{ useHsr: boolean; node?: NodeRecord }> {
  if (hsrSubstrateRequested(parsed)) return { useHsr: true };
  const substrateFlag = flag(parsed, "substrate");
  const nodeFlag = flag(parsed, "node");
  const explicitSubstrate = typeof substrateFlag === "string" && substrateFlag.trim().length > 0;
  const explicitNode = typeof nodeFlag === "string" && nodeFlag.trim().length > 0;
  if (explicitSubstrate || explicitNode) {
    // An explicit non-hsr substrate or node forces tmux — even for agents, so a
    // bee can opt its child back onto a visible pane with `--substrate tmux`.
    return { useHsr: false, node: await resolveSpawnNode(parsed, agentKind) };
  }
  const origin = (await spawnOriginIsAgent()) ? "agent" : "user";
  const want = spawnDefaultSubstrate(origin);
  if (want === "hsr") {
    // Discoverability: the origin default (not an explicit flag) chose HSR.
    if (origin === "agent" && isPretty()) {
      console.error(note("agent-context spawn -> HSR (pane-less); use --substrate tmux to override"));
    }
    return { useHsr: true };
  }
  return { useHsr: false, node: await resolveSpawnNode(parsed, agentKind) };
}


export function parseSubstrateAlias(value: string): { kind?: NodeRecord["kind"]; node: string } {
  // Accepts both "<kind>:<node>" (e.g. "ssh:mini01", "local:local") and bare "<node>" forms.
  const trimmed = value.trim();
  if (!trimmed) return { node: LOCAL_NODE_NAME };
  const idx = trimmed.indexOf(":");
  if (idx === -1) {
    // Bare "tmux"/"local"/"local-tmux" are a substrate choice meaning "force the
    // local tmux node", not a node name to look up.
    const kind = substrateKindForAlias(trimmed.toLowerCase());
    if (kind === "local-tmux") return { kind, node: LOCAL_NODE_NAME };
    return { node: trimmed };
  }
  const kindRaw = trimmed.slice(0, idx).trim();
  const node = trimmed.slice(idx + 1).trim();
  if (!node) throw new Error(`Invalid --substrate "${value}": missing node name after the kind prefix (e.g. ssh:mini01)`);
  if (!kindRaw) return { node };
  const kind = substrateKindForAlias(kindRaw);
  if (!kind) throw new Error(`Invalid --substrate "${value}": unknown kind "${kindRaw}" (use local: or ssh:)`);
  return { kind, node };
}


export function substrateKindForAlias(alias: string): NodeRecord["kind"] | undefined {
  if (alias === "ssh" || alias === "ssh-tmux") return "ssh-tmux";
  if (alias === "local" || alias === "local-tmux" || alias === "tmux") return "local-tmux";
  return undefined;
}


export async function resolveSpawnNode(parsed: Parsed, agentKind: string): Promise<NodeRecord> {
  const nodeFlag = flag(parsed, "node");
  const substrateFlag = flag(parsed, "substrate");
  let requested: string;
  let requestedKind: NodeRecord["kind"] | undefined;
  if (typeof substrateFlag === "string" && substrateFlag.length > 0) {
    const alias = parseSubstrateAlias(substrateFlag);
    requested = alias.node;
    requestedKind = alias.kind;
  } else if (typeof nodeFlag === "string" && nodeFlag.length > 0) {
    requested = nodeFlag;
  } else {
    requested = LOCAL_NODE_NAME;
  }
  const node = await loadNode(requested);
  if (!node) throw new Error(`Unknown node: ${requested}. Register it with: hive node register ${requested} --kind ssh-tmux --endpoint user@host`);
  if (requestedKind && node.kind !== requestedKind) {
    throw new Error(`--substrate ${substrateFlag} requests kind ${requestedKind}, but node "${node.name}" is ${node.kind}`);
  }
  if (!supportsCapability(node, agentKind)) {
    throw new Error(
      `Node "${node.name}" does not list capability "${agentKind}". Either update it with: hive node update ${node.name} --capabilities ${[...node.capabilities.filter((c) => c !== "*"), agentKind].join(",")}, or pick a different node.`,
    );
  }
  return node;
}


export async function resolveSpawnColony(parsed: Parsed): Promise<string | undefined> {
  const value = flag(parsed, "colony");
  if (typeof value !== "string") return undefined;
  const record = await loadColony(value);
  if (!record) throw new Error(`Unknown colony: ${value}. Create it first with: hive colony create ${value}`);
  if (record.archived) throw new Error(`Colony is archived: ${value}`);
  return record.name;
}


/** The session name of the attached client, or undefined outside tmux. */
export async function currentTmuxSession(): Promise<string | undefined> {
  const result = await tmux(["display-message", "-p", "#{session_name}"], { reject: false });
  if (!result.ok) return undefined;
  const name = result.stdout.trim();
  return name.length > 0 ? name : undefined;
}


export async function resolveSession(name: string): Promise<SessionRecord> {
  const exact = await loadSession(name);
  if (exact) return exact;
  const records = await listSessions();
  const matches = records.filter((record) => matchesSessionReference(record, name));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous session ${name}: ${matches.map((m) => m.id ?? m.name).join(", ")}`);
  throw new Error(`Unknown session: ${name}`);
}


export async function ensureLive(record: SessionRecord) {
  await ensureSessionLive(record);
}


export function cleanupAfterRun(parsed: Parsed): boolean {
  return truthy(flag(parsed, "rm")) || truthy(flag(parsed, "cleanup"));
}


export function hasFlag(parsed: Parsed, key: string): boolean {
  return flag(parsed, key) !== undefined;
}


/**
 * Resolve the first present flag among `keys` to its string value. A flag that
 * is present without a value parses as boolean true (`String(true)` would
 * otherwise leak a literal "true"), so reject anything that is not a string.
 */
export function stringFlag(parsed: Parsed, keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = flag(parsed, key);
    if (raw === undefined) continue;
    const display = `${key.length === 1 ? "-" : "--"}${key}`;
    if (raw === true) throw new Error(`${display} requires a value`);
    if (Array.isArray(raw)) throw new Error(`${display} was given multiple times; pass it once`);
    return raw;
  }
  return undefined;
}


// A repeatable value flag (e.g. `--tag a --tag b`): the parser arrays repeats,
// keeps a single value as a string, and a value-less `--tag` as `true`. Coerce
// all three to a string[] (dropping a value-less use with an error).
export function arrayFlag(parsed: Parsed, key: string): string[] {
  const raw = flag(parsed, key);
  if (raw === undefined) return [];
  if (raw === true) throw new Error(`--${key} requires a value`);
  if (Array.isArray(raw)) return raw;
  return [raw];
}


export function ageFlag(parsed: Parsed, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = flag(parsed, key);
    if (typeof value === "string") return parseAge(value);
    if (value === true) throw new Error(`--${key} requires a duration like 30m, 2h, or 7d`);
  }
  return undefined;
}


export function acceptsTrust(parsed: Parsed): boolean {
  if (truthy(flag(parsed, "no-accept-trust")) || truthy(flag(parsed, "no-trust"))) return false;
  return true;
}


export function dangerousMode(parsed: Parsed, agent?: string, requested?: string, profileYolo?: boolean): boolean {
  // Explicit per-spawn opt-out always wins.
  if (truthy(flag(parsed, "no-yolo"))) return false;
  const names = yoloDecisionNames(agent, requested);
  // Persistent opt-out via `hive config set-bee <bee> --no-yolo`.
  if (names.some((name) => beeConfig(name).yolo === false)) return false;
  if (
    truthy(flag(parsed, "yolo")) ||
    truthy(flag(parsed, "dangerous")) ||
    truthyEnv(process.env.HIVE_YOLO) ||
    names.some((name) => truthyEnv(process.env[`HIVE_${envSuffix(name)}_YOLO`]))
  ) return true;
  if (names.some((name) => beeConfig(name).yolo === true)) return true;
  // `<tool>-auto` alias for a harness whose registry entry forces yolo on
  // auto-picked accounts (codex today) — wins over the thin-profile override.
  const autoTool = requested ? autoAccountTool(requested) : undefined;
  if (autoTool && autoAliasForcesYolo(autoTool)) return true;
  // Thin-profile yolo override (precedence FLAG > config bee yolo > PROFILE >
  // per-agent default).
  if (profileYolo !== undefined) return profileYolo;
  // Per-agent default: selected harnesses run permissionless unless opted out above.
  return agent || requested ? agentDefaultsToYolo(agent ?? requested!) : false;
}


export function yoloDecisionNames(agent?: string, requested?: string): string[] {
  const names: string[] = [];
  const add = (value: string | undefined) => {
    if (value && !names.includes(value)) names.push(value);
  };
  add(requested);
  add(agent);
  add(requested ? canonicalAgentKind(requested) : undefined);
  add(agent ? canonicalAgentKind(agent) : undefined);
  return names;
}


export function envSuffix(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}


export function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}


export function formatPaneExcerpt(pane: string): string {
  const lines = pane.trimEnd().split("\n").slice(-25);
  return lines.map((line) => dim(`pane │ `) + line).join("\n");
}


export function transcriptBanner(provider: string, path: string): string {
  if (!isPretty(process.stderr)) return `# ${provider} transcript: ${path}`;
  return `${dim("─")} ${cyan(provider)} ${dim(tildify(path))}`;
}


export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export function safeTmuxTarget(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}
