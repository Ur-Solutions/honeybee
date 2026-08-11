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
 *              streaming live appends. Live events produced DURING the backlog
 *              emission are buffered and merged on seq (no dupes, no holes) —
 *              the remoteEventMirror backfill pattern, keyed on seq.
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

import { listHsrBees } from "./observe.js";
import { onHsrEventAppended, readHsrEventsAfterSeq, readHsrMeta, readHsrSeqState } from "./runDir.js";
import type { RpcConnectionCtx, RpcMethodHandler } from "./rpc.js";
import type { RunnerEvent } from "./types.js";

// Node's global WebSocket is undici's, whose constructor takes a non-standard
// init object with custom handshake `headers` (verified against Node ≥22).
// The AMBIENT type for the global can resolve to a DOM-flavored declaration
// (a dependency pulls lib.dom into the graph) that types the second argument
// as protocols only — so bind the constructor through a minimal local shape
// instead of fighting the global. Runtime behavior is unchanged.
type NodeWebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;
const NodeWebSocket = WebSocket as unknown as NodeWebSocketCtor;

// JSON-RPC 2.0 error codes (mirrors rpc.ts).
const CODE_PARSE_ERROR = -32700;
const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;
const CODE_INTERNAL = -32000;

const DEFAULT_BACKOFF_INITIAL_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 5_000;
const DEFAULT_PRESENCE_POLL_MS = 2_000;

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
};

export type GatewayConnectHandle = {
  /** Stop reconnecting, drop the socket, release the event tap + pollers. */
  close(): Promise<void>;
};

type BeePresence = { bee: string; status: string; sessionId?: string; lastSeq?: number };

/**
 * One per-connection subscription. `cursor` is the highest seq already emitted
 * to the gateway; `buffer` holds live tap events while the durable backlog is
 * being emitted (null once armed — the steady live-tail state).
 */
type Subscription = { cursor: number; buffer: RunnerEvent[] | null };

