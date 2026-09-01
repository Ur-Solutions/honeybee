/**
 * ONE executable-resolution rule for the whole node (cohort-0 finding F8).
 *
 * The daemon runs under launchd with a PATH that misses the dirs harness
 * CLIs are actually installed into (~/.local/bin, homebrew, bun, mise
 * shims), so a bare `spawn("codex")` ENOENTs even when the CLI is installed
 * — while GUI-side probes (Apiary's resolveRuntimeExecutable) DID find it:
 * two resolution rules, one lie to the operator. Probe truth must equal
 * spawn truth, so every surface that answers "is this harness runnable on
 * this node?" and every spawn-config assembly resolves through THIS module.
 *
 * The rule (mirrors Apiary packages/adapters/src/bin.ts exactly): the
 * caller's PATH dirs in order first, then the fixed fallback-dir list in
 * order. No caching — resolution happens per spawn/probe so an operator who
 * installs a CLI is seen on the very next attempt, and probe results can
 * never go stale against spawn results.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve, sep } from "node:path";

/** GUI/launchd-launch fallback dirs, in fixed precedence order (Apiary parity). */
export function executableFallbackDirs(home: string = homedir()): readonly string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    resolve(home, ".local", "bin"),
    resolve(home, "bin"),
    resolve(home, ".kimi-code", "bin"),
    resolve(home, ".bun", "bin"),
    resolve(home, ".local", "share", "mise", "shims"),
  ];
}

export const EXECUTABLE_FALLBACK_DIRS: readonly string[] = executableFallbackDirs();

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a resolution came from — recorded so a stale bun/mise leftover is
 * visible as such instead of masquerading as a working install:
 *  - `PATH`: found in the resolving environment's PATH (dir order).
 *  - `fallback`: found in EXECUTABLE_FALLBACK_DIRS (list order).
 *  - `configured_path`: the configured command already names a path
 *    (contains a separator); it is never rewritten.
 */
export type ExecutableResolutionSource = "PATH" | "fallback" | "configured_path";

export interface ResolvedExecutable {
  /** Absolute path (or the configured path verbatim for `configured_path`). */
  path: string;
  source: ExecutableResolutionSource;
}

export interface ResolveExecutableOptions {
  /** Environment whose PATH governs resolution (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Injectable predicate for tests. */
  isExecutable?: (path: string) => boolean;
  /** Injectable fallback list for tests (default: EXECUTABLE_FALLBACK_DIRS). */
  fallbackDirs?: readonly string[];
}

/**
 * Resolve a bare executable name to an absolute path: PATH dirs in order,
 * then the fallback dirs in order. A command that already names a path is
 * honored verbatim when executable. Returns null when nothing runnable is
 * found — the caller decides whether that is a refusal, a diagnostic fact,
 * or an honest unresolved spawn attempt.
 */
export function resolveExecutable(command: string, opts: ResolveExecutableOptions = {}): ResolvedExecutable | null {
  const executable = opts.isExecutable ?? isExecutableFile;
  if (command.includes(sep)) {
    return executable(resolve(command)) ? { path: command, source: "configured_path" } : null;
  }
  const env = opts.env ?? process.env;
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(dir, command);
    if (executable(candidate)) return { path: candidate, source: "PATH" };
  }
  for (const dir of opts.fallbackDirs ?? EXECUTABLE_FALLBACK_DIRS) {
    const candidate = resolve(dir, command);
    if (executable(candidate)) return { path: candidate, source: "fallback" };
  }
  return null;
}

/**
 * The resolution fact recorded on a spawn config. `not_found` means the full
 * rule (PATH + fallbacks) found nothing NOW — the spawn still proceeds with
 * the bare name so the OS ENOENT stays the honest diagnostic, and the
 * exit-detail surface names the executable for the operator.
 */
export interface SpawnCommandResolution {
  /** The configured command before resolution (bare name or explicit path). */
  executable: string;
  /** Absolute path actually spawned; null when nothing was found. */
  path: string | null;
  source: ExecutableResolutionSource | "not_found";
}

/**
 * The spawn-config half of the rule: resolve a configured harness command to
 * the absolute path the runtime will exec, recording where it came from. A
 * command that names a path, and a bare name nothing resolves for, pass
 * through unchanged (unresolved-but-attempted; ENOENT stays honest).
 */
export function resolveSpawnCommand(
  command: string,
  opts: ResolveExecutableOptions = {},
): { command: string; resolution: SpawnCommandResolution } {
  if (command.includes(sep)) {
    return { command, resolution: { executable: command, path: command, source: "configured_path" } };
  }
  const resolved = resolveExecutable(command, opts);
  if (!resolved) {
    return { command, resolution: { executable: command, path: null, source: "not_found" } };
  }
  return { command: resolved.path, resolution: { executable: command, path: resolved.path, source: resolved.source } };
}

/**
 * The operator-facing sentence for a spawn whose command resolved nowhere.
 * This text rides the crashed runtime's exit detail into the mirror — it
 * must name the executable and the node-local cause, never restyle the
 * crashed/spawn_failed mechanics around it.
 */
export function executableNotFoundDetail(executable: string): string {
  return `executable '${executable}' was not found on this node (searched PATH and the standard install dirs); install it or point the agent config at its absolute path`;
}
