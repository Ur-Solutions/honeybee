import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAttachArgv } from "../src/attach.js";

test("local bee outside tmux attaches the terminal", () => {
  assert.deepEqual(
    buildAttachArgv({ sessionName: "CL-abc", insideTmux: false }),
    ["tmux", "attach-session", "-t", "=CL-abc"],
  );
});

test("local bee inside tmux repoints the current client (never nests)", () => {
  assert.deepEqual(
    buildAttachArgv({ sessionName: "CL-abc", insideTmux: true }),
    ["tmux", "switch-client", "-t", "=CL-abc"],
  );
});

test("remote bee outside tmux attaches over ssh -t", () => {
  assert.deepEqual(
    buildAttachArgv({ sessionName: "CO-def", insideTmux: false, remote: { endpoint: "trmd@studio" } }),
    ["ssh", "-t", "trmd@studio", "tmux", "attach-session", "-t", "=CO-def"],
  );
});

test("remote bee outside tmux honors ssh binary and args overrides", () => {
  assert.deepEqual(
    buildAttachArgv({
      sessionName: "CO-def",
      insideTmux: false,
      remote: { endpoint: "studio", sshBinary: "/opt/ssh", sshArgs: ["-p", "2222"] },
    }),
    ["/opt/ssh", "-t", "-p", "2222", "studio", "tmux", "attach-session", "-t", "=CO-def"],
  );
});

test("remote bee inside tmux opens the ssh attach as a new window", () => {
  assert.deepEqual(
    buildAttachArgv({ sessionName: "CO-def", insideTmux: true, remote: { endpoint: "trmd@studio" } }),
    ["tmux", "new-window", "-n", "CO-def", "ssh -t trmd@studio tmux attach-session -t =CO-def"],
  );
});

test("remote-inside window command rejects unsafe session names and endpoints", () => {
  assert.throws(
    () => buildAttachArgv({ sessionName: "x; rm -rf /", insideTmux: true, remote: { endpoint: "studio" } }),
    /unsafe session name/,
  );
  assert.throws(
    () => buildAttachArgv({ sessionName: "CO-def", insideTmux: true, remote: { endpoint: "studio $(boom)" } }),
    /unsafe endpoint/,
  );
});

test("unsafe names are tolerated on pure-argv branches (no shell involved)", () => {
  // Outside tmux nothing is shell-interpolated locally; weird-but-real session
  // names must still be addressable. The remote words are quoted for the
  // remote shell's re-split.
  const argv = buildAttachArgv({ sessionName: "a b", insideTmux: false, remote: { endpoint: "studio" } });
  assert.deepEqual(argv, ["ssh", "-t", "studio", "tmux", "attach-session", "-t", "'=a b'"]);
});
