import { BUZ_TIERS as CANONICAL_BUZ_TIERS } from "../buz_tiers.js";
import { SEAL_STATUSES } from "../seal.js";

export const COMMANDS = [
  "spawn", "new", "launch", "send", "tail", "cat", "transcript", "tx", "last", "wait",
  "list", "ls", "ps", "bees", "kill", "clean", "run", "x", "xa", "attach", "next",
  "colony", "pool", "frame", "swarm", "node", "substrate", "flow", "loop",
  "buz",
  "daemon",
  "account", "activate", "login", "swap-account", "usage", "limits", "sessions", "sync", "open",
  "search", "seals", "events", "flight",
  "brief", "rename", "seal", "config", "completion", "help", "tag", "own", "move",
  "fork", "here", "spawn-picker", "urls", "keys", "revive", "auth-resume", "retire", "archive", "set-model",
];

export const COLONY_SUBCOMMANDS = ["list", "ls", "create", "inspect", "archive", "update", "rename"];
export const POOL_SUBCOMMANDS = ["list", "ls", "status", "spawn", "launch", "extend", "sync", "claim", "release", "park", "unpark"];
export const FRAME_SUBCOMMANDS = ["list", "ls", "define", "update", "reload", "edit", "inspect", "remove"];
export const SWARM_SUBCOMMANDS = ["list", "ls", "inspect", "destroy"];
export const NODE_SUBCOMMANDS = ["list", "ls", "register", "inspect", "update", "unregister"];
export const SUBSTRATE_SUBCOMMANDS = ["list", "ls"];
export const SEALS_SUBCOMMANDS = ["find"];
export const FLOW_SUBCOMMANDS = ["list", "ls", "define", "inspect", "remove", "run", "runs", "logs", "status", "cancel"];
export const LOOP_SUBCOMMANDS = ["launch", "template", "start", "status", "logs", "stop", "list", "ls"];
export const BUZ_SUBCOMMANDS = ["send", "inbox", "outbox", "queue", "read", "cancel", "purge", "config"];
export const DAEMON_SUBCOMMANDS = ["install", "uninstall", "start", "stop", "restart", "status", "logs", "run"];
export const ACCOUNT_SUBCOMMANDS = ["list", "ls", "add", "login", "capture", "sync", "pause", "resume", "remove"];
export const KEYS_SUBCOMMANDS = ["print", "path", "check"];
export const SESSIONS_SUBCOMMANDS = ["reconcile"];
export const SYNC_SUBCOMMANDS = ["manifest"];
export const FLIGHT_SUBCOMMANDS = ["start", "ls", "list", "status", "sweep", "enqueue", "queue", "resolve", "drain", "close"];

export const SEARCH_TYPE_VALUES = ["seals", "ledger", "sessions"];
export const SEAL_STATUS_VALUES = [...SEAL_STATUSES];
export const HIVE_STATE_VALUES = ["waiting", "done", "failed", "working"];
export const BUZ_TIERS: readonly string[] = CANONICAL_BUZ_TIERS;
export const BUZ_ACCEPT_VALUES = buzAcceptValues();

// Every contiguous tier run, shortest-suffix first — derived from the shared
// tier table so completion can never drift from delivery (HIVE-33).
function buzAcceptValues(): string[] {
  const values: string[] = [...CANONICAL_BUZ_TIERS];
  for (let length = 2; length <= CANONICAL_BUZ_TIERS.length; length += 1) {
    for (let start = CANONICAL_BUZ_TIERS.length - length; start >= 0; start -= 1) {
      values.push(CANONICAL_BUZ_TIERS.slice(start, start + length).join(","));
    }
  }
  return values;
}

export const BEES = [
  "claude", "codex", "opencode", "grok", "pi", "droid", "cursor",
  "codex1", "codex2", "codex3", "cc1", "cc2", "cc3",
];

export const SHELLS = ["bash", "zsh", "fish"];

export const TOP_LEVEL_FLAGS = ["--version", "--help"];

export const SESSION_LIVE_ONLY = new Set(["send", "brief", "tail", "cat", "transcript", "tx", "wait", "attach"]);
export const SESSION_ANY = new Set(["kill", "retire", "archive", "last", "seal", "rename", "tag", "own", "move", "split", "fork", "revive", "auth-resume", "urls", "set-model"]);
export const BEE_FIRST_ARG = new Set(["spawn", "run", "x", "xa", "open"]);
export const SHELL_FIRST_ARG = new Set(["completion"]);
// Commands whose first positional is a vault account.
export const ACCOUNT_FIRST_ARG = new Set(["login", "activate", "usage", "limits"]);

