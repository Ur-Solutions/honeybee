import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  activeSessionIndexPath,
  appendLedger,
  flushPaneStampRepairs,
  pendingPaneStampRepairNames,
  deleteSession,
  isActiveSessionRecord,
  ledgerPath,
  listActiveSessions,
  listActiveSessionsHot,
  listSessions,
  listSessionsStrict,
  loadSession,
  rebuildActiveSessionIndex,
  safeName,
  saveSession,
  shouldPersistObservationHeartbeat,
  touchSession,
  updateSession,
  type SessionRecord,
} from "../src/store.js";

function makeRecord(dir: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CO.abc",
    agent: "codex",
    cwd: dir,
    command: "codex",
    tmuxTarget: "CO-abc",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-store-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
}

function withProbe(outcome: "alive" | "dead" = "dead") {
  return {
    probeEvidence: {
      kind: "probe" as const,
      probeId: `store-test-${outcome}`,
      observerId: "store-test",
      observedAt: "2026-05-28T00:00:00.000Z",
      outcome,
      target: { substrate: "local-tmux" as const, tmuxTarget: "CO-abc" },
    },
  };
}

test("safeName neutralizes empty and dot-only path segments", () => {
  assert.equal(safeName("CO.abc"), "CO.abc");
  assert.equal(safeName("bad/name"), "bad-name");
  assert.equal(safeName("."), "-");
  assert.equal(safeName(".."), "--");
  assert.equal(safeName("..."), "---");
  assert.equal(safeName(""), "-");
});

test("active-session policy keeps every active lifecycle probeable", () => {
  const record = makeRecord("/tmp");
  assert.equal(isActiveSessionRecord(record), true);
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "auth-needed" }), true);
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "blocked" }), true, "needs-input remains daemon-visible");
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "node_unreachable" }), true);
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "error" }), true, "provider errors can recover");
  assert.equal(isActiveSessionRecord({ ...record, status: "kill_failed", lastObservedState: "kill_failed" }), true, "unconfirmed teardown remains observable");
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "crashed" }), true);
  assert.equal(isActiveSessionRecord({ ...record, status: "dead", lastObservedState: "crashed", recoveryRequestedAt: "2026-08-10T00:00:00.000Z" }), true, "durable recovery stays daemon-visible");
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "done" }), true, "completion remains probeable while lifecycle is active");
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "sealed" }), true);
  assert.equal(isActiveSessionRecord({ ...record, status: "dead" }), false);
  assert.equal(isActiveSessionRecord({ ...record, status: "done" }), false);
});

test("store root is read at call time and session files are private", async () => {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-store-"));
  process.env.HIVE_STORE_ROOT = dir;

  try {
    const record: SessionRecord = {
      name: "CO.abc",
      agent: "codex",
      cwd: dir,
      launchArgv: ["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.6-sol"],
      command: "codex",
      tmuxTarget: "CO-abc",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
      status: "running",
      title: "Repair Title Inheritance",
    };

    await saveSession(record);
    assert.deepEqual(await loadSession(record.name), record);
    assert.equal((await stat(join(dir, "sessions", "CO.abc.json"))).mode & 0o777, 0o600);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateSession merges a patch field-level under the session lock", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir, { notes: "keep me" }));

    const merged = await updateSession("CO.abc", { title: "New Title", status: "dead" });
    assert.equal(merged?.title, "New Title");
    assert.equal(merged?.status, "dead");
    assert.equal(merged?.notes, "keep me");

    const reloaded = await loadSession("CO.abc");
    assert.equal(reloaded?.title, "New Title");
    assert.equal(reloaded?.notes, "keep me");

    assert.equal(await updateSession("missing", { title: "x" }), null);
  });
});

test("updateSession deletes fields patched to explicit undefined", async () => {
  await withTempStore(async (dir) => {
    // An HSR bee about to be promoted onto tmux.
    await saveSession(makeRecord(dir, { substrate: "hsr", runnerPid: 4242, runnerTier: "turn" }));

    const merged = await updateSession("CO.abc", {
      status: "running",
      agentPaneId: "%7",
      substrate: undefined,
      runnerPid: undefined,
      runnerTier: undefined,
    });
    assert.equal(merged?.agentPaneId, "%7");
    assert.equal("substrate" in (merged ?? {}), false);
    assert.equal("runnerPid" in (merged ?? {}), false);
    assert.equal("runnerTier" in (merged ?? {}), false);

    const reloaded = await loadSession("CO.abc");
    assert.equal(reloaded?.agentPaneId, "%7");
    assert.equal(reloaded?.substrate, undefined);
    assert.equal(reloaded?.runnerPid, undefined);
    assert.equal(reloaded?.runnerTier, undefined);
  });
});

