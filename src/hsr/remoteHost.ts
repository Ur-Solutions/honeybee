/**
 * HSR remote runner-host entry (APIA-90, Phase B) — the process that runs ON
 * THE REMOTE node. It is bundled by `buildRunnerHostBundle.ts` into a single
 * self-contained `.mjs` (no node_modules on the remote), deployed over ssh by
 * `hive node bootstrap`, and invoked there as:
 *
 *   node hive-runner-host-<version>.mjs --version          (the handshake target)
 *   node hive-runner-host-<version>.mjs serve --socket <p> (the control plane)
 *   node hive-runner-host-<version>.mjs connect --gateway <wss-url> \
 *     --cell-id <id> --token-env CELL_TOKEN                (cell mode: dial OUT
 *     to the Apiary Cloud gateway and serve the SAME controller over an
 *     outbound WebSocket — see gatewayConnect.ts)
 *
 * APIA-90 scope is a DEPLOYABLE, HANDSHAKEABLE artifact plus a minimal serve
 * surface (`ping` + `liveness`). The full spawn/observe/steer surface that
 * mirrors the daemon aggregate endpoint (src/daemon/hsrControl.ts) — spawn,
 * send, interrupt, answer, stop, snapshot, observe-relay — lands in APIA-91/92;
 * see the marker in the method map below.
 *
 * Runs on the REMOTE's own `~/.hive` (its storeRoot), so `liveness()` reflects
 * HSR bees hosted on that node. Node builtins + the local HSR modules only —
 * everything is inlined at bundle time.
 */

import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
// homeEnvForAgent maps a harness kind → its home env var (CODEX_HOME /
// CLAUDE_CONFIG_DIR / …). drivers.js is already in the runner-host bundle closure
// (via remoteCreds' homeDirForSpec) and imports NO accounts/vault graph, so this
// keeps the esbuild DCE lean.
import { homeEnvForAgent, identityEnvForAgent } from "../drivers.js";
import {
  connectRpcClient,
  startRpcServer,
  type RpcClient,
  type RpcMethodHandler,
  type RpcServer,
} from "./rpc.js";
import { connectToGateway } from "./gatewayConnect.js";
import {
  ensureOrphanedChildGroupStopped,
  proveHsrChildGroupAbsent,
  hsrLiveness,
  inspectHsrHostProcess,
  isAuthNeededMessage,
  pendingNeedsInput,
  readEventTail,
  structuredStateFromEvents,
  type HsrProcessSignalDependencies,
} from "./observe.js";
import {
  ackHsrEvents,
  discardHsrEventConsumer,
  hsrMetaPath,
  hsrRoot,
  hsrRunDir,
  readHsrSourceListProjectionStrict,
  markHsrConsumerSubscribedStrict,
  readHsrEventsPageAfterSeqStrict,
  readHsrLeastConsumerCursorStrict,
  readPendingHsrEventConsumers,
  removeHsrRunDirIfConsumersCaughtUp,
  removeHsrRunDirUnderEventAuthority,
  readHsrMeta,
  readHsrMetaStrict,
  readHsrRestart,
  hsrMetaProvesProviderNeverStarted,
  isHsrEventHistoryQuarantined,
  sealHsrEventStreamClosure,
  verifyHsrEventStreamClosure,
  writeHsrMeta,
  writeHsrRestart,
  HsrSourceEventLogBusyError,
  HsrEventReplayPageTokenError,
  type HsrMeta,
} from "./runDir.js";
import { sameProcessBirthFingerprint } from "./processIdentity.js";
import {
  deliverAndRecordCredentials,
  shredDeliveredCredentials,
  type DeliveredCredentialEraseResult,
} from "./remoteCreds.js";
import { runHsrHost, type HsrHostHandle } from "./host.js";
import { hsrSubstrate } from "./substrate.js";
import { readPendingHsrTurn, readPendingHsrTurns } from "./pendingTurns.js";
import {
  HsrSourceEventIntegrityError,
  acknowledgeHsrEventIntegrityLoss,
  assertHsrSourceEventLogIntegrity,
  assertNoUnresolvedHsrEventIntegrity,
  hsrEventIntegrityReceiptOwnsHost,
  persistHsrEventIntegrityFailure,
  readHsrEventIntegrityReceipt,
  recordHsrEventIntegrityDeliveryVerdict,
  recordHsrEventIntegrityStop,
  type HsrEventIntegrityReceipt,
} from "./eventIntegrity.js";
// In-cell bee spawn: the cloud Cell is this single bundle (no dedicated
// runner-entry sibling on disk), so runnerHost re-execs THIS bundle as
// `node <bundle> __hsr-run <payloadPath>`. main() dispatches that here — and
// runner-entry's own dedicated-sibling guard stands down inside the bundle — so
// this is the sole entrypoint into the bee host. Imported straight from
// runner-entry.js (already in the bundle closure) to avoid pulling the
// substrate/observe graph that runnerHost.js would add.
import { runHsrHostFromPayload } from "./runner-entry.js";
import {
  readStagedRunnerHostArtifactSync,
  runnerHostArtifactDigest,
  runnerHostHandshakeVersion,
  runnerHostVersionForDigest,
} from "./runnerHostArtifact.js";
import { adapterFor } from "./adapters/index.js";
import { harnessSupportsRemoteHsr } from "./harness.js";
import { withSessionLifecycleLock } from "../lifecycle.js";
import { safeName } from "../store.js";
import {
  HsrAnswerConflictError,
  markHsrAnswerOperationSending,
  offerHsrAnswerOperation,
  parseHsrAnswerHostCapabilities,
  parseHsrAnswerRpcParams,
  parseHsrAnswerRpcResult,
  readHsrAnswerReceipt,
  readHsrAnswerReceipts,
  reconcileHsrAnswerOperation,
  type HsrAnswerOperation,
  type HsrAnswerReceipt,
  type HsrAnswerReconciliationVerdict,
  type HsrAnswerRpcResult,
} from "../answerReceipt.js";
import { normalizeCreds } from "./credsParams.js";
import { provisionCheckout, enumerateCheckouts, type ProvisionParams } from "./provisioning.js";
import type { RunnerEvent, RunnerOpts, RunnerTier } from "./types.js";
import {
  REMOTE_HSR_SAFETY_PROTOCOL,
  readRemoteHsrLaunchCancellationStrict,
  listRemoteHsrLaunchReceiptsStrict,
  readRemoteHsrLaunchHistoryStrict,
  readRemoteHsrLaunchReceiptStrict,
  remoteHsrRunDirExistsStrict,
  writeRemoteHsrLaunchCancellation,
  writeRemoteHsrLaunchReceipt,
  type RemoteHsrHostIdentity,
  type RemoteHsrLaunchReceipt,
} from "./remoteLaunchReceipt.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

function remoteSpawnRequestDigest(params: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(params))).digest("hex");
}

function answerResultForReceipt(
  receipt: HsrAnswerReceipt,
  dispatchingReason: string,
): HsrAnswerRpcResult | null {
  switch (receipt.phase) {
    case "settled":
      return { status: "settled", replayed: true, ...(receipt.host ? { host: receipt.host } : {}) };
    case "ambiguous":
      return {
        status: "ambiguous",
        reason: receipt.reason ?? dispatchingReason,
        ...(receipt.host ? { host: receipt.host } : {}),
      };
    case "discarded":
      return { status: "discarded" };
    case "sending":
    case "dispatching":
      return {
        status: "ambiguous",
        reason: dispatchingReason,
        ...(receipt.host ? { host: receipt.host } : {}),
      };
    case "offered":
      return null;
  }
}

async function unresolvedAnswerOwnership(bee: string): Promise<HsrAnswerReceipt | null> {
  return (await readHsrAnswerReceipts(bee)).find(
    (receipt) => receipt.phase === "sending" || receipt.phase === "dispatching" || receipt.phase === "ambiguous",
  ) ?? null;
}

function sameAnswerOperation(left: HsrAnswerOperation, right: HsrAnswerOperation): boolean {
  return left.requestId === right.requestId
    && left.answerDigest === right.answerDigest
    && left.source.createdAt === right.source.createdAt
    && left.source.runtimeGeneration === right.source.runtimeGeneration
    && left.source.id === right.source.id
    && left.source.uuid === right.source.uuid
    && left.source.node === right.source.node
    && left.source.remoteLaunchId === right.source.remoteLaunchId
    && left.source.remoteIncarnation === right.source.remoteIncarnation
    && left.host.hostPid === right.host.hostPid
    && left.host.startedAt === right.host.startedAt
    && sameProcessBirthFingerprint(left.host.hostFingerprint, right.host.hostFingerprint);
}

async function assertNoUnresolvedRemoteAnswerOwnership(bee: string, operation: string): Promise<void> {
  const unresolved = await unresolvedAnswerOwnership(bee);
  if (!unresolved) return;
  throw new Error(
    `${operation}: ${bee} has unresolved provider-answer ownership for request ${unresolved.operation.requestId}; `
    + "reconcile that exact answer before admitting new work",
  );
}

function requireRemoteBeeName(raw: unknown): string {
  const bee = String(raw ?? "");
  if (!bee) throw new Error("bee required");
  if (bee !== safeName(bee)) throw new Error("bee must be a canonical Honeybee name");
  return bee;
}

function requireLaunchId(raw: unknown): string {
  const launchId = typeof raw === "string" ? raw : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(launchId)) {
    throw new Error("launchId must be a UUID");
  }
  return launchId;
}

/** Secret-free policy failure used by both the RPC path and hermetic tests. */
export function remoteHarnessPolicyError(kind: string): string | undefined {
  return harnessSupportsRemoteHsr(kind)
    ? undefined
    : `${kind} HSR is local-only: remote credential delivery is not implemented or tested`;
}

/**
 * Resolve a remote-hsr spawn's working dir. The remote runner-host OWNS its
 * filesystem layout: a client only ships a cwd when it is already a real REMOTE
 * path (a provisioned checkout, APIA-95) — otherwise a local `/Users/…` path
 * would not exist here and Node's `spawn()` throws ENOENT. When none is given we
 * DERIVE a per-bee dir under this node's own store (`<storeRoot>/hsr/<bee>/cwd`),
 * nested under the run dir so `kill`'s run-dir removal reclaims it. `derived`
 * flags whether the caller must mkdir it.
 */
export function resolveRemoteSpawnCwd(bee: string, cwd: unknown): { cwd: string; derived: boolean } {
  const derivedCwd = join(hsrRunDir(bee), "cwd");
  if (typeof cwd === "string" && cwd) {
    if (!isAbsolute(cwd)) throw new Error(`remote HSR cwd for ${bee} must be absolute`);
    // The authority persists its derived cwd in the controller-side record.
    // A later replacement sends that absolute path back after exact teardown
    // removed the run dir. Recognize the authority's own canonical path so it
    // is recreated; arbitrary/provisioned remote paths remain caller-owned.
    if (resolve(cwd) === resolve(derivedCwd)) return { cwd: derivedCwd, derived: true };
    return { cwd, derived: false };
  }
  return { cwd: derivedCwd, derived: true };
}

/**
 * Resolve the isolated home + its harness env for a credential-delivering
 * remote-hsr spawn. The remote DERIVES the home under its own store
 * (`<storeRoot>/hsr/<bee>/home`) — a local home path shipped from the client is
 * meaningless here (the vault stays local; only the ephemeral material crosses).
 * An explicit REMOTE `home` is honored as-is. `homeEnv` is the harness's home
 * env var (CODEX_HOME / CLAUDE_CONFIG_DIR / …) the child must read the delivered
 * auth from; undefined for a harness with no home env (e.g. the test stub).
 */
export function resolveRemoteSpawnHome(bee: string, kind: string, home: unknown): { homeDir: string; homeEnv: string | undefined } {
  const homeDir = (typeof home === "string" && home) ? home : join(hsrRunDir(bee), "home");
  return { homeDir, homeEnv: homeEnvForAgent(kind) };
}

// The staged bundle computes its own exact-byte digest at startup. Build-time
// defines select that branch and freeze only the package version; no digest is
// injected (which would make the digest self-referential), and no remote git
// checkout is consulted. Unbundled development runs report the adjacent staged
// artifact when present so node-health compares against what bootstrap deploys.
declare const __HIVE_RUNNER_HOST_CONTENT_ADDRESSABLE__: boolean;
declare const __HIVE_RUNNER_HOST_PACKAGE_VERSION__: string;
const PKG_VERSION = "0.0.1";

function bundledPackageVersion(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (
    typeof __HIVE_RUNNER_HOST_CONTENT_ADDRESSABLE__ !== "undefined"
    && __HIVE_RUNNER_HOST_CONTENT_ADDRESSABLE__
    && typeof __HIVE_RUNNER_HOST_PACKAGE_VERSION__ !== "undefined"
    && __HIVE_RUNNER_HOST_PACKAGE_VERSION__
  ) {
    return __HIVE_RUNNER_HOST_PACKAGE_VERSION__;
  }
  return undefined;
}

/** `<pkgVersion>+sha256.<exact artifact digest>` for every deployed bundle. */
export function versionCore(): string {
  const packageVersion = bundledPackageVersion();
  if (packageVersion) {
    const bytes = readFileSync(fileURLToPath(import.meta.url));
    return runnerHostVersionForDigest(packageVersion, runnerHostArtifactDigest(bytes));
  }
  try {
    return readStagedRunnerHostArtifactSync().version;
  } catch {
    return `${PKG_VERSION}+development`;
  }
}

/** The full handshake string printed by `--version` and returned by `ping`. */
export function versionString(): string {
  return `runner-host ${versionCore()}`;
}

/**
 * The runner-host control-plane controller (APIA-92). Mirrors the daemon
 * aggregate endpoint (src/daemon/hsrControl.ts) — liveness/list/send/interrupt/
 * answer/stop/snapshot/observe-relay over THIS node's own run dirs + per-bee
 * control sockets — PLUS a `spawn` that forks a runner host IN-PROCESS on the
 * remote (the `hive __hsr-run` payload path, invoked here rather than shelled),
 * and a `kill` that stops a runner and removes its run dir.
 *
 * `attachServer` is called once the RpcServer exists so `observe` can broadcast
 * relayed `hsr.event` notifications; handlers run strictly after that, so the
 * late-bound reference is always defined by call time.
 */
export type RunnerHostController = {
  methods: Record<string, RpcMethodHandler>;
  attachServer(server: RpcServer): void;
  /** Fence new RPC admission before the transport drops existing clients. */
  beginClose(): void;
  close(): Promise<void>;
};

export type RunnerHostControllerOptions = {
  processSignals?: HsrProcessSignalDependencies;
  /** Injectable in-process host start for strict controller lifecycle tests. */
  runHost?: typeof runHsrHost;
  /** Injectable strict credential erasure boundary. */
  shredCredentials?: (bee: string) => Promise<void | DeliveredCredentialEraseResult | { ok: boolean; error?: string }>;
  /** CLI serve hook: invoked only after a prepared upgrade closes its socket. */
  onServeShutdown?: () => void;
};

type HsrListEventProjection = {
  stateEvents: RunnerEvent[];
  usage: {
    totals: { inputTokens: number; outputTokens: number } | null;
    latestExhausted?: { ts: number; resetHint?: string };
  };
};

function eventMatchesHost(event: RunnerEvent, expected: RemoteHsrHostIdentity): boolean {
  const host = event.host;
  return !!host
    && host.hostPid === expected.hostPid
    && host.startedAt === expected.startedAt
    && sameProcessBirthFingerprint(host.hostFingerprint, expected.hostFingerprint);
}

/**
 * Exact current-host list projection over an arbitrarily large retained log.
 * The runDir reader validates/streams every record under source authority; this
 * fold keeps only the last fact for each state relation plus numeric usage
 * totals. Its memory use therefore does not grow with a disconnected mirror's
 * durable backlog.
 */
async function readHsrListEventProjection(
  bee: string,
  expectedHost: RemoteHsrHostIdentity,
  rootThreadId?: string,
): Promise<HsrListEventProjection> {
  return readHsrSourceListProjectionStrict(bee, expectedHost, rootThreadId);
}

