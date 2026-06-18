import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { toggleBeesSidebar } from "../src/beesSidebar.js";
import { setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

const savedTmpdir = process.env.TMUX_TMPDIR;
const savedSocket = process.env.HIVE_TMUX_SOCKET;
const testTmpdir = mkdtempSync(join(tmpdir(), "hive-sidebar-test-"));

process.env.TMUX_TMPDIR = testTmpdir;
process.env.HIVE_TMUX_SOCKET = join(process.env.TMUX_TMPDIR, "s.sock");
setTmuxSocket(process.env.HIVE_TMUX_SOCKET);

after(async () => {
  await tmux(["kill-server"], { reject: false });
  setTmuxSocket(undefined);
  if (savedSocket === undefined) delete process.env.HIVE_TMUX_SOCKET;
  else process.env.HIVE_TMUX_SOCKET = savedSocket;
  if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = savedTmpdir;
  rmSync(testTmpdir, { recursive: true, force: true });
});

test("bees sidebar opens as a root-left split and focuses the sidebar pane", { timeout: 30_000 }, async () => {
  const session = "sidebar-root";
  await tmux(["new-session", "-d", "-s", session, "-x", "120", "-y", "40", "sleep 120"]);
  const windowTarget = (await tmux(["display-message", "-p", "-t", `=${session}:`, "#{session_name}:#{window_index}"])).stdout.trim();
  const rightPane = (await tmux(["split-window", "-h", "-P", "-F", "#{pane_id}", "-t", windowTarget, "sleep 120"])).stdout.trim();
  await tmux(["select-pane", "-t", rightPane]);

  const savedTmux = process.env.TMUX;
  const savedSidebarCommand = process.env.HIVE_BEES_SIDEBAR_COMMAND;
  process.env.TMUX = `${process.env.HIVE_TMUX_SOCKET},0,0`;
  process.env.HIVE_BEES_SIDEBAR_COMMAND = "sleep 120";
  try {
    assert.equal(await toggleBeesSidebar(28), "opened");
  } finally {
    if (savedSidebarCommand === undefined) delete process.env.HIVE_BEES_SIDEBAR_COMMAND;
    else process.env.HIVE_BEES_SIDEBAR_COMMAND = savedSidebarCommand;
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
  }

  const rows = (await tmux(["list-panes", "-t", windowTarget, "-F", "#{pane_id}\t#{pane_left}\t#{pane_width}\t#{pane_active}"])).stdout
    .split("\n")
    .map((line) => line.trim().split("\t"))
    .filter((parts) => parts.length === 4);
  const nav = rows.find(([, left, width]) => left === "0" && width === "28");
  const right = rows.find(([paneId]) => paneId === rightPane);
  assert.ok(nav, "nav pane should be created");
  assert.deepEqual(nav?.slice(1, 3), ["0", "28"]);
  assert.equal(nav?.[3], "1", "opening the sidebar should focus the sidebar pane");
  assert.equal(right?.[3], "0", "original active pane should no longer be focused");

  await tmux(["kill-session", "-t", `=${session}`], { reject: false });
});

test("bees sidebar toggle is quiet for tmux hotkeys", { timeout: 30_000 }, async () => {
  const session = "sidebar-quiet";
  await tmux(["new-session", "-d", "-s", session, "-x", "120", "-y", "40", "sleep 120"]);
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "bees", "--toggle-sidebar", "--width", "28"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMUX: `${process.env.HIVE_TMUX_SOCKET},0,0`,
        HIVE_BEES_SIDEBAR_COMMAND: "sleep 120",
        NO_COLOR: "1",
      },
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await tmux(["kill-session", "-t", `=${session}`], { reject: false });
  }
});
