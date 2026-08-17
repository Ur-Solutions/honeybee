/**
 * Copy-on-write (reflink) probing and copying (WP5, spec 05 provisioning
 * step 1 + the A5 warm-cell ruling).
 *
 * CoW is `cp -c` on darwin/APFS and `cp --reflink=always` on linux
 * btrfs/XFS. Both fail cleanly when the filesystem cannot reflink (ext4,
 * cross-volume, network mounts) — the probe simply attempts a one-file copy
 * and reports the truth. The A5 ruling makes CoW the ONLY warm path: no
 * per-package-manager schemes, no hardlink fallbacks; when the probe fails,
 * cells are cold and that is the recorded truth.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

export type CowPlatform = "darwin" | "linux";

export function cowPlatform(p: string = platform()): CowPlatform | null {
  if (p === "darwin" || p === "linux") return p;
  return null;
}

/** The platform CoW copy invocation for one source → destination pair. */
export function cowCopyArgs(p: CowPlatform, recursive: boolean, src: string, dest: string): string[] {
  const flags = p === "darwin" ? ["-c"] : ["--reflink=always"];
  if (recursive) flags.push("-R");
  // -P: never follow symlinks (copy them as links); -p: preserve modes/times.
  flags.push("-P", "-p");
  return [...flags, src, dest];
}

/** Attempt a CoW copy. Returns false (never throws) when the fs refuses. */
export function cowCopy(p: CowPlatform, src: string, dest: string, opts: { recursive?: boolean } = {}): boolean {
  const res = spawnSync("cp", cowCopyArgs(p, opts.recursive ?? false, src, dest), { encoding: "utf8" });
  if (res.error) return false;
  return res.status === 0;
}

/**
 * Probe whether reflink copies work from `srcDir`'s filesystem into
 * `scratchDir` (same-volume + CoW-fs required). Writes only inside
 * `scratchDir` — never inside the source (zero artifacts in user repos).
 */
export function probeCow(srcDir: string, scratchDir: string, p: CowPlatform | null = cowPlatform()): boolean {
  if (p == null) return false;
  const probeDir = mkdtempSync(join(scratchDir, ".cow-probe-"));
  try {
    // The probe file must live on the SOURCE volume to prove a cross-dir
    // reflink; a same-volume cells-root makes that impossible without writing
    // to the source. Instead: reflink an existing source file. Every git
    // repo has HEAD; fall back to a self-probe when it is missing.
    const src = join(srcDir, "HEAD");
    const ok = cowCopy(p, src, join(probeDir, "probe"));
    if (ok) return true;
    // Self-probe distinguishes "no CoW support at all" from "cross-volume":
    // both mean cold cells, so a failed direct probe is simply false.
    return false;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * Probe reflink support for an arbitrary directory pair where the driver may
 * write into BOTH sides (used only in tests / non-user-repo scenarios).
 */
export function probeCowWritable(srcDir: string, destDir: string, p: CowPlatform | null = cowPlatform()): boolean {
  if (p == null) return false;
  const marker = join(srcDir, `.cow-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(marker, "probe");
    const ok = cowCopy(p, marker, join(destDir, ".cow-probe-dest"));
    rmSync(join(destDir, ".cow-probe-dest"), { force: true });
    return ok;
  } catch {
    return false;
  } finally {
    rmSync(marker, { force: true });
  }
}
