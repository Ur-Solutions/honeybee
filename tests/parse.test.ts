import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOLEAN_FLAGS, flag, numberFlag, parse, truthy } from "../src/parse.js";

test("parse separates command args flags and passthrough rest", () => {
  const parsed = parse(["run", "claude", "--cwd", "/tmp/work", "-p", "hello", "--", "--model", "sonnet"]);

  assert.equal(parsed.command, "run");
  assert.deepEqual(parsed.args, ["claude"]);
  assert.equal(flag(parsed, "cwd"), "/tmp/work");
  assert.equal(flag(parsed, "p"), "hello");
  assert.deepEqual(parsed.rest, ["--model", "sonnet"]);
});

test("parse preserves repeated flags and numeric fallbacks", () => {
  const parsed = parse(["wait", "CO.abc", "--n=5", "--tag", "one", "--tag", "two"]);

  assert.equal(numberFlag(parsed, ["n"], 0), 5);
  assert.deepEqual(flag(parsed, "tag"), ["one", "two"]);
  assert.equal(numberFlag(parsed, ["missing"], 10), 10);
});

test("parse leaves positional args after boolean flags", () => {
  const short = parse(["tail", "-f", "CO.6e2"]);
  assert.equal(flag(short, "f"), true);
  assert.deepEqual(short.args, ["CO.6e2"]);

  const long = parse(["tail", "--follow", "CO.6e2"]);
  assert.equal(flag(long, "follow"), true);
  assert.deepEqual(long.args, ["CO.6e2"]);

  const archived = parse(["list", "--archived", "colony:frontend"]);
  assert.equal(flag(archived, "archived"), true);
  assert.deepEqual(archived.args, ["colony:frontend"]);
});

test("BOOLEAN_FLAGS is exported so completion can skip value-less flags", () => {
  assert.ok(BOOLEAN_FLAGS.has("json"));
  assert.ok(BOOLEAN_FLAGS.has("yolo"));
  assert.ok(BOOLEAN_FLAGS.has("f"));
  assert.ok(!BOOLEAN_FLAGS.has("cwd"));
});

test("truthy accepts explicit opt-in values only", () => {
  assert.equal(truthy(true), true);
  assert.equal(truthy("1"), true);
  assert.equal(truthy("yes"), true);
  assert.equal(truthy("false"), false);
  assert.equal(truthy(undefined), false);
});
