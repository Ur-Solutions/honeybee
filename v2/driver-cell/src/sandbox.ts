/**
 * Cell sandbox wrapper (WP5, spec 05 point 5 — the A4 ruling).
 *
 * The sandbox wraps the INNER spawn command (the harness CLI) with an OS
 * confinement layer: Seatbelt (`sandbox-exec`) on darwin, bwrap on linux.
 * Policy: the filesystem is read-visible but write-confined to the cell,
 * the harness's own home/state dirs, package-manager caches and the usual
 * scratch space; the network is allowed (agents talk to providers).
 *
 * Defaults by node kind (A4): workstation OFF, satellite ON, cloud gateway
 * OFF (the ephemeral VM is the boundary there). Per-cell override wins.
 */
import { realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type NodeKind = "workstation" | "satellite" | "cloud";

export const NODE_KINDS: readonly NodeKind[] = ["workstation", "satellite", "cloud"];

/** A4: sandbox default per node kind. */
export function sandboxDefaultFor(kind: NodeKind): boolean {
  return kind === "satellite";
}

/** Effective sandbox decision: per-cell override > node-kind default. */
export function sandboxEnabled(kind: NodeKind, cellOverride: boolean | null | undefined): boolean {
  return cellOverride ?? sandboxDefaultFor(kind);
}

export interface SandboxPolicy {
  /** The cell wrapper dir — the primary writable subtree. */
  cellDir: string;
  /** Harness home/state dirs and caches that must stay writable. */
  writablePaths: string[];
  /** OS scratch dirs kept writable. Defaults to the platform list. */
  scratchPaths?: string[];
}

/** OS scratch space every process needs writable (default scratch policy). */
export function defaultScratchPaths(osPlatform: string = platform()): string[] {
  return osPlatform === "darwin"
    ? ["/tmp", "/private/tmp", "/private/var/tmp", "/private/var/folders", "/dev"]
    : ["/tmp", "/var/tmp", "/dev"];
}

/**
 * Harness home + cache dirs that stay visible AND writable inside the
 * sandbox (spec: "manager download caches remain visible via the sandbox
 * profile, so cold installs stay network-warm").
 */
export function defaultWritablePaths(home: string = homedir()): string[] {
  return [
    join(home, ".claude"),
    join(home, ".claude.json"),
    join(home, ".codex"),
    join(home, ".grok"),
    join(home, ".config"),
    join(home, ".cache"),
    join(home, ".npm"),
    join(home, ".bun"),
    join(home, ".local", "share", "pnpm"),
    join(home, "Library", "Caches"),
  ];
}

const SB_ESCAPE = /(["\\])/g;

function sbPath(p: string): string {
  return `"${p.replace(SB_ESCAPE, "\\$1")}"`;
}

/**
 * Seatbelt matches RESOLVED paths (`/var/…` is a symlink to `/private/var/…`
 * on macOS); emit both spellings when they differ so a symlinked cells root
 * cannot silently escape or break the allow-list.
 */
function withRealpaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    out.add(p);
    try {
      out.add(realpathSync(p));
    } catch {
      // Path may not exist yet (harness home) — the literal spelling stands.
    }
  }
  return [...out];
}

/**
 * Seatbelt profile (darwin): allow-by-default with a global file-write deny,
 * re-allowing the cell subtree, harness homes/caches and OS scratch space.
 * Later SBPL rules win, so the allow-list overrides the deny.
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const writeAllows = withRealpaths([
    policy.cellDir,
    ...policy.writablePaths,
    ...(policy.scratchPaths ?? defaultScratchPaths("darwin")),
  ])
    .map((p) => `  (subpath ${sbPath(p)})`)
    .join("\n");
  return [
    "(version 1)",
    "; hive v2 cell sandbox — write-confined, read-open, network-open (A4)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    writeAllows,
    ")",
    "",
  ].join("\n");
}

/**
 * bwrap argv (linux): read-only root with the writable paths re-bound
 * read-write. Pure argv construction — testable on any platform; execution
 * is exercised by the linux gate (trmd-metal-3).
 */
export function bwrapArgs(policy: SandboxPolicy, command: string, args: string[]): string[] {
  const out: string[] = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--bind", policy.cellDir, policy.cellDir,
  ];
  for (const p of policy.writablePaths) {
    // --bind-try: absent harness homes must not break the spawn.
    out.push("--bind-try", p, p);
  }
  for (const p of policy.scratchPaths ?? defaultScratchPaths("linux")) {
    if (p === "/tmp" || p === "/dev") continue; // already mounted above
    out.push("--bind-try", p, p);
  }
  out.push("--share-net", "--die-with-parent", "--", command, ...args);
  return out;
}

export interface WrappedCommand {
  command: string;
  args: string[];
  /** darwin only: the profile text the caller must write to `profilePath`. */
  profile?: string;
}

/**
 * Wrap an inner spawn command with the platform sandbox. `profilePath` is
 * where the darwin Seatbelt profile file lives (the caller writes
 * `profile` there before spawning — the box dir owns it).
 */
export function wrapWithSandbox(
  policy: SandboxPolicy,
  command: string,
  args: string[],
  profilePath: string,
  osPlatform: string = platform(),
): WrappedCommand {
  if (osPlatform === "darwin") {
    return {
      command: "sandbox-exec",
      args: ["-f", profilePath, command, ...args],
      profile: seatbeltProfile(policy),
    };
  }
  if (osPlatform === "linux") {
    return { command: "bwrap", args: bwrapArgs(policy, command, args) };
  }
  throw new Error(`cell sandbox: unsupported platform '${osPlatform}'`);
}
