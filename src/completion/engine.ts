import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listAccounts, type AccountRecord } from "../accounts.js";
import { listColonies, type ColonyRecord } from "../colony.js";
import { type Frame, listFrames } from "../frame.js";
import { type Flow, listFlows } from "../flow/index.js";
import { listRuns } from "../flow/runs.js";
import { highlightUniqueSessionReference } from "../ids.js";
import { listNodes, type NodeRecord } from "../node.js";
import { BOOLEAN_FLAGS } from "../parse.js";
import { listQuests, type QuestRecord } from "../quest.js";
import { listSessions, type SessionRecord } from "../store.js";
import { listSwarms, type SwarmRecord } from "../swarm.js";
import { listTmuxSessions } from "../tmux.js";
import { listWorkspaces, type WorkspaceRecord } from "../workspace.js";
import {
  ACCOUNT_FIRST_ARG,
  BEE_FIRST_ARG,
  BEES,
  BUZ_ACCEPT_VALUES,
  BUZ_TIERS,
  COMMANDS,
  FLAG_VALUE_KINDS,
  FLAGS_BY_COMMAND,
  FORK_SEED_VALUES,
  HIVE_STATE_VALUES,
  LOOP_CONTEXT_VALUES,
  LOOP_SUMMARIZER_VALUES,
  NOUN_COMMAND_SUBS,
  NOUN_SUB_ARG,
  PER_COMMAND_FLAG_VALUE_KINDS,
  QUEST_STATUS_VALUES,
  SEARCH_TYPE_VALUES,
  SEAL_STATUS_VALUES,
  SESSION_ANY,
  SESSION_LIVE_ONLY,
  SHELL_FIRST_ARG,
  SHELLS,
  TOP_LEVEL_FLAGS,
  type FlagValueKind,
} from "./tables.js";

export type CompletionState = {
  records: SessionRecord[];
  liveTargets: Set<string>;
  colonies?: ColonyRecord[];
  workspaces?: WorkspaceRecord[];
  swarms?: SwarmRecord[];
  quests?: QuestRecord[];
  frames?: Frame[];
  flows?: Flow[];
  nodes?: NodeRecord[];
  runs?: { runId: string; flowName: string }[];
  accounts?: AccountRecord[];
  cwd?: string;
};

export function getCompletionsFromState(words: string[], state: CompletionState): string[] {
  const args = stripBinary(words);

  if (args.length <= 1) {
    const cur = args[0] ?? "";
    return cur.startsWith("-") ? TOP_LEVEL_FLAGS : COMMANDS;
  }

  const command = args[0]!;
  const currentArg = args[args.length - 1] ?? "";

  const flagValueKind = detectFlagValueContext(args, command);
  if (flagValueKind) return resolveFlagValueCandidates(flagValueKind, state);

  if (currentArg.startsWith("-")) return FLAGS_BY_COMMAND[command] ?? [];

  if (NOUN_COMMAND_SUBS[command]) {
    return nounCommandCandidates(command, args, state);
  }

  if (command === "swap-account") {
    // <bee> then <account>.
    const index = positionalIndexOf(args);
    if (index === 0) return sessionRefs(state, "all");
    if (index === 1) return resolveFlagValueCandidates("account", state);
    return [];
  }

  if (positionalIndexOf(args) !== 0) return [];

  // `hive fork launch` opens the interactive launcher; any other first
  // positional is the source bee to fork.
  if (command === "fork") return ["launch", ...sessionRefs(state, "all")];

  // Bee specs include account shorthands: the full account id is itself a
  // valid `<tool>-<account>` spawn spec; `<tool>-auto` picks the least-loaded
  // account; `<tool>-rr` advances a per-tool round-robin cursor.
  if (BEE_FIRST_ARG.has(command)) {
    const accounts = state.accounts ?? [];
    const autoAliases = [...new Set(accounts.map((account) => `${account.tool}-auto`))];
    const rrAliases = [...new Set(accounts.map((account) => `${account.tool}-rr`))];
    return [...BEES, ...accounts.map((account) => account.id), ...autoAliases, ...rrAliases];
  }
  if (ACCOUNT_FIRST_ARG.has(command)) return resolveFlagValueCandidates("account", state);
  if (SHELL_FIRST_ARG.has(command)) return SHELLS;
  if (SESSION_LIVE_ONLY.has(command)) return sessionRefs(state, "live");
  if (SESSION_ANY.has(command)) return sessionRefs(state, "all");
  return [];
}

