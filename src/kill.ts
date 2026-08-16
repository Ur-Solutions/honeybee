import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { canonicalActivationHomePath, readActivationHomeOwner, withActivationHomeLock } from "./accounts/activation.js";
import { assertNoUnresolvedHsrAnswerReceiptsForBee } from "./answerReceipt.js";
import {
  assertNoCanonicalHsrEventIntegrityDoubt,
  assertNoUnresolvedHsrEventIntegrity,
} from "./hsr/eventIntegrity.js";
import { persistCanonicalDeliveryStopDoubt } from "./deliveryDoubt.js";
import {
  enqueueCredentialHarvestWorkItem,
  removeCredentialHarvestWorkItemForHome,
  type CredentialHarvestWorkItem,
} from "./accounts/credentialHarvestQueue.js";
import { removeHsrRunDirUnderEventAuthority } from "./hsr/runDir.js";
import { preservePendingHsrTurnReceiptsForPurge } from "./hsr/pendingTurns.js";
import {
  withSessionLifecycleLock,
  withSessionLifecycleTransaction,
  withSessionLifecycleTransactionIfPresent,
  type SessionLifecycleTransaction,
} from "./lifecycle.js";
import { sealsRoot } from "./seal.js";
import {
  appendLedger,
  deleteSessionLocked,
  isActiveSessionRecord,
  listSessions,
  loadSession,
  safeName,
  transitionSession,
  updateSession,
  withSessionLock,
  type SessionStopIntent,
  type SessionRecord,
} from "./store.js";
import { isArchivedSessionLifecycle, type ProbeEvidence } from "./stateMachine.js";
import { syncCredentialPairIsolated } from "./daemon/credentialSweepProcess.js";
import { LOCAL_NODE_NAME } from "./node.js";
import { clearPublishedBeeNameLaunchReservationForPurge } from "./nameAdmission.js";
import { dropPoolClaimsForBee } from "./pool.js";
import { stopFailedRequestId } from "./requests/keys.js";
import { cancelOpenRequests, openRequest, removeBeeRequests, resolveRequest } from "./requests/store.js";
import { substrateFor, type Substrate } from "./substrates/index.js";

export type TransactionalKillOptions = {
  /** Substrate to drive (default: substrateFor(record)). Injectable for tests. */
  substrate?: Substrate;
  /** Poll attempts to confirm session is gone after substrate.kill (default 4). */
  pollAttempts?: number;
  /** Delay between poll attempts in ms (default 750). */
  pollIntervalMs?: number;
  /** Sleep implementation (default setTimeout). Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Append a ledger event (default true). */
  emitLedger?: boolean;
  /** Injectable best-effort final credential harvest after runtime exit. */
  finalCredentialSync?: (record: SessionRecord) => Promise<void>;
  /** Hard outer budget for finalCredentialSync (default 10s). */
  finalCredentialSyncBudgetMs?: number;
  /** Deterministic crash-window hook after durable quarantine, before purge. */
  afterFinalCredentialQuarantine?: (item: CredentialHarvestWorkItem) => Promise<void>;
  /** Deterministic race-test hook after old-runtime teardown confirmation. */
  afterTeardown?: (record: SessionRecord) => Promise<void>;
  /** Deterministic crash-window hook after the irreversible stop dispatch. */
  afterStopDispatch?: (record: SessionRecord) => Promise<void>;
};

export type PurgeSessionDataOptions = Pick<
  TransactionalKillOptions,
  "emitLedger" | "finalCredentialSync" | "finalCredentialSyncBudgetMs" | "afterFinalCredentialQuarantine"
> & {
  /** Clean-sweep CAS guard: accepted mail may make a previously dead snapshot active. */
  preserveRecoveryRequest?: boolean;
  /** Clean-sweep CAS guard: filing may retire a stale candidate before purge wins the lock. */
  preserveArchived?: boolean;
  /** Clean-sweep CAS guard: an unconfirmed stop must retain its exact retry handle and artifacts. */
  preserveKillFailed?: boolean;
};

export type TransactionalCleanOptions = TransactionalKillOptions & {
  /** Stale clean snapshots must not erase a newly accepted recovery obligation. */
  preserveRecoveryRequest?: boolean;
  /** Filing which wins after clean selection owns the historical record. */
  preserveArchived?: boolean;
  /** Unconfirmed explicit stop retains its exact retry locator and artifacts. */
  preserveKillFailed?: boolean;
};

export type KillOutcome =
  | { ok: true; alreadyGone: boolean; attempts: number }
  | { ok: false; lastError: string; stillRunning: boolean; attempts: number };

