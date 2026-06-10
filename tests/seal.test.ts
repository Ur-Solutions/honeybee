import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSeals, loadLatestSeal, recordSeal, sealedBeeNames, sealsRoot, validateSealArtifact } from "../src/seal.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-seal-"));
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

const VALID = {
  status: "done" as const,
  summary: "Implemented record.id display in list output.",
  type: "implementation" as const,
  filesChanged: ["src/format.ts", "src/cli.ts"],
  testsRun: [
    { command: "npm run check", result: "passed" as const },
    { command: "npm test", result: "passed" as const },
  ],
  risks: ["Legacy sessions still require exact-name resolution."],
  nextActions: ["Add migration helper for legacy session IDs."],
  confidence: 0.78,
};

test("validateSealArtifact accepts a complete payload", () => {
  const artifact = validateSealArtifact(VALID);
  assert.equal(artifact.status, "done");
  assert.equal(artifact.testsRun?.[0]!.command, "npm run check");
  assert.equal(artifact.confidence, 0.78);
});

test("validateSealArtifact rejects missing summary", () => {
  assert.throws(() => validateSealArtifact({ status: "done" }), /summary must be a non-empty string/);
});

test("validateSealArtifact rejects unknown status", () => {
  assert.throws(() => validateSealArtifact({ status: "maybe", summary: "x" }), /Invalid seal status/);
});

test("validateSealArtifact rejects unknown type", () => {
  assert.throws(() => validateSealArtifact({ ...VALID, type: "novel" }), /Invalid seal type/);
});

test("validateSealArtifact rejects out-of-range confidence", () => {
  assert.throws(() => validateSealArtifact({ ...VALID, confidence: 1.5 }), /confidence must be a number/);
  assert.throws(() => validateSealArtifact({ ...VALID, confidence: -0.1 }), /confidence must be a number/);
});

test("validateSealArtifact rejects malformed testRun", () => {
  assert.throws(
    () => validateSealArtifact({ ...VALID, testsRun: [{ command: "x", result: "perhaps" }] }),
    /result must be passed, failed, or skipped/,
  );
});

test("recordSeal stores a seal and listSeals returns it", async () => {
  await withTempStore(async () => {
    const stored = await recordSeal("CL.cc9", validateSealArtifact(VALID));
    assert.equal(stored.beeName, "CL.cc9");
    assert.ok(stored.sealedAt);

    const list = await listSeals("CL.cc9");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.summary, VALID.summary);
  });
});

test("loadLatestSeal returns the newest of multiple seals", async () => {
  await withTempStore(async () => {
    await recordSeal("CL.cc9", validateSealArtifact({ status: "done", summary: "first" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordSeal("CL.cc9", validateSealArtifact({ status: "done", summary: "second" }));
    const latest = await loadLatestSeal("CL.cc9");
    assert.equal(latest?.summary, "second");
  });
});

test("loadLatestSeal reads only the lexicographically-newest file and skips corrupt ones", async () => {
  await withTempStore(async () => {
    await recordSeal("CL.fast", validateSealArtifact({ status: "done", summary: "older valid" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordSeal("CL.fast", validateSealArtifact({ status: "done", summary: "newest valid" }));
    const latest = await loadLatestSeal("CL.fast");
    assert.equal(latest?.summary, "newest valid");

    // A corrupt file that sorts AFTER every real seal must be skipped,
    // falling back to the newest valid one.
    await writeFile(join(sealsRoot(), "CL.fast", "9999-corrupt.json"), "not json", { mode: 0o600 });
    const fallback = await loadLatestSeal("CL.fast");
    assert.equal(fallback?.summary, "newest valid");
  });
});

test("loadLatestSeal returns null for a bee with no seals", async () => {
  await withTempStore(async () => {
    assert.equal(await loadLatestSeal("CL.none"), null);
  });
});

test("sealedBeeNames returns every bee with at least one seal", async () => {
  await withTempStore(async () => {
    await recordSeal("CO.aaa", validateSealArtifact({ status: "done", summary: "a" }));
    await recordSeal("CL.bbb", validateSealArtifact({ status: "blocked", summary: "b" }));
    const names = await sealedBeeNames();
    assert.deepEqual([...names].sort(), ["CL.bbb", "CO.aaa"]);
  });
});
