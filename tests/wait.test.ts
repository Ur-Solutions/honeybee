import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { SealRecord } from "../src/seal.js";
import { sessionLivenessFailure } from "../src/sessionLiveness.js";
import { deleteSession, saveSession, type SessionRecord } from "../src/store.js";
import { WAIT_EXIT_CODES, WaitError, waitForIdle, waitForSeal } from "../src/wait.js";

const execFileAsync = promisify(execFile);

function record(dir: string): SessionRecord {
  return {
    name: "test-bee",
    agent: "claude",
    cwd: join(dir, "workspace"),
    command: "claude",
    tmuxTarget: "test-bee-target",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    status: "running",
    homePath: join(dir, "claude-home"),
  };
}

async function withStoreRoot<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = join(dir, "store");
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
  }
}

test("waitForIdle throws when the session dies mid-wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-dead-"));
  try {
    await withStoreRoot(dir, async () => {
      const saved = record(dir);
      await saveSession(saved);
      const substrate = {
        capture: async () => {
          throw new Error("can't find pane");
        },
        hasSession: async () => false,
      };

      await assert.rejects(
        waitForIdle({ record: saved, idleMs: 100, timeoutMs: 5_000, pollMs: 50, output: "pane", rows: 0, json: false, substrate }),
        (error: unknown) => {
          assert.ok(error instanceof WaitError);
          assert.equal(error.exitCode, WAIT_EXIT_CODES.terminal);
          assert.match(error.message, /terminal state crashed.*tmux session is not running/);
          return true;
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle reports a stable permission prompt as blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-blocked-"));
  try {
    await withStoreRoot(dir, async () => {
      const saved = record(dir);
      await saveSession(saved);
      const pane = "Bash(rm -rf build)\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)";
      const substrate = {
        capture: async () => pane,
        hasSession: async () => true,
      };

      const outcome = await waitForIdle({ record: saved, idleMs: 150, timeoutMs: 5_000, pollMs: 50, output: "pane", rows: 0, json: false, substrate });
      assert.deepEqual(outcome, { state: "blocked" });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle reports a settled pane as idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-idle-"));
  try {
    await withStoreRoot(dir, async () => {
      const saved = record(dir);
      await saveSession(saved);
      const substrate = {
        capture: async () => "All done.\n❯ ",
        hasSession: async () => true,
      };

      const outcome = await waitForIdle({ record: saved, idleMs: 150, timeoutMs: 5_000, pollMs: 50, output: "pane", rows: 0, json: false, substrate });
      assert.deepEqual(outcome, { state: "idle" });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle does not report --last success before a prompted transcript appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-last-no-tx-"));
  try {
    await withStoreRoot(dir, async () => {
      const prompted = {
        ...record(dir),
        lastPrompt: "Reply OK only.",
        lastPromptAt: "2026-06-10T00:00:01.000Z",
      };
      await saveSession(prompted);
      const substrate = {
        capture: async () => "Grok Build\n❯ ",
        hasSession: async () => true,
      };

      await assert.rejects(
        waitForIdle({ record: prompted, idleMs: 50, timeoutMs: 220, pollMs: 50, output: "last", rows: 0, json: false, substrate }),
        (error: unknown) => {
          assert.ok(error instanceof WaitError);
          assert.equal(error.exitCode, WAIT_EXIT_CODES.timeout);
          assert.match(error.message, /Timed out waiting for idle session/);
          return true;
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle fails when a pinned tmux pane is gone but its session remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-pane-dead-"));
  try {
    await withStoreRoot(dir, async () => {
      const saved = { ...record(dir), agentPaneId: "%7", lastObservedState: "active" };
      await saveSession(saved);
      const substrate = {
        capture: async () => "still looks active",
        hasSession: async () => true,
      };

      await assert.rejects(
        waitForIdle({
          record: saved,
          idleMs: 5_000,
          timeoutMs: 5_000,
          pollMs: 50,
          output: "pane",
          rows: 0,
          json: false,
          substrate,
          sessionDeps: {
            livenessFailure: (fresh) => sessionLivenessFailure(fresh, { substrate, localPanes: async () => new Set() }),
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof WaitError);
          assert.equal(error.exitCode, WAIT_EXIT_CODES.terminal);
          assert.match(error.message, /terminal state crashed.*tmux pane is not running.*%7/);
          return true;
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle diagnoses killed and archived records by terminal state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-record-states-"));
  try {
    await withStoreRoot(dir, async () => {
      const substrate = { capture: async () => "working", hasSession: async () => true };
      for (const [status, expected] of [["dead", "killed"], ["archived", "archived"]] as const) {
        const saved = { ...record(dir), status };
        await saveSession(saved);
        await assert.rejects(
          waitForIdle({ record: saved, idleMs: 5_000, timeoutMs: 5_000, pollMs: 100, output: "pane", rows: 0, json: false, substrate }),
          (error: unknown) => {
            assert.ok(error instanceof WaitError);
            assert.equal(error.exitCode, WAIT_EXIT_CODES.terminal);
            assert.match(error.message, new RegExp(`terminal state ${expected}`));
            return true;
          },
        );
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle fails within one poll when the session record is deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-deleted-"));
  try {
    await withStoreRoot(dir, async () => {
      const saved = record(dir);
      await saveSession(saved);
      const substrate = {
        capture: async () => "working",
        hasSession: async () => true,
      };
      const started = Date.now();
      const deletion = new Promise<void>((resolve) => {
        setTimeout(() => void deleteSession(saved.name).then(resolve), 25);
      });

      await assert.rejects(
        waitForIdle({ record: saved, idleMs: 5_000, timeoutMs: 5_000, pollMs: 100, output: "pane", rows: 0, json: false, substrate }),
        (error: unknown) => {
          assert.ok(error instanceof WaitError);
          assert.equal(error.exitCode, WAIT_EXIT_CODES.terminal);
          assert.match(error.message, /terminal state deleted/);
          return true;
        },
      );
      await deletion;
      assert.ok(Date.now() - started < 1_000, "deleted record should fail within one poll interval");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForSeal preserves successful seal stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-seal-success-"));
  try {
    const saved = record(dir);
    const seal: SealRecord = {
      status: "done",
      summary: "finished",
      beeName: saved.name,
      sealedAt: "2026-07-22T06:00:00.000Z",
    };
    let latestCalls = 0;
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => lines.push(String(line));
    try {
      await waitForSeal({
        record: saved,
        timeoutMs: 1_000,
        pollMs: 50,
        list: async () => [],
        latest: async () => (++latestCalls > 1 ? seal : null),
        sessionDeps: { load: async () => saved, livenessFailure: async () => null },
      });
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(lines, [JSON.stringify(seal, null, 2)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive wait returns terminal exit 1 promptly for every output variant", async () => {
  for (const flags of [[], ["--last"], ["--transcript"], ["--seal"]]) {
    const root = await mkdtemp(join(tmpdir(), "honeybee-wait-cli-terminal-"));
    try {
      const saved = { ...record(root), tmuxTarget: "test-bee", substrate: "hsr" as const, lastObservedState: "crashed" };
      await writeFakeRecord(root, saved);
      const started = Date.now();
      const result = await runCli(root, ["wait", saved.name, ...flags, "--timeout-ms", "5000", "--poll-ms", "100"]);
      assert.equal(result.code, WAIT_EXIT_CODES.terminal, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /terminal state crashed/);
      assert.ok(Date.now() - started < 4_500, `${flags.join(" ") || "plain"} wait should fail before its 5s timeout`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("hive wait timeout exits 2 while successful idle output exits 0 unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-wait-cli-outcomes-"));
  try {
    const saved = { ...record(root), tmuxTarget: "test-bee", substrate: "hsr" as const };
    await writeFakeRecord(root, saved);
    await writeLiveHsr(root, saved.name, "All done.\n❯ \n");

    const timedOut = await runCli(root, ["wait", saved.name, "--idle-ms", "5000", "--timeout-ms", "150", "--poll-ms", "50"]);
    assert.equal(timedOut.code, WAIT_EXIT_CODES.timeout, timedOut.stderr);
    assert.equal(timedOut.stdout, "");
    assert.match(timedOut.stderr, /Timed out waiting for idle session after 150ms/);

    const success = await runCli(root, ["wait", saved.name, "--idle-ms", "100", "--timeout-ms", "2000", "--poll-ms", "50"]);
    assert.equal(success.code, WAIT_EXIT_CODES.success, success.stderr);
    assert.equal(success.stderr, "");
    assert.equal(success.stdout, "All done.\n❯ \n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hive wait --seal timeout uses exit 2 and wait help documents the table", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-wait-cli-seal-timeout-"));
  try {
    const saved = { ...record(root), tmuxTarget: "test-bee", substrate: "hsr" as const };
    await writeFakeRecord(root, saved);
    await writeLiveHsr(root, saved.name, "working\n");

    const timedOut = await runCli(root, ["wait", saved.name, "--seal", "--timeout-ms", "150", "--poll-ms", "50"]);
    assert.equal(timedOut.code, WAIT_EXIT_CODES.timeout, timedOut.stderr);
    assert.match(timedOut.stderr, /Timed out waiting for seal.*after 150ms/);

    const direct = await runCli(root, ["wait", "--help"]);
    const routed = await runCli(root, ["help", "wait"]);
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(direct.stderr, "");
    assert.equal(routed.stdout, direct.stdout);
    assert.match(direct.stdout, /Exit codes\n  0 .*\n  1 .*\n  2 /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFakeRecord(root: string, saved: SessionRecord): Promise<void> {
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(join(root, "sessions", `${saved.name}.json`), `${JSON.stringify(saved, null, 2)}\n`);
}

async function writeLiveHsr(root: string, bee: string, ring: string): Promise<void> {
  const runDir = join(root, "hsr", bee);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "ring.txt"), ring);
  await writeFile(join(runDir, "meta.json"), JSON.stringify({
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: process.pid,
    startedAt: new Date().toISOString(),
    controlSocket: join(runDir, "control.sock"),
    status: "running",
  }));
}

async function runCli(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: root, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}
