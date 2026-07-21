import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyBeeSeals, listSeals, loadLatestSeal, recordSeal, scanLatestSeal, sealedBeeNames, sealsRoot, validateSealArtifact } from "../src/seal.js";

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

async function withFixedDate<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date;
  const fixedMs = RealDate.parse(iso);
  const FixedDate = class extends RealDate {
    constructor(...args: unknown[]) {
      super(args.length === 0 ? fixedMs : (args[0] as string | number | Date));
    }

    static now(): number {
      return fixedMs;
    }
  } as DateConstructor;
  globalThis.Date = FixedDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

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

test("recordSeal keeps same-millisecond seals as distinct files", async () => {
  await withTempStore(async () => {
    await withFixedDate("2026-07-03T12:00:00.123Z", async () => {
      const first = await recordSeal("CL.collision", validateSealArtifact({ status: "done", summary: "first" }));
      const second = await recordSeal("CL.collision", validateSealArtifact({ status: "done", summary: "second" }));
      assert.equal(first.sealedAt, second.sealedAt, "test setup must force equal millisecond stamps");
    });

    const files = (await readdir(join(sealsRoot(), "CL.collision"))).filter((f) => f.endsWith(".json")).sort();
    assert.equal(files.length, 2, "same-ms seals must not overwrite each other");
    assert.equal(new Set(files).size, 2, "same-ms seal filenames must be unique");

    const latest = await loadLatestSeal("CL.collision");
    assert.equal(latest?.summary, "second");
    const listed = await listSeals("CL.collision");
    assert.deepEqual(listed.map((seal) => seal.summary), ["second", "first"]);
  });
});

test("copyBeeSeals copies every seal file with the same filename + content, leaving sealsRoot intact", async () => {
  await withTempStore(async () => {
    await recordSeal("CL.cp", validateSealArtifact({ status: "done", summary: "one" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordSeal("CL.cp", validateSealArtifact({ status: "blocked", summary: "two" }));

    const srcFiles = (await readdir(join(sealsRoot(), "CL.cp"))).filter((f) => f.endsWith(".json")).sort();
    assert.equal(srcFiles.length, 2, "two seals recorded");

    const destRoot = await mkdtemp(join(tmpdir(), "honeybee-seal-dest-"));
    try {
      await mkdir(destRoot, { recursive: true });
      const copied = await copyBeeSeals("CL.cp", destRoot);
      assert.equal(copied, 2, "both seals copied");

      const destFiles = (await readdir(join(destRoot, "CL.cp"))).filter((f) => f.endsWith(".json")).sort();
      assert.deepEqual(destFiles, srcFiles, "identical stamp filenames in the copy");

      for (const f of srcFiles) {
        const orig = await readFile(join(sealsRoot(), "CL.cp", f), "utf8");
        const copy = await readFile(join(destRoot, "CL.cp", f), "utf8");
        assert.equal(copy, orig, "copied seal content is byte-identical");
      }

      // sealsRoot is untouched (a copy, never a move).
      const stillThere = (await readdir(join(sealsRoot(), "CL.cp"))).filter((f) => f.endsWith(".json")).sort();
      assert.deepEqual(stillThere, srcFiles, "the original seals remain after copy");

      // A bee with no seals copies nothing and does not throw.
      assert.equal(await copyBeeSeals("CL.none", destRoot), 0, "zero seals copies nothing");
    } finally {
      await rm(destRoot, { recursive: true, force: true });
    }
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

test("scanLatestSeal can start after a cached filename", async () => {
  await withTempStore(async () => {
    await recordSeal("CL.cursor", validateSealArtifact({ status: "done", summary: "first" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordSeal("CL.cursor", validateSealArtifact({ status: "done", summary: "second" }));
    const files = (await readdir(join(sealsRoot(), "CL.cursor"))).filter((f) => f.endsWith(".json")).sort();

    const afterFirst = await scanLatestSeal("CL.cursor", { afterFilename: files[0] });
    assert.equal(afterFirst.seal?.summary, "second");
    assert.equal(afterFirst.filename, files[1]);

    const afterNewest = await scanLatestSeal("CL.cursor", { afterFilename: files[1] });
    assert.equal(afterNewest.seal, null);
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

test("validateSealArtifact accepts Seal v2 fields (taskId, attempt, evidence)", () => {
  const artifact = validateSealArtifact({
    ...VALID,
    taskId: "FL.3k2/s3",
    attempt: 2,
    evidence: {
      filesChanged: ["src/a.ts"],
      testsRun: [{ command: "npm test", result: "passed" }],
      artifacts: [
        { kind: "branch", ref: "feature/parity-s3" },
        { kind: "fixture", ref: "fixtures/route-3.json" },
      ],
    },
  });
  assert.equal(artifact.taskId, "FL.3k2/s3");
  assert.equal(artifact.attempt, 2);
  assert.equal(artifact.evidence?.artifacts?.length, 2);
  assert.equal(artifact.evidence?.artifacts?.[0]?.kind, "branch");
});

test("validateSealArtifact rejects invalid Seal v2 fields", () => {
  assert.throws(() => validateSealArtifact({ ...VALID, taskId: "" }), /taskId must be a non-empty string/);
  assert.throws(() => validateSealArtifact({ ...VALID, attempt: 0 }), /attempt must be a positive integer/);
  assert.throws(() => validateSealArtifact({ ...VALID, attempt: 1.5 }), /attempt must be a positive integer/);
  assert.throws(() => validateSealArtifact({ ...VALID, evidence: [] }), /evidence must be an object/);
  assert.throws(
    () => validateSealArtifact({ ...VALID, evidence: { artifacts: [{ kind: "tarball", ref: "x" }] } }),
    /kind must be branch, diff, url, fixture/,
  );
  assert.throws(
    () => validateSealArtifact({ ...VALID, evidence: { artifacts: [{ kind: "url", ref: " " }] } }),
    /ref must be a non-empty string/,
  );
});

test("recordSeal round-trips Seal v2 fields through listSeals", async () => {
  await withTempStore(async () => {
    await recordSeal("v2-bee", {
      status: "done",
      summary: "Slot 3 complete.",
      taskId: "FL.3k2/s3",
      attempt: 1,
      evidence: { artifacts: [{ kind: "diff", ref: "worktrees/s3.diff" }] },
    });
    const seals = await listSeals("v2-bee");
    assert.equal(seals.length, 1);
    assert.equal(seals[0]!.taskId, "FL.3k2/s3");
    assert.equal(seals[0]!.attempt, 1);
    assert.equal(seals[0]!.evidence?.artifacts?.[0]?.ref, "worktrees/s3.diff");
  });
});
