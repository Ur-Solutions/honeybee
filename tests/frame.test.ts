import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineFrameFromFile, frameDefinitionFile, frameExists, listFrames, loadFrame, loadFrameSource, removeFrame, validateFrame, writeFrameFromObject } from "../src/frame.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-frame-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const DEEP_REVIEW = {
  name: "deep-review",
  description: "Multi-role review cohort",
  castes: [
    { name: "architect", bee: "claude", count: 1, brief: "Read architecture." },
    { name: "reviewer", bee: "codex", count: 2, brief: "Walk the code." },
  ],
};

test("validateFrame accepts a well-formed frame", () => {
  const frame = validateFrame(DEEP_REVIEW);
  assert.equal(frame.name, "deep-review");
  assert.equal(frame.castes.length, 2);
  assert.equal(frame.castes[1]!.count, 2);
});

test("validateFrame rejects missing or empty castes", () => {
  assert.throws(() => validateFrame({ name: "broken", castes: [] }), /castes must be a non-empty array/);
  assert.throws(() => validateFrame({ name: "broken" }), /castes must be a non-empty array/);
});

test("validateFrame rejects bad caste shape", () => {
  assert.throws(
    () => validateFrame({ name: "bad", castes: [{ name: "x", bee: "", count: 1 }] }),
    /bee must be a non-empty string/,
  );
  assert.throws(
    () => validateFrame({ name: "bad", castes: [{ name: "x", bee: "claude", count: 0 }] }),
    /count must be a positive integer/,
  );
});

test("validateFrame enforces filename matches frame name", () => {
  assert.throws(
    () => validateFrame({ name: "actual", castes: [{ name: "x", bee: "claude", count: 1 }] }, "expected"),
    /Frame name mismatch/,
  );
});

test("defineFrameFromFile imports a JSON frame and listFrames returns it", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "incoming.json");
    await writeFile(source, JSON.stringify(DEEP_REVIEW));
    const defined = await defineFrameFromFile(source);
    assert.equal(defined.name, "deep-review");
    assert.equal(await frameExists("deep-review"), true);

    const list = await listFrames();
    assert.deepEqual(list.map((f) => f.name), ["deep-review"]);
  });
});

test("loadFrame round-trips JSON content", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify(DEEP_REVIEW));
    await defineFrameFromFile(source);
    const loaded = await loadFrame("deep-review");
    assert.equal(loaded?.castes[0]!.brief, "Read architecture.");
  });
});

test("removeFrame deletes both .ts and .json siblings if present", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify(DEEP_REVIEW));
    await defineFrameFromFile(source);
    assert.equal(await removeFrame("deep-review"), true);
    assert.equal(await loadFrame("deep-review"), null);
    assert.equal(await removeFrame("deep-review"), false);
  });
});

test("defineFrameFromFile renames the frame when nameOverride is supplied", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify(DEEP_REVIEW));
    const defined = await defineFrameFromFile(source, "house-style");
    assert.equal(defined.name, "house-style");
    assert.equal(await frameExists("house-style"), true);
    assert.equal(await frameExists("deep-review"), false);
  });
});

test("validateFrame accepts and validates caste home", () => {
  const frame = validateFrame({
    name: "homed",
    castes: [
      { name: "a", bee: "claude", count: 1, home: "2" },
      { name: "b", bee: "codex", count: 1 },
    ],
  });
  assert.equal(frame.castes[0]!.home, "2");
  assert.equal(frame.castes[1]!.home, undefined);

  assert.throws(
    () => validateFrame({ name: "bad", castes: [{ name: "x", bee: "claude", count: 1, home: "" }] }),
    /home must be a non-empty string/,
  );
});

test("defineFrameFromFile rejects unsupported extensions", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "frame.yaml");
    await writeFile(source, "name: x");
    await assert.rejects(defineFrameFromFile(source), /Unsupported frame source extension/);
  });
});

test("defineFrameFromFile remembers absolute source path for reload", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify(DEEP_REVIEW));
    await defineFrameFromFile(source);
    const remembered = await loadFrameSource("deep-review");
    assert.equal(remembered, source);

    assert.equal(await removeFrame("deep-review"), true);
    assert.equal(await loadFrameSource("deep-review"), null);
  });
});

test("loadFrame loads TS frames via dynamic import when tsx is active", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "tsframe.ts");
    await writeFile(
      source,
      `const frame = ${JSON.stringify(DEEP_REVIEW)}; export default frame;\n`,
    );
    const defined = await defineFrameFromFile(source);
    assert.equal(defined.name, "deep-review");
    const loaded = await loadFrame("deep-review");
    assert.equal(loaded?.castes[0]!.brief, "Read architecture.");
  });
});

test("defineFrameFromFile rejects a nameOverride that renames a .ts frame", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "tsframe.ts");
    await writeFile(source, `const frame = ${JSON.stringify(DEEP_REVIEW)}; export default frame;\n`);
    // A verbatim .ts copy under another name would always fail validateFrame on load.
    await assert.rejects(defineFrameFromFile(source, "renamed"), /Cannot rename a \.ts frame/);
    // The declared name is still accepted (used by `hive frame reload`).
    const defined = await defineFrameFromFile(source, "deep-review");
    assert.equal(defined.name, "deep-review");
  });
});

test("redefining a frame from the other extension removes the stale sibling", async () => {
  await withTempStore(async (dir) => {
    const tsSource = join(dir, "tsframe.ts");
    await writeFile(tsSource, `const frame = ${JSON.stringify(DEEP_REVIEW)}; export default frame;\n`);
    await defineFrameFromFile(tsSource);
    assert.equal((await frameDefinitionFile("deep-review"))?.ext, ".ts");

    // Redefine from JSON: the .ts sibling must go away, or it would keep
    // shadowing the new definition (loadFrame prefers .ts).
    const jsonSource = join(dir, "in.json");
    const updated = { ...DEEP_REVIEW, description: "JSON wins now" };
    await writeFile(jsonSource, JSON.stringify(updated));
    await defineFrameFromFile(jsonSource);
    assert.equal((await frameDefinitionFile("deep-review"))?.ext, ".json");
    assert.equal((await loadFrame("deep-review"))?.description, "JSON wins now");
  });
});

test("writeFrameFromObject removes a stale .ts sibling so the edit takes effect", async () => {
  await withTempStore(async (dir) => {
    const tsSource = join(dir, "tsframe.ts");
    await writeFile(tsSource, `const frame = ${JSON.stringify(DEEP_REVIEW)}; export default frame;\n`);
    await defineFrameFromFile(tsSource);

    const edited = { ...validateFrame(DEEP_REVIEW), description: "edited" };
    await writeFrameFromObject(edited);
    assert.equal((await frameDefinitionFile("deep-review"))?.ext, ".json");
    assert.equal((await loadFrame("deep-review"))?.description, "edited");
  });
});
