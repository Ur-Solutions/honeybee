/**
 * HiveDaemon — the real v2 daemon (spec 04). Hosts the WP1 store (sole
 * writer), the WP3 HsrDriver + adapters, and the DaemonCore loops over wall
 * time; serves every client through the RPC surface (rpc.ts / protocol.ts).
 *
 * Spec mapping:
 *  - behavior 1 (loops)            → DaemonCore.step() on a tickMs interval
 *  - behavior 2 (boot sequence)    → start(): open store (boot replay) →
 *    adoptSurvivors() (pid + start-time re-adoption from the STORE's recorded
 *    identities) → DaemonCore.boot() (snapshotLive → reconcileAtBoot → orphan
 *    reap → wake sweep). Zero failed states minted (B7).
 *  - behavior 3 (scale-to-zero)    → policy.idleWindowSteps from config
 *  - behavior 4 (flag policy)      → DaemonCore.applyEvidence (spec 03 rules)
 *  - behavior 5 (I1 telemetry)     → onI1Violation → i1_violations table +
 *    ledger-shaped log line; deadline floor-clamped policy-aware (config.ts)
 *  - behavior 6 (service mgmt)     → service.ts (wired by the CLI)
 *  - behavior 7 (config)           → config.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  exportTemplate,
  exportTrack,
  importFromFrozen,
  importLocalConfig,
  importTemplate,
  importTrack,
  openCoreStore,
  serializePackage,
  type CommandRow,
  type CoreStore,
  type RowSource,
  type Scope,
} from "../../core/src/index.ts";
import { realPreflightProbes } from "./import-probes.ts";
import { HsrDriver, type SpawnSpec } from "../../driver-hsr/src/index.ts";
import { claudeAdapter, codexAdapter, stubAdapter, type HarnessAdapter } from "../../adapters/src/index.ts";
import { DaemonCore, type BootReport, type I1ViolationEvent } from "./loops.ts";
import type { ResolvedNodeConfig } from "./config.ts";
import { TelemetryStore, formatI1Violation } from "./telemetry.ts";
import { RpcServer, type RpcConn } from "./rpc.ts";
import {
  DAEMON_VERSION,
  PROTOCOL,
  RpcError,
  type DeployInfoResult,
  type HealthResult,
  type ListResult,
  type MutationResult,
  type RpcVerb,
  type ImportFromFrozenResult,
  type ImportLocalConfigResult,
  type SendRpcResult,
  type SnapshotResult,
  type SpawnResult,
  type TemplateDeleteResult,
  type TemplateExportResult,
  type TemplateGetResult,
  type TemplateImportResult,
  type TemplateListResult,
  type TemplatePutResult,
  type TrackDeleteResult,
  type TrackExportResult,
  type TrackGetResult,
  type TrackImportResult,
  type TrackListResult,
  type TrackPutResult,
  type ViewResult,
} from "./protocol.ts";

const ADAPTER_NAMES = ["claude", "codex", "stub"] as const;

/**
 * Adapter for a bee. `providerSessionId` (bee row, spec 07 §F) selects the
 * harness-native resume path: claude via argv (`resumeArgs`, applied by
 * resolveSpawnSpec), codex via its handshake (`thread/resume`). The stub has
 * no resume path — a revived stub restarts fresh, like any harness without one.
 */
function adapterFor(name: string, cwd: string, providerSessionId: string | null): HarnessAdapter | null {
  switch (name) {
    case "claude":
      return claudeAdapter;
    case "codex":
      return codexAdapter({ cwd, ...(providerSessionId ? { resumeThreadId: providerSessionId } : {}) });
    case "stub":
      return stubAdapter;
    default:
      return null;
  }
}

const OP_LOG_TAIL = 40;

export class HiveDaemon {
  readonly cfg: ResolvedNodeConfig;
  private store: CoreStore | null = null;
  private driver: HsrDriver | null = null;
  private core: DaemonCore | null = null;
  private telemetry: TelemetryStore | null = null;
  private rpc: RpcServer | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private ticks = 0;
  private tickErrors = 0;
  private lastTickAt: number | null = null;
  private lastBoot: BootReport | null = null;
  private stopping = false;
  private publishedSeq = 0;
  private readonly opLog: string[] = [];