const DEFAULT_POLL_ATTEMPTS = 4;
const DEFAULT_POLL_INTERVAL_MS = 750;
const STOP_INTENT_PENDING_ERROR = "explicit stop is in progress; exact runtime cleanup is not yet confirmed";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function explicitStopIntent(
  record: SessionRecord,
  action: SessionStopIntent["action"],
  now = new Date().toISOString(),
): SessionStopIntent {
  const generation = record.runtimeGeneration ?? 0;
  const existing = record.stopIntent?.version === 1 &&
    record.stopIntent.action === action &&
    record.stopIntent.generation === generation
    ? record.stopIntent
    : undefined;
  return {
    version: 1,
    action,
    generation,
    requestedAt: existing?.requestedAt ?? now,
    attempts: existing?.attempts ?? 0,
    ...(existing?.lastAttemptAt ? { lastAttemptAt: existing.lastAttemptAt } : {}),
    ...(existing?.nextAttemptAt ? { nextAttemptAt: existing.nextAttemptAt } : {}),
  };
}

async function eventIntegrityStopBlock(
  record: SessionRecord,
  operation: "session kill" | "session retire",
): Promise<string | undefined> {
  try {
    assertNoCanonicalHsrEventIntegrityDoubt(record, operation);
    await assertNoUnresolvedHsrEventIntegrity(record.name, operation);
    return undefined;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "HIVE_HSR_EVENT_INTEGRITY_UNRESOLVED") throw error;
    return errorMessage(error);
  }
}

type TeardownVerdict = {
  attempts: number;
  alreadyGone: boolean;
  killReturnedFailure: boolean;
  stillRunning: boolean;
  substrateKind: Substrate["kind"];
  lastError?: string;
};

/**
 * Explicit irreversible purge shared by `kill` and every clean mode. Artifact
 * stores are removed before the SessionRecord, so an interrupted purge keeps
 * the retry handle instead of leaving unaddressable seals/run data behind.
 * `deleteSession` remains the intentionally metadata-only low-level primitive.
 */
export async function purgeSessionData(
  record: SessionRecord,
  options: PurgeSessionDataOptions = {},
): Promise<boolean> {
  // Hardened readers intentionally reject a malformed embedded name, but
  // clean/purge must still be able to contain and remove its sanitized file
  // and artifacts. Such a record cannot participate in generation CAS (it is
  // not authoritative readable input), so serialize on the sanitized
  // lifecycle + session locks and retain the record-last retry semantics.
  if (safeName(record.name) !== record.name) {
    return withSessionLifecycleLock(record.name, async () => {
      if (options.preserveRecoveryRequest && record.recoveryRequestedAt) return false;
      if (options.preserveArchived && isArchivedSessionLifecycle(record)) return false;
      if (options.preserveKillFailed && record.status === "kill_failed") return false;
      await assertNoUnresolvedHsrAnswerReceiptsForBee(record.name, "session purge");
      assertNoCanonicalHsrEventIntegrityDoubt(record, "session purge");
      await assertNoUnresolvedHsrEventIntegrity(record.name, "session purge");
      await runFinalCredentialSync(record, options, "purge");
      if (record.deliveryStopDoubt) {
        await persistCanonicalDeliveryStopDoubt(record, record.deliveryStopDoubt);
      }
      await withSessionLock(record.name, async () => {
        await clearPublishedBeeNameLaunchReservationForPurge(record);
        if (record.substrate === "hsr") await preservePendingHsrTurnReceiptsForPurge(record.name);
        await rm(containedArtifactPath(sealsRoot(), record.name), { recursive: true, force: true });
        await removeHsrRunDirUnderEventAuthority(record.name);
        await removeBeeRequests(record.name);
        await deleteSessionLocked(record.name);
      });
      if (record.poolKey) await dropPoolClaimsForBee(record.poolKey, record.name).catch(() => undefined);
      return true;
    });
  }
  const purged = await withSessionLifecycleTransactionIfPresent(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    if (options.preserveRecoveryRequest && current.recoveryRequestedAt) return false;
    if (options.preserveArchived && isArchivedSessionLifecycle(current)) return false;
    if (options.preserveKillFailed && current.status === "kill_failed") return false;
    await purgeSessionDataInTransaction(lifecycle, options, current);
    return true;
  });
  return purged ?? true;
}

/**
 * Remove one generation after its caller has already proved that exact
 * runtime incarnation stopped. This is intentionally narrower than
 * transactionalKill: it performs no second, potentially ambiguous teardown,
 * but it retains the same lifecycle-generation CAS and clears the matching
 * name-admission residue before deleting the canonical SessionRecord.
 *
 * Callers MUST bind `record` to the exact stopped birth before invoking this
 * helper. A replacement generation is a LifecycleConflictError, never a
 * purge target.
 */
export async function purgeSessionAfterConfirmedRuntimeStop(
  record: SessionRecord,
  options: PurgeSessionDataOptions = {},
): Promise<boolean> {
  const purged = await withSessionLifecycleTransactionIfPresent(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    await purgeSessionAfterConfirmedRuntimeStopInTransaction(lifecycle, current, options);
    return true;
  });
  return purged ?? true;
}

