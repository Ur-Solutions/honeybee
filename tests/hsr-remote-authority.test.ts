import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalHsrAnswerDigest,
  markHsrAnswerOperationSending,
  markHsrAnswerOperationAmbiguous,
  offerHsrAnswerOperation,
  readHsrAnswerReceipt,
  reconcileHsrAnswerOperation,
  type HsrAnswerHostIdentity,
  type HsrAnswerOperation,
} from "../src/answerReceipt.js";
import { machineId } from "../src/fsx.js";
import type { HsrHostHandle } from "../src/hsr/host.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import {
  persistHsrEventIntegrityFailure,
  readHsrEventIntegrityReceipt,
  recordHsrEventIntegrityStop,
} from "../src/hsr/eventIntegrity.js";
import { captureProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import {
  REMOTE_HSR_SAFETY_PROTOCOL,
  readRemoteHsrLaunchHistoryStrict,
  readRemoteHsrLaunchReceiptStrict,
  remoteHsrLaunchReceiptPath,
  writeRemoteHsrLaunchReceipt,
} from "../src/hsr/remoteLaunchReceipt.js";
import { buildController, versionCore } from "../src/hsr/remoteHost.js";
import { connectRpcClient, startRpcServer, type RpcServer } from "../src/hsr/rpc.js";
import {
  __testOnlyClearHsrEventReplaySessions,
  __testOnlySetWholeEventLogReadGuard,
  appendHsrEvent,
  ensureHsrRunDir,
  forgetHsrRunState,
  hsrControlSocketPath,
  hsrEventConsumerDiscardEvidencePath,
  hsrEventsPath,
  hsrMetaPath,
  hsrRunDir,
  hsrSeqPath,
  HSR_EVENT_REPLAY_PAGE_MAX_EVENTS,
  HSR_LEGACY_EVENT_CONSUMER_ID,
  markHsrConsumerSubscribedStrict,
  readHsrMetaStrict,
  sealHsrEventStreamClosure,
  verifyHsrEventStreamClosure,
  writeHsrMeta,
} from "../src/hsr/runDir.js";
import type { RemoteRunnerClient } from "../src/hsr/remoteTransport.js";
import type { NodeRecord } from "../src/node.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import {
  RemoteSpawnIndeterminateError,
  RemoteSpawnNotAdmittedError,
  createRemoteHsrSubstrate,
} from "../src/substrates/remote-hsr.js";

const CTX = { connectionId: 1, close() {} };
const TEST_CONSUMER_ID = "remote-authority-test-consumer";

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function answerOperation(
  requestId: string,
  answer: string | string[][],
  locator: { remoteLaunchId: string; remoteIncarnation: string },
  nodeName = "authority-node",
  host: HsrAnswerHostIdentity = {
    hostPid: process.pid,
    startedAt: "2026-08-15T00:00:00.000Z",
    hostFingerprint: { pgid: process.pid, startedAt: "test-process-birth" },
  },
): HsrAnswerOperation {
  return {
    source: {
      createdAt: "2026-08-15T00:00:00.000Z",
      runtimeGeneration: 1,
      id: "remote-authority-answer-source",
      uuid: "remote-authority-answer-uuid",
      node: nodeName,
      remoteLaunchId: locator.remoteLaunchId,
      remoteIncarnation: locator.remoteIncarnation,
    },
    requestId,
    answerDigest: canonicalHsrAnswerDigest(answer),
    host,
  };
}

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-remote-authority-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

function requestDigest(params: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(params))).digest("hex");
}

async function fakeRunHost(
  onStart?: () => Promise<void>,
): Promise<(params: Parameters<typeof import("../src/hsr/host.js").runHsrHost>[0]) => Promise<HsrHostHandle>> {
  const hostFingerprint = await captureProcessBirthFingerprint(process.pid);
  assert.ok(hostFingerprint);
  return async (params) => {
    await onStart?.();
    const startedAt = new Date().toISOString();
    const running = {
      bee: params.bee,
      harness: params.adapter.harness,
      tier: params.adapter.tier(),
      hostPid: process.pid,
      hostFingerprint,
      childAdmission: "none" as const,
      startedAt,
      runningAt: startedAt,
      controlSocket: hsrControlSocketPath(params.bee),
      status: "running" as const,
    };
    await writeHsrMeta(params.bee, running);
    const eventHost = {
      hostPid: running.hostPid,
      startedAt: running.startedAt,
      hostFingerprint: running.hostFingerprint,
    };
    await appendHsrEvent(params.bee, { type: "host_epoch", ts: Date.now(), host: eventHost });
    return {
      bee: params.bee,
      controlSocket: running.controlSocket,
      done: new Promise<void>(() => undefined),
      async stop() {
        await appendHsrEvent(params.bee, { type: "exit", ts: Date.now(), code: 0, host: eventHost });
        const eventStreamClosure = await sealHsrEventStreamClosure(params.bee, running);
        await writeHsrMeta(params.bee, {
          ...running,
          status: "exited",
          endedAt: new Date().toISOString(),
          eventStreamClosure,
        });
      },
    };
  };
}

function authority(result: unknown): { launchId: string; incarnation: string } {
  const value = result as { ok?: boolean; launchId?: string; incarnation?: string; error?: string };
  assert.equal(value.ok, true, value.error);
  assert.ok(value.launchId);
  assert.ok(value.incarnation);
  return { launchId: value.launchId, incarnation: value.incarnation };
}

async function currentAnswerHost(bee: string): Promise<HsrAnswerHostIdentity> {
  const meta = await readHsrMetaStrict(bee);
  assert.ok(meta?.hostFingerprint);
  return { hostPid: meta.hostPid, startedAt: meta.startedAt, hostFingerprint: meta.hostFingerprint };
}

test("remote authority orders generations and never resurrects delayed launch ids", async () => {
  await withTempStore(async () => {
    let starts = 0;
    const runHost = await fakeRunHost(async () => { starts += 1; });
    const controller = buildController({ runHost });
    const bee = "authority-order";
    const launchA = randomUUID();
    const paramsA = {
      bee,
      launchId: launchA,
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };

    const a = authority(await controller.methods.spawn!(paramsA, CTX));
    const replayA = authority(await controller.methods.spawn!(paramsA, CTX));
    assert.deepEqual(replayA, a);
    assert.equal(starts, 1, "same launchId starts exactly once");
    assert.equal((await controller.methods.kill!({ bee, launchId: randomUUID() }, CTX) as { ok?: boolean }).ok, false);
    assert.equal((await controller.methods.kill!({ bee, ...a }, CTX) as { ok?: boolean }).ok, true);

    const launchB = randomUUID();
    const paramsB = { ...paramsA, launchId: launchB, previousLaunchId: launchA };
    const b = authority(await controller.methods.spawn!(paramsB, CTX));
    assert.equal(starts, 2);
    assert.equal((await controller.methods.kill!({ bee, ...b }, CTX) as { ok?: boolean }).ok, true);

    const delayedA = await controller.methods.spawn!(paramsA, CTX) as { ok?: boolean; stopped?: boolean };
    assert.equal(delayedA.ok, false);
    assert.equal(delayedA.stopped, true);
    const unseenStale = await controller.methods.spawn!({
      ...paramsA,
      launchId: randomUUID(),
      previousLaunchId: launchA,
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(unseenStale.ok, false);
    assert.match(unseenStale.error ?? "", /predecessor changed/);
    assert.equal(starts, 2, "neither delayed request reforks");

    const fresh = authority(await controller.methods.spawn!({
      ...paramsA,
      launchId: randomUUID(),
      previousLaunchId: launchB,
    }, CTX));
    const staleKill = await controller.methods.kill!({ bee, ...a }, CTX) as { ok?: boolean };
    assert.equal(staleKill.ok, false, "A cannot kill the current generation");
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
    assert.equal((await controller.methods.kill!({ bee, ...fresh }, CTX) as { ok?: boolean }).ok, true);
    await controller.close();
  });
});

test("a completed in-process handle heals a failed exited-meta write without signalling the shared serve", async () => {
  await withTempStore(async () => {
    const fingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(fingerprint);
    let stopCalls = 0;
    const signalled: number[] = [];
    const runHost: Awaited<ReturnType<typeof fakeRunHost>> = async (params) => {
      const startedAt = new Date().toISOString();
      const running = {
        bee: params.bee,
        harness: params.adapter.harness,
        tier: params.adapter.tier(),
        hostPid: process.pid,
        hostFingerprint: fingerprint,
        childAdmission: "none" as const,
        startedAt,
        runningAt: startedAt,
        controlSocket: hsrControlSocketPath(params.bee),
        status: "running" as const,
      };
      await writeHsrMeta(params.bee, running);
      const eventHost = {
        hostPid: running.hostPid,
        startedAt: running.startedAt,
        hostFingerprint: running.hostFingerprint,
      };
      await appendHsrEvent(params.bee, { type: "host_epoch", ts: 1, host: eventHost });
      await appendHsrEvent(params.bee, { type: "exit", ts: 2, code: 0, host: eventHost });
      const eventStreamClosure = await sealHsrEventStreamClosure(params.bee, running);
      const terminal = {
        ...running,
        status: "exited" as const,
        endedAt: new Date().toISOString(),
        eventStreamClosure,
      };
      return {
        bee: params.bee,
        controlSocket: running.controlSocket,
        done: Promise.resolve(), // finalize completed, but its exited-meta write was injected to fail
        async stop() { stopCalls += 1; },
        terminalMeta: () => terminal,
      };
    };
    const controller = buildController({
      runHost,
      processSignals: {
        kill(pid) { signalled.push(pid); },
      },
    });
    const base = {
      kind: "stub",
      cwd: process.cwd(),
      consumerId: "meta-heal-controller",
      spec: { command: process.execPath, args: [], env: {} },
    };
    const first = authority(await controller.methods.spawn!({ bee: "meta-heal-a", launchId: randomUUID(), ...base }, CTX));
    const second = authority(await controller.methods.spawn!({ bee: "meta-heal-b", launchId: randomUUID(), ...base }, CTX));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const killed = await controller.methods.kill!({ bee: "meta-heal-a", ...first }, CTX) as { ok?: boolean; error?: string };
    assert.equal(killed.ok, true, killed.error);
    assert.equal(stopCalls, 1);
    assert.deepEqual(signalled, [], "the shared runner-host pid is never an OS-signal fallback target");
    assert.equal((await readHsrMetaStrict("meta-heal-b"))?.status, "running", "another Cell on the serve remains live");

    assert.equal((await controller.methods.kill!({ bee: "meta-heal-b", ...second }, CTX) as { ok?: boolean }).ok, true);
    await controller.close();
  });
});

test("an exited host with a surviving birth-qualified child group cannot confirm event-integrity cleanup", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-escaped-child";
    const launchId = randomUUID();
    const incarnation = randomUUID();
    const startedAt = "2026-08-15T19:35:00.000Z";
    const hostPid = 8611;
    const childPid = 8612;
    const hostFingerprint = { pgid: hostPid, startedAt: "dead-host-birth" };
    const childFingerprint = { pgid: childPid, startedAt: "escaped-child-birth" };
    const host = { hostPid, startedAt, hostFingerprint };
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid,
      hostFingerprint,
      childAdmission: "admitted",
      childPid,
      childPgid: childPid,
      childFingerprint,
      startedAt,
      controlSocket: "",
      status: "exited",
      endedAt: startedAt,
      exitCode: null,
    });
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId,
      incarnation,
      requestDigest: "3".repeat(64),
      state: "running",
      createdAt: startedAt,
      cwd: process.cwd(),
      tier: "stream",
      host,
    });
    const integrity = await persistHsrEventIntegrityFailure({
      bee,
      host,
      remoteAuthority: { launchId, incarnation },
      deliveryIds: [],
      reason: "terminal append failed after descendant escape",
    });
    await recordHsrEventIntegrityStop(bee, integrity.integrityId, host, "doubt", "child-group proof pending");
    const signals: number[] = [];
    const controller = buildController({
      processSignals: {
        readProcessIdentity: async (pid) => pid === childPid ? childFingerprint : null,
        isProcessGroupAlive: () => true,
        kill(pid) { signals.push(pid); },
      },
    });

    const result = await controller.methods.kill!({ bee, launchId, incarnation }, CTX) as { ok?: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.ok(signals.includes(-childPid), "strict cleanup targets only the recorded child process group");
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.stopState, "doubt");
    assert.notEqual((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopped");
    // Deliberately omit close: the fixture proves shutdown must remain
    // fail-closed while the escaped group is still reported live.
  });
});

