import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import { hasSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function seedBee(store: string, name: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const sessionsDir = join(store, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const now = "2026-06-25T00:00:00.000Z";
  const record = {
    name,
    agent: "codex",
    requestedAgent: "codex",
    cwd: store,
    launchArgv: ["sh", "-c", "sleep 120", "--", "--original-flag", "two words"],
    command: "CODEX_HOME=/tmp/hive-codex-home codex --dangerously-bypass-approvals-and-sandbox",
    tmuxTarget: name.replaceAll(".", "-"),
    homePath: "/tmp/hive-codex-home",
    id: name,
    createdAt: now,
    updatedAt: now,
    status: "dead" as const,
    ...overrides,
  };
  await writeFile(join(sessionsDir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function readBee(store: string, name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(store, "sessions", `${name}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function hive(store: string, socket: string, args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: store,
      HIVE_TMUX_SOCKET: socket,
      HIVE_CODEX_CMD: "sh -c 'sleep 120' --",
      HIVE_STUB_CMD: process.execPath,
      HIVE_NO_KEYCHAIN: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      ...envOverrides,
    },
  });
}

async function withRig(fn: (ctx: { store: string; socket: string }) => Promise<void>): Promise<void> {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-revive-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-revive-store-"));
  setTmuxSocket(socket);
  try {
    await fn({ store, socket });
  } finally {
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

async function withStoreEnv<T>(store: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
  }
}

async function killHsrBee(store: string, bee: string): Promise<void> {
  await withStoreEnv(store, async () => {
    await hsrSubstrate().kill(bee).catch(() => undefined);
  });
}

async function hiveResult(store: string, socket: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await hive(store, socket, args);
    return { code: 0, ...result };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

async function waitForArgvInvocations(path: string, count: number): Promise<string[][]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const raw = await readFile(path, "utf8").catch(() => "");
    const invocations = raw
      .split("---\n")
      .filter(Boolean)
      .map((chunk) => chunk.trimEnd().split("\n"));
    if (invocations.length >= count) return invocations;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${count} argv invocation(s) in ${path}`);
}

test("revive refuses ambiguous resume without a provider session id", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.no-session";
    await seedBee(store, bee);

    await assert.rejects(
      () => hive(store, socket, ["revive", bee]),
      /no recorded provider session id; pass --session <id>.*--fresh/,
    );
    assert.equal(await hasSession("CO-no-session"), false, "revive must not launch an ambiguous latest-session resume");
  });
});

test("revive --session resumes and persists the exact provider session id", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.exact-session";
    await seedBee(store, bee);

    const original = await readBee(store, bee);
    const result = await hive(store, socket, ["revive", bee, "--session", "sess-exact", "--no-wait"]);
    assert.match(result.stdout, /revived\tCO\.exact-session\tcodex\tresumed sess-exact\t/);
    assert.match(result.stdout, /sh -c 'sleep 120' -- --original-flag 'two words' resume sess-exact/);
    assert.equal(await hasSession("CO-exact-session"), true, "revive launches the bee");

    const record = await readBee(store, bee);
    assert.equal(record.providerSessionId, "sess-exact");
    assert.equal(record.command, original.command, "the original rendered command is immutable");
    assert.deepEqual(record.launchArgv, original.launchArgv, "the structured launch is immutable");
    assert.match(String(record.lastReviveCommand), /--original-flag 'two words' resume sess-exact/);
    assert.doesNotMatch(String(record.lastReviveCommand), /resume --last/);
  });
});