/** Lifecycle-lock-owned form used by stop-intent -> signal -> purge protocols. */
export async function purgeSessionAfterConfirmedRuntimeStopInTransaction(
  lifecycle: SessionLifecycleTransaction,
  current: SessionRecord,
  options: PurgeSessionDataOptions = {},
): Promise<void> {
  await purgeSessionDataInTransaction(lifecycle, options, current, { runtimeStopConfirmed: true });
}

export type ConfirmedRuntimeRetireProof = {
  substrateKind: Substrate["kind"];
  attempts?: number;
  alreadyGone?: boolean;
  detail?: string;
};

/**
 * Archive an exact generation after a caller has already confirmed its
 * runtime stopped while holding the lifecycle transaction. This is the
 * control-RPC counterpart to transactionalRetire: no second signal is sent,
 * but credential recovery, reservation settlement, proof-carrying archive,
 * request closure, pool cleanup, and ledger publication remain identical.
 */
export async function retireSessionAfterConfirmedRuntimeStopInTransaction(
  lifecycle: SessionLifecycleTransaction,
  current: SessionRecord,
  proof: ConfirmedRuntimeRetireProof,
  options: TransactionalKillOptions = {},
): Promise<SessionRecord> {
  await lifecycle.refresh();
  await runFinalCredentialSync(current, options, "retire");
  await clearPublishedBeeNameLaunchReservationForPurge(current, {
    runtimeStopConfirmed: true,
  });
  const at = new Date().toISOString();
  const transitionKey = `retire:${current.name}:${current.runtimeGeneration ?? 0}:${at}`;
  const hsr = proof.substrateKind === "hsr" || proof.substrateKind === "remote-hsr";
  const probe: ProbeEvidence = {
    kind: "probe",
    probeId: `${transitionKey}:probe`,
    observerId: "hive-retire",
    observedAt: at,
    outcome: "dead",
    target: {
      substrate: hsr ? "hsr" : "local-tmux",
      ...(current.node ? { node: current.node } : {}),
      ...(hsr
        ? { ...(current.runnerPid ? { runnerPid: current.runnerPid } : {}) }
        : { tmuxTarget: current.tmuxTarget, ...(current.agentPaneId ? { agentPaneId: current.agentPaneId } : {}) }),
    },
    detail: proof.detail
      ?? (proof.alreadyGone
        ? "explicit retire verified the runtime was already absent"
        : `explicit retire verified runtime absence after ${proof.attempts ?? 1} teardown attempt(s)`),
  };
  const transitioned = await transitionSession(current.name, {
    eventId: transitionKey,
    at,
    type: "bee.archived",
    cause: "retire",
    evidence: { kind: "operator", actionId: transitionKey, observedAt: at, action: "retire" },
    probe,
  });
  if (!transitioned) throw new Error(`Session ${current.name} vanished before its retire transition`);
  const retired = await updateSession(current.name, {
    updatedAt: at,
    lastError: undefined,
    stopIntent: undefined,
  }) ?? transitioned.record;
  await resolveRequest(retired.name, stopFailedRequestId(retired.name, retired.runtimeGeneration ?? 0), { by: "stop-succeeded" }).catch(() => undefined);
  await cancelOpenRequests(retired.name, {}, "scope-closed", "retired").catch(() => undefined);
  if (retired.poolKey) await dropPoolClaimsForBee(retired.poolKey, retired.name).catch(() => undefined);
  if (options.emitLedger !== false) {
    await appendLedger({
      type: "session.retire",
      session: current.name,
      node: current.node ?? LOCAL_NODE_NAME,
      ok: true,
      attempts: proof.attempts ?? 1,
    });
  }
  return retired;
}

async function purgeSessionDataInTransaction(
  lifecycle: SessionLifecycleTransaction,
  options: PurgeSessionDataOptions,
  refreshedRecord?: SessionRecord,
  internal: { runtimeStopConfirmed?: boolean } = {},
): Promise<void> {
  const record = refreshedRecord ?? await lifecycle.refresh();
  // Answer receipts live outside hsrRoot. Preserve the canonical row (including
  // remote node/launch/incarnation locator) until operator reconciliation has
  // settled every provider-bound answer.
  await assertNoUnresolvedHsrAnswerReceiptsForBee(record.name, "session purge");
  assertNoCanonicalHsrEventIntegrityDoubt(record, "session purge");
  await assertNoUnresolvedHsrEventIntegrity(record.name, "session purge");
  // Credential harvest can touch the keychain, vault, and account locks. It is
  // deliberately bounded and completed before any artifact/session lock is
  // acquired or any retry handle is deleted.
  await runFinalCredentialSync(record, options, "purge");
  if (record.deliveryStopDoubt) {
    await persistCanonicalDeliveryStopDoubt(record, record.deliveryStopDoubt);
  }
  // The short record lock below is the destructive CAS point. Everything in
  // the callback is known not to re-acquire that lock; if cleanup is
  // interrupted, the canonical record remains the retry handle until the last
  // delete step.
  await lifecycle.destructiveCommit(async (current) => {
    await clearPublishedBeeNameLaunchReservationForPurge(current, internal);
    if (current.substrate === "hsr") await preservePendingHsrTurnReceiptsForPurge(current.name);
    await rm(containedArtifactPath(sealsRoot(), current.name), { recursive: true, force: true });
    await removeHsrRunDirUnderEventAuthority(current.name);
    await removeBeeRequests(current.name);
    await deleteSessionLocked(current.name);
  });
  if (record.poolKey) await dropPoolClaimsForBee(record.poolKey, record.name).catch(() => undefined);
}

