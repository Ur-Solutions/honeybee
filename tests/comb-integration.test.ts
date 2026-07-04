// APIA-85 retirement tests on a throwaway tmux server (TMUX_TMPDIR isolation,
// like pane-identity.integration.test.ts). Combs — multiple bees sharing one
// tmux session via split panes — are retired: `hive split` now errors, and the
// pane-spawn/pane-kill verbs are off the Substrate interface. What remains:
//   - the LOW-LEVEL tmux `newPane`/`killPane` helpers (still exported for direct
//     callers such as the sidebar layout) keep working;
//   - `hive split` prints a clear deprecation error;
//   - PANE PINNING stays: `hive here --id` still resolves a solo bee by its own
//     agentPaneId (the fix combs never removed).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { hasSession, killPane, listPanes, newPane, newSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

// Private throwaway tmux socket so the developer's real server is never touched:
// every tmux call (here and in the CLI subprocesses, via $HIVE_TMUX_SOCKET) is
// pinned to it with `-S`, which is also what permits `kill-server` past the
// safety guard. No TMUX env (we set it per-invocation where a command must
// believe it is inside tmux).
process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "hive-comb-itest-"));
delete process.env.TMUX;
process.env.HIVE_TMUX_SOCKET = join(process.env.TMUX_TMPDIR, "s.sock");
setTmuxSocket(process.env.HIVE_TMUX_SOCKET);

after(async () => {
  await tmux(["kill-server"], { reject: false });
  setTmuxSocket(undefined);
  delete process.env.HIVE_TMUX_SOCKET;
  rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
});

// A valid $TMUX value (socket,pid,session) pointing at the THROWAWAY server, so
// that tmux commands run by the CLI subprocess target the test socket — not the
// developer's real server. tmux parses the socket path from the first field of
// $TMUX, which would otherwise override TMUX_TMPDIR.
function fakeTmuxEnv(): string {
  return `${process.env.HIVE_TMUX_SOCKET},0,0`;
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      // HIVE_BEE cleared: the suite may itself run inside a bee (agents test
      // hive with hive), and an inherited stamp would satisfy `hive here`'s
      // pane-less HSR path and break the outside-tmux assertions.
      env: { ...process.env, HIVE_BEE: "", ...env, NO_COLOR: "1" },
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

async function readRecord(storeRoot: string, name: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(join(storeRoot, "sessions", `${name}.json`), "utf8").catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

// ---- Retained low-level tmux primitives -----------------------------------

test("low-level newPane/killPane still split and drop a pane while the session survives", { timeout: 30_000 }, async () => {
  const cwd = process.env.TMUX_TMPDIR!;
  const session = "comb-prim";
  const { paneId: pane1 } = await newSession(session, cwd, { command: "sleep", args: ["120"], env: {} });
  try {
    assert.match(pane1, /^%\d+$/);

    const { paneId: pane2 } = await newPane(session, cwd, { command: "sleep", args: ["120"], env: {} }, { dir: "v" });
    assert.match(pane2, /^%\d+$/);
    assert.notEqual(pane1, pane2, "newPane returns a distinct pane id");

    const panes = await listPanes();
    assert.ok(panes.has(pane1) && panes.has(pane2), "both panes live");

    const killResult = await killPane(pane2);
    assert.equal(killResult.ok, true, killResult.stderr);

    const after = await listPanes();
    assert.ok(!after.has(pane2), "the killed pane is gone");
    assert.ok(after.has(pane1), "the sibling pane survives");
    assert.equal(await hasSession(session), true, "the session survives");
  } finally {
    await tmux(["kill-session", "-t", `=${session}`], { reject: false });
  }
});

// ---- hive split is retired -------------------------------------------------

test("hive split errors with a deprecation message pointing at fork / --substrate tmux", { timeout: 30_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-comb-split-"));
  const env = { HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  try {
    const split = await runCli(["split", "whatever"], env);
    assert.notEqual(split.code, 0, "hive split must fail");
    assert.match(split.stderr, /hive split is retired/);
    assert.match(split.stderr, /hive fork|--substrate tmux/);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
});

// ---- Pane pinning stays (hive here) ---------------------------------------

test("hive here --id resolves a solo bee by its own agentPaneId (pane pinning survives comb retirement)", { timeout: 30_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-comb-here-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-comb-cwd-"));
  const env = { HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const name = `hive-test-here-${process.pid}`;
  try {
    const spawn = await runCli(["spawn", "sh", "--name", name, "--cwd", cwd, "--no-wait", "--", "-i"], env);
    assert.equal(spawn.code, 0, spawn.stderr);
    const rec = await readRecord(storeRoot, name);
    assert.ok(rec);
    assert.equal(rec!.combId, rec!.tmuxTarget, "solo bee combId == tmuxTarget");
    const paneId = String(rec!.agentPaneId);
    const id = String(rec!.id ?? name);
    assert.match(paneId, /^%\d+$/);

    // Pane-pinned match via $TMUX_PANE.
    const byPane = await runCli(["here", "--id"], { ...env, TMUX: fakeTmuxEnv(), TMUX_PANE: paneId });
    assert.equal(byPane.code, 0, byPane.stderr);
    assert.equal(byPane.stdout.trim(), id, "resolves by agentPaneId");

    // Outside tmux → clean error.
    const outside = await runCli(["here", "--id"], { ...env, TMUX: "" });
    assert.notEqual(outside.code, 0);
    assert.match(outside.stderr, /not inside tmux/);
  } finally {
    await tmux(["kill-session", "-t", `=${name}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