test("spawn-record round trip: revive --fresh replays yolo and passthrough argv verbatim", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.verbatim";
    const binDir = join(store, "bin");
    const fakeCodex = join(binDir, "codex");
    const argvLog = join(store, "argv.log");
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCodex, `#!/bin/sh\nprintf '%s\\n' '---' "$@" >> '${argvLog}'\nsleep 120\n`);
    await chmod(fakeCodex, 0o755);
    const env = {
      HIVE_CODEX_CMD: `${fakeCodex} --dangerously-bypass-approvals-and-sandbox`,
    };
    const passthrough = ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="xhigh"'];

    await hive(store, socket, ["spawn", "codex", "--name", bee, "--cwd", store, "--yolo", "--no-wait", "--", ...passthrough], env);
    const spawned = await readBee(store, bee);
    assert.deepEqual(spawned.launchArgv, [fakeCodex, "--dangerously-bypass-approvals-and-sandbox", ...passthrough]);
    const originalCommand = spawned.command;
    const originalArgv = spawned.launchArgv;

    await waitForArgvInvocations(argvLog, 1);
    await tmux(["kill-session", "-t", "=CO-verbatim"]);
    const result = await hive(store, socket, ["revive", bee, "--fresh", "--no-wait"], env);
    const revived = await readBee(store, bee);

    assert.equal(revived.command, originalCommand);
    assert.deepEqual(revived.launchArgv, originalArgv);
    assert.equal(revived.providerSessionId, undefined);
    assert.equal(revived.lastReviveCommand, originalCommand, "fresh replay is the exact original base launch");
    assert.match(result.stdout, /codex --dangerously-bypass-approvals-and-sandbox -m gpt-5\.6-sol -c/);

    const expectedArgs = ["--dangerously-bypass-approvals-and-sandbox", ...passthrough];
    const invocations = await waitForArgvInvocations(argvLog, 2);
    assert.deepEqual(invocations, [expectedArgs, expectedArgs], "spawn and fresh revive reached the harness with identical argv");
  });
});

test("string-only legacy commands replay defensively and remain immutable", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.legacy-command";
    const command = "CODEX_HOME=/tmp/hive-codex-home HIVE_LEGACY=kept sh -c 'sleep 120' -- --legacy 'two words' resume stale-provider-id";
    await seedBee(store, bee, {
      launchArgv: undefined,
      command,
      providerSessionId: "sess-legacy",
    });

    const result = await hive(store, socket, ["revive", bee, "--no-wait"]);
    const record = await readBee(store, bee);
    assert.equal(record.command, command);
    assert.equal(record.launchArgv, undefined);
    assert.match(String(record.lastReviveCommand), /HIVE_LEGACY=kept sh -c 'sleep 120' -- --legacy 'two words' resume sess-legacy/);
    assert.doesNotMatch(String(record.lastReviveCommand), /stale-provider-id/);
    assert.match(result.stdout, /--legacy 'two words' resume sess-legacy/);
  });
});

test("an unavailable argless legacy command falls back to the current resolver", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.legacy-fallback";
    await seedBee(store, bee, {
      launchArgv: undefined,
      command: "definitely-missing-old-codex",
      providerSessionId: "sess-fallback",
    });

    const result = await hive(store, socket, ["revive", bee, "--no-wait"]);
    const record = await readBee(store, bee);
    assert.equal(record.command, "definitely-missing-old-codex");
    assert.match(String(record.lastReviveCommand), /sh -c 'sleep 120' -- resume sess-fallback/);
    assert.match(result.stdout, /sh -c 'sleep 120' -- resume sess-fallback/);
  });
});

test("a failed revive cannot rewrite the recorded command or argv", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.failed-immutable";
    await seedBee(store, bee, {
      launchArgv: ["definitely-missing-revive-harness", "--pinned", "value"],
      command: "definitely-missing-revive-harness --pinned value",
      providerSessionId: "sess-fail",
    });
    const before = await readBee(store, bee);

    await assert.rejects(() => hive(store, socket, ["revive", bee, "--no-wait"]), /Executable not found on PATH: definitely-missing-revive-harness/);
    const after = await readBee(store, bee);
    assert.deepEqual(after, before);
    assert.equal(await hasSession("CO-failed-immutable"), false);
  });
});

