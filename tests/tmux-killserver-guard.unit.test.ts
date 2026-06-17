// The production safety net behind the "a bee nuked my tmux" incident: hive's
// own code must never `tmux kill-server` the ambient server. The guard refuses
// kill-server unless a throwaway socket is pinned (setTmuxSocket /
// $HIVE_TMUX_SOCKET). A human running `tmux kill-server` in their own shell
// never goes through this code path, so they keep full manual control.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

// Ensure no ambient socket leaks in from the runner's environment.
const savedEnvSocket = process.env.HIVE_TMUX_SOCKET;
delete process.env.HIVE_TMUX_SOCKET;
setTmuxSocket(undefined);

after(() => {
  setTmuxSocket(undefined);
  if (savedEnvSocket === undefined) delete process.env.HIVE_TMUX_SOCKET;
  else process.env.HIVE_TMUX_SOCKET = savedEnvSocket;
});

test("kill-server is refused when no throwaway socket is pinned", async () => {
  await assert.rejects(
    () => tmux(["kill-server"]),
    /refusing to run `tmux kill-server`/,
    "the guard must block kill-server against the ambient server",
  );
  // reject:false must not be an escape hatch — the guard still throws.
  await assert.rejects(
    () => tmux(["kill-server"], { reject: false }),
    /refusing to run `tmux kill-server`/,
  );
});

test("kill-server is permitted once a throwaway socket is pinned (and scoped to it)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-guard-utest-"));
  const socket = join(dir, "s.sock");
  try {
    setTmuxSocket(socket);
    // Passes the guard now; targets the throwaway socket (where no server runs),
    // so it returns a clean "no server" result rather than throwing the guard.
    const result = await tmux(["kill-server"], { reject: false });
    assert.equal(typeof result.ok, "boolean", "guard passed; got a real TmuxResult");
    assert.doesNotMatch(result.stderr, /refusing to run/, "guard did not fire with a socket pinned");
  } finally {
    setTmuxSocket(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
