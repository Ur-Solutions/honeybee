import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { test } from "node:test";
import { clearRepoTagCache, repoTagFor } from "../src/repoTag.js";

async function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  // realpath because macOS tmpdir is a /var → /private/var symlink, and git
  // rev-parse --show-toplevel returns the canonical (resolved) path.
  const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("repoTagFor returns the git top-level basename inside a repo", async () => {
  await withTempDir("hive-repotag-repo-", async (dir) => {
    clearRepoTagCache();
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    // A nested subdir still resolves to the repo's top-level basename.
    const nested = join(dir, "src", "deep");
    execFileSync("mkdir", ["-p", nested]);
    assert.equal(repoTagFor(dir), basename(dir));
    assert.equal(repoTagFor(nested), basename(dir));
  });
});

test("repoTagFor returns the cwd basename outside a repo", async () => {
  await withTempDir("hive-repotag-plain-", async (dir) => {
    clearRepoTagCache();
    assert.equal(repoTagFor(dir), basename(dir));
  });
});

test("repoTagFor memoizes per cwd (clearRepoTagCache re-derives)", async () => {
  await withTempDir("hive-repotag-memo-", async (dir) => {
    clearRepoTagCache();
    // First call: plain dir, basename of itself.
    assert.equal(repoTagFor(dir), basename(dir));
    // git init now makes it a repo whose top-level basename is the same as the
    // dir basename — but the memo means we still see the cached value without
    // re-running git. To prove memoization we instead init a repo whose
    // top-level differs from a nested path and check the cache survives.
    const nested = join(dir, "child");
    execFileSync("mkdir", ["-p", nested]);
    // Prime the cache for `nested` as a plain dir (its own basename).
    assert.equal(repoTagFor(nested), basename(nested));
    // Now make the PARENT a git repo. Without clearing, the memoized value for
    // `nested` persists (still its own basename, not the repo basename).
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    assert.equal(repoTagFor(nested), basename(nested), "memoized value survives until cleared");
    // After clearing, `nested` re-derives to the repo top-level basename.
    clearRepoTagCache();
    assert.equal(repoTagFor(nested), basename(dir), "re-derives after clear");
  });
});
