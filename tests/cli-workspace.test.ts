// Integration coverage for `hive workspace` (WORKSPACES_AND_QUESTS_PRD Phase 1,
// acceptance W1/W2/W4) against a PRIVATE throwaway tmux socket + a temp store.
// We drive the real CLI as a subprocess (with HIVE_STORE_ROOT + HIVE_TMUX_SOCKET
// so the child's tmux calls hit our private socket) and use the in-process tmux
// helper (pinned to the same socket) to seed live "bees" and assert tmux state.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { hasSession, newSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function seedBee(store: string, name: string): Promise<void> {
  const sessionsDir = join(store, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const now = "2026-06-17T00:00:00.000Z";
  const record = {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "sleep 120",
    tmuxTarget: name,
    id: name,
    createdAt: now,
    updatedAt: now,
    status: "running" as const,
  };
  await writeFile(join(sessionsDir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function readBee(store: string, name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(store, "sessions", `${name}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readWs(store: string, name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(store, "workspaces", `${name}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function hive(store: string, socket: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: store,
      HIVE_TMUX_SOCKET: socket,
      HIVE_NO_KEYCHAIN: "1",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });
}

async function sessionWindowIds(session: string): Promise<string[]> {
  const r = await tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"], { reject: false });
  return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

async function withRig(fn: (ctx: { store: string; socket: string }) => Promise<void>): Promise<void> {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-ws-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-ws-store-"));
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

test("W1: open creates ws-<name>, add links a bee + sets workspaceId, ws: resolves it", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CL-w1";
    await seedBee(store, bee);
    await newSession(bee, "/tmp", { command: "sh", args: ["-c", "sleep 120"] });
    const root = store; // any real dir
    const canonicalRoot = realpathSync(root); // --root is realpath-canonicalized

    // open: creates ws-fe, persists rootDir, sets detach-on-destroy off.
    const opened = await hive(store, socket, ["workspace", "open", "fe", "--root", root, "--print"]);
    assert.match(opened.stdout, /switch-client|attach-session/, "open prints an enter command");
    assert.equal(await hasSession("ws-fe"), true, "ws-fe session exists");
    const dod = (await tmux(["show-options", "-t", "ws-fe", "detach-on-destroy"], { reject: false })).stdout;
    assert.match(dod, /detach-on-destroy off/, "ws-fe is detach-on-destroy off");
    const wsRecord = await readWs(store, "fe");
    assert.equal(wsRecord.rootDir, canonicalRoot, "rootDir persisted on first open");

    // add: links the bee window into ws-fe and stamps workspaceId.
    await hive(store, socket, ["workspace", "add", "fe", bee]);
    const beeWindow = (await tmux(["display-message", "-p", "-t", `=${bee}:`, "#{window_id}"])).stdout.trim();
    const wsWindows = await sessionWindowIds("ws-fe");
    assert.ok(wsWindows.includes(beeWindow), "the bee's window is linked into ws-fe");

    const beeRecord = await readBee(store, bee);
    assert.equal(beeRecord.workspaceId, "fe", "bee record carries workspaceId=fe");
    const members = (await readWs(store, "fe")).members as Array<{ kind: string; beeId?: string }>;
    assert.deepEqual(members, [{ kind: "bee", beeId: bee }], "bee membership persisted");

    // ws:fe selector now resolves to the bee (the derived workspace: tag lit up).
    const rows = JSON.parse((await hive(store, socket, ["list", "ws:fe", "--json"])).stdout) as Array<{ name: string }>;
    assert.deepEqual(rows.map((r) => r.name), [bee], "ws:fe selector resolves the linked bee");
  });
});

test("W2: add-pane adds a window at rootDir and persists the pane member", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const root = store;
    await hive(store, socket, ["workspace", "open", "be", "--root", root, "--print"]);
    const before = (await sessionWindowIds("ws-be")).length;

    await hive(store, socket, ["workspace", "add-pane", "be", "--cmd", "sleep 120", "--name", "shell"]);
    const after = await sessionWindowIds("ws-be");
    assert.equal(after.length, before + 1, "add-pane adds exactly one window");

    const members = (await readWs(store, "be")).members as Array<{ kind: string; name?: string; command?: string }>;
    assert.deepEqual(members, [{ kind: "pane", name: "shell", command: "sleep 120" }], "pane member persisted");
  });
});