test("remote cleanup keeps event-integrity stop in doubt when the child leader is gone but its group survives", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-gone-leader-live-group";
    const launchId = randomUUID();
    const incarnation = randomUUID();
    const startedAt = "2026-08-15T19:37:00.000Z";
    const hostPid = 8621;
    const childPid = 8622;
    const hostFingerprint = { pgid: hostPid, startedAt: "dead-host-birth-2" };
    const childFingerprint = { pgid: childPid, startedAt: "gone-child-birth" };
    const host = { hostPid, startedAt, hostFingerprint };
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid,
      hostFingerprint,
      childAdmission: "admitted",
      childPid,
      childPgid: childPid,
      childFingerprint,
      startedAt,
      controlSocket: "",
      status: "exited",
      endedAt: startedAt,
      exitCode: null,
    });
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId,
      incarnation,
      requestDigest: "4".repeat(64),
      state: "running",
      createdAt: startedAt,
      cwd: process.cwd(),
      tier: "stream",
      host,
    });
    const integrity = await persistHsrEventIntegrityFailure({
      bee,
      host,
      remoteAuthority: { launchId, incarnation },
      deliveryIds: [],
      reason: "terminal append failed after group leader exit",
    });
    await recordHsrEventIntegrityStop(bee, integrity.integrityId, host, "doubt", "group census pending");
    const controller = buildController({
      processSignals: {
        readProcessIdentity: async () => null,
        isProcessGroupAlive: (pgid) => pgid === childPid,
        kill() { throw new Error("a leader-gone process group must not be signalled"); },
      },
    });

    const result = await controller.methods.kill!({ bee, launchId, incarnation }, CTX) as { ok?: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.stopState, "doubt");
    assert.notEqual((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopped");
  });
});

test("remote list and reconciliation use the outside integrity head when run metadata is absent or corrupt", async () => {
  await withTempStore(async () => {
    const controller = buildController();
    const createdAt = "2026-08-15T19:40:00.000Z";
    const host = {
      hostPid: 8521,
      startedAt: createdAt,
      hostFingerprint: { pgid: 8521, startedAt: "remote-integrity-list-host" },
    };

    const absentBee = "integrity-list-no-meta";
    const absentAuthority = { launchId: randomUUID(), incarnation: randomUUID() };
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee: absentBee,
      ...absentAuthority,
      requestDigest: "1".repeat(64),
      state: "dispatching",
      createdAt,
      cwd: process.cwd(),
      tier: "stream",
    });
    const absentReceipt = await persistHsrEventIntegrityFailure({
      bee: absentBee,
      host,
      remoteAuthority: absentAuthority,
      deliveryIds: [],
      reason: "provider failed before host binding",
    });
    await recordHsrEventIntegrityStop(absentBee, absentReceipt.integrityId, host, "confirmed", "strict launch cleanup");

    const corruptBee = "integrity-list-corrupt-meta";
    const corruptAuthority = { launchId: randomUUID(), incarnation: randomUUID() };
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee: corruptBee,
      ...corruptAuthority,
      requestDigest: "2".repeat(64),
      state: "running",
      createdAt,
      cwd: process.cwd(),
      tier: "stream",
      host,
    });
    const corruptReceipt = await persistHsrEventIntegrityFailure({
      bee: corruptBee,
      host,
      remoteAuthority: corruptAuthority,
      deliveryIds: [],
      reason: "provider event was lost beside malformed meta",
    });
    await recordHsrEventIntegrityStop(corruptBee, corruptReceipt.integrityId, host, "confirmed", "strict child cleanup");
    await mkdir(hsrRunDir(corruptBee), { recursive: true });
    await writeFile(hsrMetaPath(corruptBee), "{not-json", { mode: 0o600 });

    const rows = await controller.methods.list!(undefined, CTX) as Array<Record<string, unknown>>;
    for (const [bee, receipt] of [[absentBee, absentReceipt], [corruptBee, corruptReceipt]] as const) {
      const row = rows.find((candidate) => candidate.bee === bee);
      assert.equal(row?.status, "event_integrity");
      assert.equal(row?.eventIntegrityId, receipt.integrityId);
      assert.deepEqual(row?.eventIntegrityReceipt, await readHsrEventIntegrityReceipt(bee));
      const reconciled = await controller.methods.eventIntegrityReconcile!({
        bee,
        integrityId: receipt.integrityId,
        launchId: receipt.remoteAuthority!.launchId,
        incarnation: receipt.remoteAuthority!.incarnation,
      }, CTX) as { ok?: boolean; receipt?: { phase?: string }; error?: string };
      assert.equal(reconciled.ok, true, reconciled.error);
      assert.equal(reconciled.receipt?.phase, "acknowledged");
    }
    // The fixture deliberately leaves malformed/absent disposable run state;
    // controller shutdown therefore must remain fail-closed rather than erase
    // the authority heads. The temp-store teardown owns fixture cleanup.
  });
});

