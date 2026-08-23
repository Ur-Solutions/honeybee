import { test } from "node:test";
import assert from "node:assert/strict";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("listBeeViewRows batches the same authoritative view, runtime, flags, and lifecycle filtering", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();

  const { bee: active } = makeBee(store, "active");
  bootToRunning(store, active.id, 101, 11);
  store.setFlag(active.id, "auth_needed", "sign in");
  store.setFlag(active.id, "resource_blocked", "quota");

  const { bee: archived } = makeBee(store, "archived");
  store.updateRuntimeState(archived.id, 1, "stopped", { exitCause: "clean" });
  store.archiveBee(archived.id);

  const activeRows = store.listBeeViewRows("active");
  assert.equal(activeRows.length, 1);
  assert.deepEqual(activeRows[0]?.bee, store.getBee(active.id));
  assert.deepEqual(activeRows[0]?.runtime, store.currentRuntime(active.id));
  assert.deepEqual(activeRows[0]?.view, store.view(active.id));
  assert.deepEqual(activeRows[0]?.view.flags, ["auth_needed", "resource_blocked"]);

  const archivedRows = store.listBeeViewRows("archived");
  assert.equal(archivedRows.length, 1);
  assert.equal(archivedRows[0]?.bee.id, archived.id);
  assert.deepEqual(archivedRows[0]?.view, store.view(archived.id));

  const allRows = store.listBeeViewRows();
  assert.deepEqual(allRows.map((row) => row.view), store.views());
  assert.deepEqual(store.listBeeViewRows("deleted"), []);
  store.close();
});
