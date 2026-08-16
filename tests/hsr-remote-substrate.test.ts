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
import {
  canonicalHsrAnswerDigest,
  markHsrAnswerOperationAmbiguous,
  offerHsrAnswerOperation,
  type HsrAnswerHostIdentity,
  type HsrAnswerOperation,
} from "../src/answerReceipt.js";
import { buildController, serve, versionCore } from "../src/hsr/remoteHost.js";
import { connectRpcClient, startRpcServer } from "../src/hsr/rpc.js";
import { ensureHsrRunDir, hsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import {
  createRemoteHsrSubstrate,
  RemoteObservationIntegrityError,
} from "../src/substrates/remote-hsr.js";
import {
  clearSubstrateCache,
  remoteHsrSubstrateForNode,
  substrateFor,
} from "../src/substrates/index.js";
import { loadNode, registerNode } from "../src/node.js";
import type { NodeRecord } from "../src/node.js";
import type { SessionRecord } from "../src/store.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import type { TunnelChild, TunnelSpawnHook, SshExecHook } from "../src/hsr/remoteTransport.js";
import type { RemoteRunnerClient } from "../src/hsr/remoteTransport.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function answerOperation(
  requestId: string,
  answer: string | string[][],
  runtimeGeneration = 1,
  locator?: { remoteLaunchId: string; remoteIncarnation: string },
  nodeName = "loopunit",
  host: HsrAnswerHostIdentity = {
    hostPid: process.pid,
    startedAt: "2026-08-15T00:00:00.000Z",
    hostFingerprint: { pgid: process.pid, startedAt: "test-process-birth" },
  },
): HsrAnswerOperation {
  return {
    source: {
      createdAt: "2026-08-15T00:00:00.000Z",
      runtimeGeneration,
      id: `remote-test-generation-${runtimeGeneration}`,
      uuid: `remote-test-uuid-${runtimeGeneration}`,
      ...(locator
        ? {
            node: nodeName,
            remoteLaunchId: locator.remoteLaunchId,
            remoteIncarnation: locator.remoteIncarnation,
          }
        : {}),
    },
    requestId,
    answerDigest: canonicalHsrAnswerDigest(answer),
    host,
  };
}

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
      const authority = { remoteLaunchId: res.launchId, remoteIncarnation: res.incarnation };
      let releaseExit!: () => void;
      const exitBlocked = new Promise<void>((resolve) => { releaseExit = resolve; });
      let resolveExitProjected!: () => void;
      const exitProjected = new Promise<void>((resolve) => { resolveExitProjected = resolve; });
      const off = await sub.observe(bee, async (e) => {
        const event = e as { type?: string };
        events.push(event);
        if (event.type === "exit") {
          await exitBlocked;
          resolveExitProjected();
        }
      }, authority);

      // steer: sendText delivers a turn; capture shows the stub echo.
      await sub.sendText(bee, "hello", undefined, authority);
      await waitFor(async () => (await sub.capture(bee)).includes("echo:hello"), "capture shows echo:hello");
      const tail = await sub.capture(bee, 5);
      assert.match(tail, /echo:hello/);

      // event relay delivered the turn's structured events (text/turn_end).
      await waitFor(() => events.some((e) => e.type === "text" || e.type === "turn_end"), "observe relayed turn events");
      // sendText to an unknown bee surfaces a clear error.
      await assert.rejects(() => sub.sendText("no-such-bee", "hi"), /remote HSR send/);

      // Exact stop can overtake a blocked terminal projection. The first kill
      // therefore reports the incarnation stopped but retains remote history;
      // releasing/synchronizing the mirror acks the exit, and retry reclaims it.
      const pendingKill = await sub.kill(bee, authority);
      assert.equal(pendingKill.ok, false);
      assert.equal(pendingKill.incarnationStopped, true);
      releaseExit();
      await exitProjected;
      // A live progress ack is not terminal activation authority. Exercise the
      // same exact terminal replay + post-synchronization final ack used by the
      // mirror before expecting source-history reclamation.
      await sub.replayTerminalEvents(bee, () => undefined, authority, 0);
      await waitFor(async () => (await sub.kill(bee, authority)).ok, "terminal projection ack permits kill cleanup retry");
      off();
      await waitFor(async () => (await sub.hasSession(bee)) === false, "hasSession false after kill");
      assert.equal((await sub.listSessionStates()).has(bee), false, "listSessionStates drops the killed bee");
    } finally {
      await sub.close();
      await server.close();
      tunnel.killAll();
    }
  });
});

test("remote delivery replays one durable id after an outer reply loss and authority restart without a second provider call", async () => {
  await withTempStore(async () => {
    const controllers: ReturnType<typeof buildController>[] = [buildController()];
    let current = controllers[0]!;
    let sendRpcCalls = 0;
    let lostFirstSendReply = false;
    const client: RemoteRunnerClient = {
      node: "loopunit",
      localSocket: undefined,
      connected: () => true,
      async call(method, params) {
        const handler = current.methods[method];
        if (!handler) throw new Error(`missing direct runner-host method ${method}`);
        const controllerAtDispatch = current;
        const result = await handler(params, { connectionId: 1, close() {} });
        if (method === "send") {
          sendRpcCalls += 1;
          if (!lostFirstSendReply) {
            lostFirstSendReply = true;
            const restarted = buildController();
            controllers.push(restarted);
            current = restarted;
            assert.notEqual(current, controllerAtDispatch, "the retry reaches a fresh authority controller");
            throw new Error("injected outer RPC reply loss after remote provider acceptance");
          }
        }
        return result;
      },
      on: () => () => {},
      droppedCount: () => 0,
      async close() {},
    };
    const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
    const bee = "remote-delivery-receipt";
    let authority: { remoteLaunchId: string; remoteIncarnation: string } | undefined;
    try {
      const spawned = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        spec: { command: process.execPath, args: [], env: {} },
      });
      authority = {
        remoteLaunchId: spawned.launchId,
        remoteIncarnation: spawned.incarnation,
      };
      const deliveryId = "caller-stable-delivery-id";
      await sub.sendText(bee, "lost-reply", undefined, { ...authority, deliveryId });
      await waitFor(async () => (await sub.capture(bee)).includes("echo:lost-reply"), "lost-reply turn completes");

      // A later replay (including after the controller restart above) is a
      // durable receipt lookup. It must not invoke the provider again.
      await sub.sendText(bee, "lost-reply", undefined, { ...authority, deliveryId });
      await sleep(100);
      const output = await sub.capture(bee);
      assert.equal(output.match(/echo:lost-reply/g)?.length ?? 0, 1);
      assert.equal(sendRpcCalls, 3, "one lost outer call, one reconciliation call, and one settled lookup");

      await assert.rejects(
        sub.sendText(bee, "different-content", undefined, { ...authority, deliveryId }),
        (error: unknown) => (error as { code?: unknown; deliveryId?: unknown }).code === "HIVE_HSR_DELIVERY_ID_CONFLICT"
          && (error as { deliveryId?: unknown }).deliveryId === deliveryId,
      );

      const completionId = "completion-required-delivery-id";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          sub.sendText(bee, "hang until intentional stop", undefined, {
            ...authority,
            deliveryId: completionId,
            completionRequired: true,
          }),
          (error: unknown) => (error as { code?: unknown; deliveryId?: unknown }).code === "HIVE_HSR_DELIVERY_IN_FLIGHT"
            && (error as { deliveryId?: unknown }).deliveryId === completionId,
        );
      }
      await waitFor(
        async () => (await sub.capture(bee)).includes("hanging:hang until intentional stop"),
        "completion-required turn reaches provider",
      );
      assert.equal(
        (await sub.capture(bee)).match(/hanging:hang until intentional stop/g)?.length ?? 0,
        1,
        "completion-required same-id retry does not invoke the provider twice",
      );
    } finally {
      if (authority) await sub.kill(bee, authority).catch(() => undefined);
      await sub.close();
      for (const controller of controllers.reverse()) await controller.close().catch(() => undefined);
    }
  });
});