  constructor(cfg: ResolvedNodeConfig) {
    this.cfg = cfg;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    mkdirSync(this.cfg.dataDir, { recursive: true });
    mkdirSync(this.cfg.sessionLogDir, { recursive: true });
    mkdirSync(dirname(this.cfg.logPath), { recursive: true });
    this.telemetry = new TelemetryStore(this.cfg.telemetryPath);
    // Opening the store IS the single-daemon lock (B9): a second daemon on
    // this node dies right here with SecondWriterError.
    const store = openCoreStore(this.cfg.storePath, {
      maxAttempts: this.cfg.maxAttempts,
      backoffBaseMs: this.cfg.backoffBaseMs,
    });
    this.store = store;
    const driver = new HsrDriver({
      sessionLogDir: this.cfg.sessionLogDir,
      stopKillGraceMs: this.cfg.stopKillGraceMs,
      adoptToleranceMs: this.cfg.adoptToleranceMs,
      resolve: (beeId: string) => this.resolveSpawnSpec(beeId),
    });
    this.driver = driver;
    this.core = new DaemonCore({
      store,
      driver,
      policy: {
        bootHangTimeoutSteps: this.cfg.bootHangTimeoutMs,
        turnHangTimeoutSteps: this.cfg.turnHangTimeoutMs,
        commandsPerStep: this.cfg.commandsPerTick,
        idleWindowSteps: this.cfg.idleWindowMs > 0 ? this.cfg.idleWindowMs : null,
        i1DeadlineSteps: this.cfg.i1DeadlineMs,
      },
      now: Date.now,
      log: (op) => this.log(op),
      onI1Violation: (v) => this.recordI1(v),
      removeSessionLog: (path) => rmSync(path, { force: true }),
    });
    // Behavior 2: re-adopt surviving runtimes by the identities core recorded
    // at spawn, so DaemonCore.boot()'s snapshotLive() sees them and
    // reconcileAtBoot keeps their rows live instead of stopping them.
    this.adoptSurvivors(store, driver);
    this.lastBoot = this.core.boot();
    this.publishedSeq = store.lastAuditSeq();
    this.rpc = new RpcServer({
      socketPath: this.cfg.socketPath,
      log: (op) => this.log(op),
      dispatch: (verb, params, conn) => this.dispatch(verb, params, conn),
    });
    await this.rpc.listen();
    this.tickTimer = setInterval(() => this.tick(), this.cfg.tickMs);
    this.log(`daemon.started pid=${process.pid} store=${this.cfg.storePath}`);
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`daemon.stopping pid=${process.pid}`);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    await this.rpc?.close();
    this.store?.close();
    this.telemetry?.close();
    // Children are NOT killed: detached runtimes survive daemon restarts by
    // design and the next boot re-adopts them (contract §3.2). Their pipe
    // handles must not pin our event loop, though — detach them so the
    // process can actually exit.
    this.driver?.detachAll();
    this.log("daemon.stopped");
  }

  private tick(): void {
    const core = this.core;
    const store = this.store;
    if (!core || !store || this.stopping) return;
    try {
      core.step();
      this.ticks += 1;
      this.lastTickAt = Date.now();
    } catch (err) {
      // A tick error is a bug, never a reason to abandon the node: the loops
      // are idempotent over durable state, so the next tick retries.
      this.tickErrors += 1;
      this.log(`tick.error ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    this.flushWatchers();
  }

  private flushWatchers(): void {
    const store = this.store;
    const rpc = this.rpc;
    if (!store || !rpc) return;
    const latest = store.lastAuditSeq();
    if (latest > this.publishedSeq) this.publishedSeq = latest;
    rpc.flushWatch(latest, (fromSeq) => store.auditRows(fromSeq), this.cfg.watchMaxBatch);
  }

  // -------------------------------------------------------------------------
  // agents
  // -------------------------------------------------------------------------

  /**
   * The spawn shape for a bee's NEXT runtime. Continuity (spec 07 §F): when
   * the bee row carries a provider session id, the harness is asked to resume
   * it — claude gets `--resume <id>` appended to the agent spec's args, codex
   * gets `thread/resume` in its handshake — so generation N+1 (revive after a
   * stop, scale-to-zero, crash, or an old-world import) continues the same
   * conversation. Per-bee env (the harness config home an imported session
   * lives under) layers over the agent spec env.
   */
  private resolveSpawnSpec(beeId: string): SpawnSpec {
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) throw new Error(`resolve: bee ${beeId} not found`);
    const spec = this.cfg.agents[bee.agent];
    if (!spec) throw new Error(`resolve: no agent spec for '${bee.agent}'`);
    const adapter = adapterFor(spec.adapter ?? bee.agent, bee.cwd, bee.providerSessionId);
    if (!adapter) throw new Error(`resolve: no adapter for agent '${bee.agent}'`);
    const resume = bee.providerSessionId && adapter.resumeArgs ? adapter.resumeArgs(bee.providerSessionId) : [];
    return {
      adapter,
      command: spec.command,
      args: [...(spec.args ?? []), ...resume],
      cwd: bee.cwd,
      env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}), ...bee.env },
    };
  }

  private adoptSurvivors(store: CoreStore, driver: HsrDriver): void {
    for (const bee of store.listBees()) {
      const rt = store.currentRuntime(bee.id);
      if (!rt || rt.state === "stopped" || rt.pid == null || rt.pidStartedAt == null) continue;
      const adopted = driver.adopt(bee.id, rt.generation, rt.pid, rt.pidStartedAt);
      this.log(`boot.adopt bee=${bee.id} gen=${rt.generation} pid=${rt.pid} ok=${adopted}`);
    }
  }

  // -------------------------------------------------------------------------
  // telemetry + log
  // -------------------------------------------------------------------------

  private log(op: string): void {
    if (this.opLog.length >= 4000) this.opLog.shift();
    this.opLog.push(op);
    try {
      appendFileSync(this.cfg.logPath, `${JSON.stringify({ ts: Date.now(), op })}\n`);
    } catch {
      // Logging must never take the daemon down.
    }
  }

  private recordI1(v: I1ViolationEvent): void {
    const ops = this.opLog.slice(-OP_LOG_TAIL);
    const fresh = this.telemetry?.recordI1(v, ops) ?? false;
    if (fresh) this.log(`i1_violation ${formatI1Violation(v, ops)}`);
  }

  // -------------------------------------------------------------------------
  // RPC verbs
  // -------------------------------------------------------------------------

  private mustStore(): CoreStore {
    if (!this.store || this.stopping) throw new RpcError("node_stopped", "daemon is shutting down");
    return this.store;
  }

  private param(params: Record<string, unknown>, key: string): string {
    const v = params[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new RpcError("invalid_request", `param '${key}' must be a non-empty string`);
    }
    return v;
  }

  private dispatch(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): unknown {
    switch (verb) {
      case "spawn":
        return this.withIdempotency(verb, params, () => this.rpcSpawn(params));
      case "send":
        return this.withIdempotency(verb, params, () => this.rpcSend(params));
      case "stop":
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue("stop", this.param(params, "beeId"), { cause: "stopped_by_user" }, params),
        );
      case "revive":
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue("revive", this.param(params, "beeId"), {}, params),
        );
      case "archive":
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue("archive", this.param(params, "beeId"), {}, params),
        );
      case "unarchive":
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue("unarchive", this.param(params, "beeId"), {}, params),
        );
      case "delete":
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue("delete", this.param(params, "beeId"), {}, params),
        );
      case "view":
        return this.viewOf(this.mustStore(), this.param(params, "beeId"));
      case "list":
        return this.rpcList(params);
      case "mailbox":
        return { messages: this.mustStore().listMessages(this.requireBee(params)) };
      case "commands":
        return { commands: this.mustStore().listCommands({ beeId: this.requireBee(params) }) };
      case "deployInfo":
        return this.rpcDeployInfo();
      case "health":
        return this.rpcHealth();
      case "template.list":
        return this.rpcTemplateList(params);
      case "template.get":
        return { template: this.requireTemplate(params) } satisfies TemplateGetResult;
      case "template.put":
        return this.withIdempotency(verb, params, () => this.rpcTemplatePut(params));
      case "template.delete":
        return this.withIdempotency(
          verb,
          params,
          () => ({ template: this.mustStore().deleteTemplate(this.param(params, "id")) }) satisfies TemplateDeleteResult,
        );
      case "template.export": {
        const doc = exportTemplate(this.requireTemplate(params));
        return { package: doc, text: serializePackage(doc) } satisfies TemplateExportResult;
      }
      case "template.import":
        return this.withIdempotency(verb, params, () => {
          const res = importTemplate(this.mustStore(), params.package, this.importOptions(params));
          return { template: res.row, outcome: res.outcome } satisfies TemplateImportResult;
        });
      case "track.list":
        return this.rpcTrackList(params);
      case "track.get":
        return { track: this.requireTrack(params) } satisfies TrackGetResult;
      case "track.put":
        return this.withIdempotency(verb, params, () => this.rpcTrackPut(params));
      case "track.delete":
        return this.withIdempotency(
          verb,
          params,
          () => ({ track: this.mustStore().deleteTrack(this.param(params, "id")) }) satisfies TrackDeleteResult,
        );
      case "track.export": {
        const doc = exportTrack(this.requireTrack(params));
        return { package: doc, text: serializePackage(doc) } satisfies TrackExportResult;
      }
      case "track.import":
        return this.withIdempotency(verb, params, () => {
          const res = importTrack(this.mustStore(), params.package, this.importOptions(params));
          return { track: res.row, outcome: res.outcome } satisfies TrackImportResult;
        });
      case "packages.importLocalConfig":
        return this.withIdempotency(verb, params, () => this.rpcImportLocalConfig(params));
      case "import.fromFrozen":
        return this.withIdempotency(verb, params, () => this.rpcImportFromFrozen(params));
      case "snapshot": {
        const snap = this.snapshot();
        conn.alignWatch(snap.seq);
        return snap;
      }
      case "watch": {
        const snap = this.snapshot();
        conn.subscribeWatch(snap.seq);
        return snap;
      }
      default: {
        throw new RpcError("invalid_request", `unhandled verb: ${String(verb)}`);
      }
    }
  }

  private requireBee(params: Record<string, unknown>): string {
    const beeId = this.param(params, "beeId");
    if (!this.mustStore().getBee(beeId)) throw new RpcError("bee_not_found", `bee not found: ${beeId}`);
    return beeId;
  }

  /** The optional caller-supplied idempotency key (spec 06 §4.2 one-key rule). */
  private idempotencyKeyOf(params: Record<string, unknown>): string | null {
    const key = params.idempotencyKey;
    if (key === undefined || key === null) return null;
    if (typeof key !== "string" || key.length === 0) {
      throw new RpcError("invalid_request", "idempotencyKey must be a non-empty string when given");
    }
    return key;
  }

  /**
   * One-key idempotency around a mutation verb (spec 06 §4.2). With a key:
   * the whole mutation — dedup lookup, the mutation itself, and the result
   * record — runs in ONE store transaction, so a replayed key always answers
   * with the ORIGINAL recorded result (`deduped: true`; command-backed
   * results also carry the command's CURRENT status, so replay after settle
   * returns the settled outcome). A failed mutation records nothing: the
   * caller may retry with the same key. Keyless calls are untouched.
   */
  private withIdempotency<T extends object>(
    verb: RpcVerb,
    params: Record<string, unknown>,
    fn: () => T,
  ): T | (T & { deduped: true; status?: CommandRow["status"] }) {
    const key = this.idempotencyKeyOf(params);
    if (key == null) return fn();
    const store = this.mustStore();
    return store.transact(() => {
      const hit = store.lookupRpcResult(key);
      if (hit) {
        this.log(`rpc.dedup verb=${verb} key=${key}`);
        const replay = { ...(hit.result as T), deduped: true as const };
        if (hit.commandId != null) {
          const cmd = store.getCommand(hit.commandId);
          if (cmd) return { ...replay, status: cmd.status };
        }
        return replay;
      }
      const result = fn();
      const commandId = (result as { commandId?: unknown }).commandId;
      store.recordRpcResult(key, verb, typeof commandId === "number" ? commandId : null, result);
      return result;
    });
  }

  private rpcSpawn(params: Record<string, unknown>): SpawnResult {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    // Belt-and-braces guard for a key already stamped on a command at the
    // CORE level (e.g. by a library caller): answer with the original spawn
    // instead of minting a second bee. Normally the rpc_idempotency record in
    // withIdempotency answers first.
    if (key != null) {
      const original = store.getCommandByIdempotencyKey(key);
      if (original) return { beeId: original.beeId, commandId: original.id, status: original.status, deduped: true };
    }
    const name = this.param(params, "name");
    const agent = this.param(params, "agent");
    const cwd = this.param(params, "cwd");
    const agentSpec = this.cfg.agents[agent];
    const adapterName = agentSpec?.adapter ?? agent;
    if (!agentSpec || !(ADAPTER_NAMES as readonly string[]).includes(adapterName)) {
      throw new RpcError("invalid_request", `unknown agent '${agent}' (no spawn spec/adapter configured)`);
    }
    const tags = Array.isArray(params.tags) && params.tags.every((t) => typeof t === "string")
      ? (params.tags as string[])
      : [];
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : randomUUID();
    const driver = this.driver;
    store.createBee({
      id,
      name,
      agent,
      substrate: "hsr",
      cwd,
      title: typeof params.title === "string" ? params.title : undefined,
      tags,
      sessionLogPath: driver ? driver.sessionLogPath(id) : undefined,
    });
    const cmd = store.enqueueCommand("spawn", id, {}, key == null ? {} : { idempotencyKey: key });
    return { beeId: id, commandId: cmd.id };
  }

  private rpcSend(params: Record<string, unknown>): SendRpcResult {
    const store = this.mustStore();
    const beeId = this.param(params, "beeId");
    const body = this.param(params, "body");
    const sender = typeof params.sender === "string" && params.sender.length > 0 ? params.sender : "operator";
    const res = store.send(beeId, body, { sender });
    return { messageId: res.message.id, commandId: res.wakeCommand?.id ?? null, unarchived: res.unarchived };
  }

  private rpcEnqueue(
    verb: string,
    beeId: string,
    args: Record<string, unknown>,
    params: Record<string, unknown>,
  ): MutationResult {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    const cmd = store.enqueueCommand(verb, beeId, args, key == null ? {} : { idempotencyKey: key });
    // Core-level dedup (the UNIQUE key column) can answer even before the
    // rpc_idempotency record exists — surface it the same way.
    if (cmd.deduped) return { commandId: cmd.id, status: cmd.status, deduped: true };
    return { commandId: cmd.id };
  }

  private viewOf(store: CoreStore, beeId: string): ViewResult {
    const bee = store.getBee(beeId);
    return {
      view: store.view(beeId),
      bee,
      runtime: bee ? store.currentRuntime(beeId) : null,
    };
  }

  private rpcList(params: Record<string, unknown>): ListResult {
    const store = this.mustStore();
    const lifecycle = typeof params.lifecycle === "string" ? params.lifecycle : null;
    const views = store
      .listBees()
      .filter((b) => lifecycle == null || b.lifecycle === lifecycle)
      .map((b) => this.viewOf(store, b.id));
    return { views };
  }

  private rpcDeployInfo(): DeployInfoResult {
    return {
      protocol: PROTOCOL,
      daemonVersion: DAEMON_VERSION,
      nodeVersion: process.version,
      pid: process.pid,
      startedAt: this.startedAt,
      dataDir: this.cfg.dataDir,
      socketPath: this.cfg.socketPath,
      storePath: this.cfg.storePath,
    };
  }

  private rpcHealth(): HealthResult {
    const store = this.mustStore();
    const bees = store.listBees();
    return {
      protocol: PROTOCOL,
      pid: process.pid,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      tickErrors: this.tickErrors,
      stopping: this.stopping,
      lastBoot: this.lastBoot,
      i1Violations: this.telemetry?.i1Count() ?? 0,
      bees: {
        total: bees.length,
        active: bees.filter((b) => b.lifecycle === "active").length,
        archived: bees.filter((b) => b.lifecycle === "archived").length,
      },
    };
  }

  private snapshot(): SnapshotResult {
    const store = this.mustStore();
    // Single-threaded: reading the seq and the rows is atomic w.r.t. writes.
    const seq = store.lastAuditSeq();
    this.publishedSeq = seq;
    return {
      seq,
      views: store.listBees().map((b) => this.viewOf(store, b.id)),
      templates: store.listTemplates(),
      tracks: store.listTracks(),
    };
  }

  // -------------------------------------------------------------------------
  // WP6a — templates, tracks, packages (spec 06 §1.4.1)
  // -------------------------------------------------------------------------

  private scopeParam(params: Record<string, unknown>): Scope | undefined {
    const scope = params.scope;
    if (scope === undefined || scope === null) return undefined;
    if (scope !== "personal" && scope !== "team" && scope !== "repo") {
      throw new RpcError("invalid_request", "scope must be personal|team|repo");
    }
    return scope;
  }

  private importOptions(params: Record<string, unknown>): { source: RowSource; scope?: Scope; label?: string } {
    const source = params.source;
    if (source !== undefined && typeof source !== "string") {
      throw new RpcError("invalid_request", "source must be a string when given");
    }
    return {
      source: source !== undefined && source.length > 0 ? (`package:${source.replace(/^package:/, "")}` as RowSource) : "package:rpc",
      scope: this.scopeParam(params),
      label: typeof params.label === "string" ? params.label : undefined,
    };
  }

  private requireTemplate(params: Record<string, unknown>) {
    const store = this.mustStore();
    const id = this.param(params, "id");
    const template = store.getTemplate(id);
    if (!template) throw new RpcError("template_not_found", `template not found: ${id}`);
    return template;
  }

  private requireTrack(params: Record<string, unknown>) {
    const store = this.mustStore();
    const id = this.param(params, "id");
    const track = store.getTrack(id);
    if (!track) throw new RpcError("track_not_found", `track not found: ${id}`);
    return track;
  }

  private rpcTemplateList(params: Record<string, unknown>): TemplateListResult {
    const scope = this.scopeParam(params);
    return { templates: this.mustStore().listTemplates(scope ? { scope } : {}) };
  }

  private rpcTemplatePut(params: Record<string, unknown>): TemplatePutResult {
    const store = this.mustStore();
    const res = store.putTemplate({
      id: typeof params.id === "string" && params.id.length > 0 ? params.id : undefined,
      fields: params.fields,
      defaultSource: "api",
    });
    return { template: res.template, outcome: res.outcome };
  }

  private rpcTrackList(params: Record<string, unknown>): TrackListResult {
    const scope = this.scopeParam(params);
    return { tracks: this.mustStore().listTracks(scope ? { scope } : {}) };
  }

  private rpcTrackPut(params: Record<string, unknown>): TrackPutResult {
    const store = this.mustStore();
    const res = store.putTrack({
      id: typeof params.id === "string" && params.id.length > 0 ? params.id : undefined,
      fields: params.fields,
      defaultSource: "api",
    });
    return { track: res.track, outcome: res.outcome };
  }

  /**
   * WP7 (spec 07 B4): import active old-world bees from the frozen store.
   * The daemon is the sole writer (contract §3.5), so the import runs here;
   * the preflight probes real pids/tmux (A2). Refusals come back as a report
   * (`applied:false`, `refusal`), not as RPC errors — the CLI prints them.
   */
  private rpcImportFromFrozen(params: Record<string, unknown>): ImportFromFrozenResult {
    const store = this.mustStore();
    const root = typeof params.root === "string" && params.root.length > 0 ? params.root : join(homedir(), ".hive");
    const dryRun = params.dryRun === true;
    const force = params.force === true;
    const report = importFromFrozen(store, root, {
      dryRun,
      force,
      knownAgents: Object.keys(this.cfg.agents),
      probes: realPreflightProbes(),
    });
    this.log(
      `import.fromFrozen root=${root} dryRun=${dryRun} force=${force} applied=${report.applied} ` +
        `import=${report.plan.counts.import} skip=${report.plan.counts.skip} live=${report.preflight.live.length}` +
        (report.refusal ? ` refusal=${JSON.stringify(report.refusal.split("\n")[0])}` : ""),
    );
    return report;
  }

  private rpcImportLocalConfig(params: Record<string, unknown>): ImportLocalConfigResult {
    const store = this.mustStore();
    // The local package source dir: ~/.hive by default (spec 06 §1.4.1 — the
    // OLD store layout is the human-editable form). Tests always pass `dir`.
    const dir = typeof params.dir === "string" && params.dir.length > 0 ? params.dir : join(homedir(), ".hive");
    return importLocalConfig(store, dir, { scope: this.scopeParam(params) });
  }
}
