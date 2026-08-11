import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAttachArgv } from "../attach.js";
import { realUserHome } from "../env.js";
import { isWellFormedPaneId, splitFusedPaneStamp } from "../paneId.js";
import {
  captureProcessBirthFingerprintWithRetry,
  inspectProcessBirth,
  type ProcessBirthCaptureOptions,
  type ProcessBirthFingerprint,
  type ProcessIdentityReader,
} from "../hsr/processIdentity.js";
import {
  LOCAL_NODE,
  type KillResult,
  type LaunchSpec,
  type NewSessionResult,
  type ProbeResult,
  type Substrate,
  type TmuxWindowOptions,
} from "./types.js";

const execFileAsync = promisify(execFile);

export type TmuxResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

// TEST-ONLY isolation + a production safety net. When a throwaway socket is
// pinned — in-process via setTmuxSocket(), or for child processes via
// $HIVE_TMUX_SOCKET — every tmux invocation is scoped to it with `-S`, and that
// is the ONLY context in which hive's own code may run `tmux kill-server`.
// Without a pinned socket the guard in tmux() refuses kill-server outright, so a
// bug, a stray cleanup, or a test run from inside the developer's real tmux
// server can never tear it (and every live bee) down. Production never issues
// kill-server, so this is invisible there. A human typing `tmux kill-server` in
// their own shell bypasses this code path entirely and is unaffected.
let pinnedSocket: string | undefined;

/** TEST-ONLY: pin (or clear with undefined) the throwaway socket every tmux call targets. */
export function setTmuxSocket(socketPath: string | undefined): void {
  pinnedSocket = socketPath;
}

function tmuxSocket(): string | undefined {
  return pinnedSocket ?? (process.env.HIVE_TMUX_SOCKET || undefined);
}

function socketArgs(): string[] {
  const socket = tmuxSocket();
  return socket ? ["-S", socket] : [];
}

// Hard cap on any single tmux client invocation. tmux commands answer in
// milliseconds; a client that sits for longer is talking to a wedged server
// (or one blocked on a stuck client) and would otherwise hang its caller —
// the daemon tick loop above all — forever. Generous enough for a loaded
// machine and large paste-buffer round-trips.
const DEFAULT_TMUX_EXEC_TIMEOUT_MS = 30_000;