test("remote answer replays one generation-bound operation after reply loss and authority restart without a second provider call", async () => {
  await withTempStore(async () => {
    const controllers: ReturnType<typeof buildController>[] = [buildController()];
    let current = controllers[0]!;
    let answerRpcCalls = 0;
    let lostFirstAnswerReply = false;
    const client: RemoteRunnerClient = {
      node: "loopunit",
      localSocket: undefined,
      connected: () => true,
      async call(method, params) {
        const handler = current.methods[method];
        if (!handler) throw new Error(`missing direct runner-host method ${method}`);
        const controllerAtDispatch = current;
        const result = await handler(params, { connectionId: 1, close() {} });
        if (method === "answer") {
          answerRpcCalls += 1;
          if (!lostFirstAnswerReply) {
            lostFirstAnswerReply = true;
            const restarted = buildController();
            controllers.push(restarted);
            current = restarted;
            assert.notEqual(current, controllerAtDispatch, "the answer reconciliation reaches a fresh authority controller");
            throw new Error("injected outer answer RPC reply loss after provider acceptance");
          }
        }
        return result;
      },
      on: () => () => {},
      droppedCount: () => 0,
      async close() {},
    };
    const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
    const bee = "remote-answer-receipt";
    let authority: { remoteLaunchId: string; remoteIncarnation: string } | undefined;
    try {
      const spawned = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        spec: { command: process.execPath, args: [], env: {} },
      });
      authority = {
        remoteLaunchId: spawned.launchId,
        remoteIncarnation: spawned.incarnation,
      };
      await sub.sendText(bee, "ask me", undefined, authority);
      await waitFor(
        async () => (await sub.pendingInputRemote(bee, authority!)).pending !== null,
        "stub publishes the needs-input request",
      );
      const { pending, host } = await sub.pendingInputRemote(bee, authority);
      assert.ok(pending);
      const operation = answerOperation(pending.requestId, "one-answer", 1, authority, "loopunit", host);
      await offerHsrAnswerOperation(bee, operation);

      const reconciled = await sub.answerRemote(bee, operation, "one-answer", authority);
      assert.equal(reconciled.status, "settled");
      await waitFor(async () => (await sub.capture(bee)).includes("answered:one-answer"), "answer reaches stub once");

      const replayed = await sub.answerRemote(bee, operation, "one-answer", authority);
      assert.equal(replayed.status, "settled");
      await sleep(100);
      const output = await sub.capture(bee);
      assert.equal(output.match(/answered:one-answer/g)?.length ?? 0, 1, "same operation never answers the provider twice");
      assert.equal(answerRpcCalls, 3, "one lost reply, one reconciliation, and one settled lookup");

      await assert.rejects(
        offerHsrAnswerOperation(
          bee,
          answerOperation(pending.requestId, "different-answer", 1, authority, "loopunit", host),
        ),
        /different answer digest/,
      );
      assert.equal((await sub.capture(bee)).match(/answered:/g)?.length ?? 0, 1);
    } finally {
      if (authority) await sub.kill(bee, authority).catch(() => undefined);
      await sub.close();
      for (const controller of controllers.reverse()) await controller.close().catch(() => undefined);
    }
  });
});

test("remote answer host epoch prevents a pre-refresh receipt from answering a reused request id", async () => {
  await withTempStore(async (dir) => {
    const controller = buildController();
    const client: RemoteRunnerClient = {
      node: "loopunit",
      localSocket: undefined,
      connected: () => true,
      async call(method, params) {
        const handler = controller.methods[method];
        if (!handler) throw new Error(`missing direct runner-host method ${method}`);
        return handler(params, { connectionId: 1, close() {} });
      },
      on: () => () => {},
      droppedCount: () => 0,
      async close() {},
    };
    const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
    const bee = "remote-answer-refresh-epoch";
    const home = join(dir, "refresh-answer-home");
    let authority: { remoteLaunchId: string; remoteIncarnation: string } | undefined;
    try {
      const spawned = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        home,
        sessionId: "answer-refresh-thread",
        creds: {
          files: [{
            homeRelPath: "old.json",
            contentB64: Buffer.from("old-credential").toString("base64"),
            mode: 0o600,
          }],
        },
        spec: { command: process.execPath, args: [], env: {} },
      });
      authority = { remoteLaunchId: spawned.launchId, remoteIncarnation: spawned.incarnation };

      await sub.sendText(bee, "ask before refresh", undefined, authority);
      await waitFor(
        async () => (await sub.pendingInputRemote(bee, authority!)).pending !== null,
        "pre-refresh host publishes its request",
      );
      const before = await sub.pendingInputRemote(bee, authority);
      assert.ok(before.pending);
      const oldOperation = answerOperation(
        before.pending.requestId,
        "same-answer",
        1,
        authority,
        "loopunit",
        before.host,
      );
      await offerHsrAnswerOperation(bee, oldOperation);
      assert.equal((await sub.answerRemote(bee, oldOperation, "same-answer", authority)).status, "settled");
      await waitFor(
        async () => (await sub.capture(bee)).includes("answered:same-answer"),
        "pre-refresh answer reaches the provider",
      );

      const refreshed = await sub.refreshCredsRemote({
        bee,
        ...authority,
        creds: {
          files: [{
            homeRelPath: "new.json",
            contentB64: Buffer.from("new-credential").toString("base64"),
            mode: 0o600,
          }],
        },
      });
      assert.equal(refreshed.ok, true, refreshed.error);
      const afterRestart = await sub.pendingInputRemote(bee, authority);
      assert.notDeepEqual(afterRestart.host, before.host, "refresh publishes a new immutable host epoch");

      await sub.sendText(bee, "ask after refresh", undefined, authority);
      await waitFor(
        async () => (await sub.pendingInputRemote(bee, authority!)).pending !== null,
        "post-refresh host publishes its request",
      );
      const after = await sub.pendingInputRemote(bee, authority);
      assert.ok(after.pending);
      assert.equal(after.pending.requestId, before.pending.requestId, "the restarted provider reuses its request counter");

      await assert.rejects(
        sub.answerRemote(bee, oldOperation, "same-answer", authority),
        /does not own the current launch\/host epoch/,
      );
      assert.equal(
        (await sub.pendingInputRemote(bee, authority)).pending?.requestId,
        after.pending.requestId,
        "the stale pre-refresh operation leaves the new request pending",
      );
      const answersBeforeCurrent = (await sub.capture(bee)).match(/answered:same-answer/g)?.length ?? 0;

      const currentOperation = answerOperation(
        after.pending.requestId,
        "same-answer",
        1,
        authority,
        "loopunit",
        after.host,
      );
      await offerHsrAnswerOperation(bee, currentOperation);
      assert.equal((await sub.answerRemote(bee, currentOperation, "same-answer", authority)).status, "settled");
      await waitFor(
        async () => ((await sub.capture(bee)).match(/answered:same-answer/g)?.length ?? 0) === answersBeforeCurrent + 1,
        "the post-refresh operation dispatches exactly once",
      );
      assert.equal((await sub.answerRemote(bee, currentOperation, "same-answer", authority)).status, "settled");
      await sleep(100);
      assert.equal(
        (await sub.capture(bee)).match(/answered:same-answer/g)?.length ?? 0,
        answersBeforeCurrent + 1,
        "the current host-bound receipt also replays without a second provider call",
      );
    } finally {
      if (authority) await sub.kill(bee, authority).catch(() => undefined);
      await sub.close();
      await controller.close().catch(() => undefined);
    }
  });
});

