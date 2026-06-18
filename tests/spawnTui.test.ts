import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, relativeTo, resolveAccountStep, splitPathQuery, type SpawnTuiAccount } from "../src/spawnTui.js";

const acc = (id: string): SpawnTuiAccount => ({ id, label: id });

test("resolveAccountStep skips the column with no accounts (plain spawn)", () => {
  const step = resolveAccountStep([]);
  assert.equal(step.showColumn, false);
  assert.equal(step.account, undefined);
  assert.equal(step.label, "no account");
});

test("resolveAccountStep binds the only account without a column", () => {
  const step = resolveAccountStep([acc("claude-thto")]);
  assert.equal(step.showColumn, false);
  assert.equal(step.account, "claude-thto");
  assert.equal(step.label, "claude-thto");
});

test("resolveAccountStep shows an Auto-led column once there are two accounts", () => {
  const step = resolveAccountStep([acc("claude-thto"), acc("claude-work")]);
  assert.equal(step.showColumn, true);
  assert.equal(step.rows.length, 3);
  assert.equal(step.rows[0]!.id, "auto");
  assert.equal(step.rows[0]!.isAuto, true);
  assert.deepEqual(step.rows.slice(1).map((r) => r.id), ["claude-thto", "claude-work"]);
});

test("fuzzyFilter keeps original order for an empty query", () => {
  const items = ["beta", "alpha", "gamma"];
  assert.deepEqual(fuzzyFilter("", items, (x) => x), items);
});

test("fuzzyFilter matches subsequences and ranks substrings highest", () => {
  const items = ["honeybee/repos/honeybee", "oss/forge/forge", "digitech/digitech-backend"];
  const out = fuzzyFilter("honey", items, (x) => x);
  assert.equal(out[0], "honeybee/repos/honeybee");
  assert.ok(!out.includes("oss/forge/forge"));
});

test("fuzzyFilter drops non-matches", () => {
  assert.deepEqual(fuzzyFilter("zzz", ["abc", "abd"], (x) => x), []);
});

test("fuzzyFilter rejects a sparse subsequence scattered across a long corpus", () => {
  // The bees search corpus concatenates name+title+colony+agent+cwd+detail, so a
  // garbage query could otherwise hop across it. The gap budget must reject it.
  const corpus = "cl-ab12 my cool title trmd @swarm1 claude /users/trmd/projects/trmd/honeybee/repos/honeybee working on the parser refactor";
  assert.deepEqual(fuzzyFilter("ebabaebaerba", [corpus], (x) => x), []);
  assert.deepEqual(fuzzyFilter("xqzwk", [corpus], (x) => x), []);
});

test("fuzzyFilter still matches localized queries inside a long corpus", () => {
  const corpus = "cl-ab12 my cool title trmd @swarm1 claude /users/trmd/projects/honeybee working on the parser";
  assert.deepEqual(fuzzyFilter("parser", [corpus], (x) => x), [corpus]); // substring
  assert.deepEqual(fuzzyFilter("claude", [corpus], (x) => x), [corpus]); // substring
  assert.deepEqual(fuzzyFilter("cltitle", [corpus], (x) => x), [corpus]); // nearby subsequence still ok
  assert.deepEqual(fuzzyFilter("clparser", [corpus], (x) => x), []);     // first→last spans the whole corpus → rejected
});

test("fuzzyFilter prefers the shorter candidate on score ties", () => {
  // both contain "for" as a contiguous substring at index 0 → tie on score
  const out = fuzzyFilter("for", ["forge", "forge-extended-name"], (x) => x);
  assert.deepEqual(out, ["forge", "forge-extended-name"]);
});

test("splitPathQuery separates the directory from the trailing fuzzy query", () => {
  assert.deepEqual(splitPathQuery("/Users/trmd/Projects/tr"), { base: "/Users/trmd/Projects", query: "tr" });
  assert.deepEqual(splitPathQuery("/Users/trmd/Projects/"), { base: "/Users/trmd/Projects", query: "" });
  assert.deepEqual(splitPathQuery("/foo"), { base: "/", query: "foo" });
  assert.deepEqual(splitPathQuery("rel"), { base: ".", query: "rel" });
});

test("relativeTo renders a child under base, else the absolute path", () => {
  assert.equal(relativeTo("/a/b", "/a/b/c/d"), "c/d");
  assert.equal(relativeTo("/a/b", "/a/b"), "/a/b");
  assert.equal(relativeTo("/a/b", "/x/y"), "/x/y");
});
