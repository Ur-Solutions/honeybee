/**
 * HSR daemon-hosted aggregate control/observe endpoint (APIA-73).
 *
 * One unix socket under daemonRoot() that the CLI/Apiary use to steer and watch
 * EVERY HSR bee through a single plane (HSR_EXPLORATION.md §6, §7): spawn, send,
 * interrupt, answer, stop, snapshot, liveness, list, and a live event relay.
 *
 * This endpoint owns no runner and holds no harness pipes. The per-bee control
 * sockets (owned by each detached runner host — see src/hsr/host.ts) do the
 * actual steering; this server is a thin aggregate that:
 *   - reads run dirs for liveness/list (hsrObservations + readHsrMeta), and
 *   - PROXIES steering calls to a bee's control socket (connect → call → close), and
 *   - RELAYS each bee's `event` notifications out as `hsr.event` broadcasts.
 *
 * It reuses the APIA-73 JSON-RPC transport (src/hsr/rpc.ts) for both the
 * aggregate server and the per-bee client connections. No new deps.
 *
 * Resilience: every handler catches and returns `{ ok: false, error }` rather
 * than throwing, so one bad bee never wedges the shared plane. The daemon starts
 * this best-effort — a socket failure must NOT stop the daemon (see run.ts).
 */

import { join } from "node:path";
import { CELL_BROKER_CAPABILITY_VERSION } from "../cellBrokerCapability.js";
import {
  connectRpcClient,
  startRpcServer,
  type RpcClient,
  type RpcMethodHandler,
  type RpcServer,
} from "../hsr/rpc.js";
import { hsrObservations, pendingNeedsInput } from "../hsr/observe.js";
import { readHsrMeta } from "../hsr/runDir.js";
import { assertCallerEnvAllowed } from "../spawnEnv.js";
import { resolveExplicitSpawningBeeId } from "../spawnParent.js";
import { isArchivedSessionLifecycle } from "../stateMachine.js";
import { readDeliveryDoubt } from "../deliveryDoubt.js";
import { readPendingHsrTurn } from "../hsr/pendingTurns.js";
import { readBeeRequestsStrict } from "../requests/store.js";
import { createExecutionAdminMethods } from "../execution/adminMethods.js";
import { createExecutionRpcMethods } from "../execution/rpcMethods.js";
import { createProductionExecutionServiceProvider } from "../execution/production.js";
import type { ExecutionService } from "../execution/service.js";
import type { SessionRecord } from "../store.js";
import type { Substrate } from "../substrates/types.js";
import type { RemoteHsrSubstrate } from "../substrates/remote-hsr.js";
import { createBrokerMethods, type BrokerHandlerOptions } from "./broker.js";
import { daemonRoot } from "./log.js";

export type HsrControlServer = {
  path: string;
  close(): Promise<void>;
};

/**
 * The aggregate control socket path: `<daemonRoot()>/hsr-control.sock`. A short
 * path, well under the AF_UNIX ~104-byte limit (unlike the per-bee run-dir
 * sockets, which is why those are hashed under /tmp — see runDir.ts).
 */
export function hsrControlSocketPath(): string {
  return join(daemonRoot(), "hsr-control.sock");
}

