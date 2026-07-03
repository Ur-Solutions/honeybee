import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient, startRpcServer, type RpcMethodHandler } from "../src/hsr/rpc.js";

/**
 * Run `fn` against a temp socket dir; always clean up. Each test gets its own
 * mkdtemp so sockets never collide and stale-socket state is isolated.
 */
async function withSocketDir(fn: (socketPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-rpc-"));
  try {
    await fn(join(dir, "control.sock"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("round-trip: echo method returns its params", async () => {
  await withSocketDir(async (socketPath) => {
    const server = await startRpcServer({
      socketPath,
      methods: { echo: (params) => params },
    });
    const client = await connectRpcClient(socketPath);
    try {
      const result = await client.call("echo", { x: 1 });
      assert.deepEqual(result, { x: 1 });
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("method-not-found rejects with -32601 / Method not found", async () => {
  await withSocketDir(async (socketPath) => {
    const server = await startRpcServer({ socketPath, methods: {} });
    const client = await connectRpcClient(socketPath);
    try {
      await assert.rejects(
        () => client.call("nope"),
        (err: Error & { code?: number }) => {
          assert.equal(err.code, -32601);
          assert.match(err.message, /Method not found/);
          return true;
        },
      );
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("handler throw rejects with the thrown message; server still serves after", async () => {
  await withSocketDir(async (socketPath) => {
    const methods: Record<string, RpcMethodHandler> = {
      boom: () => {
        throw new Error("kaboom");
      },
      ok: () => "still here",
    };
    const server = await startRpcServer({ socketPath, methods });
    const client = await connectRpcClient(socketPath);
    try {
      await assert.rejects(
        () => client.call("boom"),
        (err: Error) => {
          assert.match(err.message, /kaboom/);
          return true;
        },
      );
      // Server survived the throw and serves a subsequent successful call.
      assert.equal(await client.call("ok"), "still here");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("notification stream: client receives all broadcasts in order", async () => {
  await withSocketDir(async (socketPath) => {
    const server = await startRpcServer({ socketPath, methods: {} });
    const client = await connectRpcClient(socketPath);
    try {
      const received: number[] = [];
      const done = new Promise<void>((resolve) => {
        client.on("event", (params) => {
          received.push((params as { n: number }).n);
          if (received.length === 3) resolve();
        });
      });
      // Broadcast after the subscription is registered. connectionCount()>0
      // guarantees the server sees the client before we fan out.
      assert.equal(server.connectionCount(), 1);
      for (let n = 1; n <= 3; n++) server.broadcast("event", { n });
      await done;
      assert.deepEqual(received, [1, 2, 3]);
    } finally {
      client.close();
      await server.close();
    }
  });
});

/** Poll until `cond` is true or the deadline passes (test never hangs). */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await sleep(5);
  }
}

test("broadcast backpressure: slow client gets bounded drop-oldest queue; fast client and telemetry unaffected (HIVE-70)", async () => {
  await withSocketDir(async (socketPath) => {
    const server = await startRpcServer({ socketPath, methods: {}, maxBroadcastQueue: 4 });

    // Fast client: a normal rpc client that reads promptly.
    const fast = await connectRpcClient(socketPath);
    const fastMarkers: string[] = [];
    fast.on("marker", (params) => {
      fastMarkers.push((params as { t: string }).t);
    });

    // Slow client: a raw socket that never reads (paused) — simulates a lagging
    // forwarded tunnel consumer. Without backpressure the server would buffer
    // every broadcast frame for it unboundedly.
    const slow = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    slow.pause();

    try {
      await waitFor(() => server.connectionCount() === 2);
      assert.equal(server.broadcastDroppedCount(), 0);

      // Saturate the slow connection with big frames until drop-oldest engages.
      // The sleep between broadcasts lets the fast client's socket flush, so it
      // never blocks and every drop is attributable to the slow connection.
      const pad = "x".repeat(512 * 1024);
      for (let i = 0; i < 20 && server.broadcastDroppedCount() === 0; i++) {
        server.broadcast("filler", { pad });
        await sleep(5);
      }
      assert.ok(server.broadcastDroppedCount() > 0, "expected drop-oldest to engage on the slow connection");
      const droppedAfterFill = server.broadcastDroppedCount();

      // With the slow connection blocked and its queue full, each further
      // broadcast displaces the oldest queued frame. Synchronous loop: no
      // 'drain' can fire mid-way, so the queue ends as the LAST 4 markers.
      for (let n = 1; n <= 6; n++) server.broadcast("marker", { t: `t${n}` });
      assert.equal(server.broadcastDroppedCount(), droppedAfterFill + 6);

      // The fast client is isolated from the slow one: it receives all 6.
      await waitFor(() => fastMarkers.length === 6);
      assert.deepEqual(fastMarkers, ["t1", "t2", "t3", "t4", "t5", "t6"]);

      // Once the slow client drains, it gets the bounded tail (drop-oldest):
      // exactly the last maxBroadcastQueue=4 markers, in order.
      const slowMarkers: string[] = [];
      let buffer = "";
      slow.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            const msg = JSON.parse(line) as { method?: string; params?: { t?: string } };
            if (msg.method === "marker" && msg.params?.t) slowMarkers.push(msg.params.t);
          }
          idx = buffer.indexOf("\n");
        }
      });
      slow.resume();
      await waitFor(() => slowMarkers.includes("t6"));
      assert.deepEqual(slowMarkers, ["t3", "t4", "t5", "t6"]);
    } finally {
      slow.destroy();
      fast.close();
      await server.close();
    }
  });
});

test("concurrency: 5 in-flight calls all resolve with correct per-id results", async () => {
  await withSocketDir(async (socketPath) => {
    const server = await startRpcServer({
      socketPath,
      methods: {
        delayed: async (params) => {
          const { i } = params as { i: number };
          // Longer wait for earlier ids so responses complete out of send order;
          // the id-matching in the transport must still route each correctly.
          await sleep(50 - i * 5);
          return { doubled: i * 2 };
        },
      },
    });
    const client = await connectRpcClient(socketPath);
    try {
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) => client.call("delayed", { i })),
      );
      assert.deepEqual(results, [
        { doubled: 0 },
        { doubled: 2 },
        { doubled: 4 },
        { doubled: 6 },
        { doubled: 8 },
      ]);
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("connection lifecycle: server.close rejects pending call, resolves closed, drops count", async () => {
  await withSocketDir(async (socketPath) => {
    const server = await startRpcServer({
      socketPath,
      methods: {
        forever: () => new Promise(() => {}), // never resolves
      },
    });
    const client = await connectRpcClient(socketPath);

    assert.equal(server.connectionCount(), 1);

    const pending = client.call("forever", undefined, { timeoutMs: 5_000 });
    const rejected = assert.rejects(pending, /rpc connection closed/);

    await server.close();

    await rejected;
    await client.closed; // resolves on socket close
    assert.equal(server.connectionCount(), 0);

    client.close();
  });
});

test("stale socket: a leftover file with no live listener is unlinked and rebound", async () => {
  await withSocketDir(async (socketPath) => {
    // Simulate the crashed-process leftover: a file exists at the socket path
    // but nothing is listening. A connect probe errors (ECONNREFUSED/ENOTSOCK),
    // so startRpcServer must unlink it and bind cleanly.
    await writeFile(socketPath, "");
    const server = await startRpcServer({ socketPath, methods: { ping: () => "pong" } });
    const client = await connectRpcClient(socketPath);
    try {
      assert.equal(await client.call("ping"), "pong");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("live socket: startRpcServer refuses a path with a running server", async () => {
  await withSocketDir(async (socketPath) => {
    const first = await startRpcServer({ socketPath, methods: {} });
    try {
      await assert.rejects(
        () => startRpcServer({ socketPath, methods: {} }),
        /already listening/,
      );
    } finally {
      await first.close();
    }
  });
});
