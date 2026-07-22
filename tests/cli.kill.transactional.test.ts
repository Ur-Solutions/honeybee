import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { transactionalKill } from "../src/kill.js";
import { saveSession, type SessionRecord } from "../src/store.js";
import type { KillResult, Substrate } from "../src/substrates/types.js";
import { hasSession as tmuxHasSession, kill as tmuxKill, newSession as tmuxNewSession } from "../src/tmux.js";

const execFileAsync = promisify(execFile);

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hive-kill-tx-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function seed(record: Partial<SessionRecord> & { name: string; tmuxTarget: string }): SessionRecord {
  return {
    name: record.name,
    agent: record.agent ?? "codex",
    cwd: record.cwd ?? "/tmp",
    command: record.command ?? "codex",
    tmuxTarget: record.tmuxTarget,
    createdAt: record.createdAt ?? "2026-05-28T11:00:00.000Z",
    updatedAt: record.updatedAt ?? "2026-05-28T11:00:00.000Z",
    status: record.status ?? "running",
    ...(record.id ? { id: record.id } : {}),
    ...(record.node ? { node: record.node } : {}),
    ...(record.launcherPgid ? { launcherPgid: record.launcherPgid } : {}),
  };
}

function killOk(): KillResult {
  return { ok: true, stdout: "", stderr: "", exitCode: 0 };
}

function killErr(stderr: string): KillResult {
  return { ok: false, stdout: "", stderr, exitCode: 1 };
}

type SubstrateOverrides = Partial<Substrate>;

function makeSubstrate(overrides: SubstrateOverrides): Substrate {
  const base: Substrate = {
    kind: "local-tmux",
    node: "local",
    probe: async () => ({ ok: true }),
    hasSession: async () => false,
    newSession: async () => ({ paneId: "%0" }),
    kill: async () => killOk(),
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [],
    listPanes: async () => new Set<string>(),
    listSessionStates: async () => new Map<string, string>(),
    setUserOptions: async () => undefined,
    setWindowOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => ["echo", "noop"],
    attachSession: async () => undefined,
  };
  return Object.assign(base, overrides);
}

test("transactionalKill: substrate.kill ok and hasSession=false → ok=true, record deleted, session.kill ledger event", async () => {
  await withTempStore(async (dir) => {
    const record = seed({ name: "alpha", tmuxTarget: "alpha" });
    await saveSession(record);

    let killCalls = 0;
    let probeCalls = 0;
    const substrate = makeSubstrate({
      kill: async () => {
        killCalls += 1;
        return killOk();
      },
      hasSession: async () => {
        probeCalls += 1;
        return false;
      },
    });

    const outcome = await transactionalKill(record, { substrate, pollIntervalMs: 0 });

    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok && outcome.attempts >= 0);
    // The fast-path "already gone" probe before kill could short-circuit.
    // Either way the record must not exist anymore.
    const sessionsDir = join(dir, "sessions");
    const after = await readFile(join(sessionsDir, "alpha.json"), "utf8").catch(() => null);
    assert.equal(after, null, "session record should be deleted");

    const ledger = await readFile(join(dir, "ledger.jsonl"), "utf8");
    const lines = ledger.trim().split("\n").map((l) => JSON.parse(l));
    const killEvent = lines.find((e) => e.type === "session.kill");
    assert.ok(killEvent, `expected a session.kill event; saw types ${lines.map((l) => l.type).join(", ")}`);
    assert.equal(killEvent.session, "alpha");
    assert.equal(killEvent.ok, true);
    assert.equal(killEvent.node, "local");
    assert.equal(typeof killEvent.attempts, "number");
    assert.equal(killCalls + probeCalls > 0, true);
  });
});

test("transactionalKill: substrate.kill returns ok but hasSession keeps returning true → ok=false, record persisted with status=kill_failed and lastError", async () => {
  await withTempStore(async (dir) => {
    const record = seed({ name: "stubborn", tmuxTarget: "stubborn" });
    await saveSession(record);

    let probeCalls = 0;
    const substrate = makeSubstrate({
      // Pretend kill "succeeded" but the session is still there.
      kill: async () => killOk(),
      hasSession: async () => {
        probeCalls += 1;
        return true;
      },
    });

    const outcome = await transactionalKill(record, { substrate, pollAttempts: 4, pollIntervalMs: 0 });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.stillRunning, true);
      assert.ok(outcome.lastError.length > 0);
    }
    // The record must still be on disk.
    const after = JSON.parse(await readFile(join(dir, "sessions", "stubborn.json"), "utf8")) as SessionRecord;
    assert.equal(after.status, "kill_failed");
    assert.ok(after.lastError && after.lastError.length > 0);

    const ledger = await readFile(join(dir, "ledger.jsonl"), "utf8");
    const lines = ledger.trim().split("\n").map((l) => JSON.parse(l));
    const killEvent = lines.find((e) => e.type === "session.kill" && e.ok === false);
    assert.ok(killEvent, "expected a session.kill ok=false event");
    assert.equal(killEvent.session, "stubborn");
    assert.equal(typeof killEvent.lastError, "string");
    assert.ok(probeCalls >= 1, "hasSession should have been polled");
  });
});

