/**
 * Node health & lifecycle UX (APIA-96).
 *
 * Three units, all offline-friendly (no ssh, no real remote):
 *
 *  1. `nodeHealth` over a remote-hsr node backed by a REAL in-process runner-host
 *     serve (the ssh wire is stood in for by a local socket relay, exactly like
 *     hsr-remote-substrate.test.ts). Reachable → latency number + live runner-host
 *     version (== the LOCAL bundle core, so no drift) + a live bee count. A second
 *     node pointed at a dead socket → offline with a reason (never throws).
 *  2. The node online/offline edge tracker: reachable→unreachable emits exactly
 *     one node.offline, staying unreachable emits nothing, recovering emits one
 *     node.online, and the first observation only baselines.
 *  3. Stale-view: a remote-hsr bee whose node is in unreachableNodes derives
 *     node_unreachable (not dead) — the bees-view path.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "../src/hsr/remoteHost.js";
import { runnerHostVersionCore } from "../src/hsr/buildRunnerHostBundle.js";
import { createRemoteHsrSubstrate } from "../src/substrates/remote-hsr.js";
import { clearSubstrateCache } from "../src/substrates/index.js";
import { nodeHealth } from "../src/nodeHealth.js";
import { createNodeReachabilityTracker } from "../src/daemon/nodeReachability.js";
import { deriveState, type StateContext } from "../src/state.js";
import type { NodeRecord } from "../src/node.js";
import type { SessionRecord } from "../src/store.js";
import type { TunnelChild, TunnelSpawnHook, SshExecHook } from "../src/hsr/remoteTransport.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** SHORT /tmp base — the forwarded socket nests deep and macOS caps AF_UNIX at ~104 chars. */
async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-nst-");
  process.env.HIVE_STORE_ROOT = dir;
  clearSubstrateCache();
  try {
    await fn(dir);
  } finally {
    clearSubstrateCache();
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function makeNode(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "loopunit",
    kind: "remote-hsr",
    endpoint: "me@remote-host",
    capabilities: ["*"],
    runnerHostVersion: "0.0.1+deadbeef1234",
    status: "unknown",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

function parseForward(argv: string[]): { local: string; remote: string } {
  const i = argv.indexOf("-L");
  assert.ok(i >= 0 && argv[i + 1], "forward argv must contain -L <local>:<remote>");
  const spec = argv[i + 1]!;
  const cut = spec.indexOf(":");
  return { local: spec.slice(0, cut), remote: spec.slice(cut + 1) };
}

/** A spawnTunnel hook standing in for `ssh -L`: a real node:net local→remote relay. */
function makeRelayTunnel(): { hook: TunnelSpawnHook; killAll: () => void } {
  const servers: Server[] = [];
  const hook: TunnelSpawnHook = (argv) => {
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
  return { hook, killAll: () => servers.forEach((s) => s.close()) };
}

/** An exec hook that reports the remote serve socket as already present (no setsid start). */
const serveUpExecHook: SshExecHook = async () => ({ stdout: "", stderr: "", exitCode: 0 });

test("nodeHealth: reachable remote-hsr reports latency, live runner-host version (no drift) and a live bee count", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const node = makeNode();
    const tunnel = makeRelayTunnel();
    const sub = createRemoteHsrSubstrate(node, {
      transport: {
        execHook: serveUpExecHook,
        spawnTunnel: tunnel.hook,
        remoteSocket: remoteSock,
        forward: { waitAttempts: 100, waitIntervalMs: 10 },
      },
    });

    try {
      // Spawn a stub bee so the live count is a definite 1.
      await sub.spawnRemote({ bee: "sbee", kind: "stub", cwd: process.cwd(), spec: { command: process.execPath, args: [], env: {} } });
      await waitFor(async () => await sub.hasSession("sbee"), "stub bee live");

      const health = await nodeHealth(node, { substrate: sub });
      assert.equal(health.name, "loopunit");
      assert.equal(health.kind, "remote-hsr");
      assert.equal(health.reachable, true);
      assert.equal(typeof health.latencyMs, "number");
      assert.ok((health.latencyMs ?? -1) >= 0, "latency is a real ms number");
      // The in-process serve reports the same git-derived core as the local bundle.
      assert.equal(health.runnerHostVersion, runnerHostVersionCore());
      assert.equal(health.localVersion, runnerHostVersionCore());
      assert.equal(health.versionDrift, false, "live version matches local bundle → no drift");
      assert.equal(health.liveBees, 1);
      assert.equal(health.reason, undefined);
    } finally {
      await sub.close();
      await server.close();
      tunnel.killAll();
    }
  });
});

