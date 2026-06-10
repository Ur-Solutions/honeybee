import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSyncManifest, reconcileSessions, sessionIndexPath } from "../src/reconcile.js";

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-reconcile-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
}

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("reconcile indexes claude+codex sessions across homes and flags duplicates/conflicts", async () => {
  await withTempStore(async (dir) => {
    // claude home 1 and 2 share UUID_A (a session resumed in two homes).
    const home1 = join(dir, "claude-1");
    const home2 = join(dir, "claude-2");
    await mkdir(join(home1, "projects", "-Users-x-proj"), { recursive: true });
    await mkdir(join(home2, "projects", "-Users-x-proj"), { recursive: true });
    await writeFile(join(home1, "projects", "-Users-x-proj", `${UUID_A}.jsonl`), "{}\n");
    await writeFile(join(home2, "projects", "-Users-x-proj", `${UUID_A}.jsonl`), "{}\n");
    await writeFile(join(home2, "projects", "-Users-x-proj", `${UUID_B}.jsonl`), "{}\n");
    await writeFile(
      join(home2, "projects", "-Users-x-proj", `${UUID_B}.sync-conflict-20260610.jsonl`),
      "{}\n",
    );

    // codex home with a rollout file embedding its uuid.
    const codexHome = join(dir, "codex-1");
    await mkdir(join(codexHome, "sessions", "2026", "06"), { recursive: true });
    await writeFile(join(codexHome, "sessions", "2026", "06", `rollout-2026-06-10-${UUID_B}.jsonl`), "{}\n");

    const index = await reconcileSessions({ homes: [home1, home2, codexHome] });

    assert.equal(index.entries.length, 4);
    assert.deepEqual(new Set(index.entries.map((entry) => entry.provider)), new Set(["claude", "codex"]));

    // UUID_A appears in two claude homes → duplicate. UUID_B appears in a
    // claude home and a codex home → also surfaced (cross-home same id).
    const duplicateIds = index.duplicates.map((duplicate) => duplicate.sessionId).sort();
    assert.deepEqual(duplicateIds, [UUID_A, UUID_B].sort());

    assert.equal(index.conflicts.length, 1);
    assert.match(index.conflicts[0]!, /sync-conflict/);

    // The unified index is persisted for retrieval.
    const persisted = JSON.parse(await readFile(sessionIndexPath(), "utf8")) as { entries: unknown[] };
    assert.equal(persisted.entries.length, 4);
  });
});

test("reconcile with no homes produces an empty index", async () => {
  await withTempStore(async () => {
    const index = await reconcileSessions({ homes: [] });
    assert.deepEqual(index.entries, []);
    assert.deepEqual(index.duplicates, []);
    assert.deepEqual(index.conflicts, []);
  });
});

test("sync manifest always excludes the vault and credential files", () => {
  const manifest = buildSyncManifest();
  assert.ok(manifest.exclude.includes("~/.hive/vault/**"));
  assert.ok(manifest.exclude.includes("**/.credentials.json"));
  assert.ok(manifest.exclude.includes("**/auth.json"));
  assert.ok(manifest.exclude.some((pattern) => pattern.includes("sync-conflict")));
  assert.ok(manifest.include.includes("~/.hive/**"));
});
