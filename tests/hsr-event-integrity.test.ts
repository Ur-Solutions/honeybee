import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertHsrSourceEventLogIntegrity,
  assertNoUnresolvedHsrEventIntegrity,
  acknowledgeHsrEventIntegrityLoss,
  HsrSourceAuthorityChangedError,
  HsrSourceEventIntegrityError,
  importRemoteHsrEventIntegrityReceipt,
  parseHsrEventIntegrityReceipt,
  persistHsrEventIntegrityFailure,
  readHsrEventIntegrityReceipt,
  recordHsrEventIntegrityDeliveryVerdict,
  recordHsrEventIntegrityStop,
  type HsrEventIntegrityReceipt,
} from "../src/hsr/eventIntegrity.js";
import {
  appendHsrEvent,
  ensureHsrRunDir,
  hsrEventHistoryEvidenceDir,
  hsrControlSocketPath,
  hsrEventsPath,
  hsrRunDir,
  hsrSeqPath,
  isHsrEventHistoryQuarantined,
  readHsrMetaStrict,
  writeHsrMeta,
} from "../src/hsr/runDir.js";
import { startRpcServer } from "../src/hsr/rpc.js";
import { purgeSessionData } from "../src/kill.js";
import { withCombAutomaticSourceAdmission } from "../src/daemon/combSweep.js";
import { withFlightAutomaticSourceAdmission } from "../src/daemon/flightSweep.js";
import {
  beginBeeReplacementOperation,
  beginBeeReplacementLaunchAdmission,
  readBeeNameLaunchReservation,
  withBeeNameLaunchAdmission,
} from "../src/nameAdmission.js";
import { isRunnableSessionRecord } from "../src/stateMachine.js";
import { loadSession, saveSession, type HsrEventIntegrityDoubt, type SessionRecord } from "../src/store.js";
import { withSessionLifecycleTransaction } from "../src/lifecycle.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-hsr-event-integrity-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const host = {
  hostPid: 8311,
  startedAt: "2026-08-15T19:00:00.000Z",
  hostFingerprint: { pgid: 8311, startedAt: "event-integrity-host-birth" },
};

function record(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    createdAt: "2026-08-15T19:00:00.000Z",
    updatedAt: "2026-08-15T19:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

test("acknowledged event-integrity receipts require confirmed stop and every terminal delivery verdict", () => {
  const base = {
    version: 1,
    integrityId: "integrity-parser",
    bee: "event-integrity-parser",
    host,
    phase: "acknowledged",
    stopState: "confirmed",
    deliveryIds: ["delivery-1"],
    reason: "lost source event",
    createdAt: "2026-08-15T19:00:00.000Z",
    updatedAt: "2026-08-15T19:00:01.000Z",
    acknowledgedAt: "2026-08-15T19:00:01.000Z",
  } as const;
  assert.throws(
    () => parseHsrEventIntegrityReceipt(base, base.bee),
    /malformed/,
  );
  assert.doesNotThrow(() => parseHsrEventIntegrityReceipt({
    ...base,
    deliveryVerdicts: { "delivery-1": "discarded" },
  }, base.bee));
  assert.throws(
    () => parseHsrEventIntegrityReceipt({ ...base, stopState: "doubt", deliveryVerdicts: { "delivery-1": "discarded" } }, base.bee),
    /malformed/,
  );
});

test("rediscovering the same event-integrity fence preserves receipt and session timestamps", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-idempotent-rediscovery";
    const current = record(bee, {
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
    });
    await saveSession(current);
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...host,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });

    const first = await persistHsrEventIntegrityFailure({
      bee,
      host,
      deliveryIds: [],
      reason: "fixture source history is incomplete",
    });
    const fenced = (await loadSession(bee))!;
    const canonicalTimestamp = "2026-08-15T19:30:00.000Z";
    await saveSession({ ...fenced, updatedAt: canonicalTimestamp });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await persistHsrEventIntegrityFailure({
      bee,
      host,
      deliveryIds: [],
      reason: "fixture source history is incomplete",
    });

    assert.equal(replay.integrityId, first.integrityId);
    assert.equal(replay.updatedAt, first.updatedAt, "receipt rediscovery is a semantic no-op");
    assert.equal((await loadSession(bee))?.updatedAt, canonicalTimestamp, "canonical activity time is preserved");
  });
});

