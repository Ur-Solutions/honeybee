/**
 * Remote HSR substrate (APIA-92) — the LOCAL Substrate that drives HSR bees on a
 * `remote-hsr` node over the forwarded runner-host socket.
 *
 * It mirrors the shape of ssh-tmux.ts (a remote Substrate) but delegates over the
 * runner-host JSON-RPC control plane (connectRemoteRunnerHost — see
 * remoteTransport.ts) instead of tmux. A remote-hsr bee is NOT a local HSR bee:
 * its SessionRecord carries `node = <remote-hsr node>` and NO `substrate:"hsr"`,
 * so substrateFor(record) routes it here by node.kind — and the daemon tick +
 * `hive bees` observe it purely through the node-probe path (probe() +
 * listSessionStates()), exactly like ssh-tmux, with no special-casing.
 *
 * The runner host itself lives ON the remote (forked by its serve on `spawn`);
 * this side only forwards steer/observe/kill calls and reads liveness/list back.
 * Spawn resolves the AgentSpec LOCALLY and hands the resolved spec to the remote
 * `spawn` RPC (no resolveAgent on the remote) via {@link RemoteHsrSubstrate.spawnRemote}.
 *
 * The ssh WIRE between this substrate and the remote serve is stood in for tests
 * by a direct/relayed socket (injectable transport deps); real loopback ssh e2e
 * is APIA-98. Credential delivery to the remote home is APIA-93 — for now the
 * remote uses its own home's auth (for a loopback remote that IS this machine).
 *
 * Node builtins only.
 */

import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { machineId } from "../fsx.js";
import type { NodeRecord } from "../node.js";
import type { BeeState } from "../state.js";
import type { DeliveredCredentials } from "../hsr/remoteCreds.js";
import type { PendingNeedsInput } from "../hsr/observe.js";
import {
  HsrAnswerConflictError,
  markHsrAnswerOperationSending,
  parseHsrAnswerRpcParams,
  parseHsrAnswerRpcResult,
  returnHsrAnswerOperationToOffer,
  type HsrAnswerHostIdentity,
  type HsrAnswerOperation,
  type HsrAnswerReconciliationVerdict,
  type HsrAnswerRpcResult,
} from "../answerReceipt.js";
import type { RunnerEvent, RunnerInputAnswer } from "../hsr/types.js";
import { REMOTE_HSR_SAFETY_PROTOCOL } from "../hsr/remoteLaunchReceipt.js";
import {
  importRemoteHsrEventIntegrityReceipt,
  parseHsrEventIntegrityReceipt,
  readHsrEventIntegrityReceipt,
  type HsrEventIntegrityReceipt,
} from "../hsr/eventIntegrity.js";
import { runnerHostHandshakeVersion } from "../hsr/runnerHostArtifact.js";
import { runnerHostVersionCore } from "../hsr/buildRunnerHostBundle.js";
import {
  HsrDeliveryAmbiguousError,
  HsrDeliveryDiscardedError,
  HsrDeliveryIdentityConflictError,
  HsrDeliveryInFlightError,
} from "../hsr/pendingTurns.js";
import {
  connectRemoteRunnerHost,
  type ConnectRemoteOptions,
  type RemoteRunnerClient,
} from "../hsr/remoteTransport.js";
import type {
  KillResult,
  KillOptions,
  NewSessionResult,
  ProbeResult,
  SendTextOptions,
  Substrate,
  TmuxWindowOptions,
} from "./types.js";

/** Short per-call budget for the tick-facing calls (probe/liveness/list). */
const PROBE_TIMEOUT_MS = 2_500;

/** A clone can be slow (network + checkout), so provision gets a long budget. */
const PROVISION_TIMEOUT_MS = 120_000;
/** A token refresh stops + re-delivers + restarts + resumes a codex boot — moderate budget. */
const REFRESH_TIMEOUT_MS = 60_000;
/** listCheckouts shells git across several dirs — a moderate budget over probe. */
const LIST_CHECKOUTS_TIMEOUT_MS = 15_000;
/** Same-id receipt reconciliation after an outer runner-host reply is lost. */
const DELIVERY_RECONCILE_ATTEMPTS = 5;
/** Same-operation reconciliation after an outer answer RPC outcome is lost. */
const ANSWER_RECONCILE_ATTEMPTS = 5;
const REMOTE_EVENT_REPLAY_PAGE_MAX_EVENTS = 128;

type RemoteEventReplayResponse = {
  ok?: boolean;
  events?: unknown;
  gap?: { fromSeq?: unknown; toSeq?: unknown };
  throughSeq?: unknown;
  hasMore?: unknown;
  pageToken?: unknown;
  integrityFailure?: boolean;
  error?: string;
};

type RemoteDeliveryPhase =
  | "queued"
  | "dispatching"
  | "accepted"
  | "started"
  | "auth_failed"
  | "completed"
  | "ambiguous"
  | "discarded";

type RemoteDeliveryResponse = {
  ok?: boolean;
  deliveryId?: string;
  phase?: RemoteDeliveryPhase;
  code?: string;
  error?: string;
};

/** A row of the remote `list` RPC (see remoteHost.ts buildController.list). */
export type RemoteListRow = {
  bee: string;
  live: boolean;
  state: BeeState | null;
  tier: string | null;
  sessionId: string | null;
  status: string | null;
  controlSocket: string | null;
  launchId?: string;
  incarnation?: string;
  eventIntegrityFailure?: string;
  eventIntegrityId?: string;
  eventIntegrityStopState?: "pending" | "confirmed" | "doubt";
  eventIntegrityReceipt?: HsrEventIntegrityReceipt;
  /** O(1)-folded exact source usage; never materializes a pinned replay suffix. */
  usage?: {
    totals: { inputTokens: number; outputTokens: number } | null;
    latestExhausted?: { ts: number; resetHint?: string };
  };
  /** Durable launch/refresh/stop phase where no terminal projection is valid. */
  transitional?: true;
  /** Per-Bee authority refusal; never reinterpret it as an empty node. */
  unavailable?: "busy" | "integrity";
  integrityFailure?: true;
  error?: string;
  /** Actionable durable consumers which still pin an exact stopped suffix. */
  pendingConsumers?: Array<{ consumerId: string; ackedSeq: number; throughSeq: number }>;
};

export type RemoteSpawnParams = {
  bee: string;
  /** Client-generated durable idempotency key; generated here if omitted. */
  launchId?: string;
  /** Expected stopped admission head captured before the first dispatch. */
  previousLaunchId?: string;
  kind: string;
  /**
   * The bee's working dir. OMITTED for a plain remote-hsr spawn — a local path
   * doesn't exist on the node (spawn() ENOENT), so the remote derives a per-bee
   * cwd under its own storeRoot. Sent ONLY when it is already a real REMOTE path:
   * a provisioned checkout (APIA-95).
   */
  cwd?: string;
  sessionId?: string;
  resume?: boolean;
  authKind?: "subscription" | "api-key";
  model?: string;
  comb?: string;
  parent?: string;
  /**
   * APIA-93 ephemeral credential material (opaque, base64 in transit) delivered
   * into the remote isolated home at spawn and shredded on kill. Only present
   * for an account-bound spawn on an ephemeral-token node. NEVER logged.
   */
  creds?: DeliveredCredentials;
  /**
   * Isolated-home override. Normally OMITTED — the remote derives the harness
   * home under its own storeRoot (a local path is meaningless on the node) and
   * writes delivered credentials there. An explicit REMOTE path is honored as-is
   * (tests inject one). Only relevant when `creds` carry files.
   */
  home?: string;
  spec: { command: string; args: string[]; env: Record<string, string> };
};

export type RemoteSpawnResult = {
  bee: string;
  launchId: string;
  incarnation: string;
  tier?: string;
  sessionId?: string;
  cwd: string;
};

export type RemoteLaunchHead =
  | { state: "empty" }
  | {
      state: "reserved" | "dispatching" | "running" | "refreshing" | "stopping" | "stopped";
      launchId: string;
      incarnation: string;
    };

export type RemoteHsrLocator = {
  remoteLaunchId?: string;
  remoteIncarnation?: string;
};

export type RemotePendingInputEnvelope = {
  pending: PendingNeedsInput | null;
  host: HsrAnswerHostIdentity;
};

export type RemoteObservationOptions = {
  /** Durable remote seq already projected by this exact generation. */
  afterSeq?: number;
  /**
   * Runs after remote lifecycle/relay admission but before exact replay. The
   * mirror uses this boundary to reset/write generation metadata without ever
   * erasing its prior cache for an unowned/stale SessionRecord.
   */
  afterAuthorized?: () => void | Promise<void>;
  /** Runs after exact durable projection but before the remote ack advances. */
  afterSynchronized?: () => void | Promise<void>;
};

/**
 * Exact replay proved that the remote event history, authority, or the local
 * durable projection cannot be trusted. Callers must fence the exact session
 * generation instead of treating this as a retryable tunnel failure.
 */
export class RemoteObservationIntegrityError extends Error {
  readonly code = "HIVE_REMOTE_EVENT_INTEGRITY";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteObservationIntegrityError";
  }
}

/** The local canonical generation was retired/replaced while replay drained. */
export class RemoteObservationDetachedError extends Error {
  readonly code = "HIVE_REMOTE_EVENT_DETACHED";

  constructor(message: string) {
    super(message);
    this.name = "RemoteObservationDetachedError";
  }
}

export class RemoteSpawnIndeterminateError extends Error {
  readonly launchId: string;
  readonly incarnation?: string;

  constructor(message: string, launchId: string, incarnation?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteSpawnIndeterminateError";
    this.launchId = launchId;
    this.incarnation = incarnation;
  }
}

/** The remote spawn verb was never dispatched, or authority proved no launch was admitted. */
export class RemoteSpawnNotAdmittedError extends Error {
  readonly launchId: string;

  constructor(message: string, launchId: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteSpawnNotAdmittedError";
    this.launchId = launchId;
  }
}

