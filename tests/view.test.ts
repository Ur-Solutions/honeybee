import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveViewName, parseWindowInventory, planViewLinks, viewSessionName } from "../src/view.js";

test("deriveViewName strips selector syntax and sanitizes", () => {
  assert.equal(deriveViewName("@t1"), "t1");
  assert.equal(deriveViewName("colony:fe-review"), "fe-review");
  assert.equal(deriveViewName("CL.3e1"), "CL-3e1");
  assert.throws(() => deriveViewName("@"), /Cannot derive/);
});

test("viewSessionName prefixes and accepts the already-prefixed form", () => {
  assert.equal(viewSessionName("t1"), "view-t1");
  assert.equal(viewSessionName("view-t1"), "view-t1");
  assert.throws(() => viewSessionName("bad name"), /Invalid view name/);
});

test("parseWindowInventory maps sessions to windows and active window", () => {
  const inventory = parseWindowInventory(
    ["CL-a\t@1\t1", "CL-b\t@2\t1", "view-t\t@9\t1", "view-t\t@1\t0", ""].join("\n"),
  );
  assert.deepEqual(inventory.windows.get("view-t"), ["@9", "@1"]);
  assert.equal(inventory.active.get("CL-a"), "@1");
  assert.equal(inventory.active.get("view-t"), "@9");
});

test("planViewLinks links only windows not already in the view", () => {
  const bees = [
    { session: "CL-a", windowId: "@1" },
    { session: "CL-b", windowId: "@2" },
    { session: "CL-c", windowId: "@3" },
  ];
  // Re-running view on a grown swarm links only the new bee.
  assert.deepEqual(planViewLinks(["@1", "@2"], bees), [{ session: "CL-c", windowId: "@3" }]);
  assert.deepEqual(planViewLinks([], bees), bees);
  assert.deepEqual(planViewLinks(["@1", "@2", "@3"], bees), []);
});
