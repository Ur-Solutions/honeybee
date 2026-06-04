#!/usr/bin/env node
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { resolveAgent, shellCommand } from "./agents.js";
import { deadSessionAge, deadSessionRecords, olderThanMillis, parseAge } from "./clean.js";
import { archiveColony, createColony, listColonies, loadColony, renameColony, updateColony } from "./colony.js";
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
import { briefFooter, configPath, loadConfig, resetConfigCache } from "./config.js";
import { getCompletions, shellScript } from "./completion.js";
import { defineFrameFromFile, frameExists, listFrames, loadFrame, loadFrameSource, removeFrame, validateFrame, writeFrameFromObject, type Frame } from "./frame.js";
import { defineFlowFromFile, listFlows, loadFlow, loadFlowSource, removeFlow, type Flow } from "./flow/index.js";
import { executeFlow } from "./flow/run.js";
import { cancelRun, spawnDetachedRun } from "./flow/background.js";
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
import { listSeals, loadLatestSeal, recordSeal, sealedBeeNames as sealedBeeNamesImpl, validateSealArtifact } from "./seal.js";
import { search, type SearchHit, type SearchOptions, type SearchTypeFilter } from "./search.js";
import { resolveSelector } from "./selectors.js";
import { type BeeState, deriveState, isTerminalState, stateLabel, type StateContext } from "./state.js";
import { createSwarm, destroySwarm, generateSwarmId, listSwarms, loadSwarm, saveSwarm, validSwarmId } from "./swarm.js";
import { actionLine, bold, cyan, dim, errorPrefix, formatRelativeTime, formatTable, gray, green, isPretty, magenta, note, red, statusDot, tildify, truncate, yellow } from "./format.js";
import { allocateBeeIdentity, highlightUniqueSessionReference, matchesSessionReference } from "./ids.js";
import { shouldShowNodeColumn } from "./listView.js";
import { flag, numberFlag, parse, truthy, type Parsed } from "./parse.js";
import { AgentReadinessError, waitForAgentReady } from "./readiness.js";
import { LOCAL_NODE_NAME, listNodes, loadNode, type NodeRecord, registerNode, supportsCapability, unregisterNode, updateNode, validNodeName } from "./node.js";
import { appendLedger, deleteSession, listSessions, loadSession, safeName, saveSession, type SessionRecord } from "./store.js";
import { appendedPaneText, parseTailOptions } from "./tail.js";
import { clearSubstrateCache, localSubstrate, substrateFor, substrateForRecord } from "./substrates/index.js";
import { attachCommand, attachSession, capture, formatShellCommand, hasSession, kill, listTmuxSessions, newSession, sendText } from "./tmux.js";
import { hasTranscriptProvider, lastAssistantText, latestTranscript, renderTranscript } from "./transcripts.js";
import { waitForIdle } from "./wait.js";

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
  const parsed = parse(argv);
  switch (parsed.command) {
    case "spawn":
      await cmdSpawn(parsed);
      break;
    case "send":
      await cmdSend(parsed);
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
    case "clean":
      await cmdClean(parsed);
      break;
    case "run":
      await cmdRun(parsed);
      break;
    case "attach":
      await cmdAttach(parsed);
      break;
    case "completion":
      await cmdCompletion(parsed);
      break;
    case "colony":
      await cmdColony(parsed);
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
    case "buz":
      await cmdBuz(parsed);
      break;
    case "daemon":
      await cmdDaemon(parsed);
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
  const countRaw = numberFlag(parsed, ["count"], 1);
  if (frameName) {
    const records = await spawnFromFrame(parsed, frameName);
    return records[0]!;
  }
  if (countRaw > 1) {
    const records = await spawnHomogeneousSwarm(parsed, countRaw);
    return records[0]!;
  }
  return spawnSingleBee(parsed);
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
};

