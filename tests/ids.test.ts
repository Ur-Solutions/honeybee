import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allocateBeeIdentity, beePrefix, highlightUniqueSessionReference, matchesSessionReference, shortestUniqueSessionPrefix } from "../src/ids.js";

function withSilencedStderr<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  return fn().finally(() => {
    console.error = original;
  });
}

test("beePrefix uses harness prefixes and alias initials", () => {
  assert.equal(beePrefix("codex", "codex"), "CO.");
  assert.equal(beePrefix("claude", "claude"), "CL.");
  assert.equal(beePrefix("codex", "codex2"), "CO.");
  assert.equal(beePrefix("claude", "cc3"), "CC.");
  assert.equal(beePrefix("opencode", "opencode"), "OP.");
});

test("allocateBeeIdentity stores UUID-backed globally unique short IDs with at least three UUID characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-ids-"));
  try {
    const first = await allocateBeeIdentity({ storeRoot: dir, agent: "codex", requestedAgent: "codex", uuid: () => "abc00000-0000-4000-8000-000000000000" });
    const second = await allocateBeeIdentity({ storeRoot: dir, agent: "codex", requestedAgent: "codex", uuid: () => "abc11111-1111-4111-8111-111111111111" });

    assert.equal(first.id, "CO.abc");
    assert.equal(first.uuid, "abc00000000040008000000000000000");
    assert.equal(second.id, "CO.abc1");
    assert.equal(second.uuid, "abc11111111141118111111111111111");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shortestUniqueSessionPrefix resolves to the least leading characters unique among current sessions", () => {
  const records = [
    { name: "CO.abc", id: "CO.abc", uuid: "abc00000000040008000000000000000" },
    { name: "CO.abd", id: "CO.abd", uuid: "abd00000000040008000000000000000" },
    { name: "CL.abc", id: "CL.abc", uuid: "abc99999000040008000000000000000" },
  ];

  assert.equal(shortestUniqueSessionPrefix(records, records[0]), "CO.abc");
  assert.equal(shortestUniqueSessionPrefix(records, records[1]), "CO.abd");
  assert.equal(shortestUniqueSessionPrefix(records, records[2]), "CL.abc");
  assert.equal(matchesSessionReference(records[0], "CO.ab"), false);
  assert.equal(matchesSessionReference(records[0], "CO.abc"), true);
  assert.equal(matchesSessionReference(records[0], "CO.abc0"), true);
  assert.equal(highlightUniqueSessionReference(records, records[0], { start: "<b>", end: "</b>" }), "CO.<b>abc</b>");
});

test("matchesSessionReference targets the suffix portion of an id", () => {
  const bee = { name: "brave-otter", id: "CO.123", uuid: "12300000000040008000000000000000" };

  // The suffix shown in the id resolves the bee without its agent prefix.
  assert.equal(matchesSessionReference(bee, "123"), true);
  // Longer queries that extend into the backing UUID still match.
  assert.equal(matchesSessionReference(bee, "1230"), true);
  // The full prefixed form keeps working.
  assert.equal(matchesSessionReference(bee, "CO.123"), true);
  // Fragments shorter than the displayed suffix are too ambiguous to resolve.
  assert.equal(matchesSessionReference(bee, "12"), false);
  // A suffix that is not a prefix of this bee's UUID must not match.
  assert.equal(matchesSessionReference(bee, "999"), false);
});

test("matchesSessionReference targets the suffix even without a recorded uuid", () => {
  const bee = { name: "brave-otter", id: "CO.abc" };
  assert.equal(matchesSessionReference(bee, "abc"), true);
  assert.equal(matchesSessionReference(bee, "ab"), false);
});

test("allocateBeeIdentity skips invalid id-index entries instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-ids-"));
  try {
    await writeFile(
      join(dir, "id-index.json"),
      JSON.stringify({ used: ["not-a-uuid", "abc00000000040008000000000000000"] }, null, 2),
    );

    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => warnings.push(args.join(" "));
    let identity;
    try {
      identity = await allocateBeeIdentity({ storeRoot: dir, agent: "codex", requestedAgent: "codex", uuid: () => "abc11111-1111-4111-8111-111111111111" });
    } finally {
      console.error = original;
    }

    // The valid historical entry is still honored: the new id needs 4 chars.
    assert.equal(identity.id, "CO.abc1");
    assert.ok(warnings.some((line) => line.includes("not-a-uuid")), `expected a warning naming the bad entry, saw: ${warnings.join("; ")}`);

    const index = JSON.parse(await readFile(join(dir, "id-index.json"), "utf8")) as { used: string[] };
    assert.ok(index.used.includes("abc00000000040008000000000000000"));
    assert.ok(index.used.includes("abc11111111141118111111111111111"));
    assert.ok(!index.used.includes("not-a-uuid"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("allocateBeeIdentity recovers from a corrupt id-index.json by moving it aside", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-ids-"));
  try {
    await writeFile(join(dir, "id-index.json"), "{definitely not json");

    const identity = await withSilencedStderr(() =>
      allocateBeeIdentity({ storeRoot: dir, agent: "codex", requestedAgent: "codex", uuid: () => "abc00000-0000-4000-8000-000000000000" }),
    );
    assert.equal(identity.id, "CO.abc");

    const entries = await readdir(dir);
    assert.ok(entries.some((entry) => entry.startsWith("id-index.json.corrupt-")), `expected the corrupt index moved aside, saw: ${entries.join(", ")}`);
    const index = JSON.parse(await readFile(join(dir, "id-index.json"), "utf8")) as { used: string[] };
    assert.deepEqual(index.used, ["abc00000000040008000000000000000"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
