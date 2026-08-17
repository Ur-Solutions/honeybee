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
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createRemoteEventMirror } from "../src/hsr/remoteEventMirror.js";
import {
  readHsrEventIntegrityReceipt,
  type HsrEventIntegrityReceipt,
} from "../src/hsr/eventIntegrity.js";
import { versionCore } from "../src/hsr/remoteHost.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import { hsrObservations, hsrUsageObservation } from "../src/hsr/observe.js";
import {
  appendHsrEvent,
  compactHsrEvents,
  ensureHsrRunDir,
  hsrEventsPath,
  hsrRingPath,
  hsrRunDir,
  readHsrMeta,
  writeHsrMeta,
  writeHsrRing,
} from "../src/hsr/runDir.js";
import {
  createRemoteHsrSubstrate,
  RemoteObservationDetachedError,
  RemoteObservationIntegrityError,
  type RemoteHsrSubstrate,
} from "../src/substrates/remote-hsr.js";
import { clearSubstrateCache } from "../src/substrates/index.js";
import { createUsageSampler } from "../src/daemon/usageSampler.js";
import { deriveState, type BeeState, type StateContext } from "../src/state.js";
import { isRunnableSessionRecord } from "../src/stateMachine.js";
import type { NodeRecord } from "../src/node.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import { readUsageEvents, type UsageEvent } from "../src/usage.js";
import type {
  ConnectRemoteOptions,
  RemoteRunnerClient,
  TunnelChild,
  TunnelSpawnHook,
  SshExecHook,
} from "../src/hsr/remoteTransport.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const BUILT_TEST_GRAPH = process.env.HIVE_TEST_BUILT_CLI === "1";

function childSourceModule(pathWithoutExtension: string): string {
  return new URL(`../src/${pathWithoutExtension}.${BUILT_TEST_GRAPH ? "js" : "ts"}`, import.meta.url).href;
}

function childModuleArgs(script: string): string[] {
  return [
    ...(BUILT_TEST_GRAPH ? [] : ["--import", "tsx"]),
    "--input-type=module",
    "--eval",
    script,
  ];
}

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
    runnerHostVersion: versionCore(),
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
    remoteLaunchId: "00000000-0000-4000-8000-0000000000a1",
    remoteIncarnation: "00000000-0000-4000-8000-0000000000a2",
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
    listRemoteRows: async () => Promise.all([...liveSessions].map(async (bee) => {
      const current = await loadSession(bee);
      return {
        bee,
        live: true,
        state: null,
        tier: "server" as const,
        sessionId: null,
        status: "running" as const,
        controlSocket: null,
        launchId: current?.remoteLaunchId,
        incarnation: current?.remoteIncarnation,
      };
    })),
    replayTerminalEvents: async () => undefined,
    listPanes: async () => new Set(),
    listSessionStates: async () => new Map(),
    setUserOptions: async () => undefined,
    setWindowOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => [],
    attachSession: async () => undefined,
    ping: async () => ({ ok: true }),
    answerRemote: async () => ({ status: "settled", replayed: false }),
    reconcileAnswerRemote: async (_bee, _operation, verdict) => verdict === "delivered"
      ? { status: "settled", replayed: true }
      : { status: "discarded" },
    reconcileEventIntegrityRemote: async () => undefined,
    discardEventConsumerRemote: async () => ({ ackedSeq: 0, throughSeq: 0, reclaimed: true }),
    pendingInputRemote: async () => ({
      pending: null,
      host: {
        hostPid: process.pid,
        startedAt: "2026-08-15T00:00:00.000Z",
        hostFingerprint: { pgid: process.pid, startedAt: "fake-remote-host" },
      },
    }),
    launchHeadRemote: async () => ({ state: "empty" }),
    spawnRemote: async (params) => ({
      bee: params.bee,
      launchId: params.launchId ?? "00000000-0000-4000-8000-000000000001",
      incarnation: "00000000-0000-4000-8000-000000000002",
      cwd: "/tmp/remote-cwd",
    }),
    killRemoteIncarnation: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0, incarnationStopped: true }),
    refreshCredsRemote: async () => ({ ok: true }),
    provisionRemote: async (params) => ({ path: "/tmp/remote-checkout", repo: params.repo, branch: params.branch, reused: false }),
    listCheckouts: async () => [],
    eventsTail: async () => [],
    observe: async (_bee, _onEvent, _locator, options) => {
      lifecycle.observeCalls += 1;
      await options?.afterAuthorized?.();
      await options?.afterSynchronized?.();
      return () => {
        lifecycle.offCalls += 1;
      };
    },
    syncObservation: async () => undefined,
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

    const record = beeRecord();
    await saveSession(record);
    await mirror([record]);
    assert.equal(lifecycle.observeCalls, 1, "mirror subscribed on first tick");

    node = makeNode({ kind: "ssh-tmux" });
    await mirror([record]);

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

    const record = beeRecord();
    await saveSession(record);
    await mirror([record]);
    assert.equal((await readHsrMeta(beeRecord().name))?.status, "running");

    await mirror.close();
    await mirror.close();

    assert.equal(lifecycle.offCalls, 1, "dispatcher close unsubscribes once");
    assert.equal(lifecycle.closeCalls, 1, "dispatcher close closes the substrate once");
    assert.equal((await readHsrMeta(beeRecord().name))?.status, "running", "shutdown close must not fake a remote exit");
  });
});

