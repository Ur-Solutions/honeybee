import { activateAccountIntoHome, listAccounts, syncAccountCredentialsToVault, type AccountRecord } from "./accounts.js";
import { assertAgentAuthFreshForSpawn, canonicalAgentKind, resolveAgent, shellCommand, splitShellWords } from "./agents.js";
import { resumeArgsForAgent } from "./drivers.js";
import { spawnHsrHost, waitForHsrHost, type HsrRunPayload } from "./hsr/runnerHost.js";
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
  /** Registry reader (tests). Defaults to listAccounts; used for the provider-match guard. */
  listAccounts?: typeof listAccounts;
  /** Local HSR runner-host launcher (tests). Defaults to spawnHsrHost. */
  spawnHsrHost?: (payload: HsrRunPayload) => Promise<number>;
  /** Local HSR runner-host readiness probe (tests). Defaults to waitForHsrHost. */
  waitForHsrHost?: (bee: string, timeoutMs: number) => Promise<boolean>;
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
  // Provider-match guard with undefined-tolerance (fix #9): once a CLI hosts
  // several providers (opencode → minimax/glm/kimi), a swap must stay within
  // the bee's current provider. Skip the check when EITHER side's provider is
  // undefined (legacy claude/codex accounts have no provider on the record).
  const accountRegistry = record.accountId ? await (options.listAccounts ?? listAccounts)() : [];
  if (record.accountId && account.provider) {
    const fromProvider = accountRegistry.find((other) => other.id === record.accountId)?.provider;
    if (fromProvider && fromProvider !== account.provider) {
      throw new Error(
        `Account ${account.id} is a ${account.provider} account; bee ${record.name} runs on ${fromProvider}`,
      );
    }
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

    // 2. Rescue the current account's freshest credentials from this home
    //    before activation overwrites it, then activate the target account.
    const rescueRegistry = current.accountId && accountRegistry.length === 0 ? await (options.listAccounts ?? listAccounts)() : accountRegistry;
    const currentAccount = current.accountId ? rescueRegistry.find((candidate) => candidate.id === current.accountId) : undefined;
    if (currentAccount && currentAccount.tool === tool && currentAccount.id !== account.id) {
      await syncAccountCredentialsToVault(currentAccount, record.homePath!, { trustExtraHome: true }).catch(() => undefined);
    }
    let spec: ReturnType<typeof resolveAgent>;
    let paneId: string | undefined;
    let launcherPgid: number | undefined;
    let runnerPid: number | undefined;
    try {
      await activate(account, record.homePath!);

      // 3. Resume the same provider session in the same provider home, with the
      //    driver's explicit identity env. The record's own model (a deliberate
      //    `hive set-model` choice) wins over the NEW account's default model;
      //    the account still supplies opencode's provider so a swapped bee keeps
      //    its `--model <provider>/<model>` selector (adversarial review fix #4).
      //    Both may be undefined (fine → the driver hook returns []). Persisted
      //    model extra flags (effort/reasoning) ride along like every relaunch.
      //
      //    HSR resumes through its detached runner host, not Substrate.newSession
      //    (that verb intentionally throws for pane-less HSR bees). The HSR
      //    adapter owns the provider-specific resume protocol, so do not append
      //    interactive CLI resume args to its base spec.
      const hsr = current.substrate === "hsr";
      if (hsr && !current.providerSessionId) {
        throw new Error(`Bee ${current.name} has no recorded provider session id; refusing to switch accounts without session continuity`);
      }
      const model = current.model ?? account.model;
      const modelExtra = current.modelExtraArgs ? splitShellWords(current.modelExtraArgs) : [];
      spec = resolveAgent(current.requestedAgent ?? current.agent, [...modelExtra, ...(hsr ? [] : resumeArgs(tool, current.providerSessionId))], {
        home: current.homePath,
        yolo: sniffYolo(current.command),
        identity: true,
        ...(model ? { model } : {}),
        ...(account.provider ? { provider: account.provider } : {}),
      });
      if (!current.node) await assertAgentAuthFreshForSpawn(spec, account.id);

      if (hsr) {
        runnerPid = await (options.spawnHsrHost ?? spawnHsrHost)({
          bee: current.name,
          comb: current.combId ?? current.name,
          ...(current.parentId ? { parent: current.parentId } : {}),
          kind: tool,
          cwd: current.cwd,
          sessionId: current.providerSessionId!,
          resume: true,
          authKind: "subscription",
          ...(model ? { model } : {}),
          spec: { command: spec.command, args: spec.args, env: spec.env },
        });
        if (!(await (options.waitForHsrHost ?? waitForHsrHost)(current.name, 5_000))) {
          console.error(`hsr host for ${current.name} did not report live within 5s; the daemon will reconcile`);
        }
      } else {
        // The swap re-creates the session, so the agent runs in a fresh pane —
        // re-pin to it (the old agentPaneId is now dead).
        const launch = await substrate.newSession(current.tmuxTarget, current.cwd, {
          command: spec.command,
          args: spec.args,
          env: spec.env,
          tmuxOptions: spec.tmuxOptions,
        });
        paneId = launch.paneId;
        launcherPgid = launch.launcherPgid;
      }
    } catch (error) {
      // Activation happens before relaunch. If anything after it fails, restore
      // the old account into the home so the persisted binding and on-disk
      // credentials cannot diverge (the exact failure mode fixed here).
      if (currentAccount) {
        try {
          await activate(currentAccount, record.homePath!);
        } catch (rollbackError) {
          const original = error instanceof Error ? error.message : String(error);
          const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(`${original}; restoring account ${currentAccount.id} also failed: ${rollback}`);
        }
      }
      throw error;
    }

    // 4. Persist the new binding and command from the under-lock snapshot so
    //    a concurrent daemon merge (title, transcript metadata, observed
    //    state) isn't clobbered; saveSessionLocked avoids re-acquiring the
    //    non-reentrant session lock we already hold.
    const updated: SessionRecord = {
      ...current,
      accountId: account.id,
      command: shellCommand(spec),
      ...(paneId ? { agentPaneId: paneId } : {}),
      ...(launcherPgid ? { launcherPgid } : {}),
      ...(runnerPid ? { runnerPid } : {}),
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

/**
 * Per-provider resume invocation; falls back to "continue most recent" forms.
 * The per-tool args live on the driver registry (AGENT_DRIVERS.resumeArgs).
 */
export function resumeArgs(tool: string, providerSessionId: string | undefined): string[] {
  return resumeArgsForAgent(tool, providerSessionId);
}

// The original spawn's yolo decision is baked into the stored command; sniff it
// back so the resumed (or revived) process keeps the same permission mode.
export function sniffYolo(command: string): boolean {
  return /dangerously|bypass|--force\b/.test(command);
}
