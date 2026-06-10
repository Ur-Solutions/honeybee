import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listAccounts, type AccountRecord } from "./accounts.js";
import { listColonies, type ColonyRecord } from "./colony.js";
import { type Frame, listFrames } from "./frame.js";
import { type Flow, listFlows } from "./flow/index.js";
import { listRuns } from "./flow/runs.js";
import { highlightUniqueSessionReference } from "./ids.js";
import { listNodes, type NodeRecord } from "./node.js";
import { listSessions, type SessionRecord } from "./store.js";
import { listSwarms, type SwarmRecord } from "./swarm.js";
import { listTmuxSessions } from "./tmux.js";

const COMMANDS = [
  "spawn", "send", "tail", "transcript", "last", "wait",
  "list", "ls", "ps", "kill", "clean", "run", "x", "attach",
  "colony", "frame", "swarm", "node", "substrate", "flow", "loop",
  "buz",
  "daemon",
  "account", "activate", "login", "swap-account", "usage", "sessions", "sync",
  "search", "seals",
  "brief", "seal", "config", "completion", "help",
];

const COLONY_SUBCOMMANDS = ["list", "ls", "create", "inspect", "archive", "update", "rename"];
const FRAME_SUBCOMMANDS = ["list", "ls", "define", "update", "reload", "edit", "inspect", "remove"];
const SWARM_SUBCOMMANDS = ["list", "ls", "inspect", "destroy"];
const NODE_SUBCOMMANDS = ["list", "ls", "register", "inspect", "update", "unregister"];
const SUBSTRATE_SUBCOMMANDS = ["list", "ls"];
const SEALS_SUBCOMMANDS = ["find"];
const FLOW_SUBCOMMANDS = ["list", "ls", "define", "inspect", "remove", "run", "runs", "logs", "status", "cancel"];
const LOOP_SUBCOMMANDS = ["start", "status", "logs", "stop", "list", "ls"];
const BUZ_SUBCOMMANDS = ["send", "inbox", "outbox", "queue", "read", "purge", "config"];
const DAEMON_SUBCOMMANDS = ["install", "uninstall", "start", "stop", "restart", "status", "logs", "run"];
const ACCOUNT_SUBCOMMANDS = ["list", "ls", "add", "login", "capture", "remove", "import-caam"];
const SESSIONS_SUBCOMMANDS = ["reconcile"];
const SYNC_SUBCOMMANDS = ["manifest"];

const SEARCH_TYPE_VALUES = ["seals", "ledger", "sessions"];
const SEAL_STATUS_VALUES = ["done", "blocked", "needs_input", "failed"];
const BUZ_TIERS = ["interrupt", "queue", "passive"];
const BUZ_ACCEPT_VALUES = [
  "interrupt", "queue", "passive",
  "queue,passive", "interrupt,queue", "interrupt,queue,passive",
];

const BEES = [
  "claude", "codex", "opencode", "grok", "pi", "droid", "cursor",
  "codex1", "codex2", "codex3", "cc1", "cc2", "cc3",
];

const SHELLS = ["bash", "zsh", "fish"];

const TOP_LEVEL_FLAGS = ["--version", "--help"];

const SESSION_LIVE_ONLY = new Set(["send", "brief", "tail", "cat", "transcript", "tx", "wait", "attach"]);
const SESSION_ANY = new Set(["kill", "last", "seal"]);
const BEE_FIRST_ARG = new Set(["spawn", "run", "x", "xa"]);
const SHELL_FIRST_ARG = new Set(["completion"]);
// Commands whose first positional is a vault account.
const ACCOUNT_FIRST_ARG = new Set(["login", "activate", "usage"]);

