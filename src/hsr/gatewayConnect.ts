/**
 * Cell-side `connect` transport (cell transport, UNIT: gateway connect) — the
 * OUTBOUND WebSocket control plane for a runner-host living inside an Apiary
 * Cloud cell:
 *
 *   node hive-runner-host.mjs connect --gateway <wss-url> --cell-id <id> --token-env CELL_TOKEN
 *
 * Same controller as `serve` (remoteHost.ts buildController), inverted
 * transport: instead of listening on a unix socket, the cell DIALS OUT to the
 * gateway and speaks JSON-RPC 2.0 with ONE JSON object per WS text frame (no
 * newline framing — the WS message boundary is the frame).
 *
 * Wire contract (the gateway side is deployed; this file matches it exactly):
 *   cell → gateway notifications (no id):
 *     hello    {cellId, runnerHostVersion, bees:[{bee,status,sessionId?,lastSeq?}]}
 *              — after every socket open (first connect and every reconnect).
 *     hsr.event{bee, event} — every RunnerEvent (seq-stamped), replay AND live.
 *     presence {bee, status, sessionId?, lastSeq?} — best-effort status edges.
 *   gateway → cell requests (numeric id; cell answers with a JSON-RPC response):
 *     subscribe {bee, afterSeq} — durable replay then live tail under ONE
 *              monotonic seq numbering: reply {ok:true, gap?}, emit hsr.event
 *              for every retained event with seq > afterSeq, then keep
 *              streaming live appends. The backlog is consumed in bounded
 *              exact pages; live events produced DURING replay set a dirty bit
 *              and are reread durably from the last seq (no dupes, no holes,
 *              and no second unbounded in-memory queue).
 *     ackEvents {bee, upToSeq} — advance the durable consumer watermark.
 *     everything else — dispatched into the controller methods map the serve
 *              mode uses (spawn/send/interrupt/answer/pendingInput/snapshot/
 *              stop/kill/list/liveness/ping/…); unknown method → -32601,
 *              thrown handler → -32000 (rpc.ts conventions).
 *
 * Auth: `Authorization: Bearer <token>` on the WS handshake (Node's global
 * undici WebSocket accepts a headers init — no dependency), plus `?cell=<id>`
 * appended to the gateway URL when not already present.
 *
 * Reconnect: capped exponential backoff with jitter (250ms → 5s, forever —
 * disconnection is ROUTINE for sleeping cells). Subscriptions die with the
 * socket: the gateway re-subscribes with its own durable cursors after every
 * re-hello, so the cell holds no subscription state across connections.
 *
 * Live tail source: runDir.ts onHsrEventAppended — the process-local tap that
 * fires on the append chain with the exact seq-stamped event that landed on
 * disk. The serve mode's observe relay is NOT used here: it re-broadcasts the
 * RAW runner event (stamped only on the disk copy), which cannot honor the
 * "same monotonic numbering, no holes" subscribe contract.
 *
 * Node builtins + local HSR modules only — bundles dependency-free.
 */

import { createHash } from "node:crypto";
import { listHsrBees } from "./observe.js";
import {
  markHsrConsumerSubscribedStrict,
  onHsrEventAppended,
  readHsrEventsPageAfterSeqStrict,
  readHsrMeta,
  readHsrSeqState,
} from "./runDir.js";
import type { RpcConnectionCtx, RpcMethodHandler } from "./rpc.js";
import type { RunnerEvent } from "./types.js";

// Node's global WebSocket is undici's, whose constructor takes a non-standard
// init object with custom handshake `headers` (verified against Node ≥22).
// The AMBIENT type for the global can resolve to a DOM-flavored declaration
// (a dependency pulls lib.dom into the graph) that types the second argument
// as protocols only — so bind the constructor through a minimal local shape
// instead of fighting the global. Runtime behavior is unchanged.
type NodeWebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

// Resolve the global WebSocket LAZILY, at dial time — never at module scope. A
// bare module-level `WebSocket` deref throws ReferenceError under Node 18/20
// (no global WebSocket there), and remoteHost imports THIS module for every
// command, so a top-level deref would regress even `--version`/`serve` on real
// satellites (which may run Node 18/20) before dispatch. Cells pin Node ≥22, so
// the connect path itself is fine; the shared bundle must simply not break on
// import for the serve/version paths.
function resolveWebSocketCtor(): NodeWebSocketCtor {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") {
    throw new Error(
      "runner-host connect: global WebSocket is unavailable — the cell `connect` transport requires Node 22+ " +
        "(satellites on Node 18/20 can serve over a unix socket but cannot dial the gateway)",
    );
  }
  return ctor as unknown as NodeWebSocketCtor;
}

