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

async function seedBee(store: string, name: string, overrides: Record<string, unknown> = {}): Promise<void> {
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
    ...overrides,
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

function hive(store: string, socket: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: store,
      HIVE_TMUX_SOCKET: socket,
      HIVE_NO_KEYCHAIN: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      ...extraEnv,
    },
  });
}

// Restore re-spawns a dead bee by resolving its agent ("claude" as seeded) and
// running it. claude is not installed in CI, so we override the resolver's
// command for that kind (HIVE_CLAUDE_CMD, honored by resolveAgent) to a harmless
// held shell. `sh -c 'sleep 120' --` keeps the tmux window alive AND absorbs any
// trailing resume args (resumeArgs → `--resume <id>`/`--continue`) as ignored
// positional params ($1, $2 …) of the script, so the --resume path stays
// hermetic too. This lets restore exercise the real reviveRecord path end-to-end
// (session re-created, record flipped to running) without a real agent binary.
const RESTORE_ENV = { HIVE_CLAUDE_CMD: "sh -c 'sleep 120' --" } as const;

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

test("W3: snapshot + restore rebuilds panes and re-spawns bee members after a reboot", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CL-fe";
    await seedBee(store, bee);
    await newSession(bee, "/tmp", { command: "sh", args: ["-c", "sleep 120"] });
    const root = store;

    // Build ws-fe: a pane member + a linked bee member.
    await hive(store, socket, ["workspace", "open", "fe", "--root", root, "--print"]);
    await hive(store, socket, ["workspace", "add-pane", "fe", "--cmd", "sleep 120", "--name", "shell"]);
    await hive(store, socket, ["workspace", "add", "fe", bee]);
    assert.equal(await hasSession("ws-fe"), true);

    // snapshot: record per-window geometry so restore can re-apply it.
    const snap = await hive(store, socket, ["workspace", "snapshot", "fe"]);
    assert.match(snap.stdout, /workspace-snapshot\tws-fe\t\d+/, "snapshot prints a window count");
    const layout = (await readWs(store, "fe")).layout as Array<{ windowName: string; layout: string }>;
    assert.ok(Array.isArray(layout) && layout.length >= 1, "layout snapshot persisted");
    for (const entry of layout) {
      assert.equal(typeof entry.windowName, "string");
      assert.match(entry.layout, /,/, "layout looks like a tmux window_layout string");
    }

    // Simulate a reboot: kill the whole tmux server. The socket is gone; the
    // next hive call starts a fresh server on the same pinned socket. The store
    // records (ws-fe + the bee) survive on disk.
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    assert.equal(await hasSession("ws-fe"), false, "ws-fe gone after kill-server");
    assert.equal(await hasSession(bee), false, "bee session gone after kill-server");

    // restore: rebuild ws-fe, recreate the pane, re-spawn the dead bee.
    const restored = await hive(store, socket, ["workspace", "restore", "fe"], RESTORE_ENV);
    assert.match(restored.stdout, /workspace-restored\tws-fe\t1\t1/, "restore reports 1 bee + 1 pane");

    assert.equal(await hasSession("ws-fe"), true, "ws-fe rebuilt");
    // The bee's own session is live again (reviveRecord re-created it).
    assert.equal(await hasSession(bee), true, "the dead bee member is re-spawned");
    // Its window is linked into ws-fe.
    const beeWindow = (await tmux(["display-message", "-p", "-t", `=${bee}:`, "#{window_id}"])).stdout.trim();
    assert.ok((await sessionWindowIds("ws-fe")).includes(beeWindow), "the re-spawned bee window is linked into ws-fe");

    // ws-fe has at least the pane window + the bee window (≥2 windows).
    assert.ok((await sessionWindowIds("ws-fe")).length >= 2, "ws-fe has the pane and bee windows");

    // The bee record is flipped back to running and re-stamped with workspaceId.
    const beeRecord = await readBee(store, bee);
    assert.equal(beeRecord.status, "running", "revived bee record is running again");
    assert.equal(beeRecord.workspaceId, "fe", "revived bee re-stamped with workspaceId=fe");
  });
});

