import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSelector, isSelectorMulti, parseSelector, resolveSelectorFromState } from "../src/selectors.js";
import type { SessionRecord } from "../src/store.js";

function bee(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "codex",
    cwd: "/tmp/plain",
    command: "codex",
    tmuxTarget: name,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    status: "running",
    id: name,
    ...overrides,
  };
}

// ── parseSelector ──────────────────────────────────────────────────────────

test("parseSelector keeps legacy colony:/@swarm forms", () => {
  assert.deepEqual(parseSelector("colony:fe"), { kind: "colony", name: "fe" });
  assert.deepEqual(parseSelector("@t1"), { kind: "swarm", name: "t1" });
});

test("parseSelector recognizes #tag and tag: user forms", () => {
  assert.deepEqual(parseSelector("#migration"), { kind: "tag", value: "migration" });
  assert.deepEqual(parseSelector("tag:migration"), { kind: "tag", value: "migration" });
});

test("parseSelector recognizes namespaced tag forms", () => {
  assert.deepEqual(parseSelector("prio:p1"), { kind: "tag", namespace: "prio", value: "p1" });
  assert.deepEqual(parseSelector("tag:prio:p1"), { kind: "tag", namespace: "prio", value: "p1" });
  assert.deepEqual(parseSelector("tag:colony:fe"), { kind: "tag", namespace: "colony", value: "fe" });
});

test("parseSelector routes a reserved <ns>:<val> to a tag kind", () => {
  assert.deepEqual(parseSelector("caste:reviewer"), { kind: "tag", namespace: "caste", value: "reviewer" });
  assert.deepEqual(parseSelector("quest:q-ab"), { kind: "tag", namespace: "quest", value: "q-ab" });
});

test("parseSelector treats a bare non-reserved token as a bee", () => {
  assert.deepEqual(parseSelector("CO.6e2"), { kind: "bee", query: "CO.6e2" });
});

test("parseSelector rejects empty tag selectors", () => {
  assert.throws(() => parseSelector("#"), /Empty tag selector/);
  assert.throws(() => parseSelector("tag:"), /Empty tag selector/);
});

// ── resolveSelectorFromState ───────────────────────────────────────────────

test("colony:fe and tag:colony:fe resolve to the same record set", () => {
  const records = [bee("a", { colony: "fe" }), bee("b", { colony: "fe" }), bee("c", { colony: "be" })];
  const legacy = resolveSelectorFromState({ kind: "colony", name: "fe" }, { records });
  const viaTag = resolveSelectorFromState({ kind: "tag", namespace: "colony", value: "fe" }, { records });
  assert.equal(legacy.kind, "colony");
  assert.equal(viaTag.kind, "tag");
  const legacyNames = (legacy as { records: SessionRecord[] }).records.map((r) => r.name).sort();
  const tagNames = (viaTag as { records: SessionRecord[] }).records.map((r) => r.name).sort();
  assert.deepEqual(legacyNames, ["a", "b"]);
  assert.deepEqual(tagNames, ["a", "b"]);
});

test("a bare user tag selector matches bees carrying that tag", () => {
  const records = [bee("a", { tags: ["migration"] }), bee("b", { tags: ["other"] }), bee("c")];
  const target = resolveSelectorFromState({ kind: "tag", value: "migration" }, { records });
  assert.equal(target.kind, "tag");
  if (target.kind === "tag") assert.deepEqual(target.records.map((r) => r.name), ["a"]);
});

test("a namespaced user tag selector matches verbatim", () => {
  const records = [bee("a", { tags: ["prio:p1"] }), bee("b", { tags: ["prio:p2"] })];
  const target = resolveSelectorFromState({ kind: "tag", namespace: "prio", value: "p1" }, { records });
  assert.equal(target.kind, "tag");
  if (target.kind === "tag") assert.deepEqual(target.records.map((r) => r.name), ["a"]);
});

test("a bare namespaced user tag selector resolves like tag:ns:value", () => {
  const records = [bee("a", { tags: ["prio:p1"] }), bee("b", { tags: ["prio:p2"] })];
  const target = resolveSelectorFromState(parseSelector("prio:p1"), { records });
  assert.equal(target.kind, "tag");
  if (target.kind === "tag") assert.deepEqual(target.records.map((r) => r.name), ["a"]);
});

test("an unknown user tag returns an empty set without throwing", () => {
  const records = [bee("a", { tags: ["x"] })];
  const target = resolveSelectorFromState({ kind: "tag", value: "nope" }, { records });
  assert.equal(target.kind, "tag");
  if (target.kind === "tag") assert.deepEqual(target.records, []);
});

test("a tag:colony selector throws on an unknown colony (existence set)", () => {
  assert.throws(
    () => resolveSelectorFromState({ kind: "tag", namespace: "colony", value: "missing" }, { records: [], colonies: new Set(["fe"]) }),
    /Unknown colony: colony:missing/,
  );
});

test("a tag:swarm selector throws on an unknown swarm (existence set)", () => {
  assert.throws(
    () => resolveSelectorFromState({ kind: "tag", namespace: "swarm", value: "missing" }, { records: [], swarms: new Set(["t1"]) }),
    /Unknown swarm: swarm:missing/,
  );
});

test("quest/workspace namespaces match 0..N without an existence-set throw", () => {
  const target = resolveSelectorFromState({ kind: "tag", namespace: "quest", value: "nope" }, { records: [] });
  assert.equal(target.kind, "tag");
  if (target.kind === "tag") assert.deepEqual(target.records, []);
});

// ── isSelectorMulti / formatSelector ───────────────────────────────────────

test("isSelectorMulti is true for tag selectors", () => {
  assert.equal(isSelectorMulti({ kind: "tag", value: "migration" }), true);
  assert.equal(isSelectorMulti({ kind: "tag", namespace: "prio", value: "p1" }), true);
  assert.equal(isSelectorMulti({ kind: "bee", query: "CO.x" }), false);
});

test("formatSelector round-trips tag selectors", () => {
  assert.equal(formatSelector({ kind: "tag", value: "migration" }), "#migration");
  assert.equal(formatSelector({ kind: "tag", namespace: "prio", value: "p1" }), "prio:p1");
  assert.equal(formatSelector({ kind: "tag", namespace: "colony", value: "fe" }), "colony:fe");
});