test("active index keeps terminal cursors probeable until explicit retire", async () => {
  await withTempStore(async () => {
    const record = makeRecord("/tmp", { accountId: "codex-a" });
    await saveSession(record);
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name]);

    await touchSession(record.name, { lastObservedState: "crashed", lastObservedStateAt: "2026-05-28T00:01:00.000Z" }, withProbe("dead"));
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name], "crash stays in the probe set");
    assert.equal((await loadSession(record.name))?.lastObservedState, "crashed", "history remains explicitly readable");

    await updateSession(record.name, {
      recoveryRequestedAt: "2026-05-28T00:01:01.000Z",
      recoveryMessageId: "019c0000-0000-7000-8000-000000000001",
      recoveryAttemptCount: 1,
      recoveryNextAttemptAt: "2026-05-28T00:01:06.000Z",
    });
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name], "recovery request re-enters the hot index without changing observed state");
    const recovering = await loadSession(record.name);
    assert.equal(recovering?.status, "running");
    assert.equal(recovering?.lastObservedState, "crashed");

    await updateSession(record.name, {
      recoveryRequestedAt: undefined,
      recoveryMessageId: undefined,
      recoveryAttemptCount: undefined,
      recoveryNextAttemptAt: undefined,
    });
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name], "resolved recovery remains probeable");

    await updateSession(record.name, { status: "running", lastObservedState: undefined, lastObservedStateAt: undefined }, withProbe("alive"));
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name], "revive re-enters the index");

    await touchSession(record.name, { lastObservedState: "done", lastObservedStateAt: "2026-05-28T00:02:00.000Z" }, withProbe("alive"));
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name], "settled turn remains probeable");
    await updateSession(record.name, { status: "running", lastObservedState: undefined, lastObservedStateAt: undefined, lastPrompt: "follow up" }, withProbe("alive"));
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name], "a follow-up turn reactivates the warm runtime");

    await updateSession(record.name, { status: "done" });
    assert.deepEqual(await listActiveSessions(), [], "retire removes operational membership");
    assert.equal((await listSessions()).length, 1, "retire never deletes the file-per-record history");
  });
});

test("active index rebuilds after missing/corrupt state and normalizes legacy archived records", async () => {
  await withTempStore(async (dir) => {
    const sessions = join(dir, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "CO.live.json"), JSON.stringify(makeRecord(dir, { name: "CO.live" })));
    await writeFile(join(sessions, "CO.old.json"), JSON.stringify(makeRecord(dir, {
      name: "CO.old",
      status: "archived" as unknown as "done",
    })));

    assert.equal(await rebuildActiveSessionIndex(), 1);
    assert.deepEqual((await listActiveSessions()).map((record) => record.name), ["CO.live"]);
    assert.equal((await listSessions()).find((record) => record.name === "CO.old")?.status, "done");

    await writeFile(activeSessionIndexPath(), "{broken");
    assert.deepEqual((await listActiveSessions()).map((record) => record.name), ["CO.live"], "corruption triggers an authoritative rebuild");
    await rm(activeSessionIndexPath(), { force: true });
    assert.deepEqual((await listActiveSessions()).map((record) => record.name), ["CO.live"], "missing index triggers an authoritative rebuild");
  });
});

test("canonical active-index reconciliation waits through a multi-scan churn burst and publishes only the stable generation", async () => {
  await withTempStore(async (dir) => {
    const sessions = join(dir, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "CO.before.json"), JSON.stringify(makeRecord(dir, {
      name: "CO.before",
      tmuxTarget: "CO.before",
    })));
    const attempts: number[] = [];
    const delays: number[] = [];
    let now = 0;

    const active = await rebuildActiveSessionIndex({
      deadlineMs: 1_000,
      now: () => now,
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms);
        now += ms;
      },
      onAttempt: async (attempt) => {
        attempts.push(attempt);
        if (attempt > 4) return;
        await writeFile(join(sessions, `CO.raced-${attempt}.json`), JSON.stringify(makeRecord(dir, {
          name: `CO.raced-${attempt}`,
          tmuxTarget: `CO.raced-${attempt}`,
        })));
        const generation = new Date(Date.UTC(2040, 0, 1, 0, 0, attempt));
        await utimes(sessions, generation, generation);
      },
    });

    assert.equal(active, 5);
    assert.deepEqual(attempts, [1, 2, 3, 4, 5], "churn beyond the old three-attempt cap recovers once stable");
    assert.deepEqual(delays, [25, 50, 100, 200], "retry uses deterministic capped exponential backoff");
    assert.deepEqual(
      (await listActiveSessionsHot()).map((record) => record.name).sort(),
      ["CO.before", "CO.raced-1", "CO.raced-2", "CO.raced-3", "CO.raced-4"],
    );
  });
});

test("continuous active-index churn fails at the deadline and preserves the prior projection", async () => {
  await withTempStore(async (dir) => {
    const sessions = join(dir, "sessions");
    await mkdir(sessions, { recursive: true });
    const stable = makeRecord(dir, { name: "CO.stable", tmuxTarget: "CO.stable" });
    await writeFile(join(sessions, `${stable.name}.json`), JSON.stringify(stable));
    await rebuildActiveSessionIndex();
    const projectionBefore = await readFile(activeSessionIndexPath(), "utf8");
    const attempts: number[] = [];
    const delays: number[] = [];
    let now = 0;

    await assert.rejects(
      () => rebuildActiveSessionIndex({
        deadlineMs: 100,
        now: () => now,
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        onAttempt: async (attempt) => {
          attempts.push(attempt);
          const name = `CO.continuous-${attempt}`;
          await writeFile(join(sessions, `${name}.json`), JSON.stringify(makeRecord(dir, {
            name,
            tmuxTarget: name,
          })));
          const generation = new Date(Date.UTC(2040, 0, 2, 0, 0, attempt));
          await utimes(sessions, generation, generation);
        },
      }),
      /session directories changed during 3 active-index reconciliation attempts within the 100ms deadline; prior projection preserved/,
    );

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(delays, [25, 50, 25], "the last delay is clamped to the remaining deadline");
    assert.equal(now, 100, "the injected clock proves retry exhaustion is bounded without real-time sleeps");
    assert.equal(await readFile(activeSessionIndexPath(), "utf8"), projectionBefore);
    assert.deepEqual(
      (await listActiveSessionsHot()).map((record) => record.name),
      [stable.name],
      "an unsuccessful scan never exposes its partial/new membership",
    );
  });
});

