import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  activateAccountIntoHome,
  defaultHomeForAccount,
  listAccounts,
  syncAccountCredentialsToVault,
  type AccountRecord,
} from "./accounts.js";
import { assertAgentAuthFreshForSpawn, canonicalAgentKind, resolveAgent, shellCommand, splitShellWords } from "./agents.js";
import { resumeArgsForAgent } from "./drivers.js";
import { spawnHsrHost, waitForHsrHost, type HsrRunPayload } from "./hsr/runnerHost.js";
import { captureProcessBirthFingerprint, type ProcessBirthFingerprint } from "./hsr/processIdentity.js";
import { closeRequestsForNewIncarnation } from "./requests/store.js";
import { appendLedger, loadSession, saveSessionLocked, withSessionLock, type SessionRecord } from "./store.js";
import { substrateFor, type Substrate } from "./substrates/index.js";
import { nextRuntimeIncarnationPatch } from "./seal.js";
import { copyThreadForFork } from "./threadCopy.js";

// ──────────────────────────────────────────────────────────────────────────
// swap-account: the req-1 MECHANISM. Stop the bee's process, activate the
// target account's credentials into that account's dedicated home, transplant
// the provider thread safely, and record both the binding and new home. Never
// re-credential the source home in place: several live bees may share an
// account home, so overwriting it would silently invalidate all of them. Purely
// mechanical and fully ledger-logged; the *decision* to swap lives in the
// autoswap dispatcher (an opt-in deterministic flow) or above honeybee.
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
  /** Target-account home resolver (tests). Defaults to defaultHomeForAccount. */
  homeForAccount?: typeof defaultHomeForAccount;
  /** Local HSR runner-host launcher (tests). Defaults to spawnHsrHost. */
  spawnHsrHost?: (payload: HsrRunPayload) => Promise<number>;
  /** Local HSR runner-host readiness probe (tests). Defaults to waitForHsrHost. */
  waitForHsrHost?: (bee: string, timeoutMs: number) => Promise<boolean>;
  /** Thread copier override (tests). Defaults to copyThreadForFork. */
  copyThread?: typeof copyThreadForFork;
  /** Fresh provider id factory (tests). Defaults to randomUUID. */
  newProviderSessionId?: () => string;
};

const DEFAULT_POLL_ATTEMPTS = 8;
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Provider resume metadata lives under the identity home for Claude and Codex.
 * Moving credentials without the recorded transcript makes `--resume <id>`
 * fail with "No conversation found" even though the provider id is valid.
 * Copy the known, non-secret transcript to the same relative location in the
 * target home and return its new path. Records without discovered transcript
 * metadata keep their existing path and rely on the provider's own resume
 * mechanism, preserving legacy/non-file-backed harness behavior.
 */