function tmuxExecTimeoutMs(): number {
  const raw = Number(process.env.HIVE_TMUX_TIMEOUT_MS ?? DEFAULT_TMUX_EXEC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TMUX_EXEC_TIMEOUT_MS;
}

export async function tmux(args: string[], options: { reject?: boolean } = {}): Promise<TmuxResult> {
  const reject = options.reject ?? true;
  if (args[0] === "kill-server" && !tmuxSocket()) {
    // Hard stop: never let hive's own code kill the ambient tmux server. Tests
    // that legitimately need kill-server must pin a throwaway socket first
    // (setTmuxSocket / $HIVE_TMUX_SOCKET); production never calls this.
    throw new Error(
      "hive: refusing to run `tmux kill-server` without a pinned test socket — " +
        "this guard protects live bees on the ambient tmux server.",
    );
  }
  try {
    const result = await execFileAsync("tmux", [...socketArgs(), ...args], { maxBuffer: 20 * 1024 * 1024, timeout: tmuxExecTimeoutMs() });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: number | string; killed?: boolean };
    // execFile's timeout kill surfaces as killed=true with an empty stderr;
    // name the condition so recentErrors/logs say what actually happened.
    if (err.killed && !err.stderr) err.stderr = `tmux ${args[0]} timed out after ${tmuxExecTimeoutMs()}ms`;
    if (reject) throw new Error(err.stderr || err.message || String(error));
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      // execFile carries the exit code in err.code (err.status is spawnSync);
      // string codes like ENOENT fall back to 1.
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

// "=" pins tmux to an exact session name; without it tmux prefix-matching can
// hit the wrong session (the id allocator naturally produces prefix pairs like
// CL-abc / CL-abcd, and `kill-session -t CL-abc` would kill CL-abcd once
// CL-abc is gone). Pane-target commands (paste-buffer, send-keys,
// capture-pane) only honor "=" in the session part of a "session:" target, so
// those use the `=name:` form (exact session, active pane).
export async function hasSession(target: string): Promise<boolean> {
  const result = await tmux(["has-session", "-t", `=${target}`], { reject: false });
  if (result.ok) return true;
  if (isTmuxServerOrTargetAbsent(result.stderr, "session")) return false;
  throw new Error(result.stderr.trim() || result.stdout.trim() || `tmux has-session exited ${result.exitCode}`);
}

// A pane id (e.g. "%7") is globally unique on a tmux server, so "-t %7" is exact
// on its own; the "=name:" form (exact session, active pane) is the fallback for
// unpinned (legacy) bees that have no recorded pane.
export function paneArg(target: string, paneId?: string): string {
  return paneId && paneId.length > 0 ? paneId : `=${target}:`;
}

export async function newSession(
  name: string,
  cwd: string,
  spec: LaunchSpec,
  birthCapture: ProcessBirthCaptureOptions = {},
): Promise<NewSessionResult> {
  const launcher = await createLauncher(spec);
  try {
    // -P -F prints the new pane's id so spawn can pin the bee to it.
    const result = await tmux(["new-session", "-d", "-P", "-F", "#{pane_id}:#{pane_pid}", "-s", name, "-c", cwd, shellCommand([process.execPath, launcher.runnerPath, launcher.payloadPath])]);
    const { paneId, launcherPgid } = parseLaunchResult(result.stdout);
    await applyTmuxWindowOptions(paneId || `=${name}:`, spec.tmuxOptions);
    const launcherFingerprint = await admitTmuxLauncher(paneId, launcherPgid, birthCapture);
    return { paneId, launcherPgid: launcherPgid!, launcherFingerprint };
  } catch (error) {
    // The runner only deletes the payload tmpdir once it actually starts; if
    // tmux itself refuses the session, clean up here instead of leaking it.
    await rm(launcher.dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

// Low-level tmux pane split. Combs are retired (APIA-85) so this is no longer on
// the Substrate interface, but it stays exported for direct low-level callers.
export async function newPane(
  target: string,
  cwd: string,
  spec: LaunchSpec,
  opts?: { dir?: "h" | "v" | "window" },
  birthCapture: ProcessBirthCaptureOptions = {},
): Promise<NewSessionResult> {
  const launcher = await createLauncher(spec);
  const command = shellCommand([process.execPath, launcher.runnerPath, launcher.payloadPath]);
  try {
    if (opts?.dir === "window") {
      // A fresh window in the same session. -P -F prints the new pane id.
      const result = await tmux(["new-window", "-d", "-P", "-F", "#{pane_id}:#{pane_pid}", "-t", `=${target}:`, "-c", cwd, command]);
      const { paneId, launcherPgid } = parseLaunchResult(result.stdout);
      await applyTmuxWindowOptions(paneId || `=${target}:`, spec.tmuxOptions);
      const launcherFingerprint = await admitTmuxLauncher(paneId, launcherPgid, birthCapture);
      return { paneId, launcherPgid: launcherPgid!, launcherFingerprint };
    }
    // Split the comb's active window. -h = horizontal (side-by-side); default
    // (no -h) is vertical (stacked). -P -F prints the new pane's id so the
    // sub-bee can be pinned to it.
    const direction = opts?.dir === "h" ? ["-h"] : [];
    const result = await tmux(["split-window", "-d", "-P", "-F", "#{pane_id}:#{pane_pid}", "-t", `=${target}:`, "-c", cwd, ...direction, command]);
    const { paneId, launcherPgid } = parseLaunchResult(result.stdout);
    await applyTmuxWindowOptions(paneId || `=${target}:`, spec.tmuxOptions);
    const launcherFingerprint = await admitTmuxLauncher(paneId, launcherPgid, birthCapture);
    return { paneId, launcherPgid: launcherPgid!, launcherFingerprint };
  } catch (error) {
    // The runner only deletes the payload tmpdir once it actually starts; if
    // tmux itself refuses the split, clean up here instead of leaking it.
    await rm(launcher.dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function setWindowOptions(target: string, options: TmuxWindowOptions | undefined, paneId?: string): Promise<void> {
  await applyTmuxWindowOptions(paneArg(target, paneId), options);
}

async function applyTmuxWindowOptions(target: string, options: TmuxWindowOptions | undefined): Promise<void> {
  if (!options) return;
  const entries = Object.entries(options).filter((entry): entry is ["allow-passthrough", "on" | "off" | "all"] => entry[1] !== undefined);
  for (const [key, value] of entries) {
    await tmux(["set-option", "-w", "-t", target, key, tmuxOptionValueArg(value)], { reject: false });
  }
}

function tmuxOptionValueArg(value: string): string {
  // tmux treats a bare ";" argv as a command separator even when there is only
  // one command in the client invocation. Escaping preserves it as data.
  return value === ";" ? "\\;" : value;
}

export async function sendText(target: string, text: string, paneId?: string): Promise<void> {
  const buffer = `hive-${target.replace(/[^A-Za-z0-9_.:-]/g, "-")}`;
  // Stream the payload via stdin (`load-buffer -`) instead of an argv element:
  // prompts near ARG_MAX (~1MB on macOS) would fail set-buffer with E2BIG.
  await tmuxWithStdin(["load-buffer", "-b", buffer, "-"], text);
  await tmux(["paste-buffer", "-p", "-b", buffer, "-t", paneArg(target, paneId)]);
  await sendEnter(target, paneId);
}

export async function sendEnter(target: string, paneId?: string): Promise<void> {
  await sendKey(target, "Enter", paneId);
}

export async function sendKey(target: string, key: string, paneId?: string): Promise<void> {
  await tmux(["send-keys", "-t", paneArg(target, paneId), key]);
}

export async function capture(target: string, lines = 80, paneId?: string): Promise<string> {
  const start = Math.max(1, Math.floor(lines));
  const result = await tmux(["capture-pane", "-pt", paneArg(target, paneId), "-S", `-${start}`]);
  return result.stdout.trimEnd();
}

export async function kill(
  target: string,
  options: { launcherPgid?: number; launcherFingerprint?: ProcessBirthFingerprint } = {},
  deps: TmuxProcessSignalDependencies = {},
): Promise<KillResult> {
  const group = await terminateProcessGroup(options.launcherPgid, options.launcherFingerprint, deps);
  const result = await tmux(["kill-session", "-t", `=${target}`], { reject: false });
  const targetAbsence = await inspectSessionAbsence(target);
  return exactStopResult(result, group, targetAbsence, `tmux session ${target}`);
}

// A pane id ("%7") is globally unique on the server, so "-t %7" is exact on its
// own — no "=name:" wrapping needed. Low-level tmux pane kill: combs are retired
// (APIA-85) so this is no longer on the Substrate interface, but it stays
// exported for direct low-level callers (e.g. sidebar-layout teardown).
export async function killPane(
  paneId: string,
  options: { launcherPgid?: number; launcherFingerprint?: ProcessBirthFingerprint } = {},
  deps: TmuxProcessSignalDependencies = {},
): Promise<KillResult> {
  const group = await terminateProcessGroup(options.launcherPgid, options.launcherFingerprint, deps);
  const result = await tmux(["kill-pane", "-t", paneId], { reject: false });
  const targetAbsence = await inspectPaneAbsence(paneId);
  return exactStopResult(result, group, targetAbsence, `tmux pane ${paneId}`);
}

function parseLaunchResult(stdout: string): NewSessionResult {
  // Separator is ":" for the same reason as listSessionStates: tmux sanitizes
  // control characters (including \t) to "_" when the server has no UTF-8
  // locale (launchd-started servers), which used to fuse "%7\t5908" into a
  // single "%7_5908" token that could never match a live pane id. Also accept
  // the legacy "\t" and sanitized "_" joins so old output still parses.
  const raw = stdout.trim();
  const legacy = splitFusedPaneStamp(raw);
  const [paneId = "", pidRaw = ""] = legacy ? [legacy.paneId, String(legacy.pid)] : raw.split(":");
  const launcherPgid = parsePositiveInt(pidRaw);
  // Never publish a token that is not an exact #{pane_id}: a mis-shaped stamp
  // would be pinned onto the SessionRecord and permanently fail the
  // pane-liveness probe. An empty paneId makes admitTmuxLauncher fail the
  // spawn loudly instead.
  if (!isWellFormedPaneId(paneId)) return { paneId: "", ...(launcherPgid ? { launcherPgid } : {}) };
  return { paneId, ...(launcherPgid ? { launcherPgid } : {}) };
}

async function admitTmuxLauncher(
  paneId: string,
  launcherPgid: number | undefined,
  birthCapture: ProcessBirthCaptureOptions,
): Promise<ProcessBirthFingerprint> {
  const fingerprint = launcherPgid
    ? await captureProcessBirthFingerprintWithRetry(launcherPgid, birthCapture)
    : undefined;
  if (paneId && launcherPgid && fingerprint?.pgid === launcherPgid) return fingerprint;

  // The pane id is the unrecycled live handle returned by this exact tmux
  // create call. Roll it back before returning an error; no SessionRecord is
  // allowed to publish a runtime whose future group teardown is unprovable.
  const command = paneId
    ? await tmux(["kill-pane", "-t", paneId], { reject: false })
    : { ok: false, stdout: "", stderr: "tmux did not return an exact pane id", exitCode: 1 };
  const absence = paneId ? await inspectPaneAbsence(paneId) : { status: "indeterminate" as const, reason: "missing exact pane id" };
  const reason = !launcherPgid
    ? "tmux did not return a launcher process-group id"
    : fingerprint
      ? `launcher birth fingerprint pgid ${fingerprint.pgid} does not match ${launcherPgid}`
      : `launcher ${launcherPgid} has no verifiable birth fingerprint`;
  if (absence.status !== "absent") {
    const cleanup = absence.status === "indeterminate" ? absence.reason : `tmux pane ${paneId} is still present`;
    throw new Error(`Local tmux birth admission failed: ${reason}; exact pane rollback unconfirmed: ${cleanup || command.stderr}`);
  }
  throw new Error(`Local tmux birth admission failed: ${reason}; exact pane ${paneId} rolled back`);
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export type TmuxProcessSignalDependencies = {
  readProcessIdentity?: ProcessIdentityReader;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
};

export type ExactProcessGroupStopResult =
  | { status: "confirmed"; reason: "not-recorded" | "absent" }
  | { status: "indeterminate"; reason: string };

type ExactTargetAbsence =
  | { status: "absent" }
  | { status: "present" }
  | { status: "indeterminate"; reason: string };

export async function terminateProcessGroup(
  pgid: number | undefined,
  fingerprint: ProcessBirthFingerprint | undefined,
  deps: TmuxProcessSignalDependencies = {},
): Promise<ExactProcessGroupStopResult> {
  if (pgid === undefined) return { status: "confirmed", reason: "not-recorded" };
  if (!Number.isSafeInteger(pgid) || pgid <= 1) {
    return { status: "indeterminate", reason: `invalid process-group id ${pgid}` };
  }
  if ((deps.platform ?? process.platform) === "win32") {
    return { status: "indeterminate", reason: `process-group verification is unavailable for ${pgid} on win32` };
  }
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => { process.kill(pid, signal); });
  if (!fingerprint) {
    // Legacy records cannot authorize a terminating signal, but
    // ESRCH from a signal-0 group probe is still exact absence proof.
    const presence = await inspectProcessGroupPresence(pgid, kill);
    if (presence.status === "absent") return { status: "confirmed", reason: "absent" };
    if (presence.status === "indeterminate") return presence;
    return { status: "indeterminate", reason: `missing birth fingerprint for live process group ${pgid}` };
  }
  if (fingerprint.pgid !== pgid) {
    return { status: "indeterminate", reason: `mismatched birth fingerprint for process group ${pgid}` };
  }
  const initialBirth = await inspectProcessBirth(pgid, fingerprint, deps.readProcessIdentity);
  if (initialBirth === "gone") return confirmProcessGroupAbsent(pgid, fingerprint, kill, deps.readProcessIdentity);
  if (initialBirth !== "match") {
    return { status: "indeterminate", reason: `process-group ${pgid} birth identity is ${initialBirth}` };
  }

  try {
    await kill(-pgid, "SIGTERM");
  } catch (error) {
    const absent = await confirmProcessGroupAbsent(pgid, fingerprint, kill, deps.readProcessIdentity);
    if (absent.status === "confirmed") return absent;
    return { status: "indeterminate", reason: `SIGTERM for process group ${pgid} failed: ${errorMessage(error)}; ${absent.reason}` };
  }
  await (deps.sleep ?? sleep)(500);

  const afterTermPresence = await inspectProcessGroupPresence(pgid, kill);
  if (afterTermPresence.status === "indeterminate") {
    return { status: "indeterminate", reason: afterTermPresence.reason };
  }
  if (afterTermPresence.status === "absent") {
    const afterTermBirth = await inspectProcessBirth(pgid, fingerprint, deps.readProcessIdentity);
    if (afterTermBirth === "gone") return { status: "confirmed", reason: "absent" };
    return {
      status: "indeterminate",
      reason: `process-group ${pgid} absence conflicted with leader birth identity ${afterTermBirth}`,
    };
  }

  // The presence probe above is only a numeric-PGID observation. The group can
  // be recycled between it and escalation, so re-read the immutable leader
  // birth immediately before SIGKILL. A missing leader plus a present group is
  // not continuity proof: without a persisted member identity it could be a
  // replacement group and must fail closed.
  const beforeKillBirth = await inspectProcessBirth(pgid, fingerprint, deps.readProcessIdentity);
  if (beforeKillBirth !== "match") {
    return {
      status: "indeterminate",
      reason: `process-group ${pgid} leader birth identity is ${beforeKillBirth} immediately before SIGKILL`,
    };
  }
  try {
    await kill(-pgid, "SIGKILL");
  } catch (error) {
    const absent = await confirmProcessGroupAbsent(pgid, fingerprint, kill, deps.readProcessIdentity);
    if (absent.status === "confirmed") return absent;
    return { status: "indeterminate", reason: `SIGKILL for process group ${pgid} failed: ${errorMessage(error)}; ${absent.reason}` };
  }
  await (deps.sleep ?? sleep)(50);
  return confirmProcessGroupAbsent(pgid, fingerprint, kill, deps.readProcessIdentity);
}

async function confirmProcessGroupAbsent(
  pgid: number,
  fingerprint: ProcessBirthFingerprint,
  kill: NonNullable<TmuxProcessSignalDependencies["kill"]>,
  reader?: ProcessIdentityReader,
): Promise<ExactProcessGroupStopResult> {
  const birth = await inspectProcessBirth(pgid, fingerprint, reader);
  const presence = await inspectProcessGroupPresence(pgid, kill);
  if (birth === "gone" && presence.status === "absent") return { status: "confirmed", reason: "absent" };
  if (presence.status === "indeterminate") return { status: "indeterminate", reason: presence.reason };
  return {
    status: "indeterminate",
    reason: `process-group ${pgid} absence unconfirmed (birth=${birth}, group=${presence.status})`,
  };
}

async function inspectProcessGroupPresence(
  pgid: number,
  kill: NonNullable<TmuxProcessSignalDependencies["kill"]>,
): Promise<{ status: "present" } | { status: "absent" } | { status: "indeterminate"; reason: string }> {
  try {
    await kill(-pgid, 0);
    return { status: "present" };
  } catch (error) {
    if (isNoSuchProcessError(error)) return { status: "absent" };
    // POSIX kill(2) reports EPERM when the target exists but the caller lacks
    // permission to signal it. That proves presence even though ownership and
    // teardown remain unconfirmed.
    if ((error as { code?: unknown } | null)?.code === "EPERM") return { status: "present" };
    return { status: "indeterminate", reason: `could not verify process-group ${pgid} absence: ${errorMessage(error)}` };
  }
}

async function inspectSessionAbsence(target: string): Promise<ExactTargetAbsence> {
  try {
    return (await hasSession(target)) ? { status: "present" } : { status: "absent" };
  } catch (error) {
    return { status: "indeterminate", reason: errorMessage(error) };
  }
}

async function inspectPaneAbsence(paneId: string): Promise<ExactTargetAbsence> {
  const result = await tmux(["list-panes", "-a", "-F", "#{pane_id}"], { reject: false });
  if (result.ok) {
    const panes = new Set(result.stdout.split("\n").map((value) => value.trim()).filter(Boolean));
    return panes.has(paneId) ? { status: "present" } : { status: "absent" };
  }
  if (isTmuxServerOrTargetAbsent(result.stderr, "pane")) return { status: "absent" };
  return { status: "indeterminate", reason: result.stderr.trim() || result.stdout.trim() || `tmux pane probe exited ${result.exitCode}` };
}

function exactStopResult(
  command: TmuxResult,
  group: ExactProcessGroupStopResult,
  target: ExactTargetAbsence,
  label: string,
): KillResult {
  if (group.status === "confirmed" && target.status === "absent") {
    return { ok: true, stdout: command.stdout, stderr: command.stderr, exitCode: 0 };
  }
  const reasons = [
    ...(group.status === "indeterminate" ? [group.reason] : []),
    ...(target.status === "present" ? [`${label} remains live`] : []),
    ...(target.status === "indeterminate" ? [`${label} absence unconfirmed: ${target.reason}`] : []),
  ];
  return {
    ok: false,
    stdout: command.stdout,
    stderr: [command.stderr.trim(), ...reasons].filter(Boolean).join("; "),
    exitCode: command.exitCode === 0 ? 1 : command.exitCode,
  };
}

function isNoSuchProcessError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ESRCH" || /no such process/i.test(errorMessage(error));
}

function isTmuxServerOrTargetAbsent(stderr: string, target: "session" | "pane"): boolean {
  return new RegExp(`can't find ${target}|no server running`, "i").test(stderr)
    || /error connecting to .*\(No such file or directory\)/i.test(stderr);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function attachCommand(target: string): string[] {
  return buildAttachArgv({ sessionName: target, insideTmux: Boolean(process.env.TMUX) });
}

export async function attachSession(target: string): Promise<void> {
  const [command, ...args] = attachCommand(target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command!, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`${formatShellCommand([command!, ...args])} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function tmuxWithStdin(args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tmux", [...socketArgs(), ...args], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    // Same hard cap as tmux(): a client stuck on a wedged server must not
    // hang the caller. Settling on 'exit' (not 'close') already guards
    // against inherited-fd stragglers; this guards against the client itself.
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      settle(new Error(`tmux ${args[0]} timed out after ${tmuxExecTimeoutMs()}ms`));
    }, tmuxExecTimeoutMs());
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => settle(error));
    child.on("exit", (code, signal) => {
      if (code === 0) settle();
      else settle(new Error(stderr.trim() || `tmux ${args[0]} exited with ${signal ?? code}`));
    });
    // If tmux exits before consuming stdin the pending write surfaces as
    // EPIPE; swallow it — the exit handler reports the real failure.
    child.stdin.on("error", () => undefined);
    child.stdin.write(input);
    child.stdin.end();
  });
}

export async function listSessions(): Promise<string[]> {
  const result = await tmux(["list-sessions", "-F", "#{session_name}"], { reject: false });
  if (!result.ok) return [];
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export const listTmuxSessions = listSessions;

export type LocalRuntimeSnapshot = {
  sessions: Set<string>;
  panes: Set<string>;
};

/**
 * One strict, internally consistent tmux liveness snapshot for pool safety.
 * The ordinary substrate list methods are display-oriented and deliberately
 * collapse tmux failures to empty collections. Allocation cannot use that
 * contract: an empty result after an observation error could over-subscribe a
 * checkout. One list-panes command is also the ordering barrier between the
 * session and pane sets, so a concurrent tmux change cannot split them across
 * two independently timed observations.
 */
export async function observeLocalRuntimeSnapshot(): Promise<LocalRuntimeSnapshot> {
  const result = await tmux(["list-panes", "-a", "-F", "#{session_name}:#{pane_id}"], { reject: false });
  if (!result.ok) {
    // With no tmux server there are authoritatively no local runtimes. Other
    // failures (timeout, permissions, a wedged socket) are uncertainty and
    // must propagate to the allocator.
    if (/no server running/i.test(result.stderr)) return { sessions: new Set(), panes: new Set() };
    throw new Error(`tmux runtime observation failed: ${result.stderr || `exit ${result.exitCode}`}`);
  }

  const sessions = new Set<string>();
  const panes = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(":");
    const session = separator > 0 ? line.slice(0, separator) : "";
    const pane = separator > 0 ? line.slice(separator + 1) : "";
    if (!session || !/^%\d+$/.test(pane)) {
      throw new Error(`tmux runtime observation returned a malformed row: ${JSON.stringify(line)}`);
    }
    sessions.add(session);
    panes.add(pane);
  }
  return { sessions, panes };
}

export async function listPanes(): Promise<Set<string>> {
  const result = await tmux(["list-panes", "-a", "-F", "#{pane_id}"], { reject: false });
  if (!result.ok) return new Set();
  return new Set(result.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
}

/**
 * Live panes grouped by their owning session. Used by the pane-stamp repair
 * sweep to re-pin a fused "%id_pid" stamp ONLY to a pane that provably belongs
 * to the record's own session — a bare pane-id match could re-pin to a foreign
 * pane after a server restart recycled the id. The ":" separator is
 * locale-independent ASCII and cannot occur in a session name or pane id.
 */
export async function listPanesBySession(): Promise<Map<string, Set<string>>> {
  const panes = new Map<string, Set<string>>();
  const result = await tmux(["list-panes", "-a", "-F", "#{session_name}:#{pane_id}"], { reject: false });
  if (!result.ok) return panes;
  for (const line of result.stdout.split("\n")) {
    const separator = line.lastIndexOf(":");
    if (separator <= 0) continue;
    const session = line.slice(0, separator);
    const paneId = line.slice(separator + 1).trim();
    if (!isWellFormedPaneId(paneId)) continue;
    const existing = panes.get(session);
    if (existing) existing.add(paneId);
    else panes.set(session, new Set([paneId]));
  }
  return panes;
}

export async function listSessionStates(): Promise<Map<string, string>> {
  const states = new Map<string, string>();
  // Do not use a literal control character as the field separator. tmux 3.6a
  // sanitizes it to "_" when the server has no UTF-8 locale (as with launchd),
  // which makes every row unparsable. A colon is locale-independent ASCII and
  // cannot occur in a tmux session name (tmux replaces it with "_"), because it
  // is the session/window target separator.
  const result = await tmux(["list-sessions", "-F", "#{session_name}:#{@hive_state}"], { reject: false });
  if (!result.ok) return states;
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    states.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return states;
}

export async function setUserOptions(target: string, options: Record<string, string>): Promise<void> {
  const entries = Object.entries(options);
  if (entries.length === 0) return;
  // One invocation per option: tmux parses a literal ";" argv element as a
  // command separator, so batching would corrupt an option whose value is ";".
  // Best-effort by contract — reject:false swallows a missing session/server,
  // and the catch guards everything else (e.g. ENOENT).
  // set-option rejects a bare "=name" target (and silently prefix-matches
  // without "="!); only the pane-style "=name:" form is both accepted and
  // exact.
  try {
    for (const [key, value] of entries) {
      await tmux(["set-option", "-t", `=${target}:`, key, tmuxOptionValueArg(value)], { reject: false });
    }
  } catch {
    // best-effort
  }
}

export async function renameWindow(target: string, name: string): Promise<void> {
  try {
    await tmux(["rename-window", "-t", `=${target}:`, name], { reject: false });
  } catch {
    // best-effort
  }
}

export async function probe(): Promise<ProbeResult> {
  try {
    await execFileAsync("tmux", ["-V"], { maxBuffer: 64 * 1024, timeout: tmuxExecTimeoutMs() });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
}

async function createLauncher(spec: LaunchSpec): Promise<{ dir: string; runnerPath: string; payloadPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hive-launch-"));
  const runnerPath = join(dir, "launch.mjs");
  const payloadPath = join(dir, "payload.json");
  await writeFile(payloadPath, `${JSON.stringify({ ...spec, realHome: realUserHome() })}\n`, { mode: 0o600 });
  await writeFile(
    runnerPath,
    `import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

const payloadPath = process.argv[2];
const payload = JSON.parse(await readFile(payloadPath, "utf8"));
await rm(dirname(payloadPath), { recursive: true, force: true }).catch(() => undefined);

const baseEnv = { ...process.env };
if (typeof payload.realHome === "string" && payload.realHome.length > 0) {
  baseEnv.HOME = payload.realHome;
}
repairInteractiveColorEnv(baseEnv);

const child = spawn(payload.command, Array.isArray(payload.args) ? payload.args : [], {
  env: { ...baseEnv, ...(payload.env && typeof payload.env === "object" ? payload.env : {}) },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(\`hive: failed to launch \${payload.command}: \${error.message}\`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

function repairInteractiveColorEnv(env) {
  if (env.HIVE_PRESERVE_NO_COLOR === "1") return;
  delete env.NO_COLOR;
  if (env.FORCE_COLOR === "" || env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false") {
    delete env.FORCE_COLOR;
  }
  if (!env.CLICOLOR) env.CLICOLOR = "1";
  if (!env.COLORTERM || env.COLORTERM === "0" || env.COLORTERM === "false") {
    env.COLORTERM = "truecolor";
  }
  if (!env.TERM || env.TERM === "dumb") {
    env.TERM = env.TMUX ? "tmux-256color" : "xterm-256color";
  }
}
`,
    { mode: 0o700 },
  );
  return { dir, runnerPath, payloadPath };
}

function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

export function formatShellCommand(parts: string[]): string {
  return shellCommand(parts);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type { LaunchSpec };

export function createLocalTmuxSubstrate(
  options: {
    processSignalDependencies?: TmuxProcessSignalDependencies;
    processBirthCapture?: ProcessBirthCaptureOptions;
  } = {},
): Substrate {
  const processSignalDependencies = options.processSignalDependencies;
  return {
    kind: "local-tmux",
    node: LOCAL_NODE,
    probe,
    hasSession,
    newSession: (name, cwd, spec) => newSession(name, cwd, spec, options.processBirthCapture),
    kill: (target, killOptions) => kill(target, killOptions, processSignalDependencies),
    killIncarnation: async (_target, launch) => {
      return killPane(launch.paneId, {
        launcherPgid: launch.launcherPgid,
        launcherFingerprint: launch.launcherFingerprint,
      }, processSignalDependencies);
    },
    capture,
    sendText,
    sendEnter,
    sendKey,
    listSessions,
    listPanes,
    listSessionStates,
    setUserOptions,
    setWindowOptions,
    renameWindow,
    attachCommand,
    attachSession,
  };
}