test("concurrent safety callers share one reconciliation snapshot after a legacy generation advance", async () => {
  await withTempStore(async (dir) => {
    const indexed = makeRecord(dir, { name: "CO.shared-old", tmuxTarget: "CO.shared-old" });
    await saveSession(indexed);
    await listActiveSessions();

    const added = makeRecord(dir, { name: "CO.shared-new", tmuxTarget: "CO.shared-new" });
    await writeFile(join(dir, "sessions", `${added.name}.json`), JSON.stringify(added));
    const generation = new Date(Date.UTC(2040, 0, 3));
    await utimes(join(dir, "sessions"), generation, generation);

    let snapshotReads = 0;
    let snapshotReady!: () => void;
    const entered = new Promise<void>((resolve) => { snapshotReady = resolve; });
    let releaseSnapshot!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const first = listActiveSessions({
      onSnapshotRead: async () => {
        snapshotReads += 1;
        snapshotReady();
        await gate;
      },
    });
    await entered;
    let joined!: () => void;
    const secondJoined = new Promise<void>((resolve) => { joined = resolve; });
    const second = listActiveSessions({
      onSafetyFlight: (disposition) => {
        if (disposition === "joined") joined();
      },
    });
    await secondJoined;
    releaseSnapshot();

    const [firstRecords, secondRecords] = await Promise.all([first, second]);
    const expected = [indexed.name, added.name].sort();
    assert.deepEqual(firstRecords.map((record) => record.name).sort(), expected);
    assert.deepEqual(secondRecords.map((record) => record.name).sort(), expected);
    assert.equal(snapshotReads, 1, "the later caller joins the root-scoped safety flight");
  });
});

test("pre-v3 active index rebuilds immediately so terminal cursors become probeable", async () => {
  await withTempStore(async (dir) => {
    const indexed = makeRecord(dir, { name: "CO.v1-indexed", tmuxTarget: "CO.v1-indexed" });
    const omitted = makeRecord(dir, { name: "CO.v1-crashed", tmuxTarget: "CO.v1-crashed", lastObservedState: "crashed" });
    await saveSession(indexed);
    await saveSession(omitted, withProbe("dead"));
    const root = dir;
    const active = [indexed.name];
    const updatedAt = "2026-08-07T00:00:00.000Z";
    const checksum = createHash("sha256")
      .update(JSON.stringify({ version: 1, root, active }))
      .digest("hex");
    const legacy = `${JSON.stringify({
      version: 1,
      complete: true,
      root,
      active,
      checksum,
      updatedAt,
    }, null, 2)}\n`;
    await writeFile(activeSessionIndexPath(), legacy);

    assert.deepEqual((await listActiveSessionsHot()).map((record) => record.name).sort(), [indexed.name, omitted.name].sort());
    const rebuilt = JSON.parse(await readFile(activeSessionIndexPath(), "utf8")) as { version: number; active: string[] };
    assert.equal(rebuilt.version, 3);
    assert.deepEqual(rebuilt.active.sort(), [indexed.name, omitted.name].sort());
  });
});

test("direct active listing trusts an unchanged fresh generation without a canonical rewrite", async () => {
  await withTempStore(async (dir) => {
    const indexed = makeRecord(dir, { name: "CO.fresh-index", tmuxTarget: "CO.fresh-index" });
    await saveSession(indexed);
    await listActiveSessions();
    const before = await readFile(activeSessionIndexPath(), "utf8");

    assert.deepEqual((await listActiveSessions()).map((record) => record.name), [indexed.name]);
    assert.equal(
      await readFile(activeSessionIndexPath(), "utf8"),
      before,
      "a fresh process pays only index + directory stat reads when no canonical writer generation changed",
    );
  });
});

test("direct active listing discovers an older-writer record without a daemon or manual rebuild", async () => {
  await withTempStore(async (dir) => {
    const indexed = makeRecord(dir, { name: "CO.indexed", tmuxTarget: "CO.indexed" });
    await saveSession(indexed);
    await listActiveSessions();

    // Exact mixed-version writer: it atomically owns only the canonical
    // SessionRecord and knows nothing about active-sessions.json.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const oldWriter = makeRecord(dir, { name: "CO.old-writer", tmuxTarget: "CO.old-writer" });
    await writeFile(join(dir, "sessions", "CO.old-writer.json"), JSON.stringify(oldWriter));

    const before = JSON.parse(await readFile(activeSessionIndexPath(), "utf8")) as {
      active: string[];
      checksum: string;
    };
    assert.deepEqual(before.active, ["CO.indexed"], "the still-valid checksum index initially omits the legacy write");
    assert.equal(typeof before.checksum, "string");
    assert.deepEqual(
      (await listActiveSessionsHot()).map((record) => record.name),
      ["CO.indexed"],
      "the daemon's separately reconciled hot projection remains non-blocking",
    );
    assert.deepEqual(
      (await listActiveSessions()).map((record) => record.name).sort(),
      ["CO.indexed", "CO.old-writer"],
      "a direct safety-sensitive caller performs its startup canonical pass",
    );
  });
});

