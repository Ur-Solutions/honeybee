import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
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
