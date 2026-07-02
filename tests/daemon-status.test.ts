import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  daemonLockPath,
  daemonLoopStale,
  daemonStatePath,
  readDaemonState,
  readDaemonStatus,
  writeDaemonState,
  type DaemonState,
} from "../src/daemon/index.js";
import { acquireLongLivedLock, LockBusyError } from "../src/fsx.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-daemon-status-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeDaemonState/readDaemonState round-trip preserves shape", async () => {
  await withTempStore(async () => {
    const state: DaemonState = {
      startedAt: "2026-06-03T10:00:00.000Z",
      lastTickAt: "2026-06-03T10:00:02.000Z",
      tickCount: 1,
      version: "1",
      pid: 12345,
      recentErrors: [{ ts: "2026-06-03T10:00:02.000Z", msg: "boom" }],
    };
    await writeDaemonState(state);
    const loaded = await readDaemonState();
    assert.deepEqual(loaded, state);
  });
});

test("readDaemonStatus reports down when no lock and no state file exist", async () => {
  await withTempStore(async () => {
    const report = await readDaemonStatus();
    assert.equal(report.running, false);
    assert.equal(report.lock, null);
    assert.equal(report.state, null);
  });
});

test("readDaemonStatus reports running when a live lock exists for current process", async () => {
  await withTempStore(async () => {
    // Acquire a long-lived lock against our own PID; this simulates the daemon holding the lock.
    const lock = await acquireLongLivedLock(daemonLockPath(), { label: "test daemon" });
    try {
      const report = await readDaemonStatus();
      assert.equal(report.running, true);
      assert.equal(report.lockHeldByOtherHost, false);
      assert.ok(report.lock);
      assert.equal(report.lock!.pid, process.pid);
    } finally {
      await lock.release();
    }
  });
});

test("readDaemonStatus does not report running for a lock written by another host", async () => {
  await withTempStore(async () => {
    const lockPath = daemonLockPath();
    await mkdir(dirname(lockPath), { recursive: true });
    // A shared/synced store root can carry a foreign lock whose PID happens
    // to be alive locally (here: our own PID). It must NOT count as running.
    const meta = { pid: process.pid, hostname: "some-other-host.example", startedAt: new Date().toISOString(), token: "x" };
    await writeFile(lockPath, JSON.stringify(meta));
    const report = await readDaemonStatus();
    assert.equal(report.running, false);
    assert.equal(report.lockHeldByOtherHost, true);
    assert.ok(report.lock, "the foreign lock meta is still surfaced");
    assert.equal(report.lock!.pid, process.pid);
  });
});

test("readDaemonStatus treats a lock with empty hostname as foreign", async () => {
  await withTempStore(async () => {
    const lockPath = daemonLockPath();
    await mkdir(dirname(lockPath), { recursive: true });
    const meta = { pid: process.pid, hostname: "", startedAt: new Date().toISOString(), token: "x" };
    await writeFile(lockPath, JSON.stringify(meta));
    const report = await readDaemonStatus();
    assert.equal(report.running, false);
    assert.equal(report.lockHeldByOtherHost, true);
  });
});

test("readDaemonStatus reads lock meta from disk even when daemon process is unknown", async () => {
  await withTempStore(async () => {
    const { hostname } = await import("node:os");
    const lockPath = daemonLockPath();
    await mkdir(dirname(lockPath), { recursive: true });
    // Write a synthetic lock file. PID 1 is init and typically alive on the host, so
    // we just verify the readDaemonStatus code path surfaces the lock meta.
    const meta = { pid: 1, hostname: hostname(), startedAt: new Date().toISOString(), token: "x" };
    await writeFile(lockPath, JSON.stringify(meta));
    const report = await readDaemonStatus();
    assert.ok(report.lock);
    assert.equal(report.lock!.pid, 1);
  });
});

test("acquireLongLivedLock refuses a second acquisition while a lock is held", async () => {
  await withTempStore(async () => {
    const first = await acquireLongLivedLock(daemonLockPath(), { label: "first" });
    try {
      await assert.rejects(
        () => acquireLongLivedLock(daemonLockPath(), { label: "second" }),
        (error) => error instanceof LockBusyError,
      );
    } finally {
      await first.release();
    }
  });
});

test("runDaemon (child process) refuses to start when lock is held", async () => {
  await withTempStore(async () => {
    const lock = await acquireLongLivedLock(daemonLockPath(), { label: "holding" });
    try {
      const cliPath = join(process.cwd(), "src", "cli.ts");
      const result = await runCli(cliPath, ["daemon", "run"]);
      assert.notEqual(result.exitCode, 0, "expected non-zero exit when lock is busy");
      const combined = `${result.stdout}${result.stderr}`;
      assert.match(combined, /already running|lock busy|busy/i);
    } finally {
      await lock.release();
    }
  });
});