test("a later strict caller cannot join stale records after the global index advances", async () => {
  await withTempStore(async (dir) => {
    const indexed = makeRecord(dir, { name: "CO.flight-old", tmuxTarget: "CO.flight-old" });
    await saveSession(indexed);
    await listActiveSessions();
    let snapshotRead!: () => void;
    const snapshotReady = new Promise<void>((resolveReady) => { snapshotRead = resolveReady; });
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolveGate) => { releaseSnapshot = resolveGate; });
    const first = listActiveSessions({
      onSnapshotRead: async () => {
        snapshotRead();
        await snapshotGate;
      },
    });
    await snapshotReady;

    const oldWriter = makeRecord(dir, { name: "CO.flight-new", tmuxTarget: "CO.flight-new" });
    const temporary = join(dir, "sessions", ".CO.flight-new.legacy-tmp");
    await writeFile(temporary, JSON.stringify(oldWriter));
    await rename(temporary, join(dir, "sessions", "CO.flight-new.json"));
    // A background reconciler can publish G+1 while A still holds its old G
    // records. B must compare against the generation attached to A's result,
    // never this newer global index.
    await rebuildActiveSessionIndex();
    const second = listActiveSessions();
    releaseSnapshot();

    assert.deepEqual((await first).map((record) => record.name), [indexed.name], "the first call linearizes before the writer");
    assert.deepEqual(
      (await second).map((record) => record.name).sort(),
      [indexed.name, oldWriter.name].sort(),
      "the later caller validates its own generation instead of inheriting the old flight",
    );
  });
});

test("ambiguous active-record read retains membership without suppressing healthy active rows", async () => {
  await withTempStore(async (dir) => {
    const record = makeRecord(dir, { name: "CO.transient", tmuxTarget: "CO.transient" });
    const healthy = makeRecord(dir, { name: "CO.healthy", tmuxTarget: "CO.healthy" });
    await saveSession(record);
    await saveSession(healthy);
    const path = join(dir, "sessions", "CO.transient.json");
    const valid = await readFile(path, "utf8");

    // Model an atomic writer's transient/torn read window. Parse failure is not
    // authoritative absence and must never be converted to index deletion.
    await writeFile(path, "{\"name\":");
    assert.deepEqual(
      (await listActiveSessionsHot()).map((candidate) => candidate.name),
      ["CO.healthy"],
      "one unreadable record does not blind every healthy active bee",
    );
    const afterFailure = JSON.parse(await readFile(activeSessionIndexPath(), "utf8")) as { active: string[] };
    assert.deepEqual(afterFailure.active, ["CO.healthy", "CO.transient"]);

    await writeFile(path, valid);
    assert.deepEqual(
      (await listActiveSessionsHot()).map((candidate) => candidate.name).sort(),
      ["CO.healthy", "CO.transient"],
    );
  });
});

test("active list retains terminal cursors but self-heals explicit lifecycle residue", async () => {
  await withTempStore(async (dir) => {
    const record = makeRecord(dir, { name: "CO.boundary", tmuxTarget: "CO.boundary" });
    await saveSession(record);

    // A terminal cursor is not lifecycle retirement and must stay indexed.
    await writeFile(join(dir, "sessions", "CO.boundary.json"), JSON.stringify({ ...record, lastObservedState: "crashed" }));
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name]);
    const healed = JSON.parse(await readFile(activeSessionIndexPath(), "utf8")) as { active: string[] };
    assert.deepEqual(healed.active, [record.name]);

    // Activation publishes the name first. A crash before the record becomes
    // live leaves the same conservative residue and is also pruned.
    await saveSession(record);
    await writeFile(join(dir, "sessions", "CO.boundary.json"), JSON.stringify({ ...record, status: "done" }));
    assert.deepEqual(await listActiveSessions(), []);
    assert.equal((await listSessions()).length, 1, "crash repair never deletes the authoritative record");
  });
});

test("active indexes are isolated across store-root switches", async () => {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const first = await mkdtemp(join(tmpdir(), "honeybee-index-root-a-"));
  const second = await mkdtemp(join(tmpdir(), "honeybee-index-root-b-"));
  try {
    process.env.HIVE_STORE_ROOT = first;
    await saveSession(makeRecord(first, { name: "CO.first", tmuxTarget: "CO.first" }));
    process.env.HIVE_STORE_ROOT = second;
    await saveSession(makeRecord(second, { name: "CO.second", tmuxTarget: "CO.second" }));
    assert.deepEqual((await listActiveSessions()).map((record) => record.name), ["CO.second"]);
    process.env.HIVE_STORE_ROOT = first;
    assert.deepEqual((await listActiveSessions()).map((record) => record.name), ["CO.first"]);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("updateSession flip preserves fields merged concurrently after the caller's load (HIVE-49)", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir, { substrate: "hsr", runnerPid: 4242 }));

    // The caller (hive promote) loads its snapshot...
    const snapshot = await loadSession("CO.abc");
    assert.ok(snapshot);

    // ...then the daemon's auto-titler lands title/providerSessionId...
    await updateSession("CO.abc", { title: "Auto Title", titleSource: "auto", providerSessionId: "sess-123" });

    // ...and the caller persists its single-purpose flip via a field merge
    // (NOT a full-record save of the stale snapshot).
    await updateSession(snapshot.name, {
      status: "running",
      agentPaneId: "%3",
      substrate: undefined,
      runnerPid: undefined,
    });

    const reloaded = await loadSession("CO.abc");
    assert.equal(reloaded?.title, "Auto Title");
    assert.equal(reloaded?.titleSource, "auto");
    assert.equal(reloaded?.providerSessionId, "sess-123");
    assert.equal(reloaded?.agentPaneId, "%3");
    assert.equal(reloaded?.substrate, undefined);
    assert.equal(reloaded?.runnerPid, undefined);
  });
});

