import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import { hasSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";
import { recordSeal, sealedBeeNames, validateSealArtifact } from "../src/seal.js";
import type { SessionRecord } from "../src/store.js";

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

function hive(store: string, socket: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
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

    const result = await hive(store, socket, ["revive", bee, "--session", "sess-exact"]);
    assert.match(result.stdout, /revived\tCO\.exact-session\tcodex\tresumed sess-exact/);
    assert.equal(await hasSession("CO-exact-session"), true, "revive launches the bee");

    const record = await readBee(store, bee);
    assert.equal(record.providerSessionId, "sess-exact");
    assert.match(String(record.command), /resume sess-exact/);
    assert.doesNotMatch(String(record.command), /resume --last/);
  });
});

test("revive routes local HSR records through the runner host", async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "HSR.revive";
    await seedBee(store, bee, {
      agent: "stub",
      requestedAgent: "stub",
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      runnerPid: 2 ** 31 - 1,
      providerSessionId: "sess-hsr",
      lastObservedState: "sealed",
      lastObservedStateAt: "2026-06-25T00:01:00.000Z",
      terminalTranscriptDiscoveryAt: "2026-06-25T00:01:00.000Z",
    });
    await withStoreEnv(store, () => recordSeal(bee, validateSealArtifact({ status: "done", summary: "old runtime" })));

    try {
      const result = await hive(store, socket, ["revive", bee]);
      assert.match(result.stdout, /revived\tHSR\.revive\tstub\tresumed sess-hsr/);

      const record = await readBee(store, bee);
      assert.equal(record.status, "running");
      assert.equal(record.substrate, "hsr");
      assert.equal(record.providerSessionId, "sess-hsr");
      assert.equal(typeof record.runnerPid, "number");
      assert.equal(record.runtimeGeneration, 1);
      assert.equal(typeof record.sealHighWaterFilename, "string");
      assert.equal(record.lastObservedState, undefined);
      assert.equal(record.lastObservedStateAt, undefined);
      assert.equal(record.terminalTranscriptDiscoveryAt, undefined);

      await withStoreEnv(store, async () => {
        assert.equal((await sealedBeeNames([record as unknown as SessionRecord])).has(bee), false);
        await recordSeal(bee, validateSealArtifact({ status: "done", summary: "new runtime" }));
        assert.equal((await sealedBeeNames([record as unknown as SessionRecord])).has(bee), true);
        const meta = await readHsrMeta(bee);
        assert.equal(meta?.status, "running");
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
      tmuxTarget: bad,
      substrate: "hsr",
      providerSessionId: "sess-bad",
      updatedAt: "2026-06-25T00:00:02.000Z",
    });
    await seedBee(store, good, {
      agent: "stub",
      requestedAgent: "stub",
      command: "stub",
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

      await withStoreEnv(store, async () => {
        const meta = await readHsrMeta(good);
        assert.equal(meta?.status, "running");
        assert.equal(meta?.sessionId, "sess-good");
      });
    } finally {
      await killHsrBee(store, good);
    }
  });
});