test("remote idle source corruption stops and receipts only the damaged Bee while a healthy Bee keeps working", async () => {
  await withTempStore(async () => {
    const controller = buildController();
    const base = {
      consumerId: "idle-integrity-controller",
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };
    const damagedBee = "idle-integrity-a";
    const healthyBee = "idle-integrity-b";
    const damaged = authority(await controller.methods.spawn!({ ...base, bee: damagedBee, launchId: randomUUID() }, CTX));
    const healthy = authority(await controller.methods.spawn!({ ...base, bee: healthyBee, launchId: randomUUID() }, CTX));
    const seeded = await controller.methods.send!({
      bee: damagedBee,
      ...damaged,
      text: "seed damaged history",
      deliveryId: "idle-integrity-seed-a",
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(seeded.ok, true, seeded.error);
    await waitFor(async () => {
      const raw = await readFile(hsrEventsPath(damagedBee), "utf8");
      return raw.split("\n").filter(Boolean).length >= 4;
    }, "damaged Bee has an internal stamped event to remove");
    const lines = (await readFile(hsrEventsPath(damagedBee), "utf8")).split("\n").filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as { seq?: number });
    const removed = events.find((event, index) => index > 0 && index < events.length - 1 && event.seq !== undefined)?.seq;
    assert.ok(removed);
    await writeFile(
      hsrEventsPath(damagedBee),
      `${lines.filter((line) => (JSON.parse(line) as { seq?: number }).seq !== removed).join("\n")}\n`,
      { mode: 0o600 },
    );

    const rows = await controller.methods.list!(undefined, CTX) as Array<Record<string, unknown>>;
    const damagedRow = rows.find((row) => row.bee === damagedBee);
    const healthyRow = rows.find((row) => row.bee === healthyBee);
    assert.equal(damagedRow?.status, "event_integrity");
    assert.equal(damagedRow?.eventIntegrityStopState, "confirmed", "idle settlement includes exact host and child-group stop proof");
    assert.equal(healthyRow?.live, true, "node-wide list remains healthy for unrelated Bees");
    await waitFor(async () => (await readHsrEventIntegrityReceipt(damagedBee))?.stopState === "confirmed", "damaged host exact stop is confirmed");
    assert.equal(await readHsrEventIntegrityReceipt(healthyBee), null);

    const healthySend = await controller.methods.send!({
      bee: healthyBee,
      ...healthy,
      text: "healthy Bee still works",
      deliveryId: "idle-integrity-send-b",
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(healthySend.ok, true, healthySend.error);
    const damagedSend = await controller.methods.send!({
      bee: damagedBee,
      ...damaged,
      text: "must stay fenced",
      deliveryId: "idle-integrity-send-a-after",
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(damagedSend.ok, false);
    assert.match(damagedSend.error ?? "", /unresolved HSR event history|is not running/);

    await Promise.resolve(controller.methods.kill!({ bee: damagedBee, ...damaged }, CTX)).catch(() => undefined);
    await Promise.resolve(controller.methods.kill!({ bee: healthyBee, ...healthy }, CTX)).catch(() => undefined);
    await controller.close().catch(() => undefined);
  });
});

test("remote list isolates malformed per-Bee metadata and publishes exact manual authority", async () => {
  await withTempStore(async () => {
    const controller = buildController();
    const base = {
      consumerId: "per-bee-meta-integrity-controller",
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };
    const damagedBee = "list-meta-damaged-a";
    const healthyBee = "list-meta-healthy-b";
    const damaged = authority(await controller.methods.spawn!({ ...base, bee: damagedBee, launchId: randomUUID() }, CTX));
    const healthy = authority(await controller.methods.spawn!({ ...base, bee: healthyBee, launchId: randomUUID() }, CTX));
    const damagedMeta = await readHsrMetaStrict(damagedBee);
    assert.ok(damagedMeta);
    await writeFile(hsrMetaPath(damagedBee), "{malformed-meta", { mode: 0o600 });

    const rows = await controller.methods.list!(undefined, CTX) as Array<Record<string, unknown>>;
    const damagedRow = rows.find((row) => row.bee === damagedBee);
    const healthyRow = rows.find((row) => row.bee === healthyBee);
    assert.equal(damagedRow?.status, "event_integrity");
    assert.equal(damagedRow?.launchId, damaged.launchId);
    assert.equal(damagedRow?.incarnation, damaged.incarnation);
    assert.equal(typeof damagedRow?.eventIntegrityId, "string");
    const receipt = await readHsrEventIntegrityReceipt(damagedBee);
    assert.equal(receipt?.remoteAuthority?.launchId, damaged.launchId);
    assert.equal(receipt?.stopState, "doubt", "corrupt meta is never mistaken for exact descendant-stop proof");
    assert.equal(healthyRow?.live, true, "healthy Bee remains visible despite A's per-Bee storage failure");

    const healthySend = await controller.methods.send!({
      bee: healthyBee,
      ...healthy,
      text: "healthy remains admitted",
      deliveryId: "per-bee-meta-healthy-send",
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(healthySend.ok, true, healthySend.error);
    const damagedSend = await controller.methods.send!({
      bee: damagedBee,
      ...damaged,
      text: "damaged must remain fenced",
      deliveryId: "per-bee-meta-damaged-send",
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(damagedSend.ok, false);
    assert.match(damagedSend.error ?? "", /unresolved HSR event history|malformed|invalid json/i);

    await writeHsrMeta(damagedBee, damagedMeta!);
    await Promise.resolve(controller.methods.kill!({ bee: damagedBee, ...damaged }, CTX)).catch(() => undefined);
    await Promise.resolve(controller.methods.kill!({ bee: healthyBee, ...healthy }, CTX)).catch(() => undefined);
    await controller.close().catch(() => undefined);
  });
});

test("remote list folds a long consumer-pinned source into exact bounded state and usage", async () => {
  await withTempStore(async () => {
    const bee = "list-streams-pinned-source";
    const consumerId = "list-streaming-controller";
    const controller = buildController({ runHost: await fakeRunHost() });
    const launched = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId,
      kind: "stub",
      cwd: process.cwd(),
      sessionId: "list-root-thread",
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    // The fake host bypasses runHsrHost's pre-provider consumer admission seam.
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    const host = await currentAnswerHost(bee);
    const usageEvents = 420;
    for (let index = 0; index < usageEvents; index += 1) {
      await appendHsrEvent(bee, {
        type: "usage",
        ts: 10 + index,
        inputTokens: 1,
        cacheReadTokens: 2,
        outputTokens: 3,
        reasoningTokens: 4,
        host,
      });
    }
    await appendHsrEvent(bee, { type: "turn_start", ts: 1_000, threadId: "list-root-thread", host });
    await appendHsrEvent(bee, { type: "turn_end", ts: 1_001, threadId: "nested-thread", host });
    await appendHsrEvent(bee, { type: "turn_end", ts: 1_002, threadId: "list-root-thread", host });
    await appendHsrEvent(bee, { type: "exhausted", ts: 1_003, resetHint: "next window", host });

    __testOnlySetWholeEventLogReadGuard((readBee) => {
      if (readBee === bee) throw new Error("remote list materialized its pinned source backlog");
    });
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await controller.methods.list!(undefined, CTX) as Array<Record<string, unknown>>;
    } finally {
      __testOnlySetWholeEventLogReadGuard(undefined);
    }
    const row = rows.find((candidate) => candidate.bee === bee);
    assert.ok(row);
    assert.equal(row.live, true, JSON.stringify(row));
    assert.equal(row.state, "idle_with_output", "nested lifecycle markers cannot replace the root terminal state");
    assert.deepEqual(row.usage, {
      totals: { inputTokens: usageEvents * 3, outputTokens: usageEvents * 7 },
      latestExhausted: { ts: 1_003, resetHint: "next window" },
    });

    const beforeKillHigh = (await readFile(hsrSeqPath(bee), "utf8"));
    const beforeKillSeq = Number((JSON.parse(beforeKillHigh) as { lastSeq: number }).lastSeq);
    await controller.methods.ackEvents!({ bee, consumerId, upToSeq: beforeKillSeq, ...launched }, CTX);
    const firstKill = await controller.methods.kill!({ bee, ...launched }, CTX) as {
      ok?: boolean;
      terminalHistoryPending?: boolean;
    };
    assert.equal(firstKill.ok, false);
    assert.equal(firstKill.terminalHistoryPending, true);
    await controller.methods.ackEvents!({
      bee,
      consumerId,
      upToSeq: beforeKillSeq + 1,
      terminalActivated: true,
      ...launched,
    }, CTX);
    assert.equal((await controller.methods.kill!({ bee, ...launched }, CTX) as { ok?: boolean }).ok, true);
    await controller.close();
  });
});

test("remote list promotes an exact meta-only event failure into a reconcilable receipt row", async () => {
  await withTempStore(async () => {
    const controller = buildController();
    const bee = "remote-meta-only-integrity";
    const generation = authority(await controller.methods.spawn!({
      bee,
      consumerId: "meta-only-controller",
      kind: "stub",
      launchId: randomUUID(),
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    const meta = await readHsrMetaStrict(bee);
    assert.ok(meta);
    await writeHsrMeta(bee, {
      ...meta!,
      eventIntegrityFailure: "source append failed after diagnostic meta but before outside head",
    });
    assert.equal(await readHsrEventIntegrityReceipt(bee), null);

    const rows = await controller.methods.list!(undefined, CTX) as Array<Record<string, unknown>>;
    const row = rows.find((candidate) => candidate.bee === bee);
    assert.equal(row?.status, "event_integrity");
    assert.equal(row?.launchId, generation.launchId);
    assert.equal(row?.incarnation, generation.incarnation);
    assert.equal(typeof row?.eventIntegrityId, "string");
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(row?.eventIntegrityId, receipt?.integrityId);
    assert.equal(receipt?.phase, "unresolved");

    await Promise.resolve(controller.methods.kill!({ bee, ...generation }, CTX)).catch(() => undefined);
    await controller.close().catch(() => undefined);
  });
});

test("remote list reconstructs a clean terminal closure lost after the stamped exit", async () => {
  await withTempStore(async () => {
    const bee = "remote-clean-exit-meta-loss";
    const launchId = randomUUID();
    const incarnation = randomUUID();
    const startedAt = "2026-08-15T20:40:00.000Z";
    const hostPid = 8891;
    const hostFingerprint = { pgid: hostPid, startedAt: "clean-dead-host-birth" };
    const host = { hostPid, startedAt, hostFingerprint };
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "host_epoch", ts: 1, host });
    await appendHsrEvent(bee, { type: "exit", ts: 2, code: 0, host });
    await markHsrConsumerSubscribedStrict(bee, "clean-exit-controller");
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid,
      hostFingerprint,
      childAdmission: "none",
      startedAt,
      runningAt: startedAt,
      controlSocket: "",
      status: "running",
    });
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId,
      incarnation,
      requestDigest: "9".repeat(64),
      state: "running",
      createdAt: startedAt,
      cwd: process.cwd(),
      tier: "stream",
      host,
    });
    const controller = buildController({
      processSignals: {
        readProcessIdentity: async () => null,
        readProcessGroupPresence: async () => "absent",
        isProcessGroupAlive: () => false,
      },
    });
    const rows = await controller.methods.list!(undefined, CTX) as Array<Record<string, unknown>>;
    const row = rows.find((candidate) => candidate.bee === bee);
    assert.equal(row?.live, false);
    assert.equal(row?.status, "exited");
    assert.equal(row?.eventIntegrityId, undefined);
    assert.equal(await readHsrEventIntegrityReceipt(bee), null);
    const healed = await readHsrMetaStrict(bee);
    assert.equal(healed?.status, "exited");
    assert.ok(healed?.eventStreamClosure);
    assert.equal(await verifyHsrEventStreamClosure(bee, healed!), true);

    await controller.close();
  });
});

test("stale launch tokens cannot offer an answer operation bound to the successor", async () => {
  await withTempStore(async () => {
    const controller = buildController({ runHost: await fakeRunHost() });
    const bee = "answer-generation-authority";
    const base = {
      bee,
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };
    const first = authority(await controller.methods.spawn!({ ...base, launchId: randomUUID() }, CTX));
    assert.equal((await controller.methods.kill!({ bee, ...first }, CTX) as { ok?: boolean }).ok, true);
    const second = authority(await controller.methods.spawn!({
      ...base,
      launchId: randomUUID(),
      previousLaunchId: first.launchId,
    }, CTX));
    const locator = { remoteLaunchId: second.launchId, remoteIncarnation: second.incarnation };
    const operation = answerOperation(
      "successor-request",
      "successor-answer",
      locator,
      "authority-node",
      await currentAnswerHost(bee),
    );
    const stale = await controller.methods.answer!({
      bee,
      operation,
      answer: "successor-answer",
      launchId: first.launchId,
      incarnation: first.incarnation,
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(stale.ok, false);
    assert.match(stale.error ?? "", /launch id does not own/);
    assert.equal(await readHsrAnswerReceipt(bee, operation), null, "stale authority creates no durable offer");
    assert.equal((await controller.methods.kill!({ bee, ...second }, CTX) as { ok?: boolean }).ok, true);
    await controller.close();
  });
});

test("an old ambiguous answer blocks a successor operation with the same base source tuple", async () => {
  await withTempStore(async () => {
    const controller = buildController({ runHost: await fakeRunHost() });
    const bee = "answer-ambiguous-predecessor";
    const base = {
      bee,
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };
    const first = authority(await controller.methods.spawn!({ ...base, launchId: randomUUID() }, CTX));
    const firstHost = await currentAnswerHost(bee);
    assert.equal((await controller.methods.kill!({ bee, ...first }, CTX) as { ok?: boolean }).ok, true);
    const second = authority(await controller.methods.spawn!({
      ...base,
      launchId: randomUUID(),
      previousLaunchId: first.launchId,
    }, CTX));
    const secondHost = await currentAnswerHost(bee);
    const firstLocator = { remoteLaunchId: first.launchId, remoteIncarnation: first.incarnation };
    const secondLocator = { remoteLaunchId: second.launchId, remoteIncarnation: second.incarnation };
    const oldOperation = answerOperation("same-request", "same-answer", firstLocator, "authority-node", firstHost);
    const currentOperation = answerOperation("same-request", "same-answer", secondLocator, "authority-node", secondHost);
    await offerHsrAnswerOperation(bee, oldOperation);
    await markHsrAnswerOperationAmbiguous(bee, oldOperation, "injected predecessor ambiguity");

    const result = await controller.methods.answer!({
      bee,
      operation: currentOperation,
      answer: "same-answer",
      launchId: second.launchId,
      incarnation: second.incarnation,
    }, CTX) as { ok?: boolean; result?: { status?: string } };
    assert.equal(result.ok, true);
    assert.equal(result.result?.status, "conflict");
    assert.equal(await readHsrAnswerReceipt(bee, currentOperation), null, "successor provider dispatch is never offered");

    assert.equal((await controller.methods.kill!({ bee, ...second }, CTX) as { ok?: boolean }).ok, true);
    await controller.close();
  });
});

test("a controller-only sending receipt can be discarded after refresh proves remote absence", async () => {
  await withTempStore(async (dir) => {
    const localRoot = join(dir, "controller-store");
    const remoteRoot = join(dir, "node-store");
    await mkdir(localRoot, { recursive: true });
    await mkdir(remoteRoot, { recursive: true });
    const bee = "answer-refresh-absence";
    const locator = { remoteLaunchId: randomUUID(), remoteIncarnation: randomUUID() };
    const fingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(fingerprint);
    const hostA: HsrAnswerHostIdentity = {
      hostPid: process.pid,
      startedAt: "2026-08-15T00:00:00.000Z",
      hostFingerprint: fingerprint,
    };
    const hostB: HsrAnswerHostIdentity = {
      hostPid: process.pid,
      startedAt: "2026-08-15T00:00:01.000Z",
      hostFingerprint: fingerprint,
    };
    const operation = answerOperation(
      "reused-request-1",
      "old-host-answer",
      locator,
      "authority-node",
      hostA,
    );

    // Controller A crosses its transport boundary, then dies before the node
    // sees any bytes. Its durable local receipt must remain fenced.
    process.env.HIVE_STORE_ROOT = localRoot;
    await offerHsrAnswerOperation(bee, operation);
    await markHsrAnswerOperationSending(bee, operation, "controller");
    assert.equal((await readHsrAnswerReceipt(bee, operation))?.phase, "sending");

    // The remote authority has independently refreshed to host B under the
    // same launch/incarnation. No node receipt exists for A's operation.
    process.env.HIVE_STORE_ROOT = remoteRoot;
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "turn",
      hostPid: process.pid,
      hostFingerprint: fingerprint,
      childAdmission: "none",
      startedAt: hostB.startedAt,
      runningAt: hostB.startedAt,
      controlSocket: hsrControlSocketPath(bee),
      status: "running",
    });
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId: locator.remoteLaunchId,
      incarnation: locator.remoteIncarnation,
      requestDigest: requestDigest({ bee, locator }),
      state: "running",
      createdAt: hostA.startedAt,
      cwd: process.cwd(),
      tier: "turn",
      host: hostB,
    });
    const controller = buildController();
    const delayed = await controller.methods.answer!({
      bee,
      operation,
      answer: "old-host-answer",
      launchId: locator.remoteLaunchId,
      incarnation: locator.remoteIncarnation,
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(delayed.ok, false);
    assert.match(delayed.error ?? "", /does not own the current launch\/host epoch/);
    assert.equal(await readHsrAnswerReceipt(bee, operation), null, "delayed A creates no node receipt or provider effect");

    const delivered = await controller.methods.answerReconcile!({
      bee,
      operation,
      verdict: "delivered",
      launchId: locator.remoteLaunchId,
      incarnation: locator.remoteIncarnation,
    }, CTX) as { ok?: boolean; result?: { status?: string } };
    assert.equal(delivered.ok, true);
    assert.equal(delivered.result?.status, "conflict", "absence can never prove delivery");
    const discarded = await controller.methods.answerReconcile!({
      bee,
      operation,
      verdict: "discard",
      launchId: locator.remoteLaunchId,
      incarnation: locator.remoteIncarnation,
    }, CTX) as { ok?: boolean; result?: { status?: string } };
    assert.equal(discarded.ok, true);
    assert.equal(discarded.result?.status, "discarded", "B host authority proves A can no longer dispatch");
    // This controller owns no transport/host handle. Do not call close(): the
    // deliberately synthetic remote meta points at this test process so close's
    // durable-runtime drain would correctly signal the fixture's own pid.
    controller.beginClose();

    // The CLI mirrors that terminal remote proof into the controller store,
    // releasing the local sending fence without inventing a delivery outcome.
    process.env.HIVE_STORE_ROOT = localRoot;
    assert.equal((await reconcileHsrAnswerOperation(bee, operation, "discard")).phase, "discarded");
    assert.equal((await readHsrAnswerReceipt(bee, operation))?.phase, "discarded");
    const next = answerOperation("reused-request-1", "new-host-answer", locator, "authority-node", hostB);
    assert.equal((await offerHsrAnswerOperation(bee, next)).phase, "offered");
  });
});

test("credential refresh refuses an unreadable strict replacement-host epoch", async () => {
  await withTempStore(async (dir) => {
    const bee = "refresh-strict-epoch-storage";
    const fingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(fingerprint);
    let starts = 0;
    let beeHost: RpcServer | undefined;
    const runHost = async (params: Parameters<typeof import("../src/hsr/host.js").runHsrHost>[0]): Promise<HsrHostHandle> => {
      starts += 1;
      const startedAt = new Date(Date.now() + starts * 1_000).toISOString();
      const controlSocket = hsrControlSocketPath(params.bee);
      beeHost ??= await startRpcServer({ socketPath: controlSocket, methods: {} });
      const running = {
        bee: params.bee,
        harness: params.adapter.harness,
        tier: params.adapter.tier(),
        hostPid: process.pid,
        hostFingerprint: fingerprint,
        childAdmission: "none" as const,
        startedAt,
        runningAt: startedAt,
        controlSocket,
        status: "running" as const,
        sessionId: params.opts.sessionId ?? "strict-refresh-session",
      };
      const eventHost = { hostPid: process.pid, startedAt, hostFingerprint: fingerprint };
      await writeHsrMeta(params.bee, running);
      await appendHsrEvent(params.bee, {
        type: "host_epoch",
        ts: Date.now(),
        host: eventHost,
      });
      if (starts === 2) {
        // The replacement host has durably published its epoch, but the strict
        // high-water is unreadable at the relay handoff boundary. Refresh must
        // remain unresolved rather than silently leave observers on host A.
        await writeFile(hsrSeqPath(params.bee), "{malformed\n", "utf8");
      }
      return {
        bee: params.bee,
        controlSocket,
        done: new Promise<void>(() => undefined),
        async stop() {
          await appendHsrEvent(params.bee, { type: "exit", ts: Date.now(), code: 0, host: eventHost });
          const eventStreamClosure = await sealHsrEventStreamClosure(params.bee, running);
          await writeHsrMeta(params.bee, {
            ...running,
            status: "exited",
            endedAt: new Date().toISOString(),
            eventStreamClosure,
          });
        },
      };
    };
    const controller = buildController({ runHost });
    const transport = await startRpcServer({ socketPath: join(dir, "runner-host.sock"), methods: controller.methods });
    controller.attachServer(transport);
    const base = {
      bee,
      launchId: randomUUID(),
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      home: join(dir, "stub-home"),
      sessionId: "strict-refresh-session",
      creds: {
        files: [{
          homeRelPath: "credential.json",
          contentB64: Buffer.from("old").toString("base64"),
          mode: 0o600,
        }],
      },
      spec: { command: process.execPath, args: [], env: {} },
    };
    const launched = authority(await controller.methods.spawn!(base, CTX));
    const observed = await controller.methods.observe!({
      bee,
      consumerId: "refresh-corrupt-observer",
      ...launched,
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(observed.ok, true, observed.error);

    const refreshed = await controller.methods.refreshCreds!({
      bee,
      ...launched,
      creds: {
        files: [{
          homeRelPath: "credential.json",
          contentB64: Buffer.from("new").toString("base64"),
          mode: 0o600,
        }],
      },
    }, CTX) as { ok?: boolean; pending?: boolean; stopUnconfirmed?: boolean; error?: string };
    assert.equal(starts, 2, `refresh started exactly one replacement host: ${JSON.stringify(refreshed)}`);
    assert.equal(refreshed.ok, false);
    assert.equal(refreshed.pending, true);
    assert.equal(refreshed.stopUnconfirmed, true);
    assert.match(refreshed.error ?? "", /refresh observer handoff is unresolved.*event sequence state/is);

    // Repair only for deterministic fixture cleanup; the refusal above already
    // proves unreadable epoch storage never reports refresh success.
    await writeFile(hsrSeqPath(bee), `${JSON.stringify({
      lastSeq: 2,
      consumers: { "refresh-corrupt-observer": { ackedSeq: 0 } },
    })}\n`, "utf8");
    await Promise.resolve(controller.methods.kill!({ bee, ...launched }, CTX)).catch(() => undefined);
    await beeHost?.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await controller.close().catch(() => undefined);
  });
});

test("credential refresh relays a successor epoch through bounded pages over a long pinned predecessor", async () => {
  await withTempStore(async (dir) => {
    const bee = "refresh-pages-pinned-predecessor";
    const consumerId = "refresh-page-observer";
    const fingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(fingerprint);
    let starts = 0;
    let beeHost: RpcServer | undefined;
    const runHost = async (params: Parameters<typeof import("../src/hsr/host.js").runHsrHost>[0]): Promise<HsrHostHandle> => {
      starts += 1;
      const startedAt = new Date(Date.now() + starts * 1_000).toISOString();
      const controlSocket = hsrControlSocketPath(params.bee);
      beeHost ??= await startRpcServer({ socketPath: controlSocket, methods: {} });
      const running = {
        bee: params.bee,
        harness: params.adapter.harness,
        tier: params.adapter.tier(),
        hostPid: process.pid,
        hostFingerprint: fingerprint,
        childAdmission: "none" as const,
        startedAt,
        runningAt: startedAt,
        controlSocket,
        status: "running" as const,
        sessionId: params.opts.sessionId ?? "refresh-pages-session",
      };
      const eventHost = { hostPid: process.pid, startedAt, hostFingerprint: fingerprint };
      await writeHsrMeta(params.bee, running);
      await appendHsrEvent(params.bee, { type: "host_epoch", ts: Date.now(), host: eventHost });
      if (starts === 1) {
        for (let index = 0; index < 300; index += 1) {
          await appendHsrEvent(params.bee, { type: "text", ts: index + 1, text: `predecessor-${index}`, host: eventHost });
        }
      }
      return {
        bee: params.bee,
        controlSocket,
        done: new Promise<void>(() => undefined),
        async stop() {
          await appendHsrEvent(params.bee, { type: "exit", ts: Date.now(), code: 0, host: eventHost });
          const eventStreamClosure = await sealHsrEventStreamClosure(params.bee, running);
          await writeHsrMeta(params.bee, {
            ...running,
            status: "exited",
            endedAt: new Date().toISOString(),
            eventStreamClosure,
          });
        },
      };
    };
    const controller = buildController({ runHost });
    const transport = await startRpcServer({ socketPath: join(dir, "runner-host.sock"), methods: controller.methods });
    controller.attachServer(transport);
    const observer = await connectRpcClient(join(dir, "runner-host.sock"));
    const relayed: RunnerEvent[] = [];
    observer.on("hsr.event", (payload) => {
      const event = (payload as { event?: RunnerEvent } | undefined)?.event;
      if (event) relayed.push(event);
    });
    const base = {
      bee,
      launchId: randomUUID(),
      consumerId,
      kind: "stub",
      cwd: process.cwd(),
      home: join(dir, "stub-home"),
      sessionId: "refresh-pages-session",
      creds: {
        files: [{
          homeRelPath: "credential.json",
          contentB64: Buffer.from("old").toString("base64"),
          mode: 0o600,
        }],
      },
      spec: { command: process.execPath, args: [], env: {} },
    };
    const launched = authority(await controller.methods.spawn!(base, CTX));
    const observed = await controller.methods.observe!({ bee, consumerId, ...launched }, CTX) as { ok?: boolean; error?: string };
    assert.equal(observed.ok, true, observed.error);

    const refreshed = await controller.methods.refreshCreds!({
      bee,
      ...launched,
      creds: {
        files: [{
          homeRelPath: "credential.json",
          contentB64: Buffer.from("new").toString("base64"),
          mode: 0o600,
        }],
      },
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(refreshed.ok, true, refreshed.error);
    assert.equal(starts, 2);
    const successor = await currentAnswerHost(bee);
    const successorEpochs = relayed.filter((event) => event.type === "host_epoch" && event.host?.startedAt === successor.startedAt);
    assert.equal(successorEpochs.length, 1, "the successor boundary survives a predecessor suffix spanning multiple replay pages");
    assert.equal(relayed.some((event) => event.type === "text" && event.text.startsWith("predecessor-")), false);

    observer.close();
    controller.beginClose();
    await beeHost?.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  });
});

test("credential refresh stops and confirms a source integrity receipt that appears during teardown without launching B", async () => {
  await withTempStore(async (dir) => {
    const bee = "refresh-source-event-integrity";
    const fingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(fingerprint);
    let starts = 0;
    let credentialErases = 0;
    let firstHost: HsrAnswerHostIdentity | undefined;
    const runHost: Awaited<ReturnType<typeof fakeRunHost>> = async (params) => {
      starts += 1;
      const startedAt = new Date(Date.now() + starts).toISOString();
      const running = {
        bee: params.bee,
        harness: params.adapter.harness,
        tier: params.adapter.tier(),
        sessionId: params.opts.sessionId ?? "refresh-source-session",
        hostPid: process.pid,
        hostFingerprint: fingerprint,
        childAdmission: "none" as const,
        startedAt,
        runningAt: startedAt,
        controlSocket: hsrControlSocketPath(params.bee),
        status: "running" as const,
      };
      await writeHsrMeta(params.bee, running);
      const host = { hostPid: running.hostPid, startedAt, hostFingerprint: fingerprint };
      if (starts === 1) firstHost = host;
      return {
        bee: params.bee,
        controlSocket: running.controlSocket,
        done: new Promise<void>(() => undefined),
        async stop() {
          if (starts === 1) {
            assert.ok(params.runtimeAuthority);
            await persistHsrEventIntegrityFailure({
              bee: params.bee,
              host,
              remoteAuthority: {
                launchId: params.runtimeAuthority.remoteLaunchId,
                incarnation: params.runtimeAuthority.remoteIncarnation,
              },
              deliveryIds: [],
              reason: "source append failed while refresh stop drained",
            });
          }
          await writeHsrMeta(params.bee, {
            ...running,
            status: "exited",
            endedAt: new Date().toISOString(),
          });
        },
      };
    };
    const controller = buildController({
      runHost,
      shredCredentials: async () => { credentialErases += 1; },
    });
    const spawned = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      home: join(dir, "refresh-source-home"),
      sessionId: "refresh-source-session",
      creds: { files: [{ homeRelPath: "credential.json", contentB64: Buffer.from("old").toString("base64"), mode: 0o600 }] },
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));

    const refreshed = await controller.methods.refreshCreds!({
      bee,
      ...spawned,
      creds: { files: [{ homeRelPath: "credential.json", contentB64: Buffer.from("new").toString("base64"), mode: 0o600 }] },
    }, CTX) as { ok?: boolean; pending?: boolean; stopUnconfirmed?: boolean; error?: string };
    assert.equal(refreshed.ok, false);
    assert.equal(refreshed.pending, true);
    assert.equal(refreshed.stopUnconfirmed, true);
    assert.match(refreshed.error ?? "", /unresolved event history/);
    assert.equal(starts, 1, "refresh dispatches no successor host across A's integrity fence");
    assert.equal(credentialErases, 0, "old/fresh credentials are untouched until event loss is reconciled");
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(receipt?.stopState, "confirmed", "strict A host/child stop upgrades only A's exact receipt");
    assert.deepEqual(receipt?.host, firstHost);
    assert.equal(receipt?.remoteAuthority?.launchId, spawned.launchId);
    assert.equal(receipt?.remoteAuthority?.incarnation, spawned.incarnation);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.refreshPhase, "stopping");
    // Unresolved source authority intentionally makes controller shutdown
    // fail closed; temp-store teardown owns this fixture.
  });
});

test("remote authority recreates its persisted default cwd for a replacement generation", async () => {
  await withTempStore(async () => {
    let starts = 0;
    const runHost = await fakeRunHost(async () => { starts += 1; });
    const controller = buildController({ runHost });
    const bee = "default-cwd-replacement";
    const firstLaunchId = randomUUID();
    const base = {
      bee,
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      spec: { command: process.execPath, args: [], env: {} },
    };

    const firstResult = await controller.methods.spawn!({
      ...base,
      launchId: firstLaunchId,
    }, CTX) as { ok?: boolean; cwd?: string; launchId?: string; incarnation?: string; error?: string };
    assert.equal(firstResult.ok, true, firstResult.error);
    assert.equal(firstResult.cwd, join(hsrRunDir(bee), "cwd"));
    assert.equal(existsSync(firstResult.cwd!), true);
    assert.equal((await controller.methods.kill!({
      bee,
      launchId: firstResult.launchId,
      incarnation: firstResult.incarnation,
    }, CTX) as { ok?: boolean }).ok, true);
    assert.equal(existsSync(hsrRunDir(bee)), false, "exact stop removes the authority-owned cwd");

    const secondResult = await controller.methods.spawn!({
      ...base,
      launchId: randomUUID(),
      previousLaunchId: firstLaunchId,
      cwd: firstResult.cwd,
    }, CTX) as { ok?: boolean; cwd?: string; launchId?: string; incarnation?: string; error?: string };
    assert.equal(secondResult.ok, true, secondResult.error);
    assert.equal(secondResult.cwd, firstResult.cwd);
    assert.equal(existsSync(secondResult.cwd!), true, "persisted authority cwd is recreated before replacement start");
    assert.equal(starts, 2);

    assert.equal((await controller.methods.kill!({
      bee,
      launchId: secondResult.launchId,
      incarnation: secondResult.incarnation,
    }, CTX) as { ok?: boolean }).ok, true);
    await controller.close();
  });
});

test("a dispatching receipt replays as unresolved and never forks without exact proof", async () => {
  await withTempStore(async (dir) => {
    let starts = 0;
    const runHost = await fakeRunHost(async () => { starts += 1; });
    const controller = buildController({ runHost });
    const bee = "dispatch-crash";
    const launchId = randomUUID();
    const incarnation = randomUUID();
    const params = {
      bee,
      launchId,
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId,
      incarnation,
      requestDigest: requestDigest(params),
      state: "dispatching",
      createdAt: new Date().toISOString(),
      cwd: process.cwd(),
      tier: "stream",
    });
    const replay = await controller.methods.spawn!(params, CTX) as { ok?: boolean; pending?: boolean; error?: string };
    assert.equal(replay.ok, false);
    assert.equal(replay.pending, true);
    assert.match(replay.error ?? "", /dispatch outcome is unresolved/);
    assert.equal(starts, 0);
    const killed = await controller.methods.kill!({ bee, launchId, incarnation }, CTX) as { ok?: boolean; error?: string };
    assert.equal(killed.ok, false, `dispatch ambiguity must stay fenced in ${dir}`);
    assert.match(killed.error ?? "", /dispatch may have escaped/);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopping");
    const retry = await controller.methods.kill!({ bee, launchId, incarnation }, CTX) as { ok?: boolean };
    assert.equal(retry.ok, false, "a retry cannot fabricate proof from the stopping phase");
    await assert.rejects(controller.close(), /unconfirmed HSR runtimes/);
  });
});

test("kill arriving before an unseen spawn durably cancels that exact launch id", async () => {
  await withTempStore(async () => {
    let starts = 0;
    const controller = buildController({ runHost: await fakeRunHost(async () => { starts += 1; }) });
    const bee = "kill-before-first-spawn";
    const launchId = randomUUID();
    const cancelled = await controller.methods.kill!({ bee, launchId }, { ...CTX, connectionId: 41 }) as {
      ok?: boolean;
      incarnationStopped?: boolean;
    };
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.incarnationStopped, true);
    const delayed = await controller.methods.spawn!({
      bee,
      launchId,
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, { ...CTX, connectionId: 99 }) as { ok?: boolean; stopped?: boolean; error?: string };
    assert.equal(delayed.ok, false);
    assert.equal(delayed.stopped, true);
    assert.match(delayed.error ?? "", /cancelled before admission/);
    assert.equal(starts, 0);
    await controller.close();
  });
});

test("spawnReceipt cannot erase stopping doubt even when the old meta is still live", async () => {
  await withTempStore(async () => {
    const runHost = await fakeRunHost();
    const controller = buildController({ runHost });
    const bee = "stopping-receipt";
    const params = {
      bee,
      launchId: randomUUID(),
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };
    const current = authority(await controller.methods.spawn!(params, CTX));
    const stopped = await controller.methods.stop!({ bee, ...current }, CTX) as { ok?: boolean };
    assert.equal(stopped.ok, false, "fake host has no control socket server");
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopping");
    const queried = await controller.methods.spawnReceipt!({ bee, launchId: current.launchId }, CTX) as {
      ok?: boolean;
      pending?: boolean;
      error?: string;
    };
    assert.equal(queried.ok, false);
    assert.equal(queried.pending, true);
    assert.match(queried.error ?? "", /stopping/);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopping");
    assert.equal((await controller.methods.kill!({ bee, ...current }, CTX) as { ok?: boolean }).ok, true);
    await controller.close();
  });
});

test("a running receipt with missing runtime evidence never reforks on replay", async () => {
  await withTempStore(async () => {
    let firstStarts = 0;
    const first = buildController({ runHost: await fakeRunHost(async () => { firstStarts += 1; }) });
    const bee = "running-evidence-lost";
    const params = {
      bee,
      launchId: randomUUID(),
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };
    authority(await first.methods.spawn!(params, CTX));
    assert.equal(firstStarts, 1);
    // Simulate a serve crash: the in-memory handle vanishes with the process,
    // while the durable running receipt survives.
    await rm(join(process.env.HIVE_STORE_ROOT!, "hsr", bee), { recursive: true, force: true });

    let replayStarts = 0;
    const replayController = buildController({ runHost: await fakeRunHost(async () => { replayStarts += 1; }) });
    const replay = await replayController.methods.spawn!(params, CTX) as { ok?: boolean; pending?: boolean; error?: string };
    assert.equal(replay.ok, false);
    assert.equal(replay.pending, true);
    assert.match(replay.error ?? "", /unresolved running ownership/);
    assert.equal(replayStarts, 0);
    await assert.rejects(replayController.close(), /unconfirmed HSR runtimes/);
  });
});

test("stale running meta from a dead serve fences history and never publishes a successor", async () => {
  await withTempStore(async () => {
    const bee = "stale-running-meta";
    const launchId = randomUUID();
    const incarnation = randomUUID();
    const params = {
      bee,
      launchId,
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    };
    const hostFingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(hostFingerprint);
    const startedAt = new Date().toISOString();
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId,
      incarnation,
      requestDigest: requestDigest(params),
      state: "dispatching",
      createdAt: startedAt,
      cwd: process.cwd(),
      tier: "stream",
    });
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint,
      childAdmission: "none",
      startedAt,
      runningAt: startedAt,
      controlSocket: hsrControlSocketPath(bee),
      status: "running",
    });
    let starts = 0;
    const controller = buildController({
      runHost: await fakeRunHost(async () => { starts += 1; }),
      processSignals: {
        readProcessIdentity: async () => ({ pgid: process.pid, startedAt: "reused-host-pid" }),
      },
    });
    const receipt = await controller.methods.spawnReceipt!({ bee, launchId }, CTX) as {
      ok?: boolean;
      pending?: boolean;
      error?: string;
    };
    assert.equal(receipt.ok, false);
    assert.equal(receipt.pending, true);
    assert.match(receipt.error ?? "", /liveness is unconfirmed/);
    const replay = await controller.methods.spawn!(params, CTX) as { ok?: boolean; pending?: boolean; error?: string };
    assert.equal(replay.ok, false);
    assert.equal(replay.pending, true);
    assert.match(replay.error ?? "", /liveness is unconfirmed/);
    assert.equal(starts, 0);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "dispatching");
    await assert.rejects(controller.close(), /unconfirmed HSR runtimes/);
    const integrity = await readHsrEventIntegrityReceipt(bee);
    assert.equal(integrity?.stopState, "confirmed");
    assert.equal(integrity?.remoteAuthority?.launchId, launchId);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopping");
    assert.equal(existsSync(hsrRunDir(bee)), true, "ungraceful source history is never tombstoned");
  });
});

