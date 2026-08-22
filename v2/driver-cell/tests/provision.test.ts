/**
 * Spec 05 test tier 1 — provisioning matrix: CoW / clone fallback / crash
 * replay, hygiene, warm cells (A5), and the zero-artifact guarantee on the
 * origin during provisioning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { provisionCell, provisionRequestOf, reserveCell } from "../src/provision.ts";
import { isProvisioned, readLedger, writeLedger, newLedger } from "../src/ledger.ts";
import { cellPaths, parseSpaceName } from "../src/layout.ts";
import { probeCow } from "../src/cow.ts";
import { fingerprintOrigin, g, makeRig } from "./helpers.ts";

const COW_AVAILABLE = (() => {
  if (platform() !== "darwin" && platform() !== "linux") return false;
  const rig = makeRig();
  try {
    return probeCow(join(rig.origin.repo, ".git"), rig.cellsRoot);
  } finally {
    rig.cleanup();
  }
})();

function req(rig: ReturnType<typeof makeRig>, over: Record<string, unknown> = {}) {
  return {
    beeId: "bee-1",
    originRepo: rig.origin.repo,
    sha: rig.origin.sha,
    wrapper: "bee-1",
    repoName: "fixture",
    cellId: "c1",
    ...over,
  };
}

test("provision.cow: CoW path places .git, records copy_mode=cow, hygiene applied", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  try {
    // Dirty up the origin's .git with live-state the CoW copy must scrub.
    const gitDir = join(rig.origin.repo, ".git");
    writeFileSync(join(gitDir, "MERGE_HEAD"), `${rig.origin.sha}\n`);
    writeFileSync(join(gitDir, "index.lock"), "");
    mkdirSync(join(gitDir, "rebase-merge"), { recursive: true });
    mkdirSync(join(gitDir, "sequencer"), { recursive: true });
    // A hooks dir with a live hook that must never fire in the cell.
    writeFileSync(join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    g(rig.origin.repo, ["config", "core.fsmonitor", "true"]);
    const before = fingerprintOrigin(rig.origin.repo);

    const cell = provisionCell(rig.cellsRoot, req(rig), "cmd-1", { useGitImages: false });
    assert.equal(cell.copyMode, "cow");
    assert.equal(cell.replayed, false);

    const space = cell.paths.spaceDir;
    // Step 2 always ran: tracked files materialized at the exact sha.
    assert.equal(g(space, ["rev-parse", "HEAD"]), rig.origin.sha);
    assert.equal(readFileSync(join(space, "README.md"), "utf8"), "# fixture\n");
    assert.equal(g(space, ["status", "--porcelain"]), "");

    // Hygiene: hooksPath → empty dir, fsmonitor off, live state scrubbed.
    assert.equal(g(space, ["config", "core.hooksPath"]), cell.paths.emptyHooksDir);
    assert.equal(g(space, ["config", "core.fsmonitor"]), "false");
    for (const leftover of ["MERGE_HEAD", "index.lock", "rebase-merge", "sequencer"]) {
      assert.ok(!existsSync(join(space, ".git", leftover)), `${leftover} not scrubbed`);
    }
    // The hook file may have been copied, but hooksPath makes it inert; a
    // commit in the cell proves it (the origin hook exits 1).
    writeFileSync(join(space, "hooked.txt"), "x\n");
    g(space, ["add", "-A"]);
    g(space, ["commit", "-m", "hook must not fire"]);

    // Ledger truth.
    const ledger = readLedger(cell.paths.ledgerPath);
    assert.equal(ledger?.copy_mode, "cow");
    assert.ok(Object.values(ledger?.operations ?? {}).some((op) => op.completedAt != null));

    // Zero artifacts: provisioning read the origin, never wrote it (the
    // pre-dirtied state is still exactly there).
    const after = fingerprintOrigin(rig.origin.repo);
    assert.deepEqual(after, before);
    assert.ok(existsSync(join(gitDir, "MERGE_HEAD")), "origin's own state must be untouched");
  } finally {
    rig.cleanup();
  }
});

test("provision.clone: fallback places a fresh .git, records copy_mode=clone, needs no hygiene", () => {
  const rig = makeRig();
  try {
    const cell = provisionCell(rig.cellsRoot, req(rig), "cmd-1", { disableCow: true });
    assert.equal(cell.copyMode, "clone");
    const space = cell.paths.spaceDir;
    assert.equal(g(space, ["rev-parse", "HEAD"]), rig.origin.sha);
    assert.equal(g(space, ["status", "--porcelain"]), "");
    assert.equal(readLedger(cell.paths.ledgerPath)?.copy_mode, "clone");
    // Detached at the requested sha, deliberately not on a branch.
    const sym = g(space, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(sym, "HEAD");
  } finally {
    rig.cleanup();
  }
});

test("provision.layout: wrapper/space/box shape and clean space checkout", () => {
  const rig = makeRig();
  try {
    const cell = provisionCell(rig.cellsRoot, req(rig), "cmd-1", { disableCow: true });
    const paths = cellPaths(rig.cellsRoot, "bee-1", "fixture", "c1");
    assert.equal(cell.paths.spaceDir, paths.spaceDir);
    assert.match(paths.spaceName, /^fixture-space-c1$/);
    assert.ok(existsSync(paths.boxDir));
    assert.ok(existsSync(paths.ledgerPath));
    // cell.json lives in box/, NOT in the checkout — git status stays empty.
    assert.equal(g(paths.spaceDir, ["status", "--porcelain"]), "");
  } finally {
    rig.cleanup();
  }
});

test("provision.replay: interrupted provisioning (partial space, no recorded step) replays idempotently", () => {
  const rig = makeRig();
  try {
    const paths = cellPaths(rig.cellsRoot, "bee-1", "fixture", "c1");
    // Simulate a crash mid-step-1: ledger exists with a started operation
    // and NO completed steps; the space dir holds partial junk.
    mkdirSync(paths.boxDir, { recursive: true });
    const ledger = newLedger({
      beeId: "bee-1",
      origin: rig.origin.repo,
      sha: rig.origin.sha,
      wrapper: "bee-1",
      spaceName: paths.spaceName,
      now: Date.now(),
    });
    ledger.operations["cmd-1"] = { startedAt: Date.now(), steps: {} };
    writeLedger(paths.ledgerPath, ledger);
    mkdirSync(join(paths.spaceDir, ".git"), { recursive: true });
    writeFileSync(join(paths.spaceDir, ".git", "HEAD"), "garbage");

    // Replay with the SAME operation id — must recover to a working cell.
    const cell = provisionCell(rig.cellsRoot, req(rig), "cmd-1", { disableCow: true });
    assert.equal(cell.replayed, false);
    assert.equal(g(cell.paths.spaceDir, ["rev-parse", "HEAD"]), rig.origin.sha);
    assert.equal(g(cell.paths.spaceDir, ["status", "--porcelain"]), "");

    // A second replay (same op) is a recorded no-op.
    const again = provisionCell(rig.cellsRoot, req(rig), "cmd-1", { disableCow: true });
    assert.equal(again.replayed, true);
    // And a replay under a DIFFERENT op id (retried command chain) no-ops too.
    const other = provisionCell(rig.cellsRoot, req(rig), "cmd-2", { disableCow: true });
    assert.equal(other.replayed, true);
  } finally {
    rig.cleanup();
  }
});

test("provision.replay: mismatched bee/sha refuses instead of clobbering", () => {
  const rig = makeRig();
  try {
    provisionCell(rig.cellsRoot, req(rig), "cmd-1", { disableCow: true });
    assert.throws(
      () => provisionCell(rig.cellsRoot, req(rig, { beeId: "bee-2" }), "cmd-9", { disableCow: true }),
      /refusing to provision/,
    );
  } finally {
    rig.cleanup();
  }
});

test("provision.warm: CoW copy-in of listed artifact dirs (A5)", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  try {
    // An untracked build-artifact dir in the origin (node_modules-like).
    mkdirSync(join(rig.origin.repo, "node_modules", "leftpad"), { recursive: true });
    writeFileSync(join(rig.origin.repo, "node_modules", "leftpad", "index.js"), "module.exports = 1;\n");
    const cell = provisionCell(rig.cellsRoot, req(rig, { warmArtifacts: ["node_modules"] }), "cmd-1");
    assert.equal(cell.warm.mode, "cow");
    assert.deepEqual(cell.warm.dirs, ["node_modules"]);
    assert.equal(
      readFileSync(join(cell.paths.spaceDir, "node_modules", "leftpad", "index.js"), "utf8"),
      "module.exports = 1;\n",
    );
  } finally {
    rig.cleanup();
  }
});

test("provision.warm: no CoW → cold, no fallback copy (the A5 ruling)", () => {
  const rig = makeRig();
  try {
    mkdirSync(join(rig.origin.repo, "node_modules"), { recursive: true });
    writeFileSync(join(rig.origin.repo, "node_modules", "a.js"), "x\n");
    const cell = provisionCell(rig.cellsRoot, req(rig, { warmArtifacts: ["node_modules"] }), "cmd-1", {
      disableCow: true,
    });
    assert.equal(cell.warm.mode, "cold");
    assert.equal(cell.warm.reason, "no_cow");
    assert.deepEqual(cell.warm.dirs, []);
    // Deliberately NOT copied by any other means.
    assert.ok(!existsSync(join(cell.paths.spaceDir, "node_modules")));
  } finally {
    rig.cleanup();
  }
});

test("provision.warm: nothing listed → cold(none_listed), default off", () => {
  const rig = makeRig();
  try {
    const cell = provisionCell(rig.cellsRoot, req(rig), "cmd-1", { disableCow: true });
    assert.equal(cell.warm.mode, "cold");
    assert.equal(cell.warm.reason, "none_listed");
  } finally {
    rig.cleanup();
  }
});

test("provision.reserve: reserveCell writes the seed ledger (origin/sha/warm/sandbox, no operations); provisionCell then provisions against it; the inverse (provisionRequestOf) round-trips; mismatches refuse", () => {
  const rig = makeRig();
  try {
    const request = { ...req(rig, { warmArtifacts: ["node_modules"], sandbox: false }) };
    const reserved = reserveCell(rig.cellsRoot, request);
    assert.equal(reserved.created, true);
    assert.ok(existsSync(reserved.paths.ledgerPath), "seed ledger written");
    assert.equal(existsSync(reserved.paths.spaceDir), false, "no checkout yet");
    const seed = readLedger(reserved.paths.ledgerPath)!;
    assert.equal(seed.beeId, "bee-1");
    assert.equal(seed.origin, rig.origin.repo);
    assert.equal(seed.sha, rig.origin.sha);
    assert.deepEqual(seed.warm, ["node_modules"]);
    assert.equal(seed.sandbox, false);
    assert.deepEqual(seed.operations, {});
    assert.equal(isProvisioned(seed), false);

    // Inverse: the ledger describes the request (minus the sandbox, which lives beside it).
    const back = provisionRequestOf(seed)!;
    assert.deepEqual(back, {
      beeId: "bee-1",
      originRepo: rig.origin.repo,
      sha: rig.origin.sha,
      wrapper: "bee-1",
      repoName: "fixture",
      cellId: "c1",
      warmArtifacts: ["node_modules"],
    });
    assert.deepEqual(parseSpaceName("my-space-repo-space-abc123"), { repoName: "my-space-repo", cellId: "abc123" });
    assert.equal(parseSpaceName("not-a-space"), null);

    // Idempotent for the same bee+sha; refuses another bee or sha.
    assert.equal(reserveCell(rig.cellsRoot, request).created, false);
    assert.throws(() => reserveCell(rig.cellsRoot, { ...request, beeId: "bee-2" }), /refusing to reserve/);
    assert.throws(() => reserveCell(rig.cellsRoot, { ...request, sha: "0".repeat(40) }), /refusing to reserve/);

    // First provisioning finds the seed and completes it in place (same ledger file, warm carried).
    const cell = provisionCell(rig.cellsRoot, back, "cmd-1", { disableCow: true });
    assert.equal(cell.replayed, false);
    assert.equal(cell.paths.ledgerPath, reserved.paths.ledgerPath);
    assert.ok(existsSync(join(cell.paths.spaceDir, ".git")));
    const done = readLedger(reserved.paths.ledgerPath)!;
    assert.equal(isProvisioned(done), true);
    assert.equal(done.sandbox, false, "seed fields survive provisioning");
    assert.deepEqual(done.warm, ["node_modules"]);
  } finally {
    rig.cleanup();
  }
});