test("remote event mirror resets durable events, ring, cursor, and startedAt across same-name generations", async () => {
  await withTempStore(async () => {
    const bee = "mirror-generation-reset";
    const oldLaunchId = "00000000-0000-4000-8000-000000000101";
    const oldIncarnation = "00000000-0000-4000-8000-000000000102";
    const newLaunchId = "00000000-0000-4000-8000-000000000201";
    const newIncarnation = "00000000-0000-4000-8000-000000000202";
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: 0,
      startedAt: new Date(1_000).toISOString(),
      controlSocket: "",
      status: "running",
      mirrorOfNode: "loopunit",
      mirrorRemoteLaunchId: oldLaunchId,
      mirrorRemoteIncarnation: oldIncarnation,
    });
    await appendHsrEvent(bee, { type: "usage", ts: 1_100, inputTokens: 900, outputTokens: 90 });
    await appendHsrEvent(bee, { type: "exhausted", ts: 1_200, resetHint: "old-generation" });
    await writeHsrRing(bee, "old-generation-output\n");

    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const liveSessions = new Set([bee]);
    const substrate = fakeRemoteSubstrate(makeNode(), liveSessions, lifecycle);
    substrate.observe = async (_bee, onEvent, locator, options) => {
      assert.deepEqual(locator, { remoteLaunchId: newLaunchId, remoteIncarnation: newIncarnation });
      lifecycle.observeCalls += 1;
      await options?.afterAuthorized?.();
      await onEvent({ type: "text", ts: 2_100, seq: 1, text: "new-generation-output" });
      await options?.afterSynchronized?.();
      return () => { lifecycle.offCalls += 1; };
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
      now: () => 2_000,
    });
    const record = beeRecord({
      name: bee,
      remoteLaunchId: newLaunchId,
      remoteIncarnation: newIncarnation,
    });
    await saveSession(record);

    await mirror([record]);
    await waitFor(async () => (await readFile(hsrEventsPath(bee), "utf8").catch(() => "")).includes("new-generation-output"), "successor mirror backfill lands");
    const events = await readFile(hsrEventsPath(bee), "utf8");
    assert.doesNotMatch(events, /old-generation|"type":"usage"|"type":"exhausted"/);
    assert.equal(
      await readFile(hsrRingPath(bee), "utf8"),
      "new-generation-output\n",
      "predecessor ring is replaced only by the successor's durable text",
    );
    const meta = await readHsrMeta(bee);
    assert.equal(meta?.startedAt, new Date(2_000).toISOString());
    assert.equal(meta?.mirrorRemoteLaunchId, newLaunchId);
    assert.equal(meta?.mirrorRemoteIncarnation, newIncarnation);

    const usageEvents: UsageEvent[] = [];
    const ledger: Record<string, unknown>[] = [];
    const sampler = createUsageSampler({
      appendUsageEvent: async (event) => { usageEvents.push(event); },
      appendLedger: async (event) => { ledger.push(event); },
      readTranscriptRows: async () => null,
      sampleIntervalMs: 0,
    });
    const [outcome] = await sampler([record], new Map(), 3_000);
    assert.equal(outcome?.sampled, false, "predecessor totals are not attributed to the successor");
    assert.equal(outcome?.exhausted, false, "predecessor exhaustion is not replayed for the successor");
    assert.deepEqual(usageEvents, []);
    assert.deepEqual(ledger, []);
    await mirror.close();
  });
});

test("a stale same-name record cannot tear down the exact active mirror generation", async () => {
  await withTempStore(async () => {
    const bee = "mirror-stale-record";
    const currentLaunchId = "00000000-0000-4000-8000-000000000301";
    const currentIncarnation = "00000000-0000-4000-8000-000000000302";
    const staleLaunchId = "00000000-0000-4000-8000-000000000201";
    const staleIncarnation = "00000000-0000-4000-8000-000000000202";
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([bee]), lifecycle);
    substrate.eventsTail = async (_bee, _afterTs, locator) => {
      if (locator?.remoteLaunchId !== currentLaunchId || locator.remoteIncarnation !== currentIncarnation) {
        throw new Error("launch id does not own current mirror");
      }
      return [];
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });
    const current = beeRecord({
      name: bee,
      remoteLaunchId: currentLaunchId,
      remoteIncarnation: currentIncarnation,
    });
    await saveSession(current);
    await mirror([current]);
    assert.equal(lifecycle.observeCalls, 1);

    await mirror([beeRecord({
      name: bee,
      remoteLaunchId: staleLaunchId,
      remoteIncarnation: staleIncarnation,
    })]);
    assert.equal(lifecycle.offCalls, 0, "failed authority preflight preserves the exact current subscription");
    assert.equal(lifecycle.observeCalls, 1, "stale generation is never observed");
    const meta = await readHsrMeta(bee);
    assert.equal(meta?.mirrorRemoteLaunchId, currentLaunchId);
    assert.equal(meta?.mirrorRemoteIncarnation, currentIncarnation);
    await mirror.close();
  });
});

test("transient observe failure retries without fencing the canonical generation", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-transient-observe" });
    await saveSession(record);
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle);
    substrate.observe = async (_bee, _onEvent, _locator, options) => {
      lifecycle.observeCalls += 1;
      if (lifecycle.observeCalls === 1) throw new Error("tunnel dropped before observe admission");
      await options?.afterAuthorized?.();
      await options?.afterSynchronized?.();
      return () => { lifecycle.offCalls += 1; };
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });

    await mirror([record]);
    assert.equal((await loadSession(record.name))?.status, "running");
    assert.equal(await readHsrMeta(record.name), null, "pre-admission transport loss creates no mirror authority");

    await mirror([record]);
    assert.equal(lifecycle.observeCalls, 2);
    assert.equal((await readHsrMeta(record.name))?.status, "running");
    assert.equal((await loadSession(record.name))?.status, "running");
    await mirror.close();
  });
});