/**
 * UNIT 2 token refresh: re-deliver a FRESH ephemeral credential to a LIVE remote
 * bee and have the runner adopt it (stop → shred old → write new → restart with
 * resume). Only the fresh credential material crosses the wire — the vault stays
 * local. Never logged.
 */
export type RemoteRefreshCredsParams = {
  bee: string;
  creds: DeliveredCredentials;
  remoteLaunchId?: string;
  remoteIncarnation?: string;
};
export type RemoteRefreshCredsResult = {
  ok: boolean;
  sessionId?: string;
  error?: string;
  /** Remote exact-stop proof failed; the caller must persist stop doubt. */
  stopUnconfirmed?: boolean;
};

/**
 * APIA-95 working-copy provisioning params/result. Clone (or idempotently reuse)
 * a git checkout ON THE REMOTE under its `<storeRoot>/worktrees/<name>`, then run
 * the bee inside it. Groundwork for Apiary's "where-it-lives" selector on
 * non-local substrates (substrates-research §5.3 / architecture §7.5).
 */
export type RemoteProvisionParams = { repo: string; branch?: string; name?: string; ref?: string };
export type RemoteProvisionResult = { path: string; repo: string; branch?: string; reused: boolean };

/** A row of the remote `listCheckouts` RPC (a provisioned git checkout on the node). */
export type RemoteCheckoutRow = {
  name: string;
  path: string;
  repo: string | null;
  branch: string | null;
  dirty?: boolean;
};

/**
 * The Substrate returned for a `remote-hsr` node, plus the two verbs the tmux
 * Substrate interface has no slot for: {@link spawnRemote} (the spawn path calls
 * it after resolving the AgentSpec locally) and {@link observe} (relayed event
 * stream), and {@link close} for teardown.
 */
export type RemoteHsrSubstrate = Substrate & {
  /**
   * Live handshake against the remote runner-host `ping` (APIA-96): `{ ok }` plus
   * the runner-host `version` string (`runner-host <core>`) when the serve is
   * reachable. `hive node status` times this and reads the version/drift from it;
   * a down tunnel resolves `{ ok:false, reason }` (never throws).
   */
  ping(): Promise<{ ok: boolean; version?: string; safetyProtocol?: number; reason?: string }>;
  spawnRemote(params: RemoteSpawnParams): Promise<RemoteSpawnResult>;
  /** Authority-grade rows include exact non-live generations and integrity. */
  listRemoteRows(): Promise<RemoteListRow[]>;
  /** One-shot exact replay for an already-ended generation; no live relay. */
  replayTerminalEvents(
    bee: string,
    onEvent: (event: RunnerEvent) => void | Promise<void>,
    locator: RemoteHsrLocator,
    afterSeq: number,
    afterSynchronized?: () => void | Promise<void>,
  ): Promise<void>;
  /** Answer one structured needs-input through exact remote authority. */
  answerRemote(
    bee: string,
    operation: HsrAnswerOperation,
    answer: RunnerInputAnswer,
    locator: RemoteHsrLocator,
  ): Promise<HsrAnswerRpcResult>;
  /** Publish an operator's exact manual answer verdict on the remote authority. */
  reconcileAnswerRemote(
    bee: string,
    operation: HsrAnswerOperation,
    verdict: HsrAnswerReconciliationVerdict,
    locator: RemoteHsrLocator,
  ): Promise<HsrAnswerRpcResult>;
  /** Explicitly acknowledge one exact stopped remote event-loss authority. */
  reconcileEventIntegrityRemote(
    bee: string,
    integrityId: string,
    locator: RemoteHsrLocator,
  ): Promise<void>;
  /** Explicitly discard one stopped generation's stale durable event consumer. */
  discardEventConsumerRemote(
    bee: string,
    consumerId: string,
    locator: RemoteHsrLocator,
  ): Promise<{ ackedSeq: number; throughSeq: number; lostFromSeq?: number; lostToSeq?: number; reclaimed: boolean }>;
  /** Read the current generation's pending request through remote authority. */
  pendingInputRemote(
    bee: string,
    locator: { remoteLaunchId?: string; remoteIncarnation?: string },
  ): Promise<RemotePendingInputEnvelope>;
  /** Read the durable authority head used for exact recovery liveness proof. */
  launchHeadRemote(bee: string): Promise<RemoteLaunchHead>;
  /** Exact conditional cleanup used for ambiguous spawn/publication rollback. */
  killRemoteIncarnation(bee: string, locator: { launchId: string; incarnation?: string }): Promise<KillResult>;
  /**
   * UNIT 2: re-deliver a fresh ephemeral credential to a live bee and restart its
   * runner with resume so it adopts the new token. Never throws — a down tunnel /
   * failed restart resolves `{ ok:false, reason/error }`.
   */
  refreshCredsRemote(params: RemoteRefreshCredsParams): Promise<RemoteRefreshCredsResult>;
  /**
   * APIA-95: clone (or idempotently reuse) a working copy on the remote and
   * return its path — the spawn path uses it as the bee's cwd.
   */
  provisionRemote(params: RemoteProvisionParams): Promise<RemoteProvisionResult>;
  /** APIA-95: enumerate existing checkouts on the remote node. */
  listCheckouts(): Promise<RemoteCheckoutRow[]>;
  /** Subscribe to a bee's relayed event stream. Returns an unsubscribe fn. */
  observe(
    bee: string,
    onEvent: (event: unknown) => void | Promise<void>,
    locator?: { remoteLaunchId?: string; remoteIncarnation?: string },
    options?: RemoteObservationOptions,
  ): Promise<() => void | Promise<void>>;
  /** Exact replay/ack barrier for an already-admitted observer generation. */
  syncObservation(
    bee: string,
    locator?: { remoteLaunchId?: string; remoteIncarnation?: string },
  ): Promise<void>;
  /**
   * The bounded events.jsonl tail for a bee on the node — optionally only events
   * strictly newer than `afterTs` (epoch ms). The daemon's event mirror uses it
   * to backfill events emitted before its observe subscription attached.
   * Tokenless legacy reads are best-effort; a token-qualified read throws on
   * transport/authority failure so generation switching can fail closed.
   */
  eventsTail(
    bee: string,
    afterTs?: number,
    locator?: { remoteLaunchId?: string; remoteIncarnation?: string },
  ): Promise<RunnerEvent[]>;
  /** Tear down the cached transport client (tests / shutdown). */
  close(): Promise<void>;
};

