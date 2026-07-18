import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAttachArgv } from "../attach.js";
import { realUserHome } from "../env.js";
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
  return result.ok;
}

// A pane id (e.g. "%7") is globally unique on a tmux server, so "-t %7" is exact
// on its own; the "=name:" form (exact session, active pane) is the fallback for
// unpinned (legacy) bees that have no recorded pane.
export function paneArg(target: string, paneId?: string): string {
  return paneId && paneId.length > 0 ? paneId : `=${target}:`;
}

export async function newSession(name: string, cwd: string, spec: LaunchSpec): Promise<NewSessionResult> {
  const launcher = await createLauncher(spec);
  try {
    // -P -F prints the new pane's id so spawn can pin the bee to it.
    const result = await tmux(["new-session", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-s", name, "-c", cwd, shellCommand([process.execPath, launcher.runnerPath, launcher.payloadPath])]);
    const { paneId, launcherPgid } = parseLaunchResult(result.stdout);
    await applyTmuxWindowOptions(paneId || `=${name}:`, spec.tmuxOptions);
    return { paneId, ...(launcherPgid ? { launcherPgid } : {}) };
  } catch (error) {
    // The runner only deletes the payload tmpdir once it actually starts; if
    // tmux itself refuses the session, clean up here instead of leaking it.
    await rm(launcher.dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

// Low-level tmux pane split. Combs are retired (APIA-85) so this is no longer on
// the Substrate interface, but it stays exported for direct low-level callers.
export async function newPane(target: string, cwd: string, spec: LaunchSpec, opts?: { dir?: "h" | "v" | "window" }): Promise<NewSessionResult> {
  const launcher = await createLauncher(spec);
  const command = shellCommand([process.execPath, launcher.runnerPath, launcher.payloadPath]);
  try {
    if (opts?.dir === "window") {
      // A fresh window in the same session. -P -F prints the new pane id.
      const result = await tmux(["new-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", `=${target}:`, "-c", cwd, command]);
      const { paneId, launcherPgid } = parseLaunchResult(result.stdout);
      await applyTmuxWindowOptions(paneId || `=${target}:`, spec.tmuxOptions);
      return { paneId, ...(launcherPgid ? { launcherPgid } : {}) };
    }
    // Split the comb's active window. -h = horizontal (side-by-side); default
    // (no -h) is vertical (stacked). -P -F prints the new pane's id so the
    // sub-bee can be pinned to it.
    const direction = opts?.dir === "h" ? ["-h"] : [];
    const result = await tmux(["split-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", `=${target}:`, "-c", cwd, ...direction, command]);
    const { paneId, launcherPgid } = parseLaunchResult(result.stdout);
    await applyTmuxWindowOptions(paneId || `=${target}:`, spec.tmuxOptions);
    return { paneId, ...(launcherPgid ? { launcherPgid } : {}) };
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

export async function kill(target: string, options: { launcherPgid?: number } = {}): Promise<KillResult> {
  const result = await tmux(["kill-session", "-t", `=${target}`], { reject: false });
  await terminateProcessGroup(options.launcherPgid);
  return result;
}

// A pane id ("%7") is globally unique on the server, so "-t %7" is exact on its
// own — no "=name:" wrapping needed. Low-level tmux pane kill: combs are retired
// (APIA-85) so this is no longer on the Substrate interface, but it stays
// exported for direct low-level callers (e.g. sidebar-layout teardown).
export async function killPane(paneId: string, options: { launcherPgid?: number } = {}): Promise<KillResult> {
  const result = await tmux(["kill-pane", "-t", paneId], { reject: false });
  await terminateProcessGroup(options.launcherPgid);
  return result;
}

function parseLaunchResult(stdout: string): NewSessionResult {
  const [paneId = "", pidRaw = ""] = stdout.trim().split("\t");
  const launcherPgid = parsePositiveInt(pidRaw);
  return { paneId, ...(launcherPgid ? { launcherPgid } : {}) };
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function terminateProcessGroup(pgid: number | undefined): Promise<void> {
  if (!pgid || process.platform === "win32") return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return;
  }
  await sleep(500);
  try {
    process.kill(-pgid, 0);
  } catch {
    return;
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone or not signalable; tmux teardown result remains authoritative.
  }
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

export async function listPanes(): Promise<Set<string>> {
  const result = await tmux(["list-panes", "-a", "-F", "#{pane_id}"], { reject: false });
  if (!result.ok) return new Set();
  return new Set(result.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
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

export function createLocalTmuxSubstrate(): Substrate {
  return {
    kind: "local-tmux",
    node: LOCAL_NODE,
    probe,
    hasSession,
    newSession,
    kill,
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