test("remote answer ambiguity fences new work until exact operator reconciliation reaches the authority", async () => {
  await withTempStore(async () => {
    const controller = buildController();
    let reconcileRpcCalls = 0;
    const client: RemoteRunnerClient = {
      node: "loopunit",
      localSocket: undefined,
      connected: () => true,
      async call(method, params) {
        const handler = controller.methods[method];
        if (!handler) throw new Error(`missing direct runner-host method ${method}`);
        const result = await handler(params, { connectionId: 1, close() {} });
        if (method === "answerReconcile") {
          reconcileRpcCalls += 1;
          if (reconcileRpcCalls === 1) throw new Error("injected lost manual-reconciliation reply");
        }
        return result;
      },
      on: () => () => {},
      droppedCount: () => 0,
      async close() {},
    };
    const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
    const bee = "remote-answer-manual";
    let authority: { remoteLaunchId: string; remoteIncarnation: string } | undefined;
    try {
      const spawned = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        spec: { command: process.execPath, args: [], env: {} },
      });
      authority = { remoteLaunchId: spawned.launchId, remoteIncarnation: spawned.incarnation };
      const { host } = await sub.pendingInputRemote(bee, authority);
      const operation = answerOperation("manual-answer-request", "manual-answer", 1, authority, "loopunit", host);
      await offerHsrAnswerOperation(bee, operation);
      await markHsrAnswerOperationAmbiguous(bee, operation, "injected lost provider answer outcome");

      await assert.rejects(
        sub.sendText(bee, "must stay fenced", undefined, authority),
        /unresolved provider-answer ownership/,
      );
      assert.doesNotMatch(await sub.capture(bee), /must stay fenced/);

      const reconciled = await sub.reconcileAnswerRemote(bee, operation, "discard", authority);
      assert.deepEqual(reconciled, { status: "discarded" });
      assert.equal(reconcileRpcCalls, 2, "lost manual-settlement reply replays the exact idempotent verdict");
      await sub.sendText(bee, "after manual reconcile", undefined, authority);
      await waitFor(
        async () => (await sub.capture(bee)).includes("echo:after manual reconcile"),
        "manual reconciliation reopens remote work admission",
      );

      const stoppedOperation = answerOperation(
        "stopped-answer-request",
        "stopped-answer",
        1,
        authority,
        "loopunit",
        host,
      );
      await offerHsrAnswerOperation(bee, stoppedOperation);
      await markHsrAnswerOperationAmbiguous(bee, stoppedOperation, "injected ambiguity before exact stop");
      const predecessorLaunchId = authority.remoteLaunchId;
      const pendingKill = await sub.kill(bee, authority);
      assert.equal(pendingKill.ok, false);
      assert.equal(pendingKill.incarnationStopped, true);
      await sub.replayTerminalEvents(bee, () => undefined, authority, 0);
      assert.equal((await sub.kill(bee, authority)).ok, true);
      assert.deepEqual(
        await sub.reconcileAnswerRemote(bee, stoppedOperation, "discard", authority),
        { status: "discarded" },
        "the exact stopped launch remains authorized for receipt-only reconciliation",
      );
      const replacement = await sub.spawnRemote({
        bee,
        previousLaunchId: predecessorLaunchId,
        kind: "stub",
        cwd: process.cwd(),
        spec: { command: process.execPath, args: [], env: {} },
      });
      authority = { remoteLaunchId: replacement.launchId, remoteIncarnation: replacement.incarnation };
    } finally {
      if (authority) await sub.kill(bee, authority).catch(() => undefined);
      await sub.close();
      await controller.close().catch(() => undefined);
    }
  });
});

