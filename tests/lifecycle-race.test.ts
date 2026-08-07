import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviveRecord } from "../src/commands/migrate.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import { transactionalKill, transactionalRetire } from "../src/kill.js";
import { LifecycleConflictError } from "../src/lifecycle.js";
import { deleteSession, loadSession, saveSession, updateSession, type SessionRecord } from "../src/store.js";
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
      const current = { paneId: `%new-${launchCount}`, live: true };
      runtimes.set(current.paneId, current);
      await rig.onLaunch?.();
      return { paneId: current.paneId };
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
    assert.equal(statusAtLaunch, "done");
    assert.equal(revived.status, "running");
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

test("HSR revive whose record disappears never fabricates a fallback and stops its exact host", async () => {
  await withTempStore(async () => {
    const record: SessionRecord = {
      ...seed("hsr-cas-loss"),
      status: "dead",
      substrate: "hsr",
      tmuxTarget: "hsr-cas-loss",
    };
    await saveSession(record);
    let stoppedPid: number | undefined;

    await assert.rejects(
      reviveRecord(record, {
        fresh: true,
        spawnHsrHost: async () => 42_424,
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
