import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { capture, hasSession, kill } from "../src/tmux.js";
import { setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

// Spawn-side tests must NOT touch the user's real tmux server. A `hive spawn`
// child shells out to tmux, and when no server is up yet, tmux captures the
// caller's env into its GLOBAL env — so a leaked HIVE_STORE_ROOT would survive
// in `tmux show-environment -g` long after the test exits. Routing every tmux
// call (both in-process and the child's) through a per-test throwaway socket
// makes that impossible: the new server starts on the socket, holds the test's
// env, and is killed in finally.
async function withIsolatedTmux<T>(fn: (socket: string) => Promise<T>): Promise<T> {
  const socketDir = await mkdtemp(join(tmpdir(), "honeybee-spawn-socket-"));
  const socket = join(socketDir, "s.sock");
  const previousTmpdir = process.env.TMUX_TMPDIR;
  const previousSocket = process.env.HIVE_TMUX_SOCKET;
  const previousTmux = process.env.TMUX;
  process.env.TMUX_TMPDIR = socketDir;
  process.env.HIVE_TMUX_SOCKET = socket;
  delete process.env.TMUX;
  setTmuxSocket(socket);
  try {
    return await fn(socket);
  } finally {
    await tmux(["kill-server"], { reject: false });
    setTmuxSocket(undefined);
    if (previousTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = previousTmpdir;
    if (previousSocket === undefined) delete process.env.HIVE_TMUX_SOCKET;
    else process.env.HIVE_TMUX_SOCKET = previousSocket;
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    await rm(socketDir, { recursive: true, force: true });
  }
}

// Emulate a codex-style TUI: show the trust prompt, then on Enter re-render
// (alternate screen + clear) into the ready prompt. The alternate screen has
// no scrollback, so once cleared the trust text is gone from `capture-pane`,
// exactly like the real codex CLI.
const FAKE_CODEX = `#!/bin/sh
printf '\\033[?1049h'
printf 'Do you trust the contents of this directory?\\r\\n'
printf 'Press enter to continue\\r\\n'
read _
printf '\\033[2J\\033[H'
printf 'What can I help with?\\r\\n'
printf '> \\r\\n'
sleep 30
`;

const STUCK_CODEX = `#!/bin/sh
printf 'still booting\\r\\n'
sleep 30
`;

const FAKE_CLAUDE = `#!/bin/sh
sleep 30
`;

test("spawn auto-accepts the codex trust prompt and waits for readiness", async () => {
  await withIsolatedTmux(async (socket) => {
    const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-spawn-store-"));
    const cwd = await mkdtemp(join(tmpdir(), "honeybee-spawn-cwd-"));
    const fakeCodex = join(storeRoot, "fake-codex.sh");
    await writeFile(fakeCodex, FAKE_CODEX);
    await chmod(fakeCodex, 0o755);
    const name = `hive-test-trust-${process.pid}`;
    try {
      const result = await runCli(
        ["spawn", "codex", "--name", name, "--cwd", cwd, "--boot-ms", "8000"],
        { HIVE_STORE_ROOT: storeRoot, HIVE_CODEX_CMD: fakeCodex, HIVE_TMUX_SOCKET: socket },
      );

      assert.equal(result.code, 0, result.stderr);
      // Spawn must not return until readiness is confirmed, so the trust prompt
      // has already been accepted (Enter sent) and the ready prompt is showing.
      const pane = await capture(name, 100);
      assert.match(pane, /What can I help with/);
      assert.doesNotMatch(pane, /Do you trust the contents of this directory/);
    } finally {
      await kill(name);
      await rm(storeRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("spawn --no-wait skips readiness and returns before the trust prompt is accepted", async () => {
  await withIsolatedTmux(async (socket) => {
    const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-spawn-store-"));
    const cwd = await mkdtemp(join(tmpdir(), "honeybee-spawn-cwd-"));
    const fakeCodex = join(storeRoot, "fake-codex.sh");
    await writeFile(fakeCodex, FAKE_CODEX);
    await chmod(fakeCodex, 0o755);
    const name = `hive-test-nowait-${process.pid}`;
    try {
      const result = await runCli(
        ["spawn", "codex", "--name", name, "--cwd", cwd, "--no-wait"],
        { HIVE_STORE_ROOT: storeRoot, HIVE_CODEX_CMD: fakeCodex, HIVE_TMUX_SOCKET: socket },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(await hasSession(name), true);
    } finally {
      await kill(name);
      await rm(storeRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("spawn --briefed records the delivered brief as lastPrompt for transcript matching", async () => {
  await withIsolatedTmux(async (socket) => {
    const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-spawn-brief-store-"));
    const cwd = await mkdtemp(join(tmpdir(), "honeybee-spawn-brief-cwd-"));
    const name = `hive-test-brief-${process.pid}-${Date.now()}`;
    const brief = "echo HIVE_BRIEF_ANCHOR";
    try {
      const result = await runCli(
        ["spawn", "sh", "--name", name, "--cwd", cwd, "--briefed", "--brief", brief, "--no-footer", "--", "-i"],
        { HIVE_STORE_ROOT: storeRoot, HIVE_TMUX_SOCKET: socket },
      );

      assert.equal(result.code, 0, result.stderr);
      const record = JSON.parse(await readFile(join(storeRoot, "sessions", `${name}.json`), "utf8")) as {
        brief?: string;
        briefedAt?: string;
        lastPrompt?: string;
        lastPromptAt?: string;
      };
      assert.equal(record.brief, brief);
      assert.ok(record.briefedAt, "brief timestamp recorded");
      assert.ok(record.lastPromptAt, "last prompt timestamp recorded");
      assert.match(record.lastPrompt ?? "", /HIVE_BRIEF_ANCHOR/);
    } finally {
      await kill(name);
      await rm(storeRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("spawn --briefed warns instead of failing when readiness times out before delivery", async () => {
  await withIsolatedTmux(async (socket) => {
    const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-spawn-brief-timeout-store-"));
    const cwd = await mkdtemp(join(tmpdir(), "honeybee-spawn-brief-timeout-cwd-"));
    const fakeCodex = join(storeRoot, "stuck-codex.sh");
    await writeFile(fakeCodex, STUCK_CODEX);
    await chmod(fakeCodex, 0o755);
    const name = `hive-test-brief-timeout-${process.pid}-${Date.now()}`;
    try {
      const result = await runCli(
        ["spawn", "codex", "--name", name, "--cwd", cwd, "--briefed", "--brief", "hello", "--boot-ms", "800"],
        { HIVE_STORE_ROOT: storeRoot, HIVE_CODEX_CMD: fakeCodex, HIVE_TMUX_SOCKET: socket },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, new RegExp(`warn\\tspawn\\t${name}\\ttimeout`));
      const record = JSON.parse(await readFile(join(storeRoot, "sessions", `${name}.json`), "utf8")) as {
        brief?: string;
        lastPromptAt?: string;
      };
      assert.equal(record.brief, "hello");
      assert.equal(record.lastPromptAt, undefined, "timed-out spawn brief was not recorded as delivered");
    } finally {
      await kill(name);
      await rm(storeRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("spawn treats --session-id=<id> as caller-supplied and does not add a second session id", async () => {
  await withIsolatedTmux(async (socket) => {
    const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-spawn-session-id-store-"));
    const cwd = await mkdtemp(join(tmpdir(), "honeybee-spawn-session-id-cwd-"));
    const fakeClaude = join(storeRoot, "fake-claude.sh");
    await writeFile(fakeClaude, FAKE_CLAUDE);
    await chmod(fakeClaude, 0o755);
    const name = `hive-test-session-id-${process.pid}-${Date.now()}`;
    try {
      const result = await runCli(
        ["spawn", "claude", "--name", name, "--cwd", cwd, "--no-wait", "--", "--session-id=custom"],
        { HIVE_STORE_ROOT: storeRoot, HIVE_CLAUDE_CMD: fakeClaude, HIVE_TMUX_SOCKET: socket },
      );

      assert.equal(result.code, 0, result.stderr);
      const record = JSON.parse(await readFile(join(storeRoot, "sessions", `${name}.json`), "utf8")) as {
        command: string;
        providerSessionId?: string;
      };
      assert.match(record.command, /--session-id=custom/);
      assert.doesNotMatch(record.command, /--session-id\s+[0-9a-f-]{36}/);
      assert.equal(record.providerSessionId, undefined);
    } finally {
      await kill(name);
      await rm(storeRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, NO_COLOR: "1" },
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}
