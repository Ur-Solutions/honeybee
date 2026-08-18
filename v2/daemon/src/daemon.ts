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
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { InterruptOutcome } from "../../harness/src/driver.ts";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
import {
  CellDeleteRefused,
  CellDriver,
  CellRuntimeLiveError,
  cellPaths,
  provisionRequestOf,
  readLedger,
  reserveCell,
  revParse,
  sanitizeComponent,
  type CellSpec,
  type ReserveRequest,
} from "../../driver-cell/src/index.ts";
import { SubstrateRouter } from "./substrates.ts";
import {
  claudeAdapter,
  claudeArgGrammar,
  codexAdapter,
  codexArgGrammar,
  codexSpawnPlan,
  composeArgv,
  stubAdapter,
  type ArgGrammar,
  type HarnessAdapter,
} from "../../adapters/src/index.ts";
import { DaemonCore, type BootReport, type I1ViolationEvent } from "./loops.ts";
import type { AgentSpecConfig, ResolvedNodeConfig } from "./config.ts";
import { TelemetryStore, formatI1Violation } from "./telemetry.ts";
import { RpcServer, type RpcConn } from "./rpc.ts";
import {
  DAEMON_VERSION,
  PROTOCOL,
  RpcError,
  SPAWN_SUBSTRATES,
  type CellCaptureMode,
  type CellCaptureResult,
  type CellRemoveResult,
  type ChildrenResult,
  type DeployInfoResult,
  type ForkResult,
  type HealthResult,
  type InterruptResult,
  type ListResult,
  type MutationResult,
  type QuestionAnswerResult,
  type QuestionAskResult,
  type QuestionListResult,
  type RenameResult,
  type RpcVerb,
  type SealCreateResult,
  type SealGetResult,
  type SealListResult,
  type SetArgsResult,
  type TagResult,
  type ImportFromFrozenResult,
  type ImportLocalConfigResult,
  type SendRpcResult,
  type SnapshotResult,
  type SpawnCellParams,
  type SpawnResult,
  type SpawnSubstrate,
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
 * `model` (codex only) is the `-m/--model` lifted off the composed argv into
 * the thread request — the app-server ignores TUI flags. `forkSeed` (v6, a
 * fork's first runtime, no session of its own yet) selects the fork path
 * instead: codex `thread/fork {threadId: seed}`; claude via `forkArgs`.
 */
function adapterFor(name: string, cwd: string, providerSessionId: string | null, model?: string, forkSeed?: string | null): HarnessAdapter | null {
  switch (name) {
    case "claude":
      return claudeAdapter;
    case "codex":
      return codexAdapter({
        cwd,
        ...(providerSessionId ? { resumeThreadId: providerSessionId } : forkSeed ? { forkThreadId: forkSeed } : {}),
        ...(model ? { model } : {}),
      });
    case "stub":
      return stubAdapter;
    default:
      return null;
  }
}

/** The argv grammar an adapter's CLI speaks (unknown adapters: no de-dup, verbatim concat). */
const NO_GRAMMAR: ArgGrammar = { valueFlags: new Set(), booleanFlags: new Set(), keyedFlags: new Set(), aliases: {} };
function grammarFor(adapterName: string): ArgGrammar {
  switch (adapterName) {
    case "claude":
      return claudeArgGrammar;
    case "codex":
      return codexArgGrammar;
    default:
      return NO_GRAMMAR;
  }
}

/**
 * The composed argv + adapter for a bee's next runtime — pure, exported for
 * tests. Precedence (adapters/args.ts): spec.args (harness plumbing) <
 * spec.defaultArgs (node per-agent defaults) < bee.args (per bee, schema v5)
 * < resume args (`--resume <id>`, claude). Repeated valued flags: later wins;
 * boolean flags idempotent; unknown tokens/positionals verbatim in place.
 * codex: `-m/--model` and the approval/sandbox flags are lifted off argv into
 * the thread request (the app-server ignores TUI flags); `-c k=v` stays.
 */
export function composeSpawn(
  spec: AgentSpecConfig,
  adapterName: string,
  bee: { cwd: string; args: string[] | null; providerSessionId: string | null; forkSeed?: string | null },
): { adapter: HarnessAdapter | null; args: string[]; model: string | undefined } {
  const grammar = grammarFor(adapterName);
  // v6 fork: a fork with no session of its own yet forks the SOURCE's
  // conversation (`--resume <seed> --fork-session` / thread/fork) into a new
  // one; once its own id is recorded the seed is consumed and plain resume
  // takes over. A recorded session always wins over a stale seed.
  const forkSeed = bee.providerSessionId ? null : (bee.forkSeed ?? null);
  const base = adapterFor(adapterName, bee.cwd, bee.providerSessionId, undefined, forkSeed);
  const resume = bee.providerSessionId && base?.resumeArgs
    ? base.resumeArgs(bee.providerSessionId)
    : forkSeed && base?.forkArgs
      ? base.forkArgs(forkSeed)
      : [];
  const composed = composeArgv(grammar, [spec.args, spec.defaultArgs, bee.args, resume]);
  if (adapterName === "codex") {
    const plan = codexSpawnPlan(composed);
    return { adapter: adapterFor(adapterName, bee.cwd, bee.providerSessionId, plan.model, forkSeed), args: plan.argv, model: plan.model };
  }
  return { adapter: base, args: composed, model: undefined };
}

/**
 * v6 — the honeybee-owned identity env every runtime is stamped with, AFTER
 * every other env source (agent spec, per-bee env) so nothing can override
 * it. HIVE_BEE / HIVE_BEE_ID are what agents' skills read (`hive v2 ask`,
 * `hive v2 seal`, `hive v2 spawn` fill their bee/parent from them);
 * HIVE_PARENT is set iff the bee was spawned by another bee — the child's
 * "you were spawned by <parent>; report back to it" fact.
 */
export function beeIdentityEnv(bee: { id: string; name: string; parentId: string | null }): Record<string, string> {
  return {
    HIVE_BEE: bee.name,
    HIVE_BEE_ID: bee.id,
    ...(bee.parentId ? { HIVE_PARENT: bee.parentId } : {}),
  };
}

const OP_LOG_TAIL = 40;

/** Verbs whose result `status` is the verb's own report, not a command status (see withIdempotency). */
const OWN_STATUS_VERBS: ReadonlySet<RpcVerb> = new Set<RpcVerb>(["cell.capture", "cell.remove"]);

export class HiveDaemon {
  readonly cfg: ResolvedNodeConfig;
  private store: CoreStore | null = null;
  /** The substrate router DaemonCore drives; `.hsr` / `.cell` are the substrate drivers. */
  private driver: SubstrateRouter | null = null;
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
    const hsrConfig = {
      sessionLogDir: this.cfg.sessionLogDir,
      stopKillGraceMs: this.cfg.stopKillGraceMs,
      adoptToleranceMs: this.cfg.adoptToleranceMs,
    };
    const hsr = new HsrDriver({ ...hsrConfig, resolve: (beeId: string) => this.resolveSpawnSpec(beeId) });
    // Cell substrate (spec 05): a CellDriver composed over its own inner
    // HsrDriver — pure delegation; the cell layer adds provisioning, cwd =
    // the space checkout, and the A4 sandbox. Same harness resolution.
    const cell = new CellDriver({
      cellsRoot: this.cfg.cellsRoot,
      nodeKind: this.cfg.nodeKind,
      resolveHarness: (beeId: string) => this.resolveSpawnSpec(beeId),
      resolveCell: (beeId: string) => this.resolveCellSpec(beeId),
      hsr: hsrConfig,
    });
    const driver = new SubstrateRouter({
      hsr,
      cell,
      substrateOf: (beeId: string) => store.getBee(beeId)?.substrate ?? null,
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
   * lives under) layers over the agent spec env. Per-bee args (schema v5)
   * layer between the agent spec's args and the resume selector — see
   * composeSpawn for the precedence.
   */
  private resolveSpawnSpec(beeId: string): SpawnSpec {
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) throw new Error(`resolve: bee ${beeId} not found`);
    const spec = this.cfg.agents[bee.agent];
    if (!spec) throw new Error(`resolve: no agent spec for '${bee.agent}'`);
    const { adapter, args } = composeSpawn(spec, spec.adapter ?? bee.agent, bee);
    if (!adapter) throw new Error(`resolve: no adapter for agent '${bee.agent}'`);
    return {
      adapter,
      command: spec.command,
      args,
      cwd: bee.cwd,
      env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}), ...bee.env, ...beeIdentityEnv(bee) },
    };
  }

  /**
   * The cell half of a cell bee's spawn (CellDriver.resolveCell). The seed
   * ledger the daemon wrote at spawn (`<wrapper>/box/cell.json`, reached
   * from the bee's cwd = the space dir) is the durable allocation truth:
   * origin, sha, layout, warm and sandbox choices all come from it, so a
   * daemon restart re-hydrates cells without any in-memory state. Node
   * config supplies the defaults the ledger left open (sandbox override).
   */
  private resolveCellSpec(beeId: string): CellSpec {
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) throw new Error(`resolveCell: bee ${beeId} not found`);
    if (bee.substrate !== "cell") throw new Error(`resolveCell: bee ${beeId} is on substrate '${bee.substrate}', not cell`);
    const wrapperDir = dirname(bee.cwd);
    const ledger = readLedger(join(wrapperDir, "box", "cell.json"));
    if (!ledger) throw new Error(`resolveCell: bee ${beeId} has no cell ledger under ${wrapperDir} (cell removed?)`);
    if (ledger.beeId !== beeId) throw new Error(`resolveCell: ledger under ${wrapperDir} belongs to bee ${ledger.beeId}, not ${beeId}`);
    const provision = provisionRequestOf(ledger);
    if (!provision) throw new Error(`resolveCell: ledger under ${wrapperDir} has a malformed space name '${ledger.spaceName}'`);
    provision.wrapper = basename(wrapperDir);
    const paths = cellPaths(this.cfg.cellsRoot, provision.wrapper, provision.repoName, provision.cellId);
    if (paths.spaceDir !== bee.cwd) {
      throw new Error(`resolveCell: bee ${beeId} cell ${bee.cwd} is outside cells root ${this.cfg.cellsRoot} (cells.root changed?)`);
    }
    return { provision, sandbox: ledger.sandbox ?? this.cfg.cellSandbox };
  }

  private adoptSurvivors(store: CoreStore, driver: SubstrateRouter): void {
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
          this.rpcEnqueue(
            "revive",
            this.param(params, "beeId"),
            params.args === undefined ? {} : { args: this.argsParam(params, "revive", true) },
            params,
          ),
        );
      case "bee.setArgs":
        return this.withIdempotency(verb, params, () => this.rpcSetArgs(params));
      case "cell.capture":
        return this.withIdempotency(verb, params, () => this.rpcCellCapture(params));
      case "cell.remove":
        return this.withIdempotency(verb, params, () => this.rpcCellRemove(params));
      case "bee.rename":
        return this.withIdempotency(verb, params, () => this.rpcRename(params));
      case "bee.tag":
        return this.withIdempotency(verb, params, () => this.rpcTag(params));
      case "bee.interrupt":
        return this.withIdempotency(verb, params, () => this.rpcInterrupt(params));
      case "bee.fork":
        return this.withIdempotency(verb, params, () => this.rpcFork(params));
      case "bee.children":
        return this.rpcChildren(params);
      case "question.ask":
        return this.withIdempotency(verb, params, () => this.rpcQuestionAsk(params));
      case "question.answer":
        return this.withIdempotency(verb, params, () => this.rpcQuestionAnswer(params));
      case "question.list":
        return this.rpcQuestionList(params);
      case "seal.create":
        return this.withIdempotency(verb, params, () => this.rpcSealCreate(params));
      case "seal.list":
        return this.rpcSealList(params);
      case "seal.get":
        return { seal: this.mustStore().mustGetSeal(this.param(params, "sealId")) } satisfies SealGetResult;
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

  /** `args` param: string[] (spawn), or string[] | null when `nullable` (setArgs/revive: null clears). */
  private argsParam(params: Record<string, unknown>, verb: string, nullable: boolean): string[] | null {
    const v = params.args;
    if (v === null && nullable) return null;
    if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) {
      throw new RpcError("invalid_request", `${verb}: args must be an array of strings${nullable ? " (or null to clear)" : ""}`);
    }
    return v as string[];
  }

  private rpcSetArgs(params: Record<string, unknown>): SetArgsResult {
    const beeId = this.requireBee(params);
    const args = this.argsParam(params, "bee.setArgs", true);
    const res = this.mustStore().updateBeeArgs(beeId, args);
    this.log(`bee.setArgs bee=${beeId} applied=${res.applied} args=${JSON.stringify(args)}`);
    return { bee: res.bee, applied: res.applied };
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
        // Command-backed results carry the command's CURRENT status on
        // replay — except the cell verbs, whose `status` IS the report
        // (deleted|refused|absent, landed|conflict|…) and is never clobbered.
        if (hit.commandId != null && !OWN_STATUS_VERBS.has(verb)) {
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
    const substrate = this.substrateParam(params);
    // The cell owns the cwd (the space checkout): `cwd` is optional/ignored for cell spawns.
    const cwd = substrate === "cell" ? "" : this.param(params, "cwd");
    const agentSpec = this.cfg.agents[agent];
    const adapterName = agentSpec?.adapter ?? agent;
    if (!agentSpec || !(ADAPTER_NAMES as readonly string[]).includes(adapterName)) {
      throw new RpcError("invalid_request", `unknown agent '${agent}' (no spawn spec/adapter configured)`);
    }
    const tags = Array.isArray(params.tags) && params.tags.every((t) => typeof t === "string")
      ? (params.tags as string[])
      : [];
    const parentId = this.parentParam(params);
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : randomUUID();
    const driver = this.driver;
    // Cell substrate: the cell owns the cwd (the space checkout). The seed
    // ledger is written in the same call, AFTER the row exists (createBee
    // is the id/name gate) and before the spawn command is enqueued —
    // inside the idempotency transaction, so a failure here leaves no bee.
    const cell = substrate === "cell" ? this.planCell(id, name, this.cellParam(params)) : null;
    store.createBee({
      id,
      name,
      agent,
      substrate,
      cwd: cell ? cell.spaceDir : cwd,
      title: typeof params.title === "string" ? params.title : undefined,
      tags,
      sessionLogPath: driver ? driver.sessionLogPath(id) : undefined,
      args: params.args === undefined ? undefined : this.argsParam(params, "spawn", false),
      parentId,
    });
    if (cell) {
      reserveCell(this.cfg.cellsRoot, cell.reserve);
      this.log(`cell.reserve bee=${id} origin=${cell.reserve.originRepo} sha=${cell.reserve.sha} space=${cell.spaceDir}`);
    }
    const cmd = store.enqueueCommand("spawn", id, {}, key == null ? {} : { idempotencyKey: key });
    return { beeId: id, commandId: cmd.id };
  }

  private substrateParam(params: Record<string, unknown>): SpawnSubstrate {
    const v = params.substrate;
    if (v === undefined || v === null) return "hsr";
    if (typeof v !== "string" || !(SPAWN_SUBSTRATES as readonly string[]).includes(v)) {
      throw new RpcError("invalid_request", `substrate must be one of ${SPAWN_SUBSTRATES.join("|")}`);
    }
    return v as SpawnSubstrate;
  }

  /** `spawn.cell` — validated shape (see SpawnCellParams). */
  private cellParam(params: Record<string, unknown>): SpawnCellParams {
    const v = params.cell;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new RpcError("invalid_request", "spawn: substrate 'cell' requires a cell object {originRepo, sha?, warm?, sandbox?}");
    }
    const c = v as Record<string, unknown>;
    if (typeof c.originRepo !== "string" || c.originRepo.length === 0 || !isAbsolute(c.originRepo)) {
      throw new RpcError("invalid_request", "spawn: cell.originRepo must be an absolute path");
    }
    if (c.sha !== undefined && (typeof c.sha !== "string" || c.sha.length === 0)) {
      throw new RpcError("invalid_request", "spawn: cell.sha must be a non-empty string when given");
    }
    if (
      c.warm !== undefined &&
      typeof c.warm !== "boolean" &&
      !(Array.isArray(c.warm) && c.warm.every((d) => typeof d === "string" && d.length > 0))
    ) {
      throw new RpcError("invalid_request", "spawn: cell.warm must be a boolean or an array of non-empty strings");
    }
    if (c.sandbox !== undefined && typeof c.sandbox !== "boolean") {
      throw new RpcError("invalid_request", "spawn: cell.sandbox must be a boolean when given");
    }
    return {
      originRepo: c.originRepo,
      ...(c.sha !== undefined ? { sha: c.sha as string } : {}),
      ...(c.warm !== undefined ? { warm: c.warm as boolean | string[] } : {}),
      ...(c.sandbox !== undefined ? { sandbox: c.sandbox as boolean } : {}),
    };
  }

  /**
   * Plan a cell for a new bee: validate the origin, resolve the sha (default
   * HEAD), and derive the layout — wrapper `<name>-<hash(id)>`, space
   * `<repo>-space-<hash(id)>` — deterministically from the bee, so a replayed
   * spawn maps to the same paths. Nothing is written here.
   */
  private planCell(id: string, name: string, cell: SpawnCellParams): { spaceDir: string; reserve: ReserveRequest } {
    const originRepo = resolve(cell.originRepo);
    if (!existsSync(join(originRepo, ".git"))) {
      throw new RpcError("invalid_request", `spawn: cell.originRepo ${originRepo} is not a git repository (no .git)`);
    }
    const sha = revParse(originRepo, cell.sha ?? "HEAD");
    if (sha == null) {
      throw new RpcError(
        "invalid_request",
        cell.sha === undefined
          ? `spawn: origin ${originRepo} has no HEAD commit`
          : `spawn: cell.sha '${cell.sha}' does not resolve to a commit in ${originRepo}`,
      );
    }
    const cellId = createHash("sha1").update(id).digest("hex").slice(0, 12);
    const wrapper = `${sanitizeComponent(name)}-${cellId}`;
    const repoName = sanitizeComponent(basename(originRepo));
    const warmArtifacts =
      cell.warm === true ? (this.cfg.cellWarm[originRepo] ?? []) : Array.isArray(cell.warm) ? cell.warm : [];
    const paths = cellPaths(this.cfg.cellsRoot, wrapper, repoName, cellId);
    return {
      spaceDir: paths.spaceDir,
      reserve: {
        beeId: id,
        originRepo,
        sha,
        wrapper,
        repoName,
        cellId,
        warmArtifacts,
        sandbox: cell.sandbox ?? null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // WP6 §5 — cell exit path (spec 05 points 4 + 6)
  // -------------------------------------------------------------------------

  /** The bee must exist AND be on the cell substrate; returns the cell driver. */
  private requireCellBee(params: Record<string, unknown>): { beeId: string; cell: CellDriver } {
    const beeId = this.requireBee(params);
    const bee = this.mustStore().getBee(beeId);
    if (bee?.substrate !== "cell") {
      throw new RpcError("invalid_request", `bee ${beeId} is on substrate '${bee?.substrate}', not cell`);
    }
    const driver = this.driver;
    if (!driver) throw new RpcError("node_stopped", "daemon is shutting down");
    return { beeId, cell: driver.cell };
  }

  /**
   * `cell.capture`: CellDriver.capture verbatim. Refusals and conflicts are
   * RESULTS (the report is the answer — the UI renders a branch picker or a
   * conflict staging state), never RPC errors. The transient ref is named by
   * the idempotency key when given, so a replayed operation is one operation.
   */
  private rpcCellCapture(params: Record<string, unknown>): CellCaptureResult {
    const { beeId, cell } = this.requireCellBee(params);
    const targetBranch = this.param(params, "targetBranch");
    const mode = params.mode;
    if (mode !== "merge" && mode !== "rebase") {
      throw new RpcError("invalid_request", "cell.capture: mode must be merge|rebase");
    }
    const key = this.idempotencyKeyOf(params);
    const opId = `capture-${key ?? randomUUID()}`;
    if (!cell.cellOf(beeId)) {
      // Reserved but never provisioned (or already removed): nothing to capture.
      return {
        status: "refused",
        targetBranch,
        mode: mode as CellCaptureMode,
        cellHead: null,
        baseTarget: null,
        resultSha: null,
        conflicts: [],
        reason: "no_cell_head",
      };
    }
    const report = cell.capture(beeId, { targetBranch, mode: mode as CellCaptureMode, opId });
    this.log(
      `cell.capture bee=${beeId} onto=${targetBranch} mode=${mode} status=${report.status}` +
        (report.reason ? ` reason=${report.reason}` : "") +
        (report.resultSha ? ` result=${report.resultSha}` : "") +
        (report.conflicts.length > 0 ? ` conflicts=${report.conflicts.length}` : ""),
    );
    return { ...report };
  }

  /**
   * `cell.remove`: the A2 dirty guard (CellDriver.removeCell) then the bee's
   * lifecycle `delete` in the same call. Refused ⇒ nothing changed, no
   * command. A live runtime is a typed `runtime_refused` — stop it first.
   */
  private rpcCellRemove(params: Record<string, unknown>): CellRemoveResult {
    const { beeId, cell } = this.requireCellBee(params);
    const store = this.mustStore();
    if (params.force !== undefined && typeof params.force !== "boolean") {
      throw new RpcError("invalid_request", "cell.remove: force must be a boolean when given");
    }
    const force = params.force === true;
    const rt = store.currentRuntime(beeId);
    if ((rt && rt.state !== "stopped") || (rt && this.driver?.hasProcess(beeId, rt.generation))) {
      throw new RpcError("runtime_refused", `bee ${beeId} has a live runtime (${rt.state}); stop it before removing its cell`);
    }
    let result: CellRemoveResult;
    try {
      const res = cell.removeCell(beeId, { force });
      result = res.deleted
        ? { status: "deleted", forced: res.forced, report: res.report, commandId: null }
        : { status: "absent", forced: false, report: null, commandId: null };
    } catch (err) {
      if (err instanceof CellDeleteRefused) {
        this.log(`cell.remove bee=${beeId} refused dirty=${JSON.stringify(err.report)}`);
        return { status: "refused", forced: false, report: err.report, commandId: null };
      }
      if (err instanceof CellRuntimeLiveError) throw new RpcError("runtime_refused", err.message);
      throw err;
    }
    const key = this.idempotencyKeyOf(params);
    const cmd = store.enqueueCommand("delete", beeId, {}, key == null ? {} : { idempotencyKey: key });
    result.commandId = cmd.id;
    this.log(`cell.remove bee=${beeId} status=${result.status} forced=${result.forced} delete=${cmd.id}`);
    return result;
  }

  // -------------------------------------------------------------------------
  // v6 — pre-flip verb set: rename, tag, interrupt, fork, parenting, questions, seals
  // -------------------------------------------------------------------------

  /** `parentId?` — the calling bee; must exist (soft ref, but never a dangling one at spawn). */
  private parentParam(params: Record<string, unknown>): string | null {
    const v = params.parentId;
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length === 0) throw new RpcError("invalid_request", "parentId must be a non-empty string when given");
    if (!this.mustStore().getBee(v)) throw new RpcError("bee_not_found", `parent bee not found: ${v}`);
    return v;
  }

  private stringListParam(params: Record<string, unknown>, key: string, verb: string): string[] | undefined {
    const v = params[key];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) {
      throw new RpcError("invalid_request", `${verb}: ${key} must be an array of strings`);
    }
    return v as string[];
  }

  private rpcRename(params: Record<string, unknown>): RenameResult {
    const beeId = this.requireBee(params);
    const name = this.param(params, "name");
    const res = this.mustStore().renameBee(beeId, name);
    this.log(`bee.rename bee=${beeId} applied=${res.applied} name=${JSON.stringify(name)}`);
    return { bee: res.bee, applied: res.applied };
  }

  private rpcTag(params: Record<string, unknown>): TagResult {
    const beeId = this.requireBee(params);
    const add = this.stringListParam(params, "add", "bee.tag");
    const remove = this.stringListParam(params, "remove", "bee.tag");
    if (add === undefined && remove === undefined) throw new RpcError("invalid_request", "bee.tag: give add and/or remove");
    const res = this.mustStore().tagBee(beeId, { add, remove });
    this.log(`bee.tag bee=${beeId} applied=${res.applied} added=${JSON.stringify(res.added)} removed=${JSON.stringify(res.removed)}`);
    return { bee: res.bee, applied: res.applied, added: res.added, removed: res.removed };
  }

  /**
   * `bee.interrupt`: the driver's in-band turn interrupt against the bee's
   * CURRENT live generation. Idle / no runtime = a reasoned no-op result.
   * The runtime stays live; the turn_ended is observed by the loops.
   */
  private rpcInterrupt(params: Record<string, unknown>): InterruptResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const rt = store.currentRuntime(beeId);
    const driver = this.driver;
    let outcome: InterruptOutcome;
    if (!rt || rt.state === "stopped" || !driver) outcome = { interrupted: false, reason: "no_process" };
    else if (rt.state === "idle") outcome = { interrupted: false, reason: "idle" };
    else if (rt.state === "booting") outcome = { interrupted: false, reason: "not_ready" };
    else outcome = driver.interrupt(beeId, rt.generation);
    store.recordInterrupt(beeId, rt?.generation ?? null, outcome);
    this.log(`bee.interrupt bee=${beeId} gen=${rt?.generation ?? "-"} interrupted=${outcome.interrupted}${outcome.reason ? ` reason=${outcome.reason}` : ""}`);
    return {
      beeId,
      generation: rt?.generation ?? null,
      interrupted: outcome.interrupted,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }

  /**
   * `bee.fork`: a new bee cloned from the source's spawn shape with
   * `parentId` = `forkedFrom` = source and the one-shot fork seed (the
   * source's provider session id) so its first runtime forks the
   * conversation into a new session of its own. Same transaction: create,
   * fork provenance, spawn command, optional first message.
   */
  private rpcFork(params: Record<string, unknown>): ForkResult {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    if (key != null) {
      const original = store.getCommandByIdempotencyKey(key);
      if (original) {
        const bee = store.getBee(original.beeId);
        if (bee) {
          return { beeId: bee.id, commandId: original.id, forkedFrom: bee.forkedFrom ?? "", forkSeed: bee.forkSeed, messageId: null, bee, status: original.status, deduped: true };
        }
      }
    }
    const sourceId = this.requireBee(params);
    const source = store.getBee(sourceId);
    if (!source) throw new RpcError("bee_not_found", `bee not found: ${sourceId}`);
    if (source.substrate === "cell") {
      throw new RpcError("invalid_request", `bee ${sourceId} runs in a cell (single-tenant checkout); spawn a new cell bee instead of forking`);
    }
    const name = params.name === undefined ? `${source.name}-fork` : this.param(params, "name");
    const prompt = params.prompt === undefined || params.prompt === null ? null : this.param(params, "prompt");
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : randomUUID();
    const forkSeed = source.providerSessionId;
    const driver = this.driver;
    const { bee } = store.createBee({
      id,
      name,
      agent: source.agent,
      substrate: source.substrate,
      cwd: source.cwd,
      title: source.title ?? undefined,
      tags: [...source.tags],
      sessionLogPath: driver ? driver.sessionLogPath(id) : undefined,
      env: { ...source.env },
      args: source.args,
      parentId: source.id,
      forkedFrom: source.id,
      forkSeed,
    });
    store.recordFork(id, source.id, forkSeed);
    const cmd = store.enqueueCommand("spawn", id, {}, key == null ? {} : { idempotencyKey: key });
    const sent = prompt == null ? null : store.send(id, prompt, { sender: "operator" });
    this.log(`bee.fork source=${source.id} fork=${id} seed=${forkSeed ?? "-"} cmd=${cmd.id}${sent ? ` msg=${sent.message.id}` : ""}`);
    return { beeId: id, commandId: cmd.id, forkedFrom: source.id, forkSeed, messageId: sent?.message.id ?? null, bee };
  }

  private rpcChildren(params: Record<string, unknown>): ChildrenResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    return { beeId, children: store.listChildren(beeId).map((b) => this.viewOf(store, b.id)) };
  }

  private rpcQuestionAsk(params: Record<string, unknown>): QuestionAskResult {
    const beeId = this.requireBee(params);
    const text = this.param(params, "text");
    const options = this.stringListParam(params, "options", "question.ask");
    const question = this.mustStore().askQuestion(beeId, {
      ...(typeof params.id === "string" && params.id.length > 0 ? { id: params.id } : {}),
      text,
      options: options ?? null,
    });
    this.log(`question.ask bee=${beeId} question=${question.id}`);
    return { question };
  }

  private rpcQuestionAnswer(params: Record<string, unknown>): QuestionAnswerResult {
    const store = this.mustStore();
    const questionId = this.param(params, "questionId");
    const answer = this.param(params, "answer");
    if (!store.getQuestion(questionId)) throw new RpcError("question_not_found", `question not found: ${questionId}`);
    const answeredBy = typeof params.answeredBy === "string" && params.answeredBy.length > 0 ? params.answeredBy : "operator";
    const res = store.answerQuestion(questionId, answer, { answeredBy });
    this.log(`question.answer question=${questionId} bee=${res.question.beeId} msg=${res.send.message.id}${res.send.wakeCommand ? ` wake=${res.send.wakeCommand.id}` : ""}`);
    return {
      question: res.question,
      messageId: res.send.message.id,
      commandId: res.send.wakeCommand?.id ?? null,
      unarchived: res.send.unarchived,
    };
  }

  private rpcQuestionList(params: Record<string, unknown>): QuestionListResult {
    const store = this.mustStore();
    const beeId = params.beeId === undefined || params.beeId === null ? undefined : this.requireBee(params);
    if (params.open !== undefined && params.open !== null && typeof params.open !== "boolean") {
      throw new RpcError("invalid_request", "question.list: open must be a boolean when given");
    }
    const open = typeof params.open === "boolean" ? params.open : undefined;
    return { questions: store.listQuestions({ ...(beeId ? { beeId } : {}), ...(open !== undefined ? { open } : {}) }) };
  }

  private rpcSealCreate(params: Record<string, unknown>): SealCreateResult {
    const beeId = this.requireBee(params);
    const title = this.param(params, "title");
    const body = params.body === undefined || params.body === null ? "" : params.body;
    if (typeof body !== "string") throw new RpcError("invalid_request", "seal.create: body must be a string");
    const refs = this.stringListParam(params, "refs", "seal.create");
    const seal = this.mustStore().createSeal(beeId, {
      ...(typeof params.id === "string" && params.id.length > 0 ? { id: params.id } : {}),
      title,
      body,
      refs,
    });
    this.log(`seal.create bee=${beeId} seal=${seal.id}`);
    return { seal };
  }

  private rpcSealList(params: Record<string, unknown>): SealListResult {
    const store = this.mustStore();
    const beeId = params.beeId === undefined || params.beeId === null ? undefined : this.requireBee(params);
    return { seals: store.listSeals(beeId ? { beeId } : {}) };
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
      questions: store.listQuestions(),
      seals: store.listSeals(),
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
