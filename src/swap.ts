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
import { mintCellBrokerCapability } from "./cellBrokerCapability.js";
import { isWellFormedPaneId } from "./paneId.js";
import { assertAgentAuthFreshForSpawn, canonicalAgentKind, resolveAgent, shellCommand, splitShellWords } from "./agents.js";
import { resumeArgsForAgent } from "./drivers.js";
import { hsrCellPayloadFields, spawnHsrHost, waitForHsrHost, type HsrRunPayload } from "./hsr/runnerHost.js";
import { captureProcessBirthFingerprint, type ProcessBirthFingerprint } from "./hsr/processIdentity.js";
import { readHsrMetaStrict } from "./hsr/runDir.js";
import { mintEphemeralCredential } from "./hsr/remoteCreds.js";
import { stopHsrIncarnationByPid } from "./hsr/substrate.js";
import { withSessionLifecycleTransaction, type SessionLifecycleTransaction } from "./lifecycle.js";
import { closeRequestsForNewIncarnation } from "./requests/store.js";
import { appendLedger, type SessionRecord } from "./store.js";
import { substrateFor, type Substrate } from "./substrates/index.js";
import { stopRuntimeForReplacement } from "./substrates/stop.js";
import type { NewSessionResult } from "./substrates/types.js";
import { nextRuntimeIncarnationPatch } from "./seal.js";
import { isArchivedSessionLifecycle, isRunnableSessionRecord } from "./stateMachine.js";
import { copyThreadForFork } from "./threadCopy.js";
import {
  beginBeeReplacementOperation,
  type BeeNameLaunchReservation,
} from "./nameAdmission.js";
import {
  RemoteSpawnNotAdmittedError,
  RemoteSpawnIndeterminateError,
  type RemoteHsrSubstrate,
  type RemoteSpawnResult,
} from "./substrates/remote-hsr.js";
import { cleanupLaunchedRemoteHsrIncarnation } from "./launchPublication.js";

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
  /** Automatic callers may not resolve stop doubt or revive archived work. */
  authorization?: "operator" | "automatic";
  /** Account whose exhaustion authorized an automatic replacement. Rechecked
   * under the lifecycle lock so a newer explicit swap cannot inherit a stale
   * sampler decision. */
  automaticTriggerAccountId?: string;
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
  /** Strict local HSR birth reader (tests). */
  readHsrMeta?: typeof readHsrMetaStrict;
  /** Fault/crash injection after the launch locator is durably journaled. */
  afterLaunch?: (
    launch:
      | { kind: "tmux"; result: NewSessionResult }
      | { kind: "hsr"; hostPid: number }
      | { kind: "remote-hsr"; result: RemoteSpawnResult },
  ) => Promise<void>;
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

