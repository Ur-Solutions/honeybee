import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  activeSessionIndexPath,
  appendLedger,
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

test("safeName neutralizes empty and dot-only path segments", () => {
  assert.equal(safeName("CO.abc"), "CO.abc");
  assert.equal(safeName("bad/name"), "bad-name");
  assert.equal(safeName("."), "-");
  assert.equal(safeName(".."), "--");
  assert.equal(safeName("..."), "---");
  assert.equal(safeName(""), "-");
});

test("active-session policy keeps recoverable daemon work and excludes settled history", () => {
  const record = makeRecord("/tmp");
  assert.equal(isActiveSessionRecord(record), true);
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "auth-needed" }), true);
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "blocked" }), true, "needs-input remains daemon-visible");
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "node_unreachable" }), true);
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "error" }), true, "provider errors can recover");
  assert.equal(isActiveSessionRecord({ ...record, status: "kill_failed", lastObservedState: "kill_failed" }), true, "unconfirmed teardown remains observable");
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "crashed" }), false);
  assert.equal(isActiveSessionRecord({ ...record, status: "dead", lastObservedState: "crashed", recoveryRequestedAt: "2026-08-10T00:00:00.000Z" }), true, "durable recovery stays daemon-visible");
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "done" }), false, "completed current turn leaves the hot set");
  assert.equal(isActiveSessionRecord({ ...record, lastObservedState: "sealed" }), false);
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

test("active index follows crash, sealed-turn re-prompt, retire, and revive boundaries without deleting history", async () => {
  await withTempStore(async () => {
    const record = makeRecord("/tmp", { accountId: "codex-a" });
    await saveSession(record);
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name]);

    await touchSession(record.name, { lastObservedState: "crashed", lastObservedStateAt: "2026-05-28T00:01:00.000Z" });
    assert.deepEqual(await listActiveSessions(), [], "crash is retained but leaves daemon hot paths");
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
    assert.deepEqual(await listActiveSessions(), [], "explicitly resolved recovery leaves terminal history cold again");

    await updateSession(record.name, { status: "running", lastObservedState: undefined, lastObservedStateAt: undefined });
    assert.deepEqual((await listActiveSessions()).map((item) => item.name), [record.name], "revive re-enters the index");

    await touchSession(record.name, { lastObservedState: "done", lastObservedStateAt: "2026-05-28T00:02:00.000Z" });
    assert.deepEqual(await listActiveSessions(), [], "sealed/current-turn-done is cold history");
    await updateSession(record.name, { status: "running", lastObservedState: undefined, lastObservedStateAt: undefined, lastPrompt: "follow up" });
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

test("canonical active-index reconciliation retries a directory generation race", async () => {
  await withTempStore(async (dir) => {
    const sessions = join(dir, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "CO.before.json"), JSON.stringify(makeRecord(dir, {
      name: "CO.before",
      tmuxTarget: "CO.before",
    })));
    const attempts: number[] = [];

    const active = await rebuildActiveSessionIndex({
      onAttempt: async (attempt) => {
        attempts.push(attempt);
        if (attempt !== 1) return;
        await writeFile(join(sessions, "CO.raced.json"), JSON.stringify(makeRecord(dir, {
          name: "CO.raced",
          tmuxTarget: "CO.raced",
        })));
      },
    });

    assert.equal(active, 2);
    assert.deepEqual(attempts, [1, 2], "the first changed generation is discarded and rescanned once stable");
    assert.deepEqual(
      (await listActiveSessionsHot()).map((record) => record.name).sort(),
      ["CO.before", "CO.raced"],
    );
  });
});

test("checksum-valid v1 active index stays hot across upgrade until background migration", async () => {
  await withTempStore(async (dir) => {
    const indexed = makeRecord(dir, { name: "CO.v1-indexed", tmuxTarget: "CO.v1-indexed" });
    await saveSession(indexed);
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

    assert.deepEqual((await listActiveSessionsHot()).map((record) => record.name), active);
    assert.equal(
      await readFile(activeSessionIndexPath(), "utf8"),
      legacy,
      "the first post-upgrade hot read serves v1 without a synchronous rebuild or rewrite",
    );
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

test("active list self-heals both terminal-write and activation-index crash residue", async () => {
  await withTempStore(async (dir) => {
    const record = makeRecord(dir, { name: "CO.boundary", tmuxTarget: "CO.boundary" });
    await saveSession(record);

    // Crash after terminal record commit but before membership removal.
    await writeFile(join(dir, "sessions", "CO.boundary.json"), JSON.stringify({ ...record, lastObservedState: "crashed" }));
    assert.deepEqual(await listActiveSessions(), []);
    const healed = JSON.parse(await readFile(activeSessionIndexPath(), "utf8")) as { active: string[] };
    assert.deepEqual(healed.active, []);

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
      }));
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
    });
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