/** Validate a spawn RPC env object and render it as repeated --env argv. */
export function hsrSpawnEnvArgv(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("spawn env must be an object of string values");
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`spawn env value for ${key} must be a string`);
    env[key] = item;
  }
  assertCallerEnvAllowed(env);
  return Object.entries(env).flatMap(([key, item]) => ["--env", `${key}=${item}`]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type HsrMessageParams = {
  bee: string;
  text: string;
  sender?: string;
  subject?: string;
  messageId?: string;
};

type HsrMessageAcceptanceHooks = {
  /** Test-only fault boundary after queue persistence and before its recovery cursor. */
  beforeRecoveryCommit?: (messageId: string) => void | Promise<void>;
  /** Deterministic transport injection for lifecycle/cross-node acceptance tests. */
  substrateFor?: (record: SessionRecord) => Substrate;
};

function hsrMessageRefusal(
  error: string,
  refusal: "pre-admission" | "idempotency-conflict" = "pre-admission",
): Record<string, unknown> {
  return { ok: false, accepted: false, refusal, error };
}

function hsrMessageAmbiguity(
  error: string,
  messageId?: string,
  accepted?: true,
): Record<string, unknown> {
  return {
    ok: false,
    ...(accepted ? { accepted: true } : {}),
    acceptanceAmbiguous: true,
    ...(messageId ? { messageId, retryWithSameMessageId: true } : {}),
    error,
  };
}

async function acceptHsrMessageOnce(
  params: HsrMessageParams,
  hooks?: HsrMessageAcceptanceHooks,
): Promise<Record<string, unknown>> {
  if (!params.bee) return hsrMessageRefusal("bee required");
  if (!params.text.trim()) return hsrMessageRefusal("message text required");
  const { resolveSession } = await import("../cli/shared.js");
  const record = await resolveSession(params.bee);
  const [
    {
      isUuidV7,
      openMessageDeliveryRequest,
      readMessageById,
      readSenderOutboxById,
      sanitizeHumanName,
      sendBuzMessageInAdmission,
      settleQueuedBuzMessageUndeliverable,
    },
    { substrateFor: defaultSubstrateFor },
    { withSessionLifecycleTransaction },
    { assertReviveWorkingDirectory },
  ] = await Promise.all([
    import("../buz.js"),
    import("../substrates/index.js"),
    import("../lifecycle.js"),
    import("../commands/migrate.js"),
  ]);
  if (params.messageId !== undefined && !isUuidV7(params.messageId)) {
    return hsrMessageRefusal("messageId must be an RFC 9562 UUIDv7");
  }
  const senderName = sanitizeHumanName(params.sender ?? "apiary");
  // sendBuzMessage omits an empty subject. Normalize the replay comparison to
  // that wire shape so `subject: ""` cannot manufacture an id collision.
  const subject = params.subject || undefined;
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();

    let existing: Awaited<ReturnType<typeof readMessageById>> = null;
    if (params.messageId) {
      existing = await readMessageById(current.name, params.messageId, { strict: true });
      existing ??= await readSenderOutboxById({ kind: "human", name: senderName }, params.messageId, { strict: true });
      if (existing) {
        const samePayload = existing.message.to === current.name &&
          existing.message.body === params.text &&
          existing.message.subject === subject &&
          existing.message.from.kind === "human" &&
          existing.message.from.name === senderName;
        if (!samePayload) {
          return hsrMessageRefusal(
            `messageId ${params.messageId} is already used with a different payload`,
            "idempotency-conflict",
          );
        }
      }
    }

    // A caller-owned id is the durable acceptance authority. Resolve it before
    // new-admission lifecycle checks: a reply can be lost and the bee can be
    // archived before the caller replays the exact accepted operation.
    if (existing && (
      existing.message.deliveredAt || existing.mailbox === "inbox" || existing.mailbox === "read"
    )) {
      return {
        ok: true,
        accepted: true,
        messageId: existing.message.id,
        delivery: "delivered",
        idempotent: true,
      };
    }

    // `outbox` is an attempted audit copy, not recipient admission. Exact
    // same-payload replay is safe to resume because strict lookup above proved
    // queue/inbox/read/quarantine absent; a different payload was refused.
    if (existing?.mailbox === "outbox") {
      existing = null;
    }

    if (existing?.mailbox === "queue") {
      const [doubt, turn, requests] = await Promise.all([
        readDeliveryDoubt(current.name, existing.message.id),
        readPendingHsrTurn(current.name, existing.message.id),
        readBeeRequestsStrict(current.name),
      ]);
      const manualFence = requests.find((request) => {
        if (request.status !== "open" || request.evidence.detail !== "delivery-ambiguous") return false;
        const input = request.input && typeof request.input === "object"
          ? request.input as Record<string, unknown>
          : {};
        return input.messageId === existing!.message.id || input.deliveryId === existing!.message.id;
      });
      if (doubt?.phase === "ambiguous" || turn?.phase === "ambiguous" || manualFence) {
        return hsrMessageAmbiguity(
          `messageId ${existing.message.id} has unresolved provider delivery ownership`,
          existing.message.id,
          true,
        );
      }
    }

    const terminalReason = isArchivedSessionLifecycle(current)
      ? `${current.name} is archived`
      : current.status === "kill_failed"
        ? `${current.name} is archived (stop state unresolved)`
        : undefined;
    if (terminalReason && !existing) return hsrMessageRefusal(terminalReason);

    // Do not probe or deliver through a stop-doubt record. An exact accepted
    // replay still reaches the undeliverable settlement below, while a new
    // logical message was refused above.
    const substrate = hooks?.substrateFor?.(current) ?? defaultSubstrateFor(current);
    const live = terminalReason
      ? false
      : await substrate.hasSession(current.tmuxTarget).catch(() => false);

    let cwdUnavailable = false;
    // A remote-HSR cwd is authoritative on the node and commonly does not
    // exist on this machine. Live delivery needs no cwd probe; cold recovery
    // queues behind the remote authority instead of fabricating missing-cwd.
    if (substrate.kind !== "remote-hsr") {
      try {
        await assertReviveWorkingDirectory(current);
      } catch {
        cwdUnavailable = true;
      }
    }
    const missingProviderSession = !live && !current.providerSessionId;

    const sent = existing
      ? { message: existing.message }
      : await sendBuzMessageInAdmission({
          recipient: current,
          sender: { kind: "human", name: senderName },
          // Known-undeliverable work is still persisted first, but must not
          // make a doomed live transport attempt before needs-action is durable.
          tier: cwdUnavailable || missingProviderSession ? "queue" : "next-tool",
          body: params.text,
          ...(params.messageId ? { messageId: params.messageId } : {}),
          ...(subject ? { subject } : {}),
          ...(cwdUnavailable || missingProviderSession
            ? {}
            : {
                transport: {
                  substrate,
                  tmuxTarget: current.tmuxTarget,
                  agentPaneId: current.agentPaneId,
                },
              }),
          ...(current.node ? { node: current.node } : {}),
        }, { lifecycle });

    const messageId = sent.message.id;
    if (sent.message.deliveredAt) {
      return {
        ok: true,
        accepted: true,
        messageId,
        delivery: "delivered",
        ...(existing ? { idempotent: true } : {}),
      };
    }

    const undeliverableReason = terminalReason && existing
      ? "archive-unresolved" as const
      : cwdUnavailable
        ? "missing-cwd" as const
        : missingProviderSession
          ? "missing-provider-session" as const
          : existing?.mailbox === "quarantine"
            ? "queued-message-missing" as const
            : undefined;
    if (undeliverableReason) {
      // UNDELIVERABLE is a terminal delivery verdict, not merely a UI label.
      // Remove the exact accepted id from queue/ under the same delivery lock
      // as the daemon drainer, while retaining it in quarantine as the durable
      // idempotency receipt. If a concurrent drain won first, report delivery
      // instead of opening a contradictory manual-action request.
      const settlement = await settleQueuedBuzMessageUndeliverable(
        current.name,
        messageId,
        undeliverableReason,
      );
      if (settlement.outcome === "delivered") {
        return {
          ok: true,
          accepted: true,
          messageId,
          delivery: "delivered",
          idempotent: true,
        };
      }
      const requestId = await openMessageDeliveryRequest(current, messageId, undeliverableReason);
      return {
        ok: true,
        accepted: true,
        messageId,
        delivery: "undeliverable",
        outcome: "UNDELIVERABLE",
        requestId,
        ...(existing ? { idempotent: true } : {}),
      };
    }

    if (!current.recoveryRequestedAt || !current.recoveryMessageId) {
      // The queue file is already durable. This separate first-class fact is
      // the daemon work-set obligation; it changes neither lifecycle status
      // nor the last state actually observed from the runtime. One record is
      // a cursor over the durable queue, so a later accepted message must not
      // replace an older unresolved owner.
      await lifecycle.refresh();
      await hooks?.beforeRecoveryCommit?.(messageId);
      await lifecycle.commit({
        recoveryRequestedAt: new Date().toISOString(),
        recoveryMessageId: messageId,
        recoveryAttemptCount: 0,
        recoveryNextAttemptAt: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    return {
      ok: true,
      accepted: true,
      messageId,
      delivery: "queued",
      ...(existing ? { idempotent: true } : {}),
    };
  });
}

async function hsrMessageWasDurablyAccepted(params: HsrMessageParams): Promise<boolean> {
  if (!params.messageId) return false;
  const [{ resolveSession }, { readMessageById, sanitizeHumanName }] = await Promise.all([
    import("../cli/shared.js"),
    import("../buz.js"),
  ]);
  const record = await resolveSession(params.bee);
  const existing = await readMessageById(record.name, params.messageId, { strict: true });
  if (!existing || existing.mailbox === "outbox") return false;
  const senderName = sanitizeHumanName(params.sender ?? "apiary");
  return existing.message.to === record.name
    && existing.message.body === params.text
    && existing.message.subject === (params.subject || undefined)
    && existing.message.from.kind === "human"
    && existing.message.from.name === senderName;
}

/** Durable user-level message acceptance, independent of aggregate RPC I/O. */
export async function acceptHsrMessage(
  params: HsrMessageParams,
  hooks?: HsrMessageAcceptanceHooks,
): Promise<Record<string, unknown>> {
  try {
    return await acceptHsrMessageOnce(params, hooks);
  } catch (firstError) {
    // A caller key lets the daemon safely retry its own persist/finalize
    // operation. The retry re-reads the recipient mailbox before doing work,
    // so a throw after sendBuzMessage cannot become a false refusal or a
    // duplicate message. One-shot store faults therefore heal within the same
    // RPC and return an idempotent receipt.
    if (params.messageId) {
      try {
        const repaired = await acceptHsrMessageOnce(params, hooks);
        if (repaired.ok === true) return repaired;
      } catch (repairError) {
        const accepted = await hsrMessageWasDurablyAccepted(params).catch(() => false);
        return hsrMessageAmbiguity(
          `${messageOf(firstError)}; idempotent receipt recovery failed: ${messageOf(repairError)}`,
          params.messageId,
          accepted ? true : undefined,
        );
      }

      // The first attempt threw, so even a later refusal cannot prove that no
      // recipient write happened in the crash window. Keep the exact key alive.
      const accepted = await hsrMessageWasDurablyAccepted(params).catch(() => false);
      return hsrMessageAmbiguity(
        `${messageOf(firstError)}; durable acceptance could not be reconciled`,
        params.messageId,
        accepted ? true : undefined,
      );
    }

    // Without a caller key there is no replay-safe identity. Preserve the
    // distinction from a positive refusal, but do not advertise safe retry.
    return hsrMessageAmbiguity(messageOf(firstError));
  }
}

export async function startHsrControlServer(opts?: {
  socketPath?: string;
  /** Execution-protocol coordinator override (tests inject fakes). */
  executionService?: () => ExecutionService | Promise<ExecutionService>;
  /** Cell broker dependency overrides (tests inject policy/spawn fakes). */
  broker?: BrokerHandlerOptions;
}): Promise<HsrControlServer> {
  const socketPath = opts?.socketPath ?? hsrControlSocketPath();

  // Live event relays, one cached client per observed bee. Ref-counted across
  // subscribers so N `observe(bee)` calls share ONE connection to the bee's
  // control socket; dropped when the bee dies (its control socket closes) or on
  // server.close().
  type Relay = { client: RpcClient; refCount: number; unsubscribe: () => void };
  const relays = new Map<string, Relay>();

  // Assigned once startRpcServer resolves; handlers/relays run strictly after,
  // so the closure read is always defined.
  let server: RpcServer;

  /**
   * Connect a bee's control socket, invoke one method, and close. Returns
   * `{ ok:true, result }` or `{ ok:false, error }`; never throws. A bee whose
   * meta is missing / not "running" / lacks a control socket has no live host.
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

  /** Sanitize a caller-supplied flags object into a Parsed flags map. */
  function rpcFlags(value: unknown): Map<string, string | true | string[]> {
    const flags = new Map<string, string | true | string[]>();
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === true) flags.set(key, true);
        else if (typeof entry === "string") flags.set(key, entry);
        else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) flags.set(key, entry as string[]);
      }
    }
    return flags;
  }

  /** Wrap a handler so it can never throw out to the transport. */
  function guarded(fn: (params: unknown) => Promise<unknown>): RpcMethodHandler {
    return async (params) => {
      try {
        return await fn(params);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    };
  }

  const methods: Record<string, RpcMethodHandler> = {
    // Feature handshake for clients that must not guess across daemon versions:
    // spawn:2 = in-process spawnSingleBee with prompt/flags/rest support;
    // spawnEnv:1 = the optional env object accepted by spawn (validated, then
    // forwarded as repeated --env). spawnParent:1 = authenticated hosts may
    // pass top-level spawnedById; generic flags/env cannot set lineage.
    // message:1 = durable user-level send; accepts before runtime recovery and
    // rejects only an archived/destroyed bee. fork:1/handoff:1 = in-process
    // cmdFork/cmdHandoff (session-fork-and-handoff epic). An older daemon
    // rejects unknown methods outright, which reads as "CLI fallback".
    // broker:3 = every Cell broker read/mutation requires a generation-bound
    // runtime capability; broker:spawn remains the v2 additive verb.
    // execution:1 = the contracts/execution/v1 protocol methods
    // (protocol.hello, node.describe, run.start/get/events) are registered on
    // this socket; real capability negotiation is protocol.hello itself.
    // executionAdmin:1 = the node-local administrative bootstrap methods
    // (executionAdmin.bindLocalAuthorityHost / .registerWorkingCopy). These
    // are NOT corpus methods and are never claimed by protocol.hello; see
    // src/execution/adminMethods.ts for the trust boundary.
    capabilities: guarded(async () => ({
      ok: true,
      spawn: 2,
      spawnEnv: 1,
      spawnParent: 1,
      message: 1,
      broker: CELL_BROKER_CAPABILITY_VERSION,
      fork: 1,
      handoff: 1,
      execution: 1,
      executionAdmin: 1,
    })),

    liveness: guarded(async () => {
      const out: Record<string, boolean> = {};
      for (const [bee, observation] of await hsrObservations()) out[bee] = observation.live;
      return out;
    }),

    list: guarded(async () => {
      const observations = await hsrObservations();
      const rows: Array<Record<string, unknown>> = [];
      for (const [bee, observation] of observations) {
        const meta = await readHsrMeta(bee);
        rows.push({
          bee,
          live: observation.live,
          state: observation.state ?? null,
          tier: meta?.tier ?? null,
          sessionId: meta?.sessionId ?? null,
          status: meta?.status ?? null,
          controlSocket: meta?.controlSocket ?? null,
        });
      }
      return rows;
    }),

    // Product-level messaging boundary for Apiary. Unlike the raw `send`
    // proxy below, this records the message durably before it depends on a
    // runner. A cold active-lifecycle bee therefore returns acceptance and the
    // daemon queue dispatcher revives it; harness/substrate states stay out of
    // the client contract.
    message: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; text?: unknown; sender?: unknown; subject?: unknown; messageId?: unknown };
      return acceptHsrMessage({
        bee: String(p.bee ?? ""),
        text: String(p.text ?? ""),
        ...(typeof p.sender === "string" ? { sender: p.sender } : {}),
        ...(typeof p.subject === "string" ? { subject: p.subject } : {}),
        ...(typeof p.messageId === "string" ? { messageId: p.messageId } : {}),
      });
    }),

    send: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; text?: unknown; mode?: unknown };
      const bee = String(p.bee ?? "");
      const [{ resolveSession }, { withRunnableSessionAdmission }] = await Promise.all([
        import("../cli/shared.js"),
        import("../delivery.js"),
      ]);
      const record = await resolveSession(bee);
      const result = await withRunnableSessionAdmission(record, async () => proxyCall(bee, "send", {
        text: String(p.text ?? ""),
        ...(p.mode === "next-tool" ? { mode: "next-tool" } : {}),
      }));
      return result.ok ? { ok: true } : result;
    }),

    interrupt: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "interrupt");
      return result.ok ? { ok: true, result: result.result } : result;
    }),

    answer: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; requestId?: unknown; source?: unknown; host?: unknown; answer?: unknown };
      const bee = String(p.bee ?? "");
      const [
        { resolveSession },
        { withRunnableSessionAdmission },
        { answerLocalHsrSessionInAdmission, hsrAnswerHostFromMeta, persistHsrAnswerAmbiguity },
        answerReceipts,
        { substrateFor },
      ] = await Promise.all([
        import("../cli/shared.js"),
        import("../delivery.js"),
        import("../hsr/answer.js"),
        import("../answerReceipt.js"),
        import("../substrates/index.js"),
      ]);
      const record = await resolveSession(bee);
      const result = await withRunnableSessionAdmission(record, async (_lifecycle, current) => {
        const requestId = typeof p.requestId === "string" && p.requestId ? p.requestId : undefined;
        if (!requestId || p.source === undefined || p.host === undefined) {
          throw new Error("HSR control answer requires exact requestId, source, and host identities");
        }
        const expectedSource = answerReceipts.parseHsrAnswerExpectedSource(p.source);
        if (!answerReceipts.hsrAnswerExpectedSourceOwnsRecord(expectedSource, current)) {
          throw new Error(`stale HSR answer source does not own ${bee}'s current runtime generation`);
        }
        const currentSubstrate = substrateFor(current);
        const locator = {
          ...(current.remoteLaunchId ? { remoteLaunchId: current.remoteLaunchId } : {}),
          ...(current.remoteIncarnation ? { remoteIncarnation: current.remoteIncarnation } : {}),
        };
        const pendingState = currentSubstrate.kind === "remote-hsr"
          ? await (currentSubstrate as RemoteHsrSubstrate).pendingInputRemote(bee, locator)
          : await (async () => {
              const meta = await readHsrMeta(bee);
              if (!meta) throw new Error(`No HSR host metadata for ${bee}`);
              return { pending: await pendingNeedsInput(bee), host: hsrAnswerHostFromMeta(meta) };
            })();
        const { pending, host } = pendingState;
        const expectedHost = answerReceipts.parseHsrAnswerHostIdentity(p.host);
        if (!answerReceipts.sameHsrAnswerHostIdentity(expectedHost, host)) {
          throw new Error(`stale HSR answer host does not own ${bee}'s current runner incarnation`);
        }
        const answer = typeof p.answer === "string"
          ? p.answer
          : Array.isArray(p.answer) && p.answer.every((row) =>
              Array.isArray(row) && row.every((item) => typeof item === "string"))
            ? p.answer as string[][]
            : undefined;
        if (answer === undefined) throw new Error("HSR control answer requires a string or string-matrix answer");
        let delivered: Awaited<ReturnType<typeof answerLocalHsrSessionInAdmission>>;
        if (currentSubstrate.kind === "remote-hsr") {
          const operation = answerReceipts.createHsrAnswerOperation(current, requestId, answer, host);
          await answerReceipts.assertNoUnresolvedHsrAnswerOwnership(current, "hsr control answer", operation);
          await answerReceipts.offerHsrAnswerOperation(bee, operation);
          const remoteResult = await (currentSubstrate as RemoteHsrSubstrate).answerRemote(bee, operation, answer, locator);
          if (remoteResult.status === "settled") {
            await answerReceipts.reconcileHsrAnswerOperation(bee, operation, "delivered");
          } else if (remoteResult.status === "discarded") {
            await answerReceipts.reconcileHsrAnswerOperation(bee, operation, "discard");
          } else if (remoteResult.status === "ambiguous" || remoteResult.status === "in-flight") {
            await persistHsrAnswerAmbiguity(
              current,
              operation,
              remoteResult.status === "ambiguous" ? remoteResult.reason : `answer ${requestId} remains in flight`,
              remoteResult.status === "ambiguous" ? remoteResult.host : undefined,
            );
          } else if (remoteResult.status === "conflict") {
            await persistHsrAnswerAmbiguity(current, operation, remoteResult.reason);
          }
          delivered = { operation, result: remoteResult };
        } else {
          delivered = await answerLocalHsrSessionInAdmission(current, requestId, answer);
        }
        if (delivered.result.status === "settled") {
          const [{ resolveRequest }, { needsInputRequestId }] = await Promise.all([
            import("../requests/store.js"),
            import("../requests/keys.js"),
          ]);
          await resolveRequest(
            bee,
            pending?.requestId === requestId
              ? needsInputRequestId(bee, { ...pending, host })
              : needsInputRequestId(bee, { requestId, ts: 0, host: delivered.operation.host }),
            { by: "hsr-control-answer", resolution: typeof answer === "string" ? answer : JSON.stringify(answer) },
          );
          return { ok: true, operation: delivered.operation, result: delivered.result };
        }
        return { ok: false, operation: delivered.operation, result: delivered.result };
      }, { operation: "hsr control answer", deferAnswerOwnershipToExactOperation: true });
      return result;
    }),

    pendingInput: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const bee = String(p.bee ?? "");
      const [
        { resolveSession },
        { withSessionLifecycleTransaction },
        { hsrAnswerExpectedSource },
        { hsrAnswerHostFromMeta },
        { substrateFor },
      ] = await Promise.all([
        import("../cli/shared.js"),
        import("../lifecycle.js"),
        import("../answerReceipt.js"),
        import("../hsr/answer.js"),
        import("../substrates/index.js"),
      ]);
      const snapshot = await resolveSession(bee);
      return withSessionLifecycleTransaction(snapshot, async (lifecycle) => {
        const current = await lifecycle.refresh();
        const substrate = substrateFor(current);
        const pendingState = substrate.kind === "remote-hsr"
          ? await (substrate as RemoteHsrSubstrate).pendingInputRemote(bee, {
              ...(current.remoteLaunchId ? { remoteLaunchId: current.remoteLaunchId } : {}),
              ...(current.remoteIncarnation ? { remoteIncarnation: current.remoteIncarnation } : {}),
            })
          : await (async () => {
              const meta = await readHsrMeta(bee);
              if (!meta) throw new Error(`No HSR host metadata for ${bee}`);
              return { pending: await pendingNeedsInput(bee), host: hsrAnswerHostFromMeta(meta) };
            })();
        return pendingState.pending
          ? { ...pendingState.pending, source: hsrAnswerExpectedSource(current), host: pendingState.host }
          : null;
      });
    }),

    stop: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "stop");
      return result.ok ? { ok: true, result: result.result } : result;
    }),

    snapshot: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; lines?: unknown };
      const args = typeof p.lines === "number" ? { lines: p.lines } : {};
      return await proxyCall(String(p.bee ?? ""), "snapshot", args);
    }),

    // Establish (or ref-count into) a relay of the bee's live event stream. Each
    // `event` notification the bee's control socket pushes is re-broadcast to
    // ALL aggregate clients as `hsr.event` { bee, event }.
    observe: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const existing = relays.get(bee);
      if (existing) {
        existing.refCount += 1;
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
          server.broadcast("hsr.event", { bee, event });
        } catch {
          // A closing aggregate socket must not wedge the relay pump.
        }
      });
      relays.set(bee, { client, refCount: 1, unsubscribe });
      // Drop the cached relay when the bee's control socket closes (bee died).
      void client.closed.then(() => {
        const relay = relays.get(bee);
        if (relay && relay.client === client) relays.delete(bee);
      });
      return { ok: true };
    }),

    // spawn runs IN-PROCESS in the warm daemon: the whole CLI Node cold-start
    // (~100ms+) is off the critical path, and the spawn itself is resolve +
    // persist + fork (spawnBee no longer waits for the runner host either).
    // spawnSingleBee is the exact code path `hive spawn` runs, so account
    // aliases, profiles, yolo, and prompt delivery behave identically; the
    // command graph is imported lazily so daemon boot stays lean and no static
    // daemon↔commands cycle forms.
    spawn: guarded(async (params) => {
      const p = (params ?? {}) as {
        kind?: unknown;
        cwd?: unknown;
        model?: unknown;
        name?: unknown;
        yolo?: unknown;
        prompt?: unknown;
        flags?: unknown;
        rest?: unknown;
        env?: unknown;
        spawnedById?: unknown;
      };
      const kind = String(p.kind ?? "");
      if (!kind) return { ok: false, error: "kind required" };
      const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
      const name = typeof p.name === "string" ? p.name : undefined;
      const model = typeof p.model === "string" ? p.model : undefined;
      const prompt = typeof p.prompt === "string" && p.prompt.trim().length > 0 ? p.prompt : undefined;
      const yolo = p.yolo === true;
      let spawnedById: string | undefined;
      if (p.spawnedById !== undefined) {
        if (typeof p.spawnedById !== "string") return { ok: false, error: "spawnedById must be a bee name or id" };
        spawnedById = await resolveExplicitSpawningBeeId(p.spawnedById);
      }
      const { spawnSingleBee } = await import("../commands/spawn.js");
      // Generic passthrough for callers (Apiary) that speak full spawn flags —
      // `--account auto`, `--pool`, etc. — plus a harness-flag rest group. The
      // named params stay for simple callers and win over the passthrough.
      const flags = new Map<string, string | true | string[]>();
      if (p.flags && typeof p.flags === "object") {
        for (const [key, value] of Object.entries(p.flags as Record<string, unknown>)) {
          if (value === true) flags.set(key, true);
          else if (typeof value === "string") flags.set(key, value);
          else if (Array.isArray(value) && value.every((item) => typeof item === "string")) flags.set(key, value as string[]);
        }
      }
      flags.set("substrate", "hsr");
      if (name) flags.set("name", name);
      if (cwd) flags.set("cwd", cwd);
      if (yolo) flags.set("yolo", true);
      // H2 caller env: validate daemon-side (clear refusal), then ride the same
      // repeated --env flag the CLI accepts; spawn-side merge order re-applies
      // the denylist and identity stamps last.
      const envPairs = hsrSpawnEnvArgv(p.env).filter((word) => word !== "--env");
      if (envPairs.length > 0) flags.set("env", envPairs);
      const rest = Array.isArray(p.rest) && (p.rest as unknown[]).every((item) => typeof item === "string")
        ? [...(p.rest as string[])]
        : [];
      if (model) rest.push("--model", model);
      const record = await spawnSingleBee(
        {
          command: "spawn",
          // A positional prompt rides the pending-turn queue (deliverHsrPrompt),
          // exactly like `hive spawn <kind> "<prompt>" --substrate hsr`.
          args: prompt ? [kind, prompt] : [kind],
          flags,
          rest,
        },
        spawnedById ? { spawnedById } : {},
      );
      return { ok: true, bee: record.name, ...(record.id ? { id: record.id } : {}) };
    }),

    // fork/handoff run IN-PROCESS like spawn: cmdFork/cmdHandoff are the exact
    // code paths the CLI runs, so anchors, thread copy, account policy, and the
    // ledger behave identically. String flags pass through verbatim.
    fork: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; flags?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const { cmdFork } = await import("../commands/fork.js");
      const record = await cmdFork({ command: "fork", args: [bee], flags: rpcFlags(p.flags), rest: [] });
      return { ok: true, bee: record.name, ...(record.id ? { id: record.id } : {}) };
    }),

    handoff: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; flags?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const { cmdHandoff } = await import("../commands/handoff.js");
      const record = await cmdHandoff({ command: "handoff", args: [bee], flags: rpcFlags(p.flags), rest: [] });
      return { ok: true, bee: record.name, ...(record.id ? { id: record.id } : {}) };
    }),
  };

  // Execution-protocol methods (contracts/execution/v1, slice H1) ride the
  // same socket behind their own per-connection protocol.hello gate. The
  // coordinator is built lazily on first protocol call so daemon boot does not
  // pay the contract/ajv load, and legacy methods are untouched.
  const execution = createExecutionRpcMethods(
    opts?.executionService ?? createProductionExecutionServiceProvider(),
  );

  // Node-local admin bootstrap methods (executionAdmin:1). Available without
  // protocol.hello — a binding must be installable BEFORE any corpus method
  // can succeed (node.describe fails closed without one).
  const admin = createExecutionAdminMethods();
  const broker = createBrokerMethods(opts?.broker);

  server = await startRpcServer({
    socketPath,
    methods: { ...execution.methods, ...admin, ...broker, ...methods },
    onDisconnect: (ctx) => execution.onDisconnect(ctx),
  });

  return {
    path: server.path,
    async close(): Promise<void> {
      for (const relay of relays.values()) {
        try {
          relay.unsubscribe();
          relay.client.close();
        } catch {
          // best-effort teardown
        }
      }
      relays.clear();
      await server.close();
    },
  };
}
