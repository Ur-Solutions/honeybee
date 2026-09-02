/**
 * agy adapter unit tests using trimmed, sanitized agy 1.1.24 output captured
 * on 2026-09-02. The source captures are /tmp/agy-fixtures/ in the HB1 cell.
 * Timing, token counts, tool inventories, and OAuth URLs are omitted; event
 * names, status values, step shapes, and permission modes are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agyAdapter,
  agyResumeArgs,
  encodeAgyMessage,
  parseAgyLine,
} from "../src/agy.ts";
import { isAuthNeededMessage } from "../src/types.ts";

const SESSION_ID = "agy-recorded-session";

const TWO_TURN_FIXTURE = [
  `{"event":"init","conversation_id":"${SESSION_ID}","init":{"cwd":"/tmp","tools":["run_command"],"permission_mode":"request-review"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":1,"state":"DONE","step_type":"agent_response"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command"}}`,
  `{"event":"result","result":{"conversation_id":"${SESSION_ID}","status":"CANCELED","response":"","num_turns":1}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":3,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"SECOND\\n"}}`,
  `{"event":"result","result":{"conversation_id":"${SESSION_ID}","status":"SUCCESS","response":"SECOND\\n","num_turns":2}}`,
] as const;

const AUTH_ERROR_FIXTURE =
  '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","num_turns":0}}';

const SKIP_PERMISSIONS_TOOL_FIXTURE = [
  `{"event":"init","conversation_id":"${SESSION_ID}","init":{"cwd":"/tmp","tools":["run_command"],"permission_mode":"always-proceed"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":1,"state":"DONE","step_type":"agent_response"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello-agy"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${SESSION_ID}","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello-agy"},"output":"hello-agy\\n"}}}`,
  `{"event":"result","result":{"conversation_id":"${SESSION_ID}","status":"SUCCESS","response":"hello-agy\\n","num_turns":1}}`,
] as const;

test("agy: init is real boot evidence and lands the ready process on idle", () => {
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[0]), [
    { kind: "booted", sessionId: SESSION_ID },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
});

test("agy: recorded two-turn stream maps agent responses and results, while user/tool steps remain noise", () => {
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[1]), []);
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[2]), [{ kind: "turn_started" }]);
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[3]), []);
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[4]), []);
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[5]), [{ kind: "turn_ended" }]);
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[6]), []);
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[7]), [{ kind: "turn_started" }]);
  assert.deepEqual(parseAgyLine(TWO_TURN_FIXTURE[8]), [
    { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
    { kind: "turn_ended" },
  ]);
});

test("agy: recorded skip-permissions stream keeps ACTIVE and DONE tool updates as noise", () => {
  assert.deepEqual(parseAgyLine(SKIP_PERMISSIONS_TOOL_FIXTURE[0]), [
    { kind: "booted", sessionId: SESSION_ID },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
  assert.deepEqual(parseAgyLine(SKIP_PERMISSIONS_TOOL_FIXTURE[1]), [{ kind: "turn_started" }]);
  assert.deepEqual(parseAgyLine(SKIP_PERMISSIONS_TOOL_FIXTURE[2]), []);
  assert.deepEqual(parseAgyLine(SKIP_PERMISSIONS_TOOL_FIXTURE[3]), []);
  assert.deepEqual(parseAgyLine(SKIP_PERMISSIONS_TOOL_FIXTURE[4]), [
    { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
    { kind: "turn_ended" },
  ]);
});

test("agy: auth ERROR result sets auth_needed despite the process exit code being unreliable", () => {
  assert.deepEqual(parseAgyLine(AUTH_ERROR_FIXTURE), [
    {
      kind: "flag",
      flag: "auth_needed",
      action: "set",
      detail: "authentication failed or timed out",
    },
    { kind: "turn_ended" },
  ]);
});

test("agy: shared auth classifier recognizes both captured stdout and stderr cues", () => {
  assert.equal(isAuthNeededMessage("authentication failed or timed out"), true);
  assert.equal(isAuthNeededMessage("Authentication required. Please visit the URL to log in"), true);
});

test("agy: resource ERROR result sets resource_blocked and ends the turn without contrary clears", () => {
  const line = JSON.stringify({
    event: "result",
    result: { conversation_id: SESSION_ID, status: "ERROR", error: "quota exhausted" },
  });
  assert.deepEqual(parseAgyLine(line), [
    { kind: "flag", flag: "resource_blocked", action: "set", detail: "quota exhausted" },
    { kind: "turn_ended" },
  ]);
});

test("agy: malformed lines, unknown events, and unknown step types are noise", () => {
  assert.deepEqual(parseAgyLine("not json {"), []);
  assert.deepEqual(parseAgyLine(JSON.stringify({ event: "future_event", state: "DONE" })), []);
  assert.deepEqual(parseAgyLine(JSON.stringify({ event: "step_update", step_update: { step_type: "future_step" } })), []);
  assert.deepEqual(parseAgyLine(JSON.stringify({ no: "event" })), []);
});

test("agy: encodeMessage emits the probed one-line stream-json user envelope", () => {
  assert.deepEqual(JSON.parse(encodeAgyMessage("hello bee")), {
    event: "user",
    message: { content: [{ type: "text", text: "hello bee" }] },
  });
  assert.ok(!encodeAgyMessage("multi\nline").includes("\n"));
});

test("agy: adapter surface matches the print-mode lifecycle and resume contract", () => {
  assert.equal(agyAdapter.harness, "agy");
  assert.equal(agyAdapter.readyAtSpawn, false);
  assert.equal(agyAdapter.acceptsMidTurn, false);
  assert.equal(agyAdapter.confirmsDelivery, false);
  assert.deepEqual(agyAdapter.bootLines(), []);
  assert.equal(agyAdapter.encodeInterrupt, undefined);
  assert.equal(agyAdapter.forkArgs, undefined);
  assert.deepEqual(agyResumeArgs(SESSION_ID), ["--conversation", SESSION_ID]);
  assert.deepEqual(agyAdapter.resumeArgs?.(SESSION_ID), ["--conversation", SESSION_ID]);
  assert.equal(
    agyAdapter.encodeMessage("x", {
      sessionId: SESSION_ID,
      messageId: 1,
      turnActive: false,
      turnId: null,
    }),
    encodeAgyMessage("x"),
  );
  assert.deepEqual(agyAdapter.parseLine(TWO_TURN_FIXTURE[7]), agyAdapter.parseLine(TWO_TURN_FIXTURE[7]));
});