/**
 * Session JSON is durable input and may be hand-edited or corrupted. Never let
 * its display name become a recursive-delete path: sanitize the leaf and then
 * prove the resolved target remains a strict child of the artifact root.
 */
function containedArtifactPath(root: string, bee: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, safeName(bee));
  if (!target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Refusing to purge artifact path outside ${resolvedRoot}`);
  }
  return target;
}

/**
 * Shared teardown core for kill and retire: substrate.kill -> poll
 * substrate.hasSession until the session is confirmed gone (or we give up).
 * Pure runtime work — the caller decides what happens to the SessionRecord.
 */
async function teardownSession(
  record: SessionRecord,
  options: TransactionalKillOptions,
): Promise<TeardownVerdict> {
  const substrate = options.substrate ?? substrateFor(record);
  const pollAttempts = Math.max(1, options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const sleep = options.sleep ?? defaultSleep;

  let attempts = 0;
  let killReturnedFailure = false;
  let killStderr: string | undefined;
  let exactIncarnationStopped = false;

  // Fast path: if the session is already gone, skip the substrate.kill call so
  // we report "alreadyGone" instead of swallowing an error from killing a
  // session that never existed.
  let alreadyGone = false;
  try {
    if (!(await substrate.hasSession(record.tmuxTarget))) alreadyGone = true;
  } catch {
    // Probe failures are non-fatal here; proceed to attempt kill.
  }

  // remote-hsr's kill RPC is also the remote cleanup hook: it shreds delivered
  // ephemeral credentials (APIA-93) and removes the remote run dir. A bee that
  // exited on its own still needs that, so the already-gone fast-path must not
  // skip the RPC there (it is idempotent on the remote).
  const needsRemoteCleanup = substrate.kind === "remote-hsr";
  const needsRemoteGroupProof = substrate.kind === "ssh-tmux";
  // Local HSR hasSession is host-authoritative: a crashed host reports false
  // while its detached harness child can remain live. Its kill implementation
  // is the strict incarnation/group cleanup hook and must always run.
  const needsLocalHsrCleanup = substrate.kind === "hsr";
  let stopDispatched = false;
  if (!alreadyGone || record.launcherPgid || needsRemoteCleanup || needsRemoteGroupProof || needsLocalHsrCleanup) {
    attempts += 1;
    stopDispatched = true;
    try {
      const killResult = await substrate.kill(record.tmuxTarget, {
        launcherPgid: record.launcherPgid,
        launcherFingerprint: record.launcherFingerprint,
        remoteLaunchId: record.remoteLaunchId,
        remoteIncarnation: record.remoteIncarnation,
      });
      exactIncarnationStopped = killResult.incarnationStopped === true;
      if (!killResult.ok) {
        killReturnedFailure = true;
        killStderr = killResult.stderr?.trim() || killResult.stdout?.trim() || `kill exited with code ${killResult.exitCode}`;
      }
    } catch (error) {
      killReturnedFailure = true;
      killStderr = errorMessage(error);
    }
  }

  // This hook is deliberately after the irreversible substrate call but
  // before any absence proof or terminal SessionRecord commit. Production has
  // no hook; fault tests use it to prove that a coordinator crash leaves the
  // pre-dispatch durable stop-intent fence authoritative.
  if (stopDispatched) await options.afterStopDispatch?.(record);

  // Poll hasSession a few times so substrates with eventually-consistent
  // teardown (ssh-tmux, slow tmux server) have a chance to settle.
  let stillRunning = false;
  let lastProbeError: string | undefined;
  for (let i = 0; !exactIncarnationStopped && i < pollAttempts; i += 1) {
    try {
      const exists = await substrate.hasSession(record.tmuxTarget);
      if (!exists) {
        stillRunning = false;
        lastProbeError = undefined;
        break;
      }
      stillRunning = true;
    } catch (error) {
      lastProbeError = errorMessage(error);
      stillRunning = true; // We can't confirm it's gone, so treat as still-running.
    }
    if (i < pollAttempts - 1 && pollIntervalMs > 0) await sleep(pollIntervalMs);
  }

  return {
    attempts,
    alreadyGone,
    killReturnedFailure,
    stillRunning,
    substrateKind: substrate.kind,
    ...(stillRunning || killReturnedFailure
      ? { lastError: lastProbeError ?? killStderr ?? "exact runtime cleanup is unconfirmed" }
      : {}),
  };
}

/**
 * Open the durable stop-failed manual-action request right after writing
 * status kill_failed (docs/INTERVENTION_REQUESTS.md): the recorded stop
 * intent is a fact, so the record is structured-grade even though the runtime
 * itself was only pane/pid-observed. Idempotent per generation; best-effort —
 * the kill outcome must be reported even when the request store misbehaves.
 */
async function openStopFailedRequest(record: SessionRecord, lastError: string): Promise<void> {
  const generation = record.runtimeGeneration ?? 0;
  await openRequest(record.name, {
    id: stopFailedRequestId(record.name, generation),
    kind: "manual-action",
    scope: "runtime-generation",
    grade: "structured",
    generation,
    question: `stop failed: ${lastError}`,
    evidence: { grade: "structured", source: "session-record", detail: "kill_failed" },
  }).catch(() => undefined);
}

/**
 * Harvest a runner home's last rotated credential after its process is
 * confirmed gone, before retire/purge makes the SessionRecord historical or
 * removes it. The record plus physical owner validation authorizes the home as
 * a locator; the isolated worker still requires provider content identity
 * before those bytes may enter the account vault.
 */
export async function syncSessionCredentialsOnExit(record: SessionRecord, timeoutMs?: number): Promise<void> {
  if (!record.accountId || !record.homePath) return;
  const outcome = await syncCredentialPairIsolated(record.accountId, record.homePath, { ...(timeoutMs ? { timeoutMs } : {}) });
  if (outcome.failedPairs > 0 || outcome.timedOutPairs > 0) throw new Error("final credential sync failed");
}

type CredentialBindingConflict = {
  accountId: string;
  reason: "home-rebound" | "activation-incomplete";
  session?: string;
  activationGeneration?: string;
};

function sessionBindingTime(record: SessionRecord): number {
  for (const value of [record.updatedAt, record.lastPromptAt, record.createdAt]) {
    const parsed = Date.parse(value ?? "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function conflictingHomeBinding(
  record: SessionRecord,
  canonicalHomePath: string,
): Promise<CredentialBindingConflict | null> {
  if (!record.accountId || !record.homePath) return null;
  const owner = await readActivationHomeOwner(canonicalHomePath);
  let bindingTime = sessionBindingTime(record);
  if (owner) {
    if (owner.state !== "ready") {
      return {
        accountId: owner.accountId,
        reason: "activation-incomplete",
        activationGeneration: owner.generation,
      };
    }
    if (owner.accountId !== record.accountId) {
      return { accountId: owner.accountId, reason: "home-rebound", activationGeneration: owner.generation };
    }
    bindingTime = Date.parse(owner.updatedAt);
    if (!Number.isFinite(bindingTime)) {
      return {
        accountId: owner.accountId,
        reason: "activation-incomplete",
        activationGeneration: owner.generation,
      };
    }
  }

  // Mixed-version writers do not update owner stamps. Even a matching ready
  // stamp must therefore yield to a live or newer foreign SessionRecord for
  // the same physical home. Without a stamp, the record itself is the legacy
  // ownership reference point.
  const candidates: SessionRecord[] = [];
  for (const candidate of await listSessions()) {
    if (
      candidate.name === record.name ||
      !candidate.accountId ||
      candidate.accountId === record.accountId ||
      !candidate.homePath ||
      (!isActiveSessionRecord(candidate) && sessionBindingTime(candidate) <= bindingTime)
    ) continue;
    if (await canonicalActivationHomePath(candidate.homePath) === canonicalHomePath) candidates.push(candidate);
  }
  candidates.sort((a, b) => {
    const live = Number(isActiveSessionRecord(b)) - Number(isActiveSessionRecord(a));
    if (live !== 0) return live;
    return sessionBindingTime(b) - sessionBindingTime(a);
  });
  const conflict = candidates[0];
  return conflict?.accountId
    ? { accountId: conflict.accountId, reason: "home-rebound", session: conflict.name }
    : null;
}

async function boundedCredentialSync(
  record: SessionRecord,
  sync: (record: SessionRecord) => Promise<void>,
  budgetMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sync(record),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`final credential sync timed out after ${budgetMs}ms`)), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type FinalCredentialSyncMode = "purge" | "retire";

async function quarantineFinalCredentialHarvest(
  record: SessionRecord,
  canonicalHomePath: string,
  owner: Awaited<ReturnType<typeof readActivationHomeOwner>>,
): Promise<CredentialHarvestWorkItem | null> {
  try {
    return await enqueueCredentialHarvestWorkItem(record, canonicalHomePath, owner);
  } catch (error) {
    // A stopped runtime cannot rotate a credential in a home that no longer
    // exists. There is no content-bearing locator to preserve in that case.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Perform the bounded post-exit harvest while the canonical home is fenced.
 * A destructive caller may proceed after failure only when either ownership
 * is positively foreign/stale (there is nothing safe to recover for this
 * account) or a secret-free recovery item was atomically persisted first.
 * Ambiguous validation/storage failures retain the SessionRecord by throwing.
 */
async function runFinalCredentialSync(
  record: SessionRecord,
  options: PurgeSessionDataOptions,
  mode: FinalCredentialSyncMode,
): Promise<void> {
  if (!record.accountId || !record.homePath) return;
  const budgetMs = options.finalCredentialSyncBudgetMs ?? 10_000;
  const startedAt = Date.now();
  const binding: { conflict: CredentialBindingConflict | null } = { conflict: null };
  let ok = false;
  let quarantined: CredentialHarvestWorkItem | null = null;
  let quarantineId: string | undefined;
  let recoveryUnnecessary = false;
  let operationError: unknown;
  try {
    // Every home, including a nominal per-account slot, is publicly
    // activatable through an explicit --home path. Activation and final
    // harvest therefore always take the same resolved-home lock and validate
    // its owner stamp before trusting bytes.
    await withActivationHomeLock(record.homePath, async (canonicalHomePath) => {
      binding.conflict = await conflictingHomeBinding(record, canonicalHomePath);
      const owner = await readActivationHomeOwner(canonicalHomePath);
      const recoverableIncompleteOwner = binding.conflict?.reason === "activation-incomplete"
        && owner?.accountId === record.accountId;
      if (binding.conflict && !recoverableIncompleteOwner) return;
      if (recoverableIncompleteOwner) {
        if (mode === "purge") {
          quarantined = await quarantineFinalCredentialHarvest(record, canonicalHomePath, owner);
          if (quarantined) {
            quarantineId = quarantined.id;
            await options.afterFinalCredentialQuarantine?.(quarantined);
          } else {
            recoveryUnnecessary = true;
          }
        }
        return;
      }
      const remainingMs = budgetMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new Error(`final credential sync timed out after ${budgetMs}ms`);
      const candidate = { ...record, homePath: canonicalHomePath };
      try {
        if (options.finalCredentialSync) {
          // Injectable tests/fallbacks are not assumed cancellable. Production
          // uses the disposable process below; a late injected settlement has
          // no queue capability and can never remove this generation's item.
          await boundedCredentialSync(candidate, options.finalCredentialSync, remainingMs);
        } else {
          // The inner deadline leaves time for birth-fenced TERM/KILL and lock
          // reaping before this activation-home lock is released.
          await syncSessionCredentialsOnExit(candidate, Math.max(1, remainingMs - 1_000));
        }
        ok = true;
        await removeCredentialHarvestWorkItemForHome(record.accountId!, canonicalHomePath);
      } catch {
        if (mode === "purge") {
          quarantined = await quarantineFinalCredentialHarvest(record, canonicalHomePath, owner);
          if (quarantined) {
            quarantineId = quarantined.id;
            await options.afterFinalCredentialQuarantine?.(quarantined);
          } else {
            recoveryUnnecessary = true;
          }
        }
      }
    }, { timeoutMs: Math.max(1, budgetMs) });
  } catch (error) {
    operationError = error;
  }
  if (options.emitLedger !== false) {
    const conflict = binding.conflict;
    await appendLedger({
      type: "account.final-sync",
      session: record.name,
      account: record.accountId,
      ok,
      ...(quarantineId ? { quarantined: true, quarantineId } : {}),
      ...(conflict ? {
        skipped: conflict.reason,
        ownerAccount: conflict.accountId,
        ...(conflict.session ? { ownerSession: conflict.session } : {}),
        ...(conflict.activationGeneration ? { ownerGeneration: conflict.activationGeneration } : {}),
      } : {}),
    }).catch(() => undefined);
  }
  if (mode === "purge" && operationError) {
    throw new Error(
      `final credential recovery could not be made durable; refusing to purge ${record.name}: ${errorMessage(operationError)}`,
    );
  }
  if (mode === "purge" && !ok && !binding.conflict && !quarantined && !recoveryUnnecessary) {
    throw new Error(`final credential recovery was unsuccessful; refusing to purge ${record.name} without a quarantine item`);
  }
}

/**
 * Transactional kill: substrate.kill -> poll substrate.hasSession -> only then
 * deleteSession. On failure (session still exists after polling, or its absence
 * cannot be confirmed), the SessionRecord is updated with status='kill_failed'
 * and lastError. The record is NOT deleted while the bee may still be running.
 *
 * DESTRUCTIVE: the SessionRecord is removed from the store, so the bee cannot
 * be revived afterwards. This is the GC half of the lifecycle (`hive kill`,
 * `hive clean`); the everyday way to end a bee is transactionalRetire, which
 * keeps the record.
 *
 * Returns a KillOutcome describing whether the bee is gone (ok=true) or still
 * suspected of running (ok=false), plus the captured lastError when applicable.
 */
export async function transactionalKill(
  record: SessionRecord,
  options: TransactionalKillOptions = {},
): Promise<KillOutcome> {
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    return transactionalKillInTransaction(lifecycle, current, options);
  });
}

async function transactionalKillInTransaction(
  lifecycle: SessionLifecycleTransaction,
  current: SessionRecord,
  options: TransactionalKillOptions,
): Promise<KillOutcome> {
  const emitLedger = options.emitLedger !== false;
  const node = current.node ?? LOCAL_NODE_NAME;
  // Persist explicit stop intent before the first signal/RPC. The lifecycle
  // lock is reclaimed when a process dies, so the lock alone cannot fence a
  // crash after dispatch. `kill_failed` is the canonical non-runnable stop-
  // doubt state; success below purges it, while any crash/error leaves an
  // exact locator that every work-admission path refuses.
  const stopping = await lifecycle.commit({
    status: "kill_failed",
    lastError: STOP_INTENT_PENDING_ERROR,
    stopIntent: explicitStopIntent(current, "kill"),
    updatedAt: new Date().toISOString(),
  });
  const verdict = await teardownSession(stopping, options);
  await options.afterTeardown?.(stopping);

  // Pane/session absence cannot override an indeterminate exact process-group
  // stop: an escaped child may have survived after tmux removed the target.
  if (verdict.stillRunning || verdict.killReturnedFailure) {
    const lastError = verdict.lastError ?? "exact runtime cleanup is unconfirmed";
    const failed = await lifecycle.commit({
      status: "kill_failed",
      lastError,
      stopIntent: explicitStopIntent(stopping, "kill"),
      updatedAt: new Date().toISOString(),
    });
    await openStopFailedRequest(failed, lastError);
    if (emitLedger) {
      await appendLedger({
        type: "session.kill",
        session: current.name,
        node,
        ok: false,
        attempts: verdict.attempts,
        lastError,
      });
    }
    return { ok: false, lastError, stillRunning: true, attempts: verdict.attempts };
  }

  // Process absence is not permission to erase unresolved provider-event
  // history. Normalize this manual fence into the same stable KillOutcome
  // contract as retire instead of letting the purge assertion escape as a raw
  // exception after the exact runtime has already stopped.
  const stopped = await lifecycle.refresh();
  const integrityBlock = await eventIntegrityStopBlock(stopped, "session kill");
  if (integrityBlock) {
    const lastError = integrityBlock;
    await lifecycle.commit({
      status: "kill_failed",
      lastError,
      stopIntent: {
        ...explicitStopIntent(stopped, "kill"),
        blockedReason: "event-integrity",
      },
      updatedAt: new Date().toISOString(),
    });
    if (emitLedger) {
      await appendLedger({
        type: "session.kill",
        session: current.name,
        node,
        ok: false,
        attempts: verdict.attempts,
        lastError,
      });
    }
    return { ok: false, lastError, stillRunning: false, attempts: verdict.attempts };
  }

  await purgeSessionDataInTransaction(lifecycle, options, undefined, { runtimeStopConfirmed: true });
  if (emitLedger) {
    await appendLedger({
      type: "session.kill",
      session: current.name,
      node,
      ok: true,
      attempts: verdict.attempts,
    });
  }
  return { ok: true, alreadyGone: verdict.alreadyGone && !verdict.killReturnedFailure, attempts: verdict.attempts };
}

/**
 * Clean a stale/dead candidate without turning coarse target absence into
 * process-exit proof. The preservation checks and strict teardown share one
 * lifecycle transaction: an accepted recovery request, archive, or stop-doubt
 * write that wins after candidate selection performs zero cleanup.
 *
 * `null` means one of those protected facts won. Otherwise the KillOutcome is
 * the same exact-stop result as an explicit `hive kill`.
 */
export async function transactionalCleanSession(
  record: SessionRecord,
  options: TransactionalCleanOptions = {},
): Promise<KillOutcome | null> {
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    if (options.preserveRecoveryRequest && current.recoveryRequestedAt) return null;
    if (options.preserveArchived && isArchivedSessionLifecycle(current)) return null;
    if (options.preserveKillFailed && current.status === "kill_failed") return null;
    return transactionalKillInTransaction(lifecycle, current, options);
  });
}

/**
 * Transactional retire: the everyday way to end a bee. Tears down the runtime
 * exactly like transactionalKill (substrate.kill -> poll hasSession), then
 * FILES the record (status='done') instead of deleting it — the bee
 * leaves the active list but its record, seals, ledger history, and provider
 * session stay intact, so `hive revive` can bring it back and `hive seals` /
 * `hive spend` keep working. Distinguishes deliberate retirement from a crash:
 * a record still 'running' whose session is gone was never retired, so state
 * derivation reports it 'crashed'.
 */
export async function transactionalRetire(
  record: SessionRecord,
  options: TransactionalKillOptions = {},
): Promise<KillOutcome> {
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    if (isArchivedSessionLifecycle(current)) {
      const existingIntegrityBlock = await eventIntegrityStopBlock(current, "session retire");
      if (existingIntegrityBlock) {
        return { ok: false, lastError: existingIntegrityBlock, stillRunning: false, attempts: 0 };
      }
      // A coordinator may have completed the proof-carrying archive transition
      // and died before removing a predecessor-only replacement journal. The
      // canonical archived cursor is durable exact-stop evidence, so heal that
      // residue here. Do not extend the proof to legacy scalar `done`: those
      // rows do not carry the transition/probe that makes cleanup conclusive.
      if (current.stateMachine?.lifecycle === "archived") {
        await clearPublishedBeeNameLaunchReservationForPurge(current, {
          runtimeStopConfirmed: true,
        });
      }
      if (current.stopIntent) {
        await updateSession(current.name, { stopIntent: undefined, updatedAt: new Date().toISOString() });
      }
      return { ok: true, alreadyGone: true, attempts: 0 };
    }
    const emitLedger = options.emitLedger !== false;
    const node = current.node ?? LOCAL_NODE_NAME;
    // See transactionalKill: the persistent stop-intent fence must precede
    // every irreversible local or remote teardown side effect.
    const stopping = await lifecycle.commit({
      status: "kill_failed",
      lastError: STOP_INTENT_PENDING_ERROR,
      stopIntent: explicitStopIntent(current, "retire"),
      updatedAt: new Date().toISOString(),
    });
    const verdict = await teardownSession(stopping, options);
    await options.afterTeardown?.(stopping);

    if (verdict.stillRunning || verdict.killReturnedFailure) {
      const lastError = verdict.lastError ?? "exact runtime cleanup is unconfirmed";
      const failed = await lifecycle.commit({
        status: "kill_failed",
        lastError,
        stopIntent: explicitStopIntent(stopping, "retire"),
        updatedAt: new Date().toISOString(),
      });
      await openStopFailedRequest(failed, lastError);
      if (emitLedger) {
        await appendLedger({
          type: "session.retire",
          session: current.name,
          node,
          ok: false,
          attempts: verdict.attempts,
          lastError,
        });
      }
      return { ok: false, lastError, stillRunning: true, attempts: verdict.attempts };
    }

    // Exact process absence does not prove that every provider event made it
    // into the durable HSR log. The host can discover that doubt while the
    // stop is in flight (or publish only the outside-run-dir head before its
    // canonical projection). Never turn either form into a successful archive:
    // automatic Flight/Comb/execution cleanup treats retire success as
    // ownership release and could otherwise start fresh work across an unknown
    // provider/tool effect.
    const stopped = await lifecycle.refresh();
    const integrityBlock = await eventIntegrityStopBlock(stopped, "session retire");
    if (integrityBlock) {
      const lastError = integrityBlock;
      await lifecycle.commit({
        status: "kill_failed",
        lastError,
        stopIntent: {
          ...explicitStopIntent(stopped, "retire"),
          blockedReason: "event-integrity",
        },
        updatedAt: new Date().toISOString(),
      });
      if (emitLedger) {
        await appendLedger({
          type: "session.retire",
          session: current.name,
          node,
          ok: false,
          attempts: verdict.attempts,
          lastError,
        });
      }
      return { ok: false, lastError, stillRunning: false, attempts: verdict.attempts };
    }

    await retireSessionAfterConfirmedRuntimeStopInTransaction(
      lifecycle,
      stopping,
      {
        substrateKind: verdict.substrateKind,
        attempts: verdict.attempts,
        alreadyGone: verdict.alreadyGone,
      },
      options,
    );
    return { ok: true, alreadyGone: verdict.alreadyGone && !verdict.killReturnedFailure, attempts: verdict.attempts };
  });
}

/**
 * Production cleanup adapter for schedulers that retain only a Bee name.
 * Archived rows still pass through transactionalRetire so its durable
 * ambiguity checks run; record absence is acceptable only when the
 * purge-surviving event-history authority is also absent.
 */
export async function retireSessionByNameExactly(
  beeName: string,
  operation = "automatic session retire",
): Promise<void> {
  const record = await loadSession(beeName);
  if (!record) {
    await assertNoUnresolvedHsrEventIntegrity(beeName, operation);
    return;
  }
  const outcome = await transactionalRetire(record);
  if (!outcome.ok) throw new Error(`${operation}: ${outcome.lastError}`);
}
