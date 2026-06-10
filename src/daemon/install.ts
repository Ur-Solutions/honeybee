import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { daemonLaunchdErrPath, daemonLaunchdOutPath, daemonRoot } from "./log.js";
import {
  DEFAULT_LAUNCH_LABEL,
  launchAgentsDir,
  plistPathForLabel,
  renderPlist,
} from "./plist.js";

export { DEFAULT_LAUNCH_LABEL };

const execFileAsync = promisify(execFile);

/**
 * Fallback PATH burned into the plist when the installing shell has none.
 * Must include the Homebrew prefixes — user-domain launchd defaults to
 * /usr/bin:/bin:/usr/sbin:/sbin, where tmux is typically absent.
 */
const DEFAULT_LAUNCHD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type InstallOptions = {
  label?: string;
  /** Override entry point (process.argv[1] by default). */
  cliEntry?: string;
  /** Override the node binary (process.execPath by default). */
  nodeBinary?: string;
  /** Force install even when an existing plist is present. */
  force?: boolean;
  /** Skip launchctl bootstrap (testing helper). */
  skipBootstrap?: boolean;
  /** Additional argv after `daemon run`. */
  extraArgs?: string[];
};

export type InstallResult = {
  label: string;
  plistPath: string;
  installed: boolean;
  bootstrapped: boolean;
  message: string;
};

export type UninstallOptions = {
  label?: string;
  /** Skip launchctl bootout (testing helper). */
  skipBootout?: boolean;
};

export type UninstallResult = {
  label: string;
  plistPath: string;
  removed: boolean;
  bootedOut: boolean;
  message: string;
};

export type LaunchctlResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

/**
 * Default runner — execFile's `launchctl` from PATH. Overridable for tests
 * via the LaunchctlRunner type so we can stub launchctl without depending
 * on a real macOS host.
 */
const defaultLaunchctlRunner: LaunchctlRunner = async (args) => {
  try {
    const result = await execFileAsync("launchctl", args, { maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    // Promisified execFile puts the numeric exit code on err.code (err.code
    // is a string like ENOENT for spawn failures, so guard on typeof).
    const err = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
};

let currentRunner: LaunchctlRunner = defaultLaunchctlRunner;

/**
 * Override the launchctl runner globally. Returns a disposer that restores
 * the previous runner — used by tests to inject a fake launchctl.
 */
export function setLaunchctlRunner(runner: LaunchctlRunner): () => void {
  const previous = currentRunner;
  currentRunner = runner;
  return () => {
    currentRunner = previous;
  };
}

/**
 * Resolve the user's launchctl domain target. On macOS each GUI session is
 * `gui/<UID>`. Honeybee only ever installs into the per-user domain — never
 * the system domain.
 */
export function userDomain(uid: number = process.getuid?.() ?? 0): string {
  return `gui/${uid}`;
}

export function userServiceTarget(label: string, uid: number = process.getuid?.() ?? 0): string {
  return `${userDomain(uid)}/${label}`;
}

/**
 * True if the current platform supports launchctl-based install. Caller
 * MUST gate install/uninstall/start/stop on this and emit a clear error
 * directing the user to the systemd snippet on Linux.
 */
export function isLaunchctlSupported(): boolean {
  return process.platform === "darwin";
}

/**
 * Resolve the CLI entry point to embed in ProgramArguments. Uses
 * `process.argv[1]` by default, but the caller can override (testing).
 *
 * Resolves the path through fs.realpath so symlinks (npm link, npx, etc.)
 * are followed.
 */
export async function resolveCliEntry(override?: string): Promise<string> {
  const raw = override ?? process.argv[1];
  if (!raw) throw new Error("daemon install: could not resolve CLI entry path");
  const { realpath } = await import("node:fs/promises");
  try {
    return await realpath(raw);
  } catch {
    return raw;
  }
}

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => null));
}

async function readPlistFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * True iff a Honeybee plist file exists for the given label.
 */
export async function isAgentInstalled(label: string = DEFAULT_LAUNCH_LABEL): Promise<boolean> {
  return exists(plistPathForLabel(label));
}