test("transactionalKill: substrate.kill throws → ok=false, record persisted with lastError surfaced", async () => {
  await withTempStore(async () => {
    const record = seed({ name: "explodes", tmuxTarget: "explodes" });
    await saveSession(record);

    const substrate = makeSubstrate({
      hasSession: async () => true,
      kill: async () => {
        throw new Error("ssh exited 255");
      },
    });

    const outcome = await transactionalKill(record, { substrate, pollAttempts: 2, pollIntervalMs: 0 });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.lastError, /ssh exited 255|session still exists/);
  });
});

test("transactionalKill: kill reports failure but the poll confirms gone → ok=true, record deleted (race)", async () => {
  await withTempStore(async (dir) => {
    const record = seed({ name: "race", tmuxTarget: "race" });
    await saveSession(record);

    // Race: the session dies between the fast-path hasSession (true) and the
    // kill call, so kill fails with "can't find session" — but the post-kill
    // poll CONFIRMS the session is gone, which must win.
    let probes = 0;
    const substrate = makeSubstrate({
      hasSession: async () => {
        probes += 1;
        return probes === 1; // alive for the fast-path probe, gone afterwards
      },
      kill: async () => killErr("can't find session: race"),
    });

    const outcome = await transactionalKill(record, { substrate, pollIntervalMs: 0 });
    assert.equal(outcome.ok, true, "poll-confirmed-gone must override the kill failure");
    const after = await readFile(join(dir, "sessions", "race.json"), "utf8").catch(() => null);
    assert.equal(after, null, "record should be deleted once the poll confirms the session is gone");
  });
});

test("transactionalKill: session already gone (hasSession false from the start) → ok=true, alreadyGone=true, no substrate.kill call", async () => {
  await withTempStore(async (dir) => {
    const record = seed({ name: "ghost", tmuxTarget: "ghost" });
    await saveSession(record);

    let killCalls = 0;
    const substrate = makeSubstrate({
      hasSession: async () => false,
      kill: async () => {
        killCalls += 1;
        return killOk();
      },
    });

    const outcome = await transactionalKill(record, { substrate, pollIntervalMs: 0 });

    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.alreadyGone, true);
    assert.equal(killCalls, 0, "should not call substrate.kill when bee is already gone");
    const gone = await readFile(join(dir, "sessions", "ghost.json"), "utf8").catch(() => null);
    assert.equal(gone, null, "session record should still be deleted");
  });
});

test("transactionalKill: remote-hsr calls substrate.kill even when the session is already gone (remote cred shred / run-dir cleanup)", async () => {
  await withTempStore(async (dir) => {
    const record = seed({ name: "remote-ghost", tmuxTarget: "remote-ghost", node: "metal" });
    await saveSession(record);

    let killCalls = 0;
    const substrate = makeSubstrate({
      kind: "remote-hsr",
      hasSession: async () => false,
      kill: async () => {
        killCalls += 1;
        return killOk();
      },
    });

    const outcome = await transactionalKill(record, { substrate, pollIntervalMs: 0 });

    assert.equal(outcome.ok, true);
    assert.equal(killCalls, 1, "remote-hsr kill RPC must fire for an exited bee so delivered creds are shredded");
    const gone = await readFile(join(dir, "sessions", "remote-ghost.json"), "utf8").catch(() => null);
    assert.equal(gone, null, "session record should be deleted");
  });
});

test("transactionalKill: session gone still signals a recorded launcher process group", async () => {
  await withTempStore(async () => {
    const record = seed({ name: "alpha", tmuxTarget: "alpha", launcherPgid: 1234 });
    await saveSession(record);

    let killCalls = 0;
    const substrate = makeSubstrate({
      hasSession: async () => false,
      kill: async (_target, options) => {
        killCalls += 1;
        assert.equal(options?.launcherPgid, 1234);
        return killErr("no such session");
      },
    });

    const outcome = await transactionalKill(record, { substrate, pollAttempts: 1, pollIntervalMs: 0 });

    assert.deepEqual(outcome, { ok: true, alreadyGone: false, attempts: 1 });
    assert.equal(killCalls, 1);
  });
});

test("transactionalKill: substrate.kill ok and hasSession becomes false on a later poll → ok=true after retries", async () => {
  await withTempStore(async () => {
    const record = seed({ name: "slowdown", tmuxTarget: "slowdown" });
    await saveSession(record);

    const hasSessionResults = [true, true, true, true, false];
    let probeIdx = 0;
    const substrate = makeSubstrate({
      kill: async () => killOk(),
      hasSession: async () => {
        const result = hasSessionResults[Math.min(probeIdx, hasSessionResults.length - 1)] ?? false;
        probeIdx += 1;
        return result;
      },
    });

    const outcome = await transactionalKill(record, { substrate, pollAttempts: 8, pollIntervalMs: 0 });
    assert.equal(outcome.ok, true);
  });
});

