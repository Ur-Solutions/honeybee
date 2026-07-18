import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountDir, type AccountRecord } from "../src/accounts.js";
import type { HsrRunPayload } from "../src/hsr/runnerHost.js";
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
    kill: async (target) => {
      calls.push({ method: "kill", target });
      alive = false;
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
    setWindowOptions: async () => undefined,
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

async function seedOpencodeAuth(account: AccountRecord, token: string, root = accountDir(account), mtimeIso?: string): Promise<void> {
  const path = join(root, "xdg-data", "opencode", "auth.json");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ [account.provider ?? "zai-coding-plan"]: { type: "api", key: token } }));
  if (mtimeIso) {
    const date = new Date(mtimeIso);
    await utimes(path, date, date);
  }
}

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

test("swapAccount rejects a provider mismatch (opencode: glm bee -> minimax account)", async () => {
  await withTempStore(async () => {
    const { substrate } = fakeSubstrate(true);
    const glmCurrent: AccountRecord = { id: "zai-current", tool: "opencode", label: "zai", addedAt: "2026-06-01T00:00:00.000Z", provider: "zai-coding-plan" };
    const minimaxTarget: AccountRecord = { id: "mm-target", tool: "opencode", label: "mm", addedAt: "2026-06-01T00:00:00.000Z", provider: "minimax-coding-plan" };
    const beeRecord = record({ agent: "opencode", accountId: "zai-current", homePath: "/tmp/home-oc" });
    await assert.rejects(
      () =>
        swapAccount(beeRecord, minimaxTarget, {
          substrate,
          sleep: async () => undefined,
          listAccounts: async () => [glmCurrent, minimaxTarget],
        }),
      /minimax-coding-plan account; bee .* runs on zai-coding-plan/,
    );
  });
});

