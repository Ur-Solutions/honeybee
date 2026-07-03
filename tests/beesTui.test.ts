import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beesCatalogSignature,
  beesTuiSearchText,
  canNarrowBeesFilter,
  filterBeesTuiItems,
  flattenBeesTuiGroups,
  groupBeesByMode,
  groupBeesTuiItems,
  initialBeesCursor,
  nextBeesGroupMode,
  resolveRegroupCursor,
  type BeesTuiItem,
} from "../src/beesTui.js";
import { __testOnlySidebarWidthClamp } from "../src/beesSidebar.js";

function item(overrides: Partial<BeesTuiItem> & Pick<BeesTuiItem, "name">): BeesTuiItem {
  const base: BeesTuiItem = {
    name: overrides.name,
    ref: overrides.ref ?? overrides.name,
    displayName: overrides.displayName ?? overrides.name,
    colony: overrides.colony ?? "",
    swarmId: overrides.swarmId ?? "",
    agent: overrides.agent ?? "claude",
    cwd: overrides.cwd ?? "~/app",
    stateLabel: overrides.stateLabel ?? "active",
    stateHeadline: overrides.stateHeadline ?? "working",
    detail: overrides.detail ?? "",
    age: overrides.age ?? "1m",
    tmuxTarget: overrides.tmuxTarget ?? overrides.name,
    live: overrides.live ?? true,
    searchText: overrides.searchText ?? beesTuiSearchText({
      name: overrides.name,
      displayName: overrides.displayName ?? overrides.name,
      colony: overrides.colony,
      swarmId: overrides.swarmId,
      agent: overrides.agent ?? "claude",
      cwd: overrides.cwd ?? "~/app",
      detail: overrides.detail ?? "",
      ref: overrides.ref ?? overrides.name,
    }),
  };
  return { ...base, ...overrides, searchText: overrides.searchText ?? base.searchText };
}