test("transactionalKill: respects pollAttempts=1 (no retry) for fast unit tests", async () => {
  await withTempStore(async () => {
    const record = seed({ name: "fast", tmuxTarget: "fast" });
    await saveSession(record);

    let probeCalls = 0;
    const substrate = makeSubstrate({
      hasSession: async () => {
        probeCalls += 1;
        return true;
      },
      kill: async () => killOk(),
    });

    const outcome = await transactionalKill(record, { substrate, pollAttempts: 1, pollIntervalMs: 0 });
    assert.equal(outcome.ok, false);
    // probe count: 1 fast-path probe + 1 post-kill probe = 2
    assert.ok(probeCalls <= 3, `expected <= 3 probe calls with pollAttempts=1, got ${probeCalls}`);
  });
});

// ---------------------- CLI integration tests ----------------------

async function writeRecord(dir: string, record: SessionRecord): Promise<void> {
  const sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `${record.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
      timeout: 15_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

test("hive kill on a real local-tmux session: succeeds and removes the session record", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-kill-cli-"));
  const target = `hive-kill-tx-happy-${process.pid}`;
  try {
    // Spin up a real tmux session, write a record pointing at it.
    await tmuxNewSession(target, "/tmp", { command: "sleep", args: ["10"] });
    assert.equal(await tmuxHasSession(target), true);
    await writeRecord(dir, seed({ name: target, tmuxTarget: target, id: "CO.kts" }));

    const result = await hive(dir, "kill", target, "--yes");
    assert.equal(result.code, 0, `kill should exit 0; stderr=${result.stderr}`);
    assert.match(result.stdout, /^killed\t/m);
    assert.equal(await tmuxHasSession(target), false);

    const stillThere = await readFile(join(dir, "sessions", `${target}.json`), "utf8").catch(() => null);
    assert.equal(stillThere, null, "session record should be removed");
  } finally {
    await tmuxKill(target).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive kill on a real local-tmux session that resists kill: persists kill_failed and exits non-zero", { timeout: 30_000 }, async () => {
  // We simulate "kill returns ok but the bee is still detectable" by registering
  // an ssh-tmux node backed by a stub `ssh` on PATH. The stub returns success for
  // every command (kill-session exits 0, has-session exits 0). That mimics a
  // substrate where kill silently fails to actually tear the bee down — the
  // record MUST persist and the CLI MUST exit non-zero.
  const dir = await mkdtemp(join(tmpdir(), "hive-kill-cli-"));
  const stubDir = await mkdtemp(join(tmpdir(), "hive-kill-stub-"));
  try {
    const stubPath = join(stubDir, "ssh");
    await writeFile(stubPath, "#!/bin/sh\nexit 0\n", "utf8");
    const { chmod } = await import("node:fs/promises");
    await chmod(stubPath, 0o755);

    const env = {
      ...process.env,
      HIVE_STORE_ROOT: dir,
      NO_COLOR: "1",
      TERM: "dumb",
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    };
    await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "node", "register", "stub-host", "--kind", "ssh-tmux", "--endpoint", "stub@localhost"], { cwd: process.cwd(), env });
    await writeRecord(dir, seed({ name: "stub-bee", tmuxTarget: "stub-bee", node: "stub-host", id: "CO.stb" }));

    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "kill", "stub-bee", "--yes"], { cwd: process.cwd(), env, timeout: 15_000 });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      code = typeof e.code === "number" ? e.code : 1;
    }

    assert.notEqual(code, 0, `kill_failed should exit non-zero; stdout=${stdout} stderr=${stderr}`);
    assert.match(stdout, /^kill_failed\tstub-bee\t/m);

    // Record should still be present with kill_failed status + lastError.
    const persisted = JSON.parse(await readFile(join(dir, "sessions", "stub-bee.json"), "utf8")) as SessionRecord;
    assert.equal(persisted.status, "kill_failed");
    assert.ok(persisted.lastError && persisted.lastError.length > 0, "lastError should be populated");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
});

test("hive kill on a session that never had a tmux pane: reports gone, removes the record", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-kill-cli-"));
  const target = `hive-kill-tx-gone-${process.pid}`;
  try {
    // Write the record but do NOT create a tmux session.
    await writeRecord(dir, seed({ name: target, tmuxTarget: target, id: "CO.kgn" }));

    const result = await hive(dir, "kill", target, "--yes");
    assert.equal(result.code, 0, `kill should exit 0 even when bee was already gone; stderr=${result.stderr}`);
    assert.match(result.stdout, /^gone\t/m);
    const stillThere = await readFile(join(dir, "sessions", `${target}.json`), "utf8").catch(() => null);
    assert.equal(stillThere, null, "session record should be removed even on 'gone'");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