test("touchSession skips the write when only lastObservedStateAt churns within the heartbeat", async () => {
  await withTempStore(async (dir) => {
    const observedAt = "2026-05-28T00:00:00.000Z";
    await saveSession(makeRecord(dir, { lastObservedState: "working", lastObservedStateAt: observedAt }));
    const path = join(dir, "sessions", "CO.abc.json");
    const before = await readFile(path, "utf8");
    const directoryBefore = (await stat(join(dir, "sessions"))).mtimeMs;
    const indexBefore = await readFile(activeSessionIndexPath(), "utf8");

    // Same state, timestamp only 2s newer: the daemon-tick case. No write.
    await touchSession("CO.abc", { lastObservedState: "working", lastObservedStateAt: "2026-05-28T00:00:02.000Z" });
    assert.equal(await readFile(path, "utf8"), before);

    // Timestamp past the 60s heartbeat: persisted as an atomic observation
    // lease outside the canonical membership-generation directory.
    await touchSession("CO.abc", { lastObservedState: "working", lastObservedStateAt: "2026-05-28T00:01:01.000Z" });
    assert.equal((await loadSession("CO.abc"))?.lastObservedStateAt, "2026-05-28T00:01:01.000Z");
    assert.equal(await readFile(path, "utf8"), before, "same-state heartbeat does not rewrite canonical membership truth");
    assert.equal((await stat(join(dir, "sessions"))).mtimeMs, directoryBefore, "heartbeat does not advance the legacy-writer generation");
    assert.equal(await readFile(activeSessionIndexPath(), "utf8"), indexBefore, "heartbeat does not refresh or rebuild membership");

    // A meaningful field change writes immediately, fresh timestamp or not.
    await touchSession("CO.abc", { lastObservedState: "idle_with_output", lastObservedStateAt: "2026-05-28T00:01:02.000Z" });
    const after = await loadSession("CO.abc");
    assert.equal(after?.lastObservedState, "idle_with_output");
    assert.equal(after?.lastObservedStateAt, "2026-05-28T00:01:02.000Z");
  });
});

test("a same-state observation lease cannot mask a later legacy canonical change", async () => {
  await withTempStore(async (dir) => {
    const record = makeRecord(dir, {
      lastObservedState: "working",
      lastObservedStateAt: "2026-05-28T00:00:00.000Z",
    });
    await saveSession(record);
    await listActiveSessions();
    await touchSession(record.name, {
      lastObservedState: "working",
      lastObservedStateAt: "2026-05-28T00:01:01.000Z",
    });

    // A non-cooperating older writer knows only the canonical JSON file. Its
    // changed stable fingerprint invalidates the sidecar, and its directory
    // write remains visible to the strict active-index generation check.
    const legacy = {
      ...record,
      lastObservedState: "idle_with_output",
      lastObservedStateAt: "2026-05-28T00:02:00.000Z",
    };
    await writeFile(join(dir, "sessions", `${record.name}.json`), JSON.stringify(legacy));

    assert.equal((await loadSession(record.name))?.lastObservedState, "idle_with_output");
    assert.equal((await loadSession(record.name))?.lastObservedStateAt, "2026-05-28T00:02:00.000Z");
    assert.equal((await listActiveSessions())[0]?.lastObservedState, "idle_with_output");
  });
});

test("a torn observation lease loses freshness without hiding canonical membership", async () => {
  await withTempStore(async (dir) => {
    const record = makeRecord(dir, {
      lastObservedState: "working",
      lastObservedStateAt: "2026-05-28T00:00:00.000Z",
    });
    await saveSession(record);
    await mkdir(join(dir, "session-observations"), { recursive: true });
    await writeFile(join(dir, "session-observations", `${record.name}.json`), "{\"version\":");

    assert.equal((await loadSession(record.name))?.lastObservedStateAt, record.lastObservedStateAt);
    assert.deepEqual((await listActiveSessions()).map((candidate) => candidate.name), [record.name]);
  });
});

test("terminal session observations never renew their on-disk heartbeat", async () => {
  await withTempStore(async (dir) => {
    const observedAt = "2026-05-28T00:00:00.000Z";
    const path = join(dir, "sessions", "CO.abc.json");

    for (const status of ["done", "dead"] as const) {
      await saveSession(makeRecord(dir, {
        status,
        lastObservedState: status === "done" ? "done" : "dead",
        lastObservedStateAt: observedAt,
      }), withProbe("dead"));
      const before = await readFile(path, "utf8");

      await touchSession("CO.abc", {
        lastObservedState: status === "done" ? "done" : "dead",
        lastObservedStateAt: "2026-05-28T12:00:00.000Z",
      });

      assert.equal(await readFile(path, "utf8"), before, `${status} heartbeat must stay immutable`);
      assert.equal((await loadSession("CO.abc"))?.lastObservedStateAt, observedAt);
    }

    // A real state change still persists immediately; only timestamp-only
    // churn is suppressed.
    await touchSession("CO.abc", {
      lastObservedState: "crashed",
      lastObservedStateAt: "2026-05-28T12:00:01.000Z",
    }, withProbe("dead"));
    assert.equal((await loadSession("CO.abc"))?.lastObservedState, "crashed");
  });
});