async function spawnBee(opts: SpawnOptions): Promise<SessionRecord> {
  const spec = resolveAgent(opts.agent, opts.extraArgs, { home: opts.home, yolo: opts.yolo });
  const isRemote = Boolean(opts.node && opts.node.kind === "ssh-tmux");
  // Executable validation only applies to local spawns; we cannot reach the remote PATH cheaply.
  if (!isRemote) await assertExecutableAvailable(spec.command);
  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  const name = safeName(opts.name ?? identity.id);
  const tmuxTarget = safeTmuxTarget(name);
  const nodeName = opts.node?.name ?? LOCAL_NODE_NAME;
  const substrate = opts.node ? substrateForRecord(opts.node) : localSubstrate();
  const locationHint = isRemote && opts.node ? ` on ${opts.node.name}` : "";
  if (await substrate.hasSession(tmuxTarget)) throw new Error(`tmux session already exists${locationHint}: ${tmuxTarget}`);
  await substrate.newSession(tmuxTarget, opts.cwd, { command: spec.command, args: spec.args, env: spec.env });
  const command = shellCommand(spec);

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    agent: spec.kind,
    cwd: opts.cwd,
    command,
    tmuxTarget,
    createdAt: now,
    updatedAt: now,
    status: "running",
    id: identity.id,
    prefix: identity.prefix,
    uuid: identity.uuid,
    requestedAgent: spec.requestedKind,
    homePath: spec.homePath,
    ...(opts.colony ? { colony: opts.colony } : {}),
    ...(opts.swarmId ? { swarmId: opts.swarmId } : {}),
    ...(opts.caste ? { caste: opts.caste } : {}),
    ...(opts.brief ? { brief: opts.brief } : {}),
    ...(nodeName !== LOCAL_NODE_NAME ? { node: nodeName } : {}),
  };
  await saveSession(record);
  return record;
}

async function spawnSingleBee(parsed: Parsed): Promise<SessionRecord> {
  const agent = parsed.args[0];
  if (!agent) throw new Error("Usage: hive spawn <bee> [--name name] [--cwd dir] [-- <bee-args...>]");
  const cwd = await resolveSpawnCwd(parsed);
  const yolo = dangerousMode(parsed, agent);
  const home = flag(parsed, "home") ?? flag(parsed, "profile");
  const colony = await resolveSpawnColony(parsed);
  const spec = resolveAgent(agent, parsed.rest, { home, yolo });
  const node = await resolveSpawnNode(parsed, spec.kind);
  const name = typeof flag(parsed, "name") === "string" ? String(flag(parsed, "name")) : undefined;
  const briefText = typeof flag(parsed, "brief") === "string" ? String(flag(parsed, "brief")) : undefined;
  let record = await spawnBee({ agent, extraArgs: parsed.rest, cwd, yolo, home, name, colony, brief: briefText, node });
  const nodeSuffix = node.name !== LOCAL_NODE_NAME ? [dim(`node:${node.name}`)] : [];
  if (isPretty()) console.log(actionLine("ok", "spawn", [bold(record.name), record.agent, dim(tildify(cwd)), ...nodeSuffix]));
  else console.log(`${record.name}\t${agent}\t${cwd}\t${node.name}`);
  if (truthy(flag(parsed, "briefed")) && briefText) {
    record = await deliverBrief(parsed, record, briefText);
  } else {
    await confirmSpawnReady(parsed, record);
  }
  return record;
}

async function spawnHomogeneousSwarm(parsed: Parsed, count: number): Promise<SessionRecord[]> {
  const agent = parsed.args[0];
  if (!agent) throw new Error("Usage: hive spawn <bee> --count <n> [--colony name]");
  if (!Number.isInteger(count) || count < 2) throw new Error(`--count must be an integer >= 2 (got ${count})`);
  const cwd = await resolveSpawnCwd(parsed);
  const yolo = dangerousMode(parsed, agent);
  const home = flag(parsed, "home") ?? flag(parsed, "profile");
  const colony = await resolveSpawnColony(parsed);
  const spec = resolveAgent(agent, parsed.rest, { home, yolo });
  const node = await resolveSpawnNode(parsed, spec.kind);
  const swarmId = resolveSwarmIdHint(parsed, agent);

  const records: SessionRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = await spawnBee({ agent, extraArgs: parsed.rest, cwd, yolo, home, colony, swarmId, node });
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

async function spawnFromFrame(parsed: Parsed, frameName: string): Promise<SessionRecord[]> {
  const frame: Frame | null = await loadFrame(frameName);
  if (!frame) throw new Error(`Unknown frame: ${frameName}. Define one with: hive frame define <file>`);
  const cwd = await resolveSpawnCwd(parsed);
  const colony = await resolveSpawnColony(parsed);
  const swarmId = resolveSwarmIdHint(parsed, frame.name);

  const briefed = truthy(flag(parsed, "briefed"));
  const flagHome = flag(parsed, "home") ?? flag(parsed, "profile");
  const records: SessionRecord[] = [];
  for (const caste of frame.castes) {
    const yolo = dangerousMode(parsed, caste.bee);
    const home = caste.home ?? flagHome;
    const casteSpec = resolveAgent(caste.bee, parsed.rest, { home, yolo });
    const casteNode = await resolveSpawnNode(parsed, casteSpec.kind);
    for (let i = 0; i < caste.count; i += 1) {
      let record = await spawnBee({
        agent: caste.bee,
        extraArgs: parsed.rest,
        cwd,
        yolo,
        ...(home !== undefined ? { home } : {}),
        colony,
        swarmId,
        caste: caste.name,
        node: casteNode,
        ...(caste.brief ? { brief: caste.brief } : {}),
      });
      if (briefed && caste.brief) record = await deliverBrief(parsed, record, caste.brief);
      records.push(record);
      if (isPretty()) console.log(actionLine("ok", "spawn", [bold(record.name), record.agent, dim(`caste:${caste.name}`), dim(`@${swarmId}`)]));
      else console.log(`${record.name}\t${caste.bee}\t${cwd}\t${caste.name}\t@${swarmId}`);
    }
  }

  await confirmSpawnReadyAll(parsed, records);

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
    if (isPretty()) console.log(actionLine("ok", "seal", [bold(record.name), dim(stored.status), dim(stored.type ?? "")]));
    else console.log(`sealed\t${record.name}\t${stored.status}\t${stored.type ?? ""}\t${stored.sealedAt}`);
  }
}

