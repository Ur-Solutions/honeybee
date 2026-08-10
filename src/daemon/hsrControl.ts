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
import { createExecutionAdminMethods } from "../execution/adminMethods.js";
import { createExecutionRpcMethods } from "../execution/rpcMethods.js";
import type { ExecutionService } from "../execution/service.js";
import { createBrokerMethods } from "./broker.js";
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

/** Durable user-level message acceptance, independent of aggregate RPC I/O. */
export async function acceptHsrMessage(params: {
  bee: string;
  text: string;
  sender?: string;
  subject?: string;
  messageId?: string;
}): Promise<Record<string, unknown>> {
  if (!params.bee) return { ok: false, error: "bee required" };
  if (!params.text.trim()) return { ok: false, error: "message text required" };
  const { resolveSession } = await import("../cli/shared.js");
  const record = await resolveSession(params.bee);
  const [
    {
      isUuidV7,
      openMessageDeliveryRequest,
      readMessageById,
      sanitizeHumanName,
      sendBuzMessage,
    },
    { substrateFor },
    { withSessionLifecycleTransaction },
    { assertReviveWorkingDirectory },
  ] = await Promise.all([
    import("../buz.js"),
    import("../substrates/index.js"),
    import("../lifecycle.js"),
    import("../commands/migrate.js"),
  ]);
  if (params.messageId !== undefined && !isUuidV7(params.messageId)) {
    return { ok: false, error: "messageId must be an RFC 9562 UUIDv7" };
  }
  const senderName = sanitizeHumanName(params.sender ?? "apiary");
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    if (current.status === "done") {
      return { ok: false, error: `${current.name} is archived` };
    }

    const substrate = substrateFor(current);
    const live = await substrate.hasSession(current.tmuxTarget).catch(() => false);
    if (current.status === "kill_failed" && !live) {
      return { ok: false, error: `${current.name} is archived (stop state unresolved)` };
    }

    let cwdUnavailable = false;
    try {
      await assertReviveWorkingDirectory(current);
    } catch {
      cwdUnavailable = true;
    }
    const missingProviderSession = !live && !current.providerSessionId;

    let existing: Awaited<ReturnType<typeof readMessageById>> = null;
    if (params.messageId) {
      existing = await readMessageById(current.name, params.messageId);
      if (existing) {
        const samePayload = existing.message.to === current.name &&
          existing.message.body === params.text &&
          existing.message.subject === params.subject &&
          existing.message.from.kind === "human" &&
          existing.message.from.name === senderName;
        if (!samePayload) {
          return { ok: false, error: `messageId ${params.messageId} is already used with a different payload` };
        }
      }
    }

    const sent = existing
      ? { message: existing.message }
      : await sendBuzMessage({
          recipient: current,
          sender: { kind: "human", name: senderName },
          // Known-undeliverable work is still persisted first, but must not
          // make a doomed live transport attempt before needs-action is durable.
          tier: cwdUnavailable || missingProviderSession ? "queue" : "next-tool",
          body: params.text,
          ...(params.messageId ? { messageId: params.messageId } : {}),
          ...(params.subject ? { subject: params.subject } : {}),
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
        });

    const messageId = sent.message.id;
    const existingDelivery = existing?.mailbox === "inbox" || existing?.mailbox === "read";
    if (sent.message.deliveredAt || existingDelivery) {
      return {
        ok: true,
        accepted: true,
        messageId,
        delivery: "delivered",
        ...(existing ? { idempotent: true } : {}),
      };
    }

    const undeliverableReason = cwdUnavailable
      ? "missing-cwd" as const
      : missingProviderSession
        ? "missing-provider-session" as const
        : existing?.mailbox === "quarantine"
          ? "queued-message-missing" as const
          : undefined;
    if (undeliverableReason) {
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

    if (current.recoveryMessageId !== messageId) {
      // The queue file is already durable. This separate first-class fact is
      // the daemon work-set obligation; it changes neither lifecycle status
      // nor the last state actually observed from the runtime.
      await lifecycle.refresh();
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

export async function startHsrControlServer(opts?: {
  socketPath?: string;
  /** Execution-protocol coordinator override (tests inject fakes). */
  executionService?: () => ExecutionService | Promise<ExecutionService>;
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
    // broker:1 = Cell-confined CLI verbs routed through the daemon with a
    // per-calling-bee ACL (broker:buz-send/inbox/state/seal).
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
      broker: 1,
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
      const result = await proxyCall(String(p.bee ?? ""), "send", {
        text: String(p.text ?? ""),
        ...(p.mode === "next-tool" ? { mode: "next-tool" } : {}),
      });
      return result.ok ? { ok: true } : result;
    }),

    interrupt: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "interrupt");
      return result.ok ? { ok: true, result: result.result } : result;
    }),

    answer: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; requestId?: unknown; answer?: unknown };
      const bee = String(p.bee ?? "");
      let requestId = typeof p.requestId === "string" && p.requestId ? p.requestId : undefined;
      if (!requestId) {
        // No explicit id — resolve the request the bee is currently blocked on.
        const pending = await pendingNeedsInput(bee).catch(() => null);
        requestId = pending?.requestId;
      }
      const result = await proxyCall(bee, "answer", { requestId: requestId ?? "", answer: String(p.answer ?? "") });
      return result.ok ? { ok: true } : result;
    }),

    pendingInput: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      return pendingNeedsInput(String(p.bee ?? ""));
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
    opts?.executionService ??
      (async () => {
        const [{ createExecutionService, storeSessionEvidenceSource }, { createHsrRunLauncher }, { requireExecutionBinding }] =
          await Promise.all([
            import("../execution/service.js"),
            import("../execution/launcher.js"),
            import("../execution/nodeState.js"),
          ]);
        return createExecutionService({
          // Runs execute as the CANONICAL bound Apiary nodeId; resolved lazily
          // because runs cannot exist before a binding does.
          launcher: createHsrRunLauncher({ nodeId: async () => (await requireExecutionBinding()).nodeId }),
          sessions: storeSessionEvidenceSource(),
        });
      }),
  );

  // Node-local admin bootstrap methods (executionAdmin:1). Available without
  // protocol.hello — a binding must be installable BEFORE any corpus method
  // can succeed (node.describe fails closed without one).
  const admin = createExecutionAdminMethods();
  const broker = createBrokerMethods();

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