test("exact mirror keeps collecting evidence while delivery stop doubt fences work", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-delivery-doubt-evidence" });
    await saveSession(record);
    let callback: ((event: unknown) => void | Promise<void>) | undefined;
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle);
    substrate.observe = async (_bee, onEvent, _locator, options) => {
      callback = onEvent;
      lifecycle.observeCalls += 1;
      await options?.afterAuthorized?.();
      await options?.afterSynchronized?.();
      return () => { lifecycle.offCalls += 1; };
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });
    await mirror([record]);

    const fenceError = "delivery outcome requires operator reconciliation";
    const marker: NonNullable<SessionRecord["deliveryStopDoubt"]> = {
      version: 1,
      deliveryId: "delivery-doubt-1",
      contentDigest: "a".repeat(64),
      source: { createdAt: record.createdAt, runtimeGeneration: record.runtimeGeneration ?? 0 },
      createdAt: "2026-08-15T00:00:00.000Z",
      fenceError,
    };
    const fenced = { ...(await loadSession(record.name))!, deliveryStopDoubt: marker, lastError: fenceError };
    await saveSession(fenced);
    assert.equal(isRunnableSessionRecord(fenced), false, "delivery doubt still blocks every work admission");

    await callback!({
      type: "needs_input",
      ts: 10,
      seq: 1,
      host: {
        hostPid: 7001,
        startedAt: "2026-08-15T00:00:00.000Z",
        hostFingerprint: { pgid: 7001, startedAt: "mirror-delivery-doubt-host" },
      },
      kind: "question",
      question: "terminal evidence while fenced",
      requestId: "req-fenced",
    });
    const raw = await readFile(hsrEventsPath(record.name), "utf8");
    assert.match(raw, /req-fenced/, "evidence is durable even while work is fenced");

    const current = (await loadSession(record.name))!;
    const { deliveryStopDoubt: _marker, ...withoutMarker } = current;
    await saveSession({ ...withoutMarker, lastError: undefined, updatedAt: new Date().toISOString() });
    await mirror([(await loadSession(record.name))!]);
    const observation = (await hsrObservations({ includeEvents: true })).get(record.name);
    assert.equal(observation?.eventSnapshot?.pendingNeedsInput?.requestId, "req-fenced");
    assert.equal(lifecycle.observeCalls, 1, "clearing the marker needs no later event/reobserve to recover evidence");
    await mirror.close();
  });
});

test("event-history receipt import detaches an exact mirror without writing its quarantined projection", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-event-history-fence" });
    await saveSession(record);
    let callback: ((event: unknown) => void | Promise<void>) | undefined;
    let listCalls = 0;
    let publishReceipt = false;
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle);
    const receipt: HsrEventIntegrityReceipt = {
      version: 1,
      integrityId: "remote-integrity-active-entry",
      bee: record.name,
      host: {
        hostPid: 8452,
        startedAt: "2026-08-15T20:00:00.000Z",
        hostFingerprint: { pgid: 8452, startedAt: "remote-integrity-active-host" },
      },
      remoteAuthority: {
        launchId: record.remoteLaunchId!,
        incarnation: record.remoteIncarnation!,
      },
      phase: "unresolved",
      stopState: "confirmed",
      deliveryIds: [],
      reason: "remote source event append failed",
      createdAt: "2026-08-15T20:00:00.000Z",
      updatedAt: "2026-08-15T20:00:01.000Z",
      stopDetail: "exact remote host and child group stopped",
    };
    substrate.listRemoteRows = async () => {
      listCalls += 1;
      return publishReceipt
        ? [{
            bee: record.name,
            live: false,
            state: null,
            tier: "stream",
            sessionId: null,
            status: "event_integrity",
            controlSocket: null,
            launchId: record.remoteLaunchId,
            incarnation: record.remoteIncarnation,
            eventIntegrityFailure: receipt.reason,
            eventIntegrityId: receipt.integrityId,
            eventIntegrityStopState: receipt.stopState,
            eventIntegrityReceipt: receipt,
          }]
        : [{
            bee: record.name,
            live: true,
            state: null,
            tier: "stream",
            sessionId: null,
            status: "running",
            controlSocket: null,
            launchId: record.remoteLaunchId,
            incarnation: record.remoteIncarnation,
          }];
    };
    substrate.observe = async (_bee, onEvent, _locator, options) => {
      callback = onEvent;
      lifecycle.observeCalls += 1;
      await options?.afterAuthorized?.();
      await options?.afterSynchronized?.();
      return () => { lifecycle.offCalls += 1; };
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });

    await mirror([record]);
    await callback!({ type: "text", ts: 1, seq: 1, text: "before-integrity-fence" });
    assert.equal((await readHsrMeta(record.name))?.status, "running");
    assert.equal(lifecycle.observeCalls, 1);

    publishReceipt = true;
    await mirror([record]);
    const fenced = (await loadSession(record.name))!;
    assert.equal(fenced.eventIntegrityDoubt?.integrityId, receipt.integrityId);
    assert.equal((await readHsrEventIntegrityReceipt(record.name))?.integrityId, receipt.integrityId);
    assert.equal(lifecycle.offCalls, 1, "receipt import unsubscribes the exact in-memory relay");
    assert.equal((await readHsrMeta(record.name))?.status, "running", "event-history stop truth does not fabricate mirror-meta exit");

    const projectionPaths = [
      hsrEventsPath(record.name),
      hsrRingPath(record.name),
      join(hsrRunDir(record.name), "remote-events-cursor.json"),
      join(hsrRunDir(record.name), "remote-ring-state.json"),
      join(hsrRunDir(record.name), "meta.json"),
    ];
    const before = await Promise.all(projectionPaths.map((path) => readFile(path, "utf8")));
    await assert.rejects(
      async () => callback!({ type: "text", ts: 2, seq: 2, text: "must-not-land" }),
      RemoteObservationDetachedError,
    );
    assert.deepEqual(
      await Promise.all(projectionPaths.map((path) => readFile(path, "utf8"))),
      before,
      "a delayed callback cannot mutate any quarantined mirror projection file",
    );

    await mirror([fenced]);
    assert.equal(listCalls, 2, "an already-fenced row performs no later remote list/import read");
    assert.equal(lifecycle.observeCalls, 1, "an already-fenced row never re-subscribes");
    assert.equal(lifecycle.offCalls, 1, "fence teardown is idempotent");
    assert.equal((await readHsrMeta(record.name))?.status, "running", "fenced dispatch teardown still does not mark exited");
    await mirror.close();
  });
});