async function relocateSessionTranscript(
  record: SessionRecord,
  sourceHomePath: string,
  targetHomePath: string,
): Promise<string | undefined> {
  if (!record.transcriptPath || resolve(sourceHomePath) === resolve(targetHomePath)) {
    return record.transcriptPath;
  }
  const sourceTranscript = resolve(record.transcriptPath);
  const sourceHome = resolve(sourceHomePath);
  const relativeTranscript = relative(sourceHome, sourceTranscript);
  if (
    !relativeTranscript ||
    relativeTranscript === ".." ||
    relativeTranscript.startsWith(`..${sep}`) ||
    isAbsolute(relativeTranscript)
  ) {
    return record.transcriptPath;
  }
  const info = await stat(sourceTranscript).catch(() => null);
  if (!info?.isFile()) return record.transcriptPath;
  const targetTranscript = join(targetHomePath, relativeTranscript);
  await mkdir(dirname(targetTranscript), { recursive: true });
  await copyFile(sourceTranscript, targetTranscript);
  return targetTranscript;
}

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
  const targetHomePath = (options.homeForAccount ?? defaultHomeForAccount)(account);
  if (record.accountId === account.id && resolve(record.homePath) === resolve(targetHomePath)) {
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
    if (!current.homePath) {
      throw new Error(`Session ${record.name} lost its dedicated home; aborting swap`);
    }
    if (current.accountId === account.id && resolve(current.homePath) === resolve(targetHomePath)) {
      throw new Error(`Bee ${record.name} is already on account ${account.id}`);
    }
    const sourceHomePath = current.homePath;
    // Claude's OAuth identity is bound into the provider session chain. A
    // cross-account resume can therefore keep charging the source account even
    // when every credential file belongs to the target. Re-key a transcript
    // copy instead; native same-id resume is only safe within one account.
    const rekeyClaudeThread = tool === "claude" && current.accountId !== account.id;
    if (rekeyClaudeThread && !current.providerSessionId) {
      throw new Error(`Bee ${current.name} has no recorded provider session id; refusing to switch Claude accounts without thread continuity`);
    }

    // 1. Ensure the process is stopped. The tmux session must be fully gone
    //    before we relaunch into the same target.
    if (await substrate.hasSession(current.tmuxTarget)) {
      const killResult = await substrate.kill(current.tmuxTarget, {
        launcherPgid: current.launcherPgid,
        launcherFingerprint: current.launcherFingerprint,
      });
      if (!killResult.ok) {
        throw new Error(`Could not stop ${record.name} before swap: ${killResult.stderr || killResult.stdout || `exit ${killResult.exitCode}`}`);
      }
    }
    let gone = false;
    for (let i = 0; i < pollAttempts; i += 1) {
      if (!(await substrate.hasSession(current.tmuxTarget).catch(() => true))) {
        gone = true;
        break;
      }
      if (pollIntervalMs > 0) await sleep(pollIntervalMs);
    }
    if (!gone) throw new Error(`Session ${current.tmuxTarget} still alive after kill; aborting swap`);

    // Resume ids are backed by home-local transcript files for Claude/Codex.
    // Claude cross-account moves must additionally mint a fresh id so its
    // account-bound provider chain cannot route back to the source identity.
    let launchProviderSessionId = current.providerSessionId;
    let relocatedTranscriptPath: string | undefined;
    if (rekeyClaudeThread) {
      const newSessionId = (options.newProviderSessionId ?? randomUUID)();
      const copied = await (options.copyThread ?? copyThreadForFork)({
        kind: tool,
        source: {
          cwd: current.cwd,
          providerSessionId: current.providerSessionId!,
          homePath: sourceHomePath,
        },
        destCwd: current.cwd,
        destHome: targetHomePath,
        newSessionId,
        anchor: { kind: "tip" },
      });
      launchProviderSessionId = copied.newProviderSessionId ?? newSessionId;
      relocatedTranscriptPath = copied.path;
    } else {
      relocatedTranscriptPath = await relocateSessionTranscript(current, sourceHomePath, targetHomePath);
    }

    // 2. Rescue the current account's freshest credentials from its source
    //    home, then activate the target in the target account's own home. The
    //    two paths deliberately differ during a real swap: changing credentials
    //    in the source home would break every other bee sharing that account.
    const rescueRegistry = current.accountId && accountRegistry.length === 0 ? await (options.listAccounts ?? listAccounts)() : accountRegistry;
    const currentAccount = current.accountId ? rescueRegistry.find((candidate) => candidate.id === current.accountId) : undefined;
    if (currentAccount && currentAccount.tool === tool && currentAccount.id !== account.id) {
      await syncAccountCredentialsToVault(currentAccount, sourceHomePath, { trustExtraHome: true }).catch(() => undefined);
    }
    let spec: ReturnType<typeof resolveAgent>;
    let paneId: string | undefined;
    let launcherPgid: number | undefined;
    let launcherFingerprint: ProcessBirthFingerprint | undefined;
    let runnerPid: number | undefined;
    let runnerFingerprint: ProcessBirthFingerprint | undefined;
    const incarnation = await nextRuntimeIncarnationPatch(current);
    try {
      await activate(account, targetHomePath);

      // 3. Resume the safely transplanted provider thread in the target
      //    account's home, with the driver's explicit identity env. The record's own model (a deliberate
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
      if (hsr && !launchProviderSessionId) {
        throw new Error(`Bee ${current.name} has no recorded provider session id; refusing to switch accounts without session continuity`);
      }
      const model = current.model ?? account.model;
      const modelExtra = current.modelExtraArgs ? splitShellWords(current.modelExtraArgs) : [];
      spec = resolveAgent(current.requestedAgent ?? current.agent, [...modelExtra, ...(hsr ? [] : resumeArgs(tool, launchProviderSessionId))], {
        home: targetHomePath,
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
          sessionId: launchProviderSessionId!,
          resume: true,
          authKind: "subscription",
          accountId: account.id,
          ...(model ? { model } : {}),
          spec: { command: spec.command, args: spec.args, env: spec.env },
        });
        runnerFingerprint = await captureProcessBirthFingerprint(runnerPid);
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
        launcherFingerprint = launch.launcherFingerprint;
      }
    } catch (error) {
      // Activation happens before relaunch. A normal swap uses a distinct
      // target home, so the source was never overwritten and needs no rollback.
      // Retain the old restoration only for a deliberately custom layout where
      // both accounts resolve to the same home.
      if (currentAccount && resolve(sourceHomePath) === resolve(targetHomePath)) {
        try {
          await activate(currentAccount, sourceHomePath);
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
      ...incarnation,
      accountId: account.id,
      homePath: targetHomePath,
      providerSessionId: launchProviderSessionId,
      ...(relocatedTranscriptPath ? { transcriptPath: relocatedTranscriptPath } : {}),
      command: shellCommand(spec),
      ...(paneId ? { agentPaneId: paneId } : {}),
      launcherPgid,
      launcherFingerprint,
      runnerPid,
      runnerFingerprint,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    await saveSessionLocked(updated);
    // The swap replaced the runtime: requests opened against the previous
    // generation are superseded (next to the nextRuntimeIncarnationPatch
    // application, per docs/INTERVENTION_REQUESTS.md; the daemon reconciler
    // backstops a missed call). Best-effort — never fail the swap over it.
    await closeRequestsForNewIncarnation(
      record.name,
      updated.runtimeGeneration ?? (current.runtimeGeneration ?? 0) + 1,
    ).catch(() => undefined);
    await appendLedger({
      type: "account.swap",
      session: record.name,
      from: record.accountId ?? null,
      to: account.id,
      fromHome: sourceHomePath,
      home: targetHomePath,
      fromProviderSessionId: current.providerSessionId ?? null,
      providerSessionId: launchProviderSessionId ?? null,
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