async function cmdBrief(parsed: Parsed) {
  const target = parsed.args[0];
  const briefText = String(flag(parsed, "brief") ?? flag(parsed, "b") ?? parsed.args.slice(1).join(" "));
  if (!target || !briefText) throw new Error("Usage: hive brief <selector> <text> OR hive brief <selector> --brief <text>");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    await ensureLive(record);
    await deliverBrief(parsed, record, briefText);
  }
}

async function deliverBrief(parsed: Parsed, record: SessionRecord, briefText: string): Promise<SessionRecord> {
  try {
    await waitForAgentReady(record, {
      timeoutMs: numberFlag(parsed, ["boot-ms"], defaultBootMs(record.agent)),
      acceptTrust: acceptsTrust(parsed),
      raiseDroidAutonomy: dangerousMode(parsed, record.agent),
    });
  } catch (error) {
    if (!(error instanceof AgentReadinessError) || error.reason !== "timeout" || !truthy(flag(parsed, "force-send"))) throw error;
    console.error(actionLine("warn", "force", [`readiness timeout for ${bold(record.name)}, briefing anyway`]));
  }
  const delivered = augmentBrief(parsed, briefText);
  await substrateFor(record).sendText(record.tmuxTarget, delivered);
  const now = new Date().toISOString();
  const updated: SessionRecord = { ...record, updatedAt: now, status: "running", brief: briefText, briefedAt: now };
  await saveSession(updated);
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
  try {
    await waitForAgentReady(record, {
      timeoutMs: numberFlag(parsed, ["boot-ms"], defaultBootMs(record.agent)),
      acceptTrust: acceptsTrust(parsed),
      raiseDroidAutonomy: dangerousMode(parsed, record.agent),
    });
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

async function resolveSpawnCwd(parsed: Parsed): Promise<string> {
  const requested = resolve(String(flag(parsed, "cwd") ?? process.cwd()).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
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
  const prompt = String(flag(parsed, "prompt") ?? flag(parsed, "p") ?? parsed.args.slice(1).join(" "));
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
    await substrateFor(record).sendText(record.tmuxTarget, prompt);
    const now = new Date().toISOString();
    await saveSession({ ...record, updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now });
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
  console.log(await substrateFor(record).capture(record.tmuxTarget, options.lines));
}

async function followTail(record: SessionRecord, lines: number, pollMs: number): Promise<void> {
  let previous = "";
  while (true) {
    await ensureLive(record);
    const next = await substrateFor(record).capture(record.tmuxTarget, lines);
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
  if (nodeFilter) {
    const node = await loadNode(nodeFilter);
    if (!node) throw new Error(`Unknown node: ${nodeFilter}. Register it with: hive node register ${nodeFilter} --kind ssh-tmux --endpoint user@host`);
  }
  const probe = await liveTargetsAcrossNodes(nodes, nodeFilter);
  let records = allRecords;
  if (colonyFilter) records = records.filter((r) => r.colony === colonyFilter);
  if (swarmFilter) records = records.filter((r) => r.swarmId === swarmFilter);
  if (nodeFilter) records = records.filter((r) => (r.node ?? LOCAL_NODE_NAME) === nodeFilter);

  const panes = await capturePanesFor(records, probe.liveTargets);
  const seals = await listSealedBeeNames();
  const context: StateContext = {
    liveTargets: probe.liveTargets,
    panes,
    seals,
    unreachableNodes: probe.unreachableNodes,
    now: Date.now(),
  };
  const states = new Map(records.map((record) => [record.name, deriveState(record, context)] as const));

  if (!isPretty()) {
    const marker = { start: "", end: "" };
    for (const record of records) {
      const derived = states.get(record.name)!;
      const ref = highlightUniqueSessionReference(records, record, marker);
      console.log(`${derived.state}\t${ref}\t${record.name}\t${record.agent}\t${record.cwd}\t${record.command}`);
    }
    if (probe.unreachableNodes.size > 0) {
      console.error(`# ${probe.unreachableNodes.size} node(s) unreachable: ${[...probe.unreachableNodes].join(", ")}`);
    }
    return;
  }

  if (records.length === 0) {
    console.log(dim("No bees in the hive. Spawn one with: hive spawn <bee>"));
    return;
  }

  const terminalWidth = process.stdout.columns ?? 100;
  const showNodeColumn = shouldShowNodeColumn(nodes, truthy(flag(parsed, "wide")));
  const cwdMax = Math.max(20, Math.min(60, terminalWidth - (showNodeColumn ? 90 : 78)));
  const now = Date.now();

  const rows = records.map((record) => {
    const derived = states.get(record.name)!;
    const ref = truncate(highlightUniqueSessionReference(records, record), 16);
    const name = record.name === record.id ? dim("=") : truncate(record.name, 22);
    const ageSource = isTerminalState(derived.state) ? record.updatedAt : record.createdAt;
    const ageText = formatRelativeTime(ageSource, now);
    const age = isTerminalState(derived.state) ? dim(ageText) : ageText;
    const nodeName = record.node ?? LOCAL_NODE_NAME;
    const base = [
      formatStateCell(derived.state),
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

const DEFAULT_NODE_PROBE_TIMEOUT_MS = 2_500;

export type MultiNodeLiveProbe = {
  liveTargets: Set<string>;
  unreachableNodes: Set<string>;
  perNode: Map<string, string[]>;
};

async function liveTargetsAcrossNodes(nodes: NodeRecord[], nodeFilter?: string): Promise<MultiNodeLiveProbe> {
  const rawTimeout = Number(process.env.HIVE_NODE_PROBE_MS ?? DEFAULT_NODE_PROBE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_NODE_PROBE_TIMEOUT_MS;
  const liveTargets = new Set<string>();
  const unreachableNodes = new Set<string>();
  const perNode = new Map<string, string[]>();
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
      const result = await withTimeout(substrate.listSessions(), timeoutMs);
      perNode.set(node.name, result);
      for (const target of result) liveTargets.add(target);
    } catch {
      unreachableNodes.add(node.name);
    }
  });
  await Promise.allSettled(queries);
  return { liveTargets, unreachableNodes, perNode };
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
  const liveRecords = records.filter((record) => liveTargets.has(record.tmuxTarget));
  const entries = await Promise.all(
    liveRecords.map(async (record) => [record.tmuxTarget, await substrateFor(record).capture(record.tmuxTarget, 80).catch(() => "")] as const),
  );
  return new Map(entries);
}

async function listSealedBeeNames(): Promise<Set<string>> {
  return sealedBeeNamesImpl().catch(() => new Set<string>());
}

async function cmdClean(parsed: Parsed) {
  if (!truthy(flag(parsed, "dead"))) throw new Error("Usage: hive clean --dead [--older-than <age>] [--dry-run|-n]");

  const [records, nodes] = await Promise.all([listSessions(), listNodes()]);
  const probe = await liveTargetsAcrossNodes(nodes);
  // Records on an unreachable node are NOT dead — we genuinely don't know their state.
  // Treat them as live so we don't sweep their metadata while their node is down.
  const recordsConsideredAlive = new Set(probe.liveTargets);
  for (const record of records) {
    if (probe.unreachableNodes.has(record.node ?? LOCAL_NODE_NAME)) {
      recordsConsideredAlive.add(record.tmuxTarget);
    }
  }
  let dead = deadSessionRecords(records, recordsConsideredAlive);
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

async function cmdTranscript(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive transcript <session> [-n rows] [--json]");
  const record = await resolveSession(target);
  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookup(record));
  if (!tx) throw new Error(`No transcript provider/file found for ${record.agent} session ${record.name}`);
  const limitRaw = flag(parsed, "n") ?? flag(parsed, "limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const json = truthy(flag(parsed, "json"));
  console.error(transcriptBanner(tx.provider, tx.path));
  console.log(renderTranscript(tx.rows, { limit: Number.isFinite(limit) ? limit : undefined, json }));
}

async function cmdLast(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive last <session> [--seal]");
  const record = await resolveSession(target);

  if (truthy(flag(parsed, "seal"))) {
    const seal = await loadLatestSeal(record.name);
    if (!seal) throw new Error(`No seal recorded for ${record.name}`);
    console.log(JSON.stringify(seal, null, 2));
    return;
  }

  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookup(record));
  if (!tx && !hasTranscriptProvider(record.agent)) {
    await ensureLive(record);
    console.error(isPretty() ? note(`no transcript provider for ${record.agent}; falling back to pane capture`) : `# no transcript provider for ${record.agent}; falling back to pane capture`);
    console.log(await substrateFor(record).capture(record.tmuxTarget, numberFlag(parsed, ["n", "lines"], 120)));
    return;
  }
  if (!tx) throw new Error(`No transcript provider/file found for ${record.agent} session ${record.name}`);
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
  await waitForIdle({
    record,
    idleMs: numberFlag(parsed, ["idle-ms", "idle"], 3_000),
    timeoutMs: numberFlag(parsed, ["timeout-ms", "timeout"], 600_000),
    pollMs: numberFlag(parsed, ["poll-ms", "poll"], 750),
    output: truthy(flag(parsed, "last")) ? "last" : truthy(flag(parsed, "transcript")) ? "transcript" : "pane",
    rows: numberFlag(parsed, ["n", "limit"], 0),
    json: truthy(flag(parsed, "json")),
  });
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

async function cmdRun(parsed: Parsed) {
  const agent = parsed.args[0];
  const prompt = String(flag(parsed, "prompt") ?? flag(parsed, "p") ?? parsed.args.slice(1).join(" "));
  if (!agent || !prompt) throw new Error("Usage: hive run <bee> -p <prompt> [--cwd dir] [--wait] [--last] [--rm|--cleanup]");
  if (truthy(flag(parsed, "keep")) && cleanupAfterRun(parsed)) throw new Error("--keep cannot be combined with --rm/--cleanup");

  const spawnParsed: Parsed = {
    command: "spawn",
    args: [agent],
    flags: new Map(parsed.flags),
    rest: parsed.rest,
  };
  const record = await cmdSpawn(spawnParsed);
  const cleanup = cleanupAfterRun(parsed);

  try {
    try {
      await waitForAgentReady(record, {
        timeoutMs: numberFlag(parsed, ["boot-ms"], defaultBootMs(record.agent)),
        acceptTrust: acceptsTrust(parsed),
        raiseDroidAutonomy: dangerousMode(parsed, record.agent),
      });
    } catch (error) {
      if (!(error instanceof AgentReadinessError) || error.reason !== "timeout" || !truthy(flag(parsed, "force-send"))) throw error;
      console.error(actionLine("warn", "force", [`readiness timeout for ${bold(record.name)}, sending anyway`]));
      if (error.pane.trim()) console.error(formatPaneExcerpt(error.pane));
    }
    await substrateFor(record).sendText(record.tmuxTarget, prompt);
    const now = new Date().toISOString();
    await saveSession({ ...record, updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now });
    await appendLedger({ type: "prompt.run", session: record.name, agent: record.agent, node: record.node ?? LOCAL_NODE_NAME, cwd: record.cwd, chars: prompt.length });

    if (truthy(flag(parsed, "wait"))) {
      await waitForIdle({
        record: { ...record, lastPrompt: prompt, lastPromptAt: now },
        idleMs: numberFlag(parsed, ["idle-ms", "idle"], 3_000),
        timeoutMs: numberFlag(parsed, ["timeout-ms", "timeout"], 600_000),
        pollMs: numberFlag(parsed, ["poll-ms", "poll"], 750),
        output: truthy(flag(parsed, "last")) ? "last" : truthy(flag(parsed, "transcript")) ? "transcript" : "pane",
        rows: numberFlag(parsed, ["n", "limit"], 0),
        json: truthy(flag(parsed, "json")),
      });
    } else {
      const waitMs = Number(flag(parsed, "wait-ms") ?? 1000);
      if (waitMs > 0) await sleep(waitMs);
      const lines = Number(flag(parsed, "n") ?? flag(parsed, "lines") ?? 80);
      console.log(await substrateFor(record).capture(record.tmuxTarget, Number.isFinite(lines) ? lines : 80));
    }
  } finally {
    if (cleanup) await cleanupRunSession(record);
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
    return;
  }
  console.error(note(`${outcome.alreadyGone ? "removed stale" : "killed"} ${record.name} (--rm/--cleanup)`));
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
    default:
      throw new Error(`Unknown config subcommand: ${sub}\nUsage: hive config <show|path|set-bee>`);
  }
}

async function configSetBee(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive config set-bee <bee> [--yolo] [--no-yolo] [--home <value>] [--command \"...\"]");
  const yolo = truthy(flag(parsed, "yolo")) ? true : truthy(flag(parsed, "no-yolo")) ? false : undefined;
  const homeRaw = flag(parsed, "home");
  const home = typeof homeRaw === "string" ? homeRaw : undefined;
  const commandRaw = flag(parsed, "command");
  const command = typeof commandRaw === "string" ? commandRaw : undefined;
  if (yolo === undefined && home === undefined && command === undefined) {
    throw new Error("hive config set-bee needs at least one of --yolo/--no-yolo, --home, --command");
  }
  const config = loadConfig();
  const next = { ...config, bees: { ...(config.bees ?? {}) } };
  const existing = next.bees[name] ?? {};
  const beeEntry: Record<string, unknown> = { ...existing };
  if (yolo !== undefined) beeEntry.yolo = yolo;
  if (home !== undefined) beeEntry.home = home;
  if (command !== undefined) beeEntry.command = command;
  next.bees[name] = beeEntry;
  await writeConfigFile(next);
  resetConfigCache();
  if (isPretty()) console.log(actionLine("ok", "config", [bold(name), dim("updated")]));
  else console.log(`config\t${name}\tupdated`);
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
    await saveSession({ ...record, colony: to, updatedAt: new Date().toISOString() });
  }
  const swarms = await listSwarms();
  for (const swarm of swarms) {
    if (swarm.colony !== from) continue;
    await saveSwarm({ ...swarm, colony: to });
  }
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

async function nodeRegister(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node register <name> --kind <local-tmux|ssh-tmux> --endpoint <addr> [--capabilities a,b,c] [--description \"...\"] [--ssh-command ssh] [--ssh-args \"-F /path/to/config\"]");
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
  const sshArgsRaw = flag(parsed, "ssh-args");
  const sshArgs = typeof sshArgsRaw === "string"
    ? sshArgsRaw.split(/\s+/).filter(Boolean)
    : undefined;
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
  if (!name) throw new Error("Usage: hive node update <name> [--endpoint addr] [--capabilities a,b] [--description \"...\"] [--ssh-command ssh] [--ssh-args \"...\"]");
  const patch: Parameters<typeof updateNode>[1] = {};
  if (typeof flag(parsed, "endpoint") === "string") patch.endpoint = String(flag(parsed, "endpoint"));
  if (typeof flag(parsed, "description") === "string") patch.description = String(flag(parsed, "description"));
  if (typeof flag(parsed, "ssh-command") === "string") patch.sshCommand = String(flag(parsed, "ssh-command"));
  if (typeof flag(parsed, "capabilities") === "string") {
    patch.capabilities = String(flag(parsed, "capabilities")).split(",").map((c) => c.trim()).filter(Boolean);
  }
  if (typeof flag(parsed, "ssh-args") === "string") {
    patch.sshArgs = String(flag(parsed, "ssh-args")).split(/\s+/).filter(Boolean);
  }
  const record = await updateNode(name, patch);
  clearSubstrateCache();
  if (isPretty()) console.log(actionLine("ok", "node", [bold(record.name), dim("updated")]));
  else console.log(`updated\t${record.name}`);
}

async function nodeUnregister(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node unregister <name>");
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
  if (truthy(flag(parsed, "background"))) {
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
    console.log(JSON.stringify({ meta, result }, null, 2));
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
    default:
      throw new Error(
        `Unknown daemon subcommand: ${sub}\nUsage: hive daemon <install|uninstall|start|stop|restart|status|logs|run>`,
      );
  }
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
  if (!force && (await isAgentInstalled(label))) {
    const msg = `hive daemon already installed (${label})`;
    if (isPretty()) console.error(`${errorPrefix()} ${msg}. Use --force to overwrite or uninstall first.`);
    else console.error(msg);
    process.exit(3);
  }
  const result = await installAgent({ label, force });
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
  const follow = truthy(flag(parsed, "follow"));
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
    await runDaemon({ config });
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
  const status = await readDaemonStatus(undefined, { label });
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.running ? 0 : 3);
  }
  const installedTag = status.installed ? "installed" : "not-installed";
  if (!isPretty()) {
    const dot = status.running ? "running" : "down";
    console.log(`${dot}\t${installedTag}\t${status.lock?.pid ?? ""}\t${status.state?.startedAt ?? ""}\t${status.state?.lastTickAt ?? ""}\t${status.state?.tickCount ?? 0}`);
    process.exit(status.running ? 0 : 3);
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
  const body = String(flag(parsed, "prompt") ?? flag(parsed, "p") ?? "");
  if (body.length === 0) throw new Error("buz: --prompt|-p body is required");
  const subject = typeof flag(parsed, "subject") === "string" ? String(flag(parsed, "subject")) : undefined;
  const sender = await resolveBuzSender(parsed);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const transport = tier === "interrupt"
      ? { substrate: substrateFor(record), tmuxTarget: record.tmuxTarget }
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
    const listing = await listMessages(record.name, mailbox, {
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

  if (consume) {
    const moved = await consumeMessage(found.bee, id);
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
    consumed: consume,
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
  const updated: SessionRecord = {
    ...record,
    buzAccept: tiers,
    updatedAt: new Date().toISOString(),
  };
  await saveSession(updated);
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

export function parseSubstrateAlias(value: string): string {
  // Accepts both "<kind>:<node>" (e.g. "ssh:mini01", "local:local") and bare "<node>" forms.
  // Returns the node name. Empty kind/node segments fall back to local.
  const trimmed = value.trim();
  if (!trimmed) return LOCAL_NODE_NAME;
  const idx = trimmed.indexOf(":");
  if (idx === -1) return trimmed;
  const after = trimmed.slice(idx + 1).trim();
  return after || LOCAL_NODE_NAME;
}

async function resolveSpawnNode(parsed: Parsed, agentKind: string): Promise<NodeRecord> {
  const nodeFlag = flag(parsed, "node");
  const substrateFlag = flag(parsed, "substrate");
  let requested: string;
  if (typeof substrateFlag === "string" && substrateFlag.length > 0) {
    requested = parseSubstrateAlias(substrateFlag);
  } else if (typeof nodeFlag === "string" && nodeFlag.length > 0) {
    requested = nodeFlag;
  } else {
    requested = LOCAL_NODE_NAME;
  }
  const node = await loadNode(requested);
  if (!node) throw new Error(`Unknown node: ${requested}. Register it with: hive node register ${requested} --kind ssh-tmux --endpoint user@host`);
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
  await substrate.attachSession(record.tmuxTarget);
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
}

async function assertExecutableAvailable(command: string) {
  const candidates = command.includes("/") ? [command] : (process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => resolve(dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return;
    } catch {
      // keep looking
    }
  }
  throw new Error(`Executable not found on PATH: ${command}`);
}

function transcriptLookup(record: SessionRecord) {
  return {
    sinceIso: record.lastPromptAt ?? record.createdAt,
    prompt: record.lastPrompt,
    transcriptPath: record.transcriptPath,
    sessionId: record.providerSessionId,
    homePath: record.homePath,
  };
}

function cleanupAfterRun(parsed: Parsed): boolean {
  return truthy(flag(parsed, "rm")) || truthy(flag(parsed, "cleanup"));
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

function dangerousMode(parsed: Parsed, agent?: string): boolean {
  const envSuffix = agent?.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return truthy(flag(parsed, "yolo")) || truthy(flag(parsed, "dangerous")) || truthyEnv(process.env.HIVE_YOLO) || Boolean(envSuffix && truthyEnv(process.env[`HIVE_${envSuffix}_YOLO`]));
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

function printHelp() {
  const pretty = isPretty();
  const head = pretty ? `${bold(APP_NAME)} ${dim(VERSION)}` : `${APP_NAME} ${VERSION}`;
  const heading = (label: string) => (pretty ? bold(label) : label);
  const cmd = (name: string) => (pretty ? cyan(name) : name);
  const arg = (text: string) => (pretty ? gray(text) : text);
  const env = (name: string) => (pretty ? cyan(name) : name);

  const commands: Array<[string, string, string]> = [
    ["spawn", "<bee> [--name <id>] [--cwd <dir>] [--home <1|2|3|path>] [--colony <name>] [--count <n>] [--node <name>] [--yolo] [--no-accept-trust] [--no-wait] [-- <bee-args...>]", "start one or more bees in detached tmux sessions (waits for the prompt, auto-accepting trust)"],
    ["spawn --frame", "<name> [--colony <name>] [--swarm-id <id>]", "spawn a swarm from a registered frame"],
    ["run", "<bee> -p <prompt> [--cwd <dir>] [--node <name>] [--wait] [--last] [--rm] [--no-accept-trust] [--force-send]", "spawn, send a prompt, optionally wait and clean up"],
    ["send", "<selector> <prompt>", "send a prompt to a bee, swarm, or colony"],
    ["brief", "<selector> <text> [--no-wait-footer] [--wait-footer \"...\"]", "send a one-time context brief (appends halt-and-wait footer unless suppressed)"],
    ["seal", "<selector> --from <path.json>", "record a typed handoff artifact"],
    ["tail", "<session> [-n <lines>] [-f|--follow]", "capture or follow pane content"],
    ["transcript", "<session> [-n <rows>] [--json]", "render structured transcript rows"],
    ["last", "<session> [--seal]", "print the bee's most recent assistant message or seal"],
    ["wait", "<session> [--idle-ms 3000] [--last|--transcript|--seal]", "block until the bee goes idle or seals"],
    ["list", "[--colony <name>] [--swarm <id>] [--node <name>] [--wide]", "show all known sessions with state (pretty mode adds NODE column when >1 node)"],
    ["ps", "[--colony <name>] [--swarm <id>] [--node <name>] [--wide]", "alias for list"],
    ["kill", "<session>", "stop a session and remove its metadata"],
    ["clean", "--dead [--older-than <age>] [--dry-run|-n]", "remove metadata for sessions no longer in tmux"],
    ["attach", "<session> [--print]", "attach to the tmux session (or print the command)"],
    ["colony", "<list|create|inspect|archive|update|rename> [name]", "manage project-scoped namespaces"],
    ["frame", "<list|define|update|reload|edit|inspect|remove> [name|path]", "manage reusable swarm blueprints"],
    ["swarm", "<list|inspect|destroy> [@id]", "manage live or destroyed bee cohorts"],
    ["node", "<list|register|inspect|update|unregister> [name]", "manage substrate endpoints (local + ssh-tmux)"],
    ["substrate", "list", "show available substrate kinds"],
    ["flow", "<list|define|inspect|remove|run|runs|logs|status|cancel> [name|path|runId] [--arg k=v]... [--background]", "manage and run flow definitions; --background detaches, cancel signals the pgid"],
    ["buz", "<send|inbox|outbox|queue|read|purge|config> [--tier <interrupt|queue|passive>] [--sender <bee>|--sender-human <name>]", "addressed messaging: three-tier delivery + per-bee policy"],
    ["daemon", "<install|uninstall|start|stop|restart|status|logs|run> [--label <id>] [--tick-ms <n>] [--lines N] [--follow] [--json]", "manage the hive daemon LaunchAgent + inspect state/logs"],
    ["search", "<query> [--type seals,ledger,sessions] [--colony X] [--swarm X] [--bee X] [--status X] [--since 7d] [--regex] [--case] [--limit N] [--json]", "search seals, ledger, and session records"],
    ["seals find", "<query> [--status X] [--colony X] [--bee X] [--since 7d] [--regex] [--case] [--limit N] [--json]", "search seals only"],
    ["config", "<show|path|set-bee <bee> [--yolo] [--home] [--command]>", "view or edit ~/.hive/config.json defaults"],
    ["completion", "<bash|zsh|fish>", "print a shell completion script (eval to install)"],
  ];

  const width = Math.max(...commands.map(([name]) => name.length));
  const pad = (name: string) => name.padEnd(width, " ");

  const usage = commands
    .map(([name, args, desc]) => {
      const left = `  hive ${cmd(pad(name))}  ${arg(args)}`.trimEnd();
      return `${left}\n      ${dim(desc)}`;
    })
    .join("\n");

  const bees = [
    "  claude, codex, opencode, grok, pi, droid",
    `  ${dim("aliases: codex1, codex2, codex3, cc1, cc2, cc3")}`,
    `  ${dim("or any executable on PATH")}`,
  ].join("\n");

  const envs = [
    `  ${env("HIVE_CLAUDE_CMD")}=${arg(`"claude --model sonnet"`)} hive spawn claude`,
    `  ${env("HIVE_CODEX_YOLO")}=${arg("1")} hive spawn codex`,
    `  ${env("HIVE_GROK_CMD")}=${arg(`"grok --model grok-code-fast-1"`)} hive spawn grok`,
    `  ${env("HIVE_DROID_CMD")}=${arg(`"python3 ~/bin/droid.py"`)} hive spawn droid`,
  ].join("\n");

  const profiles = [
    "  hive spawn codex --home 2",
    "  hive spawn codex2",
    "  hive spawn claude --home ~/.claude-3",
    "  hive spawn cc3",
  ]
    .map((line) => (pretty ? dim(line) : line))
    .join("\n");

  console.log(`${head}

${heading("Commands")}
${usage}

${heading("Bees")}
${bees}

${heading("Env overrides")}
${envs}

${heading("Home/profile examples")}
${profiles}
`);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const [first, ...rest] = message.split("\n");
  console.error(`${errorPrefix()} ${first}`);
  for (const line of rest) console.error(dim(line));
  process.exitCode = 1;
});