test("revive routes local HSR records through the runner host", async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "HSR.revive";
    await seedBee(store, bee, {
      agent: "stub",
      requestedAgent: "stub",
      command: "stub",
      launchArgv: [process.execPath, "--recorded-hsr-flag"],
      tmuxTarget: bee,
      substrate: "hsr",
      runnerPid: 2 ** 31 - 1,
      providerSessionId: "sess-hsr",
    });

    try {
      const result = await hive(store, socket, ["revive", bee]);
      assert.match(result.stdout, /revived\tHSR\.revive\tstub\tresumed sess-hsr/);

      const record = await readBee(store, bee);
      assert.equal(record.status, "running");
      assert.equal(record.substrate, "hsr");
      assert.equal(record.providerSessionId, "sess-hsr");
      assert.equal(typeof record.runnerPid, "number");
      assert.equal(record.command, "stub", "HSR revive leaves the original command untouched");
      assert.match(String(record.lastReviveCommand), /--recorded-hsr-flag/);

      await withStoreEnv(store, async () => {
        const meta = await readHsrMeta(bee);
        assert.ok(meta?.status === "running" || meta?.status === "queued", `expected live/queued HSR host, got ${meta?.status}`);
        assert.equal(meta?.harness, "stub");
        assert.equal(meta?.sessionId, "sess-hsr");
      });
    } finally {
      await killHsrBee(store, bee);
    }
  });
});

test("revive --all continues after a per-bee failure", async () => {
  await withRig(async ({ store, socket }) => {
    const bad = "HSR.bad";
    const good = "HSR.good";
    await seedBee(store, bad, {
      agent: "definitely-missing-hsr-harness",
      requestedAgent: "definitely-missing-hsr-harness",
      command: "definitely-missing-hsr-harness",
      launchArgv: ["definitely-missing-hsr-harness", "--recorded-bad-flag"],
      tmuxTarget: bad,
      substrate: "hsr",
      providerSessionId: "sess-bad",
      updatedAt: "2026-06-25T00:00:02.000Z",
    });
    await seedBee(store, good, {
      agent: "stub",
      requestedAgent: "stub",
      command: "stub",
      launchArgv: [process.execPath, "--recorded-good-flag"],
      tmuxTarget: good,
      substrate: "hsr",
      providerSessionId: "sess-good",
      updatedAt: "2026-06-25T00:00:01.000Z",
    });

    try {
      const result = await hiveResult(store, socket, ["revive", "--all"]);
      assert.equal(result.code, 1, "bulk revive reports partial failure");
      assert.match(result.stdout, /revive_failed\tHSR\.bad\tExecutable not found on PATH: definitely-missing-hsr-harness/);
      assert.match(result.stdout, /revived\tHSR\.good\tstub\tresumed sess-good/);
      assert.match(result.stdout, /revive\tall\t1\t0\t0/);

      const goodRecord = await readBee(store, good);
      assert.equal(goodRecord.status, "running");
      assert.equal(goodRecord.substrate, "hsr");
      assert.equal(goodRecord.command, "stub");
      assert.match(String(goodRecord.lastReviveCommand), /--recorded-good-flag/);

      await withStoreEnv(store, async () => {
        const meta = await readHsrMeta(good);
        assert.ok(meta?.status === "running" || meta?.status === "queued", `expected live/queued HSR host, got ${meta?.status}`);
        assert.equal(meta?.sessionId, "sess-good");
      });
    } finally {
      await killHsrBee(store, good);
    }
  });
});

test("revive --crashed replays the same recorded launch path", async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "HSR.crashed";
    await seedBee(store, bee, {
      agent: "stub",
      requestedAgent: "stub",
      command: "stub --original",
      launchArgv: [process.execPath, "--recorded-crashed-flag"],
      tmuxTarget: bee,
      substrate: "hsr",
      runnerPid: 2 ** 31 - 1,
      providerSessionId: "sess-crashed",
      status: "running",
    });

    try {
      const result = await hive(store, socket, ["revive", "--crashed", "--no-wait"]);
      assert.match(result.stdout, /revived\tHSR\.crashed\tstub\tresumed sess-crashed\t/);
      assert.match(result.stdout, /--recorded-crashed-flag/);
      const record = await readBee(store, bee);
      assert.equal(record.command, "stub --original");
      assert.deepEqual(record.launchArgv, [process.execPath, "--recorded-crashed-flag"]);
    } finally {
      await killHsrBee(store, bee);
    }
  });
});