test("W4: ws-* never appears in bee list/selectors; close leaves the bee alive", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CL-w4";
    await seedBee(store, bee);
    await newSession(bee, "/tmp", { command: "sh", args: ["-c", "sleep 120"] });
    const root = store;

    await hive(store, socket, ["workspace", "open", "fe", "--root", root, "--print"]);
    await hive(store, socket, ["workspace", "add", "fe", bee]);

    // ws-fe is not a bee: it never appears in `hive list`.
    const list = JSON.parse((await hive(store, socket, ["list", "--json"])).stdout) as Array<{ name: string }>;
    assert.ok(!list.some((r) => r.name === "ws-fe"), "ws-fe is not listed as a bee");
    assert.ok(list.some((r) => r.name === bee), "the real bee is listed");

    // A grouped --new-client session shares the windows.
    await hive(store, socket, ["workspace", "open", "fe", "--new-client", "--print"]);
    assert.equal(await hasSession("ws-fe-2"), true, "grouped ws-fe-2 exists");

    // close: tears down ws-fe AND ws-fe-2, but the bee stays alive (the view invariant).
    const closed = await hive(store, socket, ["workspace", "close", "fe"]);
    assert.match(closed.stdout, /workspace-closed|closed/);
    assert.equal(await hasSession("ws-fe"), false, "ws-fe gone after close");
    assert.equal(await hasSession("ws-fe-2"), false, "grouped ws-fe-2 swept");
    assert.equal(await hasSession(bee), true, "the bee survives workspace close");

    // The record is preserved (close keeps it).
    const ws = await readWs(store, "fe");
    assert.equal(ws.name, "fe");
  });
});

test("W4b: close ABORTS on an orphaned bee (home gone) and never kills its window", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CL-w4b";
    await seedBee(store, bee);
    await newSession(bee, "/tmp", { command: "sh", args: ["-c", "sleep 120"] });
    const root = store;

    await hive(store, socket, ["workspace", "open", "fe", "--root", root, "--print"]);
    await hive(store, socket, ["workspace", "add", "fe", bee]);
    const beeWindow = (await tmux(["display-message", "-p", "-t", `=${bee}:`, "#{window_id}"])).stdout.trim();
    assert.ok((await sessionWindowIds("ws-fe")).includes(beeWindow), "bee window linked into ws-fe");

    // Orphan the bee: kill its HOME session directly (what `hive kill` does). The
    // window survives, now linked ONLY into ws-fe — the last link. This is the
    // exact case the old "no link outside the group ⇒ ours" heuristic would have
    // kill-window'd, silently killing a still-running bee on `workspace close`.
    await tmux(["kill-session", "-t", `=${bee}`], { reject: false });
    assert.equal(await hasSession(bee), false, "bee home session is gone");
    assert.ok((await sessionWindowIds("ws-fe")).includes(beeWindow), "orphaned bee window still alive in ws-fe");

    // close must ABORT (non-zero exit) rather than destroy the orphaned bee window.
    let err: (Error & { stderr?: string }) | undefined;
    try {
      await hive(store, socket, ["workspace", "close", "fe"]);
    } catch (e) {
      err = e as Error & { stderr?: string };
    }
    assert.ok(err, "workspace close fails when a member bee is orphaned");
    assert.match(
      `${err?.stderr ?? ""}${err?.message ?? ""}`,
      /Refusing to close|last link|re-home/,
      "abort message explains the orphaned bee",
    );

    // The workspace is left FULLY intact and the orphaned bee window survives.
    assert.equal(await hasSession("ws-fe"), true, "ws-fe still alive after the aborted close");
    assert.ok(
      (await sessionWindowIds("ws-fe")).includes(beeWindow),
      "the orphaned bee window survives the aborted close (never kill-window'd)",
    );
  });
});

test("rename moves the record + live session; archive flips the flag", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const root = store;
    await hive(store, socket, ["workspace", "open", "fe", "--root", root, "--print"]);
    assert.equal(await hasSession("ws-fe"), true);

    await hive(store, socket, ["workspace", "rename", "fe", "frontend"]);
    assert.equal(await hasSession("ws-fe"), false, "old live session renamed away");
    assert.equal(await hasSession("ws-frontend"), true, "live session renamed");
    assert.equal((await readWs(store, "frontend")).name, "frontend");
    await assert.rejects(readWs(store, "fe"), /ENOENT/);

    await hive(store, socket, ["workspace", "archive", "frontend"]);
    const archived = await readWs(store, "frontend");
    assert.equal(archived.archived, true, "archive flips the flag");

    // archived hidden from default list, shown with --archived.
    const def = (await hive(store, socket, ["workspace", "list"])).stdout;
    assert.doesNotMatch(def, /frontend/, "archived workspace hidden by default");
    const all = (await hive(store, socket, ["workspace", "list", "--archived"])).stdout;
    assert.match(all, /frontend/, "archived workspace shown with --archived");
  });
});
