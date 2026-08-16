import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { captureProcessBirthFingerprint, type ProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import { hsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import {
  persistHsrEventIntegrityFailure,
  readHsrEventIntegrityReceipt,
} from "../src/hsr/eventIntegrity.js";
import { deliverSessionText } from "../src/delivery.js";
import { reviveHsrForAutomaticRecovery } from "../src/recovery/revive.js";
import { wakeRuntimeForQueuedSend } from "../src/recovery/wake.js";
import {
  beeNameLaunchReservationPath,
  beginBeeReplacementOperation,
  reconcileBeeReplacementLaunchAdmission,
  readBeeNameLaunchReservation,
  withBeeNameLaunchAdmission,
  withBeeReplacementLaunchAdmission,
  type BeeNameLaunchReservationRecord,
} from "../src/nameAdmission.js";
import { purgeSessionData, transactionalKill } from "../src/kill.js";
import {
  loadSession,
  saveSession,
  type HsrEventIntegrityDoubt,
  type SessionRecord,
} from "../src/store.js";
import type { Substrate } from "../src/substrates/types.js";
import { withSessionLifecycleTransaction } from "../src/lifecycle.js";

const LAUNCH_BIRTH: ProcessBirthFingerprint = {
  pgid: 48_321,
  startedAt: "Sat Aug 15 12:00:00 2026",
};

async function withTempStore<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const previous = process.env.HIVE_STORE_ROOT;
  const root = await mkdtemp(join(tmpdir(), "hive-name-launch-reservation-"));
  process.env.HIVE_STORE_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function publishedTmuxRecord(name: string, createdAt = "2026-08-15T12:00:00.000Z"): SessionRecord {
  return {
    name,
    agent: "node",
    requestedAgent: "node",
    cwd: "/tmp",
    command: process.execPath,
    launchArgv: [process.execPath],
    tmuxTarget: name,
    agentPaneId: "%42",
    launcherPgid: LAUNCH_BIRTH.pgid,
    launcherFingerprint: LAUNCH_BIRTH,
    id: `id-${name}`,
    uuid: `uuid-${name}`,
    createdAt,
    updatedAt: createdAt,
    status: "running",
  };
}

function tmuxLaunch() {
  return {
    paneId: "%42",
    launcherPgid: LAUNCH_BIRTH.pgid,
    launcherFingerprint: LAUNCH_BIRTH,
  };
}

function gate(): { entered: Promise<void>; enter(): void; wait: Promise<void>; release(): void } {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => { enter = resolve; }),
    enter: () => enter(),
    wait: new Promise<void>((resolve) => { release = resolve; }),
    release: () => release(),
  };
}