test("same-name successor events never leak into a stale controller observer", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const tunnel = makeRelayTunnel();
    const transport = {
      execHook: serveUpExecHook,
      spawnTunnel: tunnel.hook,
      remoteSocket: remoteSock,
      forward: { waitAttempts: 100, waitIntervalMs: 10 },
    };
    // Distinct node names give these logical controllers independent transport
    // sockets while both point at the same remote authority.
    const stale = createRemoteHsrSubstrate(makeNode({ name: "controller-a" }), { transport });
    const current = createRemoteHsrSubstrate(makeNode({ name: "controller-b" }), { transport });
    const bee = "observer-generation";
    let offStale: (() => void) | undefined;
    let offCurrent: (() => void) | undefined;

    try {
      const first = await stale.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        spec: { command: process.execPath, args: [], env: {} },
      });
      const staleEvents: Array<{ type?: string; text?: string }> = [];
      offStale = await stale.observe(
        bee,
        (event) => { staleEvents.push(event as { type?: string; text?: string }); },
        { remoteLaunchId: first.launchId, remoteIncarnation: first.incarnation },
      );
      const firstLocator = {
        remoteLaunchId: first.launchId,
        remoteIncarnation: first.incarnation,
      };
      let firstKill = await stale.kill(bee, firstLocator);
      if (!firstKill.ok) {
        assert.equal(firstKill.incarnationStopped, true);
        await stale.replayTerminalEvents(bee, () => undefined, firstLocator, 0);
        firstKill = await stale.kill(bee, firstLocator);
      }
      assert.equal(firstKill.ok, true);

      const second = await current.spawnRemote({
        bee,
        previousLaunchId: first.launchId,
        kind: "stub",
        cwd: process.cwd(),
        spec: { command: process.execPath, args: [], env: {} },
      });
      const currentEvents: Array<{ type?: string; text?: string }> = [];
      const secondAuthority = {
        remoteLaunchId: second.launchId,
        remoteIncarnation: second.incarnation,
      };
      offCurrent = await current.observe(
        bee,
        (event) => { currentEvents.push(event as { type?: string; text?: string }); },
        secondAuthority,
      );
      await current.sendText(bee, "generation-b", undefined, secondAuthority);
      await waitFor(
        () => currentEvents.some((event) => event.text?.includes("generation-b")),
        "successor observer receives its generation event",
      );
      await waitFor(
        () => currentEvents.some((event) => event.type === "turn_end"),
        "successor finishes its first turn",
      );
      await sleep(100);
      assert.equal(
        staleEvents.some((event) => event.text?.includes("generation-b")),
        false,
        "stale controller discards globally-broadcast successor events",
      );

      // Answer authority is generation-bound too. An old controller must not
      // answer a successor's prompt even though the bee name is identical.
      await current.sendText(bee, "ask me", undefined, secondAuthority);
      await waitFor(
        () => currentEvents.some((event) => event.type === "needs_input"),
        "successor reaches needs-input",
      );
      const { pending, host } = await current.pendingInputRemote(bee, secondAuthority);
      assert.ok(pending);
      const operation = answerOperation(
        pending.requestId,
        "current-answer",
        2,
        secondAuthority,
        "controller-b",
        host,
      );
      await offerHsrAnswerOperation(bee, operation);
      await assert.rejects(
        stale.answerRemote(
          bee,
          operation,
          "current-answer",
          { remoteLaunchId: first.launchId, remoteIncarnation: first.incarnation },
        ),
        /launch id does not own|answer.*failed|does not match controller-a/,
      );
      assert.equal(
        (await current.pendingInputRemote(bee, secondAuthority)).pending?.requestId,
        pending.requestId,
        "stale answer leaves the successor request pending",
      );
      assert.equal((await current.answerRemote(bee, operation, "current-answer", secondAuthority)).status, "settled");
      await waitFor(
        async () => (await current.pendingInputRemote(bee, secondAuthority)).pending === null,
        "current generation answer resolves its request",
      );

      let secondKill = await current.kill(bee, secondAuthority);
      if (!secondKill.ok) {
        assert.equal(secondKill.incarnationStopped, true);
        await current.replayTerminalEvents(bee, () => undefined, secondAuthority, 0);
        secondKill = await current.kill(bee, secondAuthority);
      }
      assert.equal(secondKill.ok, true);
    } finally {
      offCurrent?.();
      offStale?.();
      await current.close();
      await stale.close();
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

    const controllers: ReturnType<typeof buildController>[] = [];
    const startCrashableServe = async () => {
      const controller = buildController();
      const transport = await startRpcServer({ socketPath: remoteSock, methods: controller.methods });
      controller.attachServer(transport);
      controllers.push(controller);
      return { controller, transport };
    };
    let server = await startCrashableServe();
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
      const off = await sub.observe(bee, (e) => { events.push(e as { type?: string; text?: string }); });

      // Sanity: the relay works before the restart.
      await waitFor(() => {
        beeHost.broadcast("event", { type: "text", text: "before-restart" });
        return events.some((e) => e.text === "before-restart");
      }, "event relayed before restart");

      // RESTART the serve: the new process has an EMPTY relays map, so only a
      // re-issued observe RPC (not just the transport's local re-bridge) can
      // bring the event stream back. The bee host itself keeps running.
      // Simulate a process crash by dropping only the RPC transport. Graceful
      // runner-host close now intentionally stops every durable generation.
      await server.controller.methods.unobserve!({ bee }, { connectionId: 0, close() {} });
      await server.transport.close();
      server = await startCrashableServe();

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
      await server.transport.close();
      await rm(hsrRunDir(bee), { recursive: true, force: true });
      for (const controller of controllers) await controller.close();
      await beeHost.close();
      tunnel.killAll();
    }
  });
});

test("exact observe replays same-ms initial and outage events once, serialized with a paused live projection", async () => {
  const bee = "seq-observe-reconnect";
  const locator = {
    remoteLaunchId: "00000000-0000-4000-8000-000000000601",
    remoteIncarnation: "00000000-0000-4000-8000-000000000602",
  };
  const host = {
    hostPid: 601,
    startedAt: "2026-08-15T00:00:00.000Z",
    hostFingerprint: { pgid: 601, startedAt: "seq-observe-host" },
  };
  const durable: RunnerEvent[] = [
    { type: "host_epoch", ts: 100, seq: 1, host },
    { type: "turn_start", ts: 100, seq: 2, host },
    { type: "needs_input", ts: 100, seq: 3, kind: "question", question: "same ms?", requestId: "r1", host },
  ];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const acknowledgements: number[] = [];
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method, params) {
      if (method === "observe" || method === "unobserve") return { ok: true };
      if (method === "events") {
        const afterSeq = Number((params as { afterSeq?: unknown }).afterSeq ?? 0);
        return { ok: true, events: durable.filter((event) => Number(event.seq) > afterSeq) };
      }
      if (method === "ackEvents") {
        acknowledgements.push(Number((params as { upToSeq?: unknown }).upToSeq));
        return { ok: true, ackedSeq: acknowledgements.at(-1) };
      }
      return { ok: true };
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => set.delete(handler);
    },
    droppedCount: () => 0,
    async close() {},
  };
  const emit = (method: string, params: unknown): void => {
    for (const handler of handlers.get(method) ?? []) handler(params);
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
  const projected: RunnerEvent[] = [];
  let releaseFive!: () => void;
  let enteredFive!: () => void;
  const fiveEntered = new Promise<void>((resolve) => { enteredFive = resolve; });
  const fiveGate = new Promise<void>((resolve) => { releaseFive = resolve; });
  const off = await sub.observe(bee, async (event) => {
    const typed = event as RunnerEvent;
    if (typed.seq === 5) {
      enteredFive();
      await fiveGate;
    }
    projected.push(typed);
  }, locator);

  assert.deepEqual(projected.map((event) => event.seq), [1, 2, 3], "same-ms events are seq-replayed without timestamp loss");
  assert.equal(acknowledgements.at(-1), 3, "initial ack follows durable consumer completion");

  // Event 4 is emitted while the tunnel is down: no live notification reaches
  // the client. Reconnect must exact-replay it from cursor 3.
  durable.push({ type: "auth_expired", ts: 101, seq: 4, detail: "missed while down", host });
  emit("reconnect", {});
  await waitFor(() => projected.some((event) => event.seq === 4), "missed outage event is replayed");

  // Pause durable projection of seq 5, enqueue live seq 6, and reconnect while
  // the callback is still blocked. Notification and reconnect replay share one
  // operation chain, so neither 5 nor 6 can be projected twice.
  const five = { type: "exhausted", ts: 102, seq: 5, resetHint: "pause", host } satisfies RunnerEvent;
  durable.push(five);
  emit("hsr.event", { bee, event: five, launchId: locator.remoteLaunchId, incarnation: locator.remoteIncarnation });
  await fiveEntered;
  const six = { type: "needs_input", ts: 103, seq: 6, kind: "question", question: "after pause?", requestId: "r2", host } satisfies RunnerEvent;
  durable.push(six);
  emit("hsr.event", { bee, event: six, launchId: locator.remoteLaunchId, incarnation: locator.remoteIncarnation });
  emit("reconnect", {});
  releaseFive();
  await waitFor(() => projected.some((event) => event.seq === 6), "queued live/reconnect suffix drains");
  assert.deepEqual(projected.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(acknowledgements.at(-1), 6);

  await off();
  await sub.close();
});

