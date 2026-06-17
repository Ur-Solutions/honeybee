import { activateAccountIntoHome, type AccountRecord } from "./accounts.js";
import { canonicalAgentKind, resolveAgent, shellCommand } from "./agents.js";
import { appendLedger, loadSession, saveSessionLocked, withSessionLock, type SessionRecord } from "./store.js";
import { substrateFor, type Substrate } from "./substrates/index.js";

// ──────────────────────────────────────────────────────────────────────────
// swap-account: the req-1 MECHANISM. Stop the bee's process, activate the
// target account's credentials into the bee's home, resume the same provider
// session in the same home, record the binding. Purely mechanical and fully
// ledger-logged; the *decision* to swap lives in the autoswap dispatcher (an
// opt-in deterministic flow) or above honeybee entirely.
// ──────────────────────────────────────────────────────────────────────────

export type SwapAccountOptions = {
  substrate?: Substrate;
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  pollIntervalMs?: number;
  /** Activation override (tests). Defaults to activateAccountIntoHome. */
  activate?: typeof activateAccountIntoHome;
};

const DEFAULT_POLL_ATTEMPTS = 8;
const DEFAULT_POLL_INTERVAL_MS = 500;

export async function swapAccount(
  record: SessionRecord,
  account: AccountRecord,
  options: SwapAccountOptions = {},
): Promise<SessionRecord> {
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  if (tool !== account.tool) {
    throw new Error(`Account ${account.id} is a ${account.tool} account; bee ${record.name} runs ${tool}`);
  }
  if (!record.homePath) {
    throw new Error(
      `Bee ${record.name} runs in the default ${tool} home; refusing to overwrite primary credentials. ` +
        `Swap requires a dedicated home (spawn with --home or --account).`,
    );
  }
  if (record.accountId === account.id) {
    throw new Error(`Bee ${record.name} is already on account ${account.id}`);
  }

  const substrate = options.substrate ?? substrateFor(record);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollAttempts = Math.max(1, options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const activate = options.activate ?? activateAccountIntoHome;

  return withSessionLock(record.name, async () => {
    // 0. Re-validate under the lock before any side effects: a concurrent
    //    kill/clean may have deleted the record, and proceeding would respawn
    //    the session and resurrect the deleted bee.
    const current = await loadSession(record.name);
    if (!current) throw new Error(`Session ${record.name} no longer exists; aborting swap`);

    // 1. Ensure the process is stopped. The tmux session must be fully gone
    //    before we relaunch into the same target.
    if (await substrate.hasSession(record.tmuxTarget)) {
      const killResult = await substrate.kill(record.tmuxTarget);
      if (!killResult.ok) {
        throw new Error(`Could not stop ${record.name} before swap: ${killResult.stderr || killResult.stdout || `exit ${killResult.exitCode}`}`);
      }
    }
    let gone = false;
    for (let i = 0; i < pollAttempts; i += 1) {
      if (!(await substrate.hasSession(record.tmuxTarget).catch(() => true))) {
        gone = true;
        break;
      }
      if (pollIntervalMs > 0) await sleep(pollIntervalMs);
    }
    if (!gone) throw new Error(`Session ${record.tmuxTarget} still alive after kill; aborting swap`);

    // 2. Activate the target account's credentials into the bee's home.
    await activate(account, record.homePath!);

    // 3. Resume the same provider session in the same provider home.
    const spec = resolveAgent(record.requestedAgent ?? record.agent, resumeArgs(tool, record.providerSessionId), {
      home: record.homePath,
      yolo: sniffYolo(record.command),
      identity: true,
    });
    // The swap re-creates the session, so the agent runs in a fresh pane —
    // re-pin to it (the old agentPaneId is now dead).
    const { paneId } = await substrate.newSession(record.tmuxTarget, record.cwd, { command: spec.command, args: spec.args, env: spec.env });

    // 4. Persist the new binding and command from the under-lock snapshot so
    //    a concurrent daemon merge (title, transcript metadata, observed
    //    state) isn't clobbered; saveSessionLocked avoids re-acquiring the
    //    non-reentrant session lock we already hold.
    const updated: SessionRecord = {
      ...current,
      accountId: account.id,
      command: shellCommand(spec),
      ...(paneId ? { agentPaneId: paneId } : {}),
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    await saveSessionLocked(updated);
    await appendLedger({
      type: "account.swap",
      session: record.name,
      from: record.accountId ?? null,
      to: account.id,
      home: record.homePath,
      providerSessionId: record.providerSessionId ?? null,
    });
    return updated;
  });
}

/** Per-provider resume invocation; falls back to "continue most recent" forms. */
export function resumeArgs(tool: string, providerSessionId: string | undefined): string[] {
  if (tool === "claude") return providerSessionId ? ["--resume", providerSessionId] : ["--continue"];
  if (tool === "codex") return providerSessionId ? ["resume", providerSessionId] : ["resume", "--last"];
  if (tool === "opencode") return providerSessionId ? ["--session", providerSessionId] : ["--continue"];
  return [];
}

// The original spawn's yolo decision is baked into the stored command; sniff it
// back so the resumed (or revived) process keeps the same permission mode.
export function sniffYolo(command: string): boolean {
  return /dangerously|bypass|--force\b/.test(command);
}
