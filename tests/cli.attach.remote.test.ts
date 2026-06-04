import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { SessionRecord } from "../src/store.js";
import { hasSession as tmuxHasSession, kill as tmuxKill, newSession as tmuxNewSession } from "../src/tmux.js";

const execFileAsync = promisify(execFile);

// Stub `ssh` that always succeeds with empty output. The test does NOT exercise the
// real ssh path — it only verifies the argv that `hive attach --print` emits for a
// remote session record. ensureLive calls hasSession via the stub (exit 0 = success),
// then the CLI prints attachCommand([...]), which is what we assert on.
async function makeSshStub(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "hive-attach-bin-"));
  const path = join(binDir, "ssh");
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
  return binDir;
}

const ENV = (storeDir: string, stubDir: string) => ({
  ...process.env,
  HIVE_STORE_ROOT: storeDir,
  NO_COLOR: "1",
  TERM: "dumb",
  PATH: `${stubDir}:${process.env.PATH ?? ""}`,
});

async function hive(storeDir: string, stubDir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: ENV(storeDir, stubDir),
  });
}

async function writeRecord(dir: string, record: SessionRecord): Promise<void> {
  const sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `${record.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

function seedRecord(record: Partial<SessionRecord> & { name: string; tmuxTarget: string }): SessionRecord {
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
  };
}

test("hive attach --print emits ssh -t <endpoint> tmux attach-session for a remote bee", { timeout: 30_000 }, async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "hive-attach-remote-store-"));
  const stubDir = await makeSshStub();
  try {
    await hive(storeDir, stubDir, "node", "register", "mini01", "--kind", "ssh-tmux", "--endpoint", "trmd@mini01");
    await writeRecord(storeDir, seedRecord({ name: "remote-bee", tmuxTarget: "remote-bee", node: "mini01", id: "CO.rem" }));

    const { stdout } = await hive(storeDir, stubDir, "attach", "--print", "remote-bee");
    // ensureLive succeeded via the stub; the printed command is the canonical ssh attachCommand.
    assert.match(stdout, /\bssh -t trmd@mini01 tmux attach-session -t remote-bee\b/);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
});

test("hive attach --print emits a local tmux attach-session (no ssh) for a local bee", { timeout: 30_000 }, async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "hive-attach-local-store-"));
  const stubDir = await makeSshStub();
  const name = `hive-attach-local-${process.pid}`;
  try {
    // Use a real tmux session so ensureLive (hasSession) returns true without
    // requiring tmux stubs. The TMUX env var is cleared so attachCommand picks
    // the `tmux attach-session` form, not `tmux switch-client`.
    await tmuxNewSession(name, "/tmp", { command: "sh", args: ["-i"] });
    await writeRecord(storeDir, seedRecord({ name, tmuxTarget: name, id: "CO.loc" }));

    const env = { ...ENV(storeDir, stubDir), TMUX: "" };
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "attach", "--print", name],
      { cwd: process.cwd(), env },
    );
    assert.match(stdout, new RegExp(`\\btmux attach-session -t ${name}\\b`));
    assert.ok(!/\bssh\b/.test(stdout), `expected no ssh in output, got: ${stdout}`);
  } finally {
    if (await tmuxHasSession(name)) await tmuxKill(name);
    await rm(storeDir, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
});
