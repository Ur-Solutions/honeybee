import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviveRecord, stopRuntimeForAuthResume } from "../src/commands/migrate.js";
import { deliverPromptToBee } from "../src/commands/run.js";
import { reconcileAmbiguousBuzDelivery } from "../src/buz.js";
import { reconcileRuntimeDeaths } from "../src/daemon/runtimeRecovery.js";
import { deliverSessionText } from "../src/delivery.js";
import { persistDeliveryDoubt } from "../src/deliveryDoubt.js";
import {
  claimPendingHsrTurnOnHost,
  enqueuePendingHsrTurn,
  HsrDeliveryAmbiguousError,
  markPendingHsrTurnAccepted,
  markPendingHsrTurnCompleted,
  preservePendingHsrTurnReceiptsForPurge,
  readPendingHsrTurns,
  withHsrTurnDeliveryLock,
} from "../src/hsr/pendingTurns.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import { ensureHsrRunDir, hsrControlSocketPath, writeHsrMeta } from "../src/hsr/runDir.js";
import { transactionalKill, transactionalRetire } from "../src/kill.js";
import { LifecycleConflictError, withSessionLifecycleLock, withSessionLifecycleTransaction } from "../src/lifecycle.js";
import { beginBeeReplacementOperation, readBeeNameLaunchReservation } from "../src/nameAdmission.js";
import { recordRunnableSessionSeal } from "../src/sealAdmission.js";
import { readBeeRequests } from "../src/requests/store.js";
import { createSshTmuxSubstrate, type SshTmuxExecHook } from "../src/substrates/ssh-tmux.js";
import { deleteSession, loadSession, saveSession, transitionSession, updateSession, type SessionRecord } from "../src/store.js";
import type { KillResult, NewSessionResult, Substrate } from "../src/substrates/types.js";

async function withTempStore<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hive-lifecycle-race-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function seed(name: string): SessionRecord {
  return {
    name,
    agent: "stub",
    requestedAgent: "stub",
    cwd: "/tmp",
    command: process.execPath,
    launchArgv: [process.execPath, "--lifecycle-race-fixture"],
    tmuxTarget: name,
    id: name,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    status: "running",
  };
}

function ok(): KillResult {
  return { ok: true, stdout: "", stderr: "", exitCode: 0 };
}

type Runtime = { paneId: string; live: boolean };

function fakeTmux(initiallyLive: boolean): {
  substrate: Substrate;
  runtime: () => Runtime | null;
  launches: () => number;
  kills: () => number;
  addReplacement: (paneId: string) => void;
  panes: () => Set<string>;
  onLaunch?: () => Promise<void>;
} {
  const runtimes = new Map<string, Runtime>();
  if (initiallyLive) runtimes.set("%old", { paneId: "%old", live: true });
  let launchCount = 0;
  let killCount = 0;
  const rig: ReturnType<typeof fakeTmux> = {
    substrate: undefined as unknown as Substrate,
    runtime: () => [...runtimes.values()].at(-1) ?? null,
    launches: () => launchCount,
    kills: () => killCount,
    addReplacement: (paneId) => { runtimes.set(paneId, { paneId, live: true }); },
    panes: () => new Set(runtimes.keys()),
  };
  rig.substrate = {
    kind: "local-tmux",
    node: "local",
    probe: async () => ({ ok: true }),
    hasSession: async () => runtimes.size > 0,
    newSession: async (): Promise<NewSessionResult> => {
      launchCount += 1;
      const current = { paneId: `%${100 + launchCount}`, live: true };
      runtimes.set(current.paneId, current);
      await rig.onLaunch?.();
      const launcherPgid = 41_000 + launchCount;
      return {
        paneId: current.paneId,
        launcherPgid,
        launcherFingerprint: { pgid: launcherPgid, startedAt: `fake-launch-${launchCount}` },
      };
    },
    kill: async () => {
      killCount += 1;
      runtimes.clear();
      return ok();
    },
    killIncarnation: async (_target, launch) => {
      runtimes.delete(launch.paneId);
      return ok();
    },
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => runtimes.size > 0 ? ["live"] : [],
    listPanes: async () => new Set(runtimes.keys()),
    listSessionStates: async () => new Map(),
    setUserOptions: async () => undefined,
    setWindowOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => [],
    attachSession: async () => undefined,
  };
  return rig;
}

function deferred(): { entered: Promise<void>; enter: () => void; wait: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => { enter = resolve; }),
    enter: () => enter(),
    wait: new Promise<void>((resolve) => { release = resolve; }),
    release: () => release(),
  };
}