test("reconnect drains a long durable outage suffix through bounded acked pages", async () => {
  const bee = "bounded-reconnect-pages";
  const locator = {
    remoteLaunchId: "00000000-0000-4000-8000-000000000607",
    remoteIncarnation: "00000000-0000-4000-8000-000000000608",
  };
  const durable: RunnerEvent[] = Array.from({ length: 5 }, (_, index) => ({
    type: "text" as const,
    ts: index + 1,
    seq: index + 1,
    text: `initial-${index + 1}`,
  }));
  const pageLimit = 37;
  const pageSizes: number[] = [];
  const acknowledgements: number[] = [];
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method, params) {
      if (method === "observe" || method === "unobserve") return { ok: true };
      if (method === "events") {
        const request = params as { afterSeq?: unknown; pageToken?: unknown };
        const afterSeq = Number(request.afterSeq ?? 0);
        if (afterSeq === 5 && request.pageToken === undefined && durable.length > 5) {
          pageSizes.push(0);
          return { ok: true, events: [], throughSeq: 5, hasMore: true, pageToken: "scanned-prefix-at-5" };
        }
        if (request.pageToken !== undefined) {
          assert.ok(
            request.pageToken === "scanned-prefix-at-5"
              || request.pageToken === `continue-after-${afterSeq}`,
          );
        }
        const events = durable.filter((event) => Number(event.seq) > afterSeq).slice(0, pageLimit);
        pageSizes.push(events.length);
        const throughSeq = events.length > 0 ? Number(events.at(-1)!.seq) : afterSeq;
        const hasMore = throughSeq < Number(durable.at(-1)?.seq ?? afterSeq);
        return {
          ok: true,
          events,
          throughSeq,
          hasMore,
          ...(hasMore ? { pageToken: `continue-after-${throughSeq}` } : {}),
        };
      }
      if (method === "ackEvents") {
        const upToSeq = Number((params as { upToSeq?: unknown }).upToSeq);
        acknowledgements.push(upToSeq);
        return { ok: true, ackedSeq: upToSeq };
      }
      return { ok: true };
    },
    on: () => () => undefined,
    droppedCount: () => 0,
    async close() {},
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
  const projected: number[] = [];
  const off = await sub.observe(bee, (event) => { projected.push(Number((event as RunnerEvent).seq)); }, locator);
  assert.deepEqual(projected, [1, 2, 3, 4, 5]);
  assert.deepEqual(acknowledgements, [5]);

  pageSizes.length = 0;
  acknowledgements.length = 0;
  for (let seq = 6; seq <= 522; seq++) {
    durable.push({ type: "text", ts: seq, seq, text: `outage-${seq}` });
  }
  await sub.syncObservation(bee, locator);
  assert.equal(projected.length, 522);
  assert.deepEqual(projected, Array.from({ length: 522 }, (_, index) => index + 1));
  assert.ok(pageSizes.length > 10, "the long suffix is never returned as one response");
  assert.ok(pageSizes.every((size) => size <= pageLimit));
  assert.equal(acknowledgements.at(-1), 522);
  assert.ok(
    acknowledgements.slice(0, -1).every((cursor, index, all) => index === 0 || cursor > all[index - 1]!),
    "each intermediate page advances source retention monotonically",
  );

  await off();
  await sub.close();
});

test("a late subscriber is rejected before attachment unless its cursor matches the shared durable projection", async () => {
  const bee = "late-subscriber-cursor";
  const locator = {
    remoteLaunchId: "00000000-0000-4000-8000-000000000611",
    remoteIncarnation: "00000000-0000-4000-8000-000000000612",
  };
  const durable: RunnerEvent[] = [{ type: "text", ts: 1, seq: 1, text: "one" }];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  let observeCalls = 0;
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method, params) {
      if (method === "observe") {
        observeCalls += 1;
        return { ok: true };
      }
      if (method === "unobserve") return { ok: true };
      if (method === "events") {
        const afterSeq = Number((params as { afterSeq?: unknown }).afterSeq ?? 0);
        return { ok: true, events: durable.filter((event) => Number(event.seq) > afterSeq) };
      }
      if (method === "ackEvents") return { ok: true, ackedSeq: (params as { upToSeq?: unknown }).upToSeq };
      return { ok: true };
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => set.delete(handler);
    },
    droppedCount: () => 0,
    async close() {},
  };
  const emit = (method: string, params: unknown): void => {
    for (const handler of handlers.get(method) ?? []) handler(params);
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
  const first: number[] = [];
  const second: number[] = [];
  const offFirst = await sub.observe(bee, (event) => { first.push(Number((event as RunnerEvent).seq)); }, locator, { afterSeq: 0 });
  assert.deepEqual(first, [1]);

  await assert.rejects(
    sub.observe(bee, (event) => { second.push(Number((event as RunnerEvent).seq)); }, locator, { afterSeq: 0 }),
    /late observer.*requested cursor 0, current durable cursor is 1/,
  );
  assert.equal(observeCalls, 1, "a mismatched late subscriber is rejected before remote refcount admission");

  const offSecond = await sub.observe(
    bee,
    (event) => { second.push(Number((event as RunnerEvent).seq)); },
    locator,
    { afterSeq: 1 },
  );
  assert.equal(observeCalls, 2);
  const two = { type: "text", ts: 2, seq: 2, text: "two" } satisfies RunnerEvent;
  durable.push(two);
  emit("hsr.event", { bee, event: two, launchId: locator.remoteLaunchId, incarnation: locator.remoteIncarnation });
  await waitFor(() => first.includes(2) && second.includes(2), "matching late subscriber shares the exact live suffix");
  assert.deepEqual(first, [1, 2]);
  assert.deepEqual(second, [2]);

  await offSecond();
  await offFirst();
  await sub.close();
});

