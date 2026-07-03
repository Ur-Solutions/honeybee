/**
 * Remote HSR transport tests (APIA-91).
 *
 * NOTE ON SSH: real ssh to localhost has NO key-auth in this environment (flagged
 * in APIA-90), so these tests exercise the TRANSPORT LOGIC without a real ssh
 * child. The ssh unix→unix forward is stood in for by a LOCAL socket relay: a
 * real `node:net` server plays the "remote serve" (answers `ping`, pushes
 * `hsr.event`), and the injected `spawnTunnel` hook builds a real local relay
 * (localSock → remoteSock) exactly as `ssh -L` would. The real ssh wire is only
 * asserted at the argv level via the captured spawn hook. Real-host e2e (loopback
 * key-auth) is deferred to APIA-98.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { startRpcServer, type RpcServer } from "../src/hsr/rpc.js";
import {
  buildServeExecArgv,
  buildSshForwardArgv,
  connectRemoteRunnerHost,
  ensureRemoteServe,
  type SshExecHook,
  type TunnelChild,
  type TunnelSpawnHook,
} from "../src/hsr/remoteTransport.js";
import type { NodeRecord } from "../src/node.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeNode(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "loopunit",
    kind: "remote-hsr",
    endpoint: "me@remote-host",
    capabilities: ["*"],
    runnerHostVersion: "0.0.1+deadbeef1234",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

/** Parse `-L <local>:<remote>` out of a forward argv. */
function parseForward(argv: string[]): { local: string; remote: string } {
  const i = argv.indexOf("-L");
  assert.ok(i >= 0 && argv[i + 1], "forward argv must contain -L <local>:<remote>");
  const spec = argv[i + 1]!;
  const cut = spec.indexOf(":");
  return { local: spec.slice(0, cut), remote: spec.slice(cut + 1) };
}

/**
 * A spawnTunnel hook that stands in for `ssh -L`: builds a real `node:net` relay
 * from the local socket to the remote (relay) socket. Captures every argv it was
 * asked to spawn. `failNext` makes the next spawn produce a child that dies
 * immediately (used to force a reconnect retry).
 */
function makeRelayTunnel(): {
  hook: TunnelSpawnHook;
  argvs: string[][];
  servers: Server[];
  killAll: () => void;
} {
  const argvs: string[][] = [];
  const servers: Server[] = [];
  const hook: TunnelSpawnHook = (argv) => {
    argvs.push(argv);
    const { local, remote } = parseForward(argv);
    const conns = new Set<Socket>();
    const relay: Server = createServer((down) => {
      conns.add(down);
      const up = createConnection(remote);
      conns.add(up);
      down.pipe(up);
      up.pipe(down);
      const bail = (): void => {
        down.destroy();
        up.destroy();
      };
      down.on("error", bail);
      up.on("error", bail);
      down.on("close", () => up.destroy());
      up.on("close", () => down.destroy());
    });
    servers.push(relay);
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    relay.listen(local);
    const child: TunnelChild = {
      argv,
      kill: () => {
        for (const c of conns) c.destroy();
        relay.close(() => resolveExit());
        resolveExit();
      },
      exited,
    };
    return child;
  };
  return {
    hook,
    argvs,
    servers,
    killAll: () => {
      for (const s of servers) s.close();
    },
  };
}

