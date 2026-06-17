import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAccountStep, type SpawnTuiAccount } from "../src/spawnTui.js";

const acc = (id: string): SpawnTuiAccount => ({ id, label: id });

test("resolveAccountStep skips the column with no accounts (plain spawn)", () => {
  const step = resolveAccountStep([]);
  assert.equal(step.showColumn, false);
  assert.equal(step.account, undefined);
  assert.equal(step.label, "no account");
});

test("resolveAccountStep binds the only account without a column", () => {
  const step = resolveAccountStep([acc("claude-thto")]);
  assert.equal(step.showColumn, false);
  assert.equal(step.account, "claude-thto");
  assert.equal(step.label, "claude-thto");
});

test("resolveAccountStep shows an Auto-led column once there are two accounts", () => {
  const step = resolveAccountStep([acc("claude-thto"), acc("claude-work")]);
  assert.equal(step.showColumn, true);
  assert.equal(step.rows.length, 3);
  assert.equal(step.rows[0]!.id, "auto");
  assert.equal(step.rows[0]!.isAuto, true);
  assert.deepEqual(step.rows.slice(1).map((r) => r.id), ["claude-thto", "claude-work"]);
});