export async function getCompletions(words: string[]): Promise<string[]> {
  try {
    const [records, live, colonies, workspaces, swarms, quests, frames, nodes, flows, runs, accounts] = await Promise.all([
      listSessions(),
      listTmuxSessions(),
      listColonies().catch(() => []),
      listWorkspaces().catch(() => []),
      listSwarms().catch(() => []),
      listQuests().catch(() => []),
      listFrames().catch(() => []),
      listNodes().catch(() => []),
      listFlows().catch(() => []),
      listRuns().catch(() => []),
      listAccounts().catch(() => []),
    ]);
    return getCompletionsFromState(words, {
      records,
      liveTargets: new Set(live),
      colonies,
      workspaces,
      swarms,
      quests,
      frames,
      nodes,
      flows,
      runs: runs.map((r) => ({ runId: r.runId, flowName: r.flowName })),
      accounts,
      cwd: process.cwd(),
    });
  } catch {
    return [];
  }
}

function detectFlagValueContext(args: string[], command: string): FlagValueKind | null {
  if (args.length < 2) return null;
  const prev = args[args.length - 2];
  const current = args[args.length - 1] ?? "";
  if (!prev || !prev.startsWith("-")) return null;
  if (current.startsWith("-")) return null;
  const perCommand = PER_COMMAND_FLAG_VALUE_KINDS[command]?.[prev];
  if (perCommand) return perCommand;
  return FLAG_VALUE_KINDS[prev] ?? null;
}

function resolveFlagValueCandidates(kind: FlagValueKind, state: CompletionState): string[] {
  switch (kind) {
    case "colony":
      return (state.colonies ?? []).filter((c) => !c.archived).map((c) => c.name);
    case "workspace":
      return (state.workspaces ?? []).filter((w) => !w.archived).map((w) => w.name);
    case "quest":
      return (state.quests ?? []).filter((q) => q.status !== "archived").map((q) => q.id);
    case "swarm":
      return (state.swarms ?? []).filter((s) => !s.destroyed).map((s) => s.id);
    case "frame":
      return (state.frames ?? []).map((f) => f.name);
    case "shell":
      return SHELLS;
    case "node":
      return (state.nodes ?? []).map((n) => n.name);
    case "node-kind":
      return ["local-tmux", "ssh-tmux"];
    case "bee":
      return state.records.map((r) => r.name);
    case "agent":
      // Distinct agent kinds in play plus the well-known tool names, so
      // `hive list --agent <TAB>` offers what is actually spawnable/present.
      return [...new Set([...state.records.map((r) => r.agent), ...BEES])];
    case "search-type":
      return SEARCH_TYPE_VALUES;
    case "seal-status":
      return SEAL_STATUS_VALUES;
    case "quest-status":
      return QUEST_STATUS_VALUES;
    case "hive-state":
      return HIVE_STATE_VALUES;
    case "flow":
      return (state.flows ?? []).map((f) => f.name);
    case "buz-tier":
      return BUZ_TIERS;
    case "buz-accept":
      return BUZ_ACCEPT_VALUES;
    case "run":
      return (state.runs ?? []).map((r) => r.runId);
    case "loop-context":
      return LOOP_CONTEXT_VALUES;
    case "loop-summarizer":
      return LOOP_SUMMARIZER_VALUES;
    case "account":
      return (state.accounts ?? []).map((account) => account.id);
    case "account-or-meta":
      return ["auto", "rr", ...(state.accounts ?? []).map((account) => account.id)];
    case "fork-seed":
      return FORK_SEED_VALUES;
  }
}

