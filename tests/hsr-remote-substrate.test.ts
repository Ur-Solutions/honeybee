/**
 * Remote HSR substrate e2e (APIA-92).
 *
 * Drives a `remote-hsr` bee end-to-end WITHOUT ssh: the "remote" is this machine.
 * A real in-process runner-host serve (remoteHost.serve) plays the remote control
 * plane; the ssh unix→unix forward is stood in for by a LOCAL socket relay (the
 * same injected `spawnTunnel` pattern as hsr-remote-transport.test.ts). So the
 * substrate → transport → remote-serve path is exercised for real; only the ssh
 * WIRE is stubbed. Real loopback-ssh e2e is APIA-98.
 *
 * The bee runs the STUB adapter (no claude/codex binary, no auth). We assert:
 * spawnRemote → live via hasSession/listSessionStates → sendText → capture shows
 * "echo:hello" → observe relays events → kill removes it. Plus routing-by-node.kind
 * and the remote-hsr record shape (node set, no substrate:"hsr", no pane).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "../src/hsr/remoteHost.js";
import { startRpcServer } from "../src/hsr/rpc.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { createRemoteHsrSubstrate } from "../src/substrates/remote-hsr.js";
import {
  clearSubstrateCache,
  remoteHsrSubstrateForNode,
  substrateFor,
} from "../src/substrates/index.js";
import { loadNode, registerNode } from "../src/node.js";
import type { NodeRecord } from "../src/node.js";
import type { SessionRecord } from "../src/store.js";
import type { TunnelChild, TunnelSpawnHook, SshExecHook } from "../src/hsr/remoteTransport.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SHORT /tmp base: the forwarded local socket nests as
 * <storeRoot>/remote/<node>/control.sock and macOS caps AF_UNIX paths at ~104
 * chars — the default long tmpdir() prefix overflows that.
 */
async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-rhs-");
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

/** Parse `-L <local>:<remote>` out of a forward argv. */
function parseForward(argv: string[]): { local: string; remote: string } {
  const i = argv.indexOf("-L");
  assert.ok(i >= 0 && argv[i + 1], "forward argv must contain -L <local>:<remote>");
  const spec = argv[i + 1]!;
  const cut = spec.indexOf(":");
  return { local: spec.slice(0, cut), remote: spec.slice(cut + 1) };
}

/** A spawnTunnel hook that stands in for `ssh -L`: a real node:net local→remote relay. */
function makeRelayTunnel(): { hook: TunnelSpawnHook; servers: Server[]; killAll: () => void } {
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
  return { hook, servers, killAll: () => servers.forEach((s) => s.close()) };
}

/** An exec hook that reports the remote serve socket as already present (no setsid start). */
const serveUpExecHook: SshExecHook = async () => ({ stdout: "", stderr: "", exitCode: 0 });

test("remote HSR substrate: spawnRemote → steer → observe → kill a stub bee over the forwarded socket", async () => {
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
      // Static shape + a live probe over the forwarded socket.
      assert.equal(sub.kind, "remote-hsr");
      assert.equal(sub.node, "loopunit");
      assert.equal(sub.attachCommand("x").length, 0);
      assert.equal((await sub.listPanes()).size, 0);
      assert.deepEqual(await sub.probe(), { ok: true });

      // spawnRemote forks the runner host ON the remote (in-process here) from a
      // resolved spec — the stub adapter runs its own script, ignoring the spec.
      const bee = "remotebee";
      const res = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        sessionId: "pinned-remote-session",
        spec: { command: process.execPath, args: [], env: {} },
      });
      assert.equal(res.bee, bee);
      assert.equal(res.tier, "stream");
      assert.equal(res.sessionId, "pinned-remote-session");

      // Observed via the node-probe path: hasSession + listSessionStates/listSessions.
      await waitFor(async () => await sub.hasSession(bee), "hasSession true after spawn");
      const states = await sub.listSessionStates();
      assert.ok(states.has(bee), "listSessionStates includes the live bee");
      assert.ok((await sub.listSessions()).includes(bee), "listSessions includes the bee");

      // observe: subscribe BEFORE steering so we catch the turn's relayed events.
      const events: Array<{ type?: string }> = [];
      const off = await sub.observe(bee, (e) => events.push(e as { type?: string }));

      // steer: sendText delivers a turn; capture shows the stub echo.
      await sub.sendText(bee, "hello");
      await waitFor(async () => (await sub.capture(bee)).includes("echo:hello"), "capture shows echo:hello");
      const tail = await sub.capture(bee, 5);
      assert.match(tail, /echo:hello/);

      // event relay delivered the turn's structured events (text/turn_end).
      await waitFor(() => events.some((e) => e.type === "text" || e.type === "turn_end"), "observe relayed turn events");
      off();

      // sendText to an unknown bee surfaces a clear error.
      await assert.rejects(() => sub.sendText("no-such-bee", "hi"), /remote HSR send/);

      // kill stops the runner AND removes its remote run dir; the bee goes away.
      const kr = await sub.kill(bee);
      assert.equal(kr.ok, true);
      await waitFor(async () => (await sub.hasSession(bee)) === false, "hasSession false after kill");
      assert.equal((await sub.listSessionStates()).has(bee), false, "listSessionStates drops the killed bee");
    } finally {
      await sub.close();
      await server.close();
      tunnel.killAll();
    }
  });
});

