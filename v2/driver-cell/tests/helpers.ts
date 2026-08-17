/**
 * Cell-driver test helpers. Everything runs in fresh OS temp dirs (mkdtemp)
 * — origin repos, cells roots, all of it. Never ~/.hive, never the repo, and
 * NEVER any user repository: every "origin" is a fixture built here.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../src/git.ts";

export function sh(cwd: string, cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: gitEnv() });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

export function g(cwd: string, args: string[]): string {
  return sh(cwd, "git", args);
}

export interface FixtureOrigin {
  repo: string;
  /** HEAD commit of `main`. */
  sha: string;
}

/** A small origin repo: main branch, two files, one commit (plus extras). */
export function makeOrigin(root: string, name = "origin"): FixtureOrigin {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  g(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const version = 1;\n");
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-m", "initial"]);
  return { repo, sha: g(repo, ["rev-parse", "HEAD"]) };
}

/** Add a commit to the origin's current branch; returns the new sha. */
export function commitOn(repo: string, file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content);
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-m", message]);
  return g(repo, ["rev-parse", "HEAD"]);
}

/** Commit inside a cell space (detached HEAD) — the "agent did work" fixture. */
export function commitInCell(spaceDir: string, file: string, content: string, message: string): string {
  writeFileSync(join(spaceDir, file), content);
  g(spaceDir, ["add", "-A"]);
  g(spaceDir, ["commit", "-m", message]);
  return g(spaceDir, ["rev-parse", "HEAD"]);
}

export interface OriginFingerprint {
  refs: string;
  head: string;
  status: string;
  branch: string | null;
}

/** Bit-identical assertion material: full ref set + HEAD + worktree status. */
export function fingerprintOrigin(repo: string): OriginFingerprint {
  const branchRes = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    env: gitEnv(),
  });
  return {
    refs: g(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    head: g(repo, ["rev-parse", "HEAD"]),
    status: g(repo, ["status", "--porcelain"]),
    branch: branchRes.status === 0 ? branchRes.stdout.trim() : null,
  };
}

/** `git fsck` — must report no corruption after any capture operation. */
export function fsckClean(repo: string): boolean {
  const res = spawnSync("git", ["fsck", "--connectivity-only", "--no-dangling"], {
    cwd: repo,
    encoding: "utf8",
    env: gitEnv(),
  });
  return res.status === 0 && (res.stdout + res.stderr).trim().length === 0;
}

export interface CellTestRig {
  root: string;
  cellsRoot: string;
  origin: FixtureOrigin;
  cleanup: () => void;
}

export function makeRig(): CellTestRig {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-cell-"));
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot, { recursive: true });
  return {
    root,
    cellsRoot,
    origin: makeOrigin(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
