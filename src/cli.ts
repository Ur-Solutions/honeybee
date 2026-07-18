#!/usr/bin/env node
// hive CLI entrypoint: argv parsing + top-level command dispatch. Every command
// handler lives in src/commands/*, shared helpers in src/cli/shared.ts, and the
// HSR runner host in src/hsr/runnerHost.ts (HIVE-15 decomposition of cli.ts).
import { getCompletions } from "./completion.js";
import { bold, cyan, dim, errorPrefix, gray, isPretty, yellow } from "./format.js";
import { flag, parse, truthy } from "./parse.js";
import { APP_NAME, VERSION } from "./cli/shared.js";
import { runHsrHostFromPayload } from "./hsr/runnerHost.js";
import { cmdAccount, cmdActivate, cmdLimits, cmdLogin, cmdSwapAccount, cmdUsageSamples, wantsUsageLive } from "./commands/account.js";
import { cmdBuz } from "./commands/buz.js";
import { cmdClean } from "./commands/clean.js";
import { cmdColony } from "./commands/colony.js";
import { cmdCompletion, cmdConfig } from "./commands/config.js";
import { cmdDaemon, cmdSessions, cmdSync } from "./commands/daemon.js";
import { cmdFlow, runFlowExec } from "./commands/flow.js";
import { cmdFork, cmdForkLaunch, cmdSplit } from "./commands/fork.js";
import { cmdFrame } from "./commands/frame.js";
import { cmdHere, cmdSpawnPicker } from "./commands/here.js";
import { cmdKeys } from "./commands/keys.js";
import { cmdLoop } from "./commands/loop.js";
import { cmdAnswer, cmdBrief, cmdMove, cmdOwn, cmdRename, cmdSeal, cmdSend, cmdTag } from "./commands/messaging.js";
import { cmdAuthResume, cmdDemote, cmdPromote, cmdRevive, cmdSetModel } from "./commands/migrate.js";
import { cmdNode, cmdSubstrate } from "./commands/node.js";
import { cmdAttach, cmdBees, cmdKill, cmdLast, cmdList, cmdNext, cmdRetire, cmdTail, cmdTranscript, cmdUrls, cmdWait } from "./commands/observe.js";
import { cmdFleet } from "./commands/fleet.js";
import { cmdPool } from "./commands/pool.js";
import { cmdOpen, cmdRun, cmdX, cmdXa } from "./commands/run.js";
import { cmdSeals, cmdSearch } from "./commands/search.js";
import { cmdLaunch, cmdNew, cmdSpawn } from "./commands/spawn.js";
import { cmdSpend } from "./commands/spend.js";
import { cmdSwarm } from "./commands/swarm.js";
import { sealHelpText } from "./seal.js";
import { closeAllSubstrates } from "./substrates/index.js";

// Re-exports consumed by the unit tests (tests/*.test.ts import these from
// "../src/cli.js"). The HIVE-15 decomposition moved the handlers into
// src/commands/* and src/cli/shared.ts; cli.ts keeps re-exporting the same
// public surface so those imports keep resolving.
export { emitLog, followFlag, logLinesFlag, resolveSpawnSubstrate } from "./cli/shared.js";
export { resolveDefineArgs } from "./commands/frame.js";
export { assertResumable, tmuxSessionSurvives } from "./commands/migrate.js";
export { assertSingleBeeInvocation } from "./commands/run.js";
export { resolvePromptArg } from "./commands/loop.js";

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
  try {
    await dispatch(parsed);
  } finally {
    // A one-shot command that probed a remote node leaves a cached remote-hsr
    // substrate holding an `ssh -N -L` forward tunnel; its child keeps Node's
    // event loop alive and the process would hang after printing. Tear those
    // down so the CLI exits promptly. Best-effort — never fails the command.
    await closeAllSubstrates();
  }
}

async function dispatch(parsed: ReturnType<typeof parse>) {
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
    case "fleet":
      await cmdFleet(parsed);
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
    case "retire":
    case "archive":
      await cmdRetire(parsed);
      break;
    case "promote":
      await cmdPromote(parsed);
      break;
    case "set-model":
      await cmdSetModel(parsed);
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
    case "auth-resume":
      await cmdAuthResume(parsed);
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
    case "completion":
      await cmdCompletion(parsed);
      break;
    case "colony":
      await cmdColony(parsed);
      break;
    case "pool":
      await cmdPool(parsed);
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
    case "spend":
      await cmdSpend(parsed);
      break;
    case "help":
      if (parsed.args[0] === "seal") console.log(sealHelpText());
      else printHelp();
      break;
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
        ["fleet", "[<bee>|--all]", "orchestrator fleet trees with live state + seals (no arg: self inside a bee, else all fleets; --all forces all; --json)"],
        ["tail", "<session>", "capture or follow pane content"],
        ["transcript", "<session>", "render structured transcript rows"],
        ["last", "<session>", "print the bee's most recent assistant message or seal"],
        ["wait", "<session>", "block until the bee goes idle or seals"],
        ["search", "<query>", "search seals, ledger, and session records (seals find: seals only)"],
        ["usage", "[<account>]", "progress against providers' real 5h/weekly limits (--live dashboard; alias: limits)"],
        ["spend", "<ingest|report|leverage|…>", "local API-equivalent cost ledger + subscription leverage from transcripts"],
      ],
    },
    {
      title: "Manage bees",
      rows: [
        ["attach", "<session>", "attach to the tmux session (nesting-safe inside tmux)"],
        ["next", "", "jump to the next bee needing you (waiting/done/failed; --prev, --state)"],
        ["fork", "<bee> [checkpoint]", "branch a bee into a fresh comb, seeded from its state"],
        ["here", "", "resolve the bee owning the current pane (--id, --json)"],
        ["spawn-picker", "[--frame|--flow]", "print frame/flow names for a display-popup spawn chord"],
        ["urls", "[<bee>]", "list URLs printed in a bee's pane (--lines, --open, --json)"],
        ["keys", "<print|path|check>", "print/verify the recommended tmux keybinding set"],
        ["retire", "<bee|@swarm|colony:name>", "stop a bee and archive its record (the everyday way to end bees; alias: archive)"],
        ["kill", "<session>", "PURGE a bee: stop it and delete its record/seals/run data (rare; prompts, --yes)"],
        ["promote", "<bee>", "move an HSR bee onto an interactive tmux pane (resume; claude/codex, --now)"],
        ["set-model", "<bee> <model>", "change a bee's model in place, resuming its session (--clear, --fresh, --now, -- <harness flags>)"],
        ["demote", "<bee>", "move a tmux bee back to a pane-less HSR runner (resume; claude/codex, --now)"],
        ["revive", "<bee>", "relaunch a dead bee and resume its session (--crashed, --all, --fresh, --session <id>, --no-wait)"],
        ["auth-resume", "<bee>", "capture a fresh login, stop an auth-needed bee, and resume its session"],
        ["clean", "--dead|--crashed|--idle|-i", "remove dead/crashed metadata, kill idle bees, or clean interactively"],
        ["loop", "<launch|start|status|stop|…>", "run a bee repeatedly until a stop condition (launch = interactive dialog)"],
      ],
    },
    {
      title: "Organize",
      rows: [
        ["colony", "<list|create|…>", "manage project-scoped namespaces"],
        ["pool", "<list|status|spawn|…>", "checkout pools: claim clean pro clones round-robin (also: spawn --pool)"],
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
    `  ${env("HIVE_CODEX_START_CONCURRENCY")}=${arg("2")} hive x codex "task"  ${dim("— bounded HSR cold starts; 0 disables")}`,
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