test("a delayed predecessor unsubscribe cannot detach a same-name successor observation", async () => {
  const bee = "delayed-predecessor-off";
  const a = {
    remoteLaunchId: "00000000-0000-4000-8000-000000000613",
    remoteIncarnation: "00000000-0000-4000-8000-000000000614",
  };
  const b = {
    remoteLaunchId: "00000000-0000-4000-8000-000000000615",
    remoteIncarnation: "00000000-0000-4000-8000-000000000616",
  };
  const aDurable: RunnerEvent[] = [{ type: "text", ts: 1, seq: 1, text: "a-one" }];
  const bDurable: RunnerEvent[] = [{ type: "text", ts: 1, seq: 1, text: "b-one" }];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  let rejectAReplay = false;
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method, params) {
      if (method === "observe" || method === "unobserve") return { ok: true };
      if (method === "events") {
        const request = params as { afterSeq?: unknown; launchId?: unknown };
        if (request.launchId === a.remoteLaunchId && rejectAReplay) {
          return { ok: false, integrityFailure: true, error: "A history is no longer trustworthy" };
        }
        const events = request.launchId === a.remoteLaunchId ? aDurable : bDurable;
        const afterSeq = Number(request.afterSeq ?? 0);
        return { ok: true, events: events.filter((event) => Number(event.seq) > afterSeq) };
      }
      if (method === "ackEvents") return { ok: true, ackedSeq: (params as { upToSeq?: unknown }).upToSeq };
      return { ok: true };
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => set.delete(handler);
    },
    droppedCount: () => 0,
    async close() {},
  };
  const emit = (method: string, params: unknown): void => {
    for (const handler of handlers.get(method) ?? []) handler(params);
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
  const aEvents: RunnerEvent[] = [];
  const bEvents: RunnerEvent[] = [];
  const offA = await sub.observe(bee, (event) => { aEvents.push(event as RunnerEvent); }, a);

  rejectAReplay = true;
  emit("hsr.event", {
    bee,
    event: { type: "text", ts: 3, seq: 3, text: "jump" },
    launchId: a.remoteLaunchId,
    incarnation: a.remoteIncarnation,
  });
  await waitFor(
    () => aEvents.some((event) =>
      (event as RunnerEvent & { remoteObservationIntegrityFailure?: boolean }).remoteObservationIntegrityFailure === true),
    "predecessor observation detaches after exact replay integrity failure",
  );

  const offB = await sub.observe(bee, (event) => { bEvents.push(event as RunnerEvent); }, b);
  assert.deepEqual(bEvents.map((event) => event.seq), [1]);
  await offA();
  await sub.syncObservation(bee, b);

  const bTwo = { type: "text", ts: 2, seq: 2, text: "b-two" } satisfies RunnerEvent;
  bDurable.push(bTwo);
  emit("hsr.event", { bee, event: bTwo, launchId: b.remoteLaunchId, incarnation: b.remoteIncarnation });
  await waitFor(() => bEvents.some((event) => event.seq === 2), "successor remains attached after predecessor off");

  await offB();
  await sub.close();
});

test("terminal replay re-acks a durable cursor even when the remote suffix is empty", async () => {
  const acknowledgements: number[] = [];
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method, params) {
      if (method === "events") return { ok: true, events: [] };
      if (method === "ackEvents") {
        acknowledgements.push(Number((params as { upToSeq?: unknown }).upToSeq));
        return { ok: true, ackedSeq: acknowledgements.at(-1) };
      }
      return { ok: true };
    },
    on: () => () => undefined,
    droppedCount: () => 0,
    async close() {},
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
  let projected = 0;
  let synchronized = 0;
  await sub.replayTerminalEvents(
    "terminal-reack",
    async () => { projected += 1; },
    {
      remoteLaunchId: "00000000-0000-4000-8000-000000000621",
      remoteIncarnation: "00000000-0000-4000-8000-000000000622",
    },
    7,
    async () => { synchronized += 1; },
  );
  assert.equal(projected, 0);
  assert.equal(synchronized, 1);
  assert.deepEqual(acknowledgements, [7], "restart heals an ack lost after local cursor persistence");
  await sub.close();
});

test("terminal replay projects and acknowledges a long suffix page by page", async () => {
  const durable: RunnerEvent[] = Array.from({ length: 301 }, (_, index) => ({
    type: "text" as const,
    ts: index + 1,
    seq: index + 1,
    text: `terminal-${index + 1}`,
  }));
  const pageLimit = 41;
  const pageSizes: number[] = [];
  const acknowledgements: number[] = [];
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method, params) {
      if (method === "events") {
        const afterSeq = Number((params as { afterSeq?: unknown }).afterSeq ?? 0);
        const events = durable.filter((event) => Number(event.seq) > afterSeq).slice(0, pageLimit);
        pageSizes.push(events.length);
        const throughSeq = events.length ? Number(events.at(-1)!.seq) : afterSeq;
        const hasMore = throughSeq < durable.length;
        return {
          ok: true,
          events,
          throughSeq,
          hasMore,
          ...(hasMore ? { pageToken: `terminal-after-${throughSeq}` } : {}),
        };
      }
      if (method === "ackEvents") {
        const cursor = Number((params as { upToSeq?: unknown }).upToSeq);
        acknowledgements.push(cursor);
        return { ok: true, ackedSeq: cursor };
      }
      return { ok: true };
    },
    on: () => () => undefined,
    droppedCount: () => 0,
    async close() {},
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
  const projected: number[] = [];
  let activated = 0;
  await sub.replayTerminalEvents(
    "terminal-bounded-pages",
    (event) => { projected.push(Number(event.seq)); },
    {
      remoteLaunchId: "00000000-0000-4000-8000-000000000623",
      remoteIncarnation: "00000000-0000-4000-8000-000000000624",
    },
    0,
    () => { activated += 1; },
  );
  assert.deepEqual(projected, Array.from({ length: 301 }, (_, index) => index + 1));
  assert.ok(pageSizes.length > 5);
  assert.ok(pageSizes.every((size) => size <= pageLimit));
  assert.equal(acknowledgements.at(-1), 301);
  assert.equal(activated, 1);
  await sub.close();
});