/**
 * Render the plist installAgent would write for the given options. Exposed
 * so install/status flows can compare the candidate against what's on disk.
 */
export async function renderCandidatePlist(options: InstallOptions = {}): Promise<string> {
  const label = options.label ?? DEFAULT_LAUNCH_LABEL;
  const cliEntry = await resolveCliEntry(options.cliEntry);
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const extraArgs = options.extraArgs ?? [];

  const env: Record<string, string> = {};
  if (process.env.HIVE_STORE_ROOT) env.HIVE_STORE_ROOT = process.env.HIVE_STORE_ROOT;
  // We want the storeRoot to remain stable even if the user runs the daemon
  // without HIVE_STORE_ROOT — burn the resolved value in.
  if (!env.HIVE_STORE_ROOT) env.HIVE_STORE_ROOT = storeRoot();
  // Burn PATH in too: user-domain launchd defaults to /usr/bin:/bin:/usr/sbin:/sbin,
  // where Homebrew-installed tmux does not exist — the daemon would "run" while
  // every tmux probe ENOENTs.
  env.PATH = process.env.PATH || DEFAULT_LAUNCHD_PATH;

  return renderPlist({
    label,
    programArguments: [nodeBinary, cliEntry, "daemon", "run", ...extraArgs],
    workingDirectory: storeRoot(),
    // Dedicated launchd stream files — NOT daemonLogPath(): launchd's open fd
    // would follow our rotation rename and stdout would land in the rotated file.
    stdOutPath: daemonLaunchdOutPath(),
    stdErrPath: daemonLaunchdErrPath(),
    // Relaunch only after unsuccessful exits so a clean deliberate exit
    // (e.g. `hive daemon stop`) does not loop forever.
    keepAlive: { successfulExit: false },
    runAtLoad: true,
    environmentVariables: env,
  });
}

/**
 * Install the LaunchAgent: write the plist + bootstrap into the user's
 * launchctl domain. Idempotent — calling twice without --force returns
 * `installed=false` with an explanatory message; if the on-disk plist no
 * longer matches what we would write (e.g. the CLI moved), the message says
 * so and directs the user to --force. With --force the existing service is
 * booted out first so the rewritten plist actually takes effect.
 */
export async function installAgent(options: InstallOptions = {}): Promise<InstallResult> {
  const label = options.label ?? DEFAULT_LAUNCH_LABEL;
  const plistPath = plistPathForLabel(label);
  const plist = await renderCandidatePlist(options);

  if (!options.force) {
    const existing = await readPlistFile(plistPath);
    if (existing !== null) {
      const message = existing === plist
        ? `already installed at ${plistPath}`
        : `already installed at ${plistPath} but stale (plist differs from what install would write; re-run with --force)`;
      return { label, plistPath, installed: false, bootstrapped: false, message };
    }
  }

  // Make sure ~/.hive/daemon/ exists so launchd can open the log files.
  await mkdir(daemonRoot(), { recursive: true });
  await mkdir(launchAgentsDir(), { recursive: true });

  await atomicWriteFile(plistPath, plist, { mode: 0o644 });

  let bootstrapped = false;
  let message = `wrote ${plistPath}`;
  if (!options.skipBootstrap) {
    if (!isLaunchctlSupported()) {
      message = `${message}; launchctl bootstrap skipped (platform=${process.platform})`;
    } else {
      if (options.force) {
        // An old service may still be running with the old plist; bootstrap
        // alone would fail "already loaded" and leave it running until reboot.
        // Boot it out first; "not loaded" is fine to ignore.
        const bootout = await currentRunner(["bootout", userDomain(), plistPath]);
        if (bootout.ok) {
          message = `${message}; booted out existing service`;
        } else if (!isNotLoadedError(bootout)) {
          message = `${message}; bootout failed (exit ${bootout.exitCode}): ${bootout.stderr.trim() || bootout.stdout.trim()}`;
        }
      }
      const result = await currentRunner(["bootstrap", userDomain(), plistPath]);
      if (result.ok) {
        bootstrapped = true;
        message = `${message}; bootstrapped into ${userDomain()}`;
      } else {
        // Bootstrap returns non-zero if the service is already loaded; we
        // surface but don't tear down the plist (idempotent path).
        message = `${message}; bootstrap failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`;
      }
    }
  }

  return { label, plistPath, installed: true, bootstrapped, message };
}