export const FLAGS_BY_COMMAND: Record<string, string[]> = {
  spawn: ["--name", "--cwd", "--pool", "--no-keep", "--home", "--profile", "--account", "--ttl", "--autoswap", "--colony", "--count", "--frame", "--swarm-id", "--brief", "--briefed", "--contract", "--node", "--substrate", "--here", "--yolo", "--no-yolo", "--dangerous", "--no-accept-trust", "--no-wait", "--include-paused", "--yes"],
  pool: ["--json", "--all", "--ttl", "--count", "--no-keep", "--here", "--yolo", "--name", "--account"],
  account: ["--email", "--home", "--json", "--no-wait", "--timeout-ms"],
  activate: ["--home"],
  login: ["--no-wait", "--popup", "--timeout-ms"],
  revive: ["--all", "--crashed", "--fresh", "--session", "--no-wait"],
  "set-model": ["--clear", "--fresh", "--now"],
  xa: [
    "--cwd", "--home", "--profile", "--account", "--ttl", "--name", "--colony", "--print",
    "--accept-trust", "--trust", "--no-accept-trust", "--no-trust",
    "--yolo", "--no-yolo", "--dangerous", "--boot-ms", "--here", "--include-paused", "--yes",
  ],
  open: ["--raw", "--window", "--app", "--cwd", "--home", "--profile", "--account", "--ttl", "--print", "--yolo", "--no-yolo", "--dangerous", "--no-accept-trust", "--include-paused", "--yes"],
  view: ["--name", "--new-client", "--close", "--print"],
  ws: ["--root", "--new-client", "--print", "--colony", "--archived", "--cmd", "--name", "--resume"],
  usage: ["--samples", "--json", "--ttl"],
  limits: ["--samples", "--json", "--ttl"],
  sessions: ["--home", "--json"],
  sync: ["--json"],
  node: ["--kind", "--endpoint", "--capabilities", "--description", "--ssh-command", "--ssh-args"],
  run: [
    "--prompt", "-p", "--cwd", "--pool", "--no-keep", "--home", "--profile", "--account", "--ttl",
    "--wait", "--last", "--transcript",
    "--rm", "--cleanup", "--keep",
    "--accept-trust", "--trust", "--no-accept-trust", "--no-trust", "--force-send",
    "--yolo", "--dangerous",
    "--idle-ms", "--timeout-ms", "--poll-ms", "--boot-ms", "--wait-ms",
    "--node", "--substrate",
    "-n", "--limit", "--json",
    "--include-paused", "--yes",
  ],
  x: [
    "--prompt", "-p", "--cwd", "--pool", "--no-keep", "--home", "--profile", "--account", "--ttl", "--name", "--colony",
    "--accept-trust", "--trust", "--no-accept-trust", "--no-trust", "--force-send",
    "--yolo", "--dangerous", "--boot-ms", "--node", "--substrate", "--here", "--include-paused", "--yes",
  ],
  send: ["--prompt", "-p"],
  kill: ["--comb", "--yes", "--force"],
  here: ["--id", "--json"],
  "spawn-picker": ["--frame", "--flow", "--here"],
  urls: ["--lines", "--open", "--json"],
  keys: ["--tmux", "--wezterm", "--against-recommended"],
  split: ["--brief", "--dir", "--cwd", "--home", "--profile", "--account", "--ttl", "--yolo", "--no-yolo", "--dangerous", "--no-accept-trust", "--no-wait", "--briefed"],
  fork: ["--agent", "--model", "--node", "--cwd", "--seed", "--read-log", "--name", "--account", "--here", "--print", "--include-paused", "--yes"],
  brief: ["--brief", "-b", "--accept-trust", "--no-accept-trust", "--force-send", "--no-wait-footer", "--wait-footer", "--footer", "--no-footer"],
  rename: ["--auto", "--clear", "--here"],
  tag: ["--remove", "--list"],
  own: ["--clear"],
  move: ["--colony", "--owner"],
  seal: ["--from", "--example", "--help"],
  last: ["-n", "--lines", "--seal"],
  wait: ["--idle-ms", "--idle", "--timeout-ms", "--timeout", "--poll-ms", "--poll", "--last", "--transcript", "--seal", "-n", "--limit", "--json"],
  tail: ["-n", "--lines"],
  cat: ["-n", "--lines"],
  transcript: ["-n", "--limit", "--json"],
  tx: ["-n", "--limit", "--json"],
  clean: ["--dead", "--crashed", "--idle", "--interactive", "-i", "--older-than", "--older", "--dry-run", "-n"],
  list: ["--colony", "--swarm", "--node", "--state", "--agent", "--repo", "--tag", "--archived", "--json", "--wide"],
  ps: ["--colony", "--swarm", "--node", "--state", "--agent", "--repo", "--tag", "--archived", "--json", "--wide"],
  bees: ["--colony", "--swarm", "--node", "--sidebar", "--toggle-sidebar", "--width", "-w"],
  attach: ["--print"],
  next: ["--state", "--prev", "--print"],
  search: ["--colony", "--swarm", "--bee", "--type", "--status", "--since", "--regex", "--case", "--limit", "--json"],
  seals: ["--colony", "--swarm", "--bee", "--status", "--since", "--regex", "--case", "--limit", "--json"],
  buz: [
    "--tier", "--sender", "--sender-human", "--prompt", "-p", "--subject",
    "--unread", "--limit", "--from", "--consume", "--read", "--older-than", "--all",
    "--accept",
  ],
  daemon: ["--tick-ms", "--json", "--label", "--force", "--follow", "--lines", "-n"],
  events: ["--follow", "-f", "--json", "--type", "--session", "--since", "--lines", "-n"],
  flight: [
    "--name", "--cwd", "--mix", "--agent", "--slots", "--model", "--account",
    "--brief", "--brief-file", "--colony", "--completion", "--seal-type",
    "--readiness-ms", "--first-evidence-ms", "--stall-ms", "--max-attempts", "--max-boots",
    "--task-id", "--from-dir", "--retry", "--abandon", "--accept", "--json",
  ],
  flow: ["--arg", "--foreground", "--background", "--flow", "--json", "-n", "--lines"],
  loop: [
    "--bee", "--cwd", "--context", "--prompt", "--prompt-file",
    "--until", "--max", "--max-duration", "--forever",
    "--stop-on-seal", "--stop-on-sentinel", "--judge", "--summarizer",
    "--yolo", "--iter", "-n", "--follow", "-f", "--now", "--json",
    "--name", "--description",
  ],
};