/** Append `?cell=<id>` to the gateway URL unless the caller already carries one. */
export function gatewayUrlWithCell(gatewayUrl: string, cellId: string): string {
  const url = new URL(gatewayUrl);
  if (!url.searchParams.has("cell")) url.searchParams.set("cell", cellId);
  return url.toString();
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
  const backoffInitialMs = Math.max(1, options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS);
  const backoffMaxMs = Math.max(backoffInitialMs, options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS);
  const presencePollMs = Math.max(1, options.presencePollMs ?? DEFAULT_PRESENCE_POLL_MS);

  let closed = false;
  let ws: WebSocket | undefined;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let presenceTimer: NodeJS.Timeout | undefined;
  // Per-connection subscription state — replaced wholesale on every (re)connect:
  // subscriptions die with the socket (the gateway re-subscribes after re-hello).
  let subscriptions = new Map<string, Subscription>();
  // Presence baseline (status+sessionId per bee) seeded by hello, so the poll
  // only reports EDGES. Best-effort by contract.
  let presenceBaseline = new Map<string, string>();

  function send(value: unknown): void {
    // One JSON object per WS text frame — the frame IS the message.
    if (ws && ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(value));
      } catch {
        // A racing close must not take down the transport loop.
      }
    }
  }

  const notify = (method: string, params: unknown): void => send({ jsonrpc: "2.0", method, params });
  const respond = (id: number, result: unknown): void => send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
  const respondError = (id: number | null, code: number, message: string): void =>
    send({ jsonrpc: "2.0", id: id as number, error: { code, message } });

  /** Emit one live event if it advances the subscription cursor (dupe guard). */
  function emitLive(bee: string, sub: Subscription, event: RunnerEvent): void {
    const seq = event.seq;
    if (typeof seq !== "number" || seq <= sub.cursor) return;
    sub.cursor = seq;
    notify("hsr.event", { bee, event });
  }

  // ONE tap for the handle's lifetime: appends for a subscribed bee stream (or
  // buffer, mid-replay) to the current socket; everything else is ignored.
  const offTap = onHsrEventAppended((bee, event) => {
    const sub = subscriptions.get(bee);
    if (!sub) return;
    if (sub.buffer !== null) {
      sub.buffer.push(event);
      return;
    }
    emitLive(bee, sub, event);
  });

  /**
   * subscribe {bee, afterSeq}: durable replay then seamless live tail.
   * Registration happens BEFORE the backlog read, so any event that lands
   * during the read is either already IN the read (it hit disk first) or
   * buffered by the tap — the seq cursor merges the two without dupes/holes.
   */
  async function handleSubscribe(id: number, params: unknown): Promise<void> {
    const p = (params ?? {}) as { bee?: unknown; afterSeq?: unknown };
    const bee = typeof p.bee === "string" ? p.bee : "";
    if (!bee) {
      respondError(id, CODE_INVALID_PARAMS, "bee required");
      return;
    }
    const afterSeq = typeof p.afterSeq === "number" && Number.isFinite(p.afterSeq) ? Math.max(0, Math.floor(p.afterSeq)) : 0;
    const sub: Subscription = { cursor: afterSeq, buffer: [] };
    subscriptions.set(bee, sub); // a re-subscribe replaces the prior cursor
    const { events, gap } = await readHsrEventsAfterSeq(bee, afterSeq);
    // The response (gap included) precedes the replayed events; WS frames on
    // one socket are ordered, so the gateway sees exactly response → backlog
    // → live.
    respond(id, { ok: true, ...(gap ? { gap } : {}) });
    for (const event of events) {
      if (subscriptions.get(bee) !== sub) return; // replaced/torn down mid-replay
      emitLive(bee, sub, event);
    }
    // Arm the live tail: merge everything buffered during the backlog emission
    // through the same cursor (events present in both phases skip on seq).
    const buffered = sub.buffer ?? [];
    sub.buffer = null;
    for (const event of buffered) {
      if (subscriptions.get(bee) !== sub) return;
      emitLive(bee, sub, event);
    }
  }

  async function dispatch(id: number, method: string, params: unknown): Promise<void> {
    if (method === "subscribe") {
      await handleSubscribe(id, params);
      return;
    }
    const handler = options.methods[method];
    if (!handler) {
      respondError(id, CODE_METHOD_NOT_FOUND, "Method not found");
      return;
    }
    const ctx: RpcConnectionCtx = { connectionId: 1, close: () => ws?.close() };
    try {
      respond(id, await handler(params, ctx));
    } catch (error) {
      respondError(id, CODE_INTERNAL, error instanceof Error ? error.message : String(error));
    }
  }

  function handleFrame(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      respondError(null, CODE_PARSE_ERROR, "Parse error");
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const req = msg as { id?: unknown; method?: unknown; params?: unknown };
    // Only numeric-id requests are answerable; gateway notifications and stray
    // responses are dropped (mirrors rpc.ts server discipline).
    if (typeof req.id !== "number" || typeof req.method !== "string") return;
    void dispatch(req.id, req.method, req.params).catch(() => undefined);
  }

  async function sendHello(): Promise<void> {
    const bees = await enumerateBees();
    presenceBaseline = new Map(bees.map((row) => [row.bee, `${row.status} ${row.sessionId ?? ""}`]));
    notify("hello", { cellId: options.cellId, runnerHostVersion: options.runnerHostVersion, bees });
  }

  /** Best-effort presence poll: report status/sessionId EDGES since the baseline. */
  async function pollPresence(): Promise<void> {
    const rows = await enumerateBees().catch(() => [] as BeePresence[]);
    for (const row of rows) {
      const signature = `${row.status} ${row.sessionId ?? ""}`;
      if (presenceBaseline.get(row.bee) === signature) continue;
      presenceBaseline.set(row.bee, signature);
      notify("presence", row);
    }
  }

  function startPresence(): void {
    stopPresence();
    presenceTimer = setInterval(() => {
      void pollPresence().catch(() => undefined);
    }, presencePollMs);
  }

  function stopPresence(): void {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = undefined;
    }
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
    let socket: WebSocket;
    try {
      socket = new NodeWebSocket(url, { headers: { Authorization: `Bearer ${options.token}` } });
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    subscriptions = new Map(); // fresh connection — no inherited subscriptions
    let gone = false;
    const onGone = (): void => {
      // error + close both fire on failures — collapse them, and never react
      // to a stale socket after a newer connect superseded it.
      if (gone || ws !== socket) return;
      gone = true;
      ws = undefined;
      subscriptions = new Map();
      stopPresence();
      scheduleReconnect();
    };
    socket.addEventListener("open", () => {
      if (ws !== socket) return;
      attempt = 0;
      void sendHello().catch(() => undefined);
      startPresence();
    });
    socket.addEventListener("message", (event) => {
      if (ws !== socket) return;
      if (typeof event.data === "string") handleFrame(event.data);
    });
    socket.addEventListener("close", onGone);
    socket.addEventListener("error", onGone);
  }

  connect();

  return {
    async close(): Promise<void> {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      stopPresence();
      offTap();
      subscriptions = new Map();
      const socket = ws;
      ws = undefined;
      if (socket) {
        try {
          socket.close();
        } catch {
          // already closing/failed
        }
      }
    },
  };
}