test("controller close fences admission, drains an in-flight spawn, then exact-stops it", async () => {
  await withTempStore(async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runHost = await fakeRunHost(async () => { enter(); await gate; });
    const controller = buildController({ runHost });
    const bee = "close-drain";
    const spawning = controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX);
    await entered;
    let closed = false;
    const closing = controller.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    const rejected = await controller.methods.liveness!(undefined, CTX) as { ok?: boolean; error?: string };
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /closing/);
    release();
    const spawned = authority(await spawning);
    await closing;
    assert.equal(await readHsrMetaStrict(bee), null);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopped");

    let restarts = 0;
    const replacement = buildController({ runHost: await fakeRunHost(async () => { restarts += 1; }) });
    const next = authority(await replacement.methods.spawn!({
      bee,
      launchId: randomUUID(),
      previousLaunchId: spawned.launchId,
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    assert.equal(restarts, 1, "successful close leaves a reusable stopped authority head");
    assert.equal((await replacement.methods.kill!({ bee, ...next }, CTX) as { ok?: boolean }).ok, true);
    await replacement.close();
  });
});

test("controller close persists stopping before a teardown failure", async () => {
  await withTempStore(async () => {
    const controller = buildController({
      runHost: await fakeRunHost(),
      shredCredentials: async () => { throw new Error("injected close erasure failure"); },
    });
    const bee = "close-stop-doubt";
    const spawned = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    await assert.rejects(controller.close(), /unconfirmed HSR runtimes/);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopping");
    assert.equal(await readHsrMetaStrict(bee).then((meta) => meta?.status), "exited");

    const recovery = buildController();
    assert.equal((await recovery.methods.kill!({ bee, ...spawned }, CTX) as { ok?: boolean }).ok, true);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopped");
    assert.equal(await readHsrMetaStrict(bee), null);
    await recovery.close();
  });
});