test("direct remote list APIs never collapse a per-Bee unavailable row into absence", async () => {
  let unavailable: "busy" | "integrity" = "integrity";
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method) {
      if (method === "list") return [{
        bee: "unavailable-a",
        live: false,
        state: null,
        tier: "stream",
        sessionId: null,
        status: unavailable === "integrity" ? "event_integrity" : "unavailable",
        controlSocket: null,
        launchId: "00000000-0000-4000-8000-0000000006a1",
        incarnation: "00000000-0000-4000-8000-0000000006a2",
        unavailable,
        ...(unavailable === "integrity" ? { integrityFailure: true } : {}),
        error: unavailable === "integrity" ? "source storage corrupt" : "event writer owns authority",
      }, {
        bee: "healthy-b",
        live: true,
        state: "ready",
        tier: "stream",
        sessionId: null,
        status: "running",
        controlSocket: "/healthy.sock",
      }];
      return { ok: true };
    },
    on: () => () => undefined,
    droppedCount: () => 0,
    async close() {},
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
  const rows = await sub.listRemoteRows();
  assert.equal(rows.length, 2, "mirror callers retain per-Bee isolation metadata");
  await assert.rejects(
    sub.listSessions(),
    (error: unknown) => error instanceof RemoteObservationIntegrityError,
  );
  await assert.rejects(
    sub.listSessionStates(),
    (error: unknown) => error instanceof RemoteObservationIntegrityError,
  );

  unavailable = "busy";
  await assert.rejects(
    sub.listSessions(),
    (error: unknown) => error instanceof Error && !(error instanceof RemoteObservationIntegrityError),
  );
  await assert.rejects(
    sub.listSessionStates(),
    (error: unknown) => error instanceof Error && !(error instanceof RemoteObservationIntegrityError),
  );
  await sub.close();
});

test("periodic exact reconciliation coalesces ticks behind one paused pass", async () => {
  const bee = "periodic-reobserve-coalesced";
  const locator = {
    remoteLaunchId: "00000000-0000-4000-8000-000000000631",
    remoteIncarnation: "00000000-0000-4000-8000-000000000632",
  };
  let eventsCalls = 0;
  let enterPaused!: () => void;
  let releasePaused!: () => void;
  let enterRerun!: () => void;
  let releaseRerun!: () => void;
  const paused = new Promise<void>((resolve) => { enterPaused = resolve; });
  const release = new Promise<void>((resolve) => { releasePaused = resolve; });
  const rerun = new Promise<void>((resolve) => { enterRerun = resolve; });
  const finishRerun = new Promise<void>((resolve) => { releaseRerun = resolve; });
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method) {
      if (method === "observe" || method === "unobserve") return { ok: true };
      if (method === "events") {
        eventsCalls += 1;
        if (eventsCalls === 2) {
          enterPaused();
          await release;
        } else if (eventsCalls === 3) {
          enterRerun();
          await finishRerun;
        }
        return { ok: true, events: [] };
      }
      return { ok: true };
    },
    on: () => () => undefined,
    droppedCount: () => 0,
    async close() {},
  };
  const sub = createRemoteHsrSubstrate(makeNode(), {
    connect: async () => client,
    observationReconcileMs: 25,
  });
  const off = await sub.observe(bee, async () => undefined, locator);
  assert.equal(eventsCalls, 1, "initial admission performs one exact replay");
  await paused;
  await sleep(110); // several periodic ticks arrive while the first pass is blocked
  assert.equal(eventsCalls, 2, "ticks do not enqueue overlapping replay RPCs");
  releasePaused();
  await rerun;
  await sub.close();
  releaseRerun();
  assert.equal(eventsCalls, 3, "many blocked ticks collapse to at most one queued pass");
  await off();
});

test("local projection failure advances no remote ack and the exact event replays on repaired admission", async () => {
  const bee = "projection-failure-replay";
  const locator = {
    remoteLaunchId: "00000000-0000-4000-8000-000000000811",
    remoteIncarnation: "00000000-0000-4000-8000-000000000812",
  };
  const durable: RunnerEvent[] = [{
    type: "needs_input",
    ts: 100,
    seq: 1,
    kind: "question",
    question: "durable?",
    requestId: "r1",
  }];
  const acknowledgements: number[] = [];
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method, params) {
      if (method === "observe" || method === "unobserve") return { ok: true };
      if (method === "events") {
        const afterSeq = Number((params as { afterSeq?: unknown }).afterSeq ?? 0);
        return { ok: true, events: durable.filter((event) => Number(event.seq) > afterSeq) };
      }
      if (method === "ackEvents") {
        acknowledgements.push(Number((params as { upToSeq?: unknown }).upToSeq));
        return { ok: true, ackedSeq: acknowledgements.at(-1) };
      }
      return { ok: true };
    },
    on: () => () => {},
    droppedCount: () => 0,
    async close() {},
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });

  await assert.rejects(
    sub.observe(bee, async () => {
      throw new Error("injected local mirror append/cursor persistence failure");
    }, locator),
    (error: unknown) => error instanceof RemoteObservationIntegrityError
      && /local remote-event projection failed/.test(error.message),
  );
  assert.deepEqual(acknowledgements, [], "remote retention is never acknowledged before local durability");

  const repaired: RunnerEvent[] = [];
  const off = await sub.observe(bee, async (event) => { repaired.push(event as RunnerEvent); }, locator);
  assert.deepEqual(repaired.map((event) => event.seq), [1], "the unacked event remains exactly replayable");
  assert.deepEqual(acknowledgements, [1], "ack advances only after the repaired durable consumer returns");
  await off();
  await sub.close();
});

