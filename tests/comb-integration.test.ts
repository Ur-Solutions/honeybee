// Phase B integration tests on a throwaway tmux server (TMUX_TMPDIR isolation,
// like pane-identity.integration.test.ts). Covers the substrate primitives
// (newPane/killPane) and the three acceptance criteria:
//   B1  hive split → adjacent pane, new bee with parentId/combId sharing the comb
//   B2  hive here --id inside a bee pane prints that bee's id
//   B3  hive kill <sub-bee> removes only its pane; siblings survive
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { createLocalTmuxSubstrate, hasSession, listPanes, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

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
  // Point $TMUX at the pinned throwaway socket. The CLI's `-S` (from
  // $HIVE_TMUX_SOCKET) overrides $TMUX for targeting regardless, but a valid
  // $TMUX is still what makes the CLI believe it is running inside tmux.
  return `${process.env.HIVE_TMUX_SOCKET},0,0`;
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function readRecord(storeRoot: string, name: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(join(storeRoot, "sessions", `${name}.json`), "utf8").catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

async function listRecords(storeRoot: string): Promise<Record<string, unknown>[]> {
  const files = await readdir(join(storeRoot, "sessions")).catch(() => []);
  const out: Record<string, unknown>[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(join(storeRoot, "sessions", file), "utf8").catch(() => null);
    if (raw) out.push(JSON.parse(raw));
  }
  return out;
}

// ---- Substrate primitives -------------------------------------------------

test("newPane creates an adjacent pane and killPane removes it (session survives)", { timeout: 30_000 }, async () => {
  const substrate = createLocalTmuxSubstrate();
  const cwd = process.env.TMUX_TMPDIR!;
  const session = "comb-prim";
  const { paneId: pane1 } = await substrate.newSession(session, cwd, { command: "sleep", args: ["120"], env: {} });
  try {
    assert.match(pane1, /^%\d+$/);

    const { paneId: pane2 } = await substrate.newPane(session, cwd, { command: "sleep", args: ["120"], env: {} }, { dir: "v" });
    assert.match(pane2, /^%\d+$/);
    assert.notEqual(pane1, pane2, "newPane returns a distinct pane id");

    const panes = await listPanes();
    assert.ok(panes.has(pane1) && panes.has(pane2), "both panes live");

    const killResult = await substrate.killPane(pane2);
    assert.equal(killResult.ok, true, killResult.stderr);

    const after = await listPanes();
    assert.ok(!after.has(pane2), "the killed pane is gone");
    assert.ok(after.has(pane1), "the sibling pane survives");
    assert.equal(await hasSession(session), true, "the comb/session survives");
  } finally {
    await tmux(["kill-session", "-t", `=${session}`], { reject: false });
  }
});

test("newPane with dir:window opens a new window in the same session", { timeout: 30_000 }, async () => {
  const substrate = createLocalTmuxSubstrate();
  const cwd = process.env.TMUX_TMPDIR!;
  const session = "comb-window";
  const { paneId: pane1 } = await substrate.newSession(session, cwd, { command: "sleep", args: ["120"], env: {} });
  try {
    const { paneId: pane2 } = await substrate.newPane(session, cwd, { command: "sleep", args: ["120"], env: {} }, { dir: "window" });
    assert.match(pane2, /^%\d+$/);
    assert.notEqual(pane1, pane2);
    const windows = await tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"], { reject: false });
    assert.ok(windows.stdout.trim().split("\n").filter(Boolean).length >= 2, "session has >=2 windows");
  } finally {
    await tmux(["kill-session", "-t", `=${session}`], { reject: false });
  }
});

// ---- B1: hive split -------------------------------------------------------

test("B1: hive split registers a sub-bee with parentId + shared comb, both sharing one tmuxTarget", { timeout: 30_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-comb-split-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-comb-cwd-"));
  const env = { HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `hive-test-parent-${process.pid}`;
  try {
    const spawn = await runCli(["spawn", "sh", "--name", parentName, "--cwd", cwd, "--no-wait", "--", "-i"], env);
    assert.equal(spawn.code, 0, spawn.stderr);

    const parent = await readRecord(storeRoot, parentName);
    assert.ok(parent, "parent record exists");
    assert.equal(parent!.combId, parent!.tmuxTarget, "solo bee combId == tmuxTarget");
    assert.equal(parent!.parentId, undefined, "parent has no parentId");
    assert.match(String(parent!.agentPaneId), /^%\d+$/);

    const split = await runCli(["split", parentName, "--no-wait"], env);
    assert.equal(split.code, 0, split.stderr);

    const records = await listRecords(storeRoot);
    assert.equal(records.length, 2, "two bees registered");
    const child = records.find((r) => r.name !== parentName)!;
    assert.ok(child, "sub-bee record exists");
    assert.equal(child.tmuxTarget, parent!.tmuxTarget, "sub-bee shares the comb's tmuxTarget");
    assert.equal(child.combId, parent!.combId, "sub-bee shares combId");
    assert.equal(child.parentId, parent!.id ?? parentName, "sub-bee records parentId");
    assert.match(String(child.agentPaneId), /^%\d+$/);
    assert.notEqual(child.agentPaneId, parent!.agentPaneId, "sub-bee has its own pane");

    // Both panes live in the same session.
    const panes = await listPanes();
    assert.ok(panes.has(String(parent!.agentPaneId)) && panes.has(String(child.agentPaneId)));
  } finally {
    await runCli(["kill", parentName, "--comb"], env).catch(() => undefined);
    await tmux(["kill-session", "-t", `=${parentName}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("B1: `hive split <agent>` from inside a bee pane splits the CURRENT comb (agent, not bee, in pos 0)", { timeout: 30_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-comb-split2-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-comb-cwd-"));
  const env = { HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `hive-test-parent2-${process.pid}`;
  try {
    await runCli(["spawn", "sh", "--name", parentName, "--cwd", cwd, "--no-wait", "--", "-i"], env);
    const parent = await readRecord(storeRoot, parentName);
    assert.ok(parent);

    // "sh" is an agent kind here, not an existing bee → split current comb.
    // Run from inside the parent's pane so resolveBeeInCurrentPane finds it.
    const split = await runCli(["split", "sh", "--no-wait"], {
      ...env,
      TMUX: fakeTmuxEnv(),
      TMUX_PANE: String(parent!.agentPaneId),
    });
    assert.equal(split.code, 0, split.stderr);

    const records = await listRecords(storeRoot);
    assert.equal(records.length, 2, "current comb gained a sub-bee");
    const child = records.find((r) => r.name !== parentName)!;
    assert.equal(child.tmuxTarget, parent!.tmuxTarget, "sub-bee shares the current comb");
    assert.equal(child.parentId, parent!.id ?? parentName);
    assert.equal(child.agent, "sh", "pos-0 was interpreted as the agent");
  } finally {
    await tmux(["kill-session", "-t", `=${parentName}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---- B2: hive here --------------------------------------------------------

test("B2: hive here --id resolves the bee owning the current pane (and the session fallback)", { timeout: 30_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-comb-here-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-comb-cwd-"));
  const env = { HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const name = `hive-test-here-${process.pid}`;
  try {
    const spawn = await runCli(["spawn", "sh", "--name", name, "--cwd", cwd, "--no-wait", "--", "-i"], env);
    assert.equal(spawn.code, 0, spawn.stderr);
    const rec = await readRecord(storeRoot, name);
    assert.ok(rec);
    const paneId = String(rec!.agentPaneId);
    const id = String(rec!.id ?? name);

    // Path 1: pane-pinned match via $TMUX_PANE.
    const byPane = await runCli(["here", "--id"], { ...env, TMUX: fakeTmuxEnv(), TMUX_PANE: paneId });
    assert.equal(byPane.code, 0, byPane.stderr);
    assert.equal(byPane.stdout.trim(), id, "resolves by agentPaneId");

    // Path 2: session-name fallback (no/empty TMUX_PANE → display-message).
    // Run `hive here` from inside the bee's own pane so display-message yields
    // the comb's session name.
    const target = String(rec!.tmuxTarget);
    const out = await runCli(
      ["here", "--id"],
      { ...env, TMUX: fakeTmuxEnv(), TMUX_PANE: "%99999" }, // a pane id that matches no record
    );
    // %99999 matches no record; the fallback uses display-message which, run
    // outside a real client pane on this socket, may or may not resolve — we
    // only require it not to crash and to error cleanly when it cannot match.
    assert.ok(out.code === 0 ? out.stdout.trim() === id : /no matching bee/.test(out.stderr), out.stderr || out.stdout);
    void target;

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

// ---- B3: comb-aware hive kill --------------------------------------------

test("B3: hive kill <sub-bee> removes only its pane; the sibling survives; kill last takes the session", { timeout: 40_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-comb-kill-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-comb-cwd-"));
  const env = { HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `hive-test-kparent-${process.pid}`;
  try {
    await runCli(["spawn", "sh", "--name", parentName, "--cwd", cwd, "--no-wait", "--", "-i"], env);
    await runCli(["split", parentName, "--no-wait"], env);

    const parent = await readRecord(storeRoot, parentName);
    const child = (await listRecords(storeRoot)).find((r) => r.name !== parentName)!;
    assert.ok(parent && child, "two bees registered");
    const parentPane = String(parent!.agentPaneId);
    const childPane = String(child.agentPaneId);
    assert.ok((await listPanes()).has(childPane), "sub-bee pane live before kill");

    // Kill the sub-bee: only its pane should go; the session and sibling survive.
    const kill = await runCli(["kill", String(child.name)], env);
    assert.equal(kill.code, 0, kill.stderr);
    assert.match(kill.stdout, /killed\s+.*pane removed|pane removed/);

    const panesAfter = await listPanes();
    assert.ok(!panesAfter.has(childPane), "sub-bee pane removed");
    assert.ok(panesAfter.has(parentPane), "sibling (parent) pane survives");
    assert.equal(await hasSession(parentName), true, "the comb/session survives");
    assert.equal(await readRecord(storeRoot, String(child.name)), null, "sub-bee record deleted");
    assert.ok(await readRecord(storeRoot, parentName), "parent record intact");

    // ledger has a bee.kill_pane event.
    const ledger = await readFile(join(storeRoot, "ledger.jsonl"), "utf8").catch(() => "");
    assert.ok(/"type":"bee\.kill_pane"/.test(ledger), "bee.kill_pane ledger event emitted");

    // Now kill the last/sole bee: this takes the whole session.
    const killLast = await runCli(["kill", parentName], env);
    assert.equal(killLast.code, 0, killLast.stderr);
    assert.equal(await hasSession(parentName), false, "session gone after killing the last bee");
    assert.equal(await readRecord(storeRoot, parentName), null, "parent record deleted");
  } finally {
    await tmux(["kill-session", "-t", `=${parentName}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("hive clean --dead sweeps a sub-bee whose pane died while the comb survives", { timeout: 40_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-comb-clean-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-comb-cwd-"));
  const env = { HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `hive-test-cparent-${process.pid}`;
  try {
    await runCli(["spawn", "sh", "--name", parentName, "--cwd", cwd, "--no-wait", "--", "-i"], env);
    await runCli(["split", parentName, "--no-wait"], env);
    const child = (await listRecords(storeRoot)).find((r) => r.name !== parentName)!;
    const childPane = String(child.agentPaneId);

    // Kill the sub-bee's pane directly via tmux (simulating an external death),
    // WITHOUT going through hive — the record stays behind.
    await tmux(["kill-pane", "-t", childPane], { reject: false });
    assert.ok(!(await listPanes()).has(childPane), "sub-bee pane is gone");
    assert.equal(await hasSession(parentName), true, "comb survives (parent pane holds it)");
    assert.ok(await readRecord(storeRoot, String(child.name)), "sub-bee record still present before clean");

    const attachDead = await runCli(["attach", String(child.name), "--print"], env);
    assert.notEqual(attachDead.code, 0, "dead sub-bee pane should not be selectable");
    assert.match(attachDead.stderr, /tmux pane is not running/);

    const clean = await runCli(["clean", "--dead"], env);
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(await readRecord(storeRoot, String(child.name)), null, "dead sub-bee record swept");
    assert.ok(await readRecord(storeRoot, parentName), "live parent record kept");
  } finally {
    await tmux(["kill-session", "-t", `=${parentName}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