async function writeReservationFixture(
  root: string,
  record: BeeNameLaunchReservationRecord,
): Promise<void> {
  const path = beeNameLaunchReservationPath(record.name, root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

test("birth-qualified publication promotes and clears a local launch reservation", async () => {
  await withTempStore(async () => {
    const name = "reservation-publish";
    const record = publishedTmuxRecord(name);
    const result = await withBeeNameLaunchAdmission(name, async (reservation) => {
      await reservation.markLaunchDispatch();
      await reservation.recordTmuxLaunch({
        substrate: "local-tmux",
        target: name,
        launch: tmuxLaunch(),
      });
      await saveSession(record);
      await reservation.promotePublished(record);
      return record;
    });

    assert.equal(result.name, name);
    assert.equal(await readBeeNameLaunchReservation(name), null);
    assert.equal((await loadSession(name))?.createdAt, record.createdAt);
  });
});

test("publication projects an integrity receipt raised before the canonical HSR row existed", async () => {
  await withTempStore(async () => {
    const name = "reservation-prepublication-integrity";
    const host = {
      hostPid: 48_355,
      startedAt: "2026-08-15T12:05:00.000Z",
      hostFingerprint: { pgid: 48_355, startedAt: "prepublication-host-birth" },
    };
    const record: SessionRecord = {
      name,
      agent: "stub",
      cwd: "/tmp",
      command: process.execPath,
      tmuxTarget: name,
      createdAt: "2026-08-15T12:05:00.000Z",
      updatedAt: "2026-08-15T12:05:00.000Z",
      status: "running",
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
      runtimeGeneration: 1,
    };
    await assert.rejects(
      withBeeNameLaunchAdmission(name, async (reservation) => {
        await reservation.markLaunchDispatch();
        await reservation.recordHsrLaunch({
          hostPid: host.hostPid,
          hostFingerprint: host.hostFingerprint,
          childAdmission: "none",
        });
        await persistHsrEventIntegrityFailure({
          bee: name,
          host,
          deliveryIds: [],
          reason: "startup event append failed before SessionRecord publication",
        });
        await saveSession(record);
        await reservation.promotePublished(record);
      }),
      /unresolved HSR event history/,
    );
    const receipt = await readHsrEventIntegrityReceipt(name);
    const canonical = await loadSession(name);
    assert.equal(canonical?.status, "kill_failed");
    assert.equal(canonical?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
    assert.equal((await readBeeNameLaunchReservation(name))?.phase, "launched");
  });
});

test("pre-dispatch launch barriers honor a stale canonical integrity marker even after its outside head settled", async () => {
  await withTempStore(async () => {
    for (const remote of [false, true]) {
      const name = `reservation-integrity-marker-${remote ? "remote" : "local"}`;
      const marker: HsrEventIntegrityDoubt = {
        version: 1,
        integrityId: `integrity-${name}`,
        source: {
          hostPid: 48_399,
          startedAt: "2026-08-15T12:30:00.000Z",
          hostFingerprint: { pgid: 48_399, startedAt: "integrity-host-birth" },
        },
        createdAt: "2026-08-15T12:30:00.000Z",
        fenceError: "event-integrity canonical clear was interrupted",
      };
      let dispatches = 0;
      await assert.rejects(
        withBeeNameLaunchAdmission(name, async (reservation) => {
          await saveSession({
            ...publishedTmuxRecord(name),
            status: "kill_failed",
            lastError: marker.fenceError,
            eventIntegrityDoubt: marker,
          });
          if (remote) {
            await reservation.markRemoteLaunchDispatch({ node: "remote-node", remoteLaunchId: "remote-launch" });
          } else {
            await reservation.markLaunchDispatch();
          }
          dispatches += 1;
        }),
        /unresolved HSR event history/,
      );
      assert.equal(dispatches, 0);
      assert.equal(await readBeeNameLaunchReservation(name), null, "pre-dispatch refusal releases only its untouched journal");
    }
  });
});

test("replacement publication is bound to the exact predecessor and next runtime generation", async () => {
  await withTempStore(async () => {
    const old = { ...publishedTmuxRecord("replacement-generation"), runtimeGeneration: 7 };
    await saveSession(old);
    const nextBirth = { pgid: 58_321, startedAt: "Sat Aug 15 12:01:00 2026" };
    const updated = await withSessionLifecycleTransaction(old, (lifecycle) =>
      withBeeReplacementLaunchAdmission(lifecycle, "revive", async (reservation) => {
        await reservation.markLaunchDispatch();
        await reservation.recordTmuxLaunch({
          substrate: "local-tmux",
          target: old.tmuxTarget,
          launch: { paneId: "%52", launcherPgid: nextBirth.pgid, launcherFingerprint: nextBirth },
        });
        const published = await lifecycle.commit({
          runtimeGeneration: 8,
          agentPaneId: "%52",
          launcherPgid: nextBirth.pgid,
          launcherFingerprint: nextBirth,
          status: "running",
          lastError: undefined,
          updatedAt: "2026-08-15T12:01:00.000Z",
        });
        await reservation.promotePublished(published);
        return published;
      }));
    assert.equal(updated.runtimeGeneration, 8);
    assert.equal(await readBeeNameLaunchReservation(old.name), null);
  });
});

test("every replacement operation leaves a generation-bound fence after a post-dispatch crash", async () => {
  for (const operation of ["revive", "promote", "demote", "set-model", "swap-account"] as const) {
    await withTempStore(async () => {
      const old = { ...publishedTmuxRecord(`replacement-crash-${operation}`), runtimeGeneration: 3 };
      await saveSession(old);
      await assert.rejects(
        withSessionLifecycleTransaction(old, (lifecycle) =>
          withBeeReplacementLaunchAdmission(lifecycle, operation, async (reservation) => {
            await reservation.markLaunchDispatch();
            await reservation.recordTmuxLaunch({
              substrate: "local-tmux",
              target: old.tmuxTarget,
              launch: {
                paneId: "%99",
                launcherPgid: 99_321,
                launcherFingerprint: { pgid: 99_321, startedAt: "Sat Aug 15 12:02:00 2026" },
              },
            });
            throw new Error("injected coordinator crash before locator commit");
          })),
        /injected coordinator crash/,
      );
      const journal = await readBeeNameLaunchReservation(old.name);
      assert.equal(journal?.phase, "launched", operation);
      assert.equal(journal?.operation, operation);
      assert.equal(journal?.replacementOf?.runtimeGeneration, 3);
      let called = false;
      await assert.rejects(
        withSessionLifecycleTransaction(old, (lifecycle) =>
          withBeeReplacementLaunchAdmission(lifecycle, operation, async () => {
            called = true;
          })),
        /launch reservation already owns name/,
      );
      assert.equal(called, false, `${operation} replay never dispatches a second runtime`);
    });
  }
});

test("replacement admission refuses a canonical delivery marker before any journal or stop fence", async () => {
  await withTempStore(async () => {
    const old: SessionRecord = { ...publishedTmuxRecord("replacement-delivery-doubt"), runtimeGeneration: 6 };
    const deliveryId = "0198beef-0000-7000-8000-000000000001";
    old.deliveryStopDoubt = {
      version: 1,
      deliveryId,
      contentDigest: "a".repeat(64),
      source: {
        createdAt: old.createdAt,
        runtimeGeneration: 6,
        id: old.id,
        uuid: old.uuid,
      },
      createdAt: "2026-08-15T12:05:00.000Z",
      fenceError: `delivery ${deliveryId} is ambiguous`,
    };
    await saveSession(old);

    await assert.rejects(
      withSessionLifecycleTransaction(old, (lifecycle) =>
        beginBeeReplacementOperation(lifecycle, "swap-account")),
      new RegExp(deliveryId),
    );
    assert.equal(await readBeeNameLaunchReservation(old.name), null, "replacement created no launch journal");
    const current = await loadSession(old.name);
    assert.equal(current?.status, "running", "replacement created no predecessor-stop fence");
    assert.equal(current?.runtimeGeneration, 6);
    assert.equal(current?.deliveryStopDoubt?.deliveryId, deliveryId);
  });
});

test("stopping journal round-trips and same-operation replay adopts after the prior call unwinds", async () => {
  await withTempStore(async () => {
    const old = { ...publishedTmuxRecord("replacement-stopping-replay"), runtimeGeneration: 4 };
    await saveSession(old);

    await assert.rejects(
      withSessionLifecycleTransaction(old, async (lifecycle) => {
        await beginBeeReplacementOperation(lifecycle, "promote");
        assert.equal((await loadSession(old.name))?.status, "kill_failed");
        throw new Error("injected crash before predecessor stop");
      }),
      /injected crash/,
    );
    const stopped = await readBeeNameLaunchReservation(old.name);
    assert.equal(stopped?.phase, "stopping");
    assert.equal(stopped?.replacementOf?.runtimeGeneration, 4);

    const fenced = (await loadSession(old.name))!;
    await assert.rejects(
      withSessionLifecycleTransaction(fenced, (lifecycle) =>
        beginBeeReplacementOperation(lifecycle, "demote")),
      /refusing to reinterpret it as demote/,
    );

    await withSessionLifecycleTransaction(fenced, async (lifecycle) => {
      const adopted = await beginBeeReplacementOperation(lifecycle, "promote");
      assert.equal(adopted.id, stopped?.reservationId, "same-process daemon retry adopts the settled call");
      // Test fixture supplies the exact predecessor-stop proof here.
      await adopted.clearAfterConfirmedStop();
      await lifecycle.commit({ status: "running", lastError: undefined });
    });
    assert.equal(await readBeeNameLaunchReservation(old.name), null);
    assert.equal((await loadSession(old.name))?.status, "running");
  });
});

test("kill repairs a stopping attempt after exact predecessor teardown", async () => {
  await withTempStore(async () => {
    const old = { ...publishedTmuxRecord("replacement-stopping-purge"), runtimeGeneration: 2 };
    await saveSession(old);
    await withSessionLifecycleTransaction(old, async (lifecycle) => {
      await beginBeeReplacementOperation(lifecycle, "revive");
    });
    const fenced = (await loadSession(old.name))!;
    assert.equal(fenced.status, "kill_failed");
    assert.equal((await readBeeNameLaunchReservation(old.name))?.phase, "stopping");

    const substrate = {
      kind: "local-tmux",
      node: "local",
      hasSession: async () => false,
      kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as Substrate;
    const result = await transactionalKill(fenced, {
      substrate,
      emitLedger: false,
      pollIntervalMs: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(await loadSession(old.name), null);
    assert.equal(await readBeeNameLaunchReservation(old.name), null);
  });
});

test("crash in predecessor stopping admits no direct or queued work", async () => {
  await withTempStore(async () => {
    const old = { ...publishedTmuxRecord("replacement-stopping-work-fence"), runtimeGeneration: 1 };
    await saveSession(old);
    await withSessionLifecycleTransaction(old, async (lifecycle) => {
      await beginBeeReplacementOperation(lifecycle, "set-model");
    });
    const fenced = (await loadSession(old.name))!;
    let transports = 0;
    let livenessChecks = 0;
    await assert.rejects(
      deliverSessionText(fenced, "must not reach the predecessor", {
        deliver: async () => { transports += 1; },
      }),
      /unresolved launch ownership/,
    );
    await assert.rejects(
      wakeRuntimeForQueuedSend(fenced, {
        isLive: async () => { livenessChecks += 1; return true; },
      }),
      /unresolved launch ownership/,
    );
    assert.equal(transports, 0);
    assert.equal(livenessChecks, 0);
  });
});

test("a launched journal with a canonical running row admits no direct, wake, or automatic recovery work", async () => {
  await withTempStore(async (root) => {
    const name = "reservation-running-journal-work-fence";
    const createdAt = "2026-08-15T12:10:00.000Z";
    const birth: ProcessBirthFingerprint = {
      pgid: 48_322,
      startedAt: "Sat Aug 15 12:10:00 2026",
    };
    const record: SessionRecord = {
      name,
      agent: "stub",
      requestedAgent: "stub",
      cwd: "/tmp",
      command: "stub",
      launchArgv: ["stub"],
      tmuxTarget: name,
      substrate: "hsr",
      runnerPid: birth.pgid,
      runnerFingerprint: birth,
      providerSessionId: `thread-${name}`,
      runtimeGeneration: 1,
      id: `id-${name}`,
      uuid: `uuid-${name}`,
      createdAt,
      updatedAt: createdAt,
      status: "running",
    };
    await saveSession(record);
    const coordinatorFingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(coordinatorFingerprint);
    await writeReservationFixture(root, {
      version: 1,
      reservationId: "canonical-fence-write-failed",
      name,
      operation: "spawn",
      phase: "launched",
      coordinatorPid: process.pid,
      coordinatorFingerprint: coordinatorFingerprint!,
      createdAt,
      updatedAt: createdAt,
      runtime: {
        kind: "hsr",
        substrate: "hsr",
        hostPid: birth.pgid,
        hostFingerprint: birth,
        childAdmission: "admitted",
      },
      lastError: "canonical kill_failed fence could not be committed",
    });

    let transports = 0;
    let livenessChecks = 0;
    let revives = 0;
    await assert.rejects(
      deliverSessionText(record, "must not cross unresolved publication", {
        deliver: async () => { transports += 1; },
      }),
      /unresolved launch ownership \(launched\)/,
    );
    await assert.rejects(
      wakeRuntimeForQueuedSend(record, {
        isLive: async () => { livenessChecks += 1; return true; },
      }),
      /unresolved launch ownership \(launched\)/,
    );
    await assert.rejects(
      reviveHsrForAutomaticRecovery(record, "journal-fence", {
        revive: async (candidate) => { revives += 1; return candidate; },
      }),
      /unresolved launch ownership \(launched\)/,
    );
    assert.equal(transports, 0);
    assert.equal(livenessChecks, 0);
    assert.equal(revives, 0);
  });
});

test("remote publication is bound to the pre-dispatch client id and returned incarnation", async () => {
  await withTempStore(async () => {
    const name = "reservation-remote-publish";
    const createdAt = "2026-08-15T12:15:00.000Z";
    const record: SessionRecord = {
      name,
      agent: "node",
      requestedAgent: "node",
      cwd: "/remote/work",
      command: process.execPath,
      launchArgv: [process.execPath],
      tmuxTarget: name,
      node: "remote-one",
      remoteLaunchId: "launch-123",
      remoteIncarnation: "incarnation-456",
      id: `id-${name}`,
      uuid: `uuid-${name}`,
      createdAt,
      updatedAt: createdAt,
      status: "running",
    };

    await withBeeNameLaunchAdmission(name, async (reservation) => {
      await reservation.markRemoteLaunchDispatch({ node: record.node!, remoteLaunchId: record.remoteLaunchId! });
      const dispatched = await readBeeNameLaunchReservation(name);
      assert.deepEqual(dispatched?.runtime, {
        kind: "remote-hsr",
        substrate: "remote-hsr",
        node: record.node,
        remoteLaunchId: record.remoteLaunchId,
      });
      await reservation.recordRemoteLaunch({
        node: record.node!,
        remoteLaunchId: record.remoteLaunchId!,
        remoteIncarnation: record.remoteIncarnation!,
      });
      await saveSession(record);
      await reservation.promoteExternallyPublished(record);
    });
    assert.equal(await readBeeNameLaunchReservation(name), null);
  });
});

test("coordinator failure after newSession leaves the exact runtime fenced", async () => {
  await withTempStore(async () => {
    const name = "reservation-crash";
    await assert.rejects(
      withBeeNameLaunchAdmission(name, async (reservation) => {
        await reservation.markLaunchDispatch();
        await reservation.recordTmuxLaunch({
          substrate: "local-tmux",
          target: name,
          launch: tmuxLaunch(),
        });
        throw new Error("simulated coordinator crash before publication");
      }),
      /simulated coordinator crash/,
    );

    const residue = await readBeeNameLaunchReservation(name);
    assert.equal(residue?.phase, "launched");
    assert.deepEqual(residue?.runtime, {
      kind: "tmux",
      substrate: "local-tmux",
      target: name,
      paneId: "%42",
      launcherPgid: LAUNCH_BIRTH.pgid,
      launcherFingerprint: LAUNCH_BIRTH,
    });
    let relaunched = false;
    await assert.rejects(
      withBeeNameLaunchAdmission(name, async () => {
        relaunched = true;
        throw new Error("must not run");
      }),
      /launch reservation already owns name/,
    );
    assert.equal(relaunched, false);
  });
});

test("concurrent same-name admission serializes through one reservation", async () => {
  await withTempStore(async () => {
    const name = "reservation-concurrent";
    const record = publishedTmuxRecord(name);
    const hold = gate();
    const first = withBeeNameLaunchAdmission(name, async (reservation) => {
      await reservation.markLaunchDispatch();
      await reservation.recordTmuxLaunch({ substrate: "local-tmux", target: name, launch: tmuxLaunch() });
      hold.enter();
      await hold.wait;
      await saveSession(record);
      await reservation.promotePublished(record);
      return record;
    });
    await hold.entered;

    let secondLaunched = false;
    const second = assert.rejects(
      withBeeNameLaunchAdmission(name, async () => {
        secondLaunched = true;
        throw new Error("must not launch twice");
      }),
      /session record already owns name/,
    );
    hold.release();
    await first;
    await second;
    assert.equal(secondLaunched, false);
  });
});

test("cursor-less terminal legacy rows remain intentionally reusable", async () => {
  await withTempStore(async () => {
    const name = "reservation-legacy-row";
    await saveSession({
      ...publishedTmuxRecord(name, "2026-08-14T00:00:00.000Z"),
      status: "dead",
      agentPaneId: undefined,
      launcherPgid: undefined,
      launcherFingerprint: undefined,
    });
    const replacement = publishedTmuxRecord(name, "2026-08-15T12:30:00.000Z");

    await withBeeNameLaunchAdmission(name, async (reservation) => {
      await reservation.markLaunchDispatch();
      await reservation.recordTmuxLaunch({ substrate: "local-tmux", target: name, launch: tmuxLaunch() });
      await saveSession(replacement);
      await reservation.promotePublished(replacement);
    });

    assert.equal((await loadSession(name))?.createdAt, replacement.createdAt);
    assert.equal(await readBeeNameLaunchReservation(name), null);
  });
});

test("published unlink residue is cleared before purge so the name can be reused", async () => {
  await withTempStore(async (root) => {
    const name = "reservation-published-purge";
    const published = { ...publishedTmuxRecord(name), status: "dead" as const };
    await saveSession(published);
    const coordinatorFingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(coordinatorFingerprint);
    await writeReservationFixture(root, {
      version: 1,
      reservationId: "published-unlink-failed",
      name,
      operation: "spawn",
      phase: "published",
      coordinatorPid: process.pid,
      coordinatorFingerprint: coordinatorFingerprint!,
      createdAt: published.createdAt,
      updatedAt: published.updatedAt,
      runtime: {
        kind: "tmux",
        substrate: "local-tmux",
        target: name,
        paneId: published.agentPaneId!,
        launcherPgid: published.launcherPgid,
        launcherFingerprint: published.launcherFingerprint,
      },
      publishedRecord: {
        createdAt: published.createdAt,
        id: published.id,
        uuid: published.uuid,
        runtimeGeneration: published.runtimeGeneration ?? 0,
      },
    });

    assert.equal(await purgeSessionData(published, { emitLedger: false }), true);
    assert.equal(await loadSession(name), null);
    assert.equal(await readBeeNameLaunchReservation(name), null);

    const replacement = publishedTmuxRecord(name, "2026-08-15T13:00:00.000Z");
    await withBeeNameLaunchAdmission(name, async (reservation) => {
      await reservation.markLaunchDispatch();
      await reservation.recordTmuxLaunch({ substrate: "local-tmux", target: name, launch: tmuxLaunch() });
      await saveSession(replacement);
      await reservation.promotePublished(replacement);
    });
    assert.equal((await loadSession(name))?.createdAt, replacement.createdAt);
  });
});

test("matching legacy publication remains fenced when journal unlink fails", async () => {
  await withTempStore(async (root) => {
    const name = "reservation-heal-unlink-failure";
    const published = { ...publishedTmuxRecord(name), status: "dead" as const };
    await saveSession(published);
    const coordinatorFingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(coordinatorFingerprint);
    await writeReservationFixture(root, {
      version: 1,
      reservationId: "published-heal-unlink-failed",
      name,
      operation: "spawn",
      phase: "published",
      coordinatorPid: process.pid,
      coordinatorFingerprint: coordinatorFingerprint!,
      createdAt: published.createdAt,
      updatedAt: published.updatedAt,
      runtime: {
        kind: "tmux",
        substrate: "local-tmux",
        target: name,
        paneId: published.agentPaneId!,
        launcherPgid: published.launcherPgid,
        launcherFingerprint: published.launcherFingerprint,
      },
      publishedRecord: {
        createdAt: published.createdAt,
        id: published.id,
        uuid: published.uuid,
        runtimeGeneration: published.runtimeGeneration ?? 0,
      },
    });

    const directory = dirname(beeNameLaunchReservationPath(name));
    let entered = false;
    await chmod(directory, 0o500);
    try {
      await assert.rejects(withBeeNameLaunchAdmission(name, async () => {
        entered = true;
        throw new Error("must not overwrite while unlink is uncertain");
      }));
    } finally {
      await chmod(directory, 0o700);
    }
    assert.equal(entered, false);
    assert.equal((await readBeeNameLaunchReservation(name))?.phase, "published");
    assert.equal((await loadSession(name))?.createdAt, published.createdAt);
  });
});

test("stopping an old row cannot clear a locatorless newer dispatch", async () => {
  await withTempStore(async (root) => {
    const name = "reservation-old-row-new-dispatch";
    const old = { ...publishedTmuxRecord(name), status: "dead" as const };
    await saveSession(old);
    const coordinatorFingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(coordinatorFingerprint);
    await writeReservationFixture(root, {
      version: 1,
      reservationId: "unknown-new-dispatch",
      name,
      operation: "spawn",
      phase: "dispatching",
      coordinatorPid: process.pid,
      coordinatorFingerprint: coordinatorFingerprint!,
      createdAt: "2026-08-15T12:59:00.000Z",
      updatedAt: "2026-08-15T12:59:00.000Z",
      lastError: "newSession returned but locator persistence failed",
    });
    const substrate = {
      kind: "local-tmux",
      node: "local",
      hasSession: async () => false,
      kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as Substrate;

    await assert.rejects(
      transactionalKill(old, { substrate, emitLedger: false, pollIntervalMs: 0 }),
      /non-matching launch reservation still owns the name/,
    );
    assert.equal((await loadSession(name))?.createdAt, old.createdAt, "old row remains as purge retry evidence");
    assert.equal((await readBeeNameLaunchReservation(name))?.phase, "dispatching");
  });
});

test("target absence cannot clear a partial tmux locator without birth proof", async () => {
  await withTempStore(async (root) => {
    const name = "reservation-partial-pane-new-launch";
    const old: SessionRecord = {
      ...publishedTmuxRecord(name),
      status: "dead",
      agentPaneId: undefined,
      launcherPgid: undefined,
      launcherFingerprint: undefined,
    };
    await saveSession(old);
    const coordinatorFingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(coordinatorFingerprint);
    await writeReservationFixture(root, {
      version: 1,
      reservationId: "partial-new-tmux-launch",
      name,
      operation: "spawn",
      phase: "launched",
      coordinatorPid: process.pid,
      coordinatorFingerprint: coordinatorFingerprint!,
      createdAt: "2026-08-15T12:59:30.000Z",
      updatedAt: "2026-08-15T12:59:30.000Z",
      runtime: {
        kind: "tmux",
        substrate: "local-tmux",
        target: name,
        paneId: "%noisy-partial-pane",
      },
    });
    const substrate = {
      kind: "local-tmux",
      node: "local",
      hasSession: async () => false,
      kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as Substrate;

    await assert.rejects(
      transactionalKill(old, { substrate, emitLedger: false, pollIntervalMs: 0 }),
      /non-matching launch reservation still owns the name/,
    );
    assert.equal((await loadSession(name))?.createdAt, old.createdAt);
    assert.equal((await readBeeNameLaunchReservation(name))?.phase, "launched");
  });
});

test("only a birth-proven dead pre-dispatch owner is reclaimable", async () => {
  await withTempStore(async (root) => {
    const now = "2026-08-15T12:00:00.000Z";
    const stale: BeeNameLaunchReservationRecord = {
      version: 1,
      reservationId: "dead-coordinator",
      name: "reservation-pre-dispatch-dead",
      operation: "spawn",
      phase: "reserved",
      coordinatorPid: 99_999_999,
      coordinatorFingerprint: { pgid: 99_999_999, startedAt: "Thu Jan 01 00:00:00 1970" },
      createdAt: now,
      updatedAt: now,
    };
    await writeReservationFixture(root, stale);

    let admitted = false;
    await assert.rejects(
      withBeeNameLaunchAdmission(stale.name, async () => {
        admitted = true;
        throw new Error("fresh prelaunch failure");
      }),
      /fresh prelaunch failure/,
    );
    assert.equal(admitted, true);
    assert.equal(await readBeeNameLaunchReservation(stale.name), null);

    const liveFingerprint = await captureProcessBirthFingerprint(process.ppid);
    assert.ok(liveFingerprint);
    const live = {
      ...stale,
      reservationId: "live-coordinator",
      name: "reservation-pre-dispatch-live",
      coordinatorPid: process.ppid,
      coordinatorFingerprint: liveFingerprint!,
    };
    await writeReservationFixture(root, live);
    await assert.rejects(
      withBeeNameLaunchAdmission(live.name, async () => {
        throw new Error("must not steal live coordinator");
      }),
      /launch reservation already owns name/,
    );
  });
});

test("post-dispatch ambiguity never becomes reclaimable when its coordinator dies", async () => {
  await withTempStore(async (root) => {
    const now = "2026-08-15T12:00:00.000Z";
    const record: BeeNameLaunchReservationRecord = {
      version: 1,
      reservationId: "dead-after-dispatch",
      name: "reservation-dispatch-unknown",
      operation: "spawn",
      phase: "dispatching",
      coordinatorPid: 99_999_999,
      coordinatorFingerprint: { pgid: 99_999_999, startedAt: "Thu Jan 01 00:00:00 1970" },
      createdAt: now,
      updatedAt: now,
    };
    await writeReservationFixture(root, record);

    await assert.rejects(
      withBeeNameLaunchAdmission(record.name, async () => {
        throw new Error("must remain fenced");
      }),
      /launch reservation already owns name.*dispatching/,
    );
  });
});

test("impossible phase and locator combinations fail closed instead of being reclaimed", async () => {
  await withTempStore(async (root) => {
    const now = "2026-08-15T12:00:00.000Z";
    const malformed: BeeNameLaunchReservationRecord = {
      version: 1,
      reservationId: "reserved-with-runtime",
      name: "reservation-malformed-phase",
      operation: "spawn",
      phase: "reserved",
      coordinatorPid: 99_999_999,
      coordinatorFingerprint: { pgid: 99_999_999, startedAt: "Thu Jan 01 00:00:00 1970" },
      createdAt: now,
      updatedAt: now,
      runtime: {
        kind: "tmux",
        substrate: "local-tmux",
        target: "reservation-malformed-phase",
        paneId: "%42",
        launcherPgid: LAUNCH_BIRTH.pgid,
        launcherFingerprint: LAUNCH_BIRTH,
      },
    };
    await writeReservationFixture(root, malformed);
    let entered = false;
    await assert.rejects(
      withBeeNameLaunchAdmission(malformed.name, async () => {
        entered = true;
        throw new Error("must not launch");
      }),
      /launch reservation.*malformed/,
    );
    assert.equal(entered, false);
  });
});

test("journal parser rejects impossible phase shapes and invalid coordinator identity", async () => {
  await withTempStore(async (root) => {
    const now = "2026-08-15T12:00:00.000Z";
    const base = (name: string): BeeNameLaunchReservationRecord => ({
      version: 1,
      reservationId: `fixture-${name}`,
      name,
      operation: "spawn",
      phase: "reserved",
      coordinatorPid: process.pid,
      coordinatorFingerprint: LAUNCH_BIRTH,
      createdAt: now,
      updatedAt: now,
    });
    const invalid: BeeNameLaunchReservationRecord[] = [
      {
        ...base("parser-dispatch-local-runtime"),
        phase: "dispatching",
        runtime: {
          kind: "tmux",
          substrate: "local-tmux",
          target: "parser-dispatch-local-runtime",
          paneId: "%42",
        },
      },
      { ...base("parser-launched-no-runtime"), phase: "launched" },
      {
        ...base("parser-published-no-record-proof"),
        phase: "published",
        runtime: {
          kind: "tmux",
          substrate: "local-tmux",
          target: "parser-published-no-record-proof",
          paneId: "%42",
          launcherFingerprint: LAUNCH_BIRTH,
        },
      },
      { ...base("parser-zero-coordinator"), coordinatorPid: 0 },
      {
        ...base("parser-dispatch-returned-incarnation"),
        phase: "dispatching",
        runtime: {
          kind: "remote-hsr",
          substrate: "remote-hsr",
          node: "remote-one",
          remoteLaunchId: "launch-before-dispatch",
          remoteIncarnation: "incarnation-cannot-be-pre-dispatch",
        },
      },
    ];

    for (const record of invalid) {
      await writeReservationFixture(root, record);
      await assert.rejects(readBeeNameLaunchReservation(record.name), /launch reservation.*malformed/);
    }
  });
});

test("local HSR run-dir residue fences reuse even when meta is missing or exited", async () => {
  await withTempStore(async () => {
    const missingMeta = "reservation-hsr-dir-only";
    await mkdir(hsrRunDir(missingMeta), { recursive: true });
    await assert.rejects(
      withBeeNameLaunchAdmission(missingMeta, async () => {
        throw new Error("must not launch over HSR residue");
      }),
      /HSR run state already owns name/,
    );

    const exited = "reservation-hsr-exited";
    await writeHsrMeta(exited, {
      bee: exited,
      harness: "stub",
      tier: "stream",
      hostPid: 47_777,
      hostFingerprint: { pgid: 47_777, startedAt: "Sat Aug 15 10:00:00 2026" },
      childAdmission: "none",
      startedAt: "2026-08-15T10:00:00.000Z",
      endedAt: "2026-08-15T10:01:00.000Z",
      controlSocket: "/tmp/reservation-hsr-exited.sock",
      status: "exited",
    });
    await assert.rejects(
      withBeeNameLaunchAdmission(exited, async () => {
        throw new Error("must not launch over exited HSR residue");
      }),
      /HSR run state already owns name/,
    );
  });
});
