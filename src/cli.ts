#!/usr/bin/env node
import { access, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn as spawnChild } from "node:child_process";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { agentDefaultsToYolo, assertAgentAuthFreshForSpawn, canonicalAgentKind, forcedSessionIdArgs, resolveAgent, resolveHome, shellCommand, tmuxOptionsForAgent } from "./agents.js";
import {
  AUTO_ACCOUNT_QUERY,
  RR_ACCOUNT_QUERY,
  type AccountChainSyncOutcome,
  type AccountRecord,
  type SpawnAgentSpec,
  accountHasCredentials,
  activateAccountIntoHome,
  addAccount,
  autoAccountTool,
  captureAccountFromHome,
  defaultHomeForAccount,
  findAccount,
  listAccounts,
  removeAccount,
  resolveSpawnAgent,
  roundRobinAccountTool,
  seedClaudeHomeAcceptance,
  syncAccountCredentialsToVault,
  syncAllAccountCredentialsToVault,
  vaultRoot,
} from "./accounts.js";
import { agentKinds, identityEnvForAgent, identityRecipeForAgent, type IdentityRecipe } from "./drivers.js";
import { credentialDigest, readClaudeKeychain } from "./keychain.js";
import { attachBeeWithSidebar, readBeesGroupMode, resolveCurrentSidebarBeeName, showBeeBesideSidebar, syncBeesSidebarLayout, toggleBeesSidebar, writeBeesGroupMode } from "./beesSidebar.js";
import { beesTuiSearchText, runBeesTui, type BeesTuiItem } from "./beesTui.js";
import { chooseNewBee, type SpawnTuiAccount } from "./spawnTui.js";
import { chooseLaunch, type LaunchTemplate } from "./launchTui.js";
import { chooseLoop, loopStartArgs, type LoopLaunchResult } from "./loopTui.js";
import { chooseFork, defaultForkForm, forkIntent, type ForkAccountOption } from "./forkTui.js";
import { listLoopTemplates, loadLoopTemplate, removeLoopTemplate, saveLoopTemplate, type LoopTemplate, type LoopTemplateInput } from "./loopTemplate.js";
import { createProSlot, listProRepoEntries, listProRepos, prewarmProRepos, resolveProEntryForCwd, resolveProSlotForCwd, toProSlug, type ProRepoEntry, type ProSlotKind } from "./proProjects.js";
import { cachedAccountLimits, paceDelta, pickLeastLoadedAccount, sortAccountsForLimitsDisplay, windowRolledOver, type AccountLimits, type WindowUsage } from "./limits.js";
import { pickRoundRobinAccount } from "./roundRobin.js";
import { reconcileSessions, sessionIndexPath, syncManifestPath, writeSyncManifest } from "./reconcile.js";
import { resumeArgs, sniffYolo, swapAccount } from "./swap.js";
import { modelArgsFor, pickForkSeed, type ForkSeedInput, type SeedMode } from "./fork.js";
import { openInNewTerminal, runInCurrentTerminal } from "./terminal.js";
import { isRecentlyExhausted, listUsageAccounts, usageSummary } from "./usage.js";
import { deadSessionAge, deadSessionRecords, idleAgeSource, idleOlderThanMillis, idleSessionAge, olderThanMillis, parseAge } from "./clean.js";
import { chooseCleanTargets, type CleanTuiCleanOutcome, type CleanTuiItem } from "./cleanTui.js";
import { assertExecutableAvailable } from "./execCheck.js";
import { archiveColony, createColony, listColonies, loadColony, renameColony, updateColony } from "./colony.js";
import {
  archiveWorkspace,
  createWorkspace,
  listWorkspaces,
  loadWorkspace,
  renameWorkspace,
  updateWorkspace,
  WORKSPACE_PREFIX,
  workspaceSessionName,
  type WorkspaceLayoutEntry,
  type WorkspaceMember,
  type WorkspaceRecord,
} from "./workspace.js";
import {
  createQuest,
  generateQuestId,
  listQuests,
  loadQuest,
  questDir,
  updateQuest,
  validQuestId,
  type QuestRecord,
  type QuestStatus,
} from "./quest.js";
import { isLinearIdentifier, loadLinearAdapter } from "./linear.js";
import { createGroupedSession, ensureLinkSession, linkTargetsInto, linkWindowsInto, windowInventory } from "./tmuxLink.js";
import {
  BUZ_TIERS,
  type BuzMessage,
  type BuzSender,
  type BuzTier,
  consumeMessage,
  listMessages,
  parseAcceptFlag,
  purgeMailbox,
  readMessageById,
  resolveBuzAccept,
  sanitizeHumanName,
  sendBuzMessage,
  senderDisplay,
} from "./buz.js";
import { beeConfig, briefFooter, configPath, loadConfig, NAMING_EFFORTS, resetConfigCache, spawnDefaultSubstrate, type NamingEffort } from "./config.js";
import { getCompletions, shellScript } from "./completion.js";
import { defineFrameFromFile, frameDefinitionFile, frameExists, listFrames, loadFrame, loadFrameSource, removeFrame, validateFrame, writeFrameFromObject, type Frame } from "./frame.js";
import { defineFlowFromFile, listFlows, loadFlow, loadFlowSource, removeFlow, type Flow } from "./flow/index.js";
import { executeFlow } from "./flow/run.js";
import { cancelRun, spawnDetachedRun } from "./flow/background.js";
import { runHsrHost } from "./hsr/host.js";
import { adapterFor } from "./hsr/adapters/index.js";
import { ensureHsrRunDir, hsrRunDir, readHsrMeta } from "./hsr/runDir.js";
import { hsrObservations, pendingNeedsInput, type HsrObservation } from "./hsr/observe.js";
import { hsrSubstrate } from "./hsr/substrate.js";
import { connectRpcClient } from "./hsr/rpc.js";
import type { RunnerOpts } from "./hsr/types.js";
import { loopFlow } from "./loop/flow.js";
import { buildLoopConfig } from "./loop/context.js";
import {
  ensureLoopDir,
  generateLoopId,
  type LoopConfig,
  listLoops,
  loopIterLogPath,
  loopProgressPath,
  readLoopConfig,
  reconcileLoopStatus,
  requestStop,
  resolveLoopId,
  updateLoopConfig,
  writeLoopConfig,
} from "./loop/state.js";
import {
  findRunById,
  generateRunId,
  listRuns,
  readLogFull,
  readMeta,
  readResult,
  runLogPath,
  type FlowRunMeta,
} from "./flow/runs.js";
import { transactionalKill } from "./kill.js";
import { readDaemonStatus } from "./daemon/index.js";
import { runDaemon } from "./daemon/run.js";
import { runSentinel } from "./daemon/sentinel.js";
import {
  DEFAULT_LAUNCH_LABEL,
  installAgent,
  isAgentInstalled,
  isLaunchctlSupported,
  restartAgent,
  startAgent,
  stopAgent,
  uninstallAgent,
} from "./daemon/install.js";
import { tailDaemonLog } from "./daemon/logs.js";
import { renderSystemdUnit } from "./daemon/plist.js";
import { copyBeeSeals, listSeals, loadLatestSeal, recordSeal, sealedBeeNames as sealedBeeNamesImpl, validateSealArtifact } from "./seal.js";
import { search, type SearchHit, type SearchOptions, type SearchTypeFilter } from "./search.js";
import { persistSessionTranscriptMetadata, transcriptLookupForSession } from "./sessionMetadata.js";
import { resolveSelector } from "./selectors.js";
import { type BeeState, type DerivedState, deriveState, isTerminalState, liveTargetKey, stateLabel, type StateContext } from "./state.js";
import { createSwarm, destroySwarm, generateSwarmId, listSwarms, loadSwarm, saveSwarm, validSwarmId } from "./swarm.js";
import { actionLine, bold, cyan, dim, errorPrefix, formatRelativeTime, formatTable, formatTimeUntil, gray, green, isPretty, magenta, note, red, statusDot, tildify, truncate, yellow } from "./format.js";
import { effectiveHiveState, hiveStateFor, writeHiveState, writeHiveTags, writeHiveTitle, writeSpawnOptions } from "./hiveState.js";
import { repoTagFor } from "./repoTag.js";
import { dedupeTags, effectiveTags, isValidTagValue, normalizeTagArg, rejectReservedNamespaceTag } from "./tags.js";
import { buildView, closeView, createGroupedView, deriveViewName, linkHere, VIEW_PREFIX, viewSessionName } from "./view.js";
import { allocateBeeIdentity, highlightUniqueSessionReference, matchesSessionReference } from "./ids.js";
import { sessionDisplayName, shouldShowNodeColumn } from "./listView.js";
import { gatherTitleContext, generateTitle } from "./naming.js";
import { flag, numberFlag, parse, truthy, type Parsed } from "./parse.js";
import { AgentReadinessError, waitForAgentReady } from "./readiness.js";
import { startSpawnTimer, type SpawnTimer } from "./spawnTiming.js";
import { attentionCount, DEFAULT_ATTENTION_STATES, parseStateList, pickNextBee, type BeeStateEntry } from "./next.js";
import { LOCAL_NODE_NAME, listNodes, loadNode, loadNodeSync, type NodeRecord, registerNode, supportsCapability, unregisterNode, updateNode, validNodeName } from "./node.js";
import { appendLedger, deleteSession, listSessions, loadSession, safeName, saveSession, storeRoot, updateSession, type SessionRecord } from "./store.js";
import { appendedPaneText, parseTailOptions } from "./tail.js";
import { clearSubstrateCache, localSubstrate, substrateFor, substrateForRecord } from "./substrates/index.js";
import { attachCommand, attachSession, capture, formatShellCommand, hasSession, kill, listTmuxSessions, newSession, sendText, tmux } from "./tmux.js";
import { hasTranscriptProvider, lastAssistantText, latestTranscript, renderTranscript } from "./transcripts.js";
import { waitForIdle } from "./wait.js";
import {
  CANONICAL_TMUX_CONF,
  CANONICAL_WEZTERM_BLOCK,
  RECOMMENDED_BINDS,
  extractUrls,
} from "./keybindings.js";
import { fileURLToPath } from "node:url";

const VERSION = "0.0.1";
const APP_NAME = "hive";

async function main(argv: string[]) {
  if (argv[0] === "__complete") {
    const candidates = await getCompletions(argv.slice(1));
    for (const line of candidates) console.log(line);
    return;
  }
  if (argv[0] === "__flow-exec") {
    await runFlowExec(argv.slice(1));
    return;
  }
  if (argv[0] === "__hsr-run") {
    await runHsrHostFromPayload(argv[1]);
    return;
  }
  const parsed = parse(argv);
  switch (parsed.command) {
    case "spawn":
      await cmdSpawn(parsed);
      break;
    case "new":
      await cmdNew(parsed);
      break;
    case "launch":
      await cmdLaunch(parsed);
      break;
    case "send":
      await cmdSend(parsed);
      break;
    case "answer":
      await cmdAnswer(parsed);
      break;
    case "tail":
    case "cat":
      await cmdTail(parsed);
      break;
    case "list":
    case "ls":
    case "ps":
      await cmdList(parsed);
      break;
    case "bees":
      await cmdBees(parsed);
      break;
    case "transcript":
    case "tx":
      await cmdTranscript(parsed);
      break;
    case "last":
      await cmdLast(parsed);
      break;
    case "wait":
      await cmdWait(parsed);
      break;
    case "kill":
      await cmdKill(parsed);
      break;
    case "here":
      await cmdHere(parsed);
      break;
    case "spawn-picker":
      await cmdSpawnPicker(parsed);
      break;
    case "urls":
      await cmdUrls(parsed);
      break;
    case "keys":
      await cmdKeys(parsed);
      break;
    case "split":
      await cmdSplit(parsed);
      break;
    case "fork":
      if (parsed.args[0] === "launch") await cmdForkLaunch(parsed);
      else await cmdFork(parsed);
      break;
    case "revive":
      await cmdRevive(parsed);
      break;
    case "clean":
      await cmdClean(parsed);
      break;
    case "run":
      await cmdRun(parsed);
      break;
    case "x":
      await cmdX(parsed);
      break;
    case "xa":
      await cmdXa(parsed);
      break;
    case "open":
      await cmdOpen(parsed);
      break;
    case "attach":
      await cmdAttach(parsed);
      break;
    case "next":
      await cmdNext(parsed);
      break;
    case "view":
      await cmdView(parsed);
      break;
    case "completion":
      await cmdCompletion(parsed);
      break;
    case "colony":
      await cmdColony(parsed);
      break;
    case "workspace":
    case "ws":
      await cmdWorkspace(parsed);
      break;
    case "quest":
      await cmdQuest(parsed);
      break;
    case "restore":
      await cmdRestore(parsed);
      break;
    case "frame":
      await cmdFrame(parsed);
      break;
    case "swarm":
      await cmdSwarm(parsed);
      break;
    case "brief":
      await cmdBrief(parsed);
      break;
    case "rename":
      await cmdRename(parsed);
      break;
    case "tag":
      await cmdTag(parsed);
      break;
    case "own":
      await cmdOwn(parsed);
      break;
    case "move":
      await cmdMove(parsed);
      break;
    case "seal":
      await cmdSeal(parsed);
      break;
    case "config":
      await cmdConfig(parsed);
      break;
    case "node":
      await cmdNode(parsed);
      break;
    case "substrate":
      await cmdSubstrate(parsed);
      break;
    case "flow":
      await cmdFlow(parsed);
      break;
    case "loop":
      await cmdLoop(parsed);
      break;
    case "buz":
      await cmdBuz(parsed);
      break;
    case "daemon":
      await cmdDaemon(parsed);
      break;
    case "account":
      await cmdAccount(parsed);
      break;
    case "activate":
      await cmdActivate(parsed);
      break;
    case "login":
      await cmdLogin(parsed);
      break;
    case "swap-account":
      await cmdSwapAccount(parsed);
      break;
    case "usage":
    case "limits":
      // One question, one command: where do my accounts stand against the
      // real provider windows. The daemon's local token samples (autoswap's
      // raw material) sit behind --samples.
      if (truthy(flag(parsed, "samples"))) await cmdUsageSamples(parsed);
      else await cmdLimits(parsed);
      break;
    case "sessions":
      await cmdSessions(parsed);
      break;
    case "sync":
      await cmdSync(parsed);
      break;
    case "search":
      await cmdSearch(parsed);
      break;
    case "seals":
      await cmdSeals(parsed);
      break;
    case "help":
    case "--help":
    case "-h":
    case "":
      printHelp();
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    default:
      throw new Error(`Unknown command: ${parsed.command}\nRun: hive help`);
  }
}

async function cmdSpawn(parsed: Parsed): Promise<SessionRecord> {
  const frameName = typeof flag(parsed, "frame") === "string" ? String(flag(parsed, "frame")) : undefined;
  const count = resolveSpawnCount(parsed);
  let records: SessionRecord[];
  if (frameName) {
    records = await spawnFromFrame(parsed, frameName);
  } else if (count > 1) {
    records = await spawnHomogeneousSwarm(parsed, count);
  } else {
    records = [await spawnSingleBee(parsed)];
  }
  await maybeLinkHere(parsed, records);
  return records[0]!;
}

/**
 * `--here`: after the normal detached spawn (registration, readiness, briefs
 * all unchanged), link the bee's window into the caller's current session —
 * presentation only. A single bee gets selected; swarms link without focus.
 */
async function maybeLinkHere(parsed: Parsed, records: SessionRecord[]): Promise<void> {
  if (!truthy(flag(parsed, "here"))) return;
  if (!process.env.TMUX) {
    console.error(note("--here ignored: not inside tmux (plain spawn done)"));
    return;
  }
  const local = records.filter((record) => !record.node || record.node === LOCAL_NODE_NAME);
  if (local.length < records.length) {
    console.error(note(`--here skips ${records.length - local.length} remote bee(s) — link-window cannot cross tmux servers`));
  }
  if (local.length === 0) return;
  try {
    const result = await linkHere(
      local.map((record) => record.tmuxTarget),
      { select: records.length === 1 },
    );
    if (isPretty()) console.log(actionLine("ok", "here", [bold(result.session), `${result.linked} window(s) linked`]));
    else console.log(`here\t${result.session}\t${result.linked}`);
    await syncBeesSidebarLayout({ pruneOthers: true });
  } catch (error) {
    // Presentation only: the spawn itself already succeeded and is recorded.
    console.error(note(`--here failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function resolveSpawnCount(parsed: Parsed): number {
  const raw = flag(parsed, "count");
  if (raw === undefined) return 1;
  const value = typeof raw === "string" ? Number(raw) : NaN;
  if (Number.isInteger(value) && value >= 1) return value;
  throw new Error(`--count must be an integer >= 2 (got ${raw === true ? "no value" : String(raw)})`);
}

type SpawnOptions = {
  agent: string;
  extraArgs: string[];
  cwd: string;
  yolo: boolean;
  home?: string | true | string[];
  name?: string;
  colony?: string;
  swarmId?: string;
  caste?: string;
  brief?: string;
  node?: NodeRecord;
  /**
   * Substrate override. HSR ("hsr") runs the bee pane-lessly under a detached
   * runner host (local-only); absent/"local-tmux" keeps the tmux path. Set only
   * for HSR spawns — `node` is left undefined in that case.
   */
  substrate?: "local-tmux" | "hsr";
  /** Vault account to activate into the home before launch (Phase 3). */
  account?: AccountRecord;
  /** Default model to embed as the CLI model selector (account/profile). */
  model?: string;
  /** Provider for the model selector (opencode `--model <provider>/<model>`). */
  provider?: string;
  /** Opt this bee into the daemon's autoswap flow. Requires account. */
  autoswap?: boolean;
  /**
   * Opt-in phase timer (HIVE_DEBUG_SPAWN). When passed, spawnBee marks its
   * internal phases on it and leaves reporting to the caller (so resolve/ready
   * phases measured outside spawnBee join the same line). When absent, spawnBee
   * owns a self-reporting timer covering just its internal phases.
   */
  timer?: SpawnTimer;
};

// ──────────────────────────────────────────────────────────────────────────
// HSR runner host (APIA-76): the detached `hive __hsr-run <payload>` process
// and the spawn-side fork that launches it. Mirrors flow/background.ts.
// ──────────────────────────────────────────────────────────────────────────

/** The JSON payload the spawn path hands the detached `hive __hsr-run` host. */
type HsrRunPayload = {
  bee: string;
  kind: string;
  cwd: string;
  sessionId?: string;
  authKind?: "subscription" | "api-key";
  model?: string;
  /** Lineage for HIVE_COMB/HIVE_PARENT env stamping (APIA-82). */
  comb?: string;
  parent?: string;
  spec: { command: string; args: string[]; env: Record<string, string> };
};

/** process.execArgv minus flags that would change the child's execution mode. */
function inheritableExecArgvForHsr(): string[] {
  return process.execArgv.filter(
    (arg) => arg !== "--test" && !arg.startsWith("--test=") && arg !== "--watch" && !arg.startsWith("--watch="),
  );
}

/** Resolve the CLI entry path (matches spawnDetachedRun's logic). */
async function resolveHsrEntry(): Promise<string> {
  const raw = process.argv[1];
  if (!raw) throw new Error("hsr: could not resolve CLI entry path (process.argv[1] is empty)");
  try {
    return await realpath(raw);
  } catch {
    return raw;
  }
}

/**
 * The body of the hidden `hive __hsr-run <payloadPath>` subcommand: read the
 * payload, run the harness under its RunnerAdapter via runHsrHost, and live
 * exactly as long as the session (HSR_EXPLORATION.md §7). This process holds the
 * harness child's pipes; the CLI/daemon observe it purely through the run dir.
 */
async function runHsrHostFromPayload(payloadPath: string | undefined): Promise<void> {
  if (!payloadPath) {
    process.stderr.write("hive __hsr-run: missing payload path\n");
    process.exit(1);
  }
  let payload: HsrRunPayload;
  try {
    payload = JSON.parse(await readFile(payloadPath, "utf8")) as HsrRunPayload;
  } catch (error) {
    process.stderr.write(`hive __hsr-run: unreadable payload ${payloadPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  const adapter = adapterFor(payload.kind);
  if (!adapter) {
    process.stderr.write(`hive __hsr-run: no HSR adapter for harness "${payload.kind}"\n`);
    process.exit(1);
    return;
  }
  // The harness child needs a complete env (PATH etc.), not just the spawn
  // overrides. The tmux path gets this by merging process.env in its launcher;
  // here the host inherited the CLI's full env, so overlay spec.env on top of
  // it. (The claude adapter still scrubs ANTHROPIC_API_KEY for subscriptions.)
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") childEnv[key] = value;
  }
  Object.assign(childEnv, payload.spec.env);
  // Stamp the bee's identity so in-agent affordances (`hive here`, `hive fork`,
  // self-seal, buz) resolve the current bee WITHOUT a $TMUX_PANE (APIA-82). HSR
  // children have no pane, so HIVE_BEE is the pane-less resolution anchor.
  childEnv.HIVE_BEE = payload.bee;
  childEnv.HIVE_COMB = payload.comb ?? payload.bee;
  if (payload.parent) childEnv.HIVE_PARENT = payload.parent;
  const opts: RunnerOpts = {
    bee: payload.bee,
    cwd: payload.cwd,
    env: childEnv,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.authKind ? { authKind: payload.authKind } : {}),
    command: payload.spec.command,
    args: payload.spec.args,
    runDir: hsrRunDir(payload.bee),
  };
  const handle = await runHsrHost({ bee: payload.bee, adapter, opts });
  const shutdown = async (): Promise<void> => {
    try {
      await handle.stop();
    } catch {
      // best-effort; we're exiting regardless
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await handle.done;
  process.exit(0);
}

/**
 * Fork the detached `hive __hsr-run` host for a bee and return its pid. Mirrors
 * spawnDetachedRun/createLauncher: an 0600 payload file under a temp dir, the
 * host's stdout/stderr to a log file under the run dir, detached + unref'd so it
 * survives the CLI process.
 */
async function spawnHsrHost(payload: HsrRunPayload): Promise<number> {
  await ensureHsrRunDir(payload.bee);
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-payload-"));
  const payloadPath = join(dir, "payload.json");
  await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });

  const logHandle = await open(join(hsrRunDir(payload.bee), "host.log"), "a", 0o600);
  try {
    const entry = await resolveHsrEntry();
    const childArgv = [...inheritableExecArgvForHsr(), entry, "__hsr-run", payloadPath];
    const child = spawnChild(process.execPath, childArgv, {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...process.env },
    });
    // Async spawn failures surface via 'error' after spawn() returns; the
    // missing-pid check below converts them into a thrown error.
    child.once("error", () => undefined);
    if (!child.pid) throw new Error(`hive __hsr-run: spawn failed (no pid for ${payload.bee})`);
    const pid = child.pid;
    child.unref();
    return pid;
  } finally {
    await logHandle.close().catch(() => undefined);
  }
}

/** Poll until the runner host records a live session, or the timeout lapses. */
async function waitForHsrHost(bee: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const substrate = hsrSubstrate();
  while (Date.now() < deadline) {
    if (await substrate.hasSession(bee).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

async function spawnBee(opts: SpawnOptions): Promise<SessionRecord> {
  // When the caller threads a timer it also owns reporting (it has resolve/ready
  // phases to fold in); a bare spawnBee gets its own self-reporting timer so
  // swarm bees still emit their internal breakdown under HIVE_DEBUG_SPAWN.
  const timer = opts.timer ?? startSpawnTimer(opts.agent);
  const ownsTimer = !opts.timer;
  // An account-bound spawn gets a home (explicit or the account's dedicated
  // slot), the account's credentials activated into it, and the driver's
  // explicit identity env — never a blind HOME rewrite.
  const home = opts.account ? (opts.home ?? defaultHomeForAccount(opts.account)) : opts.home;
  const spec = resolveAgent(opts.agent, opts.extraArgs, {
    home,
    yolo: opts.yolo,
    identity: Boolean(opts.account),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  });
  if (opts.account) {
    if (opts.node && opts.node.kind !== "local-tmux") throw new Error("--account spawns are local-only (the vault never leaves this machine)");
    if (!spec.homePath) throw new Error(`Agent ${spec.kind} has no home env; cannot bind account ${opts.account.id}`);
    await activateAccountIntoHome(opts.account, spec.homePath, { onWarn: (message) => console.error(note(message)) });
  }
  // "activate" folds in resolveAgent + account activation (the OAuth-refresh
  // network call and accounts-lock wait live here); near-zero without --account.
  timer.mark("activate");
  // Pin the bee to its own provider session id from birth so the transcript
  // matcher anchors on it (+1000) instead of cross-matching a sibling's file by
  // mtime — the auto-titler and resume/swap all key off providerSessionId. Skip
  // when the caller already supplied --session-id in extra args.
  let pinnedSessionId: string | undefined;
  if (!opts.extraArgs?.includes("--session-id")) {
    const sid = randomUUID();
    const sessionArgs = forcedSessionIdArgs(spec.kind, sid);
    if (sessionArgs) {
      spec.args = [...spec.args, ...sessionArgs];
      pinnedSessionId = sid;
    }
  }
  const isRemote = Boolean(opts.node && opts.node.kind === "ssh-tmux");
  // Executable validation only applies to local spawns; we cannot reach the remote PATH cheaply.
  if (!isRemote) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, opts.account?.id);
  }
  timer.mark("exec-check");
  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  timer.mark("allocate");
  const name = safeName(opts.name ?? identity.id);

  // HSR: fork a detached runner host instead of a tmux session. The bee is a
  // normal SessionRecord with substrate:"hsr", tmuxTarget=name (a logical id, no
  // tmux target), no pane. resolveAgent / account activation / session-id
  // pinning / exec-check above are reused verbatim (HSR_EXPLORATION.md §7).
  if (opts.substrate === "hsr") {
    const adapter = adapterFor(spec.kind);
    const runnerTier = adapter?.tier();
    const hostPid = await spawnHsrHost({
      bee: name,
      comb: name, // solo comb — a forked sub-bee will carry its parent's comb
      kind: spec.kind,
      cwd: opts.cwd,
      ...(pinnedSessionId ? { sessionId: pinnedSessionId } : {}),
      authKind: "subscription",
      ...(opts.model ? { model: opts.model } : {}),
      spec: { command: spec.command, args: spec.args, env: spec.env },
    });
    timer.mark("session-create");
    const command = shellCommand(spec);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name,
      agent: spec.kind,
      cwd: opts.cwd,
      command,
      tmuxTarget: name, // logical id — HSR has no tmux target
      substrate: "hsr",
      runnerPid: hostPid,
      ...(runnerTier ? { runnerTier } : {}),
      combId: name,
      createdAt: now,
      updatedAt: now,
      status: "running",
      id: identity.id,
      prefix: identity.prefix,
      uuid: identity.uuid,
      requestedAgent: spec.requestedKind,
      homePath: spec.homePath,
      ...(pinnedSessionId ? { providerSessionId: pinnedSessionId } : {}),
      ...(opts.colony ? { colony: opts.colony } : {}),
      ...(opts.swarmId ? { swarmId: opts.swarmId } : {}),
      ...(opts.caste ? { caste: opts.caste } : {}),
      ...(opts.brief ? { brief: opts.brief } : {}),
      ...(opts.account ? { accountId: opts.account.id } : {}),
      ...(opts.autoswap ? { autoswap: true } : {}),
    };
    await saveSession(record);
    await writeSpawnOptions(record);
    timer.mark("persist");
    // Wait briefly for the host to come up so the spawn returns a live bee. On
    // timeout still return the record — observe/deriveState will reconcile.
    if (!(await waitForHsrHost(name, 5000))) {
      console.error(note(`hsr host for ${name} did not report live within 5s; the daemon will reconcile`));
    }
    if (ownsTimer) timer.report(record.name);
    return record;
  }

  const tmuxTarget = safeTmuxTarget(name);
  const nodeName = opts.node?.name ?? LOCAL_NODE_NAME;
  const substrate = opts.node ? substrateForRecord(opts.node) : localSubstrate();
  const locationHint = isRemote && opts.node ? ` on ${opts.node.name}` : "";
  if (await substrate.hasSession(tmuxTarget)) throw new Error(`tmux session already exists${locationHint}: ${tmuxTarget}`);
  const launch = await substrate.newSession(tmuxTarget, opts.cwd, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    tmuxOptions: spec.tmuxOptions,
  });
  timer.mark("session-create");
  const command = shellCommand(spec);

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    agent: spec.kind,
    cwd: opts.cwd,
    command,
    tmuxTarget,
    ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
    ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
    // Solo combs: every bee gets combId == tmuxTarget at spawn (§12 Q3).
    combId: tmuxTarget,
    createdAt: now,
    updatedAt: now,
    status: "running",
    id: identity.id,
    prefix: identity.prefix,
    uuid: identity.uuid,
    requestedAgent: spec.requestedKind,
    homePath: spec.homePath,
    ...(pinnedSessionId ? { providerSessionId: pinnedSessionId } : {}),
    ...(opts.colony ? { colony: opts.colony } : {}),
    ...(opts.swarmId ? { swarmId: opts.swarmId } : {}),
    ...(opts.caste ? { caste: opts.caste } : {}),
    ...(opts.brief ? { brief: opts.brief } : {}),
    ...(nodeName !== LOCAL_NODE_NAME ? { node: nodeName } : {}),
    ...(opts.account ? { accountId: opts.account.id } : {}),
    ...(opts.autoswap ? { autoswap: true } : {}),
  };
  await saveSession(record);
  await writeSpawnOptions(record);
  timer.mark("persist");
  // Owned timers (swarm/internal callers) report here; a caller-threaded timer
  // is reported by the caller once the readiness wait has also been measured.
  if (ownsTimer) timer.report(record.name);
  return record;
}

/**
 * `--ttl <age>`: maximum acceptable age for cached provider limits (e.g. 30m,
 * 2h; 0 forces a live read). Undefined when the flag is absent, so callers
 * keep their own defaults (limits: live; auto pick: 1h).
 */
function ttlFlagMs(parsed: Parsed): number | undefined {
  const raw = flag(parsed, "ttl");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("--ttl needs a duration (e.g. 30m, 2h; 0 forces a live read)");
  if (raw.trim() === "0") return 0;
  return parseAge(raw);
}

/**
 * resolveSpawnAgent plus the reserved `<tool>-auto` and `<tool>-rr` aliases.
 * `auto` picks the least-loaded account (live limits-aware); `rr` advances a
 * persistent cursor so spawns walk the credentialed accounts in order, ignoring
 * remaining quota.
 */
async function resolveSpawnAgentWithAuto(requested: string, parsed: Parsed): Promise<SpawnAgentSpec> {
  const rr = roundRobinAccountTool(requested);
  if (rr) return { agent: rr, account: await pickRoundRobinAccountForCli(rr) };
  const tool = autoAccountTool(requested);
  if (tool) return { agent: tool, account: await pickAutoAccount(tool, ttlFlagMs(parsed)) };
  const resolved = await resolveSpawnAgent(requested);
  const defaultAccount = await defaultBareGrokAccount(requested, parsed, resolved);
  return defaultAccount ? { agent: defaultAccount.tool, account: defaultAccount } : resolved;
}

async function defaultBareGrokAccount(requested: string, parsed: Parsed, resolved: SpawnAgentSpec): Promise<AccountRecord | undefined> {
  if (resolved.account || resolved.agent !== "grok" || requested.trim().toLowerCase() !== "grok") return undefined;
  if (hasFlag(parsed, "account") || hasFlag(parsed, "home") || hasFlag(parsed, "profile")) return undefined;
  const accounts = (await listAccounts()).filter((account) => account.tool === "grok");
  const credentialed: AccountRecord[] = [];
  for (const account of accounts) {
    if (await accountHasCredentials(account)) credentialed.push(account);
  }
  if (credentialed.length !== 1) return undefined;
  const account = credentialed[0]!;
  console.error(note(`account default → ${account.id} — bare grok uses the only Grok account with credentials`));
  return account;
}

/** `--account <query>` resolution; reserved queries: `auto` (least-loaded) and `rr` (round-robin). */
async function resolveAccountFlag(query: string, tool: string, ttlMs: number | undefined): Promise<AccountRecord> {
  if (query === AUTO_ACCOUNT_QUERY) return pickAutoAccount(tool, ttlMs);
  if (query === RR_ACCOUNT_QUERY) return pickRoundRobinAccountForCli(tool);
  return findAccount(query, tool);
}

// TODO (adversarial review #6, S3/S4): `<tool>-auto` / `--account auto` picks
// the least-loaded account scoped by CLI only, never by provider. Once opencode
// hosts multiple providers (minimax + glm + kimi), an auto-pick for `opencode`
// is provider-blind and may select a different provider than the user meant.
// Account-first resolution (exact id) sidesteps this; left unchanged in S2.
async function pickAutoAccount(tool: string, ttlMs: number | undefined): Promise<AccountRecord> {
  const choice = await pickLeastLoadedAccount(tool, ttlMs !== undefined ? { ttlMs } : {});
  const usage = autoPickUsage(choice.limits);
  const freshness = choice.limits?.cached && choice.limits.asOf ? `, cached ${formatRelativeTime(choice.limits.asOf)} ago` : "";
  console.error(note(`account auto → ${choice.account.id}${usage ? ` (${usage}${freshness})` : ""} — ${choice.reason}`));
  return choice.account;
}

async function pickRoundRobinAccountForCli(tool: string): Promise<AccountRecord> {
  const choice = await pickRoundRobinAccount(tool);
  console.error(note(`account rr → ${choice.account.id} — ${choice.reason}`));
  return choice.account;
}

function autoPickUsage(limits: AccountLimits | undefined): string {
  if (!limits?.ok) return "";
  const now = Date.now();
  const cell = (label: string, window?: WindowUsage) =>
    window ? `${label} ${Math.round(windowRolledOver(window, now) ? 0 : window.usedPercent)}%` : null;
  return [cell("weekly", limits.weekly), cell("5h", limits.fiveHour)].filter(Boolean).join(", ");
}

/**
 * A resolved thin profile (config `bees.<name>` with an `account` field): the
 * referenced vault account plus its model/args/cwd/yolo overrides. Precedence
 * is FLAG > PROFILE > ACCOUNT — the caller layers an explicit CLI flag over
 * what this returns, and falls back to the account default below it.
 */
type ProfileOverlay = {
  account: AccountRecord;
  /** Profile model override; falls back to the account's default model. */
  model?: string;
  /** Extra args declared by the profile (appended to user `-- …` args). */
  args: string[];
  /** Profile cwd override (FLAG still wins above it). */
  cwd?: string;
  /** Profile yolo override (FLAG still wins above it). */
  yolo?: boolean;
};

/**
 * Resolve a requested spawn token that names a thin profile referencing an
 * account. Returns undefined when the token is not such a profile (no
 * `account` field) so callers fall through to today's path. A profile naming
 * a missing account fails loudly via findAccount.
 */
async function resolveProfileOverlay(requested: string): Promise<ProfileOverlay | undefined> {
  const profile = beeConfig(requested);
  if (!profile.account) return undefined;
  const account = await findAccount(profile.account);
  return {
    account,
    // Precedence: profile model wins over the account default (the CLI flag is
    // layered on top by the caller).
    ...(profile.model ?? account.model ? { model: profile.model ?? account.model } : {}),
    args: profile.args ?? [],
    ...(profile.cwd ? { cwd: profile.cwd } : {}),
    ...(profile.yolo !== undefined ? { yolo: profile.yolo } : {}),
  };
}

async function spawnSingleBee(parsed: Parsed): Promise<SessionRecord> {
  const requested = parsed.args[0];
  if (!requested) throw new Error("Usage: hive spawn <bee> [--name name] [--cwd dir] [--account <name|auto>] [--yolo] [-- <bee-args...>]  (e.g. --account auto -- -m gpt-5.5)");
  // Opt-in spawn timing (HIVE_DEBUG_SPAWN). No-op object when disabled.
  const timer = startSpawnTimer(requested);
  // <tool>-<account> spawn shorthand: hive spawn codex-ur / claude-thto / claude-auto.
  const { agent: resolvedAgent, account: aliasAccount } = await resolveSpawnAgentWithAuto(requested, parsed);
  // Thin profile: a config bee referencing an account supplies the CLI from the
  // account, plus model/args/cwd/yolo overrides (precedence FLAG > PROFILE >
  // ACCOUNT).
  const profile = await resolveProfileOverlay(requested);
  const agent = profile ? profile.account.tool : resolvedAgent;
  const extraArgs = profile ? [...parsed.rest, ...profile.args] : parsed.rest;
  const cwd = await resolveSpawnCwd(parsed, profile?.cwd);
  const yolo = dangerousMode(parsed, agent, requested, profile?.yolo);
  const home = flag(parsed, "home") ?? flag(parsed, "profile");
  const colony = await resolveSpawnColony(parsed);
  const spec = resolveAgent(agent, extraArgs, { home, yolo });
  // HSR is a substrate, not a node: `--substrate hsr` skips node resolution and
  // runs the bee pane-lessly on the local runner host (HSR_EXPLORATION.md §7).
  // Origin-based default (agents → HSR, humans → local-tmux) with explicit
  // `--substrate`/`--node` override — see resolveSpawnSubstrate (§5).
  const { useHsr, node } = await resolveSpawnSubstrate(parsed, spec.kind);
  const name = typeof flag(parsed, "name") === "string" ? String(flag(parsed, "name")) : undefined;
  const briefText = typeof flag(parsed, "brief") === "string" ? String(flag(parsed, "brief")) : undefined;
  const accountQuery = typeof flag(parsed, "account") === "string" ? String(flag(parsed, "account")) : undefined;
  // Account binding precedence: explicit --account flag > profile account >
  // <tool>-<account> shorthand / account-id resolution.
  const account = accountQuery ? await resolveAccountFlag(accountQuery, spec.kind, ttlFlagMs(parsed)) : (profile?.account ?? aliasAccount);
  // Model selector precedence: profile model override > the account's default
  // model. Only meaningful when an account is bound.
  const model = account ? (profile?.model ?? account.model) : undefined;
  const provider = account?.provider;
  const autoswap = truthy(flag(parsed, "autoswap"));
  if (autoswap && !account) throw new Error("--autoswap requires an account (--account or a <tool>-<account> bee spec)");
  // "resolve" folds in account/profile/node resolution above (remote node probe
  // lives here); spawnBee marks its own internal phases on the same timer.
  timer.mark("resolve");
  let record = await spawnBee({ agent, extraArgs, cwd, yolo, home, name, colony, brief: briefText, node, account, model, provider, autoswap, timer, ...(useHsr ? { substrate: "hsr" } : {}) });
  const nodeSuffix = useHsr ? [dim("substrate:hsr")] : node && node.name !== LOCAL_NODE_NAME ? [dim(`node:${node.name}`)] : [];
  if (isPretty()) console.log(actionLine("ok", "spawn", [bold(record.name), record.agent, dim(tildify(cwd)), ...nodeSuffix]));
  else console.log(`${record.name}\t${agent}\t${cwd}\t${useHsr ? "hsr" : node?.name ?? LOCAL_NODE_NAME}`);
  if (truthy(flag(parsed, "briefed")) && briefText) {
    record = await deliverBrief(parsed, record, briefText);
    timer.mark("brief");
  } else {
    await confirmSpawnReady(parsed, record);
    timer.mark("ready");
  }
  timer.report(record.name);
  return record;
}

/**
 * `hive new`: interactive, column-by-column spawn picker (type → account →
 * config → project). Designed to be bound to a tmux popup (M-n). It only
 * gathers choices, then funnels them through the normal spawn path so account
 * activation, yolo resolution, swarms, and `--here` window linking all behave
 * exactly as the flag-driven `hive spawn`. A single bee gets selected in the
 * caller's tmux client via `--here`; a swarm links without stealing focus.
 */
async function cmdNew(parsed: Parsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive new needs a TTY — bind it to a tmux popup: bind -n M-n display-popup -E "hive new"');
  }
  const here = await resolveBeeInCurrentPane();
  const defaultCwd = here?.cwd ?? (await resolveSpawnCwd(parsed));
  const defaultKind = here ? canonicalAgentKind(here.agent) : undefined;

  // Warm the `pro ls repos` inventory while the operator picks an agent /
  // account / cwd, so the per-cwd "checking pro repo…" step resolves from cache
  // instead of blocking the spawn on a cold shell-out.
  prewarmProRepos();

  const plan = await chooseNewBee({
    types: agentKinds().map((kind) => ({ kind })),
    defaultKind,
    defaultCwd,
    defaultCwdLabel: tildify(defaultCwd),
    defaultYolo: (kind) => agentDefaultsToYolo(kind),
    loadAccounts: (kind) => newBeeAccountRows(kind),
    loadProjects: async () =>
      (await listProRepos()).map((repo) => ({ label: repo.label, path: repo.path, project: repo.project })),
    validatePath: async (input) => {
      try {
        const abs = resolve(input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        const real = await realpath(abs);
        if (!(await stat(real)).isDirectory()) return { ok: false, error: "not a directory" };
        return { ok: true, path: real };
      } catch {
        return { ok: false, error: "path does not exist" };
      }
    },
    listSubdirs: (base) => listNewBeeSubdirs(base),
    proRepoForCwd: async (cwd) => {
      try {
        const entry = resolveProEntryForCwd(await listProRepoEntries(), cwd);
        if (!entry) return null;
        const label = [entry.area, entry.project, entry.repo].filter((part) => part.length > 0).join("/") || entry.path;
        return { label, path: entry.path };
      } catch {
        return null;
      }
    },
    suggestDirName: (kind) => toProSlug(`${kind}-${basename(defaultCwd)}`) || toProSlug(kind) || "bee",
    createProDir: async (kind, repoPath, name) => {
      const slug = toProSlug(name);
      if (!slug) return { ok: false, error: "use letters, digits, and dashes" };
      try {
        return { ok: true, path: await createProSlot(kind, repoPath, slug) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  if (!plan) {
    if (isPretty()) console.error(note("new: cancelled"));
    return;
  }

  const flags = new Map<string, string | true | string[]>();
  if (plan.account) flags.set("account", plan.account);
  flags.set("cwd", plan.cwd);
  flags.set(plan.yolo ? "yolo" : "no-yolo", true);
  if (plan.autoswap) flags.set("autoswap", true);
  if (plan.count > 1) flags.set("count", String(plan.count));

  const record = await cmdSpawn({ command: "spawn", args: [plan.kind], flags, rest: [] });

  // Land in the new bee. Each bee is its own tmux session, so switch the client
  // to it — the same primitive the M-s switcher uses, which (unlike --here's
  // link-window/select-window) reliably repoints the underlying client from
  // inside a display-popup. Local single-bee only: a remote bee lives on another
  // tmux server, and a swarm shouldn't yank focus to an arbitrary member.
  if (process.env.TMUX && plan.count <= 1 && !record.node) {
    await tmux(["switch-client", "-t", `=${record.tmuxTarget}`], { reject: false });
    await syncBeesSidebarLayout({ pruneOthers: true });
  }
}

/**
 * `hive launch` — the interactive frame/flow launcher (KEYBINDINGS: the ⌘⇧B/⌘⇧F
 * target). Pick a frame or flow, pick the repo (defaults to the current one),
 * fill a flow's args in editable boxes, and launch DETACHED: a frame spawns its
 * swarm, a flow runs in the background. The repo picker reuses cmdNew's hooks.
 */
async function cmdLaunch(parsed: Parsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive launch needs a TTY — bind it to a tmux popup: bind -n M-B display-popup -E "hive launch"');
  }
  const here = await resolveBeeInCurrentPane();
  const defaultCwd = here?.cwd ?? (await resolveSpawnCwd(parsed));
  // Warm `pro ls repos` while the operator picks a frame/flow and repo.
  prewarmProRepos();

  const [frames, flows] = await Promise.all([listFrames(), listFlows()]);
  const templates: LaunchTemplate[] = [
    ...frames.map((f): LaunchTemplate => ({
      kind: "frame",
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      beeCount: f.castes.reduce((sum, c) => sum + (c.count ?? 1), 0),
      // One slot per spawned bee, in spawn order (caste order, then index) so
      // the message form lines up with spawnFromFrame's expansion.
      beeSlots: f.castes.flatMap((c) =>
        Array.from({ length: c.count ?? 1 }, (_, i) => ({
          caste: c.name,
          bee: c.bee,
          index: i + 1,
          count: c.count ?? 1,
          ...(c.brief ? { brief: c.brief } : {}),
        })),
      ),
    })),
    ...flows
      .filter((f) => !f.loadError) // a broken flow can't run; hide it from the picker
      .map((f): LaunchTemplate => ({
        kind: "flow",
        name: f.name,
        ...(f.description ? { description: f.description } : {}),
        args: (f.args ?? []).map((a) => ({
          name: a.name,
          ...(a.default !== undefined ? { default: String(a.default) } : {}),
          ...(a.description ? { description: a.description } : {}),
          ...(a.name === "bee" ? { picker: "bee" as const } : {}),
        })),
      })),
  ];

  const plan = await chooseLaunch({
    templates,
    defaultCwd,
    defaultCwdLabel: tildify(defaultCwd),
    loadProjects: async () => (await listProRepos()).map((repo) => ({ label: repo.label, path: repo.path, project: repo.project })),
    validatePath: async (input) => {
      try {
        const abs = resolve(input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        const real = await realpath(abs);
        if (!(await stat(real)).isDirectory()) return { ok: false, error: "not a directory" };
        return { ok: true, path: real };
      } catch {
        return { ok: false, error: "path does not exist" };
      }
    },
    listSubdirs: (base) => listNewBeeSubdirs(base),
    loadBeeOptions: async () => {
      // Account-aware agent shorthands the bee picker offers: <kind>-auto and
      // <kind>-rr (when ≥1 account), <kind>-<account-id> per account, or plain
      // <kind> with none.
      const out: Array<{ value: string; label: string; detail?: string }> = [];
      for (const kind of agentKinds()) {
        const accounts = await newBeeAccountRows(kind).catch(() => []);
        if (accounts.length >= 1) {
          out.push({ value: `${kind}-auto`, label: `${kind} · auto`, detail: "least-loaded account" });
          if (accounts.length >= 2) out.push({ value: `${kind}-rr`, label: `${kind} · rr`, detail: "round-robin next account" });
        }
        for (const acct of accounts) {
          out.push({ value: `${kind}-${acct.id}`, label: `${kind} · ${acct.label}`, ...(acct.usage ? { detail: acct.usage } : {}) });
        }
        if (accounts.length === 0) out.push({ value: kind, label: `${kind} · (no account)` });
      }
      return out;
    },
  });

  if (!plan) {
    if (isPretty()) console.error(note("launch: cancelled"));
    return;
  }

  if (plan.kind === "frame") {
    // Spawn the frame's swarm detached at the chosen repo (no switch-client — a
    // swarm shouldn't yank focus to an arbitrary member). Per-bee messages from
    // the composer (if any) are delivered after readiness, in spawn order.
    const flags = new Map<string, string | true | string[]>([["frame", plan.name], ["cwd", plan.cwd]]);
    // "start now" delivery (the composer default) suppresses the wait-footer so
    // the message is acted on; "brief only" keeps it so bees wait for a follow-up.
    if (plan.waitForGo === false) flags.set("no-wait-footer", true);
    await spawnFromFrame({ command: "spawn", args: ["spawn"], flags, rest: [] }, plan.name, plan.messages);
    return;
  }

  // Flow: run in the background so it survives the popup. Args go through --arg;
  // the cwd arg (if any) was seeded with the chosen repo in the TUI.
  const argEntries = Object.entries(plan.args)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}=${value}`);
  const flowFlags = new Map<string, string | true | string[]>([["background", true]]);
  if (argEntries.length > 0) flowFlags.set("arg", argEntries);
  await flowRun({ command: "flow", args: ["run", plan.name], flags: flowFlags, rest: [] });
}

/** Accounts for one tool, enriched with a cached-usage cell for the picker. */
async function newBeeAccountRows(kind: string): Promise<SpawnTuiAccount[]> {
  const mine = (await listAccounts()).filter((account) => account.tool === kind);
  if (mine.length === 0) return [];
  let limits: AccountLimits[] = [];
  try {
    limits = await cachedAccountLimits(mine, { ttlMs: 3_600_000 });
  } catch {
    limits = [];
  }
  const byId = new Map(limits.map((entry) => [entry.account, entry]));
  const now = Date.now();
  return mine.map((account) => {
    const entry = byId.get(account.id);
    const usage = newBeeUsageCell(entry, now);
    const saturated = Boolean(
      entry?.ok && entry.fiveHour && !windowRolledOver(entry.fiveHour, now) && entry.fiveHour.usedPercent >= 90,
    );
    return { id: account.id, label: account.label, usage, saturated };
  });
}

function newBeeUsageCell(limits: AccountLimits | undefined, now: number): string | undefined {
  if (!limits) return undefined;
  if (!limits.ok) return "limits n/a";
  const cell = (label: string, window?: WindowUsage) =>
    window ? `${label} ${Math.round(windowRolledOver(window, now) ? 0 : window.usedPercent)}%` : null;
  const parts = [cell("5h", limits.fiveHour), cell("wk", limits.weekly)].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Junk dir names never worth offering as a spawn cwd. */
const NEW_BEE_SUBDIR_IGNORE = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  ".git", ".next", ".turbo", ".cache", ".venv", "__pycache__", ".idea", ".vscode",
]);
const NEW_BEE_SUBDIR_CAP = 800;

/**
 * Directories up to two levels deep under `base`, for the `hive new` path
 * completer. Junk (node_modules/dist/.git/…) and dotdirs are skipped; the list
 * is capped so a huge tree can't stall the picker. Errors come back as
 * `{ ok: false }` rather than throwing, so the TUI degrades to literal-path entry.
 */
async function listNewBeeSubdirs(
  base: string,
): Promise<{ ok: boolean; base: string; dirs: string[]; error?: string }> {
  const keep = (name: string) => !name.startsWith(".") && !NEW_BEE_SUBDIR_IGNORE.has(name);
  try {
    const abs = await realpath(resolve(base.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
    const dirs: string[] = [];
    const level1: string[] = [];
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && keep(entry.name)) level1.push(`${abs}/${entry.name}`);
    }
    level1.sort();
    dirs.push(...level1);
    for (const dir of level1) {
      if (dirs.length >= NEW_BEE_SUBDIR_CAP) break;
      let children: import("node:fs").Dirent[] = [];
      try {
        children = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable subdir (perms) — skip its children
      }
      const grand = children
        .filter((entry) => entry.isDirectory() && keep(entry.name))
        .map((entry) => `${dir}/${entry.name}`)
        .sort();
      dirs.push(...grand);
    }
    return { ok: true, base: abs, dirs: dirs.slice(0, NEW_BEE_SUBDIR_CAP) };
  } catch {
    return { ok: false, base, dirs: [], error: "cannot read directory" };
  }
}

async function spawnHomogeneousSwarm(parsed: Parsed, count: number): Promise<SessionRecord[]> {
  const requested = parsed.args[0];
  if (!requested) throw new Error("Usage: hive spawn <bee> --count <n> [--colony name]");
  if (!Number.isInteger(count) || count < 2) throw new Error(`--count must be an integer >= 2 (got ${count})`);
  if (hasFlag(parsed, "name")) throw new Error("--name cannot be combined with --count > 1; swarm bees are auto-named");
  if (hasFlag(parsed, "brief") || hasFlag(parsed, "briefed")) {
    throw new Error("--brief/--briefed cannot be combined with --count > 1; spawn first, then: hive brief @<swarm-id> <text>");
  }
  const { agent: resolvedAgent, account: aliasAccount } = await resolveSpawnAgentWithAuto(requested, parsed);
  // Thin profile → account (same overlay as spawnSingleBee).
  const profile = await resolveProfileOverlay(requested);
  const agent = profile ? profile.account.tool : resolvedAgent;
  const extraArgs = profile ? [...parsed.rest, ...profile.args] : parsed.rest;
  const account = profile?.account ?? aliasAccount;
  // Model selector precedence: profile model override > the account default.
  const model = account ? (profile?.model ?? account.model) : undefined;
  const provider = account?.provider;
  const cwd = await resolveSpawnCwd(parsed, profile?.cwd);
  const yolo = dangerousMode(parsed, agent, requested, profile?.yolo);
  const home = flag(parsed, "home") ?? flag(parsed, "profile");
  const colony = await resolveSpawnColony(parsed);
  const spec = resolveAgent(agent, extraArgs, { home, yolo });
  const node = await resolveSpawnNode(parsed, spec.kind);
  const swarmId = resolveSwarmIdHint(parsed, agent);

  // PRESERVE (adversarial review fix #11): an account-first swarm behaves
  // exactly like an `--account` swarm does today — all N bees share ONE
  // accountId and ONE isolated home (spawnBee derives it from
  // defaultHomeForAccount(account) since no per-bee --home is given). This is
  // the existing shared-home reality; S2 deliberately adds no per-bee homes
  // and no new --count restriction.
  const records: SessionRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = await spawnBee({ agent, extraArgs, cwd, yolo, home, colony, swarmId, node, account, model, provider });
    records.push(record);
    const nodeSuffix = node.name !== LOCAL_NODE_NAME ? [dim(`node:${node.name}`)] : [];
    if (isPretty()) console.log(actionLine("ok", "spawn", [bold(record.name), record.agent, dim(`@${swarmId}`), ...nodeSuffix]));
    else console.log(`${record.name}\t${agent}\t${cwd}\t@${swarmId}\t${node.name}`);
  }

  await confirmSpawnReadyAll(parsed, records);

  await createSwarm({
    id: swarmId,
    beeIds: records.map((r) => r.id ?? r.name),
    ...(colony ? { colony } : {}),
  });
  if (isPretty()) console.log(actionLine("ok", "swarm", [bold(`@${swarmId}`), `${records.length} bees`]));
  else console.log(`swarm\t@${swarmId}\t${records.length}`);
  return records;
}

/**
 * Spawn every bee of a frame's castes (caste order, then index within a caste).
 *
 * `perBeeMessages`, when given, holds one initial message per spawned bee in
 * that exact order (from the `hive launch` composer). A non-empty entry is
 * delivered to its bee after readiness, overriding the caste's default brief; an
 * empty entry sends nothing. When omitted, the legacy `--briefed` behavior
 * applies (deliver each caste's own brief).
 */
async function spawnFromFrame(parsed: Parsed, frameName: string, perBeeMessages?: string[]): Promise<SessionRecord[]> {
  if (hasFlag(parsed, "name")) throw new Error("--name cannot be combined with --frame; frame bees are auto-named");
  if (hasFlag(parsed, "brief")) throw new Error("--brief cannot be combined with --frame; briefs come from the frame's castes");
  const frame: Frame | null = await loadFrame(frameName);
  if (!frame) throw new Error(`Unknown frame: ${frameName}. Define one with: hive frame define <file>`);
  const cwd = await resolveSpawnCwd(parsed);
  const colony = await resolveSpawnColony(parsed);
  const swarmId = resolveSwarmIdHint(parsed, frame.name);

  const briefed = truthy(flag(parsed, "briefed"));
  const flagHome = flag(parsed, "home") ?? flag(parsed, "profile");
  const records: SessionRecord[] = [];
  // deliverBrief already waits for readiness, so just-briefed bees are excluded
  // from the post-spawn confirmation (mirrors spawnSingleBee's exclusivity).
  const unbriefed: SessionRecord[] = [];
  const hasComposerMessages = perBeeMessages !== undefined;
  let slot = 0; // running bee index across all castes, aligned with perBeeMessages
  for (const caste of frame.castes) {
    const { agent: resolvedAgent, account: aliasAccount } = await resolveSpawnAgentWithAuto(caste.bee, parsed);
    const profile = await resolveProfileOverlay(caste.bee);
    const agent = profile ? profile.account.tool : resolvedAgent;
    const extraArgs = profile ? [...parsed.rest, ...profile.args] : parsed.rest;
    const account = profile?.account ?? aliasAccount;
    const model = account ? (profile?.model ?? account.model) : undefined;
    const provider = account?.provider;
    const yolo = dangerousMode(parsed, agent, caste.bee, profile?.yolo);
    const home = caste.home ?? flagHome;
    const casteSpec = resolveAgent(agent, extraArgs, { home, yolo });
    const casteNode = await resolveSpawnNode(parsed, casteSpec.kind);
    for (let i = 0; i < caste.count; i += 1) {
      // A composer message (if non-blank) overrides this bee's caste brief.
      const custom = hasComposerMessages ? perBeeMessages?.[slot] ?? "" : undefined;
      slot += 1;
      const hasCustom = typeof custom === "string" && custom.trim().length > 0;
      const recordBrief = hasComposerMessages ? (hasCustom ? custom : undefined) : caste.brief;
      // With composer messages present, a blank slot explicitly means no brief;
      // otherwise fall back to the legacy "--briefed delivers caste brief" path.
      const toDeliver = hasComposerMessages ? (hasCustom ? custom : undefined) : briefed && caste.brief ? caste.brief : undefined;
      let record = await spawnBee({
        agent,
        extraArgs,
        cwd,
        yolo,
        ...(home !== undefined ? { home } : {}),
        colony,
        swarmId,
        caste: caste.name,
        node: casteNode,
        account,
        model,
        provider,
        ...(recordBrief ? { brief: recordBrief } : {}),
      });
      if (toDeliver) record = await deliverBrief(parsed, record, toDeliver);
      else unbriefed.push(record);
      records.push(record);
      if (isPretty()) console.log(actionLine("ok", "spawn", [bold(record.name), record.agent, dim(`caste:${caste.name}`), dim(`@${swarmId}`)]));
      else console.log(`${record.name}\t${record.agent}\t${cwd}\t${caste.name}\t@${swarmId}`);
    }
  }

  await confirmSpawnReadyAll(parsed, unbriefed);

  await createSwarm({
    id: swarmId,
    frame: frame.name,
    beeIds: records.map((r) => r.id ?? r.name),
    ...(colony ? { colony } : {}),
  });
  if (isPretty()) console.log(actionLine("ok", "swarm", [bold(`@${swarmId}`), `${records.length} bees`, dim(`frame:${frame.name}`)]));
  else console.log(`swarm\t@${swarmId}\t${records.length}\t${frame.name}`);
  return records;
}

async function cmdSeal(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive seal <selector> --from <path-to-seal.json>");
  const fromPath = typeof flag(parsed, "from") === "string" ? String(flag(parsed, "from")) : undefined;
  if (!fromPath) throw new Error("hive seal requires --from <path-to-seal.json>");

  const raw = await readFile(fromPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid seal JSON in ${fromPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const artifact = validateSealArtifact(parsedJson);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const stored = await recordSeal(record.name, artifact);
    await writeHiveState(record, "done");
    if (isPretty()) console.log(actionLine("ok", "seal", [bold(record.name), dim(stored.status), dim(stored.type ?? "")]));
    else console.log(`sealed\t${record.name}\t${stored.status}\t${stored.type ?? ""}\t${stored.sealedAt}`);
  }
}

async function cmdBrief(parsed: Parsed) {
  const target = parsed.args[0];
  const briefText = stringFlag(parsed, ["brief", "b"]) ?? parsed.args.slice(1).join(" ");
  if (!target || !briefText) throw new Error("Usage: hive brief <selector> <text> OR hive brief <selector> --brief <text>");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  let briefedCount = 0;
  for (const record of records) {
    if (!(await substrateFor(record).hasSession(record.tmuxTarget))) {
      if (!isMulti) throw new Error(`tmux session is not running: ${record.tmuxTarget}`);
      if (isPretty()) console.error(note(`skip ${record.name} (dead)`));
      else console.error(`skip\t${record.name}\tdead`);
      continue;
    }
    await deliverBrief(parsed, record, briefText);
    briefedCount += 1;
  }

  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "brief", [bold(target), `${briefedCount}/${records.length} bees`]));
    else console.log(`briefed\t${target}\t${briefedCount}/${records.length}`);
  }
}

async function cmdRename(parsed: Parsed) {
  const auto = truthy(flag(parsed, "auto"));
  const clear = truthy(flag(parsed, "clear"));
  const here = truthy(flag(parsed, "here"));
  const usage = "Usage: hive rename <selector> <title>  |  hive rename --here <title>  |  hive rename <selector> --auto  |  hive rename <selector> --clear";

  // `--here` reshapes argv to the selector-then-title contract: resolve the
  // current pane's bee and treat every positional as the title (no selector to
  // skip). Without it, args[0] is the selector and args.slice(1) the title.
  let target: string | undefined;
  let explicit: string;
  if (here) {
    const bee = await resolveBeeInCurrentPane();
    if (!bee) throw new Error("hive rename --here: no matching bee for the current pane/session");
    target = bee.name;
    explicit = parsed.args.join(" ").trim();
  } else {
    target = parsed.args[0];
    explicit = parsed.args.slice(1).join(" ").trim();
  }
  if (!target || (auto && clear) || ((auto || clear) === Boolean(explicit))) throw new Error(usage);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);
  if (explicit && isMulti) {
    throw new Error("Refusing to set the same title on multiple bees; use --auto or --clear for swarm/colony selectors");
  }

  for (const record of records) {
    const now = new Date().toISOString();
    if (clear) {
      // Dropping autoTitleAt + the attempt counter makes the bee a fresh daemon
      // auto-title candidate again.
      await updateSession(record.name, { title: undefined, titleSource: undefined, autoTitleAt: undefined, autoTitleAttempts: undefined, updatedAt: now });
      await writeHiveTitle(record, "");
      if (isPretty()) console.log(actionLine("ok", "rename", [bold(record.name), dim("title cleared")]));
      else console.log(`renamed\t${record.name}\t`);
      continue;
    }

    let title = explicit;
    let source: SessionRecord["titleSource"] = "user";
    if (auto) {
      const context = await gatherTitleContext(record);
      if (!context) {
        const reason = "no brief and no transcript to derive a title from";
        if (!isMulti) throw new Error(`${record.name}: ${reason}`);
        console.error(note(`skip ${record.name} (${reason})`));
        continue;
      }
      title = await generateTitle(context);
      source = "auto";
    }
    await updateSession(record.name, {
      title,
      titleSource: source,
      updatedAt: now,
      // Stamp autoTitleAt so the daemon's backoff sees a recent attempt; the bee
      // is no longer a candidate once title+titleSource are set, so the attempt
      // counter is intentionally left unbumped (this is the manual override).
      ...(auto ? { autoTitleAt: now } : {}),
    });
    await writeHiveTitle(record, title);
    if (isPretty()) console.log(actionLine("ok", "rename", [bold(record.name), title, dim(source)]));
    else console.log(`renamed\t${record.name}\t${title}\t${source}`);
  }
}

async function cmdTag(parsed: Parsed) {
  const target = parsed.args[0];
  const usage =
    "Usage: hive tag <selector> <tag>...  |  hive tag <selector> --remove <tag>...  |  hive tag <selector> --list";
  if (!target) throw new Error(usage);

  const listMode = truthy(flag(parsed, "list"));
  const removeArgs = arrayFlag(parsed, "remove");
  const removeMode = removeArgs.length > 0 || flag(parsed, "remove") === true;
  // Positional tags after the selector are the add set (unless we're in
  // list/remove mode, where positionals are ignored).
  const addArgs = !listMode && !removeMode ? parsed.args.slice(1) : [];

  if (!listMode && !removeMode && addArgs.length === 0) {
    throw new Error("hive tag: pass tag names to add, --remove <tag>... to remove, or --list to display");
  }

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);
  const isMulti = resolved.kind !== "bee";

  if (listMode) {
    for (const record of records) {
      const tags = Array.from(effectiveTags(record)).sort();
      const tagStr = tags.length > 0 ? tags.join(", ") : "(none)";
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim(tagStr)]));
      else console.log(`${record.name}\ttags\t${tagStr}`);
    }
    return;
  }

  if (removeMode) {
    if (removeArgs.length === 0) throw new Error("hive tag --remove: pass tag names to remove");
    let changed = 0;
    for (const record of records) {
      const before = record.tags ?? [];
      const after = before.filter((tag) => !removeArgs.includes(tag));
      if (before.length === after.length) {
        if (!isMulti) console.error(note(`${record.name}: no matching tags to remove`));
        continue;
      }
      changed += 1;
      const now = new Date().toISOString();
      await updateSession(record.name, { tags: after.length > 0 ? after : undefined, updatedAt: now });
      await writeHiveTags({ ...record, tags: after.length > 0 ? after : undefined });
      await appendLedger({ type: "tag.remove", bee: record.name, tags: removeArgs });
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim("removed"), removeArgs.join(", ")]));
      else console.log(`${record.name}\ttag.remove\t${removeArgs.join(", ")}`);
    }
    if (isMulti) {
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(target), `removed from ${changed}/${records.length} bees`]));
      else console.log(`tag.remove\t${target}\t${changed}/${records.length} bees`);
    }
    return;
  }

  // ADD mode: validate every tag (reject reserved namespaces, enforce grammar)
  // BEFORE mutating any record, so a bad tag never half-applies.
  for (const tag of addArgs) {
    const rejection = rejectReservedNamespaceTag(tag);
    if (rejection) throw new Error(`hive tag ${tag}: ${rejection}`);
    if (!isValidTagValue(tag)) {
      throw new Error(`Invalid tag: ${tag} (forbid whitespace/comma/tab/newline, max 64 chars)`);
    }
  }

  let changed = 0;
  for (const record of records) {
    const before = record.tags ?? [];
    const after = dedupeTags([...before, ...addArgs]);
    if (before.length === after.length && before.every((t, i) => t === after[i])) {
      if (!isMulti) console.error(note(`${record.name}: already has those tags`));
      continue;
    }
    changed += 1;
    const now = new Date().toISOString();
    await updateSession(record.name, { tags: after, updatedAt: now });
    await writeHiveTags({ ...record, tags: after });
    await appendLedger({ type: "tag.add", bee: record.name, tags: addArgs });
    if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim("added"), addArgs.join(", ")]));
    else console.log(`${record.name}\ttag.add\t${addArgs.join(", ")}`);
  }
  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "tag", [bold(target), `added to ${changed}/${records.length} bees`]));
    else console.log(`tag.add\t${target}\t${changed}/${records.length} bees`);
  }
}

// Resolve the owner selector to EXACTLY ONE bee, then point every bee resolved
// from each beeSelector at it (reportsToId edge). Shared by cmdOwn's set path
// and cmdMove's --owner alias (Risk 5: avoids synthesizing a fake Parsed).
async function setOwnership(ownerSel: string, beeSelectors: string[]): Promise<void> {
  const ownerResolved = await resolveSelector(ownerSel);
  const ownerRecords = ownerResolved.kind === "bee" ? [ownerResolved.record] : ownerResolved.records;
  if (ownerRecords.length === 0) throw new Error(`hive own: owner selector matched no bee: ${ownerSel}`);
  if (ownerRecords.length > 1) {
    throw new Error(`hive own: owner selector ${ownerSel} matched ${ownerRecords.length} bees; pick one`);
  }
  const owner = ownerRecords[0]!;
  const ownerId = owner.id ?? owner.name;

  let changed = 0;
  let total = 0;
  for (const sel of beeSelectors) {
    const resolved = await resolveSelector(sel);
    const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
    for (const record of records) {
      total += 1;
      const now = new Date().toISOString();
      await updateSession(record.name, { reportsToId: ownerId, updatedAt: now });
      await appendLedger({ type: "rel.set", bee: record.name, kind: "reports-to", to: ownerId });
      changed += 1;
      if (isPretty()) console.log(actionLine("ok", "own", [bold(record.name), dim("reports-to"), ownerId]));
      else console.log(`${record.name}\trel.set\treports-to\t${ownerId}`);
    }
  }
  if (isPretty()) console.log(actionLine("ok", "own", [bold(ownerId), `${changed}/${total} bees`]));
  else console.log(`own\t${ownerId}\t${changed}/${total} bees`);
}

// Clear the reportsToId edge on every bee resolved from beeSel. NEVER kills a
// bee — relationships are reference-only (§9.4 / R3).
async function clearOwnership(beeSel: string): Promise<void> {
  const resolved = await resolveSelector(beeSel);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${beeSel}`);
  for (const record of records) {
    const now = new Date().toISOString();
    await updateSession(record.name, { reportsToId: undefined, updatedAt: now });
    await appendLedger({ type: "rel.clear", bee: record.name, kind: "reports-to" });
    if (isPretty()) console.log(actionLine("ok", "own", [bold(record.name), dim("cleared")]));
    else console.log(`${record.name}\trel.clear\treports-to`);
  }
}

// `hive own <owner-selector> <bee-selector>...` sets the owned-by/reports-to
// edge; `hive own <bee-selector> --clear` unsets it. No @hive_tags refresh:
// relationships have no tmux mirror in v1 (§9.4).
async function cmdOwn(parsed: Parsed) {
  const ownerSel = parsed.args[0];
  const usage =
    "Usage: hive own <owner-selector> <bee-selector>...  |  hive own <bee-selector> --clear";
  if (!ownerSel) throw new Error(usage);

  if (truthy(flag(parsed, "clear"))) {
    if (parsed.args.length > 1) throw new Error("hive own --clear takes exactly one <bee-selector>");
    await clearOwnership(ownerSel);
    return;
  }

  const beeSelectors = parsed.args.slice(1);
  if (beeSelectors.length === 0) throw new Error(usage);
  await setOwnership(ownerSel, beeSelectors);
}

// `hive move <bee> --colony <c>` reassigns a bee's colony (the derived colony:
// tag follows on read); `hive move <bee> --owner <o>` is an alias for hive own
// on one bee, and `--owner ''` clears ownership.
async function cmdMove(parsed: Parsed) {
  const beeSel = parsed.args[0];
  const usage =
    "Usage: hive move <bee> --colony <c>  |  hive move <bee> --owner <o>  (--owner '' clears)";
  if (!beeSel) throw new Error(usage);

  const colonyRaw = flag(parsed, "colony");
  const ownerRaw = flag(parsed, "owner");
  if (colonyRaw === undefined && ownerRaw === undefined) throw new Error(usage);
  if (colonyRaw !== undefined && ownerRaw !== undefined) {
    throw new Error("hive move: pass either --colony or --owner, not both");
  }

  // --owner: alias for hive own on a single bee; --owner '' clears ownership.
  if (ownerRaw !== undefined) {
    const owner = typeof ownerRaw === "string" ? ownerRaw.trim() : "";
    if (owner === "") {
      await clearOwnership(beeSel);
      return;
    }
    await setOwnership(owner, [beeSel]);
    return;
  }

  // --colony: rewrite record.colony on each resolved bee (derived colony: tag
  // follows). Refresh @hive_tags because colony: is a derived reserved tag.
  if (colonyRaw === true) throw new Error("--colony requires a value");
  const colony = String(colonyRaw);
  const resolved = await resolveSelector(beeSel);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${beeSel}`);
  for (const record of records) {
    const now = new Date().toISOString();
    const next = colony.trim() === "" ? undefined : colony;
    await updateSession(record.name, { colony: next, updatedAt: now });
    await writeHiveTags({ ...record, colony: next });
    if (isPretty()) console.log(actionLine("ok", "move", [bold(record.name), dim("colony"), next ?? "(none)"]));
    else console.log(`${record.name}\tmove\tcolony\t${next ?? ""}`);
  }
}

async function deliverBrief(parsed: Parsed, record: SessionRecord, briefText: string): Promise<SessionRecord> {
  try {
    await waitForAgentReady(record, {
      timeoutMs: numberFlag(parsed, ["boot-ms"], defaultBootMs(record.agent)),
      acceptTrust: acceptsTrust(parsed),
      raiseDroidAutonomy: dangerousMode(parsed, record.agent, record.requestedAgent),
    });
  } catch (error) {
    if (!(error instanceof AgentReadinessError) || error.reason !== "timeout" || !truthy(flag(parsed, "force-send"))) throw error;
    console.error(actionLine("warn", "force", [`readiness timeout for ${bold(record.name)}, briefing anyway`]));
  }
  const delivered = augmentBrief(parsed, briefText);
  await substrateFor(record).sendText(record.tmuxTarget, delivered, record.agentPaneId);
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

/**
 * After a bare spawn, wait for the freshly spawned bee to reach its prompt,
 * auto-accepting any startup trust/safety prompt along the way (e.g. codex's
 * "Do you trust the contents of this directory?"). Without this, a plain
 * `hive spawn codex` sits forever at the trust prompt with nobody to press
 * Enter. The bee is already spawned and persisted, so readiness problems are
 * surfaced as warnings rather than failing the spawn. Opt out of the wait with
 * `--no-wait`, or out of trust acceptance specifically with `--no-accept-trust`.
 */
async function confirmSpawnReady(parsed: Parsed, record: SessionRecord): Promise<void> {
  if (truthy(flag(parsed, "no-wait"))) return;
  // HSR bees have no interactive TUI to poll — the runner host was already
  // confirmed live at spawn. Mark it waiting (its "ready" state) and return.
  if (record.substrate === "hsr") {
    await writeHiveState(record, "waiting");
    return;
  }
  try {
    await waitForAgentReady(record, {
      timeoutMs: numberFlag(parsed, ["boot-ms"], defaultBootMs(record.agent)),
      acceptTrust: acceptsTrust(parsed),
      raiseDroidAutonomy: dangerousMode(parsed, record.agent, record.requestedAgent),
    });
    // The agent reached its prompt: it is waiting for input until briefed/prompted.
    await writeHiveState(record, "waiting");
  } catch (error) {
    if (!(error instanceof AgentReadinessError)) throw error;
    if (isPretty()) console.error(actionLine("warn", "spawn", [`${bold(record.name)} not confirmed ready (${error.reason})`]));
    else console.error(`warn\tspawn\t${record.name}\t${error.reason}`);
  }
}

async function confirmSpawnReadyAll(parsed: Parsed, records: SessionRecord[]): Promise<void> {
  if (truthy(flag(parsed, "no-wait"))) return;
  await Promise.all(records.map((record) => confirmSpawnReady(parsed, record)));
}

function augmentBrief(parsed: Parsed, briefText: string): string {
  if (truthy(flag(parsed, "no-wait-footer")) || truthy(flag(parsed, "no-footer"))) return briefText;
  const customFooter = flag(parsed, "wait-footer") ?? flag(parsed, "footer");
  const footer = typeof customFooter === "string" ? customFooter : briefFooter();
  if (!footer) return briefText;
  return briefText.endsWith(footer) ? briefText : `${briefText}${footer}`;
}

async function resolveSpawnCwd(parsed: Parsed, profileCwd?: string): Promise<string> {
  // Precedence FLAG > PROFILE > process cwd.
  const requested = resolve((stringFlag(parsed, ["cwd"]) ?? profileCwd ?? process.cwd()).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  return realpath(requested);
}

function resolveSwarmIdHint(parsed: Parsed, prefix?: string): string {
  const explicit = flag(parsed, "swarm-id") ?? flag(parsed, "swarm");
  if (typeof explicit === "string") {
    if (!validSwarmId(explicit)) throw new Error(`Invalid swarm id: ${explicit}`);
    return explicit;
  }
  return generateSwarmId(prefix);
}

async function cmdSend(parsed: Parsed) {
  const target = parsed.args[0];
  const prompt = stringFlag(parsed, ["prompt", "p"]) ?? parsed.args.slice(1).join(" ");
  if (!target || !prompt) throw new Error("Usage: hive send <selector> <prompt> OR hive send <selector> -p <prompt>");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  let sent = 0;
  for (const record of records) {
    if (!(await substrateFor(record).hasSession(record.tmuxTarget))) {
      if (!isMulti) throw new Error(`tmux session is not running: ${record.tmuxTarget}`);
      if (isPretty()) console.error(note(`skip ${record.name} (dead)`));
      else console.error(`skip\t${record.name}\tdead`);
      continue;
    }
    await substrateFor(record).sendText(record.tmuxTarget, prompt, record.agentPaneId);
    const now = new Date().toISOString();
    await updateSession(record.name, { updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now });
    await writeHiveState(record, "working");
    await appendLedger({ type: "prompt.send", session: record.name, agent: record.agent, node: record.node ?? LOCAL_NODE_NAME, cwd: record.cwd, chars: prompt.length });
    if (isPretty()) console.log(actionLine("ok", "send", [bold(record.name), `${prompt.length} chars`]));
    else console.log(`sent\t${record.name}\t${prompt.length} chars`);
    sent += 1;
  }

  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "send", [bold(target), `${sent}/${records.length} bees`]));
    else console.log(`sent\t${target}\t${sent}/${records.length}`);
  }
}

/**
 * Answer the pending needs_input of a blocked HSR bee over its control socket.
 * The daemon routes an HSR bee's needs_input to its parent as a buz; the parent
 * (or a human) replies with `hive answer <bee> <text>`. Defaults to "yes" when
 * no text is supplied (the common permission-approve case).
 */
async function cmdAnswer(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive answer <bee> [text]");
  const text = stringFlag(parsed, ["answer", "a"]) ?? parsed.args.slice(1).join(" ") ?? "";
  const answer = text.length > 0 ? text : "yes";

  const record = await resolveSession(target);
  if (record.substrate !== "hsr") {
    throw new Error(`hive answer applies to HSR bees only; ${record.name} is ${record.substrate ?? "local-tmux"}`);
  }
  const pending = await pendingNeedsInput(record.name);
  if (!pending) throw new Error(`No pending needs-input for ${record.name}`);
  const meta = await readHsrMeta(record.name);
  if (!meta?.controlSocket) throw new Error(`No control socket for ${record.name}`);

  const client = await connectRpcClient(meta.controlSocket);
  try {
    await client.call("answer", { requestId: pending.requestId, answer });
  } finally {
    client.close();
  }

  if (isPretty()) console.log(actionLine("ok", "answer", [bold(record.name), dim(pending.requestId)]));
  else console.log(`answered\t${record.name}\t${pending.requestId}`);
}

async function cmdTail(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive tail <session> [-n lines] [-f|--follow] [--poll-ms 1000]");
  const record = await resolveSession(target);
  await ensureLive(record);
  const options = parseTailOptions(parsed);
  if (options.follow) {
    await followTail(record, options.lines, options.pollMs);
    return;
  }
  console.log(await substrateFor(record).capture(record.tmuxTarget, options.lines, record.agentPaneId));
}

async function followTail(record: SessionRecord, lines: number, pollMs: number): Promise<void> {
  let previous = "";
  while (true) {
    await ensureLive(record);
    const next = await substrateFor(record).capture(record.tmuxTarget, lines, record.agentPaneId);
    const delta = appendedPaneText(previous, next);
    if (delta) {
      if (previous && !next.startsWith(previous)) process.stdout.write("\n");
      process.stdout.write(delta.endsWith("\n") ? delta : `${delta}\n`);
    }
    previous = next;
    await sleep(Math.max(100, pollMs));
  }
}

async function cmdList(parsed: Parsed) {
  const [allRecords, nodes] = await Promise.all([listSessions(), listNodes()]);

  const colonyFilter = typeof flag(parsed, "colony") === "string" ? String(flag(parsed, "colony")) : undefined;
  const swarmFilter = typeof flag(parsed, "swarm") === "string" ? String(flag(parsed, "swarm")).replace(/^@/, "") : undefined;
  const nodeFilter = typeof flag(parsed, "node") === "string" ? String(flag(parsed, "node")) : undefined;
  const stateFilter = stringFlag(parsed, ["state"]);
  const agentFilter = stringFlag(parsed, ["agent"]);
  const repoFilter = stringFlag(parsed, ["repo"]);
  const tagFilters = arrayFlag(parsed, "tag");
  const jsonOut = truthy(flag(parsed, "json"));
  const positionalSel = parsed.args[0];
  if (nodeFilter) {
    const node = await loadNode(nodeFilter);
    if (!node) throw new Error(`Unknown node: ${nodeFilter}. Register it with: hive node register ${nodeFilter} --kind ssh-tmux --endpoint user@host`);
  }
  const probe = await liveTargetsAcrossNodes(nodes, nodeFilter);
  let records = allRecords;
  // Filed (archived) bees are hidden from the default list — a `quest done`-filed
  // bee is no longer a working bee (PRD §16 #4). Re-include them with --archived
  // (mirrors `workspace list --archived`), and auto-include when the user targets
  // them explicitly with `--state archived` so that query is never empty.
  const showArchived = truthy(flag(parsed, "archived")) || stateFilter === "archived";
  if (!showArchived) records = records.filter((r) => r.status !== "archived");
  if (colonyFilter) records = records.filter((r) => r.colony === colonyFilter);
  if (swarmFilter) records = records.filter((r) => r.swarmId === swarmFilter);
  if (nodeFilter) records = records.filter((r) => (r.node ?? LOCAL_NODE_NAME) === nodeFilter);
  if (agentFilter) records = records.filter((r) => r.agent === agentFilter);
  if (repoFilter) records = records.filter((r) => repoTagFor(r.cwd) === repoFilter);
  // --tag repeats conjunctively (AND): every filter (bare user tag or ns:val)
  // must be present in the bee's effective tag set (PRD §8.3, T4).
  if (tagFilters.length > 0) {
    records = records.filter((r) => {
      const tags = effectiveTags(r);
      return tagFilters.every((arg) => tags.has(normalizeTagArg(arg)));
    });
  }
  if (positionalSel) {
    // Let resolveSelector throw on a genuinely unknown colony/swarm, consistent
    // with the other commands; an empty colony/swarm just filters to nothing.
    const resolved = await resolveSelector(positionalSel);
    const names = new Set(resolved.kind === "bee" ? [resolved.record.name] : resolved.records.map((r) => r.name));
    records = records.filter((r) => names.has(r.name));
  }

  const panes = await capturePanesFor(records, probe.liveTargets);
  const seals = await listSealedBeeNames();
  const livePanes = await localSubstrate().listPanes().catch(() => new Set<string>());
  // HSR bees are pane-less — observed from run dirs, not tmux. Without this they
  // have no live pane/target and deriveState reads every one as dead.
  const hsrObs = await hsrObservations().catch(() => new Map<string, HsrObservation>());
  const hsrLive = new Set<string>();
  const hsrStates = new Map<string, BeeState>();
  const hsrSnapshots = new Map<string, string>();
  for (const [bee, observation] of hsrObs) {
    if (observation.live) hsrLive.add(bee);
    if (observation.state) hsrStates.set(bee, observation.state);
    hsrSnapshots.set(bee, observation.snapshot);
  }
  const context: StateContext = {
    liveTargets: probe.liveTargets,
    livePanes,
    panes,
    seals,
    unreachableNodes: probe.unreachableNodes,
    hsrLive,
    hsrStates,
    hsrSnapshots,
    now: Date.now(),
  };
  const states = new Map(records.map((record) => [record.name, deriveState(record, context)] as const));

  // Live @hive_state (set by hive itself and by agent hooks) wins over the
  // store-derived state — the tmux server is the source of truth for live bees.
  const liveHiveState = (record: SessionRecord): string | undefined => {
    const state = probe.states.get(liveTargetKey(record.node, record.tmuxTarget));
    return effectiveHiveState(state, states.get(record.name)?.state);
  };

  // --state matches the live @hive_state, the coarse hive mapping of the derived
  // BeeState, the BeeState itself, or its display label — so `--state waiting`,
  // `--state idle_with_output`, and `--state idle` all resolve.
  if (stateFilter) {
    records = records.filter((r) => {
      const beeState = states.get(r.name)!.state;
      return (
        (liveHiveState(r) ?? hiveStateFor(beeState)) === stateFilter ||
        beeState === stateFilter ||
        stateLabel(beeState) === stateFilter
      );
    });
  }

  if (jsonOut) {
    console.log(
      JSON.stringify(
        records.map((r) => ({
          ref: highlightUniqueSessionReference(records, r, { start: "", end: "" }),
          name: r.name,
          id: r.id,
          title: r.title,
          agent: r.agent,
          state: liveHiveState(r) ?? states.get(r.name)!.state,
          beeState: states.get(r.name)!.state,
          detail: states.get(r.name)!.detail,
          colony: r.colony,
          swarm: r.swarmId,
          comb: r.combId,
          node: r.node ?? LOCAL_NODE_NAME,
          repo: repoTagFor(r.cwd),
          cwd: r.cwd,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (!isPretty()) {
    const marker = { start: "", end: "" };
    for (const record of records) {
      const derived = states.get(record.name)!;
      const ref = highlightUniqueSessionReference(records, record, marker);
      console.log(`${liveHiveState(record) ?? derived.state}\t${ref}\t${sessionDisplayName(record, { collapseDefaultId: false })}\t${record.agent}\t${record.cwd}\t${record.command}`);
    }
    if (probe.unreachableNodes.size > 0) {
      console.error(`# ${probe.unreachableNodes.size} node(s) unreachable: ${[...probe.unreachableNodes].join(", ")}`);
    }
    return;
  }

  if (records.length === 0) {
    const filters = [
      positionalSel ? positionalSel : undefined,
      colonyFilter ? `colony:${colonyFilter}` : undefined,
      swarmFilter ? `@${swarmFilter}` : undefined,
      nodeFilter ? `node:${nodeFilter}` : undefined,
      stateFilter ? `state:${stateFilter}` : undefined,
      agentFilter ? `agent:${agentFilter}` : undefined,
      repoFilter ? `repo:${repoFilter}` : undefined,
      ...tagFilters.map((t) => `tag:${t}`),
    ].filter((part): part is string => part !== undefined);
    if (filters.length > 0) console.log(dim(`No bees match ${filters.join(" ")}`));
    else console.log(dim("No bees in the hive. Spawn one with: hive spawn <bee>"));
    return;
  }

  const terminalWidth = process.stdout.columns ?? 100;
  const showNodeColumn = shouldShowNodeColumn(nodes, truthy(flag(parsed, "wide")));
  const cwdMax = Math.max(20, Math.min(60, terminalWidth - (showNodeColumn ? 90 : 78)));
  const now = Date.now();

  const rows = records.map((record) => {
    const derived = states.get(record.name)!;
    const ref = truncate(highlightUniqueSessionReference(records, record), 16);
    const displayName = sessionDisplayName(record);
    const name = displayName === "=" ? dim("=") : truncate(displayName, 22);
    const ageSource = isTerminalState(derived.state) ? record.updatedAt : record.createdAt;
    const ageText = formatRelativeTime(ageSource, now);
    const age = isTerminalState(derived.state) ? dim(ageText) : ageText;
    const nodeName = record.node ?? LOCAL_NODE_NAME;
    const live = liveHiveState(record);
    const base = [
      live ? formatHiveStateCell(live) : formatStateCell(derived.state),
      ref,
      name,
      truncate(record.agent, 12),
      dim(truncate(derived.detail, 30)),
      age,
      dim(truncate(tildify(record.cwd), cwdMax)),
    ];
    return showNodeColumn ? [...base.slice(0, 4), dim(truncate(nodeName, 12)), ...base.slice(4)] : base;
  });

  const columns = showNodeColumn
    ? [
        { header: "STATE" },
        { header: "REF" },
        { header: "NAME" },
        { header: "BEE" },
        { header: "NODE" },
        { header: "DETAIL" },
        { header: "AGE", align: "right" as const },
        { header: "CWD" },
      ]
    : [
        { header: "STATE" },
        { header: "REF" },
        { header: "NAME" },
        { header: "BEE" },
        { header: "DETAIL" },
        { header: "AGE", align: "right" as const },
        { header: "CWD" },
      ];

  console.log(formatTable(columns, rows));

  if (probe.unreachableNodes.size > 0) {
    console.error(note(`${probe.unreachableNodes.size} node(s) unreachable: ${[...probe.unreachableNodes].join(", ")}`));
  }
}

async function cmdBees(parsed: Parsed): Promise<void> {
  if (truthy(flag(parsed, "toggle-sidebar"))) {
    const widthRaw = stringFlag(parsed, ["width", "w"]);
    const width = widthRaw !== undefined ? Number(widthRaw) : undefined;
    await toggleBeesSidebar(Number.isFinite(width) ? width : undefined);
    return;
  }

  const { items, records } = await loadBeesTuiItems(parsed);
  const sidebar = truthy(flag(parsed, "sidebar"));
  const groupMode = (await readBeesGroupMode()) ?? undefined;
  // The sidebar lives beside one bee's window: start on that bee and mark it, so
  // each window's fresh strip lands on its bee instead of resetting to the top.
  const currentName = sidebar ? await resolveCurrentSidebarBeeName(records) : undefined;

  await runBeesTui({
    items,
    sidebar,
    groupMode,
    ...(currentName ? { currentName } : {}),
    onGroupChange: async (mode) => {
      // Persist globally so every sidebar (and the next launch) shares the facet.
      await writeBeesGroupMode(mode);
    },
    // Sidebars live-update each other: poll the shared facet so cycling in one
    // strip re-groups the rest. Skipped for the standalone full-screen TUI.
    ...(sidebar ? { syncGroupMode: () => readBeesGroupMode() } : {}),
    // Live-refresh the catalog so renames/spawns/kills/state changes appear
    // without reopening. Reuses the same filters this invocation was launched
    // with; the TUI diffs and only redraws on real change.
    refreshItems: async () => (await loadBeesTuiItems(parsed)).items,
    onPreview: async (item) => {
      const record = await resolveSession(item.name).catch(() => undefined);
      if (!record) return;
      await openBeePreviewPopup(record);
    },
    onKill: async (item) => {
      const record = await resolveSession(item.name).catch(() => undefined);
      if (!record) return { ok: false, detail: "no matching bee record" };
      const outcome = await transactionalKill(record);
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.lastError };
    },
    onSelect: async (item) => {
      const record = await resolveSession(item.name);
      await ensureLive(record);
      if (sidebar) {
        await showBeeBesideSidebar(record);
        return;
      }
      if (!process.env.TMUX) {
        // Launched from a bare terminal: attach the bee's session with the
        // sidebar already materialized, so you land in the cockpit.
        await attachBeeWithSidebar(record);
        return;
      }
      const substrate = substrateFor(record);
      await applyBeeWindowOptions(record);
      await substrate.attachSession(record.tmuxTarget);
      await syncBeesSidebarLayout({ pruneOthers: true });
    },
  });
}

async function loadBeesTuiItems(parsed: Parsed): Promise<{ items: BeesTuiItem[]; records: SessionRecord[] }> {
  const colonyFilter = typeof flag(parsed, "colony") === "string" ? String(flag(parsed, "colony")) : undefined;
  const swarmFilter = typeof flag(parsed, "swarm") === "string" ? String(flag(parsed, "swarm")) : undefined;
  const nodeFilter = typeof flag(parsed, "node") === "string" ? String(flag(parsed, "node")) : undefined;

  const allRecords = await listSessions();
  const nodes = await listNodes();
  if (nodeFilter && !nodes.some((node) => node.name === nodeFilter)) {
    throw new Error(`Unknown node: ${nodeFilter}. Register it with: hive node register ${nodeFilter} --kind ssh-tmux --endpoint user@host`);
  }
  const probe = await liveTargetsAcrossNodes(nodes, nodeFilter);
  let records = allRecords;
  if (colonyFilter) records = records.filter((record) => record.colony === colonyFilter);
  if (swarmFilter) records = records.filter((record) => record.swarmId === swarmFilter);
  if (nodeFilter) records = records.filter((record) => (record.node ?? LOCAL_NODE_NAME) === nodeFilter);

  const panes = await capturePanesFor(records, probe.liveTargets);
  const seals = await listSealedBeeNames();
  const livePanes = await localSubstrate().listPanes().catch(() => new Set<string>());
  // HSR bees are pane-less — observed from run dirs, not tmux. Best-effort so a
  // bad/absent HSR root never breaks the tmux path.
  const hsrObs = await hsrObservations().catch(() => new Map<string, HsrObservation>());
  const hsrLive = new Set<string>();
  const hsrStates = new Map<string, BeeState>();
  const hsrSnapshots = new Map<string, string>();
  for (const [bee, observation] of hsrObs) {
    if (observation.live) hsrLive.add(bee);
    if (observation.state) hsrStates.set(bee, observation.state);
    hsrSnapshots.set(bee, observation.snapshot);
  }
  const context: StateContext = {
    liveTargets: probe.liveTargets,
    livePanes,
    panes,
    seals,
    unreachableNodes: probe.unreachableNodes,
    hsrLive,
    hsrStates,
    hsrSnapshots,
    now: Date.now(),
  };

  // Resolve each bee's cwd to its pro area/project/repo once, so the TUI can
  // group by pro facets without shelling out. Best-effort: no pro CLI → no
  // facets (those grouping modes just bucket everything under "no pro …").
  const proEntries = await listProRepoEntries().catch(() => [] as ProRepoEntry[]);

  const now = Date.now();
  const items = records.map((record) => {
    const derived = deriveState(record, context);
    const live = derived.state !== "dead" && derived.state !== "sealed" && derived.state !== "node_unreachable";
    const liveHive = effectiveHiveState(probe.states.get(liveTargetKey(record.node, record.tmuxTarget)), derived.state);
    const stateHeadline = liveHive ? liveHive : stateLabel(derived.state);
    const displayName = sessionDisplayName(record);
    const ref = highlightUniqueSessionReference(records, record);
    const ageSource = isTerminalState(derived.state) ? record.updatedAt : record.createdAt;
    const detail = beeTuiDescription(record, derived);
    const pro = resolveProSlotForCwd(proEntries, record.cwd);
    return {
      name: record.name,
      ref,
      displayName: displayName === "=" ? record.name : displayName,
      colony: record.colony ?? "",
      swarmId: record.swarmId ?? "",
      agent: record.agent,
      cwd: record.cwd,
      stateLabel: derived.state,
      stateHeadline,
      detail,
      age: formatRelativeTime(ageSource, now),
      tmuxTarget: record.tmuxTarget,
      node: record.node,
      live,
      ...(pro
        ? {
            proArea: pro.area,
            proProject: pro.project,
            proRepo: pro.repo,
            ...(pro.slot ? { proSlotKind: pro.kind as ProSlotKind, proSlotName: pro.slot } : {}),
          }
        : {}),
      searchText: beesTuiSearchText({
        name: record.name,
        displayName: displayName === "=" ? record.name : displayName,
        colony: record.colony,
        swarmId: record.swarmId,
        agent: record.agent,
        cwd: record.cwd,
        detail,
        ref,
        slot: pro?.slot,
      }),
    };
  });
  return { items, records };
}

function beeTuiDescription(record: SessionRecord, derived: DerivedState): string {
  const candidates = [
    record.notes,
    record.brief,
    record.lastPrompt,
    derived.detail,
    record.cwd,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeBeeTuiDescription(candidate);
    if (normalized) return normalized;
  }
  return record.agent;
}

function normalizeBeeTuiDescription(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 400 ? `${normalized.slice(0, 400)}...` : normalized;
}

const DEFAULT_NODE_PROBE_TIMEOUT_MS = 2_500;

export type MultiNodeLiveProbe = {
  /** Live tmux sessions keyed by liveTargetKey(node, target). */
  liveTargets: Set<string>;
  unreachableNodes: Set<string>;
  perNode: Map<string, string[]>;
  /** Live @hive_state per session, keyed like liveTargets (empty string when unset). */
  states: Map<string, string>;
};

async function liveTargetsAcrossNodes(nodes: NodeRecord[], nodeFilter?: string): Promise<MultiNodeLiveProbe> {
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

function formatHiveStateCell(state: string): string {
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

function formatStateCell(state: BeeState): string {
  const label = stateLabel(state);
  switch (state) {
    case "active":
      return `${green("●")} ${green(label)}`;
    case "ready":
      return `${green("●")} ${label}`;
    case "booting":
      return `${cyan("●")} ${cyan(label)}`;
    case "blocked":
      return `${yellow("●")} ${yellow(label)}`;
    case "idle_with_output":
      return `${dim("●")} ${label}`;
    case "sealed":
      return `${magenta("●")} ${magenta(label)}`;
    case "archived":
      return `${gray("○")} ${gray(label)}`;
    case "error":
      return `${red("●")} ${red(label)}`;
    case "kill_failed":
      return `${red("●")} ${red(label)}`;
    case "dead":
      return `${gray("○")} ${gray(label)}`;
    case "node_unreachable":
      return `${yellow("?")} ${yellow(label)}`;
  }
}

async function capturePanesFor(records: SessionRecord[], liveTargets: Set<string>): Promise<Map<string, string>> {
  const liveRecords = records.filter((record) => liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)));
  const entries = await Promise.all(
    // Re-key by the bee's own pane (agentPaneId) so sub-bees sharing one comb's
    // tmuxTarget keep distinct captures; legacy solo bees with no pane fall back
    // to tmuxTarget. deriveState reads with the same `agentPaneId ?? tmuxTarget`.
    liveRecords.map(async (record) => [record.agentPaneId ?? record.tmuxTarget, await substrateFor(record).capture(record.tmuxTarget, 80, record.agentPaneId).catch(() => "")] as const),
  );
  return new Map(entries);
}

async function listSealedBeeNames(): Promise<Set<string>> {
  return sealedBeeNamesImpl().catch(() => new Set<string>());
}

async function cmdClean(parsed: Parsed) {
  const interactive = hasFlag(parsed, "interactive") || hasFlag(parsed, "i");
  const wantsDead = hasFlag(parsed, "dead");
  const wantsIdle = hasFlag(parsed, "idle");

  if (interactive) {
    if (wantsDead || wantsIdle) {
      throw new Error("hive clean -i/--interactive cannot be combined with --dead/--idle; pick targets in the TUI instead.");
    }
    if (hasFlag(parsed, "dry-run") || hasFlag(parsed, "n") || hasFlag(parsed, "older-than") || hasFlag(parsed, "older")) {
      throw new Error("hive clean -i/--interactive does not support --dry-run/--older-than; pick targets in the TUI instead.");
    }
    return cmdCleanInteractive(parsed);
  }
  if (wantsDead && wantsIdle) throw new Error("Choose either hive clean --dead or hive clean --idle, not both.");
  if (wantsIdle) return cmdCleanIdle(parsed);
  if (wantsDead) return cmdCleanDead(parsed);
  throw new Error("Usage: hive clean (--dead|--idle|-i|--interactive) [--older-than <age>] [--dry-run|-n]");
}

async function cmdCleanDead(parsed: Parsed) {
  const [allRecords, nodes] = await Promise.all([listSessions(), listNodes()]);
  // A filed (archived) bee is filed, not dead — `clean` must never reap it (PRD
  // §13); only an explicit `hive kill` deletes a filed bee. Exclude it at the
  // source so neither the dead-sweep nor the pane-dead loop below can touch it.
  const records = allRecords.filter((r) => r.status !== "archived");
  const probe = await liveTargetsAcrossNodes(nodes);
  // Records on an unreachable node are NOT dead — we genuinely don't know their state.
  // Treat them as live so we don't sweep their metadata while their node is down.
  // The same goes for records whose node is no longer registered: it was never
  // probed, so we cannot tell whether the remote session is still running.
  const knownNodes = new Set(nodes.map((node) => node.name));
  const unknownNodes = new Set<string>();
  const recordsConsideredAlive = new Set(probe.liveTargets);
  for (const record of records) {
    const nodeName = record.node ?? LOCAL_NODE_NAME;
    if (!knownNodes.has(nodeName)) {
      unknownNodes.add(nodeName);
      recordsConsideredAlive.add(liveTargetKey(record.node, record.tmuxTarget));
      continue;
    }
    if (probe.unreachableNodes.has(nodeName)) {
      recordsConsideredAlive.add(liveTargetKey(record.node, record.tmuxTarget));
    }
  }
  if (unknownNodes.size > 0) {
    const skipped = [...unknownNodes].join(", ");
    if (isPretty()) console.error(note(`skipping bees on unregistered node(s): ${skipped} (re-register or kill them explicitly)`));
    else console.error(`# skipping bees on unregistered node(s): ${skipped}`);
  }
  let dead = deadSessionRecords(records, recordsConsideredAlive);
  // Phase B: a local sub-bee whose pane died (agentPaneId ∉ live panes) is dead
  // even though its comb/session survives via a sibling pane. Mirror
  // deriveState's pane-pinned liveness so `hive clean --dead` sweeps it too.
  // Guard against a transient empty listPanes() (server hiccup): only sweep
  // panes when at least one pane responded — an empty set can't be trusted to
  // mean "all panes dead" while sessions are live.
  const livePanes = await localSubstrate().listPanes().catch(() => new Set<string>());
  if (livePanes.size > 0) {
    const deadNames = new Set(dead.map((record) => record.name));
    for (const record of records) {
      if (deadNames.has(record.name)) continue;
      const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
      // Only a bee whose comb is otherwise considered alive can be "pane-dead";
      // if its session is gone it is already in `dead`.
      const sessionLive = recordsConsideredAlive.has(liveTargetKey(record.node, record.tmuxTarget));
      if (isLocal && sessionLive && record.agentPaneId && !livePanes.has(record.agentPaneId)) {
        dead.push(record);
        deadNames.add(record.name);
      }
    }
  }
  const olderThan = ageFlag(parsed, ["older-than", "older"]);
  if (olderThan !== undefined) dead = olderThanMillis(dead, olderThan);
  const dryRun = truthy(flag(parsed, "dry-run")) || truthy(flag(parsed, "n"));

  if (dead.length === 0) {
    if (isPretty()) console.log(dim("No dead bees to clean."));
    else console.log("cleaned\t0");
    return;
  }

  if (dryRun) {
    if (!isPretty()) {
      for (const record of dead) console.log(`dead\t${record.id ?? record.name}\t${record.name}\t${record.agent}\t${deadSessionAge(record)}\t${record.cwd}`);
      return;
    }
    console.log(formatTable(
      [
        { header: "REF" },
        { header: "NAME" },
        { header: "BEE" },
        { header: "AGE", align: "right" },
        { header: "CWD" },
      ],
      dead.map((record) => [
        truncate(highlightUniqueSessionReference(records, record), 16),
        truncate(record.name, 22),
        truncate(record.agent, 12),
        dim(deadSessionAge(record)),
        dim(truncate(tildify(record.cwd), Math.max(20, Math.min(60, (process.stdout.columns ?? 100) - 68)))),
      ]),
    ));
    console.error(note("dry run; remove these with: hive clean --dead"));
    return;
  }

  for (const record of dead) {
    await deleteSession(record.name);
    if (isPretty()) console.log(actionLine("ok", "clean", [bold(record.name), record.agent, dim(tildify(record.cwd))]));
    else console.log(`cleaned\t${record.name}`);
  }
}

async function cmdCleanIdle(parsed: Parsed) {
  const { candidates } = await collectCleanCandidates();
  let idle = candidates.filter((candidate) => candidate.state === "idle_with_output" && candidate.mode === "kill");
  const olderThan = ageFlag(parsed, ["older-than", "older"]);
  if (olderThan !== undefined) {
    const oldEnough = new Set(idleOlderThanMillis(idle.map((candidate) => candidate.record), olderThan).map((record) => record.name));
    idle = idle.filter((candidate) => oldEnough.has(candidate.record.name));
  }
  const dryRun = truthy(flag(parsed, "dry-run")) || truthy(flag(parsed, "n"));

  if (idle.length === 0) {
    if (isPretty()) console.log(dim("No idle bees to clean."));
    else console.log("cleaned\t0");
    return;
  }

  if (dryRun) {
    printIdleDryRun(idle);
    return;
  }

  await cleanCandidates(idle);
}

async function cmdCleanInteractive(_parsed: Parsed) {
  const { candidates } = await collectCleanCandidates();
  if (candidates.length === 0) {
    console.log(dim("No bees in the hive. Nothing to clean."));
    return;
  }
  const candidateByName = new Map(candidates.map((candidate) => [candidate.record.name, candidate] as const));
  const result = await chooseCleanTargets(candidates.map(cleanTuiItem), {
    loadPreview: async (item) => {
      const candidate = candidateByName.get(item.name);
      if (!candidate) return "No matching bee record found.";
      return cleanPreview(candidate.record);
    },
    clean: async (items) => {
      const targets = items.flatMap((item) => {
        const candidate = candidateByName.get(item.name);
        return candidate && candidate.mode !== "disabled" ? [candidate] : [];
      });
      const outcomes = await cleanCandidatesForTui(targets);
      for (const outcome of outcomes) {
        if (!outcome.ok) continue;
        candidateByName.delete(outcome.name);
      }
      return outcomes;
    },
  });
  if (result.failed > 0) process.exitCode = 1;
}

async function cleanPreview(
  record: SessionRecord,
  opts: { transcriptRows?: number; paneLines?: number } = {},
): Promise<string> {
  const transcriptRows = opts.transcriptRows ?? 8;
  const paneLines = opts.paneLines ?? 80;
  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record)).catch(() => null);
  if (tx) {
    const rendered = renderTranscript(tx.rows, { limit: transcriptRows }).trim();
    if (rendered) return [`transcript ${tx.provider} ${tildify(tx.path)}`, "", rendered].join("\n");
  }

  try {
    if (await substrateFor(record).hasSession(record.tmuxTarget)) {
      const pane = await substrateFor(record).capture(record.tmuxTarget, paneLines, record.agentPaneId);
      if (pane.trim()) return [`pane tail ${record.tmuxTarget}`, "", pane.trimEnd()].join("\n");
    }
  } catch {
    // Fall through to the metadata fallback; preview should not make selection brittle.
  }

  if (record.lastPrompt) return ["last prompt", "", record.lastPrompt].join("\n");
  if (record.brief) return ["brief", "", record.brief].join("\n");
  return "No transcript or pane tail available.";
}

/**
 * Preview text for the popup: prefer the bee's actual *rendered* pane (colors
 * intact) so the operator sees the live agent UI — not just the transcript log.
 * Falls back to the transcript / pane tail for dead or remote bees.
 */
async function renderedBeeView(record: SessionRecord): Promise<string> {
  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  if (isLocal && process.env.TMUX) {
    try {
      if (await localSubstrate().hasSession(record.tmuxTarget)) {
        // -e keeps SGR colors; capturing the visible screen reproduces the
        // agent's current rendered frame (its TUI), not the scrollback log.
        const paneTarget = record.agentPaneId ?? `=${record.tmuxTarget}`;
        const captured = await tmux(["capture-pane", "-e", "-p", "-t", paneTarget], { reject: false });
        const view = captured.ok ? captured.stdout.replace(/\s+$/, "") : "";
        if (view.trim()) return view;
      }
    } catch {
      // fall through to the transcript preview
    }
  }
  return cleanPreview(record, { transcriptRows: 80, paneLines: 200 });
}

/**
 * Open a bee's preview in a large, scrollable tmux popup — far more readable
 * than an inline strip in the narrow sidebar. Blocks until the operator quits
 * the pager; falls back to a plain print outside tmux.
 */
async function openBeePreviewPopup(record: SessionRecord): Promise<void> {
  const text = await renderedBeeView(record);
  if (!process.env.TMUX) {
    console.log(text);
    return;
  }
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(os.tmpdir(), `hive-preview-${safeName(record.name)}.txt`);
  const header = `${record.name}  ${record.agent}  ${tildify(record.cwd)}`;
  await writeFile(file, `${header}\n\n${text}\n`, "utf8");
  const quoted = `'${file.replaceAll("'", `'\\''`)}'`;
  try {
    // -R keeps the transcript's ANSI colors; q in less closes the popup.
    await tmux(["display-popup", "-E", "-w", "85%", "-h", "85%", `less -R -- ${quoted}`], { reject: false });
  } finally {
    await rm(file, { force: true });
  }
}

type CleanMode = "delete" | "kill" | "disabled";

type CleanCandidate = CleanTuiItem & {
  record: SessionRecord;
  mode: CleanMode;
  ageMs: number;
};

async function collectCleanCandidates(): Promise<{ records: SessionRecord[]; candidates: CleanCandidate[] }> {
  const [allRecords, nodes] = await Promise.all([listSessions(), listNodes()]);
  // A filed (archived) bee derives to the "archived" terminal state but must NOT
  // be offered as an idle/dead clean candidate (PRD §13) — exclude it up front so
  // `clean --idle`/interactive never lists it.
  const records = allRecords.filter((r) => r.status !== "archived");
  const probe = await liveTargetsAcrossNodes(nodes);
  // A record whose node is no longer registered was never probed; treat it as
  // unreachable (not dead) so clean paths refuse to sweep a possibly-live bee.
  const knownNodes = new Set(nodes.map((node) => node.name));
  const unreachableNodes = new Set(probe.unreachableNodes);
  for (const record of records) {
    const nodeName = record.node ?? LOCAL_NODE_NAME;
    if (!knownNodes.has(nodeName)) unreachableNodes.add(nodeName);
  }
  const panes = await capturePanesFor(records, probe.liveTargets);
  const seals = await listSealedBeeNames();
  const livePanes = await localSubstrate().listPanes().catch(() => new Set<string>());
  const context: StateContext = {
    liveTargets: probe.liveTargets,
    livePanes,
    panes,
    seals,
    unreachableNodes,
    now: Date.now(),
  };
  const candidates = records.map((record) => cleanCandidateFor(record, records, deriveState(record, context), probe.liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)), context.now!));
  candidates.sort(compareCleanCandidates);
  return { records, candidates };
}

function cleanCandidateFor(record: SessionRecord, records: SessionRecord[], derived: DerivedState, live: boolean, now: number): CleanCandidate {
  const disabledReason = cleanDisabledReason(derived.state);
  const mode: CleanMode = disabledReason ? "disabled" : live ? "kill" : "delete";
  const ageSource = cleanCandidateAgeSource(record, derived.state);
  const ageTs = Date.parse(ageSource);
  const ageMs = Number.isFinite(ageTs) ? Math.max(0, now - ageTs) : 0;
  return {
    record,
    mode,
    ageMs,
    name: record.name,
    ref: highlightUniqueSessionReference(records, record),
    agent: record.agent,
    state: derived.state,
    detail: derived.detail,
    age: cleanCandidateAge(record, derived.state, now),
    cwd: record.cwd,
    ...(disabledReason ? { disabledReason } : {}),
  };
}

function cleanDisabledReason(state: BeeState): string | undefined {
  switch (state) {
    case "active":
      return "active";
    case "booting":
      return "booting";
    case "node_unreachable":
      return "offline";
    default:
      return undefined;
  }
}

function cleanCandidateAge(record: SessionRecord, state: BeeState, now: number): string {
  return formatRelativeTime(cleanCandidateAgeSource(record, state), now);
}

function cleanCandidateAgeSource(record: SessionRecord, state: BeeState): string {
  if (state === "idle_with_output") return idleAgeSource(record);
  if (isTerminalState(state)) return record.updatedAt;
  return record.createdAt;
}

function cleanTuiItem(candidate: CleanCandidate): CleanTuiItem {
  const { name, ref, agent, state, detail, age, cwd, disabledReason } = candidate;
  return { name, ref, agent, state, detail, age, cwd, ...(disabledReason ? { disabledReason } : {}) };
}

function printIdleDryRun(idle: CleanCandidate[]) {
  if (!isPretty()) {
    for (const candidate of idle) {
      const record = candidate.record;
      console.log(`idle\t${record.id ?? record.name}\t${record.name}\t${record.agent}\t${idleSessionAge(record)}\t${record.cwd}`);
    }
    return;
  }
  console.log(formatTable(
    [
      { header: "REF" },
      { header: "NAME" },
      { header: "BEE" },
      { header: "IDLE", align: "right" },
      { header: "CWD" },
      { header: "LAST PROMPT" },
    ],
    idle.map((candidate) => {
      const record = candidate.record;
      return [
        truncate(candidate.ref, 16),
        truncate(record.name, 22),
        truncate(record.agent, 12),
        dim(idleSessionAge(record)),
        dim(truncate(tildify(record.cwd), Math.max(20, Math.min(50, (process.stdout.columns ?? 100) - 86)))),
        dim(truncate(record.lastPrompt?.split("\n")[0] ?? "", Math.max(20, Math.min(60, (process.stdout.columns ?? 100) - 90)))),
      ];
    }),
  ));
  console.error(note("dry run; remove these with: hive clean --idle"));
}

async function cleanCandidates(candidates: CleanCandidate[]): Promise<void> {
  let failed = 0;
  for (const candidate of candidates) {
    if (candidate.mode === "disabled") continue;
    const outcome = await cleanCandidate(candidate);
    if (!outcome.ok) {
      failed += 1;
      if (isPretty()) {
        console.log(actionLine("warn", "clean", [bold(candidate.record.name), dim(outcome.detail)]));
        console.error(note(`bee may still be running; retry: hive kill ${candidate.record.name}`));
      } else {
        console.log(`clean_failed\t${candidate.record.name}\t${outcome.detail}`);
      }
      continue;
    }
    printCleanSuccess(candidate.record, outcome.detail);
  }
  if (failed > 0) process.exitCode = 1;
}

async function cleanCandidatesForTui(candidates: CleanCandidate[]): Promise<CleanTuiCleanOutcome[]> {
  const outcomes: CleanTuiCleanOutcome[] = [];
  for (const candidate of candidates) {
    try {
      outcomes.push(await cleanCandidate(candidate));
    } catch (error) {
      outcomes.push({
        name: candidate.record.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

async function cleanCandidate(candidate: CleanCandidate): Promise<CleanTuiCleanOutcome> {
  const record = candidate.record;
  if (candidate.mode === "delete") {
    await deleteSession(record.name);
    return { name: record.name, ok: true, detail: "removed stale" };
  }
  const outcome = await transactionalKill(record);
  if (!outcome.ok) return { name: record.name, ok: false, detail: outcome.lastError };
  return { name: record.name, ok: true, detail: outcome.alreadyGone ? "gone" : "killed" };
}

function printCleanSuccess(record: SessionRecord, detail: string) {
  if (isPretty()) console.log(actionLine("ok", "clean", [bold(record.name), record.agent, dim(detail), dim(tildify(record.cwd))]));
  else console.log(`cleaned\t${record.name}`);
}

function compareCleanCandidates(a: CleanCandidate, b: CleanCandidate): number {
  const age = b.ageMs - a.ageMs;
  if (age !== 0) return age;
  const priority = cleanStatePriority(a.state) - cleanStatePriority(b.state);
  if (priority !== 0) return priority;
  return a.record.name.localeCompare(b.record.name);
}

function cleanStatePriority(state: BeeState): number {
  switch (state) {
    case "idle_with_output":
      return 0;
    case "dead":
      return 1;
    case "archived":
      return 1;
    case "sealed":
      return 2;
    case "kill_failed":
      return 3;
    case "ready":
      return 4;
    case "blocked":
      return 5;
    case "error":
      return 6;
    case "booting":
      return 7;
    case "active":
      return 8;
    case "node_unreachable":
      return 9;
  }
}

async function cmdTranscript(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive transcript <session> [-n rows] [--json]");
  let record = await resolveSession(target);
  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record));
  if (!tx) throw new Error(`No transcript provider/file found for ${record.agent} session ${record.name}`);
  record = await persistSessionTranscriptMetadata(record, tx);
  const limitRaw = flag(parsed, "n") ?? flag(parsed, "limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const json = truthy(flag(parsed, "json"));
  console.error(transcriptBanner(tx.provider, tx.path));
  console.log(renderTranscript(tx.rows, { limit: Number.isFinite(limit) ? limit : undefined, json }));
}

async function cmdLast(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive last <session> [--seal]");
  let record = await resolveSession(target);

  if (truthy(flag(parsed, "seal"))) {
    const seal = await loadLatestSeal(record.name);
    if (!seal) throw new Error(`No seal recorded for ${record.name}`);
    console.log(JSON.stringify(seal, null, 2));
    return;
  }

  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record));
  if (!tx && !hasTranscriptProvider(record.agent)) {
    await ensureLive(record);
    console.error(isPretty() ? note(`no transcript provider for ${record.agent}; falling back to pane capture`) : `# no transcript provider for ${record.agent}; falling back to pane capture`);
    console.log(await substrateFor(record).capture(record.tmuxTarget, numberFlag(parsed, ["n", "lines"], 120), record.agentPaneId));
    return;
  }
  if (!tx) throw new Error(`No transcript provider/file found for ${record.agent} session ${record.name}`);
  record = await persistSessionTranscriptMetadata(record, tx);
  const text = lastAssistantText(tx.rows);
  if (!text) throw new Error(`No assistant text found in transcript: ${tx.path}`);
  console.error(transcriptBanner(tx.provider, tx.path));
  console.log(text);
}

async function cmdWait(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive wait <session> [--idle-ms 3000] [--timeout-ms 600000] [--last|--transcript|--seal]");
  const record = await resolveSession(target);

  if (truthy(flag(parsed, "seal"))) {
    return waitForSeal(record, parsed);
  }

  await ensureLive(record);
  const outcome = await waitForIdle({
    record,
    idleMs: numberFlag(parsed, ["idle-ms", "idle"], 3_000),
    timeoutMs: numberFlag(parsed, ["timeout-ms", "timeout"], 600_000),
    pollMs: numberFlag(parsed, ["poll-ms", "poll"], 750),
    output: truthy(flag(parsed, "last")) ? "last" : truthy(flag(parsed, "transcript")) ? "transcript" : "pane",
    rows: numberFlag(parsed, ["n", "limit"], 0),
    json: truthy(flag(parsed, "json")),
  });
  // A blocked bee did not finish its turn; exit non-zero so `hive wait && hive kill`
  // chains do not kill a bee that is stalled on an approval prompt.
  if (outcome.state === "blocked") process.exitCode = 1;
}

async function waitForSeal(record: SessionRecord, parsed: Parsed): Promise<void> {
  const timeoutMs = numberFlag(parsed, ["timeout-ms", "timeout"], 600_000);
  const pollMs = numberFlag(parsed, ["poll-ms", "poll"], 1_000);
  const baseline = (await listSeals(record.name))[0]?.sealedAt;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const latest = await loadLatestSeal(record.name);
    if (latest && latest.sealedAt !== baseline) {
      console.log(JSON.stringify(latest, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, pollMs)));
  }
  throw new Error(`Timed out waiting for seal on ${record.name} after ${timeoutMs}ms`);
}

async function cmdKill(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive kill <session> [--comb]");
  const record = await resolveSession(target);
  const forceComb = truthy(flag(parsed, "comb"));

  // Comb-aware kill: a pane-pinned bee that shares its comb (tmuxTarget) with at
  // least one live sibling is dropped with killPane — its siblings keep running.
  // --comb (or a sole/last bee in the comb) takes the whole session via the
  // existing transactional path. Killing a sub-bee MUST NEVER kill a sibling.
  if (!forceComb && record.agentPaneId) {
    const all = await listSessions();
    const siblings = all.filter(
      (other) =>
        other.name !== record.name &&
        other.tmuxTarget === record.tmuxTarget &&
        (other.node ?? LOCAL_NODE_NAME) === (record.node ?? LOCAL_NODE_NAME) &&
        other.agentPaneId, // only pane-pinned siblings would survive a pane kill
    );
    if (siblings.length > 0) {
      await killSubBeePane(record);
      return;
    }
  }

  const outcome = await transactionalKill(record);
  if (!outcome.ok) {
    if (isPretty()) {
      console.log(actionLine("warn", "kill_failed", [bold(record.name), dim(outcome.lastError)]));
      console.error(note(`bee may still be running; retry: hive kill ${record.name}`));
    } else {
      console.log(`kill_failed\t${record.name}\t${outcome.lastError}`);
    }
    process.exitCode = 1;
    return;
  }
  if (isPretty()) {
    console.log(actionLine(outcome.alreadyGone ? "warn" : "ok", outcome.alreadyGone ? "gone" : "kill", [bold(record.name)]));
  } else {
    console.log(`${outcome.alreadyGone ? "gone" : "killed"}\t${record.name}`);
  }
}

/**
 * Drop one sub-bee by killing only its pane (not the comb). On a clean kill the
 * record is deleted and a `bee.kill_pane` ledger event is emitted; on failure
 * the record is marked kill_failed (mirroring transactionalKill's discipline).
 */
async function killSubBeePane(record: SessionRecord): Promise<void> {
  const substrate = substrateFor(record);
  const result = await substrate.killPane(record.agentPaneId!, { launcherPgid: record.launcherPgid }).catch((error) => ({
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (!result.ok) {
    const lastError = result.stderr.trim() || `kill-pane exited with code ${result.exitCode}`;
    await updateSession(record.name, { status: "kill_failed", lastError, updatedAt: new Date().toISOString() });
    if (isPretty()) {
      console.log(actionLine("warn", "kill_failed", [bold(record.name), dim(lastError)]));
      console.error(note(`bee may still be running; retry: hive kill ${record.name}`));
    } else {
      console.log(`kill_failed\t${record.name}\t${lastError}`);
    }
    process.exitCode = 1;
    return;
  }
  await deleteSession(record.name);
  await appendLedger({
    type: "bee.kill_pane",
    session: record.name,
    node: record.node ?? LOCAL_NODE_NAME,
    parentId: record.parentId,
    combId: record.combId ?? record.tmuxTarget,
    agentPaneId: record.agentPaneId,
  });
  if (isPretty()) {
    console.log(actionLine("ok", "kill", [bold(record.name), dim("pane removed")]));
  } else {
    console.log(`killed\t${record.name}\tpane removed`);
  }
}

/**
 * Resolve the bee owning the current tmux pane:
 *   1. $TMUX_PANE → match a record by agentPaneId (the precise, pane-pinned path)
 *   2. fallback: tmux display-message → the bee whose tmuxTarget is this session
 *      (solo combs / legacy bees that were never pinned)
 * Returns undefined when not inside tmux or no record matches.
 */
async function resolveBeeInCurrentPane(): Promise<SessionRecord | undefined> {
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

/** The session name of the current pane, via `tmux display-message`. */
async function currentTmuxSessionName(): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined;
  const result = await tmux(["display-message", "-p", "#{session_name}"], { reject: false });
  if (result.ok) {
    const name = result.stdout.trim();
    return name.length > 0 ? name : undefined;
  }
  return undefined;
}

async function cmdHere(parsed: Parsed): Promise<void> {
  // Pane-less HSR bees resolve via HIVE_BEE (APIA-82); only error when neither
  // a tmux pane nor a HIVE_BEE stamp is available.
  if (!process.env.TMUX && !process.env.HIVE_BEE) throw new Error("hive here: not inside tmux or an HSR bee");
  const bee = await resolveBeeInCurrentPane();
  if (!bee) throw new Error("hive here: no matching bee for the current pane/session");

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({
      id: bee.id ?? bee.name,
      name: bee.name,
      agent: bee.agent,
      cwd: bee.cwd,
      combId: bee.combId ?? bee.tmuxTarget,
      parentId: bee.parentId ?? null,
      agentPaneId: bee.agentPaneId ?? null,
    }, null, 2));
    return;
  }
  if (truthy(flag(parsed, "id"))) {
    console.log(bee.id ?? bee.name);
    return;
  }
  if (isPretty()) console.log(actionLine("ok", "here", [bold(bee.name), bee.agent, dim(tildify(bee.cwd))]));
  else console.log(`here\t${bee.name}\t${bee.agent}\t${bee.cwd}`);
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
function defaultSubstrateIsSshTmux(): boolean {
  const overlay = loadNodeSync(LOCAL_NODE_NAME);
  return overlay?.kind === "ssh-tmux";
}

function assertLocalFleetReadable(verb: string): void {
  if (defaultSubstrateIsSshTmux()) {
    // dim stderr + non-zero so a popup's `xargs -r` no-ops and the popup closes.
    throw new Error(
      `hive ${verb}: refusing to run under an ssh-tmux default substrate — ` +
        `pickers read the LOCAL store and would target the wrong fleet (§13).`,
    );
  }
}

// hive spawn-picker [--frame | --flow] [--here]
// A PURE stdout list verb: prints candidate names one-per-line and does NOTHING
// else (no spawn/switch/store-write). The action lives in the binding (§8.2).
async function cmdSpawnPicker(parsed: Parsed): Promise<void> {
  assertLocalFleetReadable("spawn-picker");
  // --here is a passthrough hint for the binding (it appends `--here` to the
  // spawn action unconditionally); it does NOT change the printed candidate set.
  // hasFlag (presence) not truthy(flag): `flow` is not a BOOLEAN_FLAG (it takes a
  // value on `spawn`), so a stray `--flow <x>` would otherwise parse the value and
  // mis-route; presence is the correct boolean intent for the picker.
  const useFlow = hasFlag(parsed, "flow");
  const names = useFlow
    ? (await listFlows()).map((flow) => flow.name)
    : (await listFrames()).map((frame) => frame.name);
  // The selectable machine token is the first whitespace/TAB field. Frame/flow
  // names have no spaces, so a bare name per line is the token. Empty candidate
  // set → exit 0 with empty stdout so the binding's `xargs -r` no-ops.
  for (const name of names) console.log(name);
}

// hive urls [<bee>] [--lines <n>] [--open] [--json]
// Lists website URLs printed in a bee's pane. Side-effect-free unless --open.
async function cmdUrls(parsed: Parsed): Promise<void> {
  const selector = parsed.args[0];
  let record: SessionRecord | undefined;
  if (selector) {
    // Explicit selector → grab from another bee. These read the LOCAL store, so
    // they must hard-error under an ssh-tmux default substrate (§13).
    assertLocalFleetReadable("urls");
    const resolved = await resolveSelector(selector);
    if (resolved.kind !== "bee") {
      throw new Error(`hive urls: ${selector} selects multiple bees; pass a single bee`);
    }
    record = resolved.record;
  } else {
    if (!process.env.TMUX && !process.env.HIVE_BEE) throw new Error("hive urls: not inside tmux/an HSR bee and no bee selector given");
    record = await resolveBeeInCurrentPane();
    if (!record) throw new Error("hive urls: no matching bee for the current pane/session");
  }

  const lines = numberFlag(parsed, ["lines"], 2000);
  const text = await substrateFor(record).capture(record.tmuxTarget, lines, record.agentPaneId);
  const urls = extractUrls(text);

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(urls));
    return;
  }
  if (urls.length === 0) {
    // dim stderr note so the popup closes cleanly; exit 0 (no URLs is not an error).
    console.error(dim("no URLs"));
    return;
  }
  if (truthy(flag(parsed, "open"))) {
    await openUrl(urls[0]!);
    return;
  }
  for (const url of urls) console.log(url);
}

/** Open a URL via the platform opener (open on darwin, xdg-open on linux). */
async function openUrl(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolveOpen, rejectOpen) => {
    execFile(opener, [url], (error) => (error ? rejectOpen(error) : resolveOpen()));
  });
}

// hive keys print [--tmux | --wezterm] | path | check [--against-recommended]
async function cmdKeys(parsed: Parsed): Promise<void> {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "print":
      return keysPrint(parsed);
    case "path":
      return keysPath();
    case "check":
      return keysCheck(parsed);
    case "doctor":
      // OPTIONAL Phase 2 — the runtime popup-env probe. Not yet implemented.
      throw new Error("hive keys doctor: not yet implemented (Phase 2). Use `hive keys check` for static checks.");
    default:
      throw new Error(`Unknown keys subcommand: ${sub}\nUsage: hive keys <print|path|check>`);
  }
}

function keysPrint(parsed: Parsed): void {
  // `--tmux` (default) prints the recommended tmux block VERBATIM (the same
  // source-of-truth string written to docs/honeybee.tmux.conf). `--wezterm`
  // prints the cmd→Meta additions.
  if (truthy(flag(parsed, "wezterm"))) {
    process.stdout.write(CANONICAL_WEZTERM_BLOCK);
    return;
  }
  process.stdout.write(CANONICAL_TMUX_CONF);
}

/**
 * The absolute path of the shipped docs/honeybee.tmux.conf, resolved relative to
 * this module (which lives at dist/cli.js when packaged, src/cli.ts under tsx).
 * Both are exactly one directory below the repo root, so `..` from the module dir
 * reaches the root and `docs/honeybee.tmux.conf` from there is the artifact.
 *
 * Path-stability caveat (KEYBINDINGS_PRD §16 Q2): this resolves relative to the
 * install location, so it is brittle across reinstall/relocation. The robust
 * `source-file` recipe is `source-file "$(hive keys path)"`, re-evaluated by the
 * shell; a bare paste (`hive keys print --tmux >> ~/.tmux.conf`) goes stale
 * silently. `hive keys check` audits presence either way.
 */
function keybindingsConfPath(): string {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  return resolve(moduleDir, "..", "docs", "honeybee.tmux.conf");
}

function keysPath(): void {
  console.log(keybindingsConfPath());
}

async function keysCheck(parsed: Parsed): Promise<void> {
  // PURE READ. Reports recommended binds present/absent, flags tmux-layer
  // collisions, and runs the static PATH/substrate checks.
  //
  // LIMITATION (KEYBINDINGS_PRD §6/§13): `check` reads `tmux list-keys`, so it is
  // STRUCTURALLY BLIND to the WezTerm ALT/cmd layer in ~/.wezterm.lua — that must
  // be eyeballed. The collision report below is necessary but not sufficient.
  const pretty = isPretty();
  let hardFailures = 0;
  let warnings = 0;

  // The live root-table key bindings, as a key → command map.
  const liveBinds = await liveTmuxRootBinds();

  // Per-recommended-bind: present / absent / collision (bound to something else).
  for (const bind of RECOMMENDED_BINDS) {
    const live = liveBinds.get(bind.key);
    const wired = live !== undefined && live.includes(`hive ${bind.verb}`);
    const collision = live !== undefined && !wired;
    if (wired) {
      if (pretty) console.log(actionLine("ok", "keys", [bold(bind.key), dim(`→ hive ${bind.verb}`), dim(bind.note)]));
      else console.log(`bind\tpresent\t${bind.key}\t${bind.verb}`);
    } else if (collision) {
      warnings += 1;
      if (pretty) console.log(actionLine("warn", "keys", [bold(bind.key), yellow("collision"), dim(truncate(live!, 50))]));
      else console.log(`bind\tcollision\t${bind.key}\t${live!.replace(/\s+/g, " ").trim()}`);
    } else {
      // Absent. A delegated bind whose verb may not be shipped yet is only a
      // note; a non-delegated recommended bind absent is also just informational
      // (the operator may not have pasted the block) — not a hard failure.
      if (pretty) console.log(actionLine("info", "keys", [bold(bind.key), dim("absent"), dim(bind.delegated ? "(delegated)" : "")]));
      else console.log(`bind\tabsent\t${bind.key}\t${bind.delegated ? "delegated" : ""}`);
    }
  }

  // --against-recommended: report live binds on our recommended keys that differ
  // from the shipped set (drift after a stale paste + hive upgrade).
  if (truthy(flag(parsed, "against-recommended"))) {
    for (const bind of RECOMMENDED_BINDS) {
      const live = liveBinds.get(bind.key);
      if (live !== undefined && !live.includes(`hive ${bind.verb}`)) {
        if (pretty) console.log(actionLine("warn", "drift", [bold(bind.key), dim(truncate(live, 60))]));
        else console.log(`drift\t${bind.key}\t${live.replace(/\s+/g, " ").trim()}`);
        warnings += 1;
      }
    }
  }

  // Static checks: fzf, a browser opener, the substrate, and `hive` reachability.
  const fzf = await binaryOnPath("fzf");
  reportCheck(pretty, fzf, "fzf on PATH", "fzf missing — popups can't filter candidates");
  if (!fzf) warnings += 1;

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const openerOk = await binaryOnPath(opener);
  reportCheck(pretty, openerOk, `${opener} on PATH`, `${opener} missing — \`hive urls\` --open / the M-u binding can't open a browser`);
  if (!openerOk) warnings += 1;

  // Substrate: warn under ssh-tmux (the pickers/affordances target the wrong fleet, §13).
  const ssh = defaultSubstrateIsSshTmux();
  if (ssh) {
    warnings += 1;
    if (pretty) console.log(actionLine("warn", "check", [yellow("substrate is ssh-tmux"), dim("pickers/affordances read the LOCAL store (§13)")]));
    else console.log(`check\tsubstrate\tssh-tmux`);
  } else {
    if (pretty) console.log(actionLine("ok", "check", [dim("substrate is local-tmux")]));
    else console.log(`check\tsubstrate\tlocal-tmux`);
  }

  // `hive` itself reachable (recommended verbs are unreachable otherwise → HARD fail).
  const hiveOk = await binaryOnPath("hive");
  if (!hiveOk) {
    hardFailures += 1;
    if (pretty) console.log(actionLine("err", "check", [red("hive not on PATH"), dim("bindings invoke `hive` inside popups — they will all fail")]));
    else console.log(`check\thive\tunreachable`);
  } else {
    if (pretty) console.log(actionLine("ok", "check", [dim("hive on PATH")]));
    else console.log(`check\thive\treachable`);
  }

  // The list-keys blind-spot, surfaced every run so it is never forgotten.
  if (pretty) console.log(note("check covers the tmux layer only; the WezTerm ALT/cmd layer (~/.wezterm.lua) is list-keys-invisible and must be eyeballed (§6)."));
  else console.log(`check\tlimitation\twezterm-alt-cmd-layer-not-checked`);

  if (hardFailures > 0) process.exitCode = 1;
  else if (warnings > 0 && pretty) console.log(dim(`${warnings} warning(s) — see above`));
}

/** Live root-table (no-prefix) bindings: tmux key spec → bound command string. */
async function liveTmuxRootBinds(): Promise<Map<string, string>> {
  const binds = new Map<string, string>();
  // `-T root` is the no-prefix table where `bind -n` binds land.
  const result = await tmux(["list-keys", "-T", "root"], { reject: false });
  if (!result.ok) return binds;
  for (const line of result.stdout.split("\n")) {
    // Format: `bind-key -T root M-b <command...>`. Find the table+key, take the rest.
    const match = line.match(/^bind-key\s+(?:-r\s+)?-T\s+root\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const command = match[2]!.trim();
    binds.set(key, command);
  }
  return binds;
}

function reportCheck(pretty: boolean, ok: boolean, label: string, failHint: string): void {
  if (ok) {
    if (pretty) console.log(actionLine("ok", "check", [dim(label)]));
    else console.log(`check\tok\t${label}`);
  } else {
    if (pretty) console.log(actionLine("warn", "check", [yellow(label), dim(failHint)]));
    else console.log(`check\twarn\t${label}`);
  }
}

/** Whether `name` resolves on PATH (via the platform `which`/`command -v`). */
async function binaryOnPath(name: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise<boolean>((resolveCheck) => {
    const probe = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [name] : ["-v", name];
    // `command -v` needs a shell; `which` is also fine but less portable.
    if (process.platform === "win32") {
      execFile(probe, args, (error) => resolveCheck(!error));
    } else {
      execFile("sh", ["-c", `command -v ${JSON.stringify(name)}`], (error) => resolveCheck(!error));
    }
  });
}

async function cmdSplit(parsed: Parsed): Promise<SessionRecord> {
  // hive split [<bee>] [<agent>] [--brief <text>] [--dir v|h|window] [--cwd <dir>] [--home <h>]
  // No <bee> (or --here) → split the current bee's comb (via hive here resolution).
  //
  // The first positional is ambiguous: it can be a parent bee selector OR (when
  // run from inside a bee, e.g. `hive split codex`) the sub-bee's agent. We
  // disambiguate by trying to resolve it as an existing session; if that fails
  // we treat it as the agent and split the current bee's comb.
  const useHere = truthy(flag(parsed, "here"));
  const pos0 = parsed.args[0] && !parsed.args[0]!.startsWith("-") ? parsed.args[0]! : undefined;
  const pos1 = parsed.args[1] && !parsed.args[1]!.startsWith("-") ? parsed.args[1]! : undefined;

  let parent: SessionRecord | undefined;
  let agentArg: string | undefined;
  if (useHere || pos0 === undefined) {
    // Current-pane parent; pos0 (if any) is the agent.
    parent = await resolveBeeInCurrentPane();
    agentArg = pos0;
  } else {
    // pos0 is a bee selector if it resolves to a session, else it's the agent.
    parent = await resolveSession(pos0).catch(() => undefined);
    if (parent) {
      agentArg = pos1;
    } else {
      parent = await resolveBeeInCurrentPane();
      agentArg = pos0;
    }
  }
  if (!parent) {
    throw new Error(
      "hive split: no parent bee specified and not inside a bee pane. " +
        "Usage: hive split [<bee>] [<agent>] [--brief <text>] [--dir v|h|window] [--cwd <dir>] [--home <h>]",
    );
  }

  const substrate = substrateFor(parent);
  if (!(await substrate.hasSession(parent.tmuxTarget))) {
    throw new Error(`hive split: parent bee ${parent.name} is not running`);
  }

  const requestedAgent = agentArg ?? parent.agent;
  const { agent, account } = await resolveSpawnAgentWithAuto(requestedAgent, parsed);

  const dirRaw = typeof flag(parsed, "dir") === "string" ? String(flag(parsed, "dir")) : "v";
  if (!["h", "v", "window"].includes(dirRaw)) throw new Error(`hive split: invalid --dir ${dirRaw} (use v|h|window)`);
  const dir = dirRaw as "h" | "v" | "window";

  const cwd = typeof flag(parsed, "cwd") === "string"
    ? await resolveSpawnCwd(parsed)
    : parent.cwd;
  const homeFlag = flag(parsed, "home") ?? flag(parsed, "profile");
  const home = account ? (typeof homeFlag === "string" ? homeFlag : defaultHomeForAccount(account)) : homeFlag;
  const yolo = dangerousMode(parsed, agent, requestedAgent);
  const spec = resolveAgent(agent, parsed.rest, {
    home,
    yolo,
    identity: Boolean(account),
    ...(account?.model ? { model: account.model } : {}),
    ...(account?.provider ? { provider: account.provider } : {}),
  });
  if (account) {
    if (parent.node) throw new Error("--account splits are local-only (the vault never leaves this machine)");
    if (!spec.homePath) throw new Error(`Agent ${spec.kind} has no home env; cannot bind account ${account.id}`);
    await activateAccountIntoHome(account, spec.homePath, { onWarn: (message) => console.error(note(message)) });
  }
  if (!(parent.node)) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, account?.id);
  }

  const launch = await substrate.newPane(parent.tmuxTarget, cwd, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    tmuxOptions: spec.tmuxOptions,
  }, { dir });

  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  const name = safeName(identity.id);
  const now = new Date().toISOString();
  const combId = parent.combId ?? parent.tmuxTarget;
  const record: SessionRecord = {
    name,
    agent: spec.kind,
    cwd,
    command: shellCommand(spec),
    tmuxTarget: parent.tmuxTarget, // shared comb
    agentPaneId: launch.paneId,    // own pane
    ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
    combId,
    parentId: parent.id ?? parent.name,
    createdAt: now,
    updatedAt: now,
    status: "running",
    id: identity.id,
    prefix: identity.prefix,
    uuid: identity.uuid,
    requestedAgent: spec.requestedKind,
    ...(spec.homePath ? { homePath: spec.homePath } : {}),
    ...(account ? { accountId: account.id } : {}),
    ...(parent.colony ? { colony: parent.colony } : {}),
    ...(parent.node ? { node: parent.node } : {}),
  };
  await saveSession(record);
  await writeSpawnOptions(record);
  await appendLedger({ type: "bee.split", name: record.name, parentId: record.parentId, combId, agentPaneId: launch.paneId });

  if (isPretty()) console.log(actionLine("ok", "split", [bold(record.name), record.agent, dim(`from ${parent.name}`)]));
  else console.log(`split\t${record.name}\t${record.agent}\t${parent.name}`);

  const briefText = typeof flag(parsed, "brief") === "string" ? String(flag(parsed, "brief")) : undefined;
  if (briefText) return deliverBrief(parsed, record, briefText);
  await confirmSpawnReady(parsed, record);
  return record;
}

const FORK_SEED_MODES = new Set<SeedMode>(["resume", "seal", "summary", "log", "none"]);

/**
 * Account-safety gate for `hive fork` (fork-and-pane §7.1, the crux). Two live
 * processes must never share one account: Anthropic rotates OAuth refresh
 * tokens per-account, so two live bees on one account (even in separate homes)
 * log each other out. Returns the account (if any) the fork should use — for an
 * account-bound parent the fork's account is NEVER === source.accountId (which
 * also guarantees its defaultHomeForAccount home differs from the parent's).
 */
async function resolveForkAccountSafety(
  parsed: Parsed,
  source: SessionRecord,
  context: { targetTool: string; requestedSeed?: SeedMode },
): Promise<{ account?: AccountRecord }> {
  const accountQuery = stringFlag(parsed, ["account"]);
  const wantsResume = context.requestedSeed === "resume";

  if (accountQuery) {
    const account = await resolveAccountFlag(accountQuery, context.targetTool, ttlFlagMs(parsed));
    // The fork's account must DIFFER from a live account-bound parent's. The
    // OAuth refresh token rotates per-ACCOUNT (not per-home), so two live bees
    // on one account log each other out even in separate homes — and when the
    // account's home IS the parent's (the common `defaultHomeForAccount`
    // layout), this also reuses the parent's exact live home. `--account auto`
    // can silently land on the parent's own account, so this guard covers it too.
    if (source.accountId && account.id === source.accountId) {
      throw new Error(
        `fork would run on ${source.name}'s own account (${account.id}); two live bees on one ` +
          `account rotate the shared OAuth chain and log each other out. Pass a different ` +
          `--account (fork-and-pane §7.1).`,
      );
    }
    // The (different) account brings its own dedicated home
    // (defaultHomeForAccount), so the fork never touches the parent's home.
    // Native resume needs the parent's provider session, which lives in the
    // parent's home — a different account/home can't see it.
    if (wantsResume) {
      throw new Error(
        `--seed resume needs ${source.name}'s home to see its provider session; ` +
          `account ${account.id} has its own home — fork with a seal instead`,
      );
    }
    return { account };
  }

  if (source.accountId) {
    // Account-bound parent with no --account: refuse. A fork must get its own
    // account/home; sharing the parent's live home rotates the OAuth chain and
    // logs both bees out.
    throw new Error(
      `${source.name} is account-bound (${source.accountId}); a fork must get its own account — ` +
        `pass --account <a> (or --account auto). Sharing a live home rotates the OAuth chain and ` +
        `logs both bees out (fork-and-pane §7.1).`,
    );
  }

  // Default-home parent (no accountId): allow a plain spawn (own fresh tmux
  // session in the default home — same risk profile as a second default bee).
  if (wantsResume) {
    console.error(
      note(
        `warn: --seed resume reuses ${source.name}'s provider session in a shared home; ` +
          `the two processes may fight over the OAuth chain. Prefer --seed seal, or --account.`,
      ),
    );
  }
  return {};
}

/**
 * hive fork <bee> [checkpoint]
 *   [--agent <kind>] [--model <m>] [--node <n>] [--cwd <dir>]
 *   [--seed resume|seal|summary|log|none] [--read-log]
 *   [--name <n>] [--account <a>] [--here] [--print]
 *
 * Branch an existing bee into a FRESH comb (its own session) seeded from the
 * source's state. fork-and-pane Phase C: layered seeding (resume → seal →
 * summary(deferred) → log → refuse), cross-harness forcing non-resume, account
 * safety, and anti-cross-match. See docs/fork-and-pane.md §7.1.
 */
async function cmdFork(parsed: Parsed): Promise<SessionRecord> {
  const selector = parsed.args[0];
  if (!selector) {
    throw new Error(
      "Usage: hive fork <bee> [checkpoint] [--agent <kind>] [--model <m>] [--node <n>] " +
        "[--cwd <dir>] [--seed resume|seal|summary|log|none] [--read-log] [--name <n>] [--account <a>] [--here] [--print]",
    );
  }

  // 1. Resolve source (single bee only — never fork a set).
  const resolved = await resolveSelector(selector);
  if (resolved.kind !== "bee") {
    throw new Error(`hive fork: ${selector} matched multiple bees; pick one`);
  }
  const source = resolved.record;

  // 2. Resolve the checkpoint seal.
  const checkpointArg = parsed.args[1];
  const seal = await resolveForkCheckpoint(source.name, checkpointArg);

  // 3. Resolve fork agent / model / node / cwd.
  const requestedAgent = stringFlag(parsed, ["agent"]) ?? source.requestedAgent ?? source.agent;
  const targetTool = canonicalAgentKind(requestedAgent);
  const sourceTool = canonicalAgentKind(source.agent);
  const model = stringFlag(parsed, ["model"]);
  const cwd = hasFlag(parsed, "cwd") ? await resolveSpawnCwd(parsed) : source.cwd;

  // 4. Validate the --seed value (if any).
  const seedFlag = stringFlag(parsed, ["seed"]);
  if (seedFlag !== undefined && !FORK_SEED_MODES.has(seedFlag as SeedMode)) {
    throw new Error(`hive fork: invalid --seed ${seedFlag} (use resume|seal|summary|log|none)`);
  }
  const requestedSeed = seedFlag as SeedMode | undefined;
  const readLog = truthy(flag(parsed, "read-log"));

  // 5. Account safety (the crux). Yields the account whose dedicated home the
  //    fork will use; for a default-home parent it returns no account.
  const { account } = await resolveForkAccountSafety(parsed, source, { targetTool, requestedSeed });

  // 6. Pick the seed mode (pure decision).
  const seedInput: ForkSeedInput = {
    source,
    seal,
    requestedSeed,
    readLog,
    targetTool,
    sourceTool,
    forkName: source.name,
  };
  const decision = pickForkSeed(seedInput);
  if (decision.mode === "refuse") throw new Error(`hive fork: ${decision.reason}`);
  // Tell the operator when a bare `hive fork` fell back to a cold boot because the
  // source had nothing to seed from (vs an explicit `--seed none`).
  if (decision.mode === "none" && seedInput.requestedSeed === undefined) {
    console.error(note(`${source.name} had no session/seal/transcript to seed from — forking cold`));
  }

  // 7. Build the spawn spec and create the new comb. Resume args are baked into
  //    the spawn command (§7.1); seal/log/none seed via a brief after spawn.
  const modelArgs = modelArgsFor(targetTool, model);
  const resumeArgsList = decision.mode === "resume" ? decision.resumeArgs : [];
  const extraArgs = [...resumeArgsList, ...modelArgs, ...parsed.rest];

  const yolo = dangerousMode(parsed, targetTool, requestedAgent);
  const node = await resolveSpawnNode(parsed, targetTool);
  const isRemote = node.kind === "ssh-tmux";
  if (account && isRemote) throw new Error("--account forks are local-only (the vault never leaves this machine)");

  // The account brings its own dedicated home; otherwise the fork boots in the
  // default home (never the parent's exact home for an account-bound parent —
  // resolveForkAccountSafety already enforced that).
  const home = account ? defaultHomeForAccount(account) : undefined;
  const spec = resolveAgent(requestedAgent, extraArgs, { home, yolo, identity: Boolean(account) });
  if (account) {
    if (!spec.homePath) throw new Error(`Agent ${spec.kind} has no home env; cannot bind account ${account.id}`);
    await activateAccountIntoHome(account, spec.homePath, { onWarn: (message) => console.error(note(message)) });
  }
  if (!isRemote) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, account?.id);
  }

  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  const name = safeName(stringFlag(parsed, ["name"]) ?? identity.id);
  const tmuxTarget = safeTmuxTarget(name);
  const nodeName = node.name;
  const substrate = node.name !== LOCAL_NODE_NAME ? substrateForRecord(node) : localSubstrate();
  const locationHint = isRemote ? ` on ${node.name}` : "";
  if (await substrate.hasSession(tmuxTarget)) throw new Error(`tmux session already exists${locationHint}: ${tmuxTarget}`);

  const launch = await substrate.newSession(tmuxTarget, cwd, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    tmuxOptions: spec.tmuxOptions,
  });
  const command = shellCommand(spec);

  // 8. Build the record with fork lineage + anti-cross-match fields.
  //    ANTI-CROSS-MATCH (§7.1): lastPromptAt set at creation, and NO inherited
  //    providerSessionId / transcriptPath — the fork is a new session with no
  //    transcript of its own yet, so the daemon's scorer can never assign the
  //    parent's transcript to the fork.
  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    agent: spec.kind,
    cwd,
    command,
    tmuxTarget,
    ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
    ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
    combId: tmuxTarget, // fork is its own comb (new session)
    forkedFromId: source.id ?? source.name,
    forkedAt: now,
    seedMode: decision.mode,
    forkCheckpoint: decision.checkpoint,
    ...(model ? { model } : {}),
    createdAt: now,
    updatedAt: now,
    lastPromptAt: now, // anti-cross-match anchor
    status: "running",
    id: identity.id,
    prefix: identity.prefix,
    uuid: identity.uuid,
    requestedAgent: spec.requestedKind,
    homePath: spec.homePath,
    ...(account ? { accountId: account.id } : {}),
    ...(nodeName !== LOCAL_NODE_NAME ? { node: nodeName } : {}),
    ...(source.colony ? { colony: source.colony } : {}),
  };
  await saveSession(record);
  await writeSpawnOptions(record);

  // 9. Ledger.
  await appendLedger({
    type: "fork.create",
    name,
    forkedFromId: record.forkedFromId,
    seedMode: record.seedMode,
    forkCheckpoint: record.forkCheckpoint,
    ...(model ? { model } : {}),
    ...(nodeName !== LOCAL_NODE_NAME ? { node: nodeName } : {}),
  });

  // Print the success line. The trailing `command` field on the tab form makes
  // the resume-args / model-args assertion trivial in the non-TTY test harness.
  if (isPretty()) {
    console.log(actionLine("ok", "fork", [bold(name), spec.kind, dim(`from ${source.name}`), dim(decision.mode)]));
  } else {
    console.log(`fork\t${name}\t${spec.kind}\t${source.name}\t${decision.mode}\t${record.command}`);
  }

  // 10. Seed: resume/none carry the seed in the spawn command (or boot cold);
  //     seal/log deliver a brief once ready.
  let finalRecord = record;
  if (decision.mode === "seal" || decision.mode === "log") {
    finalRecord = await deliverBrief(parsed, record, decision.brief);
  } else {
    await confirmSpawnReady(parsed, record);
  }

  // 11. --print / --here behave like spawn's interactive affordances.
  if (truthy(flag(parsed, "print"))) {
    if (isPretty()) console.error(note("attach with:"));
    console.log(formatShellCommand(substrate.attachCommand(record.tmuxTarget)));
  }
  await maybeLinkHere(parsed, [finalRecord]);
  return finalRecord;
}

/**
 * Resolve the fork's checkpoint seal: absent/`latest` → the latest seal;
 * `seal:<ISO>` → that specific seal; `msg:N` → deferred.
 */
async function resolveForkCheckpoint(beeName: string, checkpointArg: string | undefined): Promise<import("./seal.js").SealRecord | null> {
  if (!checkpointArg || checkpointArg === "latest") return loadLatestSeal(beeName);
  if (checkpointArg.startsWith("msg:")) {
    throw new Error("hive fork: message-offset checkpoints are deferred (§9/§11); use a seal");
  }
  if (checkpointArg.startsWith("seal:")) {
    const wanted = checkpointArg.slice("seal:".length);
    const normalized = wanted.replace(/[:.]/g, "-");
    const seals = await listSeals(beeName);
    const match = seals.find((s) => s.sealedAt === wanted || s.sealedAt.replace(/[:.]/g, "-") === normalized);
    if (!match) throw new Error(`hive fork: no seal ${wanted} for ${beeName}`);
    return match;
  }
  throw new Error(`hive fork: unrecognized checkpoint "${checkpointArg}" (use latest or seal:<ISO>)`);
}

// ── hive fork launch — the interactive dialog (⌘K) ───────────────────────────

/**
 * `hive fork launch` — the interactive fork window (the ⌘K target). The SOURCE
 * is the bee owning the current pane, so the dialog opens straight on a form for
 * composing the fork (seed, agent, model, worktree isolation, account, name).
 * The chosen values are turned into a `hive fork` invocation and run through
 * cmdFork, so account-safety, anti-cross-match, the ledger, and --here linking
 * are all reused unchanged.
 */
async function cmdForkLaunch(parsed: Parsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive fork launch needs a TTY — bind it to a tmux popup: bind -n M-k display-popup -E "hive fork launch"');
  }
  const source = await resolveBeeInCurrentPane();
  if (!source) {
    throw new Error("hive fork launch: no bee owns the current pane — run it from inside a bee, or use `hive fork <bee>`.");
  }
  const sourceKind = canonicalAgentKind(source.agent);

  // Worktree isolation is offered only when the source lives inside a pro repo.
  const proRepo = await (async (): Promise<{ label: string; path: string } | null> => {
    try {
      const entry = resolveProEntryForCwd(await listProRepoEntries(), source.cwd);
      if (!entry) return null;
      const label = [entry.area, entry.project, entry.repo].filter((part) => part.length > 0).join("/") || entry.path;
      return { label, path: entry.path };
    } catch {
      return null;
    }
  })();

  // Account options. An account-bound source MUST fork onto a DIFFERENT account
  // (a shared OAuth chain rotates and logs both bees out), so its own account is
  // excluded and the "inherit" row withheld; a default-home source may inherit.
  const accountRequired = Boolean(source.accountId);
  const accounts = await newBeeAccountRows(sourceKind).catch(() => []);
  const accountOptions: ForkAccountOption[] = [];
  if (!accountRequired) accountOptions.push({ value: "", label: "inherit (no account binding)" });
  accountOptions.push({ value: "auto", label: "auto", detail: "least-loaded account" });
  for (const acct of accounts) {
    if (accountRequired && acct.id === source.accountId) continue;
    accountOptions.push({ value: acct.id, label: acct.label, ...(acct.usage ? { detail: acct.usage } : {}) });
  }

  const suggestSlot = toProSlug(`fork-${source.name}`) || toProSlug(sourceKind) || "fork";
  const defaults = defaultForkForm({ sourceAgent: sourceKind, accountRequired, accountOptions, suggestSlot });

  const result = await chooseFork({
    source: {
      name: source.name,
      id: source.id ?? source.name,
      agent: sourceKind,
      cwd: source.cwd,
      ...(source.accountId ? { accountId: source.accountId } : {}),
    },
    cwdLabel: tildify(source.cwd),
    agentKinds: agentKinds(),
    proRepo,
    accountRequired,
    accountOptions,
    defaults,
  });

  if (!result) {
    if (isPretty()) console.error(note("fork launch: cancelled"));
    return;
  }

  const intent = forkIntent(result.values, { sourceName: source.name, sourceAgent: sourceKind });

  // Create the worktree/checkout up front — its path becomes the fork's --cwd.
  let cwd: string | undefined;
  if (intent.isolation) {
    if (!proRepo) throw new Error("hive fork launch: not a pro repo — cannot create a worktree");
    const slug = toProSlug(intent.isolation.name);
    if (!slug) throw new Error("hive fork launch: worktree name must contain letters, digits, or dashes");
    if (isPretty()) console.error(note(`creating ${intent.isolation.kind} ${slug}…`));
    cwd = await createProSlot(intent.isolation.kind, proRepo.path, slug);
  }

  // Build a `hive fork` invocation and reuse cmdFork wholesale.
  const flags = new Map<string, string | true | string[]>();
  if (intent.seed) flags.set("seed", intent.seed);
  if (intent.agent) flags.set("agent", intent.agent);
  if (intent.model) flags.set("model", intent.model);
  if (intent.name) flags.set("name", intent.name);
  if (intent.account) flags.set("account", intent.account);
  if (cwd) flags.set("cwd", cwd);
  flags.set("here", true);

  const record = await cmdFork({ command: "fork", args: [source.name], flags, rest: [] });

  if (intent.message) {
    await cmdSend({ command: "send", args: [record.name, intent.message], flags: new Map(), rest: [] });
  }
}

/**
 * hive revive <bee> [--all] [--fresh]
 *
 * Bring a dead bee back: re-create its tmux session in the same cwd/home and
 * resume the same provider session (claude --resume / codex resume / opencode
 * --session) so it picks up where it left off. The record is reused in place —
 * same id, name, colony, account binding. This is the swap-account relaunch
 * recipe minus the account switch.
 *
 *   --all     revive every dead local bee that has a precise providerSessionId
 *   --fresh   start a new session instead of resuming the old transcript
 */
async function cmdRevive(parsed: Parsed): Promise<void> {
  if (truthy(flag(parsed, "all"))) {
    if (stringFlag(parsed, ["session"])) throw new Error("hive revive --all cannot take --session (one id can't apply to many bees)");
    const records = await listSessions();
    const local = records.filter((r) => !r.node || r.node === LOCAL_NODE_NAME);
    let revived = 0;
    let alive = 0;
    const skipped: string[] = [];
    for (const record of local) {
      if (await substrateFor(record).hasSession(record.tmuxTarget)) {
        alive += 1;
        continue;
      }
      // --all only auto-revives bees we can resume precisely; resuming "the
      // latest session in the home" would grab a sibling's when homes are shared.
      if (!record.providerSessionId && !truthy(flag(parsed, "fresh"))) {
        skipped.push(record.name);
        continue;
      }
      await reviveOne(record, parsed);
      revived += 1;
    }
    if (isPretty()) {
      const parts = [`revived ${revived}`, `${alive} already alive`];
      if (skipped.length > 0) parts.push(`${skipped.length} skipped (no resumable session id: ${skipped.join(", ")})`);
      console.log(note(parts.join(" · ")));
    } else {
      console.log(`revive\tall\t${revived}\t${alive}\t${skipped.length}`);
    }
    return;
  }

  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive revive <bee> [--all] [--fresh] [--session <id>]");
  const record = await resolveSession(target);
  await reviveOne(record, parsed);
}

/**
 * Pure relaunch core: re-create a bee's tmux session in its OWN cwd/home and
 * resume (or, with `fresh`, start anew) its provider session. No `parsed`, no
 * console output — it does only the resolveAgent/newSession/updateSession/
 * appendLedger work and returns the updated record. It does NOT guard liveness
 * (the caller does, so `restore` can decide per-bee whether to skip a live one).
 * Non-fresh revive requires an exact provider session id; falling back to a
 * provider's "latest" session can resume a sibling bee in a shared home.
 *
 * ACCOUNT SAFETY: this re-spawns into `record.homePath` with NO account switch
 * (no activateAccountIntoHome) — the same home whose creds are already there, so
 * there is no cross-account OAuth-logout hazard. `reviveOne`/`restore` both rely
 * on this invariant.
 */
async function reviveRecord(record: SessionRecord, opts: { fresh: boolean; sessionOverride?: string }): Promise<SessionRecord> {
  const substrate = substrateFor(record);
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  const fresh = opts.fresh;
  // sessionOverride resumes (and persists) a specific provider session — used to
  // recover bees whose providerSessionId was never recorded but whose session
  // still exists on disk (claude/codex keep sessions keyed by project dir).
  const sessionOverride = opts.sessionOverride;
  const providerSessionId = fresh ? undefined : (sessionOverride ?? record.providerSessionId);
  if (!fresh && !providerSessionId) {
    throw new Error(
      `hive revive: ${record.name} has no recorded provider session id; pass --session <id> to resume an exact session, or --fresh to start anew`,
    );
  }

  // Mirror the swap relaunch: rebuild the agent command from the configured
  // kind (preserving the original permission mode) and append the resume args.
  const spec = resolveAgent(record.requestedAgent ?? record.agent, fresh ? [] : resumeArgs(tool, providerSessionId), {
    home: record.homePath,
    yolo: sniffYolo(record.command),
    identity: true,
  });
  if (!record.node) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, record.accountId);
  }

  const launch = await substrate.newSession(record.tmuxTarget, record.cwd, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    tmuxOptions: spec.tmuxOptions,
  });

  const updated =
    (await updateSession(record.name, {
      status: "running",
      command: shellCommand(spec),
      combId: record.combId ?? record.tmuxTarget,
      ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
      ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
      ...(sessionOverride ? { providerSessionId: sessionOverride } : {}),
      updatedAt: new Date().toISOString(),
    })) ?? record;
  await writeSpawnOptions(updated);
  await appendLedger({
    type: "bee.revive",
    session: record.name,
    providerSessionId: providerSessionId ?? null,
    agentPaneId: launch.paneId,
    fresh,
  });
  return updated;
}

/** Relaunch one dead bee and resume (or, with --fresh, start anew) its session. */
async function reviveOne(record: SessionRecord, parsed: Parsed): Promise<SessionRecord> {
  const substrate = substrateFor(record);
  if (await substrate.hasSession(record.tmuxTarget)) {
    throw new Error(`hive revive: ${record.name} is already running (${record.tmuxTarget})`);
  }
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  const fresh = truthy(flag(parsed, "fresh"));
  // --session <id> resumes (and persists) a specific provider session — used to
  // recover bees whose providerSessionId was never recorded but whose session
  // still exists on disk (claude/codex keep sessions keyed by project dir).
  const sessionOverride = stringFlag(parsed, ["session"]);
  const providerSessionId = fresh ? undefined : (sessionOverride ?? record.providerSessionId);
  if (!fresh && !providerSessionId) {
    throw new Error(
      `hive revive: ${record.name} has no recorded provider session id; pass --session <id> to resume an exact ${tool} session, or --fresh to start anew`,
    );
  }

  const updated = await reviveRecord(record, { fresh, sessionOverride });

  const how = providerSessionId ? `resumed ${providerSessionId}` : "fresh session";
  if (isPretty()) console.log(actionLine("ok", "revive", [bold(record.name), record.agent, dim(how)]));
  else console.log(`revived\t${record.name}\t${record.agent}\t${how}`);
  return updated;
}

async function cmdRun(parsed: Parsed) {
  const agent = parsed.args[0];
  const prompt = stringFlag(parsed, ["prompt", "p"]) ?? parsed.args.slice(1).join(" ");
  if (!agent || !prompt) throw new Error("Usage: hive run <bee> -p <prompt> [--cwd dir] [--account <name|auto>] [--yolo] [--wait] [--last] [--rm|--cleanup] [-- <bee-args...>]");
  if (truthy(flag(parsed, "keep")) && cleanupAfterRun(parsed)) throw new Error("--keep cannot be combined with --rm/--cleanup");
  if (numberFlag(parsed, ["count"], 1) > 1 || flag(parsed, "frame")) {
    throw new Error("hive run spawns a single bee; to prompt a swarm use: hive spawn <bee> --count <n> && hive send <selector> <prompt>");
  }

  // The waitForAgentReady below is authoritative; skip spawn's own readiness
  // confirmation so a slow boot is only waited for once.
  const spawnFlags = new Map(parsed.flags);
  spawnFlags.set("no-wait", true);
  const spawnParsed: Parsed = {
    command: "spawn",
    args: [agent],
    flags: spawnFlags,
    rest: parsed.rest,
  };
  const record = await cmdSpawn(spawnParsed);
  const cleanup = cleanupAfterRun(parsed);
  let blocked = false;

  try {
    try {
      await waitForAgentReady(record, {
        timeoutMs: numberFlag(parsed, ["boot-ms"], defaultBootMs(record.agent)),
        acceptTrust: acceptsTrust(parsed),
        raiseDroidAutonomy: dangerousMode(parsed, record.agent, record.requestedAgent),
      });
    } catch (error) {
      if (!(error instanceof AgentReadinessError) || error.reason !== "timeout" || !truthy(flag(parsed, "force-send"))) throw error;
      console.error(actionLine("warn", "force", [`readiness timeout for ${bold(record.name)}, sending anyway`]));
      if (error.pane.trim()) console.error(formatPaneExcerpt(error.pane));
    }
    await substrateFor(record).sendText(record.tmuxTarget, prompt, record.agentPaneId);
    const now = new Date().toISOString();
    await updateSession(record.name, { updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now });
    await writeHiveState(record, "working");
    await appendLedger({ type: "prompt.run", session: record.name, agent: record.agent, node: record.node ?? LOCAL_NODE_NAME, cwd: record.cwd, chars: prompt.length });

    if (truthy(flag(parsed, "wait"))) {
      const outcome = await waitForIdle({
        record: { ...record, lastPrompt: prompt, lastPromptAt: now },
        idleMs: numberFlag(parsed, ["idle-ms", "idle"], 3_000),
        timeoutMs: numberFlag(parsed, ["timeout-ms", "timeout"], 600_000),
        pollMs: numberFlag(parsed, ["poll-ms", "poll"], 750),
        output: truthy(flag(parsed, "last")) ? "last" : truthy(flag(parsed, "transcript")) ? "transcript" : "pane",
        rows: numberFlag(parsed, ["n", "limit"], 0),
        json: truthy(flag(parsed, "json")),
      });
      blocked = outcome.state === "blocked";
    } else {
      const waitMs = Number(flag(parsed, "wait-ms") ?? 1000);
      if (waitMs > 0) await sleep(waitMs);
      const lines = Number(flag(parsed, "n") ?? flag(parsed, "lines") ?? 80);
      console.log(await substrateFor(record).capture(record.tmuxTarget, Number.isFinite(lines) ? lines : 80, record.agentPaneId));
    }
  } finally {
    if (cleanup) {
      if (blocked) {
        // The bee is stalled on an approval prompt — killing it now would
        // destroy the pending work. Keep it and let the human decide.
        console.error("");
        console.error(note(`kept ${record.name} (blocked on a permission prompt); resolve with: hive attach ${record.name}`));
        process.exitCode = 1;
      } else {
        await cleanupRunSession(record);
      }
    }
  }

  const waited = truthy(flag(parsed, "wait"));
  if (cleanup) {
    return;
  }
  if (truthy(flag(parsed, "keep"))) {
    console.error("");
    console.error(note(`kept ${record.name}; clean up with: hive kill ${record.name}`));
  } else if (!waited) {
    console.error("");
    console.error(note(`kept ${record.name}; use: hive wait ${record.name} && hive kill ${record.name}`));
  } else {
    console.error("");
    console.error(note(`kept ${record.name}; pass --rm next time to clean up automatically`));
  }
}

async function cleanupRunSession(record: SessionRecord): Promise<void> {
  const outcome = await transactionalKill(record);
  console.error("");
  if (!outcome.ok) {
    console.error(note(`kill_failed ${record.name} (--rm/--cleanup): ${outcome.lastError}`));
    process.exitCode = 1;
    return;
  }
  console.error(note(`${outcome.alreadyGone ? "removed stale" : "killed"} ${record.name} (--rm/--cleanup)`));
}

// Shorthand: spawn a single bee of <bee> and hand it <prompt> in one command, then
// return immediately (fire-and-forget). It is the front half of `run` — spawn, wait
// for the prompt to be ready, deliver it — without `run`'s blocking wait/capture/cleanup.
// Inspect later with `hive tail|attach|wait`.
async function cmdX(parsed: Parsed) {
  const agent = parsed.args[0];
  const prompt = stringFlag(parsed, ["prompt", "p"]) ?? parsed.args.slice(1).join(" ");
  if (!agent || !prompt) throw new Error("Usage: hive x <bee> <prompt> [--cwd <dir>] [--account <name|auto>] [--name <id>] [--yolo] [-- <bee-args...>]");
  if (numberFlag(parsed, ["count"], 1) > 1 || flag(parsed, "frame")) {
    throw new Error("hive x spawns a single bee; to prompt a swarm use: hive spawn <bee> --count <n> && hive send <selector> <prompt>");
  }

  // The waitForAgentReady below is authoritative; skip spawn's own readiness
  // confirmation so a slow boot is only waited for once.
  const spawnFlags = new Map(parsed.flags);
  spawnFlags.set("no-wait", true);
  const spawnParsed: Parsed = {
    command: "spawn",
    args: [agent],
    flags: spawnFlags,
    rest: parsed.rest,
  };
  const record = await cmdSpawn(spawnParsed);

  // HSR bees have no interactive TUI to poll for readiness — the runner host is
  // ready as soon as spawn confirmed it live (hasSession). Skip the pane-scrape
  // readiness wait; steer straight through the control socket.
  if (record.substrate !== "hsr") {
    try {
      await waitForAgentReady(record, {
        timeoutMs: numberFlag(parsed, ["boot-ms"], defaultBootMs(record.agent)),
        acceptTrust: acceptsTrust(parsed),
        raiseDroidAutonomy: dangerousMode(parsed, record.agent, record.requestedAgent),
      });
    } catch (error) {
      if (!(error instanceof AgentReadinessError) || error.reason !== "timeout" || !truthy(flag(parsed, "force-send"))) throw error;
      console.error(actionLine("warn", "force", [`readiness timeout for ${bold(record.name)}, sending anyway`]));
      if (error.pane.trim()) console.error(formatPaneExcerpt(error.pane));
    }
  }

  await substrateFor(record).sendText(record.tmuxTarget, prompt);
  const now = new Date().toISOString();
  await updateSession(record.name, { updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now });
  await writeHiveState(record, "working");
  await appendLedger({ type: "prompt.run", session: record.name, agent: record.agent, node: record.node ?? LOCAL_NODE_NAME, cwd: record.cwd, chars: prompt.length });
  if (isPretty()) console.log(actionLine("ok", "send", [bold(record.name), `${prompt.length} chars`]));
  else console.log(`sent\t${record.name}\t${prompt.length} chars`);
}

// Shorthand: spawn a single bee and attach to it — the interactive front door
// (`hive xa claude`, `hive xa cc1`, `hive xa codex-ur`). Spawn waits for the
// agent prompt (confirmSpawnReady) so attach lands on a ready pane; detaching
// leaves the bee running like any tmux session.
async function cmdXa(parsed: Parsed) {
  const agent = parsed.args[0];
  if (!agent) throw new Error("Usage: hive xa <bee> [--cwd <dir>] [--home <1|2|3|path>] [--account <a|auto>] [--name <id>] [--print]");
  if (numberFlag(parsed, ["count"], 1) > 1 || flag(parsed, "frame")) {
    throw new Error("hive xa attaches to a single bee; spawn cohorts with hive spawn --count/--frame");
  }

  const spawnParsed: Parsed = {
    command: "spawn",
    args: [agent],
    flags: new Map(parsed.flags),
    rest: parsed.rest,
  };
  const record = await cmdSpawn(spawnParsed);

  const substrate = substrateFor(record);
  if (truthy(flag(parsed, "print")) || !process.stdout.isTTY) {
    if (isPretty()) console.error(note("attach with:"));
    console.log(formatShellCommand(substrate.attachCommand(record.tmuxTarget)));
    return;
  }
  await substrate.attachSession(record.tmuxTarget);
}

// `hive open <bee>`: identity-launcher mode. Activates the account into its
// home, then runs the agent DIRECTLY in the CURRENT terminal — foreground,
// where you called it. --window/--app launch a new native terminal window
// Flags `open` consumes itself. Anything else on the command line is forwarded
// to the agent CLI, so `hive open claude --resume <id>` works without the `--`
// separator (which still works, and is the escape hatch for flags open owns,
// e.g. `hive open claude -- --print`).
const OPEN_OWN_FLAGS = new Set([
  "raw", "window", "app", "cwd", "account", "ttl", "home", "profile", "print",
  "yolo", "dangerous", "no-yolo", "accept-trust", "trust", "no-accept-trust", "no-trust",
]);

// In the registered (non-raw) modes these are spawn-pipeline controls, not
// agent flags — they ride the delegated spawn instead of the passthrough.
const OPEN_SPAWN_CONTROL_FLAGS = new Set([
  "name", "colony", "swarm", "swarm-id", "count", "frame", "node", "substrate",
  "brief", "briefed", "autoswap", "boot-ms", "no-wait", "force-send", "here",
]);

const OPEN_DELEGATED_FLAGS = new Set([...OPEN_OWN_FLAGS, ...OPEN_SPAWN_CONTROL_FLAGS]);

function openPassthroughArgs(parsed: Parsed, exclude: Set<string> = OPEN_OWN_FLAGS): string[] {
  const out: string[] = [];
  for (const [key, value] of parsed.flags) {
    if (exclude.has(key)) continue;
    // Single-letter keys came in as `-x`; the parser strips dashes, so restore
    // the form the agent CLI expects.
    const name = key.length === 1 ? `-${key}` : `--${key}`;
    for (const item of Array.isArray(value) ? value : [value]) {
      out.push(name);
      if (item !== true) out.push(String(item));
    }
  }
  return out;
}

// `open` = run an agent where you are. Since the daily driver moved inside
// tmux, the default contract is a REGISTERED spawn presented in place:
//   inside tmux  → spawn + --here (window linked into your current session)
//   outside tmux → spawn + attach (xa semantics)
// `--raw` is the old behavior — agent runs directly in this terminal, no tmux
// session, no SessionRecord (list/tail/kill/daemon do not apply). --window/
// --app imply --raw: they target external terminal apps by nature.
async function cmdOpen(parsed: Parsed) {
  const requested = parsed.args[0];
  if (!requested) throw new Error("Usage: hive open <bee> [--raw] [--window] [--app <terminal>] [--cwd <dir>] [--account <a|auto>] [--print] [<bee-flags...>]");

  const rawAppFlag = typeof flag(parsed, "app") === "string" ? String(flag(parsed, "app")) : undefined;
  const raw = truthy(flag(parsed, "raw")) || truthy(flag(parsed, "window")) || rawAppFlag !== undefined;
  if (!raw) {
    const spawnFlags = new Map(parsed.flags);
    for (const key of [...spawnFlags.keys()]) {
      // Unknown flags reach the agent via the spawn rest, not as spawn flags.
      if (!OPEN_DELEGATED_FLAGS.has(key)) spawnFlags.delete(key);
    }
    spawnFlags.delete("raw");
    spawnFlags.delete("print");
    if (process.env.TMUX) spawnFlags.set("here", true);
    const spawnParsed: Parsed = {
      command: "spawn",
      args: [requested],
      flags: spawnFlags,
      rest: [...openPassthroughArgs(parsed, OPEN_DELEGATED_FLAGS), ...parsed.rest],
    };
    const record = await cmdSpawn(spawnParsed);
    const substrate = substrateFor(record);
    if (truthy(flag(parsed, "print")) || !process.stdout.isTTY) {
      if (isPretty()) console.error(note("attach with:"));
      console.log(formatShellCommand(substrate.attachCommand(record.tmuxTarget)));
      return;
    }
    // Inside tmux --here already linked and selected the window right here.
    if (process.env.TMUX) return;
    await substrate.attachSession(record.tmuxTarget);
    return;
  }

  await cmdOpenRaw(parsed);
}

// The pre-tmux-era contract, now explicit: agent runs raw in this terminal
// (or a new terminal window via --window/--app). Off-brand on purpose — no
// tmux session, no SessionRecord. Activation and launch are ledger-logged.
async function cmdOpenRaw(parsed: Parsed) {
  const requested = parsed.args[0]!;
  const { agent: resolvedAgent, account: aliasAccount } = await resolveSpawnAgentWithAuto(requested, parsed);
  // Thin profile → account (same overlay as spawnSingleBee).
  const profile = await resolveProfileOverlay(requested);
  const agent = profile ? profile.account.tool : resolvedAgent;
  const profileArgs = profile?.args ?? [];
  const yolo = dangerousMode(parsed, agent, requested, profile?.yolo);
  const accountQuery = typeof flag(parsed, "account") === "string" ? String(flag(parsed, "account")) : undefined;
  const account = accountQuery ? await resolveAccountFlag(accountQuery, canonicalAgentKind(agent), ttlFlagMs(parsed)) : (profile?.account ?? aliasAccount);
  const model = account ? (profile?.model ?? account.model) : undefined;
  const provider = account?.provider;
  const home = (flag(parsed, "home") ?? flag(parsed, "profile")) ?? (account ? defaultHomeForAccount(account) : undefined);
  const spec = resolveAgent(agent, [...openPassthroughArgs(parsed), ...parsed.rest, ...profileArgs], {
    home,
    yolo,
    identity: Boolean(account),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  });
  if (account) {
    if (!spec.homePath) throw new Error(`Agent ${spec.kind} has no home env; cannot bind account ${account.id}`);
    await activateAccountIntoHome(account, spec.homePath, { onWarn: (message) => console.error(note(message)) });
  }
  const cwd = await resolveSpawnCwd(parsed, profile?.cwd);
  // Re-merge the startup acceptances activation just clobbered (and seed them
  // for fresh homes), so claude does not re-ask the bypass-permissions and
  // folder-trust questions on every open.
  if (spec.kind === "claude" && spec.homePath) {
    await seedClaudeHomeAcceptance(spec.homePath, { yolo, trustCwd: acceptsTrust(parsed) ? cwd : undefined });
  }
  const command = shellCommand(spec);
  const appFlag = typeof flag(parsed, "app") === "string" ? String(flag(parsed, "app")) : undefined;
  const wantsWindow = truthy(flag(parsed, "window")) || appFlag !== undefined;
  await appendLedger({
    type: "session.open",
    agent: spec.kind,
    account: account?.id ?? null,
    cwd,
    mode: wantsWindow ? "window" : "here",
  });

  if (truthy(flag(parsed, "print"))) {
    console.log(command);
    return;
  }
  await assertAgentAuthFreshForSpawn(spec, account?.id);

  if (wantsWindow) {
    const app = await openInNewTerminal(command, cwd, appFlag);
    if (isPretty()) console.log(actionLine("ok", "open", [bold(spec.kind), ...(account ? [account.id] : []), dim(`${app} window`)]));
    else console.log(`opened\t${spec.kind}\t${account?.id ?? "-"}\t${app}`);
    return;
  }

  // Default: take over THIS terminal, exactly where the user called from.
  process.exitCode = await runInCurrentTerminal(spec.command, spec.args, spec.env, cwd);
  // The session may have refreshed/rotated auth in the home, not the vault.
  // Pull it back now so the next activation does not stamp an old credential
  // over the live one.
  if (account && spec.homePath) {
    await syncAccountCredentialsToVault(account, spec.homePath, { trustExtraHome: true }).catch(() => undefined);
  }
}

async function cmdConfig(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "show": {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "path":
      console.log(configPath());
      return;
    case "set-bee":
      return configSetBee(parsed);
    case "set-naming":
      return configSetNaming(parsed);
    default:
      throw new Error(`Unknown config subcommand: ${sub}\nUsage: hive config <show|path|set-bee|set-naming>`);
  }
}

async function configSetBee(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive config set-bee <bee> [--kind <agent>] [--yolo] [--no-yolo] [--home <value>] [--command \"...\"]");
  const yolo = truthy(flag(parsed, "yolo")) ? true : truthy(flag(parsed, "no-yolo")) ? false : undefined;
  const homeRaw = flag(parsed, "home");
  const home = typeof homeRaw === "string" ? homeRaw : undefined;
  const commandRaw = flag(parsed, "command");
  const command = typeof commandRaw === "string" ? commandRaw : undefined;
  const kindRaw = flag(parsed, "kind");
  const kind = typeof kindRaw === "string" ? kindRaw : undefined;
  if (yolo === undefined && home === undefined && command === undefined && kind === undefined) {
    throw new Error("hive config set-bee needs at least one of --kind, --yolo/--no-yolo, --home, --command");
  }
  const config = loadConfig();
  const next = { ...config, bees: { ...(config.bees ?? {}) } };
  const existing = next.bees[name] ?? {};
  const beeEntry: Record<string, unknown> = { ...existing };
  if (yolo !== undefined) beeEntry.yolo = yolo;
  if (home !== undefined) beeEntry.home = home;
  if (command !== undefined) beeEntry.command = command;
  if (kind !== undefined) beeEntry.kind = kind;
  next.bees[name] = beeEntry;
  await writeConfigFile(next);
  resetConfigCache();
  if (isPretty()) console.log(actionLine("ok", "config", [bold(name), dim("updated")]));
  else console.log(`config\t${name}\tupdated`);
}

async function configSetNaming(parsed: Parsed) {
  const auto = truthy(flag(parsed, "auto")) ? true : truthy(flag(parsed, "no-auto")) ? false : undefined;
  const toolRaw = flag(parsed, "tool");
  if (toolRaw !== undefined && toolRaw !== "claude" && toolRaw !== "codex") throw new Error("--tool must be claude or codex");
  const tool = toolRaw as "claude" | "codex" | undefined;
  const modelRaw = flag(parsed, "model");
  const model = typeof modelRaw === "string" ? modelRaw : undefined;
  const commandRaw = flag(parsed, "command");
  const command = typeof commandRaw === "string" ? commandRaw : undefined;
  const effortRaw = flag(parsed, "effort");
  if (effortRaw !== undefined && !(NAMING_EFFORTS as readonly string[]).includes(String(effortRaw))) {
    throw new Error(`--effort must be one of: ${NAMING_EFFORTS.join(", ")}`);
  }
  const effort = typeof effortRaw === "string" ? (effortRaw as NamingEffort) : undefined;
  if (auto === undefined && tool === undefined && model === undefined && command === undefined && effort === undefined) {
    throw new Error('hive config set-naming needs at least one of --auto/--no-auto, --tool <claude|codex>, --model <m>, --effort <minimal|low|medium|high|xhigh>, --command "..."');
  }
  const config = loadConfig();
  const naming = { ...(config.naming ?? {}) };
  if (auto !== undefined) naming.auto = auto;
  if (tool !== undefined) naming.tool = tool;
  if (model !== undefined) naming.model = model;
  if (command !== undefined) naming.command = command;
  if (effort !== undefined) naming.effort = effort;
  await writeConfigFile({ ...config, naming });
  resetConfigCache();
  if (isPretty()) console.log(actionLine("ok", "config", [bold("naming"), dim("updated")]));
  else console.log("config\tnaming\tupdated");
}

async function writeConfigFile(config: unknown): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const target = configPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function cmdCompletion(parsed: Parsed) {
  const shell = parsed.args[0];
  if (!shell) throw new Error("Usage: hive completion <bash|zsh|fish>");
  process.stdout.write(shellScript(shell));
}

async function cmdColony(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return colonyList();
    case "create":
      return colonyCreate(parsed);
    case "inspect":
      return colonyInspect(parsed);
    case "archive":
      return colonyArchive(parsed);
    case "update":
      return colonyUpdate(parsed);
    case "rename":
      return colonyRename(parsed);
    default:
      throw new Error(`Unknown colony subcommand: ${sub}\nUsage: hive colony <list|create|inspect|archive|update|rename>`);
  }
}

async function colonyList() {
  const colonies = await listColonies();
  if (!isPretty()) {
    for (const c of colonies) console.log(`${c.archived ? "archived" : "active"}\t${c.name}\t${c.createdAt}`);
    return;
  }
  if (colonies.length === 0) {
    console.log(dim("No colonies. Create one with: hive colony create <name>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "NAME" },
      { header: "AGE", align: "right" },
      { header: "DESCRIPTION" },
    ],
    colonies.map((c) => [
      c.archived ? gray("archived") : green("active"),
      bold(c.name),
      dim(formatRelativeTime(c.createdAt)),
      dim(c.description ?? ""),
    ]),
  ));
}

async function colonyCreate(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive colony create <name> [--description \"...\"]");
  const description = typeof flag(parsed, "description") === "string" ? String(flag(parsed, "description")) : undefined;
  const record = await createColony(name, description);
  if (isPretty()) console.log(actionLine("ok", "colony", [bold(record.name), dim("created")]));
  else console.log(`created\t${record.name}`);
}

async function colonyInspect(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive colony inspect <name>");
  const record = await loadColony(name);
  if (!record) throw new Error(`Unknown colony: ${name}`);
  console.log(JSON.stringify(record, null, 2));
}

async function colonyArchive(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive colony archive <name>");
  const record = await archiveColony(name);
  if (isPretty()) console.log(actionLine("ok", "colony", [bold(record.name), dim("archived")]));
  else console.log(`archived\t${record.name}`);
}

async function colonyUpdate(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive colony update <name> [--description \"...\"] [--name <new>]");
  const descRaw = flag(parsed, "description");
  if (descRaw === true) throw new Error("--description requires a value (use --description \"\" to clear)");
  const description = typeof descRaw === "string" ? descRaw : undefined;
  const newName = typeof flag(parsed, "name") === "string" ? String(flag(parsed, "name")) : undefined;
  if (description === undefined && newName === undefined) {
    throw new Error("hive colony update needs --description \"...\" or --name <new>");
  }

  let current = await loadColony(name);
  if (!current) throw new Error(`Unknown colony: ${name}`);

  if (description !== undefined) current = await updateColony(name, { description });
  if (newName !== undefined && newName !== current.name) {
    const oldName = current.name;
    current = await renameColony(oldName, newName);
    await cascadeColonyRename(oldName, newName);
  }

  if (isPretty()) console.log(actionLine("ok", "colony", [bold(current.name), dim("updated")]));
  else console.log(`updated\t${current.name}`);
}

async function colonyRename(parsed: Parsed) {
  const from = parsed.args[1];
  const to = parsed.args[2];
  if (!from || !to) throw new Error("Usage: hive colony rename <old> <new>");
  const record = await renameColony(from, to);
  await cascadeColonyRename(from, to);
  if (isPretty()) console.log(actionLine("ok", "colony", [bold(record.name), dim(`renamed from ${from}`)]));
  else console.log(`renamed\t${from}\t${to}`);
}

async function cascadeColonyRename(from: string, to: string): Promise<void> {
  if (from === to) return;
  const sessions = await listSessions();
  for (const record of sessions) {
    if (record.colony !== from) continue;
    await updateSession(record.name, { colony: to, updatedAt: new Date().toISOString() });
  }
  const swarms = await listSwarms();
  for (const swarm of swarms) {
    if (swarm.colony !== from) continue;
    await saveSwarm({ ...swarm, colony: to });
  }
}

async function cmdWorkspace(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return workspaceList(parsed);
    case "open":
      return workspaceOpen(parsed);
    case "add":
      return workspaceAdd(parsed);
    case "add-pane":
      return workspaceAddPane(parsed);
    case "snapshot":
      return workspaceSnapshot(parsed);
    case "restore":
      return workspaceRestore(parsed);
    case "close":
      return workspaceClose(parsed);
    case "rename":
      return workspaceRename(parsed);
    case "here":
      return workspaceHere(parsed);
    case "archive":
      return workspaceArchive(parsed);
    default:
      throw new Error(`Unknown workspace subcommand: ${sub}\nUsage: hive workspace <open|list|add|add-pane|snapshot|restore|close|rename|here|archive>`);
  }
}

/**
 * Resolve the current pane's OWNING workspace bare name (KEYBINDINGS_PRD §9.1 /
 * §10 — unblocks the M-R binding). If $TMUX's session is a ws-* session, print
 * its bare workspace name; else resolve the current bee → its workspaceId.
 * Errors to stderr + non-zero if not inside tmux or no owning workspace.
 */
async function workspaceHere(_parsed: Parsed): Promise<void> {
  if (!process.env.TMUX) throw new Error("hive workspace here: not inside tmux");
  const sessionName = await currentTmuxSessionName();
  if (sessionName && sessionName.startsWith(WORKSPACE_PREFIX)) {
    const bare = sessionName.slice(WORKSPACE_PREFIX.length);
    // A grouped ws-* client carries a `-N` suffix (ws-fe-2). Disambiguate against
    // a workspace literally named `fe-2`: if a record with the exact bare name
    // exists, that is it; otherwise strip a trailing `-<digits>` grouping suffix
    // and re-check, so the M-R rename chord resolves `fe` from a `ws-fe-2` client.
    if (await loadWorkspace(bare)) {
      console.log(bare);
      return;
    }
    const ungrouped = bare.replace(/-\d+$/, "");
    if (ungrouped !== bare && (await loadWorkspace(ungrouped))) {
      console.log(ungrouped);
      return;
    }
    // No record either way (an ad-hoc ws- session with no record): the bare
    // prefix-stripped name is the best we can do and round-trips when un-grouped.
    console.log(bare);
    return;
  }
  const bee = await resolveBeeInCurrentPane();
  if (!bee || !bee.workspaceId) {
    throw new Error("hive workspace here: the current pane has no owning workspace");
  }
  console.log(bee.workspaceId);
}

/**
 * Resolve the workspace record for `name`, falling back to a same-named colony's
 * auto-workspace. Returns null when neither exists.
 */
async function resolveWorkspaceRecord(name: string): Promise<WorkspaceRecord | null> {
  const direct = await loadWorkspace(name);
  if (direct) return direct;
  // Fall back to a colony of the same name whose auto-workspace wasn't
  // provisioned yet (or was created before this feature) — create it lazily.
  const colony = await loadColony(name);
  if (!colony) return null;
  try {
    return await createWorkspace({ name, rootDir: colony.rootDir ?? "", members: [], colony: name });
  } catch {
    // A concurrent create won the race; re-read.
    return loadWorkspace(name);
  }
}

/**
 * Resolve-or-create the workspace record for `name`. A bare `open <name>` for a
 * name that is neither a workspace nor a colony creates a stand-alone ad-hoc
 * workspace (the PRD allows these alongside colony auto-workspaces).
 */
async function ensureWorkspaceRecord(name: string): Promise<WorkspaceRecord> {
  const resolved = await resolveWorkspaceRecord(name);
  if (resolved) return resolved;
  try {
    return await createWorkspace({ name, rootDir: "", members: [] });
  } catch {
    const reread = await loadWorkspace(name);
    if (reread) return reread;
    throw new Error(`Could not create workspace: ${name}`);
  }
}

/** Resolve a workspace's file root: --root › record.rootDir › colony.rootDir › cwd. */
async function resolveWorkspaceRoot(rootFlag: string | undefined, record: WorkspaceRecord): Promise<string> {
  if (rootFlag) return realpath(resolve(rootFlag.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))).catch(() => resolve(rootFlag));
  if (record.rootDir && record.rootDir.length > 0) return record.rootDir;
  if (record.colony) {
    const colony = await loadColony(record.colony);
    if (colony?.rootDir) return colony.rootDir;
  }
  return process.cwd();
}

async function workspaceList(parsed: Parsed) {
  const colonyFilter = stringFlag(parsed, ["colony"]);
  const showArchived = truthy(flag(parsed, "archived"));
  let workspaces = await listWorkspaces();
  if (!showArchived) workspaces = workspaces.filter((w) => !w.archived);
  if (colonyFilter) workspaces = workspaces.filter((w) => w.colony === colonyFilter);

  if (!isPretty()) {
    for (const w of workspaces) {
      console.log(`${w.archived ? "archived" : "active"}\t${w.name}\t${w.rootDir}\t${w.colony ?? ""}\t${w.members.length}`);
    }
    return;
  }
  if (workspaces.length === 0) {
    console.log(dim("No workspaces. Create one with: hive workspace open <name> --root <dir>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "NAME" },
      { header: "ROOT" },
      { header: "COLONY" },
      { header: "MEMBERS", align: "right" },
      { header: "AGE", align: "right" },
    ],
    workspaces.map((w) => [
      w.archived ? gray("archived") : green("active"),
      bold(w.name),
      dim(w.rootDir ? tildify(w.rootDir) : "(unset)"),
      dim(w.colony ?? ""),
      String(w.members.length),
      dim(formatRelativeTime(w.createdAt)),
    ]),
  ));
}

/** Active window ids per local tmux session, for de-dupe on add/open. */
async function workspaceWindowsOf(session: string): Promise<string[]> {
  const inventory = await windowInventory();
  return inventory.windows.get(session) ?? [];
}

async function workspaceOpen(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace open <name|colony> [--root <dir>] [--new-client] [--print]");
  // open create-or-reuses: a colony's auto-workspace, an existing record, or a
  // fresh stand-alone workspace for an unknown name.
  const record = await ensureWorkspaceRecord(name);

  const rootDir = await resolveWorkspaceRoot(stringFlag(parsed, ["root"]), record);
  // Persist the resolved root on first open (when it was empty or --root given).
  if (record.rootDir !== rootDir) {
    await updateWorkspace(record.name, { rootDir });
  }

  const session = workspaceSessionName(record.name);
  const ensured = await ensureLinkSession(session);
  // Workspaces persist across terminal close — unlike views, never auto-destroyed.
  await setWorkspaceOptions(session);
  // The placeholder shell is the workspace's own window — mark it so `close`
  // may kill-window it (it survives as the anchor of an empty/pane-only ws).
  if (ensured.placeholder) await markWorkspaceOwnWindow(session, ensured.placeholder);

  // Materialize bee members: resolve each bee's live session, link its window in.
  const records = await listSessions();
  const byId = new Map(records.map((r) => [r.id ?? r.name, r] as const));
  const liveNames = new Set(await localSubstrate().listSessions());
  const beeTargets: string[] = [];
  for (const member of record.members) {
    if (member.kind !== "bee") continue;
    const bee = byId.get(member.beeId) ?? records.find((r) => r.name === member.beeId);
    if (!bee) continue;
    if (bee.node && bee.node !== LOCAL_NODE_NAME) continue;
    if (!liveNames.has(bee.tmuxTarget)) continue;
    beeTargets.push(bee.tmuxTarget);
    // Converge with `add`: a member bee must carry workspaceId so ws:<name>
    // (derived from bee.workspaceId) and record.members never disagree.
    if (bee.workspaceId !== record.name) {
      await updateSession(bee.name, { workspaceId: record.name });
      await writeHiveTags({ ...bee, workspaceId: record.name });
    }
  }
  const linkResult = await linkTargetsInto(session, beeTargets, ensured);

  // Materialize pane members: a window at rootDir running the member's command
  // (or a shell). Only when the session was freshly created this call — a
  // re-open of a live session keeps its existing panes (native persistence).
  if (ensured.created) {
    for (const member of record.members) {
      if (member.kind !== "pane") continue;
      await openWorkspacePane(session, rootDir, member.command);
    }
    // If we created bee links, the placeholder is already gone; otherwise it
    // remains as the single (shell) window — which is fine for an empty/pane-only
    // workspace.
  }

  if (isPretty()) {
    console.log(actionLine("ok", "workspace", [bold(session), dim(`root ${tildify(rootDir)}`), `${linkResult.linked.length} bee(s) linked`]));
  } else {
    console.log(`workspace\t${session}\t${rootDir}\t${linkResult.linked.length}`);
  }

  let enterTarget = session;
  if (truthy(flag(parsed, "new-client"))) {
    enterTarget = await createGroupedSession(session);
    if (isPretty()) console.error(note(`grouped session ${enterTarget} — independent focus on the same windows`));
  }

  const substrate = localSubstrate();
  if (truthy(flag(parsed, "print")) || !process.stdout.isTTY) {
    if (isPretty()) console.error(note("enter with:"));
    console.log(formatShellCommand(substrate.attachCommand(enterTarget)));
    return;
  }
  await substrate.attachSession(enterTarget);
}

/**
 * Make a workspace session persist across terminal close (PRD §6/§7.2): never
 * auto-destroyed when the last client detaches, and clients survive a window
 * close. tmux's `set-option` does NOT accept the `=name` exact-match prefix
 * (unlike has-session/kill-session/window targets), so the session is targeted
 * by its bare exact name (freshly created, no prefix-collision risk).
 */
async function setWorkspaceOptions(session: string): Promise<void> {
  await tmux(["set-option", "-t", session, "destroy-unattached", "off"], { reject: false });
  await tmux(["set-option", "-t", session, "detach-on-destroy", "off"], { reject: false });
}

/** Open a window at `rootDir` running `command` (or the user's shell). */
const WS_OWN_OPTION = "@hive_ws_own";

// Mark a window the workspace itself created (the placeholder shell or an
// add-pane shell) so `close` may kill-window it. A linked BEE window is NEVER
// marked, so close can only ever safe-unlink (no -k) those — which is what makes
// closing a workspace provably incapable of killing a bee, even one orphaned by
// a prior `hive kill` (home session gone, window still linked here).
async function markWorkspaceOwnWindow(session: string, windowId: string): Promise<void> {
  if (!windowId) return;
  await tmux(["set-option", "-w", "-t", `${session}:${windowId}`, WS_OWN_OPTION, "1"], { reject: false });
}

async function openWorkspacePane(session: string, rootDir: string, command?: string): Promise<void> {
  const args = ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${session}:`, "-c", rootDir];
  if (command && command.length > 0) args.push(command);
  const result = await tmux(args, { reject: false });
  await markWorkspaceOwnWindow(session, result.stdout.trim());
}

async function workspaceAdd(parsed: Parsed) {
  const name = parsed.args[1];
  const sel = parsed.args[2];
  if (!name || !sel) throw new Error("Usage: hive workspace add <name> <bee-selector>");
  const record = await ensureWorkspaceRecord(name);

  const session = workspaceSessionName(record.name);
  // Ensure the session exists so `add` works standalone (without a prior open).
  const ensured = await ensureLinkSession(session);
  if (ensured.created) {
    await setWorkspaceOptions(session);
  }

  const resolved = await resolveSelector(sel);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${sel}`);

  const local = records.filter((r) => !r.node || r.node === LOCAL_NODE_NAME);
  if (local.length < records.length) {
    console.error(note(`skip ${records.length - local.length} remote bee(s) — link-window cannot cross tmux servers`));
  }
  const liveNames = new Set(await localSubstrate().listSessions());
  const live = local.filter((r) => liveNames.has(r.tmuxTarget));
  if (live.length < local.length) console.error(note(`skip ${local.length - live.length} dead bee(s)`));
  if (live.length === 0) throw new Error(`No live local bees match selector: ${sel}`);

  const members: WorkspaceMember[] = [...record.members];
  const memberIds = new Set(members.filter((m) => m.kind === "bee").map((m) => (m as { beeId: string }).beeId));
  const inventory = await windowInventory();
  let linkedCount = 0;
  for (const bee of live) {
    const windowId = inventory.active.get(bee.tmuxTarget);
    if (!windowId) continue;
    const currentWindows = await workspaceWindowsOf(session);
    const linked = await linkWindowsInto(session, currentWindows, [{ session: bee.tmuxTarget, windowId }], { select: false });
    linkedCount += linked;
    const beeId = bee.id ?? bee.name;
    if (!memberIds.has(beeId)) {
      members.push({ kind: "bee", beeId });
      memberIds.add(beeId);
    }
    // Stamp workspaceId on the live bee so the derived ws: tag refreshes
    // (cmdMove colony pattern).
    const now = new Date().toISOString();
    await updateSession(bee.name, { workspaceId: record.name, updatedAt: now });
    await writeHiveTags({ ...bee, workspaceId: record.name });
  }
  await updateWorkspace(record.name, { members });

  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(session), `${linkedCount} bee(s) linked`]));
  else console.log(`workspace-add\t${session}\t${linkedCount}`);
}

async function workspaceAddPane(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace add-pane <name> [--cmd \"...\"] [--name <label>]");
  const record = await ensureWorkspaceRecord(name);

  const command = stringFlag(parsed, ["cmd"]);
  const label = stringFlag(parsed, ["name"]) ?? "pane";

  const session = workspaceSessionName(record.name);
  const ensured = await ensureLinkSession(session);
  if (ensured.created) {
    await setWorkspaceOptions(session);
  }
  const rootDir = await resolveWorkspaceRoot(stringFlag(parsed, ["root"]), record);
  await openWorkspacePane(session, rootDir, command);

  const members: WorkspaceMember[] = [...record.members, { kind: "pane", name: label, ...(command ? { command } : {}) }];
  await updateWorkspace(record.name, { members });

  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(session), dim(`pane ${label}`), command ? dim(command) : dim("shell")]));
  else console.log(`workspace-add-pane\t${session}\t${label}`);
}

/**
 * `hive workspace snapshot <name>` — refresh the record's geometry from the live
 * `ws-<name>` session so `restore` can rebuild it after a reboot (PRD §7.2/§11).
 * Captures each window's tmux `window_layout` string keyed by `window_name`.
 */
async function workspaceSnapshot(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace snapshot <name>");
  const record = await ensureWorkspaceRecord(name);
  const session = workspaceSessionName(record.name);
  if (!(await hasSession(session))) throw new Error(`No such workspace session: ${session}`);

  // Capture per-window geometry. Tab-separate name from layout (layout strings
  // never contain a tab); skip blank rows defensively.
  const result = await tmux(["list-windows", "-t", `=${session}:`, "-F", "#{window_name}\t#{window_layout}"], { reject: false });
  const layout: WorkspaceLayoutEntry[] = [];
  for (const line of (result.ok ? result.stdout.split("\n") : []).filter(Boolean)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const windowName = line.slice(0, tab);
    const value = line.slice(tab + 1);
    if (!windowName || !value) continue;
    layout.push({ windowName, layout: value });
  }
  await updateWorkspace(record.name, { layout });

  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(session), dim(`snapshot · ${layout.length} window(s)`)]));
  else console.log(`workspace-snapshot\t${session}\t${layout.length}`);
}

/**
 * `hive workspace restore <name> [--resume]` — rebuild `ws-<name>` from the
 * record after a reboot (tmux server + bee processes gone, records persist),
 * PRD §7.3/§11. Idempotent: restoring a live workspace re-attaches/links without
 * double-spawning (PRD §13). Delegates to the shared restore core.
 */
async function workspaceRestore(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace restore <name> [--resume]");
  const record = await resolveWorkspaceRecord(name);
  if (!record) throw new Error(`Unknown workspace: ${name}`);
  const result = await restoreWorkspaceRecord(record, { resume: truthy(flag(parsed, "resume")) });
  if (isPretty()) {
    console.log(actionLine("ok", "workspace", [bold(result.session), dim(`restored · ${result.beeCount} bee(s), ${result.paneCount} pane(s)`)]));
  } else {
    console.log(`workspace-restored\t${result.session}\t${result.beeCount}\t${result.paneCount}`);
  }
}

/**
 * Shared restore core for `workspace restore <name>` and `restore --all`. Rebuilds
 * `ws-<name>` from the record, reusing the same open/add helpers (no duplicated
 * link logic): ensure the session, recreate pane members at rootDir, re-spawn or
 * (idempotently) re-link bee members, then re-apply the saved layout geometry.
 *
 * Restore is purely additive — it NEVER kills a bee, and never double-spawns one
 * that is already alive (PRD §13). `reviveRecord` re-spawns each bee into ITS OWN
 * home with no account switch, so there is no cross-account hazard.
 */
async function restoreWorkspaceRecord(record: WorkspaceRecord, opts: { resume: boolean }): Promise<{ session: string; beeCount: number; paneCount: number }> {
  const rootDir = await resolveWorkspaceRoot(undefined, record);
  // Persist the resolved root on first restore (when it was empty and resolved
  // from the colony or cwd), exactly as workspaceOpen does — so the record and
  // the rebuilt session agree on the file root.
  if (record.rootDir !== rootDir) {
    await updateWorkspace(record.name, { rootDir });
  }
  const session = workspaceSessionName(record.name);

  // Same session bootstrap as workspaceOpen: ensure it, make it persist, and
  // mark the placeholder shell own so `close` can later reap it.
  const ensured = await ensureLinkSession(session);
  await setWorkspaceOptions(session);
  if (ensured.placeholder) await markWorkspaceOwnWindow(session, ensured.placeholder);

  // Pane members: recreate a window at rootDir per pane — only when the session
  // was freshly created this call. A re-restore of a LIVE ws keeps its existing
  // panes (idempotency; native persistence already holds them).
  let paneCount = 0;
  if (ensured.created) {
    for (const member of record.members) {
      if (member.kind !== "pane") continue;
      await openWorkspacePane(session, rootDir, member.command);
      paneCount += 1;
    }
  } else {
    paneCount = record.members.filter((m) => m.kind === "pane").length;
  }

  // Bee members: same resolution as workspaceOpen (records keyed by id ?? name).
  const records = await listSessions();
  const byId = new Map(records.map((r) => [r.id ?? r.name, r] as const));
  const liveNames = new Set(await localSubstrate().listSessions());
  const beeTargets: string[] = [];
  const seenBees = new Set<string>();
  let beeCount = 0;
  for (const member of record.members) {
    if (member.kind !== "bee") continue;
    // Defensive against a hand-edited record with a duplicate bee member: process
    // each beeId once so we never revive (or double-count) the same bee twice.
    if (seenBees.has(member.beeId)) continue;
    seenBees.add(member.beeId);
    const bee = byId.get(member.beeId) ?? records.find((r) => r.name === member.beeId);
    if (bee && bee.node && bee.node !== LOCAL_NODE_NAME) {
      // link-window cannot cross tmux servers; leave a remote bee for its node.
      console.error(note(`skip remote bee ${member.beeId} — restore links local windows only`));
      continue;
    }
    if (bee && liveNames.has(bee.tmuxTarget)) {
      // ALREADY live — never double-spawn (PRD §13). Just link it in + stamp.
      beeTargets.push(bee.tmuxTarget);
      beeCount += 1;
      await stampWorkspaceMembership(bee, record.name);
      continue;
    }
    if (bee) {
      // Dead bee with a record: re-spawn it into its own home. Default re-spawns
      // fresh; --resume continues from providerSessionId via resumeArgs.
      const revived = await reviveRecord(bee, { fresh: !opts.resume });
      // Re-read liveness: the freshly created session's window links in below.
      beeTargets.push(revived.tmuxTarget);
      beeCount += 1;
      await stampWorkspaceMembership(revived, record.name);
      continue;
    }
    // No record for beeId: a dead placeholder. Open a held shell window at the
    // root named after the bee so the user can re-spawn into it; mark it own so
    // `close` can reap it (it carries no live agent).
    await openWorkspacePlaceholder(session, rootDir, member.beeId);
    console.error(note(`could not revive bee ${member.beeId} — no record; left a placeholder window`));
  }
  // Link freshly-live bee windows into the session (the workspaceOpen path —
  // never reinvent link logic).
  await linkTargetsInto(session, beeTargets, ensured);

  // Phase 2 geometry: re-apply each window's saved window_layout by matching
  // window_name. Best-effort — a missing window is skipped; on a name collision
  // entries apply in order to whichever windows currently match.
  await applyWorkspaceLayout(session, record.layout ?? []);

  return { session, beeCount, paneCount };
}

/** Stamp a bee's workspaceId (and refresh its derived ws: tag) — workspaceOpen pattern. */
async function stampWorkspaceMembership(bee: SessionRecord, workspaceName: string): Promise<void> {
  if (bee.workspaceId === workspaceName) return;
  await updateSession(bee.name, { workspaceId: workspaceName });
  await writeHiveTags({ ...bee, workspaceId: workspaceName });
}

/** A dead bee with no record: a window the user can re-spawn into (held shell, marked own). */
async function openWorkspacePlaceholder(session: string, rootDir: string, label: string): Promise<void> {
  // A bare interactive shell holds the window open without a live agent.
  await openWorkspacePane(session, rootDir);
  // Best-effort label so the user recognizes which bee it stands in for.
  const result = await tmux(["list-windows", "-t", `=${session}:`, "-F", "#{window_id}"], { reject: false });
  const last = (result.ok ? result.stdout.split("\n").filter(Boolean) : []).at(-1);
  if (last) await tmux(["rename-window", "-t", `=${session}:${last}`, label], { reject: false });
}

/** Re-apply saved per-window geometry by matching window_name (best-effort). */
async function applyWorkspaceLayout(session: string, layout: WorkspaceLayoutEntry[]): Promise<void> {
  if (layout.length === 0) return;
  const result = await tmux(["list-windows", "-t", `=${session}:`, "-F", "#{window_id}\t#{window_name}"], { reject: false });
  // window_name → ordered window_ids (a name may map to several windows).
  const byName = new Map<string, string[]>();
  for (const line of (result.ok ? result.stdout.split("\n") : []).filter(Boolean)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const windowId = line.slice(0, tab);
    const windowName = line.slice(tab + 1);
    const ids = byName.get(windowName);
    if (ids) ids.push(windowId);
    else byName.set(windowName, [windowId]);
  }
  for (const entry of layout) {
    const windowId = byName.get(entry.windowName)?.shift();
    if (!windowId) continue; // missing window — skip
    await tmux(["select-layout", "-t", `=${session}:${windowId}`, entry.layout], { reject: false });
  }
}

/**
 * `hive restore --all [--resume]` — sweep every NON-archived workspace and
 * rebuild it after a reboot (PRD §7.3/§11). Idempotent across the sweep (live
 * bees are skipped, never re-spawned). Without `--all`, prints usage.
 */
async function cmdRestore(parsed: Parsed) {
  if (!truthy(flag(parsed, "all"))) {
    throw new Error("Usage: hive restore --all [--resume]   (or: hive workspace restore <name> [--resume])");
  }
  const resume = truthy(flag(parsed, "resume"));
  const workspaces = (await listWorkspaces()).filter((w) => !w.archived);
  let restored = 0;
  let bees = 0;
  let panes = 0;
  for (const record of workspaces) {
    const result = await restoreWorkspaceRecord(record, { resume });
    restored += 1;
    bees += result.beeCount;
    panes += result.paneCount;
    if (isPretty()) {
      console.log(actionLine("ok", "workspace", [bold(result.session), dim(`restored · ${result.beeCount} bee(s), ${result.paneCount} pane(s)`)]));
    } else {
      console.log(`workspace-restored\t${result.session}\t${result.beeCount}\t${result.paneCount}`);
    }
  }
  if (isPretty()) console.log(note(`restored ${restored} workspace(s) · ${bees} bee(s), ${panes} pane(s)`));
  else console.log(`restore\tall\t${restored}\t${bees}\t${panes}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QUESTS (WORKSPACES_AND_QUESTS_PRD §8, increment 9a — create/start/list/inspect)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function cmdQuest(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case "create":
      return questCreate(parsed);
    case "start":
      return questStart(parsed);
    case undefined:
    case "list":
    case "ls":
      return questList(parsed);
    case "inspect":
      return questInspect(parsed);
    case "done":
      return questDone(parsed);
    case "archive":
      return questArchive(parsed);
    default:
      throw new Error(`Unknown quest subcommand: ${sub}\nUsage: hive quest <create|start|list|inspect|done|archive>`);
  }
}

/**
 * Slugify a quest title into a colony name (COLONY_NAME_RE:
 * /^[A-Za-z0-9][A-Za-z0-9_-]*$/): lowercase, collapse runs of unsafe chars into
 * a single dash, trim leading/trailing dashes. Falls back to "quest" if nothing
 * usable survives (e.g. a title of only punctuation).
 */
function colonySlugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "quest";
}

/** Ensure a colony exists by name, creating it if missing; return its name. */
async function ensureColony(name: string): Promise<string> {
  const existing = await loadColony(name);
  if (existing) {
    if (existing.archived) throw new Error(`Colony is archived: ${name}`);
    return existing.name;
  }
  const created = await createColony(name);
  return created.name;
}

async function questCreate(parsed: Parsed) {
  const positionalTitle = parsed.args[1];
  const linear = stringFlag(parsed, ["linear"]);
  let description = stringFlag(parsed, ["description"]);

  // LINEAR ENRICHMENT (PRD §8.2/§8.3, side-effect-gated READ): only when
  // `--linear` is given, and only via the adapter the gate hands us. With no
  // LINEAR_API_KEY the adapter is null and we stay fully OFFLINE — the id is
  // recorded verbatim and nothing is fetched. The fetch result seeds the title
  // (only when no positional title was given — an explicit positional ALWAYS
  // wins) and the description (only when --description did not override it).
  let title = positionalTitle;
  let linearSeededNote: string | undefined;
  if (linear) {
    if (!isLinearIdentifier(linear)) {
      throw new Error(`--linear expects an issue identifier like ENG-1234 (got: ${linear})`);
    }
    const adapter = loadLinearAdapter();
    if (adapter) {
      const issue = await adapter.fetchIssue(linear);
      if (issue) {
        // Track what we ACTUALLY seeded at the assignment site (don't infer it by
        // value-comparing afterward — an explicit --description that happens to
        // equal the issue's would otherwise be misreported as seeded).
        const seeded: string[] = [];
        if (!positionalTitle && issue.title) { title = issue.title; seeded.push("title"); }
        if (!description && issue.description) { description = issue.description; seeded.push("description"); }
        linearSeededNote = `seeded from ${linear}${seeded.length ? ` (${seeded.join(", ")})` : ""}`;
      } else {
        // A configured adapter that misses (not found / API error already warned
        // by the adapter): no enrichment, fall through to the title requirement.
        linearSeededNote = `${linear}: no issue fetched — recorded id, no enrichment`;
      }
    } else {
      // OFFLINE NO-OP: no LINEAR_API_KEY. Record the id verbatim, no network.
      linearSeededNote = `Linear not configured (set LINEAR_API_KEY) — recorded ${linear}, no enrichment`;
    }
  }

  // Title is required UNLESS Linear enrichment supplied one. A missing title with
  // no usable Linear title (no positional AND (no adapter OR a fetch miss)) is a
  // clean usage error — we never invent a title.
  if (!title) {
    if (linear) {
      throw new Error(
        `hive quest create --linear ${linear}: a title is required because Linear did not supply one ` +
          `(no LINEAR_API_KEY, or the issue was not found). Pass a positional title.`,
      );
    }
    throw new Error('Usage: hive quest create "<title>" [--colony <c>] [--root <dir>] [--linear <issue>]');
  }

  // A quest ALWAYS lives in a colony (PRD §8.2 / open-question #5 decided yes):
  // use/create the named one, else auto-create from the title slug.
  const colonyFlag = stringFlag(parsed, ["colony"]);
  const colony = colonyFlag ? await ensureColony(colonyFlag) : await ensureColony(colonySlugFromTitle(title));

  const id = generateQuestId();

  // The quest OWNS A DEDICATED workspace named after the quest id — NOT the
  // colony's shared workspace, so a later `quest done` that closes the quest's
  // workspace can never nuke a colony-shared one. Resolve the file root from
  // --root › colony.rootDir › cwd.
  const rootDir = await resolveQuestRoot(stringFlag(parsed, ["root"]), colony);
  await createWorkspace({ name: id, rootDir, colony });
  await updateWorkspace(id, { questId: id });

  const record = await createQuest({
    id,
    title,
    colony,
    workspace: id,
    status: "open",
    ...(linear ? { linearIssueId: linear } : {}),
    ...(description ? { description } : {}),
  });

  if (linearSeededNote) console.error(note(`linear ${linearSeededNote}`));

  const session = workspaceSessionName(record.workspace);
  if (isPretty()) {
    console.log(actionLine("ok", "quest", [bold(record.id), dim(`"${record.title}"`), dim(`colony:${record.colony}`), dim(session)]));
    console.error(note(`start work with: hive quest start ${record.id} --frame <frame>`));
  } else {
    console.log(`quest-created\t${record.id}\t${record.colony}\t${record.workspace}`);
  }
}

/** Resolve a quest workspace's file root: --root › colony.rootDir › cwd. */
async function resolveQuestRoot(rootFlag: string | undefined, colony: string): Promise<string> {
  if (rootFlag) {
    return realpath(resolve(rootFlag.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))).catch(() => resolve(rootFlag));
  }
  const record = await loadColony(colony);
  if (record?.rootDir && record.rootDir.length > 0) return record.rootDir;
  return process.cwd();
}

/** Resolve a quest by exact id, then by unique prefix (the swarm/colony nicety). */
async function resolveQuestRecord(idArg: string): Promise<QuestRecord | null> {
  const direct = await loadQuest(idArg);
  if (direct) return direct;
  if (!validQuestId(idArg)) return null;
  const quests = await listQuests();
  const matches = quests.filter((q) => q.id.startsWith(idArg));
  return matches.length === 1 ? matches[0]! : null;
}

async function questStart(parsed: Parsed) {
  const idArg = parsed.args[1];
  if (!idArg) throw new Error("Usage: hive quest start <id> --frame <f>");

  // --flow and --frame are mutually exclusive; --flow wins its own branch.
  if (hasFlag(parsed, "flow")) return questStartFlow(parsed, idArg);
  const frameName = stringFlag(parsed, ["frame"]);
  if (!frameName) throw new Error("hive quest start requires --frame <f> or --flow <f>");

  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);
  if (quest.status === "archived" || quest.status === "done") {
    throw new Error(`Quest ${quest.id} is ${quest.status}; cannot start work on it`);
  }

  // Spawn the swarm with the quest's colony injected — the bees MUST carry the
  // quest's colony (PRD §8.2), not whatever --colony the user typed. We clone the
  // Parsed and overwrite the colony/frame flags, then call the existing
  // spawnFromFrame: this needs NO change to that hot path (it already reads
  // --colony via resolveSpawnColony and --frame), and keeps swarm-record
  // creation, readiness waiting, and the swarmId hint all in one place.
  const questFlags = new Map(parsed.flags);
  questFlags.set("colony", quest.colony);
  questFlags.set("frame", frameName);
  // A quest-level --brief override lands with the flow/Linear increment; for now
  // briefs come from the frame's castes, so drop any stray --brief rather than let
  // spawnFromFrame reject the whole spawn (it forbids --brief with --frame).
  questFlags.delete("brief");
  const questParsed: Parsed = { ...parsed, flags: questFlags };

  const records = await spawnFromFrame(questParsed, frameName);
  if (records.length === 0) throw new Error(`Frame ${frameName} spawned no bees`);

  // Stamp every spawned bee with the quest id (and re-stamp colony defensively)
  // so the derived quest:<id> tag lights up, and link each bee's window into the
  // quest's workspace — reusing the workspace link path, never reinventing it.
  const session = workspaceSessionName(quest.workspace);
  const ensured = await ensureLinkSession(session);
  await setWorkspaceOptions(session);
  if (ensured.placeholder) await markWorkspaceOwnWindow(session, ensured.placeholder);

  const inventory = await windowInventory();
  const liveNames = new Set(await localSubstrate().listSessions());
  const wsRecord = await loadWorkspace(quest.workspace);
  const members: WorkspaceMember[] = wsRecord ? [...wsRecord.members] : [];
  const memberIds = new Set(members.filter((m) => m.kind === "bee").map((m) => (m as { beeId: string }).beeId));
  const beeTargets: string[] = [];
  for (const bee of records) {
    await stampQuestMembership(bee, quest.id, quest.colony, quest.workspace);
    // Only local + live windows can be link-window'd (the workspaceAdd discipline).
    if (bee.node && bee.node !== LOCAL_NODE_NAME) continue;
    if (!liveNames.has(bee.tmuxTarget)) continue;
    const windowId = inventory.active.get(bee.tmuxTarget);
    if (!windowId) continue; // no live window to link — never record a phantom member
    beeTargets.push(bee.tmuxTarget);
    const beeId = bee.id ?? bee.name;
    if (!memberIds.has(beeId)) {
      members.push({ kind: "bee", beeId });
      memberIds.add(beeId);
    }
  }
  await linkTargetsInto(session, beeTargets, ensured);
  // Persist the bee membership on the workspace so a later restore brings them
  // back (converges with the workspace add/open invariant).
  await updateWorkspace(quest.workspace, { members });

  // Flip the quest to active: stamp activatedAt (first activation only) and
  // append the swarm id. The swarm id is the frame's swarm hint (spawnFromFrame
  // created it); read it off the freshly spawned bees.
  const swarmId = records.find((r) => r.swarmId)?.swarmId;
  const swarmIds = swarmId && !quest.swarmIds.includes(swarmId) ? [...quest.swarmIds, swarmId] : quest.swarmIds;
  await updateQuest(quest.id, {
    status: "active",
    swarmIds,
    ...(quest.activatedAt ? {} : { activatedAt: new Date().toISOString() }),
  });

  if (isPretty()) {
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(swarmId ? `@${swarmId}` : ""), `${records.length} bee(s)`, dim(session)]));
  } else {
    console.log(`quest-started\t${quest.id}\t${swarmId ?? ""}\t${records.length}`);
  }
}

/**
 * `hive quest start <id> --flow <name>` — run a flow in the FOREGROUND and adopt
 * every bee it spawns into the quest, reaching the SAME end state as the --frame
 * path: each bee carries questId + the quest's colony + workspaceId, each live
 * local window is linked into ws-<id>, the workspace members are persisted, the
 * flow's swarm cohort is appended to quest.swarmIds, and the quest is flipped to
 * active (on success only).
 *
 * Foreground-only in this increment: the per-spawn stamp/link happens in-process
 * via the onSpawned hook, which closes over the ensured link session + members
 * accumulator. A --background child re-execs in a different process where that
 * closure does not exist (spawnDetachedRun cannot carry a JS callback across the
 * fork), so --flow --background is an explicit, guarded later-increment throw.
 */
async function questStartFlow(parsed: Parsed, idArg: string): Promise<void> {
  if (hasFlag(parsed, "background")) {
    throw new Error("hive quest start --flow --background lands in a later increment");
  }
  const flowName = stringFlag(parsed, ["flow"]);
  if (!flowName) throw new Error("Usage: hive quest start <id> --flow <name> [--arg key=value]...");

  // Resolve + validate the quest BEFORE loading the flow so a bad id fails fast.
  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);
  if (quest.status === "archived" || quest.status === "done") {
    throw new Error(`Quest ${quest.id} is ${quest.status}; cannot start work on it`);
  }

  const flow = await loadFlow(flowName);
  if (!flow) throw new Error(`Unknown flow: ${flowName}`);
  const args = parseFlowRunArgs(parsed);

  // Prepare the quest's link session ONCE up front (mirror the --frame path) so
  // ws-<id> exists before the first bee spawns and has a host for the link.
  const session = workspaceSessionName(quest.workspace);
  const ensured = await ensureLinkSession(session);
  await setWorkspaceOptions(session);
  if (ensured.placeholder) await markWorkspaceOwnWindow(session, ensured.placeholder);

  // Seed the members accumulator from the existing workspace record. The
  // onSpawned hook appends to `members` as each bee spawns; we persist it once
  // after the flow returns (members are records, so they survive kill-on-end).
  const wsRecord = await loadWorkspace(quest.workspace);
  const members: WorkspaceMember[] = wsRecord ? [...wsRecord.members] : [];
  const memberIds = new Set(members.filter((m) => m.kind === "bee").map((m) => (m as { beeId: string }).beeId));

  // Per-spawn hook: replicate the --frame loop body for ONE bee. Liveness +
  // the window inventory MUST be re-read per spawn — bees spawn over time, so a
  // single up-front snapshot (as in the --frame path) would miss later windows.
  const onSpawned = async (bee: SessionRecord): Promise<void> => {
    await stampQuestMembership(bee, quest.id, quest.colony, quest.workspace);
    // Only local + live windows can be link-window'd (the workspaceAdd discipline).
    if (bee.node && bee.node !== LOCAL_NODE_NAME) return;
    if (!(await localSubstrate().hasSession(bee.tmuxTarget))) return;
    const inventory = await windowInventory();
    const windowId = inventory.active.get(bee.tmuxTarget);
    if (!windowId) return; // no live window to link — never record a phantom member
    await linkTargetsInto(session, [bee.tmuxTarget], ensured);
    const beeId = bee.id ?? bee.name;
    if (!memberIds.has(beeId)) {
      members.push({ kind: "bee", beeId });
      memberIds.add(beeId);
    }
  };

  // The flow's cohort swarmId is the facade default `flow:<name>:run:<runId>`.
  // Reconstruct it (don't read it off a bee) so a zero-spawn flow still records
  // the cohort and it never depends on a bee surviving cleanup.
  const runId = generateRunId();
  const swarmId = `flow:${flow.name}:run:${runId}`;
  if (isPretty()) {
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(`flow ${flow.name}`), dim(`run ${runId}`)]));
  } else {
    console.log(`quest-flow\t${quest.id}\t${flow.name}\t${runId}`);
  }

  let outcome: Awaited<ReturnType<typeof executeFlow>>;
  try {
    // cleanupOverride:"keep" defeats a flow's kill-on-end — the quest owns its
    // bees. Foreground (no installSignalHandlers override) so SIGINT aborts the
    // run exactly like `hive flow run`.
    outcome = await executeFlow(flow, { args, runId, onSpawned, cleanupOverride: "keep" });
  } finally {
    // Persist members REGARDLESS of outcome so the workspace reflects whatever
    // bees were spawned + linked, even on a failed/cancelled run (the safe
    // partial state — these bees are real quest members, not orphans).
    await updateWorkspace(quest.workspace, { members });
  }

  // Flip the quest active ONLY on success: a crashed/aborted flow must never
  // leave a phantom-active quest. Append the cohort swarmId either way is wrong
  // — only record it when we actually activate.
  if (outcome.status === "ok") {
    const swarmIds = quest.swarmIds.includes(swarmId) ? quest.swarmIds : [...quest.swarmIds, swarmId];
    await updateQuest(quest.id, {
      status: "active",
      swarmIds,
      ...(quest.activatedAt ? {} : { activatedAt: new Date().toISOString() }),
    });
  }

  if (isPretty()) {
    const colored = outcome.status === "ok" ? green("ok")
      : outcome.status === "cancelled" ? yellow("cancelled")
      : outcome.status === "failed" ? red("failed")
      : dim(outcome.status);
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(`@${swarmId}`), dim(`${members.length} bee(s)`), colored]));
    if (outcome.error?.message) console.error(dim(`error: ${outcome.error.message}`));
  } else {
    console.log(`quest-started\t${quest.id}\t${swarmId}\t${members.length}\t${outcome.status}`);
  }
  if (outcome.status === "failed") process.exitCode = 1;
  if (outcome.status === "cancelled") process.exitCode = 130;
}

/**
 * Stamp a bee's questId (+ colony) so the derived quest:<id> / colony: tags
 * refresh (the stampWorkspaceMembership pattern). A quest never silently fails to
 * stamp a bee — that is the heart of acceptance Q1.
 */
async function stampQuestMembership(bee: SessionRecord, questId: string, colony: string, workspaceName: string): Promise<void> {
  const patch: Partial<SessionRecord> = {};
  if (bee.questId !== questId) patch.questId = questId;
  if (bee.colony !== colony) patch.colony = colony;
  if (bee.workspaceId !== workspaceName) patch.workspaceId = workspaceName;
  if (Object.keys(patch).length === 0) return;
  await updateSession(bee.name, { ...patch, updatedAt: new Date().toISOString() });
  await writeHiveTags({ ...bee, ...patch });
}

async function questList(parsed: Parsed) {
  const colonyFilter = stringFlag(parsed, ["colony"]);
  const statusFilter = stringFlag(parsed, ["status"]);
  let quests = await listQuests();
  // Archived quests are excluded from default listings (archive handling proper
  // is increment 9b); a `--status archived` request can still surface them.
  if (statusFilter !== "archived") quests = quests.filter((q) => q.status !== "archived");
  if (colonyFilter) quests = quests.filter((q) => q.colony === colonyFilter);
  if (statusFilter) quests = quests.filter((q) => q.status === statusFilter);

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(quests, null, 2));
    return;
  }
  if (!isPretty()) {
    for (const q of quests) {
      console.log(`${q.status}\t${q.id}\t${q.colony}\t${q.workspace}\t${q.swarmIds.length}\t${q.title}`);
    }
    return;
  }
  if (quests.length === 0) {
    console.log(dim('No quests. Create one with: hive quest create "<title>" [--colony <c>]'));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "ID" },
      { header: "COLONY" },
      { header: "WORKSPACE" },
      { header: "SWARMS", align: "right" },
      { header: "TITLE" },
      { header: "AGE", align: "right" },
    ],
    quests.map((q) => [
      questStatusColor(q.status),
      bold(q.id),
      dim(q.colony),
      dim(q.workspace),
      String(q.swarmIds.length),
      truncate(q.title, 40),
      dim(formatRelativeTime(q.createdAt)),
    ]),
  ));
}

function questStatusColor(status: QuestStatus): string {
  switch (status) {
    case "active":
      return green("active");
    case "open":
      return cyan("open");
    case "done":
      return gray("done");
    case "archived":
      return gray("archived");
  }
}

async function questInspect(parsed: Parsed) {
  const idArg = parsed.args[1];
  if (!idArg) throw new Error("Usage: hive quest inspect <id>");
  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);

  // Roll up the quest's bees by filtering the store for questId===id (the same
  // set the quest:<id> selector resolves, but read directly so inspect stays a
  // cheap store-only read with no live tmux probe).
  const bees = (await listSessions()).filter((b) => b.questId === quest.id);
  const beeSummary = bees.map((b) => ({
    name: b.name,
    agent: b.agent,
    caste: b.caste,
    status: b.status,
    state: b.lastObservedState,
  }));

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ ...quest, bees: beeSummary }, null, 2));
    return;
  }

  if (isPretty()) {
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(`"${quest.title}"`), questStatusColor(quest.status)]));
    console.log(`  ${dim("colony")}    ${quest.colony}`);
    console.log(`  ${dim("workspace")} ${workspaceSessionName(quest.workspace)}`);
    console.log(`  ${dim("swarms")}    ${quest.swarmIds.length > 0 ? quest.swarmIds.map((s) => `@${s}`).join(" ") : dim("none")}`);
    if (quest.linearIssueId) console.log(`  ${dim("linear")}    ${quest.linearIssueId}`);
    console.log(`  ${dim("bees")}      ${bees.length}`);
    for (const b of beeSummary) {
      // A filed bee shows `archived` (it stays in the live store by questId, so
      // inspect surfaces it even though the default selector path excludes it).
      const state = b.status === "archived" ? gray("archived") : b.status === "running" ? green(b.state ?? "running") : gray(b.status);
      console.log(`    ${bold(b.name)} ${dim(b.caste ? `caste:${b.caste}` : b.agent)} ${state}`);
    }
  } else {
    console.log(`quest\t${quest.id}\t${quest.status}\t${quest.colony}\t${quest.workspace}\t${quest.swarmIds.join(",")}\t${quest.linearIssueId ?? ""}`);
    for (const b of beeSummary) {
      console.log(`bee\t${b.name}\t${b.caste ?? b.agent}\t${b.status}\t${b.state ?? ""}`);
    }
  }
}

/**
 * `hive quest done <id> [--keep-bees] [--close-linear]` — file the quest's work
 * and complete it (PRD §8.4, acceptance Q2). The strict ordering is the safety
 * spine: FILE (copy seals + the final workspace snapshot) BEFORE any destructive
 * step, so a crash never loses a seal or the geometry; SNAPSHOT the workspace
 * BEFORE closing it; KILL transactionally; mark archived ONLY the bees we
 * confirmed killed (a kill_failed or a kept-alive bee is NEVER marked archived —
 * the cardinal invariant: never hide a live bee from `list`); then CLOSE the
 * workspace with the safe close (which never kills a bee, and aborts rather than
 * orphan one); finally flip the quest to done. The whole flow is restartable.
 */
async function questDone(parsed: Parsed) {
  const idArg = parsed.args[1];
  if (!idArg) throw new Error("Usage: hive quest done <id> [--keep-bees] [--close-linear]");
  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);
  // Idempotency guard (mirrors questStart): a quest that is already done/archived
  // has already been filed; don't re-run the destructive flow.
  if (quest.status === "done" || quest.status === "archived") {
    throw new Error(`Quest ${quest.id} is already ${quest.status}`);
  }

  const keepBees = truthy(flag(parsed, "keep-bees"));

  // 1. Gather members directly from the store by questId (NOT resolveSelector —
  //    some may already be archived from a prior partial run, and the selector
  //    path excludes archived).
  const bees = (await listSessions()).filter((b) => b.questId === quest.id);

  // 3. SNAPSHOT the quest workspace geometry (before close) so the filed
  //    workspace.json carries live window layouts.
  const wsSession = workspaceSessionName(quest.workspace);
  if (await hasSession(wsSession)) {
    const result = await tmux(["list-windows", "-t", `=${wsSession}:`, "-F", "#{window_name}\t#{window_layout}"], { reject: false });
    const layout: WorkspaceLayoutEntry[] = [];
    for (const line of (result.ok ? result.stdout.split("\n") : []).filter(Boolean)) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const windowName = line.slice(0, tab);
      const value = line.slice(tab + 1);
      if (!windowName || !value) continue;
      layout.push({ windowName, layout: value });
    }
    await updateWorkspace(quest.workspace, { layout });
  }
  const wsRecord = await loadWorkspace(quest.workspace);

  // 4. FILE ARCHIVE under quests/<id>/ — a COPY, BEFORE any destructive step.
  const dir = questDir(quest.id);
  await mkdir(dir, { recursive: true });
  // 4a. Seals: copy every member's seals (read-only collection — bees seal
  //     themselves; absence of a seal is not an error). The live sealsRoot is
  //     never moved, so a crash here leaves seals duplicated (benign), not lost.
  let filedSealBees = 0;
  for (const bee of bees) {
    const copied = await copyBeeSeals(bee.name, join(dir, "seals"));
    if (copied > 0) filedSealBees += 1;
  }
  // 4b. Final workspace snapshot (geometry + members) for reconstruction.
  if (wsRecord) {
    await writeFile(join(dir, "workspace.json"), `${JSON.stringify(wsRecord, null, 2)}\n`, { mode: 0o600 });
  }
  // 4c. Manifest: each member's final SessionRecord so a filed bee is
  //     reconstructable even after its live record is later kill-deleted.
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify({ questId: quest.id, filedAt: new Date().toISOString(), bees }, null, 2)}\n`,
    { mode: 0o600 },
  );

  // 5./6. KILL (unless --keep-bees) + mark ONLY confirmed-killed bees archived.
  // A quest bee's window is LINKED into ws-<id> (quest start link-window'd it):
  // killing the bee's own session leaves that window orphaned in the ws (its only
  // remaining link), which the safe close would then refuse as a "last link". So
  // for each CONFIRMED-killed bee we reap its now-dead orphan window from the ws
  // with `unlink-window -k` — killing a confirmed-dead window is debris cleanup,
  // never killing a live bee. A kept/kill_failed (live) bee's window is left for
  // the safe close to safe-unlink (it survives via the bee's own session).
  const inventory = (await hasSession(wsSession)) ? await windowInventory() : undefined;
  const outcomes: Array<{ name: string; result: "archived" | "kept" | "kill_failed" }> = [];
  if (!keepBees) {
    for (const bee of bees) {
      if (bee.status === "archived") {
        // Already filed by a prior partial run — leave it archived.
        outcomes.push({ name: bee.name, result: "archived" });
        continue;
      }
      // Capture the record + ws window id BEFORE the kill: transactionalKill
      // deletes the record on confirmed death, and the window id is needed to
      // reap the orphan afterwards.
      const snapshot = { ...bee };
      const wsWindowId = inventory?.active.get(bee.tmuxTarget);
      const outcome = await transactionalKill(bee);
      if (outcome.ok) {
        // Re-create the index record with status:"archived" — the live store
        // stays the index (PRD §16 #4), the bee is filed not deleted.
        await saveSession({ ...snapshot, status: "archived", updatedAt: new Date().toISOString() });
        // Reap the now-dead orphan window from the ws (the bee is confirmed gone).
        if (wsWindowId) await tmux(["unlink-window", "-k", "-t", wsWindowId], { reject: false });
        outcomes.push({ name: bee.name, result: "archived" });
      } else {
        // A kill_failed bee may still be running — leave it kill_failed, do NOT
        // archive it (never hide a possibly-live bee), and leave its window for
        // the safe close to safe-unlink.
        outcomes.push({ name: bee.name, result: "kill_failed" });
      }
    }
  } else {
    // --keep-bees: bees stay alive → NEVER mark them archived (that would hide a
    // live bee from `list`, the cardinal invariant). They keep status:"running".
    for (const bee of bees) outcomes.push({ name: bee.name, result: "kept" });
  }

  // 7. CLOSE the quest workspace with the safe close (never kills a bee; aborts
  //    rather than orphan a still-live --keep-bees window). If it throws, the
  //    quest is left NOT-done and surfaces the error — no silent bee loss. The
  //    confirmed-dead orphan windows were already reaped above, so the safe close
  //    sees only our own windows + any live (kept/kill_failed) bee windows.
  if (await hasSession(wsSession)) {
    await closeWorkspaceSession(wsSession);
  }
  await archiveWorkspace(quest.workspace).catch(() => undefined);

  // 8. Flip the quest to done (emits the quest.done ledger event).
  const updated = await updateQuest(quest.id, { status: "done", completedAt: new Date().toISOString() });

  // 9. --close-linear (side-effect-gated WRITE, best-effort): transition the
  //    quest's Linear issue to Done. The quest is ALREADY done by this point, so
  //    a Linear failure is a side effect that NEVER fails `quest done`.
  if (truthy(flag(parsed, "close-linear"))) {
    if (!updated.linearIssueId) {
      console.error(note("--close-linear: this quest has no Linear issue — nothing to close"));
    } else {
      const adapter = loadLinearAdapter();
      if (!adapter) {
        // OFFLINE NO-OP: no LINEAR_API_KEY.
        console.error(note(`--close-linear: Linear not configured (set LINEAR_API_KEY) — left ${updated.linearIssueId} untouched`));
      } else {
        const closed = await adapter.closeIssue(updated.linearIssueId);
        if (closed) console.error(note(`--close-linear: transitioned ${updated.linearIssueId} to Done`));
        else console.error(note(`--close-linear: could not close ${updated.linearIssueId} (best-effort; quest is still done)`));
      }
    }
  }

  const killFailed = outcomes.filter((o) => o.result === "kill_failed").map((o) => o.name);
  if (killFailed.length > 0) {
    console.error(note(`${killFailed.length} bee(s) failed to die and stay visible (kill_failed): ${killFailed.join(", ")}`));
  }
  if (isPretty()) {
    const beeNote = keepBees ? `${bees.length} bee(s) kept` : `${outcomes.filter((o) => o.result === "archived").length} bee(s) filed`;
    console.log(actionLine("ok", "quest", [bold(updated.id), dim("done"), dim(beeNote), dim(`${filedSealBees} sealed`)]));
  } else {
    console.log(`quest-done\t${updated.id}\t${outcomes.filter((o) => o.result === "archived").length}\t${killFailed.length}`);
  }
}

/**
 * `hive quest archive <id>` — the post-done filing flip (done → archived, PRD
 * §8.4). A pure quest-record state flip: it does NOT re-touch bees or the
 * workspace (already handled by `done`). Idempotent: archiving an archived quest
 * is a no-op. Surfaces in `quest list --status archived`.
 */
async function questArchive(parsed: Parsed) {
  const idArg = parsed.args[1];
  if (!idArg) throw new Error("Usage: hive quest archive <id>");
  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);
  if (quest.status === "archived") {
    if (isPretty()) console.log(actionLine("ok", "quest", [bold(quest.id), dim("already archived")]));
    else console.log(`quest-archived\t${quest.id}`);
    return;
  }
  // Archive is the lifecycle flip after done; require done first so the work was
  // filed (quest done copies seals + snapshot before archiving is meaningful).
  if (quest.status !== "done") {
    throw new Error(`Quest ${quest.id} is ${quest.status}; run 'hive quest done ${quest.id}' before archiving`);
  }
  const updated = await updateQuest(quest.id, { status: "archived", archivedAt: new Date().toISOString() });
  if (isPretty()) console.log(actionLine("ok", "quest", [bold(updated.id), dim("archived")]));
  else console.log(`quest-archived\t${updated.id}`);
}

async function workspaceClose(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace close <name>");
  const session = workspaceSessionName(name);
  if (!(await hasSession(session))) throw new Error(`No such workspace session: ${session}`);
  const result = await closeWorkspaceSession(session);
  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(session), dim(`closed, ${result.unlinked} bee window(s) unlinked`)]));
  else console.log(`workspace-closed\t${session}\t${result.unlinked}`);
}

/**
 * Tear down a workspace session WITHOUT ever killing a bee (the view invariant,
 * PRD §13), while still removing the workspace's OWN windows (the throwaway
 * placeholder and shell/command panes we created).
 *
 * The discriminator is PROVENANCE, not link topology: only a window WE created
 * carries the `@hive_ws_own` marker, so only those are kill-window'd. EVERY other
 * window is treated as a bee link and is only ever safe-unlinked WITHOUT -k — and
 * if that refuses (the ws is the window's last link, i.e. an orphaned bee whose
 * home session is gone) we ABORT the whole close, leaving the workspace intact and
 * the bee alive. An earlier "linked outside this group ⇒ bee" heuristic was unsound:
 * an orphaned bee has no outside link either, so it would have been kill-window'd.
 * view's uniform safe-unlink (a view holds only bees, no own windows) stays simpler;
 * this preserves the same guarantee — a bee never loses its home to a workspace close.
 */
async function closeWorkspaceSession(session: string): Promise<{ sessions: string[]; unlinked: number }> {
  const groupSet = new Set(await tmuxGroupSessions(session));

  // Classify by PROVENANCE (the @hive_ws_own window marker), never by link
  // topology. A window the workspace created is marked and may be kill-window'd;
  // EVERY other window is a bee link and is only ever safe-unlinked WITHOUT -k,
  // aborting if it is the window's last link (an orphaned bee whose home session
  // is gone). The old "no link outside the group ⇒ ours" heuristic was unsound:
  // an orphaned bee also has no outside link, so it would have been killed.
  const listResult = await tmux(
    ["list-windows", "-t", `=${session}`, "-F", "#{window_id}\t#{@hive_ws_own}"],
    { reject: false },
  );
  const rows = listResult.ok ? listResult.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const ownWindows: string[] = [];
  const beeWindows: string[] = [];
  for (const row of rows) {
    const tab = row.indexOf("\t");
    const wid = tab >= 0 ? row.slice(0, tab) : row;
    const ownFlag = tab >= 0 ? row.slice(tab + 1).trim() : "";
    (ownFlag === "1" ? ownWindows : beeWindows).push(wid);
  }

  // First: safe-unlink every (potential) bee window, and ABORT before any
  // destruction if one refuses — so an aborted close leaves the workspace fully
  // intact and the orphaned bee alive.
  let unlinked = 0;
  for (const wid of beeWindows) {
    const result = await tmux(["unlink-window", "-t", `=${session}:${wid}`], { reject: false });
    if (!result.ok) {
      throw new Error(
        `Refusing to close ${session}: window ${wid} is a bee whose own session is gone ` +
          `(${result.stderr.trim() || "last link"}); re-home it first (hive workspace add <ws> <bee>) ` +
          `or attach to rescue it: tmux attach -t ${session}.`,
      );
    }
    unlinked += 1;
  }
  // Then: kill the windows the workspace owns, and the (now empty) group.
  for (const wid of ownWindows) {
    await tmux(["kill-window", "-t", `=${session}:${wid}`], { reject: false });
  }
  for (const s of groupSet) {
    await tmux(["kill-session", "-t", `=${s}`], { reject: false });
  }
  return { sessions: [...groupSet], unlinked };
}

/** The session group for `session` (itself + grouped `<session>-<n>` clients). */
async function tmuxGroupSessions(session: string): Promise<string[]> {
  const groupResult = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_group}"], { reject: false });
  const pairs = (groupResult.ok ? groupResult.stdout.split("\n").filter(Boolean) : []).map((line) => {
    const tab = line.indexOf("\t");
    return [tab >= 0 ? line.slice(0, tab) : line, tab >= 0 ? line.slice(tab + 1) : ""] as const;
  });
  const group = pairs.find(([s]) => s === session)?.[1] ?? "";
  const sessions = pairs
    .filter(([s, g]) => s === session || (group.length > 0 && g === group && s.startsWith(`${session}-`)))
    .map(([s]) => s);
  if (!sessions.includes(session)) sessions.unshift(session);
  return sessions;
}

async function workspaceRename(parsed: Parsed) {
  const from = parsed.args[1];
  const to = parsed.args[2];
  if (!from || !to) throw new Error("Usage: hive workspace rename <old> <new>");
  const record = await renameWorkspace(from, to);
  // Rename the live ws- session if present.
  const oldSession = workspaceSessionName(from);
  const newSession = workspaceSessionName(to);
  if (await hasSession(oldSession)) {
    // rename-session does not accept the `=name` exact prefix; target the bare
    // session name (it exists and is ws- prefixed, so no collision risk).
    await tmux(["rename-session", "-t", oldSession, newSession], { reject: false });
  }
  // Cascade workspaceId on member bees (cascadeColonyRename pattern).
  const sessions = await listSessions();
  for (const bee of sessions) {
    if (bee.workspaceId !== from) continue;
    await updateSession(bee.name, { workspaceId: to, updatedAt: new Date().toISOString() });
    await writeHiveTags({ ...bee, workspaceId: to });
  }
  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(record.name), dim(`renamed from ${from}`)]));
  else console.log(`workspace-renamed\t${from}\t${to}`);
}

async function workspaceArchive(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace archive <name>");
  const record = await archiveWorkspace(name);
  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(record.name), dim("archived")]));
  else console.log(`workspace-archived\t${record.name}`);
}

async function cmdFrame(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return frameList();
    case "define":
      return frameDefine(parsed);
    case "update":
      return frameUpdate(parsed);
    case "reload":
      return frameReload(parsed);
    case "edit":
      return frameEdit(parsed);
    case "inspect":
      return frameInspect(parsed);
    case "remove":
      return frameRemove(parsed);
    default:
      throw new Error(`Unknown frame subcommand: ${sub}\nUsage: hive frame <list|define|update|reload|edit|inspect|remove>`);
  }
}

async function frameList() {
  const frames = await listFrames();
  if (!isPretty()) {
    for (const frame of frames) {
      const total = frame.castes.reduce((sum, caste) => sum + caste.count, 0);
      console.log(`${frame.name}\t${frame.castes.length} castes\t${total} bees`);
    }
    return;
  }
  if (frames.length === 0) {
    console.log(dim("No frames defined. Register one with: hive frame define <name> <file>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "NAME" },
      { header: "CASTES", align: "right" },
      { header: "BEES", align: "right" },
      { header: "DESCRIPTION" },
    ],
    frames.map((frame) => [
      bold(frame.name),
      String(frame.castes.length),
      String(frame.castes.reduce((sum, caste) => sum + caste.count, 0)),
      dim(frame.description ?? ""),
    ]),
  ));
}

async function frameDefine(parsed: Parsed) {
  const first = parsed.args[1];
  const second = parsed.args[2];
  if (!first) throw new Error("Usage: hive frame define <path-to-frame.json|.ts> [<name>]");
  const { sourcePath, nameOverride } = resolveFrameDefineArgs(first, second);
  const frame = await defineFrameFromFile(sourcePath, nameOverride);
  if (isPretty()) console.log(actionLine("ok", "frame", [bold(frame.name), `${frame.castes.length} castes`, dim(sourcePath)]));
  else console.log(`defined\t${frame.name}\t${frame.castes.length}\t${sourcePath}`);
}

function resolveFrameDefineArgs(first: string, second?: string): { sourcePath: string; nameOverride?: string } {
  if (!second) return { sourcePath: first };
  const firstIsPath = looksLikeFramePath(first);
  const secondIsPath = looksLikeFramePath(second);
  if (firstIsPath && !secondIsPath) return { sourcePath: first, nameOverride: second };
  if (!firstIsPath && secondIsPath) return { sourcePath: second, nameOverride: first };
  return { sourcePath: first, nameOverride: second };
}

function looksLikeFramePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".json") || value.endsWith(".ts");
}

async function frameUpdate(parsed: Parsed) {
  const first = parsed.args[1];
  const second = parsed.args[2];
  if (!first) throw new Error("Usage: hive frame update <name> [path] OR hive frame update <path>");

  // hive frame update <name>  → reload from remembered source
  if (!second && !looksLikeFramePath(first)) {
    return reloadFrame(first);
  }

  let sourcePath: string;
  let targetName: string | undefined;
  if (second) {
    const { sourcePath: s, nameOverride } = resolveFrameDefineArgs(first, second);
    sourcePath = s;
    targetName = nameOverride;
  } else {
    sourcePath = first;
  }

  if (targetName !== undefined) {
    if (!(await frameExists(targetName))) {
      throw new Error(`Unknown frame: ${targetName}. Use 'hive frame define' to create a new one.`);
    }
    const frame = await defineFrameFromFile(sourcePath, targetName);
    if (isPretty()) console.log(actionLine("ok", "frame", [bold(frame.name), dim("updated"), dim(sourcePath)]));
    else console.log(`updated\t${frame.name}\t${sourcePath}`);
    return;
  }

  // No explicit target: read source, use its declared name, require it to exist.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const absolute = path.resolve(sourcePath);
  try {
    await fs.access(absolute);
  } catch {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  const ext = path.extname(absolute);
  if (ext !== ".json") throw new Error(`hive frame update reads JSON only (got ${ext}). For .ts frames, pass an explicit <name>.`);
  const raw = JSON.parse(await fs.readFile(absolute, "utf8"));
  const draft = validateFrame(raw);
  if (!(await frameExists(draft.name))) {
    throw new Error(`Unknown frame: ${draft.name}. Use 'hive frame define' to create a new one.`);
  }
  const frame = await defineFrameFromFile(sourcePath);
  if (isPretty()) console.log(actionLine("ok", "frame", [bold(frame.name), dim("updated"), dim(sourcePath)]));
  else console.log(`updated\t${frame.name}\t${sourcePath}`);
}

async function frameReload(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive frame reload <name>");
  return reloadFrame(name);
}

async function reloadFrame(name: string) {
  if (!(await frameExists(name))) throw new Error(`Unknown frame: ${name}`);
  const source = await loadFrameSource(name);
  if (!source) {
    throw new Error(`No source path recorded for frame ${name}. Re-import once with: hive frame define <path>`);
  }
  const fs = await import("node:fs/promises");
  try {
    await fs.access(source);
  } catch {
    throw new Error(`Source file no longer exists: ${source}\nRe-import with: hive frame define <new-path> ${name}`);
  }
  const frame = await defineFrameFromFile(source, name);
  if (isPretty()) console.log(actionLine("ok", "frame", [bold(frame.name), dim("reloaded"), dim(source)]));
  else console.log(`reloaded\t${frame.name}\t${source}`);
}

async function frameEdit(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive frame edit <name>");
  const existing = await loadFrame(name);
  if (!existing) throw new Error(`Unknown frame: ${name}`);
  const backing = await frameDefinitionFile(name);
  if (backing?.ext === ".ts") {
    throw new Error(`Frame ${name} is backed by a TypeScript source (${backing.path}); edit that file, then run: hive frame reload ${name}`);
  }

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { spawn } = await import("node:child_process");

  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `hive-frame-${name}-`));
  const tmpFile = path.join(tmpDir, `${name}.json`);
  await fs.writeFile(tmpFile, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });

  try {
    const [editorCmd, ...editorArgs] = editor.split(/\s+/);
    if (!editorCmd) throw new Error("Empty $EDITOR/$VISUAL");
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(editorCmd, [...editorArgs, tmpFile], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`Editor exited with code ${code}; frame unchanged`);

    const raw = JSON.parse(await fs.readFile(tmpFile, "utf8"));
    const validated = validateFrame(raw);
    if (validated.name !== name) {
      throw new Error(`Frame name changed in editor (${name} → ${validated.name}); use 'hive frame define' to rename`);
    }
    await writeFrameFromObject(validated);
    if (isPretty()) console.log(actionLine("ok", "frame", [bold(name), dim("edited")]));
    else console.log(`edited\t${name}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function frameInspect(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive frame inspect <name>");
  const frame = await loadFrame(name);
  if (!frame) throw new Error(`Unknown frame: ${name}`);
  console.log(JSON.stringify(frame, null, 2));
}

async function frameRemove(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive frame remove <name>");
  const removed = await removeFrame(name);
  if (!removed) throw new Error(`Unknown frame: ${name}`);
  if (isPretty()) console.log(actionLine("ok", "frame", [bold(name), dim("removed")]));
  else console.log(`removed\t${name}`);
}

async function cmdSwarm(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return swarmList();
    case "inspect":
      return swarmInspect(parsed);
    case "destroy":
      return swarmDestroy(parsed);
    default:
      throw new Error(`Unknown swarm subcommand: ${sub}\nUsage: hive swarm <list|inspect|destroy>`);
  }
}

async function swarmList() {
  const swarms = await listSwarms();
  if (!isPretty()) {
    for (const s of swarms) console.log(`${s.destroyed ? "destroyed" : "live"}\t@${s.id}\t${s.beeIds.length}\t${s.frame ?? "-"}\t${s.colony ?? "-"}\t${s.createdAt}`);
    return;
  }
  if (swarms.length === 0) {
    console.log(dim("No swarms. Spawn one with: hive spawn <bee> --count <n> or hive spawn --frame <name>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "SWARM" },
      { header: "BEES", align: "right" },
      { header: "FRAME" },
      { header: "COLONY" },
      { header: "AGE", align: "right" },
    ],
    swarms.map((s) => [
      s.destroyed ? gray("destroyed") : green("live"),
      bold(`@${s.id}`),
      String(s.beeIds.length),
      dim(s.frame ?? ""),
      dim(s.colony ?? ""),
      dim(formatRelativeTime(s.createdAt)),
    ]),
  ));
}

async function swarmInspect(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive swarm inspect <id>");
  const cleaned = id.startsWith("@") ? id.slice(1) : id;
  const record = await loadSwarm(cleaned);
  if (!record) throw new Error(`Unknown swarm: ${id}`);
  console.log(JSON.stringify(record, null, 2));
}

async function swarmDestroy(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive swarm destroy <id>");
  const cleaned = id.startsWith("@") ? id.slice(1) : id;
  const swarm = await loadSwarm(cleaned);
  if (!swarm) throw new Error(`Unknown swarm: ${id}`);

  const records = await listSessions();
  const members = records.filter((r) => r.swarmId === cleaned);
  let killFailed = 0;
  for (const member of members) {
    const outcome = await transactionalKill(member);
    if (!outcome.ok) {
      killFailed += 1;
      if (isPretty()) console.log(actionLine("warn", "kill_failed", [bold(member.name), dim(outcome.lastError)]));
      else console.log(`kill_failed\t${member.name}\t${outcome.lastError}`);
      continue;
    }
    if (isPretty()) console.log(actionLine(outcome.alreadyGone ? "warn" : "ok", outcome.alreadyGone ? "gone" : "kill", [bold(member.name)]));
    else console.log(`${outcome.alreadyGone ? "gone" : "killed"}\t${member.name}`);
  }

  if (killFailed > 0) {
    if (isPretty()) console.error(note(`${killFailed} bee(s) failed to die; swarm record retained. Retry: hive kill <bee> then hive swarm destroy ${cleaned}`));
    else console.error(`# ${killFailed} kill_failed; swarm record retained`);
    process.exitCode = 1;
    return;
  }

  await destroySwarm(cleaned);
  if (isPretty()) console.log(actionLine("ok", "swarm", [bold(`@${cleaned}`), dim("destroyed"), `${members.length} bees`]));
  else console.log(`destroyed\t@${cleaned}\t${members.length}`);
}

async function cmdNode(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return nodeList();
    case "register":
      return nodeRegister(parsed);
    case "inspect":
      return nodeInspect(parsed);
    case "update":
      return nodeUpdate(parsed);
    case "unregister":
      return nodeUnregister(parsed);
    default:
      throw new Error(`Unknown node subcommand: ${sub}\nUsage: hive node <list|register|inspect|update|unregister>`);
  }
}

async function nodeList() {
  const nodes = await listNodes();
  if (!isPretty()) {
    for (const n of nodes) console.log(`${n.kind}\t${n.name}\t${n.endpoint}\t${n.status ?? "unknown"}\t${n.capabilities.join(",") || "*"}`);
    return;
  }
  if (nodes.length === 0) {
    console.log(dim("No nodes registered. The implicit 'local' node is always available."));
    return;
  }
  console.log(formatTable(
    [
      { header: "KIND" },
      { header: "NAME" },
      { header: "ENDPOINT" },
      { header: "STATUS" },
      { header: "CAPABILITIES" },
      { header: "DESCRIPTION" },
    ],
    nodes.map((n) => [
      n.kind === "local-tmux" ? gray("local") : cyan("ssh"),
      bold(n.name),
      dim(n.endpoint),
      formatNodeStatus(n.status),
      dim(n.capabilities.join(", ")),
      dim(n.description ?? ""),
    ]),
  ));
}

function formatNodeStatus(status: NodeRecord["status"]): string {
  switch (status) {
    case "online":
      return green("● online");
    case "offline":
      return red("○ offline");
    case "unknown":
    default:
      return dim("? unknown");
  }
}

/**
 * ssh args almost always start with "-", which the flag parser reads as the
 * next flag (leaving --ssh-args === true). Silently dropping them would
 * register the node without its ssh config, so demand the = form instead.
 */
function parseSshArgsFlag(parsed: Parsed): string[] | undefined {
  const raw = flag(parsed, "ssh-args");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error('--ssh-args requires a value; use --ssh-args="-F /path/to/config" (the = form is required for values starting with -)');
  }
  return raw.split(/\s+/).filter(Boolean);
}

async function nodeRegister(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node register <name> --kind <local-tmux|ssh-tmux> --endpoint <addr> [--capabilities a,b,c] [--description \"...\"] [--ssh-command ssh] [--ssh-args=\"-F /path/to/config\"]");
  const kindRaw = flag(parsed, "kind");
  if (typeof kindRaw !== "string") throw new Error("--kind is required (local-tmux or ssh-tmux)");
  const endpointRaw = flag(parsed, "endpoint");
  if (typeof endpointRaw !== "string") throw new Error("--endpoint is required");
  const capabilitiesRaw = flag(parsed, "capabilities");
  const capabilities = typeof capabilitiesRaw === "string"
    ? capabilitiesRaw.split(",").map((c) => c.trim()).filter(Boolean)
    : undefined;
  const description = typeof flag(parsed, "description") === "string" ? String(flag(parsed, "description")) : undefined;
  const sshCommand = typeof flag(parsed, "ssh-command") === "string" ? String(flag(parsed, "ssh-command")) : undefined;
  const sshArgs = parseSshArgsFlag(parsed);
  const record = await registerNode({
    name,
    kind: kindRaw as NodeRecord["kind"],
    endpoint: endpointRaw,
    ...(capabilities ? { capabilities } : {}),
    ...(description ? { description } : {}),
    ...(sshCommand ? { sshCommand } : {}),
    ...(sshArgs ? { sshArgs } : {}),
  });
  clearSubstrateCache();
  if (isPretty()) console.log(actionLine("ok", "node", [bold(record.name), record.kind, dim(record.endpoint)]));
  else console.log(`registered\t${record.name}\t${record.kind}\t${record.endpoint}`);
}

async function nodeInspect(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node inspect <name>");
  const record = await loadNode(name);
  if (!record) throw new Error(`Unknown node: ${name}`);
  console.log(JSON.stringify(record, null, 2));
}

async function nodeUpdate(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node update <name> [--endpoint addr] [--capabilities a,b] [--description \"...\"] [--ssh-command ssh] [--ssh-args=\"...\"]");
  const patch: Parameters<typeof updateNode>[1] = {};
  if (typeof flag(parsed, "endpoint") === "string") patch.endpoint = String(flag(parsed, "endpoint"));
  if (typeof flag(parsed, "description") === "string") patch.description = String(flag(parsed, "description"));
  if (typeof flag(parsed, "ssh-command") === "string") patch.sshCommand = String(flag(parsed, "ssh-command"));
  if (typeof flag(parsed, "capabilities") === "string") {
    patch.capabilities = String(flag(parsed, "capabilities")).split(",").map((c) => c.trim()).filter(Boolean);
  }
  const sshArgs = parseSshArgsFlag(parsed);
  if (sshArgs) patch.sshArgs = sshArgs;
  const record = await updateNode(name, patch);
  clearSubstrateCache();
  if (isPretty()) console.log(actionLine("ok", "node", [bold(record.name), dim("updated")]));
  else console.log(`updated\t${record.name}`);
}

async function nodeUnregister(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node unregister <name> [--force]");
  const sessions = await listSessions();
  const affected = sessions.filter((record) => (record.node ?? LOCAL_NODE_NAME) === name);
  if (affected.length > 0 && !truthy(flag(parsed, "force"))) {
    throw new Error(
      `Node ${name} still has ${affected.length} bee(s): ${affected.map((record) => record.name).join(", ")}.\n` +
      `Kill or clean them first, or pass --force to unregister anyway (their records become unmanageable).`,
    );
  }
  await unregisterNode(name);
  clearSubstrateCache();
  if (isPretty()) console.log(actionLine("ok", "node", [bold(name), dim("unregistered")]));
  else console.log(`unregistered\t${name}`);
}

async function cmdSubstrate(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return substrateList();
    default:
      throw new Error(`Unknown substrate subcommand: ${sub}\nUsage: hive substrate list`);
  }
}

async function substrateList() {
  const nodes = await listNodes();
  const kinds = new Map<string, number>();
  for (const node of nodes) kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1);
  if (!isPretty()) {
    for (const [kind, count] of kinds) console.log(`${kind}\t${count}`);
    return;
  }
  console.log(formatTable(
    [
      { header: "KIND" },
      { header: "NODES", align: "right" },
    ],
    [...kinds.entries()].sort().map(([kind, count]) => [
      kind === "local-tmux" ? gray("local-tmux") : cyan("ssh-tmux"),
      String(count),
    ]),
  ));
}

async function cmdFlow(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return flowList();
    case "run":
      return flowRun(parsed);
    case "define":
      return flowDefine(parsed);
    case "runs":
      return flowRunsList(parsed);
    case "inspect":
      return flowInspect(parsed);
    case "logs":
      return flowLogs(parsed);
    case "remove":
      return flowRemove(parsed);
    case "status":
      return flowStatus(parsed);
    case "cancel":
      return flowCancel(parsed);
    default:
      throw new Error(`Unknown flow subcommand: ${sub}\nUsage: hive flow <list|define|inspect|remove|run|runs|logs|status|cancel>`);
  }
}

function parseFlowRunArgs(parsed: Parsed): Record<string, unknown> {
  const raw = parsed.flags.get("arg");
  if (raw === undefined) return {};
  const entries: string[] = [];
  if (typeof raw === "string") entries.push(raw);
  else if (Array.isArray(raw)) entries.push(...raw);
  else if (raw === true) throw new Error("--arg requires a key=value pair");
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --arg: ${entry} (expected key=value)`);
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    // Coerce numeric/boolean literals; everything else stays a string.
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else if (value !== "" && Number.isFinite(Number(value))) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

async function flowRun(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive flow run <name> [--arg key=value]... [--foreground|--background]");
  const flow = await loadFlow(name);
  if (!flow) throw new Error(`Unknown flow: ${name}`);
  const args = parseFlowRunArgs(parsed);
  const foreground = truthy(flag(parsed, "foreground"));
  const background = truthy(flag(parsed, "background"));
  if (foreground && background) throw new Error("--foreground and --background are mutually exclusive");
  if (background) {
    if (process.platform === "win32") {
      throw new Error("hive flow run --background is not supported on Windows.");
    }
    const { runId, pid, pgid } = await spawnDetachedRun(flow, args);
    if (isPretty()) {
      console.log(actionLine("ok", "flow", [bold(flow.name), dim(`run ${runId}`), dim(`pid:${pid}`), dim(`pgid:${pgid}`)]));
      console.error(dim(`Background run started. Inspect: hive flow status ${runId} / hive flow logs ${runId} / hive flow cancel ${runId}`));
    } else {
      console.log(`flow.run\t${flow.name}\t${runId}\t${pid}\t${pgid}\tbackground`);
    }
    return;
  }
  const runId = generateRunId();
  if (isPretty()) {
    console.log(actionLine("ok", "flow", [bold(flow.name), dim(`run ${runId}`)]));
  } else {
    console.log(`flow.run\t${flow.name}\t${runId}`);
  }
  const outcome = await executeFlow(flow, { args, runId });
  if (isPretty()) {
    const colored = outcome.status === "ok" ? green("ok")
      : outcome.status === "cancelled" ? yellow("cancelled")
      : outcome.status === "failed" ? red("failed")
      : dim(outcome.status);
    console.log(actionLine("ok", "flow", [bold(flow.name), dim(runId), colored]));
    if (outcome.error?.message) {
      console.error(dim(`error: ${outcome.error.message}`));
    }
  } else {
    console.log(`flow.end\t${flow.name}\t${runId}\t${outcome.status}`);
  }
  if (outcome.status === "failed") process.exitCode = 1;
  if (outcome.status === "cancelled") process.exitCode = 130;
}

async function flowCancel(parsed: Parsed) {
  const runId = parsed.args[1];
  if (!runId) throw new Error("Usage: hive flow cancel <runId>");
  const summary = await findRunById(runId);
  if (!summary) throw new Error(`Unknown run: ${runId}`);
  if (summary.status !== "running") {
    if (isPretty()) {
      console.log(actionLine("ok", "flow", [bold(summary.flowName), dim(runId), dim(`already ${summary.status}`)]));
    } else {
      console.log(`flow.cancel\t${summary.flowName}\t${runId}\talready-${summary.status}`);
    }
    return;
  }
  const outcome = await cancelRun(summary.flowName, runId);
  if (isPretty()) {
    const tag = outcome.signalled === "already-dead" ? dim(outcome.signalled) : yellow(outcome.signalled);
    console.log(actionLine("ok", "flow", [bold(outcome.flowName), dim(runId), tag]));
  } else {
    console.log(`flow.cancel\t${outcome.flowName}\t${runId}\t${outcome.signalled}`);
  }
}

/**
 * Hidden entrypoint for the detached background child. Invoked as
 *   <node> <cli> __flow-exec <runId> --flow <name>
 *
 * Reads meta.json (pre-written by spawnDetachedRun), loads the registered
 * flow, and runs it through executeFlow. Exits with a status-derived code so
 * any waiting parent (test or future supervisor) sees the outcome.
 */
async function runFlowExec(rest: string[]) {
  const runId = rest[0];
  if (!runId) {
    console.error(`${errorPrefix()} __flow-exec: missing runId`);
    process.exitCode = 2;
    return;
  }
  // Parse optional --flow <name>. The parent always passes this; we still
  // fall back to findRunById to be resilient if the flag is missing.
  let flowName: string | undefined;
  for (let i = 1; i < rest.length; i += 1) {
    if (rest[i] === "--flow" && typeof rest[i + 1] === "string") {
      flowName = rest[i + 1];
      i += 1;
    }
  }
  if (!flowName) {
    const summary = await findRunById(runId);
    if (!summary) {
      console.error(`${errorPrefix()} __flow-exec: cannot resolve flow for runId ${runId}`);
      process.exitCode = 2;
      return;
    }
    flowName = summary.flowName;
  }
  const meta = await readMeta(flowName, runId);
  if (!meta) {
    console.error(`${errorPrefix()} __flow-exec: missing meta.json for ${flowName}/${runId}`);
    process.exitCode = 2;
    return;
  }
  const flow = await loadFlow(flowName);
  if (!flow) {
    console.error(`${errorPrefix()} __flow-exec: unknown flow ${flowName}`);
    process.exitCode = 2;
    return;
  }
  const outcome = await executeFlow(flow, {
    runId,
    args: meta.args,
    installSignalHandlers: true,
    background: true,
  });
  if (outcome.status === "failed") process.exitCode = 1;
  else if (outcome.status === "cancelled") process.exitCode = 130;
}

async function flowRunsList(parsed: Parsed) {
  // Optional --flow <name> filter scopes the inventory.
  const flowName = typeof flag(parsed, "flow") === "string" ? String(flag(parsed, "flow")) : undefined;
  const runs = await listRuns(flowName ? { flowName } : {});
  if (!isPretty()) {
    for (const r of runs) {
      console.log([
        "flow.run",
        r.flowName,
        r.runId,
        r.status,
        r.startedAt,
        r.endedAt ?? "",
        r.pid ?? "",
      ].join("\t"));
    }
    return;
  }
  if (runs.length === 0) {
    console.log(dim("No flow runs yet. Start one with: hive flow run <name> [--arg k=v]..."));
    return;
  }
  console.log(formatTable(
    [
      { header: "FLOW" },
      { header: "RUN" },
      { header: "STATUS" },
      { header: "STARTED" },
      { header: "ENDED" },
      { header: "PID", align: "right" },
    ],
    runs.map((r) => [
      bold(r.flowName),
      r.runId,
      colorRunStatus(r.status),
      dim(r.startedAt),
      dim(r.endedAt ?? ""),
      r.pid !== undefined ? String(r.pid) : dim(""),
    ]),
  ));
}

function colorRunStatus(status: FlowRunMeta["status"]): string {
  if (status === "ok") return green(status);
  if (status === "running") return cyan(status);
  if (status === "cancelled") return yellow(status);
  if (status === "failed") return red(status);
  if (status === "orphaned") return magenta(status);
  return dim(status);
}

async function flowLogs(parsed: Parsed) {
  const runId = parsed.args[1];
  if (!runId) throw new Error("Usage: hive flow logs <runId>");
  const summary = await findRunById(runId);
  if (!summary) throw new Error(`Unknown run: ${runId}`);
  const text = await readLogFull(summary.flowName, runId);
  process.stdout.write(text);
  if (text.length > 0 && !text.endsWith("\n")) process.stdout.write("\n");
  // Hint at the path for tail -f users.
  if (isPretty(process.stderr)) {
    console.error(dim(`# ${runLogPath(summary.flowName, runId)}`));
  }
}

async function flowStatus(parsed: Parsed) {
  const runId = parsed.args[1];
  if (!runId) throw new Error("Usage: hive flow status <runId>");
  const summary = await findRunById(runId);
  if (!summary) throw new Error(`Unknown run: ${runId}`);
  const meta = await readMeta(summary.flowName, runId);
  const result = await readResult(summary.flowName, runId);
  if (truthy(flag(parsed, "json"))) {
    // summary.status is reconciled (running + dead pid → orphaned); the raw
    // meta on disk may still say "running", so emit the reconciled view.
    console.log(JSON.stringify({ meta: meta ? { ...meta, status: summary.status } : meta, result }, null, 2));
    return;
  }
  if (!isPretty()) {
    console.log(`${summary.flowName}\t${runId}\t${summary.status}\t${summary.startedAt}\t${summary.endedAt ?? ""}`);
    return;
  }
  console.log(`${bold(summary.flowName)} ${dim(runId)} ${colorRunStatus(summary.status)}`);
  console.log(`  startedAt ${summary.startedAt}`);
  if (summary.endedAt) console.log(`  endedAt   ${summary.endedAt}`);
  if (summary.pid !== undefined) console.log(`  pid       ${summary.pid}`);
  if (summary.cleanup) console.log(`  cleanup   ${summary.cleanup}`);
  if (result?.value !== undefined) {
    console.log(`  value     ${JSON.stringify(result.value)}`);
  }
  if (result?.error) {
    console.log(`  ${red("error")}     ${result.error.message}`);
    if (result.error.cancelled) console.log(dim("  (cancelled by SIGINT)"));
  }
  if (meta && Object.keys(meta.args).length > 0) {
    console.log(`  args      ${JSON.stringify(meta.args)}`);
  }
}

async function flowList() {
  const flows = await listFlows();
  if (!isPretty()) {
    for (const f of flows) {
      const args = f.args?.length ?? 0;
      const cleanup = f.cleanup ?? "keep";
      console.log(`${f.name}\t${args} args\t${cleanup}`);
    }
    return;
  }
  if (flows.length === 0) {
    console.log(dim("No flows defined. Register one with: hive flow define <path-to-flow.json|.ts>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "NAME" },
      { header: "ARGS", align: "right" },
      { header: "CLEANUP" },
      { header: "DESCRIPTION" },
    ],
    flows.map((f) => [
      bold(f.name),
      String(f.args?.length ?? 0),
      f.cleanup === "kill-on-end" ? yellow("kill-on-end") : gray("keep"),
      dim(f.description ?? ""),
    ]),
  ));
}

async function flowDefine(parsed: Parsed) {
  const first = parsed.args[1];
  const second = parsed.args[2];
  if (!first) throw new Error("Usage: hive flow define <path-to-flow.json|.ts> [<name>]");
  const { sourcePath, nameOverride } = resolveFlowDefineArgs(first, second);
  const flow = await defineFlowFromFile(sourcePath, nameOverride);
  if (isPretty()) {
    console.log(actionLine("ok", "flow", [bold(flow.name), `${flow.args?.length ?? 0} args`, dim(sourcePath)]));
  } else {
    console.log(`defined\t${flow.name}\t${flow.args?.length ?? 0}\t${sourcePath}`);
  }
}

function resolveFlowDefineArgs(first: string, second?: string): { sourcePath: string; nameOverride?: string } {
  if (!second) return { sourcePath: first };
  const firstIsPath = looksLikeFlowPath(first);
  const secondIsPath = looksLikeFlowPath(second);
  if (firstIsPath && !secondIsPath) return { sourcePath: first, nameOverride: second };
  if (!firstIsPath && secondIsPath) return { sourcePath: second, nameOverride: first };
  return { sourcePath: first, nameOverride: second };
}

function looksLikeFlowPath(value: string): boolean {
  return value.includes("/") || value.endsWith(".json") || value.endsWith(".ts");
}

async function flowInspect(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive flow inspect <name>");
  const flow = await loadFlow(name);
  if (!flow) throw new Error(`Unknown flow: ${name}`);
  const source = await loadFlowSource(name).catch(() => null);
  // Re-read the raw source if it still exists — for JSON flows this shows the
  // declarative steps without trying to serialize the compiled closure.
  if (source) {
    try {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(source, "utf8");
      if (source.endsWith(".json")) {
        // Validate that it's still parseable JSON; if so emit it verbatim.
        JSON.parse(raw);
        console.log(raw.endsWith("\n") ? raw.slice(0, -1) : raw);
        return;
      }
    } catch {
      // fall through to summary
    }
  }
  // TS flow (or missing source): print a JSON summary of the compiled shape.
  const summary: Record<string, unknown> = { name: flow.name };
  if (flow.description !== undefined) summary.description = flow.description;
  if (flow.args !== undefined) summary.args = flow.args;
  if (flow.cleanup !== undefined) summary.cleanup = flow.cleanup;
  summary.source = source;
  console.log(JSON.stringify(summary, null, 2));
}

async function flowRemove(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive flow remove <name>");
  const removed = await removeFlow(name);
  if (!removed) throw new Error(`Unknown flow: ${name}`);
  if (isPretty()) console.log(actionLine("ok", "flow", [bold(name), dim("removed")]));
  else console.log(`removed\t${name}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Loops — `hive loop <start|status|logs|stop|list>`. A loop is the built-in
// `loop` flow run detached (runId === loopId); state lives under
// ~/.hive/loops/<loopId>/.
// ──────────────────────────────────────────────────────────────────────────

async function cmdLoop(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return loopListCmd();
    case "start":
      return loopStartCmd(parsed);
    case "launch":
      return cmdLoopLaunch(parsed);
    case "template":
      return cmdLoopTemplate(parsed);
    case "status":
      return loopStatusCmd(parsed);
    case "logs":
      return loopLogsCmd(parsed);
    case "stop":
      return loopStopCmd(parsed);
    default:
      throw new Error(`Unknown loop subcommand: ${sub}\nUsage: hive loop <launch|template|start|status|logs|stop|list> [id]`);
  }
}

function loopArgsFromFlags(parsed: Parsed, prompt: string): Record<string, unknown> {
  return {
    bee: typeof flag(parsed, "bee") === "string" ? String(flag(parsed, "bee")) : "",
    cwd: typeof flag(parsed, "cwd") === "string" ? String(flag(parsed, "cwd")) : "",
    context: typeof flag(parsed, "context") === "string" ? String(flag(parsed, "context")) : "",
    prompt,
    until: typeof flag(parsed, "until") === "string" ? String(flag(parsed, "until")) : "",
    max: typeof flag(parsed, "max") === "string" ? String(flag(parsed, "max")) : undefined,
    maxDuration: typeof flag(parsed, "max-duration") === "string" ? String(flag(parsed, "max-duration")) : "",
    forever: truthy(flag(parsed, "forever")),
    stopOnSeal: typeof flag(parsed, "stop-on-seal") === "string" ? String(flag(parsed, "stop-on-seal")) : "",
    stopOnSentinel: typeof flag(parsed, "stop-on-sentinel") === "string" ? String(flag(parsed, "stop-on-sentinel")) : "",
    judge: typeof flag(parsed, "judge") === "string" ? String(flag(parsed, "judge")) : "",
    summarizer: typeof flag(parsed, "summarizer") === "string" ? String(flag(parsed, "summarizer")) : "",
    yolo: truthy(flag(parsed, "yolo")),
  };
}

async function loopStartCmd(parsed: Parsed) {
  // Resolve the prompt from --prompt or --prompt-file.
  let prompt = typeof flag(parsed, "prompt") === "string" ? String(flag(parsed, "prompt")) : "";
  const promptFile = typeof flag(parsed, "prompt-file") === "string" ? String(flag(parsed, "prompt-file")) : undefined;
  if (promptFile) {
    if (prompt) throw new Error("Provide either --prompt or --prompt-file, not both.");
    prompt = (await readFile(resolve(promptFile), "utf8")).trim();
  }

  await startLoopDetached(loopArgsFromFlags(parsed, prompt));
}

/**
 * Spawn a loop driver detached (so it survives the calling popup/shell). Shared
 * by `hive loop start` and `hive loop launch`: validate eagerly, write loop.json,
 * then hand off to the background runner. `rawArgs` is the loose flag record both
 * loopArgsFromFlags and loopStartArgs produce.
 */
async function startLoopDetached(rawArgs: Record<string, unknown>) {
  // The bee token (codex-auto / claude-thto / account-id) is persisted verbatim
  // and resolved at each iteration's spawn (spawnLoopBee / facade.spawn), so a
  // fresh-carrier `auto` loop re-picks the least-loaded account per iteration.
  // Validate eagerly so errors surface BEFORE we spawn a detached process.
  const loopId = await generateLoopId();
  const cfg = buildLoopConfig({ ...rawArgs, loopId });
  cfg.loopId = loopId;

  if (process.platform === "win32") {
    throw new Error("hive loop start is not supported on Windows (POSIX process groups are required to stop).");
  }

  await ensureLoopDir(loopId);
  await writeLoopConfig(cfg);
  const args = { ...rawArgs, loopId };
  let pid: number;
  let pgid: number;
  try {
    ({ pid, pgid } = await spawnDetachedRun(loopFlow, args, { runId: loopId }));
  } catch (error) {
    // loop.json was written status:"running" before the spawn; mark it errored
    // so a failed spawn does not strand a phantom running loop.
    const message = error instanceof Error ? error.message : String(error);
    await updateLoopConfig(loopId, {
      status: "errored",
      stopReason: `spawn failed: ${message}`,
      endedAt: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }

  if (isPretty()) {
    console.log(actionLine("ok", "loop", [bold("loop"), dim(`id ${loopId}`), dim(`pid:${pid}`)]));
    console.error(dim(`Loop started. Inspect: hive loop status ${loopId} / hive loop logs ${loopId} / hive loop stop ${loopId}`));
  } else {
    console.log(`loop.start\t${loopId}\t${pid}\t${pgid}`);
  }
  return loopId;
}

// ── hive loop launch — the interactive dialog (⌘⇧L) ──────────────────────────

async function cmdLoopLaunch(parsed: Parsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive loop launch needs a TTY — bind it to a tmux popup: bind -n M-L display-popup -E "hive loop launch"');
  }
  const here = await resolveBeeInCurrentPane();
  const defaultCwd = here?.cwd ?? (await resolveSpawnCwd(parsed));

  const result = await chooseLoop({
    templates: await listLoopTemplates(),
    defaultCwd,
    defaultCwdLabel: tildify(defaultCwd),
    loadProjects: async () => (await listProRepos()).map((repo) => ({ label: repo.label, path: repo.path, project: repo.project })),
    validatePath: async (input) => {
      try {
        const abs = resolve(input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        const real = await realpath(abs);
        if (!(await stat(real)).isDirectory()) return { ok: false, error: "not a directory" };
        return { ok: true, path: real };
      } catch {
        return { ok: false, error: "path does not exist" };
      }
    },
    listSubdirs: (base) => listNewBeeSubdirs(base),
    loadBeeOptions: loadLoopBeeOptions,
  });

  if (!result) {
    if (isPretty()) console.error(note("loop launch: cancelled"));
    return;
  }

  if (result.action === "save-template") {
    await saveLoopTemplate(loopTemplateInputFromResult(result));
    if (isPretty()) console.log(actionLine("ok", "loop", [bold("template"), dim(result.templateName ?? "")]));
    else console.log(`loop.template.save\t${result.templateName ?? ""}`);
    return;
  }

  // Launch: run the loop detached so it survives the popup. The flag map mirrors
  // what `hive loop start` would build from CLI flags, plus the chosen cwd.
  await startLoopDetached({ ...loopStartArgs(result.values), cwd: result.cwd });
}

/** The account-aware agent shorthands the loop's bee picker offers. */
async function loadLoopBeeOptions(): Promise<Array<{ value: string; label: string; detail?: string }>> {
  const out: Array<{ value: string; label: string; detail?: string }> = [];
  for (const kind of agentKinds()) {
    const accounts = await newBeeAccountRows(kind).catch(() => []);
    if (accounts.length >= 1) {
      out.push({ value: `${kind}-auto`, label: `${kind} · auto`, detail: "least-loaded account" });
      if (accounts.length >= 2) out.push({ value: `${kind}-rr`, label: `${kind} · rr`, detail: "round-robin next account" });
    }
    for (const acct of accounts) {
      out.push({ value: `${kind}-${acct.id}`, label: `${kind} · ${acct.label}`, ...(acct.usage ? { detail: acct.usage } : {}) });
    }
    if (accounts.length === 0) out.push({ value: kind, label: `${kind} · (no account)` });
  }
  return out;
}

/** Map a save-as-template dialog result into the loopTemplate input record. */
function loopTemplateInputFromResult(result: LoopLaunchResult): LoopTemplateInput {
  const v = result.values;
  const input: LoopTemplateInput = { name: result.templateName ?? "", prompt: v.prompt };
  const put = (key: keyof LoopTemplateInput, value: string) => {
    if (value.trim().length > 0) (input as Record<string, unknown>)[key] = value.trim();
  };
  put("context", v.context);
  put("bee", v.bee);
  put("until", v.until);
  put("max", v.max);
  put("maxDuration", v.maxDuration);
  put("stopOnSeal", v.stopOnSeal);
  put("stopOnSentinel", v.stopOnSentinel);
  put("judge", v.judge);
  put("summarizer", v.summarizer);
  if (v.forever) input.forever = true;
  if (v.yolo) input.yolo = true;
  return input;
}

// ── hive loop template <list|save|remove> ────────────────────────────────────

async function cmdLoopTemplate(parsed: Parsed): Promise<void> {
  const sub = parsed.args[1];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return loopTemplateListCmd(parsed);
    case "save":
      return loopTemplateSaveCmd(parsed);
    case "remove":
    case "rm":
      return loopTemplateRemoveCmd(parsed);
    default:
      throw new Error(`Unknown loop template subcommand: ${sub}\nUsage: hive loop template <list|save|remove>`);
  }
}

async function loopTemplateListCmd(parsed: Parsed): Promise<void> {
  const templates = await listLoopTemplates();
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(templates, null, 2));
    return;
  }
  if (!isPretty()) {
    for (const t of templates) console.log(["loop.template", t.name, t.context ?? "", t.bee ?? "", t.prompt.replace(/\s+/g, " ")].join("\t"));
    return;
  }
  if (templates.length === 0) {
    console.log(dim('No loop templates yet. Save one with: hive loop template save --name <name> --prompt "..." [--context …]'));
    return;
  }
  console.log(formatTable(
    [{ header: "NAME" }, { header: "TYPE" }, { header: "BEE" }, { header: "PROMPT" }],
    templates.map((t) => [bold(t.name), t.context ?? dim("—"), t.bee ?? dim("—"), dim(truncate(t.prompt.replace(/\s+/g, " "), 60))]),
  ));
}

async function loopTemplateSaveCmd(parsed: Parsed): Promise<void> {
  const name = typeof flag(parsed, "name") === "string" ? String(flag(parsed, "name")) : "";
  if (!name) throw new Error("Usage: hive loop template save --name <name> --prompt \"...\" [--context …]");
  let prompt = typeof flag(parsed, "prompt") === "string" ? String(flag(parsed, "prompt")) : "";
  const promptFile = typeof flag(parsed, "prompt-file") === "string" ? String(flag(parsed, "prompt-file")) : undefined;
  if (promptFile) {
    if (prompt) throw new Error("Provide either --prompt or --prompt-file, not both.");
    prompt = (await readFile(resolve(promptFile), "utf8")).trim();
  }
  if (!prompt) throw new Error("hive loop template save needs --prompt or --prompt-file.");

  const input: LoopTemplateInput = { name, prompt };
  const putStr = (key: keyof LoopTemplateInput, flagName: string) => {
    const value = flag(parsed, flagName);
    if (typeof value === "string" && value.length > 0) (input as Record<string, unknown>)[key] = value;
  };
  putStr("bee", "bee");
  putStr("context", "context");
  putStr("until", "until");
  putStr("max", "max");
  putStr("maxDuration", "max-duration");
  putStr("stopOnSeal", "stop-on-seal");
  putStr("stopOnSentinel", "stop-on-sentinel");
  putStr("judge", "judge");
  putStr("summarizer", "summarizer");
  putStr("description", "description");
  if (truthy(flag(parsed, "forever"))) input.forever = true;
  if (truthy(flag(parsed, "yolo"))) input.yolo = true;

  const record = await saveLoopTemplate(input);
  if (isPretty()) console.log(actionLine("ok", "loop", [bold("template"), dim(record.name)]));
  else console.log(`loop.template.save\t${record.name}`);
}

async function loopTemplateRemoveCmd(parsed: Parsed): Promise<void> {
  const name = parsed.args[2];
  if (!name) throw new Error("Usage: hive loop template remove <name>");
  const existing = await loadLoopTemplate(name);
  if (!existing) throw new Error(`Unknown loop template: ${name}`);
  await removeLoopTemplate(name);
  if (isPretty()) console.log(actionLine("ok", "loop", [bold("template"), dim(name), red("removed")]));
  else console.log(`loop.template.remove\t${name}`);
}

async function loopStatusCmd(parsed: Parsed) {
  const loopRef = parsed.args[1];
  if (!loopRef) return loopListCmd();
  const loopId = await resolveLoopId(loopRef);
  const cfg = await readLoopConfig(loopId);
  if (!cfg) throw new Error(`Unknown loop: ${loopId}`);
  const status = loopDisplayStatus(cfg);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ ...cfg, status }, null, 2));
    return;
  }
  if (!isPretty()) {
    console.log(
      [
        cfg.loopId,
        cfg.context,
        status,
        cfg.iteration,
        cfg.lastSealStatus ?? "",
        cfg.startedAt,
        cfg.endedAt ?? "",
      ].join("\t"),
    );
    return;
  }
  console.log(`${bold("loop")} ${dim(cfg.loopId)} ${colorLoopStatus(status)}`);
  console.log(`  context    ${cfg.context} ${dim(`(carrier=${cfg.carrier} memory=${cfg.memory})`)}`);
  console.log(`  bee        ${cfg.bee}`);
  console.log(`  iteration  ${cfg.iteration}${cfg.stop.max != null ? dim(` / ${cfg.stop.max}`) : ""}`);
  if (cfg.lastSealStatus) console.log(`  lastSeal   ${cfg.lastSealStatus}`);
  if (cfg.lastStopCheck) {
    console.log(`  stopCheck  ${cfg.lastStopCheck.condition}=${cfg.lastStopCheck.result} ${dim(cfg.lastStopCheck.at)}`);
  }
  if (cfg.stopReason) console.log(`  stopReason ${cfg.stopReason}`);
  console.log(`  elapsed    ${formatLoopElapsed(cfg)}`);
  if (cfg.pid !== undefined) console.log(`  pid        ${cfg.pid}`);
  const progress = await readFile(loopProgressPath(loopId), "utf8").catch(() => "");
  if (progress.trim()) {
    const head = progress.split("\n").slice(0, 8).join("\n");
    console.log(`\n${dim("progress.md (head):")}\n${head}`);
  }
}

async function loopLogsCmd(parsed: Parsed) {
  const loopRef = parsed.args[1];
  if (!loopRef) throw new Error("Usage: hive loop logs <loopId> [--iter <n>] [-n <lines>] [-f|--follow]");
  const loopId = await resolveLoopId(loopRef);
  const cfg = await readLoopConfig(loopId);
  if (!cfg) throw new Error(`Unknown loop: ${loopId}`);

  const follow = truthy(flag(parsed, "follow")) || truthy(flag(parsed, "f"));
  const iterRaw = flag(parsed, "iter");
  if (iterRaw !== undefined) {
    if (typeof iterRaw !== "string") throw new Error("--iter requires an iteration number (e.g. --iter 3)");
    if (follow) throw new Error("--iter cannot be combined with -f/--follow; iteration logs are complete files");
    const n = Number(iterRaw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid --iter "${iterRaw}": expected a positive integer.`);
    const path = loopIterLogPath(loopId, n);
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`No log for iteration ${n} of loop ${loopId}`);
      throw error;
    });
    await emitLogText(text, path);
    return;
  }

  const path = runLogPath("loop", loopId);
  const lines = numberFlag(parsed, ["n", "lines"], 0);
  if (follow) {
    await followLoopLog(loopId);
    return;
  }
  let text = await readLogFull("loop", loopId);
  if (lines > 0) {
    const parts = text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    text = parts.slice(-lines).join("\n");
  }
  await emitLogText(text, path);
}

async function emitLogText(text: string, path: string): Promise<void> {
  process.stdout.write(text);
  if (text.length > 0 && !text.endsWith("\n")) process.stdout.write("\n");
  if (isPretty(process.stderr)) console.error(dim(`# ${path}`));
}

async function followLoopLog(loopId: string): Promise<void> {
  let previous = "";
  const printDelta = (next: string) => {
    if (next.length > previous.length) {
      process.stdout.write(next.slice(previous.length));
    } else if (next !== previous) {
      // Log was rotated/rewritten — reprint from scratch.
      process.stdout.write(next);
    }
    previous = next;
  };
  while (true) {
    printDelta(await readLogFull("loop", loopId));
    const cfg = await readLoopConfig(loopId).catch(() => null);
    if (cfg && cfg.status !== "running") break;
    if (cfg && cfg.status === "running" && typeof cfg.pid === "number" && !processAlive(cfg.pid)) {
      console.error(note(`loop driver (pid ${cfg.pid}) is gone but loop.json still says running; log will not grow`));
      break;
    }
    await sleep(1_000);
  }
  // One final read: catch lines appended between the last read and the status flip.
  printDelta(await readLogFull("loop", loopId));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function loopStopCmd(parsed: Parsed) {
  const loopRef = parsed.args[1];
  if (!loopRef) throw new Error("Usage: hive loop stop <loopId> [--now]");
  const loopId = await resolveLoopId(loopRef);
  const cfg = await readLoopConfig(loopId);
  if (!cfg) throw new Error(`Unknown loop: ${loopId}`);
  const now = truthy(flag(parsed, "now"));
  if (now) {
    const outcome = await cancelRun("loop", loopId);
    // cancelRun SIGKILLs the driver's process group, so the driver's own
    // finalize() may never run and loop.json would be stuck at "running".
    // Reconcile it here so `hive loop status/list` reports a terminal state.
    if (cfg.status === "running") {
      await updateLoopConfig(loopId, { status: "stopped", stopReason: "stopped:now", endedAt: new Date().toISOString() }).catch(
        () => undefined,
      );
    }
    if (isPretty()) {
      const tag = outcome.signalled === "already-dead" ? dim(outcome.signalled) : yellow(outcome.signalled);
      console.log(actionLine("ok", "loop", [bold(loopId), dim("now"), tag]));
    } else {
      console.log(`loop.stop\t${loopId}\tnow\t${outcome.signalled}`);
    }
    return;
  }
  await requestStop(loopId);
  if (isPretty()) {
    console.log(actionLine("ok", "loop", [bold(loopId), dim("queued"), dim("stops after current iteration")]));
  } else {
    console.log(`loop.stop\t${loopId}\tqueued`);
  }
}

async function loopListCmd() {
  const loops = await listLoops();
  if (!isPretty()) {
    for (const l of loops) {
      console.log(["loop.run", l.loopId, l.context, loopDisplayStatus(l), l.iteration, l.startedAt].join("\t"));
    }
    return;
  }
  if (loops.length === 0) {
    console.log(dim("No loops yet. Start one with: hive loop start --bee <kind> --cwd <dir> --context <mode> --prompt \"...\""));
    return;
  }
  console.log(formatTable(
    [
      { header: "LOOP" },
      { header: "CONTEXT" },
      { header: "STATUS" },
      { header: "ITER", align: "right" },
      { header: "STARTED" },
    ],
    loops.map((l) => [
      bold(l.loopId),
      l.context,
      colorLoopStatus(loopDisplayStatus(l)),
      String(l.iteration),
      dim(l.startedAt),
    ]),
  ));
}

// Display-level only: a "running" loop whose driver pid is gone (e.g. SIGKILL)
// can never finalize loop.json, so surface it as orphaned instead of running
// forever. Delegates to the same reconciliation listLoops applies.
function loopDisplayStatus(cfg: LoopConfig): LoopConfig["status"] {
  return reconcileLoopStatus(cfg).status;
}

function colorLoopStatus(status: LoopConfig["status"] | "orphaned"): string {
  if (status === "running") return cyan(status);
  if (status === "done") return green(status);
  if (status === "paused") return yellow(status);
  if (status === "stopped") return yellow(status);
  if (status === "errored") return red(status);
  if (status === "orphaned") return magenta(status);
  return dim(status);
}

function formatLoopElapsed(cfg: LoopConfig): string {
  const start = Date.parse(cfg.startedAt);
  const end = cfg.endedAt ? Date.parse(cfg.endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "?";
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

async function cmdDaemon(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "status":
      return daemonStatus(parsed);
    case "run":
      return daemonRun(parsed);
    case "install":
      return daemonInstall(parsed);
    case "uninstall":
      return daemonUninstall(parsed);
    case "start":
      return daemonStart(parsed);
    case "stop":
      return daemonStop(parsed);
    case "restart":
      return daemonRestart(parsed);
    case "logs":
      return daemonLogs(parsed);
    // Internal: the out-of-process heartbeat watcher spawned by `daemon run`.
    // Deliberately absent from the usage string.
    case "sentinel":
      return daemonSentinel(parsed);
    default:
      throw new Error(
        `Unknown daemon subcommand: ${sub}\nUsage: hive daemon <install|uninstall|start|stop|restart|status|logs|run>`,
      );
  }
}

async function daemonSentinel(parsed: Parsed) {
  const parentPid = numberFlag(parsed, ["parent-pid"], 0);
  const statePath = stringFlag(parsed, ["state-path"]);
  const staleMs = numberFlag(parsed, ["stale-ms"], 0);
  const checkMs = numberFlag(parsed, ["check-ms"], 15_000);
  const logPath = stringFlag(parsed, ["log-path"]);
  if (!parentPid || !statePath || !staleMs) {
    throw new Error("Usage (internal): hive daemon sentinel --parent-pid <pid> --state-path <file> --stale-ms <ms> [--check-ms <ms>] [--log-path <file>]");
  }
  await runSentinel({ parentPid, statePath, staleMs, checkMs, ...(logPath ? { logPath } : {}) });
}

function daemonLabel(parsed: Parsed): string {
  const raw = flag(parsed, "label");
  if (typeof raw === "string" && raw.length > 0) return raw;
  return DEFAULT_LAUNCH_LABEL;
}

function ensureLaunchctlOrExit(action: string): void {
  if (isLaunchctlSupported()) return;
  console.error(`${errorPrefix()} hive daemon ${action} requires macOS launchctl (platform=${process.platform}).`);
  const snippet = renderSystemdUnit({
    programArguments: [process.execPath, process.argv[1] ?? "hive", "daemon", "run"],
  });
  console.error(`\nOn Linux you can run the daemon under systemd --user with a unit similar to:\n\n${snippet}`);
  process.exit(4);
}

async function daemonInstall(parsed: Parsed) {
  ensureLaunchctlOrExit("install");
  const label = daemonLabel(parsed);
  const force = truthy(flag(parsed, "force"));
  const result = await installAgent({ label, force });
  if (!result.installed) {
    // Already installed; installAgent's message says whether the on-disk
    // plist is stale (CLI moved, options changed) and to re-run with --force.
    if (isPretty()) console.error(`${errorPrefix()} hive daemon ${result.message}. Use --force to overwrite or uninstall first.`);
    else console.error(result.message);
    process.exit(3);
  }
  if (isPretty()) {
    console.log(actionLine("ok", "daemon", [bold("install"), dim(result.message)]));
    console.log(dim(`  label: ${result.label}`));
    console.log(dim(`  plist: ${result.plistPath}`));
  } else {
    console.log(`install\t${result.label}\t${result.plistPath}\t${result.bootstrapped ? "bootstrapped" : "plist-only"}`);
  }
}

async function daemonUninstall(parsed: Parsed) {
  ensureLaunchctlOrExit("uninstall");
  const label = daemonLabel(parsed);
  const result = await uninstallAgent({ label });
  if (isPretty()) {
    const verb = result.removed ? "uninstalled" : "noop";
    console.log(actionLine("ok", "daemon", [bold(verb), dim(result.message)]));
  } else {
    console.log(`uninstall\t${result.label}\t${result.removed ? "removed" : "absent"}\t${result.bootedOut ? "booted-out" : "no-bootout"}`);
  }
}

async function daemonStart(parsed: Parsed) {
  ensureLaunchctlOrExit("start");
  const label = daemonLabel(parsed);
  if (!(await isAgentInstalled(label))) {
    console.error(`${errorPrefix()} hive daemon not installed (${label}). Run: hive daemon install`);
    process.exit(3);
  }
  const result = await startAgent(label);
  if (!result.ok) {
    console.error(`${errorPrefix()} launchctl kickstart failed: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`);
    process.exit(1);
  }
  if (isPretty()) console.log(actionLine("ok", "daemon", [bold("start"), dim(label)]));
  else console.log(`start\t${label}`);
}

async function daemonStop(parsed: Parsed) {
  ensureLaunchctlOrExit("stop");
  const label = daemonLabel(parsed);
  if (!(await isAgentInstalled(label))) {
    console.error(`${errorPrefix()} hive daemon not installed (${label}). Run: hive daemon install`);
    process.exit(3);
  }
  const result = await stopAgent(label);
  if (!result.ok) {
    console.error(`${errorPrefix()} launchctl kill failed: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`);
    process.exit(1);
  }
  if (isPretty()) console.log(actionLine("ok", "daemon", [bold("stop"), dim(label)]));
  else console.log(`stop\t${label}`);
}

async function daemonRestart(parsed: Parsed) {
  ensureLaunchctlOrExit("restart");
  const label = daemonLabel(parsed);
  if (!(await isAgentInstalled(label))) {
    console.error(`${errorPrefix()} hive daemon not installed (${label}). Run: hive daemon install`);
    process.exit(3);
  }
  const result = await restartAgent(label);
  if (!result.ok) {
    console.error(`${errorPrefix()} launchctl kickstart -k failed: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`);
    process.exit(1);
  }
  if (isPretty()) console.log(actionLine("ok", "daemon", [bold("restart"), dim(label)]));
  else console.log(`restart\t${label}`);
}

async function daemonLogs(parsed: Parsed) {
  const follow = truthy(flag(parsed, "follow")) || truthy(flag(parsed, "f"));
  const linesRaw = flag(parsed, "lines");
  const linesN = (() => {
    if (typeof linesRaw !== "string") return undefined;
    const n = Number(linesRaw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  })();
  const nFlag = numberFlag(parsed, ["n"], NaN);
  const lines = Number.isFinite(nFlag) ? nFlag : (linesN ?? 50);

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  if (follow) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    await tailDaemonLog({ lines, follow, signal: controller.signal });
  } finally {
    if (follow) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}

async function daemonRun(parsed: Parsed) {
  const tickRaw = flag(parsed, "tick-ms");
  const config: { tickMs?: number } = {};
  if (typeof tickRaw === "string") {
    const ms = Number(tickRaw);
    if (Number.isFinite(ms) && ms > 0) config.tickMs = ms;
  }
  if (isPretty()) console.error(note(`hive daemon starting (pid ${process.pid})...`));
  try {
    // The production entrypoint runs with the out-of-process sentinel: the
    // only defense that still works when this process can no longer run JS
    // (sync-blocked loop, exit path deadlocked on a poisoned threadpool).
    await runDaemon({ config, sentinel: !process.env.HIVE_DAEMON_NO_SENTINEL });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY") {
      console.error(`${errorPrefix()} ${error instanceof Error ? error.message : String(error)}`);
      process.exit(3);
    }
    throw error;
  }
}

async function daemonStatus(parsed: Parsed) {
  const label = daemonLabel(parsed);
  const staleAfter = numberFlag(parsed, ["stale-after-ms"], 0);
  const status = await readDaemonStatus(undefined, { label, ...(staleAfter > 0 ? { staleAfterMs: staleAfter } : {}) });
  // Exit codes: 0 healthy, 3 down, 4 STALE (process alive, loop wedged).
  // Anything polling this command must treat nonzero as an outage.
  const exitCode = status.running ? (status.stale ? 4 : 0) : 3;
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(status, null, 2));
    process.exit(exitCode);
  }
  const installedTag = status.installed ? "installed" : "not-installed";
  if (!isPretty()) {
    const dot = status.running ? (status.stale ? "STALE" : "running") : "down";
    console.log(`${dot}\t${installedTag}\t${status.lock?.pid ?? ""}\t${status.state?.startedAt ?? ""}\t${status.state?.lastTickAt ?? ""}\t${status.state?.tickCount ?? 0}`);
    process.exit(exitCode);
  }
  if (!status.running) {
    console.log(`${red("○")} ${bold("hive daemon")} ${dim("down")} ${dim(`(${installedTag})`)}`);
    if (status.installed && status.plistPath) {
      console.log(dim(`  plist: ${status.plistPath}`));
    } else if (!status.installed) {
      console.log(dim(`  hint: hive daemon install`));
    }
    if (status.lock) console.log(dim(`  stale lock: pid ${status.lock.pid} (${status.lock.startedAt})`));
    if (status.state) {
      console.log(dim(`  last state.json: pid ${status.state.pid} startedAt ${status.state.startedAt}`));
      console.log(dim(`  last tick: ${status.state.lastTickAt ?? "(none)"} ticks=${status.state.tickCount}`));
    }
    process.exit(3);
  }
  if (status.stale) {
    const age = status.state?.lastTickAt ? formatRelativeTime(status.state.lastTickAt) : "never";
    console.log(`${red("●")} ${bold("hive daemon")} ${red(bold("STALE"))} ${dim(`(process alive, loop wedged — last tick ${age} ago, threshold ${Math.round(status.staleAfterMs / 60_000)}m)`)}`);
    if (status.lock) console.log(`  pid ${status.lock.pid}  host ${status.lock.hostname || "<unknown>"}  startedAt ${status.lock.startedAt}`);
    if (status.state) {
      console.log(`  ticks ${status.state.tickCount}  lastTickAt ${status.state.lastTickAt ?? dim("(none)")}`);
      if (status.state.recentErrors.length > 0) {
        console.log(dim(`  recent errors (${status.state.recentErrors.length}):`));
        for (const e of status.state.recentErrors.slice(-3)) console.log(dim(`    ${e.ts} ${e.msg}`));
      }
    }
    console.log(dim(`  hint: hive daemon restart`));
    process.exit(4);
  }
  console.log(`${green("●")} ${bold("hive daemon")} ${dim("running")} ${dim(`(${installedTag})`)}`);
  if (status.installed && status.plistPath) {
    console.log(`  plist ${status.plistPath}`);
  }
  if (status.lock) {
    console.log(`  pid ${status.lock.pid}  host ${status.lock.hostname || "<unknown>"}  startedAt ${status.lock.startedAt}`);
  }
  if (status.state) {
    console.log(`  ticks ${status.state.tickCount}  lastTickAt ${status.state.lastTickAt ?? dim("(none)")}`);
    if (status.state.recentErrors.length > 0) {
      console.log(dim(`  recent errors (${status.state.recentErrors.length}):`));
      for (const e of status.state.recentErrors.slice(-3)) console.log(dim(`    ${e.ts} ${e.msg}`));
    }
  }
}

async function cmdBuz(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case "send":
      return buzSend(parsed);
    case "inbox":
      return buzList(parsed, "inbox");
    case "outbox":
      return buzList(parsed, "outbox");
    case "queue":
      return buzList(parsed, "queue");
    case "read":
      return buzRead(parsed);
    case "purge":
      return buzPurge(parsed);
    case "config":
      return buzConfig(parsed);
    default:
      throw new Error(`Unknown buz subcommand: ${sub ?? ""}\nUsage: hive buz <send|inbox|outbox|queue|read|purge|config>`);
  }
}

async function resolveBuzSender(parsed: Parsed): Promise<BuzSender> {
  const beeFlag = flag(parsed, "sender");
  const humanFlag = flag(parsed, "sender-human");
  const hasBee = typeof beeFlag === "string" && beeFlag.length > 0;
  const hasHuman = typeof humanFlag === "string" && humanFlag.length > 0;
  if (hasBee && hasHuman) throw new Error("buz: --sender and --sender-human are mutually exclusive");
  if (!hasBee && !hasHuman) throw new Error("buz: exactly one of --sender <bee> or --sender-human <name> is required");
  if (hasBee) {
    // Must resolve to a registered bee.
    const record = await resolveSession(String(beeFlag));
    return { kind: "bee", id: record.id ?? record.name };
  }
  return { kind: "human", name: sanitizeHumanName(String(humanFlag)) };
}

function parseBuzTier(value: unknown): BuzTier {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`buz: --tier must be one of ${BUZ_TIERS.join(", ")}`);
  }
  if (!(BUZ_TIERS as readonly string[]).includes(value)) {
    throw new Error(`buz: unknown tier "${value}". Use one of: ${BUZ_TIERS.join(", ")}`);
  }
  return value as BuzTier;
}

async function buzSend(parsed: Parsed) {
  const target = parsed.args[1];
  if (!target) throw new Error("Usage: hive buz send <selector> --sender <bee>|--sender-human <name> --tier <interrupt|queue|passive> -p <body>");
  const tier = parseBuzTier(flag(parsed, "tier") ?? "queue");
  const body = stringFlag(parsed, ["prompt", "p"]) ?? "";
  if (body.length === 0) throw new Error("buz: --prompt|-p body is required");
  const subject = typeof flag(parsed, "subject") === "string" ? String(flag(parsed, "subject")) : undefined;
  const sender = await resolveBuzSender(parsed);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const transport = tier === "interrupt"
      ? { substrate: substrateFor(record), tmuxTarget: record.tmuxTarget, agentPaneId: record.agentPaneId }
      : undefined;
    const result = await sendBuzMessage({
      recipient: record,
      sender,
      tier,
      body,
      ...(subject ? { subject } : {}),
      ...(transport ? { transport } : {}),
      ...(record.node ? { node: record.node } : {}),
    });
    const m = result.message;
    if (isPretty()) {
      const downgradeNote = result.downgraded ? dim(`downgraded:${m.tier}->${m.deliveredAs}`) : dim(m.deliveredAs);
      console.log(actionLine("ok", "buz", [bold(record.name), m.id, downgradeNote]));
    } else {
      console.log(`buz.send\t${record.name}\t${m.id}\t${m.tier}\t${m.deliveredAs}\t${result.downgraded ? "downgraded" : "ok"}`);
    }
  }
}

async function buzList(parsed: Parsed, mailbox: "inbox" | "outbox" | "queue") {
  const target = parsed.args[1];
  if (!target) throw new Error(`Usage: hive buz ${mailbox} <selector> [--limit N] [--from <ref>]`);
  const limit = numberFlag(parsed, ["limit"], 0) || undefined;
  const fromFilter = typeof flag(parsed, "from") === "string" ? String(flag(parsed, "from")) : undefined;

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const storageBee = mailbox === "outbox" ? (record.id || record.name) : record.name;
    const listing = await listMessages(storageBee, mailbox, {
      ...(limit !== undefined ? { limit } : {}),
      ...(fromFilter ? { fromFilter } : {}),
    });
    if (listing.length === 0) {
      if (isPretty()) console.log(dim(`# ${record.name}: no ${mailbox} messages`));
      continue;
    }
    if (!isPretty()) {
      for (const { message, path } of listing) {
        console.log([
          `buz.${mailbox}`,
          record.name,
          message.id,
          senderDisplay(message.from),
          message.to,
          message.tier,
          message.deliveredAs,
          message.sentAt,
          path,
        ].join("\t"));
      }
      continue;
    }
    if (records.length > 1) console.log(bold(record.name));
    console.log(formatTable(
      [
        { header: "ID" },
        { header: "FROM" },
        { header: "TIER" },
        { header: "DELIVERED" },
        { header: "AGE", align: "right" },
        { header: "SUBJECT" },
      ],
      listing.map(({ message }) => [
        message.id,
        senderDisplay(message.from),
        message.tier,
        message.deliveredAs,
        dim(formatRelativeTime(message.sentAt)),
        dim(message.subject ?? ""),
      ]),
    ));
  }
}

async function buzRead(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive buz read <message-id> [--consume] [--bee <ref>]");
  const consume = truthy(flag(parsed, "consume"));
  const beeRef = typeof flag(parsed, "bee") === "string" ? String(flag(parsed, "bee")) : undefined;
  const candidates = beeRef ? [await resolveSession(beeRef)] : await listSessions();
  let found: { message: BuzMessage; bee: string; path: string; mailbox: string } | null = null;
  for (const record of candidates) {
    const result = await readMessageById(record.name, id);
    if (result) {
      found = { message: result.message, bee: record.name, path: result.path, mailbox: result.mailbox };
      break;
    }
  }
  if (!found) throw new Error(`No buz message found with id: ${id}`);

  let consumed = false;
  if (consume) {
    const moved = await consumeMessage(found.bee, id);
    consumed = moved !== null;
    if (!moved) {
      // Was not in inbox/, so we can't consume it. Just print it.
      console.error(note(`message ${id} is in ${found.mailbox}/; --consume only applies to inbox/`));
    }
  }

  console.log(JSON.stringify({
    id: found.message.id,
    bee: found.bee,
    mailbox: found.mailbox,
    from: senderDisplay(found.message.from),
    to: found.message.to,
    tier: found.message.tier,
    deliveredAs: found.message.deliveredAs,
    sentAt: found.message.sentAt,
    deliveredAt: found.message.deliveredAt,
    subject: found.message.subject,
    body: found.message.body,
    consumed,
  }, null, 2));
}

async function buzPurge(parsed: Parsed) {
  const target = parsed.args[1];
  if (!target) throw new Error("Usage: hive buz purge <selector> [--read|--older-than <age>|--all]");
  const all = truthy(flag(parsed, "all"));
  const readOnly = truthy(flag(parsed, "read"));
  const olderThanRaw = flag(parsed, "older-than");
  const olderThanMs = typeof olderThanRaw === "string" ? parseAge(olderThanRaw) : undefined;

  const flagsCount = [all, readOnly, olderThanMs !== undefined].filter(Boolean).length;
  if (flagsCount === 0) throw new Error("buz purge: pass --read, --older-than <age>, or --all");
  if (flagsCount > 1) throw new Error("buz purge: --read / --older-than / --all are mutually exclusive");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const scope = all ? "all" as const : readOnly ? "read" as const : "older-than" as const;
    const opts = scope === "older-than"
      ? { scope, olderThanMs: olderThanMs! }
      : { scope };
    const result = await purgeMailbox(record.name, opts);
    if (isPretty()) console.log(actionLine("ok", "buz", [bold(record.name), `purged:${scope}`, `${result.removed}`]));
    else console.log(`buz.purge\t${record.name}\t${scope}\t${result.removed}`);
  }
}

async function buzConfig(parsed: Parsed) {
  const ref = parsed.args[1];
  if (!ref) throw new Error("Usage: hive buz config <bee> [--accept interrupt,queue,passive]");
  const record = await resolveSession(ref);

  const acceptRaw = flag(parsed, "accept");
  if (typeof acceptRaw !== "string") {
    // Read-only inspect: print current resolved policy.
    const policy = resolveBuzAccept(record);
    if (!isPretty()) console.log(`buz.config\t${record.name}\t${policy.join(",")}`);
    else console.log(formatTable(
      [{ header: "BEE" }, { header: "ACCEPT" }, { header: "SOURCE" }],
      [[bold(record.name), policy.join(","), dim(record.buzAccept ? "explicit" : "default")]],
    ));
    return;
  }

  const tiers = parseAcceptFlag(acceptRaw);
  await updateSession(record.name, { buzAccept: tiers, updatedAt: new Date().toISOString() });
  await appendLedger({ type: "buz.config", bee: record.name, buzAccept: tiers });
  if (isPretty()) console.log(actionLine("ok", "buz", [bold(record.name), `accept:${tiers.join(",")}`]));
  else console.log(`buz.config\t${record.name}\t${tiers.join(",")}`);
}

async function cmdSearch(parsed: Parsed) {
  const options = await buildSearchOptions(parsed);
  await runSearch(parsed, options, "search");
}

async function cmdSeals(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case "find": {
      // Strip the leading "find" and re-parse args[1] as the query. We keep
      // any --status/--colony/--bee flags but reject --type (the seals noun is
      // already a corpus restriction; mixing it with --type leads to surprise).
      if (parsed.flags.has("type")) {
        throw new Error("hive seals find ignores --type; the seals noun already restricts the corpus. Use 'hive search' for cross-corpus queries.");
      }
      const subParsed: Parsed = {
        command: "seals find",
        args: parsed.args.slice(1),
        flags: parsed.flags,
        rest: parsed.rest,
      };
      const options = await buildSearchOptions(subParsed);
      // Force corpus to seals only — the seals noun is the discoverability hook
      // for users who already know they want seals.
      options.types = new Set(["seals"]);
      await runSearch(subParsed, options, "seals find");
      return;
    }
    default:
      throw new Error(`Unknown seals subcommand: ${sub ?? "(none)"}\nUsage: hive seals find <query> [--status done] [--colony X] [--bee X] [--regex] [--case] [--since 7d] [--limit N] [--json]`);
  }
}

async function buildSearchOptions(parsed: Parsed): Promise<SearchOptions> {
  const query = parsed.args[0];
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Usage: hive search <query> [--colony X] [--swarm X] [--bee X] [--type seals,ledger,sessions] [--status done] [--since 7d] [--regex] [--case] [--limit N] [--json]");
  }

  const limit = (() => {
    const raw = flag(parsed, "limit");
    if (raw === undefined) return 30;
    if (raw === true) throw new Error("--limit requires a number (use 0 for unlimited)");
    const parsedNum = Number(raw);
    if (!Number.isFinite(parsedNum) || parsedNum < 0) throw new Error(`Invalid --limit: ${String(raw)}`);
    return Math.floor(parsedNum);
  })();

  const types = parseTypeFilter(flag(parsed, "type"));
  const colony = typeof flag(parsed, "colony") === "string" ? String(flag(parsed, "colony")) : undefined;
  if (colony) {
    const record = await loadColony(colony);
    if (!record) throw new Error(`Unknown colony: ${colony}`);
  }
  const swarm = typeof flag(parsed, "swarm") === "string" ? String(flag(parsed, "swarm")).replace(/^@/, "") : undefined;
  const beeRaw = typeof flag(parsed, "bee") === "string" ? String(flag(parsed, "bee")) : undefined;
  if (beeRaw && (beeRaw.startsWith("@") || beeRaw.startsWith("colony:"))) {
    throw new Error(`--bee accepts only a bee name or id selector (got ${beeRaw}). Use --colony or --swarm for cohort filters.`);
  }
  const status = typeof flag(parsed, "status") === "string" ? String(flag(parsed, "status")) : undefined;

  const sinceMs = (() => {
    const raw = flag(parsed, "since");
    if (raw === undefined) return undefined;
    if (raw === true) throw new Error("--since requires a duration like 7d, 24h, 30m");
    const ageMs = parseAge(String(raw));
    return Date.now() - ageMs;
  })();

  return {
    query,
    limit,
    caseSensitive: truthy(flag(parsed, "case")),
    regex: truthy(flag(parsed, "regex")),
    ...(colony ? { colony } : {}),
    ...(swarm ? { swarm } : {}),
    ...(beeRaw ? { bee: beeRaw } : {}),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(status ? { status } : {}),
    ...(types ? { types } : {}),
  };
}

function parseTypeFilter(raw: string | true | string[] | undefined): Set<SearchTypeFilter> | undefined {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("--type requires a value (e.g. --type seals,ledger,sessions)");
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const set = new Set<SearchTypeFilter>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed !== "seals" && trimmed !== "ledger" && trimmed !== "sessions") {
      throw new Error(`Invalid --type value: ${trimmed}. Use one or more of: seals, ledger, sessions.`);
    }
    set.add(trimmed);
  }
  if (set.size === 0) throw new Error("--type requires at least one value (seals|ledger|sessions)");
  return set;
}

async function runSearch(parsed: Parsed, options: SearchOptions, verb: string): Promise<void> {
  const result = await search(options);
  const json = truthy(flag(parsed, "json"));
  if (json) {
    console.log(JSON.stringify({
      query: options.query,
      hits: result.hits.map((hit) => ({
        type: hit.type,
        path: hit.path,
        ...(hit.beeName ? { beeName: hit.beeName } : {}),
        snippet: hit.snippet,
        matchStartInSnippet: hit.matchStartInSnippet,
        matchEndInSnippet: hit.matchEndInSnippet,
        score: hit.score,
        matchedAt: hit.matchedAt,
      })),
      truncated: result.truncated,
    }, null, 2));
    return;
  }
  if (result.hits.length === 0) {
    if (isPretty()) console.log(dim(`no hits for ${JSON.stringify(options.query)}`));
    else console.log(`# no hits for ${options.query}`);
    return;
  }
  if (!isPretty()) {
    for (const hit of result.hits) {
      console.log(`${hit.type}\t${hit.matchedAt}\t${hit.beeName ?? "-"}\t${hit.path}\t${hit.snippet}`);
    }
    if (result.truncated) console.error(`# more results truncated; raise --limit (0 = unlimited)`);
    return;
  }
  for (const hit of result.hits) {
    console.log(formatHitPretty(hit));
  }
  if (result.truncated) console.error(note(`more results truncated; raise --limit (0 = unlimited)`));
  // Avoid an unused-variable warning when the verb isn't surfaced in pretty mode.
  void verb;
}

function formatHitPretty(hit: SearchHit): string {
  const head = `${corpusBadge(hit.type)}  ${bold(hit.beeName ?? "-")}  ${dim(formatRelativeTime(hit.matchedAt))}`;
  const path = dim(tildify(hit.path));
  const snippet = highlightSnippet(hit.snippet, hit.matchStartInSnippet, hit.matchEndInSnippet);
  return `${head}\n  ${snippet}\n  ${path}`;
}

function corpusBadge(type: SearchHit["type"]): string {
  switch (type) {
    case "seal":
      return magenta("seal");
    case "ledger":
      return cyan("ledger");
    case "session":
      return green("session");
  }
}

function highlightSnippet(snippet: string, start: number, end: number): string {
  if (start < 0 || end <= start || end > snippet.length) return snippet;
  const before = snippet.slice(0, start);
  const match = snippet.slice(start, end);
  const after = snippet.slice(end);
  return `${before}${bold(yellow(match))}${after}`;
}

/**
 * `--substrate hsr` (or bare `hsr` / `hsr:local`) selects the local runner-host
 * substrate. HSR is NOT a node, so callers short-circuit node resolution when
 * this is true and set opts.substrate="hsr" instead.
 */
function hsrSubstrateRequested(parsed: Parsed): boolean {
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
 *      process is itself a bee) follow `spawn.defaultSubstrate.agent` (default
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
  const origin = (await resolveBeeInCurrentPane()) ? "agent" : "user";
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

function substrateKindForAlias(alias: string): NodeRecord["kind"] | undefined {
  if (alias === "ssh" || alias === "ssh-tmux") return "ssh-tmux";
  if (alias === "local" || alias === "local-tmux" || alias === "tmux") return "local-tmux";
  return undefined;
}

async function resolveSpawnNode(parsed: Parsed, agentKind: string): Promise<NodeRecord> {
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

async function resolveSpawnColony(parsed: Parsed): Promise<string | undefined> {
  const value = flag(parsed, "colony");
  if (typeof value !== "string") return undefined;
  const record = await loadColony(value);
  if (!record) throw new Error(`Unknown colony: ${value}. Create it first with: hive colony create ${value}`);
  if (record.archived) throw new Error(`Colony is archived: ${value}`);
  return record.name;
}

// Colony cockpit: an ephemeral tmux session whose windows are links to live
// bees' windows. tmux-derived, no store records; closing a view is provably
// incapable of killing a bee (see src/view.ts).
async function cmdView(parsed: Parsed) {
  const closeName = flag(parsed, "close");
  if (closeName !== undefined) {
    if (typeof closeName !== "string" || closeName.length === 0) throw new Error("Usage: hive view --close <name>");
    const result = await closeView(closeName);
    if (isPretty()) console.log(actionLine("ok", "view", [bold(viewSessionName(closeName)), dim(`closed, ${result.unlinked} window(s) unlinked`)]));
    else console.log(`view-closed\t${viewSessionName(closeName)}\t${result.unlinked}`);
    return;
  }

  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive view <selector> [--name <name>] [--new-client]  |  hive view --close <name>");
  const nameFlag = flag(parsed, "name");
  const name = typeof nameFlag === "string" && nameFlag.length > 0 ? nameFlag : deriveViewName(target);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  const local = records.filter((record) => !record.node || record.node === LOCAL_NODE_NAME);
  if (local.length < records.length) {
    console.error(note(`skip ${records.length - local.length} remote bee(s) — link-window cannot cross tmux servers`));
  }
  const liveNames = new Set(await localSubstrate().listSessions());
  const live = local.filter((record) => liveNames.has(record.tmuxTarget));
  if (live.length < local.length) console.error(note(`skip ${local.length - live.length} dead bee(s)`));
  if (live.length === 0) throw new Error(`No live local bees match selector: ${target}`);

  const result = await buildView(name, live.map((record) => record.tmuxTarget));
  const parts = [bold(result.session), `${result.linked.length} bee(s) linked`];
  if (result.alreadyLinked > 0) parts.push(dim(`${result.alreadyLinked} already linked`));
  if (isPretty()) console.log(actionLine("ok", "view", parts));
  else console.log(`view\t${result.session}\t${result.linked.length}\t${result.alreadyLinked}`);

  let enterTarget = result.session;
  if (truthy(flag(parsed, "new-client"))) {
    enterTarget = await createGroupedView(name);
    if (isPretty()) console.error(note(`grouped session ${enterTarget} — independent focus on the same windows`));
  }

  const substrate = localSubstrate();
  if (truthy(flag(parsed, "print")) || !process.stdout.isTTY) {
    if (isPretty()) console.error(note("enter with:"));
    console.log(formatShellCommand(substrate.attachCommand(enterTarget)));
    return;
  }
  await substrate.attachSession(enterTarget);
}

async function cmdAttach(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive attach <session> [--print]");
  const record = await resolveSession(target);
  await ensureLive(record);
  const substrate = substrateFor(record);
  const command = formatShellCommand(substrate.attachCommand(record.tmuxTarget));
  if (truthy(flag(parsed, "print"))) {
    if (isPretty()) console.error(note(`attach with:`));
    console.log(command);
    return;
  }
  await applyBeeWindowOptions(record);
  await substrate.attachSession(record.tmuxTarget);
  await syncBeesSidebarLayout({ pruneOthers: true });
}

async function applyBeeWindowOptions(record: SessionRecord): Promise<void> {
  const options = tmuxOptionsForAgent(record.agent);
  if (!options) return;
  await substrateFor(record).setWindowOptions(record.tmuxTarget, options, record.agentPaneId);
}

/**
 * Jump the attached client to the next bee that needs attention — `waiting`,
 * `done`, or `failed` by default (override with --state). Reads live @hive_state
 * straight off the local tmux server (no store), so it stays O(1) at any fleet
 * size. Repeated presses cycle through the attention set; --prev walks back.
 *
 * Local-only by design: switch-client cannot cross to a remote tmux server, so
 * remote bees are out of scope (use `hive attach <bee>` for those).
 */
async function cmdNext(parsed: Parsed) {
  const stateFlag = stringFlag(parsed, ["state"]);
  const states = stateFlag ? parseStateList(stateFlag) : DEFAULT_ATTENTION_STATES;
  const prev = truthy(flag(parsed, "prev"));

  const substrate = localSubstrate();
  const stateMap = await substrate.listSessionStates();
  const sessions: BeeStateEntry[] = [...stateMap].map(([name, state]) => ({ name, state }));

  const current = process.env.TMUX ? await currentTmuxSession() : undefined;
  const target = pickNextBee(sessions, current, { states, prev });

  if (!target) {
    if (isPretty()) console.error(note(`No bees ${states.join("/")} — nothing needs you right now`));
    return;
  }

  if (truthy(flag(parsed, "print"))) {
    console.log(target);
    return;
  }

  const record = await loadSession(target).catch(() => null);
  if (record) await applyBeeWindowOptions(record);
  await substrate.attachSession(target);
  await syncBeesSidebarLayout({ pruneOthers: true });

  if (isPretty()) {
    const remaining = attentionCount(sessions, states) - 1;
    const tail = target === current ? "" : remaining > 0 ? `  ${dim(`· ${remaining} more need you`)}` : "";
    console.error(note(`→ ${target}  ${dim(stateMap.get(target) ?? "")}${tail}`));
  }
}

/** The session name of the attached client, or undefined outside tmux. */
async function currentTmuxSession(): Promise<string | undefined> {
  const result = await tmux(["display-message", "-p", "#{session_name}"], { reject: false });
  if (!result.ok) return undefined;
  const name = result.stdout.trim();
  return name.length > 0 ? name : undefined;
}

async function resolveSession(name: string): Promise<SessionRecord> {
  const exact = await loadSession(name);
  if (exact) return exact;
  const records = await listSessions();
  const matches = records.filter((record) => matchesSessionReference(record, name));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous session ${name}: ${matches.map((m) => m.id ?? m.name).join(", ")}`);
  throw new Error(`Unknown session: ${name}`);
}

async function ensureLive(record: SessionRecord) {
  const substrate = substrateFor(record);
  if (!(await substrate.hasSession(record.tmuxTarget))) {
    throw new Error(`tmux session is not running: ${record.tmuxTarget}`);
  }
  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  if (isLocal && record.agentPaneId) {
    const panes = await localSubstrate().listPanes();
    if (!panes.has(record.agentPaneId)) {
      throw new Error(`tmux pane is not running for ${record.name}: ${record.agentPaneId}`);
    }
  }
}

function cleanupAfterRun(parsed: Parsed): boolean {
  return truthy(flag(parsed, "rm")) || truthy(flag(parsed, "cleanup"));
}

function hasFlag(parsed: Parsed, key: string): boolean {
  return flag(parsed, key) !== undefined;
}

/**
 * Resolve the first present flag among `keys` to its string value. A flag that
 * is present without a value parses as boolean true (`String(true)` would
 * otherwise leak a literal "true"), so reject anything that is not a string.
 */
function stringFlag(parsed: Parsed, keys: string[]): string | undefined {
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
function arrayFlag(parsed: Parsed, key: string): string[] {
  const raw = flag(parsed, key);
  if (raw === undefined) return [];
  if (raw === true) throw new Error(`--${key} requires a value`);
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function ageFlag(parsed: Parsed, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = flag(parsed, key);
    if (typeof value === "string") return parseAge(value);
    if (value === true) throw new Error(`--${key} requires a duration like 30m, 2h, or 7d`);
  }
  return undefined;
}

function acceptsTrust(parsed: Parsed): boolean {
  if (truthy(flag(parsed, "no-accept-trust")) || truthy(flag(parsed, "no-trust"))) return false;
  return true;
}

function defaultBootMs(agent: string): number {
  switch (agent) {
    case "claude": return 15_000;
    case "codex": return 30_000;
    case "opencode": return 15_000;
    case "grok": return 10_000;
    case "droid": return 5_000;
    case "pi": return 10_000;
    default: return 10_000;
  }
}

function dangerousMode(parsed: Parsed, agent?: string, requested?: string, profileYolo?: boolean): boolean {
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
  if (requested && autoAccountTool(requested) === "codex") return true;
  // Thin-profile yolo override (precedence FLAG > config bee yolo > PROFILE >
  // per-agent default).
  if (profileYolo !== undefined) return profileYolo;
  // Per-agent default: selected harnesses run permissionless unless opted out above.
  return agent || requested ? agentDefaultsToYolo(agent ?? requested!) : false;
}

function yoloDecisionNames(agent?: string, requested?: string): string[] {
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

function envSuffix(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function formatPaneExcerpt(pane: string): string {
  const lines = pane.trimEnd().split("\n").slice(-25);
  return lines.map((line) => dim(`pane │ `) + line).join("\n");
}

function transcriptBanner(provider: string, path: string): string {
  if (!isPretty(process.stderr)) return `# ${provider} transcript: ${path}`;
  return `${dim("─")} ${cyan(provider)} ${dim(tildify(path))}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeTmuxTarget(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 3: identity & accounts
// ──────────────────────────────────────────────────────────────────────────

async function cmdAccount(parsed: Parsed) {
  const sub = parsed.args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      await accountList(parsed);
      break;
    case "add": {
      const [, tool, label] = parsed.args;
      if (!tool || !label) throw new Error("Usage: hive account add <tool> <label> [--email <addr>] [--provider <id>] [--model <id>]");
      const email = typeof flag(parsed, "email") === "string" ? String(flag(parsed, "email")) : undefined;
      const provider = typeof flag(parsed, "provider") === "string" ? String(flag(parsed, "provider")) : undefined;
      const model = typeof flag(parsed, "model") === "string" ? String(flag(parsed, "model")) : undefined;
      const account = await addAccount(tool, label, { email, provider, model });
      if (isPretty()) console.log(actionLine("ok", "account", [bold(account.id), account.tool, account.provider ?? "?", account.label]));
      else console.log(`${account.id}\t${account.tool}\t${account.provider ?? ""}\t${account.label}`);
      console.log(note(`vault dir ready; capture credentials with: hive account login ${account.tool} ${account.label}`));
      break;
    }
    case "login": {
      const [, tool, label] = parsed.args;
      if (!tool || !label) throw new Error("Usage: hive account login <tool> <label> [--provider <id>] [--model <id>]");
      const kind = canonicalAgentKind(tool).toLowerCase();
      const accounts = await listAccounts();
      const existing = accounts.find((candidate) => candidate.tool === kind && candidate.label === label.trim());
      // Auto-create path: a CLI with no canonical provider (opencode) makes
      // addAccount throw unless --provider is supplied. Thread the flags so a
      // first-time `account login` of such a CLI can name its provider; for
      // single-provider CLIs (claude/codex/grok/kimi) they default and this is
      // byte-identical to before.
      const provider = typeof flag(parsed, "provider") === "string" ? String(flag(parsed, "provider")) : undefined;
      const model = typeof flag(parsed, "model") === "string" ? String(flag(parsed, "model")) : undefined;
      const account = existing ?? (await addAccount(tool, label, { provider, model }));
      await runLoginSeat(parsed, account);
      break;
    }
    case "capture": {
      const query = parsed.args[1];
      if (!query) throw new Error("Usage: hive account capture <account> --home <1|2|3|path>");
      const account = await findAccount(query);
      const homeFlag = flag(parsed, "home");
      if (typeof homeFlag !== "string") throw new Error("--home <1|2|3|path> is required: which home should credentials be captured from?");
      const homePath = resolveHome(account.tool, homeFlag);
      const captured = await captureAccountFromHome(account, homePath);
      if (isPretty()) console.log(actionLine("ok", "capture", [bold(account.id), dim(tildify(homePath)), `${captured.length} file(s)`]));
      else console.log(`captured\t${account.id}\t${homePath}\t${captured.join(",")}`);
      break;
    }
    case "remove":
    case "rm": {
      const query = parsed.args[1];
      if (!query) throw new Error("Usage: hive account remove <account>");
      const account = await removeAccount(query);
      if (isPretty()) console.log(actionLine("ok", "remove", [bold(account.id)]));
      else console.log(`removed\t${account.id}`);
      break;
    }
    case "sync": {
      // Pull rotated/refreshed credentials from account homes back into the
      // vault. Claude rotates OAuth chains; Codex rewrites auth.json on token
      // refresh. One account when named, otherwise every supported account.
      const query = parsed.args[1];
      const outcomes: AccountChainSyncOutcome[] = query
        ? await (async () => {
            const account = await findAccount(query);
            if (!identityRecipeForAgent(account.tool)) {
              throw new Error(`credential sync only applies to accounts with identity recipes; ${account.id} is ${account.tool}`);
            }
            const result = await syncAccountCredentialsToVault(account);
            return [{ account: account.id, vaultUpdated: result.vaultUpdated }];
          })()
        : await syncAllAccountCredentialsToVault();
      for (const outcome of outcomes) {
        const state = outcome.error ? red(`error: ${outcome.error}`) : outcome.vaultUpdated ? green("vault updated") : dim("already fresh");
        if (isPretty()) console.log(actionLine(outcome.error ? "warn" : "ok", "sync", [bold(outcome.account), state]));
        else console.log(`synced\t${outcome.account}\t${outcome.error ?? (outcome.vaultUpdated ? "updated" : "fresh")}`);
      }
      if (outcomes.length === 0) console.log(note("no accounts with identity recipes registered; nothing to sync"));
      break;
    }
    default:
      throw new Error(`Unknown account subcommand: ${sub}. Use: list|add|login|capture|sync|remove`);
  }
}

async function accountList(parsed: Parsed) {
  const accounts = await listAccounts();
  const now = Date.now();
  const rows: string[][] = [];
  const jsonRows: Record<string, unknown>[] = [];
  for (const account of accounts) {
    const summary = await usageSummary(account.id, now);
    const hasCreds = await accountHasCredentials(account);
    const exhausted = isRecentlyExhausted(summary, now);
    if (truthy(flag(parsed, "json"))) {
      jsonRows.push({ ...account, credentials: hasCreds, exhausted, lastExhaustedAt: summary.lastExhaustedAt ?? null, resetHint: summary.lastResetHint ?? null });
      continue;
    }
    const state = !hasCreds ? yellow("no-creds") : exhausted ? red("exhausted") : green("ok");
    rows.push([
      account.id,
      account.tool,
      account.provider ?? "-",
      account.label,
      isPretty() ? state : !hasCreds ? "no-creds" : exhausted ? "exhausted" : "ok",
      summary.lastExhaustedAt ? formatRelativeTime(summary.lastExhaustedAt) : "-",
      summary.lastResetHint ?? "-",
    ]);
  }
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(jsonRows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(note("no accounts registered; add one with: hive account add <tool> <label>"));
    return;
  }
  console.log(formatTable(
    [{ header: "ACCOUNT" }, { header: "TOOL" }, { header: "PROVIDER" }, { header: "LABEL" }, { header: "STATE" }, { header: "EXHAUSTED" }, { header: "RESET" }],
    rows,
  ));
}

// Interactive (re)login seat: a scratch home + the tool's own login flow in a
// detached tmux session; once credential files land we capture them into the
// vault and tear the seat down.
async function runLoginSeat(parsed: Parsed, account: AccountRecord) {
  const recipe = identityRecipeForAgent(account.tool);
  if (!recipe) throw new Error(`Tool ${account.tool} has no identity recipe`);
  // Capture must gate on the PRIMARY credential: tools write supporting files
  // (claude's .claude.json) the moment they boot, long before any login.
  const primary = recipe.credentialFiles[0]!;
  const seatHome = resolve(storeRoot(), "login-homes", account.id);
  await mkdir(seatHome, { recursive: true, mode: 0o700 });
  const target = safeTmuxTarget(`login-${account.id}`);
  const substrate = localSubstrate();
  const markerPath = resolve(seatHome, ".login-seat-started");

  if (!(await substrate.hasSession(target))) {
    if (recipe.seedLoginSeat === false) {
      // The tool's sign-in flow only triggers when the primary credential is
      // absent; the seat home persists across attempts, so stale creds from a
      // previous seat must go too.
      await clearSeatCredentials(recipe, seatHome);
    } else if (await accountHasCredentials(account)) {
      // Re-login starts from the existing creds when we have them.
      await activateAccountIntoHome(account, seatHome).catch(() => undefined);
    }
    // The marker is the freshness baseline: its mtime for the credentials
    // file, its recorded digest for the keychain entry (claude on macOS logs
    // in to the Keychain, not the file). Written post-activation so re-seeded
    // old creds stay stale.
    const keychainBaseline = account.tool === "claude" ? await readClaudeKeychain(seatHome) : null;
    const marker = { account: account.id, keychainDigest: keychainBaseline ? credentialDigest(keychainBaseline) : null };
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    const spec = resolveAgent(account.tool, [], { home: seatHome, identity: true, yolo: false });
    await substrate.newSession(target, process.cwd(), {
      command: spec.command,
      args: spec.args,
      env: spec.env,
      tmuxOptions: spec.tmuxOptions,
    });
  } else {
    // A seat from a previous attempt is still up — rejoin it.
    console.log(note(`rejoining the running login seat for ${account.id}`));
  }

  const attachHint = `tmux attach -t ${target}`;
  if (isPretty()) console.log(actionLine("ok", "login-seat", [bold(account.id), dim(attachHint)]));
  else console.log(`login-seat\t${account.id}\t${target}`);

  if (truthy(flag(parsed, "no-wait"))) {
    console.log(note(`complete the ${account.tool} login in the seat (${attachHint}), then run: hive account capture ${account.id} --home ${seatHome}`));
    return;
  }

  const baselineMs = (await stat(markerPath).catch(() => null))?.mtimeMs ?? Date.now();
  const baselineDigest = await readMarkerKeychainDigest(markerPath);
  const loggedIn = async (): Promise<boolean> => {
    const info = await stat(resolve(seatHome, primary)).catch(() => null);
    if (info?.isFile() && info.mtimeMs >= baselineMs) return true;
    if (account.tool !== "claude") return false;
    // claude on macOS logs in to the Keychain, not the credentials file.
    const current = await readClaudeKeychain(seatHome);
    return Boolean(current) && credentialDigest(current!) !== baselineDigest;
  };
  const captureIfLoggedIn = async (): Promise<boolean> => {
    if (!(await loggedIn())) return false;
    const captured = await captureAccountFromHome(account, seatHome);
    await substrate.kill(target).catch(() => undefined);
    if (isPretty()) console.log(actionLine("ok", "capture", [bold(account.id), `${captured.length} file(s)`]));
    else console.log(`captured\t${account.id}\t${captured.join(",")}`);
    return true;
  };

  // Interactive: put the user in the seat; capture when they detach or the
  // tool exits. Inside an existing tmux client attach would nest — fall back
  // to the headless poll loop there.
  if (process.stdout.isTTY && process.stdin.isTTY && !process.env.TMUX) {
    console.log(note(`complete the ${account.tool} login, then detach (ctrl-b d) or quit the tool`));
    try {
      await substrate.attachSession(target);
    } catch {
      // attach failed (no client?); fall through to polling
    }
    if (await captureIfLoggedIn()) return;
    if (await substrate.hasSession(target)) {
      throw new Error(`Login not completed (no fresh credentials in ${primary} or the keychain); the seat is still running — rerun hive login ${account.id} or ${attachHint}`);
    }
    throw new Error(`Login seat exited without producing ${primary}; rerun: hive login ${account.id}`);
  }

  console.log(note(`complete the ${account.tool} login in the seat (${attachHint}); waiting for ${primary}`));
  const timeoutMs = numberFlag(parsed, ["timeout-ms", "timeout"], 600_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await captureIfLoggedIn()) return;
    if (!(await substrate.hasSession(target))) {
      throw new Error(`Login seat exited without producing ${primary}; rerun: hive login ${account.id}`);
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${primary} in ${seatHome}; the seat is still running — ${attachHint}`);
}

async function clearSeatCredentials(recipe: IdentityRecipe, seatHome: string): Promise<void> {
  const files = [...recipe.credentialFiles, ...Object.values(recipe.activationMirrors ?? {})];
  for (const file of files) {
    await rm(resolve(seatHome, file), { force: true });
  }
}

async function readMarkerKeychainDigest(markerPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { keychainDigest?: unknown };
    return typeof parsed.keychainDigest === "string" ? parsed.keychainDigest : null;
  } catch {
    // Pre-keychain marker format (plain text) — no baseline recorded.
    return null;
  }
}

async function cmdActivate(parsed: Parsed) {
  const query = parsed.args[0];
  if (!query) throw new Error("Usage: hive activate <account> [--home <1|2|3|path>]");
  const account = await findAccount(query);
  const homeFlag = flag(parsed, "home");
  const homePath = typeof homeFlag === "string" ? resolveHome(account.tool, homeFlag) : defaultHomeForAccount(account);
  const written = await activateAccountIntoHome(account, homePath, { onWarn: (message) => console.error(note(message)) });
  if (isPretty()) console.log(actionLine("ok", "activate", [bold(account.id), dim(tildify(homePath)), `${written.length} file(s)`]));
  else console.log(`activated\t${account.id}\t${homePath}\t${written.join(",")}`);
  const identityEnv = identityEnvForAgent(account.tool, homePath);
  const envHint = Object.entries(identityEnv).map(([key, value]) => `${key}=${value}`).join(" ");
  console.log(note(`spawn with: hive spawn ${account.tool} --home ${homePath}${envHint ? ` (identity env: ${envHint})` : ""}`));
}

async function cmdLogin(parsed: Parsed) {
  const query = parsed.args[0];
  if (!query) throw new Error("Usage: hive login <account> [--no-wait] [--popup]");
  const account = await findAccount(query);
  if (truthy(flag(parsed, "popup"))) {
    // The mesh tmux binding wraps this in display-popup; print the canonical form.
    console.log(`tmux display-popup -E "hive login ${account.id}"`);
    return;
  }
  await runLoginSeat(parsed, account);
}

async function cmdSwapAccount(parsed: Parsed) {
  const [beeQuery, accountQuery] = parsed.args;
  if (!beeQuery || !accountQuery) throw new Error("Usage: hive swap-account <bee> <account>");
  const target = await resolveSelector(beeQuery);
  if (target.kind !== "bee") throw new Error("swap-account targets a single bee");
  const record = target.record;
  const account = await findAccount(accountQuery, record.agent);
  const updated = await swapAccount(record, account);
  if (isPretty()) console.log(actionLine("ok", "swap", [bold(updated.name), `${record.accountId ?? "unbound"} → ${account.id}`, dim(updated.providerSessionId ?? "fresh session")]));
  else console.log(`swapped\t${updated.name}\t${account.id}`);
}

async function cmdUsageSamples(parsed: Parsed) {
  const query = parsed.args[0];
  const now = Date.now();
  const accounts = await listAccounts();
  const ids = query
    ? [(await findAccount(query)).id]
    : [...new Set([...accounts.map((account) => account.id), ...(await listUsageAccounts())])];

  const summaries = [];
  for (const id of ids) summaries.push(await usageSummary(id, now));

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }
  if (summaries.length === 0) {
    console.log(note("no usage recorded; usage accrues for account-bound bees (hive spawn <tool> --account <a>)"));
    return;
  }
  const rows = summaries.map((summary) => {
    const exhausted = isRecentlyExhausted(summary, now);
    return [
      summary.account,
      `${formatTokens(summary.windowInputTokens)}/${formatTokens(summary.windowOutputTokens)}`,
      summary.lastSample ? formatRelativeTime(summary.lastSample.ts) : "-",
      summary.lastExhaustedAt ? formatRelativeTime(summary.lastExhaustedAt) : "-",
      isPretty() ? (exhausted ? red("exhausted") : green("ok")) : exhausted ? "exhausted" : "ok",
      summary.lastResetHint ?? "-",
    ];
  });
  console.log(formatTable(
    [{ header: "ACCOUNT" }, { header: "5H IN/OUT" }, { header: "SAMPLED" }, { header: "EXHAUSTED" }, { header: "STATE" }, { header: "RESET" }],
    rows,
  ));
  console.log(note("token sums are directional estimates from transcripts, not authoritative quota"));
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

// `hive limits`: progress against the providers' REAL 5h/weekly windows.
// claude is queried live (the same endpoint as Claude Code's /usage panel);
// codex is the newest rate_limits snapshot its CLI wrote to disk (stamped).
async function cmdLimits(parsed: Parsed) {
  const query = parsed.args[0];
  const accounts = query ? [await findAccount(query)] : sortAccountsForLimitsDisplay(await listAccounts());
  if (accounts.length === 0) {
    console.log(note("no accounts registered; add some with: hive account add <tool> <label> && hive login <account>"));
    return;
  }
  // Live reads refresh the on-disk cache; --ttl serves entries younger than
  // the given age instead of paying the provider round-trips.
  const ttlMs = ttlFlagMs(parsed);
  const results = await cachedAccountLimits(accounts, ttlMs !== undefined ? { ttlMs } : {});

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const rows = results.map((result) => [
    result.account,
    result.plan ?? "-",
    limitCell(result.fiveHour, result),
    limitCell(result.weekly, result),
    terseLimitCell(result.fableWeekly, result),
    result.cached ? `cache ${formatRelativeTime(result.asOf)}` : result.asOf ? formatRelativeTime(result.asOf) : result.ok ? "live" : "-",
  ]);
  console.log(formatTable(
    [{ header: "ACCOUNT" }, { header: "PLAN" }, { header: "5H" }, { header: "WEEKLY" }, { header: "FABLE" }, { header: "AS-OF" }],
    rows,
  ));
  for (const result of results.filter((candidate) => !candidate.ok)) {
    console.log(note(`${result.account}: ${result.error}`));
  }
  console.log(note("pace = used% − elapsed% of the window: ▲ burning faster than it refills, ▼ headroom, ● on pace"));
}

function limitCell(window: WindowUsage | undefined, result: AccountLimits): string {
  if (!result.ok || !window) return "-";
  const now = Date.now();
  // A snapshot whose reset boundary has passed describes a window that has
  // already rolled over: it's fresh (0%) and nothing is pending a reset.
  if (windowRolledOver(window, now)) {
    return `${limitBar(0)}   0%`;
  }
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const pace = paceDelta(window, now);
  const paceSuffix = pace === null ? "" : ` ${formatPace(pace)}`;
  const reset = window.resetsAt ? ` ⟳ ${formatTimeUntil(window.resetsAt)}` : "";
  return `${limitBar(percent)} ${String(Math.round(percent)).padStart(3)}%${reset}${paceSuffix}`;
}

/** Bar-less cell for narrow columns (Fable included usage): `42% ⟳ 3d`. */
function terseLimitCell(window: WindowUsage | undefined, result: AccountLimits): string {
  if (!result.ok || !window) return "-";
  if (windowRolledOver(window)) return "0%";
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const text = `${Math.round(percent)}%`;
  const colored = !isPretty() ? text : percent >= 90 ? red(text) : percent >= 70 ? yellow(text) : green(text);
  return window.resetsAt ? `${colored} ⟳ ${formatTimeUntil(window.resetsAt)}` : colored;
}

function formatPace(delta: number): string {
  const rounded = Math.round(delta);
  if (Math.abs(rounded) <= 2) return isPretty() ? dim("●") : "=0";
  const label = rounded > 0 ? `▲+${rounded}` : `▼${rounded}`;
  if (!isPretty()) return rounded > 0 ? `+${rounded}` : `${rounded}`;
  if (rounded > 0) return rounded >= 15 ? red(label) : yellow(label);
  return green(label);
}

function limitBar(percent: number): string {
  const width = 10;
  const filled = Math.round((percent / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  if (!isPretty()) return bar;
  if (percent >= 90) return red(bar);
  if (percent >= 70) return yellow(bar);
  return green(bar);
}

async function cmdSessions(parsed: Parsed) {
  const sub = parsed.args[0];
  if (sub !== "reconcile") throw new Error("Usage: hive sessions reconcile [--home <path>]... [--json]");
  const homeFlag = flag(parsed, "home");
  const extraHomes = Array.isArray(homeFlag) ? homeFlag : typeof homeFlag === "string" ? [homeFlag] : [];
  const index = await reconcileSessions({ extraHomes });
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(index, null, 2));
    return;
  }
  if (isPretty()) {
    console.log(actionLine("ok", "reconcile", [`${index.entries.length} sessions`, `${index.scannedHomes.length} homes`, dim(tildify(sessionIndexPath()))]));
  } else {
    console.log(`reconciled\t${index.entries.length}\t${index.scannedHomes.length}\t${sessionIndexPath()}`);
  }
  for (const duplicate of index.duplicates) {
    const locations = duplicate.locations.map((location) => tildify(location.home)).join(", ");
    console.log(note(`duplicate ${duplicate.sessionId} in: ${locations}`));
  }
  for (const conflict of index.conflicts) {
    console.log(note(`sync conflict: ${tildify(conflict)}`));
  }
  if (index.duplicates.length === 0 && index.conflicts.length === 0) {
    console.log(note("no cross-home duplicates or sync conflicts"));
  }
}

async function cmdSync(parsed: Parsed) {
  const sub = parsed.args[0];
  if (sub !== "manifest") throw new Error("Usage: hive sync manifest [--json]");
  const manifest = await writeSyncManifest();
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (isPretty()) console.log(actionLine("ok", "manifest", [dim(tildify(syncManifestPath()))]));
  else console.log(`manifest\t${syncManifestPath()}`);
  for (const pattern of manifest.include) console.log(`  include ${pattern}`);
  for (const pattern of manifest.exclude) console.log(`  exclude ${pattern}`);
  console.log(note(manifest.note));
}

function printHelp() {
  const pretty = isPretty();
  const head = pretty ? `${bold(APP_NAME)} ${dim(VERSION)}` : `${APP_NAME} ${VERSION}`;
  const heading = (label: string) => (pretty ? bold(yellow(label)) : label);
  const cmd = (name: string) => (pretty ? cyan(name) : name);
  const arg = (text: string) => (pretty ? gray(text) : text);
  const env = (name: string) => (pretty ? cyan(name) : name);

  // Grouped overview. Each row is [name, synopsis, one-line description].
  // The synopsis shows only the leading positionals — full flag signatures
  // live in each command's own `Usage:` (run the command with no/invalid args).
  const groups: Array<{ title: string; rows: Array<[string, string, string]> }> = [
    {
      title: "Spawn & run",
      rows: [
        ["spawn", "<bee>", "start bees in detached tmux sessions (--frame to spawn a swarm)"],
        ["new", "", "interactive picker: choose type, account, config & folder, then spawn"],
        ["run", "<bee> -p <prompt>", "spawn, send a prompt, optionally wait and clean up"],
        ["x", "<bee> <prompt>", "spawn a bee and hand it a prompt, then return (fire-and-forget)"],
        ["xa", "<bee>", "spawn a bee and attach to it"],
        ["open", "<bee>", "registered spawn presented where you are (link window or attach)"],
      ],
    },
    {
      title: "Message",
      rows: [
        ["send", "<selector> <prompt>", "send a prompt to a bee, swarm, or colony"],
        ["answer", "<bee> [text]", "answer a blocked HSR bee's needs-input (default: yes)"],
        ["brief", "<selector> <text>", "send a one-time context brief"],
        ["buz", "<send|inbox|read|…>", "addressed messaging: three-tier delivery + per-bee policy"],
        ["rename", "<selector> <title>", "set a bee's display title (--here for current bee, --auto to derive one, --clear)"],
        ["tag", "<selector> <tag>...", "add/remove user tags on bees (--remove, --list)"],
        ["seal", "<selector> --from <p>", "record a typed handoff artifact"],
      ],
    },
    {
      title: "Observe",
      rows: [
        ["list", "", "show all known sessions with state (alias: ps)"],
        ["bees", "", "grouped fuzzy fleet TUI (^g cycles colony/pro/folder/type grouping, tab previews; --sidebar)"],
        ["tail", "<session>", "capture or follow pane content"],
        ["transcript", "<session>", "render structured transcript rows"],
        ["last", "<session>", "print the bee's most recent assistant message or seal"],
        ["wait", "<session>", "block until the bee goes idle or seals"],
        ["view", "<selector>", "colony cockpit: link live bees' windows into a view session"],
        ["search", "<query>", "search seals, ledger, and session records (seals find: seals only)"],
        ["usage", "[<account>]", "progress against providers' real 5h/weekly limits (alias: limits)"],
      ],
    },
    {
      title: "Manage bees",
      rows: [
        ["attach", "<session>", "attach to the tmux session (nesting-safe inside tmux)"],
        ["next", "", "jump to the next bee needing you (waiting/done/failed; --prev, --state)"],
        ["split", "[<bee>] [<agent>]", "spawn a sub-bee into the bee's comb (adjacent pane)"],
        ["fork", "<bee> [checkpoint]", "branch a bee into a fresh comb, seeded from its state"],
        ["here", "", "resolve the bee owning the current pane (--id, --json)"],
        ["spawn-picker", "[--frame|--flow]", "print frame/flow names for a display-popup spawn chord"],
        ["urls", "[<bee>]", "list URLs printed in a bee's pane (--lines, --open, --json)"],
        ["keys", "<print|path|check>", "print/verify the recommended tmux keybinding set"],
        ["kill", "<session>", "stop a bee (its pane) or a whole comb (--comb)"],
        ["revive", "<bee>", "relaunch a dead bee and resume its session (--all, --fresh, --session <id>)"],
        ["clean", "--dead|--idle|-i", "remove dead metadata, kill idle bees, or clean interactively"],
        ["loop", "<launch|start|status|stop|…>", "run a bee repeatedly until a stop condition (launch = interactive dialog)"],
      ],
    },
    {
      title: "Organize",
      rows: [
        ["colony", "<list|create|…>", "manage project-scoped namespaces"],
        ["swarm", "<list|inspect|destroy>", "manage live or destroyed bee cohorts"],
        ["frame", "<list|define|…>", "manage reusable swarm blueprints"],
        ["flow", "<list|run|runs|…>", "manage and run flow definitions"],
        ["own", "<owner> <bee>...", "set the owned-by/reports-to edge (--clear to unset)"],
        ["move", "<bee> --colony <c>", "reassign a bee's colony (or --owner <o> alias)"],
      ],
    },
    {
      title: "Accounts",
      rows: [
        ["account", "<list|add|sync|…>", "manage provider accounts in the local credential vault"],
        ["activate", "<account>", "seed an account's credentials into a home slot (fast login)"],
        ["login", "<account>", "interactive (re)login seat in tmux; captures fresh credentials"],
        ["swap-account", "<bee> <account>", "re-credential a bee's home and resume on another account"],
      ],
    },
    {
      title: "Substrate & daemon",
      rows: [
        ["node", "<list|register|…>", "manage substrate endpoints (local + ssh-tmux)"],
        ["substrate", "list", "show available substrate kinds"],
        ["daemon", "<status|logs|…>", "manage the hive daemon LaunchAgent + inspect state/logs"],
        ["sessions", "reconcile", "index sessions across all homes; flag dupes and conflicts"],
        ["sync", "manifest", "write the syncthing include/exclude manifest"],
      ],
    },
    {
      title: "Setup",
      rows: [
        ["config", "<show|set-bee|…>", "view or edit ~/.hive/config.json defaults"],
        ["completion", "<bash|zsh|fish>", "print a shell completion script (eval to install)"],
      ],
    },
  ];

  // One alignment width across all groups, so the description column lines up.
  const invocation = (name: string, syn: string) => `hive ${name}${syn ? ` ${syn}` : ""}`;
  const width = Math.max(
    ...groups.flatMap((g) => g.rows.map(([name, syn]) => invocation(name, syn).length)),
  );

  const renderRow = ([name, syn, desc]: [string, string, string]) => {
    const plain = invocation(name, syn);
    const colored = `hive ${cmd(name)}${syn ? ` ${arg(syn)}` : ""}`;
    const padded = colored + " ".repeat(Math.max(0, width - plain.length));
    return `  ${padded}   ${dim(desc)}`;
  };

  const sections = groups
    .map((g) => `${heading(g.title)}\n${g.rows.map(renderRow).join("\n")}`)
    .join("\n\n");

  const bees = [
    "  claude, codex, opencode, grok, pi, droid, cursor — or any executable on PATH",
    `  ${dim("home aliases: codex1, codex2, codex3, cc1, cc2, cc3")}`,
    `  ${dim("account shorthands: <tool>-<account fragment> (codex-ur, claude-thto) — see hive account list")}`,
    `  ${dim("<tool>-auto / --account auto: pick the account with the least weekly usage")}`,
  ].join("\n");

  const envs = [
    `  ${env("HIVE_CLAUDE_CMD")}=${arg(`"claude --model sonnet"`)} hive spawn claude`,
    `  ${env("HIVE_CODEX_YOLO")}=${arg("1")} hive spawn codex`,
    `  ${env("HIVE_DEBUG_SPAWN")}=${arg("1")} hive spawn claude  ${dim("— print a per-phase spawn timing breakdown to stderr")}`,
    `  ${dim("hive spawn codex2 · hive spawn claude --home ~/.claude-3 · hive spawn cc3")}`,
  ].join("\n");

  console.log(`${head}  ${dim("— run any command with no/invalid args for its full usage")}

${heading("Usage")}
  ${cmd("hive")} ${arg("<command> [args]")}

${sections}

${heading("Bees")}
${bees}

${heading("Env overrides")}
${envs}
`);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const [first, ...rest] = message.split("\n");
  console.error(`${errorPrefix()} ${first}`);
  for (const line of rest) console.error(dim(line));
  process.exitCode = 1;
});