test("a one-off notification jump retries silent replay past three transient failures without reconnect", async () => {
  const bee = "persistent-reobserve-retry";
  const locator = {
    remoteLaunchId: "00000000-0000-4000-8000-000000000821",
    remoteIncarnation: "00000000-0000-4000-8000-000000000822",
  };
  const durable: RunnerEvent[] = [{ type: "host_epoch", ts: 1, seq: 1, host: {
    hostPid: process.pid,
    startedAt: "2026-08-15T00:00:00.000Z",
    hostFingerprint: { pgid: process.pid, startedAt: "persistent-replay-host" },
  } }];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const acknowledgements: number[] = [];
  let replayFailuresRemaining = 0;
  let syncObserveRefusals = 0;
  const client: RemoteRunnerClient = {
    node: "loopunit",
    localSocket: undefined,
    connected: () => true,
    async call(method, params) {
      if (method === "observe") {
        if ((params as { sync?: unknown } | undefined)?.sync !== undefined && syncObserveRefusals > 0) {
          syncObserveRefusals -= 1;
          return { ok: false, error: "replacement host is not live yet" };
        }
        return { ok: true };
      }
      if (method === "unobserve") return { ok: true };
      if (method === "events") {
        if (replayFailuresRemaining > 0) {
          replayFailuresRemaining -= 1;
          throw new Error("temporary replay RPC outage");
        }
        const afterSeq = Number((params as { afterSeq?: unknown }).afterSeq ?? 0);
        return { ok: true, events: durable.filter((event) => Number(event.seq) > afterSeq) };
      }
      if (method === "ackEvents") {
        acknowledgements.push(Number((params as { upToSeq?: unknown }).upToSeq));
        return { ok: true, ackedSeq: acknowledgements.at(-1) };
      }
      return { ok: true };
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => set.delete(handler);
    },
    droppedCount: () => 0,
    async close() {},
  };
  const emit = (method: string, params: unknown): void => {
    for (const handler of handlers.get(method) ?? []) handler(params);
  };
  const sub = createRemoteHsrSubstrate(makeNode(), { connect: async () => client });
  const projected: RunnerEvent[] = [];
  const off = await sub.observe(bee, async (event) => { projected.push(event as RunnerEvent); }, locator);
  assert.deepEqual(projected.map((event) => event.seq), [1]);

  durable.push({
    type: "needs_input",
    ts: 2,
    seq: 2,
    kind: "question",
    question: "missed while replay RPC is down",
    requestId: "silent-r2",
  });
  const jumped = { type: "turn_end", ts: 3, seq: 3 } satisfies RunnerEvent;
  durable.push(jumped);
  replayFailuresRemaining = 4;
  syncObserveRefusals = 1;
  emit("hsr.event", {
    bee,
    event: jumped,
    launchId: locator.remoteLaunchId,
    incarnation: locator.remoteIncarnation,
  });
  await waitFor(
    () => projected.some((event) => event.seq === 3),
    "periodic exact replay recovers a silent tail after the old three-retry ceiling",
  );
  assert.deepEqual(projected.map((event) => event.seq), [1, 2, 3]);
  assert.equal(acknowledgements.at(-1), 3);

  await off();
  await sub.close();
});

test("observe/unobserve refcounting on the serve: last unobserve closes the per-bee relay connection (HIVE-56)", async () => {
  await withTempStore(async (dir) => {
    const bee = "refbee";
    const consumerId = "refbee-controller";

    // A fake per-bee runner host; its connectionCount() exposes whether the
    // serve's relay client is still attached.
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

    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const client = await connectRpcClient(remoteSock);

    try {
      // Two subscribers share ONE relay connection to the bee's control socket.
      assert.deepEqual(await client.call("observe", { bee, consumerId }), { ok: true });
      assert.deepEqual(await client.call("observe", { bee, consumerId }), { ok: true });
      await waitFor(() => beeHost.connectionCount() === 1, "one shared relay connection after two observes");

      // First release: refcount 2 → 1, relay stays up and keeps pumping.
      assert.deepEqual(await client.call("unobserve", { bee, consumerId }), { ok: true });
      const events: unknown[] = [];
      const off = client.on("hsr.event", (p) => events.push(p));
      await waitFor(() => {
        beeHost.broadcast("event", { type: "text", text: "still-alive" });
        return events.length > 0;
      }, "relay still pumping after first unobserve");
      assert.equal(beeHost.connectionCount(), 1, "relay connection survives while refcount > 0");

      // Last release: relay client closes — the per-bee connection is reclaimed.
      assert.deepEqual(await client.call("unobserve", { bee, consumerId }), { ok: true });
      await waitFor(() => beeHost.connectionCount() === 0, "relay connection closed at refcount zero");
      // Idempotent: releasing an already-gone relay is a success, not an error.
      assert.deepEqual(await client.call("unobserve", { bee, consumerId }), { ok: true });
      off();

      // `sync` SETS the refcount instead of incrementing (reconnect
      // reconciliation): two observes + a sync:1 re-observe must close after
      // ONE unobserve, not three.
      assert.deepEqual(await client.call("observe", { bee, consumerId }), { ok: true });
      assert.deepEqual(await client.call("observe", { bee, consumerId }), { ok: true });
      assert.deepEqual(await client.call("observe", { bee, consumerId, sync: 1 }), { ok: true });
      await waitFor(() => beeHost.connectionCount() === 1, "relay re-established");
      assert.deepEqual(await client.call("unobserve", { bee, consumerId }), { ok: true });
      await waitFor(() => beeHost.connectionCount() === 0, "sync reset the refcount so one release closed the relay");

      // `count` releases several subscriptions at once (substrate close path).
      assert.deepEqual(await client.call("observe", { bee, consumerId, sync: 3 }), { ok: true });
      await waitFor(() => beeHost.connectionCount() === 1, "relay re-established for count release");
      assert.deepEqual(await client.call("unobserve", { bee, consumerId, count: 3 }), { ok: true });
      await waitFor(() => beeHost.connectionCount() === 0, "count:3 released the whole relay");
    } finally {
      client.close();
      await rm(hsrRunDir(bee), { recursive: true, force: true });
      await server.close();
      await beeHost.close();
    }
  });
});

test("substrate unsubscribe releases the remote relay: flapping observe/off cycles do not leak per-bee connections (HIVE-56)", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const bee = "flapbee";

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
      // Flap: mirror teardown-then-resubscribe. Every off() must reach the
      // remote — the relay's per-bee connection closes after each cycle
      // instead of accumulating refcounts until the bee is killed.
      for (let cycle = 0; cycle < 3; cycle++) {
        const events: Array<{ text?: string }> = [];
        const off = await sub.observe(bee, (e) => { events.push(e as { text?: string }); });
        await waitFor(() => {
          beeHost.broadcast("event", { type: "text", text: `cycle-${cycle}` });
          return events.some((e) => e.text === `cycle-${cycle}`);
        }, `event relayed on cycle ${cycle}`);
        assert.equal(beeHost.connectionCount(), 1, `one relay connection during cycle ${cycle}`);
        off();
        await waitFor(() => beeHost.connectionCount() === 0, `relay released after cycle ${cycle}`);
      }

      // Two subscribers: dropping one keeps the shared relay; dropping the
      // last one releases it.
      const off1 = await sub.observe(bee, () => undefined);
      const off2 = await sub.observe(bee, () => undefined);
      await waitFor(() => beeHost.connectionCount() === 1, "shared relay up for two subscribers");
      off1();
      await sleep(100);
      assert.equal(beeHost.connectionCount(), 1, "relay survives while one subscriber remains");
      off2();
      await waitFor(() => beeHost.connectionCount() === 0, "relay released after last unsubscribe");

      // close() releases whatever is still observed before dropping the tunnel.
      await sub.observe(bee, () => undefined);
      await sub.observe(bee, () => undefined);
      await waitFor(() => beeHost.connectionCount() === 1, "relay up again before close");
      await sub.close();
      await waitFor(() => beeHost.connectionCount() === 0, "close() released the relay");
    } finally {
      await sub.close();
      await rm(hsrRunDir(bee), { recursive: true, force: true });
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
      runnerHostVersion: versionCore(),
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
