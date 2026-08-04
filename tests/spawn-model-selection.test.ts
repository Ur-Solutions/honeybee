import assert from "node:assert/strict";
import { test } from "node:test";
import { requestedModelFromArgs } from "../src/commands/spawn.js";

test("requestedModelFromArgs follows harness argv precedence", () => {
  assert.equal(requestedModelFromArgs([]), undefined);
  assert.equal(requestedModelFromArgs(["--model", "claude-fable-5"]), "claude-fable-5");
  assert.equal(requestedModelFromArgs(["--model=opus"]), "opus");
  assert.equal(requestedModelFromArgs(["-m", "sonnet", "--model", "claude-fable-5"]), "claude-fable-5");
  assert.equal(requestedModelFromArgs(["-m=claude-fable-5"]), "claude-fable-5");
});
