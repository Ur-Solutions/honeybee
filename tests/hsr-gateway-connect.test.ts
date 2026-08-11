/**
 * Cell-side `connect` transport (gatewayConnect.ts): the outbound WebSocket
 * control plane a cell's runner-host dials to the Apiary Cloud gateway.
 *
 *   - dial: Authorization bearer header on the handshake, `?cell=` on the URL,
 *     a `hello` notification (cellId, runnerHostVersion, bees + lastSeq) after
 *     every socket open;
 *   - subscribe {bee, afterSeq}: durable replay of exactly seq > afterSeq,
 *     explicit gap when the cursor predates retention, then a seamless live
 *     tail under the SAME monotonic numbering (no dupes, no holes);
 *   - ackEvents advances the durable on-disk watermark;
 *   - reconnect: capped-backoff redial after a server-side drop, re-hello, and
 *     a fresh subscribe resumes exactly (subscriptions die with the socket);
 *   - controller relay: gateway requests dispatch into the SAME methods map
 *     the serve mode uses, with rpc.ts error-code conventions.
 *
 * The fake gateway is a dependency-free in-process WS server: node:http
 * upgrade + a minimal RFC6455 codec (client frames are masked; server frames
 * are not). One JSON object per WS text frame — no newline framing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectToGateway, gatewayUrlWithCell } from "../src/hsr/gatewayConnect.js";
import { buildController, versionString } from "../src/hsr/remoteHost.js";
import {
  ackHsrEvents,
  appendHsrEvent,
  compactHsrEvents,
  ensureHsrRunDir,
  readHsrSeqState,
  writeHsrMeta,
  type HsrMeta,
} from "../src/hsr/runDir.js";
import type { RunnerEvent } from "../src/hsr/types.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WAIT_MS = 5_000;

// --- minimal in-process WS gateway -------------------------------------------

type JsonRpcFrame = {
  jsonrpc?: string;
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

type GatewayConn = {
  url: string;
  headers: IncomingHttpHeaders;
  /** Every parsed frame, in arrival order (never consumed). */
  received: JsonRpcFrame[];
  /** Take the next not-yet-taken frame matching `pred` (waits if needed). */
  take(pred: (frame: JsonRpcFrame) => boolean, label?: string): Promise<JsonRpcFrame>;
  send(value: unknown): void;
  /** Send a gateway→cell request and await its response frame. */
  request(method: string, params?: unknown): Promise<JsonRpcFrame>;
  /** Hard server-side drop (no close handshake) — the sleeping-cell case. */
  destroy(): void;
};

type FakeGateway = {
  url: string;
  nextConnection(): Promise<GatewayConn>;
  close(): Promise<void>;
};

