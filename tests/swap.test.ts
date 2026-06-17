import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AccountRecord } from "../src/accounts.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { LaunchSpec, Substrate } from "../src/substrates/types.js";
import { resumeArgs, swapAccount } from "../src/swap.js";

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-swap-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
}

type FakeCall = { method: string; target: string; spec?: LaunchSpec };

function fakeSubstrate(initiallyAlive: boolean) {
  const calls: FakeCall[] = [];
  let alive = initiallyAlive;
  const substrate: Substrate = {
    kind: "local-tmux",
    node: "local",
    probe: async () => ({ ok: true }),
    hasSession: async () => alive,
    newSession: async (target, _cwd, spec) => {
      calls.push({ method: "newSession", target, spec });
      alive = true;
      return { paneId: "%0" };
    },
    newPane: async (target, _cwd, spec) => {
      calls.push({ method: "newPane", target, spec });
      return { paneId: "%0" };
    },
    kill: async (target) => {
      calls.push({ method: "kill", target });
      alive = false;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    killPane: async (paneId) => {
      calls.push({ method: "killPane", target: paneId });
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [],
    listPanes: async () => new Set<string>(),
    listSessionStates: async () => new Map<string, string>(),
    setUserOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => [],
    attachSession: async () => undefined,
  };
  return { substrate, calls };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CL.test",
    agent: "claude",
    cwd: "/tmp",
    command: "CLAUDE_CONFIG_DIR=/tmp/home-a claude --dangerously-skip-permissions",
    tmuxTarget: "CL-test",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    status: "running",
    homePath: "/tmp/home-a",
    accountId: "claude-old",
    providerSessionId: "uuid-123",
    ...overrides,
  };
}

const account: AccountRecord = { id: "claude-new", tool: "claude", label: "new@a.b", addedAt: "2026-06-01T00:00:00.000Z" };

test("swapAccount stops, re-credentials, resumes the same session, and rebinds", async () => {
  await withTempStore(async () => {
    const { substrate, calls } = fakeSubstrate(true);
    const activated: string[] = [];
    const existing = record();
    await saveSession(existing);
    const updated = await swapAccount(existing, account, {
      substrate,
      sleep: async () => undefined,
      activate: async (target, home) => {
        activated.push(`${target.id}:${home}`);
        return ["auth"];
      },
    });

    assert.deepEqual(activated, ["claude-new:/tmp/home-a"]);
    assert.equal(calls[0]!.method, "kill");
    const relaunch = calls.find((call) => call.method === "newSession")!;
    assert.equal(relaunch.target, "CL-test");
    // Same session resumed, same yolo mode, same home, in the same tmux target.
    assert.deepEqual(relaunch.spec!.args.slice(-2), ["--resume", "uuid-123"]);
    assert.ok(relaunch.spec!.args.includes("--dangerously-skip-permissions"));
    assert.equal(relaunch.spec!.env?.CLAUDE_CONFIG_DIR, "/tmp/home-a");

    assert.equal(updated.accountId, "claude-new");
    assert.equal(updated.status, "running");
    const persisted = await loadSession("CL.test");
    assert.equal(persisted?.accountId, "claude-new");
  });
});

test("swapAccount refuses a bee in the default home", async () => {
  await withTempStore(async () => {
    const { substrate } = fakeSubstrate(true);
    await assert.rejects(
      () => swapAccount(record({ homePath: undefined }), account, { substrate, sleep: async () => undefined }),
      /dedicated home/,
    );
  });
});

test("swapAccount refuses tool mismatch and no-op swaps", async () => {
  await withTempStore(async () => {
    const { substrate } = fakeSubstrate(true);
    const codexAccount: AccountRecord = { ...account, id: "codex-x", tool: "codex" };
    await assert.rejects(() => swapAccount(record(), codexAccount, { substrate, sleep: async () => undefined }), /codex account/);
    await assert.rejects(
      () => swapAccount(record({ accountId: "claude-new" }), account, { substrate, sleep: async () => undefined }),
      /already on account/,
    );
  });
});

test("swapAccount relaunches codex with CODEX_HOME but not HOME", async () => {
  await withTempStore(async () => {
    const { substrate, calls } = fakeSubstrate(false);
    const codexAccount: AccountRecord = { id: "codex-new", tool: "codex", label: "c@a.b", addedAt: "2026-06-01T00:00:00.000Z" };
    const existing = record({ agent: "codex", command: "CODEX_HOME=/tmp/home-c codex", homePath: "/tmp/home-c", accountId: "codex-old", providerSessionId: undefined });
    await saveSession(existing);
    await swapAccount(
      existing,
      codexAccount,
      { substrate, sleep: async () => undefined, activate: async () => ["auth.json"] },
    );
    const relaunch = calls.find((call) => call.method === "newSession")!;
    assert.deepEqual(relaunch.spec!.args.slice(-2), ["resume", "--last"]);
    assert.equal(relaunch.spec!.env?.CODEX_HOME, "/tmp/home-c");
    assert.equal(relaunch.spec!.env?.HOME, undefined);
  });
});

test("resumeArgs picks per-provider resume forms", () => {
  assert.deepEqual(resumeArgs("claude", "abc"), ["--resume", "abc"]);
  assert.deepEqual(resumeArgs("claude", undefined), ["--continue"]);
  assert.deepEqual(resumeArgs("codex", "abc"), ["resume", "abc"]);
  assert.deepEqual(resumeArgs("codex", undefined), ["resume", "--last"]);
  assert.deepEqual(resumeArgs("grok", "abc"), []);
});
