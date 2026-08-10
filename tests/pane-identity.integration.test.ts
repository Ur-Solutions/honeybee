// Real-tmux proof of the partial-listing fallback: pin a bee to its pane, add a
// second pane so the session survives, kill the agent pane, and confirm live
// session evidence prevents a false crash. Private socket dir so the
// developer's server is untouched.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { hasSession, listPanes, newSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";
import { deriveState } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "hive-pane-itest-"));
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

function bee(paneId: string): SessionRecord {
  return {
    name: "CL.pane",
    agent: "claude",
    cwd: "/tmp",
    command: "sleep 120",
    tmuxTarget: "CL-pane",
    agentPaneId: paneId,
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z",
    status: "running",
  };
}

test("newSession returns the pane id; a live session prevents a false crash when that pane disappears", { timeout: 30_000 }, async () => {
  const cwd = process.env.TMUX_TMPDIR!;
  const { paneId } = await newSession("CL-pane", cwd, { command: "sleep", args: ["120"], env: {} });
  try {
    assert.match(paneId, /^%\d+$/, "newSession returns a real tmux pane id");
    assert.ok((await listPanes()).has(paneId), "the pinned pane is live");

    const rec = bee(paneId);
    assert.notEqual(deriveState(rec, { liveTargets: new Set(["CL-pane"]), livePanes: await listPanes() }).state, "dead");

    // Add a second pane so killing the agent pane does NOT take the session.
    await tmux(["split-window", "-d", "-t", "=CL-pane:", "-c", cwd]);
    await tmux(["kill-pane", "-t", paneId]);

    assert.equal(await hasSession("CL-pane"), true, "session survives (the split pane keeps it alive)");
    const panesAfter = await listPanes();
    assert.ok(!panesAfter.has(paneId), "the agent pane is gone");

    // A missing pane can be a partial listPanes result; session liveness gets
    // the final word before deriveState can stamp a false crash.
    assert.equal(deriveState(rec, { liveTargets: new Set(["CL-pane"]), livePanes: panesAfter }).state, "ready");
  } finally {
    await tmux(["kill-session", "-t", "=CL-pane"], { reject: false });
  }
});