test("groupBeesTuiItems nests colony then swarm with ungrouped last", () => {
  const groups = groupBeesTuiItems([
    item({ name: "b1", colony: "fe", swarmId: "t2" }),
    item({ name: "a1", colony: "fe", swarmId: "t1" }),
    item({ name: "solo", colony: "fe" }),
    item({ name: "orphan" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.label),
    ["fe · @t1", "fe · @t2", "fe · solo", "ungrouped"],
  );
});

test("flattenBeesTuiGroups inserts headers before items", () => {
  const groups = groupBeesTuiItems([item({ name: "x", colony: "c" })]);
  const flat = flattenBeesTuiGroups(groups);
  assert.equal(flat[0]?.kind, "header");
  assert.equal(flat[1]?.kind, "item");
});

test("filterBeesTuiItems fuzzy-matches title and colony", () => {
  const rows = [
    item({ name: "CL-1", displayName: "auth review", colony: "fe" }),
    item({ name: "CL-2", displayName: "billing", colony: "ops" }),
  ];
  const out = filterBeesTuiItems(rows, "auth");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "CL-1");
});

test("beesCatalogSignature changes when a bee is renamed", () => {
  const before = [item({ name: "CL-1", displayName: "old title" }), item({ name: "CL-2" })];
  const after = [item({ name: "CL-1", displayName: "new title" }), item({ name: "CL-2" })];
  assert.notEqual(beesCatalogSignature(before), beesCatalogSignature(after));
});

test("beesCatalogSignature is stable when only age drifts", () => {
  const a = [item({ name: "CL-1", age: "1m" })];
  const b = [item({ name: "CL-1", age: "9m" })];
  assert.equal(beesCatalogSignature(a), beesCatalogSignature(b));
});

test("beesCatalogSignature reflects spawn, kill, and state changes", () => {
  const base = [item({ name: "CL-1", stateHeadline: "working" })];
  assert.notEqual(beesCatalogSignature(base), beesCatalogSignature([...base, item({ name: "CL-2" })]), "spawn");
  assert.notEqual(beesCatalogSignature(base), beesCatalogSignature([]), "kill");
  assert.notEqual(
    beesCatalogSignature(base),
    beesCatalogSignature([item({ name: "CL-1", stateHeadline: "waiting" })]),
    "state change",
  );
});

test("beesCatalogSignature does not collide across field boundaries", () => {
  // Adjacent fields must not be ambiguous: ("ab","c") vs ("a","bc").
  const a = [item({ name: "ab", displayName: "c" })];
  const b = [item({ name: "a", displayName: "bc" })];
  assert.notEqual(beesCatalogSignature(a), beesCatalogSignature(b));
});

test("groupBeesByMode type buckets by agent, no-agent last", () => {
  const groups = groupBeesByMode([
    item({ name: "a", agent: "codex" }),
    item({ name: "b", agent: "claude" }),
    item({ name: "c", agent: "codex" }),
    item({ name: "d", agent: "" }),
  ], "type");
  assert.deepEqual(groups.map((g) => g.label), ["claude", "codex", "no agent"]);
  assert.deepEqual(groups.find((g) => g.label === "codex")!.items.map((i) => i.name).sort(), ["a", "c"]);
});

test("groupBeesByMode pro-repo groups by project/repo and buckets unmapped", () => {
  const groups = groupBeesByMode([
    item({ name: "a", proProject: "oss/forge", proRepo: "forge", proArea: "oss" }),
    item({ name: "b", proProject: "oss/forge", proRepo: "forge", proArea: "oss" }),
    item({ name: "c" }),
  ], "pro-repo");
  assert.deepEqual(groups.map((g) => g.label), ["oss/forge · forge", "no pro repo"]);
});

test("groupBeesByMode pro-repo keeps worktree/checkout bees in the canonical repo's bucket", () => {
  const groups = groupBeesByMode([
    item({ name: "canon", proProject: "digitech/digitech", proRepo: "next", proArea: "digitech" }),
    item({ name: "wt", proProject: "digitech/digitech", proRepo: "next", proArea: "digitech", proSlotKind: "worktree", proSlotName: "unimicro" }),
    item({ name: "co", proProject: "digitech/digitech", proRepo: "next", proArea: "digitech", proSlotKind: "checkout", proSlotName: "release" }),
  ], "pro-repo");
  assert.deepEqual(groups.map((g) => g.label), ["digitech/digitech · next"]);
  assert.deepEqual(groups[0]!.items.map((i) => i.name).sort(), ["canon", "co", "wt"]);
});

test("beesTuiSearchText indexes the slot name so a worktree filters by it", () => {
  const rows = [
    item({
      name: "wt-bee",
      proSlotKind: "worktree",
      proSlotName: "unimicro-integration",
      searchText: beesTuiSearchText({ name: "wt-bee", displayName: "wt-bee", agent: "claude", cwd: "~/app", detail: "", ref: "wt-bee", slot: "unimicro-integration" }),
    }),
    item({ name: "other" }),
  ];
  const out = filterBeesTuiItems(rows, "unimicro");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "wt-bee");
});

test("groupBeesByMode pro-area groups by area", () => {
  const groups = groupBeesByMode([
    item({ name: "a", proArea: "oss" }),
    item({ name: "b", proArea: "digitech" }),
    item({ name: "c", proArea: "oss" }),
  ], "pro-area");
  assert.deepEqual(groups.map((g) => g.label), ["digitech", "oss"]);
});

test("groupBeesByMode folder groups by cwd", () => {
  const groups = groupBeesByMode([
    item({ name: "a", cwd: "/x/one" }),
    item({ name: "b", cwd: "/x/two" }),
    item({ name: "c", cwd: "/x/one" }),
  ], "folder");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.flatMap((g) => g.items).length, 3);
});

test("initialBeesCursor selects the named bee's row, else the first item", () => {
  const flat = flattenBeesTuiGroups(groupBeesTuiItems([
    item({ name: "a", colony: "c" }),
    item({ name: "b", colony: "c" }),
  ]));
  const rowOf = (name: string) => flat.findIndex((row) => row.kind === "item" && row.item.name === name);
  const firstItem = flat.findIndex((row) => row.kind === "item");
  assert.equal(initialBeesCursor(flat, "b"), rowOf("b"));
  assert.equal(initialBeesCursor(flat, "a"), rowOf("a"));
  assert.equal(initialBeesCursor(flat, "gone"), firstItem); // not in list → first item
  assert.equal(initialBeesCursor(flat, undefined), firstItem); // no current bee → first item
});

