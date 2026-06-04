import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allocateBeeIdentity, beePrefix, highlightUniqueSessionReference, matchesSessionReference, shortestUniqueSessionPrefix } from "../src/ids.js";

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