function encodeTextFrame(data: string): Buffer {
  const payload = Buffer.from(data, "utf8");
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Wire a raw upgraded socket into a GatewayConn (parses masked client frames). */
function wireConnection(socket: Socket, url: string, headers: IncomingHttpHeaders): GatewayConn {
  const received: JsonRpcFrame[] = [];
  let taken = 0; // received[0..taken) already claimed by take()
  const waiters: Array<{ pred: (frame: JsonRpcFrame) => boolean; resolve: (frame: JsonRpcFrame) => void }> = [];
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let nextId = 1;

  const deliver = (frame: JsonRpcFrame): void => {
    received.push(frame);
    // A waiter claims frames in order: everything up to and including its
    // match becomes taken, so successive take() calls never see a frame twice.
    if (waiters.length > 0) {
      const waiter = waiters[0]!;
      for (let i = taken; i < received.length; i++) {
        if (waiter.pred(received[i]!)) {
          taken = i + 1;
          waiters.shift();
          waiter.resolve(received[i]!);
          return;
        }
      }
    }
  };

  const handlePayload = (opcode: number, payload: Buffer): void => {
    if (opcode === 0x8) {
      // close: echo and drop.
      try {
        socket.write(Buffer.from([0x88, 0x00]));
      } catch {
        // already gone
      }
      socket.destroy();
      return;
    }
    if (opcode === 0x9) {
      socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      return;
    }
    if (opcode === 0x1) {
      try {
        deliver(JSON.parse(payload.toString("utf8")) as JsonRpcFrame);
      } catch {
        // garbage frame — ignore
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let len = buffer[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let mask: Buffer | undefined;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      }
      buffer = buffer.subarray(offset + len);
      if (opcode === 0x0 || !fin) {
        // continuation / fragmented text: accumulate until fin.
        fragments.push(payload);
        if (fin) {
          handlePayload(0x1, Buffer.concat(fragments));
          fragments = [];
        }
        continue;
      }
      handlePayload(opcode, payload);
    }
  });
  socket.on("error", () => socket.destroy());

  return {
    url,
    headers,
    received,
    take(pred, label = "frame"): Promise<JsonRpcFrame> {
      for (let i = taken; i < received.length; i++) {
        if (pred(received[i]!)) {
          taken = i + 1;
          return Promise.resolve(received[i]!);
        }
      }
      return new Promise<JsonRpcFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), WAIT_MS);
        waiters.push({
          pred,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    send(value: unknown): void {
      socket.write(encodeTextFrame(JSON.stringify(value)));
    },
    async request(method: string, params?: unknown): Promise<JsonRpcFrame> {
      const id = nextId++;
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      return this.take((frame) => frame.id === id && frame.method === undefined, `response to ${method}`);
    },
    destroy(): void {
      socket.destroy();
    },
  };
}

async function startFakeGateway(): Promise<FakeGateway> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new Set<Socket>();
  const pendingConns: GatewayConn[] = [];
  const connWaiters: Array<(conn: GatewayConn) => void> = [];
  server.on("upgrade", (req, socket: Socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const conn = wireConnection(socket, req.url ?? "", req.headers);
    const waiter = connWaiters.shift();
    if (waiter) waiter(conn);
    else pendingConns.push(conn);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("fake gateway did not bind");
  return {
    url: `ws://127.0.0.1:${address.port}/gw`,
    nextConnection(): Promise<GatewayConn> {
      const conn = pendingConns.shift();
      if (conn) return Promise.resolve(conn);
      return new Promise<GatewayConn>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a gateway connection")), WAIT_MS);
        connWaiters.push((next) => {
          clearTimeout(timer);
          resolve(next);
        });
      });
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// --- shared cell-side fixtures ------------------------------------------------

/** Point HIVE_STORE_ROOT at a fresh temp dir for the duration of `fn`. */
async function withTempStore<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-gw-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** A live LOCAL meta (this test process is the "host" pid, so it probes alive). */
function liveMeta(bee: string, sessionId?: string): HsrMeta {
  return {
    bee,
    harness: "stub",
    tier: "stream",
    ...(sessionId ? { sessionId } : {}),
    hostPid: process.pid,
    startedAt: new Date().toISOString(),
    controlSocket: "/tmp/unused.sock",
    status: "running",
  };
}

async function appendTexts(bee: string, count: number, startTs = 1): Promise<void> {
  let last: Promise<void> = Promise.resolve();
  for (let i = 0; i < count; i++) {
    last = appendHsrEvent(bee, { type: "text", ts: startTs + i, text: `chunk-${i}` });
  }
  await last;
}

type CellCtx = {
  gateway: FakeGateway;
  controller: ReturnType<typeof buildController>;
};

/**
 * Fake gateway + real controller + the connect transport, torn down strictly.
 * `prepare` seeds run dirs BEFORE the cell dials (hello enumerates them).
 */
async function withConnectedCell(
  prepare: (ctx: CellCtx) => Promise<void>,
  fn: (ctx: CellCtx & { handle: ReturnType<typeof connectToGateway> }) => Promise<void>,
): Promise<void> {
  await withTempStore(async () => {
    const gateway = await startFakeGateway();
    const controller = buildController();
    let handle: ReturnType<typeof connectToGateway> | undefined;
    try {
      await prepare({ gateway, controller });
      handle = connectToGateway({
        gatewayUrl: gateway.url,
        cellId: "cell-1",
        token: "tok-secret",
        methods: controller.methods,
        runnerHostVersion: versionString(),
        backoffInitialMs: 10,
        backoffMaxMs: 50,
        presencePollMs: 25,
      });
      await fn({ gateway, controller, handle });
    } finally {
      await handle?.close();
      await controller.close();
      await gateway.close();
    }
  });
}

const isHello = (frame: JsonRpcFrame): boolean => frame.method === "hello";
const isHsrEvent = (frame: JsonRpcFrame): boolean => frame.method === "hsr.event";

async function takeHsrEvents(conn: GatewayConn, count: number): Promise<Array<{ bee: string; event: RunnerEvent }>> {
  const out: Array<{ bee: string; event: RunnerEvent }> = [];
  for (let i = 0; i < count; i++) {
    const frame = await conn.take(isHsrEvent, `hsr.event #${i + 1}`);
    out.push(frame.params as { bee: string; event: RunnerEvent });
  }
  return out;
}

// --- tests ---------------------------------------------------------------------

test("gatewayUrlWithCell appends the cell param exactly once", () => {
  assert.equal(gatewayUrlWithCell("wss://gw.example/cells", "c1"), "wss://gw.example/cells?cell=c1");
  assert.equal(gatewayUrlWithCell("wss://gw.example/cells?cell=pinned", "c1"), "wss://gw.example/cells?cell=pinned");
});

test("connect dials with the bearer header + cell param and says hello with the bee inventory", async () => {
  await withConnectedCell(
    async () => {
      const bee = "gw-hello";
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, liveMeta(bee, "sess-42"));
      await appendTexts(bee, 3);
    },
    async ({ gateway }) => {
      const conn = await gateway.nextConnection();
      assert.equal(conn.headers.authorization, "Bearer tok-secret", "handshake must carry the bearer token");
      assert.match(conn.url, /[?&]cell=cell-1(&|$)/, "gateway URL must carry the cell id");
      const hello = await conn.take(isHello, "hello");
      const params = hello.params as { cellId: string; runnerHostVersion: string; bees: unknown[] };
      assert.equal(params.cellId, "cell-1");
      assert.equal(params.runnerHostVersion, versionString());
      assert.deepEqual(params.bees, [{ bee: "gw-hello", status: "running", sessionId: "sess-42", lastSeq: 3 }]);
    },
  );
});

test("subscribe replays exactly seq > afterSeq from the durable log, then streams live appends seamlessly", async () => {
  const bee = "gw-replay";
  await withConnectedCell(
    async () => {
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, liveMeta(bee));
      await appendTexts(bee, 5); // seq 1..5
    },
    async ({ gateway }) => {
      const conn = await gateway.nextConnection();
      await conn.take(isHello, "hello");

      const response = await conn.request("subscribe", { bee, afterSeq: 2 });
      assert.deepEqual(response.result, { ok: true }, "mid-cursor subscribe carries no gap");
      const replay = await takeHsrEvents(conn, 3);
      assert.deepEqual(replay.map((row) => row.bee), [bee, bee, bee]);
      assert.deepEqual(replay.map((row) => row.event.seq), [3, 4, 5], "replay is exactly seq > afterSeq, in order");
      assert.deepEqual(replay.map((row) => (row.event as { text?: string }).text), ["chunk-2", "chunk-3", "chunk-4"]);

      // Live tail continues under the same numbering — no dupes, no holes.
      await appendTexts(bee, 2, 100); // seq 6..7
      const live = await takeHsrEvents(conn, 2);
      assert.deepEqual(live.map((row) => row.event.seq), [6, 7]);
    },
  );
});

test("subscribe races the live appends without dupes or holes (buffer-merge handoff)", async () => {
  const bee = "gw-race";
  await withConnectedCell(
    async () => {
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, liveMeta(bee));
      await appendTexts(bee, 2); // seq 1..2
    },
    async ({ gateway }) => {
      const conn = await gateway.nextConnection();
      await conn.take(isHello, "hello");
      // Fire the subscribe and append MORE events without awaiting the
      // response, so the appends land during the backlog read/emission window.
      const responsePromise = conn.request("subscribe", { bee, afterSeq: 0 });
      await appendTexts(bee, 3, 50); // seq 3..5, racing the replay
      assert.deepEqual((await responsePromise).result, { ok: true });
      const rows = await takeHsrEvents(conn, 5);
      assert.deepEqual(rows.map((row) => row.event.seq), [1, 2, 3, 4, 5], "replay→live merge must be exactly-once");
    },
  );
});

test("a stale cursor gets the explicit gap and resumes from the oldest retained seq", async () => {
  const bee = "gw-gap";
  await withConnectedCell(
    async () => {
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, liveMeta(bee));
      await appendTexts(bee, 10); // seq 1..10
      await ackHsrEvents(bee, 6);
      await compactHsrEvents(bee, { keepLines: 2, targetBytes: 10_000 }); // folds 1..6, retains 7..10
    },
    async ({ gateway }) => {
      const conn = await gateway.nextConnection();
      await conn.take(isHello, "hello");
      const response = await conn.request("subscribe", { bee, afterSeq: 4 });
      assert.deepEqual(response.result, { ok: true, gap: { fromSeq: 5, toSeq: 6 } });
      const rows = await takeHsrEvents(conn, 4);
      assert.deepEqual(rows.map((row) => row.event.seq), [7, 8, 9, 10]);
    },
  );
});

