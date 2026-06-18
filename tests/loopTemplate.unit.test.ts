// CRUD coverage for loop templates (src/loopTemplate.ts): the saved presets
// behind `hive loop launch`. Mirrors tests/workspace.unit.test.ts — a temp
// HIVE_STORE_ROOT per test, the validate-before-path-join discipline, the
// defensive reader that drops stem-mismatched / malformed records, and the
// sanitizer that keeps only well-formed fields.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listLoopTemplates,
  loadLoopTemplate,
  loopTemplatesDir,
  removeLoopTemplate,
  saveLoopTemplate,
  validLoopTemplateName,
} from "../src/loopTemplate.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-loop-template-"));
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

test("validLoopTemplateName accepts identifiers and rejects unsafe characters", () => {
  assert.equal(validLoopTemplateName("nightly"), true);
  assert.equal(validLoopTemplateName("review-2026"), true);
  assert.equal(validLoopTemplateName("ops_team"), true);
  assert.equal(validLoopTemplateName("../escape"), false);
  assert.equal(validLoopTemplateName(""), false);
  assert.equal(validLoopTemplateName("-leading-dash"), false);
  assert.equal(validLoopTemplateName("bad name"), false);
});

test("save/load/list/remove round-trip", async () => {
  await withTempStore(async () => {
    const record = await saveLoopTemplate({
      name: "nightly",
      prompt: "keep the build green",
      bee: "claude-auto",
      context: "ralph",
      max: "10",
      forever: false,
      yolo: true,
    });
    assert.equal(record.name, "nightly");
    assert.equal(record.prompt, "keep the build green");
    assert.equal(record.bee, "claude-auto");
    assert.equal(record.context, "ralph");
    assert.equal(record.max, "10");
    assert.equal(record.yolo, true);
    assert.equal(record.forever, undefined, "false booleans are not stored");
    assert.ok(record.createdAt);
    assert.ok(record.updatedAt);

    const loaded = await loadLoopTemplate("nightly");
    assert.deepEqual(loaded, record);

    const list = await listLoopTemplates();
    assert.deepEqual(list.map((t) => t.name), ["nightly"]);

    assert.equal(await removeLoopTemplate("nightly"), true);
    assert.equal(await loadLoopTemplate("nightly"), null);
    assert.deepEqual(await listLoopTemplates(), []);
    assert.equal(await removeLoopTemplate("nightly"), false, "removing twice is idempotent");
  });
});

test("save overwrites (preset semantics) and preserves createdAt", async () => {
  await withTempStore(async () => {
    const first = await saveLoopTemplate({ name: "dup", prompt: "v1" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await saveLoopTemplate({ name: "dup", prompt: "v2", context: "rolling" });
    assert.equal(second.prompt, "v2");
    assert.equal(second.context, "rolling");
    assert.equal(second.createdAt, first.createdAt, "createdAt is preserved across overwrite");
    assert.notEqual(second.updatedAt, first.updatedAt, "updatedAt bumps");
    const list = await listLoopTemplates();
    assert.equal(list.length, 1, "overwrite, not duplicate");
  });
});

test("save rejects invalid names and empty prompts", async () => {
  await withTempStore(async () => {
    await assert.rejects(saveLoopTemplate({ name: "../escape", prompt: "x" }), /Invalid loop template name/);
    await assert.rejects(saveLoopTemplate({ name: "ok", prompt: "" }), /needs a prompt/);
    await assert.rejects(saveLoopTemplate({ name: "ok", prompt: "   " }), /needs a prompt/);
  });
});

test("loadLoopTemplate rejects path-traversal names without touching the filesystem", async () => {
  await withTempStore(async () => {
    assert.equal(await loadLoopTemplate("../escape"), null);
    assert.equal(await loadLoopTemplate("nested/path"), null);
  });
});

test("listLoopTemplates skips records whose embedded name disagrees with the file stem", async () => {
  await withTempStore(async () => {
    await saveLoopTemplate({ name: "real", prompt: "go" });
    await mkdir(loopTemplatesDir(), { recursive: true });
    await writeFile(
      join(loopTemplatesDir(), "imposter.json"),
      JSON.stringify({ name: "real", prompt: "go", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
    );
    const list = await listLoopTemplates();
    assert.deepEqual(list.map((t) => t.name), ["real"]);
  });
});

test("the defensive reader drops malformed fields, keeping only well-formed ones", async () => {
  await withTempStore(async () => {
    await mkdir(loopTemplatesDir(), { recursive: true });
    await writeFile(
      join(loopTemplatesDir(), "messy.json"),
      JSON.stringify({
        name: "messy",
        prompt: "do the thing",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        context: "ralph",
        max: 10, // wrong type (number) → dropped
        forever: "yes", // not strictly true → dropped
        yolo: true, // kept
        bogus: "field", // unknown → dropped
      }),
    );
    const loaded = await loadLoopTemplate("messy");
    assert.ok(loaded);
    assert.equal(loaded!.context, "ralph");
    assert.equal(loaded!.max, undefined, "non-string max dropped");
    assert.equal(loaded!.forever, undefined, "non-true forever dropped");
    assert.equal(loaded!.yolo, true);
    assert.equal((loaded as Record<string, unknown>).bogus, undefined, "unknown field dropped");
  });
});

test("sanitize keeps only well-formed fields when saving", async () => {
  await withTempStore(async () => {
    const record = await saveLoopTemplate({
      name: "clean",
      prompt: "p",
      bee: "", // empty string → dropped
      until: "test -f done",
      forever: false, // false → dropped
      yolo: true,
    } as never);
    assert.equal(record.bee, undefined, "empty string field dropped");
    assert.equal(record.until, "test -f done");
    assert.equal(record.forever, undefined);
    assert.equal(record.yolo, true);
  });
});