test("nodeHealth: a remote-hsr node pointed at a dead socket is offline with a reason (no throw)", async () => {
  await withTempStore(async (dir) => {
    const deadSock = join(dir, "nobody-here.sock"); // no serve ever bound
    const node = makeNode({ name: "downunit" });
    const tunnel = makeRelayTunnel();
    const sub = createRemoteHsrSubstrate(node, {
      transport: {
        execHook: serveUpExecHook,
        spawnTunnel: tunnel.hook,
        remoteSocket: deadSock,
        forward: { waitAttempts: 20, waitIntervalMs: 10 },
      },
    });
    try {
      const health = await nodeHealth(node, { substrate: sub, timeoutMs: 1_500 });
      assert.equal(health.reachable, false);
      assert.equal(typeof health.reason, "string");
      assert.ok((health.reason ?? "").length > 0, "offline carries a reason");
      assert.equal(typeof health.latencyMs, "number");
      // Unreachable falls back to the recorded runner-host version.
      assert.equal(health.runnerHostVersion, "0.0.1+deadbeef1234");
      assert.equal(health.liveBees, undefined);
    } finally {
      await sub.close();
      tunnel.killAll();
    }
  });
});

test("node reachability tracker: emits node.offline/node.online only on the reachability edge", async () => {
  const events: Array<Record<string, unknown>> = [];
  const track = createNodeReachabilityTracker({ appendLedger: async (e) => void events.push(e) });
  const nodes: NodeRecord[] = [makeNode({ name: "n1" })];
  const NOW = Date.parse("2026-07-03T12:00:00.000Z");

  // Tick 1: first observation (reachable) — baseline only, no event.
  assert.deepEqual(await track(nodes, new Set(), NOW), []);
  assert.equal(events.length, 0);

  // Tick 2: reachable → unreachable — exactly one node.offline.
  const off = await track(nodes, new Set(["n1"]), NOW + 1_000);
  assert.deepEqual(off, [{ node: "n1", transition: "offline" }]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "node.offline");
  assert.equal(events[0]!.node, "n1");
  assert.equal(typeof events[0]!.ts, "string");

  // Tick 3: still unreachable — no new event.
  assert.deepEqual(await track(nodes, new Set(["n1"]), NOW + 2_000), []);
  assert.equal(events.length, 1);

  // Tick 4: unreachable → reachable — exactly one node.online.
  const on = await track(nodes, new Set(), NOW + 3_000);
  assert.deepEqual(on, [{ node: "n1", transition: "online" }]);
  assert.equal(events.length, 2);
  assert.equal(events[1]!.type, "node.online");
});

test("deriveState: a remote-hsr bee on an unreachable node is node_unreachable, not dead", async () => {
  const record: SessionRecord = {
    name: "rb",
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: "rb",
    node: "loopunit",
    combId: "rb",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    status: "running",
  };

  // Node down → node_unreachable wins over the (absent) liveness signal.
  const down: StateContext = {
    liveTargets: new Set(),
    unreachableNodes: new Set(["loopunit"]),
    now: Date.now(),
  };
  assert.equal(deriveState(record, down).state, "node_unreachable");

  // Node reachable but no live target → it would read dead, proving the probe
  // (not a hardcoded state) is what surfaces node_unreachable above.
  const up: StateContext = { liveTargets: new Set(), unreachableNodes: new Set(), now: Date.now() };
  assert.equal(deriveState(record, up).state, "crashed");
});
