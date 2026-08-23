import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { v2IsDefault } from "../src/cliRoute.js";

// WP7 B5 — the flip switch is the freeze marker itself (reset-07 §B3/§B5):
// FROZEN present → plain `hive` verbs are the v2 surface; `deploy` and
// completion plumbing stay old-world; removing the marker un-flips (§C).
test("frozen flip: FROZEN marker routes plain verbs to v2; deploy/completions stay; unfrozen stays v1", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-frozen-flip-"));
  const saved = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    assert.equal(v2IsDefault("ls"), false, "unfrozen: old world untouched");
    assert.equal(v2IsDefault(undefined), false, "unfrozen: bare `hive` stays v1 help");
    writeFileSync(join(dir, "FROZEN"), "cutover 2026-08-19\n");
    assert.equal(v2IsDefault("ls"), true, "frozen: plain verbs are v2");
    assert.equal(v2IsDefault("send"), true);
    assert.equal(v2IsDefault(undefined), true, "frozen: bare `hive` is v2 help");
    assert.equal(v2IsDefault("deploy"), false, "deploy keeps the runtime machinery");
    assert.equal(v2IsDefault("__complete"), false, "completion plumbing stays");
    rmSync(join(dir, "FROZEN"));
    assert.equal(v2IsDefault("ls"), false, "rollback: removing the marker un-flips");
  } finally {
    if (saved === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