function nounCommandCandidates(command: string, args: string[], state: CompletionState): string[] {
  const subs = NOUN_COMMAND_SUBS[command]!;
  const positionalIndex = positionalIndexOf(args);
  const sub = positionalAt(args, 0);
  const currentArg = args[args.length - 1] ?? "";
  if (positionalIndex === 0) return subs;
  if (positionalIndex === 1) {
    if (command === "frame" && sub === "define") {
      return fileCandidates(currentArg, [".json", ".ts"], state.cwd ?? process.cwd());
    }
    if (command === "flow" && sub === "define") {
      return fileCandidates(currentArg, [".json", ".ts"], state.cwd ?? process.cwd());
    }
    const argKind = sub ? NOUN_SUB_ARG[command]?.[sub] : undefined;
    if (!argKind) return [];
    if (argKind === "swarm") return resolveFlagValueCandidates("swarm", state).map((id) => `@${id}`);
    if (argKind === "session-any") return sessionRefs(state, "all");
    if (argKind === "run") return resolveFlagValueCandidates("run", state);
    return resolveFlagValueCandidates(argKind, state);
  }
  if (positionalIndex === 2 && command === "frame" && sub === "update") {
    return fileCandidates(currentArg, [".json", ".ts"], state.cwd ?? process.cwd());
  }
  // `hive workspace add <name> <bee-selector>`: the 2nd positional is any bee.
  if (positionalIndex === 2 && (command === "workspace" || command === "ws") && sub === "add") {
    return sessionRefs(state, "all");
  }
  return [];
}

export function fileCandidates(prefix: string, exts: string[], cwd: string): string[] {
  const expanded = expandTilde(prefix);
  const slashIdx = expanded.lastIndexOf("/");
  let basePart: string;
  let displayDir: string;
  let scanDir: string;

  if (slashIdx === -1) {
    basePart = expanded;
    displayDir = "";
    scanDir = cwd;
  } else {
    basePart = expanded.slice(slashIdx + 1);
    const origSlashIdx = prefix.lastIndexOf("/");
    displayDir = prefix.slice(0, origSlashIdx + 1);
    const absSegment = expanded.slice(0, slashIdx + 1);
    if (absSegment.startsWith("/")) scanDir = absSegment === "/" ? "/" : absSegment;
    else scanDir = resolve(cwd, absSegment);
  }

  let entries: string[];
  try {
    entries = readdirSync(scanDir);
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".") && !basePart.startsWith(".")) continue;
    if (basePart && !name.startsWith(basePart)) continue;
    const fullAbs = join(scanDir, name);
    let isDir = false;
    try {
      isDir = statSync(fullAbs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      results.push(`${displayDir}${name}/`);
    } else if (exts.some((ext) => name.endsWith(ext))) {
      results.push(`${displayDir}${name}`);
    }
  }
  return results;
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

// Boolean flags (--yolo, --json, ...) never consume a value; treating them as
// value-taking would swallow the following positional during completion.
function flagConsumesValue(token: string): boolean {
  if (token.includes("=")) return false;
  return !BOOLEAN_FLAGS.has(token.replace(/^-+/, ""));
}

function positionalAt(args: string[], index: number): string | undefined {
  let count = 0;
  for (let i = 1; i < args.length - 1; i += 1) {
    const token = args[i]!;
    if (token.startsWith("-")) {
      if (flagConsumesValue(token) && i + 1 < args.length - 1 && !args[i + 1]!.startsWith("-")) i += 1;
      continue;
    }
    if (count === index) return token;
    count += 1;
  }
  return undefined;
}

function stripBinary(words: string[]): string[] {
  if (words.length === 0) return words;
  const first = words[0]!;
  if (first === "hive" || first.endsWith("/hive")) return words.slice(1);
  return words;
}

function positionalIndexOf(args: string[]): number {
  let index = 0;
  for (let i = 1; i < args.length - 1; i += 1) {
    const token = args[i]!;
    if (token.startsWith("-")) {
      if (flagConsumesValue(token) && i + 1 < args.length - 1 && !args[i + 1]!.startsWith("-")) i += 1;
      continue;
    }
    index += 1;
  }
  return index;
}

function sessionRefs(state: CompletionState, filter: "live" | "all"): string[] {
  const filtered = filter === "live"
    ? state.records.filter((record) => state.liveTargets.has(record.tmuxTarget))
    : state.records;
  return filtered.map((record) =>
    highlightUniqueSessionReference(state.records, record, { start: "", end: "" }),
  );
}
