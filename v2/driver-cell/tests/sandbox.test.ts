/**
 * Spec 05 test tier 1 — sandbox matrix (A4): node-kind defaults + per-cell
 * override, Seatbelt profile generation + real `sandbox-exec` confinement
 * (darwin-local), bwrap argv construction everywhere + real bwrap
 * confinement (linux only — the metal-3 gate runs it; skipped elsewhere).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  bwrapArgs,
  sandboxDefaultFor,
  sandboxEnabled,
  seatbeltProfile,
  wrapWithSandbox,
} from "../src/sandbox.ts";

const IS_DARWIN = platform() === "darwin";
const IS_LINUX = platform() === "linux";

test("sandbox.defaults: workstation OFF, satellite ON, cloud OFF (A4)", () => {
  assert.equal(sandboxDefaultFor("workstation"), false);
  assert.equal(sandboxDefaultFor("satellite"), true);
  assert.equal(sandboxDefaultFor("cloud"), false);
});

test("sandbox.override: per-cell override beats the node-kind default", () => {
  assert.equal(sandboxEnabled("workstation", null), false);
  assert.equal(sandboxEnabled("workstation", true), true);
  assert.equal(sandboxEnabled("satellite", undefined), true);
  assert.equal(sandboxEnabled("satellite", false), false);
  assert.equal(sandboxEnabled("cloud", true), true);
});

test("sandbox.profile: Seatbelt profile confines writes to cell + harness paths, allows the rest", () => {
  const profile = seatbeltProfile({
    cellDir: "/cells/bee-1",
    writablePaths: ["/home/u/.claude", "/home/u/.cache"],
  });
  assert.match(profile, /\(allow default\)/); // read + network open
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(subpath "\/cells\/bee-1"\)/);
  assert.match(profile, /\(subpath "\/home\/u\/\.claude"\)/);
  assert.match(profile, /\(subpath "\/private\/var\/folders"\)/);
  // Quotes/backslashes in paths are escaped, not profile-breaking.
  const tricky = seatbeltProfile({ cellDir: '/cells/we"ird', writablePaths: [] });
  assert.match(tricky, /\(subpath "\/cells\/we\\"ird"\)/);
});

test("sandbox.bwrap: argv is read-only root + rw cell/harness binds + net (pure, all platforms)", () => {
  const args = bwrapArgs(
    { cellDir: "/cells/bee-1", writablePaths: ["/home/u/.codex"] },
    "node",
    ["agent.mjs"],
  );
  const joined = args.join(" ");
  assert.match(joined, /--ro-bind \/ \//);
  assert.match(joined, /--bind \/cells\/bee-1 \/cells\/bee-1/);
  assert.match(joined, /--bind-try \/home\/u\/\.codex \/home\/u\/\.codex/);
  assert.match(joined, /--share-net/);
  assert.match(joined, /--die-with-parent/);
  assert.ok(joined.endsWith("-- node agent.mjs"));
});

test("sandbox.wrap: platform dispatch (darwin sandbox-exec -f, linux bwrap, other throws)", () => {
  const policy = { cellDir: "/c", writablePaths: [] };
  const darwin = wrapWithSandbox(policy, "node", ["a.mjs"], "/box/p.sb", "darwin");
  assert.equal(darwin.command, "sandbox-exec");
  assert.deepEqual(darwin.args.slice(0, 2), ["-f", "/box/p.sb"]);
  assert.ok(darwin.profile != null && darwin.profile.includes("(version 1)"));
  const linux = wrapWithSandbox(policy, "node", ["a.mjs"], "/box/p.sb", "linux");
  assert.equal(linux.command, "bwrap");
  assert.equal(linux.profile, undefined);
  assert.throws(() => wrapWithSandbox(policy, "node", [], "/p", "win32"), /unsupported platform/);
});

test("sandbox.seatbelt-real: sandbox-exec confines writes to the cell (darwin)", { skip: !IS_DARWIN }, () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-sb-"));
  try {
    const cellDir = join(root, "cell");
    const outsideDir = join(root, "outside");
    spawnSync("mkdir", ["-p", cellDir, outsideDir]);
    const profilePath = join(root, "profile.sb");
    // Pin scratch to /dev only: the test dirs live under the OS tmp area,
    // which the DEFAULT scratch policy would rightly allow — confinement is
    // proven against a policy whose only writable subtree is the cell.
    writeFileSync(profilePath, seatbeltProfile({ cellDir, writablePaths: [], scratchPaths: ["/dev"] }));

    // Inside the cell: allowed.
    const inside = spawnSync(
      "sandbox-exec",
      ["-f", profilePath, "/bin/sh", "-c", `echo ok > ${cellDir}/f.txt`],
      { encoding: "utf8" },
    );
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(readFileSync(join(cellDir, "f.txt"), "utf8"), "ok\n");

    // Outside the cell: denied.
    const outside = spawnSync(
      "sandbox-exec",
      ["-f", profilePath, "/bin/sh", "-c", `echo leak > ${outsideDir}/f.txt`],
      { encoding: "utf8" },
    );
    assert.notEqual(outside.status, 0, "write outside the cell must be denied");

    // Reads outside the cell stay allowed (fs visible, write-confined).
    const read = spawnSync("sandbox-exec", ["-f", profilePath, "/bin/cat", "/etc/hosts"], {
      encoding: "utf8",
    });
    assert.equal(read.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.bwrap-real: bwrap confines writes to the cell (linux — metal-3 gate)", { skip: !IS_LINUX }, () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-sb-"));
  try {
    const cellDir = join(root, "cell");
    const outsideDir = join(root, "outside");
    spawnSync("mkdir", ["-p", cellDir, outsideDir]);
    const policy = { cellDir, writablePaths: [], scratchPaths: [] };

    const inside = spawnSync(
      "bwrap",
      bwrapArgs(policy, "/bin/sh", ["-c", `echo ok > ${cellDir}/f.txt`]),
      { encoding: "utf8" },
    );
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(readFileSync(join(cellDir, "f.txt"), "utf8"), "ok\n");

    const outside = spawnSync(
      "bwrap",
      bwrapArgs(policy, "/bin/sh", ["-c", `echo leak > ${outsideDir}/f.txt`]),
      { encoding: "utf8" },
    );
    assert.notEqual(outside.status, 0, "write outside the cell must be denied");

    const read = spawnSync("bwrap", bwrapArgs(policy, "/bin/cat", ["/etc/hosts"]), { encoding: "utf8" });
    assert.equal(read.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
