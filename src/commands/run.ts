// `hive run`/x/xa/open — spawn a bee, hand it a prompt, and optionally wait,
// attach, or present it where you are.
// Extracted from cli.ts (HIVE-15).
import { activateAccountIntoHome, defaultHomeForAccount, seedClaudeHomeAcceptance, syncAccountCredentialsToVault } from "../accounts.js";
import { assertAgentAuthFreshForSpawn, canonicalAgentKind, refreshIdentityEnv, resolveAgent, shellCommand } from "../agents.js";
import { bootMsForAgent } from "../drivers.js";
import { actionLine, bold, dim, isPretty, note } from "../format.js";
import { writeHiveState } from "../hiveState.js";
import { transactionalKill } from "../kill.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { AgentReadinessError, waitForAgentReady } from "../readiness.js";
import { appendLedger, updateSession, type SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { openInNewTerminal, runInCurrentTerminal } from "../terminal.js";
import { formatShellCommand } from "../tmux.js";
import { waitForIdle } from "../wait.js";
import { acceptsTrust, cleanupAfterRun, confirmPausedAccount, dangerousMode, formatPaneExcerpt, hasFlag, hsrSubstrateRequested, includePausedFlag, resolveSpawnCwd, sleep, stringFlag, ttlFlagMs } from "../cli/shared.js";
import { cmdSpawn, resolveAccountFlag, resolveProfileOverlay, resolveSpawnAgentWithAuto } from "../commands/spawn.js";

/**
 * run/x/xa spawn exactly one bee — reject cohort flags with a command-specific
 * hint (the guard used to be copy-pasted per command and drifted).
 */
export function assertSingleBeeInvocation(parsed: Parsed, hint: string): void {
  if (numberFlag(parsed, ["count"], 1) > 1 || flag(parsed, "frame")) throw new Error(hint);
}


/**
 * The shared run/x/xa/open delegation to cmdSpawn: clone the caller's flags,
 * let `mutateFlags` adjust the clone (no-wait, forced substrate, delegated-flag
 * pruning), and spawn with the caller's rest unless overridden.
 */
export async function spawnDelegated(
  parsed: Parsed,
  agent: string,
  opts: { mutateFlags?: (flags: Map<string, string | true | string[]>) => void; rest?: string[] } = {},
): Promise<SessionRecord> {
  const spawnFlags = new Map(parsed.flags);
  opts.mutateFlags?.(spawnFlags);
  const spawnParsed: Parsed = {
    command: "spawn",
    args: [agent],
    flags: spawnFlags,
    rest: opts.rest ?? parsed.rest,
  };
  return cmdSpawn(spawnParsed);
}


/**
 * run/x readiness gate. HSR bees have no interactive TUI to poll for readiness
 * — the runner host is ready as soon as spawn confirmed it live (hasSession),
 * so only tmux bees wait on the pane scrape; --force-send downgrades a
 * readiness timeout to a warning. Shared so the HSR split cannot diverge
 * between run and x again.
 */
export async function waitForPromptReady(record: SessionRecord, parsed: Parsed): Promise<void> {
  if (record.substrate === "hsr") return;
  try {
    await waitForAgentReady(record, {
      timeoutMs: numberFlag(parsed, ["boot-ms"], bootMsForAgent(record.agent)),
      acceptTrust: acceptsTrust(parsed),
      raiseDroidAutonomy: dangerousMode(parsed, record.agent, record.requestedAgent),
    });
  } catch (error) {
    if (!(error instanceof AgentReadinessError) || error.reason !== "timeout" || !truthy(flag(parsed, "force-send"))) throw error;
    console.error(actionLine("warn", "force", [`readiness timeout for ${bold(record.name)}, sending anyway`]));
    if (error.pane.trim()) console.error(formatPaneExcerpt(error.pane));
  }
}


/**
 * Deliver a run/x prompt: send it to the agent pane, stamp the record's
 * lastPrompt fields, flip hive-state to working, and ledger the prompt.
 * Returns the stamp timestamp (cmdRun's waitForIdle needs it).
 */
export async function deliverPromptToBee(record: SessionRecord, prompt: string): Promise<string> {
  await substrateFor(record).sendText(record.tmuxTarget, prompt, record.agentPaneId);
  const now = new Date().toISOString();
  await updateSession(record.name, { updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now });
  await writeHiveState(record, "working");
  await appendLedger({ type: "prompt.run", session: record.name, agent: record.agent, node: record.node ?? LOCAL_NODE_NAME, cwd: record.cwd, chars: prompt.length });
  return now;
}


export async function cmdRun(parsed: Parsed) {
  const agent = parsed.args[0];
  const prompt = stringFlag(parsed, ["prompt", "p"]) ?? parsed.args.slice(1).join(" ");
  if (!agent || !prompt) throw new Error("Usage: hive run <bee> -p <prompt> [--cwd dir] [--account <name|auto>] [--yolo] [--wait] [--last] [--rm|--cleanup] [-- <bee-args...>]");
  if (truthy(flag(parsed, "keep")) && cleanupAfterRun(parsed)) throw new Error("--keep cannot be combined with --rm/--cleanup");
  assertSingleBeeInvocation(parsed, "hive run spawns a single bee; to prompt a swarm use: hive spawn <bee> --count <n> && hive send <selector> <prompt>");
  const waited = truthy(flag(parsed, "wait"));
  if (!waited && hasFlag(parsed, "n")) {
    throw new Error("hive run: -n is only for --wait output rows; use --lines for the no-wait pane preview");
  }

  // The waitForPromptReady below is authoritative; skip spawn's own readiness
  // confirmation so a slow boot is only waited for once.
  const record = await spawnDelegated(parsed, agent, { mutateFlags: (flags) => flags.set("no-wait", true) });
  const cleanup = cleanupAfterRun(parsed);
  let blocked = false;

  try {
    await waitForPromptReady(record, parsed);
    const now = await deliverPromptToBee(record, prompt);

    if (waited) {
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
      const lines = Number(flag(parsed, "lines") ?? 80);
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


export async function cleanupRunSession(record: SessionRecord): Promise<void> {
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
export async function cmdX(parsed: Parsed) {
  const agent = parsed.args[0];
  const prompt = stringFlag(parsed, ["prompt", "p"]) ?? parsed.args.slice(1).join(" ");
  if (!agent || !prompt) throw new Error("Usage: hive x <bee> <prompt> [--cwd <dir>] [--account <name|auto>] [--name <id>] [--yolo] [-- <bee-args...>]");
  assertSingleBeeInvocation(parsed, "hive x spawns a single bee; to prompt a swarm use: hive spawn <bee> --count <n> && hive send <selector> <prompt>");

  // The waitForPromptReady below is authoritative; skip spawn's own readiness
  // confirmation so a slow boot is only waited for once.
  const record = await spawnDelegated(parsed, agent, { mutateFlags: (flags) => flags.set("no-wait", true) });

  await waitForPromptReady(record, parsed);
  await deliverPromptToBee(record, prompt);
  if (isPretty()) console.log(actionLine("ok", "send", [bold(record.name), `${prompt.length} chars`]));
  else console.log(`sent\t${record.name}\t${prompt.length} chars`);
}


// Shorthand: spawn a single bee and attach to it — the interactive front door
// (`hive xa claude`, `hive xa cc1`, `hive xa codex-ur`). Spawn waits for the
// agent prompt (confirmSpawnReady) so attach lands on a ready pane; detaching
// leaves the bee running like any tmux session.
export async function cmdXa(parsed: Parsed) {
  const agent = parsed.args[0];
  if (!agent) throw new Error("Usage: hive xa <bee> [--cwd <dir>] [--home <1|2|3|path>] [--account <a|auto>] [--name <id>] [--print]");
  assertSingleBeeInvocation(parsed, "hive xa attaches to a single bee; spawn cohorts with hive spawn --count/--frame");

  // `xa` = spawn + attach to a terminal. HSR bees are pane-less and have no
  // tmux target to attach, so xa must never produce one: reject an explicit
  // --substrate hsr, and — when nothing is explicit — force local tmux so the
  // agent-context HSR default (spawnSingleBee policy) never applies to an
  // attach workflow. An explicit tmux-family target (--substrate ssh:host /
  // --node host, an attachable remote pane) is honored as-is.
  if (hsrSubstrateRequested(parsed)) {
    throw new Error(
      "hive xa attaches to a terminal, which HSR bees don't have. Use `hive x <bee> --substrate hsr` then `hive send`/`hive tail`, or drop --substrate hsr to attach a tmux bee.",
    );
  }
  const xaSubstrateFlag = flag(parsed, "substrate");
  const xaNodeFlag = flag(parsed, "node");
  const xaHasExplicitTarget =
    (typeof xaSubstrateFlag === "string" && xaSubstrateFlag.trim().length > 0) ||
    (typeof xaNodeFlag === "string" && xaNodeFlag.trim().length > 0);
  const record = await spawnDelegated(parsed, agent, {
    mutateFlags: (flags) => {
      if (!xaHasExplicitTarget) flags.set("substrate", "tmux");
    },
  });

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
export const OPEN_OWN_FLAGS = new Set([
  "raw", "window", "app", "cwd", "account", "ttl", "home", "profile", "print",
  "yolo", "dangerous", "no-yolo", "accept-trust", "trust", "no-accept-trust", "no-trust",
]);


// In the registered (non-raw) modes these are spawn-pipeline controls, not
// agent flags — they ride the delegated spawn instead of the passthrough.
export const OPEN_SPAWN_CONTROL_FLAGS = new Set([
  "name", "colony", "swarm", "swarm-id", "count", "frame", "node", "substrate",
  "brief", "briefed", "autoswap", "boot-ms", "no-wait", "force-send", "here",
]);


export const OPEN_DELEGATED_FLAGS = new Set([...OPEN_OWN_FLAGS, ...OPEN_SPAWN_CONTROL_FLAGS]);


export function openPassthroughArgs(parsed: Parsed, exclude: Set<string> = OPEN_OWN_FLAGS): string[] {
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
export async function cmdOpen(parsed: Parsed) {
  const requested = parsed.args[0];
  if (!requested) throw new Error("Usage: hive open <bee> [--raw] [--window] [--app <terminal>] [--cwd <dir>] [--account <a|auto>] [--print] [<bee-flags...>]");

  const rawAppFlag = typeof flag(parsed, "app") === "string" ? String(flag(parsed, "app")) : undefined;
  const raw = truthy(flag(parsed, "raw")) || truthy(flag(parsed, "window")) || rawAppFlag !== undefined;
  if (!raw) {
    const record = await spawnDelegated(parsed, requested, {
      mutateFlags: (flags) => {
        for (const key of [...flags.keys()]) {
          // Unknown flags reach the agent via the spawn rest, not as spawn flags.
          if (!OPEN_DELEGATED_FLAGS.has(key)) flags.delete(key);
        }
        flags.delete("raw");
        flags.delete("print");
        if (process.env.TMUX) flags.set("here", true);
      },
      rest: [...openPassthroughArgs(parsed, OPEN_DELEGATED_FLAGS), ...parsed.rest],
    });
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
export async function cmdOpenRaw(parsed: Parsed) {
  const requested = parsed.args[0]!;
  const { agent: resolvedAgent, account: aliasAccount } = await resolveSpawnAgentWithAuto(requested, parsed);
  // Thin profile → account (same overlay as spawnSingleBee).
  const profile = await resolveProfileOverlay(requested);
  const agent = profile ? profile.account.tool : resolvedAgent;
  const profileArgs = profile?.args ?? [];
  const yolo = dangerousMode(parsed, agent, requested, profile?.yolo);
  const accountQuery = typeof flag(parsed, "account") === "string" ? String(flag(parsed, "account")) : undefined;
  const account = accountQuery ? await resolveAccountFlag(accountQuery, canonicalAgentKind(agent), ttlFlagMs(parsed), includePausedFlag(parsed)) : (profile?.account ?? aliasAccount);
  // Raw open skips cmdSpawn, so it needs its own paused-account gate.
  await confirmPausedAccount(account, parsed);
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
    refreshIdentityEnv(spec);
  }
  const cwd = await resolveSpawnCwd(parsed, profile?.cwd);
  // Re-merge the startup acceptances activation just clobbered (and seed them
  // for fresh homes), so claude does not re-ask the bypass-permissions and
  // folder-trust questions on every open.
  if (spec.kind === "claude" && spec.homePath) {
    await seedClaudeHomeAcceptance(spec.homePath, { yolo, trustCwd: acceptsTrust(parsed) ? cwd : undefined });
  }
  // This rendering is executed (window mode) or handed to the user (--print),
  // so it must carry real secret env values — never store or display it.
  const command = shellCommand(spec, { forExec: true });
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