test("only live or uncertain records need observation heartbeat persistence", () => {
  assert.equal(shouldPersistObservationHeartbeat({ status: "running" }), true);
  assert.equal(shouldPersistObservationHeartbeat({ status: "kill_failed" }), true);
  assert.equal(shouldPersistObservationHeartbeat({ status: "dead" }), false);
  assert.equal(shouldPersistObservationHeartbeat({ status: "done" }), false);
});

test("touchSession cannot resurrect a deleted session", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir));
    await mkdir(join(dir, "seals", "CO.abc"), { recursive: true });
    await mkdir(join(dir, "hsr", "CO.abc"), { recursive: true });
    await writeFile(join(dir, "seals", "CO.abc", "seal.json"), "seal history");
    await writeFile(join(dir, "hsr", "CO.abc", "events.jsonl"), "run history");
    await deleteSession("CO.abc");

    assert.equal(await touchSession("CO.abc", { lastObservedState: "working", lastObservedStateAt: new Date().toISOString() }), null);
    assert.equal(await loadSession("CO.abc"), null);
    const files = await readdir(join(dir, "sessions"));
    assert.deepEqual(files.filter((file) => file.endsWith(".json")), []);
    assert.equal(await readFile(join(dir, "seals", "CO.abc", "seal.json"), "utf8"), "seal history", "deleteSession is metadata-only");
    assert.equal(await readFile(join(dir, "hsr", "CO.abc", "events.jsonl"), "utf8"), "run history", "deleteSession does not imply purge");
  });
});

test("unknown session record fields survive a load→merge→save round-trip", async () => {
  await withTempStore(async (dir) => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const onDisk = { ...makeRecord(dir), futureField: { nested: true }, anotherNewField: "v2" };
    await writeFile(join(dir, "sessions", "CO.abc.json"), JSON.stringify(onDisk, null, 2));

    const loaded = await loadSession("CO.abc");
    assert.equal(loaded?.name, "CO.abc");

    await touchSession("CO.abc", { notes: "touched by an old binary" });
    const raw = JSON.parse(await readFile(join(dir, "sessions", "CO.abc.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.futureField, { nested: true });
    assert.equal(raw.anotherNewField, "v2");
    assert.equal(raw.notes, "touched by an old binary");
  });
});

test("dangerous unknown metadata cannot inject inherited destructive session fields", async () => {
  await withTempStore(async (dir) => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const onDisk = makeRecord(dir) as Record<string, unknown>;
    Object.defineProperty(onDisk, "__proto__", {
      value: {
        accountId: "foreign-account",
        homePath: "/tmp/foreign-home",
        poolKey: "../../foreign-pool",
        substrate: "local-tmux",
        launcherPgid: 1234,
      },
      enumerable: true,
    });
    const path = join(dir, "sessions", "CO.abc.json");
    await writeFile(path, JSON.stringify(onDisk, null, 2));

    await assert.rejects(
      () => loadSession("CO.abc"),
      /disallowed metadata key "__proto__"/,
      "a crafted record must be rejected before inherited cleanup fields can exist",
    );
    assert.deepEqual(await listSessions(), [], "bulk cleanup enumeration must skip the rejected record");
    assert.match(await readFile(path, "utf8"), /foreign-account/, "the malformed source remains for operator repair");
    assert.equal(({} as { accountId?: string }).accountId, undefined, "global Object.prototype remains untouched");
  });
});

test("autoTitleAttempts round-trips, and invalid on-disk values are dropped", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir, { autoTitleAttempts: 2 }));
    assert.equal((await loadSession("CO.abc"))?.autoTitleAttempts, 2);

    // A non-finite / wrong-typed value on disk normalizes away (treated as 0 by callers).
    await mkdir(join(dir, "sessions"), { recursive: true });
    for (const bad of ["3x", null, "NaN"]) {
      await writeFile(join(dir, "sessions", "CO.abc.json"), JSON.stringify({ ...makeRecord(dir), autoTitleAttempts: bad }));
      assert.equal((await loadSession("CO.abc"))?.autoTitleAttempts, undefined, `bad value ${JSON.stringify(bad)} should drop`);
    }
  });
});

test("provider fallback title provenance round-trips", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir, {
      title: "Raw first prompt",
      titleSource: "provider",
      providerTitleKind: "fallback",
    }));
    const stored = await loadSession("CO.abc");
    assert.equal(stored?.title, "Raw first prompt");
    assert.equal(stored?.titleSource, "provider");
    assert.equal(stored?.providerTitleKind, "fallback");
  });
});

test("updateSession can clear autoTitleAttempts and provider title provenance (rename --clear path)", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir, {
      title: "x",
      titleSource: "auto",
      providerTitleKind: "fallback",
      autoTitleAt: "2026-06-10T00:00:00.000Z",
      autoTitleAttempts: 3,
    }));
    await updateSession("CO.abc", {
      title: undefined,
      titleSource: undefined,
      providerTitleKind: undefined,
      autoTitleAt: undefined,
      autoTitleAttempts: undefined,
    });
    const cleared = await loadSession("CO.abc");
    assert.equal(cleared?.title, undefined);
    assert.equal(cleared?.titleSource, undefined);
    assert.equal(cleared?.providerTitleKind, undefined);
    assert.equal(cleared?.autoTitleAt, undefined);
    assert.equal(cleared?.autoTitleAttempts, undefined);
  });
});

