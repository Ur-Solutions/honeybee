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

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
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
 * Resolve which pro repo a directory lives in by longest path-prefix match
 * (a bee's cwd is often a subdir of the repo root). Pure — pass in the entries.
 */
export function resolveProForCwd(
  entries: ProRepoEntry[],
  cwd: string,
): { area: string; project: string; repo: string } | undefined {
  let best: ProRepoEntry | undefined;
  for (const entry of entries) {
    if (cwd === entry.path || cwd.startsWith(`${entry.path}/`)) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  return best ? { area: best.area, project: best.project, repo: best.repo } : undefined;
}
