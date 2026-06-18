import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createQuest,
  generateQuestId,
  listQuests,
  loadQuest,
  questDir,
  questFile,
  updateQuest,
  validQuestId,
} from "../src/quest.js";
import { ledgerPath } from "../src/store.js";
import { HiveFacade } from "../src/flow/hive_facade.js";

// quest start --flow reconstructs the flow's cohort swarmId as
// `flow:<name>:run:<runId>` (rather than reading it off a bee, so a zero-spawn
// flow still records the cohort). This must stay byte-identical to the facade's
// own default — assert against the real HiveFacade so a future rename of the
// facade's scheme breaks loudly here instead of silently desyncing quest.swarmIds.
test("quest --flow swarmId reconstruction matches HiveFacade.defaultSwarmId", () => {
  const flowName = "review";
  const runId = "20240101-abcd";
  const reconstructed = `flow:${flowName}:run:${runId}`;
  const facade = new HiveFacade({ flowName, runId });
  assert.equal(reconstructed, facade.defaultSwarmId);
});

async function ledgerTypes(): Promise<string[]> {
  const raw = await readFile(ledgerPath(), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type?: string }).type ?? "");
}

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-quest-"));
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

test("generateQuestId produces a valid <prefix>-<hex> token", () => {
  const id = generateQuestId();
  assert.match(id, /^q-[0-9a-f]{6}$/, "default prefix q + 6 hex chars");
  assert.equal(validQuestId(id), true);

  const custom = generateQuestId("review");
  assert.match(custom, /^review-[0-9a-f]{6}$/);
  assert.equal(validQuestId(custom), true);

  // An unsafe prefix is rejected → falls back to "q".
  const fallback = generateQuestId("../bad");
  assert.match(fallback, /^q-[0-9a-f]{6}$/, "unsafe prefix falls back to q");
});

test("validQuestId accepts ids and rejects path-traversal", () => {
  assert.equal(validQuestId("q-abc123"), true);
  assert.equal(validQuestId("review-2026.1"), true);
  assert.equal(validQuestId("../escape"), false);
  assert.equal(validQuestId("nested/path"), false);
  assert.equal(validQuestId(""), false);
  assert.equal(validQuestId("-leading-dash"), false);
});

test("createQuest writes quests/<id>/quest.json and listQuests returns it", async () => {
  await withTempStore(async () => {
    const record = await createQuest({
      id: "q-aaa111",
      title: "review #1255",
      colony: "reviews",
      workspace: "q-aaa111",
      status: "open",
      linearIssueId: "ENG-1234",
    });
    assert.equal(record.id, "q-aaa111");
    assert.equal(record.title, "review #1255");
    assert.equal(record.colony, "reviews");
    assert.equal(record.workspace, "q-aaa111");
    assert.equal(record.status, "open");
    assert.deepEqual(record.swarmIds, []);
    assert.equal(record.linearIssueId, "ENG-1234");
    assert.ok(record.createdAt);

    // The record lives in its own directory.
    const raw = JSON.parse(await readFile(questFile("q-aaa111"), "utf8")) as { id: string };
    assert.equal(raw.id, "q-aaa111");

    const list = await listQuests();
    assert.deepEqual(list.map((q) => q.id), ["q-aaa111"]);
  });
});

test("createQuest refuses duplicate ids and invalid ids", async () => {
  await withTempStore(async () => {
    await createQuest({ id: "q-dup", title: "t", colony: "c", workspace: "q-dup" });
    await assert.rejects(createQuest({ id: "q-dup", title: "t", colony: "c", workspace: "q-dup" }), /already exists/);
    await assert.rejects(createQuest({ id: "../escape", title: "t", colony: "c", workspace: "x" }), /Invalid quest id/);
  });
});

test("loadQuest rejects path-traversal ids without touching the filesystem", async () => {
  await withTempStore(async () => {
    assert.equal(await loadQuest("../escape"), null);
    assert.equal(await loadQuest("nested/path"), null);
    assert.equal(await loadQuest("ghost"), null);
  });
});

