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

test("parseSelector recognizes every rel prefix as a rel kind", () => {
  assert.deepEqual(parseSelector("owns:CL.x"), { kind: "rel", verb: "owns", target: "CL.x" });
  assert.deepEqual(parseSelector("owned-by:CL.x"), { kind: "rel", verb: "owned-by", target: "CL.x" });
  assert.deepEqual(parseSelector("reports-to:CL.x"), { kind: "rel", verb: "reports-to", target: "CL.x" });
  assert.deepEqual(parseSelector("children-of:CL.x"), { kind: "rel", verb: "children-of", target: "CL.x" });
  assert.deepEqual(parseSelector("forks-of:CL.x"), { kind: "rel", verb: "forks-of", target: "CL.x" });
});

test("parseSelector does NOT turn owns: into a tag kind (owns is not a reserved ns)", () => {
  const sel = parseSelector("owns:CL.x");
  assert.equal(sel.kind, "rel");
  assert.notEqual(sel.kind as string, "tag");
});

test("parseSelector rejects an empty rel selector", () => {
  assert.throws(() => parseSelector("owns:"), /Empty relationship selector/);
  assert.throws(() => parseSelector("children-of:"), /Empty relationship selector/);
});

// ── resolveSelectorFromState ───────────────────────────────────────────────

test("owns: returns the bees pointing reportsToId at the owner's id", () => {
  const records = [
    bee("owner"),
    bee("a", { reportsToId: "owner" }),
    bee("b", { reportsToId: "owner" }),
    bee("c", { reportsToId: "someone-else" }),
  ];
  const target = resolveSelectorFromState({ kind: "rel", verb: "owns", target: "owner" }, { records });
  assert.equal(target.kind, "rel");
  if (target.kind === "rel") assert.deepEqual(target.records.map((r) => r.name).sort(), ["a", "b"]);
});

test("owns:/owned-by:/reports-to: are aliases — same record set", () => {
  const records = [bee("owner"), bee("a", { reportsToId: "owner" }), bee("b", { reportsToId: "owner" })];
  const owns = resolveSelectorFromState({ kind: "rel", verb: "owns", target: "owner" }, { records });
  const ownedBy = resolveSelectorFromState({ kind: "rel", verb: "owned-by", target: "owner" }, { records });
  const reportsTo = resolveSelectorFromState({ kind: "rel", verb: "reports-to", target: "owner" }, { records });
  const names = (t: typeof owns) => (t.kind === "rel" ? t.records.map((r) => r.name).sort() : []);
  assert.deepEqual(names(owns), ["a", "b"]);
  assert.deepEqual(names(ownedBy), ["a", "b"]);
  assert.deepEqual(names(reportsTo), ["a", "b"]);
});

test("children-of: reverse-queries parentId", () => {
  const records = [bee("p"), bee("kid", { parentId: "p" }), bee("other", { parentId: "q" })];
  const target = resolveSelectorFromState({ kind: "rel", verb: "children-of", target: "p" }, { records });
  assert.equal(target.kind, "rel");
  if (target.kind === "rel") assert.deepEqual(target.records.map((r) => r.name), ["kid"]);
});

test("forks-of: reverse-queries forkedFromId", () => {
  const records = [bee("src"), bee("fork", { forkedFromId: "src" }), bee("nope")];
  const target = resolveSelectorFromState({ kind: "rel", verb: "forks-of", target: "src" }, { records });
  assert.equal(target.kind, "rel");
  if (target.kind === "rel") assert.deepEqual(target.records.map((r) => r.name), ["fork"]);
});

test("dead anchor: owns:<removed-owner> still matches surviving bees by raw id", () => {
  // No record named/id'd GONE.id exists — the owner was killed and its record
  // removed. The reverse query falls back to the raw token and still matches.
  const records = [bee("a", { reportsToId: "GONE.id" }), bee("b", { reportsToId: "GONE.id" }), bee("c")];
  const target = resolveSelectorFromState({ kind: "rel", verb: "owns", target: "GONE.id" }, { records });
  assert.equal(target.kind, "rel");
  if (target.kind === "rel") assert.deepEqual(target.records.map((r) => r.name).sort(), ["a", "b"]);
});

test("live anchor resolved by name maps to its id via resolveBeeId", () => {
  // The owner is addressed by its name "lead" but its stored id (CL.lead123) is
  // what the owned bees carry — resolveBeeId must map name → id before matching.
  const records = [
    bee("lead", { id: "CL.lead123" }),
    bee("a", { reportsToId: "CL.lead123" }),
    bee("b", { reportsToId: "CL.lead123" }),
  ];
  const target = resolveSelectorFromState({ kind: "rel", verb: "owns", target: "lead" }, { records });
  assert.equal(target.kind, "rel");
  if (target.kind === "rel") assert.deepEqual(target.records.map((r) => r.name).sort(), ["a", "b"]);
});

test("live anchor resolved by a sufficiently-long id prefix maps to its id", () => {
  const records = [
    bee("lead", { id: "CL.lead" }),
    bee("a", { reportsToId: "CL.lead" }),
    bee("b", { reportsToId: "CL.lead" }),
  ];
  // Query equals the full id (length-rule satisfied) → resolves via prefix path.
  const target = resolveSelectorFromState({ kind: "rel", verb: "owns", target: "CL.lead" }, { records });
  assert.equal(target.kind, "rel");
  if (target.kind === "rel") assert.deepEqual(target.records.map((r) => r.name).sort(), ["a", "b"]);
});

test("a rel query with no surviving edges matches 0 bees without throwing", () => {
  const records = [bee("owner"), bee("a")];
  const target = resolveSelectorFromState({ kind: "rel", verb: "owns", target: "owner" }, { records });
  assert.equal(target.kind, "rel");
  if (target.kind === "rel") assert.deepEqual(target.records, []);
});

// ── isSelectorMulti / formatSelector ───────────────────────────────────────

test("isSelectorMulti is true for rel selectors", () => {
  assert.equal(isSelectorMulti({ kind: "rel", verb: "owns", target: "CL.x" }), true);
  assert.equal(isSelectorMulti({ kind: "rel", verb: "children-of", target: "CL.x" }), true);
});

test("formatSelector round-trips rel selectors to the input verb", () => {
  assert.equal(formatSelector({ kind: "rel", verb: "owns", target: "CL.x" }), "owns:CL.x");
  // Aliases preserve the operator's spelling — owned-by stays owned-by.
  assert.equal(formatSelector({ kind: "rel", verb: "owned-by", target: "CL.x" }), "owned-by:CL.x");
  assert.equal(formatSelector({ kind: "rel", verb: "reports-to", target: "CL.x" }), "reports-to:CL.x");
  assert.equal(formatSelector({ kind: "rel", verb: "children-of", target: "CL.x" }), "children-of:CL.x");
  assert.equal(formatSelector({ kind: "rel", verb: "forks-of", target: "CL.x" }), "forks-of:CL.x");
});