test("generic markerless kill_failed remote rows remain exactly observable", async () => {
  await withTempStore(async () => {
    const record = beeRecord({
      name: "mirror-generic-stop-doubt",
      status: "kill_failed",
      lastError: "session still exists after kill",
    });
    await saveSession(record);
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle);
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });

    await mirror([record]);
    assert.equal(lifecycle.observeCalls, 1, "generic stop doubt still collects exact remote evidence");
    assert.equal((await readHsrMeta(record.name))?.status, "running");
    await mirror.close();
  });
});

test("event integrity supersedes delivery doubt and cannot be reopened by its reconciliation", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-integrity-under-delivery-doubt" });
    await saveSession(record);
    let callback: ((event: unknown) => void | Promise<void>) | undefined;
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle);
    substrate.observe = async (_bee, onEvent, _locator, options) => {
      callback = onEvent;
      lifecycle.observeCalls += 1;
      await options?.afterAuthorized?.();
      await options?.afterSynchronized?.();
      return () => { lifecycle.offCalls += 1; };
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });
    await mirror([record]);

    const fenceError = "delivery fallback fence";
    const marker: NonNullable<SessionRecord["deliveryStopDoubt"]> = {
      version: 1,
      deliveryId: "delivery-doubt-integrity",
      contentDigest: "b".repeat(64),
      source: { createdAt: record.createdAt, runtimeGeneration: record.runtimeGeneration ?? 0 },
      createdAt: "2026-08-15T00:00:00.000Z",
      fenceError,
    };
    await saveSession({ ...(await loadSession(record.name))!, status: "kill_failed", lastError: fenceError, deliveryStopDoubt: marker });
    await callback!({
      type: "error",
      ts: 20,
      message: "remote retained history is corrupt",
      remoteObservationIntegrityFailure: true,
    });
    const integrityFenced = (await loadSession(record.name))!;
    assert.equal(integrityFenced.status, "kill_failed");
    assert.notEqual(integrityFenced.lastError, marker.fenceError, "integrity becomes an independent durable reason");

    // Mirror the delivery reconciler's ownership rule: it may clear only its
    // own marker/error and may reopen only when that exact error still owns the
    // kill_failed scalar. Integrity has superseded it, so clearing the delivery
    // marker leaves the canonical row non-runnable immediately.
    const { deliveryStopDoubt: _marker, ...cleared } = integrityFenced;
    await saveSession({ ...cleared, updatedAt: new Date().toISOString() });
    const afterReconcile = (await loadSession(record.name))!;
    assert.equal(afterReconcile.status, "kill_failed");
    assert.equal(isRunnableSessionRecord(afterReconcile), false);
    await mirror([afterReconcile]);
    assert.equal(lifecycle.observeCalls, 1, "integrity-fenced generation admits no replacement observe/work");
    await mirror.close();
  });
});

test("typed replay integrity failure fences the exact canonical generation and quarantines stale facts", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-integrity-fence" });
    await saveSession(record);
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle);
    substrate.observe = async () => {
      lifecycle.observeCalls += 1;
      throw new RemoteObservationIntegrityError("remote seq sidecar is malformed");
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });

    await mirror([record]);
    assert.equal((await loadSession(record.name))?.status, "kill_failed");
    assert.equal((await readHsrMeta(record.name))?.status, "exited");
    assert.equal(await readFile(hsrEventsPath(record.name), "utf8").catch(() => ""), "");

    await mirror([record]);
    assert.equal(lifecycle.observeCalls, 1, "non-runnable canonical fence prevents automatic re-observe");
    await mirror.close();
  });
});

test("a terminal exact row replays its final suffix once after a daemon restart with no in-memory mirror", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-terminal-no-entry" });
    await saveSession(record);
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set(), lifecycle);
    substrate.listRemoteRows = async () => [{
      bee: record.name,
      live: false,
      state: null,
      tier: "stream",
      sessionId: null,
      status: "exited",
      controlSocket: null,
      launchId: record.remoteLaunchId,
      incarnation: record.remoteIncarnation,
    }];
    const remoteEvents: RunnerEvent[] = [
      { type: "text", ts: 1, seq: 1, text: "terminal-before-daemon-restart" },
      { type: "exit", ts: 2, seq: 2, code: 0 },
    ];
    let projected = 0;
    substrate.replayTerminalEvents = async (_bee, onEvent, _locator, afterSeq, afterSynchronized) => {
      for (const event of remoteEvents) {
        if ((event.seq ?? 0) <= afterSeq) continue;
        projected += 1;
        await onEvent(event);
      }
      await afterSynchronized?.();
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });

    await mirror([record]);
    assert.equal(projected, 2);
    const first = await readFile(hsrEventsPath(record.name), "utf8");
    assert.equal((first.match(/terminal-before-daemon-restart/g) ?? []).length, 1);
    assert.equal((await readHsrMeta(record.name))?.status, "exited");

    await mirror([record]);
    assert.equal(projected, 2, "durable origin cursor prevents terminal replay duplication");
    const second = await readFile(hsrEventsPath(record.name), "utf8");
    assert.equal((second.match(/terminal-before-daemon-restart/g) ?? []).length, 1);
    assert.equal(lifecycle.observeCalls, 0, "an ended row never creates a live relay");
    await mirror.close();
  });
});