test("updateQuest patches status/swarmIds/activatedAt/description/linear", async () => {
  await withTempStore(async () => {
    await createQuest({ id: "q-up", title: "t", colony: "c", workspace: "q-up", status: "open" });
    const at = "2026-06-17T00:00:00.000Z";
    const updated = await updateQuest("q-up", {
      status: "active",
      swarmIds: ["s1", "s2", "s1"], // deduped on write
      activatedAt: at,
      description: "now working",
      linearIssueId: "ENG-9",
    });
    assert.equal(updated.status, "active");
    assert.deepEqual(updated.swarmIds, ["s1", "s2"], "swarmIds deduped");
    assert.equal(updated.activatedAt, at);
    assert.equal(updated.description, "now working");
    assert.equal(updated.linearIssueId, "ENG-9");

    const reloaded = await loadQuest("q-up");
    assert.equal(reloaded?.status, "active");
    assert.deepEqual(reloaded?.swarmIds, ["s1", "s2"]);

    // Clearing a string field with "" removes it.
    const cleared = await updateQuest("q-up", { description: "", linearIssueId: "" });
    assert.equal(cleared.description, undefined);
    assert.equal(cleared.linearIssueId, undefined);

    await assert.rejects(updateQuest("q-ghost", { status: "active" }), /Unknown quest/);
  });
});

test("readQuest drops a record whose embedded id disagrees with its directory name", async () => {
  await withTempStore(async () => {
    await createQuest({ id: "q-real", title: "t", colony: "c", workspace: "q-real" });

    // Plant an imposter directory whose quest.json claims a different id.
    const dir = process.env.HIVE_STORE_ROOT!;
    await mkdir(join(dir, "quests", "q-imposter"), { recursive: true });
    await writeFile(
      join(dir, "quests", "q-imposter", "quest.json"),
      JSON.stringify({
        id: "q-real", // embedded id != directory name → debris
        title: "t",
        colony: "c",
        workspace: "q-real",
        status: "open",
        swarmIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const list = await listQuests();
    assert.deepEqual(list.map((q) => q.id), ["q-real"], "imposter dropped, real kept");

    // loadQuest on the imposter id surfaces the debris (mismatch) rather than
    // silently returning it — same discipline as readWorkspace/readColony, where
    // only ENOENT maps to null and a name/id mismatch is a hard signal.
    await assert.rejects(loadQuest("q-imposter"), /does not match directory name/);
  });
});

test("listQuests skips a malformed record and survives garbage in the dir", async () => {
  await withTempStore(async () => {
    await createQuest({ id: "q-ok", title: "t", colony: "c", workspace: "q-ok" });

    const dir = process.env.HIVE_STORE_ROOT!;
    // A directory with a malformed quest.json (missing required fields).
    await mkdir(join(dir, "quests", "q-broken"), { recursive: true });
    await writeFile(join(dir, "quests", "q-broken", "quest.json"), JSON.stringify({ id: "q-broken" }));
    // A stray file (not a directory) must not break the listing.
    await writeFile(join(dir, "quests", "stray.txt"), "noise");

    const list = await listQuests();
    assert.deepEqual(list.map((q) => q.id), ["q-ok"], "only the well-formed quest is returned");
  });
});

test("questFile/questDir compose the per-quest directory path", async () => {
  await withTempStore(async () => {
    const dir = process.env.HIVE_STORE_ROOT!;
    assert.equal(questDir("q-x"), join(dir, "quests", "q-x"));
    assert.equal(questFile("q-x"), join(dir, "quests", "q-x", "quest.json"));
  });
});

test("updateQuest persists completedAt on done and emits a quest.done ledger event", async () => {
  await withTempStore(async () => {
    await createQuest({ id: "q-done", title: "t", colony: "c", workspace: "q-done", status: "active" });
    const at = "2026-06-17T01:00:00.000Z";
    const updated = await updateQuest("q-done", { status: "done", completedAt: at });
    assert.equal(updated.status, "done");
    assert.equal(updated.completedAt, at, "completedAt persisted on the returned record");

    const reloaded = await loadQuest("q-done");
    assert.equal(reloaded?.completedAt, at, "completedAt reads back from disk");

    const types = await ledgerTypes();
    assert.ok(types.includes("quest.done"), "a distinct quest.done ledger event was emitted");
    assert.ok(!types.includes("quest.archive"), "no quest.archive event yet");
  });
});

test("updateQuest persists archivedAt on archive and emits a quest.archive ledger event", async () => {
  await withTempStore(async () => {
    await createQuest({ id: "q-arch", title: "t", colony: "c", workspace: "q-arch", status: "done" });
    const at = "2026-06-17T02:00:00.000Z";
    const updated = await updateQuest("q-arch", { status: "archived", archivedAt: at });
    assert.equal(updated.status, "archived");
    assert.equal(updated.archivedAt, at, "archivedAt persisted on the returned record");

    const reloaded = await loadQuest("q-arch");
    assert.equal(reloaded?.archivedAt, at, "archivedAt reads back from disk");

    const types = await ledgerTypes();
    assert.ok(types.includes("quest.archive"), "a distinct quest.archive ledger event was emitted");
  });
});
