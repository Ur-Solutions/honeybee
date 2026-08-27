import { blue, bold, cyan, dim, gray, honey, yellow } from "./style.ts";

type Row = [cmd: string, syn: string, desc: string];
type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "Spawn & run",
    rows: [
      ["spawn", "<name> [agent]", "start a bee (supports claude-gmail, codex-auto, claude-rr; exact --account wins)"],
      ["x", "<name> <prompt…>", "spawn + first send, fire-and-forget (--agent/--account/--cwd…)"],
      ["xa", "<agent> [--name n]", "spawn + attach (e.g. claude-gmail fuzzy, codex-auto least-loaded, claude-rr round-robin)"],
      ["run", "<name> -p <prompt>", "spawn, send, wait, print the reply, archive (--keep skips)"],
      ["fork", "<bee> [--name n]", "new bee, same shape, continues the source's conversation"],
    ],
  },
  {
    title: "Message",
    rows: [
      ["send", "<bee> <message…>", "mailbox insert; --urgency now|next|idle; --wait blocks on delivery"],
      ["ask", "<question…>", "(from inside a bee) ask the operator; the answer returns as mail"],
      ["answer", "<question-id> <answer…>", "answer an open question (also: question answer …)"],
      ["question", "list [--bee b] [--open]", "list questions"],
      ["seal", "<title> [--body t]", "record a seal · seal list [--bee b] · seal get <id>"],
      ["buz", "send <bee> -p <body>", "v1 compat: a mailbox send (tiers map onto urgency)"],
      ["buz", "inbox [bee]", "v1 compat: the mailbox (defaults to self inside a bee)"],
      ["task", "add <list> -p <title>", "append a micro-task (bee:<id> or shared:<name> or a bare bee)"],
      ["task", "ls|show|start|done|block|cancel", "list / inspect / transition (block -p reason)"],
      ["task", "claim|mv|edit|lists", "claim shared work, reorder, edit, enumerate lists"],
      ["task", "supply <bee> [--on|--off]", "auto-feed pending auto tasks via mailbox when idle"],
    ],
  },
  {
    title: "Observe",
    rows: [
      ["list", "[--all|--archived]", "all bees with state (aliases: ls, ps)"],
      ["view", "<bee>", "one bee, in full"],
      ["mailbox", "<bee>", "queued + delivered mail"],
      ["commands", "<bee>", "command queue for a bee"],
      ["children", "<bee>", "bees this one spawned or forked"],
      ["transcript", "<bee> [-n n] [-f]", "session log as readable turns (alias: tx); -f/--follow streams"],
      ["tail", "<bee> [-n n] [-f]", "recent output; -f/--follow streams (--raw = verbatim log)"],
      ["last", "<bee> [--seal]", "the most recent assistant message (fallback: latest seal)"],
      ["wait", "<bee>", "block until the bee is idle/stopped with no queued mail"],
      ["events", "[--bee b] [--kind glob]", "audit-row tail (the ledger of every write)"],
      ["here", "[--json]", "this process's own bee (the HIVE_BEE_ID stamp)"],
      ["usage", "[account]", "provider 5h/weekly/fable windows per account (alias: limits)"],
      ["watch", "[--bee id]", "whole-node change stream (snapshot + seq deltas)"],
      ["health", "", "daemon liveness + i1 violations"],
      ["deploy-info", "", "protocol / versions / paths"],
    ],
  },
  {
    title: "Manage bees",
    rows: [
      ["stop", "<bee>", "end the runtime; the bee stays active"],
      ["revive", "<bee>", "generation N+1; optional replacement args after --"],
      ["archive", "<bee>", "file the bee; send auto-unarchives"],
      ["unarchive", "<bee>", "return an archived bee to active"],
      ["delete", "<bee>", "remove the bee and owned durable data"],
      ["interrupt", "<bee>", "stop the current TURN, keep the runtime (idle = no-op)"],
      ["rename", "<bee> <new-name>", "rename (names are labels; the id is the identity)"],
      ["tag", "<bee> [--add t]...", "edit tags (apiary:workspace=… moves a bee between workspaces)"],
      ["bee", "set-args <bee> -- <args…>", "per-bee harness args; applies on the NEXT runtime"],
      ["bee", "args <bee>", "show layered args"],
      ["set-model", "<bee> <model>", "model surgery on the per-bee args (applies next runtime)"],
      ["attach", "<bee> [--print]", "tmux-substrate bees only (hsr/cell are pane-less: use tail)"],
      ["cell", "capture <bee> --onto <b>", "land the cell's commits onto an origin branch"],
      ["cell", "remove <bee> [--force]", "delete the cell (dirty guard) + delete the bee"],
    ],
  },
  {
    title: "Accounts",
    rows: [
      ["account", "list [--harness h]", "accounts + latest limits · get <selector> (exact or unique fuzzy)"],
      ["account", "add <harness> <label>", "create an account [--id id] [--home dir] [--penalty n]"],
      ["account", "remove|pause|unpause <selector>", "lifecycle · penalty <selector> <0-100>"],
      ["login", "<account>", "open + attach to the login seat (--no-attach leaves it detached)"],
      ["account", "capture <selector>", "snapshot an already-authenticated home/provider credential into the vault"],
      ["swap-account", "<bee> <account>", "move a bee to another account of the SAME harness"],
      ["account", "limits [<selector>]", "refresh + show provider limits (feeds auto; rr uses registration order)"],
      ["account", "import [--root ~/.hive]", "import the old vault · account backfill [--dry-run]"],
    ],
  },
  {
    title: "Templates & tracks",
    rows: [
      ["template", "run <name> [input…]", "spawn from a daemon-owned preset (--wait or --attach)"],
      ["template", "list|get|inspect|put|delete|…", "rows are truth, files are packages"],
      ["track", "list|get|put|delete|…", "expected step sequences"],
      ["packages", "import-local [--dir d]", "import ~/.hive templates & tracks"],
    ],
  },
  {
    title: "Cutover",
    rows: [
      ["freeze", "[--root r] [--force]", "write <root>/FROZEN (refuses while the old daemon is alive)"],
      ["import", "--from-frozen", "import active bees from the frozen old-world store"],
    ],
  },
  {
    title: "Daemon",
    rows: [
      ["daemon", "run", "run the daemon in the foreground"],
      ["daemon", "install|uninstall|start|stop|restart|status", "platform service + liveness"],
    ],
  },
];

