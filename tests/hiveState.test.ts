import assert from "node:assert/strict";
import { test } from "node:test";
import { hiveStateFor } from "../src/hiveState.js";
import type { BeeState } from "../src/state.js";

test("hiveStateFor maps every BeeState to the coarse @hive_state vocabulary", () => {
  const expected: Record<BeeState, string | undefined> = {
    booting: "working",
    active: "working",
    ready: "waiting",
    blocked: "waiting",
    idle_with_output: "done",
    sealed: "done",
    archived: undefined,
    error: "failed",
    kill_failed: "failed",
    dead: undefined,
    node_unreachable: undefined,
  };
  for (const [state, mapped] of Object.entries(expected)) {
    assert.equal(hiveStateFor(state as BeeState), mapped, `mapping for ${state}`);
  }
});