test("W3 --resume: restore --resume re-spawns the bee via the resume path", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CL-rs";
    // A providerSessionId makes --resume take the `--resume <id>` arg path.
    await seedBee(store, bee, { providerSessionId: "sess-abc123" });
    await newSession(bee, "/tmp", { command: "sh", args: ["-c", "sleep 120"] });
    const root = store;

    await hive(store, socket, ["workspace", "open", "fe", "--root", root, "--print"]);
    await hive(store, socket, ["workspace", "add", "fe", bee]);

    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    assert.equal(await hasSession(bee), false, "bee gone after kill-server");

    await hive(store, socket, ["workspace", "restore", "fe", "--resume"], RESTORE_ENV);

    // The bee is live again and its persisted command reflects the resume path
    // (resumeArgs("claude", "sess-abc123") → `--resume sess-abc123`, appended to
    // the held shell so the args are inert but observable in the record).
    assert.equal(await hasSession(bee), true, "bee re-spawned on restore --resume");
    const beeRecord = await readBee(store, bee);
    assert.match(String(beeRecord.command), /--resume sess-abc123/, "restore --resume used the resume args");
    assert.equal(beeRecord.status, "running", "resumed bee record is running");
  });
});

test("W3 idempotency: restoring a workspace whose bee is already live does not double-spawn", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CL-idem";
    await seedBee(store, bee);
    await newSession(bee, "/tmp", { command: "sh", args: ["-c", "sleep 120"] });
    const root = store;

    await hive(store, socket, ["workspace", "open", "fe", "--root", root, "--print"]);
    await hive(store, socket, ["workspace", "add", "fe", bee]);

    // The bee is STILL live (no reboot). The record carries the original command.
    const before = await readBee(store, bee);
    const beforeWindows = (await sessionWindowIds("ws-fe")).length;

    // restore must NOT relaunch a live bee (PRD §13) — no second window/session.
    await hive(store, socket, ["workspace", "restore", "fe"], RESTORE_ENV);

    assert.equal(await hasSession(bee), true, "the live bee stays alive");
    const afterWindows = (await sessionWindowIds("ws-fe")).length;
    assert.equal(afterWindows, beforeWindows, "no extra window created for an already-live bee");

    const after = await readBee(store, bee);
    assert.equal(after.command, before.command, "live bee was not relaunched (command unchanged)");
    assert.equal(after.updatedAt, before.updatedAt, "live bee record not rewritten by reviveRecord");
  });
});

test("restore --all rebuilds every non-archived workspace after a reboot", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const root = store;
    // Two pane-only workspaces (no bees needed — exercises the sweep + pane path).
    await hive(store, socket, ["workspace", "open", "fe", "--root", root, "--print"]);
    await hive(store, socket, ["workspace", "add-pane", "fe", "--cmd", "sleep 120", "--name", "shell"]);
    await hive(store, socket, ["workspace", "open", "be", "--root", root, "--print"]);
    await hive(store, socket, ["workspace", "add-pane", "be", "--cmd", "sleep 120", "--name", "shell"]);

    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    assert.equal(await hasSession("ws-fe"), false);
    assert.equal(await hasSession("ws-be"), false);

    const out = await hive(store, socket, ["restore", "--all"], RESTORE_ENV);
    assert.match(out.stdout, /restore\tall\t2\t/, "restore --all reports both workspaces");
    assert.equal(await hasSession("ws-fe"), true, "ws-fe rebuilt by restore --all");
    assert.equal(await hasSession("ws-be"), true, "ws-be rebuilt by restore --all");
  });
});

test("restore without --all prints usage and does nothing", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    let err: (Error & { stderr?: string }) | undefined;
    try {
      await hive(store, socket, ["restore"]);
    } catch (e) {
      err = e as Error & { stderr?: string };
    }
    assert.ok(err, "hive restore (no --all) exits non-zero");
    assert.match(`${err?.stderr ?? ""}${err?.message ?? ""}`, /Usage: hive restore --all/, "prints the --all usage hint");
  });
});
