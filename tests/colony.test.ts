import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archiveColony, colonyExists, createColony, listColonies, loadColony, renameColony, updateColony, validColonyName } from "../src/colony.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-colony-"));
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

test("validColonyName accepts simple identifiers and rejects unsafe characters", () => {
  assert.equal(validColonyName("marketing"), true);
  assert.equal(validColonyName("review-2026"), true);
  assert.equal(validColonyName("ops_team"), true);
  assert.equal(validColonyName("../escape"), false);
  assert.equal(validColonyName(""), false);
  assert.equal(validColonyName("-leading-dash"), false);
});

test("createColony writes a record and listColonies returns it", async () => {
  await withTempStore(async () => {
    const record = await createColony("marketing", "Outbound campaigns");
    assert.equal(record.name, "marketing");
    assert.equal(record.description, "Outbound campaigns");
    assert.ok(record.createdAt);
    assert.equal(await colonyExists("marketing"), true);

    const list = await listColonies();
    assert.deepEqual(list.map((r) => r.name), ["marketing"]);
  });
});

test("createColony refuses duplicate names", async () => {
  await withTempStore(async () => {
    await createColony("ops");
    await assert.rejects(createColony("ops"), /already exists/);
  });
});

test("archiveColony flips the archived flag and records archivedAt", async () => {
  await withTempStore(async () => {
    await createColony("legacy");
    const archived = await archiveColony("legacy");
    assert.equal(archived.archived, true);
    assert.ok(archived.archivedAt);

    const reloaded = await loadColony("legacy");
    assert.equal(reloaded?.archived, true);
  });
});

test("archiveColony is idempotent and refuses unknown colonies", async () => {
  await withTempStore(async () => {
    await createColony("idem");
    const first = await archiveColony("idem");
    const again = await archiveColony("idem");
    assert.equal(first.archivedAt, again.archivedAt);

    await assert.rejects(archiveColony("ghost"), /Unknown colony/);
  });
});

test("createColony rejects invalid names", async () => {
  await withTempStore(async () => {
    await assert.rejects(createColony("../escape"), /Invalid colony name/);
  });
});

test("updateColony writes description and clears it on empty string", async () => {
  await withTempStore(async () => {
    await createColony("alpha", "original");
    const updated = await updateColony("alpha", { description: "revised" });
    assert.equal(updated.description, "revised");

    const cleared = await updateColony("alpha", { description: "" });
    assert.equal(cleared.description, undefined);

    await assert.rejects(updateColony("ghost", { description: "x" }), /Unknown colony/);
  });
});

test("renameColony moves the record and refuses collisions", async () => {
  await withTempStore(async () => {
    await createColony("old", "desc");
    const renamed = await renameColony("old", "new");
    assert.equal(renamed.name, "new");
    assert.equal(renamed.description, "desc");
    assert.equal(await colonyExists("old"), false);
    assert.equal(await colonyExists("new"), true);

    await createColony("blocker");
    await assert.rejects(renameColony("new", "blocker"), /already exists/);
    await assert.rejects(renameColony("new", "../bad"), /Invalid colony name/);
    await assert.rejects(renameColony("ghost", "x"), /Unknown colony/);
  });
});

test("loadColony rejects path-traversal names without touching the filesystem", async () => {
  await withTempStore(async () => {
    assert.equal(await loadColony("../escape"), null);
    assert.equal(await loadColony("nested/path"), null);
    assert.equal(await colonyExists("../escape"), false);
  });
});

test("mutating colony ops validate the name before resolving paths", async () => {
  await withTempStore(async () => {
    await assert.rejects(updateColony("../bad", { description: "x" }), /Invalid colony name/);
    await assert.rejects(archiveColony("../bad"), /Invalid colony name/);
    await assert.rejects(renameColony("../bad", "ok"), /Invalid colony name/);
  });
});

test("concurrent createColony calls produce exactly one colony", async () => {
  await withTempStore(async () => {
    const results = await Promise.allSettled([
      createColony("contested"),
      createColony("contested"),
      createColony("contested"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1, `expected exactly one create to win, got ${fulfilled.length}`);
    const list = await listColonies();
    assert.deepEqual(list.map((record) => record.name), ["contested"]);
  });
});

test("listColonies skips records whose embedded name disagrees with the file stem", async () => {
  await withTempStore(async () => {
    await createColony("real");
    const { writeFile: write } = await import("node:fs/promises");
    const dir = process.env.HIVE_STORE_ROOT!;
    await write(
      join(dir, "colonies", "imposter.json"),
      JSON.stringify({ name: "real", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const list = await listColonies();
    assert.deepEqual(list.map((record) => record.name), ["real"]);
  });
});