test("reconfirming an unchanged event-integrity stop is a semantic no-op", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-idempotent-stop-confirmation";
    const current = record(bee, {
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
    });
    await saveSession(current);
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...host,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });

    const receipt = await persistHsrEventIntegrityFailure({
      bee,
      host,
      deliveryIds: [],
      reason: "fixture source history is incomplete",
    });
    const firstConfirmation = await recordHsrEventIntegrityStop(
      bee,
      receipt.integrityId,
      host,
      "confirmed",
      "exact host and child-group stop proof",
    );
    const canonicalTimestamp = "2026-08-15T19:31:00.000Z";
    const fenced = (await loadSession(bee))!;
    await saveSession({ ...fenced, updatedAt: canonicalTimestamp });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await recordHsrEventIntegrityStop(
      bee,
      receipt.integrityId,
      host,
      "confirmed",
      "exact host and child-group stop proof",
    );

    assert.equal(replay.updatedAt, firstConfirmation.updatedAt, "receipt confirmation timestamp is preserved");
    assert.equal((await loadSession(bee))?.updatedAt, canonicalTimestamp, "canonical activity time is preserved");
  });
});

test("acknowledging a stopped corrupt source quarantines evidence and unblocks one exact replacement", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-ack-quarantine";
    const current = record(bee, {
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
    });
    await saveSession(current);
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...host,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
    await appendHsrEvent(bee, { type: "text", ts: 3, text: "three" });
    const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
    const corrupt = `${lines[0]}\n${lines[2]}\n`;
    await writeFile(hsrEventsPath(bee), corrupt, { mode: 0o600 });

    await assert.rejects(
      assertHsrSourceEventLogIntegrity({
        bee,
        meta: (await readHsrMetaStrict(bee))!,
        operation: "corrupt predecessor admission",
      }),
      (error: unknown) => error instanceof HsrSourceEventIntegrityError,
    );
    const unresolved = await readHsrEventIntegrityReceipt(bee);
    assert.ok(unresolved);
    await recordHsrEventIntegrityStop(
      bee,
      unresolved!.integrityId,
      unresolved!.host,
      "confirmed",
      "fixture exact stop proof",
    );
    const acknowledged = await acknowledgeHsrEventIntegrityLoss(bee, unresolved!.integrityId);
    assert.equal(acknowledged.phase, "acknowledged");
    assert.equal(await readFile(hsrEventsPath(bee), "utf8"), "", "active source history starts a fresh sequence space");
    await assert.rejects(readFile(hsrSeqPath(bee), "utf8"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const evidenceDir = hsrEventHistoryEvidenceDir(bee, unresolved!.integrityId);
    assert.equal(await readFile(join(evidenceDir, "events.jsonl"), "utf8"), corrupt);
    assert.match(await readFile(join(evidenceDir, "complete.json"), "utf8"), new RegExp(unresolved!.integrityId));

    // The same stopped generation is now explicitly settled. Replacement
    // admission may create its journal without minting an identical receipt;
    // the successor's first authoritative append starts at seq 1.
    const afterAck = (await loadSession(bee))!;
    await withSessionLifecycleTransaction(afterAck, (lifecycle) => beginBeeReplacementOperation(lifecycle, "revive"));
    assert.ok(await readBeeNameLaunchReservation(bee));
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.integrityId, unresolved!.integrityId);
    await appendHsrEvent(bee, { type: "host_epoch", ts: 4, host });
    const successor = JSON.parse(await readFile(hsrEventsPath(bee), "utf8")) as { seq?: number };
    assert.equal(successor.seq, 1);
  });
});

