/**
 * Thin bridge to the external `pro` CLI (project folders for humans and tools).
 *
 * The `hive new` project column lets the operator pick a working directory from
 * their `pro`-managed repos instead of typing a path. We shell out to the stable
 * `pro ls repos` interface — tab-separated `area/project<TAB>repo<TAB>abspath` —
 * rather than reading pro's private index file, so we track whatever `pro`
 * decides to expose. Missing/old `pro` installs surface a friendly error that
 * the picker shows inline; they never crash the spawn flow.
 */

import { execFile } from "node:child_process";

export type ProRepo = {
  /** "area/project/repo" — the display label in the picker. */
  label: string;
  /** Absolute path to the repo, used directly as the spawn cwd. */
  path: string;
  /** "area/project" group, shown dimmed for context. */
  project: string;
};

function run(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`\`${command}\` CLI not found on PATH — install it or pick "Path…" instead`));
          return;
        }
        const detail = stderr.trim() || error.message;
        reject(new Error(`\`${command} ${args.join(" ")}\` failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Parse `pro ls repos` output (tab-separated `area/project<TAB>repo<TAB>abspath`).
 * Lines that don't carry an absolute path are skipped rather than shown as
 * broken rows. Kept pure (no I/O) so it can be unit-tested.
 */
export function parseProRepos(stdout: string): ProRepo[] {
  const repos: ProRepo[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [project, repo, path] = line.split("\t");
    if (!path || !path.startsWith("/")) continue;
    repos.push({
      label: repo ? `${project}/${repo}` : (project ?? path),
      path,
      project: project ?? "",
    });
  }
  return repos;
}

/**
 * List every repo `pro` knows about, in pro's own ordering.
 */
export async function listProRepos(): Promise<ProRepo[]> {
  return parseProRepos(await run("pro", ["ls", "repos"]));
}

export type ProRepoEntry = {
  area: string;
  project: string;
  repo: string;
  /** Absolute repo path. */
  path: string;
};

/**
 * Parse `pro ls repos` into structured area/project/repo rows (pure). The first
 * column is "area/project"; we split it so callers can group by either facet.
 */
export function parseProRepoEntries(stdout: string): ProRepoEntry[] {
  const entries: ProRepoEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [areaProject, repo, path] = line.split("\t");
    if (!path || !path.startsWith("/")) continue;
    const [area = "", project = ""] = (areaProject ?? "").split("/");
    entries.push({ area, project, repo: repo ?? "", path });
  }
  return entries;
}

/** Structured repo inventory from `pro` (for grouping bees by pro facets). */
export async function listProRepoEntries(): Promise<ProRepoEntry[]> {
  return parseProRepoEntries(await run("pro", ["ls", "repos"]));
}

/**
 * Resolve which pro repo entry a directory lives in by longest path-prefix
 * match (a bee's cwd is often a subdir of the repo root). Pure — pass in the
 * entries. Returns the full entry (callers that only need the facets use
 * {@link resolveProForCwd}; the worktree/checkout step needs `path` too).
 */
export function resolveProEntryForCwd(entries: ProRepoEntry[], cwd: string): ProRepoEntry | undefined {
  let best: ProRepoEntry | undefined;
  for (const entry of entries) {
    if (cwd === entry.path || cwd.startsWith(`${entry.path}/`)) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  return best;
}

/**
 * Resolve which pro repo a directory lives in by longest path-prefix match
 * (a bee's cwd is often a subdir of the repo root). Pure — pass in the entries.
 */
export function resolveProForCwd(
  entries: ProRepoEntry[],
  cwd: string,
): { area: string; project: string; repo: string } | undefined {
  const best = resolveProEntryForCwd(entries, cwd);
  return best ? { area: best.area, project: best.project, repo: best.repo } : undefined;
}

export type ProSlotKind = "worktree" | "checkout";

/**
 * Lower-case a free-typed name into a pro slug (`[a-z0-9][a-z0-9-]*`, no
 * leading/trailing dash — pro's `is_slug`). Returns "" when nothing usable
 * remains, so callers surface a "type a name" hint instead of shipping an
 * invalid slug. Pure (no I/O).
 */
export function toProSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Create (or reuse) a pro worktree/checkout beside the repo and return its
 * absolute path. Shells out to `pro <wt|co> s -c <name>` from inside `repoPath`
 * so pro resolves the area/project/repo from the directory (no REPO: qualifier
 * needed even in multi-repo projects); `s -c` prints the slot path on stdout —
 * git/clone chatter goes to stderr — and reuses an existing slot of the same
 * name rather than erroring. The longer timeout covers a `co` full clone.
 */
export async function createProSlot(kind: ProSlotKind, repoPath: string, name: string): Promise<string> {
  const sub = kind === "worktree" ? "wt" : "co";
  const stdout = await run("pro", [sub, "s", "-c", name], { cwd: repoPath, timeoutMs: 300_000 });
  const path = stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!path.startsWith("/")) throw new Error(`\`pro ${sub} s -c ${name}\` did not return a path`);
  return path;
}
