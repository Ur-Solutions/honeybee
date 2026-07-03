import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendLedger,
  deleteSession,
  ledgerPath,
  listSessions,
  loadSession,
  saveSession,
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

test("store root is read at call time and session files are private", async () => {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-store-"));
  process.env.HIVE_STORE_ROOT = dir;

  try {
    const record: SessionRecord = {
      name: "CO.abc",
      agent: "codex",
      cwd: dir,
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

    // Same state, timestamp only 2s newer: the daemon-tick case. No write.
    await touchSession("CO.abc", { lastObservedState: "working", lastObservedStateAt: "2026-05-28T00:00:02.000Z" });
    assert.equal(await readFile(path, "utf8"), before);

    // Timestamp past the 60s heartbeat: persisted.
    await touchSession("CO.abc", { lastObservedState: "working", lastObservedStateAt: "2026-05-28T00:01:01.000Z" });
    assert.equal((await loadSession("CO.abc"))?.lastObservedStateAt, "2026-05-28T00:01:01.000Z");

    // A meaningful field change writes immediately, fresh timestamp or not.
    await touchSession("CO.abc", { lastObservedState: "idle_with_output", lastObservedStateAt: "2026-05-28T00:01:02.000Z" });
    const after = await loadSession("CO.abc");
    assert.equal(after?.lastObservedState, "idle_with_output");
    assert.equal(after?.lastObservedStateAt, "2026-05-28T00:01:02.000Z");
  });
});

test("touchSession cannot resurrect a deleted session", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir));
    await deleteSession("CO.abc");

    assert.equal(await touchSession("CO.abc", { lastObservedState: "working", lastObservedStateAt: new Date().toISOString() }), null);
    assert.equal(await loadSession("CO.abc"), null);
    const files = await readdir(join(dir, "sessions"));
    assert.deepEqual(files.filter((file) => file.endsWith(".json")), []);
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

test("updateSession can clear autoTitleAttempts (rename --clear path)", async () => {
  await withTempStore(async (dir) => {
    await saveSession(makeRecord(dir, { title: "x", titleSource: "auto", autoTitleAt: "2026-06-10T00:00:00.000Z", autoTitleAttempts: 3 }));
    await updateSession("CO.abc", { title: undefined, titleSource: undefined, autoTitleAt: undefined, autoTitleAttempts: undefined });
    const cleared = await loadSession("CO.abc");
    assert.equal(cleared?.title, undefined);
    assert.equal(cleared?.titleSource, undefined);
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
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a status:archived record round-trips (not downgraded to dead) and carries questId/workspaceId", async () => {
  await withTempStore(async (dir) => {
    const record = makeRecord(dir, { status: "archived", questId: "q-abc", workspaceId: "q-abc" });
    await saveSession(record);
    const loaded = await loadSession(record.name);
    assert.equal(loaded?.status, "archived", "archived survives a round-trip (validation allow-list)");
    assert.equal(loaded?.questId, "q-abc", "questId is carried through");
    assert.equal(loaded?.workspaceId, "q-abc", "workspaceId is carried through");
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