/** An exec hook that reports the remote serve socket as already present. */
function serveUpExecHook(trace: string[]): SshExecHook {
  return async (argv) => {
    const cmd = argv[argv.length - 1] ?? "";
    trace.push(cmd);
    if (cmd.startsWith("test -S")) return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

// --- ensureRemoteServe --------------------------------------------------------

test("ensureRemoteServe: socket already present → single `test -S`, no serve start", async () => {
  const trace: string[] = [];
  const { remoteSocket } = await ensureRemoteServe(makeNode(), { execHook: serveUpExecHook(trace) });
  assert.equal(remoteSocket, "~/.hive/runner-host/control.sock");
  assert.deepEqual(trace, ["test -S ~/.hive/runner-host/control.sock"]);
});

test("ensureRemoteServe: missing socket → starts detached setsid node serve, then polls test -S", async () => {
  const trace: string[] = [];
  let socketUp = false;
  const execHook: SshExecHook = async (argv) => {
    const cmd = argv[argv.length - 1] ?? "";
    trace.push(cmd);
    if (cmd.startsWith("test -S")) {
      return { stdout: "", stderr: "", exitCode: socketUp ? 0 : 1 };
    }
    if (cmd.startsWith("setsid node")) {
      socketUp = true; // the detached serve "comes up"
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${cmd}`, exitCode: 1 };
  };
  const { remoteSocket } = await ensureRemoteServe(makeNode(), {
    execHook,
    sleep: async () => {},
    pollAttempts: 5,
  });
  assert.equal(remoteSocket, "~/.hive/runner-host/control.sock");
  // Sequence: probe (miss) → setsid start → probe (hit).
  assert.equal(trace[0], "test -S ~/.hive/runner-host/control.sock");
  const start = trace.find((c) => c.startsWith("setsid node"));
  assert.ok(start, "must issue a `setsid node <bundle> serve --socket` start");
  assert.match(start!, /setsid node ~\/\.hive\/runner-host\/hive-runner-host-0\.0\.1\+deadbeef1234\.mjs serve --socket ~\/\.hive\/runner-host\/control\.sock/);
  assert.ok(trace.filter((c) => c.startsWith("test -S")).length >= 2, "must poll test -S after starting");
});

test("ensureRemoteServe: rejects a node without runnerHostVersion", async () => {
  await assert.rejects(
    ensureRemoteServe(makeNode({ runnerHostVersion: undefined }), { execHook: serveUpExecHook([]) }),
    /no runnerHostVersion/,
  );
});

// --- ssh forward argv (the real wire, asserted via the hook) ------------------

test("buildSshForwardArgv: contains -N, -L <local>:<remote>, ControlMaster=auto, StreamLocalBindUnlink=yes", () => {
  const argv = buildSshForwardArgv(makeNode(), "/local/control.sock", "~/.hive/runner-host/control.sock");
  assert.ok(argv.includes("-N"));
  const li = argv.indexOf("-L");
  assert.ok(li >= 0);
  assert.equal(argv[li + 1], "/local/control.sock:~/.hive/runner-host/control.sock");
  assert.ok(argv.includes("ControlMaster=auto"));
  assert.ok(argv.includes("ExitOnForwardFailure=yes"));
  assert.ok(argv.includes("StreamLocalBindUnlink=yes"));
  assert.equal(argv[0], "ssh");
  assert.equal(argv[argv.length - 1], "me@remote-host");
  // ControlPath uses the shared %C hash so it reuses the ssh-tmux master.
  assert.ok(argv.includes("ControlPath=~/.ssh/hive-%C"));
});

test("buildServeExecArgv: `ssh <endpoint> <cmd>` with control-master options", () => {
  const argv = buildServeExecArgv(makeNode(), "test -S /x");
  assert.equal(argv[0], "ssh");
  assert.equal(argv[argv.length - 2], "me@remote-host");
  assert.equal(argv[argv.length - 1], "test -S /x");
  assert.ok(argv.includes("ControlMaster=auto"));
});

// --- connectRemoteRunnerHost: end-to-end over a local socket relay -------------

/** Spin up a real "remote serve" rpc server on its own socket dir. */
async function withRemoteServe(
  methods: Parameters<typeof startRpcServer>[0]["methods"],
  fn: (ctx: { remoteSock: string; server: RpcServer; restart: (m?: typeof methods) => Promise<void>; dir: string }) => Promise<void>,
): Promise<void> {
  // Use a SHORT /tmp base: the forwarded local socket nests as
  // <storeRoot>/remote/<node>/control.sock, and macOS caps AF_UNIX paths at ~104
  // chars — the default long tmpdir() prefix overflows that.
  const dir = await mkdtemp("/tmp/hb-rt-");
  // Point storeRoot at the temp dir so the transport's local forward socket
  // (<storeRoot>/remote/<node>/control.sock) lands here, not the real ~/.hive.
  const prevStore = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  const remoteSock = join(dir, "remote-control.sock");
  let server = await startRpcServer({ socketPath: remoteSock, methods });
  const ctx = {
    remoteSock,
    get server(): RpcServer {
      return server;
    },
    dir,
    restart: async (m?: typeof methods) => {
      server = await startRpcServer({ socketPath: remoteSock, methods: m ?? methods });
    },
  };
  try {
    await fn(ctx as unknown as { remoteSock: string; server: RpcServer; restart: (m?: typeof methods) => Promise<void>; dir: string });
  } finally {
    await server.close().catch(() => {});
    if (prevStore === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prevStore;
    await rm(dir, { recursive: true, force: true });
  }
}

test("connect + call('ping') round-trips over the forwarded socket", async () => {
  await withRemoteServe({ ping: () => ({ ok: true, version: "runner-host test" }) }, async ({ remoteSock, dir }) => {
    const tunnel = makeRelayTunnel();
    const client = await connectRemoteRunnerHost(makeNode(), {
      execHook: serveUpExecHook([]),
      spawnTunnel: tunnel.hook,
      remoteSocket: remoteSock,
      forward: { waitAttempts: 50, waitIntervalMs: 10 },
    });
    try {
      assert.equal(client.connected(), true);
      const res = await client.call("ping");
      assert.deepEqual(res, { ok: true, version: "runner-host test" });
      // The forward argv the transport asked ssh to run.
      assert.equal(tunnel.argvs.length, 1);
      const { remote, local } = parseForward(tunnel.argvs[0]!);
      assert.equal(remote, remoteSock);
      // The forwarded local socket lives under storeRoot/remote/<node>/, and it
      // is what the rpc client actually connected to.
      assert.equal(local, join(dir, "remote", "loopunit", "control.sock"));
      assert.equal(client.localSocket, local);
    } finally {
      await client.close();
    }
  });
});

test("subscription: on('hsr.event') receives pushed notifications", async () => {
  await withRemoteServe({ ping: () => ({ ok: true }) }, async ({ remoteSock, server }) => {
    const tunnel = makeRelayTunnel();
    const client = await connectRemoteRunnerHost(makeNode(), {
      execHook: serveUpExecHook([]),
      spawnTunnel: tunnel.hook,
      remoteSocket: remoteSock,
      forward: { waitAttempts: 50, waitIntervalMs: 10 },
    });
    try {
      const received: number[] = [];
      const got3 = new Promise<void>((resolve) => {
        client.on("hsr.event", (p) => {
          received.push((p as { n: number }).n);
          if (received.length === 3) resolve();
        });
      });
      // Give the bridge a tick to attach before broadcasting.
      await sleep(20);
      for (let n = 1; n <= 3; n++) server.broadcast("hsr.event", { n });
      await got3;
      assert.deepEqual(received, [1, 2, 3]);
    } finally {
      await client.close();
    }
  });
});

test("reconnect + re-adoption: drop the relay, bring it back, subscription still delivers", async () => {
  await withRemoteServe({ ping: () => ({ ok: true }) }, async (ctx) => {
    const tunnel = makeRelayTunnel();
    const client = await connectRemoteRunnerHost(makeNode(), {
      execHook: serveUpExecHook([]),
      spawnTunnel: tunnel.hook,
      remoteSocket: ctx.remoteSock,
      forward: { waitAttempts: 100, waitIntervalMs: 10 },
      reconnect: { maxAttempts: 20, baseDelayMs: 10, maxDelayMs: 30 },
    });
    try {
      const received: number[] = [];
      client.on("hsr.event", (p) => received.push((p as { n: number }).n));

      const reconnected = new Promise<void>((resolve) => client.on("reconnect", () => resolve()));

      await sleep(20);
      ctx.server.broadcast("hsr.event", { n: 1 });
      await sleep(30);
      assert.deepEqual(received, [1], "pre-drop event delivered");

      // DROP: kill the remote serve AND the tunnel relay → client socket closes.
      await ctx.server.close();
      tunnel.killAll();

      // Bring the remote serve back on the same socket path.
      await ctx.restart();

      // Wait for the transport to re-establish (session re-adoption).
      await reconnected;
      assert.equal(client.connected(), true);

      // A NEW event after reconnect must reach the re-adopted subscription.
      const got2 = new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          if (received.includes(2)) {
            clearInterval(iv);
            resolve();
          }
        }, 10);
      });
      await sleep(20);
      ctx.server.broadcast("hsr.event", { n: 2 });
      await got2;
      assert.ok(received.includes(2), "post-reconnect event delivered to re-adopted subscription");
    } finally {
      await client.close();
    }
  });
});

test("per-call timeoutMs rejects a hung call", async () => {
  await withRemoteServe({ hang: () => new Promise(() => {}) }, async ({ remoteSock }) => {
    const tunnel = makeRelayTunnel();
    const client = await connectRemoteRunnerHost(makeNode(), {
      execHook: serveUpExecHook([]),
      spawnTunnel: tunnel.hook,
      remoteSocket: remoteSock,
      forward: { waitAttempts: 50, waitIntervalMs: 10 },
    });
    try {
      await assert.rejects(
        client.call("hang", undefined, { timeoutMs: 80 }),
        /timed out after 80ms/,
      );
    } finally {
      await client.close();
    }
  });
});

test("backpressure: floods are capped and dropped-oldest with a dropped-count", async () => {
  await withRemoteServe({ ping: () => ({ ok: true }) }, async ({ remoteSock, server }) => {
    const tunnel = makeRelayTunnel();
    const maxQueue = 5;
    const client = await connectRemoteRunnerHost(makeNode(), {
      execHook: serveUpExecHook([]),
      spawnTunnel: tunnel.hook,
      remoteSocket: remoteSock,
      maxQueue,
      forward: { waitAttempts: 50, waitIntervalMs: 10 },
    });
    try {
      const delivered: number[] = [];
      // A gated handler: the first delivery parks the drain loop until we open
      // the gate, so a synchronous flood overflows the bounded queue → drops.
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let first = true;
      client.on("hsr.event", async (p) => {
        delivered.push((p as { n: number }).n);
        if (first) {
          first = false;
          await gate;
        }
      });
      await sleep(20);

      const N = 100;
      for (let n = 0; n < N; n++) server.broadcast("hsr.event", { n });
      // Let the flood arrive and fill the queue while the drain is gated.
      await sleep(60);

      const dropped = client.droppedCount("hsr.event");
      assert.ok(dropped > 0, `expected drops, got ${dropped}`);
      // Nothing beyond (1 in-flight + maxQueue buffered) can be retained.
      assert.ok(dropped >= N - (maxQueue + 1), `dropped ${dropped} should account for the flood beyond the cap`);

      openGate();
      await sleep(40);
      // Delivered count is bounded by the cap discipline, never the full flood.
      assert.ok(delivered.length <= maxQueue + 1, `delivered ${delivered.length} exceeded cap ${maxQueue + 1}`);
      assert.equal(delivered.length + dropped, N, "every event is either delivered or counted as dropped");
    } finally {
      await client.close();
    }
  });
});