async function withSwapLaunchReservation(input: {
  lifecycle: SessionLifecycleTransaction;
  current: SessionRecord;
  incarnation: Partial<SessionRecord>;
  substrate: Substrate;
  localHsr: boolean;
  remoteHsr: boolean;
  spec: ReturnType<typeof resolveAgent>;
  tool: string;
  model?: string;
  account: AccountRecord;
  targetHomePath: string;
  launchProviderSessionId?: string;
  relocatedTranscriptPath?: string;
  remoteCredentials?: Awaited<ReturnType<typeof mintEphemeralCredential>>;
  options: SwapAccountOptions;
  reservation: BeeNameLaunchReservation;
}): Promise<SessionRecord> {
  const {
    lifecycle,
    current,
    incarnation,
    substrate,
    localHsr,
    remoteHsr,
    spec,
    tool,
    model,
    account,
    targetHomePath,
    launchProviderSessionId,
    relocatedTranscriptPath,
    remoteCredentials,
    options,
    reservation,
  } = input;
  let runnerPid: number | undefined;
  let runnerFingerprint: ProcessBirthFingerprint | undefined;
  let tmuxLaunch: NewSessionResult | undefined;
  let remoteResult: RemoteSpawnResult | undefined;
  const remoteLaunchId = remoteHsr ? randomUUID() : undefined;
  const brokerCapability = localHsr && current.executionRunId
    ? mintCellBrokerCapability(current.name, incarnation.runtimeGeneration as number)
    : undefined;

  const runtimePatch = (
    remoteLocator?: { launchId: string; incarnation?: string; cwd?: string },
  ): Partial<SessionRecord> => {
    if (remoteHsr) {
      const locator = remoteLocator ?? (remoteResult
        ? { launchId: remoteResult.launchId, incarnation: remoteResult.incarnation, cwd: remoteResult.cwd }
        : undefined);
      return {
        ...incarnation,
        substrate: undefined,
        runnerPid: undefined,
        runnerFingerprint: undefined,
        launcherPgid: undefined,
        launcherFingerprint: undefined,
        agentPaneId: undefined,
        node: current.node,
        ...(locator ? { remoteLaunchId: locator.launchId } : {}),
        ...(locator?.incarnation ? { remoteIncarnation: locator.incarnation } : {}),
        ...(locator?.cwd ? { cwd: locator.cwd } : {}),
      };
    }
    if (localHsr) {
      return {
        ...incarnation,
        substrate: "hsr",
        runnerPid,
        runnerFingerprint,
        agentPaneId: undefined,
        launcherPgid: undefined,
        launcherFingerprint: undefined,
        remoteLaunchId: undefined,
        remoteIncarnation: undefined,
        ...(brokerCapability ? { cellBrokerCapabilityHash: brokerCapability.hash } : {}),
      };
    }
    return {
      ...incarnation,
      substrate: undefined,
      runnerPid: undefined,
      runnerFingerprint: undefined,
      runnerTier: undefined,
      remoteLaunchId: undefined,
      remoteIncarnation: undefined,
      ...(tmuxLaunch?.paneId ? { agentPaneId: tmuxLaunch.paneId } : {}),
      ...(tmuxLaunch?.launcherPgid ? { launcherPgid: tmuxLaunch.launcherPgid } : {}),
      ...(tmuxLaunch?.launcherFingerprint ? { launcherFingerprint: tmuxLaunch.launcherFingerprint } : {}),
    };
  };

  const persistStopDoubt = async (
    detail: string,
    remoteLocator?: { launchId: string; incarnation?: string; cwd?: string },
  ): Promise<void> => {
    if (remoteHsr && remoteLocator) {
      await reservation.retainRemoteStopDoubt({
        node: current.node!,
        remoteLaunchId: remoteLocator.launchId,
        ...(remoteLocator.incarnation ? { remoteIncarnation: remoteLocator.incarnation } : {}),
      }, detail).catch(() => undefined);
    } else {
      await reservation.retainStopDoubt(detail).catch(() => undefined);
    }
    await lifecycle.commit({
      ...runtimePatch(remoteLocator),
      status: "kill_failed",
      lastError: `account swap launch cleanup unconfirmed: ${detail}`,
      updatedAt: new Date().toISOString(),
    }).catch(() => undefined);
  };

  const cleanup = async (cause: unknown): Promise<never> => {
    if (remoteHsr) {
      const incarnationToken = remoteResult?.incarnation
        ?? (cause instanceof RemoteSpawnIndeterminateError ? cause.incarnation : undefined);
      const locator = {
        launchId: remoteLaunchId!,
        ...(incarnationToken ? { incarnation: incarnationToken } : {}),
        ...(remoteResult?.cwd ? { cwd: remoteResult.cwd } : {}),
      };
      const proof = await cleanupLaunchedRemoteHsrIncarnation(
        substrate as RemoteHsrSubstrate,
        current.name,
        locator,
      );
      if (proof.stopped) await reservation.clearAfterConfirmedStop();
      else await persistStopDoubt(proof.detail, locator);
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `${message}; exact remote swap cleanup ${proof.stopped ? "confirmed" : `unconfirmed: ${proof.detail}`}`,
        { cause },
      );
    }
    if (runnerPid) {
      await cleanupHsrSwapLaunch(
        current.name,
        runnerPid,
        cause,
        (detail) => persistStopDoubt(detail),
      );
      await reservation.clearAfterConfirmedStop();
    } else if (tmuxLaunch) {
      await cleanupTmuxSwapLaunch(
        substrate,
        current.tmuxTarget,
        tmuxLaunch,
        cause,
        (detail) => persistStopDoubt(detail),
      );
      await reservation.clearAfterConfirmedStop();
    }
    throw cause;
  };

  try {
    if (remoteHsr) {
      try {
        await reservation.markRemoteLaunchDispatch({ node: current.node!, remoteLaunchId: remoteLaunchId! });
      } catch (error) {
        await reservation.clearAfterConfirmedStop().catch(() => undefined);
        throw error;
      }
      try {
        remoteResult = await (substrate as RemoteHsrSubstrate).spawnRemote({
          bee: current.name,
          launchId: remoteLaunchId,
          ...(current.remoteLaunchId ? { previousLaunchId: current.remoteLaunchId } : {}),
          kind: spec.kind,
          cwd: current.cwd,
          comb: current.combId ?? current.name,
          ...(current.parentId ? { parent: current.parentId } : {}),
          sessionId: launchProviderSessionId,
          resume: true,
          authKind: "subscription",
          ...(model ? { model } : {}),
          creds: {
            ...(remoteCredentials?.files.length ? { files: remoteCredentials.files } : {}),
            ...(remoteCredentials?.env ? { env: remoteCredentials.env } : {}),
          },
          spec: { command: spec.command, args: spec.args, env: spec.env },
        });
        await reservation.recordRemoteLaunch({
          node: current.node!,
          remoteLaunchId: remoteLaunchId!,
          remoteIncarnation: remoteResult.incarnation,
        });
        await options.afterLaunch?.({ kind: "remote-hsr", result: remoteResult });
      } catch (error) {
        if (error instanceof RemoteSpawnNotAdmittedError) {
          await reservation.clearAfterConfirmedStop();
          throw error;
        }
        return cleanup(error);
      }
    } else {
      try {
        await reservation.markLaunchDispatch();
      } catch (error) {
        await reservation.clearAfterConfirmedStop().catch(() => undefined);
        throw error;
      }
      if (localHsr) {
        try {
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
            ...hsrCellPayloadFields(current),
            ...(brokerCapability ? { cellBrokerCapability: brokerCapability.token } : {}),
            spec: { command: spec.command, args: spec.args, env: spec.env },
          });
          await reservation.recordHsrLaunch({ hostPid: runnerPid, childAdmission: "pending" });
          const meta = await (options.readHsrMeta ?? readHsrMetaStrict)(current.name);
          runnerFingerprint = meta?.hostPid === runnerPid ? meta.hostFingerprint : undefined;
          if (!runnerFingerprint || (meta?.childAdmission !== "admitted" && meta?.childAdmission !== "none")) {
            throw new Error("account swap HSR launch returned without complete process birth admission");
          }
          await reservation.recordHsrLaunch({
            hostPid: runnerPid,
            hostFingerprint: runnerFingerprint,
            childAdmission: meta.childAdmission,
          });
          if (!(await (options.waitForHsrHost ?? waitForHsrHost)(current.name, 5_000))) {
            console.error(`hsr host for ${current.name} did not report live within 5s; the daemon will reconcile`);
          }
          await options.afterLaunch?.({ kind: "hsr", hostPid: runnerPid });
        } catch (error) {
          return cleanup(error);
        }
      } else {
        try {
          tmuxLaunch = await substrate.newSession(current.tmuxTarget, current.cwd, {
            command: spec.command,
            args: spec.args,
            env: spec.env,
            tmuxOptions: spec.tmuxOptions,
          });
          await reservation.recordTmuxLaunch({
            substrate: substrate.kind === "ssh-tmux" ? "ssh-tmux" : "local-tmux",
            target: current.tmuxTarget,
            ...(substrate.kind === "ssh-tmux" ? { node: substrate.node } : {}),
            launch: tmuxLaunch,
          });
          if (!isWellFormedPaneId(tmuxLaunch.paneId)) {
            throw new Error(`account swap returned malformed tmux pane id: ${tmuxLaunch.paneId}`);
          }
          await options.afterLaunch?.({ kind: "tmux", result: tmuxLaunch });
        } catch (error) {
          return cleanup(error);
        }
      }
    }

    let published: SessionRecord;
    try {
      published = await lifecycle.commit({
        ...runtimePatch(),
        accountId: account.id,
        homePath: targetHomePath,
        providerSessionId: launchProviderSessionId,
        ...(relocatedTranscriptPath ? { transcriptPath: relocatedTranscriptPath } : {}),
        command: shellCommand(spec),
        ...(remoteCredentials?.expiresAt ? { remoteTokenExpiresAt: remoteCredentials.expiresAt } : {}),
        ...(remoteResult?.tier ? { runnerTier: remoteResult.tier } : {}),
        status: "running",
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return cleanup(error);
    }
    if (remoteHsr) await reservation.promoteExternallyPublished(published);
    else await reservation.promotePublished(published);
    return published;
  } catch (error) {
    throw error;
  }
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

  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    // 0. Re-validate under the lock before any side effects: a concurrent
    //    kill/clean may have deleted the record, and proceeding would respawn
    //    the session and resurrect the deleted bee.
    const current = await lifecycle.refresh();
    if (isArchivedSessionLifecycle(current)) {
      throw new Error(`Bee ${current.name} is archived; revive it explicitly before swapping accounts`);
    }
    if (options.authorization === "automatic") {
      if (!isRunnableSessionRecord(current)) {
        throw new Error(`Bee ${current.name} has unresolved stop state; automatic account swap is fenced`);
      }
      if (current.autoswap !== true) {
        throw new Error(`Bee ${current.name} no longer permits automatic account swap`);
      }
      const expectedAccountId = options.automaticTriggerAccountId ?? record.accountId;
      if (current.accountId !== expectedAccountId) {
        throw new Error(`Bee ${current.name} changed account before automatic swap admission`);
      }
    }
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

    // Fence all direct/queued work before the predecessor receives a stop
    // signal. The same attempt is carried through the successor publication.
    const replacement = await beginBeeReplacementOperation(lifecycle, "swap-account");

    // 1. Ensure both the exact persisted launcher group and tmux target are
    //    positively absent before credentials are activated or a replacement
    //    runtime is launched.
    await stopRuntimeForReplacement(current, substrate, current.tmuxTarget, {
      pollAttempts,
      pollIntervalMs,
      sleep,
      context: `Could not stop ${record.name} before swap`,
      onStopUnconfirmed: async (message) => {
        await replacement.noteFailure(`account swap stop unconfirmed: ${message}`).catch(() => undefined);
        await lifecycle.commit({
          status: "kill_failed",
          lastError: `account swap stop unconfirmed: ${message}`,
          updatedAt: new Date().toISOString(),
        });
      },
    });

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
      await syncAccountCredentialsToVault(currentAccount, sourceHomePath, {
        authorization: "automatic",
        trustExtraHome: true,
      }).catch(() => undefined);
    }
    const incarnation = await nextRuntimeIncarnationPatch(current);
    let updated: SessionRecord;
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
      const localHsr = current.substrate === "hsr";
      const remoteHsr = substrate.kind === "remote-hsr";
      const headless = localHsr || remoteHsr;
      if (headless && !launchProviderSessionId) {
        throw new Error(`Bee ${current.name} has no recorded provider session id; refusing to switch accounts without session continuity`);
      }
      const model = current.model ?? account.model;
      const modelExtra = current.modelExtraArgs ? splitShellWords(current.modelExtraArgs) : [];
      const spec = resolveAgent(current.requestedAgent ?? current.agent, [...modelExtra, ...(headless ? [] : resumeArgs(tool, launchProviderSessionId))], {
        home: targetHomePath,
        yolo: sniffYolo(current.command),
        identity: true,
        ...(model ? { model } : {}),
        ...(account.provider ? { provider: account.provider } : {}),
      });
      if (!current.node) await assertAgentAuthFreshForSpawn(spec, account.id);
      const remoteCredentials = remoteHsr ? await mintEphemeralCredential(account, tool) : undefined;
      updated = await withSwapLaunchReservation({
        lifecycle,
        current,
        incarnation,
        substrate,
        localHsr,
        remoteHsr,
        spec,
        tool,
        model,
        account,
        targetHomePath,
        launchProviderSessionId: launchProviderSessionId!,
        relocatedTranscriptPath,
        remoteCredentials,
        options,
        reservation: replacement,
      });
    } catch (error) {
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

async function cleanupHsrSwapLaunch(
  bee: string,
  hostPid: number,
  cause: unknown,
  onStopUnconfirmed?: (detail: string) => Promise<void>,
): Promise<void> {
  const stopped = await stopHsrIncarnationByPid(bee, hostPid);
  if (stopped.ok) return;
  const original = cause instanceof Error ? cause.message : String(cause);
  const detail = stopped.stderr || stopped.stdout || `exit ${stopped.exitCode}`;
  await onStopUnconfirmed?.(detail);
  throw new Error(`${original}; exact launched HSR swap cleanup failed: ${detail}`);
}

async function cleanupTmuxSwapLaunch(
  substrate: Substrate,
  target: string,
  launch: NewSessionResult,
  cause: unknown,
  onStopUnconfirmed?: (detail: string) => Promise<void>,
): Promise<void> {
  if (!substrate.killIncarnation) {
    const original = cause instanceof Error ? cause.message : String(cause);
    const detail = `substrate ${substrate.kind} cannot clean exact launched swap pane ${launch.paneId}`;
    await onStopUnconfirmed?.(detail);
    throw new Error(`${original}; ${detail}`);
  }
  const stopped = await substrate.killIncarnation(target, launch);
  if (stopped.ok) return;
  const original = cause instanceof Error ? cause.message : String(cause);
  const detail = stopped.stderr || stopped.stdout || launch.paneId;
  await onStopUnconfirmed?.(detail);
  throw new Error(`${original}; exact launched tmux swap cleanup failed: ${detail}`);
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