test("kill owns post-teardown/pre-purge: a concurrent revive never launches", async () => {
  await withTempStore(async () => {
    const record = seed("kill-before-revive");
    await saveSession(record);
    const rig = fakeTmux(true);
    const gate = deferred();

    const killing = transactionalKill(record, {
      substrate: rig.substrate,
      pollIntervalMs: 0,
      emitLedger: false,
      afterTeardown: async () => { gate.enter(); await gate.wait; },
    });
    await gate.entered;
    const reviving = reviveRecord(record, { fresh: true, substrate: rig.substrate });
    gate.release();

    assert.equal((await killing).ok, true);
    await assert.rejects(reviving, LifecycleConflictError);
    assert.equal(rig.launches(), 0);
    assert.equal(rig.runtime(), null);
    assert.equal(await loadSession(record.name), null);
  });
});

test("new-turn delivery refuses unresolved stop ownership before transport", async () => {
  await withTempStore(async () => {
    const record = { ...seed("delivery-stop-doubt"), status: "kill_failed" as const };
    await saveSession(record);
    let transports = 0;

    await assert.rejects(
      deliverSessionText(record, "do more work", {
        deliver: async () => { transports += 1; },
      }),
      /unresolved stop state/,
    );
    assert.equal(transports, 0);
    assert.equal((await loadSession(record.name))?.status, "kill_failed");
  });
});

