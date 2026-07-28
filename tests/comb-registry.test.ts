import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalDigest, canonicalJson } from "../src/comb/canonical.js";
import { defineCombFromFile, defineCombVersion, listCombVersions, loadCombVersion } from "../src/comb/registry.js";
import { canonicalDeepEqual, lintComb, resolveJsonPointer } from "../src/comb/schema.js";
import type { CombSpecInput, JsonValue } from "../src/comb/types.js";

function simpleComb(name = "strict-review"): CombSpecInput {
  return {
    name,
    input: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { ref: { type: "string" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
    nodes: [
      {
        id: "review",
        executor: "agent",
        binding: "strict",
        output: {
          kind: "json-schema",
          schema: {
            type: "object",
            properties: { verdict: { enum: ["pass", "fail"] } },
            required: ["verdict"],
            additionalProperties: false,
          },
        },
        agent: {
          capacity: { kind: "spawn", bee: "codex", account: "auto" },
          brief: "Review {{input.ref}}",
        },
      },
      {
        id: "passed",
        executor: "engine",
        binding: "strict",
        engine: {
          kind: "predicate",
          predicate: { kind: "output-equals", nodeId: "review", path: "/verdict", equals: "pass" },
        },
      },
    ],
    edges: [{ id: "review-passed", from: "review", to: "passed", kind: "forward", on: "done" }],
    output: {
      contract: {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
      },
      value: { source: "node-output", nodeId: "review", pointer: "", lineage: "current", item: "same" },
    },
  };
}

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-comb-registry-"));
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

test("canonical JSON ignores object insertion order but preserves array order", () => {
  const first = { z: [1, 2], a: { y: true, x: null } } as JsonValue;
  const reordered = { a: { x: null, y: true }, z: [1, 2] } as JsonValue;
  const reversed = { a: { x: null, y: true }, z: [2, 1] } as JsonValue;
  assert.equal(canonicalJson(first), canonicalJson(reordered));
  assert.equal(canonicalDigest(first), canonicalDigest(reordered));
  assert.notEqual(canonicalDigest(first), canonicalDigest(reversed));
});

test("lint normalizes format/join and enforces the E1 output predicate contract", () => {
  const result = lintComb(simpleComb());
  assert.equal(result.normalized.formatVersion, 2);
  assert.deepEqual(result.normalized.nodes[0]?.join, { mode: "all", tolerateFailures: 0 });
  assert.throws(
    () => lintComb({
      ...simpleComb(),
      nodes: [
        { ...simpleComb().nodes[0]!, output: { kind: "informal", description: "anything" } },
        simpleComb().nodes[1]!,
      ],
    }),
    /output-equals may reference only/,
  );
});

test("lint rejects functions, cycles, forward cycles, and malformed waiting edges", () => {
  assert.throws(() => lintComb({ ...simpleComb(), bad: () => undefined }), /function is not valid comb data/);
  const cyclic: Record<string, unknown> = { ...simpleComb() };
  cyclic.self = cyclic;
  assert.throws(() => lintComb(cyclic), /cyclic values/);
  assert.throws(
    () => lintComb({
      ...simpleComb(),
      edges: [
        { id: "a", from: "review", to: "passed", kind: "forward", on: "done" },
        { id: "b", from: "passed", to: "review", kind: "forward", on: "done" },
      ],
    }),
    /forward edges must form a DAG/,
  );
  assert.throws(
    () => lintComb({
      ...simpleComb(),
      edges: [{ id: "timeout", from: "review", to: "passed", kind: "waiting", on: "waiting" }],
    }),
    /waiting edges are not supported in strict-spine slice 1/,
  );
});

test("RFC 6901 and canonical deep equality do not coerce values", () => {
  const document = { "a/b": { "~key": [null, { x: 1 }] } } as JsonValue;
  assert.deepEqual(resolveJsonPointer(document, "/a~1b/~0key/1/x"), { found: true, value: 1 });
  assert.deepEqual(resolveJsonPointer(document, "/missing"), { found: false });
  assert.equal(canonicalDeepEqual({ b: 2, a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(canonicalDeepEqual(1, "1"), false);
});

test("registry versions are immutable, duplicate defines are no-ops, and CAS conflicts", async () => {
  await withTempStore(async () => {
    const first = await defineCombVersion({
      definition: simpleComb(),
      provenance: { kind: "file", sourcePath: "/tmp/strict.json", sourceDigest: "sha256:first" },
      createdAt: "2026-07-28T10:00:00.000Z",
      createdBy: "test",
    });
    assert.equal(first.created, true);
    assert.equal(first.comb.version, 1);

    const duplicate = await defineCombVersion({
      definition: JSON.parse(JSON.stringify(simpleComb())),
      provenance: { kind: "file", sourcePath: "/tmp/duplicate.json", sourceDigest: "sha256:second" },
      baseVersion: 1,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.comb.version, 1);

    const changed = simpleComb();
    changed.description = "v2";
    const second = await defineCombVersion({
      definition: changed,
      provenance: { kind: "file", sourcePath: "/tmp/strict-v2.json", sourceDigest: "sha256:third" },
      baseVersion: 1,
      createdAt: "2026-07-28T11:00:00.000Z",
    });
    assert.equal(second.comb.version, 2);
    assert.equal((await loadCombVersion("strict-review", 1))?.definition.description, undefined);
    assert.equal((await loadCombVersion("strict-review"))?.definition.description, "v2");
    assert.equal((await listCombVersions())[0]?.index.latestVersion, 2);

    await assert.rejects(
      defineCombVersion({
        definition: { ...changed, description: "v3" },
        provenance: { kind: "file", sourcePath: "/tmp/strict-v3.json", sourceDigest: "sha256:fourth" },
        baseVersion: 1,
      }),
      /not base version 1/,
    );
  });
});

test("JSON and TS files compile to canonical immutable data at define time", async () => {
  await withTempStore(async (dir) => {
    const jsonPath = join(dir, "authored.json");
    await writeFile(jsonPath, JSON.stringify(simpleComb("from-json")));
    const json = await defineCombFromFile(jsonPath);
    assert.equal(json.comb.name, "from-json");

    const tsPath = join(dir, "authored.ts");
    await writeFile(
      tsPath,
      `export default ${JSON.stringify(simpleComb("from-ts"))};\n`,
    );
    const ts = await defineCombFromFile(tsPath);
    assert.equal(ts.comb.name, "from-ts");
    const stored = JSON.parse(await readFile(join(dir, "combs", "definitions", "from-ts", "versions", "000001.json"), "utf8"));
    assert.equal(stored.definition.name, "from-ts");
    assert.equal(typeof stored.definition, "object");
  });
});
