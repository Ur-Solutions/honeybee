import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetTree, fleetDescendants, flattenFleet, parentEdgeOf } from "../src/fleet.js";
import type { SessionRecord } from "../src/store.js";

let seq = 0;
function rec(name: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  seq += 1;
  return {
    name,
    agent: "claude",
    cwd: "/x",
    command: "claude",
    tmuxTarget: name,
    createdAt: `2026-07-04T00:00:${String(seq).padStart(2, "0")}Z`,
    updatedAt: "2026-07-04T00:00:00Z",
    status: "running",
    id: name, // id == name keeps fixtures simple; edges may point at either
    ...extra,
  };
}

test("parentEdgeOf: spawned > reports-to > forked precedence", () => {
  assert.deepEqual(parentEdgeOf(rec("a", { spawnedById: "R", reportsToId: "X" })), { ref: "R", edge: "spawned" });
  assert.deepEqual(parentEdgeOf(rec("b", { reportsToId: "X" })), { ref: "X", edge: "reports-to" });
  assert.equal(parentEdgeOf(rec("c", { forkedFromId: "F" })), null); // forks off by default
  assert.deepEqual(parentEdgeOf(rec("c", { forkedFromId: "F" }), { includeForks: true }), { ref: "F", edge: "forked" });
  assert.equal(parentEdgeOf(rec("root")), null);
});

test("fleetTree: builds the descendant tree in createdAt order", () => {
  const R = rec("R");
  const A = rec("A", { spawnedById: "R" });
  const B = rec("B", { spawnedById: "R" });
  const C = rec("C", { spawnedById: "A" });
  const tree = fleetTree("R", [C, B, A, R]); // unordered input
  assert.ok(tree);
  assert.equal(tree!.record.name, "R");
  assert.deepEqual(tree!.children.map((n) => n.record.name), ["A", "B"]);
  assert.deepEqual(tree!.children[0]!.children.map((n) => n.record.name), ["C"]);
  assert.equal(tree!.children[0]!.children[0]!.depth, 2);

  // Flatten is DFS root-first; descendants excludes the root.
  assert.deepEqual(flattenFleet(tree!).map((n) => n.record.name), ["R", "A", "C", "B"]);
  assert.deepEqual(fleetDescendants("R", [C, B, A, R]).map((n) => n.record.name), ["A", "C", "B"]);
});

test("fleetTree: a child may point at the parent's id OR name", () => {
  const R = rec("orchestrator", { id: "CL.abc" });
  const child = rec("worker", { spawnedById: "CL.abc" }); // points at id
  const tree = fleetTree("orchestrator", [R, child]); // root looked up by name
  assert.deepEqual(tree!.children.map((n) => n.record.name), ["worker"]);
});

test("fleetTree: reports-to acts as a fallback parent edge", () => {
  const R = rec("R");
  const owned = rec("owned", { reportsToId: "R" });
  const tree = fleetTree("R", [R, owned]);
  assert.equal(tree!.children[0]!.record.name, "owned");
  assert.equal(tree!.children[0]!.edge, "reports-to");
});

test("fleetTree: cycles do not loop forever", () => {
  const A = rec("A", { spawnedById: "B" });
  const B = rec("B", { spawnedById: "A" });
  const tree = fleetTree("A", [A, B]);
  assert.ok(tree);
  // B attaches under A once; A is not re-attached under B (visited guard).
  assert.deepEqual(flattenFleet(tree!).map((n) => n.record.name), ["A", "B"]);
});

test("fleetTree: unknown root returns null", () => {
  assert.equal(fleetTree("nope", [rec("x")]), null);
  assert.deepEqual(fleetDescendants("nope", [rec("x")]), []);
});

test("fleetDescendants: multi-level fan-out", () => {
  const root = rec("root");
  const kids = [rec("k1", { spawnedById: "root" }), rec("k2", { spawnedById: "root" })];
  const grandkids = [rec("g1", { spawnedById: "k1" }), rec("g2", { spawnedById: "k1" }), rec("g3", { spawnedById: "k2" })];
  const all = [root, ...kids, ...grandkids];
  const names = fleetDescendants("root", all).map((n) => n.record.name);
  assert.equal(names.length, 5);
  assert.deepEqual(new Set(names), new Set(["k1", "k2", "g1", "g2", "g3"]));
  // k1's grandchildren come right after k1 (DFS).
  assert.deepEqual(names.slice(0, 3), ["k1", "g1", "g2"]);
});