test("a later generation loss archives rather than overwrites an acknowledged receipt", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-ack-history";
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...host,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });
    const prior = await persistHsrEventIntegrityFailure({
      bee,
      host,
      deliveryIds: [],
      reason: "predecessor loss",
    });
    await recordHsrEventIntegrityStop(bee, prior.integrityId, host, "confirmed", "fixture stop");
    await acknowledgeHsrEventIntegrityLoss(bee, prior.integrityId);

    const successorHost = {
      hostPid: host.hostPid + 1,
      startedAt: "2026-08-15T19:10:00.000Z",
      hostFingerprint: { pgid: host.hostPid + 1, startedAt: "successor-host-birth" },
    };
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...successorHost,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });
    const successor = await persistHsrEventIntegrityFailure({
      bee,
      host: successorHost,
      deliveryIds: [],
      reason: "successor loss",
    });
    assert.notEqual(successor.integrityId, prior.integrityId);
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.integrityId, successor.integrityId);
    const beeKey = createHash("sha256").update(bee).digest("hex");
    const priorKey = createHash("sha256").update(prior.integrityId).digest("hex");
    const archived = JSON.parse(await readFile(join(
      process.env.HIVE_STORE_ROOT!,
      "hsr-event-integrity",
      "history",
      beeKey,
      `${priorKey}.json`,
    ), "utf8")) as HsrEventIntegrityReceipt;
    assert.equal(archived.integrityId, prior.integrityId);
    assert.equal(archived.phase, "acknowledged");
    assert.equal(await isHsrEventHistoryQuarantined(bee, prior.integrityId), true, "new local authority never removes predecessor audit bytes");
  });
});

test("a later remote generation import archives rather than overwrites an acknowledged controller receipt", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-remote-ack-history";
    await ensureHsrRunDir(bee);
    const priorAuthority = { launchId: "launch-a", incarnation: "incarnation-a" };
    const prior = await persistHsrEventIntegrityFailure({
      bee,
      host,
      remoteAuthority: priorAuthority,
      deliveryIds: [],
      reason: "remote predecessor loss",
    });
    await recordHsrEventIntegrityStop(bee, prior.integrityId, host, "confirmed", "fixture remote stop");
    await acknowledgeHsrEventIntegrityLoss(bee, prior.integrityId);

    const successorHost = {
      hostPid: host.hostPid + 2,
      startedAt: "2026-08-15T19:20:00.000Z",
      hostFingerprint: { pgid: host.hostPid + 2, startedAt: "remote-successor-host-birth" },
    };
    const now = "2026-08-15T19:21:00.000Z";
    const remoteSuccessor: HsrEventIntegrityReceipt = {
      version: 1,
      integrityId: "remote-successor-integrity",
      bee,
      host: successorHost,
      remoteAuthority: { launchId: "launch-b", incarnation: "incarnation-b" },
      phase: "unresolved",
      stopState: "doubt",
      deliveryIds: [],
      reason: "remote successor loss",
      createdAt: now,
      updatedAt: now,
    };
    await importRemoteHsrEventIntegrityReceipt(remoteSuccessor, bee);

    assert.equal((await readHsrEventIntegrityReceipt(bee))?.integrityId, remoteSuccessor.integrityId);
    const beeKey = createHash("sha256").update(bee).digest("hex");
    const priorKey = createHash("sha256").update(prior.integrityId).digest("hex");
    const archived = JSON.parse(await readFile(join(
      process.env.HIVE_STORE_ROOT!,
      "hsr-event-integrity",
      "history",
      beeKey,
      `${priorKey}.json`,
    ), "utf8")) as HsrEventIntegrityReceipt;
    assert.equal(archived.integrityId, prior.integrityId);
    assert.equal(archived.phase, "acknowledged");
    assert.equal(await isHsrEventHistoryQuarantined(bee, prior.integrityId), true, "remote import never removes predecessor audit bytes");
  });
});

