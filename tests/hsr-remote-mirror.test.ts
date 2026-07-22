/**
 * Remote event mirror e2e (APIA-94) — WITHOUT ssh.
 *
 * The "remote" is a REAL child `remoteHost.ts serve` running under its OWN
 * HIVE_STORE_ROOT (so the remote bee's run dir is genuinely separate from the
 * local one — the whole point of the mirror). The ssh unix→unix forward is
 * stood in for by a LOCAL socket relay (the same injected `spawnTunnel` pattern
 * as hsr-remote-substrate.test.ts). So the mirror → substrate → transport →
 * remote-serve path is exercised for real; only the ssh WIRE is stubbed.
 *
 * We assert the full mirror lifecycle:
 *   - a live remote stub bee gets ONE local mirror subscription (dedupe on
 *     repeated ticks);
 *   - a steered turn's `text`/`usage`/`turn_end` events land in the LOCAL
 *     events.jsonl and the local ring.txt shows the output;
 *   - hsrObservations()/deriveState report the remote bee as a live structured
 *     state (idle_with_output) from the mirror, with mirrorOf set;
 *   - the usage sampler ingests the mirrored `usage` event (per account);
 *   - when the bee leaves the remote list (kill), the mirror tears down and the
 *     local meta flips to "exited".
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createRemoteEventMirror } from "../src/hsr/remoteEventMirror.js";
import { hsrObservations, hsrUsageObservation } from "../src/hsr/observe.js";
import { hsrEventsPath, hsrRingPath, readHsrMeta } from "../src/hsr/runDir.js";
import { createRemoteHsrSubstrate, type RemoteHsrSubstrate } from "../src/substrates/remote-hsr.js";
import { clearSubstrateCache } from "../src/substrates/index.js";
import { createUsageSampler } from "../src/daemon/usageSampler.js";
import { deriveState, type BeeState, type StateContext } from "../src/state.js";
import type { NodeRecord } from "../src/node.js";
import type { SessionRecord } from "../src/store.js";
import { readUsageEvents, type UsageEvent } from "../src/usage.js";
import type { ConnectRemoteOptions, TunnelChild, TunnelSpawnHook, SshExecHook } from "../src/hsr/remoteTransport.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** SHORT /tmp base: forwarded local sockets nest under <storeRoot> and macOS caps AF_UNIX at ~104 chars. */
async function withTempStore(fn: (localDir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-rmir-");
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

function beeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "remotebee",
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: "remotebee",
    node: "loopunit",
    combId: "remotebee",
    accountId: "acct-remote",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

type FakeSubstrateLifecycle = {
  observeCalls: number;
  offCalls: number;
  closeCalls: number;
};

function fakeRemoteSubstrate(node: NodeRecord, liveSessions: Set<string>, lifecycle: FakeSubstrateLifecycle): RemoteHsrSubstrate {
  return {
    kind: "remote-hsr",
    node: node.name,
    endpoint: node.endpoint,
    probe: async () => ({ ok: true }),
    hasSession: async (target) => liveSessions.has(target),
    newSession: async () => ({ paneId: "%1" }),
    kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [...liveSessions],
    listPanes: async () => new Set(),
    listSessionStates: async () => new Map(),
    setUserOptions: async () => undefined,
    setWindowOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => [],
    attachSession: async () => undefined,
    ping: async () => ({ ok: true }),
    spawnRemote: async (params) => ({ bee: params.bee }),
    refreshCredsRemote: async () => ({ ok: true }),
    provisionRemote: async (params) => ({ path: "/tmp/remote-checkout", repo: params.repo, branch: params.branch, reused: false }),
    listCheckouts: async () => [],
    eventsTail: async () => [],
    observe: async () => {
      lifecycle.observeCalls += 1;
      return () => {
        lifecycle.offCalls += 1;
      };
    },
    close: async () => {
      lifecycle.closeCalls += 1;
    },
  };
}

test("remote event mirror closes a node substrate when the node is re-kinded", async () => {
  await withTempStore(async () => {
    let node = makeNode();
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const liveSessions = new Set([beeRecord().name]);
    const mirror = createRemoteEventMirror({
      loadNode: async () => node,
      createSubstrate: (n) => fakeRemoteSubstrate(n, liveSessions, lifecycle),
    });

    await mirror([beeRecord()]);
    assert.equal(lifecycle.observeCalls, 1, "mirror subscribed on first tick");

    node = makeNode({ kind: "ssh-tmux" });
    await mirror([beeRecord()]);

    assert.equal(lifecycle.offCalls, 1, "re-kind unsubscribed the old mirror");
    assert.equal(lifecycle.closeCalls, 1, "re-kind closed the old substrate");
    assert.equal((await readHsrMeta(beeRecord().name))?.status, "exited", "re-kind marks the local mirror exited");
  });
});

test("remote event mirror close releases subscriptions and substrates without marking mirrors exited", async () => {
  await withTempStore(async () => {
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const liveSessions = new Set([beeRecord().name]);
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: (n) => fakeRemoteSubstrate(n, liveSessions, lifecycle),
    });

    await mirror([beeRecord()]);
    assert.equal((await readHsrMeta(beeRecord().name))?.status, "running");

    await mirror.close();
    await mirror.close();

    assert.equal(lifecycle.offCalls, 1, "dispatcher close unsubscribes once");
    assert.equal(lifecycle.closeCalls, 1, "dispatcher close closes the substrate once");
    assert.equal((await readHsrMeta(beeRecord().name))?.status, "running", "shutdown close must not fake a remote exit");
  });
});

