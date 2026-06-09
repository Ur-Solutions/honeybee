import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSelector, isSelectorMulti, parseSelector, resolveSelectorFromState } from "../src/selectors.js";
import type { SessionRecord } from "../src/store.js";

function bee(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget: name,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "running",
    id: name,
    ...overrides,
  };
}

test("parseSelector recognizes bee, swarm, and colony forms", () => {
  assert.deepEqual(parseSelector("CO.6e2"), { kind: "bee", query: "CO.6e2" });
  assert.deepEqual(parseSelector("@deep-review"), { kind: "swarm", name: "deep-review" });
  assert.deepEqual(parseSelector("colony:marketing"), { kind: "colony", name: "marketing" });
});

test("parseSelector trims whitespace", () => {
  assert.deepEqual(parseSelector("  @swarm-1 "), { kind: "swarm", name: "swarm-1" });
});

test("parseSelector rejects empty and prefix-only inputs", () => {
  assert.throws(() => parseSelector(""), /Empty selector/);
  assert.throws(() => parseSelector("@"), /Empty swarm selector/);
  assert.throws(() => parseSelector("colony:"), /Empty colony selector/);
});

test("resolves a bee by exact name", () => {
  const records = [bee("brave-otter", { id: "CO.abc" }), bee("dead-bee", { id: "CO.def" })];
  const target = resolveSelectorFromState({ kind: "bee", query: "brave-otter" }, { records });
  assert.equal(target.kind, "bee");
  if (target.kind === "bee") assert.equal(target.record.name, "brave-otter");
});

test("resolves a bee by id prefix when unique", () => {
  const records = [bee("brave-otter", { id: "CO.abc" }), bee("dead-bee", { id: "CO.def" })];
  const target = resolveSelectorFromState({ kind: "bee", query: "CO.abc" }, { records });
  assert.equal(target.kind, "bee");
  if (target.kind === "bee") assert.equal(target.record.id, "CO.abc");
});

test("resolves a bee by the suffix of its id (without the agent prefix)", () => {
  const records = [
    bee("brave-otter", { id: "CO.123", uuid: "12300000000040008000000000000000" }),
    bee("dead-bee", { id: "CL.456", uuid: "45600000000040008000000000000000" }),
  ];
  const target = resolveSelectorFromState({ kind: "bee", query: "123" }, { records });
  assert.equal(target.kind, "bee");
  if (target.kind === "bee") assert.equal(target.record.id, "CO.123");
});

test("rejects ambiguous bee selectors", () => {
  const records = [
    bee("my-cool-bee", { id: undefined }),
    bee("my-cool-other", { id: undefined }),
  ];
  assert.throws(
    () => resolveSelectorFromState({ kind: "bee", query: "my-cool" }, { records }),
    /Ambiguous bee selector/,
  );
});

test("rejects unknown bee selectors", () => {
  assert.throws(
    () => resolveSelectorFromState({ kind: "bee", query: "nope" }, { records: [] }),
    /Unknown bee selector/,
  );
});

test("resolves a swarm by id, returning all member bees", () => {
  const records = [
    bee("a", { swarmId: "review-001" }),
    bee("b", { swarmId: "review-001" }),
    bee("c", { swarmId: "other" }),
  ];
  const target = resolveSelectorFromState({ kind: "swarm", name: "review-001" }, { records });
  assert.equal(target.kind, "swarm");
  if (target.kind === "swarm") {
    assert.deepEqual(target.records.map((r) => r.name).sort(), ["a", "b"]);
  }
});

test("rejects unknown swarms when registry is provided", () => {
  assert.throws(
    () => resolveSelectorFromState({ kind: "swarm", name: "missing" }, { records: [], swarms: new Set(["other"]) }),
    /Unknown swarm: @missing/,
  );
});

test("returns empty member list for known but empty swarm", () => {
  const target = resolveSelectorFromState(
    { kind: "swarm", name: "drained" },
    { records: [], swarms: new Set(["drained"]) },
  );
  assert.equal(target.kind, "swarm");
  if (target.kind === "swarm") assert.deepEqual(target.records, []);
});

test("resolves a colony", () => {
  const records = [
    bee("a", { colony: "marketing" }),
    bee("b", { colony: "marketing" }),
    bee("c", { colony: "ops" }),
  ];
  const target = resolveSelectorFromState({ kind: "colony", name: "marketing" }, { records });
  assert.equal(target.kind, "colony");
  if (target.kind === "colony") {
    assert.deepEqual(target.records.map((r) => r.name).sort(), ["a", "b"]);
  }
});

test("isSelectorMulti distinguishes cohort selectors from bee selectors", () => {
  assert.equal(isSelectorMulti({ kind: "bee", query: "CO.6e2" }), false);
  assert.equal(isSelectorMulti({ kind: "swarm", name: "review" }), true);
  assert.equal(isSelectorMulti({ kind: "colony", name: "ops" }), true);
});

test("formatSelector roundtrips the canonical form", () => {
  assert.equal(formatSelector({ kind: "bee", query: "CO.6e2" }), "CO.6e2");
  assert.equal(formatSelector({ kind: "swarm", name: "review" }), "@review");
  assert.equal(formatSelector({ kind: "colony", name: "ops" }), "colony:ops");
});
