import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProRepoEntries, parseProRepos, resolveProEntryForCwd, resolveProForCwd, resolveProSlotForCwd, toProSlug } from "../src/proProjects.js";

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

test("parseProRepoEntries splits area/project and repo", () => {
  const out = "digitech/digitech\tdigitech-backend\t/p/digitech/digitech/repos/digitech-backend";
  assert.deepEqual(parseProRepoEntries(out), [
    { area: "digitech", project: "digitech", repo: "digitech-backend", path: "/p/digitech/digitech/repos/digitech-backend" },
  ]);
});

test("resolveProForCwd matches the longest path prefix (cwd may be a subdir)", () => {
  const entries = parseProRepoEntries([
    "oss/forge\tforge\t/p/oss/forge/repos/forge",
    "digitech/dt\tbackend\t/p/digitech/dt/repos/backend",
  ].join("\n"));
  assert.deepEqual(resolveProForCwd(entries, "/p/oss/forge/repos/forge/src/deep"), { area: "oss", project: "forge", repo: "forge" });
  assert.deepEqual(resolveProForCwd(entries, "/p/oss/forge/repos/forge"), { area: "oss", project: "forge", repo: "forge" });
  assert.equal(resolveProForCwd(entries, "/somewhere/else"), undefined);
});

test("resolveProEntryForCwd returns the full entry (path included) for the isolation step", () => {
  const entries = parseProRepoEntries([
    "trmd/honeybee\thoneybee\t/p/trmd/honeybee/repos/honeybee",
    "trmd/honeybee\thoneybee-build\t/p/trmd/honeybee/repos/honeybee-build",
  ].join("\n"));
  assert.deepEqual(resolveProEntryForCwd(entries, "/p/trmd/honeybee/repos/honeybee/src"), {
    area: "trmd", project: "honeybee", repo: "honeybee", path: "/p/trmd/honeybee/repos/honeybee",
  });
  // A sibling repo's path must not be matched by the shorter-prefix repo.
  assert.equal(resolveProEntryForCwd(entries, "/p/trmd/honeybee/repos/honeybee-build")!.repo, "honeybee-build");
  assert.equal(resolveProEntryForCwd(entries, "/elsewhere"), undefined);
});

test("resolveProSlotForCwd maps the canonical repo to kind=repo with no slot", () => {
  const entries = parseProRepoEntries("trmd/honeybee\thoneybee\t/p/trmd/honeybee/repos/honeybee");
  assert.deepEqual(resolveProSlotForCwd(entries, "/p/trmd/honeybee/repos/honeybee/src/deep"), {
    area: "trmd", project: "honeybee", repo: "honeybee", kind: "repo",
  });
});

test("resolveProSlotForCwd maps worktrees and checkouts back to the owning repo with slot kind+name", () => {
  const entries = parseProRepoEntries("digitech/digitech\tdigitech-next\t/p/digitech/digitech/repos/digitech-next");
  // A worktree lives at <project>/worktrees/<repo>/<name>, a sibling of repos/.
  assert.deepEqual(resolveProSlotForCwd(entries, "/p/digitech/digitech/worktrees/digitech-next/unimicro/src"), {
    area: "digitech", project: "digitech", repo: "digitech-next", kind: "worktree", slot: "unimicro",
  });
  // A checkout lives at <project>/checkouts/<repo>/<name>.
  assert.deepEqual(resolveProSlotForCwd(entries, "/p/digitech/digitech/checkouts/digitech-next/release-button"), {
    area: "digitech", project: "digitech", repo: "digitech-next", kind: "checkout", slot: "release-button",
  });
});

test("resolveProSlotForCwd ignores the slot base dir itself and unrelated paths", () => {
  const entries = parseProRepoEntries("digitech/digitech\tdigitech-next\t/p/digitech/digitech/repos/digitech-next");
  // The worktrees/<repo> base dir has no slot segment — don't invent one.
  assert.equal(resolveProSlotForCwd(entries, "/p/digitech/digitech/worktrees/digitech-next"), undefined);
  assert.equal(resolveProSlotForCwd(entries, "/somewhere/else"), undefined);
});

test("resolveProSlotForCwd picks the most specific repo when slot paths overlap a sibling", () => {
  const entries = parseProRepoEntries([
    "trmd/honeybee\thoneybee\t/p/trmd/honeybee/repos/honeybee",
    "trmd/honeybee\thoneybee-build\t/p/trmd/honeybee/repos/honeybee-build",
  ].join("\n"));
  // A worktree of honeybee-build must not be swallowed by the shorter `honeybee` repo.
  assert.deepEqual(resolveProSlotForCwd(entries, "/p/trmd/honeybee/worktrees/honeybee-build/wip"), {
    area: "trmd", project: "honeybee", repo: "honeybee-build", kind: "worktree", slot: "wip",
  });
});

test("toProSlug lowercases and dashes free text into a pro-valid slug", () => {
  assert.equal(toProSlug("Fix Login Bug"), "fix-login-bug");
  assert.equal(toProSlug("  feature/Foo_Bar!  "), "feature-foo-bar");
  assert.equal(toProSlug("--Edge--"), "edge");
  assert.equal(toProSlug("claude"), "claude");
  assert.equal(toProSlug("!!!"), ""); // nothing usable → caller surfaces a hint
});
