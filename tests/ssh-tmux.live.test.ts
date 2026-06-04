// Gated live SSH test. Only runs when SSH_LOCALHOST_AVAILABLE=1 is set in the
// environment AND the local machine accepts `ssh localhost` without a password
// (e.g. via authorized_keys + tmux installed remotely). Skipped on CI by default
// so we don't introduce flaky network tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeRecord } from "../src/node.js";
import { createSshTmuxSubstrate } from "../src/substrates/ssh-tmux.js";

const ENABLED = process.env.SSH_LOCALHOST_AVAILABLE === "1";

function localhostNode(): NodeRecord {
  return {
    name: "localhost",
    kind: "ssh-tmux",
    endpoint: "localhost",
    capabilities: ["*"],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };
}

test("real ssh-tmux probe against localhost succeeds", { skip: !ENABLED }, async () => {
  const s = createSshTmuxSubstrate({ node: localhostNode() });
  const result = await s.probe();
  assert.equal(result.ok, true);
});

test("real ssh-tmux listSessions against localhost returns an array", { skip: !ENABLED }, async () => {
  const s = createSshTmuxSubstrate({ node: localhostNode() });
  const sessions = await s.listSessions();
  assert.ok(Array.isArray(sessions));
});
