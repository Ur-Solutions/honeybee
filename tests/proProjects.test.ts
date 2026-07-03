import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireProSlot, deleteProSlot, parseProRepoEntries, parseProRepos, proSlotDeleteArgs, resolveProEntryForCwd, resolveProForCwd, resolveProSlotForCwd, toProSlug } from "../src/proProjects.js";

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

test("proSlotDeleteArgs removes the slot without taking ownership of worktree branches", () => {
  assert.deepEqual(proSlotDeleteArgs("worktree", "fork-api"), ["wt", "d", "fork-api", "--force", "--hard", "--no-delete-branch"]);
  assert.deepEqual(proSlotDeleteArgs("checkout", "fork-api"), ["co", "d", "fork-api", "--force", "--hard"]);
});

async function withStubPro(exists: boolean, fn: (ctx: { repo: string; log: string; slotPath: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-pro-stub-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const log = join(root, "pro.log");
  const slotPath = join(root, "slot");
  await mkdir(bin, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(log, "");
  await writeFile(join(bin, "pro"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$PRO_STUB_LOG"
case "$1:$2" in
  wt:s|co:s)
    if [ "\${3:-}" = "-c" ]; then
      printf '%s\\n' "$PRO_STUB_PATH"
    elif [ "\${PRO_STUB_EXISTS:-0}" = "1" ]; then
      printf '%s\\n' "$PRO_STUB_PATH"
    else
      printf 'slot missing\\n' >&2
      exit 2
    fi
    ;;
  wt:c|co:c)
    printf '%s\\n' "$PRO_STUB_PATH"
    ;;
  wt:d|co:d)
    ;;
  *)
    printf 'unexpected pro args: %s\\n' "$*" >&2
    exit 64
    ;;
esac
`, { mode: 0o755 });

  const oldPath = process.env.PATH;
  const oldLog = process.env.PRO_STUB_LOG;
  const oldPathOut = process.env.PRO_STUB_PATH;
  const oldExists = process.env.PRO_STUB_EXISTS;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.PRO_STUB_LOG = log;
  process.env.PRO_STUB_PATH = slotPath;
  process.env.PRO_STUB_EXISTS = exists ? "1" : "0";
  try {
    await fn({ repo, log, slotPath });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.PRO_STUB_LOG;
    else process.env.PRO_STUB_LOG = oldLog;
    if (oldPathOut === undefined) delete process.env.PRO_STUB_PATH;
    else process.env.PRO_STUB_PATH = oldPathOut;
    if (oldExists === undefined) delete process.env.PRO_STUB_EXISTS;
    else process.env.PRO_STUB_EXISTS = oldExists;
    await rm(root, { recursive: true, force: true });
  }
}

test("acquireProSlot reports an existing slot without creating it", async () => {
  await withStubPro(true, async ({ repo, log, slotPath }) => {
    assert.deepEqual(await acquireProSlot("worktree", repo, "fork-api"), { path: slotPath, created: false });
    assert.equal(await readFile(log, "utf8"), "wt s fork-api\n");
  });
});

test("acquireProSlot creates a missing slot and deleteProSlot removes it", async () => {
  await withStubPro(false, async ({ repo, log, slotPath }) => {
    assert.deepEqual(await acquireProSlot("worktree", repo, "fork-api"), { path: slotPath, created: true });
    await deleteProSlot("worktree", repo, "fork-api");
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "wt s fork-api",
      "wt c fork-api",
      "wt d fork-api --force --hard --no-delete-branch",
    ]);
  });
});
