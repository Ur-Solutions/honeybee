import assert from "node:assert/strict";
import { test } from "node:test";
import { attachCommand, formatShellCommand } from "../src/tmux.js";

test("attachCommand attaches outside tmux and switches inside tmux", () => {
  const oldTmux = process.env.TMUX;
  try {
    delete process.env.TMUX;
    assert.deepEqual(attachCommand("CO-abc"), ["tmux", "attach-session", "-t", "CO-abc"]);

    process.env.TMUX = "/tmp/tmux-501/default,123,0";
    assert.deepEqual(attachCommand("CO-abc"), ["tmux", "switch-client", "-t", "CO-abc"]);
  } finally {
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
  }
});

test("formatShellCommand quotes unsafe target text", () => {
  assert.equal(formatShellCommand(["tmux", "attach-session", "-t", "name with space"]), "tmux attach-session -t 'name with space'");
});