test("ackEvents advances the durable on-disk watermark through the relay", async () => {
  const bee = "gw-ack";
  await withConnectedCell(
    async () => {
      await ensureHsrRunDir(bee);
      await appendTexts(bee, 4);
    },
    async ({ gateway }) => {
      const conn = await gateway.nextConnection();
      await conn.take(isHello, "hello");
      const response = await conn.request("ackEvents", { bee, upToSeq: 3 });
      assert.deepEqual(response.result, { ok: true, ackedSeq: 3 });
      assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 4, ackedSeq: 3 }, "the watermark must be durable");
      // Never-regress + clamp semantics ride through the same relay.
      const stale = await conn.request("ackEvents", { bee, upToSeq: 1 });
      assert.deepEqual(stale.result, { ok: true, ackedSeq: 3 });
      const over = await conn.request("ackEvents", { bee, upToSeq: 999 });
      assert.deepEqual(over.result, { ok: true, ackedSeq: 4 });
    },
  );
});

test("a server-side drop re-dials with backoff, re-hellos, and a fresh subscribe resumes exactly", async () => {
  const bee = "gw-reconnect";
  await withConnectedCell(
    async () => {
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, liveMeta(bee));
      await appendTexts(bee, 3); // seq 1..3
    },
    async ({ gateway }) => {
      const first = await gateway.nextConnection();
      await first.take(isHello, "hello");
      await first.request("subscribe", { bee, afterSeq: 0 });
      const before = await takeHsrEvents(first, 3);
      assert.deepEqual(before.map((row) => row.event.seq), [1, 2, 3]);

      // Hard drop (sleeping cell / dead tunnel). Events keep landing on disk.
      first.destroy();
      await appendTexts(bee, 2, 200); // seq 4..5

      const second = await gateway.nextConnection();
      const hello = await second.take(isHello, "re-hello");
      const params = hello.params as { bees: Array<{ bee: string; lastSeq?: number }> };
      assert.deepEqual(params.bees.map((row) => [row.bee, row.lastSeq]), [[bee, 5]], "re-hello advertises the durable high-water");

      // The gateway resumes from ITS durable cursor — nothing was lost or duped.
      const response = await second.request("subscribe", { bee, afterSeq: 3 });
      assert.deepEqual(response.result, { ok: true });
      const resumed = await takeHsrEvents(second, 2);
      assert.deepEqual(resumed.map((row) => row.event.seq), [4, 5]);
    },
  );
});