test("remote event mirror: backfills events emitted before the observe subscription attached (no duplicates)", async () => {
  await withTempStore(async (localDir) => {
    const remoteStore = await mkdtemp("/tmp/hb-rmtb-");
    const remoteSock = join(localDir, "rc.sock");
    const serveProc: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", "src/hsr/remoteHost.ts", "serve", "--socket", remoteSock],
      { cwd: process.cwd(), env: { ...process.env, HIVE_STORE_ROOT: remoteStore }, stdio: "ignore" },
    );

    const node = makeNode();
    const tunnel = makeRelayTunnel();
    const transport: ConnectRemoteOptions = {
      execHook: serveUpExecHook,
      spawnTunnel: tunnel.hook,
      remoteSocket: remoteSock,
      forward: { waitAttempts: 200, waitIntervalMs: 10 },
    };
    const driverNode = makeNode({ name: "loopdrv" });
    const driver = createRemoteHsrSubstrate(driverNode, { transport });

    const mirrorSubs: Array<{ close: () => Promise<void> }> = [];
    const mirror = createRemoteEventMirror({
      loadNode: async (name) => (name === "loopunit" ? node : null),
      createSubstrate: (n) => {
        const sub = createRemoteHsrSubstrate(n, { transport });
        mirrorSubs.push(sub);
        return sub;
      },
    });

    const record = beeRecord();
    try {
      await waitFor(() => existsSync(remoteSock), "remote serve socket appears");

      const bee = record.name;
      await driver.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        sessionId: "pinned-remote-backfill",
        spec: { command: process.execPath, args: [], env: {} },
      });
      await waitFor(async () => await driver.hasSession(bee), "remote bee live");

      // Steer a turn BEFORE the mirror ever ticks: these events exist only on
      // the remote — exactly the spawn→first-tick gap the backfill recovers.
      await driver.sendText(bee, "before mirror");
      await waitFor(async () => {
        const tail = await driver.eventsTail(bee);
        return tail.some((e) => e.type === "text");
      }, "remote events.jsonl has the pre-mirror turn (via the events RPC)");

      // First mirror tick: subscribe + backfill the pre-attach tail.
      await mirror([record]);
      await waitFor(async () => {
        const raw = await readFile(hsrEventsPath(bee), "utf8").catch(() => "");
        return raw.includes("echo:before mirror");
      }, "backfill lands the pre-attach text event locally");

      // A live turn after attach must append exactly once alongside the backfill.
      await driver.sendText(bee, "after mirror");
      await waitFor(async () => {
        const raw = await readFile(hsrEventsPath(bee), "utf8").catch(() => "");
        return raw.includes("echo:after mirror");
      }, "live events still flow after backfill");

      const lines = (await readFile(hsrEventsPath(bee), "utf8")).trim().split("\n");
      const beforeCount = lines.filter((l) => l.includes("echo:before mirror")).length;
      const afterCount = lines.filter((l) => l.includes("echo:after mirror")).length;
      assert.equal(beforeCount, 1, "backfilled event appears exactly once");
      assert.equal(afterCount, 1, "live event appears exactly once");

      // A second tick must not re-backfill (dedupe by mirrors map).
      await mirror([record]);
      const lines2 = (await readFile(hsrEventsPath(bee), "utf8")).trim().split("\n");
      assert.equal(lines2.filter((l) => l.includes("echo:before mirror")).length, 1, "no duplicate after a second tick");
    } finally {
      await driver.close().catch(() => undefined);
      for (const sub of mirrorSubs) await sub.close().catch(() => undefined);
      tunnel.killAll();
      try {
        serveProc.kill("SIGTERM");
      } catch {
        // already gone
      }
      await rm(remoteStore, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

test("remote event mirror: subscribe → replay events/ring locally → deriveState + usage → teardown on disappear", async () => {
  await withTempStore(async (localDir) => {
    // A REAL remote serve in a child, under its OWN store root (separate run dir).
    const remoteStore = await mkdtemp("/tmp/hb-rmt-");
    const remoteSock = join(localDir, "rc.sock");
    const serveProc: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", "src/hsr/remoteHost.ts", "serve", "--socket", remoteSock],
      { cwd: process.cwd(), env: { ...process.env, HIVE_STORE_ROOT: remoteStore }, stdio: "ignore" },
    );

    const node = makeNode();
    const tunnel = makeRelayTunnel();
    const transport: ConnectRemoteOptions = {
      execHook: serveUpExecHook,
      spawnTunnel: tunnel.hook,
      remoteSocket: remoteSock,
      forward: { waitAttempts: 200, waitIntervalMs: 10 },
    };
    // The "driver" substrate spawns + steers + kills the remote bee. A DISTINCT
    // node name (so its forwarded local socket path differs from the mirror's)
    // pointed at the SAME remote serve.
    const driverNode = makeNode({ name: "loopdrv" });
    const driver = createRemoteHsrSubstrate(driverNode, { transport });

    // Count observe subscriptions to prove no double-subscribe across ticks, and
    // track the mirror's substrates so we can close their tunnels at the end.
    let observeCalls = 0;
    const mirrorSubs: Array<{ close: () => Promise<void> }> = [];
    const mirror = createRemoteEventMirror({
      loadNode: async (name) => (name === "loopunit" ? node : null),
      createSubstrate: (n) => {
        const sub = createRemoteHsrSubstrate(n, { transport });
        mirrorSubs.push(sub);
        const origObserve = sub.observe.bind(sub);
        sub.observe = async (bee, cb) => {
          observeCalls += 1;
          return origObserve(bee, cb);
        };
        return sub;
      },
    });

    const record = beeRecord();
    try {
      await waitFor(() => existsSync(remoteSock), "remote serve socket appears");

      // Spawn a stub bee ON the remote (in the child's store).
      const bee = record.name;
      const res = await driver.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        sessionId: "pinned-remote",
        spec: { command: process.execPath, args: [], env: {} },
      });
      assert.equal(res.bee, bee);
      await waitFor(async () => await driver.hasSession(bee), "remote bee live");

      // Tick 1: the mirror subscribes and seeds a local `running` mirror meta.
      await mirror([record]);
      const meta1 = await readHsrMeta(bee);
      assert.ok(meta1, "local mirror meta written");
      assert.equal(meta1!.mirrorOfNode, "loopunit", "meta marked mirrorOfNode");
      assert.equal(meta1!.status, "running");
      assert.equal(meta1!.hostPid, 0, "mirror meta has no local host pid");

      // Steer a turn that also reports usage; events relay into the LOCAL run dir.
      await driver.sendText(bee, "usage please");
      await waitFor(async () => {
        const raw = await readFile(hsrEventsPath(bee), "utf8").catch(() => "");
        return raw.includes("turn_end") && raw.includes('"type":"usage"');
      }, "local events.jsonl gains text/usage/turn_end");

      const eventsRaw = await readFile(hsrEventsPath(bee), "utf8");
      assert.match(eventsRaw, /"type":"text"/, "mirrored a text event");
      assert.match(eventsRaw, /"type":"turn_end"/, "mirrored the turn_end");
      // ring.txt is written debounced — wait for the flush.
      await waitFor(async () => (await readFile(hsrRingPath(bee), "utf8").catch(() => "")).includes("echo:usage please"), "local ring.txt shows the output");

      // Tick 2: no double subscription (dedupe).
      await mirror([record]);
      assert.equal(observeCalls, 1, "exactly one observe subscription across ticks");

      // hsrObservations()/deriveState: the remote bee reads live + idle_with_output.
      const observations = await hsrObservations();
      const obs = observations.get(bee);
      assert.ok(obs, "observation present for mirrored bee");
      assert.equal(obs!.live, true, "mirror bee is live");
      assert.equal(obs!.mirrorOf, "loopunit", "observation carries mirrorOf");
      assert.equal(obs!.state, "idle_with_output", "structured state from mirrored events");

      const context: StateContext = {
        liveTargets: new Set(),
        panes: new Map(),
        hsrLive: new Set([bee]),
        hsrStates: new Map<string, BeeState>([[bee, obs!.state!]]),
        hsrSnapshots: new Map([[bee, obs!.snapshot]]),
        hsrMirrors: new Set([bee]),
        now: Date.now(),
      };
      assert.equal(deriveState(record, context).state, "idle_with_output", "deriveState routes mirror bee to HSR path");

      // Usage sampler: ingests the mirrored `usage` event for the account.
      const ledger: Record<string, unknown>[] = [];
      const sampler = createUsageSampler({ appendLedger: async (e) => void ledger.push(e), sampleIntervalMs: 0 });
      const usageObs = await hsrUsageObservation(bee);
      assert.deepEqual(usageObs.totals, { inputTokens: 100, outputTokens: 10 }, "mirrored usage totals readable");
      const outcomes = await sampler([record], new Map(), 1_000);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.sampled, true, "sampler sampled the mirrored usage");
      const samples = (await readUsageEvents("acct-remote")).filter(
        (e): e is Extract<UsageEvent, { kind: "sample" }> => e.kind === "sample",
      );
      assert.equal(samples.length, 1);
      assert.equal(samples[0]!.inputTokens, 100);
      assert.equal(samples[0]!.outputTokens, 10);

      // Teardown: the bee leaves the remote list (kill) → mirror tears down and
      // flips the local meta to "exited".
      await driver.kill(bee);
      await waitFor(async () => (await driver.hasSession(bee)) === false, "remote bee gone");
      await mirror([record]);
      const meta2 = await readHsrMeta(bee);
      assert.ok(meta2, "meta still present after teardown");
      assert.equal(meta2!.status, "exited", "mirror meta flipped to exited");
      assert.ok(meta2!.endedAt, "endedAt stamped on teardown");

      // And the observation now reads not-live (deriveState would settle it dead).
      const finalObs = (await hsrObservations()).get(bee);
      assert.equal(finalObs?.live, false, "mirror bee reads not-live after teardown");
    } finally {
      await driver.close().catch(() => undefined);
      for (const sub of mirrorSubs) await sub.close().catch(() => undefined);
      tunnel.killAll();
      try {
        serveProc.kill("SIGTERM");
      } catch {
        // already gone
      }
      await rm(remoteStore, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