test("a restarted controller close stops but preserves an unclosed durable generation", async () => {
  await withTempStore(async () => {
    const bee = "restart-close-running";
    const launchId = randomUUID();
    const incarnation = randomUUID();
    const startedAt = new Date().toISOString();
    const hostPid = 987_654;
    const hostFingerprint = { pgid: hostPid, startedAt };
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid,
      hostFingerprint,
      childAdmission: "none",
      startedAt,
      runningAt: startedAt,
      controlSocket: hsrControlSocketPath(bee),
      status: "running",
    });
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId,
      incarnation,
      requestDigest: createHash("sha256").update("restart-close-running").digest("hex"),
      state: "running",
      createdAt: startedAt,
      cwd: process.cwd(),
      tier: "stream",
      host: { hostPid, startedAt, hostFingerprint },
    });

    const restarted = buildController({
      processSignals: { readProcessIdentity: async () => null },
    });
    await assert.rejects(restarted.close(), /unconfirmed HSR runtimes/);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopping");
    const integrity = await readHsrEventIntegrityReceipt(bee);
    assert.equal(integrity?.stopState, "confirmed");
    assert.equal(integrity?.remoteAuthority?.launchId, launchId);
    assert.equal(existsSync(hsrRunDir(bee)), true, "manual event-history authority survives controller restart cleanup");
  });
});

test("direct remote kill exact-stops but never tombstones a dead source without terminal proof", async () => {
  await withTempStore(async () => {
    const bee = "direct-kill-unclosed-source";
    const launchId = randomUUID();
    const incarnation = randomUUID();
    const startedAt = new Date().toISOString();
    const hostPid = 987_655;
    const hostFingerprint = { pgid: hostPid, startedAt };
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid,
      hostFingerprint,
      childAdmission: "none",
      startedAt,
      runningAt: startedAt,
      controlSocket: hsrControlSocketPath(bee),
      status: "running",
    });
    await appendHsrEvent(bee, {
      type: "host_epoch",
      ts: Date.now(),
      host: { hostPid, startedAt, hostFingerprint },
    });
    await appendHsrEvent(bee, {
      type: "text",
      ts: Date.now() + 1,
      text: "provider output without a terminal exit",
      host: { hostPid, startedAt, hostFingerprint },
    });
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId,
      incarnation,
      requestDigest: createHash("sha256").update("direct-kill-unclosed-source").digest("hex"),
      state: "running",
      createdAt: startedAt,
      cwd: process.cwd(),
      tier: "stream",
      host: { hostPid, startedAt, hostFingerprint },
    });

    const controller = buildController({
      processSignals: { readProcessIdentity: async () => null },
    });
    const killed = await controller.methods.kill!({ bee, launchId, incarnation }, CTX) as {
      ok?: boolean;
      error?: string;
    };
    assert.equal(killed.ok, false);
    assert.match(killed.error ?? "", /unresolved event history|event history/i);
    const integrity = await readHsrEventIntegrityReceipt(bee);
    assert.equal(integrity?.phase, "unresolved");
    assert.equal(integrity?.stopState, "confirmed", "physical host/group absence confirms only cleanup, never clean history");
    assert.equal(integrity?.remoteAuthority?.launchId, launchId);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopping");
    assert.equal(existsSync(hsrRunDir(bee)), true, "direct kill preserves the manual event-history authority and source bytes");
    await assert.rejects(controller.close(), /unconfirmed HSR runtimes/);
  });
});