export function buildController(options: RunnerHostControllerOptions = {}): RunnerHostController {
  const version = versionString();
  const processSignals = options.processSignals ?? {};
  const runHost = options.runHost ?? runHsrHost;
  const shredCredentials = options.shredCredentials ?? shredDeliveredCredentials;

  async function eraseCredentialsStrict(bee: string): Promise<void> {
    const result = await shredCredentials(bee);
    if (result && !result.ok) {
      const detail = "code" in result ? result.code : result.error;
      throw new Error(detail ? `credential erasure unconfirmed for ${bee} (${detail})` : `credential erasure unconfirmed for ${bee}`);
    }
  }

  // Live event relays, one cached client per observed bee (ref-counted across
  // subscribers) — mirrors hsrControl.ts. server is assigned by attachServer.
  type Relay = {
    client?: RpcClient;
    /** Per durable controller; reconnect sync replaces only its own count. */
    consumers: Map<string, number>;
    unsubscribe?: () => void;
    launchId?: string;
    incarnation?: string;
  };
  const relays = new Map<string, Relay>();
  // In-process runner hosts we spawned, so `kill` can stop them cleanly.
  const handles = new Map<string, HsrHostHandle>();
  // Birth identity captured when each handle was admitted. A handle keyed only
  // by bee name is not enough after same-name replacement or hostile meta drift.
  const handleHosts = new Map<string, RemoteHsrHostIdentity>();
  // Bees currently mid-refresh (UNIT 2), so a re-entrant refreshCreds is refused
  // rather than racing a second stop→re-deliver→restart against the first.
  const refreshing = new Set<string>();
  let server: RpcServer | undefined;
  let closing = false;
  let inFlight = 0;
  const drainWaiters = new Set<() => void>();
  let closeOperation: Promise<void> | undefined;
  let closeSettled = false;
  let preparedUpgrade: { replacementVersion: string; token: string } | undefined;
  let preparingUpgrade = false;
  let upgradeCommitScheduled = false;
  let shutdownRequested = false;

  function beginClose(): void {
    shutdownRequested = true;
    closing = true;
  }

  async function waitForRpcDrain(): Promise<void> {
    if (inFlight === 0) return;
    await new Promise<void>((resolve) => drainWaiters.add(resolve));
  }

  function finishRpc(): void {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }

  /**
   * Connect a bee's control socket, invoke one method, and close. Returns
   * `{ ok:true, result }` or `{ ok:false, error }`; never throws.
   */
  async function proxyCall(bee: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!bee) return { ok: false, error: "bee required" };
    const meta = await readHsrMeta(bee);
    if (!meta || meta.status !== "running" || !meta.controlSocket) {
      return { ok: false, error: `no live host for ${bee}` };
    }
    let client: RpcClient;
    try {
      client = await connectRpcClient(meta.controlSocket);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    try {
      const result = await client.call(method, params);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    } finally {
      client.close();
    }
  }

  /** Wrap a handler so it can never throw out to the transport. */
  function guarded(
    fn: (params: unknown) => Promise<unknown>,
    closingResult: unknown = { ok: false, error: "runner-host is closing" },
  ): RpcMethodHandler {
    return async (params) => {
      if (closing) return closingResult;
      inFlight += 1;
      try {
        return await fn(params);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      } finally {
        finishRpc();
      }
    };
  }

  const sameHostIncarnation = (left: HsrMeta, right: HsrMeta | null): boolean =>
    !!right && left.hostPid === right.hostPid && left.startedAt === right.startedAt &&
    sameProcessBirthFingerprint(left.hostFingerprint, right.hostFingerprint);

  type RemoteIncarnationLocator = { launchId?: string; incarnation?: string };

  function locatorFromParams(params: Record<string, unknown>): RemoteIncarnationLocator {
    return {
      ...(typeof params.launchId === "string" && params.launchId ? { launchId: params.launchId } : {}),
      ...(typeof params.incarnation === "string" && params.incarnation ? { incarnation: params.incarnation } : {}),
    };
  }

  function consumerIdFromParams(params: Record<string, unknown>): string {
    if (typeof params.consumerId !== "string" || params.consumerId.length === 0 || params.consumerId.length > 256) {
      throw new Error("consumerId must be a non-empty string of at most 256 bytes");
    }
    return params.consumerId;
  }

  function receiptHostIdentity(meta: HsrMeta): RemoteHsrHostIdentity {
    if (!meta.hostFingerprint) {
      throw new Error(`remote HSR host ${meta.bee} has no birth fingerprint`);
    }
    return {
      hostPid: meta.hostPid,
      startedAt: meta.startedAt,
      hostFingerprint: meta.hostFingerprint,
    };
  }

  function receiptHostMatchesMeta(receipt: RemoteHsrLaunchReceipt, meta: HsrMeta | null): boolean {
    return !!receipt.host && !!meta
      && receipt.host.hostPid === meta.hostPid
      && receipt.host.startedAt === meta.startedAt
      && sameProcessBirthFingerprint(receipt.host.hostFingerprint, meta.hostFingerprint);
  }

  function hostIdentityMatchesMeta(host: RemoteHsrHostIdentity, meta: HsrMeta): boolean {
    return host.hostPid === meta.hostPid
      && host.startedAt === meta.startedAt
      && sameProcessBirthFingerprint(host.hostFingerprint, meta.hostFingerprint);
  }

  async function admittedHostIsLive(bee: string, meta: HsrMeta): Promise<boolean> {
    const locallyOwned = handleHosts.get(bee);
    if (locallyOwned && hostIdentityMatchesMeta(locallyOwned, meta)) return true;
    return (await inspectHsrHostProcess(meta, processSignals)) === "match";
  }

  /**
   * Bind a pre-launch reservation to the admitted host birth. The only allowed
   * rebind is an explicitly journaled credential refresh; ordinary running
   * receipts fail closed on a different meta incarnation.
   */
  async function reconcileReceiptHost(
    receipt: RemoteHsrLaunchReceipt,
    suppliedMeta?: HsrMeta | null,
  ): Promise<RemoteHsrLaunchReceipt> {
    if (receipt.state === "stopped") {
      throw new Error(`remote HSR launch ${receipt.launchId} is already stopped`);
    }
    if (receipt.state === "stopping") {
      throw new Error(`remote HSR launch ${receipt.launchId} is stopping`);
    }
    const meta = suppliedMeta === undefined ? await readHsrMetaStrict(receipt.bee) : suppliedMeta;
    if (!meta) throw new Error(`remote HSR launch ${receipt.launchId} has no host metadata`);
    if (meta.status !== "running") {
      throw new Error(`remote HSR launch ${receipt.launchId} is not running`);
    }
    if (!(await admittedHostIsLive(receipt.bee, meta))) {
      throw new Error(`remote HSR launch ${receipt.launchId} has running metadata but host liveness is unconfirmed`);
    }
    if (receiptHostMatchesMeta(receipt, meta)) {
      if (receipt.state === "running") return receipt;
      const { refreshPhase: _refreshPhase, refreshSourceHost: _refreshSourceHost, ...settled } = receipt;
      const updated: RemoteHsrLaunchReceipt = { ...settled, state: "running" };
      await writeRemoteHsrLaunchReceipt(updated);
      return updated;
    }
    if (receipt.host && !(receipt.state === "refreshing" && receipt.refreshPhase === "dispatching")) {
      throw new Error(`remote HSR receipt for ${receipt.bee} does not own the current host incarnation`);
    }
    const {
      refreshPhase: _refreshPhase,
      refreshSourceHost: _refreshSourceHost,
      terminalConsumerActivations: _terminalConsumerActivations,
      ...settled
    } = receipt;
    const updated: RemoteHsrLaunchReceipt = {
      ...settled,
      state: "running",
      host: receiptHostIdentity(meta),
    };
    await writeRemoteHsrLaunchReceipt(updated);
    return updated;
  }

  function launchResult(receipt: RemoteHsrLaunchReceipt): Record<string, unknown> {
    return {
      ok: true,
      safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL,
      bee: receipt.bee,
      launchId: receipt.launchId,
      incarnation: receipt.incarnation,
      tier: receipt.tier,
      cwd: receipt.cwd,
      ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
    };
  }

  function eventIntegrityListRow(
    bee: string,
    authority: RemoteHsrLaunchReceipt | undefined,
    receipt: HsrEventIntegrityReceipt | null,
  ): Record<string, unknown> | null {
    if (receipt?.phase !== "unresolved") return null;
    const remoteAuthorityMatches = !!authority
      && receipt.remoteAuthority?.launchId === authority.launchId
      && receipt.remoteAuthority?.incarnation === authority.incarnation;
    if (
      !remoteAuthorityMatches
      || (authority.host && !hsrEventIntegrityReceiptOwnsHost(
          receipt,
          authority.host,
          { launchId: authority.launchId, incarnation: authority.incarnation },
        ))
    ) {
      throw new Error(`HSR event-integrity receipt for ${bee} does not match its launch authority`);
    }
    return {
      bee,
      live: false,
      state: null,
      tier: authority.tier ?? null,
      sessionId: authority.sessionId ?? null,
      status: "event_integrity",
      controlSocket: null,
      launchId: authority.launchId,
      incarnation: authority.incarnation,
      eventIntegrityFailure: receipt.reason,
      eventIntegrityId: receipt.integrityId,
      eventIntegrityStopState: receipt.stopState,
      eventIntegrityReceipt: receipt,
    };
  }

  async function settledEventIntegrityListRow(
    bee: string,
    authority: RemoteHsrLaunchReceipt | undefined,
    receipt: HsrEventIntegrityReceipt | null,
  ): Promise<Record<string, unknown> | null> {
    let row = eventIntegrityListRow(bee, authority, receipt);
    if (!row || !authority || !receipt || receipt.stopState === "confirmed") return row;
    // Idle/list discovery is also the node's autonomous source-loss stop
    // boundary. Preserve the receipt even when strict teardown is uncertain;
    // promote confirmed only after stopRunner proves the exact host and child
    // group are gone.
    if (await stopRunner(bee).catch(() => false)) {
      await recordHsrEventIntegrityStop(
        bee,
        receipt.integrityId,
        receipt.host,
        "confirmed",
        "remote idle observer exact-stopped the source host and child group",
      );
      receipt = await readHsrEventIntegrityReceipt(bee);
      row = eventIntegrityListRow(bee, authority, receipt);
    }
    return row;
  }

  async function authorizeCurrentIncarnation(
    bee: string,
    locator: RemoteIncarnationLocator,
    options: { allowLegacy: boolean; allowLaunchIdOnly?: boolean; allowRefreshing?: boolean },
  ): Promise<{ receipt: RemoteHsrLaunchReceipt | null; meta: HsrMeta | null }> {
    const receipt = await readRemoteHsrLaunchReceiptStrict(bee);
    if (!receipt) {
      if (locator.launchId || locator.incarnation) {
        throw new Error(`remote HSR launch receipt for ${bee} is absent`);
      }
      if (!options.allowLegacy) throw new Error(`remote HSR incarnation token required for ${bee}`);
      return { receipt: null, meta: await readHsrMetaStrict(bee) };
    }
    if (!locator.launchId || locator.launchId !== receipt.launchId) {
      throw new Error(`remote HSR launch id does not own ${bee}`);
    }
    if (!options.allowLaunchIdOnly && !locator.incarnation) {
      throw new Error(`remote HSR incarnation token required for ${bee}`);
    }
    if (locator.incarnation && locator.incarnation !== receipt.incarnation) {
      throw new Error(`remote HSR incarnation token does not own ${bee}`);
    }
    if (receipt.state === "stopped") {
      throw new Error(`remote HSR launch ${receipt.launchId} is already stopped`);
    }
    if (receipt.state === "refreshing") {
      if (!options.allowRefreshing) throw new Error(`remote HSR launch ${receipt.launchId} is refreshing`);
      const meta = await readHsrMetaStrict(bee);
      if (receipt.refreshPhase === "dispatching") {
        // The old host was exactly stopped and removed before this phase was
        // persisted. A new running meta is the refresh successor; no meta is an
        // unresolved pre-meta dispatch and must never authorize a second fork.
        return { receipt, meta };
      }
      if (receipt.host && meta && !receiptHostMatchesMeta(receipt, meta)) {
        throw new Error(`remote HSR receipt for ${bee} does not own the refresh source incarnation`);
      }
      return { receipt, meta };
    }
    if (receipt.state === "stopping") {
      throw new Error(`remote HSR launch ${receipt.launchId} is stopping`);
    }
    const meta = await readHsrMetaStrict(bee);
    const reconciled = await reconcileReceiptHost(receipt, meta);
    return { receipt: reconciled, meta };
  }

  /**
   * Read/ack authority for an exact retained event history. Unlike mutation or
   * live-observe admission, a naturally exited host remains readable when the
   * immutable launch/incarnation receipt still owns the same host birth.
   */
  async function authorizeEventHistory(
    bee: string,
    locator: RemoteIncarnationLocator,
  ): Promise<{ receipt: RemoteHsrLaunchReceipt | null; meta: HsrMeta | null }> {
    const receipt = await readRemoteHsrLaunchReceiptStrict(bee);
    const meta = await readHsrMetaStrict(bee);
    if (!receipt) {
      if (locator.launchId || locator.incarnation) {
        throw new Error(`remote HSR launch receipt for ${bee} is absent`);
      }
      return { receipt: null, meta };
    }
    if (!locator.launchId || locator.launchId !== receipt.launchId) {
      throw new Error(`remote HSR launch id does not own ${bee}`);
    }
    if (!locator.incarnation || locator.incarnation !== receipt.incarnation) {
      throw new Error(`remote HSR incarnation token does not own ${bee}`);
    }
    if (!meta || !receiptHostMatchesMeta(receipt, meta)) {
      throw new Error(`remote HSR retained event history for ${bee} is not owned by the launch receipt`);
    }
    return { receipt, meta };
  }

  function assertAnswerOperationMatchesLocator(
    operation: HsrAnswerOperation,
    locator: RemoteIncarnationLocator,
  ): { launchId: string; incarnation: string } {
    const launchId = operation.source.remoteLaunchId;
    const incarnation = operation.source.remoteIncarnation;
    if (!launchId || !incarnation || !operation.source.node) {
      throw new Error(`remote HSR answer ${operation.requestId} is missing its immutable authority source`);
    }
    if (locator.launchId !== launchId || locator.incarnation !== incarnation) {
      throw new Error(`remote HSR answer ${operation.requestId} does not match its launch/incarnation authority`);
    }
    return { launchId: requireLaunchId(launchId), incarnation: requireLaunchId(incarnation) };
  }

  /**
   * Manual answer reconciliation performs no provider I/O, so it remains
   * available after exact stop. The operation itself is immutably bound to the
   * launch/incarnation; a stale historical controller can settle only its own
   * receipt, never a successor's.
   */
  async function authorizeAnswerReconciliation(
    bee: string,
    operation: HsrAnswerOperation,
    locator: RemoteIncarnationLocator,
  ): Promise<RemoteHsrLaunchReceipt> {
    const expected = assertAnswerOperationMatchesLocator(operation, locator);
    const head = await readRemoteHsrLaunchReceiptStrict(bee);
    const authority = head?.launchId === expected.launchId
      ? head
      : await readRemoteHsrLaunchHistoryStrict(bee, expected.launchId);
    if (!authority || authority.launchId !== expected.launchId || authority.incarnation !== expected.incarnation) {
      throw new Error(`remote HSR answer ${operation.requestId} is not owned by a known launch incarnation`);
    }
    return authority;
  }

  async function waitForStoppedIncarnation(bee: string, initial: HsrMeta, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const identity = await inspectHsrHostProcess(initial, processSignals);
      if (identity === "gone" || identity === "mismatch") return true;
      if (identity === "unverifiable") return false;
      const latest = await readHsrMetaStrict(bee);
      // Remote runners are hosted in-process, so finalized meta is the stop
      // proof even while the shared serve process itself remains alive.
      if (sameHostIncarnation(initial, latest) && latest?.status === "exited") return true;
      await (processSignals.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(50);
    }
    return false;
  }

  async function stopTrackedHandle(bee: string, handle: HsrHostHandle): Promise<boolean> {
    // The handle is not durable identity by itself: snapshot the exact meta
    // incarnation before calling user/provider teardown, then require the same
    // locator plus birth-fenced child absence afterward.
    const initial = await readHsrMetaStrict(bee);
    if (!initial) return false;
    let resolved = false;
    try {
      await handle.stop();
      resolved = true;
    } catch {
      // Fall through to strict child-group recovery below. Keep the handle in
      // the map until that durable proof succeeds.
    }
    const latest = await readHsrMetaStrict(bee);
    if (!latest || !sameHostIncarnation(initial, latest)) return false;
    if (!(await ensureOrphanedChildGroupStopped(latest, processSignals))) return false;
    if (!resolved) return false;
    if (latest.status !== "exited") {
      // `handle.done` is exact in-process completion evidence, and the strict
      // child-group census above proves no provider descendant remains. Heal a
      // transient final meta write failure under the unchanged host birth
      // instead of dropping the handle and later trying to SIGTERM the shared
      // runner-host serve process.
      const terminalMeta = handle.terminalMeta?.();
      await writeHsrMeta(bee, {
        ...latest,
        status: "exited",
        exitCode: latest.exitCode ?? null,
        endedAt: latest.endedAt ?? new Date().toISOString(),
        ...(terminalMeta?.eventStreamClosure ? { eventStreamClosure: terminalMeta.eventStreamClosure } : {}),
        ...(terminalMeta?.eventIntegrityFailure ? { eventIntegrityFailure: terminalMeta.eventIntegrityFailure } : {}),
      });
      const healed = await readHsrMetaStrict(bee);
      if (!sameHostIncarnation(initial, healed) || healed?.status !== "exited") return false;
    }
    if (handles.get(bee) === handle) {
      handles.delete(bee);
      handleHosts.delete(bee);
    }
    return true;
  }

  /**
   * A physically stopped host is not automatically a clean event source. The
   * provider may have emitted bytes/effects immediately before an ungraceful
   * death. Require positive terminal proof, or publish the exact launch-bound
   * receipt before any refresh/tombstone can discard this run directory.
   */
  async function settleStoppedSourceHistory(bee: string, meta: HsrMeta): Promise<boolean> {
    const authority = await readRemoteHsrLaunchReceiptStrict(bee);
    const host = receiptHostIdentity(meta);
    const remoteAuthority = authority
      ? { launchId: authority.launchId, incarnation: authority.incarnation }
      : undefined;
    const existing = await readHsrEventIntegrityReceipt(bee);
    if (existing?.phase === "unresolved") {
      if (!hsrEventIntegrityReceiptOwnsHost(existing, host, remoteAuthority)) return false;
      await recordHsrEventIntegrityStop(
        bee,
        existing.integrityId,
        existing.host,
        "confirmed",
        "remote controller exact host and child-group stop proof",
      );
      return true;
    }
    if (
      existing?.phase === "acknowledged"
      && existing.stopState === "confirmed"
      && hsrEventIntegrityReceiptOwnsHost(existing, host, remoteAuthority)
      && await isHsrEventHistoryQuarantined(bee, existing.integrityId)
    ) return true;

    // Missing-event testimony outranks a later syntactically clean exit. The
    // failed event never consumed a seq, so terminal contiguity cannot disprove
    // the already-persisted loss marker.
    if (!meta.eventIntegrityFailure) {
      if (hsrMetaProvesProviderNeverStarted(meta)) return true;
      if (meta.eventStreamClosure) {
        try {
          if (await verifyHsrEventStreamClosure(bee, meta, 250)) return true;
        } catch (error) {
          if (error instanceof HsrSourceEventLogBusyError) return false;
          // Invalid closure/history falls through to manual integrity authority.
        }
      }

      try {
        const closure = await sealHsrEventStreamClosure(bee, meta, 250);
        const latest = await readHsrMetaStrict(bee);
        if (!latest || !sameHostIncarnation(meta, latest)) return false;
        await writeHsrMeta(bee, {
          ...latest,
          status: "exited",
          exitCode: latest.exitCode ?? null,
          endedAt: latest.endedAt ?? closure.closedAt,
          eventStreamClosure: closure,
        });
        const healed = await readHsrMetaStrict(bee);
        return !!healed
          && sameHostIncarnation(meta, healed)
          && healed.eventStreamClosure?.lastSeq === closure.lastSeq;
      } catch (error) {
        if (error instanceof HsrSourceEventLogBusyError) return false;
      }
    }

    try {
      await assertHsrSourceEventLogIntegrity({
        bee,
        meta: {
          ...meta,
          eventIntegrityFailure: meta.eventIntegrityFailure
            ?? "runner host stopped without a durable clean event-stream closure",
        },
        operation: "remote HSR stopped-source history settlement",
        ...(remoteAuthority ? { remoteAuthority } : {}),
      });
      return false;
    } catch (error) {
      if (!(error instanceof HsrSourceEventIntegrityError)) return false;
    }
    const receipt = await readHsrEventIntegrityReceipt(bee);
    if (
      !receipt
      || receipt.phase !== "unresolved"
      || !hsrEventIntegrityReceiptOwnsHost(receipt, host, remoteAuthority)
    ) return false;
    await recordHsrEventIntegrityStop(
      bee,
      receipt.integrityId,
      receipt.host,
      "confirmed",
      "remote controller exact host and child-group stop proof",
    );
    return true;
  }

  /** Stop a runner: prefer the in-process handle, else socket + birth-validated fallback. */
  async function stopRunner(bee: string): Promise<boolean> {
    const handle = handles.get(bee);
    if (handle && !(await stopTrackedHandle(bee, handle))) return false;
    const meta = await readHsrMetaStrict(bee);
    if (!meta) return false;
    let stopped = handle !== undefined;
    if (!stopped && meta.controlSocket && meta.status === "running") {
      const result = await proxyCall(bee, "stop");
      if (result.ok) stopped = await waitForStoppedIncarnation(bee, meta, 2_500);
    }
    if (!stopped && meta.status === "running") {
      const latest = await readHsrMetaStrict(bee);
      const identity = await inspectHsrHostProcess(meta, processSignals);
      if (
        identity === "match"
        && meta.hostPid !== process.pid
        && sameHostIncarnation(meta, latest)
        && latest?.status === "running"
      ) {
        try {
          (processSignals.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)))(meta.hostPid, "SIGTERM");
        } catch {
          // already gone / not signalable
        }
        stopped = await waitForStoppedIncarnation(bee, meta, 2_500);
      } else if (identity === "gone" || identity === "mismatch") {
        // The host died without finalize (a previous serve was SIGKILLed/OOMed:
        // its in-process runners carried the serve's pid as hostPid), so the
        // harness child group is orphaned and unreachable over any control
        // socket. Signal the recorded child group directly (HIVE-53).
        stopped = await ensureOrphanedChildGroupStopped(meta, processSignals);
      }
    }
    if (!stopped && meta.status === "exited") {
      const identity = await inspectHsrHostProcess(meta, processSignals);
      stopped = identity === "gone" || identity === "mismatch" ||
        (identity === "match" && meta.hostPid === process.pid);
    }
    if (!stopped) return false;
    // An exited host cursor is not descendant-absence proof. This is especially
    // important after a controller restart, where the in-memory handle is gone
    // and an adapter may have exited while an escaped child remains alive.
    const stoppedMeta = await readHsrMetaStrict(bee);
    if (!stoppedMeta || !(await ensureOrphanedChildGroupStopped(stoppedMeta, processSignals))) return false;
    return settleStoppedSourceHistory(bee, stoppedMeta);
  }

  type SpawnLikeParams = {
    bee?: unknown;
    launchId?: unknown;
    previousLaunchId?: unknown;
    consumerId?: unknown;
    kind?: unknown;
    cwd?: unknown;
    sessionId?: unknown;
    resume?: unknown;
    authKind?: unknown;
    model?: unknown;
    comb?: unknown;
    parent?: unknown;
    creds?: unknown;
    home?: unknown;
    spec?: { command?: unknown; args?: unknown; env?: unknown };
  };

  type StartResult = { ok: boolean; bee?: string; tier?: RunnerTier; cwd?: string; sessionId?: string; error?: string };

  /**
   * Fork a runner host IN-PROCESS from a resolved spec (the local side already ran
   * resolveAgent — no resolveAgent here). Shared by `spawn` (fresh) and
   * `refreshCreds` (restart with resume, UNIT 2). `override.resume` / `.sessionId`
   * let the refresh path force a resume onto the bee's learned thread id. Persists
   * a restart descriptor (no creds) so a later refresh can restart faithfully.
   * May throw (runner never started) — the caller's `guarded` maps that to error.
   */
  async function startRunner(params: unknown, override: {
    resume?: boolean;
    sessionId?: string;
    remoteLaunchId?: string;
    remoteIncarnation?: string;
  } = {}): Promise<StartResult> {
    const p = (params ?? {}) as SpawnLikeParams;
    const bee = requireRemoteBeeName(p.bee);
    const kind = String(p.kind ?? "");
    if (!kind) return { ok: false, error: "kind required" };
    const policyError = remoteHarnessPolicyError(kind);
    if (policyError) return { ok: false, error: policyError };
    const adapter = adapterFor(kind);
    if (!adapter) return { ok: false, error: `no HSR adapter for harness "${kind}"` };
    const spec = p.spec ?? {};
    const command = typeof spec.command === "string" ? spec.command : "";
    const args = Array.isArray(spec.args) ? spec.args.map((a) => String(a)) : [];
    const specEnv = spec.env && typeof spec.env === "object" ? (spec.env as Record<string, string>) : {};
    // The harness child needs a complete env (PATH etc.), not just the spawn
    // overrides — overlay spec.env on the serve process's own env.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") childEnv[key] = value;
    }
    Object.assign(childEnv, specEnv);
    childEnv.HIVE_BEE = bee;
    childEnv.HIVE_COMB = typeof p.comb === "string" && p.comb ? p.comb : bee;
    if (typeof p.parent === "string" && p.parent) childEnv.HIVE_PARENT = p.parent;

    // Resolve the working dir the remote OWNS (derive per-bee under this store
    // unless the client shipped a real remote checkout path). A local client cwd
    // would not exist here → Node spawn() ENOENT (the bug this fixes).
    const { cwd: cwdDir, derived: cwdDerived } = resolveRemoteSpawnCwd(bee, p.cwd);
    if (!isAbsolute(cwdDir)) {
      return { ok: false, error: `resolved remote working dir for ${bee} is not absolute` };
    }
    if (cwdDerived) {
      try {
        await mkdir(cwdDir, { recursive: true, mode: 0o700 });
      } catch {
        return { ok: false, error: `could not create the remote working dir for ${bee}` };
      }
    }

    // APIA-93 credential delivery: the ephemeral-token policy ships a SHORT-LIVED
    // credential (opaque, base64 in transit) that we write into this bee's
    // isolated home (0700 dir / 0600 files) BEFORE forking the runner, and record
    // so `kill` (and the next refresh) can shred it. The vault never reaches the
    // remote. Secrets are never logged.
    const creds = normalizeCreds(p.creds);
    let deliveredCredPaths: string[] = [];
    if (creds?.env) Object.assign(childEnv, creds.env);
    let homeDirResolved: string | undefined;
    if (creds?.files?.length) {
      const { homeDir, homeEnv } = resolveRemoteSpawnHome(bee, kind, p.home);
      homeDirResolved = homeDir;
      try {
        // The strict locator is committed while the no-follow target fds are
        // still empty, before secret bytes are written through them. A crash can
        // therefore never strand a delivered credential without erase identity.
        deliveredCredPaths = await deliverAndRecordCredentials(bee, homeDir, creds);
      } catch {
        try {
          await eraseCredentialsStrict(bee);
        } catch {
          return { ok: false, error: "failed to write delivered credentials; cleanup unconfirmed and run state preserved" };
        }
        return { ok: false, error: "failed to write delivered credentials into the remote home" };
      }
      if (homeEnv) childEnv[homeEnv] = homeDir;
      // Home-RELATIVE identity env (e.g. opencode's XDG_DATA_HOME → <home>/xdg-data,
      // where the delivered auth.json lives) must be re-derived against the REMOTE
      // home: the value the local resolveAgent baked into spec.env points at a
      // local path that does not exist on this node, so the child would look for
      // the delivered credential in the wrong place. Re-template against homeDir
      // and OVERRIDE the shipped value. No-op for harnesses without extraEnv
      // (codex/claude/grok/kimi return {}). NOT a secret — these are paths.
      for (const [key, value] of Object.entries(identityEnvForAgent(kind, homeDir))) {
        childEnv[key] = value;
      }
    }

    const resume = override.resume ?? p.resume === true;
    const sessionId =
      typeof override.sessionId === "string" && override.sessionId
        ? override.sessionId
        : typeof p.sessionId === "string" && p.sessionId
          ? p.sessionId
          : undefined;

    const opts: RunnerOpts = {
      bee,
      cwd: cwdDir,
      env: childEnv,
      ...(sessionId ? { sessionId } : {}),
      ...(typeof p.authKind === "string" ? { authKind: p.authKind as "subscription" | "api-key" } : {}),
      ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
      ...(resume ? { resume: true } : {}),
      command,
      args,
      runDir: hsrRunDir(bee),
    };

    // Persist a restart descriptor (spec + resolved cwd/home, NO creds and NO
    // process.env) so a later `refreshCreds` restarts this runner faithfully with
    // resume (UNIT 2). Best-effort: a failed write only degrades refresh, not spawn.
    await writeHsrRestart(bee, {
      kind,
      command,
      args,
      env: specEnv,
      cwd: cwdDir,
      ...(homeDirResolved
        ? { home: homeDirResolved }
        : typeof p.home === "string" && p.home
          ? { home: p.home }
          : {}),
      ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
      ...(typeof p.authKind === "string" ? { authKind: p.authKind as "subscription" | "api-key" } : {}),
      ...(typeof p.comb === "string" && p.comb ? { comb: p.comb } : {}),
      ...(typeof p.parent === "string" && p.parent ? { parent: p.parent } : {}),
    }).catch(() => undefined);

    let handle: HsrHostHandle;
    try {
      handle = await runHost({
        bee,
        adapter,
        opts,
        answerAuthority: "remote-receipt",
        ...(typeof p.consumerId === "string" ? {
          initialEventConsumerId: consumerIdFromParams(p as Record<string, unknown>),
        } : {}),
        ...(override.remoteLaunchId && override.remoteIncarnation ? {
          runtimeAuthority: {
            remoteLaunchId: override.remoteLaunchId,
            remoteIncarnation: override.remoteIncarnation,
          },
        } : {}),
      });
    } catch (error) {
      // Runner never started — do not leave the delivered credential on disk.
      if (deliveredCredPaths.length > 0) {
        try {
          await eraseCredentialsStrict(bee);
        } catch {
          throw new Error(`runner startup failed for ${bee}; credential erasure unconfirmed and run state preserved`);
        }
      }
      throw error;
    }
    const admitted = await readHsrMetaStrict(bee);
    if (!admitted || admitted.status !== "running") {
      throw new Error(`runner startup for ${bee} returned without running host metadata`);
    }
    handles.set(bee, handle);
    handleHosts.set(bee, receiptHostIdentity(admitted));
    // Drop a naturally completed handle only after its exact exited cursor is
    // durable. If finalize's last write failed, retain the handle so a later
    // stop can strict-census children and heal that cursor; falling back to OS
    // signalling would otherwise target this shared serve's own process pid.
    void handle.done.then(async () => {
      if (handles.get(bee) !== handle) return;
      const expected = handleHosts.get(bee);
      const latest = await readHsrMetaStrict(bee).catch(() => null);
      if (!expected || !latest || latest.status !== "exited" || !hostIdentityMatchesMeta(expected, latest)) return;
      if (!latest.eventStreamClosure && !latest.eventIntegrityFailure) return;
      if (handles.get(bee) === handle) {
        handles.delete(bee);
        handleHosts.delete(bee);
      }
    }).catch(() => undefined);
    // Echo the resolved remote cwd back so the local SessionRecord stores a real
    // remote path (the derived per-bee dir, or the checkout the client sent).
    return { ok: true, bee, tier: adapter.tier(), cwd: cwdDir, ...(sessionId ? { sessionId } : {}) };
  }

  function stoppedLaunchResult(receipt: RemoteHsrLaunchReceipt): Record<string, unknown> {
    return {
      ok: false,
      stopped: true,
      safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL,
      bee: receipt.bee,
      launchId: receipt.launchId,
      incarnation: receipt.incarnation,
      error: `remote HSR launch ${receipt.launchId} is already stopped`,
    };
  }

  function closeRelay(bee: string): void {
    const relay = relays.get(bee);
    if (!relay) return;
    try {
      relay.unsubscribe?.();
      relay.client?.close();
    } catch {
      // Best-effort transport teardown follows an already-proven runtime stop.
    }
    relays.delete(bee);
  }

  function isRelayedRunnerEvent(value: unknown): value is RunnerEvent {
    return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
  }

  function broadcastRelayEvent(
    bee: string,
    event: RunnerEvent,
    generation: { launchId?: string; incarnation?: string },
  ): void {
    server?.broadcast("hsr.event", {
      bee,
      event,
      ...(generation.launchId ? { launchId: generation.launchId } : {}),
      ...(generation.incarnation ? { incarnation: generation.incarnation } : {}),
    });
  }

  /**
   * Rebind an existing observer intent to a replacement host within the SAME
   * remote launch/incarnation. The durable host_epoch plus its exact seq-owned
   * events are broadcast before refresh returns, so a local mirror cannot keep
   * projecting the stopped host merely because the replacement is initially
   * silent. Live events racing the backfill are buffered and seq-deduplicated.
   */
  async function rebindRelayAfterHostRefresh(
    bee: string,
    meta: HsrMeta,
    generation: { launchId?: string; incarnation?: string },
  ): Promise<void> {
    const relay = relays.get(bee);
    if (!relay) return;
    if (relay.launchId !== generation.launchId || relay.incarnation !== generation.incarnation) {
      throw new Error(`observer generation changed while refreshing ${bee}`);
    }
    if (!meta.controlSocket || meta.status !== "running") {
      throw new Error(`refreshed host for ${bee} has no live control socket`);
    }

    const client = await connectRpcClient(meta.controlSocket);
    const buffered: RunnerEvent[] = [];
    let backfilling = true;
    const unsubscribe = client.on("event", (event) => {
      if (!isRelayedRunnerEvent(event)) return;
      if (backfilling) buffered.push(event);
      else broadcastRelayEvent(bee, event, generation);
    });

    const priorClient = relay.client;
    const priorUnsubscribe = relay.unsubscribe;
    relay.client = client;
    relay.unsubscribe = unsubscribe;
    try {
      priorUnsubscribe?.();
      priorClient?.close();
    } catch {
      // The old host is already proven stopped; stale relay teardown is best effort.
    }

    let readError: unknown;
    let highSeq = 0;
    try {
      const expectedHost = receiptHostIdentity(meta);
      const activeConsumers = [...relay.consumers.entries()]
        .filter(([, count]) => count > 0)
        .map(([consumerId]) => consumerId);
      const least = await readHsrLeastConsumerCursorStrict(bee, activeConsumers);
      let cursor = least.ackedSeq;
      let pageToken: string | undefined;
      let sawExpectedEpoch = false;
      do {
        const page = await readHsrEventsPageAfterSeqStrict(
          bee,
          cursor,
          least.consumerId,
          pageToken,
        );
        if (page.gap) {
          throw new Error(`retained event gap ${page.gap.fromSeq}..${page.gap.toSeq}`);
        }
        for (const event of page.events) {
          if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq <= cursor) {
            throw new Error("replacement host event is missing its exact sequence");
          }
          cursor = event.seq;
          highSeq = Math.max(highSeq, event.seq);
          const exactHost = eventMatchesHost(event, expectedHost);
          if (event.type === "host_epoch" && exactHost) sawExpectedEpoch = true;
          // Modern hosts stamp every event. Hostless compatibility facts are
          // accepted only after this replacement's exact durable boundary.
          if (exactHost || (sawExpectedEpoch && event.host === undefined)) {
            broadcastRelayEvent(bee, event, generation);
          }
        }
        if (page.throughSeq !== cursor) {
          throw new Error("replacement host replay page reported a mismatched high-water");
        }
        pageToken = page.pageToken;
        if (page.hasMore !== (pageToken !== undefined)) {
          throw new Error("replacement host replay page continuation is malformed");
        }
      } while (pageToken);
      if (!sawExpectedEpoch) {
        throw new Error("replacement host epoch is absent from the strict retained suffix");
      }
    } catch (error) {
      readError = error;
    } finally {
      backfilling = false;
      for (const event of buffered) {
        if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq <= 0) continue;
        if (event.seq <= highSeq) continue;
        highSeq = event.seq;
        broadcastRelayEvent(bee, event, generation);
      }
    }
    void client.closed.then(() => {
      const current = relays.get(bee);
      if (!current || current.client !== client) return;
      if (refreshing.has(bee)) {
        current.client = undefined;
        current.unsubscribe = undefined;
      } else {
        relays.delete(bee);
      }
    });
    if (readError !== undefined) {
      throw new Error(`refreshed host event epoch is unreadable for ${bee}: ${messageOf(readError)}`);
    }
  }

  /**
   * Settle one launch generation without ever erasing a same-name replacement.
   * The durable stopped tombstone is written before the disposable run dir is
   * removed, so delayed/replayed spawn RPCs cannot resurrect a cleaned launch.
   */
  async function stopAndTombstoneLaunch(
    receipt: RemoteHsrLaunchReceipt,
    options: { dispatchNeverActivated?: boolean } = {},
  ): Promise<{
    ok: boolean;
    error?: string;
    terminalHistoryPending?: boolean;
    pendingConsumers?: Array<{ consumerId: string; ackedSeq: number; throughSeq: number }>;
  }> {
    const meta = await readHsrMetaStrict(receipt.bee);
    if (receipt.host && meta && !receiptHostMatchesMeta(receipt, meta)) {
      return { ok: false, error: `remote HSR receipt for ${receipt.bee} does not own the current host incarnation` };
    }
    const unresolvedDispatch = receipt.state !== "reserved"
      && receipt.state !== "stopped"
      && !meta
      && !handles.has(receipt.bee);
    if (receipt.state !== "stopping" && receipt.state !== "stopped") {
      receipt = { ...receipt, state: "stopping" };
      await writeRemoteHsrLaunchReceipt(receipt);
    }
    if (unresolvedDispatch && !options.dispatchNeverActivated) {
      return {
        ok: false,
        error: `stop unconfirmed for ${receipt.bee}; dispatch may have escaped before durable host admission`,
      };
    }
    if (handles.has(receipt.bee) || meta) {
      if (!(await stopRunner(receipt.bee))) {
        return { ok: false, error: `stop unconfirmed for ${receipt.bee}; run state preserved` };
      }
    }
    const eventIntegrity = await readHsrEventIntegrityReceipt(receipt.bee);
    if (eventIntegrity?.phase === "unresolved") {
      const eventHost = eventIntegrity.host;
      if (
        eventIntegrity.remoteAuthority?.launchId !== receipt.launchId
        || eventIntegrity.remoteAuthority?.incarnation !== receipt.incarnation
        || (receipt.host && !hsrEventIntegrityReceiptOwnsHost(eventIntegrity, receipt.host, {
          launchId: receipt.launchId,
          incarnation: receipt.incarnation,
        }))
      ) {
        return { ok: false, error: `unresolved HSR event-integrity authority for ${receipt.bee} belongs to a different generation` };
      }
      if (eventIntegrity.stopState !== "confirmed") {
        await recordHsrEventIntegrityStop(
          receipt.bee,
          eventIntegrity.integrityId,
          eventHost,
          "confirmed",
          "remote controller exact-stop proof",
        );
      }
      return {
        ok: false,
        error: `HSR event history ${eventIntegrity.integrityId} is unresolved for ${receipt.bee}; reconcile every delivery then run hive hsr-reconcile ${receipt.bee} ${eventIntegrity.integrityId} --acknowledge-loss`,
      };
    }
    closeRelay(receipt.bee);
    try {
      await eraseCredentialsStrict(receipt.bee);
    } catch {
      return { ok: false, error: `credential erasure unconfirmed for ${receipt.bee}; run state preserved` };
    }
    const { refreshPhase: _refreshPhase, refreshSourceHost: _refreshSourceHost, ...settled } = receipt;
    const tombstone: RemoteHsrLaunchReceipt = {
      ...settled,
      state: "stopped",
      stoppedAt: receipt.stoppedAt ?? new Date().toISOString(),
    };
    try {
      await writeRemoteHsrLaunchReceipt(tombstone);
    } catch (error) {
      return { ok: false, error: `stopped receipt persistence failed for ${receipt.bee}: ${messageOf(error)}` };
    }
    let removed = false;
    try {
      removed = await removeHsrRunDirIfConsumersCaughtUp(
        receipt.bee,
        tombstone.terminalConsumerActivations,
      );
    } catch {
      return { ok: false, error: `run state removal unconfirmed for ${receipt.bee}` };
    }
    // Exact stop and its tombstone are complete even while a slow durable
    // consumer pins the terminal suffix. Ordinary authority shutdown may now
    // exit safely; the next serve exposes the stopped row for replay. Explicit
    // kill reports the pending history below so its controller retains the
    // canonical mirror/cursor until final acknowledgement.
    if (removed) return { ok: true };
    const pendingConsumers = await readPendingHsrEventConsumers(
      receipt.bee,
      tombstone.terminalConsumerActivations,
    );
    return {
      ok: true,
      terminalHistoryPending: true,
      ...(pendingConsumers.length > 0 ? { pendingConsumers } : {}),
    };
  }

  /**
   * A controller restart deliberately loses the in-memory handle map, but it
   * must not lose shutdown responsibility for durable authority heads or old
   * run dirs. Enumerate both namespaces before claiming a quiescent close.
   */
  async function durableRuntimeNames(): Promise<string[]> {
    const names = new Set(handles.keys());
    for (const receipt of await listRemoteHsrLaunchReceiptsStrict()) {
      names.add(requireRemoteBeeName(receipt.bee));
    }
    let entries;
    try {
      entries = await readdir(hsrRoot(), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [...names].sort((left, right) => left.localeCompare(right));
      }
      throw new Error(`Unable to enumerate remote HSR run state: ${messageOf(error)}`);
    }
    for (const entry of entries) {
      if (entry.name === "launch-receipts") continue;
      if (!entry.isDirectory()) continue;
      names.add(requireRemoteBeeName(entry.name));
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }

  /** Exact cleanup for pre-protocol run dirs that have no durable receipt. */
  async function settleLegacyRunState(bee: string): Promise<boolean> {
    if (!(await remoteHsrRunDirExistsStrict(bee))) return true;
    if (!(await stopRunner(bee))) return false;
    if ((await readHsrEventIntegrityReceipt(bee))?.phase === "unresolved") return false;
    closeRelay(bee);
    try {
      await eraseCredentialsStrict(bee);
      await removeHsrRunDirUnderEventAuthority(bee);
    } catch {
      return false;
    }
    return true;
  }

  async function closeAuthority(): Promise<void> {
    if (closeSettled) return;
    if (closeOperation) return closeOperation;
    closeOperation = (async () => {
      await waitForRpcDrain();
      for (const relay of relays.values()) {
        try {
          relay.unsubscribe?.();
          relay.client?.close();
        } catch {
          // best-effort teardown
        }
      }
      relays.clear();
      const unresolved: string[] = [];
      let runtimeNames: string[];
      try {
        runtimeNames = await durableRuntimeNames();
      } catch (error) {
        throw new Error(`runner-host close could not enumerate durable HSR authority: ${messageOf(error)}`);
      }
      for (const bee of runtimeNames) {
        try {
          const stopped = await withSessionLifecycleLock(bee, async () => {
            const receipt = await readRemoteHsrLaunchReceiptStrict(bee);
            if (receipt) {
              const cleanup = await stopAndTombstoneLaunch(receipt);
              return cleanup.ok;
            }
            return settleLegacyRunState(bee);
          });
          if (!stopped) unresolved.push(bee);
        } catch {
          unresolved.push(bee);
        }
      }
      if (unresolved.length > 0) {
        throw new Error(`runner-host close left unconfirmed HSR runtimes: ${unresolved.join(", ")}`);
      }
      closeSettled = true;
    })();
    try {
      await closeOperation;
    } finally {
      if (!closeSettled) closeOperation = undefined;
    }
  }

  /**
   * A routine bootstrap must never stop somebody's live remote Cells. Upgrade
   * preparation therefore fences and drains RPC admission, then proves the
   * authority is already quiescent. Stopped receipt tombstones are harmless;
   * every live/transitional receipt, run directory, or in-memory handle is an
   * explicit operator-visible refusal with zero stop signals.
   */
  async function prepareQuiescentUpgrade(replacementVersion: string): Promise<{ token: string } | { error: string; active: string[] }> {
    if (preparedUpgrade) {
      if (preparedUpgrade.replacementVersion !== replacementVersion) {
        return { error: `runner-host is already prepared for ${preparedUpgrade.replacementVersion}`, active: [] };
      }
      return { token: preparedUpgrade.token };
    }
    if (preparingUpgrade || closing) {
      return { error: "runner-host is already closing or preparing an upgrade", active: [] };
    }
    preparingUpgrade = true;
    closing = true;
    try {
      await waitForRpcDrain();
      const active: string[] = [];
      for (const bee of await durableRuntimeNames()) {
        const blocked = await withSessionLifecycleLock(bee, async () => {
          const receipt = await readRemoteHsrLaunchReceiptStrict(bee);
          const runDirExists = await remoteHsrRunDirExistsStrict(bee);
          if (handles.has(bee) || runDirExists) return true;
          return receipt !== null && receipt.state !== "stopped";
        });
        if (blocked) active.push(bee);
      }
      if (active.length > 0) {
        return {
          error: `runner-host upgrade refused while remote HSR work is active or unresolved: ${active.join(", ")}; stop/retire those bees, then rerun hive node bootstrap`,
          active,
        };
      }
      for (const relay of relays.values()) {
        try {
          relay.unsubscribe?.();
          relay.client?.close();
        } catch {
          // best-effort: there is no admitted runtime to mutate at this point.
        }
      }
      relays.clear();
      preparedUpgrade = { replacementVersion, token: randomUUID() };
      return { token: preparedUpgrade.token };
    } finally {
      preparingUpgrade = false;
      if (!preparedUpgrade && !shutdownRequested) closing = false;
    }
  }

  async function settleFailedLaunch(
    receipt: RemoteHsrLaunchReceipt,
    launchError: string,
    options: { dispatchNeverActivated?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const cleanup = await stopAndTombstoneLaunch(receipt, options);
    if (!cleanup.ok || cleanup.terminalHistoryPending) {
      return {
        ok: false,
        cleanupUnconfirmed: true,
        launchId: receipt.launchId,
        incarnation: receipt.incarnation,
        error: `${launchError}; ${cleanup.error ?? "terminal event history awaits durable consumer acknowledgement"}`,
      };
    }
    return {
      ...stoppedLaunchResult({ ...receipt, state: "stopped", stoppedAt: new Date().toISOString() }),
      error: launchError,
    };
  }

  const methods: Record<string, RpcMethodHandler> = {
    // Handshake / health: cheap, side-effect-free, mirrors the --version target.
    ping: () => closing
      ? { ok: false, version, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL, error: "runner-host is closing" }
      : { ok: true, version, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL },

    // Two-phase, non-destructive authority upgrade. prepareUpgrade refuses
    // while any live/unresolved generation exists; commitUpgrade is reachable
    // only with the one-time token returned after the quiescent proof.
    prepareUpgrade: async (params) => {
      if (!server) return { ok: false, error: "runner-host upgrade is unavailable without a local serve socket" };
      const p = (params ?? {}) as { expectedVersion?: unknown; replacementVersion?: unknown };
      if (p.expectedVersion !== version) {
        return { ok: false, version, error: `runner-host version changed before upgrade admission (expected ${String(p.expectedVersion)})` };
      }
      if (typeof p.replacementVersion !== "string" || !p.replacementVersion.startsWith("runner-host ")) {
        return { ok: false, version, error: "replacementVersion must be an exact runner-host handshake" };
      }
      const replacementCore = p.replacementVersion.slice("runner-host ".length);
      try {
        if (runnerHostHandshakeVersion(replacementCore) !== p.replacementVersion) throw new Error("non-canonical handshake");
      } catch {
        return { ok: false, version, error: "replacementVersion is malformed" };
      }
      if (p.replacementVersion === version) {
        return { ok: false, version, error: "runner-host already has the requested version" };
      }
      try {
        const prepared = await prepareQuiescentUpgrade(p.replacementVersion);
        if ("error" in prepared) return { ok: false, version, ...prepared };
        return {
          ok: true,
          version,
          replacementVersion: p.replacementVersion,
          safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL,
          token: prepared.token,
        };
      } catch (error) {
        return { ok: false, version, error: `runner-host upgrade preparation failed: ${messageOf(error)}` };
      }
    },

    commitUpgrade: async (params) => {
      const p = (params ?? {}) as { token?: unknown; replacementVersion?: unknown };
      if (
        !server
        || !preparedUpgrade
        || p.token !== preparedUpgrade.token
        || p.replacementVersion !== preparedUpgrade.replacementVersion
      ) {
        return { ok: false, version, error: "runner-host upgrade commit token does not match the prepared authority handoff" };
      }
      if (!upgradeCommitScheduled) {
        upgradeCommitScheduled = true;
        const attachedServer = server;
        setTimeout(() => {
          void attachedServer.close().then(
            () => options.onServeShutdown?.(),
            (error) => {
              upgradeCommitScheduled = false;
              process.stderr.write(`runner-host: prepared upgrade socket close failed: ${messageOf(error)}\n`);
            },
          );
        }, 50);
      }
      return {
        ok: true,
        version,
        replacementVersion: preparedUpgrade.replacementVersion,
        safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL,
      };
    },

    // Read-only cross-process liveness of this node's HSR bees (run-dir based).
    liveness: guarded(async () => {
      const out: Record<string, boolean> = {};
      for (const [bee, live] of await hsrLiveness()) out[bee] = live;
      return out;
    }),

    list: guarded(async () => {
      try {
        const heads = await listRemoteHsrLaunchReceiptsStrict();
        const headByBee = new Map(heads.map((receipt) => [receipt.bee, receipt]));
        const bees = new Set(heads.map((receipt) => receipt.bee));
        let entries;
        try {
          entries = await readdir(hsrRoot(), { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw new Error("remote HSR run root is unreadable", { cause: error });
        }
        const rows: Array<Record<string, unknown>> = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name === "launch-receipts") continue;
          bees.add(requireRemoteBeeName(entry.name));
        }
        for (const bee of [...bees].sort()) {
          try {
            await withSessionLifecycleLock(bee, async () => {
          const authority = await readRemoteHsrLaunchReceiptStrict(bee) ?? headByBee.get(bee);
          const eventIntegrity = await readHsrEventIntegrityReceipt(bee);
          const existingIntegrityRow = await settledEventIntegrityListRow(bee, authority, eventIntegrity);
          if (existingIntegrityRow) {
            // The run dir (including meta/events) is exactly the storage that
            // may be damaged. The launch receipt + outside integrity head carry
            // all immutable identity needed for controller import/reconcile.
            rows.push(existingIntegrityRow);
            return;
          }
          let meta = await readHsrMetaStrict(bee);
          if (!meta) {
            if (authority?.state === "stopped") return;
            if (
              authority
              && (authority.state === "reserved" || authority.state === "dispatching"
                || authority.state === "refreshing" || authority.state === "stopping")
            ) {
              rows.push({
                bee,
                live: false,
                state: null,
                tier: authority.tier ?? null,
                sessionId: authority.sessionId ?? null,
                status: authority.state,
                controlSocket: null,
                launchId: authority.launchId,
                incarnation: authority.incarnation,
                transitional: true,
              });
              return;
            }
            throw new Error(`remote HSR run ${bee} has no readable metadata`);
          }
          const live = (meta.status === "running" || meta.status === "queued")
            ? await admittedHostIsLive(bee, meta)
            : false;
          if ((meta.status === "running" || meta.status === "queued") && !live) {
            // The terminal event can win its append while the host dies before
            // the final meta replacement. Reconstruct positive clean proof
            // only from an exact host-stamped exit at durable high-water plus
            // already-absent descendants; otherwise this is manual ambiguity.
            let recoveredCleanExit = false;
            try {
              const closure = await sealHsrEventStreamClosure(bee, meta, 250);
              if (await proveHsrChildGroupAbsent(meta, processSignals)) {
                const latest = await readHsrMetaStrict(bee);
                if (!latest || !sameHostIncarnation(meta, latest)) {
                  throw new Error(`remote HSR ${bee} changed incarnation while healing clean exit`);
                }
                meta = {
                  ...latest,
                  status: "exited",
                  exitCode: latest.exitCode ?? null,
                  endedAt: latest.endedAt ?? closure.closedAt,
                  eventStreamClosure: closure,
                };
                await writeHsrMeta(bee, meta);
                recoveredCleanExit = true;
              }
            } catch (error) {
              if (error instanceof HsrSourceEventLogBusyError) throw error;
            }
            if (recoveredCleanExit) {
              // Continue below as an ordinary exact terminal row. The local
              // mirror performs its final replay before projecting non-live.
            } else {
            if (!authority) throw new Error(`remote HSR ${bee} died without launch authority`);
            try {
              await assertHsrSourceEventLogIntegrity({
                bee,
                meta: {
                  ...meta,
                  eventIntegrityFailure: "runner host died without a durable clean event-stream closure",
                },
                operation: "remote HSR ungraceful host-death observation",
                remoteAuthority: {
                  launchId: authority.launchId,
                  incarnation: authority.incarnation,
                },
              });
            } catch (guardError) {
              if (!(guardError instanceof HsrSourceEventIntegrityError)) throw guardError;
            }
            const raised = await readHsrEventIntegrityReceipt(bee);
            const raisedRow = await settledEventIntegrityListRow(bee, authority, raised);
            if (!raisedRow) throw new Error(`remote HSR ${bee} ungraceful death could not be fenced`);
            rows.push(raisedRow);
            return;
            }
          }
          if (meta.eventIntegrityFailure) {
            if (!authority) throw new Error(`remote HSR ${bee} has event-integrity failure without launch authority`);
            try {
              await assertHsrSourceEventLogIntegrity({
                bee,
                meta,
                operation: "remote HSR idle observation",
                remoteAuthority: {
                  launchId: authority.launchId,
                  incarnation: authority.incarnation,
                },
              });
            } catch (guardError) {
              if (!(guardError instanceof HsrSourceEventIntegrityError)) throw guardError;
            }
            const raised = await readHsrEventIntegrityReceipt(bee);
            const raisedRow = await settledEventIntegrityListRow(bee, authority, raised);
            if (!raisedRow) throw new Error(`remote HSR ${bee} event-integrity marker could not be promoted`);
            rows.push(raisedRow);
            return;
          }
          let projectedState: string | null = null;
          let projection: HsrListEventProjection;
          try {
            projection = await readHsrListEventProjection(
              bee,
              receiptHostIdentity(meta),
              meta.sessionId,
            );
          } catch (error) {
            if (!authority) throw error;
            try {
              await assertHsrSourceEventLogIntegrity({
                bee,
                meta,
                operation: "remote HSR idle observation",
                remoteAuthority: {
                  launchId: authority.launchId,
                  incarnation: authority.incarnation,
                },
              });
            } catch (guardError) {
              if (!(guardError instanceof HsrSourceEventIntegrityError)) throw guardError;
            }
            const raised = await readHsrEventIntegrityReceipt(bee);
            const raisedRow = await settledEventIntegrityListRow(bee, authority, raised);
            if (!raisedRow) throw error;
            rows.push(raisedRow);
            return;
          }
          const eventState = structuredStateFromEvents(projection.stateEvents, { rootThreadId: meta.sessionId });
          projectedState = live
            ? meta.status === "queued"
              ? meta.startupPhase === "harness" ? "booting" : "queued"
              : eventState ?? (meta.runningAt ? "ready" : "booting")
            : null;
          const pendingConsumers = authority?.state === "stopped"
            ? await readPendingHsrEventConsumers(bee, authority.terminalConsumerActivations)
            : [];
          rows.push({
            bee,
            live,
            state: projectedState,
            tier: meta.tier ?? null,
            sessionId: meta.sessionId ?? null,
            status: meta.status,
            controlSocket: meta.controlSocket ?? null,
            usage: projection.usage,
            ...(authority ? { launchId: authority.launchId, incarnation: authority.incarnation } : {}),
            ...(meta.eventIntegrityFailure ? { eventIntegrityFailure: meta.eventIntegrityFailure } : {}),
            ...(pendingConsumers.length > 0 ? { pendingConsumers } : {}),
          });
            });
          } catch (error) {
            const authority = headByBee.get(bee);
            if (error instanceof HsrSourceEventLogBusyError) {
              rows.push({
                bee,
                live: false,
                state: null,
                tier: authority?.tier ?? null,
                sessionId: authority?.sessionId ?? null,
                status: "unavailable",
                controlSocket: null,
                ...(authority ? { launchId: authority.launchId, incarnation: authority.incarnation } : {}),
                unavailable: "busy",
                error: messageOf(error),
              });
              continue;
            }

            // A per-Bee authority/storage failure must not collapse the whole
            // node into an empty/error response. When the durable launch head
            // still supplies an exact host birth, publish the same outside
            // manual-action authority used by source append failures. If that
            // store is itself damaged, the exact row still fences only this
            // generation on the controller; unrelated Bees continue listing.
            let eventIntegrity = await readHsrEventIntegrityReceipt(bee).catch(() => null);
            if (!eventIntegrity && authority?.host) {
              let deliveryIds: string[] = [];
              let deliveryScanError: string | undefined;
              try {
                deliveryIds = (await readPendingHsrTurns(bee))
                  .filter((turn) => turn.phase !== "completed" && turn.phase !== "discarded")
                  .map((turn) => turn.id);
              } catch (scanError) {
                deliveryScanError = `pending HSR delivery authority could not be enumerated: ${messageOf(scanError)}`;
              }
              try {
                eventIntegrity = await persistHsrEventIntegrityFailure({
                  bee,
                  host: authority.host,
                  remoteAuthority: { launchId: authority.launchId, incarnation: authority.incarnation },
                  deliveryIds,
                  ...(deliveryScanError ? { deliveryScanError } : {}),
                  reason: `remote idle authority read failed: ${messageOf(error)}`,
                });
                eventIntegrity = await recordHsrEventIntegrityStop(
                  bee,
                  eventIntegrity.integrityId,
                  eventIntegrity.host,
                  "doubt",
                  "remote idle authority failed before exact host/group stop proof",
                );
              } catch {
                eventIntegrity = null;
              }
            }
            const integrityRow = await settledEventIntegrityListRow(bee, authority, eventIntegrity).catch(() => null);
            if (integrityRow) {
              rows.push(integrityRow);
              continue;
            }
            rows.push({
              bee,
              live: false,
              state: null,
              tier: authority?.tier ?? null,
              sessionId: authority?.sessionId ?? null,
              status: "event_integrity",
              controlSocket: null,
              ...(authority ? { launchId: authority.launchId, incarnation: authority.incarnation } : {}),
              unavailable: "integrity",
              integrityFailure: true,
              error: messageOf(error),
            });
          }
        }
        return rows;
      } catch (error) {
        return {
          ok: false,
          ...(error instanceof HsrSourceEventLogBusyError ? {} : { integrityFailure: true }),
          error: messageOf(error),
        };
      }
    }),

    // Fork a runner host IN-PROCESS from a resolved spec (the local side already
    // ran resolveAgent — no resolveAgent on the remote). Delegates to startRunner
    // (shared with refreshCreds); guarded maps a thrown runner-start to error.
    spawn: guarded(async (params) => {
      const p = (params ?? {}) as SpawnLikeParams;
      const bee = requireRemoteBeeName(p.bee);
      const launchId = requireLaunchId(p.launchId);
      // Validate before reserving a launch id: without a durable consumer a
      // fast >retention-cap run could become unrecoverable before first attach.
      consumerIdFromParams(p as Record<string, unknown>);
      const kind = String(p.kind ?? "");
      if (!kind) return { ok: false, launchUnowned: true, error: "kind required" };
      const policyError = remoteHarnessPolicyError(kind);
      if (policyError) return { ok: false, launchUnowned: true, error: policyError };
      const adapter = adapterFor(kind);
      if (!adapter) return { ok: false, launchUnowned: true, error: `no HSR adapter for harness "${kind}"` };
      let cwd: string;
      try {
        ({ cwd } = resolveRemoteSpawnCwd(bee, p.cwd));
      } catch (error) {
        return { ok: false, launchUnowned: true, error: messageOf(error) };
      }
      if (!isAbsolute(cwd)) return { ok: false, launchUnowned: true, error: `resolved remote working dir for ${bee} is not absolute` };
      const requestDigest = remoteSpawnRequestDigest(p);
      return withSessionLifecycleLock(bee, async () => {
        let receipt = await readRemoteHsrLaunchReceiptStrict(bee);
        if (await readRemoteHsrLaunchCancellationStrict(bee, launchId)) {
          return { ok: false, stopped: true, launchId, error: `remote HSR launch ${launchId} was cancelled before admission` };
        }
        const historical = await readRemoteHsrLaunchHistoryStrict(bee, launchId);
        if (historical && receipt?.launchId !== launchId) {
          if (historical.requestDigest !== requestDigest) {
            return { ok: false, error: `remote HSR launch ${launchId} was already used with different parameters` };
          }
          return historical.state === "stopped"
            ? stoppedLaunchResult(historical)
            : { ok: false, error: `remote HSR launch ${launchId} is historical and no longer owns ${bee}` };
        }
        if (receipt?.launchId === launchId) {
          if (receipt.requestDigest !== requestDigest) {
            return { ok: false, error: `remote HSR launch ${launchId} was already used with different parameters` };
          }
          if (receipt.state === "stopped") return stoppedLaunchResult(receipt);
          if (receipt.state === "refreshing" || receipt.state === "stopping") {
            return { ok: false, pending: true, launchId, incarnation: receipt.incarnation, error: `remote HSR launch ${launchId} is ${receipt.state}` };
          }
          const admitted = await readHsrMetaStrict(bee);
          if (admitted?.status === "running") {
            try {
              receipt = await reconcileReceiptHost(receipt, admitted);
              return launchResult(receipt);
            } catch (error) {
              return {
                ok: false,
                pending: true,
                launchId,
                incarnation: receipt.incarnation,
                error: `remote HSR launch ${launchId} ownership is unresolved: ${messageOf(error)}`,
              };
            }
          }
          if (admitted || handles.has(bee)) {
            return { ok: false, pending: true, launchId, incarnation: receipt.incarnation, error: `remote HSR launch ${launchId} has not reached running state` };
          }
          if (receipt.state === "dispatching") {
            return { ok: false, pending: true, launchId, incarnation: receipt.incarnation, error: `remote HSR launch ${launchId} dispatch outcome is unresolved` };
          }
          if (receipt.state !== "reserved") {
            return { ok: false, pending: true, launchId, incarnation: receipt.incarnation, error: `remote HSR launch ${launchId} has unresolved ${receipt.state} ownership` };
          }
          // A serve may have crashed after durably reserving but before forking.
          // Replaying the SAME launchId resumes that one request; it never creates
          // a second logical incarnation.
        } else {
          if (receipt && receipt.state !== "stopped") {
            return { ok: false, launchUnowned: true, error: `remote HSR name ${bee} is owned by launch ${receipt.launchId}` };
          }
          const previousLaunchId = typeof p.previousLaunchId === "string" && p.previousLaunchId
            ? p.previousLaunchId
            : undefined;
          if (receipt) {
            if (previousLaunchId !== receipt.launchId) {
              return { ok: false, launchUnowned: true, error: `remote HSR launch predecessor changed for ${bee}` };
            }
          } else if (previousLaunchId) {
            return { ok: false, launchUnowned: true, error: `remote HSR launch predecessor ${previousLaunchId} is no longer current for ${bee}` };
          }
          const unresolvedAnswer = await unresolvedAnswerOwnership(bee);
          if (unresolvedAnswer) {
            return {
              ok: false,
              launchUnowned: true,
              error: `remote HSR name ${bee} has unresolved provider-answer ownership for request ${unresolvedAnswer.operation.requestId}; reconcile it before replacement`,
            };
          }
          await assertNoUnresolvedHsrEventIntegrity(bee, "remote HSR spawn");
          // This remote node is the runtime authority. Refuse every existing run
          // identity until exact teardown removes it. Stat is fail-closed: only
          // ENOENT is absence; EACCES/EIO propagate through guarded().
          const runDirExists = await remoteHsrRunDirExistsStrict(bee);
          const existingMeta = await readHsrMetaStrict(bee);
          if (handles.has(bee) || existingMeta || runDirExists) {
            return { ok: false, launchUnowned: true, error: `remote HSR name ${bee} already has run state; kill it before reuse` };
          }
          receipt = {
            version: REMOTE_HSR_SAFETY_PROTOCOL,
            bee,
            launchId,
            incarnation: randomUUID(),
            ...(previousLaunchId ? { previousLaunchId } : {}),
            requestDigest,
            state: "reserved",
            createdAt: new Date().toISOString(),
            cwd,
            tier: adapter.tier(),
            ...(typeof p.sessionId === "string" && p.sessionId ? { sessionId: p.sessionId } : {}),
          };
          await writeRemoteHsrLaunchReceipt(receipt);
        }

        try {
          // This write is the irreversible boundary. A serve crash after this
          // point can never cause a same-launchId replay to fork a second child;
          // unresolved dispatching receipts require exact cleanup/reconciliation.
          receipt = { ...receipt, state: "dispatching" };
          await writeRemoteHsrLaunchReceipt(receipt);
          const result = await startRunner(params, {
            remoteLaunchId: receipt.launchId,
            remoteIncarnation: receipt.incarnation,
          });
          if (!result.ok) {
            return settleFailedLaunch(
              receipt,
              result.error ?? `remote HSR launch ${launchId} failed`,
              { dispatchNeverActivated: true },
            );
          }
          const admitted = await readHsrMetaStrict(bee);
          receipt = await reconcileReceiptHost(receipt, admitted);
          return launchResult(receipt);
        } catch (error) {
          // If the host reached running before the response path failed, the
          // durable meta+receipt pair is authoritative and the retry succeeds.
          const admitted = await readHsrMetaStrict(bee);
          if (admitted?.status === "running") {
            receipt = await reconcileReceiptHost(receipt, admitted);
            return launchResult(receipt);
          }
          return settleFailedLaunch(receipt, `remote HSR launch ${launchId} failed: ${messageOf(error)}`);
        }
      });
    }, { ok: false, launchUnowned: true, error: "runner-host is closing before spawn admission" }),

    // Read the authoritative admission head before constructing a NEW launch
    // request. The client copies a stopped head into previousLaunchId; spawn then
    // CASes it under the lifecycle lock so delayed first-arrivals cannot reorder.
    spawnHead: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const bee = requireRemoteBeeName(p.bee);
      const receipt = await readRemoteHsrLaunchReceiptStrict(bee);
      return receipt
        ? { ok: true, launchId: receipt.launchId, incarnation: receipt.incarnation, state: receipt.state }
        : { ok: true, state: "empty" };
    }),

    // Query the durable outcome of a possibly ambiguous spawn dispatch. This is
    // deliberately idempotent and returns the immutable incarnation token once
    // the reserved launch is bound to a running host.
    spawnReceipt: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; launchId?: unknown };
      const bee = requireRemoteBeeName(p.bee);
      const launchId = requireLaunchId(p.launchId);
      return withSessionLifecycleLock(bee, async () => {
        let receipt = await readRemoteHsrLaunchReceiptStrict(bee);
        if (!receipt || receipt.launchId !== launchId) return { ok: false, notFound: true, launchId };
        if (receipt.state === "stopped") return stoppedLaunchResult(receipt);
        if (receipt.state === "stopping") {
          return {
            ok: false,
            pending: true,
            launchId,
            incarnation: receipt.incarnation,
            error: `remote HSR launch ${launchId} is stopping`,
          };
        }
        const meta = await readHsrMetaStrict(bee);
        if (meta?.status === "running" && receipt.state !== "refreshing") {
          try {
            receipt = await reconcileReceiptHost(receipt, meta);
            return launchResult(receipt);
          } catch (error) {
            return {
              ok: false,
              pending: true,
              launchId,
              incarnation: receipt.incarnation,
              error: `remote HSR launch ${launchId} ownership is unresolved: ${messageOf(error)}`,
            };
          }
        }
        return {
          ok: false,
          pending: true,
          launchId,
          incarnation: receipt.incarnation,
          error: `remote HSR launch ${launchId} has not reached running state`,
        };
      });
    }),

    // UNIT 2 token refresh: re-deliver a FRESH access-token credential to a live
    // bee and get the harness to adopt it. A running codex app-server holds the
    // access token in memory and won't pick up a hot-swapped auth.json (on 401 it
    // reads the BLANKED refresh_token and dies), so adoption REQUIRES a restart:
    // stop the runner (keeping the run dir), shred the OLD credential, write the
    // NEW one into the bee's home, then restart the SAME runner with resume + the
    // learned thread id so codex re-reads auth.json at boot and resumes the thread.
    // Atomic per bee (a re-entrant refresh is refused). The daemon side mints; the
    // vault never reaches the remote.
    refreshCreds: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; creds?: unknown; launchId?: unknown; incarnation?: unknown };
      const bee = requireRemoteBeeName(p.bee);
      const creds = normalizeCreds(p.creds);
      if (!creds?.files?.length) return { ok: false, error: "refreshCreds requires credential files" };
      return withSessionLifecycleLock(bee, async () => {
        if (refreshing.has(bee)) return { ok: false, error: `refresh already in flight for ${bee}` };
        const authorization = await authorizeCurrentIncarnation(bee, locatorFromParams(p), {
          allowLegacy: true,
          allowRefreshing: true,
        });
        await assertNoUnresolvedRemoteAnswerOwnership(bee, "remote credential refresh");
        await assertNoUnresolvedHsrEventIntegrity(bee, "remote credential refresh");
        if (authorization.meta && authorization.receipt) {
          await assertHsrSourceEventLogIntegrity({
            bee,
            meta: authorization.meta,
            operation: "remote HSR credential refresh",
            remoteAuthority: {
              launchId: authorization.receipt.launchId,
              incarnation: authorization.receipt.incarnation,
            },
          });
        }
        const descriptor = await readHsrRestart(bee);
        if (!descriptor) return { ok: false, error: `no restart descriptor for ${bee} (spawned before refresh support?)` };
        // The learned provider session id (codex thread id) lives in THIS node's
        // meta. Once the old meta is removed at the refresh dispatch boundary,
        // the receipt carries it so a crash/retry can still reconcile exactly.
        let meta = authorization.meta;
        let receipt = authorization.receipt;
        const sessionId = meta?.sessionId ?? receipt?.sessionId;
        if (!sessionId) return { ok: false, error: `no learned session id for ${bee}; cannot resume` };

        // A previous refresh reached the irreversible replacement dispatch. It
        // may be replayed only by reconciling the successor meta; missing meta is
        // stop doubt, never permission to fork again.
        if (receipt?.state === "refreshing" && receipt.refreshPhase === "dispatching") {
          if (meta?.status === "running") {
            try {
              receipt = await reconcileReceiptHost(receipt, meta);
              await rebindRelayAfterHostRefresh(bee, meta, {
                launchId: receipt.launchId,
                incarnation: receipt.incarnation,
              });
            } catch (error) {
              return {
                ok: false,
                stopUnconfirmed: true,
                pending: true,
                error: `refresh successor ownership is unresolved for ${bee}: ${messageOf(error)}`,
              };
            }
            return {
              ok: true,
              bee,
              sessionId: meta.sessionId ?? sessionId,
              launchId: receipt.launchId,
              incarnation: receipt.incarnation,
            };
          }
          return {
            ok: false,
            stopUnconfirmed: true,
            pending: true,
            error: `refresh dispatch outcome is unresolved for ${bee}`,
          };
        }
        refreshing.add(bee);
        try {
          if (receipt && receipt.refreshPhase !== "stopped") {
            receipt = {
              ...receipt,
              state: "refreshing",
              refreshPhase: "stopping",
              sessionId,
            };
            await writeRemoteHsrLaunchReceipt(receipt);
          }
          // Stop the current runner but KEEP restart/events. A retry in the
          // durable `stopping` phase resumes the exact same stop.
          if (receipt?.refreshPhase !== "stopped" && !(await stopRunner(bee))) {
            return {
              ok: false,
              stopUnconfirmed: true,
              error: `stop unconfirmed for ${bee}; credentials not replaced`,
            };
          }
          // The source host may discover an event-persistence failure while
          // this exact stop is draining. The launch/incarnation survives a
          // refresh, so proceeding to B would otherwise graft A's unresolved
          // provider effects onto a new host epoch. Strict stopRunner proof
          // above is sufficient to confirm only the exact stopped A receipt;
          // retain the refresh authority for explicit reconciliation and send
          // zero credential/replacement bytes.
          const postStopIntegrity = await readHsrEventIntegrityReceipt(bee);
          if (postStopIntegrity?.phase === "unresolved") {
            const sourceHost = receipt?.host ?? (meta ? receiptHostIdentity(meta) : undefined);
            if (
              !receipt
              || !sourceHost
              || !hsrEventIntegrityReceiptOwnsHost(
                postStopIntegrity,
                sourceHost,
                { launchId: receipt.launchId, incarnation: receipt.incarnation },
              )
            ) {
              return {
                ok: false,
                stopUnconfirmed: true,
                pending: true,
                error: `event-integrity ownership changed while stopping refresh source ${bee}`,
              };
            }
            await recordHsrEventIntegrityStop(
              bee,
              postStopIntegrity.integrityId,
              sourceHost,
              "confirmed",
              "remote credential refresh exact-stopped the source host and child group",
            );
            return {
              ok: false,
              stopUnconfirmed: true,
              pending: true,
              error: `remote credential refresh stopped ${bee} with unresolved event history ${postStopIntegrity.integrityId}; reconcile before retry`,
            };
          }
          // Destroy the OLD delivered credential BEFORE writing the fresh one,
          // so the dead access token never lingers on the remote.
          try {
            await eraseCredentialsStrict(bee);
          } catch {
            return { ok: false, error: `old credential erasure unconfirmed for ${bee}; credentials not replaced` };
          }
          if (receipt) {
            receipt = { ...receipt, state: "refreshing", refreshPhase: "stopped", sessionId };
            await writeRemoteHsrLaunchReceipt(receipt);
            // The durable stopped phase is the proof that makes deleting the old
            // meta safe. A later dispatching receipt plus no meta stays ambiguous
            // forever instead of re-forking after a serve crash.
            meta = await readHsrMetaStrict(bee);
            if (meta && (!receipt.host || !receiptHostMatchesMeta(receipt, meta) || meta.status !== "exited")) {
              return { ok: false, stopUnconfirmed: true, error: `refresh source identity changed for ${bee}` };
            }
            await rm(hsrMetaPath(bee), { force: true });
            const sourceHost = receipt.host;
            if (!sourceHost) return { ok: false, stopUnconfirmed: true, error: `refresh source identity missing for ${bee}` };
            const {
              host: _host,
              terminalConsumerActivations: _terminalConsumerActivations,
              ...unbound
            } = receipt;
            receipt = {
              ...unbound,
              state: "refreshing",
              refreshPhase: "dispatching",
              refreshSourceHost: sourceHost,
            };
            await writeRemoteHsrLaunchReceipt(receipt);
          }

          let result: StartResult;
          try {
            result = await startRunner(
              {
                bee,
                kind: descriptor.kind,
                spec: { command: descriptor.command, args: descriptor.args, env: descriptor.env },
                cwd: descriptor.cwd,
                ...(descriptor.home ? { home: descriptor.home } : {}),
                ...(descriptor.model ? { model: descriptor.model } : {}),
                ...(descriptor.authKind ? { authKind: descriptor.authKind } : {}),
                ...(descriptor.comb ? { comb: descriptor.comb } : {}),
                ...(descriptor.parent ? { parent: descriptor.parent } : {}),
                creds,
              },
              {
                resume: true,
                sessionId,
                ...(receipt ? {
                  remoteLaunchId: receipt.launchId,
                  remoteIncarnation: receipt.incarnation,
                } : {}),
              },
            );
          } catch (error) {
            const admitted = await readHsrMetaStrict(bee);
            if (receipt && admitted?.status === "running") {
              receipt = await reconcileReceiptHost(receipt, admitted);
              try {
                await rebindRelayAfterHostRefresh(bee, admitted, {
                  launchId: receipt.launchId,
                  incarnation: receipt.incarnation,
                });
              } catch (handoffError) {
                return {
                  ok: false,
                  stopUnconfirmed: true,
                  pending: true,
                  error: `refresh observer handoff is unresolved for ${bee}: ${messageOf(handoffError)}`,
                };
              }
              return {
                ok: true,
                bee,
                sessionId: admitted.sessionId ?? sessionId,
                launchId: receipt.launchId,
                incarnation: receipt.incarnation,
              };
            }
            return {
              ok: false,
              stopUnconfirmed: true,
              error: `refresh dispatch outcome is unresolved for ${bee}: ${messageOf(error)}`,
            };
          }
          if (!result.ok) {
            if (receipt) {
              const { refreshSourceHost: _source, ...settled } = receipt;
              receipt = { ...settled, refreshPhase: "stopped", host: receipt.refreshSourceHost };
              await writeRemoteHsrLaunchReceipt(receipt);
            }
            return result;
          }
          const refreshedMeta = await readHsrMetaStrict(bee);
          if (!refreshedMeta || refreshedMeta.status !== "running") {
            return { ok: false, stopUnconfirmed: true, error: `refreshed host metadata is missing for ${bee}` };
          }
          if (receipt) receipt = await reconcileReceiptHost(receipt, refreshedMeta);
          try {
            await rebindRelayAfterHostRefresh(bee, refreshedMeta, {
              ...(receipt?.launchId ? { launchId: receipt.launchId } : {}),
              ...(receipt?.incarnation ? { incarnation: receipt.incarnation } : {}),
            });
          } catch (error) {
            return {
              ok: false,
              stopUnconfirmed: true,
              pending: true,
              error: `refresh observer handoff is unresolved for ${bee}: ${messageOf(error)}`,
            };
          }
          return {
            ok: true,
            bee,
            sessionId: result.sessionId ?? sessionId,
            ...(receipt ? { launchId: receipt.launchId, incarnation: receipt.incarnation } : {}),
          };
        } finally {
          refreshing.delete(bee);
        }
      });
    }),

    send: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        text?: unknown;
        mode?: unknown;
        deliveryId?: unknown;
        completionRequired?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      if (typeof p.deliveryId !== "string" || !p.deliveryId || p.deliveryId.length > 1_024) {
        return { ok: false, error: "deliveryId must be a non-empty string of at most 1024 characters" };
      }
      if (p.completionRequired !== undefined && typeof p.completionRequired !== "boolean") {
        return { ok: false, deliveryId: p.deliveryId, error: "completionRequired must be boolean when provided" };
      }
      const deliveryId = p.deliveryId;
      return withSessionLifecycleLock(bee, async () => {
        const authorization = await authorizeCurrentIncarnation(bee, locatorFromParams(p), { allowLegacy: true });
        await assertNoUnresolvedRemoteAnswerOwnership(bee, "remote send");
        await assertNoUnresolvedHsrEventIntegrity(bee, "remote send");
        if (authorization.meta && authorization.receipt) {
          await assertHsrSourceEventLogIntegrity({
            bee,
            meta: authorization.meta,
            operation: "remote HSR delivery",
            remoteAuthority: {
              launchId: authorization.receipt.launchId,
              incarnation: authorization.receipt.incarnation,
            },
          });
        }
        try {
          await hsrSubstrate().sendText(bee, String(p.text ?? ""), undefined, {
            deliveryId,
            ...(p.mode === "next-tool" ? { mode: "next-tool" } : {}),
            ...(p.completionRequired === true ? { completionRequired: true } : {}),
          });
          // Receipt phase is diagnostic only after the local coordinator has
          // returned authoritative success. A failed ancillary read must not
          // turn provider acceptance into a false definite delivery failure.
          const receipt = await readPendingHsrTurn(bee, deliveryId).catch(() => null);
          return {
            ok: true,
            deliveryId,
            ...(receipt ? { phase: receipt.phase } : {}),
          };
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          const reportedCode = code === "HIVE_HSR_DELIVERY_AMBIGUOUS"
              || code === "HIVE_HSR_DELIVERY_IN_FLIGHT"
              || code === "HIVE_HSR_DELIVERY_ID_CONFLICT"
              || code === "HIVE_HSR_DELIVERY_DISCARDED"
            ? code
            : undefined;
          const receipt = await readPendingHsrTurn(bee, deliveryId).catch(() => null);
          // A provider-bound phase is itself durable evidence that the call
          // crossed the safe queued boundary. If the coordinating host then
          // vanished or otherwise returned an untyped failure, never let an
          // outer controller treat that as a replay license.
          const durableCode = reportedCode ?? (
              receipt?.phase === "dispatching"
                || receipt?.phase === "accepted"
                || receipt?.phase === "started"
            ? "HIVE_HSR_DELIVERY_AMBIGUOUS"
            : undefined
          );
          return {
            ok: false,
            deliveryId,
            ...(durableCode ? { code: durableCode } : {}),
            ...(receipt ? { phase: receipt.phase } : {}),
            error: messageOf(error),
          };
        }
      });
    }),

    interrupt: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; launchId?: unknown; incarnation?: unknown };
      const bee = requireRemoteBeeName(p.bee);
      return withSessionLifecycleLock(bee, async () => {
        const authorization = await authorizeCurrentIncarnation(bee, locatorFromParams(p), { allowLegacy: true });
        await assertNoUnresolvedHsrEventIntegrity(bee, "remote interrupt");
        if (authorization.meta && authorization.receipt) {
          await assertHsrSourceEventLogIntegrity({
            bee,
            meta: authorization.meta,
            operation: "remote HSR interrupt",
            remoteAuthority: {
              launchId: authorization.receipt.launchId,
              incarnation: authorization.receipt.incarnation,
            },
          });
        }
        const result = await proxyCall(bee, "interrupt");
        return result.ok ? { ok: true } : result;
      });
    }),

    answer: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        operation?: unknown;
        answer?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      const answerParams = parseHsrAnswerRpcParams({ operation: p.operation, answer: p.answer });
      return withSessionLifecycleLock(bee, async () => {
        // Answers are mutations and must never fall back to bee-name authority.
        // The caller's canonical lifecycle admission supplies both immutable
        // remote tokens, while the answer operation itself binds request,
        // source generation, and content digest.
        const locator = locatorFromParams(p);
        const authorization = await authorizeCurrentIncarnation(bee, locator, { allowLegacy: false });
        const operationAuthority = assertAnswerOperationMatchesLocator(answerParams.operation, locator);
        if (
          authorization.receipt?.launchId !== operationAuthority.launchId
          || authorization.receipt.incarnation !== operationAuthority.incarnation
          || !authorization.meta
          || !hostIdentityMatchesMeta(answerParams.operation.host, authorization.meta)
        ) {
          throw new Error(`remote HSR answer ${answerParams.operation.requestId} does not own the current launch/host epoch`);
        }

        // The source event log may have lost the very prompt/effect this
        // answer would settle. Refuse before publishing a node answer offer.
        await assertNoUnresolvedHsrEventIntegrity(bee, "remote HSR answer");
        if (authorization.meta && authorization.receipt) {
          await assertHsrSourceEventLogIntegrity({
            bee,
            meta: authorization.meta,
            operation: "remote HSR answer",
            remoteAuthority: {
              launchId: authorization.receipt.launchId,
              incarnation: authorization.receipt.incarnation,
            },
          });
        }

        const unresolved = await unresolvedAnswerOwnership(bee);
        if (unresolved && !sameAnswerOperation(unresolved.operation, answerParams.operation)) {
          return {
            ok: true,
            result: {
              status: "conflict",
              reason: `HSR answer request ${unresolved.operation.requestId} already has unresolved provider ownership`,
            } satisfies HsrAnswerRpcResult,
          };
        }

        // Rolling-upgrade honesty: never offer on this node until the exact
        // per-Bee host proves the durable answer-receipt protocol. A complete
        // refusal is returned before node sending/provider I/O so the caller
        // can safely return its controller receipt to offered. A pre-existing
        // different unresolved operation conflicts above without consulting a
        // replacement provider process.
        const capabilities = await proxyCall(bee, "answerCapabilities");
        if (!capabilities.ok) {
          return {
            ok: false,
            error: `per-Bee host lacks durable answer receipt capability: ${capabilities.error ?? "unavailable"}`,
          };
        }
        try {
          parseHsrAnswerHostCapabilities(capabilities.result);
        } catch (error) {
          return {
            ok: false,
            error: `per-Bee host returned an invalid answer receipt capability: ${messageOf(error)}`,
          };
        }

        let offered: HsrAnswerReceipt;
        try {
          // The controller-side offer lives on a different machine. Publish the
          // exact same operation on this authority before the per-Bee host can
          // cross its provider dispatch boundary.
          offered = await offerHsrAnswerOperation(bee, answerParams.operation);
        } catch (error) {
          if (error instanceof HsrAnswerConflictError) {
            return { ok: true, result: { status: "conflict", reason: error.message } satisfies HsrAnswerRpcResult };
          }
          throw error;
        }
        const prior = offered.phase === "sending" && offered.sendingAuthority === "controller"
          ? null
          : answerResultForReceipt(
              offered,
              `HSR answer ${answerParams.operation.requestId} crossed dispatch without a terminal provider receipt`,
            );
        if (prior) return { ok: true, result: prior };

        // Publish node-authority transport ownership immediately before the
        // per-Bee control RPC can leave. The host coordinator accepts only
        // this phase, so a delayed first handler can never dispatch from a
        // merely offered receipt after controller replacement.
        await markHsrAnswerOperationSending(bee, answerParams.operation, "node");
        const proxied = await proxyCall(bee, "answer", answerParams);
        if (proxied.ok) {
          try {
            return { ok: true, result: parseHsrAnswerRpcResult(proxied.result) };
          } catch (error) {
            // A malformed/missing outer host response is only definite if the
            // durable node-local receipt still proves the operation was merely
            // offered. Otherwise it may follow provider acceptance.
            try {
              const receipt = await readHsrAnswerReceipt(bee, answerParams.operation);
              if (receipt) {
                const durable = answerResultForReceipt(
                  receipt,
                  `per-Bee host returned an invalid response after answer dispatch: ${messageOf(error)}`,
                );
                if (durable) return { ok: true, result: durable };
              }
              return { ok: false, error: `per-Bee host returned an invalid answer result: ${messageOf(error)}` };
            } catch (receiptError) {
              return {
                ok: true,
                result: {
                  status: "ambiguous",
                  reason: `per-Bee host answer response and durable receipt are unreadable: ${messageOf(receiptError)}`,
                } satisfies HsrAnswerRpcResult,
              };
            }
          }
        }

        // `proxyCall` intentionally collapses connect and reply failures. Read
        // the durable receipt before classifying: offered proves no provider
        // dispatch; dispatching/settled/ambiguous must never be retried as new.
        try {
          const receipt = await readHsrAnswerReceipt(bee, answerParams.operation);
          if (receipt) {
            const durable = answerResultForReceipt(
              receipt,
              `per-Bee host answer RPC outcome was lost after durable dispatch: ${proxied.error ?? "unknown"}`,
            );
            if (durable) return { ok: true, result: durable };
          }
          return { ok: false, error: proxied.error ?? `per-Bee host answer failed for ${bee}` };
        } catch (error) {
          return {
            ok: true,
            result: {
              status: "ambiguous",
              reason: `per-Bee host answer failed and its durable receipt is unreadable: ${messageOf(error)}`,
            } satisfies HsrAnswerRpcResult,
          };
        }
      });
    }),

    answerReconcile: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        operation?: unknown;
        verdict?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      if (p.verdict !== "delivered" && p.verdict !== "discard") {
        return { ok: false, error: "answer reconciliation verdict must be delivered or discard" };
      }
      return withSessionLifecycleLock(bee, async () => {
        const operation = p.operation as HsrAnswerOperation;
        const authority = await authorizeAnswerReconciliation(bee, operation, locatorFromParams(p));
        const before = await readHsrAnswerReceipt(bee, operation);
        if (!before) {
          // No node-local receipt is authoritative zero-effect evidence only
          // after this exact launch has moved away from the operation's host
          // epoch (refresh) or stopped. In that state a delayed old answer RPC
          // is host/token-rejected under this same lifecycle lock, so discard
          // can safely unblock the controller's local-only sending receipt.
          // `delivered` can never be inferred from absence.
          const currentHostOwnsOperation = authority.host !== undefined && sameAnswerOperation(
            operation,
            { ...operation, host: authority.host },
          );
          if (p.verdict === "discard" && (authority.state === "stopped" || !currentHostOwnsOperation)) {
            return { ok: true, result: { status: "discarded" } satisfies HsrAnswerRpcResult };
          }
          return {
            ok: true,
            result: {
              status: "conflict",
              reason: p.verdict === "delivered"
                ? `HSR answer ${String((operation as { requestId?: unknown }).requestId ?? "unknown")} has no durable remote receipt proving delivery`
                : `HSR answer ${String((operation as { requestId?: unknown }).requestId ?? "unknown")} may still reach its current host and cannot be discarded from absence`,
            } satisfies HsrAnswerRpcResult,
          };
        }
        const desiredPhase = p.verdict === "delivered" ? "settled" : "discarded";
        if (before.phase === desiredPhase) {
          return {
            ok: true,
            result: answerResultForReceipt(before, `HSR answer ${before.operation.requestId} is unresolved`)!,
          };
        }
        if (before.phase === "settled" || before.phase === "discarded") {
          return {
            ok: true,
            result: {
              status: "conflict",
              reason: `HSR answer ${before.operation.requestId} is already ${before.phase}`,
            } satisfies HsrAnswerRpcResult,
          };
        }
        const reconciled = await reconcileHsrAnswerOperation(
          bee,
          operation,
          p.verdict as HsrAnswerReconciliationVerdict,
        );
        return {
          ok: true,
          result: answerResultForReceipt(
            reconciled,
            `HSR answer ${reconciled.operation.requestId} remains unresolved after reconciliation`,
          )!,
        };
      });
    }),

    eventIntegrityReconcile: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        integrityId?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
        deliveryVerdicts?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      if (typeof p.integrityId !== "string" || !p.integrityId) {
        return { ok: false, error: "integrityId required" };
      }
      return withSessionLifecycleLock(bee, async () => {
        const locator = locatorFromParams(p);
        const authority = await readRemoteHsrLaunchReceiptStrict(bee);
        if (
          !authority
          || !locator.launchId || locator.launchId !== authority.launchId
          || !locator.incarnation || locator.incarnation !== authority.incarnation
        ) {
          return { ok: false, error: `remote HSR launch authority does not own event-integrity receipt ${p.integrityId}` };
        }
        const receipt = await readHsrEventIntegrityReceipt(bee);
        if (!receipt || receipt.integrityId !== p.integrityId) {
          return { ok: false, error: `HSR event-integrity receipt ${p.integrityId} is not current for ${bee}` };
        }
        if (
          receipt.remoteAuthority?.launchId !== authority.launchId
          || receipt.remoteAuthority?.incarnation !== authority.incarnation
          || (authority.host && !hsrEventIntegrityReceiptOwnsHost(
              receipt,
              authority.host,
              { launchId: authority.launchId, incarnation: authority.incarnation },
            ))
        ) {
          return { ok: false, error: `HSR event-integrity receipt ${p.integrityId} does not own the requested remote generation` };
        }
        if (p.deliveryVerdicts !== undefined) {
          if (!p.deliveryVerdicts || typeof p.deliveryVerdicts !== "object" || Array.isArray(p.deliveryVerdicts)) {
            return { ok: false, error: "deliveryVerdicts must be an object" };
          }
          for (const [deliveryId, verdict] of Object.entries(p.deliveryVerdicts as Record<string, unknown>)) {
            if (verdict !== "delivered" && verdict !== "discarded") {
              return { ok: false, error: `invalid event-integrity delivery verdict for ${deliveryId}` };
            }
            const recorded = await recordHsrEventIntegrityDeliveryVerdict(bee, deliveryId, verdict);
            if (!recorded) {
              return { ok: false, error: `delivery ${deliveryId} does not belong to event-integrity receipt ${p.integrityId}` };
            }
          }
        }
        const settled = await acknowledgeHsrEventIntegrityLoss(bee, p.integrityId);
        return { ok: true, integrityId: settled.integrityId, phase: settled.phase, receipt: settled };
      });
    }),

    pendingInput: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; launchId?: unknown; incarnation?: unknown };
      const bee = requireRemoteBeeName(p.bee);
      return withSessionLifecycleLock(bee, async () => {
        const authorization = await authorizeCurrentIncarnation(bee, locatorFromParams(p), { allowLegacy: false });
        if (!authorization.meta || authorization.meta.status !== "running") {
          throw new Error(`remote HSR pending input for ${bee} has no current host epoch`);
        }
        return {
          pending: await pendingNeedsInput(bee),
          host: receiptHostIdentity(authorization.meta),
        };
      });
    }),

    stop: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; launchId?: unknown; incarnation?: unknown };
      const bee = requireRemoteBeeName(p.bee);
      return withSessionLifecycleLock(bee, async () => {
        const authorization = await authorizeCurrentIncarnation(bee, locatorFromParams(p), { allowLegacy: true });
        if (authorization.receipt) {
          await writeRemoteHsrLaunchReceipt({ ...authorization.receipt, state: "stopping" });
        }
        const result = await proxyCall(bee, "stop");
        return result.ok ? { ok: true, result: result.result } : { ...result, stopUnconfirmed: true };
      });
    }),

    snapshot: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; lines?: unknown };
      const args = typeof p.lines === "number" ? { lines: p.lines } : {};
      return await proxyCall(requireRemoteBeeName(p.bee), "snapshot", args);
    }),

    // The bounded events.jsonl tail for a bee, optionally only events strictly
    // newer than `afterTs` (epoch ms). Read straight off this node's run dir —
    // no live control socket needed, so it also serves exited bees. The local
    // event mirror (APIA-94) uses it to backfill events emitted before its
    // observe subscription attached.
    //
    // Cell-transport seq cursor: `afterSeq` (per-bee monotonic seq, wins over
    // afterTs when both are sent) returns exactly the events with
    // `seq > afterSeq` — the exact-resume path for consumers whose connection
    // died. When the cursor points below the oldest retained seq (compaction
    // folded it away), the result carries an explicit `gap: {fromSeq, toSeq}`
    // so the consumer can resynchronize instead of silently diverging.
    events: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        consumerId?: unknown;
        afterTs?: unknown;
        afterSeq?: unknown;
        pageToken?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      const read = async (): Promise<Record<string, unknown>> => {
        const afterSeq = typeof p.afterSeq === "number" && Number.isFinite(p.afterSeq) ? p.afterSeq : undefined;
        if (afterSeq !== undefined) {
          let consumerId: string;
          try {
            consumerId = consumerIdFromParams(p);
            const pageToken = typeof p.pageToken === "string" && p.pageToken.length > 0
              ? p.pageToken
              : undefined;
            const page = await readHsrEventsPageAfterSeqStrict(bee, afterSeq, consumerId, pageToken);
            return { ok: true, ...page };
          } catch (error) {
            return {
              ok: false,
              ...(error instanceof HsrSourceEventLogBusyError || error instanceof HsrEventReplayPageTokenError
                ? {}
                : { integrityFailure: true }),
              error: messageOf(error),
            };
          }
        }
        const afterTs = typeof p.afterTs === "number" && Number.isFinite(p.afterTs) ? p.afterTs : undefined;
        const events = await readEventTail(bee);
        return {
          ok: true,
          events: afterTs === undefined ? events : events.filter((event) => typeof event.ts === "number" && event.ts > afterTs),
        };
      };
      const locator = locatorFromParams(p);
      if (!locator.launchId && !locator.incarnation) return read();
      return withSessionLifecycleLock(bee, async () => {
        // A lost reply to the post-activation final ack may leave the stopped
        // run dir already reclaimed. Consult the purge-surviving exact receipt
        // before ordinary history authorization (which correctly requires the
        // disposable meta/run dir) so the same stable consumer can retry.
        const afterSeq = typeof p.afterSeq === "number" && Number.isFinite(p.afterSeq) ? p.afterSeq : undefined;
        const pageToken = typeof p.pageToken === "string" && p.pageToken.length > 0
          ? p.pageToken
          : undefined;
        if (afterSeq !== undefined && !pageToken) {
          const consumerId = consumerIdFromParams(p);
          const receipt = await readRemoteHsrLaunchReceiptStrict(bee);
          const activation = receipt?.terminalConsumerActivations?.[consumerId];
          if (
            receipt?.state === "stopped"
            && receipt.launchId === locator.launchId
            && receipt.incarnation === locator.incarnation
            && activation?.throughSeq === afterSeq
            && !(await remoteHsrRunDirExistsStrict(bee))
          ) {
            return { ok: true, events: [], throughSeq: afterSeq, hasMore: false };
          }
        }
        const authority = await authorizeEventHistory(bee, locator);
        if (authority.meta?.eventIntegrityFailure) {
          return { ok: false, integrityFailure: true, error: authority.meta.eventIntegrityFailure };
        }
        return read();
      });
    }),

    // Advance a bee's consumer ack watermark (cell transport). Events at or
    // below the returned `ackedSeq` become foldable by compaction; everything
    // above it is retained verbatim for exact seq-cursor resume, even past the
    // size cap. The watermark is clamped to the issued high-water and never
    // regresses, so a stale/duplicate ack is harmless.
    ackEvents: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        consumerId?: unknown;
        upToSeq?: unknown;
        terminalActivated?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      if (typeof p.upToSeq !== "number" || !Number.isFinite(p.upToSeq) || p.upToSeq < 1) {
        return { ok: false, error: "upToSeq must be a positive number" };
      }
      const upToSeq = p.upToSeq;
      if (p.terminalActivated !== undefined && p.terminalActivated !== true) {
        return { ok: false, error: "terminalActivated must be true when present" };
      }
      return withSessionLifecycleLock(bee, async () => {
        const locator = locatorFromParams(p);
        const consumerId = consumerIdFromParams(p);
        const existingReceipt = await readRemoteHsrLaunchReceiptStrict(bee);
        const existingActivation = existingReceipt?.terminalConsumerActivations?.[consumerId];
        if (
          p.terminalActivated === true
          && existingReceipt?.state === "stopped"
          && existingReceipt.launchId === locator.launchId
          && existingReceipt.incarnation === locator.incarnation
          && existingActivation
          && existingActivation.throughSeq >= upToSeq
          && !(await remoteHsrRunDirExistsStrict(bee))
        ) {
          return { ok: true, ackedSeq: existingActivation.throughSeq };
        }
        const authority = await authorizeEventHistory(bee, locator);
        if (authority.meta?.eventIntegrityFailure) {
          return { ok: false, integrityFailure: true, error: authority.meta.eventIntegrityFailure };
        }
        const ackedSeq = await ackHsrEvents(bee, upToSeq, consumerId);
        let receipt = authority.receipt;
        if (p.terminalActivated === true) {
          if (!receipt || authority.meta?.status !== "exited") {
            return {
              ok: false,
              integrityFailure: true,
              error: `remote HSR terminal activation for ${bee} requires exact exited launch authority`,
            };
          }
          const prior = receipt.terminalConsumerActivations?.[consumerId];
          if (!prior || ackedSeq > prior.throughSeq) {
            receipt = {
              ...receipt,
              terminalConsumerActivations: {
                ...receipt.terminalConsumerActivations,
                [consumerId]: {
                  throughSeq: ackedSeq,
                  activatedAt: new Date().toISOString(),
                  host: receiptHostIdentity(authority.meta),
                },
              },
            };
          }
          // Persist (or re-persist) the generation-bound activation OUTSIDE
          // the disposable run dir before deletion. The receipt writer commits
          // the authority head before its per-launch history. If that second
          // write failed on a prior attempt, the head already contains this
          // idempotent activation; rewriting it here heals the history before
          // source reclamation instead of deleting the only retryable bytes.
          await writeRemoteHsrLaunchReceipt(receipt);
        }
        if (authority.receipt?.state === "stopped" && authority.meta?.status === "exited") {
          await removeHsrRunDirIfConsumersCaughtUp(bee, receipt?.terminalConsumerActivations);
        }
        return { ok: true, ackedSeq };
      });
    }),

    // Establish (or ref-count into) a relay of the bee's live event stream. Each
    // `event` the bee's control socket pushes is re-broadcast to ALL clients as
    // `hsr.event` { bee, event } — the local transport re-emits it upward.
    // `sync` (reconnect reconciliation, HIVE-56): instead of incrementing, SET
    // the refcount to the caller's subscriber count — a re-issued observe after
    // a tunnel flap must not inflate the count past what unobserve will return.
    observe: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        consumerId?: unknown;
        afterSeq?: unknown;
        sync?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      const consumerId = consumerIdFromParams(p);
      const afterSeq = p.afterSeq === undefined ? 0 : Number(p.afterSeq);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        return { ok: false, error: "afterSeq must be a non-negative safe integer" };
      }
      const sync = typeof p.sync === "number" && Number.isFinite(p.sync) ? Math.max(1, Math.floor(p.sync)) : undefined;
      return withSessionLifecycleLock(bee, async () => {
        const authorization = await authorizeCurrentIncarnation(bee, locatorFromParams(p), { allowLegacy: true });
        // Establish the durable retention floor before acknowledging the
        // observer. From this point every exact resume has a strict seq.json
        // high-water, and compaction cannot fold an unacknowledged event.
        try {
          await markHsrConsumerSubscribedStrict(bee, consumerId, afterSeq);
        } catch (error) {
          return {
            ok: false,
            ...(error instanceof HsrSourceEventLogBusyError ? {} : { integrityFailure: true }),
            error: messageOf(error),
          };
        }
        const launchId = authorization.receipt?.launchId;
        const incarnation = authorization.receipt?.incarnation;
        let existing = relays.get(bee);
        if (
          existing
          && (existing.launchId !== launchId || existing.incarnation !== incarnation)
        ) {
          // A relay is generation-owned. Never reuse an old control-socket
          // subscription for a same-name successor, even if stale teardown
          // failed to release its refcount.
          closeRelay(bee);
          existing = undefined;
        }
        if (existing) {
          const priorCount = existing.consumers.get(consumerId) ?? 0;
          existing.consumers.set(consumerId, sync ?? priorCount + 1);
          return { ok: true };
        }
        const meta = await readHsrMeta(bee);
        if (!meta || meta.status !== "running" || !meta.controlSocket) {
          return { ok: false, error: `no live host for ${bee}` };
        }
        let client: RpcClient;
        try {
          client = await connectRpcClient(meta.controlSocket);
        } catch (error) {
          return { ok: false, error: messageOf(error) };
        }
        const unsubscribe = client.on("event", (event) => {
          try {
            // RpcServer broadcasts to every controller connection. Bind each
            // notification to the receipt generation captured at admission so
            // stale clients can discard successor events before projection.
            server?.broadcast("hsr.event", {
              bee,
              event,
              ...(launchId ? { launchId } : {}),
              ...(incarnation ? { incarnation } : {}),
            });
          } catch {
            // A closing socket must not wedge the relay pump.
          }
        });
        relays.set(bee, {
          client,
          consumers: new Map([[consumerId, sync ?? 1]]),
          unsubscribe,
          ...(launchId ? { launchId } : {}),
          ...(incarnation ? { incarnation } : {}),
        });
        void client.closed.then(() => {
          const relay = relays.get(bee);
          if (!relay || relay.client !== client) return;
          if (refreshing.has(bee)) {
            // Preserve the caller's refcount/authority intent across the
            // stop→restart window. Refresh rebinds it to the successor socket
            // before releasing the lifecycle lock.
            relay.client = undefined;
            relay.unsubscribe = undefined;
          } else {
            relays.delete(bee);
          }
        });
        return { ok: true };
      });
    }),

    // Release a relay subscription (HIVE-56): decrement the refcount by `count`
    // (default 1) and close the per-bee control-socket client once it hits zero.
    // Idempotent — a relay already gone (bee killed, client.closed pruned it)
    // is a success, so teardown/unsubscribe races never surface errors.
    unobserve: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        consumerId?: unknown;
        count?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      const consumerId = consumerIdFromParams(p);
      const count = typeof p.count === "number" && Number.isFinite(p.count) ? Math.max(1, Math.floor(p.count)) : 1;
      return withSessionLifecycleLock(bee, async () => {
        await authorizeCurrentIncarnation(bee, locatorFromParams(p), { allowLegacy: true });
        const relay = relays.get(bee);
        if (!relay) return { ok: true };
        const nextCount = Math.max(0, (relay.consumers.get(consumerId) ?? 0) - count);
        if (nextCount > 0) relay.consumers.set(consumerId, nextCount);
        else relay.consumers.delete(consumerId);
        if ([...relay.consumers.values()].some((value) => value > 0)) return { ok: true };
        closeRelay(bee);
        return { ok: true };
      });
    }),

    // Explicit operator settlement for a durable controller that will never
    // return. The exact stopped launch tokens authorize discarding only that
    // consumer's retained suffix; the lost seq range is persisted in seq.json
    // before the compaction pin is removed.
    discardEventConsumer: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        consumerId?: unknown;
        launchId?: unknown;
        incarnation?: unknown;
      };
      const bee = requireRemoteBeeName(p.bee);
      const consumerId = consumerIdFromParams(p);
      const locator = locatorFromParams(p);
      return withSessionLifecycleLock(bee, async () => {
        const receipt = await readRemoteHsrLaunchReceiptStrict(bee);
        if (
          !receipt
          || receipt.state !== "stopped"
          || receipt.launchId !== locator.launchId
          || receipt.incarnation !== locator.incarnation
        ) {
          return { ok: false, error: `remote HSR stopped launch tokens do not authorize consumer discard for ${bee}` };
        }
        const discarded = await discardHsrEventConsumer(bee, consumerId, {
          launchId: receipt.launchId,
          incarnation: receipt.incarnation,
        });
        let settledReceipt = receipt;
        if (receipt.terminalConsumerActivations?.[consumerId]) {
          const terminalConsumerActivations = { ...receipt.terminalConsumerActivations };
          delete terminalConsumerActivations[consumerId];
          settledReceipt = {
            ...receipt,
            ...(Object.keys(terminalConsumerActivations).length > 0
              ? { terminalConsumerActivations }
              : { terminalConsumerActivations: undefined }),
          };
          // A later re-admission of the same stable id must not inherit a
          // pre-discard activation proof. Clear the outside proof before any
          // reclaim attempt; a failed write leaves history safely retained.
          await writeRemoteHsrLaunchReceipt(settledReceipt);
        }
        const reclaimed = await removeHsrRunDirIfConsumersCaughtUp(
          bee,
          settledReceipt.terminalConsumerActivations,
        );
        return { ok: true, ...discarded, reclaimed };
      });
    }),

    // Stop the runner (control-socket stop + fallback) and remove its run dir.
    // The LOCAL side keeps the SessionRecord — this only reclaims remote state.
    kill: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; launchId?: unknown; incarnation?: unknown };
      const bee = requireRemoteBeeName(p.bee);
      const locator = locatorFromParams(p);
      return withSessionLifecycleLock(bee, async () => {
        const receipt = await readRemoteHsrLaunchReceiptStrict(bee);
        if (receipt) {
          if (!locator.launchId || locator.launchId !== receipt.launchId) {
            return { ok: false, error: `remote HSR launch id does not own ${bee}` };
          }
          if (locator.incarnation && locator.incarnation !== receipt.incarnation) {
            return { ok: false, error: `remote HSR incarnation token does not own ${bee}` };
          }
          if (receipt.state === "stopped" && !(await remoteHsrRunDirExistsStrict(bee))) {
            return { ok: true, stdout: "", stderr: "", exitCode: 0, incarnationStopped: true };
          }
          const integrity = await readHsrEventIntegrityReceipt(bee);
          if (!integrity || integrity.phase !== "unresolved") {
            const meta = await readHsrMetaStrict(bee);
            if (meta) {
              await assertHsrSourceEventLogIntegrity({
                bee,
                meta,
                operation: "remote HSR teardown",
                remoteAuthority: {
                  launchId: receipt.launchId,
                  incarnation: receipt.incarnation,
                },
              });
            }
          }
          const cleanup = await stopAndTombstoneLaunch(receipt);
          if (!cleanup.ok) return { ok: false, error: cleanup.error ?? `cleanup unconfirmed for ${bee}` };
          if (cleanup.terminalHistoryPending) {
            const commands = (cleanup.pendingConsumers ?? [])
              .map((consumer) => `hive hsr-reconcile ${bee} --discard-consumer ${consumer.consumerId}`)
              .join("; ");
            return {
              ok: false,
              incarnationStopped: true,
              terminalHistoryPending: true,
              ...(cleanup.pendingConsumers ? { pendingConsumers: cleanup.pendingConsumers } : {}),
              error: `remote HSR ${bee} is stopped; terminal event history is retained until every durable consumer acknowledges and activates it${commands ? `; stale consumers may be explicitly discarded with: ${commands}` : ""}`,
            };
          }
          return { ok: true, stdout: "", stderr: "", exitCode: 0, incarnationStopped: true };
        }

        // A launchId-only cleanup is also the reconciliation path for a request
        // that provably never reached this host. It succeeds only when strict
        // stat confirms there is no runtime state; existing unowned state fails
        // closed and can be handled only by the explicit legacy operator path.
        if (locator.launchId || locator.incarnation) {
          if (await remoteHsrRunDirExistsStrict(bee)) {
            return { ok: false, error: `remote HSR launch receipt for ${bee} is absent while run state exists` };
          }
          if (!locator.launchId) {
            return { ok: false, error: `remote HSR launch id required to cancel an unseen launch for ${bee}` };
          }
          const launchId = requireLaunchId(locator.launchId);
          await writeRemoteHsrLaunchCancellation(bee, launchId);
          return { ok: true, stdout: "", stderr: "", exitCode: 0, incarnationStopped: true };
        }

        // Backward-compatible cleanup for bees created by an old runner-host.
        if (!(await stopRunner(bee))) {
          return { ok: false, error: `stop unconfirmed for ${bee}; run state preserved` };
        }
        const legacyIntegrity = await readHsrEventIntegrityReceipt(bee);
        if (legacyIntegrity?.phase === "unresolved") {
          return {
            ok: false,
            error: `HSR event history ${legacyIntegrity.integrityId} is unresolved for ${bee}; run state preserved`,
          };
        }
        closeRelay(bee);
        try {
          await eraseCredentialsStrict(bee);
        } catch {
          return { ok: false, error: `credential erasure unconfirmed for ${bee}; run state preserved` };
        }
        try {
          await removeHsrRunDirUnderEventAuthority(bee);
        } catch {
          return { ok: false, error: `run state removal unconfirmed for ${bee}` };
        }
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      });
    }),

    // APIA-95 working-copy provisioning: clone (or idempotently reuse) a git
    // checkout under this node's `<storeRoot>/worktrees/<name>` so a spawn can run
    // the bee inside a fresh checkout of a repo/branch. Never throws (git failures
    // surface as { ok:false, error }). Groundwork for Apiary's "where-it-lives"
    // selector on non-local substrates (substrates-research §5.3 / arch §7.5).
    provision: guarded((params) => provisionCheckout((params ?? {}) as ProvisionParams)),

    // Enumerate this node's existing checkouts (best-effort; tolerates non-git dirs).
    listCheckouts: guarded(() => enumerateCheckouts()),
  };

  return {
    methods,
    attachServer(s: RpcServer): void {
      server = s;
    },
    beginClose,
    async close(): Promise<void> {
      beginClose();
      await closeAuthority();
    },
  };
}