/** Operator-facing binary name. After WP7 freeze, plain `hive` IS this CLI. */
export const BIN = "hive";

function invocation(name: string, syn: string): string {
  return `${BIN} ${name}${syn ? ` ${syn}` : ""}`;
}

function renderRow([name, syn, desc]: Row, width: number): string {
  const plain = invocation(name, syn);
  const colored = `${cyan(BIN)} ${cyan(name)}${syn ? ` ${gray(syn)}` : ""}`;
  const padded = colored + " ".repeat(Math.max(0, width - plain.length));
  return `  ${padded}   ${dim(desc)}`;
}

export function helpText(version = "v2"): string {
  const width = Math.max(...GROUPS.flatMap((g) => g.rows.map(([name, syn]) => invocation(name, syn).length)));
  const sections = GROUPS.map((g) => `${bold(yellow(`${g.title}:`))}\n${g.rows.map((row) => renderRow(row, width)).join("\n")}`).join(
    "\n\n",
  );

  const head = `${honey(bold("hive"))} ${dim(version)}  ${dim("— durable AI agent sessions")}`;
  const usage = `${bold(yellow("Usage:"))}
  ${cyan("hive")} ${gray("<command> [args]")} ${dim("[--data-dir d] [--socket s] [--json]")}

  Mutations go through the daemon (RPC). Reads fall back to the read-only
  store when the daemon is down — that output is clearly labeled STALE.
  ${dim("(--idempotency-key on any mutation: a replayed key returns the original outcome, marked deduped.)")}
  ${dim("(`hive v2 …` still works — it is the same CLI.)")}`;

  const bees = `${bold(yellow("Bees:"))}
  ${blue("claude")}, ${blue("codex")}, ${blue("grok")}, stub — or any agent the node has configured
  ${dim("resolve a bee by handle (CL.a3f2), unique name, or uuid prefix (3+ chars)")}
  ${dim("urgency: now = interrupt then deliver; next = next accept point (default); idle = after the turn")}`;

  return `${head}

${usage}

${sections}

${bees}
`;
}
