import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
