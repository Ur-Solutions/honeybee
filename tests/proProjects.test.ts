import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProRepos } from "../src/proProjects.js";

test("parseProRepos turns tab-separated rows into labelled repos", () => {
  const out = [
    "digitech/digitech\tdigitech-backend\t/Users/x/Projects/digitech/digitech/repos/digitech-backend",
    "oss/forge\tforge\t/Users/x/Projects/oss/forge/repos/forge",
  ].join("\n");
  assert.deepEqual(parseProRepos(out), [
    { label: "digitech/digitech/digitech-backend", path: "/Users/x/Projects/digitech/digitech/repos/digitech-backend", project: "digitech/digitech" },
    { label: "oss/forge/forge", path: "/Users/x/Projects/oss/forge/repos/forge", project: "oss/forge" },
  ]);
});

test("parseProRepos skips blank lines and rows without an absolute path", () => {
  const out = ["", "broken-line-no-tabs", "p\tr\trelative/path", "a/b\tc\t/abs/c", "   "].join("\n");
  assert.deepEqual(parseProRepos(out), [
    { label: "a/b/c", path: "/abs/c", project: "a/b" },
  ]);
});