// JSON-RPC 2.0 error codes (mirrors rpc.ts).
const CODE_PARSE_ERROR = -32700;
const CODE_INVALID_REQUEST = -32600;
const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;
const CODE_INTERNAL = -32000;

const DEFAULT_BACKOFF_INITIAL_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 5_000;
const DEFAULT_PRESENCE_POLL_MS = 2_000;
// A socket must stay open at least this long (or deliver one inbound frame)
// before its successful connection resets the reconnect backoff — an immediate
// post-open close (401 upgrade-then-close, auth reject) must keep the backoff
// growing instead of hot-looping at the initial delay.
const DEFAULT_STABLE_OPEN_MS = 1_000;
// Inbound frame bound — mirror rpc.ts SERVER_MAX_LINE_BYTES (8 MiB): a larger
// frame is a runaway/hostile writer and the socket is closed rather than buffered.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
// Outbound replay backpressure: while emitting a durable backlog, yield once the
// socket's send buffer climbs past this, so a huge un-acked log is streamed in
// chunks that respect bufferedAmount instead of being shoved in synchronously.
const REPLAY_HIGH_WATER_BYTES = 1 * 1024 * 1024;
const REPLAY_DRAIN_STEP_MS = 5;
const REPLAY_DRAIN_MAX_MS = 5_000;

export type GatewayConnectOptions = {
  /** wss:// (or ws:// in tests) gateway endpoint; `?cell=` appended if absent. */
  gatewayUrl: string;
  cellId: string;
  /** Bearer token for the WS handshake Authorization header. */
  token: string;
  /** The controller methods map the serve mode uses (buildController().methods). */
  methods: Record<string, RpcMethodHandler>;
  /** versionString() — advertised in hello. */
  runnerHostVersion: string;
  /** Reconnect backoff overrides (tests). */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Presence poll cadence (best-effort status edges); tests shrink it. */
  presencePollMs?: number;
  /** Outbound replay backpressure tuning; production defaults are conservative. */
  replayHighWaterBytes?: number;
  replayDrainStepMs?: number;
  replayDrainMaxMs?: number;
};

export type GatewayConnectHandle = {
  /** Stop reconnecting, drop the socket, release the event tap + pollers. */
  close(): Promise<void>;
};

type BeePresence = { bee: string; status: string; sessionId?: string; lastSeq?: number };

/**
 * One per-connection subscription. `cursor` is the highest seq already emitted
 * to the gateway; replay state records only whether a later durable page is
 * needed while the immutable backlog snapshot is being emitted.
 */
type Subscription = {
  cursor: number;
  /** Durable backlog is being replayed in bounded immutable pages. */
  replaying: boolean;
  /** A same-process append landed after the current immutable page opened. */
  dirty: boolean;
};

/**
 * All state bound to ONE physical socket. Every respond/notify/emit and the
 * subscription map hang off this object, so async work started on socket A
 * (a slow controller call, a subscribe replay) can only ever write back to
 * A's socket — a superseding socket B is a different Connection and never
 * receives A's late completion. That closes both the cross-socket misroute and
 * the per-socket-id cross-talk (both sockets restart request ids at 1).
 */
type Connection = {
  id: number;
  socket: WebSocket;
  subscriptions: Map<string, Subscription>;
  presenceBaseline: Map<string, string>;
  presenceTimer?: NodeJS.Timeout;
  stableTimer?: NodeJS.Timeout;
  openedAt?: number;
  /** Set once the socket proves healthy (stable-open window or first inbound frame). */
  established: boolean;
};

/** A cursor param is valid iff a present, non-negative, safe integer. */
function isValidCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Append `?cell=<id>` to the gateway URL unless the caller already carries one. */
export function gatewayUrlWithCell(gatewayUrl: string, cellId: string): string {
  const url = new URL(gatewayUrl);
  if (!url.searchParams.has("cell")) url.searchParams.set("cell", cellId);
  return url.toString();
}