test("observe survives a remote serve RESTART: the substrate re-issues the observe RPC on reconnect (HIVE-11)", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const bee = "restartbee";

    // A fake per-bee runner host: a real RpcServer on the bee's control socket.
    // The remote serve's observe relay connects here and re-broadcasts every
    // "event" notification as hsr.event. It OUTLIVES the serve restart below —
    // exactly like a real runner host (a detached process) does when the serve
    // crashes and is restarted by ensureRemoteServe.
    const beeSock = join(dir, "bee-control.sock");
    const beeHost = await startRpcServer({ socketPath: beeSock, methods: { ping: () => ({ ok: true }) } });
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      controlSocket: beeSock,
      status: "running",
    });

    let server = await serve(remoteSock);
    const node = makeNode();
    const tunnel = makeRelayTunnel();
    const sub = createRemoteHsrSubstrate(node, {
      transport: {
        execHook: serveUpExecHook,
        spawnTunnel: tunnel.hook,
        remoteSocket: remoteSock,
        forward: { waitAttempts: 100, waitIntervalMs: 10 },
        reconnect: { maxAttempts: 50, baseDelayMs: 10, maxDelayMs: 50 },
      },
    });

    try {
      const events: Array<{ type?: string; text?: string }> = [];
      const off = await sub.observe(bee, (e) => events.push(e as { type?: string; text?: string }));

      // Sanity: the relay works before the restart.
      await waitFor(() => {
        beeHost.broadcast("event", { type: "text", text: "before-restart" });
        return events.some((e) => e.text === "before-restart");
      }, "event relayed before restart");

      // RESTART the serve: the new process has an EMPTY relays map, so only a
      // re-issued observe RPC (not just the transport's local re-bridge) can
      // bring the event stream back. The bee host itself keeps running.
      await server.close();
      server = await serve(remoteSock);

      // The transport reconnects (client socket died with the old serve), the
      // substrate re-observes, the fresh serve rebuilds its relay — and events
      // flow again. Without the re-observe this times out: the mirror freezes.
      await waitFor(() => {
        beeHost.broadcast("event", { type: "text", text: "after-restart" });
        return events.some((e) => e.text === "after-restart");
      }, "event relayed after serve restart", 10_000);

      off();
    } finally {
      await sub.close();
      await server.close();
      await beeHost.close();
      tunnel.killAll();
    }
  });
});

test("remote HSR routing: node.kind routes to the remote substrate; local hsr stays local; record shape holds", async () => {
  await withTempStore(async () => {
    await registerNode({
      name: "loopunit",
      kind: "remote-hsr",
      endpoint: "me@remote-host",
      runnerHostVersion: "0.0.1+deadbeef1234",
      capabilities: ["*"],
    });

    // A record as spawnBee builds it for a remote-hsr bee: node set, NO local
    // substrate:"hsr", NO agentPaneId. It must route to the remote substrate.
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
    assert.equal(record.substrate, undefined, "remote-hsr record must NOT set substrate:hsr");
    assert.equal(record.agentPaneId, undefined, "remote-hsr record has no pane");
    assert.equal(substrateFor(record).kind, "remote-hsr", "routes by node.kind to the remote substrate");

    // A local-hsr record (substrate:"hsr", no node) still routes to LOCAL hsr.
    const localHsr: SessionRecord = { ...record, substrate: "hsr" };
    delete (localHsr as { node?: string }).node;
    assert.equal(substrateFor(localHsr).kind, "hsr", "substrate:hsr still routes to local hsr");

    // The typed accessor exposes spawnRemote and shares the per-node cache.
    const node = await loadNode("loopunit");
    assert.ok(node);
    const typed = remoteHsrSubstrateForNode(node!);
    assert.equal(typed.kind, "remote-hsr");
    assert.equal(typeof typed.spawnRemote, "function");
    assert.equal(typeof typed.observe, "function");
    await typed.close();
  });
});
