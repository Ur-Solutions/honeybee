import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beesTuiSearchText,
  filterBeesTuiItems,
  flattenBeesTuiGroups,
  groupBeesByMode,
  groupBeesTuiItems,
  nextBeesGroupMode,
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

test("nextBeesGroupMode cycles forward and wraps, and goes backward", () => {
  assert.equal(nextBeesGroupMode("colony", 1), "pro-repo");
  assert.equal(nextBeesGroupMode("type", 1), "colony");
  assert.equal(nextBeesGroupMode("colony", -1), "type");
});

test("sidebar width clamp stays in tmux-friendly bounds", () => {
  assert.equal(__testOnlySidebarWidthClamp(5), 12);
  assert.equal(__testOnlySidebarWidthClamp(28), 28);
  assert.equal(__testOnlySidebarWidthClamp(80), 38);
});