/**
 * True when a launchctl bootout failure just means "service was not loaded"
 * (exit 3 = ESRCH, or the human-readable equivalents).
 */
function isNotLoadedError(result: LaunchctlResult): boolean {
  if (result.exitCode === 3) return true;
  return /no such process|not loaded|could not find service/i.test(`${result.stderr} ${result.stdout}`);
}

/**
 * Remove the LaunchAgent: bootout + delete the plist. Idempotent — if the
 * plist doesn't exist we still attempt bootout (harmless) and report
 * `removed=false`.
 */
export async function uninstallAgent(options: UninstallOptions = {}): Promise<UninstallResult> {
  const label = options.label ?? DEFAULT_LAUNCH_LABEL;
  const plistPath = plistPathForLabel(label);
  const plistExists = await exists(plistPath);

  let bootedOut = false;
  let message = "";
  if (!options.skipBootout && isLaunchctlSupported()) {
    // bootout takes either a service target or a plist path. Use plist path
    // so it works even if the agent is currently disabled.
    const result = await currentRunner(["bootout", userDomain(), plistPath]);
    if (result.ok) {
      bootedOut = true;
      message = `booted out of ${userDomain()}`;
    } else {
      message = `bootout returned ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`;
    }
  }

  let removed = false;
  if (plistExists) {
    await rm(plistPath, { force: true });
    removed = true;
    message = message ? `${message}; removed ${plistPath}` : `removed ${plistPath}`;
  } else if (!message) {
    message = `not installed (no plist at ${plistPath})`;
  }

  return { label, plistPath, removed, bootedOut, message };
}

/**
 * Kickstart the LaunchAgent (start if stopped). Requires it to be installed.
 */
export async function startAgent(label: string = DEFAULT_LAUNCH_LABEL): Promise<LaunchctlResult> {
  return currentRunner(["kickstart", "-k", userServiceTarget(label)]);
}

/**
 * Stop the LaunchAgent via SIGTERM. The daemon handles SIGTERM and exits 0,
 * and KeepAlive.SuccessfulExit=false only relaunches after unsuccessful
 * exits — so this is a real stop until the next start/kickstart or login.
 */
export async function stopAgent(label: string = DEFAULT_LAUNCH_LABEL): Promise<LaunchctlResult> {
  return currentRunner(["kill", "SIGTERM", userServiceTarget(label)]);
}

/**
 * Restart the LaunchAgent. Implemented as kickstart -k, which kills the
 * existing process and relaunches it.
 */
export async function restartAgent(label: string = DEFAULT_LAUNCH_LABEL): Promise<LaunchctlResult> {
  return currentRunner(["kickstart", "-k", userServiceTarget(label)]);
}

/**
 * Best-effort `launchctl print` for the service. Returns null if the
 * service is not loaded (or platform is not darwin).
 */
export async function printAgentStatus(label: string = DEFAULT_LAUNCH_LABEL): Promise<LaunchctlResult | null> {
  if (!isLaunchctlSupported()) return null;
  return currentRunner(["print", userServiceTarget(label)]);
}

/**
 * Convenience: full status report combining the plist file presence and
 * the user-facing label. Used by `hive daemon status` to surface the
 * "installed" flag.
 */
export type AgentInstallStatus = {
  label: string;
  plistPath: string;
  plistExists: boolean;
  plistChecksum?: string;
};

export async function getAgentInstallStatus(label: string = DEFAULT_LAUNCH_LABEL): Promise<AgentInstallStatus> {
  const plistPath = plistPathForLabel(label);
  const raw = await readPlistFile(plistPath);
  if (raw === null) {
    return { label, plistPath, plistExists: false };
  }
  return { label, plistPath, plistExists: true, plistChecksum: shortHash(raw) };
}

function shortHash(input: string): string {
  // Cheap non-crypto hash to give status output something stable to point at.
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  // 32-bit unsigned hex.
  return (hash >>> 0).toString(16).padStart(8, "0");
}