test("resolveRegroupCursor keeps the survivor, else the current bee, else first", () => {
  const flat = flattenBeesTuiGroups(groupBeesTuiItems([
    item({ name: "a", colony: "c" }),
    item({ name: "b", colony: "c" }),
    item({ name: "home", colony: "c" }),
  ]));
  const rowOf = (name: string) => flat.findIndex((row) => row.kind === "item" && row.item.name === name);
  const firstItem = flat.findIndex((row) => row.kind === "item");
  // Highlight survived the regroup → stay on it.
  assert.equal(resolveRegroupCursor(flat, "b", "home"), rowOf("b"));
  // Highlighted bee gone (e.g. just killed) → fall back to the current-window bee.
  assert.equal(resolveRegroupCursor(flat, "killed", "home"), rowOf("home"));
  // Neither resolves → first item.
  assert.equal(resolveRegroupCursor(flat, "killed", "also-gone"), firstItem);
  assert.equal(resolveRegroupCursor(flat, undefined, undefined), firstItem);
});

test("nextBeesGroupMode cycles forward and wraps, and goes backward", () => {
  assert.equal(nextBeesGroupMode("colony", 1), "pro-repo");
  assert.equal(nextBeesGroupMode("type", 1), "colony");
  assert.equal(nextBeesGroupMode("colony", -1), "type");
});

test("sidebar width clamp stays in tmux-friendly bounds", () => {
  assert.equal(__testOnlySidebarWidthClamp(5), 12);
  assert.equal(__testOnlySidebarWidthClamp(54), 54);
  assert.equal(__testOnlySidebarWidthClamp(80), 72);
});

test("canNarrowBeesFilter allows short prefix extensions only", () => {
  assert.equal(canNarrowBeesFilter("a", "au"), true);
  assert.equal(canNarrowBeesFilter("au", "aut"), true);
  assert.equal(canNarrowBeesFilter("aut", "auth"), true);
  // 5 effective chars: fuzzyScore's sparse-match cap starts growing with the
  // query, so "matches next ⇒ matches prev" no longer holds.
  assert.equal(canNarrowBeesFilter("auth", "authx"), false);
  // Not extensions.
  assert.equal(canNarrowBeesFilter("ab", "ba"), false);
  assert.equal(canNarrowBeesFilter("ab", "ab"), false);
  assert.equal(canNarrowBeesFilter("abc", "ab"), false);
  // An empty previous pass matched everything — nothing to narrow from.
  assert.equal(canNarrowBeesFilter("", "a"), false);
  // Compared on the effective (trimmed, lowercased) query like fuzzyFilter.
  assert.equal(canNarrowBeesFilter("A", "ab "), true);
});

test("narrowing from the previous match set equals filtering the catalog", () => {
  const rows = [
    item({ name: "auth-api", colony: "backend" }),
    item({ name: "authz", colony: "backend" }),
    item({ name: "cart", colony: "shop" }),
    item({ name: "atlas-utils", colony: "infra" }),
    item({ name: "worker", colony: "queue" }),
  ];
  let prev = "";
  let pool = rows;
  for (const query of ["a", "au", "aut", "auth"]) {
    const full = filterBeesTuiItems(rows, query);
    if (canNarrowBeesFilter(prev, query)) {
      assert.deepEqual(filterBeesTuiItems(pool, query).map((r) => r.name), full.map((r) => r.name), `query "${query}"`);
    }
    prev = query;
    pool = full;
  }
});

test("fuzzy match is non-monotone past 4 chars — why canNarrowBeesFilter caps there", () => {
  // Greedy match of "abcd" spans 14 chars (gaps 10 > cap 8) → rejected; the
  // 5-char "abcde" raises the cap to 10 and the same span passes.
  const sparse = item({ name: "sparse", searchText: "axxxxxxxxxxbcde" });
  assert.equal(filterBeesTuiItems([sparse], "abcd").length, 0);
  assert.equal(filterBeesTuiItems([sparse], "abcde").length, 1);
});