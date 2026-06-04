import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSwarm, destroySwarm, generateSwarmId, listSwarms, loadSwarm, removeSwarmRecord, swarmIds, validSwarmId } from "../src/swarm.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-swarm-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("validSwarmId accepts simple identifiers and rejects unsafe characters", () => {
  assert.equal(validSwarmId("deep-review-7a3f2c"), true);
  assert.equal(validSwarmId("swarm-001"), true);
  assert.equal(validSwarmId("../escape"), false);
  assert.equal(validSwarmId(""), false);
});

test("generateSwarmId returns prefixed unique-ish ids", () => {
  const a = generateSwarmId();
  const b = generateSwarmId();
  assert.ok(a.startsWith("swarm-"));
  assert.notEqual(a, b);
  const named = generateSwarmId("deep-review");
  assert.ok(named.startsWith("deep-review-"));
});

test("createSwarm writes a record and listSwarms returns it newest-first", async () => {
  await withTempStore(async () => {
    const first = await createSwarm({ id: "alpha", beeIds: ["CO.aaa", "CO.bbb"], frame: "deep-review" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await createSwarm({ id: "beta", beeIds: ["CO.ccc"], colony: "ops" });

    const list = await listSwarms();
    assert.deepEqual(list.map((s) => s.id), [second.id, first.id]);
    assert.equal(list[1]!.frame, "deep-review");
    assert.equal(list[0]!.colony, "ops");
  });
});

test("createSwarm refuses duplicate ids", async () => {
  await withTempStore(async () => {
    await createSwarm({ id: "dup", beeIds: [] });
    await assert.rejects(createSwarm({ id: "dup", beeIds: [] }), /already exists/);
  });
});

test("destroySwarm marks the record and is idempotent", async () => {
  await withTempStore(async () => {
    await createSwarm({ id: "gone", beeIds: ["x"] });
    const destroyed = await destroySwarm("gone");
    assert.equal(destroyed.destroyed, true);
    assert.ok(destroyed.destroyedAt);
    const again = await destroySwarm("gone");
    assert.equal(destroyed.destroyedAt, again.destroyedAt);
  });
});

test("destroySwarm rejects unknown swarms", async () => {
  await withTempStore(async () => {
    await assert.rejects(destroySwarm("nope"), /Unknown swarm/);
  });
});

test("swarmIds reflects all known ids", async () => {
  await withTempStore(async () => {
    await createSwarm({ id: "a", beeIds: [] });
    await createSwarm({ id: "b", beeIds: [] });
    const ids = await swarmIds();
    assert.deepEqual([...ids].sort(), ["a", "b"]);
  });
});

test("removeSwarmRecord deletes the file", async () => {
  await withTempStore(async () => {
    await createSwarm({ id: "tmp", beeIds: [] });
    await removeSwarmRecord("tmp");
    assert.equal(await loadSwarm("tmp"), null);
  });
});
