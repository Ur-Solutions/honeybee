/**
 * Spec 05 test tier 1 — dirty-cell delete + --force (A2), shape-checked
 * paths, ENOTEMPTY retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureWork } from "../src/capture.ts";
import { readLedger, writeLedger } from "../src/ledger.ts";
import { provisionCell } from "../src/provision.ts";
import { CellDeleteRefused, CellShapeError, deleteCell, dirtyReport } from "../src/remove.ts";
import { commitInCell, makeRig } from "./helpers.ts";

function provisioned(rig: ReturnType<typeof makeRig>, beeId = "bee-1", cellId = "c1") {
  return provisionCell(
    rig.cellsRoot,
    {
      beeId,
      originRepo: rig.origin.repo,
      sha: rig.origin.sha,
      wrapper: beeId,
      repoName: "fixture",
      cellId,
    },
    "cmd-1",
    { disableCow: true },
  );
}

test("delete.clean: a pristine cell deletes without force", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    const res = deleteCell(cell.paths.wrapperDir);
    assert.equal(res.deleted, true);
    assert.equal(res.forced, false);
    assert.ok(!existsSync(cell.paths.wrapperDir));
  } finally {
    rig.cleanup();
  }
});

test("delete.dirty-uncommitted: refuses without force; force deletes (A2)", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    writeFileSync(join(cell.paths.spaceDir, "wip.ts"), "half-done\n");
    assert.throws(() => deleteCell(cell.paths.wrapperDir), (err: unknown) => {
      assert.ok(err instanceof CellDeleteRefused);
      assert.equal(err.report.uncommitted, true);
      return true;
    });
    assert.ok(existsSync(cell.paths.spaceDir), "refusal must not partially delete");
    const res = deleteCell(cell.paths.wrapperDir, { force: true });
    assert.equal(res.deleted, true);
    assert.equal(res.forced, true);
    assert.ok(!existsSync(cell.paths.wrapperDir));
  } finally {
    rig.cleanup();
  }
});

test("delete.dirty-unpushed: commits the origin never saw refuse; captured work deletes clean", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    commitInCell(cell.paths.spaceDir, "work.ts", "w\n", "uncaptured work");
    const report = dirtyReport(cell.paths.wrapperDir);
    assert.equal(report.unpushed, true);
    assert.throws(() => deleteCell(cell.paths.wrapperDir), CellDeleteRefused);

    // Capture the work out — the same cell is now clean to delete.
    const landed = captureWork({
      originRepo: rig.origin.repo,
      cellSpaceDir: cell.paths.spaceDir,
      targetBranch: "bee/work",
      mode: "merge",
      opId: "cmd-l",
    });
    assert.equal(landed.status, "landed");
    const res = deleteCell(cell.paths.wrapperDir);
    assert.equal(res.deleted, true);
    assert.equal(res.forced, false);
  } finally {
    rig.cleanup();
  }
});

test("delete.origin-gone: unknown origin counts as dirty (refuse without force)", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    commitInCell(cell.paths.spaceDir, "work.ts", "w\n", "work");
    // Break the ledger's origin pointer (moved/deleted origin).
    const ledger = readLedger(cell.paths.ledgerPath);
    assert.ok(ledger);
    ledger.origin = join(rig.root, "no-such-repo");
    writeLedger(cell.paths.ledgerPath, ledger);
    assert.throws(() => deleteCell(cell.paths.wrapperDir), (err: unknown) => {
      assert.ok(err instanceof CellDeleteRefused);
      assert.equal(err.report.originUnknown, true);
      return true;
    });
    assert.equal(deleteCell(cell.paths.wrapperDir, { force: true }).deleted, true);
  } finally {
    rig.cleanup();
  }
});

test("delete.shape: refuses anything that is not a -space- shaped cell wrapper", () => {
  const rig = makeRig();
  try {
    // A user-looking directory: no -space- checkout inside.
    const userDir = join(rig.root, "my-project");
    mkdirSync(join(userDir, "src"), { recursive: true });
    writeFileSync(join(userDir, "src", "index.ts"), "code\n");
    assert.throws(() => deleteCell(userDir), CellShapeError);
    assert.ok(existsSync(userDir));
    // The origin repo itself must obviously refuse too.
    assert.throws(() => deleteCell(rig.origin.repo), CellShapeError);
    assert.ok(existsSync(rig.origin.repo));
    // A nonexistent path is a no-op, not an error.
    assert.equal(deleteCell(join(rig.root, "nope")).deleted, false);
  } finally {
    rig.cleanup();
  }
});

test("delete.half-provisioned: a wrapper whose space has no .git deletes fine", () => {
  const rig = makeRig();
  try {
    const wrapper = join(rig.cellsRoot, "bee-x");
    mkdirSync(join(wrapper, "fixture-space-cx"), { recursive: true });
    mkdirSync(join(wrapper, "box"), { recursive: true });
    const res = deleteCell(wrapper);
    assert.equal(res.deleted, true);
    assert.ok(!existsSync(wrapper));
  } finally {
    rig.cleanup();
  }
});