test("runDaemon (child process) starts, writes state.json, and exits cleanly on SIGTERM", async (t) => {
  await withTempStore(async () => {
    const cliPath = join(process.cwd(), "src", "cli.ts");
    const env = { ...process.env, HIVE_DAEMON_TICK_MS: "50" };
    const child = spawn("node", ["--import", "tsx", cliPath, "daemon", "run", "--tick-ms", "50"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.diagnostic(`spawned pid=${child.pid}`);
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += String(chunk);
    });

    // Wait for state.json to appear.
    const statePath = daemonStatePath();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const exists = await stat(statePath).then(() => true).catch(() => false);
      if (exists) break;
      await sleep(50);
    }
    const exists = await stat(statePath).then(() => true).catch(() => false);
    if (!exists) {
      // Kill child to clean up before failing.
      child.kill("SIGKILL");
      assert.fail(`state.json not written in time\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`);
    }

    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { pid: number; startedAt: string; version: string };
    assert.equal(parsed.pid, child.pid);
    assert.equal(parsed.version, "1");

    // SIGTERM and wait for clean exit.
    const exitPromise = new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
    });
    child.kill("SIGTERM");
    const code = await Promise.race([
      exitPromise,
      sleep(5_000).then(() => -1),
    ]);
    if (code === -1) {
      child.kill("SIGKILL");
      assert.fail("daemon did not exit within 5s of SIGTERM");
    }
    assert.equal(code, 0, "expected clean exit code 0");

    // Lock should be released.
    const lockMeta = await readFile(daemonLockPath(), "utf8").catch(() => null);
    assert.equal(lockMeta, null, "expected lock file to be cleaned up after shutdown");
  });
});

function runCli(cliPath: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", cliPath, ...argv], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("daemonLoopStale judges a running loop by lastTickAt age", () => {
  const state: DaemonState = {
    startedAt: "2026-06-28T17:00:00.000Z",
    lastTickAt: "2026-06-29T07:43:14.708Z",
    tickCount: 23334,
    version: "1",
    pid: 51841,
    recentErrors: [],
  };
  const tickMs = Date.parse(state.lastTickAt!);
  assert.equal(daemonLoopStale(state, tickMs + 60_000, 5 * 60_000).stale, false);
  const wedged = daemonLoopStale(state, tickMs + 3 * 24 * 3_600_000, 5 * 60_000);
  assert.equal(wedged.stale, true);
  assert.ok(wedged.ageMs! >= 3 * 24 * 3_600_000);
});

test("daemonLoopStale falls back to startedAt when the daemon never ticked", () => {
  const state: DaemonState = {
    startedAt: "2026-06-28T17:00:00.000Z",
    lastTickAt: null,
    tickCount: 0,
    version: "1",
    pid: 1,
    recentErrors: [],
  };
  const startMs = Date.parse(state.startedAt);
  assert.equal(daemonLoopStale(state, startMs + 1_000, 5 * 60_000).stale, false);
  assert.equal(daemonLoopStale(state, startMs + 10 * 60_000, 5 * 60_000).stale, true);
});

test("readDaemonStatus reports STALE for a live process whose lastTickAt is old", async () => {
  await withTempStore(async () => {
    const lock = await acquireLongLivedLock(daemonLockPath(), { label: "test daemon" });
    try {
      const lastTickAt = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago
      await writeDaemonState({
        startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        lastTickAt,
        tickCount: 100,
        version: "1",
        pid: process.pid,
        recentErrors: [],
      });
      const report = await readDaemonStatus(undefined, { staleAfterMs: 5 * 60_000 });
      assert.equal(report.running, true);
      assert.equal(report.stale, true);
      assert.ok(report.lastTickAgeMs! > 5 * 60_000);
      assert.equal(report.staleAfterMs, 5 * 60_000);
    } finally {
      await lock.release();
    }
  });
});

test("readDaemonStatus reports a fresh running daemon as not stale", async () => {
  await withTempStore(async () => {
    const lock = await acquireLongLivedLock(daemonLockPath(), { label: "test daemon" });
    try {
      await writeDaemonState({
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastTickAt: new Date().toISOString(),
        tickCount: 100,
        version: "1",
        pid: process.pid,
        recentErrors: [],
      });
      const report = await readDaemonStatus(undefined, { staleAfterMs: 5 * 60_000 });
      assert.equal(report.running, true);
      assert.equal(report.stale, false);
    } finally {
      await lock.release();
    }
  });
});

test("readDaemonStatus does not mark a down daemon stale", async () => {
  await withTempStore(async () => {
    await writeDaemonState({
      startedAt: "2026-06-28T17:00:00.000Z",
      lastTickAt: "2026-06-29T07:43:14.708Z",
      tickCount: 23334,
      version: "1",
      pid: 999_999,
      recentErrors: [],
    });
    const report = await readDaemonStatus(undefined, { staleAfterMs: 5 * 60_000 });
    assert.equal(report.running, false);
    assert.equal(report.stale, false);
  });
});
