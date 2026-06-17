// Integration coverage for the Phase-1 keybinding layer (KEYBINDINGS_PRD):
//   - spawn-picker --frame / --flow: one-name-per-line; empty when no frames.
//   - keys print --tmux: byte-identical to docs/honeybee.tmux.conf.
//   - keys check: runs against a PRIVATE tmux socket and reports present/absent/
//     collision without throwing on a clean server.
//   - workspace here: prints <name> in a ws-<name> session; prints workspaceId
//     for a bee with one.
//
// We drive the real CLI as a subprocess (HIVE_STORE_ROOT temp + HIVE_TMUX_SOCKET
// for the private tmux server), mirroring the cli-workspace rig.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { newSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type HiveResult = { stdout: string; stderr: string; code: number };

// execFile rejects on non-zero exit; we want to assert on stdout/stderr/code
// for the dim-stderr / exit-code contracts, so capture rather than throw.
function hive(store: string, args: string[], extraEnv: Record<string, string> = {}, socket?: string): Promise<HiveResult> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: store,
      ...(socket ? { HIVE_TMUX_SOCKET: socket } : {}),
      HIVE_NO_KEYCHAIN: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      ...extraEnv,
    },
  }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: typeof error.code === "number" ? error.code : 1,
    }),
  );
}

async function seedFrame(store: string, name: string): Promise<void> {
  const dir = join(store, "frames");
  await mkdir(dir, { recursive: true });
  const frame = {
    name,
    description: `frame ${name}`,
    castes: [{ name: "worker", bee: "claude", count: 1 }],
  };
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(frame, null, 2)}\n`);
}

async function seedBee(store: string, name: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const dir = join(store, "sessions");
  await mkdir(dir, { recursive: true });
  const now = "2026-06-17T00:00:00.000Z";
  await writeFile(
    join(dir, `${name}.json`),
    `${JSON.stringify(
      {
        name,
        agent: "claude",
        cwd: "/tmp",
        command: "sleep 120",
        tmuxTarget: name,
        id: name,
        createdAt: now,
        updatedAt: now,
        status: "running",
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

async function withStore(fn: (store: string) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "hive-keys-store-"));
  try {
    await fn(store);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
}

async function withRig(fn: (ctx: { store: string; socket: string }) => Promise<void>): Promise<void> {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-keys-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-keys-store-"));
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

test("spawn-picker --frame lists one frame name per line; empty when none", async () => {
  await withStore(async (store) => {
    // No frames yet → empty stdout, exit 0 (the binding's `xargs -r` no-ops).
    const empty = await hive(store, ["spawn-picker", "--frame"]);
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout.trim(), "", "no frames → empty stdout");

    await seedFrame(store, "alpha");
    await seedFrame(store, "beta");
    const out = await hive(store, ["spawn-picker", "--frame"]);
    assert.equal(out.code, 0);
    const names = out.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(names.sort(), ["alpha", "beta"], "one frame name per line");
  });
});

test("spawn-picker --flow lists one flow name per line (built-in loop flow)", async () => {
  await withStore(async (store) => {
    const out = await hive(store, ["spawn-picker", "--flow"]);
    assert.equal(out.code, 0);
    const names = out.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    // The built-in `loop` flow is always present even with no on-disk flows.
    assert.ok(names.includes("loop"), `--flow lists the built-in loop flow (got ${JSON.stringify(names)})`);
    // Every line is a bare name (the machine token), no spaces.
    for (const name of names) assert.ok(!/\s/.test(name), `flow name has no spaces: ${name}`);
  });
});

test("spawn-picker --here does not change the printed list", async () => {
  await withStore(async (store) => {
    await seedFrame(store, "gamma");
    const withHere = await hive(store, ["spawn-picker", "--frame", "--here"]);
    const without = await hive(store, ["spawn-picker", "--frame"]);
    assert.equal(withHere.stdout, without.stdout, "--here is a passthrough hint, not a filter");
  });
});

test("keys print --tmux is byte-identical to docs/honeybee.tmux.conf", async () => {
  await withStore(async (store) => {
    const printed = await hive(store, ["keys", "print", "--tmux"]);
    assert.equal(printed.code, 0);
    const onDisk = await readFile(join(process.cwd(), "docs", "honeybee.tmux.conf"), "utf8");
    assert.equal(printed.stdout, onDisk, "`hive keys print --tmux` drifted from the shipped doc");
  });
});

test("keys path prints the absolute path of docs/honeybee.tmux.conf", async () => {
  await withStore(async (store) => {
    const out = await hive(store, ["keys", "path"]);
    assert.equal(out.code, 0);
    assert.match(out.stdout.trim(), /\/docs\/honeybee\.tmux\.conf$/, "ends with the doc path");
    assert.ok(out.stdout.trim().startsWith("/"), "is absolute");
  });
});

test("keys check runs clean against a private tmux server: absent binds, exit 0", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    // Start a server on the private socket so list-keys has a server to read.
    await tmux(["new-session", "-d", "-s", "probe", "sleep 120"], { reject: false });
    const out = await hive(store, ["keys", "check"], {}, socket);
    assert.equal(out.code, 0, "clean check exits 0 (hive reachable, no hard failures)");
    // None of our recommended binds are bound on the fresh server.
    assert.match(out.stdout, /bind\tabsent\tM-b/, "M-b reported absent");
    assert.match(out.stdout, /check\tsubstrate\tlocal-tmux/, "substrate reported local-tmux");
    assert.match(out.stdout, /check\tlimitation\twezterm-alt-cmd-layer-not-checked/, "limitation surfaced");
  });
});

