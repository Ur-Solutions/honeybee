// Real-tmux roundtrip for the @hive_* user-option plumbing, on a private
// socket directory so the developer's live server is never touched.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { listSessionStates, setTmuxSocket, setUserOptions, setWindowOptions, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "hive-state-itest-"));
delete process.env.TMUX;
// Pin a throwaway socket: scopes every tmux call here with `-S` and is what
// allows kill-server past the safety guard (never the developer's real server).
process.env.HIVE_TMUX_SOCKET = join(process.env.TMUX_TMPDIR, "s.sock");
setTmuxSocket(process.env.HIVE_TMUX_SOCKET);

after(async () => {
  await tmux(["kill-server"], { reject: false });
  setTmuxSocket(undefined);
  delete process.env.HIVE_TMUX_SOCKET;
  rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
});

test("setUserOptions writes exactly and listSessionStates reads back", { timeout: 30_000 }, async () => {
  await tmux(["new-session", "-d", "-s", "CL-abcd", "sleep 30"]);
  try {
    await setUserOptions("CL-abcd", { "@hive_state": "working", "@hive_id": "CL.abcd" });
    const states = await listSessionStates();
    assert.equal(states.get("CL-abcd"), "working");

    await setUserOptions("CL-abcd", { "@hive_separator": ";" });
    const separator = (await tmux(["show-options", "-qv", "-t", "=CL-abcd:", "@hive_separator"])).stdout.trimEnd();
    assert.equal(separator, ";");

    await setWindowOptions("CL-abcd", { "@hive_window_separator": ";" } as unknown as Parameters<typeof setWindowOptions>[1]);
    const windowSeparator = (await tmux(["show-options", "-wqv", "-t", "=CL-abcd:", "@hive_window_separator"])).stdout.trimEnd();
    assert.equal(windowSeparator, ";");

    // Exact match: a write aimed at a vanished shorter name must not
    // prefix-match onto CL-abcd (set-option without "=" would).
    await setUserOptions("CL-abc", { "@hive_state": "failed" });
    const after = await listSessionStates();
    assert.equal(after.get("CL-abcd"), "working");

    // Missing sessions and a dead server stay silent (best-effort contract).
    await setUserOptions("no-such-session", { "@hive_state": "done" });
  } finally {
    await tmux(["kill-session", "-t", "=CL-abcd"], { reject: false });
  }
});

test("listSessionStates works under an env -i-style environment with no locale", { timeout: 30_000 }, async () => {
  const socketDir = mkdtempSync(join(tmpdir(), "hive-state-no-locale-itest-"));
  const socket = join(socketDir, "s.sock");
  const script = `
    import assert from "node:assert/strict";
    import { listSessionStates, setUserOptions, tmux } from "./src/substrates/local-tmux.ts";

    assert.equal(process.env.LANG, undefined);
    assert.equal(process.env.LC_ALL, undefined);
    try {
      await tmux(["new-session", "-d", "-s", "CL-no-locale", "sleep 30"]);
      await setUserOptions("CL-no-locale", { "@hive_state": "idle_with_output" });
      const states = await listSessionStates();
      assert.equal(states.get("CL-no-locale"), "idle_with_output");
    } finally {
      await tmux(["kill-server"], { reject: false });
    }
  `;

  try {
    // Supplying an explicit environment replaces the parent's environment,
    // equivalent to `env -i` plus only the values needed to find node/tmux and
    // isolate the test server. In particular, no locale variables are present.
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        HIVE_TMUX_SOCKET: socket,
        TMUX_TMPDIR: socketDir,
      },
      timeout: 30_000,
    });
  } finally {
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test("renameWindow renames the bee's window exactly", { timeout: 30_000 }, async () => {
  const { renameWindow } = await import("../src/substrates/local-tmux.js");
  await tmux(["new-session", "-d", "-s", "CL-title", "sleep 30"]);
  try {
    await renameWindow("CL-title", "fix the flaky auth test");
    const name = (await tmux(["display-message", "-p", "-t", "=CL-title:", "#{window_name}"])).stdout.trim();
    assert.equal(name, "fix the flaky auth test");
    // Missing session: silent no-op.
    await renameWindow("CL-nope", "x");
  } finally {
    await tmux(["kill-session", "-t", "=CL-title"], { reject: false });
  }
});
