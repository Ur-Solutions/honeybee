import { execFileSync } from "node:child_process";
import { basename } from "node:path";

// repoTagFor maps a bee's cwd to a coarse "repo" facet: the git top-level
// directory's basename when inside a repo, else the cwd's basename. Two
// different repos that share a basename collide — accepted as a known lossy
// facet (TAGS_AND_RELATIONSHIPS_PRD §13). Memoized per cwd (cwd→repo is stable),
// so `hive list --repo` over a large fleet runs at most one git call per
// distinct cwd, and stamping `@hive_repo` at spawn is a one-time cost.
const cache = new Map<string, string>();

export function repoTagFor(cwd: string): string {
  if (!cwd) return "";
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;
  let tag: string;
  try {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    tag = basename(top) || basename(cwd);
  } catch {
    tag = basename(cwd);
  }
  cache.set(cwd, tag);
  return tag;
}

/** Test-only: clear the memo so a test can re-derive after moving dirs. */
export function clearRepoTagCache(): void {
  cache.clear();
}