/** Stable durable-consumer identity reused across every reconnect. */
export function gatewayEventConsumerId(gatewayUrl: string, cellId: string): string {
  const authority = gatewayUrlWithCell(gatewayUrl, cellId);
  return `gateway:${createHash("sha256").update(authority).digest("hex").slice(0, 40)}`;
}

/** The hello/presence row for one bee, read off its run dir. Null without meta. */
async function presenceRow(bee: string): Promise<BeePresence | null> {
  const meta = await readHsrMeta(bee);
  if (!meta) return null;
  const seqState = await readHsrSeqState(bee);
  return {
    bee,
    status: meta.status,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(seqState ? { lastSeq: seqState.lastSeq } : {}),
  };
}

async function enumerateBees(): Promise<BeePresence[]> {
  const rows: BeePresence[] = [];
  for (const bee of await listHsrBees()) {
    const row = await presenceRow(bee).catch(() => null);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Dial the gateway and keep dialing forever. Returns immediately; the returned
 * handle owns the reconnect loop. Never throws from the loop — every failure
 * path funnels into the backoff retry.
 */
export function connectToGateway(options: GatewayConnectOptions): GatewayConnectHandle {
  const url = gatewayUrlWithCell(options.gatewayUrl, options.cellId);
  const eventConsumerId = gatewayEventConsumerId(options.gatewayUrl, options.cellId);
  const backoffInitialMs = Math.max(1, options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS);
  const backoffMaxMs = Math.max(backoffInitialMs, options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS);
  const presencePollMs = Math.max(1, options.presencePollMs ?? DEFAULT_PRESENCE_POLL_MS);
  const stableOpenMs = Math.max(backoffInitialMs, DEFAULT_STABLE_OPEN_MS);
  const replayHighWaterBytes = Math.max(0, options.replayHighWaterBytes ?? REPLAY_HIGH_WATER_BYTES);
  const replayDrainStepMs = Math.max(1, options.replayDrainStepMs ?? REPLAY_DRAIN_STEP_MS);
  const replayDrainMaxMs = Math.max(replayDrainStepMs, options.replayDrainMaxMs ?? REPLAY_DRAIN_MAX_MS);

  let closed = false;
  // The one connection that owns the transport right now. Every socket-scoped
  // completion checks `current === conn` before writing, so a superseded
  // socket's late work is dropped, never misrouted to the socket that replaced it.
  let current: Connection | undefined;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let connectionSeq = 0;

  const isOpen = (socket: WebSocket): boolean => socket.readyState === socket.OPEN;

  function send(conn: Connection, value: unknown): void {
    // Bind the write to THIS connection's socket (one JSON object per WS text
    // frame). A superseded connection's socket is closed, so its late
    // completions no-op here instead of leaking onto the current socket.
    if (!isOpen(conn.socket)) return;
    try {
      conn.socket.send(JSON.stringify(value));
    } catch {
      // A racing close must not take down the transport loop.
    }
  }

  const notify = (conn: Connection, method: string, params: unknown): void =>
    send(conn, { jsonrpc: "2.0", method, params });
  const respond = (conn: Connection, id: number, result: unknown): void =>
    send(conn, { jsonrpc: "2.0", id, result: result === undefined ? null : result });
  const respondError = (conn: Connection, id: number | null, code: number, message: string): void =>
    send(conn, { jsonrpc: "2.0", id, error: { code, message } });

  /** Emit one live event if it advances the subscription cursor (dupe guard). */
  function emitLive(conn: Connection, bee: string, sub: Subscription, event: RunnerEvent): void {
    const seq = event.seq;
    if (!isOpen(conn.socket) || typeof seq !== "number" || seq <= sub.cursor) return;
    sub.cursor = seq;
    notify(conn, "hsr.event", { bee, event });
  }

  function closeForReplayBackpressure(conn: Connection): void {
    try {
      conn.socket.close();
    } catch {
      // already closing
    }
  }

  // ONE tap for the handle's lifetime: appends for a subscribed bee stream (or
  // mark dirty, mid-replay) to the CURRENT connection's socket; a superseded
  // connection no longer receives taps, and everything else is ignored.
  const offTap = onHsrEventAppended((bee, event) => {
    const conn = current;
    if (!conn) return;
    const sub = conn.subscriptions.get(bee);
    if (!sub) return;
    if (sub.replaying) {
      // The event is durable. Remember only that another exact page is needed;
      // retaining every live event while a large backlog drains would merely
      // move the unbounded suffix from disk into memory.
      sub.dirty = true;
      return;
    }
    // The process-local tap cannot await an async drain. Once the gateway is
    // behind, close before enqueueing more live frames and let its durable ack
    // drive an exact paged replay on the next connection. Also close if this
    // one frame crosses the threshold; at most one bounded frame sits above
    // the configured high-water.
    if (conn.socket.bufferedAmount > replayHighWaterBytes) {
      closeForReplayBackpressure(conn);
      return;
    }
    emitLive(conn, bee, sub, event);
    if (conn.socket.bufferedAmount > replayHighWaterBytes) closeForReplayBackpressure(conn);
  });

  /**
   * Yield while the socket's send buffer is over the replay high-water.
   * A peer that cannot drain within the bounded window loses this connection:
   * continuing would merely move the durable on-disk backlog into an
   * unbounded WebSocket buffer. Its next connection resumes from the last
   * durable gateway ack.
   */
  async function drainReplay(conn: Connection): Promise<void> {
    let waited = 0;
    while (isOpen(conn.socket) && current === conn && conn.socket.bufferedAmount > replayHighWaterBytes && waited < replayDrainMaxMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, replayDrainStepMs));
      waited += replayDrainStepMs;
    }
    if (!isOpen(conn.socket) || current !== conn) {
      throw new Error("gateway replay connection closed before its buffered events drained");
    }
    if (conn.socket.bufferedAmount > replayHighWaterBytes) {
      closeForReplayBackpressure(conn);
      throw new Error(`gateway replay backpressure did not drain within ${replayDrainMaxMs}ms`);
    }
  }

  /**
   * subscribe {bee, afterSeq}: durable replay then seamless live tail.
   * Registration happens BEFORE the backlog read, so any event that lands
   * during the read is either already IN its immutable page snapshot or marks
   * the subscription dirty for another durable page — the seq cursor merges
   * the two without dupes/holes or an unbounded live-event buffer.
   */
  async function handleSubscribe(conn: Connection, id: number, params: unknown): Promise<void> {
    const p = (params ?? {}) as { bee?: unknown; afterSeq?: unknown };
    const bee = typeof p.bee === "string" ? p.bee : "";
    if (!bee) {
      respondError(conn, id, CODE_INVALID_PARAMS, "bee required");
      return;
    }
    if (!isValidCursor(p.afterSeq)) {
      respondError(conn, id, CODE_INVALID_PARAMS, "afterSeq must be a non-negative safe integer");
      return;
    }
    const afterSeq = p.afterSeq;
    // Mark this stable gateway as an active durable consumer so its un-acked
    // events survive compaction before the first ack lands. Admission is
    // strict: a late new consumer cannot claim an already-folded prefix.
    try {
      await markHsrConsumerSubscribedStrict(bee, eventConsumerId);
    } catch (error) {
      respondError(conn, id, CODE_INTERNAL, error instanceof Error ? error.message : String(error));
      return;
    }
    const sub: Subscription = { cursor: afterSeq, replaying: true, dirty: false };
    // Still current AND still the registered subscription for this bee — a
    // superseded socket or a re-subscribe must never write back.
    const alive = (): boolean => isOpen(conn.socket) && current === conn && conn.subscriptions.get(bee) === sub;
    conn.subscriptions.set(bee, sub); // a re-subscribe replaces the prior cursor
    let responded = false;
    try {
      // Drain one immutable bounded snapshot at a time. Appends racing a
      // snapshot set only `dirty`; after its final page we open another exact
      // snapshot at the projected cursor. No replay response or in-memory
      // buffer grows with a slow consumer's retained suffix.
      for (;;) {
        sub.dirty = false;
        let pageToken: string | undefined;
        do {
          const page = await readHsrEventsPageAfterSeqStrict(
            bee,
            sub.cursor,
            eventConsumerId,
            pageToken,
          );
          if (!alive()) return;
          if (!responded) {
            respond(conn, id, { ok: true, ...(page.gap ? { gap: page.gap } : {}) });
            responded = true;
          }
          for (const event of page.events) {
            if (!alive()) return;
            emitLive(conn, bee, sub, event);
            if (conn.socket.bufferedAmount > replayHighWaterBytes) await drainReplay(conn);
          }
          if (page.gap) {
            // The ordered response already exposed the missing range. Do not
            // invent a seamless live tail across it; the gateway must resume
            // from its reconciled durable cursor.
            sub.replaying = false;
            return;
          }
          if (page.throughSeq !== sub.cursor) {
            throw new Error(`gateway replay cursor for ${bee} disagrees with its exact page high-water`);
          }
          pageToken = page.pageToken;
          if (page.hasMore !== (pageToken !== undefined)) {
            throw new Error(`gateway replay continuation for ${bee} is malformed`);
          }
        } while (pageToken);
        if (!sub.dirty) {
          // Synchronous transition: the append tap cannot interleave between
          // the final dirty check and arming the live tail.
          sub.replaying = false;
          return;
        }
      }
    } catch (error) {
      if (!responded) {
        respondError(conn, id, CODE_INTERNAL, error instanceof Error ? error.message : String(error));
      } else {
        // A later page proved corruption/busy after the ordered success frame.
        // Drop this socket so the gateway resumes from its last durable ack;
        // never continue a live tail across an unproven suffix.
        try {
          conn.socket.close();
        } catch {
          // already closing
        }
      }
    }
  }

  async function dispatch(conn: Connection, id: number, method: string, params: unknown): Promise<void> {
    if (method === "subscribe") {
      await handleSubscribe(conn, id, params);
      return;
    }
    const handler = options.methods[method];
    if (!handler) {
      respondError(conn, id, CODE_METHOD_NOT_FOUND, "Method not found");
      return;
    }
    const ctx: RpcConnectionCtx = { connectionId: conn.id, close: () => conn.socket.close() };
    try {
      const consumerScopedParams = (
        method === "spawn"
        || method === "events"
        || method === "ackEvents"
        || method === "observe"
        || method === "unobserve"
      ) && params && typeof params === "object" && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>), consumerId: eventConsumerId }
        : params;
      const result = await handler(consumerScopedParams, ctx);
      // A completion whose socket is no longer current is dropped, not sent —
      // this is what stops a stale request-id from satisfying the new socket.
      if (current !== conn) return;
      respond(conn, id, result);
    } catch (error) {
      if (current !== conn) return;
      respondError(conn, id, CODE_INTERNAL, error instanceof Error ? error.message : String(error));
    }
  }

  function handleFrame(conn: Connection, raw: string): void {
    markEstablished(conn); // any inbound frame proves the gateway accepted us
    if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) {
      process.stderr.write(`runner-host connect: inbound frame over ${MAX_FRAME_BYTES} bytes; closing socket\n`);
      // A normal-closure code only: the WebSocket API forbids application code
      // from passing reserved codes like 1009 to close() (it throws). Dropping
      // the socket is what matters — the reconnect loop then redials.
      try {
        conn.socket.close();
      } catch {
        // already closing
      }
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      respondError(conn, null, CODE_PARSE_ERROR, "Parse error");
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const req = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    // Only numeric-id requests are answerable; gateway notifications and stray
    // responses are dropped (mirrors rpc.ts server discipline).
    if (typeof req.id !== "number") return;
    // A well-formed-but-invalid request (missing method / wrong version) gets a
    // -32600 rather than a silent drop.
    if (typeof req.method !== "string" || req.jsonrpc !== "2.0") {
      respondError(conn, req.id, CODE_INVALID_REQUEST, "Invalid Request");
      return;
    }
    void dispatch(conn, req.id, req.method, req.params).catch(() => undefined);
  }

  async function sendHello(conn: Connection): Promise<void> {
    const bees = await enumerateBees();
    if (current !== conn) return;
    conn.presenceBaseline = new Map(bees.map((row) => [row.bee, `${row.status} ${row.sessionId ?? ""}`]));
    notify(conn, "hello", { cellId: options.cellId, runnerHostVersion: options.runnerHostVersion, bees });
  }

  /** Best-effort presence poll: report status/sessionId EDGES since the baseline. */
  async function pollPresence(conn: Connection): Promise<void> {
    const rows = await enumerateBees().catch(() => [] as BeePresence[]);
    if (current !== conn) return;
    for (const row of rows) {
      const signature = `${row.status} ${row.sessionId ?? ""}`;
      if (conn.presenceBaseline.get(row.bee) === signature) continue;
      conn.presenceBaseline.set(row.bee, signature);
      notify(conn, "presence", row);
    }
  }

  function startPresence(conn: Connection): void {
    stopPresence(conn);
    conn.presenceTimer = setInterval(() => {
      void pollPresence(conn).catch(() => undefined);
    }, presencePollMs);
  }

  function stopPresence(conn: Connection): void {
    if (conn.presenceTimer) {
      clearInterval(conn.presenceTimer);
      conn.presenceTimer = undefined;
    }
  }

  /**
   * Mark a connection healthy (stable-open window elapsed, or an inbound frame
   * arrived) and only THEN reset the reconnect backoff. An immediate post-open
   * close never marks established, so its backoff keeps growing instead of
   * hot-looping at the initial delay.
   */
  function markEstablished(conn: Connection): void {
    if (conn.established) return;
    conn.established = true;
    if (current === conn) attempt = 0;
  }

  function scheduleReconnect(): void {
    if (closed || retryTimer) return;
    // Capped exponential backoff with half-spread jitter: base/2 + rand*base/2.
    const base = Math.min(backoffMaxMs, backoffInitialMs * 2 ** Math.min(attempt, 30));
    attempt += 1;
    const delay = Math.max(1, Math.round(base / 2 + Math.random() * (base / 2)));
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closed) return;
    // Resolve the global WebSocket at DIAL time — a missing global (Node < 22)
    // throws a clear error out of the FIRST connect() (and thus out of
    // connectToGateway) instead of a module-load ReferenceError that would take
    // down even --version/serve on satellites that import this module.
    const WebSocketCtor = resolveWebSocketCtor();
    let socket: WebSocket;
    try {
      socket = new WebSocketCtor(url, { headers: { Authorization: `Bearer ${options.token}` } });
    } catch {
      scheduleReconnect();
      return;
    }
    const conn: Connection = {
      id: ++connectionSeq,
      socket,
      subscriptions: new Map(),
      presenceBaseline: new Map(),
      established: false,
    };
    current = conn; // fresh connection — no inherited subscriptions
    let gone = false;
    const onGone = (): void => {
      // error + close both fire on failures — collapse them, and never react
      // to a stale socket after a newer connect superseded it.
      if (gone || current !== conn) return;
      gone = true;
      if (!conn.established && conn.openedAt !== undefined) {
        // Opened then dropped before proving healthy — a likely permanent
        // handshake/auth rejection (401 upgrade-then-close). Make it OBSERVABLE
        // and let the backoff keep growing (attempt was never reset) rather than
        // hot-loop forever at the initial delay.
        process.stderr.write(
          "runner-host connect: gateway dropped the socket immediately after open " +
            "(auth/handshake rejected?) — backing off\n",
        );
      }
      if (conn.stableTimer) {
        clearTimeout(conn.stableTimer);
        conn.stableTimer = undefined;
      }
      stopPresence(conn);
      current = undefined;
      scheduleReconnect();
    };
    socket.addEventListener("open", () => {
      if (current !== conn) return;
      conn.openedAt = Date.now();
      // Reset the backoff only after the socket stays open past the stable
      // window (or an inbound frame arrives first — see handleFrame).
      conn.stableTimer = setTimeout(() => {
        conn.stableTimer = undefined;
        markEstablished(conn);
      }, stableOpenMs);
      void sendHello(conn).catch(() => undefined);
      startPresence(conn);
    });
    socket.addEventListener("message", (event) => {
      if (current !== conn) return;
      if (typeof event.data === "string") handleFrame(conn, event.data);
    });
    socket.addEventListener("close", onGone);
    socket.addEventListener("error", onGone);
  }

  try {
    connect();
  } catch (error) {
    offTap(); // a missing WebSocket global threw — release the tap we registered
    throw error;
  }

  return {
    async close(): Promise<void> {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      offTap();
      const conn = current;
      current = undefined;
      if (conn) {
        stopPresence(conn);
        if (conn.stableTimer) {
          clearTimeout(conn.stableTimer);
          conn.stableTimer = undefined;
        }
        try {
          conn.socket.close();
        } catch {
          // already closing/failed
        }
      }
    },
  };
}
