/**
 * Two-layer remote working-copy resolution for `hive spawn --node <remote-hsr>`
 * with a LOCAL cwd (the DWIM path — no explicit --repo/--checkout):
 *
 *   Layer 1 — `pro sync`. When the local `pro` CLI is installed and the cwd is
 *   a pro-managed repo/worktree/checkout, sync it to the node with
 *   `pro sync <endpoint>` and spawn in the printed remote canonical checkout
 *   (`~/Projects/<area>/<project>/repos/<repo>` on the node). pro ships a git
 *   BUNDLE of the current branch over ssh — unpushed commits travel, nothing
 *   round-trips through a git host, and the remote needs only git (pro is NOT
 *   required on the node). pro refuses dirty/detached/non-fast-forward trees;
 *   those refusals FAIL the spawn loudly — silently falling back would run the
 *   bee against stale code.
 *
 *   Layer 2 — origin provisioning. Not pro-managed (or no pro installed) but a
 *   git repo with an `origin` remote: reuse the existing APIA-95 provisioning
 *   (`provisionRemote`), which clones on the node under its
 *   `~/.hive/worktrees/<name>` and idempotently REUSES an existing checkout of
 *   the same name. Only pushed commits travel here; the current branch rides
 *   along when origin has it, else the clone's default branch is used.
 *
 *   Neither applies (not a git repo at all) → null: the remote derives its
 *   per-bee empty cwd exactly as before.
 *
 * Node builtins only; exec is injectable for tests.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { NodeRecord } from "../node.js";

export type ExecResult = { ok: boolean; stdout: string; stderr: string; code: number | string };
export type ExecHook = (command: string, args: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

/** The one provisioning verb this module needs off RemoteHsrSubstrate. */
export type RemoteProvisioner = {
  provisionRemote(params: { repo: string; branch?: string; name?: string }): Promise<{ path: string }>;
};

export type RemoteCwdResolution = {
  /** The REMOTE absolute path to spawn in. */
  cwd: string;
  /** Which layer produced it — for the operator-facing note. */
  via: "pro-sync" | "provisioned";
  /** Secret-free, one-line operator note (branch/reuse facts). */
  note: string;
};

function defaultExec(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: error ? ((error as NodeJS.ErrnoException).code ?? 1) : 0,
      });
    });
  });
}

/**
 * pro refusals that mean "this cwd is not pro-sync territory" — fall through to
 * layer 2. Everything else from a found pro binary is a REAL refusal (dirty
 * tree, detached HEAD, non-fast-forward remote, ssh failure) and must fail the
 * spawn rather than silently running the bee against different code.
 */
function proSaysNotApplicable(stderr: string): boolean {
  return /run inside a (pro-managed|git repo)/i.test(stderr);
}

export async function resolveRemoteCwd(
  localCwd: string,
  node: NodeRecord,
  provisioner: RemoteProvisioner,
  deps: { exec?: ExecHook } = {},
): Promise<RemoteCwdResolution | null> {
  const exec = deps.exec ?? defaultExec;

  // Operator switch (Apiary settings / shell): HIVE_REMOTE_SYNC=origin skips
  // the pro layer entirely; =off skips BOTH layers (remote derives its per-bee
  // cwd). Unset/auto = pro-first, the default.
  const mode = (process.env.HIVE_REMOTE_SYNC ?? "auto").toLowerCase();
  if (mode === "off") return null;

  // ── Layer 1: pro sync into the node's canonical checkout ──────────────────
  // `pro sync HOST` prints the remote repo dir as its final stdout line.
  // NOTE: resolve the USER's pro off PATH — on Ubuntu nodes /usr/bin/pro is
  // Canonical's Ubuntu Pro client, but this exec runs LOCALLY where PATH order
  // puts ~/.local/bin first; a wrong-pro invocation fails as not-applicable.
  const endpoint = node.endpoint ?? node.name;
  const sync = mode === "origin"
    ? ({ ok: false, stdout: "", stderr: "", code: "ENOENT" } as ExecResult)
    : await exec("pro", ["sync", endpoint], { cwd: localCwd, timeoutMs: 180_000 });
  if (sync.ok) {
    const lines = sync.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const remotePath = lines[lines.length - 1];
    if (remotePath && remotePath.startsWith("/")) {
      return { cwd: remotePath, via: "pro-sync", note: `pro sync → ${remotePath}` };
    }
    // A "successful" pro that printed no path is not our pro (e.g. Ubuntu Pro
    // answering `pro sync` with help text) — treat as not applicable.
  } else if (sync.code !== "ENOENT" && !proSaysNotApplicable(sync.stderr)) {
    // pro exists and REFUSED (dirty/detached/non-ff/ssh): surface it verbatim.
    const detail = sync.stderr.trim() || `pro sync exited ${sync.code}`;
    throw new Error(`pro sync to ${node.name} failed: ${detail}`);
  }

  // ── Layer 2: provision from origin into the node's ~/.hive/worktrees ──────
  const origin = await exec("git", ["-C", localCwd, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  const originUrl = origin.ok ? origin.stdout.trim() : "";
  if (!originUrl) return null;

  const name = basename(originUrl.replace(/\/+$/, "")).replace(/\.git$/, "") || undefined;
  // Ride the local branch along only when origin actually has it — layer 2
  // clones from origin, so an unpushed branch would fail the clone.
  let branch: string | undefined;
  const local = await exec("git", ["-C", localCwd, "symbolic-ref", "--short", "HEAD"], { timeoutMs: 10_000 });
  const localBranch = local.ok ? local.stdout.trim() : "";
  if (localBranch) {
    const onOrigin = await exec("git", ["-C", localCwd, "ls-remote", "--heads", "origin", localBranch], { timeoutMs: 30_000 });
    if (onOrigin.ok && onOrigin.stdout.trim().length > 0) branch = localBranch;
  }

  const prov = await provisioner.provisionRemote({ repo: originUrl, ...(branch ? { branch } : {}), ...(name ? { name } : {}) });
  const branchNote = branch ? ` @ ${branch}` : localBranch ? ` (origin lacks ${localBranch}; default branch)` : "";
  return { cwd: prov.path, via: "provisioned", note: `provisioned ${originUrl}${branchNote} → ${prov.path}` };
}
