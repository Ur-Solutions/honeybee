/**
 * Plain-git plumbing for the cell driver (WP5, spec 05).
 *
 * A1 ruling: no Kaia anywhere in v2 — everything the cell driver needs from
 * git is a few hundred lines of plain plumbing, executed synchronously with a
 * pinned, deterministic environment (no user global/system config, no hooks).
 */
import { spawnSync } from "node:child_process";
import { devNull } from "node:os";

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Deterministic environment for every driver-run git command: the user's
 * global/system config never leaks into cell operations (gpg signing, hooks
 * templates, fsmonitor daemons), and merge/rebase commits the driver mints
 * carry a fixed identity.
 */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "hive-cell",
    GIT_AUTHOR_EMAIL: "cell@hive.invalid",
    GIT_COMMITTER_NAME: "hive-cell",
    GIT_COMMITTER_EMAIL: "cell@hive.invalid",
    ...extra,
  };
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run git, returning the result without throwing. */
export function tryGit(cwd: string, args: string[]): GitResult {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  if (res.error) throw res.error; // git binary missing — a machine boundary, not a git failure
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run git; non-zero exit throws GitError. Returns trimmed stdout. */
export function git(cwd: string, args: string[]): string {
  const res = tryGit(cwd, args);
  if (res.status !== 0) throw new GitError(args, res.status, res.stderr);
  return res.stdout.trim();
}

/** rev-parse a ref; null when it does not resolve. */
export function revParse(repo: string, ref: string): string | null {
  const res = tryGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** True iff `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  const res = tryGit(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return res.status === 0;
}

/** True iff the commit object exists in the repo. */
export function hasCommit(repo: string, sha: string): boolean {
  const res = tryGit(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  return res.status === 0;
}

/** The branch HEAD symbolically points at (short name), or null when detached. */
export function currentBranch(repo: string): string | null {
  const res = tryGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** `git status --porcelain` — empty string means a clean working tree. */
export function porcelainStatus(repo: string): string {
  return git(repo, ["status", "--porcelain"]);
}

/** Full ref set of a repo (`git for-each-ref`), for bit-identical assertions. */
export function refSet(repo: string): string {
  return git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
}