export type RemoteHsrSubstrateOptions = {
  /** Injectable transport deps (tests point these at an in-process serve). */
  transport?: ConnectRemoteOptions;
  /** Full override of the transport factory (tests). */
  connect?: (node: NodeRecord, opts: ConnectRemoteOptions) => Promise<RemoteRunnerClient>;
  /** Periodic exact replay closes silent notification-drop gaps. */
  observationReconcileMs?: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Coarse @hive_state (working|waiting|done|failed) for a structured BeeState.
 * Inlined (mirrors hiveState.ts hiveStateFor) to keep this module off the
 * hiveState → substrates import cycle. Empty string = no override.
 */
function coarseHiveState(state: BeeState | null): string {
  switch (state) {
    case "queued":
    case "booting":
    case "active":
      return "working";
    case "ready":
    case "blocked":
    case "auth-needed":
      return "waiting";
    case "idle_with_output":
    case "done":
      return "done";
    case "error":
    case "kill_failed":
      return "failed";
    default:
      return "";
  }
}

export function createRemoteHsrSubstrate(
  node: NodeRecord,
  options: RemoteHsrSubstrateOptions = {},
): RemoteHsrSubstrate {
  if (node.kind !== "remote-hsr") {
    throw new Error(`createRemoteHsrSubstrate requires kind=remote-hsr, got ${node.kind}`);
  }
  const connect = options.connect ?? connectRemoteRunnerHost;
  const deps = options.transport ?? {};
  // One durable projection authority per local Honeybee store + remote node.
  // The persisted machine id survives daemon restart; hashing keeps the wire
  // identifier fixed-size and avoids exposing local filesystem/host details.
  const observationConsumerId = `hive-observer-v1:${createHash("sha256")
    .update(JSON.stringify([machineId(), node.name]))
    .digest("hex")}`;

  // Observed bees (refcounted across subscribers). The remote relay behind the
  // `observe` RPC lives only in the serve process's memory — if that process
  // restarts (crash/OOM/redeploy), the transport reconnects and re-adopts the
  // local `hsr.event` bridge, but the fresh serve has an EMPTY relay map and
  // would never broadcast again (HIVE-11). So we track what we observe and
  // re-issue the observe RPC on every transport `reconnect`.
  type ObservedGeneration = {
    count: number;
    remoteLaunchId?: string;
    remoteIncarnation?: string;
    subscribers: Set<(event: unknown) => void | Promise<void>>;
    detach: () => void;
    cursor: number;
    resuming: boolean;
    buffered: RunnerEvent[];
    failed?: Error;
    resumePromise?: Promise<void>;
    operationChain: Promise<void>;
  };
  const observed = new Map<string, ObservedGeneration>();
  let closed = false;
  let reobserveRetryTimer: NodeJS.Timeout | undefined;
  let reobserveRetryCount = 0;
  let reobservePass: Promise<void> | undefined;
  let reobserveRerun = false;
  const observationReconcileMs = Math.max(25, options.observationReconcileMs ?? 1_000);
  const observationReconcileTimer = setInterval(() => {
    if (closed || observed.size === 0 || !clientPromise) return;
    void clientPromise.then((c) => reobserve(c)).catch(() => undefined);
  }, observationReconcileMs);
  observationReconcileTimer.unref?.();

  function runnerEvent(value: unknown): value is RunnerEvent {
    return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
  }

  function observationParams(bee: string, entry: ObservedGeneration): Record<string, unknown> {
    return {
      bee,
      consumerId: observationConsumerId,
      afterSeq: entry.cursor,
      ...(entry.remoteLaunchId ? { launchId: entry.remoteLaunchId } : {}),
      ...(entry.remoteIncarnation ? { incarnation: entry.remoteIncarnation } : {}),
    };
  }

  async function publishObserved(entry: ObservedGeneration, event: RunnerEvent): Promise<void> {
    for (const subscriber of [...entry.subscribers]) {
      try {
        await subscriber(event);
      } catch (error) {
        if (error instanceof RemoteObservationDetachedError) throw error;
        throw new RemoteObservationIntegrityError("local remote-event projection failed", { cause: error });
      }
    }
  }

  function serializeObservation<T>(entry: ObservedGeneration, operation: () => Promise<T>): Promise<T> {
    const result = entry.operationChain.catch(() => undefined).then(operation);
    entry.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function failObservation(
    c: RemoteRunnerClient,
    bee: string,
    entry: ObservedGeneration,
    error: RemoteObservationIntegrityError,
  ): Promise<void> {
    if (entry.failed) return;
    entry.failed = error;
    entry.buffered.length = 0;
    // A silent frozen mirror can keep authorizing predecessor state. Publish a
    // terminal structured failure locally, then suppress this stream until an
    // explicit teardown/re-admission establishes a trustworthy cursor.
    let projectionError: unknown;
    try {
      await publishObserved(entry, {
        type: "error",
        ts: Date.now(),
        message: `remote HSR event stream for ${bee} cannot resume safely: ${error.message}`,
        remoteObservationIntegrityFailure: true,
      } as RunnerEvent);
    } catch (caught) {
      projectionError = caught;
    } finally {
      entry.detach();
      if (observed.get(bee) === entry) observed.delete(bee);
      await c.call("unobserve", {
        ...observationParams(bee, entry),
        count: entry.count,
      }).catch(() => undefined);
    }
    if (projectionError !== undefined) {
      throw projectionError instanceof RemoteObservationIntegrityError
        ? projectionError
        : new RemoteObservationIntegrityError("local remote-event integrity fence failed", { cause: projectionError });
    }
  }

  async function ackObserved(c: RemoteRunnerClient, bee: string, entry: ObservedGeneration): Promise<void> {
    if (entry.cursor <= 0 || entry.failed) return;
    let result: { ok?: boolean; ackedSeq?: unknown; integrityFailure?: boolean } | null;
    try {
      result = await c.call("ackEvents", {
        ...observationParams(bee, entry),
        upToSeq: entry.cursor,
      }) as { ok?: boolean; ackedSeq?: unknown; integrityFailure?: boolean } | null;
    } catch {
      // Keep the remote log retained; a later resume/replay or ack retries.
      return;
    }
    // A lost ack reply is harmless: local durability already precedes this
    // call, and replay dedupes from the persisted cursor. An explicit
    // authority refusal is not harmless; freeze this generation and abort any
    // remaining page loop immediately.
    if (!result?.ok && result?.integrityFailure === true) {
      const error = new RemoteObservationIntegrityError("remote acknowledgement authority was refused");
      await failObservation(c, bee, entry, error);
      throw error;
    }
  }

  async function applyObservedBatch(
    c: RemoteRunnerClient,
    bee: string,
    entry: ObservedGeneration,
    events: RunnerEvent[],
    options: { ack?: boolean } = {},
  ): Promise<void> {
    const stamped = new Map<number, RunnerEvent>();
    for (const event of events) {
      const seq = event.seq;
      if (seq === undefined) {
        // Seq-less live notifications are accepted only as a legacy
        // compatibility path. Preserve their actual wire position; current
        // runner-host artifacts always stamp exact-replay events.
        await publishObserved(entry, event);
        continue;
      }
      if (!Number.isSafeInteger(seq) || seq <= 0) {
        throw new RemoteObservationIntegrityError("remote event carried an invalid sequence");
      }
      const prior = stamped.get(seq);
      if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
        throw new RemoteObservationIntegrityError(`remote event sequence ${seq} changed content`);
      }
      stamped.set(seq, event);
      if (seq <= entry.cursor) continue;
      if (seq !== entry.cursor + 1) {
        throw new RemoteObservationIntegrityError(
          `remote event sequence gap ${entry.cursor + 1}..${seq - 1}`,
        );
      }
      // Await every consumer's durable projection BEFORE advancing/acking.
      await publishObserved(entry, event);
      entry.cursor = seq;
    }
    if (options.ack !== false) await ackObserved(c, bee, entry);
  }

  function replayPageContinuation(
    response: RemoteEventReplayResponse,
    requestedCursor: number,
    projectedCursor: number,
  ): string | undefined {
    const paged = response.throughSeq !== undefined
      || response.hasMore !== undefined
      || response.pageToken !== undefined;
    if (!paged) return undefined; // rolling compatibility with pre-page serves
    if (
      !Number.isSafeInteger(response.throughSeq)
      || Number(response.throughSeq) < requestedCursor
      || Number(response.throughSeq) !== projectedCursor
      || typeof response.hasMore !== "boolean"
    ) {
      throw new RemoteObservationIntegrityError("remote exact replay returned invalid page bounds");
    }
    if (response.hasMore) {
      if (typeof response.pageToken !== "string" || response.pageToken.length === 0) {
        throw new RemoteObservationIntegrityError("remote exact replay omitted its continuation token");
      }
      // A continuation may intentionally carry no events: when another slow
      // consumer pins a large prefix, the authority bounds prefix scan work as
      // well as response bytes and resumes from its opaque immutable snapshot.
      // The exact artifact handshake and token bind that internal progress;
      // `throughSeq` must still equal our unchanged durable cursor above.
      return response.pageToken;
    }
    if (response.pageToken !== undefined) {
      throw new RemoteObservationIntegrityError("remote exact replay returned a continuation after its final page");
    }
    return undefined;
  }

  async function resumeObservation(
    c: RemoteRunnerClient,
    bee: string,
    entry: ObservedGeneration,
    options: {
      sync: boolean;
      initial?: boolean;
      afterSynchronized?: () => void | Promise<void>;
    },
  ): Promise<void> {
    if (entry.failed) throw entry.failed;
    if (entry.resumePromise) return entry.resumePromise;
    const resume = (async () => {
      entry.resuming = true;
      try {
        if (options.sync) {
          const observedResult = await c.call("observe", {
            ...observationParams(bee, entry),
            sync: entry.count,
          }) as { ok?: boolean; integrityFailure?: boolean; error?: string } | null;
          if (!observedResult?.ok) {
            const detail = `remote observe authority was refused: ${observedResult?.error ?? "unknown"}`;
            if (observedResult?.integrityFailure === true) throw new RemoteObservationIntegrityError(detail);
            throw new Error(detail);
          }
        }
        let pageToken: string | undefined;
        for (;;) {
          const requestedCursor = entry.cursor;
          const response = await c.call("events", {
            ...observationParams(bee, entry),
            afterSeq: requestedCursor,
            ...(pageToken ? { pageToken } : {}),
          }) as RemoteEventReplayResponse | null;
          if (!response?.ok || !Array.isArray(response.events)) {
            const detail = `remote exact event replay was refused: ${response?.error ?? "invalid response"}`;
            if (response?.integrityFailure === true) throw new RemoteObservationIntegrityError(detail);
            throw new Error(detail);
          }
          if (response.gap !== undefined) {
            const from = response.gap?.fromSeq;
            const to = response.gap?.toSeq;
            throw new RemoteObservationIntegrityError(
              `remote event history has a compaction/storage gap ${String(from)}..${String(to)}`,
            );
          }
          const replay = response.events.filter(runnerEvent);
          if (replay.length !== response.events.length) {
            throw new RemoteObservationIntegrityError("remote exact event replay contained a malformed event");
          }
          if (response.hasMore !== undefined && replay.length > REMOTE_EVENT_REPLAY_PAGE_MAX_EVENTS) {
            throw new RemoteObservationIntegrityError("remote exact replay exceeded its bounded page size");
          }
          // Persist/project and ack EACH bounded page before requesting the
          // next one. A long-disconnected slow consumer therefore makes
          // monotonic recovery progress without one unbounded JSON-RPC frame.
          await applyObservedBatch(c, bee, entry, replay, { ack: false });
          pageToken = replayPageContinuation(response, requestedCursor, entry.cursor);
          if (pageToken && entry.cursor > requestedCursor) await ackObserved(c, bee, entry);
          if (!pageToken) break;
        }
        // Notifications can race both the observe admission and the snapshot.
        // Keep draining the buffered suffix until no producer arrived while the
        // prior pages were being committed; seq identity removes duplicates.
        while (entry.buffered.length > 0) {
          const buffered = entry.buffered.splice(0);
          await applyObservedBatch(c, bee, entry, buffered, { ack: false });
        }
        // Activation/terminal projection is part of the local durability
        // boundary. A failure here leaves the remote prefix unacked/replayable.
        await options.afterSynchronized?.();
        await ackObserved(c, bee, entry);
      } catch (error) {
        if (error instanceof RemoteObservationIntegrityError && !options.initial) {
          await failObservation(c, bee, entry, error);
        }
        throw error;
      } finally {
        entry.resuming = false;
      }
    })();
    entry.resumePromise = resume;
    try {
      await resume;
    } finally {
      if (entry.resumePromise === resume) entry.resumePromise = undefined;
    }
  }

  async function onObservedNotification(
    c: RemoteRunnerClient,
    bee: string,
    entry: ObservedGeneration,
    params: unknown,
  ): Promise<void> {
    if (entry.failed) return;
    const p = (params ?? {}) as { bee?: unknown; event?: unknown; launchId?: unknown; incarnation?: unknown };
    const launchId = typeof p.launchId === "string" && p.launchId ? p.launchId : undefined;
    const incarnation = typeof p.incarnation === "string" && p.incarnation ? p.incarnation : undefined;
    if (
      String(p.bee ?? "") !== bee
      || launchId !== entry.remoteLaunchId
      || incarnation !== entry.remoteIncarnation
      || !runnerEvent(p.event)
    ) return;
    if (entry.resuming) {
      entry.buffered.push(p.event);
      return;
    }
    const seq = p.event.seq;
    if (seq === undefined || seq === entry.cursor + 1) {
      try {
        await applyObservedBatch(c, bee, entry, [p.event]);
      } catch (error) {
        if (error instanceof RemoteObservationDetachedError) return;
        await failObservation(
          c,
          bee,
          entry,
          error instanceof RemoteObservationIntegrityError
            ? error
            : new RemoteObservationIntegrityError("remote event notification projection failed", { cause: error }),
        );
      }
      return;
    }
    if (Number.isSafeInteger(seq) && Number(seq) <= entry.cursor) return;
    // A notification jump usually means transport queue loss. Replay the
    // durable suffix from the last committed cursor before publishing it.
    entry.buffered.push(p.event);
    try {
      await resumeObservation(c, bee, entry, { sync: false });
    } catch (error) {
      // Integrity failures publish a terminal local event; transport failures
      // keep the buffer and start the same periodic exact-resume loop used by a
      // tunnel reconnect. A one-off notification jump may be the only signal we
      // ever receive; waiting for another event/reconnect would freeze silently.
      if (!(error instanceof RemoteObservationIntegrityError)
        && !(error instanceof RemoteObservationDetachedError)) scheduleReobserveRetry(c);
    }
  }

  function scheduleReobserveRetry(c: RemoteRunnerClient): void {
    if (closed || !c.connected() || reobserveRetryTimer !== undefined) return;
    reobserveRetryCount += 1;
    reobserveRetryTimer = setTimeout(() => {
      reobserveRetryTimer = undefined;
      void reobserve(c);
    }, Math.min(50 * reobserveRetryCount, 1_000));
  }

  async function reobserveOnce(c: RemoteRunnerClient): Promise<void> {
    let transientFailure = false;
    for (const [bee, entry] of [...observed]) {
      try {
        // `sync` makes the remote SET its relay refcount to our subscriber
        // count: against a surviving serve a plain observe would inflate the
        // count past what our unobserve calls return (HIVE-56); against a
        // restarted serve it re-creates the relay with the right count.
        // `ok:false` (bee gone) is left to the mirror's teardown pass; a
        // thrown call (tunnel flapped again) is retried by the next reconnect.
        await serializeObservation(entry, () => resumeObservation(c, bee, entry, { sync: true }));
      } catch (error) {
        // One flapping bee must not prevent later generations on the same node
        // from rebuilding their relays. The next reconnect (or ordinary mirror
        // tick) retries this entry from its durable cursor.
        if (!(error instanceof RemoteObservationIntegrityError)
          && !(error instanceof RemoteObservationDetachedError)) transientFailure = true;
        continue;
      }
    }
    if (!transientFailure) {
      reobserveRetryCount = 0;
      return;
    }
    scheduleReobserveRetry(c);
  }

  function reobserve(c: RemoteRunnerClient): Promise<void> {
    if (reobservePass) {
      // Periodic ticks/reconnects are level-triggered. One sticky rerun closes
      // any gap discovered while the current pass is blocked without building
      // an unbounded queue of full-node scans behind a slow projection.
      reobserveRerun = true;
      return reobservePass;
    }
    const run = (async () => {
      do {
        reobserveRerun = false;
        await reobserveOnce(c);
      } while (reobserveRerun && !closed && c.connected());
    })();
    reobservePass = run.finally(() => {
      reobservePass = undefined;
    });
    return reobservePass;
  }

  // Lazily establish ONE resilient client per node (reused by the daemon tick,
  // steer, observe). A failed establish is NOT cached — the next call retries,
  // so a transient tunnel drop never wedges the substrate. Caching a client that
  // later goes 'down' is safe too: its call()/on() kick a fresh reconnect, so
  // the memoized client self-heals once the network recovers (HIVE-9).
  let clientPromise: Promise<RemoteRunnerClient> | undefined;
  function client(): Promise<RemoteRunnerClient> {
    if (!clientPromise) {
      clientPromise = connect(node, deps)
        .then((c) => {
          c.on("reconnect", () => void reobserve(c));
          return c;
        })
        .catch((error) => {
          clientPromise = undefined;
          throw error;
        });
    }
    return clientPromise;
  }

  function requireLocalArtifactForNewWork(operation: string): string {
    let localVersion: string;
    try {
      localVersion = runnerHostVersionCore();
    } catch (error) {
      throw new Error(
        `refusing remote HSR ${operation} on ${node.name}: local staged runner-host identity is unavailable: ${messageOf(error)}`,
        { cause: error },
      );
    }
    if (node.runnerHostVersion !== localVersion) {
      throw new Error(
        `refusing new remote HSR work (${operation}) on ${node.name}: registered runner-host ${String(node.runnerHostVersion ?? "none")} `
        + `does not match this Honeybee artifact ${localVersion}; stop/retire active remote bees and rerun hive node bootstrap`,
      );
    }
    return localVersion;
  }

  async function currentAuthorityForNewWork(operation: string): Promise<RemoteRunnerClient> {
    const localVersion = requireLocalArtifactForNewWork(operation);
    const c = await client();
    const handshake = (await c.call("ping", undefined, { timeoutMs: PROBE_TIMEOUT_MS })) as
      | { ok?: boolean; version?: string; safetyProtocol?: number }
      | null;
    const expectedVersion = runnerHostHandshakeVersion(localVersion);
    if (
      !handshake?.ok
      || handshake.version !== expectedVersion
      || typeof handshake.safetyProtocol !== "number"
      || handshake.safetyProtocol < REMOTE_HSR_SAFETY_PROTOCOL
    ) {
      throw new Error(
        `runner-host authority mismatch on ${node.name}: expected ${expectedVersion} with safety protocol ${REMOTE_HSR_SAFETY_PROTOCOL}, `
        + `received ${String(handshake?.version ?? "no version")} with protocol ${String(handshake?.safetyProtocol ?? "none")}; bootstrap/upgrade the node first`,
      );
    }
    return c;
  }

  async function callList(): Promise<RemoteListRow[]> {
    const c = await client();
    const rows = await c.call("list", undefined, { timeoutMs: PROBE_TIMEOUT_MS });
    if (Array.isArray(rows)) {
      return rows.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new RemoteObservationIntegrityError(`remote HSR list on ${node.name} returned a malformed row`);
        }
        const row = raw as RemoteListRow;
        if (typeof row.bee !== "string" || typeof row.live !== "boolean") {
          throw new RemoteObservationIntegrityError(`remote HSR list on ${node.name} returned a malformed row`);
        }
        if (
          row.unavailable !== undefined
          && row.unavailable !== "busy"
          && row.unavailable !== "integrity"
        ) {
          throw new RemoteObservationIntegrityError(`remote HSR list on ${node.name} returned a malformed unavailable row`);
        }
        if (row.eventIntegrityReceipt !== undefined) {
          row.eventIntegrityReceipt = parseHsrEventIntegrityReceipt(row.eventIntegrityReceipt, row.bee);
        }
        if (row.pendingConsumers !== undefined && (
          !Array.isArray(row.pendingConsumers)
          || row.pendingConsumers.some((consumer) => (
            !consumer || typeof consumer !== "object"
            || typeof consumer.consumerId !== "string" || consumer.consumerId.length === 0
            || !Number.isSafeInteger(consumer.ackedSeq) || consumer.ackedSeq < 0
            || !Number.isSafeInteger(consumer.throughSeq) || consumer.throughSeq < consumer.ackedSeq
          ))
        )) {
          throw new RemoteObservationIntegrityError(`remote HSR list on ${node.name} returned malformed pending consumers`);
        }
        return row;
      });
    }
    const failure = rows as { integrityFailure?: unknown; error?: unknown } | null;
    const detail = `remote HSR list on ${node.name} failed: ${String(failure?.error ?? "invalid response")}`;
    if (failure?.integrityFailure === true) throw new RemoteObservationIntegrityError(detail);
    throw new Error(detail);
  }

  function assertListRowsAvailable(rows: RemoteListRow[]): void {
    const unavailable = rows.find((row) => row.unavailable !== undefined || row.integrityFailure === true);
    if (!unavailable) return;
    const detail = `remote HSR list on ${node.name} is unavailable for ${unavailable.bee}: ${unavailable.error ?? "authority unavailable"}`;
    if (unavailable.unavailable === "integrity" || unavailable.integrityFailure === true) {
      throw new RemoteObservationIntegrityError(detail);
    }
    throw new Error(detail);
  }

  async function probe(): Promise<ProbeResult> {
    try {
      const c = await client();
      const res = (await c.call("ping", undefined, { timeoutMs: PROBE_TIMEOUT_MS })) as { ok?: boolean } | null;
      if (res && res.ok === false) return { ok: false, reason: "remote serve reported not-ok" };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
  }

  async function ping(): Promise<{ ok: boolean; version?: string; safetyProtocol?: number; reason?: string }> {
    try {
      const c = await client();
      const res = (await c.call("ping", undefined, { timeoutMs: PROBE_TIMEOUT_MS })) as
        | { ok?: boolean; version?: string; safetyProtocol?: number }
        | null;
      if (res && res.ok === false) return { ok: false, reason: "remote serve reported not-ok" };
      return {
        ok: true,
        ...(res && typeof res.version === "string" ? { version: res.version } : {}),
        ...(res && typeof res.safetyProtocol === "number" ? { safetyProtocol: res.safetyProtocol } : {}),
      };
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
  }

  async function hasSession(bee: string): Promise<boolean> {
    // Throws on transport failure (tunnel down) so callers (transactionalKill,
    // clean --dead) don't delete records of live bees on an unreachable node —
    // mirrors ssh-tmux.hasSession's ssh-255 discipline.
    const c = await client();
    const live = (await c.call("liveness", undefined, { timeoutMs: PROBE_TIMEOUT_MS })) as Record<string, boolean> | null;
    return Boolean(live && live[bee] === true);
  }

  async function capture(bee: string, lines?: number): Promise<string> {
    try {
      const c = await client();
      const res = (await c.call("snapshot", typeof lines === "number" ? { bee, lines } : { bee })) as
        | { ok?: boolean; result?: unknown }
        | null;
      if (res && res.ok && typeof res.result === "string") return res.result;
      return "";
    } catch {
      return "";
    }
  }

  async function eventsTail(
    bee: string,
    afterTs?: number,
    locator?: { remoteLaunchId?: string; remoteIncarnation?: string },
  ): Promise<RunnerEvent[]> {
    try {
      const c = await client();
      const res = (await c.call("events", {
        bee,
        ...(afterTs === undefined ? {} : { afterTs }),
        ...(locator?.remoteLaunchId ? { launchId: locator.remoteLaunchId } : {}),
        ...(locator?.remoteIncarnation ? { incarnation: locator.remoteIncarnation } : {}),
      })) as
        | { ok?: boolean; events?: unknown; error?: string }
        | null;
      if (res?.ok && Array.isArray(res.events)) return res.events as RunnerEvent[];
      if (locator?.remoteLaunchId || locator?.remoteIncarnation) {
        throw new Error(`remote HSR event authority rejected for ${bee}: ${res?.error ?? "unknown"}`);
      }
      return [];
    } catch (error) {
      // Token-qualified reads are also an authority preflight for mirror
      // generation switches, so rejection must stay distinguishable from an
      // authorized empty tail. Legacy tokenless capture remains best-effort.
      if (locator?.remoteLaunchId || locator?.remoteIncarnation) throw error;
      return [];
    }
  }

  async function sendText(bee: string, text: string, _paneId?: string, options?: SendTextOptions): Promise<void> {
    const deliveryId = options?.deliveryId ?? randomUUID();
    const params = {
      bee,
      text,
      deliveryId,
      ...(options?.mode === "next-tool" ? { mode: "next-tool" } : {}),
      ...(options?.completionRequired ? { completionRequired: true } : {}),
      ...(options?.remoteLaunchId ? { launchId: options.remoteLaunchId } : {}),
      ...(options?.remoteIncarnation ? { incarnation: options.remoteIncarnation } : {}),
    };
    let transportError: unknown;
    let dispatchAttempted = false;
    let lostOuterOutcome = false;
    for (let attempt = 0; attempt < DELIVERY_RECONCILE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25 * (2 ** (attempt - 1)), 200)));
      }
      let res: RemoteDeliveryResponse | null;
      let c: RemoteRunnerClient;
      try {
        c = await currentAuthorityForNewWork("send");
      } catch (error) {
        // Capability/version refusal and a failed initial preflight happen
        // before the delivery request exists on the authority. Preserve that
        // definite, actionable classification rather than manufacturing doubt.
        if (!dispatchAttempted) throw error;
        transportError = error;
        continue;
      }
      try {
        dispatchAttempted = true;
        res = (await c.call("send", params)) as RemoteDeliveryResponse | null;
      } catch (error) {
        transportError = error;
        lostOuterOutcome = true;
        continue;
      }
      if (res?.ok) return;
      const detail = `remote HSR send to ${bee} on ${node.name} failed: ${res?.error ?? "unknown"}`;
      switch (res?.code) {
        case "HIVE_HSR_DELIVERY_AMBIGUOUS":
          throw new HsrDeliveryAmbiguousError(deliveryId, detail);
        case "HIVE_HSR_DELIVERY_IN_FLIGHT":
          // For an ordinary direct send, durable in-flight is not yet the
          // acceptance receipt the caller needs after losing an earlier outer
          // response. Poll the SAME id only; if it never advances the bounded
          // loop below converts the unresolved outcome to manual ambiguity.
          // Completion-required callers intentionally retain their external
          // queue on in-flight, so preserve that contract immediately.
          if (lostOuterOutcome && !options?.completionRequired) {
            transportError = new Error(detail);
            continue;
          }
          throw new HsrDeliveryInFlightError(deliveryId, detail);
        case "HIVE_HSR_DELIVERY_ID_CONFLICT":
          throw new HsrDeliveryIdentityConflictError(deliveryId, detail);
        case "HIVE_HSR_DELIVERY_DISCARDED":
          throw new HsrDeliveryDiscardedError(deliveryId, detail);
        default:
          if (lostOuterOutcome) {
            throw new HsrDeliveryAmbiguousError(
              deliveryId,
              `${detail}; an earlier same-id authority response was lost, so this failure does not prove provider non-acceptance`,
              transportError === undefined ? undefined : { cause: transportError },
            );
          }
          throw new Error(detail);
      }
    }
    throw new HsrDeliveryAmbiguousError(
      deliveryId,
      `remote HSR delivery ${deliveryId} to ${bee} lost its authority RPC outcome after ${DELIVERY_RECONCILE_ATTEMPTS} same-id reconciliation attempts`,
      transportError === undefined ? undefined : { cause: transportError },
    );
  }

  async function answerRemote(
    bee: string,
    operation: HsrAnswerOperation,
    answer: RunnerInputAnswer,
    locator: RemoteHsrLocator,
  ): Promise<HsrAnswerRpcResult> {
    if (
      operation.source.node !== node.name
      || operation.source.remoteLaunchId !== locator.remoteLaunchId
      || operation.source.remoteIncarnation !== locator.remoteIncarnation
    ) {
      throw new HsrAnswerConflictError(
        operation,
        `remote HSR answer ${operation.requestId} does not match ${node.name}'s launch/incarnation authority`,
      );
    }
    // Validate the content binding before opening a transport. A malformed or
    // digest-mismatched request is definitely unowned by the remote provider.
    const rpcParams = parseHsrAnswerRpcParams({ operation, answer });
    const params = {
      bee,
      ...rpcParams,
      ...(locator.remoteLaunchId ? { launchId: locator.remoteLaunchId } : {}),
      ...(locator.remoteIncarnation ? { incarnation: locator.remoteIncarnation } : {}),
    };
    let dispatchAttempted = false;
    let ownershipUnresolved = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < ANSWER_RECONCILE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25 * (2 ** (attempt - 1)), 200)));
      }
      let c: RemoteRunnerClient;
      try {
        c = await currentAuthorityForNewWork("answer");
      } catch (error) {
        if (!dispatchAttempted) throw error;
        ownershipUnresolved = true;
        lastError = error;
        continue;
      }
      let response: { ok?: boolean; result?: unknown; error?: string } | null;
      try {
        // The controller's durable receipt is the last safe point before RPC
        // bytes can leave this machine. A caller death after this write must
        // fence replacement/new work even if the remote authority has not yet
        // claimed provider dispatch.
        await markHsrAnswerOperationSending(bee, operation, "controller");
        dispatchAttempted = true;
        response = (await c.call("answer", params)) as { ok?: boolean; result?: unknown; error?: string } | null;
      } catch (error) {
        ownershipUnresolved = true;
        lastError = error;
        continue;
      }
      if (response?.ok) {
        let result: HsrAnswerRpcResult;
        try {
          result = parseHsrAnswerRpcResult(response.result);
        } catch (error) {
          ownershipUnresolved = true;
          lastError = error;
          continue;
        }
        if (result.status === "in-flight") {
          // Only the exact same operation is retried. If the active host never
          // publishes a terminal receipt, manual ambiguity is safer than a
          // fresh provider answer.
          ownershipUnresolved = true;
          lastError = new Error(`remote HSR answer ${operation.requestId} remains in flight`);
          continue;
        }
        return result;
      }
      const detail = `remote HSR answer for ${bee} on ${node.name} failed: ${response?.error ?? "unknown"}`;
      if (!ownershipUnresolved) {
        // A complete authority response with ok:false proves the node never
        // crossed its node→per-Bee transport boundary; restore the controller
        // offer so a corrected retry is possible. A lost/thrown response never
        // takes this path and remains durably sending/ambiguous.
        try {
          await returnHsrAnswerOperationToOffer(bee, operation, "controller");
        } catch (error) {
          return {
            status: "ambiguous",
            reason: `${detail}; controller transport ownership could not be rolled back: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        throw new Error(detail);
      }
      lastError = new Error(detail, lastError === undefined ? undefined : { cause: lastError });
    }
    return {
      status: "ambiguous",
      reason: `remote HSR answer ${operation.requestId} lost its authority outcome after ${ANSWER_RECONCILE_ATTEMPTS} same-operation reconciliation attempts: ${lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")}`,
    };
  }

  async function reconcileAnswerRemote(
    bee: string,
    operation: HsrAnswerOperation,
    verdict: HsrAnswerReconciliationVerdict,
    locator: RemoteHsrLocator,
  ): Promise<HsrAnswerRpcResult> {
    if (verdict !== "delivered" && verdict !== "discard") throw new Error("invalid HSR answer reconciliation verdict");
    if (
      operation.source.node !== node.name
      || operation.source.remoteLaunchId !== locator.remoteLaunchId
      || operation.source.remoteIncarnation !== locator.remoteIncarnation
    ) {
      throw new HsrAnswerConflictError(
        operation,
        `remote HSR answer ${operation.requestId} does not match ${node.name}'s launch/incarnation authority`,
      );
    }
    const params = {
      bee,
      operation,
      verdict,
      ...(locator.remoteLaunchId ? { launchId: locator.remoteLaunchId } : {}),
      ...(locator.remoteIncarnation ? { incarnation: locator.remoteIncarnation } : {}),
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < ANSWER_RECONCILE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25 * (2 ** (attempt - 1)), 200)));
      }
      try {
        // Reconciliation is a no-provider-I/O drain operation. Keep it
        // available on a busy old authority so an operator can settle receipts
        // before the node is upgraded; the exact launch/incarnation is still
        // checked by the server.
        const c = await client();
        const response = (await c.call("answerReconcile", params)) as
          | { ok?: boolean; result?: unknown; error?: string }
          | null;
        if (!response?.ok) throw new Error(response?.error ?? "remote authority rejected answer reconciliation");
        const result = parseHsrAnswerRpcResult(response.result);
        if (result.status === "settled" || result.status === "discarded" || result.status === "conflict") return result;
        if (result.status === "ambiguous") {
          lastError = new Error(result.reason);
          continue;
        }
        lastError = new Error(`remote HSR answer ${operation.requestId} is still in flight`);
      } catch (error) {
        lastError = error;
      }
    }
    return {
      status: "ambiguous",
      reason: `remote HSR answer reconciliation for ${operation.requestId} has no confirmed authority outcome: ${lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")}`,
    };
  }

  async function pendingInputRemote(
    bee: string,
    locator: { remoteLaunchId?: string; remoteIncarnation?: string },
  ): Promise<RemotePendingInputEnvelope> {
    const c = await client();
    const res = await c.call("pendingInput", {
      bee,
      ...(locator.remoteLaunchId ? { launchId: locator.remoteLaunchId } : {}),
      ...(locator.remoteIncarnation ? { incarnation: locator.remoteIncarnation } : {}),
    });
    if (!res || typeof res !== "object" || Array.isArray(res)) {
      throw new Error(`remote HSR pending-input read for ${bee} on ${node.name} returned an invalid response`);
    }
    const envelope = res as Record<string, unknown>;
    if (envelope.ok === false) {
      throw new Error(
        `remote HSR pending-input read for ${bee} on ${node.name} failed: ${typeof envelope.error === "string" ? envelope.error : "unknown"}`,
      );
    }
    const parsedHost = parseHsrAnswerRpcResult({ status: "settled", replayed: true, host: envelope.host });
    if (parsedHost.status !== "settled" || !parsedHost.host) {
      throw new Error(`remote HSR pending-input read for ${bee} on ${node.name} omitted its host identity`);
    }
    if (envelope.pending === null) return { pending: null, host: parsedHost.host };
    if (!envelope.pending || typeof envelope.pending !== "object" || Array.isArray(envelope.pending)) {
      throw new Error(`remote HSR pending-input read for ${bee} on ${node.name} returned an invalid pending request`);
    }
    const pending = envelope.pending as Record<string, unknown>;
    if (
      typeof pending.requestId !== "string"
      || typeof pending.ts !== "number" || !Number.isFinite(pending.ts)
      || (pending.kind !== "permission" && pending.kind !== "question")
      || typeof pending.question !== "string"
    ) {
      throw new Error(`remote HSR pending-input read for ${bee} on ${node.name} returned an invalid response`);
    }
    return { pending: pending as PendingNeedsInput, host: parsedHost.host };
  }

  async function reconcileEventIntegrityRemote(
    bee: string,
    integrityId: string,
    locator: RemoteHsrLocator,
  ): Promise<void> {
    const c = await client();
    const local = await readHsrEventIntegrityReceipt(bee);
    const deliveryVerdicts = local?.integrityId === integrityId
      ? local.deliveryVerdicts
      : undefined;
    const response = await c.call("eventIntegrityReconcile", {
      bee,
      integrityId,
      launchId: locator.remoteLaunchId,
      incarnation: locator.remoteIncarnation,
      ...(deliveryVerdicts ? { deliveryVerdicts } : {}),
    }) as { ok?: unknown; receipt?: unknown; error?: unknown } | null;
    if (!response || response.ok !== true) {
      throw new Error(
        `remote HSR event-integrity reconciliation for ${bee} on ${node.name} failed: ${String(response?.error ?? "invalid response")}`,
      );
    }
    if (response.receipt === undefined) {
      throw new Error(`remote HSR event-integrity reconciliation for ${bee} returned no exact receipt`);
    }
    // Remote authority is settled first. Import its exact acknowledged head
    // next; failure leaves the controller marker intact and a retry converges.
    await importRemoteHsrEventIntegrityReceipt(response.receipt, bee);
  }

  async function discardEventConsumerRemote(
    bee: string,
    consumerId: string,
    locator: RemoteHsrLocator,
  ): Promise<{ ackedSeq: number; throughSeq: number; lostFromSeq?: number; lostToSeq?: number; reclaimed: boolean }> {
    const c = await client();
    const response = await c.call("discardEventConsumer", {
      bee,
      consumerId,
      launchId: locator.remoteLaunchId,
      incarnation: locator.remoteIncarnation,
    }) as {
      ok?: unknown;
      error?: unknown;
      ackedSeq?: unknown;
      throughSeq?: unknown;
      lostFromSeq?: unknown;
      lostToSeq?: unknown;
      reclaimed?: unknown;
    };
    if (!response || response.ok !== true) {
      throw new Error(typeof response?.error === "string"
        ? response.error
        : `remote HSR consumer discard for ${bee} on ${node.name} failed`);
    }
    if (
      !Number.isSafeInteger(response.ackedSeq) || Number(response.ackedSeq) < 0
      || !Number.isSafeInteger(response.throughSeq) || Number(response.throughSeq) < Number(response.ackedSeq)
      || typeof response.reclaimed !== "boolean"
      || ((response.lostFromSeq === undefined) !== (response.lostToSeq === undefined))
      || (response.lostFromSeq !== undefined && (!Number.isSafeInteger(response.lostFromSeq) || Number(response.lostFromSeq) <= 0))
      || (response.lostToSeq !== undefined && (!Number.isSafeInteger(response.lostToSeq) || Number(response.lostToSeq) < Number(response.lostFromSeq)))
    ) {
      throw new Error(`remote HSR consumer discard for ${bee} on ${node.name} returned an invalid response`);
    }
    return {
      ackedSeq: Number(response.ackedSeq),
      throughSeq: Number(response.throughSeq),
      ...(response.lostFromSeq !== undefined ? { lostFromSeq: Number(response.lostFromSeq) } : {}),
      ...(response.lostToSeq !== undefined ? { lostToSeq: Number(response.lostToSeq) } : {}),
      reclaimed: response.reclaimed,
    };
  }

  async function launchHeadRemote(bee: string): Promise<RemoteLaunchHead> {
    const c = await client();
    const res = await c.call("spawnHead", { bee }, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!res || typeof res !== "object" || Array.isArray(res)) {
      throw new Error(`remote HSR launch-head read for ${bee} on ${node.name} returned an invalid response`);
    }
    const head = res as Record<string, unknown>;
    if (head.ok !== true) {
      throw new Error(
        `remote HSR launch-head read for ${bee} on ${node.name} failed: ${typeof head.error === "string" ? head.error : "unknown"}`,
      );
    }
    if (head.state === "empty") return { state: "empty" };
    if (
      head.state !== "reserved" && head.state !== "dispatching" && head.state !== "running"
      && head.state !== "refreshing" && head.state !== "stopping" && head.state !== "stopped"
    ) {
      throw new Error(`remote HSR launch-head read for ${bee} on ${node.name} returned an invalid state`);
    }
    if (
      typeof head.launchId !== "string" || !head.launchId
      || typeof head.incarnation !== "string" || !head.incarnation
    ) {
      throw new Error(`remote HSR launch-head read for ${bee} on ${node.name} returned incomplete authority tokens`);
    }
    return {
      state: head.state,
      launchId: head.launchId,
      incarnation: head.incarnation,
    };
  }

  async function kill(bee: string, options?: KillOptions): Promise<KillResult> {
    try {
      const c = await client();
      const res = (await c.call("kill", {
        bee,
        ...(options?.remoteLaunchId ? { launchId: options.remoteLaunchId } : {}),
        ...(options?.remoteIncarnation ? { incarnation: options.remoteIncarnation } : {}),
      })) as
        | {
            ok?: boolean;
            stdout?: string;
            stderr?: string;
            exitCode?: number;
            error?: string;
            incarnationStopped?: boolean;
            terminalHistoryPending?: boolean;
            pendingConsumers?: Array<{ consumerId: string; ackedSeq: number; throughSeq: number }>;
          }
        | null;
      if (res && res.ok) {
        return {
          ok: true,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
          exitCode: res.exitCode ?? 0,
          ...(res.incarnationStopped === true ? { incarnationStopped: true } : {}),
          ...(res.terminalHistoryPending === true ? { terminalHistoryPending: true } : {}),
          ...(Array.isArray(res.pendingConsumers) ? { pendingConsumers: res.pendingConsumers } : {}),
        };
      }
      return {
        ok: false,
        stdout: "",
        stderr: res?.error ?? "remote kill failed",
        exitCode: 1,
        ...(res?.incarnationStopped === true ? { incarnationStopped: true } : {}),
        ...(res?.terminalHistoryPending === true ? { terminalHistoryPending: true } : {}),
        ...(Array.isArray(res?.pendingConsumers) ? { pendingConsumers: res.pendingConsumers } : {}),
      };
    } catch (error) {
      return { ok: false, stdout: "", stderr: messageOf(error), exitCode: 1 };
    }
  }

  async function killRemoteIncarnation(
    bee: string,
    locator: { launchId: string; incarnation?: string },
  ): Promise<KillResult> {
    return kill(bee, {
      remoteLaunchId: locator.launchId,
      ...(locator.incarnation ? { remoteIncarnation: locator.incarnation } : {}),
    });
  }

  async function listSessions(): Promise<string[]> {
    const rows = await callList();
    assertListRowsAvailable(rows);
    return rows.filter((row) => row.live).map((row) => row.bee);
  }

  async function listRemoteRows(): Promise<RemoteListRow[]> {
    return callList();
  }

  async function listSessionStates(): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    // Transport loss remains an unknown/empty observation for legacy callers,
    // but authority/storage corruption is not absence and must reach the
    // canonical mirror fence.
    let rows: RemoteListRow[];
    try {
      rows = await callList();
    } catch (error) {
      if (error instanceof RemoteObservationIntegrityError) throw error;
      return states;
    }
    assertListRowsAvailable(rows);
    for (const row of rows) {
      if (!row.live) continue;
      states.set(row.bee, coarseHiveState(row.state));
    }
    return states;
  }

  async function spawnRemote(params: RemoteSpawnParams): Promise<RemoteSpawnResult> {
    const launchId = params.launchId ?? randomUUID();
    let c: Awaited<ReturnType<typeof client>>;
    let previousLaunchId = params.previousLaunchId;
    try {
      c = await currentAuthorityForNewWork("spawn");
      if (!previousLaunchId) {
        const head = (await c.call("spawnHead", { bee: params.bee }, { timeoutMs: PROBE_TIMEOUT_MS })) as
          | { ok?: boolean; launchId?: string; state?: string; error?: string }
          | null;
        if (!head?.ok) {
          throw new Error(`admission preflight for ${params.bee} failed: ${head?.error ?? "unknown"}`);
        }
        if (head.state === "stopped" && typeof head.launchId === "string" && head.launchId !== launchId) {
          previousLaunchId = head.launchId;
        }
      }
    } catch (error) {
      throw new RemoteSpawnNotAdmittedError(
        `refusing remote HSR spawn on ${node.name}: ${messageOf(error)}`,
        launchId,
        { cause: error },
      );
    }
    const wireParams = {
      bee: params.bee,
      launchId,
      // Admit this stable store+node projection before the provider can emit.
      // Fast terminal runs may compact before the daemon's first mirror tick;
      // the durable consumer keeps their exact prefix replayable.
      consumerId: observationConsumerId,
      ...(previousLaunchId ? { previousLaunchId } : {}),
      kind: params.kind,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.resume ? { resume: true } : {}),
      ...(params.authKind ? { authKind: params.authKind } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.comb ? { comb: params.comb } : {}),
      ...(params.parent ? { parent: params.parent } : {}),
      ...(params.creds ? { creds: params.creds } : {}),
      ...(params.home ? { home: params.home } : {}),
      spec: params.spec,
    };
    type SpawnWireResult = {
      ok?: boolean;
      safetyProtocol?: number;
      bee?: string;
      launchId?: string;
      incarnation?: string;
      tier?: string;
      sessionId?: string;
      cwd?: string;
      error?: string;
      pending?: boolean;
      stopped?: boolean;
      cleanupUnconfirmed?: boolean;
      notFound?: boolean;
      launchUnowned?: boolean;
    };

    function parseSuccess(res: SpawnWireResult): RemoteSpawnResult {
      if (
        typeof res.safetyProtocol !== "number"
        || res.safetyProtocol < REMOTE_HSR_SAFETY_PROTOCOL
        || res.bee !== params.bee
        || res.launchId !== launchId
        || typeof res.incarnation !== "string" || !res.incarnation
        || typeof res.cwd !== "string" || !isAbsolute(res.cwd)
      ) {
        throw new RemoteSpawnIndeterminateError(
          `remote HSR spawn of ${params.bee} on ${node.name} returned an invalid authority receipt`,
          launchId,
          typeof res.incarnation === "string" && res.incarnation ? res.incarnation : undefined,
        );
      }
      return {
        bee: params.bee,
        launchId,
        incarnation: res.incarnation,
        cwd: res.cwd,
        ...(typeof res.tier === "string" && res.tier ? { tier: res.tier } : {}),
        ...(typeof res.sessionId === "string" && res.sessionId ? { sessionId: res.sessionId } : {}),
      };
    }

    function interpret(res: SpawnWireResult | null): RemoteSpawnResult {
      if (res?.ok) return parseSuccess(res);
      if (res?.stopped || res?.launchUnowned) {
        throw new RemoteSpawnNotAdmittedError(
          `remote HSR spawn of ${params.bee} on ${node.name} was not admitted: ${res.error ?? "unknown"}`,
          launchId,
        );
      }
      if (res?.pending || res?.cleanupUnconfirmed) {
        throw new RemoteSpawnIndeterminateError(
          `remote HSR spawn of ${params.bee} on ${node.name} is unresolved: ${res.error ?? "unknown"}`,
          launchId,
          typeof res.incarnation === "string" && res.incarnation ? res.incarnation : undefined,
        );
      }
      throw new RemoteSpawnIndeterminateError(
        `remote HSR spawn of ${params.bee} on ${node.name} returned an unclassified failure: ${res?.error ?? "unknown"}`,
        launchId,
        typeof res?.incarnation === "string" && res.incarnation ? res.incarnation : undefined,
      );
    }

    let transportFailure: unknown;
    try {
      return interpret((await c.call("spawn", wireParams)) as SpawnWireResult | null);
    } catch (error) {
      if (error instanceof RemoteSpawnNotAdmittedError) throw error;
      if (error instanceof RemoteSpawnIndeterminateError) transportFailure = error;
      else transportFailure = error;
    }

    let learnedIncarnation: string | undefined = transportFailure instanceof RemoteSpawnIndeterminateError
      ? transportFailure.incarnation
      : undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const settled = (await c.call(
          "spawnReceipt",
          { bee: params.bee, launchId },
          { timeoutMs: PROBE_TIMEOUT_MS },
        )) as SpawnWireResult | null;
        if (settled?.ok) return parseSuccess(settled);
        if (typeof settled?.incarnation === "string" && settled.incarnation) learnedIncarnation = settled.incarnation;
        if (settled?.stopped) {
          throw new RemoteSpawnNotAdmittedError(
            `remote HSR spawn of ${params.bee} on ${node.name} was not admitted: ${settled.error ?? "launch failed"}`,
            launchId,
          );
        }
        // A not-found response proves the first dispatch never durably reserved;
        // a pending response may represent a post-reservation transport flap.
        // Reissuing the identical request is safe: reserved resumes once,
        // dispatching never reforks, and running deterministically replays.
        const retried = (await c.call("spawn", wireParams)) as SpawnWireResult | null;
        if (retried?.ok) return parseSuccess(retried);
        if (typeof retried?.incarnation === "string" && retried.incarnation) learnedIncarnation = retried.incarnation;
        if (retried?.stopped || retried?.launchUnowned) {
          throw new RemoteSpawnNotAdmittedError(
            `remote HSR spawn of ${params.bee} on ${node.name} was not admitted: ${retried.error ?? "launch failed"}`,
            launchId,
          );
        }
      } catch (error) {
        if (error instanceof RemoteSpawnNotAdmittedError) throw error;
        transportFailure = error;
      }
      if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new RemoteSpawnIndeterminateError(
      `remote HSR spawn of ${params.bee} on ${node.name} could not be reconciled: ${messageOf(transportFailure)}`,
      launchId,
      learnedIncarnation,
      { cause: transportFailure },
    );
  }

  async function refreshCredsRemote(params: RemoteRefreshCredsParams): Promise<RemoteRefreshCredsResult> {
    let c: Awaited<ReturnType<typeof client>>;
    try {
      c = await currentAuthorityForNewWork("credential refresh/restart");
    } catch (error) {
      // No request was dispatched; remote runtime ownership is unchanged.
      return { ok: false, error: messageOf(error) };
    }
    try {
      const res = (await c.call("refreshCreds", {
        bee: params.bee,
        creds: params.creds,
        ...(params.remoteLaunchId ? { launchId: params.remoteLaunchId } : {}),
        ...(params.remoteIncarnation ? { incarnation: params.remoteIncarnation } : {}),
      }, { timeoutMs: REFRESH_TIMEOUT_MS })) as
        | { ok?: boolean; sessionId?: string; error?: string; stopUnconfirmed?: boolean }
        | null;
      if (res && res.ok) return { ok: true, ...(typeof res.sessionId === "string" && res.sessionId ? { sessionId: res.sessionId } : {}) };
      return {
        ok: false,
        error: res?.error ?? "remote refreshCreds failed",
        ...(res?.stopUnconfirmed === true ? { stopUnconfirmed: true } : {}),
      };
    } catch (error) {
      // The server handler can continue after a client timeout/disconnect. Once
      // dispatched, failure is therefore ambiguous across stop/restart and must
      // fence local work until exact ownership is reconciled.
      return { ok: false, error: messageOf(error), stopUnconfirmed: true };
    }
  }

  async function provisionRemote(params: RemoteProvisionParams): Promise<RemoteProvisionResult> {
    const c = await currentAuthorityForNewWork("working-copy provision");
    const res = (await c.call(
      "provision",
      {
        repo: params.repo,
        ...(params.branch ? { branch: params.branch } : {}),
        ...(params.name ? { name: params.name } : {}),
        ...(params.ref ? { ref: params.ref } : {}),
      },
      { timeoutMs: PROVISION_TIMEOUT_MS },
    )) as { ok?: boolean; path?: string; repo?: string; branch?: string; reused?: boolean; error?: string } | null;
    if (!res || !res.ok || typeof res.path !== "string") {
      throw new Error(`remote HSR provision on ${node.name} failed: ${res?.error ?? "unknown"}`);
    }
    return {
      path: res.path,
      repo: res.repo ?? params.repo,
      ...(res.branch ? { branch: res.branch } : {}),
      reused: Boolean(res.reused),
    };
  }

  async function listCheckouts(): Promise<RemoteCheckoutRow[]> {
    const c = await client();
    const rows = await c.call("listCheckouts", undefined, { timeoutMs: LIST_CHECKOUTS_TIMEOUT_MS });
    return Array.isArray(rows) ? (rows as RemoteCheckoutRow[]) : [];
  }

  async function observe(
    bee: string,
    onEvent: (event: unknown) => void | Promise<void>,
    locator: { remoteLaunchId?: string; remoteIncarnation?: string } = {},
    options: RemoteObservationOptions = {},
  ): Promise<() => void> {
    const c = await client();
    let admittedEntry!: ObservedGeneration;
    let existing = observed.get(bee);
    if (existing?.failed) {
      existing.detach();
      observed.delete(bee);
      await existing.operationChain.catch(() => undefined);
      existing = undefined;
    }
    if (
      existing
      && (existing.remoteLaunchId !== locator.remoteLaunchId || existing.remoteIncarnation !== locator.remoteIncarnation)
    ) {
      throw new Error(`remote HSR observe generation changed for ${bee} on ${node.name}`);
    }
    if (options.afterSeq !== undefined && (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0)) {
      throw new Error(`remote HSR observe cursor for ${bee} must be a non-negative safe integer`);
    }
    if (existing) {
      await serializeObservation(existing, async () => {
        const requestedCursor = options.afterSeq ?? 0;
        if (requestedCursor !== existing!.cursor) {
          throw new Error(
            `remote HSR late observer for ${bee} requested cursor ${requestedCursor}, current durable cursor is ${existing!.cursor}`,
          );
        }
        existing!.subscribers.add(onEvent);
        const res = (await c.call("observe", observationParams(bee, existing!))) as {
          ok?: boolean;
          integrityFailure?: boolean;
          error?: string;
        } | null;
        if (!res?.ok) {
          existing!.subscribers.delete(onEvent);
          const detail = `remote HSR observe of ${bee} on ${node.name} failed: ${res?.error ?? "unknown"}`;
          if (res?.integrityFailure === true) throw new RemoteObservationIntegrityError(detail);
          throw new Error(detail);
        }
        existing!.count += 1;
      });
      admittedEntry = existing;
    } else {
      const entry: ObservedGeneration = {
        count: 1,
        ...(locator.remoteLaunchId ? { remoteLaunchId: locator.remoteLaunchId } : {}),
        ...(locator.remoteIncarnation ? { remoteIncarnation: locator.remoteIncarnation } : {}),
        subscribers: new Set([onEvent]),
        detach: () => undefined,
        cursor: options.afterSeq ?? 0,
        resuming: true,
        buffered: [],
        operationChain: Promise.resolve(),
      };
      admittedEntry = entry;
      observed.set(bee, entry);
      entry.detach = c.on("hsr.event", (params) => serializeObservation(
        entry,
        () => onObservedNotification(c, bee, entry, params),
      ));
      try {
        const res = (await c.call("observe", observationParams(bee, entry))) as {
          ok?: boolean;
          integrityFailure?: boolean;
          error?: string;
        } | null;
        if (!res?.ok) {
          const detail = `remote HSR observe of ${bee} on ${node.name} failed: ${res?.error ?? "unknown"}`;
          if (res?.integrityFailure === true) throw new RemoteObservationIntegrityError(detail);
          throw new Error(detail);
        }
        await options.afterAuthorized?.();
        await serializeObservation(
          entry,
          () => resumeObservation(c, bee, entry, {
            sync: false,
            initial: true,
            afterSynchronized: options.afterSynchronized,
          }),
        );
      } catch (error) {
        entry.detach();
        observed.delete(bee);
        await c.call("unobserve", observationParams(bee, entry)).catch(() => undefined);
        throw error;
      }
    }
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      admittedEntry.subscribers.delete(onEvent);
      // A callback may already have copied this subscriber and be awaiting its
      // durable projection. Drain the exact admitted generation before return.
      await admittedEntry.operationChain.catch(() => undefined);
      const current = observed.get(bee);
      // A failed/detached predecessor can be replaced in the map before its
      // caller finally invokes this closure. Never decrement or detach that
      // same-name successor; predecessor failure/close already released its
      // own remote refcount.
      if (current !== admittedEntry) return;
      const count = current?.count ?? 0;
      if (count <= 1 && observed.get(bee) === current) {
        current?.detach();
        observed.delete(bee);
      } else if (current && observed.get(bee) === current) current.count = count - 1;
      // Release the remote side too (HIVE-56): decrement the serve's relay
      // refcount so the last unsubscribe closes its connection to the bee's
      // control socket. Best-effort and fire-and-forget — if the tunnel is
      // down the next reconnect's `sync` reconciles the count anyway. Reuses
      // the memoized client only; never opens a connection just to release.
      await clientPromise?.then((c) => c.call("unobserve", {
        bee,
        consumerId: observationConsumerId,
        ...(locator.remoteLaunchId ? { launchId: locator.remoteLaunchId } : {}),
        ...(locator.remoteIncarnation ? { incarnation: locator.remoteIncarnation } : {}),
      })).catch(() => undefined);
    };
  }

  async function syncObservation(
    bee: string,
    locator: { remoteLaunchId?: string; remoteIncarnation?: string } = {},
  ): Promise<void> {
    const entry = observed.get(bee);
    if (!entry || entry.failed) {
      throw new RemoteObservationDetachedError(`remote HSR observation for ${bee} is not admitted`);
    }
    if (entry.remoteLaunchId !== locator.remoteLaunchId || entry.remoteIncarnation !== locator.remoteIncarnation) {
      throw new RemoteObservationDetachedError(`remote HSR observation generation changed for ${bee}`);
    }
    const c = await client();
    await serializeObservation(entry, () => resumeObservation(c, bee, entry, { sync: false }));
  }

  async function replayTerminalEvents(
    bee: string,
    onEvent: (event: RunnerEvent) => void | Promise<void>,
    locator: RemoteHsrLocator,
    afterSeq: number,
    afterSynchronized?: () => void | Promise<void>,
  ): Promise<void> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new Error(`remote HSR terminal cursor for ${bee} must be a non-negative safe integer`);
    }
    const c = await client();
    const params = {
      bee,
      consumerId: observationConsumerId,
      launchId: locator.remoteLaunchId,
      incarnation: locator.remoteIncarnation,
    };
    let cursor = afterSeq;
    const ackCursor = async (terminalActivated = false): Promise<void> => {
      if (cursor <= 0) return;
      const ack = await c.call("ackEvents", {
        ...params,
        upToSeq: cursor,
        ...(terminalActivated ? { terminalActivated: true } : {}),
      }) as {
        ok?: boolean;
        integrityFailure?: boolean;
        error?: string;
      } | null;
      if (!ack?.ok) {
        const detail = `remote terminal event acknowledgement was refused: ${ack?.error ?? "invalid response"}`;
        if (ack?.integrityFailure === true) throw new RemoteObservationIntegrityError(detail);
        throw new Error(detail);
      }
    };
    let pageToken: string | undefined;
    for (;;) {
      const requestedCursor = cursor;
      const response = await c.call("events", {
        ...params,
        afterSeq: requestedCursor,
        ...(pageToken ? { pageToken } : {}),
      }) as RemoteEventReplayResponse | null;
      if (!response?.ok || !Array.isArray(response.events)) {
        const detail = `remote terminal event replay was refused: ${response?.error ?? "invalid response"}`;
        if (response?.integrityFailure === true) throw new RemoteObservationIntegrityError(detail);
        throw new Error(detail);
      }
      if (response.gap !== undefined) {
        throw new RemoteObservationIntegrityError(
          `remote terminal event history has a gap ${String(response.gap.fromSeq)}..${String(response.gap.toSeq)}`,
        );
      }
      if (response.hasMore !== undefined && response.events.length > REMOTE_EVENT_REPLAY_PAGE_MAX_EVENTS) {
        throw new RemoteObservationIntegrityError("remote terminal replay exceeded its bounded page size");
      }
      for (const raw of response.events) {
        if (!runnerEvent(raw) || !Number.isSafeInteger(raw.seq) || Number(raw.seq) <= 0) {
          throw new RemoteObservationIntegrityError("remote terminal replay contained a malformed event");
        }
        const seq = Number(raw.seq);
        if (seq <= cursor) continue;
        if (seq !== cursor + 1) {
          throw new RemoteObservationIntegrityError(
            `remote terminal event sequence gap ${cursor + 1}..${seq - 1}`,
          );
        }
        await onEvent(raw);
        cursor = seq;
      }
      pageToken = replayPageContinuation(response, requestedCursor, cursor);
      if (pageToken && cursor > requestedCursor) await ackCursor();
      if (!pageToken) break;
    }
    await afterSynchronized?.();
    // Re-ack after activation too: a crash after local cursor persistence but
    // before the previous source ack must heal even when the final page is empty.
    await ackCursor(true);
  }

  return {
    kind: "remote-hsr",
    node: node.name,
    endpoint: node.endpoint,
    // The mode forwards over the send RPC, so native/fallback next-tool
    // steering works exactly as it does on a local runner host.
    supportsNextTool: true,
    probe,
    hasSession,
    // Spawn goes through spawnRemote (the remote serve forks the runner host), so
    // the tmux newSession verb is never reached — throw to catch a mis-route.
    newSession(): Promise<NewSessionResult> {
      throw new Error("remote HSR bees spawn via the remote runner host, not newSession");
    },
    kill,
    capture,
    sendText,
    // HSR commits a turn atomically in sendText — no separate Enter/keystroke channel.
    async sendEnter(): Promise<void> {
      /* no-op */
    },
    async sendKey(): Promise<void> {
      /* no-op */
    },
    listSessions,
    async listPanes(): Promise<Set<string>> {
      return new Set();
    },
    listSessionStates,
    // Pane/window/user-option verbs are tmux-only; remote HSR bees have no pane.
    async setUserOptions(): Promise<void> {
      /* no-op */
    },
    async setWindowOptions(_target: string, _options: TmuxWindowOptions | undefined): Promise<void> {
      /* no-op */
    },
    async renameWindow(): Promise<void> {
      /* no-op */
    },
    attachCommand(): string[] {
      return [];
    },
    async attachSession(): Promise<void> {
      throw new Error("remote HSR bees have no tmux target; use hive tail/transcript");
    },
    ping,
    spawnRemote,
    listRemoteRows,
    replayTerminalEvents,
    answerRemote,
    reconcileAnswerRemote,
    reconcileEventIntegrityRemote,
    discardEventConsumerRemote,
    pendingInputRemote,
    launchHeadRemote,
    killRemoteIncarnation,
    refreshCredsRemote,
    provisionRemote,
    listCheckouts,
    observe,
    syncObservation,
    eventsTail,
    async close(): Promise<void> {
      closed = true;
      clearInterval(observationReconcileTimer);
      if (reobserveRetryTimer !== undefined) {
        clearTimeout(reobserveRetryTimer);
        reobserveRetryTimer = undefined;
      }
      const releasing = [...observed];
      for (const [, entry] of releasing) entry.detach();
      observed.clear();
      if (!clientPromise) return;
      const pending = clientPromise;
      clientPromise = undefined;
      await pending
        .then(async (c) => {
          // Best-effort: release every relay we still hold before dropping the
          // connection, so the serve's per-bee clients don't outlive us (HIVE-56).
          for (const [bee, entry] of releasing) {
            await c.call("unobserve", {
              bee,
              consumerId: observationConsumerId,
              count: entry.count,
              ...(entry.remoteLaunchId ? { launchId: entry.remoteLaunchId } : {}),
              ...(entry.remoteIncarnation ? { incarnation: entry.remoteIncarnation } : {}),
            }).catch(() => undefined);
          }
          c.close();
        })
        .catch(() => undefined);
    },
  };
}
