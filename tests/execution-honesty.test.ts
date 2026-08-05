// Contract honesty (P0/P1 checkpoint): the corpus profile's REQUIRED event
// list must contain only families this runtime can actually produce today,
// and no surface (profile, node.describe, run.command) may claim the answer
// command is deliverable while needs_input.opened is not bridged into the
// protocol event stream. The rich families stay in the schema vocabulary as
// optionalEventTypes so fixtures and future emitters need no corpus change.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadExecutionContract, type JsonObject } from "../src/execution/contract.js";
import { PRODUCED_EVENT_TYPES, SUPPORTED_COMMANDS } from "../src/execution/describe.js";

const contract = loadExecutionContract();
const localCore = (contract.profile.profiles as JsonObject)["local-core-v1"] as JsonObject;
const required = (localCore.eventTypes as string[]).slice();
const optional = (localCore.optionalEventTypes as string[]).slice();

test("required eventTypes are exactly the families the runtime durably emits", () => {
  assert.deepEqual(
    [...required].sort(),
    [...PRODUCED_EVENT_TYPES].sort(),
    "profile.json eventTypes must promise exactly what service.ts/operations.ts emit — nothing more, nothing less",
  );
});

test("un-emitted rich families moved to optionalEventTypes keep their schema vocabulary", () => {
  const moved = [
    "turn.started",
    "turn.completed",
    "needs_input.opened",
    "needs_input.resolved",
    "usage.updated",
    "artifact.staged",
    "artifact.finalized",
    "run.recovering",
  ];
  for (const type of moved) {
    assert.ok(optional.includes(type), `${type} must stay in the vocabulary as optional`);
    assert.ok(!required.includes(type), `${type} has no emitter and must not be required`);
  }
  // No family may be promised and optional at once.
  const overlap = required.filter((type) => optional.includes(type));
  assert.deepEqual(overlap, []);
});

test("answer stays schema vocabulary but is never advertised as a deliverable runtime command", () => {
  // The corpus command vocabulary keeps `answer` (run-command-body still
  // validates it, like `checkpoint`)...
  assert.ok((localCore.commands as string[]).includes("answer"));
  // ...but the node's advertised per-driver command set — the honesty
  // surface — must not claim it until needs_input.opened is bridged.
  assert.deepEqual([...SUPPORTED_COMMANDS], ["send", "interrupt"]);
});