test("saveSession appends a compact ledger event without brief/lastPrompt payloads", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir, {
      id: "CO.abc",
      colony: "ops",
      swarmId: "swarm-1",
      brief: "a very long brief ".repeat(100),
      lastPrompt: "a very long prompt ".repeat(100),
    }));

    const lines = (await readFile(ledgerPath(), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const event = lines.find((entry) => entry.type === "session.save");
    assert.ok(event, "expected a session.save event");
    assert.equal(event.name, "CO.abc");
    assert.equal(event.id, "CO.abc");
    assert.equal(event.status, "running");
    assert.equal(event.colony, "ops");
    assert.equal(event.swarmId, "swarm-1");
    assert.equal(typeof event.updatedAt, "string");
    assert.equal(event.brief, undefined);
    assert.equal(event.lastPrompt, undefined);
  });
});

test("ledger rotation keeps only the newest K rotated files", async () => {
  await withTempStore(async (dir) => {
    const oldMax = process.env.HIVE_LEDGER_MAX_BYTES;
    const oldKeep = process.env.HIVE_LEDGER_KEEP_ROTATIONS;
    process.env.HIVE_LEDGER_MAX_BYTES = "1";
    process.env.HIVE_LEDGER_KEEP_ROTATIONS = "2";
    try {
      for (let i = 0; i < 6; i += 1) {
        await appendLedger({ type: "test.event", index: i });
        // Rotation suffixes have millisecond granularity; keep them distinct.
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      const entries = await readdir(dir);
      const rotations = entries.filter((entry) => /^ledger\.jsonl\.\d{4}-/.test(entry)).sort();
      assert.equal(rotations.length, 2, `expected 2 retained rotations, saw ${rotations.join(", ")}`);
      // The current ledger holds the newest event.
      const current = await readFile(ledgerPath(), "utf8");
      assert.match(current, /"index":5/);
    } finally {
      if (oldMax === undefined) delete process.env.HIVE_LEDGER_MAX_BYTES;
      else process.env.HIVE_LEDGER_MAX_BYTES = oldMax;
      if (oldKeep === undefined) delete process.env.HIVE_LEDGER_KEEP_ROTATIONS;
      else process.env.HIVE_LEDGER_KEEP_ROTATIONS = oldKeep;
    }
  });
});

test("listSessions skips malformed session files", async () => {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-store-"));
  process.env.HIVE_STORE_ROOT = dir;

  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", "bad.json"), "{not json");
    assert.deepEqual(await listSessions(), []);
    await assert.rejects(listSessionsStrict(), /Invalid JSON in session record/);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("listSessionsStrict rejects load-bearing shape corruption that the tolerant display scan normalizes", async () => {
  await withTempStore(async (dir) => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", "CO.abc.json"), JSON.stringify({ ...makeRecord(dir), status: "mystery" }));
    assert.equal((await listSessions())[0]?.status, "dead");
    await assert.rejects(listSessionsStrict(), /unknown status/);
  });
});

test("listSessionsStrict retries when a record publication crosses its directory-generation barrier", async () => {
  await withTempStore(async (dir) => {
    const sessions = join(dir, "sessions");
    await mkdir(sessions, { recursive: true });
    const first = makeRecord(dir);
    await writeFile(join(sessions, `${first.name}.json`), JSON.stringify(first));
    let injected = false;
    const attempts: number[] = [];
    const records = await listSessionsStrict({
      onSnapshotRead: async (attempt) => {
        attempts.push(attempt);
        if (injected) return;
        injected = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = makeRecord(dir, { name: "CO.new", tmuxTarget: "CO-new" });
        await writeFile(join(sessions, `${second.name}.json`), JSON.stringify(second));
      },
    });
    assert.ok(attempts.length >= 2, "a changed directory generation forces a fresh canonical scan");
    assert.deepEqual(records.map((record) => record.name).sort(), ["CO.abc", "CO.new"]);
  });
});

test("listSessions reads 1,200 records with bounded fan-out and coalesces concurrent snapshots", async () => {
  await withTempStore(async (dir) => {
    const sessions = join(dir, "sessions");
    await mkdir(sessions, { recursive: true });
    for (let offset = 0; offset < 1_200; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, inner) => {
        const index = offset + inner;
        const record = makeRecord(dir, {
          name: `CO.${String(index).padStart(4, "0")}`,
          tmuxTarget: `CO-${index}`,
          updatedAt: new Date(Date.parse("2026-05-28T00:00:00.000Z") + index).toISOString(),
        });
        return writeFile(join(sessions, `${record.name}.json`), JSON.stringify(record));
      }));
    }

    const first = listSessions();
    const second = listSessions();
    assert.equal(second, first, "concurrent callers share one in-flight registry walk");
    const records = await first;

    assert.equal(records.length, 1_200);
    assert.equal(new Set(records.map((record) => record.name)).size, 1_200);
    assert.equal(records[0]?.name, "CO.1199");
    assert.equal(records.at(-1)?.name, "CO.0000");
  });
});

test("a status:done record round-trips (not downgraded to dead)", async () => {
  await withTempStore(async (dir) => {
    const record = makeRecord(dir, { status: "done" });
    await saveSession(record);
    const loaded = await loadSession(record.name);
    assert.equal(loaded?.status, "done", "done survives a round-trip (validation allow-list)");
  });
});

test("a legacy status:archived record loads as done (pre-rename records)", async () => {
  await withTempStore(async (dir) => {
    const record = makeRecord(dir, { status: "archived" as unknown as "done" });
    await saveSession(record);
    const loaded = await loadSession(record.name);
    assert.equal(loaded?.status, "done", "legacy archived normalizes to done on read");
  });
});