test("controller relays dispatch into the serve-mode methods map with rpc error mapping", async () => {
  const bee = "gw-relay";
  await withConnectedCell(
    async ({ controller }) => {
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, liveMeta(bee));
      // Inject a throwing method to exercise the -32000 mapping (buildController's
      // own methods are guarded and surface {ok:false} results instead).
      controller.methods.boom = () => {
        throw new Error("kapow");
      };
    },
    async ({ gateway }) => {
      const conn = await gateway.nextConnection();
      await conn.take(isHello, "hello");

      const ping = await conn.request("ping");
      assert.deepEqual(ping.result, { ok: true, version: versionString() });

      const liveness = await conn.request("liveness");
      assert.deepEqual(liveness.result, { [bee]: true });

      const list = (await conn.request("list")).result as Array<{ bee: string; status: string }>;
      assert.deepEqual(list.map((row) => [row.bee, row.status]), [[bee, "running"]]);

      // A guarded controller failure is a RESULT (the serve-mode contract)…
      const badSend = await conn.request("send", { bee: "nobody", text: "hi" });
      assert.equal((badSend.result as { ok: boolean }).ok, false);

      // …while transport-level failures are JSON-RPC errors.
      const missing = await conn.request("definitely-not-a-method");
      assert.equal(missing.error?.code, -32601);
      const thrown = await conn.request("boom");
      assert.deepEqual(thrown.error, { code: -32000, message: "kapow" });
      const badSubscribe = await conn.request("subscribe", { afterSeq: 0 });
      assert.equal(badSubscribe.error?.code, -32602);
    },
  );
});

test("presence edges are pushed best-effort when a bee's status flips", async () => {
  const bee = "gw-presence";
  await withConnectedCell(
    async () => {
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, liveMeta(bee));
      await appendTexts(bee, 2);
    },
    async ({ gateway }) => {
      const conn = await gateway.nextConnection();
      await conn.take(isHello, "hello");
      await writeHsrMeta(bee, { ...liveMeta(bee, "sess-9"), status: "exited" });
      const presence = await conn.take((frame) => frame.method === "presence", "presence");
      assert.deepEqual(presence.params, { bee, status: "exited", sessionId: "sess-9", lastSeq: 2 });
    },
  );
});