/** Start the runner-host control socket. Returns an RpcServer whose close also tears down the controller. */
export async function serve(socketPath: string, options: RunnerHostControllerOptions = {}): Promise<RpcServer> {
  // Starting an observer is not a bee event. In particular, never run the old
  // bulk orphan reaper here: a locale-dependent birth mismatch during a
  // reinstall killed live runners and stamped their metas exited. The daemon's
  // proof-gated re-adoption/supervision path owns any later recovery action.
  const controller = buildController(options);
  const server = await startRpcServer({ socketPath, methods: controller.methods });
  controller.attachServer(server);
  return {
    path: server.path,
    broadcast: (method, params) => server.broadcast(method, params),
    connectionCount: () => server.connectionCount(),
    broadcastDroppedCount: () => server.broadcastDroppedCount(),
    async close(): Promise<void> {
      controller.beginClose();
      await controller.close();
      await server.close();
    },
  };
}

type RunnerHostPing = {
  ok?: boolean;
  version?: string;
  safetyProtocol?: number;
  error?: string;
};

function cliFlag(argv: string[], name: string): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === name) return argv[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

async function liveServePing(socketPath: string): Promise<{ client: RpcClient; ping: RunnerHostPing }> {
  const client = await connectRpcClient(socketPath);
  try {
    const ping = (await client.call("ping", undefined, { timeoutMs: 5_000 })) as RunnerHostPing | null;
    if (!ping || typeof ping !== "object") throw new Error("live serve returned a malformed ping");
    return { client, ping };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function probeLiveServe(socketPath: string, expectedVersion: string): Promise<void> {
  const expectedHandshake = runnerHostHandshakeVersion(expectedVersion);
  const { client, ping } = await liveServePing(socketPath);
  try {
    if (!ping.ok) throw new Error(ping.error ?? "live serve reported not-ok");
    if (ping.version !== expectedHandshake) {
      throw new Error(`live serve version mismatch: reported ${JSON.stringify(ping.version)}, expected ${JSON.stringify(expectedHandshake)}`);
    }
    if (
      typeof ping.safetyProtocol !== "number"
      || ping.safetyProtocol < REMOTE_HSR_SAFETY_PROTOCOL
    ) {
      throw new Error(`live serve lacks safety protocol ${REMOTE_HSR_SAFETY_PROTOCOL}`);
    }
  } finally {
    client.close();
  }
}

async function upgradeLiveServe(socketPath: string, targetVersion: string): Promise<"already-current" | "upgraded"> {
  const targetHandshake = runnerHostHandshakeVersion(targetVersion);
  const { client, ping } = await liveServePing(socketPath);
  try {
    if (!ping.ok || typeof ping.version !== "string") {
      throw new Error(ping.error ?? "live serve did not report an authoritative version");
    }
    if (
      ping.version === targetHandshake
      && typeof ping.safetyProtocol === "number"
      && ping.safetyProtocol >= REMOTE_HSR_SAFETY_PROTOCOL
    ) {
      return "already-current";
    }
    const prepared = (await client.call("prepareUpgrade", {
      expectedVersion: ping.version,
      replacementVersion: targetHandshake,
    }, { timeoutMs: 120_000 })) as {
      ok?: boolean;
      version?: string;
      replacementVersion?: string;
      safetyProtocol?: number;
      token?: string;
      error?: string;
      active?: string[];
    } | null;
    if (
      !prepared?.ok
      || prepared.version !== ping.version
      || prepared.replacementVersion !== targetHandshake
      || typeof prepared.token !== "string"
      || !prepared.token
      || typeof prepared.safetyProtocol !== "number"
      || prepared.safetyProtocol < REMOTE_HSR_SAFETY_PROTOCOL
    ) {
      throw new Error(
        prepared?.error
          ?? `live serve cannot prove a quiescent authority handoff; stop/retire remote bees and retry bootstrap`,
      );
    }
    try {
      const committed = (await client.call("commitUpgrade", {
        token: prepared.token,
        replacementVersion: targetHandshake,
      }, { timeoutMs: 5_000 })) as { ok?: boolean; error?: string } | null;
      if (committed && committed.ok === false) throw new Error(committed.error ?? "upgrade commit rejected");
    } catch {
      // The commit intentionally closes this connection. Socket disappearance
      // below is the authoritative completion proof, not the RPC reply.
    }
  } finally {
    client.close();
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!existsSync(socketPath)) return "upgraded";
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`prepared runner-host upgrade did not release ${socketPath}`);
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];

  if (cmd === "--version" || cmd === "version") {
    process.stdout.write(`${versionString()}\n`);
    return 0;
  }

  if (cmd === "probe") {
    const socketPath = cliFlag(argv, "--socket");
    const expectedVersion = cliFlag(argv, "--expect-version");
    if (!socketPath || !expectedVersion) {
      process.stderr.write("runner-host probe: --socket <path> and --expect-version <version> are required\n");
      return 2;
    }
    await probeLiveServe(socketPath, expectedVersion);
    process.stdout.write(`${runnerHostHandshakeVersion(expectedVersion)}\n`);
    return 0;
  }

  if (cmd === "upgrade") {
    const socketPath = cliFlag(argv, "--socket");
    const targetVersion = cliFlag(argv, "--target-version");
    if (!socketPath || !targetVersion) {
      process.stderr.write("runner-host upgrade: --socket <path> and --target-version <version> are required\n");
      return 2;
    }
    const result = await upgradeLiveServe(socketPath, targetVersion);
    process.stdout.write(`${result}\n`);
    return 0;
  }

  if (cmd === "serve") {
    // Parse `--socket <path>` (or `--socket=<path>`).
    let socketPath: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--socket") {
        socketPath = argv[++i];
      } else if (arg.startsWith("--socket=")) {
        socketPath = arg.slice("--socket=".length);
      }
    }
    if (!socketPath) {
      process.stderr.write("runner-host serve: --socket <path> is required\n");
      return 2;
    }
    const server = await serve(socketPath, { onServeShutdown: () => process.exit(0) });
    process.stdout.write(`runner-host serving on ${server.path} (${versionString()})\n`);
    // Keep the process alive until signalled; close the socket cleanly on exit.
    // Guard against repeated/overlapping SIGINT/SIGTERM starting concurrent
    // teardowns, and surface a non-zero exit when close REJECTS (an unconfirmed
    // runner teardown must not be masked as a clean exit).
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close().then(
        () => process.exit(0),
        (error) => {
          process.stderr.write(`runner-host: shutdown close failed: ${messageOf(error)}\n`);
          process.exit(1);
        },
      );
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Never resolves — the server owns the event loop.
    return await new Promise<number>(() => {});
  }

  if (cmd === "connect") {
    // Parse `--gateway <wss-url> --cell-id <id> [--token-env CELL_TOKEN]`
    // (each flag also accepts the `--flag=value` form).
    let gatewayUrl: string | undefined;
    let cellId: string | undefined;
    let tokenEnv = "CELL_TOKEN";
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--gateway") gatewayUrl = argv[++i];
      else if (arg.startsWith("--gateway=")) gatewayUrl = arg.slice("--gateway=".length);
      else if (arg === "--cell-id") cellId = argv[++i];
      else if (arg.startsWith("--cell-id=")) cellId = arg.slice("--cell-id=".length);
      else if (arg === "--token-env") tokenEnv = argv[++i] ?? tokenEnv;
      else if (arg.startsWith("--token-env=")) tokenEnv = arg.slice("--token-env=".length);
    }
    if (!gatewayUrl || !cellId) {
      process.stderr.write("runner-host connect: --gateway <wss-url> and --cell-id <id> are required\n");
      return 2;
    }
    const token = process.env[tokenEnv];
    if (!token) {
      process.stderr.write(`runner-host connect: env var ${tokenEnv} is empty (the gateway bearer token)\n`);
      return 2;
    }
    // Connecting a new observer must not signal runners or stamp their metas.
    // Proof-gated re-adoption happens in the daemon/supervisor state machine.
    const controller = buildController();
    const connection = connectToGateway({
      gatewayUrl,
      cellId,
      token,
      methods: controller.methods,
      runnerHostVersion: versionString(),
    });
    process.stdout.write(`runner-host connecting to ${gatewayUrl} as cell ${cellId} (${versionString()})\n`);
    // Guard against repeated/overlapping signals, and exit non-zero if the
    // controller teardown REJECTS rather than masking an unconfirmed runner
    // teardown behind a clean exit.
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      controller.beginClose();
      connection
        .close()
        .then(() => controller.close())
        .then(
          () => process.exit(0),
          (error) => {
            process.stderr.write(`runner-host: shutdown close failed: ${messageOf(error)}\n`);
            process.exit(1);
          },
        );
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Never resolves — the reconnect loop owns the event loop.
    return await new Promise<number>(() => {});
  }

  if (cmd === "__hsr-run") {
    // Bundle-self bee spawn (in-cell): runnerHost re-execs this bundle with the
    // `__hsr-run` marker when there is no dedicated runner-entry sibling. This
    // owns the bundle's handoff into the bee host; runHsrHostFromPayload manages
    // its own process lifetime (it calls process.exit on both success and
    // startup failure), so control does not return here in practice.
    await runHsrHostFromPayload(argv[1]);
    return 0;
  }

  process.stderr.write(
    `runner-host: unknown command ${cmd ?? "(none)"}\n` +
      "usage: runner-host --version | probe --socket <path> --expect-version <version> | upgrade --socket <path> --target-version <version> | serve --socket <path> | connect --gateway <wss-url> --cell-id <id> [--token-env CELL_TOKEN]\n",
  );
  return 2;
}

// Standalone-entry guard: run main() only when invoked directly (bundled .mjs or
// `tsx remoteHost.ts`), never on import (tests import versionString/buildMethods).
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // The ESM loader realpath-resolves import.meta.url (on macOS `/var` →
    // `/private/var`), but process.argv[1] is left as-invoked — so compare both
    // through realpath to avoid a symlink mismatch that would skip main().
    const self = fileURLToPath(import.meta.url);
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error) => {
      process.stderr.write(`runner-host: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