const FLAGS_BY_COMMAND: Record<string, string[]> = {
  spawn: ["--name", "--cwd", "--home", "--profile", "--account", "--autoswap", "--colony", "--count", "--frame", "--swarm-id", "--brief", "--briefed", "--node", "--substrate", "--yolo", "--no-yolo", "--dangerous", "--no-accept-trust", "--no-wait"],
  account: ["--email", "--home", "--from", "--json", "--no-wait", "--timeout-ms"],
  activate: ["--home"],
  login: ["--no-wait", "--popup", "--timeout-ms"],
  xa: [
    "--cwd", "--home", "--profile", "--account", "--name", "--colony", "--print",
    "--accept-trust", "--trust", "--no-accept-trust", "--no-trust",
    "--yolo", "--no-yolo", "--dangerous", "--boot-ms",
  ],
  usage: ["--json"],
  sessions: ["--home", "--json"],
  sync: ["--json"],
  node: ["--kind", "--endpoint", "--capabilities", "--description", "--ssh-command", "--ssh-args"],
  run: [
    "--prompt", "-p", "--cwd", "--home", "--profile",
    "--wait", "--last", "--transcript",
    "--rm", "--cleanup", "--keep",
    "--accept-trust", "--trust", "--no-accept-trust", "--no-trust", "--force-send",
    "--yolo", "--dangerous",
    "--idle-ms", "--timeout-ms", "--poll-ms", "--boot-ms", "--wait-ms",
    "--node", "--substrate",
    "-n", "--limit", "--json",
  ],
  x: [
    "--prompt", "-p", "--cwd", "--home", "--profile", "--name", "--colony",
    "--accept-trust", "--trust", "--no-accept-trust", "--no-trust", "--force-send",
    "--yolo", "--dangerous", "--boot-ms", "--node", "--substrate",
  ],
  send: ["--prompt", "-p"],
  brief: ["--brief", "-b", "--accept-trust", "--no-accept-trust", "--force-send", "--no-wait-footer", "--wait-footer", "--footer", "--no-footer"],
  seal: ["--from"],
  last: ["-n", "--lines", "--seal"],
  wait: ["--idle-ms", "--idle", "--timeout-ms", "--timeout", "--poll-ms", "--poll", "--last", "--transcript", "--seal", "-n", "--limit", "--json"],
  tail: ["-n", "--lines"],
  cat: ["-n", "--lines"],
  transcript: ["-n", "--limit", "--json"],
  tx: ["-n", "--limit", "--json"],
  clean: ["--dead", "--idle", "--interactive", "-i", "--older-than", "--older", "--dry-run", "-n"],
  list: ["--colony", "--swarm", "--node", "--wide"],
  ps: ["--colony", "--swarm", "--node", "--wide"],
  attach: ["--print"],
  search: ["--colony", "--swarm", "--bee", "--type", "--status", "--since", "--regex", "--case", "--limit", "--json"],
  seals: ["--colony", "--swarm", "--bee", "--status", "--since", "--regex", "--case", "--limit", "--json"],
  buz: [
    "--tier", "--sender", "--sender-human", "--prompt", "-p", "--subject",
    "--unread", "--limit", "--from", "--consume", "--read", "--older-than", "--all",
    "--accept",
  ],
  daemon: ["--tick-ms", "--json", "--label", "--force", "--follow", "--lines", "-n"],
  flow: ["--arg", "--foreground", "--background", "--flow", "--json"],
  loop: [
    "--bee", "--cwd", "--context", "--prompt", "--prompt-file",
    "--until", "--max", "--max-duration", "--forever",
    "--stop-on-seal", "--stop-on-sentinel", "--judge", "--summarizer",
    "--yolo", "--iter", "-n", "--follow", "-f", "--now", "--json",
  ],
};

export type CompletionState = {
  records: SessionRecord[];
  liveTargets: Set<string>;
  colonies?: ColonyRecord[];
  swarms?: SwarmRecord[];
  frames?: Frame[];
  flows?: Flow[];
  nodes?: NodeRecord[];
  runs?: { runId: string; flowName: string }[];
  accounts?: AccountRecord[];
  cwd?: string;
};

type FlagValueKind = "colony" | "swarm" | "frame" | "shell" | "node" | "node-kind" | "bee" | "search-type" | "seal-status" | "flow" | "buz-tier" | "buz-accept" | "run" | "loop-context" | "loop-summarizer" | "account";

const LOOP_CONTEXT_VALUES = ["persistent", "ralph", "rolling"];
const LOOP_SUMMARIZER_VALUES = ["self", "bee"];

// Global fallback: flags whose value-completion is unambiguous regardless
// of the current verb (e.g. --colony always refers to a colony).
const FLAG_VALUE_KINDS: Record<string, FlagValueKind> = {
  "--colony": "colony",
  "--swarm": "swarm",
  "--swarm-id": "swarm",
  "--frame": "frame",
  "--node": "node",
  "--kind": "node-kind",
  "--bee": "bee",
  "--type": "search-type",
  "--status": "seal-status",
  "--flow": "flow",
  "--account": "account",
};

// Per-command overrides + additions. These only apply when args[0] equals
// the command name, so `--tier` cannot accidentally pollute non-buz verbs
// that might add an identically named flag later.
const PER_COMMAND_FLAG_VALUE_KINDS: Record<string, Record<string, FlagValueKind>> = {
  buz: {
    "--tier": "buz-tier",
    "--accept": "buz-accept",
  },
  loop: {
    "--bee": "bee",
    "--context": "loop-context",
    "--summarizer": "loop-summarizer",
    "--stop-on-seal": "seal-status",
  },
};

