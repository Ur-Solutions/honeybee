import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSession, type SessionRecord } from "../src/store.js";
import {
  dedupeTags,
  effectiveTags,
  extractNamespace,
  getReservedNamespaces,
  isReservedNamespace,
  isValidSessionTag,
  isValidTagValue,
  MAX_TAGS_PER_BEE,
  parseTag,
  renderTags,
} from "../src/tags.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-tags-store-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeRaw(dir: string, name: string, body: Record<string, unknown>): Promise<void> {
  const sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

function rawRecord(dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "CO.abc",
    agent: "codex",
    cwd: dir,
    command: "codex",
    tmuxTarget: "CO-abc",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function bee(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "alpha",
    agent: "claude",
    cwd: "/tmp/plain-dir",
    command: "claude",
    tmuxTarget: "alpha",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

test("effectiveTags derives reserved facets from canonical fields plus user tags", () => {
  const record = bee({
    colony: "fe",
    swarmId: "t1",
    caste: "reviewer",
    node: "mac",
    agent: "claude",
    combId: "CO.x",
    tags: ["migration", "prio:p1"],
  });
  const tags = effectiveTags(record);
  assert.ok(tags.has("colony:fe"));
  assert.ok(tags.has("swarm:t1"));
  assert.ok(tags.has("caste:reviewer"));
  assert.ok(tags.has("node:mac"));
  assert.ok(tags.has("agent:claude"));
  assert.ok(tags.has("comb:CO.x"));
  // repo derives from the cwd basename when outside a git repo.
  assert.ok(tags.has("repo:plain-dir"));
  // user tags carried verbatim.
  assert.ok(tags.has("migration"));
  assert.ok(tags.has("prio:p1"));
});

test("effectiveTags excludes state: (tmux-facet only, never store-derived)", () => {
  const record = bee({ lastObservedState: "waiting" });
  const tags = effectiveTags(record);
  for (const tag of tags) assert.ok(!tag.startsWith("state:"), `unexpected ${tag}`);
});

test("effectiveTags falls back to tmuxTarget for comb when combId is absent", () => {
  const record = bee({ tmuxTarget: "solo-target", combId: undefined });
  assert.ok(effectiveTags(record).has("comb:solo-target"));
});

test("effectiveTags derives reserved tags even with no user tags", () => {
  const record = bee({ colony: "fe", tags: undefined });
  const tags = effectiveTags(record);
  assert.ok(tags.has("colony:fe"));
  assert.ok(tags.has("agent:claude"));
});

test("quest/workspace getters stay dark until their fields are populated", () => {
  const record = bee();
  const tags = effectiveTags(record);
  for (const tag of tags) {
    assert.ok(!tag.startsWith("quest:"), `unexpected ${tag}`);
    assert.ok(!tag.startsWith("workspace:"), `unexpected ${tag}`);
  }
  // But they light up when the field exists (forward-compat).
  const withQuest = bee({ ...{ questId: "q-ab" } } as Partial<SessionRecord>);
  assert.ok(effectiveTags(withQuest).has("quest:q-ab"));
});

test("parseTag splits bare and namespaced tokens", () => {
  assert.deepEqual(parseTag("migration"), { value: "migration" });
  assert.deepEqual(parseTag("prio:p1"), { namespace: "prio", value: "p1" });
});

test("parseTag throws on empty namespace or value", () => {
  assert.throws(() => parseTag(":p1"), /Invalid tag format/);
  assert.throws(() => parseTag("prio:"), /Invalid tag format/);
});

test("extractNamespace returns the namespace or undefined", () => {
  assert.equal(extractNamespace("migration"), undefined);
  assert.equal(extractNamespace("prio:p1"), "prio");
});

test("isValidTagValue accepts grammar-valid tags and rejects bad ones", () => {
  assert.ok(isValidTagValue("migration"));
  assert.ok(isValidTagValue("prio:p1"));
  assert.ok(isValidTagValue("waiting-review"));
  // whitespace / comma / tab / newline forbidden.
  assert.ok(!isValidTagValue("two words"));
  assert.ok(!isValidTagValue("a,b"));
  assert.ok(!isValidTagValue("a\tb"));
  assert.ok(!isValidTagValue("a\nb"));
  assert.ok(!isValidTagValue(""));
  // namespaced with empty namespace or value is invalid.
  assert.ok(!isValidTagValue(":p1"));
  assert.ok(!isValidTagValue("prio:"));
  // length cap (64).
  assert.ok(isValidTagValue("x".repeat(64)));
  assert.ok(!isValidTagValue("x".repeat(65)));
});

test("isReservedNamespace recognizes all reserved namespaces", () => {
  for (const ns of ["colony", "swarm", "caste", "node", "agent", "repo", "quest", "workspace", "comb", "state"]) {
    assert.ok(isReservedNamespace(ns), `${ns} should be reserved`);
  }
  assert.ok(!isReservedNamespace("prio"));
  assert.ok(!isReservedNamespace("custom"));
  assert.ok(!isReservedNamespace(undefined));
  // getReservedNamespaces returns the same set.
  assert.deepEqual(new Set(getReservedNamespaces()), new Set(["colony", "swarm", "caste", "node", "agent", "repo", "quest", "workspace", "comb", "state"]));
});

test("isValidSessionTag rejects reserved-namespace tags (defense-in-depth)", () => {
  assert.ok(isValidSessionTag("migration"));
  assert.ok(isValidSessionTag("prio:p1"));
  assert.ok(!isValidSessionTag("colony:fe"));
  assert.ok(!isValidSessionTag("swarm:t1"));
  assert.ok(!isValidSessionTag("state:waiting"));
  assert.ok(!isValidSessionTag("two words"));
});

test("dedupeTags removes duplicates preserving order", () => {
  assert.deepEqual(dedupeTags(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
});

test("renderTags is sentinel-wrapped and sorted", () => {
  const record = bee({ colony: "fe", swarmId: "t1", tags: ["migration"] });
  const rendered = renderTags(record);
  // leading and trailing space (word-boundary matching for tmux).
  assert.ok(rendered.startsWith(" "), "leading space");
  assert.ok(rendered.endsWith(" "), "trailing space");
  // sorted.
  const inner = rendered.slice(1, -1).split(" ");
  assert.deepEqual([...inner].sort(), inner);
  // contains the expected tags.
  assert.ok(rendered.includes(" migration "));
  assert.ok(rendered.includes(" colony:fe "));
  assert.ok(rendered.includes(" swarm:t1 "));
});

test("renderTags returns empty string for an empty effective set", () => {
  // A record with no reserved-deriving fields and no user tags. agent and repo
  // and comb always derive, so to get an empty set we hand a degenerate record.
  const empty: SessionRecord = {
    name: "",
    agent: "",
    cwd: "",
    command: "",
    tmuxTarget: "",
    createdAt: "x",
    updatedAt: "x",
    status: "dead",
  };
  assert.equal(renderTags(empty), "");
});

test("MAX_TAGS_PER_BEE is the documented cap", () => {
  assert.equal(MAX_TAGS_PER_BEE, 32);
});

// ── normalizeSessionRecord tags branch (S1) ───────────────────────────────

test("S1: load keeps valid tags and drops invalid/reserved ones without throwing", async () => {
  await withTempStore(async (dir) => {
    await writeRaw(dir, "CO.abc", rawRecord(dir, { tags: ["colony:other", "valid-tag", 123, "prio:p1", "two words"] }));
    const loaded = await loadSession("CO.abc");
    assert.ok(loaded, "record still loads");
    // colony:other (reserved) dropped, 123 (non-string) dropped, "two words"
    // (invalid grammar) dropped; valid-tag and prio:p1 kept.
    assert.deepEqual(loaded!.tags, ["valid-tag", "prio:p1"]);
  });
});

test("S1: a non-array tags field is ignored on load", async () => {
  await withTempStore(async (dir) => {
    await writeRaw(dir, "CO.abc", rawRecord(dir, { tags: "not-an-array" }));
    const loaded = await loadSession("CO.abc");
    assert.ok(loaded);
    assert.equal(loaded!.tags, undefined);
  });
});

test("S1: tags are deduped and capped on load", async () => {
  await withTempStore(async (dir) => {
    const many = Array.from({ length: 40 }, (_, i) => `tag-${i}`);
    await writeRaw(dir, "CO.abc", rawRecord(dir, { tags: ["dup", "dup", ...many] }));
    const loaded = await loadSession("CO.abc");
    assert.ok(loaded);
    assert.equal(loaded!.tags!.length, MAX_TAGS_PER_BEE);
    // dedupe ran (only one "dup").
    assert.equal(loaded!.tags!.filter((t) => t === "dup").length, 1);
  });
});

test("S1: a record with reserved fields but no tags array loads (derived on read)", async () => {
  await withTempStore(async (dir) => {
    await writeRaw(dir, "CO.abc", rawRecord(dir, { colony: "fe" }));
    const loaded = await loadSession("CO.abc");
    assert.ok(loaded);
    assert.equal(loaded!.tags, undefined);
    // The reserved tag is derived, not stored.
    assert.ok(effectiveTags(loaded as SessionRecord).has("colony:fe"));
  });
});