test("an unknown status still downgrades to dead (regression guard)", async () => {
  await withTempStore(async (dir) => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const raw = makeRecord(dir);
    await writeFile(join(dir, "sessions", "CO.abc.json"), JSON.stringify({ ...raw, status: "frozen" }));
    const loaded = await loadSession("CO.abc");
    assert.equal(loaded?.status, "dead", "an unknown status is coerced to dead, not preserved");
  });
});

test("normalize drops a malformed agentPaneId at load and queues it for repair (review §1.1)", async () => {
  await withTempStore(async (dir) => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const fused = makeRecord(dir, { name: "CL.fused", tmuxTarget: "CL-fused", agentPaneId: "%110_18981" });
    const garbage = makeRecord(dir, { name: "CL.noise", tmuxTarget: "CL-noise", agentPaneId: "Last login: %7" });
    const good = makeRecord(dir, { name: "CL.good", tmuxTarget: "CL-good", agentPaneId: "%7" });
    for (const record of [fused, garbage, good]) {
      await writeFile(join(dir, "sessions", `${record.name}.json`), `${JSON.stringify(record)}\n`);
    }

    const records = await listSessions();
    const byName = new Map(records.map((record) => [record.name, record]));
    // Malformed stamps are never trusted in memory; a valid one passes through.
    assert.equal(byName.get("CL.fused")?.agentPaneId, undefined);
    assert.equal(byName.get("CL.noise")?.agentPaneId, undefined);
    assert.equal(byName.get("CL.good")?.agentPaneId, "%7");
    // Strict safety snapshots must still READ the poisoned records (repair,
    // kill, and clean depend on it) — with the same sanitized view.
    const strict = await listSessionsStrict();
    assert.equal(strict.find((record) => record.name === "CL.fused")?.agentPaneId, undefined);

    const pending = pendingPaneStampRepairNames();
    assert.ok(pending.includes("CL.fused"));
    assert.ok(pending.includes("CL.noise"));
    assert.ok(!pending.includes("CL.good"));

    // Repair sweep: the fused stamp re-pins ONLY when the pane still belongs
    // to the record's own session; the garbage stamp is dropped outright.
    const listerCalls: number[] = [];
    const result = await flushPaneStampRepairs(async () => {
      listerCalls.push(1);
      return new Map([["CL-fused", new Set(["%110"])]]);
    });
    assert.deepEqual(result.repaired, [{ name: "CL.fused", paneId: "%110" }]);
    assert.ok(result.dropped.includes("CL.noise"));
    assert.equal(listerCalls.length, 1);

    const repaired = JSON.parse(await readFile(join(dir, "sessions", "CL.fused.json"), "utf8"));
    assert.equal(repaired.agentPaneId, "%110");
    const dropped = JSON.parse(await readFile(join(dir, "sessions", "CL.noise.json"), "utf8"));
    assert.equal("agentPaneId" in dropped, false);

    // The sweep is one-shot: a second flush has nothing left to do.
    const again = await flushPaneStampRepairs(async () => {
      throw new Error("lister must not be called with no pending repairs");
    });
    assert.deepEqual(again, { repaired: [], dropped: [] });
  });
});

test("pane-stamp repair drops unverifiable fused stamps and never probes tmux for remote records", async () => {
  await withTempStore(async (dir) => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const gone = makeRecord(dir, { name: "CL.gone", tmuxTarget: "CL-gone", agentPaneId: "%9_777" });
    const remote = makeRecord(dir, { name: "CL.far", tmuxTarget: "CL-far", node: "studio", agentPaneId: "%3_42" });
    for (const record of [gone, remote]) {
      await writeFile(join(dir, "sessions", `${record.name}.json`), `${JSON.stringify(record)}\n`);
    }
    await listSessions();

    // The pane is not in the record's session (server restarted / pane died):
    // the stamp must be DROPPED, never re-pinned to a foreign pane.
    const result = await flushPaneStampRepairs(async () => new Map([["CL-other", new Set(["%9"])]]));
    assert.ok(result.dropped.includes("CL.gone"));
    assert.ok(result.dropped.includes("CL.far"));
    assert.deepEqual(result.repaired, []);
    const goneDisk = JSON.parse(await readFile(join(dir, "sessions", "CL.gone.json"), "utf8"));
    assert.equal("agentPaneId" in goneDisk, false);
    const farDisk = JSON.parse(await readFile(join(dir, "sessions", "CL.far.json"), "utf8"));
    assert.equal("agentPaneId" in farDisk, false);
  });
});

test("pane-stamp repair never clobbers a valid re-stamp that landed meanwhile", async () => {
  await withTempStore(async (dir) => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const record = makeRecord(dir, { name: "CL.race", tmuxTarget: "CL-race", agentPaneId: "%5_99" });
    await writeFile(join(dir, "sessions", "CL.race.json"), `${JSON.stringify(record)}\n`);
    await listSessions();

    // A swap/revive re-pins a fresh, valid pane before the sweep runs.
    await updateSession("CL.race", { agentPaneId: "%8" });

    const result = await flushPaneStampRepairs(async () => new Map([["CL-race", new Set(["%5"])]]));
    assert.deepEqual(result.repaired, []);
    assert.ok(!result.dropped.includes("CL.race"));
    const disk = JSON.parse(await readFile(join(dir, "sessions", "CL.race.json"), "utf8"));
    assert.equal(disk.agentPaneId, "%8");
  });
});