test("swapAccount tolerates undefined provider (legacy claude swap still allowed)", async () => {
  await withTempStore(async () => {
    const { substrate, calls } = fakeSubstrate(true);
    // Legacy current account carries no provider; the guard must be skipped.
    const legacyCurrent: AccountRecord = { id: "claude-old", tool: "claude", label: "old@a.b", addedAt: "2026-06-01T00:00:00.000Z" };
    const existing = record();
    await saveSession(existing);
    const updated = await swapAccount(existing, account, {
      substrate,
      sleep: async () => undefined,
      activate: async () => ["auth"],
      listAccounts: async () => [legacyCurrent, account],
    });
    assert.equal(updated.accountId, "claude-new");
    assert.ok(calls.some((call) => call.method === "newSession"));
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

test("swapAccount relaunches an HSR bee through the runner host", async () => {
  await withTempStore(async () => {
    const { substrate, calls } = fakeSubstrate(false);
    const codexAccount: AccountRecord = { id: "codex-new", tool: "codex", label: "c@a.b", addedAt: "2026-06-01T00:00:00.000Z" };
    const existing = record({
      name: "CO.test",
      agent: "codex",
      command: "CODEX_HOME=/tmp/home-c codex --yolo",
      tmuxTarget: "CO.test",
      substrate: "hsr",
      homePath: "/tmp/home-c",
      accountId: "codex-old",
      providerSessionId: "thread-123",
    });
    await saveSession(existing);
    let payload: HsrRunPayload | undefined;

    const updated = await swapAccount(existing, codexAccount, {
      substrate,
      sleep: async () => undefined,
      activate: async () => ["auth.json"],
      spawnHsrHost: async (next) => {
        payload = next;
        return 4321;
      },
      waitForHsrHost: async () => true,
    });

    assert.equal(calls.some((call) => call.method === "newSession"), false);
    assert.equal(payload?.bee, "CO.test");
    assert.equal(payload?.sessionId, "thread-123");
    assert.equal(payload?.resume, true);
    assert.equal(payload?.spec.env.CODEX_HOME, "/tmp/home-c");
    assert.equal(payload?.spec.args.includes("resume"), false);
    assert.equal(updated.runnerPid, 4321);
    assert.equal(updated.accountId, "codex-new");
  });
});

test("swapAccount restores the old credentials when HSR relaunch fails", async () => {
  await withTempStore(async () => {
    const { substrate } = fakeSubstrate(false);
    const oldAccount: AccountRecord = { id: "codex-old", tool: "codex", label: "old@a.b", addedAt: "2026-06-01T00:00:00.000Z" };
    const targetAccount: AccountRecord = { id: "codex-new", tool: "codex", label: "new@a.b", addedAt: "2026-06-01T00:00:00.000Z" };
    const existing = record({
      name: "CO.test",
      agent: "codex",
      command: "CODEX_HOME=/tmp/home-c codex --yolo",
      tmuxTarget: "CO.test",
      substrate: "hsr",
      homePath: "/tmp/home-c",
      accountId: oldAccount.id,
      providerSessionId: "thread-123",
    });
    await saveSession(existing);
    const activated: string[] = [];

    await assert.rejects(
      () => swapAccount(existing, targetAccount, {
        substrate,
        sleep: async () => undefined,
        listAccounts: async () => [oldAccount, targetAccount],
        activate: async (next) => {
          activated.push(next.id);
          return ["auth.json"];
        },
        spawnHsrHost: async () => {
          throw new Error("runner launch failed");
        },
      }),
      /runner launch failed/,
    );

    assert.deepEqual(activated, ["codex-new", "codex-old"]);
    assert.equal((await loadSession(existing.name))?.accountId, "codex-old");
  });
});

test("swapAccount threads the new account's model into the resumed opencode command (fix #4)", async () => {
  await withTempStore(async () => {
    const { substrate, calls } = fakeSubstrate(false);
    const opencodeAccount: AccountRecord = {
      id: "opencode-minimax",
      tool: "opencode",
      label: "minimax",
      provider: "minimax-coding-plan",
      model: "MiniMax-M3",
      addedAt: "2026-06-01T00:00:00.000Z",
    };
    const existing = record({
      agent: "opencode",
      command: "OPENCODE_CONFIG_DIR=/tmp/home-o opencode run --interactive",
      homePath: "/tmp/home-o",
      accountId: "opencode-glm",
      providerSessionId: "sess-1",
    });
    await saveSession(existing);
    await swapAccount(existing, opencodeAccount, { substrate, sleep: async () => undefined, activate: async () => ["xdg-data/opencode/auth.json"] });
    const relaunch = calls.find((call) => call.method === "newSession")!;
    // The swapped bee keeps its --model selector built from the NEW account.
    const args = relaunch.spec!.args;
    const modelIdx = args.indexOf("--model");
    assert.notEqual(modelIdx, -1);
    assert.equal(args[modelIdx + 1], "minimax-coding-plan/MiniMax-M3");
    // ...and still resumes the same provider session.
    assert.deepEqual(args.slice(-2), ["--session", "sess-1"]);
  });
});

test("swapAccount rescues generic file-backed credentials before overwriting the home", async () => {
  await withTempStore(async (dir) => {
    const { substrate } = fakeSubstrate(false);
    const currentAccount: AccountRecord = {
      id: "opencode-current",
      tool: "opencode",
      label: "current",
      provider: "zai-coding-plan",
      addedAt: "2026-06-01T00:00:00.000Z",
    };
    const targetAccount: AccountRecord = {
      id: "opencode-target",
      tool: "opencode",
      label: "target",
      provider: "zai-coding-plan",
      addedAt: "2026-06-01T00:00:00.000Z",
    };
    const home = join(dir, "homes", "shared-opencode");
    await seedOpencodeAuth(currentAccount, "old-current", accountDir(currentAccount), "2026-06-01T00:00:00.000Z");
    await seedOpencodeAuth(currentAccount, "fresh-current", home, "2026-06-02T00:00:00.000Z");
    await seedOpencodeAuth(targetAccount, "target-key");
    const existing = record({
      agent: "opencode",
      command: `OPENCODE_CONFIG_DIR=${home} opencode run --interactive`,
      homePath: home,
      accountId: currentAccount.id,
      providerSessionId: "sess-1",
    });
    await saveSession(existing);

    await swapAccount(existing, targetAccount, {
      substrate,
      sleep: async () => undefined,
      listAccounts: async () => [currentAccount, targetAccount],
    });

    const rescued = JSON.parse(await readFile(join(accountDir(currentAccount), "xdg-data", "opencode", "auth.json"), "utf8"));
    assert.equal(rescued["zai-coding-plan"].key, "fresh-current");
    const stamped = JSON.parse(await readFile(join(home, "xdg-data", "opencode", "auth.json"), "utf8"));
    assert.equal(stamped["zai-coding-plan"].key, "target-key");
  });
});

test("resumeArgs picks per-provider resume forms", () => {
  assert.deepEqual(resumeArgs("claude", "abc"), ["--resume", "abc"]);
  assert.deepEqual(resumeArgs("claude", undefined), ["--continue"]);
  assert.deepEqual(resumeArgs("codex", "abc"), ["resume", "abc"]);
  assert.deepEqual(resumeArgs("codex", undefined), ["resume", "--last"]);
  assert.deepEqual(resumeArgs("grok", "abc"), []);
});
