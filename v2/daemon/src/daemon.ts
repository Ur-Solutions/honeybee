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
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import {
  accountIdFor,
  homeEnvFor,
  exportTemplate,
  exportTrack,
  importFromFrozen,
  importLocalConfig,
  importTemplate,
  importTrack,
  beeTaskList,
  isTaskStatus,
  isTaskTransitionAction,
  MESSAGE_URGENCIES,
  openCoreStore,
  TASK_TRANSITION_ACTIONS,
  serializePackage,
  type AccountRow,
  type BeeRow,
  type CommandRow,
  type CoreStore,
  type RowSource,
  type Scope,
  type Urgency,
} from "../../core/src/index.ts";
import { AccountsService, type LimitsFetchers, type LoginSeat } from "./accountsService.ts";
import type { KeychainReader, KeychainWriter } from "./keychain.ts";
import type { FlagEvidenceLike } from "./loops.ts";
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
import { TmuxDriver } from "../../driver-tmux/src/index.ts";
import { tmuxSpawnSpec } from "./tmuxHarness.ts";
import {
  claudeAdapter,
  claudeArgGrammar,
  codexAdapter,
  codexArgGrammar,
  grokAdapter,
  grokArgGrammar,
  grokSpawnPlan,
  codexSpawnPlan,
  composeArgv,
  stubAdapter,
  type ArgGrammar,
  type HarnessAdapter,
  type GrokMcpServerStdio,
} from "../../adapters/src/index.ts";
import { liveGateways } from "./gateways.ts";
import { DaemonCore, type BootReport, type I1ViolationEvent } from "./loops.ts";
import {
  ConfigError,
  loadNodeConfig,
  patchNamingConfig,
  publicNamingConfig,
  type AgentSpecConfig,
  type NamingConfig,
  type ResolvedNamingConfig,
  type ResolvedNodeConfig,
} from "./config.ts";
import { createStoreAutoTitleDispatcher, type AutoTitleOutcome } from "./autoTitle.ts";
import { TitleGeneratorService } from "./namingService.ts";
import { TelemetryStore, formatI1Violation } from "./telemetry.ts";
import { RpcServer, type RpcConn } from "./rpc.ts";
import {
  DAEMON_VERSION,
  PROTOCOL,
  RpcError,
  SPAWN_SUBSTRATES,
  type AccountAddResult,
  type AccountBackfillResult,
  type AccountGetResult,
  type AccountImportRegistryResult,
  type AccountLimitsResult,
  type AccountListResult,
  type AccountLoginResult,
  type AccountRemoveResult,
  type AccountUpdateResult,
  type AuditTailResult,
  type LoginSeatInfo,
  type SwapAccountResult,
  type CellCaptureMode,
  type CellCaptureResult,
  type CellRemoveResult,
  type ChildrenResult,
  type ConfigGetResult,
  type ConfigPatchResult,
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
  type TaskAddResult,
  type TaskClaimResult,
  type TaskEditResult,
  type TaskGetResult,
  type TaskListResult,
  type TaskListsResult,
  type TaskMoveResult,
  type TaskSupplyGetResult,
  type TaskSupplySetResult,
  type TaskTransitionResult,
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

const ADAPTER_NAMES = ["claude", "codex", "grok", "stub"] as const;

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
function adapterFor(
  name: string,
  cwd: string,
  providerSessionId: string | null,
  model?: string,
  forkSeed?: string | null,
  grokMcpServers: readonly GrokMcpServerStdio[] = [],
): HarnessAdapter | null {
  switch (name) {
    case "claude":
      return claudeAdapter;
    case "codex":
      return codexAdapter({
        cwd,
        ...(providerSessionId ? { resumeThreadId: providerSessionId } : forkSeed ? { forkThreadId: forkSeed } : {}),
        ...(model ? { model } : {}),
      });
    case "grok":
      return grokAdapter({
        cwd,
        mcpServers: grokMcpServers,
        ...(providerSessionId ? { resumeSessionId: providerSessionId } : {}),
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
    case "grok":
      return grokArgGrammar;
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
  grokMcpServers: readonly GrokMcpServerStdio[] = [],
): { adapter: HarnessAdapter | null; args: string[]; model: string | undefined } {
  const grammar = grammarFor(adapterName);
  // v6 fork: a fork with no session of its own yet forks the SOURCE's
  // conversation (`--resume <seed> --fork-session` / thread/fork) into a new
  // one; once its own id is recorded the seed is consumed and plain resume
  // takes over. A recorded session always wins over a stale seed.
  const forkSeed = bee.providerSessionId ? null : (bee.forkSeed ?? null);
  const base = adapterFor(adapterName, bee.cwd, bee.providerSessionId, undefined, forkSeed, grokMcpServers);
  const resume = bee.providerSessionId && base?.resumeArgs
    ? base.resumeArgs(bee.providerSessionId)
    : forkSeed && base?.forkArgs
      ? base.forkArgs(forkSeed)
      : [];
  const composed = composeArgv(grammar, [spec.args, spec.defaultArgs, bee.args, resume]);
  if (adapterName === "codex") {
    const plan = codexSpawnPlan(composed);
    return { adapter: adapterFor(adapterName, bee.cwd, bee.providerSessionId, plan.model, forkSeed, grokMcpServers), args: plan.argv, model: plan.model };
  }
  if (adapterName === "grok") {
    const plan = grokSpawnPlan(composed);
    return { adapter: adapterFor(adapterName, bee.cwd, bee.providerSessionId, undefined, forkSeed, grokMcpServers), args: plan.argv, model: plan.model };
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

/** v7: injectable transports for in-process tests (the daemon binary uses the defaults). */
export interface HiveDaemonDeps {
  keychainReader?: KeychainReader;
  keychainWriter?: KeychainWriter;
  fetchers?: LimitsFetchers;
}

/** Rate-limit cause classifier for resource_blocked evidence (spec 08 rotation trigger). */
export function isRateLimitCause(detail: string): boolean {
  const m = detail.toLowerCase();
  return m.includes("rate limit") || m.includes("rate-limit") || m.includes("rate_limit") || m.includes("429") || (m.includes("quota") && (m.includes("exceeded") || m.includes("exhausted"))) || m.includes("usage limit");
}

/** Per-bee rotation opt-out: tag or arg `autoswap=false` (also `--autoswap=false`). */
export function autoswapDisabled(bee: { tags: string[]; args: string[] | null }): boolean {
  const spelled = (v: string) => /^-{0,2}autoswap=false$/i.test(v.trim());
  return bee.tags.some(spelled) || (bee.args ?? []).some(spelled);
}

/** Verbs whose result `status` is the verb's own report, not a command status (see withIdempotency). */
const OWN_STATUS_VERBS: ReadonlySet<RpcVerb> = new Set<RpcVerb>(["cell.capture", "cell.remove"]);

export class HiveDaemon {
  readonly cfg: ResolvedNodeConfig;
  private store: CoreStore | null = null;
  /** The substrate router DaemonCore drives; `.hsr` / `.cell` / `.tmux` are the substrate drivers. */
  private driver: SubstrateRouter | null = null;
  private core: DaemonCore | null = null;
  private telemetry: TelemetryStore | null = null;
  private rpc: RpcServer | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  /** Event-loop delay histogram: stalls anywhere (tick, RPC handler, fs) starve the accept loop. */
  private loopDelay: IntervalHistogram | null = null;
  private loopDelayTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private ticks = 0;
  private tickErrors = 0;
  private lastTickAt: number | null = null;
  private lastBoot: BootReport | null = null;
  private stopping = false;
  private publishedSeq = 0;
  private readonly opLog: string[] = [];
  private accounts: AccountsService | null = null;
  private readonly deps: HiveDaemonDeps;
  /** v7 rotation bound: one attempt per (bee, generation) exhaustion event. */
  private readonly rotatedGenerations = new Map<string, number>();
  private naming: ResolvedNamingConfig;
  private autoTitle: ((bees?: BeeRow[]) => Promise<AutoTitleOutcome[]>) | null = null;
  private titleGenerator: TitleGeneratorService | null = null;

  constructor(cfg: ResolvedNodeConfig, deps: HiveDaemonDeps = {}) {
    this.cfg = cfg;
    this.deps = deps;
    this.naming = cfg.naming;
  }

  /** The account plane (tests reach the selector / login seat / importer through it). */
  get accountsService(): AccountsService {
    if (!this.accounts) throw new Error("daemon not started");
    return this.accounts;
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
    const codexSpec = this.cfg.agents.codex;
    this.titleGenerator = new TitleGeneratorService({
      log: (op) => this.log(op),
      ...(codexSpec?.command ? { codexCommand: codexSpec.command } : {}),
      ...(codexSpec?.args ? { codexArgs: codexSpec.args } : {}),
    });
    this.autoTitle = createStoreAutoTitleDispatcher(store, {
      naming: () => this.naming,
      statePath: join(this.cfg.dataDir, "auto-title.json"),
      log: (op) => this.log(op),
      generate: (context) => this.titleGenerator!.generate(context, this.naming),
    });
    this.titleGenerator.warm(this.naming);
    this.accounts = new AccountsService({
      store,
      cfg: this.cfg,
      log: (op) => this.log(op),
      keychainReader: this.deps.keychainReader,
      keychainWriter: this.deps.keychainWriter,
      fetchers: this.deps.fetchers,
    });
    const hsrConfig = {
      sessionLogDir: this.cfg.sessionLogDir,
      stopKillGraceMs: this.cfg.stopKillGraceMs,
      adoptToleranceMs: this.cfg.adoptToleranceMs,
      // WP5 runner host: in production v2 ships as a single bundle, so the
      // driver's source-path default cannot exist — the host is our own CLI
      // entry re-invoked with the hidden runner-host verb. Under tests the
      // daemon is constructed in-process (argv[1] is the test runner), so
      // only claim the entry when it is recognizably the hive CLI.
      ...(process.argv[1] && /(?:^|\/)(?:hive|cli\.[cm]?js)$/.test(process.argv[1])
        ? {
            hostCommand: (configPath: string) => ({
              command: process.execPath,
              args: [process.argv[1] as string, "v2", "runner-host", configPath],
            }),
          }
        : {}),
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
      backgroundProvisioning: true,
    });
    mkdirSync(join(this.cfg.dataDir, "tmux-events"), { recursive: true });
    const tmux = new TmuxDriver({
      socketPath: join(this.cfg.dataDir, "tmux.sock"),
      eventsDir: join(this.cfg.dataDir, "tmux-events"),
      sessionLogDir: this.cfg.sessionLogDir,
      resolve: (beeId: string) => this.resolveTmuxSpec(beeId),
      stopKillGraceMs: this.cfg.stopKillGraceMs,
      adoptToleranceMs: this.cfg.adoptToleranceMs,
    });
    const driver = new SubstrateRouter({
      hsr,
      cell,
      tmux,
      substrateOf: (beeId: string) => store.getBee(beeId)?.substrate ?? null,
    });
    this.driver = driver;
    this.core = new DaemonCore({
      store,
      driver,
      policy: {
        bootHangTimeoutSteps: this.cfg.bootHangTimeoutMs,
        commandsPerStep: this.cfg.commandsPerTick,
        idleWindowSteps: this.cfg.idleWindowMs > 0 ? this.cfg.idleWindowMs : null,
        i1DeadlineSteps: this.cfg.i1DeadlineMs,
      },
      now: Date.now,
      log: (op) => this.log(op),
      onI1Violation: (v) => this.recordI1(v),
      removeSessionLog: (path) => rmSync(path, { force: true }),
      onFlagEvidence: (ev) => this.applyAccountPolicy(ev),
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
    // Loop-delay watch (2026-08-21): tick.slow attributes stalls inside the
    // tick; this catches the rest (sync RPC-handler work, keychain/tmux
    // shell-outs) — at most one log line per minute, when the loop stalled.
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.loopDelay.enable();
    this.loopDelayTimer = setInterval(() => {
      const h = this.loopDelay;
      if (!h) return;
      const maxMs = Math.round(h.max / 1e6);
      const p99Ms = Math.round(h.percentile(99) / 1e6);
      if (maxMs >= 500) this.log(`loop.stall max=${maxMs}ms p99=${p99Ms}ms window=60s`);
      h.reset();
    }, 60_000);
    this.loopDelayTimer.unref();
    this.log(`daemon.started pid=${process.pid} store=${this.cfg.storePath}`);
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`daemon.stopping pid=${process.pid}`);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.loopDelayTimer) clearInterval(this.loopDelayTimer);
    this.loopDelay?.disable();
    this.tickTimer = null;
    this.titleGenerator?.close();
    this.titleGenerator = null;
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
    const t0 = Date.now();
    let tStep = t0;
    let tAccounts = t0;
    try {
      core.step();
      tStep = Date.now();
      this.ticks += 1;
      this.lastTickAt = tStep;
      // v7: bounded in-daemon limits refresh + login-seat watch (no forks).
      this.accounts?.periodicRefreshTick();
      tAccounts = Date.now();
      void this.pollLoginSeats();
      void this.autoTitle?.()
        .then((outcomes) => {
          for (const outcome of outcomes) {
            if (outcome.error) this.log(`autoTitle.error bee=${outcome.beeId} ${outcome.error}`);
          }
        })
        .catch((error) => {
          this.log(`autoTitle.error ${error instanceof Error ? error.message : String(error)}`);
        });
    } catch (err) {
      // A tick error is a bug, never a reason to abandon the node: the loops
      // are idempotent over durable state, so the next tick retries.
      this.tickErrors += 1;
      this.log(`tick.error ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    this.flushWatchers();
    const tEnd = Date.now();
    // Accept-loop starvation attribution (2026-08-21): the daemon is single-
    // threaded, so any slow tick IS an RPC stall. Log the phase breakdown for
    // every tick that would eat a visible slice of a client's timeout budget.
    if (tEnd - t0 >= 250) {
      this.log(
        `tick.slow total=${tEnd - t0}ms step=${tStep - t0}ms accounts=${tAccounts - tStep}ms flush=${tEnd - tAccounts}ms`,
      );
    }
  }

  private flushWatchers(): void {
    const store = this.store;
    const rpc = this.rpc;
    if (!store || !rpc) return;
    const latest = store.lastAuditSeq();
    if (latest > this.publishedSeq) this.publishedSeq = latest;
    // maxBatch+1: one extra row is exactly enough to detect a gap without
    // materializing the backlog (the 2026-08-21 flush stall).
    rpc.flushWatch(latest, (fromSeq) => store.auditRows(fromSeq, this.cfg.watchMaxBatch + 1), this.cfg.watchMaxBatch);
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
    const adapterName = spec.adapter ?? bee.agent;
    const grokMcpServers: GrokMcpServerStdio[] = adapterName === "grok"
      ? liveGateways().map((gateway) => ({
        name: gateway.name,
        command: gateway.shim.command,
        args: [...gateway.shim.args],
        env: Object.entries(gateway.env).map(([name, value]) => ({ name, value })),
      }))
      : [];
    const { adapter, args } = composeSpawn(spec, adapterName, bee, grokMcpServers);
    if (!adapter) throw new Error(`resolve: no adapter for agent '${bee.agent}'`);
    // v7 (spec 08): a bound bee runs in its account's home. The env is derived
    // from the account row (the mechanism), and an EMPTY home is activated
    // from the vault right here — a populated home is never touched.
    let accountEnv: Record<string, string> = {};
    if (bee.account && this.accounts) {
      const account = store.getAccount(bee.account);
      if (!account) throw new Error(`resolve: bee ${beeId} is bound to unknown account ${bee.account}`);
      accountEnv = this.accounts.homeEnvOf(account);
      this.accounts.activateForSpawn(account, bee);
    }
    return {
      adapter,
      command: spec.command,
      args,
      cwd: bee.cwd,
      env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}), ...bee.env, ...accountEnv, ...beeIdentityEnv(bee) },
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

  /**
   * Tmux TUI spawn: same account/home env as HSR, but the interactive CLI
   * (no headless plumbing args) plus the harness transcript locator.
   */
  private resolveTmuxSpec(beeId: string): ReturnType<typeof tmuxSpawnSpec> {
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) throw new Error(`resolveTmux: bee ${beeId} not found`);
    const spec = this.cfg.agents[bee.agent];
    if (!spec) throw new Error(`resolveTmux: no agent spec for '${bee.agent}'`);
    let accountEnv: Record<string, string> = {};
    if (bee.account && this.accounts) {
      const account = store.getAccount(bee.account);
      if (!account) throw new Error(`resolveTmux: bee ${beeId} is bound to unknown account ${bee.account}`);
      accountEnv = this.accounts.homeEnvOf(account);
      this.accounts.activateForSpawn(account, bee);
    }
    const env = { ...(process.env as Record<string, string>), ...(spec.env ?? {}), ...bee.env, ...accountEnv, ...beeIdentityEnv(bee) };
    return tmuxSpawnSpec(spec, { agent: bee.agent, cwd: bee.cwd, args: bee.args, env });
  }

  private adoptSurvivors(store: CoreStore, driver: SubstrateRouter): void {
    for (const bee of store.listBees()) {
      const rt = store.currentRuntime(bee.id);
      if (!rt || rt.state === "stopped" || rt.pid == null || rt.pidStartedAt == null) continue;
      const lastKnownState =
        rt.state === "booting" || rt.state === "running" || rt.state === "idle" ? rt.state : undefined;
      const adopted = driver.adopt(bee.id, rt.generation, rt.pid, rt.pidStartedAt, lastKnownState);
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

  private numberParam(params: Record<string, unknown>, key: string): number {
    const v = params[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new RpcError("invalid_request", `param '${key}' must be a positive integer`);
    }
    return v;
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
        return this.rpcSpawnWithAccount(params);
      case "bee.swapAccount":
        return this.withIdempotency(verb, params, () => this.rpcSwapAccount(params));
      case "config.get":
        return this.rpcConfigGet();
      case "config.patch":
        return this.withIdempotency(verb, params, () => this.rpcConfigPatch(params));
      case "account.list":
        return this.rpcAccountList(params);
      case "account.get":
        return this.rpcAccountGet(params);
      case "account.add":
        return this.withIdempotency(verb, params, () => this.rpcAccountAdd(params));
      case "account.remove":
        return this.withIdempotency(verb, params, () => ({ account: this.mustStore().removeAccount(this.param(params, "id")) }) satisfies AccountRemoveResult);
      case "account.pause":
        return this.withIdempotency(verb, params, () => this.rpcAccountStatus(params, "paused"));
      case "account.unpause":
        return this.withIdempotency(verb, params, () => this.rpcAccountStatus(params, "ok"));
      case "account.setPenalty":
        return this.withIdempotency(verb, params, () => this.rpcAccountSetPenalty(params));
      case "account.login":
        return this.rpcAccountLogin(params);
      case "account.limits":
        return this.rpcAccountLimits(params);
      case "account.importRegistry":
        return this.withIdempotency(verb, params, () => this.rpcAccountImportRegistry(params));
      case "account.backfill":
        return this.withIdempotency(verb, params, () => this.rpcAccountBackfill(params));
      case "send":
        return this.withIdempotency(verb, params, () => this.rpcSend(params));
      case "mail.cancel": {
        // Direct mailbox mutation (like send): cancel an undelivered message.
        const res = this.mustStore().cancelMessage(this.numberParam(params, "messageId"));
        if (!res.canceled) throw new RpcError("invalid_request", `mail.cancel: message ${res.reason}`);
        return res;
      }
      case "mail.expedite": {
        const urgency = this.param(params, "urgency");
        if (!(MESSAGE_URGENCIES as readonly string[]).includes(urgency)) {
          throw new RpcError("invalid_request", `mail.expedite: urgency must be one of ${MESSAGE_URGENCIES.join("|")}`);
        }
        const res = this.mustStore().expediteMessage(this.numberParam(params, "messageId"), urgency as Urgency);
        if (!res.applied) throw new RpcError("invalid_request", `mail.expedite: message ${res.reason}`);
        return res;
      }
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
      case "task.add":
        return this.withIdempotency(verb, params, () => this.rpcTaskAdd(params));
      case "task.list":
        return this.rpcTaskList(params);
      case "task.get":
        return this.rpcTaskGet(params);
      case "task.transition":
        return this.withIdempotency(verb, params, () => this.rpcTaskTransition(params));
      case "task.claim":
        return this.withIdempotency(verb, params, () => this.rpcTaskClaim(params));
      case "task.move":
        return this.withIdempotency(verb, params, () => this.rpcTaskMove(params));
      case "task.edit":
        return this.withIdempotency(verb, params, () => this.rpcTaskEdit(params));
      case "task.lists":
        return { lists: this.mustStore().listTaskLists() } satisfies TaskListsResult;
      case "task.supply.get":
        return this.rpcTaskSupplyGet(params);
      case "task.supply.set":
        return this.withIdempotency(verb, params, () => this.rpcTaskSupplySet(params));
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
      case "audit.tail":
        return this.rpcAuditTail(params);
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

  /**
   * v7 (spec 08): `spawn {account?}` — 'auto' (default) resolves to a concrete
   * account BEFORE the bee row is written; the bounded limits refresh for
   * stale rows happens first (async), then the pick + createBee + spawn
   * command run in ONE store transaction under the idempotency wrapper.
   */
  private async rpcSpawnWithAccount(params: Record<string, unknown>): Promise<SpawnResult> {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    // A replayed key answers from the record without paying a limits fetch.
    if (key != null && store.lookupRpcResult(key)) return this.withIdempotency("spawn", params, () => this.rpcSpawn(params, null));
    const agent = this.param(params, "agent");
    const request = this.accountParam(params);
    if (request === "auto" && this.accounts && store.listAccounts({ harness: agent }).length > 1) {
      // Refresh stale limits for the candidates (bounded; failures become
      // unreadable rows and never block the spawn).
      await this.accounts.ensureFreshLimits(agent, { model: this.modelParamOf(params, agent) });
    }
    return this.withIdempotency("spawn", params, () => this.rpcSpawn(params, request));
  }

  /** `account?` on spawn: undefined → 'auto'; null → unbound; string → explicit id (or 'auto'). */
  private accountParam(params: Record<string, unknown>): string | null {
    const v = params.account;
    if (v === undefined) return "auto";
    if (v === null) return null;
    if (typeof v !== "string" || v.length === 0) throw new RpcError("invalid_request", "spawn: account must be an account id, 'auto', or null");
    return v;
  }

  /** The `--model` the bee will run with (for the Fable-scoped selection tier): bee args over agent defaults. */
  private modelParamOf(params: Record<string, unknown>, agent: string): string | undefined {
    const args = Array.isArray(params.args) ? (params.args as unknown[]).filter((a): a is string => typeof a === "string") : [];
    const spec = this.cfg.agents[agent];
    const all = [...(spec?.defaultArgs ?? []), ...args];
    let model: string | undefined;
    for (let i = 0; i < all.length; i += 1) {
      const a = all[i] as string;
      if (a === "--model" || a === "-m") model = all[i + 1];
      else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    }
    return model;
  }

  /**
   * Resolve the account for a new bee: explicit id → validated
   * (account_not_found / account_paused / harness_mismatch); 'auto' → the
   * calibrated selector (unbound when the harness has no accounts at all;
   * `account_unavailable` when it has some but none is usable); null →
   * unbound.
   */
  private resolveSpawnAccount(request: string | null, agent: string, params: Record<string, unknown>): { account: AccountRow | null; reason: string | null } {
    const store = this.mustStore();
    if (request === null) return { account: null, reason: null };
    if (request !== "auto") {
      const account = store.getAccount(request);
      if (!account) throw new RpcError("account_not_found", `account not found: ${request}`);
      if (account.harness !== agent) throw new RpcError("harness_mismatch", `account ${account.id} is a ${account.harness} account; the bee runs ${agent}`);
      if (account.status === "paused") throw new RpcError("account_paused", `account ${account.id} is paused; unpause it or pick another`);
      return { account, reason: "explicit" };
    }
    if (!this.accounts || store.listAccounts({ harness: agent }).length === 0) return { account: null, reason: null };
    const pick = this.accounts.pick(agent, { model: this.modelParamOf(params, agent) });
    if (!pick.ok) throw new RpcError("account_unavailable", pick.message);
    return { account: pick.account, reason: pick.reason };
  }

  private rpcSpawn(params: Record<string, unknown>, accountRequest: string | null): SpawnResult {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    // Belt-and-braces guard for a key already stamped on a command at the
    // CORE level (e.g. by a library caller): answer with the original spawn
    // instead of minting a second bee. Normally the rpc_idempotency record in
    // withIdempotency answers first.
    if (key != null) {
      const original = store.getCommandByIdempotencyKey(key);
      if (original) {
        const prompt = typeof params.prompt === "string" && params.prompt.length > 0 ? params.prompt : null;
        const messageId = prompt == null
          ? null
          : store.listMessages(original.beeId).find((message) =>
              message.sender === "operator" && message.body === prompt
            )?.id ?? null;
        return {
          beeId: original.beeId,
          handle: store.getBee(original.beeId)?.handle ?? null,
          commandId: original.id,
          messageId,
          status: original.status,
          deduped: true,
        };
      }
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
    // v7: the account is resolved BEFORE the row is written ('auto' is never
    // stored); the home env is derived from the account row.
    const { account, reason: accountReason } = this.resolveSpawnAccount(accountRequest, agent, params);
    const accountEnv = account && this.accounts ? this.accounts.homeEnvOf(account) : {};
    const requestedEnv = this.spawnEnvParam(params);
    // Cell substrate: the cell owns the cwd (the space checkout). The seed
    // ledger is written in the same call, AFTER the row exists (createBee
    // is the id/name gate) and before the spawn command is enqueued —
    // inside the idempotency transaction, so a failure here leaves no bee.
    const cell = substrate === "cell" ? this.planCell(id, name, this.cellParam(params)) : null;
    const { bee: created } = store.createBee({
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
      env: { ...requestedEnv, ...accountEnv },
      ...(account ? { account: account.id } : {}),
    });
    if (cell) {
      reserveCell(this.cfg.cellsRoot, cell.reserve);
      this.log(`cell.reserve bee=${id} origin=${cell.reserve.originRepo} sha=${cell.reserve.sha} space=${cell.spaceDir}`);
    }
    const cmd = store.enqueueCommand("spawn", id, {}, key == null ? {} : { idempotencyKey: key });
    const prompt = params.prompt === undefined || params.prompt === null
      ? null
      : this.param(params, "prompt");
    const sent = prompt == null || prompt.length === 0
      ? null
      : store.send(id, prompt, { sender: "operator" });
    if (account) this.log(`spawn.account bee=${id} account=${account.id}${accountReason ? ` reason=${JSON.stringify(accountReason)}` : ""}`);
    return {
      beeId: id,
      handle: created.handle,
      commandId: cmd.id,
      messageId: sent?.message.id ?? null,
      account: account?.id ?? null,
      ...(accountReason && accountReason !== "explicit" ? { accountReason } : {}),
    };
  }

  private substrateParam(params: Record<string, unknown>): SpawnSubstrate {
    const v = params.substrate;
    if (v === undefined || v === null) return "hsr";
    if (typeof v !== "string" || !(SPAWN_SUBSTRATES as readonly string[]).includes(v)) {
      throw new RpcError("invalid_request", `substrate must be one of ${SPAWN_SUBSTRATES.join("|")}`);
    }
    return v as SpawnSubstrate;
  }

  /** Optional per-bee environment supplied by versioned spawn/template RPC callers. */
  private spawnEnvParam(params: Record<string, unknown>): Record<string, string> {
    const value = params.env;
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RpcError("invalid_request", "spawn: env must be an object of string values");
    }
    const entries = Object.entries(value);
    if (entries.some(([, item]) => typeof item !== "string")) {
      throw new RpcError("invalid_request", "spawn: env must be an object of string values");
    }
    return Object.fromEntries(entries) as Record<string, string>;
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

  private rpcConfigGet(): ConfigGetResult {
    try {
      this.naming = loadNodeConfig(this.cfg.dataDir, this.cfg.configPath).naming;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      throw new RpcError("invalid_request", err.message);
    }
    return { naming: publicNamingConfig(this.naming), configPath: this.cfg.configPath };
  }

  private rpcConfigPatch(params: Record<string, unknown>): ConfigPatchResult {
    const namingRaw = params.naming;
    if (namingRaw === null || typeof namingRaw !== "object" || Array.isArray(namingRaw)) {
      throw new RpcError("invalid_request", "config.patch: naming must be an object");
    }
    const raw = namingRaw as Record<string, unknown>;
    const patch: NamingConfig = {};
    if (raw.auto !== undefined) {
      if (typeof raw.auto !== "boolean") throw new RpcError("invalid_request", "config.patch: naming.auto must be a boolean");
      patch.auto = raw.auto;
    }
    if (raw.backend !== undefined) {
      if (raw.backend !== "codex-app-server" && raw.backend !== "openai-api" && raw.backend !== "claude-cli") {
        throw new RpcError(
          "invalid_request",
          'config.patch: naming.backend must be "codex-app-server", "openai-api", or "claude-cli"',
        );
      }
      patch.backend = raw.backend;
    }
    if (raw.tool !== undefined) {
      if (raw.tool !== "codex" && raw.tool !== "claude") {
        throw new RpcError("invalid_request", 'config.patch: naming.tool must be "codex" or "claude"');
      }
      patch.tool = raw.tool;
    }
    if (raw.model !== undefined) {
      if (typeof raw.model !== "string" || raw.model.length === 0) {
        throw new RpcError("invalid_request", "config.patch: naming.model must be a non-empty string");
      }
      patch.model = raw.model;
    }
    if (raw.effort !== undefined) {
      if (typeof raw.effort !== "string" || raw.effort.length === 0) {
        throw new RpcError("invalid_request", "config.patch: naming.effort must be a non-empty string");
      }
      patch.effort = raw.effort as NamingConfig["effort"];
    }
    if (raw.apiKey !== undefined) {
      if (typeof raw.apiKey !== "string") {
        throw new RpcError("invalid_request", "config.patch: naming.apiKey must be a string");
      }
      patch.apiKey = raw.apiKey;
    }
    if (raw.command !== undefined) {
      if (typeof raw.command !== "string") {
        throw new RpcError("invalid_request", "config.patch: naming.command must be a string");
      }
      patch.command = raw.command;
    }
    if (Object.keys(patch).length === 0) {
      throw new RpcError("invalid_request", "config.patch: give at least one naming field");
    }
    try {
      this.naming = patchNamingConfig(this.cfg.configPath, this.cfg.dataDir, patch);
    } catch (err) {
      throw new RpcError("invalid_request", err instanceof Error ? err.message : String(err));
    }
    this.titleGenerator?.reconfigure(this.naming);
    this.log(`config.patch naming=${JSON.stringify(publicNamingConfig(this.naming))}`);
    return { naming: publicNamingConfig(this.naming), configPath: this.cfg.configPath };
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
      // v7: a fork runs on the source's account (same identity, same home).
      account: source.account,
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

  private rpcTaskAdd(params: Record<string, unknown>): TaskAddResult {
    const store = this.mustStore();
    const title = this.param(params, "title");
    let list: string;
    if (typeof params.list === "string" && params.list.length > 0) {
      list = params.list;
    } else {
      const beeId = this.requireBee(params);
      list = beeTaskList(beeId);
    }
    const originKind =
      params.originKind === "user" || params.originKind === "self" || params.originKind === "bee"
        ? params.originKind
        : "user";
    const originSender =
      typeof params.originSender === "string" && params.originSender.length > 0 ? params.originSender : "operator";
    const body = params.body === undefined || params.body === null ? undefined : params.body;
    if (body !== undefined && typeof body !== "string") throw new RpcError("invalid_request", "task.add: body must be a string");
    const autoRequested = typeof params.auto === "boolean" ? params.auto : undefined;
    const questId = typeof params.questId === "string" && params.questId.length > 0 ? params.questId : undefined;
    let context: Record<string, unknown> | undefined;
    if (params.context !== undefined && params.context !== null) {
      if (typeof params.context !== "object" || Array.isArray(params.context)) {
        throw new RpcError("invalid_request", "task.add: context must be a JSON object");
      }
      context = params.context as Record<string, unknown>;
    }
    try {
      const res = store.addTask({
        list,
        title,
        originKind,
        originSender,
        ...(body !== undefined ? { body } : {}),
        ...(autoRequested !== undefined ? { autoRequested } : {}),
        ...(questId !== undefined ? { questId } : {}),
        ...(context !== undefined ? { context } : {}),
      });
      this.log(`task.add list=${res.task.list} task=${res.task.id}`);
      return { task: res.task, ...(res.warning ? { warning: res.warning } : {}) };
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError("invalid_request", err instanceof Error ? err.message : String(err));
    }
  }

  private rpcTaskList(params: Record<string, unknown>): TaskListResult {
    const store = this.mustStore();
    let list: string | undefined;
    let beeId: string | undefined;
    if (typeof params.list === "string" && params.list.length > 0) list = params.list;
    else if (params.beeId !== undefined && params.beeId !== null) {
      beeId = this.requireBee(params);
      list = beeTaskList(beeId);
    }
    let statuses: Array<"pending" | "queued" | "in-progress" | "done" | "blocked" | "cancelled"> | undefined;
    if (params.statuses !== undefined && params.statuses !== null) {
      if (!Array.isArray(params.statuses) || params.statuses.some((s) => !isTaskStatus(s))) {
        throw new RpcError("invalid_request", "task.list: statuses must be an array of known statuses");
      }
      statuses = params.statuses as NonNullable<typeof statuses>;
    }
    const tasks = store.listTasks({
      ...(list ? { list } : {}),
      ...(beeId && !list ? { beeId } : {}),
      ...(statuses ? { statuses } : {}),
    });
    return { list: list ?? null, tasks };
  }

  private rpcTaskGet(params: Record<string, unknown>): TaskGetResult {
    const taskId = this.param(params, "taskId");
    const task = this.mustStore().getTask(taskId);
    if (!task) throw new RpcError("task_not_found", `task not found: ${taskId}`);
    return { task };
  }

  private rpcTaskTransition(params: Record<string, unknown>): TaskTransitionResult {
    const taskId = this.param(params, "taskId");
    const action = this.param(params, "action");
    if (!isTaskTransitionAction(action)) {
      throw new RpcError("invalid_request", `task.transition: action must be one of ${TASK_TRANSITION_ACTIONS.join("|")}`);
    }
    if (!this.mustStore().getTask(taskId)) throw new RpcError("task_not_found", `task not found: ${taskId}`);
    const reason = typeof params.reason === "string" && params.reason.length > 0 ? params.reason : undefined;
    const task = this.mustStore().transitionTask(taskId, action, reason !== undefined ? { reason } : {});
    this.log(`task.${action} task=${taskId} status=${task.status}`);
    return { task };
  }

  private rpcTaskClaim(params: Record<string, unknown>): TaskClaimResult {
    const list = this.param(params, "list");
    const claimant = this.param(params, "claimant");
    const task = this.mustStore().claimTask(list, claimant);
    return { task };
  }

  private rpcTaskMove(params: Record<string, unknown>): TaskMoveResult {
    const taskId = this.param(params, "taskId");
    if (!this.mustStore().getTask(taskId)) throw new RpcError("task_not_found", `task not found: ${taskId}`);
    const before = typeof params.before === "string" && params.before.length > 0 ? params.before : undefined;
    const after = typeof params.after === "string" && params.after.length > 0 ? params.after : undefined;
    const task = this.mustStore().moveTask(taskId, { ...(before ? { before } : {}), ...(after ? { after } : {}) });
    return { task };
  }

  private rpcTaskEdit(params: Record<string, unknown>): TaskEditResult {
    const taskId = this.param(params, "taskId");
    if (!this.mustStore().getTask(taskId)) throw new RpcError("task_not_found", `task not found: ${taskId}`);
    const title = typeof params.title === "string" ? params.title : undefined;
    const body = params.body === undefined ? undefined : params.body === null ? null : params.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new RpcError("invalid_request", "task.edit: body must be a string or null");
    }
    const auto = typeof params.auto === "boolean" ? params.auto : undefined;
    const task = this.mustStore().editTask(taskId, {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(auto !== undefined ? { auto } : {}),
    });
    return { task };
  }

  private rpcTaskSupplyGet(params: Record<string, unknown>): TaskSupplyGetResult {
    const beeId = this.requireBee(params);
    return { supply: this.mustStore().getTaskSupply(beeId) };
  }

  private rpcTaskSupplySet(params: Record<string, unknown>): TaskSupplySetResult {
    const beeId = this.requireBee(params);
    if (params.on !== undefined && params.on !== null && typeof params.on !== "boolean") {
      throw new RpcError("invalid_request", "task.supply.set: on must be a boolean");
    }
    if (params.limit !== undefined && params.limit !== null && typeof params.limit !== "number") {
      throw new RpcError("invalid_request", "task.supply.set: limit must be a number");
    }
    const supply = this.mustStore().setTaskSupply(beeId, {
      ...(typeof params.on === "boolean" ? { on: params.on } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    });
    this.log(`task.supply bee=${beeId} on=${supply.on} limit=${supply.limit} paused=${supply.paused}`);
    return { supply };
  }

  private rpcSend(params: Record<string, unknown>): SendRpcResult {
    const store = this.mustStore();
    const beeId = this.param(params, "beeId");
    const body = this.param(params, "body");
    const sender = typeof params.sender === "string" && params.sender.length > 0 ? params.sender : "operator";
    // v8: optional delivery urgency (spec 01 Q2 amendment); omitted = 'next'.
    let urgency: Urgency = "next";
    if (params.urgency !== undefined && params.urgency !== null) {
      if (typeof params.urgency !== "string" || !(MESSAGE_URGENCIES as readonly string[]).includes(params.urgency)) {
        throw new RpcError("invalid_request", `send: urgency must be one of ${MESSAGE_URGENCIES.join("|")}`);
      }
      urgency = params.urgency as Urgency;
    }
    const res = store.send(beeId, body, { sender, urgency });
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
    const views = store.listBeeViewRows(lifecycle);
    return { views };
  }

  /**
   * `audit.tail` — bounded audit-log read for `hive v2 events`. `afterSeq`
   * is a follow cursor (rows with seq > afterSeq only); `limit` keeps the
   * LAST n rows after the bee filter (default 100, capped at 1000).
   */
  private rpcAuditTail(params: Record<string, unknown>): AuditTailResult {
    const store = this.mustStore();
    const afterSeq = typeof params.afterSeq === "number" && Number.isFinite(params.afterSeq) ? params.afterSeq : 0;
    const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : 100;
    const limit = Math.max(1, Math.min(1000, rawLimit));
    const beeId = typeof params.beeId === "string" && params.beeId.length > 0 ? params.beeId : null;
    return { rows: store.auditTail(afterSeq, limit, beeId) };
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
      views: store.listBeeViewRows(),
      templates: store.listTemplates(),
      tracks: store.listTracks(),
      questions: store.listQuestions(),
      seals: store.listSeals(),
      accounts: store.listAccounts(),
      accountLimits: store.listAccountLimits(),
      tasks: store.listTasks(),
      taskSupply: store.listTaskSupply(),
    };
  }

  // -------------------------------------------------------------------------
  // v7 (spec 08) — accounts + auth
  // -------------------------------------------------------------------------

  private mustAccounts(): AccountsService {
    if (!this.accounts || this.stopping) throw new RpcError("node_stopped", "daemon is shutting down");
    return this.accounts;
  }

  private requireAccount(params: Record<string, unknown>, key = "id"): AccountRow {
    const id = this.param(params, key);
    const account = this.mustStore().getAccount(id);
    if (!account) throw new RpcError("account_not_found", `account not found: ${id}`);
    return account;
  }

  private seatInfo(seat: LoginSeat | null): LoginSeatInfo | null {
    if (!seat) return null;
    return { accountId: seat.accountId, session: seat.session, socket: seat.socket, attach: seat.attach, startedAt: seat.startedAt, deadline: seat.deadline };
  }

  private rpcAccountList(params: Record<string, unknown>): AccountListResult {
    const store = this.mustStore();
    const harness = typeof params.harness === "string" && params.harness.length > 0 ? params.harness : undefined;
    const accounts = store.listAccounts(harness ? { harness } : {});
    const ids = new Set(accounts.map((a) => a.id));
    return { accounts, limits: store.listAccountLimits().filter((l) => ids.has(l.account)) };
  }

  private rpcAccountGet(params: Record<string, unknown>): AccountGetResult {
    const store = this.mustStore();
    const account = this.requireAccount(params);
    return {
      account,
      limits: store.getAccountLimits(account.id),
      bees: store.beesOnAccount(account.id).map((b) => b.id),
      credentialed: this.mustAccounts().credentialed(account),
      loginSeat: this.seatInfo(this.mustAccounts().seatOf(account.id)),
    };
  }

  private rpcAccountAdd(params: Record<string, unknown>): AccountAddResult {
    const store = this.mustStore();
    const harness = this.param(params, "harness");
    const label = this.param(params, "label");
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : accountIdFor(harness, label);
    const homePath = typeof params.homePath === "string" && params.homePath.length > 0 ? resolve(params.homePath) : this.mustAccounts().defaultHomeOf(id);
    const penalty = params.penalty === undefined ? 0 : params.penalty;
    if (typeof penalty !== "number") throw new RpcError("invalid_request", "account.add: penalty must be a number");
    if (store.getAccount(id)) throw new RpcError("invalid_request", `account already exists: ${id}`);
    const account = store.createAccount({ id, harness, label, homePath, penalty });
    this.log(`account.add id=${id} harness=${harness} home=${homePath}`);
    return { account };
  }

  private rpcAccountStatus(params: Record<string, unknown>, status: "paused" | "ok"): AccountUpdateResult {
    const account = this.requireAccount(params);
    const res = this.mustStore().setAccountStatus(account.id, status, status === "paused" ? "operator pause" : "operator unpause");
    this.log(`account.${status === "paused" ? "pause" : "unpause"} id=${account.id} applied=${res.applied}`);
    return { account: res.account, applied: res.applied };
  }

  private rpcAccountSetPenalty(params: Record<string, unknown>): AccountUpdateResult {
    const account = this.requireAccount(params);
    const penalty = params.penalty;
    if (typeof penalty !== "number" || !Number.isFinite(penalty) || penalty < 0 || penalty > 100) {
      throw new RpcError("invalid_request", "account.setPenalty: penalty must be a number from 0 to 100");
    }
    const res = this.mustStore().setAccountPenalty(account.id, penalty);
    this.log(`account.setPenalty id=${account.id} penalty=${penalty} applied=${res.applied}`);
    return { account: res.account, applied: res.applied };
  }

  private async rpcAccountLogin(params: Record<string, unknown>): Promise<AccountLoginResult> {
    const account = this.requireAccount(params);
    const key = this.idempotencyKeyOf(params);
    const store = this.mustStore();
    if (key != null) {
      const hit = store.lookupRpcResult(key);
      if (hit) return { ...(hit.result as AccountLoginResult), deduped: true };
    }
    let started: { seat: LoginSeat; rejoined: boolean };
    try {
      started = await this.mustAccounts().startLogin(account);
    } catch (err) {
      throw new RpcError("invalid_request", err instanceof Error ? err.message : String(err));
    }
    const result: AccountLoginResult = { accountId: account.id, seat: this.seatInfo(started.seat) as LoginSeatInfo, rejoined: started.rejoined };
    if (key != null) store.recordRpcResult(key, "account.login", null, result);
    return result;
  }

  private async rpcAccountLimits(params: Record<string, unknown>): Promise<AccountLimitsResult> {
    const accounts = this.mustAccounts();
    const ids = params.id === undefined || params.id === null ? undefined : [this.requireAccount(params).id];
    const limits = await accounts.refreshLimits(ids);
    return { limits };
  }

  private rpcAccountImportRegistry(params: Record<string, unknown>): AccountImportRegistryResult {
    const root = typeof params.root === "string" && params.root.length > 0 ? params.root : join(homedir(), ".hive");
    const dryRun = params.dryRun === true;
    const report = this.mustAccounts().importRegistry(root, { dryRun });
    this.log(`account.importRegistry root=${root} dryRun=${dryRun} applied=${report.applied} import=${report.counts.import} skip=${report.counts.skip}${report.refusal ? ` refusal=${JSON.stringify(report.refusal)}` : ""}`);
    const backfill = report.applied ? this.mustAccounts().backfillBeeAccounts() : undefined;
    return { ...report, ...(backfill ? { backfill } : {}) };
  }

  private rpcAccountBackfill(params: Record<string, unknown>): AccountBackfillResult {
    return this.mustAccounts().backfillBeeAccounts({ dryRun: params.dryRun === true });
  }

  /**
   * `bee.swapAccount {beeId, account}` (spec 08): same-harness only. Rebind
   * (account + home env; claude cross-account: rekey the session so the
   * conversation resumes under a NEW id via --resume <seed> --fork-session),
   * then stop the live runtime with `thenRevive` so the next generation
   * boots in the new account's home and resumes. A stopped bee is only
   * rebound (its next wake runs on the new account).
   */
  private rpcSwapAccount(params: Record<string, unknown>): SwapAccountResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const bee = store.getBee(beeId) as BeeRow;
    const target = this.requireAccount(params, "account");
    return this.performSwap(bee, target, "operator");
  }

  private performSwap(bee: BeeRow, target: AccountRow, by: "operator" | "rotation"): SwapAccountResult {
    const store = this.mustStore();
    const accounts = this.mustAccounts();
    if (target.harness !== bee.agent) {
      throw new RpcError("harness_mismatch", `account ${target.id} is a ${target.harness} account; bee ${bee.name} runs ${bee.agent}`);
    }
    if (target.status === "paused") throw new RpcError("account_paused", `account ${target.id} is paused`);
    const from = bee.account;
    if (from === target.id) return { beeId: bee.id, from, to: target.id, action: "noop", commandId: null, rekeyed: false };
    const rt = store.currentRuntime(bee.id);
    const live = rt != null && rt.state !== "stopped";
    let rekeyed = false;
    let commandId: number | null = null;
    store.transact(() => {
      store.setBeeAccount(bee.id, target.id);
      const key = homeEnvFor(bee.agent);
      const env = { ...bee.env };
      if (key) delete env[key];
      store.setBeeEnv(bee.id, { ...env, ...accounts.homeEnvOf(target) });
      // Claude cross-account moves mint a fresh session id (the old
      // copyThread rule): the resume runs as `--resume <seed> --fork-session`.
      if (bee.agent === "claude" && from !== target.id) rekeyed = store.rekeyBeeSession(bee.id).applied;
      if (live && rt) {
        commandId = store.enqueueCommand("stop", bee.id, { cause: "stopped_by_system", reason: `swap_account:${by}`, thenRevive: true }).id;
      }
    });
    const action: SwapAccountResult["action"] = live ? "stop_then_revive" : "rebind_only";
    this.log(`bee.swapAccount bee=${bee.id} from=${from ?? "-"} to=${target.id} by=${by} action=${action} rekeyed=${rekeyed}${commandId != null ? ` stop=${commandId}` : ""}`);
    return { beeId: bee.id, from, to: target.id, action, commandId, rekeyed };
  }

  /**
   * Account policy over adapter flag evidence (spec 08 "auth_needed ↔ Log in"
   * + "Automatic rotation on exhaustion"):
   *  - auth_needed set → accounts.status = auth_needed (bee flag already set
   *    by the loop); auth_needed clear (authenticated turn) → status ok.
   *  - resource_blocked set with a rate-limit cause → exhaustion evidence on
   *    the account, then ONE rotation attempt for this (bee, generation):
   *    selection for the harness excluding the current account (and recently
   *    exhausted ones); a candidate → swapAccount; none → the bee stays
   *    flagged and visible. Per-bee opt-out: tag/arg `autoswap=false`.
   *  - resource_blocked clear (turn served / allowed again) → exhaustion cleared.
   */
  private applyAccountPolicy(ev: FlagEvidenceLike): void {
    const store = this.mustStore();
    const accounts = this.accounts;
    if (!accounts) return;
    const bee = store.getBee(ev.beeId);
    if (!bee || !bee.account) return;
    const account = store.getAccount(bee.account);
    if (!account) return;
    if (ev.flag === "auth_needed") {
      if (ev.action === "set") {
        if (account.status !== "paused" && store.setAccountStatus(account.id, "auth_needed", `bee ${bee.id}: ${ev.detail.slice(0, 200)}`).applied) {
          this.log(`account.auth_needed account=${account.id} bee=${bee.id} gen=${ev.generation}`);
        }
      } else if (account.status === "auth_needed") {
        store.setAccountStatus(account.id, "ok", `bee ${bee.id}: ${ev.detail.slice(0, 200)}`);
        this.log(`account.auth_ok account=${account.id} bee=${bee.id} gen=${ev.generation}`);
      }
      return;
    }
    if (ev.flag !== "resource_blocked") return;
    if (ev.action === "clear") {
      if (account.exhaustedAt != null) store.recordAccountExhaustion(account.id, null);
      return;
    }
    if (!isRateLimitCause(ev.detail)) return;
    // Exhaustion evidence on the account (rotation cool-off). Debounced: a
    // provider re-reports the wall on every call; one stamp a minute is plenty.
    const now = Date.now();
    if (account.exhaustedAt == null || now - account.exhaustedAt > 60_000) store.recordAccountExhaustion(account.id, now);
    if (autoswapDisabled(bee)) {
      this.log(`account.rotate bee=${bee.id} account=${account.id} skipped=autoswap_disabled`);
      return;
    }
    // Bounded: one attempt per exhaustion event (= per generation; a swap mints the next).
    const rt = store.currentRuntime(bee.id);
    const generation = rt?.generation ?? ev.generation;
    if (this.rotatedGenerations.get(bee.id) === generation) return;
    this.rotatedGenerations.set(bee.id, generation);
    const pick = accounts.pick(bee.agent, { excludeAccountIds: new Set([account.id]), excludeRecentlyExhausted: true, model: this.modelOfBee(bee) });
    if (!pick.ok) {
      this.log(`account.rotate bee=${bee.id} account=${account.id} skipped=no_candidate (${pick.message})`);
      return;
    }
    try {
      const res = this.performSwap(bee, pick.account, "rotation");
      this.log(`account.rotate bee=${bee.id} from=${account.id} to=${pick.account.id} action=${res.action} reason=${JSON.stringify(pick.reason)}`);
    } catch (err) {
      this.log(`account.rotate bee=${bee.id} from=${account.id} to=${pick.account.id} failed=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The bee's effective model (its args over the agent defaults), for the Fable tier. */
  private modelOfBee(bee: BeeRow): string | undefined {
    const spec = this.cfg.agents[bee.agent];
    const all = [...(spec?.defaultArgs ?? []), ...(bee.args ?? [])];
    let model: string | undefined;
    for (let i = 0; i < all.length; i += 1) {
      const a = all[i] as string;
      if (a === "--model" || a === "-m") model = all[i + 1];
      else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    }
    return model;
  }

  /** Tick: poll open login seats; a completed login clears auth_needed on the account's bees (contrary evidence). */
  private async pollLoginSeats(): Promise<void> {
    const accounts = this.accounts;
    const store = this.store;
    if (!accounts || !store || this.stopping) return;
    let outcomes;
    try {
      outcomes = await accounts.pollLoginSeats();
    } catch (err) {
      this.log(`account.login.poll_error ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const done of outcomes) {
      if (this.stopping) return;
      for (const bee of store.beesOnAccount(done.accountId)) {
        if (store.clearFlag(bee.id, "auth_needed", `login completed for account ${done.accountId}`).applied) {
          this.log(`flag.clear bee=${bee.id} flag=auth_needed by=login`);
        }
      }
    }
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