test("keys check flags a tmux-layer collision on a recommended key", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    await tmux(["new-session", "-d", "-s", "probe", "sleep 120"], { reject: false });
    // Bind M-b to something that is NOT `hive spawn-picker` → a collision.
    await tmux(["bind-key", "-n", "M-b", "display-message", "hello"], { reject: false });
    const out = await hive(store, ["keys", "check"], {}, socket);
    assert.equal(out.code, 0, "a collision is a warning, not a hard failure");
    assert.match(out.stdout, /bind\tcollision\tM-b/, "M-b collision reported");
  });
});

test("keys check reports a recommended bind as present when wired to its verb", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    await tmux(["new-session", "-d", "-s", "probe", "sleep 120"], { reject: false });
    // Bind M-b to a binding whose command dispatches `hive spawn-picker` (the
    // wired-detection substring). The popup wrapper is irrelevant to detection.
    await tmux(["bind-key", "-n", "M-b", "display-popup", "-E", "hive spawn-picker --frame | fzf"], { reject: false });
    const out = await hive(store, ["keys", "check"], {}, socket);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /bind\tpresent\tM-b\tspawn-picker/, "M-b reported present");
  });
});

test("workspace here prints <name> inside a ws-<name> session", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    await tmux(["new-session", "-d", "-s", "ws-frontend", "sleep 120"], { reject: false });
    // Resolve $TMUX_PANE for the ws session's pane so the in-process resolution
    // path runs against the private socket. We invoke from the session by
    // exporting the tmux env the popup would inherit.
    const env = (await tmux(["list-panes", "-t", "ws-frontend", "-F", "#{pane_id}"], { reject: false })).stdout.trim();
    const tmuxEnv = (await tmux(["show-environment", "-t", "ws-frontend", "TMUX"], { reject: false })).stdout.trim();
    const out = await hive(store, ["workspace", "here"], {
      TMUX: tmuxEnv.startsWith("TMUX=") ? tmuxEnv.slice("TMUX=".length) : `${socket},0,0`,
      TMUX_PANE: env.split("\n")[0] ?? "%0",
    }, socket);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), "frontend", "ws-frontend → frontend");
  });
});

test("workspace here resolves a grouped ws-<name>-N client back to <name>", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    // A real workspace record named `fe` (so loadWorkspace("fe") hits) + ws-fe.
    await hive(store, ["workspace", "open", "fe", "--root", store, "--print"], {}, socket);
    // A grouped secondary client ws-fe-2 (what `workspace open --new-client` makes).
    await tmux(["new-session", "-d", "-t", "ws-fe", "-s", "ws-fe-2"], { reject: false });
    const tmuxEnv = (await tmux(["show-environment", "-t", "ws-fe-2", "TMUX"], { reject: false })).stdout.trim();
    const pane = (await tmux(["list-panes", "-t", "ws-fe-2", "-F", "#{pane_id}"], { reject: false })).stdout.trim().split("\n")[0] ?? "%0";
    const out = await hive(store, ["workspace", "here"], {
      TMUX: tmuxEnv.startsWith("TMUX=") ? tmuxEnv.slice("TMUX=".length) : `${socket},0,0`,
      TMUX_PANE: pane,
    }, socket);
    assert.equal(out.code, 0, out.stderr);
    // The M-R rename chord needs the record name `fe`, not the grouped `fe-2`.
    assert.equal(out.stdout.trim(), "fe", "grouped ws-fe-2 → fe (the workspace record)");
  });
});

test("rename --here renames the current bee (title not mistaken for a selector)", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CL-rn";
    await seedBee(store, bee);
    await newSession(bee, "/tmp", { command: "sh", args: ["-c", "sleep 120"] });
    const paneId = (await tmux(["list-panes", "-t", bee, "-F", "#{pane_id}"], { reject: false })).stdout.trim().split("\n")[0] ?? "%0";
    await seedBee(store, bee, { agentPaneId: paneId });

    // A multi-word title that, passed raw, would land in args[0] and be resolved
    // as a (nonexistent) selector. The wrapper must inject the bee id instead.
    const out = await hive(store, ["rename", "--here", "my", "new", "title"], {
      TMUX: `${socket},0,0`,
      TMUX_PANE: paneId,
    }, socket);
    assert.equal(out.code, 0, out.stderr);
    const record = JSON.parse(await readFile(join(store, "sessions", `${bee}.json`), "utf8")) as { title?: string; titleSource?: string };
    assert.equal(record.title, "my new title", "title set from the bare positionals");
    assert.equal(record.titleSource, "user", "user-sourced title");
  });
});

test("workspace here prints workspaceId for a bee in the current pane", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CL-wsh";
    await seedBee(store, bee, { workspaceId: "be" });
    await newSession(bee, "/tmp", { command: "sh", args: ["-c", "sleep 120"] });
    const paneId = (await tmux(["list-panes", "-t", bee, "-F", "#{pane_id}"], { reject: false })).stdout.trim().split("\n")[0] ?? "%0";
    // Update the seeded record with the real pane id so resolveBeeInCurrentPane
    // matches by agentPaneId.
    await seedBee(store, bee, { workspaceId: "be", agentPaneId: paneId });
    const out = await hive(store, ["workspace", "here"], {
      TMUX: `${socket},0,0`,
      TMUX_PANE: paneId,
    }, socket);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), "be", "bee.workspaceId printed");
  });
});