test("an imported canonical event-integrity marker blocks fresh, low-level replacement, and purge admission", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-marker-admission";
    const marker: HsrEventIntegrityDoubt = {
      version: 1,
      integrityId: "imported-integrity-id",
      source: {
        hostPid: host.hostPid,
        startedAt: host.startedAt,
        hostFingerprint: host.hostFingerprint,
        remoteLaunchId: "00000000-0000-4000-8000-000000000901",
        remoteIncarnation: "00000000-0000-4000-8000-000000000902",
      },
      createdAt: "2026-08-15T19:00:00.000Z",
      fenceError: "remote event history is unresolved",
    };
    const current = record(bee, {
      status: "dead",
      node: "remote-node",
      remoteLaunchId: marker.source.remoteLaunchId,
      remoteIncarnation: marker.source.remoteIncarnation,
      eventIntegrityDoubt: marker,
      lastError: marker.fenceError,
    });
    await saveSession(current);
    assert.equal(isRunnableSessionRecord(current), false);

    let launched = false;
    await assert.rejects(
      withBeeNameLaunchAdmission(bee, async () => { launched = true; }),
      /unresolved HSR event history/,
    );
    assert.equal(launched, false);
    assert.equal(await readBeeNameLaunchReservation(bee), null);

    await assert.rejects(
      withSessionLifecycleTransaction(current, (lifecycle) =>
        beginBeeReplacementLaunchAdmission(lifecycle, "low-level-test")),
      /unresolved HSR event history/,
    );
    assert.equal(await readBeeNameLaunchReservation(bee), null);
    await assert.rejects(purgeSessionData(current), /unresolved HSR event history/);
    assert.ok(await loadSession(bee), "purge preserves the only canonical remote locator");
  });
});

test("automatic Comb and Flight source gates reject sidecar-only event-integrity authority", async () => {
  await withTempStore(async () => {
    const combBee = "event-integrity-comb-sidecar";
    await persistHsrEventIntegrityFailure({
      bee: combBee,
      host,
      deliveryIds: [],
      reason: "provider output may have been lost before automatic Comb retry",
    });
    const combSource = record(combBee, {
      status: "dead",
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
    });
    await saveSession(combSource);
    let combSpawned = false;
    await assert.rejects(
      withCombAutomaticSourceAdmission([combSource], async () => { combSpawned = true; }),
      /unresolved HSR event history/,
    );
    assert.equal(combSpawned, false);

    const flightBee = "event-integrity-flight-sidecar";
    await persistHsrEventIntegrityFailure({
      bee: flightBee,
      host,
      deliveryIds: [],
      reason: "provider output may have been lost before automatic Flight replacement",
    });
    const flightSource = record(flightBee, {
      status: "done",
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
    });
    await saveSession(flightSource);
    let flightSpawned = false;
    await assert.rejects(
      withFlightAutomaticSourceAdmission(flightSource, async () => { flightSpawned = true; }),
      /unresolved HSR event history/,
    );
    assert.equal(flightSpawned, false, "archive alone cannot release a source whose event history is unresolved");
  });
});

test("a conflicting controller verdict cannot overwrite an authoritative remote integrity receipt", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-verdict-conflict";
    const remoteAuthority = {
      launchId: "00000000-0000-4000-8000-000000000911",
      incarnation: "00000000-0000-4000-8000-000000000912",
    };
    await saveSession(record(bee, {
      node: "remote-node",
      remoteLaunchId: remoteAuthority.launchId,
      remoteIncarnation: remoteAuthority.incarnation,
    }));
    const local = await persistHsrEventIntegrityFailure({
      bee,
      host,
      remoteAuthority,
      deliveryIds: ["delivery-conflict"],
      reason: "lost source event",
    });
    assert.equal(await recordHsrEventIntegrityDeliveryVerdict(bee, "delivery-conflict", "delivered"), true);
    const conflicting: HsrEventIntegrityReceipt = {
      ...local,
      deliveryVerdicts: { "delivery-conflict": "discarded" },
      updatedAt: "2026-08-15T19:01:00.000Z",
    };

    await assert.rejects(
      importRemoteHsrEventIntegrityReceipt(conflicting, bee),
      /conflicts with local delivered/,
    );
    const retained = await readHsrEventIntegrityReceipt(bee);
    assert.equal(retained?.deliveryVerdicts?.["delivery-conflict"], "delivered");
    assert.equal((await loadSession(bee))?.eventIntegrityDoubt?.integrityId, local.integrityId);
  });
});