test("an exact no-entry event-integrity row imports its operator id and fences all local work", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-integrity-no-entry" });
    await saveSession(record);
    const now = "2026-08-15T19:30:00.000Z";
    const receipt: HsrEventIntegrityReceipt = {
      version: 1,
      integrityId: "remote-integrity-no-entry",
      bee: record.name,
      host: {
        hostPid: 8451,
        startedAt: now,
        hostFingerprint: { pgid: 8451, startedAt: "remote-integrity-host" },
      },
      remoteAuthority: {
        launchId: record.remoteLaunchId!,
        incarnation: record.remoteIncarnation!,
      },
      phase: "unresolved",
      stopState: "doubt",
      deliveryIds: ["remote-direct-delivery"],
      reason: "remote source event append failed",
      createdAt: now,
      updatedAt: now,
      stopDetail: "controller stop proof pending",
    };
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set(), lifecycle);
    let terminalReplayCalls = 0;
    substrate.listRemoteRows = async () => [{
      bee: record.name,
      live: false,
      state: null,
      tier: "stream",
      sessionId: null,
      status: "event_integrity",
      controlSocket: null,
      launchId: record.remoteLaunchId,
      incarnation: record.remoteIncarnation,
      eventIntegrityFailure: receipt.reason,
      eventIntegrityId: receipt.integrityId,
      eventIntegrityStopState: receipt.stopState,
      eventIntegrityReceipt: receipt,
    }];
    substrate.replayTerminalEvents = async () => { terminalReplayCalls += 1; };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });

    await mirror([record]);
    assert.equal((await readHsrEventIntegrityReceipt(record.name))?.integrityId, receipt.integrityId);
    const fenced = await loadSession(record.name);
    assert.equal(fenced?.eventIntegrityDoubt?.integrityId, receipt.integrityId);
    assert.equal(fenced?.status, "kill_failed");
    assert.equal(isRunnableSessionRecord(fenced!), false);
    assert.equal(lifecycle.observeCalls, 0);
    assert.equal(terminalReplayCalls, 0, "receipt import does not trust damaged event history");
    await mirror.close();
  });
});

test("a typed remote list integrity refusal fences canonical authority while transport loss remains retryable", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-list-integrity" });
    await saveSession(record);
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set(), lifecycle);
    substrate.listRemoteRows = async () => {
      throw new RemoteObservationIntegrityError("remote list metadata is malformed");
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });
    await mirror([record]);
    assert.equal((await loadSession(record.name))?.status, "kill_failed");
    assert.equal(lifecycle.observeCalls, 0);
    await mirror.close();
  });
});

test("a per-Bee remote list integrity row fences only its exact generation", async () => {
  await withTempStore(async () => {
    const damaged = beeRecord({
      name: "mirror-list-damaged-a",
      remoteLaunchId: "00000000-0000-4000-8000-0000000007a1",
      remoteIncarnation: "00000000-0000-4000-8000-0000000007a2",
    });
    const healthy = beeRecord({
      name: "mirror-list-healthy-b",
      remoteLaunchId: "00000000-0000-4000-8000-0000000007b1",
      remoteIncarnation: "00000000-0000-4000-8000-0000000007b2",
    });
    await saveSession(damaged);
    await saveSession(healthy);
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([healthy.name]), lifecycle);
    substrate.listRemoteRows = async () => [{
      bee: damaged.name,
      live: false,
      state: null,
      tier: "stream",
      sessionId: null,
      status: "event_integrity",
      controlSocket: null,
      launchId: damaged.remoteLaunchId,
      incarnation: damaged.remoteIncarnation,
      unavailable: "integrity",
      integrityFailure: true,
      error: "damaged source authority",
    }, {
      bee: healthy.name,
      live: true,
      state: "ready",
      tier: "stream",
      sessionId: null,
      status: "running",
      controlSocket: "/healthy.sock",
      launchId: healthy.remoteLaunchId,
      incarnation: healthy.remoteIncarnation,
    }];
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });

    await mirror([damaged, healthy]);
    assert.equal((await loadSession(damaged.name))?.status, "kill_failed");
    assert.equal((await loadSession(healthy.name))?.status, "running");
    assert.equal((await readHsrMeta(healthy.name))?.status, "running");
    assert.equal(lifecycle.observeCalls, 1, "healthy Bee retains independent observe admission");
    await mirror.close();
  });
});

