/**
 * Two-layer remote working-copy resolution for `hive spawn --node <remote-hsr>`
 * with a LOCAL cwd (the DWIM path — no explicit --repo/--checkout):
 *
 *   Layer 1 — `pro sync --dirty`. When the local `pro` CLI is installed and the
 *   cwd is a pro-managed repo/worktree/checkout, sync it to the node with
 *   `pro sync --dirty <endpoint>` and spawn in the printed remote canonical
 *   checkout (`~/Projects/<area>/<project>/repos/<repo>` on the node). pro ships
 *   a git BUNDLE of the current branch over ssh plus a worktree-vs-HEAD patch —
 *   unpushed commits AND uncommitted work travel, nothing round-trips through a
 *   git host, and the remote needs only git (pro is NOT required on the node).
 *
 *   `--dirty` is the default because a dirty tree is the NORMAL state of a repo
 *   you are working in: without it every "spawn a bee on metal-1" mid-edit died
 *   on `refusing to sync dirty working tree`. Older pro installs that reject the
 *   flag are retried clean, so a stale node/laptop degrades instead of halting.
 *   What pro still refuses — detached HEAD, a remote branch that is ahead, a
 *   remote checkout carrying someone ELSE's edits — fails the spawn loudly with
 *   a remedy attached; silently falling back would run the bee against different
 *   code, or throw away work sitting on the node.
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
  const timeout = opts.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: opts.cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      // A timeout kills the child with a signal and no stderr of its own, which
      // would otherwise surface as a bare "exited 1" — name it instead.
      const timedOut = Boolean(error && (error as { killed?: boolean }).killed && child.exitCode === null);
      resolve({
        ok: !error,
        stdout: stdout ?? "",
        stderr: timedOut ? `${command} timed out after ${Math.round(timeout / 1000)}s` : (stderr ?? ""),
        code: error ? (timedOut ? "ETIMEDOUT" : ((error as NodeJS.ErrnoException).code ?? 1)) : 0,
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

/** A pro too old to know `--dirty` — retry the sync clean rather than halt. */
function proRejectsDirtyFlag(stderr: string): boolean {
  return /unknown sync flag: --dirty/i.test(stderr);
}

/**
 * Turn pro's refusal into something the operator can act on. These are the
 * states pro will NOT paper over, each with the one command that clears it.
 */
function remedyFor(stderr: string, endpoint: string): string {
  if (/dirty remote tree/i.test(stderr)) {
    return "the checkout on the node has changes pro did not put there (a bee already working in it, or an edit made on the node) — inspect it, or re-spawn with HIVE_REMOTE_SYNC=force to overwrite";
  }
  if (/not an ancestor of local/i.test(stderr)) {
    return `the node has commits on this branch that you do not — \`pro pull ${endpoint}\` first, then re-spawn`;
  }
  if (/detached HEAD/i.test(stderr)) {
    return "check out a branch, or spawn with --repo/--checkout";
  }
  if (/limit \d+/i.test(stderr) && /uncommitted changes are/i.test(stderr)) {
    return "commit or gitignore the bulk, or raise PRO_SYNC_MAX_DIRTY_BYTES";
  }
  return "";
}

export async function resolveRemoteCwd(
  localCwd: string,
  node: NodeRecord,
  provisioner: RemoteProvisioner,
  deps: { exec?: ExecHook } = {},
): Promise<RemoteCwdResolution | null> {
  const exec = deps.exec ?? defaultExec;

  // Operator switch (Apiary settings / shell):
  //   auto (unset)  pro sync --dirty, then origin provisioning — the default
  //   force         as auto, plus --force: overwrite foreign dirt on the node
  //   clean         pro sync WITHOUT --dirty (committed state only)
  //   origin        skip the pro layer entirely
  //   off           skip BOTH layers (remote derives its per-bee cwd)
  const mode = (process.env.HIVE_REMOTE_SYNC ?? "auto").toLowerCase();
  if (mode === "off") return null;

  // ── Layer 1: pro sync into the node's canonical checkout ──────────────────
  // `pro sync HOST` prints the remote repo dir as its final stdout line.
  // NOTE: resolve the USER's pro off PATH — on Ubuntu nodes /usr/bin/pro is
  // Canonical's Ubuntu Pro client, but this exec runs LOCALLY where PATH order
  // puts ~/.local/bin first; a wrong-pro invocation fails as not-applicable.
  const endpoint = node.endpoint ?? node.name;
  const syncFlags = mode === "clean" ? [] : mode === "force" ? ["--dirty", "--force"] : ["--dirty"];
  // The patch can carry every uncommitted byte in the tree, so give the transfer
  // real headroom — a timeout here halts the spawn just like a refusal does.
  const timeoutMs = 300_000;
  const runSync = (flags: string[]): Promise<ExecResult> =>
    exec("pro", ["sync", ...flags, endpoint], { cwd: localCwd, timeoutMs });
  let sync = mode === "origin"
    ? ({ ok: false, stdout: "", stderr: "", code: "ENOENT" } as ExecResult)
    : await runSync(syncFlags);
  let downgraded = false;
  if (!sync.ok && syncFlags.length > 0 && proRejectsDirtyFlag(sync.stderr)) {
    // pro predates --dirty. A clean sync still beats no spawn at all; the note
    // says so, because uncommitted work did NOT travel.
    sync = await runSync([]);
    downgraded = true;
  }
  if (sync.ok) {
    const lines = sync.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const remotePath = lines[lines.length - 1];
    if (remotePath && remotePath.startsWith("/")) {
      const how = downgraded
        ? "pro sync (committed only — pro is too old for --dirty)"
        : `pro sync${syncFlags.length ? ` ${syncFlags.join(" ")}` : " (committed state only)"}`;
      return { cwd: remotePath, via: "pro-sync", note: `${how} → ${remotePath}` };
    }
    // A "successful" pro that printed no path is not our pro (e.g. Ubuntu Pro
    // answering `pro sync` with help text) — treat as not applicable.
  } else if (sync.code !== "ENOENT" && !proSaysNotApplicable(sync.stderr)) {
    // pro exists and REFUSED (detached/non-ff/foreign remote dirt/ssh): surface
    // it verbatim, with the remedy when we recognize the refusal.
    const detail = sync.stderr.trim() || `pro sync exited ${sync.code}`;
    const remedy = remedyFor(sync.stderr, endpoint);
    throw new Error(`pro sync to ${node.name} failed: ${detail}${remedy ? ` — ${remedy}` : ""}`);
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