test("strict source validation publishes an exact outside receipt when the host control socket is absent", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-no-control-socket";
    await saveSession(record(bee, {
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
    }));
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...host,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
    const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
    await writeFile(hsrEventsPath(bee), `${lines[0]}\n{malformed-middle\n${lines[1]}\n`, { mode: 0o600 });
    const meta = (await import("../src/hsr/runDir.js")).readHsrMetaStrict;
    const currentMeta = await meta(bee);
    assert.ok(currentMeta);

    await assert.rejects(
      assertHsrSourceEventLogIntegrity({ bee, meta: currentMeta!, operation: "test admission" }),
      (error: unknown) => error instanceof HsrSourceEventIntegrityError,
    );
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(receipt?.host.hostPid, host.hostPid);
    assert.equal(receipt?.stopState, "doubt");
    assert.equal((await loadSession(bee))?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
  });
});

test("unreadable pending-turn authority cannot be laundered into an empty integrity receipt", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-unreadable-deliveries";
    await saveSession(record(bee, {
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
    }));
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...host,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
    const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
    await writeFile(hsrEventsPath(bee), `${lines[1]}\n`, { mode: 0o600 });
    const pendingDir = join(hsrRunDir(bee), "pending-turns");
    await mkdir(pendingDir, { recursive: true });
    await writeFile(join(pendingDir, "unknown-ownership.json"), "{malformed", { mode: 0o600 });

    await assert.rejects(
      assertHsrSourceEventLogIntegrity({
        bee,
        meta: (await readHsrMetaStrict(bee))!,
        operation: "corrupt source with unreadable deliveries",
      }),
      (error: unknown) => error instanceof HsrSourceEventIntegrityError,
    );
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.ok(receipt?.deliveryScanError);
    assert.deepEqual(receipt?.deliveryIds, [], "unreadable is explicitly distinct from proven empty");
    await recordHsrEventIntegrityStop(bee, receipt!.integrityId, receipt!.host, "confirmed", "fixture stop proof");
    await assert.rejects(
      acknowledgeHsrEventIntegrityLoss(bee, receipt!.integrityId),
      /pending delivery authority was unreadable/,
    );
    await assert.rejects(
      assertNoUnresolvedHsrEventIntegrity(bee, "replacement after unreadable delivery authority"),
      /unresolved HSR event history/,
    );

    await rm(join(pendingDir, "unknown-ownership.json"));
    const repaired = await acknowledgeHsrEventIntegrityLoss(bee, receipt!.integrityId);
    assert.equal(repaired.phase, "acknowledged", "a repaired strict delivery scan converges without file surgery on the receipt");
    assert.equal(repaired.deliveryScanError, undefined);
  });
});

test("corrupt legacy source history without a host fingerprint still durably blocks automatic replacement", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-legacy-source";
    const legacyHost = {
      hostPid: 8321,
      startedAt: "2026-08-15T19:05:00.000Z",
    };
    const current = record(bee, {
      substrate: "hsr",
      runnerPid: legacyHost.hostPid,
      runnerFingerprint: undefined,
    });
    await saveSession(current);
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...legacyHost,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
    const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
    await writeFile(hsrEventsPath(bee), `${lines[0]}\n{legacy-corruption\n${lines[1]}\n`, { mode: 0o600 });
    const { readHsrMetaStrict } = await import("../src/hsr/runDir.js");
    const meta = await readHsrMetaStrict(bee);
    assert.ok(meta);

    await assert.rejects(
      assertHsrSourceEventLogIntegrity({ bee, meta: meta!, operation: "legacy observation" }),
      (error: unknown) => error instanceof HsrSourceEventIntegrityError,
    );
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(receipt?.host.hostFingerprint, undefined);
    assert.equal(receipt?.stopState, "doubt");
    const fenced = await loadSession(bee);
    assert.equal(fenced?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
    await assert.rejects(
      withSessionLifecycleTransaction(fenced!, (lifecycle) => beginBeeReplacementOperation(lifecycle, "auto-revive")),
      /unresolved HSR event history/,
    );
    assert.equal(await readBeeNameLaunchReservation(bee), null, "legacy corruption creates no replacement journal");
  });
});