const NOUN_COMMAND_SUBS: Record<string, string[]> = {
  colony: COLONY_SUBCOMMANDS,
  frame: FRAME_SUBCOMMANDS,
  swarm: SWARM_SUBCOMMANDS,
  node: NODE_SUBCOMMANDS,
  substrate: SUBSTRATE_SUBCOMMANDS,
  seals: SEALS_SUBCOMMANDS,
  flow: FLOW_SUBCOMMANDS,
  loop: LOOP_SUBCOMMANDS,
  buz: BUZ_SUBCOMMANDS,
  daemon: DAEMON_SUBCOMMANDS,
  account: ACCOUNT_SUBCOMMANDS,
  sessions: SESSIONS_SUBCOMMANDS,
  sync: SYNC_SUBCOMMANDS,
};

const NOUN_SUB_ARG: Record<string, Record<string, "colony" | "swarm" | "frame" | "node" | "flow" | "session-any" | "run" | "account">> = {
  colony: { inspect: "colony", archive: "colony", update: "colony", rename: "colony" },
  frame: { inspect: "frame", remove: "frame", edit: "frame", update: "frame", reload: "frame" },
  swarm: { inspect: "swarm", destroy: "swarm" },
  node: { inspect: "node", update: "node", unregister: "node" },
  flow: { inspect: "flow", remove: "flow", run: "flow", logs: "run", status: "run", cancel: "run" },
  account: { capture: "account", remove: "account", rm: "account" },
  // buz subcommands all take a selector as their first positional. We
  // accept any session (live or dead) since reading inbox/outbox/queue
  // is meaningful even for a sealed bee.
  buz: {
    send: "session-any",
    inbox: "session-any",
    outbox: "session-any",
    queue: "session-any",
    purge: "session-any",
    config: "session-any",
  },
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

  // Bee specs include account shorthands: the full account id is itself a
  // valid `<tool>-<account>` spawn spec.
  if (BEE_FIRST_ARG.has(command)) return [...BEES, ...(state.accounts ?? []).map((account) => account.id)];
  if (ACCOUNT_FIRST_ARG.has(command)) return resolveFlagValueCandidates("account", state);
  if (SHELL_FIRST_ARG.has(command)) return SHELLS;
  if (SESSION_LIVE_ONLY.has(command)) return sessionRefs(state, "live");
  if (SESSION_ANY.has(command)) return sessionRefs(state, "all");
  return [];
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
    case "search-type":
      return SEARCH_TYPE_VALUES;
    case "seal-status":
      return SEAL_STATUS_VALUES;
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

function positionalAt(args: string[], index: number): string | undefined {
  let count = 0;
  for (let i = 1; i < args.length - 1; i += 1) {
    const token = args[i]!;
    if (token.startsWith("-")) {
      if (i + 1 < args.length - 1 && !args[i + 1]!.startsWith("-")) i += 1;
      continue;
    }
    if (count === index) return token;
    count += 1;
  }
  return undefined;
}

export async function getCompletions(words: string[]): Promise<string[]> {
  try {
    const [records, live, colonies, swarms, frames, nodes, flows, runs, accounts] = await Promise.all([
      listSessions(),
      listTmuxSessions(),
      listColonies().catch(() => []),
      listSwarms().catch(() => []),
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
      swarms,
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
      if (i + 1 < args.length - 1 && !args[i + 1]!.startsWith("-")) i += 1;
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

export function shellScript(shell: string): string {
  switch (shell) {
    case "bash":
      return BASH_SCRIPT;
    case "zsh":
      return ZSH_SCRIPT;
    case "fish":
      return FISH_SCRIPT;
    default:
      throw new Error(`Unsupported shell: ${shell}. Use one of: bash, zsh, fish.`);
  }
}

const BASH_SCRIPT = `# hive bash completion
# Install: eval "$(hive completion bash)"
# Or add to ~/.bashrc: hive completion bash > ~/.hive.bash && source ~/.hive.bash
_hive_complete() {
  local IFS=$'\\n'
  local response
  response=$("\${COMP_WORDS[0]}" __complete "\${COMP_WORDS[@]}" 2>/dev/null)
  COMPREPLY=( $(compgen -W "$response" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _hive_complete hive
`;

const ZSH_SCRIPT = `#compdef hive
# hive zsh completion
# Install: eval "$(hive completion zsh)"
# Or add to a directory in $fpath as _hive: hive completion zsh > ~/.zsh/completions/_hive
_hive() {
  local -a candidates
  candidates=( "\${(@f)\$("\${words[1]}" __complete "\${words[@]}" 2>/dev/null)}" )
  compadd -a candidates
}
compdef _hive hive
`;

const FISH_SCRIPT = `# hive fish completion
# Install: hive completion fish | source
# Or add to ~/.config/fish/completions/hive.fish
function __hive_complete
  hive __complete (commandline -opc) (commandline -ct) 2>/dev/null
end
complete -c hive -f -a '(__hive_complete)'
`;
