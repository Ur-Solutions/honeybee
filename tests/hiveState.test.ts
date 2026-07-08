import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveHiveState, hiveStateFor } from "../src/hiveState.js";
import type { BeeState } from "../src/state.js";

test("hiveStateFor maps every BeeState to the coarse @hive_state vocabulary", () => {
  const expected: Record<BeeState, string | undefined> = {
    booting: "working",
    wedged: "failed",
    active: "working",
    ready: "waiting",
    blocked: "waiting",
    idle_with_output: "done",
    sealed: "done",
    archived: undefined,
    error: "failed",
    kill_failed: "failed",
    dead: undefined,
    crashed: undefined,
    node_unreachable: undefined,
  };
  for (const [state, mapped] of Object.entries(expected)) {
    assert.equal(hiveStateFor(state as BeeState), mapped, `mapping for ${state}`);
  }
});

test("effectiveHiveState drops a stale 'working' when the live pane shows the bee idle/ready/blocked", () => {
  // The reported codex bug: @hive_state stuck at the spawn-time "working" while
  // the pane is plainly done, because hookless codex relies on a lagging daemon.
  assert.equal(effectiveHiveState("working", "idle_with_output"), undefined, "done pane overrides stale working");
  assert.equal(effectiveHiveState("working", "ready"), undefined, "ready pane overrides stale working");
  assert.equal(effectiveHiveState("working", "blocked"), undefined, "blocked pane overrides stale working");
});

test("effectiveHiveState keeps 'working' while the pane agrees the bee is busy", () => {
  assert.equal(effectiveHiveState("working", "active"), "working");
  assert.equal(effectiveHiveState("working", "booting"), "working");
  // No derived state to compare against → trust the hint as-is.
  assert.equal(effectiveHiveState("working", undefined), "working");
});

test("effectiveHiveState trusts hook-authoritative values verbatim and ignores empties", () => {
  // waiting/done come from real Stop/Notification events — never second-guessed.
  assert.equal(effectiveHiveState("waiting", "active"), "waiting");
  assert.equal(effectiveHiveState("done", "active"), "done");
  assert.equal(effectiveHiveState("", "idle_with_output"), undefined);
  assert.equal(effectiveHiveState(undefined, "ready"), undefined);
});
test("effectiveHiveState drops a stale 'failed' when the live pane shows a healthy state", () => {
  // "failed" is only ever daemon-mirrored from wedged/error — no hook sets it —
  // so a "failed" hint that disagrees with a healthy pane is stale and yields.
  assert.equal(effectiveHiveState("failed", "ready"), undefined, "ready pane overrides stale failed");
  assert.equal(effectiveHiveState("failed", "idle_with_output"), undefined, "idle pane overrides stale failed");
  assert.equal(effectiveHiveState("failed", "active"), undefined, "active pane overrides stale failed");
});
test("effectiveHiveState keeps 'failed' while the pane agrees the bee is failed", () => {
  assert.equal(effectiveHiveState("failed", "wedged"), "failed");
  assert.equal(effectiveHiveState("failed", "error"), "failed");
  assert.equal(effectiveHiveState("failed", "kill_failed"), "failed");
  // No derived state (dead/crashed/archived → undefined mapping) → trust the hint.
  assert.equal(effectiveHiveState("failed", "crashed"), "failed");
  assert.equal(effectiveHiveState("failed", undefined), "failed");
});
