#!/usr/bin/env node
import { access, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn as spawnChild } from "node:child_process";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { agentDefaultsToYolo, assertAgentAuthFreshForSpawn, canonicalAgentKind, forcedSessionIdArgs, resolveAgent, resolveHome, shellCommand, tmuxOptionsForAgent, type AgentSpec } from "./agents.js";
import {
  AUTO_ACCOUNT_QUERY,
  RR_ACCOUNT_QUERY,
  type AccountChainSyncOutcome,
  type AccountRecord,
  type SpawnAgentSpec,
  accountEmail,
  accountHasCredentials,
  accountsRegistryPath,
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
import { agentKinds, autoAliasForcesYolo, bootMsForAgent, defaultsToSoleCredentialedAccount, identityEnvForAgent, identityRecipeForAgent, sessionPinnedInArgs, type IdentityRecipe } from "./drivers.js";
import { mapWithConcurrency } from "./concurrency.js";
import { credentialDigest, readClaudeKeychain } from "./keychain.js";
import { attachBeeWithSidebar, readBeesGroupMode, resolveCurrentSidebarBeeName, showBeeBesideSidebar, syncBeesSidebarLayout, toggleBeesSidebar, writeBeesGroupMode } from "./beesSidebar.js";
import { beesTuiSearchText, runBeesTui, type BeesTuiItem } from "./beesTui.js";
import { clampUsageInterval, runUsageTui } from "./usageTui.js";
import { chooseNewBee, type SpawnTuiAccount } from "./spawnTui.js";
import { chooseLaunch, type LaunchTemplate } from "./launchTui.js";
import { chooseLoop, loopStartArgs, type LoopLaunchResult } from "./loopTui.js";
import { chooseFork, defaultForkForm, forkIntent, type ForkAccountOption } from "./forkTui.js";
import { listLoopTemplates, loadLoopTemplate, removeLoopTemplate, saveLoopTemplate, type LoopTemplate, type LoopTemplateInput } from "./loopTemplate.js";
import { acquireProSlot, createProSlot, deleteProSlot, listProRepoEntries, listProRepos, prewarmProRepos, resolveProEntryForCwd, resolveProSlotForCwd, toProSlug, type ProRepoEntry, type ProSlotKind } from "./proProjects.js";
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
import { createGroupedSession, ensureLinkSession, linkTargetsInto, linkWindowsInto, sessionWindowInventory, windowInventory, type EnsureLinkSessionResult } from "./tmuxLink.js";
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
import { defineFrameFromFile, frameDefinitionFile, frameExists, listFrames, loadFrame, loadFrameSource, removeFrame, validateFrame, writeFrameFromObject, writeFrameFromValidatedObject, type Frame } from "./frame.js";
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
import { type BeeState, cleanStatePriority, type DerivedState, deriveState, formatStateCell, isTerminalState, liveTargetKey, stateLabel, type StateContext } from "./state.js";
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
import { authPolicyOf, describeAuthPolicy, LOCAL_NODE_NAME, listNodes, loadNode, loadNodeSync, type AuthPolicy, type NodeRecord, registerNode, supportsCapability, unregisterNode, updateNode, validNodeName } from "./node.js";
import { mintEphemeralCredential, type EphemeralCredential } from "./hsr/remoteCreds.js";
import { bootstrapRunnerHost } from "./hsr/bootstrap.js";
import { nodeHealth, type NodeHealth } from "./nodeHealth.js";
import { appendLedger, deleteSession, listSessions, loadSession, safeName, saveSession, storeRoot, updateSession, type SessionRecord } from "./store.js";
import { appendedPaneText, parseTailOptions } from "./tail.js";
import { clearSubstrateCache, localSubstrate, remoteHsrSubstrateForNode, substrateFor, substrateForRecord, type Substrate } from "./substrates/index.js";
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
import {
  APP_NAME,
  VERSION,
  acceptsTrust,
  ageFlag,
  arrayFlag,
  assertLocalFleetReadable,
  buildStateContext,
  cleanupAfterRun,
  confirmSpawnReady,
  confirmSpawnReadyAll,
  currentTmuxSession,
  currentTmuxSessionName,
  dangerousMode,
  defaultSubstrateIsSshTmux,
  deliverBrief,
  deliverSpawnBrief,
  emitLog,
  ensureLive,
  followFlag,
  formatHiveStateCell,
  formatPaneExcerpt,
  hasFlag,
  hsrSubstrateRequested,
  liveTargetsAcrossNodes,
  logLinesFlag,
  observeHsrLiveness,
  resolveBeeInCurrentPane,
  resolveSession,
  resolveSpawnColony,
  resolveSpawnCwd,
  resolveSpawnNode,
  resolveSpawnSubstrate,
  resolveSwarmIdHint,
  safeTmuxTarget,
  sleep,
  stringFlag,
  transcriptBanner,
  ttlFlagMs,
} from "./cli/shared.js";

// Re-exports consumed by the unit tests (tests/*.test.ts import these from
// "../src/cli.js"). As the HIVE-15 decomposition moves handlers into
// src/commands/* and src/cli/shared.ts, cli.ts keeps re-exporting the same
// public surface so those imports keep resolving.
export { emitLog, followFlag, logLinesFlag, resolveSpawnSubstrate } from "./cli/shared.js";
export { resolveDefineArgs } from "./commands/frame.js";
export { assertResumable, tmuxSessionSurvives } from "./commands/migrate.js";
export { assertSingleBeeInvocation } from "./commands/run.js";
import { runHsrHostFromPayload, spawnHsrHost, waitForHsrHost } from "./hsr/runnerHost.js";

// Command handlers extracted into src/commands/* (HIVE-15). cli.ts dispatches
// to these; each module owns its command's helpers.
import { cmdAccount, cmdActivate, cmdLimits, cmdLogin, cmdSwapAccount, cmdUsageSamples, wantsUsageLive } from "./commands/account.js";
import { cmdBuz } from "./commands/buz.js";
import { cmdClean, openBeePreviewPopup } from "./commands/clean.js";
import { cmdColony } from "./commands/colony.js";
import { cmdCompletion, cmdConfig } from "./commands/config.js";
import { cmdDaemon, cmdSessions, cmdSync } from "./commands/daemon.js";
import { cmdFlow, flowRun, parseFlowRunArgs, runFlowExec } from "./commands/flow.js";
import { cmdFork, cmdForkLaunch, cmdSplit } from "./commands/fork.js";
import { cmdFrame, resolveDefineArgs } from "./commands/frame.js";
import { cmdKeys } from "./commands/keys.js";
import { cmdAnswer, cmdBrief, cmdMove, cmdOwn, cmdRename, cmdSeal, cmdSend, cmdTag } from "./commands/messaging.js";
import { cmdDemote, cmdPromote, cmdRevive, reviveRecord } from "./commands/migrate.js";
import { cmdNode, cmdSubstrate } from "./commands/node.js";
import { cmdOpen, cmdRun, cmdX, cmdXa } from "./commands/run.js";
import { cmdSeals, cmdSearch } from "./commands/search.js";
import {
  cmdLaunch,
  cmdNew,
  cmdSpawn,
  listNewBeeSubdirs,
  maybeLinkHere,
  newBeeAccountRows,
  resolveAccountFlag,
  resolveProfileOverlay,
  resolveSpawnAgentWithAuto,
  spawnFromFrame,
} from "./commands/spawn.js";
import { cmdSwarm } from "./commands/swarm.js";

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
    case "promote":
      await cmdPromote(parsed);
      break;
    case "demote":
      await cmdDemote(parsed);
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
      if (truthy(flag(parsed, "samples"))) {
        if (wantsUsageLive(parsed)) throw new Error("--live applies to the limits view, not --samples");
        await cmdUsageSamples(parsed);
      } else await cmdLimits(parsed);
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

  const context = await buildStateContext(records, probe);
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

  const context = await buildStateContext(records, probe);

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
  if (!target) throw new Error("Usage: hive kill <session>");
  const record = await resolveSession(target);

  // Combs are retired (APIA-85): every bee is solo (its own session/runner host),
  // so a kill always tears down the whole session via the transactional path.
  // The pane-pinned `agentPaneId` is kept for I/O targeting, not comb membership.
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

// ──────────────────────────────────────────────────────────────────────────
// promote / demote (APIA-84): move a bee between HSR (pane-less) and local-tmux
// by RESUMING the same provider session. The chat/transcript never blinks
// because it is the same native transcript file (HSR_EXPLORATION.md §4). Gated
// on verified resume: claude + codex only.
// ──────────────────────────────────────────────────────────────────────────

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
  const ensured = await ensureWorkspaceSession(session);

  // Materialize bee members: resolve each bee's live session, link its window in.
  const index = await beeSessionIndex();
  const beeTargets: string[] = [];
  for (const member of record.members) {
    if (member.kind !== "bee") continue;
    const bee = resolveBeeMember(index, member.beeId);
    if (!bee) continue;
    if (bee.node && bee.node !== LOCAL_NODE_NAME) continue;
    if (!index.liveNames.has(bee.tmuxTarget)) continue;
    beeTargets.push(bee.tmuxTarget);
    // Converge with `add`: a member bee must carry workspaceId so ws:<name>
    // (derived from bee.workspaceId) and record.members never disagree.
    await stampWorkspaceMembership(bee, record.name);
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

/**
 * Shared workspace/quest session bootstrap (open/restore/quest-start): ensure
 * the link session, make it persist across terminal close, and mark the
 * placeholder shell as the workspace's own window so `close` may reap it (it
 * survives as the anchor of an empty/pane-only workspace).
 */
async function ensureWorkspaceSession(session: string): Promise<EnsureLinkSessionResult> {
  const ensured = await ensureLinkSession(session);
  await setWorkspaceOptions(session);
  if (ensured.placeholder) await markWorkspaceOwnWindow(session, ensured.placeholder);
  return ensured;
}

/**
 * Session records keyed by id ?? name plus the live local tmux session set —
 * the resolution workspaceOpen and restore share for materializing bee members.
 */
type BeeSessionIndex = { records: SessionRecord[]; byId: Map<string, SessionRecord>; liveNames: Set<string> };

async function beeSessionIndex(): Promise<BeeSessionIndex> {
  const records = await listSessions();
  const byId = new Map(records.map((r) => [r.id ?? r.name, r] as const));
  const liveNames = new Set(await localSubstrate().listSessions());
  return { records, byId, liveNames };
}

/** Resolve a workspace bee member to its record — member ids may be record ids or bare names. */
function resolveBeeMember(index: BeeSessionIndex, beeId: string): SessionRecord | undefined {
  return index.byId.get(beeId) ?? index.records.find((r) => r.name === beeId);
}

/**
 * The members accumulator add/quest-start share: existing members (order
 * preserved) plus the bee-member id set for dedup.
 */
export type WorkspaceMembership = { members: WorkspaceMember[]; memberIds: Set<string> };

export function seedWorkspaceMembers(existing: WorkspaceMember[] | undefined): WorkspaceMembership {
  const members: WorkspaceMember[] = existing ? [...existing] : [];
  const memberIds = new Set(members.filter((m) => m.kind === "bee").map((m) => (m as { beeId: string }).beeId));
  return { members, memberIds };
}

/** Record a bee as a workspace member once (keyed by id ?? name). */
export function addBeeMember(membership: WorkspaceMembership, bee: SessionRecord): void {
  const beeId = bee.id ?? bee.name;
  if (membership.memberIds.has(beeId)) return;
  membership.members.push({ kind: "bee", beeId });
  membership.memberIds.add(beeId);
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

  const membership = seedWorkspaceMembers(record.members);
  const inventory = await windowInventory();
  const currentWindows = new Set(inventory.windows.get(session) ?? []);
  let linkedCount = 0;
  for (const bee of live) {
    const windowId = inventory.active.get(bee.tmuxTarget);
    if (!windowId) continue;
    const linked = await linkWindowsInto(session, currentWindows, [{ session: bee.tmuxTarget, windowId }], { select: false });
    linkedCount += linked;
    if (linked > 0) currentWindows.add(windowId);
    addBeeMember(membership, bee);
    // Stamp workspaceId on the live bee so the derived ws: tag refreshes
    // (cmdMove colony pattern).
    const now = new Date().toISOString();
    await updateSession(bee.name, { workspaceId: record.name, updatedAt: now });
    await writeHiveTags({ ...bee, workspaceId: record.name });
  }
  await updateWorkspace(record.name, { members: membership.members });

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

  // Same session bootstrap as workspaceOpen.
  const ensured = await ensureWorkspaceSession(session);

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
  const index = await beeSessionIndex();
  const beeTargets: string[] = [];
  const seenBees = new Set<string>();
  let beeCount = 0;
  for (const member of record.members) {
    if (member.kind !== "bee") continue;
    // Defensive against a hand-edited record with a duplicate bee member: process
    // each beeId once so we never revive (or double-count) the same bee twice.
    if (seenBees.has(member.beeId)) continue;
    seenBees.add(member.beeId);
    const bee = resolveBeeMember(index, member.beeId);
    if (bee && bee.node && bee.node !== LOCAL_NODE_NAME) {
      // link-window cannot cross tmux servers; leave a remote bee for its node.
      console.error(note(`skip remote bee ${member.beeId} — restore links local windows only`));
      continue;
    }
    if (bee && index.liveNames.has(bee.tmuxTarget)) {
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
  const ensured = await ensureWorkspaceSession(session);

  const inventory = await windowInventory();
  const liveNames = new Set(await localSubstrate().listSessions());
  const wsRecord = await loadWorkspace(quest.workspace);
  const membership = seedWorkspaceMembers(wsRecord?.members);
  const beeTargets: string[] = [];
  for (const bee of records) {
    await stampQuestMembership(bee, quest.id, quest.colony, quest.workspace);
    // Only local + live windows can be link-window'd (the workspaceAdd discipline).
    if (bee.node && bee.node !== LOCAL_NODE_NAME) continue;
    if (!liveNames.has(bee.tmuxTarget)) continue;
    const windowId = inventory.active.get(bee.tmuxTarget);
    if (!windowId) continue; // no live window to link — never record a phantom member
    beeTargets.push(bee.tmuxTarget);
    addBeeMember(membership, bee);
  }
  await linkTargetsInto(session, beeTargets, ensured);
  // Persist the bee membership on the workspace so a later restore brings them
  // back (converges with the workspace add/open invariant).
  await updateWorkspace(quest.workspace, { members: membership.members });

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
  const ensured = await ensureWorkspaceSession(session);

  // Seed the members accumulator from the existing workspace record. The
  // onSpawned hook appends to it as each bee spawns; we persist it once
  // after the flow returns (members are records, so they survive kill-on-end).
  const wsRecord = await loadWorkspace(quest.workspace);
  const membership = seedWorkspaceMembers(wsRecord?.members);
  const currentWindows = new Set((await sessionWindowInventory(session)).windows);
  let placeholderDropped = false;

  // Per-spawn hook: replicate the --frame loop body for ONE bee. The spawned
  // bee's windows must be read per spawn because bees appear over time, but a
  // single-session `list-windows -t =bee` is enough; avoid a global `-a` scan.
  const onSpawned = async (bee: SessionRecord): Promise<void> => {
    await stampQuestMembership(bee, quest.id, quest.colony, quest.workspace);
    // Only local + live windows can be link-window'd (the workspaceAdd discipline).
    if (bee.node && bee.node !== LOCAL_NODE_NAME) return;
    const beeWindows = await sessionWindowInventory(bee.tmuxTarget);
    const windowId = beeWindows.active;
    if (!windowId) return; // no live window to link — never record a phantom member
    const linked = await linkWindowsInto(session, currentWindows, [{ session: bee.tmuxTarget, windowId }], { select: false });
    if (linked > 0) {
      currentWindows.add(windowId);
      if (ensured.placeholder && !placeholderDropped) {
        await tmux(["kill-window", "-t", `=${session}:${ensured.placeholder}`], { reject: false });
        currentWindows.delete(ensured.placeholder);
        placeholderDropped = true;
      }
      if (ensured.created) {
        await tmux(["select-window", "-t", `=${session}:${windowId}`], { reject: false });
      }
    }
    addBeeMember(membership, bee);
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
    await updateWorkspace(quest.workspace, { members: membership.members });
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
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(`@${swarmId}`), dim(`${membership.members.length} bee(s)`), colored]));
    if (outcome.error?.message) console.error(dim(`error: ${outcome.error.message}`));
  } else {
    console.log(`quest-started\t${quest.id}\t${swarmId}\t${membership.members.length}\t${outcome.status}`);
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
      // reap the orphan afterwards. Re-read from disk (not the quest listing's
      // possibly-stale `bee`) so daemon merges since then — auto-title,
      // providerSessionId — survive into the archived record (HIVE-49).
      const snapshot = (await loadSession(bee.name)) ?? { ...bee };
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
  const args: Record<string, unknown> = {
    bee: typeof flag(parsed, "bee") === "string" ? String(flag(parsed, "bee")) : "",
    cwd: typeof flag(parsed, "cwd") === "string" ? String(flag(parsed, "cwd")) : "",
    context: typeof flag(parsed, "context") === "string" ? String(flag(parsed, "context")) : "",
    prompt,
    until: typeof flag(parsed, "until") === "string" ? String(flag(parsed, "until")) : "",
    max: typeof flag(parsed, "max") === "string" ? String(flag(parsed, "max")) : undefined,
    maxDuration: typeof flag(parsed, "max-duration") === "string" ? String(flag(parsed, "max-duration")) : "",
    forever: truthy(flag(parsed, "forever")),
    stopOnSentinel: typeof flag(parsed, "stop-on-sentinel") === "string" ? String(flag(parsed, "stop-on-sentinel")) : "",
    judge: typeof flag(parsed, "judge") === "string" ? String(flag(parsed, "judge")) : "",
    summarizer: typeof flag(parsed, "summarizer") === "string" ? String(flag(parsed, "summarizer")) : "",
    yolo: truthy(flag(parsed, "yolo")),
  };
  const stopOnSeal = flag(parsed, "stop-on-seal");
  if (stopOnSeal !== undefined) args.stopOnSeal = Array.isArray(stopOnSeal) ? stopOnSeal.join(",") : stopOnSeal === true ? "" : String(stopOnSeal);
  return args;
}

/** Resolve a loop prompt from --prompt or --prompt-file (mutually exclusive; may be empty). */
export async function resolvePromptArg(parsed: Parsed): Promise<string> {
  const prompt = typeof flag(parsed, "prompt") === "string" ? String(flag(parsed, "prompt")) : "";
  const promptFile = typeof flag(parsed, "prompt-file") === "string" ? String(flag(parsed, "prompt-file")) : undefined;
  if (promptFile) {
    if (prompt) throw new Error("Provide either --prompt or --prompt-file, not both.");
    return (await readFile(resolve(promptFile), "utf8")).trim();
  }
  return prompt;
}

async function loopStartCmd(parsed: Parsed) {
  await startLoopDetached(loopArgsFromFlags(parsed, await resolvePromptArg(parsed)));
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
  const cfg = buildLoopConfig(rawArgs);

  if (process.platform === "win32") {
    throw new Error("hive loop start is not supported on Windows (POSIX process groups are required to stop).");
  }

  const loopId = await generateLoopId();
  cfg.loopId = loopId;
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
  const prompt = await resolvePromptArg(parsed);
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

  const follow = followFlag(parsed);
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
    await emitLog({ text, path });
    return;
  }

  if (follow) {
    await followLoopLog(loopId);
    return;
  }
  await emitLog({
    text: await readLogFull("loop", loopId),
    path: runLogPath("loop", loopId),
    lines: logLinesFlag(parsed, 0),
  });
}

async function followLoopLog(loopId: string): Promise<void> {
  const path = runLogPath("loop", loopId);
  let offset = 0;
  const printAppended = async () => {
    const result = await readLogSince(path, offset);
    offset = result.offset;
    if (result.text.length > 0) process.stdout.write(result.text);
  };
  while (true) {
    await printAppended();
    const cfg = await readLoopConfig(loopId).catch(() => null);
    if (cfg && cfg.status !== "running") break;
    if (cfg && cfg.status === "running" && typeof cfg.pid === "number" && !processAlive(cfg.pid)) {
      console.error(note(`loop driver (pid ${cfg.pid}) is gone but loop.json still says running; log will not grow`));
      break;
    }
    await sleep(1_000);
  }
  // One final read: catch lines appended between the last read and the status flip.
  await printAppended();
}

async function readLogSince(path: string, offset: number): Promise<{ text: string; offset: number }> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile()) return { text: "", offset: 0 };
  const start = info.size < offset ? 0 : offset;
  const length = info.size - start;
  if (length <= 0) return { text: "", offset: info.size };

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), offset: start + bytesRead };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", offset: 0 };
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
    const latestCfg = await readLoopConfig(loopId).catch(() => null);
    if (latestCfg?.status === "running") {
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
        ["usage", "[<account>]", "progress against providers' real 5h/weekly limits (--live dashboard; alias: limits)"],
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
        ["promote", "<bee>", "move an HSR bee onto an interactive tmux pane (resume; claude/codex, --now)"],
        ["demote", "<bee>", "move a tmux bee back to a pane-less HSR runner (resume; claude/codex, --now)"],
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
    `  ${dim("<tool>-auto / --account auto: pick the least-loaded account (pace-aware: prefers unused quota expiring at the next reset)")}`,
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