test("actual remote exact-replay corruption fences the canonical mirror and admits no second observe", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-wire-integrity-fence" });
    await saveSession(record);
    let observeCalls = 0;
    let eventsCalls = 0;
    const client: RemoteRunnerClient = {
      node: "loopunit",
      localSocket: undefined,
      connected: () => true,
      async call(method) {
        if (method === "list") {
          return [{
            bee: record.name,
            live: true,
            state: null,
            tier: "turn",
            sessionId: null,
            status: "running",
            controlSocket: "/remote/control.sock",
            launchId: record.remoteLaunchId,
            incarnation: record.remoteIncarnation,
          }];
        }
        if (method === "observe") {
          observeCalls += 1;
          return { ok: true };
        }
        if (method === "events") {
          eventsCalls += 1;
          return { ok: false, integrityFailure: true, error: "remote seq sidecar is corrupt" };
        }
        if (method === "unobserve") return { ok: true };
        return { ok: true };
      },
      on: () => () => {},
      droppedCount: () => 0,
      async close() {},
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: (node) => createRemoteHsrSubstrate(node, { connect: async () => client }),
    });

    await mirror([record]);
    assert.equal(observeCalls, 1);
    assert.equal(eventsCalls, 1);
    assert.equal((await loadSession(record.name))?.status, "kill_failed");
    assert.equal((await readHsrMeta(record.name))?.status, "exited");

    await mirror([record]);
    assert.equal(observeCalls, 1, "canonical kill_failed blocks a second remote observe/work admission");
    assert.equal(eventsCalls, 1);
    await mirror.close();
  });
});

test("a delayed predecessor callback cannot recreate or contaminate a same-name successor mirror", async () => {
  await withTempStore(async () => {
    const bee = "mirror-delayed-predecessor";
    const predecessor = beeRecord({
      name: bee,
      remoteLaunchId: "00000000-0000-4000-8000-000000000401",
      remoteIncarnation: "00000000-0000-4000-8000-000000000402",
    });
    await saveSession(predecessor);
    let predecessorCallback: ((event: unknown) => void | Promise<void>) | undefined;
    let observeCount = 0;
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([bee]), lifecycle);
    substrate.observe = async (_bee, onEvent, _locator, options) => {
      observeCount += 1;
      await options?.afterAuthorized?.();
      if (observeCount === 1) predecessorCallback = onEvent;
      else await onEvent({ type: "text", ts: 2, seq: 1, text: "successor-only" });
      await options?.afterSynchronized?.();
      return () => { lifecycle.offCalls += 1; };
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });
    await mirror([predecessor]);

    const successor = beeRecord({
      ...predecessor,
      runtimeGeneration: 1,
      remoteLaunchId: "00000000-0000-4000-8000-000000000501",
      remoteIncarnation: "00000000-0000-4000-8000-000000000502",
    });
    await saveSession(successor);
    await mirror([successor]);
    await assert.rejects(
      Promise.resolve(predecessorCallback!({
        type: "needs_input",
        ts: 3,
        seq: 1,
        kind: "question",
        question: "poison?",
        requestId: "old",
      })),
      RemoteObservationDetachedError,
    );

    const raw = await readFile(hsrEventsPath(bee), "utf8");
    assert.match(raw, /successor-only/);
    assert.doesNotMatch(raw, /poison|"requestId":"old"/);
    const meta = await readHsrMeta(bee);
    assert.equal(meta?.mirrorRemoteLaunchId, successor.remoteLaunchId);
    assert.equal(meta?.mirrorRemoteIncarnation, successor.remoteIncarnation);
    await mirror.close();
  });
});

test("late integrity failure after archive never resurrects the row or run directory", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-archive-wins" });
    await saveSession(record);
    let callback: ((event: unknown) => void | Promise<void>) | undefined;
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle);
    substrate.observe = async (_bee, onEvent, _locator, options) => {
      callback = onEvent;
      await options?.afterAuthorized?.();
      await options?.afterSynchronized?.();
      return () => { lifecycle.offCalls += 1; };
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });
    await mirror([record]);
    await saveSession({ ...record, status: "done" });
    await rm(hsrRunDir(record.name), { recursive: true, force: true });

    await callback!({
      type: "error",
      ts: 2,
      message: "late gap",
      remoteObservationIntegrityFailure: true,
    });
    assert.equal((await loadSession(record.name))?.status, "done");
    assert.equal(existsSync(hsrRunDir(record.name)), false, "late fence must not recreate archived cache residue");
    await mirror.close();
  });
});