test("direct delivery carries one stable operation id and exposes durable ambiguity", async () => {
  await withTempStore(async () => {
    const record = seed("delivery-id-manual-fence");
    await saveSession(record);
    let suppliedId: string | undefined;

    await assert.rejects(
      deliverSessionText(record, "one uncertain turn", {
        makeActionId: () => "action-42",
        deliver: async (_current, _text, options) => {
          suppliedId = options?.deliveryId;
          throw new HsrDeliveryAmbiguousError(options!.deliveryId!, "provider outcome unknown");
        },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );

    assert.equal(suppliedId, `delivery:${record.name}:action-42`);
    const request = (await readBeeRequests(record.name)).find((candidate) =>
      candidate.evidence.source === "hsr-delivery" && candidate.status === "open");
    assert.ok(request, "uncertain non-Buz work is visible as a durable manual action");
    assert.deepEqual(request.input, { deliveryId: suppliedId });
  });
});

test("transport acceptance followed by SessionRecord publication failure stays typed and visible", async () => {
  await withTempStore(async () => {
    const record = { ...seed("delivery-post-accept-commit-failure"), substrate: "hsr" as const };
    await saveSession(record);
    let transports = 0;
    await assert.rejects(
      deliverSessionText(record, "accepted before metadata failure", {
        deliveryId: "post-accept-id",
        deliver: async () => {
          transports += 1;
          await deleteSession(record.name);
        },
      }),
      (error: unknown) =>
        (error as { code?: unknown; deliveryId?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS" &&
        (error as { deliveryId?: unknown }).deliveryId === "post-accept-id",
    );
    assert.equal(transports, 1);
    assert.ok((await readBeeRequests(record.name)).some((request) =>
      request.status === "open" && request.evidence.detail === "delivery-ambiguous"));
  });
});

test("ambiguity request persistence failure never masks the typed accepted boundary", async () => {
  await withTempStore(async () => {
    const record = { ...seed("delivery-request-store-failure"), substrate: "hsr" as const };
    await saveSession(record);
    await assert.rejects(
      deliverSessionText(record, "accepted before both stores fail", {
        deliveryId: "post-accept-request-fail",
        deliver: async () => { await deleteSession(record.name); },
        openAmbiguityRequest: async () => { throw new Error("request store unavailable"); },
      }),
      (error: unknown) => {
        const typed = error as Error & { code?: unknown; deliveryId?: unknown; cause?: unknown };
        assert.equal(typed.code, "HIVE_HSR_DELIVERY_AMBIGUOUS");
        assert.equal(typed.deliveryId, "post-accept-request-fail");
        assert.ok(typed.cause instanceof AggregateError);
        return true;
      },
    );
  });
});

test("post-accept metadata doubt fences fresh ids until an operator confirms delivery", async () => {
  await withTempStore(async () => {
    const record = { ...seed("delivery-doubt-fresh-id-fence"), substrate: "hsr" as const };
    await saveSession(record);
    let transports = 0;
    await assert.rejects(
      deliverSessionText(record, "one accepted effect", {
        deliveryId: "metadata-doubt-id",
        deliver: async () => { transports += 1; },
        metadata: () => { throw new Error("metadata callback fault"); },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    await assert.rejects(
      deliverSessionText(record, "fresh duplicate", {
        deliveryId: "fresh-id-must-not-send",
        deliver: async () => { transports += 1; },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.equal(transports, 1, "fresh work cannot cross the bee-scoped delivery-doubt fence");

    assert.deepEqual(await reconcileAmbiguousBuzDelivery(record.name, "metadata-doubt-id", "delivered"), {
      verdict: "delivered",
      mailbox: "absent",
    });
    await deliverSessionText(record, "later independent work", {
      deliveryId: "later-safe-id",
      deliver: async () => { transports += 1; },
    });
    assert.equal(transports, 2);
  });
});

test("exact HSR receipt remains the fence when generic delivery-doubt persistence fails", async () => {
  await withTempStore(async () => {
    const record = { ...seed("delivery-doubt-fallback-receipt"), substrate: "hsr" as const };
    const deliveryId = "fallback-receipt-id";
    const text = "provider already accepted this exact turn";
    const host = {
      hostPid: 8121,
      startedAt: "2026-08-15T15:00:00.000Z",
      hostFingerprint: { pgid: 8121, startedAt: "fallback-host-birth" },
    };
    await saveSession(record);
    await withHsrTurnDeliveryLock(record.name, () => enqueuePendingHsrTurn(record.name, text, { deliveryId }));
    await claimPendingHsrTurnOnHost(record.name, deliveryId, text, "turn", host);
    await markPendingHsrTurnAccepted(record.name, deliveryId, host);
    let transports = 0;

    await assert.rejects(
      deliverSessionText(record, text, {
        deliveryId,
        deliver: async () => { transports += 1; },
        metadata: () => { throw new Error("injected metadata failure"); },
        persistDeliveryDoubt: async () => { throw new Error("injected doubt-store failure"); },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.equal((await readPendingHsrTurns(record.name))[0]?.phase, "ambiguous");
    await assert.rejects(
      deliverSessionText(record, "fresh id must not cross", { deliveryId: "fresh-after-sidecar-failure" }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.equal(transports, 1);
  });
});

test("completed dual-copy receipt is never demoted; canonical fallback fences metadata doubt", async () => {
  await withTempStore(async () => {
    const record = { ...seed("completed-receipt-canonical-fallback"), substrate: "hsr" as const };
    const deliveryId = "completed-fallback-id";
    const text = "provider completion already proven";
    const host = {
      hostPid: 8131,
      startedAt: "2026-08-15T15:10:00.000Z",
      hostFingerprint: { pgid: 8131, startedAt: "completed-host-birth" },
    };
    await saveSession(record);
    await withHsrTurnDeliveryLock(record.name, () => enqueuePendingHsrTurn(record.name, text, { deliveryId }));
    await claimPendingHsrTurnOnHost(record.name, deliveryId, text, "turn", host);
    await markPendingHsrTurnCompleted(record.name, deliveryId, host);
    await preservePendingHsrTurnReceiptsForPurge(record.name);
    let transports = 0;
    await assert.rejects(
      deliverSessionText(record, text, {
        deliveryId,
        deliver: async () => { transports += 1; },
        metadata: () => { throw new Error("injected post-completion metadata failure"); },
        persistDeliveryDoubt: async () => { throw new Error("injected generic doubt failure"); },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.equal((await readPendingHsrTurns(record.name))[0]?.phase, "completed");
    const fenced = await loadSession(record.name);
    assert.equal(fenced?.status, "kill_failed");
    await assert.rejects(
      deliverSessionText(fenced!, "fresh work", { deliver: async () => { transports += 1; } }),
      /unresolved stop state/,
    );
    assert.equal(transports, 1);
  });
});

test("run prompt mirror failures after acceptance are repair-only", async () => {
  await withTempStore(async () => {
    const record = seed("run-post-accept-mirrors");
    await saveSession(record);
    let deliveries = 0;
    const deliveredAt = await deliverPromptToBee(record, "run exactly once", {
      deliver: async () => { deliveries += 1; },
      writeState: async () => { throw new Error("injected hive-state mirror failure"); },
      appendLedger: async () => { throw new Error("injected ledger mirror failure"); },
    });
    assert.equal(deliveries, 1);
    assert.match(deliveredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await loadSession(record.name))?.lastPrompt, "run exactly once");
  });
});

test("manual delivery reconciliation waits behind the bee lifecycle authority", async () => {
  await withTempStore(async () => {
    const record = seed("reconcile-lifecycle-order");
    const deliveryId = "reconcile-lifecycle-id";
    await saveSession(record);
    await persistDeliveryDoubt(record, deliveryId, "accepted work", "injected post-accept publication doubt");
    const gate = deferred();
    const holding = withSessionLifecycleLock(record.name, async () => {
      gate.enter();
      await gate.wait;
    });
    await gate.entered;
    let reconciled = false;
    const repairing = reconcileAmbiguousBuzDelivery(record.name, deliveryId, "delivered").then((value) => {
      reconciled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reconciled, false, "reconcile cannot mutate receipts beneath kill/revive lifecycle ownership");
    gate.release();
    await holding;
    assert.equal((await repairing).mailbox, "absent");
  });
});

test("discard reconciliation permits later work but the old exact id remains cancelled", async () => {
  await withTempStore(async () => {
    const record = { ...seed("delivery-doubt-discard-tombstone"), substrate: "hsr" as const };
    await saveSession(record);
    let transports = 0;
    await assert.rejects(
      deliverSessionText(record, "discard this uncertain effect", {
        deliveryId: "discarded-effect-id",
        deliver: async () => { transports += 1; },
        metadata: () => { throw new Error("metadata callback fault"); },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    await reconcileAmbiguousBuzDelivery(record.name, "discarded-effect-id", "discard");
    await assert.rejects(
      deliverSessionText(record, "discard this uncertain effect", {
        deliveryId: "discarded-effect-id",
        deliver: async () => { transports += 1; },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_DISCARDED",
    );
    await deliverSessionText(record, "new work after discard", {
      deliveryId: "new-after-discard",
      deliver: async () => { transports += 1; },
    });
    assert.equal(transports, 2, "discard tombstone blocks only the old exact id");
  });
});

for (const operation of ["kill", "retire"] as const) {
  test(`${operation} persists stop intent before dispatch so a coordinator crash cannot reopen work`, async () => {
    await withTempStore(async () => {
      const record = seed(`${operation}-dispatch-crash-fence`);
      await saveSession(record);
      const rig = fakeTmux(true);

      const stop = operation === "kill" ? transactionalKill : transactionalRetire;
      await assert.rejects(
        stop(record, {
          substrate: rig.substrate,
          pollIntervalMs: 0,
          emitLedger: false,
          afterStopDispatch: async (dispatched) => {
            assert.equal(dispatched.status, "kill_failed", "durable fence precedes the first stop effect");
            assert.match(dispatched.lastError ?? "", /stop is in progress/);
            throw new Error("injected coordinator crash after stop dispatch");
          },
        }),
        /injected coordinator crash/,
      );

      const fenced = await loadSession(record.name);
      assert.ok(fenced);
      assert.equal(fenced.status, "kill_failed");
      assert.match(fenced.lastError ?? "", /exact runtime cleanup is not yet confirmed/);

      let transports = 0;
      await assert.rejects(
        deliverSessionText(fenced, "must not cross interrupted stop", {
          deliver: async () => { transports += 1; },
        }),
        /unresolved stop state/,
      );
      assert.equal(transports, 0);

      let recoveryProbes = 0;
      const decisions = await reconcileRuntimeDeaths([fenced], {
        probe: async () => {
          recoveryProbes += 1;
          return {
            evidence: {
              kind: "probe",
              probeId: "must-not-run",
              observerId: "test",
              observedAt: new Date().toISOString(),
              outcome: "dead",
              target: { substrate: "local-tmux", tmuxTarget: fenced.tmuxTarget },
            },
          };
        },
        transition: async () => undefined,
      });
      assert.deepEqual(decisions, []);
      assert.equal(recoveryProbes, 0, "automatic recovery never interprets interrupted stop as a crash");
    });
  });
}

test("delivery and retire have one lifecycle order with no post-stop paste", async () => {
  await withTempStore(async () => {
    const record = seed("delivery-before-retire");
    await saveSession(record);
    const rig = fakeTmux(true);
    const gate = deferred();
    let transports = 0;

    const delivering = deliverSessionText(record, "one admitted turn", {
      deliver: async () => {
        transports += 1;
        gate.enter();
        await gate.wait;
      },
    });
    await gate.entered;
    let retireSettled = false;
    const retiring = transactionalRetire(record, {
      substrate: rig.substrate,
      pollIntervalMs: 0,
      emitLedger: false,
    }).finally(() => { retireSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(retireSettled, false, "retire waits behind the admitted transport");

    gate.release();
    await delivering;
    assert.equal((await retiring).ok, true);
    assert.equal(transports, 1);
    assert.equal((await loadSession(record.name))?.status, "done");

    await assert.rejects(
      deliverSessionText(record, "late turn", { deliver: async () => { transports += 1; } }),
      /archived/,
    );
    assert.equal(transports, 1, "no transport occurs after stop wins");
  });
});

test("exact retire settles a failed replacement journal so a later explicit revive can own the name", async () => {
  await withTempStore(async () => {
    const record = { ...seed("retire-replacement-recovery"), runtimeGeneration: 4 };
    await saveSession(record);
    await withSessionLifecycleTransaction(record, async (lifecycle) => {
      await beginBeeReplacementOperation(lifecycle, "set-model");
    });
    const fenced = (await loadSession(record.name))!;
    assert.equal(fenced.status, "kill_failed");
    assert.equal((await readBeeNameLaunchReservation(record.name))?.phase, "stopping");

    const stopRig = fakeTmux(false);
    const retired = await transactionalRetire(fenced, {
      substrate: stopRig.substrate,
      pollIntervalMs: 0,
      emitLedger: false,
    });
    assert.equal(retired.ok, true);
    assert.equal((await loadSession(record.name))?.stateMachine?.lifecycle, "archived");
    assert.equal(await readBeeNameLaunchReservation(record.name), null);

    const reviveRig = fakeTmux(false);
    const revived = await reviveRecord((await loadSession(record.name))!, {
      fresh: true,
      substrate: reviveRig.substrate,
    });
    assert.equal(reviveRig.launches(), 1);
    assert.equal(revived.stateMachine?.lifecycle, "active");
    assert.equal(revived.runtimeGeneration, 5);
    assert.equal(await readBeeNameLaunchReservation(record.name), null);
  });
});

test("idempotent retire heals a predecessor journal left after the canonical archive transition", async () => {
  await withTempStore(async () => {
    const record = { ...seed("retire-archive-journal-repair"), runtimeGeneration: 2 };
    await saveSession(record);
    await withSessionLifecycleTransaction(record, async (lifecycle) => {
      await beginBeeReplacementOperation(lifecycle, "swap-account");
    });
    const at = new Date().toISOString();
    const archived = await transitionSession(record.name, {
      eventId: `test-retire:${record.name}`,
      at,
      type: "bee.archived",
      cause: "retire",
      evidence: { kind: "operator", actionId: `test-retire:${record.name}`, observedAt: at, action: "retire" },
      probe: {
        kind: "probe",
        probeId: `test-retire:${record.name}:probe`,
        observerId: "test",
        observedAt: at,
        outcome: "dead",
        target: { substrate: "local-tmux", tmuxTarget: record.tmuxTarget },
      },
    });
    assert.ok(archived);
    assert.equal((await readBeeNameLaunchReservation(record.name))?.phase, "stopping");

    const rig = fakeTmux(false);
    const result = await transactionalRetire(archived.record, {
      substrate: rig.substrate,
      pollIntervalMs: 0,
      emitLedger: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyGone, true);
    assert.equal(rig.kills(), 0, "archive proof repairs metadata without another stop effect");
    assert.equal(await readBeeNameLaunchReservation(record.name), null);
  });
});

test("retire winning the lifecycle race prevents every seal artifact and mirror effect", async () => {
  await withTempStore(async () => {
    const record = seed("seal-after-stop-intent");
    await saveSession(record);
    const rig = fakeTmux(true);
    const gate = deferred();

    const retiring = transactionalRetire(record, {
      substrate: rig.substrate,
      pollIntervalMs: 0,
      emitLedger: false,
      afterStopDispatch: async () => { gate.enter(); await gate.wait; },
    });
    await gate.entered;

    let sealWrites = 0;
    let mirrors = 0;
    const sealing = recordRunnableSessionSeal(record, {
      status: "done",
      summary: "must not publish after stop intent",
    }, {
      mirrorDone: true,
      writeSeal: async (name, artifact) => {
        sealWrites += 1;
        return { ...artifact, beeName: name, sealedAt: new Date().toISOString() };
      },
      writeMirror: async () => { mirrors += 1; },
    });

    gate.release();
    assert.equal((await retiring).ok, true);
    await assert.rejects(sealing, /archived/);
    assert.equal(sealWrites, 0);
    assert.equal(mirrors, 0);
  });
});

test("revive owns post-launch/pre-update: stale kill cannot purge or signal the replacement", async () => {
  await withTempStore(async () => {
    const record = { ...seed("revive-before-kill"), status: "dead" as const };
    await saveSession(record);
    const rig = fakeTmux(false);
    const gate = deferred();

    const reviving = reviveRecord(record, {
      fresh: true,
      substrate: rig.substrate,
      afterLaunch: async () => { gate.enter(); await gate.wait; },
    });
    await gate.entered;
    const killing = transactionalKill(record, { substrate: rig.substrate, pollIntervalMs: 0, emitLedger: false });
    gate.release();

    const revived = await reviving;
    assert.equal(revived.runtimeGeneration, 1);
    await assert.rejects(killing, LifecycleConflictError);
    assert.equal(rig.kills(), 0, "stale kill never signals the launched replacement");
    assert.equal(rig.runtime()?.live, true);
    assert.equal((await loadSession(record.name))?.runtimeGeneration, 1);
  });
});

test("local revive resolves failed-stop ownership before launching a replacement", async () => {
  await withTempStore(async () => {
    const record = {
      ...seed("revive-stop-doubt"),
      status: "kill_failed" as const,
      launcherPgid: 4242,
      launcherFingerprint: { pgid: 4242, startedAt: "Fri Aug  7 10:00:00 2026" },
    };
    await saveSession(record);
    const rig = fakeTmux(false);

    const revived = await reviveRecord(record, { fresh: true, substrate: rig.substrate });
    assert.equal(rig.kills(), 1, "birth-qualified cleanup precedes replacement launch");
    assert.equal(rig.launches(), 1);
    assert.equal(revived.status, "running");
    assert.equal(revived.lastError, undefined);
    assert.equal(revived.runtimeGeneration, 1);
  });
});

test("target-gone local revive still exact-stops a persisted launcher group before launch", async () => {
  await withTempStore(async () => {
    const record = {
      ...seed("revive-target-gone-group"),
      status: "dead" as const,
      launcherPgid: 4343,
      launcherFingerprint: { pgid: 4343, startedAt: "Fri Aug  7 10:05:00 2026" },
    };
    await saveSession(record);
    const rig = fakeTmux(false);

    const revived = await reviveRecord(record, { fresh: true, substrate: rig.substrate });
    assert.equal(rig.kills(), 1, "target absence never substitutes for exact group cleanup");
    assert.equal(rig.launches(), 1);
    assert.equal(revived.status, "running");
  });
});

test("local revive refuses failed-stop ownership without exact launcher identity", async () => {
  await withTempStore(async () => {
    const record = { ...seed("revive-stop-doubt-legacy"), status: "kill_failed" as const };
    await saveSession(record);
    const rig = fakeTmux(false);

    await assert.rejects(
      reviveRecord(record, { fresh: true, substrate: rig.substrate }),
      /unresolved stop state and no exact launcher identity/,
    );
    assert.equal(rig.kills(), 0);
    assert.equal(rig.launches(), 0);
    assert.equal((await loadSession(record.name))?.status, "kill_failed");
  });
});

test("retire commits done before a queued revive launches a new generation", async () => {
  await withTempStore(async () => {
    const record = seed("retire-before-revive");
    await saveSession(record);
    const rig = fakeTmux(true);
    const gate = deferred();
    let statusAtLaunch: SessionRecord["status"] | undefined;
    rig.onLaunch = async () => { statusAtLaunch = (await loadSession(record.name))?.status; };

    const retiring = transactionalRetire(record, {
      substrate: rig.substrate,
      pollIntervalMs: 0,
      emitLedger: false,
      afterTeardown: async () => { gate.enter(); await gate.wait; },
    });
    await gate.entered;
    const reviving = reviveRecord(record, { fresh: true, substrate: rig.substrate });
    gate.release();

    assert.equal((await retiring).ok, true);
    const revived = await reviving;
    assert.equal(statusAtLaunch, "kill_failed", "replacement work is fenced before launch dispatch");
    assert.equal(revived.status, "running");
    assert.equal(revived.stateMachine?.lifecycle, "active", "legacy records seed archived on retire and revive through the table");
    assert.equal(revived.stateMachine?.lastTransition.type, "bee.revived");
    assert.equal(revived.stateMachine?.revision, 2);
    assert.equal(revived.runtimeGeneration, 1);
    assert.equal(rig.runtime()?.live, true);
  });
});

test("revive owns post-launch/pre-update: stale retire cannot mark the replacement done", async () => {
  await withTempStore(async () => {
    const record = { ...seed("revive-before-retire"), status: "dead" as const };
    await saveSession(record);
    const rig = fakeTmux(false);
    const gate = deferred();

    const reviving = reviveRecord(record, {
      fresh: true,
      substrate: rig.substrate,
      afterLaunch: async () => { gate.enter(); await gate.wait; },
    });
    await gate.entered;
    const retiring = transactionalRetire(record, { substrate: rig.substrate, pollIntervalMs: 0, emitLedger: false });
    gate.release();

    await reviving;
    await assert.rejects(retiring, LifecycleConflictError);
    assert.equal(rig.kills(), 0, "stale retire never signals the launched replacement");
    assert.equal((await loadSession(record.name))?.status, "running");
    assert.equal((await loadSession(record.name))?.runtimeGeneration, 1);
  });
});

test("tmux revive that loses its generation CAS tears down only its launched pane", async () => {
  await withTempStore(async () => {
    const record = { ...seed("tmux-cas-loss"), status: "dead" as const };
    await saveSession(record);
    const rig = fakeTmux(false);

    await assert.rejects(
      reviveRecord(record, {
        fresh: true,
        substrate: rig.substrate,
        afterLaunch: async (launch) => {
          assert.equal(launch.kind, "tmux");
          rig.addReplacement("%replacement");
          await updateSession(record.name, {
            runtimeGeneration: 7,
            status: "running",
            agentPaneId: "%replacement",
          });
        },
      }),
      LifecycleConflictError,
    );

    assert.deepEqual(rig.panes(), new Set(["%replacement"]), "exact cleanup preserves the replacement pane");
    assert.equal((await loadSession(record.name))?.runtimeGeneration, 7);
  });
});

test("replacement commit rejects a legacy terminal status write without a generation bump", async () => {
  await withTempStore(async () => {
    const record = { ...seed("legacy-terminal-cas"), status: "dead" as const };
    await saveSession(record);
    const rig = fakeTmux(false);

    await assert.rejects(
      reviveRecord(record, {
        fresh: true,
        substrate: rig.substrate,
        afterLaunch: async () => {
          // Mixed-version terminal writer: status + target teardown, but no
          // runtimeGeneration bump. The replacement must not overwrite done
          // with running after its newly launched pane was killed.
          await updateSession(record.name, { status: "done" });
          await rig.substrate.kill(record.tmuxTarget);
        },
      }),
      LifecycleConflictError,
    );

    assert.equal(rig.runtime(), null, "the exact launched replacement is absent");
    const persisted = await loadSession(record.name);
    assert.equal(persisted?.status, "done", "terminal legacy truth wins the CAS");
    assert.equal(persisted?.runtimeGeneration, undefined, "legacy writer did not need a generation bump");
  });
});

test("remote tmux revive that loses its CAS refuses missing-pane cleanup while its child group survives", async () => {
  await withTempStore(async () => {
    const oldStartedAt = "Fri Aug  7 09:00:00 2026";
    const record = {
      ...seed("remote-tmux-cas-loss"),
      status: "dead" as const,
      node: "mini01",
      launcherPgid: 4141,
      launcherFingerprint: { pgid: 4141, startedAt: oldStartedAt },
    };
    await saveSession(record);
    const signals: string[] = [];
    const startedAt = "Fri Aug  7 10:00:00 2026";
    const hook: SshTmuxExecHook = async (argv, input) => {
      if (argv.includes("has-session")) return { stdout: "", stderr: "can't find session", exitCode: 1 };
      if (argv.includes("new-session") || input?.includes("new-session")) {
        return { stdout: "%77:4242\n", stderr: "", exitCode: 0 };
      }
      if (argv.includes("/bin/ps")) {
        if (argv.some((part) => part.includes("4141"))) return { stdout: "", stderr: "", exitCode: 1 };
        return { stdout: `4242 1 4242 ${startedAt}\n`, stderr: "", exitCode: 0 };
      }
      if (argv.includes("/bin/kill")) {
        const signal = argv.find((word) => /^-(?:0|TERM|KILL)$/.test(word)) ?? "unknown";
        signals.push(signal);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (argv.includes("kill-pane") || argv.includes("list-panes")) {
        return { stdout: "", stderr: "can't find pane: %77", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const remote = createSshTmuxSubstrate({
      node: {
        name: "mini01",
        kind: "ssh-tmux",
        endpoint: "trmd@mini01",
        capabilities: ["*"],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      execHook: hook,
      sleep: async () => undefined,
    });
    // Exact predecessor cleanup is already authority-confirmed; the rest of
    // this regression targets the separately launched successor's CAS-loss
    // cleanup and must not conflate those two generations.
    remote.kill = async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0, incarnationStopped: true });

    await assert.rejects(
      reviveRecord(record, {
        fresh: true,
        substrate: remote,
        afterLaunch: async (launch) => {
          assert.equal(launch.kind, "tmux");
          assert.deepEqual(launch.result.launcherFingerprint, { pgid: 4242, startedAt });
          await updateSession(record.name, { runtimeGeneration: 7, status: "running" });
        },
      }),
      /exact launched tmux incarnation cleanup failed.*absence unconfirmed/,
    );

    assert.ok(signals.includes("-TERM"));
    assert.ok(signals.includes("-KILL"));
    assert.equal((await loadSession(record.name))?.runtimeGeneration, 7);
  });
});

test("auth-resume stop aborts on a liveness probe error instead of launching from assumed absence", async () => {
  const record = seed("auth-resume-probe-error");
  const rig = fakeTmux(true);
  let kills = 0;
  rig.substrate.hasSession = async () => { throw new Error("tmux probe failed"); };
  rig.substrate.kill = async () => {
    kills += 1;
    return ok();
  };

  await assert.rejects(
    stopRuntimeForAuthResume(record, rig.substrate),
    /initial liveness observation failed.*tmux probe failed/,
  );
  assert.equal(kills, 0);
});

test("auth-resume stop rejects an unconfirmed exact-group kill", async () => {
  const record = {
    ...seed("auth-resume-kill-error"),
    launcherPgid: 4242,
    launcherFingerprint: { pgid: 4242, startedAt: "Fri Aug  7 10:00:00 2026" },
  };
  const rig = fakeTmux(true);
  rig.substrate.kill = async () => ({
    ok: false,
    stdout: "",
    stderr: "matching launcher group remains live",
    exitCode: 1,
  });

  await assert.rejects(
    stopRuntimeForAuthResume(record, rig.substrate),
    /exact cleanup unconfirmed.*matching launcher group remains live/,
  );
  assert.equal(rig.runtime()?.live, true);
});

test("HSR revive whose record disappears never fabricates a fallback and stops its exact host", async () => {
  await withTempStore(async () => {
    const record: SessionRecord = {
      ...seed("hsr-cas-loss"),
      status: "dead",
      substrate: "hsr",
      tmuxTarget: "hsr-cas-loss",
    };
    await saveSession(record);
    await ensureHsrRunDir(record.name);
    await writeHsrMeta(record.name, {
      bee: record.name,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: { pgid: process.pid, startedAt: "prior-test-host-birth" },
      childAdmission: "none",
      startedAt: "2026-08-06T00:00:00.000Z",
      endedAt: "2026-08-06T00:01:00.000Z",
      startupFailure: {
        stage: "adapter-start",
        message: "fixture provider was durably never started",
      },
      controlSocket: hsrControlSocketPath(record.name),
      status: "exited",
    });
    let stoppedPid: number | undefined;

    await assert.rejects(
      reviveRecord(record, {
        fresh: true,
        spawnHsrHost: async () => {
          await ensureHsrRunDir(record.name);
          await writeHsrMeta(record.name, {
            bee: record.name,
            harness: "stub",
            tier: "stream",
            hostPid: 42_424,
            hostFingerprint: { pgid: 42_424, startedAt: "test-host-birth" },
            childAdmission: "none",
            startedAt: "2026-08-07T00:00:00.000Z",
            controlSocket: hsrControlSocketPath(record.name),
            status: "queued",
          });
          return 42_424;
        },
        waitForHsrHost: async () => true,
        stopHsrIncarnation: async (bee, hostPid) => {
          assert.equal(bee, record.name);
          stoppedPid = hostPid;
          return ok();
        },
        afterLaunch: async (launch) => {
          assert.equal(launch.kind, "hsr");
          await deleteSession(record.name);
        },
      }),
      LifecycleConflictError,
    );

    assert.equal(stoppedPid, 42_424, "cleanup is fenced to the exact host returned by spawn");
    assert.equal(await hsrSubstrate().hasSession(record.name), false);
    assert.equal(await loadSession(record.name), null, "a lost HSR commit cannot recreate the deleted record");
  });
});