export type FlagValueKind = "colony" | "swarm" | "frame" | "shell" | "node" | "node-kind" | "bee" | "agent" | "search-type" | "seal-status" | "hive-state" | "flow" | "buz-tier" | "buz-accept" | "run" | "loop-context" | "loop-summarizer" | "account" | "account-or-meta" | "fork-seed";

export const LOOP_CONTEXT_VALUES = ["persistent", "ralph", "rolling"];
export const LOOP_SUMMARIZER_VALUES = ["self", "bee"];
export const FORK_SEED_VALUES = ["resume", "seal", "summary", "log", "none"];

// Global fallback: flags whose value-completion is unambiguous regardless
// of the current verb (e.g. --colony always refers to a colony).
export const FLAG_VALUE_KINDS: Record<string, FlagValueKind> = {
  "--colony": "colony",
  "--swarm": "swarm",
  "--swarm-id": "swarm",
  "--frame": "frame",
  "--node": "node",
  "--kind": "node-kind",
  "--bee": "bee",
  "--owner": "bee",
  "--agent": "agent",
  "--type": "search-type",
  "--status": "seal-status",
  "--flow": "flow",
  // --account only appears on spawn-side verbs, where the reserved queries
  // `auto` (least-loaded pick) and `rr` (round-robin) are valid alongside
  // real account ids.
  "--account": "account-or-meta",
};

// Per-command overrides + additions. These only apply when args[0] equals
// the command name, so `--tier` cannot accidentally pollute non-buz verbs
// that might add an identically named flag later.
export const PER_COMMAND_FLAG_VALUE_KINDS: Record<string, Record<string, FlagValueKind>> = {
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
  next: {
    "--state": "hive-state",
  },
  fork: {
    "--seed": "fork-seed",
  },
};

export const NOUN_COMMAND_SUBS: Record<string, string[]> = {
  colony: COLONY_SUBCOMMANDS,
  pool: POOL_SUBCOMMANDS,
  frame: FRAME_SUBCOMMANDS,
  swarm: SWARM_SUBCOMMANDS,
  node: NODE_SUBCOMMANDS,
  substrate: SUBSTRATE_SUBCOMMANDS,
  seals: SEALS_SUBCOMMANDS,
  flow: FLOW_SUBCOMMANDS,
  loop: LOOP_SUBCOMMANDS,
  buz: BUZ_SUBCOMMANDS,
  daemon: DAEMON_SUBCOMMANDS,
  flight: FLIGHT_SUBCOMMANDS,
  account: ACCOUNT_SUBCOMMANDS,
  sessions: SESSIONS_SUBCOMMANDS,
  sync: SYNC_SUBCOMMANDS,
  keys: KEYS_SUBCOMMANDS,
};

export type NounSubArgKind = "colony" | "swarm" | "frame" | "node" | "flow" | "session-any" | "run" | "account";

export const NOUN_SUB_ARG: Record<string, Record<string, NounSubArgKind>> = {
  colony: { inspect: "colony", archive: "colony", update: "colony", rename: "colony" },
  frame: { inspect: "frame", remove: "frame", edit: "frame", update: "frame", reload: "frame" },
  swarm: { inspect: "swarm", destroy: "swarm" },
  node: { inspect: "node", update: "node", unregister: "node" },
  flow: { inspect: "flow", remove: "flow", run: "flow", logs: "run", status: "run", cancel: "run" },
  account: { capture: "account", sync: "account", pause: "account", resume: "account", remove: "account", rm: "account" },
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