test("durable remote-origin cursor heals append-before-cursor crash and survives local compaction/restart", async () => {
  await withTempStore(async () => {
    const record = beeRecord({ name: "mirror-cursor-restart" });
    await saveSession(record);
    await ensureHsrRunDir(record.name);
    await writeHsrMeta(record.name, {
      bee: record.name,
      harness: "stub",
      tier: "stream",
      hostPid: 0,
      startedAt: "2026-08-15T00:00:00.000Z",
      controlSocket: "",
      status: "running",
      mirrorOfNode: record.node,
      mirrorRemoteLaunchId: record.remoteLaunchId,
      mirrorRemoteIncarnation: record.remoteIncarnation,
    });
    await appendHsrEvent(record.name, { type: "text", ts: 1, text: "one", remoteSeq: 1 });
    await appendHsrEvent(record.name, { type: "text", ts: 2, text: "two", remoteSeq: 2 });
    await writeFile(
      join(hsrRunDir(record.name), "remote-events-cursor.json"),
      `${JSON.stringify({
        version: 1,
        node: record.node,
        remoteLaunchId: record.remoteLaunchId,
        remoteIncarnation: record.remoteIncarnation,
        lastSeq: 1,
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(hsrRunDir(record.name), "remote-ring-state.json"),
      `${JSON.stringify({
        version: 1,
        node: record.node,
        remoteLaunchId: record.remoteLaunchId,
        remoteIncarnation: record.remoteIncarnation,
        throughRemoteSeq: 2,
        text: "one\ntwo\n",
      })}\n`,
      { mode: 0o600 },
    );
    await writeHsrRing(record.name, "one\ntwo\n");
    await compactHsrEvents(record.name, { keepLines: 1, targetBytes: 10_000 });

    let admittedCursor: number | undefined;
    const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const substrate = fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle);
    substrate.observe = async (_bee, _onEvent, _locator, options) => {
      admittedCursor = options?.afterSeq;
      await options?.afterAuthorized?.();
      await options?.afterSynchronized?.();
      return () => { lifecycle.offCalls += 1; };
    };
    const mirror = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => substrate,
    });
    await mirror([record]);
    assert.equal(admittedCursor, 2, "durable event origin heals the cursor lag without replaying seq 2");
    const raw = await readFile(hsrEventsPath(record.name), "utf8");
    assert.equal(raw.split("\n").filter((line) => line.includes('"remoteSeq":2')).length, 1);
    await mirror.close();

    // Cursor-only state is not proof. Losing both the retained origin event and
    // the atomic compaction checkpoint must fence instead of declaring caught up.
    await rm(hsrEventsPath(record.name));
    const secondLifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
    const mirrorAfterLoss = createRemoteEventMirror({
      loadNode: async () => makeNode(),
      createSubstrate: () => fakeRemoteSubstrate(makeNode(), new Set([record.name]), secondLifecycle),
    });
    await mirrorAfterLoss([record]);
    assert.equal((await loadSession(record.name))?.status, "kill_failed");
    assert.equal(secondLifecycle.observeCalls, 0, "deleted local evidence is refused before remote admission");
    await mirrorAfterLoss.close();
  });
});

test("mirror restart rejects cursors that skip or reorder their durable origin proof", async () => {
  await withTempStore(async () => {
    const cases: Array<{ name: string; cursor: number; events: RunnerEvent[] }> = [
      {
        name: "mirror-proof-cursor-ten-only",
        cursor: 10,
        events: [{ type: "text", ts: 10, text: "ten", remoteSeq: 10 }],
      },
      {
        name: "mirror-proof-checkpoint-eight-skip-nine",
        cursor: 10,
        events: [
          {
            type: "remote_cursor_checkpoint",
            ts: 8,
            throughRemoteSeq: 8,
            node: "loopunit",
            remoteLaunchId: "00000000-0000-4000-8000-000000000001",
            remoteIncarnation: "00000000-0000-4000-8000-000000000002",
          },
          { type: "text", ts: 10, text: "ten", remoteSeq: 10 },
        ],
      },
      {
        name: "mirror-proof-file-order-two-one",
        cursor: 2,
        events: [
          { type: "text", ts: 2, text: "two-first", remoteSeq: 2 },
          { type: "text", ts: 1, text: "one-second", remoteSeq: 1 },
        ],
      },
    ];

    for (const invalid of cases) {
      const record = beeRecord({ name: invalid.name });
      await saveSession(record);
      await ensureHsrRunDir(record.name);
      await writeHsrMeta(record.name, {
        bee: record.name,
        harness: "stub",
        tier: "stream",
        hostPid: 0,
        startedAt: "2026-08-15T00:00:00.000Z",
        controlSocket: "",
        status: "running",
        mirrorOfNode: record.node,
        mirrorRemoteLaunchId: record.remoteLaunchId,
        mirrorRemoteIncarnation: record.remoteIncarnation,
      });
      for (const event of invalid.events) {
        await appendHsrEvent(record.name, event.type === "remote_cursor_checkpoint"
          ? {
              ...event,
              node: record.node!,
              remoteLaunchId: record.remoteLaunchId!,
              remoteIncarnation: record.remoteIncarnation!,
            }
          : event);
      }
      await writeFile(
        join(hsrRunDir(record.name), "remote-events-cursor.json"),
        `${JSON.stringify({
          version: 1,
          node: record.node,
          remoteLaunchId: record.remoteLaunchId,
          remoteIncarnation: record.remoteIncarnation,
          lastSeq: invalid.cursor,
        })}\n`,
        { mode: 0o600 },
      );

      const lifecycle: FakeSubstrateLifecycle = { observeCalls: 0, offCalls: 0, closeCalls: 0 };
      const mirror = createRemoteEventMirror({
        loadNode: async () => makeNode(),
        createSubstrate: () => fakeRemoteSubstrate(makeNode(), new Set([record.name]), lifecycle),
      });
      await mirror([record]);
      assert.equal((await loadSession(record.name))?.status, "kill_failed", `${invalid.name} is fenced`);
      assert.equal(lifecycle.observeCalls, 0, `${invalid.name} is rejected before remote admission`);
      await mirror.close();
    }
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
      const spawned = await driver.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        sessionId: "pinned-remote-backfill",
        spec: { command: process.execPath, args: [], env: {} },
      });
      record.remoteLaunchId = spawned.launchId;
      record.remoteIncarnation = spawned.incarnation;
      await saveSession(record);
      const authority = { remoteLaunchId: spawned.launchId, remoteIncarnation: spawned.incarnation };
      await waitFor(async () => await driver.hasSession(bee), "remote bee live");

      // Steer a turn BEFORE the mirror ever ticks: these events exist only on
      // the remote — exactly the spawn→first-tick gap the backfill recovers.
      await driver.sendText(bee, "before mirror", undefined, authority);
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
      await driver.sendText(bee, "after mirror", undefined, authority);
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

      // A daemon shutdown releases only the live relay. Its stable durable
      // consumer must keep pinning source history emitted while the controller
      // is offline; otherwise ordinary source compaction can checkpoint past
      // the local mirror cursor and make the next daemon start fence a healthy
      // generation with an unrecoverable gap.
      await mirror.close();
      for (const prompt of ["offline-one", "offline-two", "offline-three"]) {
        await driver.sendText(bee, prompt, undefined, authority);
      }
      const runDirModule = childSourceModule("hsr/runDir");
      await execFileAsync(process.execPath, childModuleArgs(
        `const m=await import(${JSON.stringify(runDirModule)});await m.compactHsrEvents(${JSON.stringify(bee)},{keepLines:1,targetBytes:64});`,
      ), {
        cwd: process.cwd(),
        env: { ...process.env, HIVE_STORE_ROOT: remoteStore },
      });

      const restartedMirror = createRemoteEventMirror({
        loadNode: async (name) => (name === "loopunit" ? node : null),
        createSubstrate: (n) => {
          const sub = createRemoteHsrSubstrate(n, { transport });
          mirrorSubs.push(sub);
          return sub;
        },
      });
      await restartedMirror([record]);
      await waitFor(async () => {
        const raw = await readFile(hsrEventsPath(bee), "utf8").catch(() => "");
        return raw.includes("echo:offline-three");
      }, "restarted dispatcher exactly replays the compacted offline suffix");
      const afterRestart = await readFile(hsrEventsPath(bee), "utf8");
      for (const prompt of ["offline-one", "offline-two", "offline-three"]) {
        assert.equal(
          afterRestart.split("\n").filter((line) => line.includes(`echo:${prompt}`)).length,
          1,
          `${prompt} is projected exactly once after dispatcher restart`,
        );
      }
      assert.equal((await loadSession(bee))?.status, "running");
      await restartedMirror.close();
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
        sub.observe = async (bee, cb, locator, options) => {
          observeCalls += 1;
          return origObserve(bee, cb, locator, options);
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
        home: join(remoteStore, "stub-home"),
        sessionId: "pinned-remote",
        creds: {
          files: [{
            homeRelPath: "credential.json",
            contentB64: Buffer.from("epoch-a-credential").toString("base64"),
            mode: 0o600,
          }],
        },
        spec: { command: process.execPath, args: [], env: {} },
      });
      assert.equal(res.bee, bee);
      record.remoteLaunchId = res.launchId;
      record.remoteIncarnation = res.incarnation;
      await saveSession(record);
      const authority = { remoteLaunchId: res.launchId, remoteIncarnation: res.incarnation };
      await waitFor(async () => await driver.hasSession(bee), "remote bee live");

      // Tick 1: the mirror subscribes and seeds a local `running` mirror meta.
      await mirror([record]);
      const meta1 = await readHsrMeta(bee);
      assert.ok(meta1, "local mirror meta written");
      assert.equal(meta1!.mirrorOfNode, "loopunit", "meta marked mirrorOfNode");
      assert.equal(meta1!.status, "running");
      assert.equal(meta1!.hostPid, 0, "mirror meta has no local host pid");

      // Steer a turn that also reports usage; events relay into the LOCAL run dir.
      await driver.sendText(bee, "usage please", undefined, authority);
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

      // Same launch/incarnation, NEW host epoch: leave A's question unresolved,
      // refresh the provider host, and require the live relay to hand the local
      // mirror B's durable host_epoch before refresh returns. The mirror must
      // stop projecting A even while B has emitted no ordinary event yet.
      await driver.sendText(bee, "ask epoch-a", undefined, authority);
      await waitFor(
        async () => (await driver.pendingInputRemote(bee, authority)).pending !== null,
        "epoch A publishes an unresolved request",
      );
      const epochA = await driver.pendingInputRemote(bee, authority);
      assert.ok(epochA.pending);
      await waitFor(
        async () => (await hsrObservations({ includeEvents: true })).get(bee)?.eventSnapshot?.pendingNeedsInput?.requestId
          === epochA.pending?.requestId,
        "local mirror projects epoch A's request",
      );

      const refreshed = await driver.refreshCredsRemote({
        bee,
        ...authority,
        creds: {
          files: [{
            homeRelPath: "credential.json",
            contentB64: Buffer.from("epoch-b-credential").toString("base64"),
            mode: 0o600,
          }],
        },
      });
      assert.equal(refreshed.ok, true, refreshed.error);
      const epochBEmpty = await driver.pendingInputRemote(bee, authority);
      assert.notDeepEqual(epochBEmpty.host, epochA.host, "refresh rotates the exact host epoch");
      assert.equal(epochBEmpty.pending, null, "A's unresolved request is not rebound to silent B");
      await waitFor(async () => {
        const observation = (await hsrObservations({ includeEvents: true })).get(bee);
        const raw = await readFile(hsrEventsPath(bee), "utf8").catch(() => "");
        const markers = raw.split("\n").filter((line) => line.includes('"type":"host_epoch"')).length;
        return markers >= 2 && observation?.eventSnapshot?.pendingNeedsInput === null;
      }, "local mirror receives B's host boundary and clears A before a B event");

      await driver.sendText(bee, "ask epoch-b", undefined, authority);
      await waitFor(
        async () => (await driver.pendingInputRemote(bee, authority)).pending !== null,
        "epoch B publishes its own request",
      );
      const epochB = await driver.pendingInputRemote(bee, authority);
      assert.ok(epochB.pending);
      assert.equal(epochB.pending.requestId, epochA.pending.requestId, "stub reused its request counter after refresh");
      await waitFor(async () => {
        const snapshot = (await hsrObservations({ includeEvents: true })).get(bee)?.eventSnapshot;
        const latestNeeds = [...(snapshot?.events ?? [])].reverse().find((event) => event.type === "needs_input");
        return snapshot?.pendingNeedsInput?.requestId === epochB.pending!.requestId
          && JSON.stringify(latestNeeds?.host) === JSON.stringify(epochB.host);
      }, "first B event is relayed/backfilled under B's host epoch");

      // Teardown: the bee leaves the remote list (kill) → mirror tears down and
      // flips the local meta to "exited".
      await driver.kill(bee, authority);
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
