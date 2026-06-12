// Real-tmux roundtrip for the @hive_* user-option plumbing, on a private
// socket directory so the developer's live server is never touched.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listSessionStates, setUserOptions, tmux } from "../src/substrates/local-tmux.js";

process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "hive-state-itest-"));
delete process.env.TMUX;

after(async () => {
  await tmux(["kill-server"], { reject: false });
  rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
});

test("setUserOptions writes exactly and listSessionStates reads back", { timeout: 30_000 }, async () => {
  await tmux(["new-session", "-d", "-s", "CL-abcd", "sleep 30"]);
  try {
    await setUserOptions("CL-abcd", { "@hive_state": "working", "@hive_id": "CL.abcd" });
    const states = await listSessionStates();
    assert.equal(states.get("CL-abcd"), "working");

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