test("remote kill retains a blocked consumer's terminal suffix until its final durable ack", async () => {
  await withTempStore(async () => {
    const bee = "kill-retains-terminal-suffix";
    const consumerId = "blocked-terminal-mirror";
    const secondConsumerId = "second-slow-terminal-mirror";
    const controller = buildController({ runHost: await fakeRunHost() });
    const launched = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    // The fake host intentionally omits runHsrHost's pre-admission seam. Admit
    // the controller explicitly, then leave its callback/cursor at zero while
    // kill appends and seals the terminal exit.
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    await markHsrConsumerSubscribedStrict(bee, secondConsumerId);

    const killed = await controller.methods.kill!({ bee, ...launched }, CTX) as {
      ok?: boolean;
      incarnationStopped?: boolean;
      terminalHistoryPending?: boolean;
      error?: string;
    };
    assert.equal(killed.ok, false);
    assert.equal(killed.incarnationStopped, true);
    assert.equal(killed.terminalHistoryPending, true);
    assert.match(killed.error ?? "", /terminal event history.*acknowledge/i);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopped");
    assert.equal(existsSync(hsrRunDir(bee)), true, "stopped bytes survive the blocked mirror callback");

    const listed = await controller.methods.list!(undefined, CTX) as Array<Record<string, unknown>>;
    assert.equal(listed.some((row) => row.bee === bee && row.status === "exited"), true);
    const replay = await controller.methods.events!({
      bee,
      consumerId,
      afterSeq: 0,
      launchId: launched.launchId,
      incarnation: launched.incarnation,
    }, CTX) as { ok?: boolean; events?: RunnerEvent[]; throughSeq?: number; hasMore?: boolean };
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.events?.map((event) => event.type), ["host_epoch", "exit"]);
    assert.equal(replay.throughSeq, 2);
    assert.equal(replay.hasMore, false);

    const partialAck = await controller.methods.ackEvents!({
      bee,
      consumerId,
      upToSeq: 1,
      launchId: launched.launchId,
      incarnation: launched.incarnation,
    }, CTX) as { ok?: boolean; ackedSeq?: number };
    assert.deepEqual(partialAck, { ok: true, ackedSeq: 1 });
    assert.equal(existsSync(hsrRunDir(bee)), true, "an intermediate ack cannot erase the terminal event");

    const finalAck = await controller.methods.ackEvents!({
      bee,
      consumerId,
      upToSeq: 2,
      terminalActivated: true,
      launchId: launched.launchId,
      incarnation: launched.incarnation,
    }, CTX) as { ok?: boolean; ackedSeq?: number };
    assert.deepEqual(finalAck, { ok: true, ackedSeq: 2 });
    assert.equal(existsSync(hsrRunDir(bee)), true, "one caught-up consumer cannot erase another consumer's terminal suffix");

    // Model receipt head success followed by per-launch history failure. A
    // retry sees an already-present activation in the head, but must still
    // rewrite both copies before the remaining consumer can release history.
    const activatedReceipt = await readRemoteHsrLaunchReceiptStrict(bee);
    assert.ok(activatedReceipt?.terminalConsumerActivations?.[consumerId]);
    const { terminalConsumerActivations: _activation, ...staleHistory } = activatedReceipt;
    await writeRemoteHsrLaunchReceipt(staleHistory);
    await writeFile(
      remoteHsrLaunchReceiptPath(bee),
      `${JSON.stringify(activatedReceipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    const healedRetry = await controller.methods.ackEvents!({
      bee,
      consumerId,
      upToSeq: 2,
      terminalActivated: true,
      launchId: launched.launchId,
      incarnation: launched.incarnation,
    }, CTX) as { ok?: boolean; ackedSeq?: number };
    assert.deepEqual(healedRetry, { ok: true, ackedSeq: 2 });
    assert.equal(
      (await readRemoteHsrLaunchHistoryStrict(bee, launched.launchId))
        ?.terminalConsumerActivations?.[consumerId]?.throughSeq,
      2,
    );

    const lastConsumerAck = await controller.methods.ackEvents!({
      bee,
      consumerId: secondConsumerId,
      upToSeq: 2,
      terminalActivated: true,
      launchId: launched.launchId,
      incarnation: launched.incarnation,
    }, CTX) as { ok?: boolean; ackedSeq?: number };
    assert.deepEqual(lastConsumerAck, { ok: true, ackedSeq: 2 });
    assert.equal(existsSync(hsrRunDir(bee)), false, "the minimum final durable ack reclaims stopped source state");
    assert.equal((await controller.methods.list!(undefined, CTX) as Array<Record<string, unknown>>)
      .some((row) => row.bee === bee), false);
    await controller.close();
  });
});

test("a stopped exact-page terminal replay activates before its final ack reclaims source history", async () => {
  await withTempStore(async () => {
    const bee = "terminal-exact-page-activation";
    const remoteNode = node();
    const secondRemoteNode = node({ name: "authority-second-controller" });
    const consumerId = `hive-observer-v1:${createHash("sha256")
      .update(JSON.stringify([machineId(), remoteNode.name]))
      .digest("hex")}`;
    const secondConsumerId = `hive-observer-v1:${createHash("sha256")
      .update(JSON.stringify([machineId(), secondRemoteNode.name]))
      .digest("hex")}`;
    const controller = buildController({ runHost: await fakeRunHost() });
    const launched = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    for (let index = 1; index < HSR_EVENT_REPLAY_PAGE_MAX_EVENTS - 1; index += 1) {
      await appendHsrEvent(bee, { type: "text", ts: index + 1, text: `terminal-page-${index}` });
    }
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    await markHsrConsumerSubscribedStrict(bee, secondConsumerId);
    const killed = await controller.methods.kill!({ bee, ...launched }, CTX) as {
      ok?: boolean;
      terminalHistoryPending?: boolean;
    };
    assert.equal(killed.ok, false);
    assert.equal(killed.terminalHistoryPending, true);
    // More ignorable framing than one page's bounded EOF lookahead forces a
    // continuation after the terminal seq. Its intermediate ack must retain
    // the stopped source until the controller reaches EOF and activates.
    await appendFile(
      hsrEventsPath(bee),
      "\n".repeat(HSR_EVENT_REPLAY_PAGE_MAX_EVENTS + 1),
      "utf8",
    );

    // A second controller can complete and durably activate the same terminal
    // generation first; its proof must not authorize deletion while A has only
    // a page-progress ack.
    const secondSubstrate = createRemoteHsrSubstrate(secondRemoteNode, {
      connect: async () => fakeClient(async (method, params) => {
        const handler = controller.methods[method];
        if (!handler) throw new Error(`unexpected remote method ${method}`);
        return handler(params, CTX);
      }),
    });
    let secondActivated = 0;
    await secondSubstrate.replayTerminalEvents(
      bee,
      () => undefined,
      { remoteLaunchId: launched.launchId, remoteIncarnation: launched.incarnation },
      0,
      () => { secondActivated += 1; },
    );
    assert.equal(secondActivated, 1);
    assert.equal(existsSync(hsrRunDir(bee)), true, "one consumer's activation cannot release another consumer");
    await secondSubstrate.close();

    // Model a controller that durably projects the full event page and sends
    // its ordinary progress ack, then the remote serve crashes before the
    // whitespace continuation reaches EOF/afterSynchronized.
    const firstPage = await controller.methods.events!({
      bee,
      consumerId,
      afterSeq: 0,
      launchId: launched.launchId,
      incarnation: launched.incarnation,
    }, CTX) as {
      ok?: boolean;
      events?: RunnerEvent[];
      throughSeq?: number;
      hasMore?: boolean;
      pageToken?: string;
    };
    assert.equal(firstPage.ok, true);
    assert.equal(firstPage.events?.length, HSR_EVENT_REPLAY_PAGE_MAX_EVENTS);
    assert.equal(firstPage.throughSeq, HSR_EVENT_REPLAY_PAGE_MAX_EVENTS);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.pageToken);
    const progressAck = await controller.methods.ackEvents!({
      bee,
      consumerId,
      upToSeq: HSR_EVENT_REPLAY_PAGE_MAX_EVENTS,
      launchId: launched.launchId,
      incarnation: launched.incarnation,
    }, CTX) as { ok?: boolean; ackedSeq?: number };
    assert.deepEqual(progressAck, { ok: true, ackedSeq: HSR_EVENT_REPLAY_PAGE_MAX_EVENTS });
    await __testOnlyClearHsrEventReplaySessions();
    await controller.close();
    const restartedController = buildController({ runHost: await fakeRunHost() });

    const repeatedKill = await restartedController.methods.kill!({ bee, ...launched }, CTX) as {
      ok?: boolean;
      terminalHistoryPending?: boolean;
      pendingConsumers?: Array<{ consumerId: string; ackedSeq: number; throughSeq: number }>;
    };
    assert.equal(repeatedKill.ok, false);
    assert.equal(repeatedKill.terminalHistoryPending, true);
    assert.deepEqual(repeatedKill.pendingConsumers, [{
      consumerId,
      ackedSeq: HSR_EVENT_REPLAY_PAGE_MAX_EVENTS,
      throughSeq: HSR_EVENT_REPLAY_PAGE_MAX_EVENTS,
    }]);
    assert.equal(existsSync(hsrRunDir(bee)), true, "serve restart cannot turn a progress ack into activation proof");

    const substrate = createRemoteHsrSubstrate(remoteNode, {
      connect: async () => fakeClient(async (method, params) => {
        const handler = restartedController.methods[method];
        if (!handler) throw new Error(`unexpected remote method ${method}`);
        return handler(params, CTX);
      }),
    });
    const projected: number[] = [];
    let activated = 0;
    await substrate.replayTerminalEvents(
      bee,
      (event) => { projected.push(Number(event.seq)); },
      { remoteLaunchId: launched.launchId, remoteIncarnation: launched.incarnation },
      HSR_EVENT_REPLAY_PAGE_MAX_EVENTS,
      () => {
        activated += 1;
        assert.equal(existsSync(hsrRunDir(bee)), true, "terminal activation precedes the reclaiming final ack");
      },
    );
    assert.deepEqual(projected, []);
    assert.equal(activated, 1);
    assert.equal(existsSync(hsrRunDir(bee)), false, "the post-activation final ack reclaims the stopped source");

    await substrate.close();
    await restartedController.close();
  });
});

test("terminal replay heals a landed high-water before cursor admission and final activation", async () => {
  await withTempStore(async () => {
    const bee = "terminal-sidecar-lag-cursor-high";
    const remoteNode = node();
    const consumerId = `hive-observer-v1:${createHash("sha256")
      .update(JSON.stringify([machineId(), remoteNode.name]))
      .digest("hex")}`;
    const controller = buildController({ runHost: await fakeRunHost() });
    const launched = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    const killed = await controller.methods.kill!({ bee, ...launched }, CTX) as {
      ok?: boolean;
      terminalHistoryPending?: boolean;
    };
    assert.equal(killed.ok, false);
    assert.equal(killed.terminalHistoryPending, true);

    // The controller already projected the terminal seq=2, but the source's
    // best-effort sidecar persisted only seq=1 before serve/process restart.
    // Exact source bytes/proof must heal that high-water before events(after=2)
    // judges the cursor; otherwise terminal activation can never be finalized.
    const state = JSON.parse(await readFile(hsrSeqPath(bee), "utf8")) as {
      lastSeq: number;
      consumers?: Record<string, { ackedSeq?: number }>;
      consumerRevision?: number;
    };
    assert.equal(state.lastSeq, 2);
    await writeFile(hsrSeqPath(bee), `${JSON.stringify({
      ...state,
      lastSeq: 1,
      consumers: { ...state.consumers, [consumerId]: { ackedSeq: 1 } },
    })}\n`, { mode: 0o600 });
    forgetHsrRunState(bee);

    const substrate = createRemoteHsrSubstrate(remoteNode, {
      connect: async () => fakeClient(async (method, params) => {
        const handler = controller.methods[method];
        if (!handler) throw new Error(`unexpected remote method ${method}`);
        return handler(params, CTX);
      }),
    });
    const projected: number[] = [];
    let activations = 0;
    await substrate.replayTerminalEvents(
      bee,
      (event) => { projected.push(Number(event.seq)); },
      { remoteLaunchId: launched.launchId, remoteIncarnation: launched.incarnation },
      2,
      () => {
        activations += 1;
        assert.equal(existsSync(hsrRunDir(bee)), true, "activation precedes the final reclaiming ack");
      },
    );
    assert.deepEqual(projected, []);
    assert.equal(activations, 1);
    assert.equal(existsSync(hsrRunDir(bee)), false);
    assert.equal(
      (await readRemoteHsrLaunchReceiptStrict(bee))?.terminalConsumerActivations?.[consumerId]?.throughSeq,
      2,
    );

    await substrate.close();
    await controller.close();
  });
});

test("a lost post-activation final-ack reply retries from the stopped receipt after source reclaim", async () => {
  await withTempStore(async () => {
    const bee = "terminal-final-ack-reply-loss";
    const remoteNode = node();
    const consumerId = `hive-observer-v1:${createHash("sha256")
      .update(JSON.stringify([machineId(), remoteNode.name]))
      .digest("hex")}`;
    const controller = buildController({ runHost: await fakeRunHost() });
    const launched = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    const killed = await controller.methods.kill!({ bee, ...launched }, CTX) as {
      ok?: boolean;
      terminalHistoryPending?: boolean;
    };
    assert.equal(killed.ok, false);
    assert.equal(killed.terminalHistoryPending, true);

    let loseFinalReply = true;
    const substrate = createRemoteHsrSubstrate(remoteNode, {
      connect: async () => fakeClient(async (method, params) => {
        const handler = controller.methods[method];
        if (!handler) throw new Error(`unexpected remote method ${method}`);
        const result = await handler(params, CTX);
        if (
          method === "ackEvents"
          && (params as { terminalActivated?: unknown } | undefined)?.terminalActivated === true
          && loseFinalReply
        ) {
          loseFinalReply = false;
          throw new Error("simulated lost final-ack reply");
        }
        return result;
      }),
    });
    const firstProjection: number[] = [];
    let activations = 0;
    await assert.rejects(
      substrate.replayTerminalEvents(
        bee,
        (event) => { firstProjection.push(Number(event.seq)); },
        { remoteLaunchId: launched.launchId, remoteIncarnation: launched.incarnation },
        0,
        () => { activations += 1; },
      ),
      /simulated lost final-ack reply/,
    );
    assert.deepEqual(firstProjection, [1, 2]);
    assert.equal(activations, 1);
    assert.equal(existsSync(hsrRunDir(bee)), false, "activation proof precedes reclaim even when its reply is lost");
    assert.equal(
      (await readRemoteHsrLaunchReceiptStrict(bee))?.terminalConsumerActivations?.[consumerId]?.throughSeq,
      2,
    );

    const retryProjection: number[] = [];
    await substrate.replayTerminalEvents(
      bee,
      (event) => { retryProjection.push(Number(event.seq)); },
      { remoteLaunchId: launched.launchId, remoteIncarnation: launched.incarnation },
      2,
      () => { activations += 1; },
    );
    assert.deepEqual(retryProjection, []);
    assert.equal(activations, 2);

    await substrate.close();
    await controller.close();
  });
});

test("remote kill reports a stale consumer and explicit reconcile audits loss before reclaim and name reuse", async () => {
  await withTempStore(async () => {
    const bee = "kill-reports-stale-consumer";
    const consumerId = "retired-controller-consumer";
    const controller = buildController({ runHost: await fakeRunHost() });
    const launched = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId,
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    await markHsrConsumerSubscribedStrict(bee, consumerId);

    const killed = await controller.methods.kill!({ bee, ...launched }, CTX) as {
      ok?: boolean;
      incarnationStopped?: boolean;
      terminalHistoryPending?: boolean;
      pendingConsumers?: Array<{ consumerId: string; ackedSeq: number; throughSeq: number }>;
      error?: string;
    };
    assert.equal(killed.ok, false);
    assert.equal(killed.incarnationStopped, true);
    assert.equal(killed.terminalHistoryPending, true);
    assert.deepEqual(killed.pendingConsumers, [{ consumerId, ackedSeq: 0, throughSeq: 2 }]);
    assert.match(
      killed.error ?? "",
      new RegExp(`hive hsr-reconcile ${bee} --discard-consumer ${consumerId}`),
    );

    const listed = await controller.methods.list!(undefined, CTX) as Array<{
      bee?: string;
      pendingConsumers?: Array<{ consumerId: string; ackedSeq: number; throughSeq: number }>;
    }>;
    assert.deepEqual(
      listed.find((row) => row.bee === bee)?.pendingConsumers,
      [{ consumerId, ackedSeq: 0, throughSeq: 2 }],
      "the normal list surface preserves the same actionable consumer progress",
    );

    const substrate = createRemoteHsrSubstrate(node(), {
      connect: async () => fakeClient(async (method, params) => {
        const handler = controller.methods[method];
        if (!handler) throw new Error(`unexpected remote method ${method}`);
        return handler(params, CTX);
      }),
    });
    const discarded = await substrate.discardEventConsumerRemote(bee, consumerId, {
      remoteLaunchId: launched.launchId,
      remoteIncarnation: launched.incarnation,
    });
    assert.deepEqual(discarded, {
      ackedSeq: 0,
      throughSeq: 2,
      lostFromSeq: 1,
      lostToSeq: 2,
      reclaimed: true,
    });
    assert.equal(existsSync(hsrRunDir(bee)), false, "the stopped source is reclaimable after explicit loss settlement");

    const evidence = JSON.parse(await readFile(
      hsrEventConsumerDiscardEvidencePath(bee, launched, consumerId),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(evidence.bee, bee);
    assert.equal(evidence.consumerId, consumerId);
    assert.deepEqual(evidence.authority, launched);
    assert.equal(evidence.lostFromSeq, 1);
    assert.equal(evidence.lostToSeq, 2);

    assert.deepEqual(
      await substrate.discardEventConsumerRemote(bee, consumerId, {
        remoteLaunchId: launched.launchId,
        remoteIncarnation: launched.incarnation,
      }),
      discarded,
      "a lost successful reconcile reply retries from purge-surviving evidence",
    );

    const successor = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      previousLaunchId: launched.launchId,
      consumerId: "successor-controller-consumer",
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    assert.notEqual(successor.launchId, launched.launchId);
    assert.equal((await controller.methods.kill!({ bee, ...successor }, CTX) as { ok?: boolean }).ok, true);
    await substrate.close();
    await controller.close();
  });
});

test("a lagging legacy single-consumer watermark is reported and explicitly discardable", async () => {
  await withTempStore(async () => {
    const bee = "kill-reports-legacy-consumer";
    const controller = buildController({ runHost: await fakeRunHost() });
    const launched = authority(await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: "legacy-upgrade-bootstrap-controller",
      kind: "stub",
      cwd: process.cwd(),
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    await writeFile(hsrSeqPath(bee), `${JSON.stringify({ lastSeq: 1, subscribed: true, ackedSeq: 1 })}\n`, { mode: 0o600 });

    const killed = await controller.methods.kill!({ bee, ...launched }, CTX) as {
      ok?: boolean;
      terminalHistoryPending?: boolean;
      pendingConsumers?: Array<{ consumerId: string; ackedSeq: number; throughSeq: number }>;
      error?: string;
    };
    assert.equal(killed.ok, false);
    assert.equal(killed.terminalHistoryPending, true);
    assert.deepEqual(killed.pendingConsumers, [{
      consumerId: HSR_LEGACY_EVENT_CONSUMER_ID,
      ackedSeq: 1,
      throughSeq: 2,
    }]);
    assert.match(
      killed.error ?? "",
      new RegExp(`--discard-consumer ${HSR_LEGACY_EVENT_CONSUMER_ID}`),
    );

    const substrate = createRemoteHsrSubstrate(node(), {
      connect: async () => fakeClient(async (method, params) => {
        const handler = controller.methods[method];
        if (!handler) throw new Error(`unexpected remote method ${method}`);
        return handler(params, CTX);
      }),
    });
    assert.deepEqual(
      await substrate.discardEventConsumerRemote(bee, HSR_LEGACY_EVENT_CONSUMER_ID, {
        remoteLaunchId: launched.launchId,
        remoteIncarnation: launched.incarnation,
      }),
      { ackedSeq: 1, throughSeq: 2, lostFromSeq: 2, lostToSeq: 2, reclaimed: true },
    );
    assert.equal(existsSync(hsrRunDir(bee)), false);
    await substrate.close();
    await controller.close();
  });
});

test("a restarted controller close fails closed on unresolved dispatch authority", async () => {
  await withTempStore(async () => {
    const bee = "restart-close-dispatching";
    await writeRemoteHsrLaunchReceipt({
      version: REMOTE_HSR_SAFETY_PROTOCOL,
      bee,
      launchId: randomUUID(),
      incarnation: randomUUID(),
      requestDigest: createHash("sha256").update("restart-close-dispatching").digest("hex"),
      state: "dispatching",
      createdAt: new Date().toISOString(),
      cwd: process.cwd(),
      tier: "stream",
    });

    await assert.rejects(buildController().close(), /unconfirmed HSR runtimes/);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopping");
  });
});

test("a restarted controller close refuses an unowned legacy run directory", async () => {
  await withTempStore(async () => {
    const bee = "restart-close-raw-run-dir";
    await mkdir(hsrRunDir(bee), { recursive: true });

    await assert.rejects(buildController().close(), /unconfirmed HSR runtimes/);
    assert.equal(existsSync(hsrRunDir(bee)), true, "unproved run state is preserved for operator reconciliation");
  });
});

test("refresh dispatch crash binds the successor without reforking and remains exactly killable", async () => {
  await withTempStore(async () => {
    let starts = 0;
    const original = buildController({ runHost: await fakeRunHost(async () => { starts += 1; }) });
    const bee = "refresh-successor-bind";
    const spawned = authority(await original.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: TEST_CONSUMER_ID,
      kind: "stub",
      cwd: process.cwd(),
      sessionId: "thread-refresh-successor",
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX));
    const current = await readRemoteHsrLaunchReceiptStrict(bee);
    const oldMeta = await readHsrMetaStrict(bee);
    assert.ok(current?.host);
    assert.ok(oldMeta?.hostFingerprint);
    const { host: sourceHost, ...unbound } = current;
    await writeRemoteHsrLaunchReceipt({
      ...unbound,
      state: "refreshing",
      refreshPhase: "dispatching",
      refreshSourceHost: sourceHost,
    });
    const successorStartedAt = new Date(Date.now() + 1_000).toISOString();
    await writeHsrMeta(bee, {
      ...oldMeta,
      startedAt: successorStartedAt,
      runningAt: successorStartedAt,
      status: "running",
    });
    const successorHost = {
      hostPid: oldMeta.hostPid,
      startedAt: successorStartedAt,
      hostFingerprint: oldMeta.hostFingerprint,
    };
    await appendHsrEvent(bee, { type: "host_epoch", ts: Date.now(), host: successorHost });

    const staleRecovery = buildController({
      runHost: await fakeRunHost(async () => { starts += 1; }),
      processSignals: {
        readProcessIdentity: async () => ({ pgid: process.pid, startedAt: "not-the-current-host" }),
      },
    });
    const refreshRequest = {
      bee,
      ...spawned,
      creds: { files: [{ homeRelPath: "fresh.json", contentB64: Buffer.from("fresh").toString("base64"), mode: 0o600 }] },
    };
    const staleReplay = await staleRecovery.methods.refreshCreds!(refreshRequest, CTX) as {
      ok?: boolean;
      stopUnconfirmed?: boolean;
      error?: string;
    };
    assert.equal(staleReplay.ok, false);
    assert.equal(staleReplay.stopUnconfirmed, true);
    assert.match(staleReplay.error ?? "", /liveness is unconfirmed/);
    assert.equal(starts, 1);
    const recovery = buildController({ runHost: await fakeRunHost(async () => { starts += 1; }) });
    const replay = await recovery.methods.refreshCreds!(refreshRequest, CTX) as { ok?: boolean; error?: string };
    assert.equal(replay.ok, true, replay.error);
    assert.equal(starts, 1, "recovery binds the already-started successor instead of starting again");
    const rebound = await readRemoteHsrLaunchReceiptStrict(bee);
    assert.equal(rebound?.state, "running");
    assert.equal(rebound?.host?.startedAt, successorStartedAt);
    const killer = buildController({
      processSignals: {
        readProcessIdentity: async () => ({ pgid: process.pid, startedAt: "not-the-current-host" }),
      },
    });
    await appendHsrEvent(bee, { type: "exit", ts: Date.now(), code: 0, host: successorHost });
    assert.equal((await killer.methods.kill!({ bee, ...spawned }, CTX) as { ok?: boolean }).ok, true);
    assert.equal((await readRemoteHsrLaunchReceiptStrict(bee))?.state, "stopped");
    assert.equal(await readHsrMetaStrict(bee), null);
    assert.equal(existsSync(hsrRunDir(bee)), false);
    await killer.close();
    await recovery.close();
    await staleRecovery.close();
  });
});

const AUTHORITY_RUNNER_VERSION = versionCore();

function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "authority-node",
    kind: "remote-hsr",
    endpoint: "test@authority",
    runnerHostVersion: AUTHORITY_RUNNER_VERSION,
    capabilities: ["*"],
    status: "unknown",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeClient(call: RemoteRunnerClient["call"]): RemoteRunnerClient {
  return {
    node: "authority-node",
    localSocket: "/tmp/fake-authority.sock",
    connected: () => true,
    call: async (method, params, options) => {
      const result = await call(method, params, options);
      if (
        method === "ping"
        && result
        && typeof result === "object"
        && !Array.isArray(result)
        && !("version" in result)
      ) {
        return { ...(result as Record<string, unknown>), version: `runner-host ${AUTHORITY_RUNNER_VERSION}` };
      }
      return result;
    },
    on: () => () => undefined,
    droppedCount: () => 0,
    close: async () => undefined,
  };
}

test("remote event-integrity reconciliation keeps both controller fences on RPC failure and converges on retry", async () => {
  await withTempStore(async () => {
    const bee = "remote-integrity-reconcile-retry";
    const locator = { remoteLaunchId: randomUUID(), remoteIncarnation: randomUUID() };
    const canonical: SessionRecord = {
      name: bee,
      agent: "stub",
      cwd: "/tmp",
      command: "stub",
      tmuxTarget: bee,
      node: "authority-node",
      remoteLaunchId: locator.remoteLaunchId,
      remoteIncarnation: locator.remoteIncarnation,
      createdAt: "2026-08-15T20:00:00.000Z",
      updatedAt: "2026-08-15T20:00:00.000Z",
      status: "running",
    };
    await saveSession(canonical);
    const integrity = await persistHsrEventIntegrityFailure({
      bee,
      host: {
        hostPid: 8711,
        startedAt: "2026-08-15T20:00:00.000Z",
        hostFingerprint: { pgid: 8711, startedAt: "remote-reconcile-host" },
      },
      remoteAuthority: {
        launchId: locator.remoteLaunchId,
        incarnation: locator.remoteIncarnation,
      },
      deliveryIds: [],
      reason: "remote source history lost",
    });
    await recordHsrEventIntegrityStop(bee, integrity.integrityId, integrity.host, "confirmed", "remote strict stop");
    let failRpc = true;
    const substrate = createRemoteHsrSubstrate(node(), {
      connect: async () => fakeClient(async (method) => {
        if (method !== "eventIntegrityReconcile") return { ok: true };
        if (failRpc) throw new Error("injected tunnel failure before remote acknowledgement");
        const current = await readHsrEventIntegrityReceipt(bee);
        assert.ok(current);
        const now = new Date().toISOString();
        return {
          ok: true,
          receipt: {
            ...current,
            phase: "acknowledged",
            acknowledgedAt: now,
            updatedAt: now,
          },
        };
      }),
    });

    await assert.rejects(
      substrate.reconcileEventIntegrityRemote(bee, integrity.integrityId, locator),
      /injected tunnel failure/,
    );
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.phase, "unresolved");
    assert.equal((await loadSession(bee))?.eventIntegrityDoubt?.integrityId, integrity.integrityId);

    failRpc = false;
    await substrate.reconcileEventIntegrityRemote(bee, integrity.integrityId, locator);
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.phase, "acknowledged");
    assert.equal((await loadSession(bee))?.eventIntegrityDoubt, undefined);
    await substrate.close();
  });
});

test("spawn refuses an old serve before dispatching an irreversible RPC", async () => {
  let spawnCalls = 0;
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => fakeClient(async (method) => {
      if (method === "ping") return { ok: true, version: "runner-host old" };
      if (method === "spawn") spawnCalls += 1;
      return { ok: true, state: "empty" };
    }),
  });
  await assert.rejects(
    substrate.spawnRemote({ bee: "old-serve", kind: "stub", spec: { command: "node", args: [], env: {} } }),
    (error: Error) => error instanceof RemoteSpawnNotAdmittedError && /bootstrap\/upgrade/.test(error.message),
  );
  assert.equal(spawnCalls, 0);
  await substrate.close();
});

test("spawn refuses a same-protocol serve whose live artifact digest differs from the NodeRecord", async () => {
  let spawnCalls = 0;
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => fakeClient(async (method) => {
      if (method === "ping") {
        return {
          ok: true,
          version: "runner-host 0.0.1+sha256.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL,
        };
      }
      if (method === "spawn") spawnCalls += 1;
      return { ok: true, state: "empty" };
    }),
  });
  await assert.rejects(
    substrate.spawnRemote({ bee: "stale-same-protocol", kind: "stub", spec: { command: "node", args: [], env: {} } }),
    (error: Error) => error instanceof RemoteSpawnNotAdmittedError && /authority mismatch.*bootstrap\/upgrade/s.test(error.message),
  );
  assert.equal(spawnCalls, 0);
  await substrate.close();
});

test("send and answer refuse a same-protocol stale live serve before their mutation RPC", async () => {
  const mutations: string[] = [];
  const answerLocator = { remoteLaunchId: randomUUID(), remoteIncarnation: randomUUID() };
  const staleVersion = "runner-host 0.0.1+sha256.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => fakeClient(async (method) => {
      if (method === "ping") {
        return { ok: true, version: staleVersion, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL };
      }
      mutations.push(method);
      return { ok: true };
    }),
  });
  await assert.rejects(
    substrate.sendText("stale-live", "do not deliver", undefined, {
      remoteLaunchId: randomUUID(),
      remoteIncarnation: randomUUID(),
    }),
    /authority mismatch.*bootstrap\/upgrade/s,
  );
  await assert.rejects(
    substrate.answerRemote("stale-live", answerOperation("request-stale", "no", answerLocator), "no", answerLocator),
    /authority mismatch.*bootstrap\/upgrade/s,
  );
  assert.deepEqual(mutations, []);
  await substrate.close();
});

test("remote send keeps a lost outer response ambiguous when reconciliation cannot prove a durable outcome", async () => {
  const deliveryId = "remote-lost-response-id";
  const sentIds: string[] = [];
  let sendCalls = 0;
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => fakeClient(async (method, params) => {
      if (method === "ping") {
        return { ok: true, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL };
      }
      if (method === "send") {
        sendCalls += 1;
        sentIds.push(String((params as { deliveryId?: unknown }).deliveryId ?? ""));
        if (sendCalls === 1) throw new Error("outer response lost after dispatch");
        return { ok: false, error: "fresh authority cannot read the delivery receipt" };
      }
      return { ok: true };
    }),
  });
  await assert.rejects(
    substrate.sendText("lost-response", "do not duplicate", undefined, {
      deliveryId,
      remoteLaunchId: randomUUID(),
      remoteIncarnation: randomUUID(),
    }),
    (error: unknown) => (error as { code?: unknown; deliveryId?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS"
      && (error as { deliveryId?: unknown }).deliveryId === deliveryId,
  );
  assert.deepEqual(sentIds, [deliveryId, deliveryId], "reconciliation never invents a replacement delivery id");
  await substrate.close();
});

test("ordinary remote send polls the same id through delayed acceptance after losing its first response", async () => {
  const deliveryId = "remote-delayed-acceptance-id";
  const sentIds: string[] = [];
  let sendCalls = 0;
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => fakeClient(async (method, params) => {
      if (method === "ping") return { ok: true, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL };
      if (method !== "send") return { ok: true };
      sendCalls += 1;
      sentIds.push(String((params as { deliveryId?: unknown }).deliveryId ?? ""));
      if (sendCalls === 1) throw new Error("outer response lost after the one provider dispatch");
      if (sendCalls === 2) {
        return {
          ok: false,
          code: "HIVE_HSR_DELIVERY_IN_FLIGHT",
          deliveryId,
          phase: "dispatching",
          error: "provider acceptance is not durable yet",
        };
      }
      return { ok: true, deliveryId, phase: "accepted" };
    }),
  });
  await substrate.sendText("delayed-acceptance", "one provider turn", undefined, {
    deliveryId,
    remoteLaunchId: randomUUID(),
    remoteIncarnation: randomUUID(),
  });
  assert.deepEqual(sentIds, [deliveryId, deliveryId, deliveryId]);
  await substrate.close();
});

test("remote answer reconciles only the same operation and returns manual ambiguity when dispatch never settles", async () => {
  await withTempStore(async () => {
    const locator = { remoteLaunchId: randomUUID(), remoteIncarnation: randomUUID() };
    const operation = answerOperation("request-unresolved", "one-answer", locator);
    const observedOperations: HsrAnswerOperation[] = [];
    let answerCalls = 0;
    const substrate = createRemoteHsrSubstrate(node(), {
      connect: async () => fakeClient(async (method, params) => {
        if (method === "ping") return { ok: true, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL };
        if (method !== "answer") return { ok: true };
        answerCalls += 1;
        observedOperations.push((params as { operation: HsrAnswerOperation }).operation);
        if (answerCalls === 1) throw new Error("outer answer response lost after provider dispatch");
        return { ok: true, result: { status: "in-flight" } };
      }),
    });
    await offerHsrAnswerOperation("answer-unresolved", operation);
    const result = await substrate.answerRemote("answer-unresolved", operation, "one-answer", locator);
    assert.equal(result.status, "ambiguous");
    assert.match(result.status === "ambiguous" ? result.reason : "", /same-operation reconciliation attempts/);
    assert.equal(answerCalls, 5);
    assert.deepEqual(observedOperations, Array.from({ length: answerCalls }, () => operation));
    const controllerReceipt = await readHsrAnswerReceipt("answer-unresolved", operation);
    assert.equal(controllerReceipt?.phase, "sending", "lost remote outcome retains controller transport ownership");
    assert.equal(controllerReceipt?.sendingAuthority, "controller");
    await assert.rejects(
      offerHsrAnswerOperation(
        "answer-unresolved",
        answerOperation("replacement-request", "replacement-answer", locator),
      ),
      /unresolved provider ownership/,
      "controller death/lost reply cannot admit replacement answer work",
    );
    assert.equal(answerCalls, 5, "fenced replacement performs zero remote/provider calls");
    await substrate.close();
  });
});

test("remote answer rejects content that does not match its operation digest before transport", async () => {
  let connects = 0;
  const locator = { remoteLaunchId: randomUUID(), remoteIncarnation: randomUUID() };
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => {
      connects += 1;
      return fakeClient(async () => ({ ok: true }));
    },
  });
  await assert.rejects(
    substrate.answerRemote(
      "answer-content-conflict",
      answerOperation("request-content-conflict", "signed-answer", locator),
      "different-answer",
      locator,
    ),
    (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_ANSWER_CONFLICT",
  );
  assert.equal(connects, 0);
  await substrate.close();
});

test("a busy old node record cannot admit new work after local Honeybee upgrades", async () => {
  let connects = 0;
  let rpcCalls = 0;
  const answerLocator = { remoteLaunchId: randomUUID(), remoteIncarnation: randomUUID() };
  const oldVersion = "0.0.1+sha256.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const substrate = createRemoteHsrSubstrate(node({ runnerHostVersion: oldVersion }), {
    connect: async () => {
      connects += 1;
      return fakeClient(async () => {
        rpcCalls += 1;
        return {
          ok: true,
          version: `runner-host ${oldVersion}`,
          safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL,
        };
      });
    },
  });
  await assert.rejects(
    substrate.spawnRemote({ bee: "busy-old-node", kind: "stub", spec: { command: "node", args: [], env: {} } }),
    (error: Error) => error instanceof RemoteSpawnNotAdmittedError && /does not match this Honeybee artifact.*stop\/retire/s.test(error.message),
  );
  await assert.rejects(
    substrate.sendText("busy-old-node", "unsafe new turn", undefined, {
      remoteLaunchId: randomUUID(),
      remoteIncarnation: randomUUID(),
    }),
    /does not match this Honeybee artifact/,
  );
  await assert.rejects(
    substrate.answerRemote("busy-old-node", answerOperation("request-old", "yes", answerLocator), "yes", answerLocator),
    /does not match this Honeybee artifact/,
  );
  const refreshed = await substrate.refreshCredsRemote({
    bee: "busy-old-node",
    creds: { files: [] },
    remoteLaunchId: randomUUID(),
    remoteIncarnation: randomUUID(),
  });
  assert.equal(refreshed.ok, false);
  assert.match(refreshed.error ?? "", /does not match this Honeybee artifact/);
  assert.equal(connects, 0, "local digest drift must refuse before opening the remote transport");
  assert.equal(rpcCalls, 0);
  await substrate.close();
});

test("authoritative pre-admission rejection is distinct from ambiguous dispatch", async () => {
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => fakeClient(async (method) => {
      if (method === "ping") return { ok: true, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL };
      if (method === "spawnHead") return { ok: true, state: "empty" };
      if (method === "spawn") return { ok: false, launchUnowned: true, error: "name already owned" };
      return null;
    }),
  });
  await assert.rejects(
    substrate.spawnRemote({ bee: "pre-admission-reject", kind: "stub", spec: { command: "node", args: [], env: {} } }),
    (error: Error) => error instanceof RemoteSpawnNotAdmittedError && /name already owned/.test(error.message),
  );
  await substrate.close();
});

test("spawn racing controller shutdown is rejected as definitively unowned", async () => {
  await withTempStore(async () => {
    const controller = buildController({ runHost: await fakeRunHost() });
    let spawnCalls = 0;
    const substrate = createRemoteHsrSubstrate(node(), {
      connect: async () => fakeClient(async (method, params) => {
        if (method === "ping") {
          const result = await controller.methods.ping!(params, CTX);
          controller.beginClose();
          return result;
        }
        if (method === "spawn") spawnCalls += 1;
        const handler = controller.methods[method];
        if (!handler) throw new Error(`unexpected ${method}`);
        return handler(params, CTX);
      }),
    });

    await assert.rejects(
      substrate.spawnRemote({
        bee: "closing-before-admission",
        launchId: randomUUID(),
        previousLaunchId: randomUUID(),
        kind: "stub",
        spec: { command: "node", args: [], env: {} },
      }),
      (error: Error) => error instanceof RemoteSpawnNotAdmittedError && /closing before spawn admission/.test(error.message),
    );
    assert.equal(spawnCalls, 1, "the typed refusal is returned by the spawn admission boundary");
    assert.equal(await readRemoteHsrLaunchReceiptStrict("closing-before-admission"), null);
    await substrate.close();
    await controller.close();
  });
});

test("spawn reconciles a lost reply through the durable receipt", async () => {
  const launchId = randomUUID();
  const incarnation = randomUUID();
  let spawnCalls = 0;
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => fakeClient(async (method) => {
      if (method === "ping") return { ok: true, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL };
      if (method === "spawnHead") return { ok: true, state: "empty" };
      if (method === "spawn") {
        spawnCalls += 1;
        throw new Error("reply lost after dispatch");
      }
      if (method === "spawnReceipt") {
        return {
          ok: true,
          safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL,
          bee: "lost-reply",
          launchId,
          incarnation,
          cwd: "/remote/cwd",
          tier: "stream",
        };
      }
      throw new Error(`unexpected ${method}`);
    }),
  });
  const result = await substrate.spawnRemote({
    bee: "lost-reply",
    launchId,
    kind: "stub",
    spec: { command: "node", args: [], env: {} },
  });
  assert.equal(spawnCalls, 1);
  assert.equal(result.incarnation, incarnation);
  assert.equal(result.cwd, "/remote/cwd");
  await substrate.close();
});

test("invalid non-absolute spawn receipts remain explicitly indeterminate", async () => {
  const launchId = randomUUID();
  const incarnation = randomUUID();
  const invalid = {
    ok: true,
    safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL,
    bee: "bad-cwd",
    launchId,
    incarnation,
    cwd: "relative/cwd",
  };
  const substrate = createRemoteHsrSubstrate(node(), {
    connect: async () => fakeClient(async (method) => {
      if (method === "ping") return { ok: true, safetyProtocol: REMOTE_HSR_SAFETY_PROTOCOL };
      if (method === "spawnHead") return { ok: true, state: "empty" };
      if (method === "spawn" || method === "spawnReceipt") return invalid;
      throw new Error(`unexpected ${method}`);
    }),
  });
  await assert.rejects(
    substrate.spawnRemote({
      bee: "bad-cwd",
      launchId,
      kind: "stub",
      spec: { command: "node", args: [], env: {} },
    }),
    (error: Error) => error instanceof RemoteSpawnIndeterminateError && error.launchId === launchId,
  );
  await substrate.close();
});