test("replacement admission validates an unfenced local source log before journal or stop dispatch", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-replacement-source-check";
    const current = record(bee, {
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
    });
    await saveSession(current);
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      ...host,
      childAdmission: "none",
      controlSocket: "",
      status: "running",
    });
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
    await appendHsrEvent(bee, { type: "text", ts: 3, text: "three" });
    const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
    await writeFile(hsrEventsPath(bee), `${lines[0]}\n${lines[2]}\n`, { mode: 0o600 });

    await assert.rejects(
      withSessionLifecycleTransaction(current, (lifecycle) => beginBeeReplacementOperation(lifecycle, "revive")),
      /unresolved HSR event history/,
    );
    assert.equal(await readBeeNameLaunchReservation(bee), null, "no replacement journal exists before source authority is settled");
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(receipt?.stopState, "doubt");
    assert.equal((await loadSession(bee))?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
  });
});

test("a stale A observation never sends an unqualified stop through B's reused control socket", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-stale-socket";
    const socketPath = hsrControlSocketPath(bee);
    let stopCalls = 0;
    const server = await startRpcServer({
      socketPath,
      methods: {
        eventIntegrityFailure: () => { throw new Error("host identity belongs to successor B"); },
        stop: () => { stopCalls += 1; return { stopping: true }; },
      },
    });
    try {
      await saveSession(record(bee, {
        substrate: "hsr",
        runnerPid: host.hostPid,
        runnerFingerprint: host.hostFingerprint,
      }));
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, {
        bee,
        harness: "stub",
        tier: "stream",
        ...host,
        childAdmission: "none",
        controlSocket: socketPath,
        status: "running",
      });
      await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
      await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
      const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
      await writeFile(hsrEventsPath(bee), `${lines[0]}\n{malformed-middle\n${lines[1]}\n`, { mode: 0o600 });
      const { readHsrMetaStrict } = await import("../src/hsr/runDir.js");
      const currentMeta = await readHsrMetaStrict(bee);
      assert.ok(currentMeta);

      await assert.rejects(
        assertHsrSourceEventLogIntegrity({ bee, meta: currentMeta!, operation: "stale A observation" }),
        (error: unknown) => error instanceof HsrSourceEventIntegrityError,
      );
      assert.equal(stopCalls, 0, "a socket that rejected A's exact host token receives no stop mutation");
      assert.equal((await readHsrEventIntegrityReceipt(bee))?.host.hostPid, host.hostPid);
    } finally {
      await server.close();
    }
  });
});

test("a stale A observation cannot publish a name head or poison current successor B", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-stale-successor";
    const staleHost = host;
    const successorHost = {
      hostPid: 9322,
      startedAt: "2026-08-15T19:10:00.000Z",
      hostFingerprint: { pgid: 9322, startedAt: "event-integrity-successor-birth" },
    };
    const socketPath = hsrControlSocketPath(bee);
    let stopCalls = 0;
    const server = await startRpcServer({
      socketPath,
      methods: {
        eventIntegrityFailure: () => { throw new Error("stale A token rejected by B"); },
        stop: () => { stopCalls += 1; return { stopping: true }; },
      },
    });
    try {
      await ensureHsrRunDir(bee);
      await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
      await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
      const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
      await writeFile(hsrEventsPath(bee), `${lines[0]}\n{malformed-middle\n${lines[1]}\n`, { mode: 0o600 });
      const staleMeta = {
        bee,
        harness: "stub",
        tier: "stream" as const,
        ...staleHost,
        childAdmission: "none" as const,
        controlSocket: socketPath,
        status: "running" as const,
      };
      await writeHsrMeta(bee, {
        ...staleMeta,
        ...successorHost,
      });
      await saveSession(record(bee, {
        substrate: "hsr",
        runnerPid: successorHost.hostPid,
        runnerFingerprint: successorHost.hostFingerprint,
      }));

      await assert.rejects(
        assertHsrSourceEventLogIntegrity({ bee, meta: staleMeta, operation: "stale A observation" }),
        (error: unknown) => error instanceof HsrSourceAuthorityChangedError,
      );
      assert.equal(stopCalls, 0);
      assert.equal(await readHsrEventIntegrityReceipt(bee), null);
      assert.equal((await loadSession(bee))?.eventIntegrityDoubt, undefined);
      await assertNoUnresolvedHsrEventIntegrity(bee, "successor B work admission");
    } finally {
      await server.close();
    }
  });
});
