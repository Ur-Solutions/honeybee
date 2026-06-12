import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAttachArgv } from "../attach.js";
import {
  LOCAL_NODE,
  type KillResult,
  type LaunchSpec,
  type ProbeResult,
  type Substrate,
} from "./types.js";

const execFileAsync = promisify(execFile);

export type TmuxResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function tmux(args: string[], options: { reject?: boolean } = {}): Promise<TmuxResult> {
  const reject = options.reject ?? true;
  try {
    const result = await execFileAsync("tmux", args, { maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: number | string };
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

export async function newSession(name: string, cwd: string, spec: LaunchSpec): Promise<void> {
  const launcher = await createLauncher(spec);
  try {
    await tmux(["new-session", "-d", "-s", name, "-c", cwd, shellCommand([process.execPath, launcher.runnerPath, launcher.payloadPath])]);
  } catch (error) {
    // The runner only deletes the payload tmpdir once it actually starts; if
    // tmux itself refuses the session, clean up here instead of leaking it.
    await rm(launcher.dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function sendText(target: string, text: string): Promise<void> {
  const buffer = `hive-${target.replace(/[^A-Za-z0-9_.:-]/g, "-")}`;
  // Stream the payload via stdin (`load-buffer -`) instead of an argv element:
  // prompts near ARG_MAX (~1MB on macOS) would fail set-buffer with E2BIG.
  await tmuxWithStdin(["load-buffer", "-b", buffer, "-"], text);
  await tmux(["paste-buffer", "-p", "-b", buffer, "-t", `=${target}:`]);
  await sendEnter(target);
}

export async function sendEnter(target: string): Promise<void> {
  await sendKey(target, "Enter");
}

export async function sendKey(target: string, key: string): Promise<void> {
  await tmux(["send-keys", "-t", `=${target}:`, key]);
}

export async function capture(target: string, lines = 80): Promise<string> {
  const start = Math.max(1, Math.floor(lines));
  const result = await tmux(["capture-pane", "-pt", `=${target}:`, "-S", `-${start}`]);
  return result.stdout.trimEnd();
}

export async function kill(target: string): Promise<KillResult> {
  return tmux(["kill-session", "-t", `=${target}`], { reject: false });
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
    const child = spawn("tmux", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
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

export async function listSessionStates(): Promise<Map<string, string>> {
  const states = new Map<string, string>();
  const result = await tmux(["list-sessions", "-F", "#{session_name}\t#{@hive_state}"], { reject: false });
  if (!result.ok) return states;
  for (const line of result.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    states.set(line.slice(0, tab), line.slice(tab + 1).trim());
  }
  return states;
}

export async function setUserOptions(target: string, options: Record<string, string>): Promise<void> {
  const entries = Object.entries(options);
  if (entries.length === 0) return;
  // One invocation: tmux parses a literal ";" argv element as a command
  // separator. Best-effort by contract — reject:false swallows a missing
  // session/server, and the catch guards everything else (e.g. ENOENT).
  // set-option rejects a bare "=name" target (and silently prefix-matches
  // without "="!); only the pane-style "=name:" form is both accepted and
  // exact.
  const args: string[] = [];
  entries.forEach(([key, value], index) => {
    if (index > 0) args.push(";");
    args.push("set-option", "-t", `=${target}:`, key, value);
  });
  try {
    await tmux(args, { reject: false });
  } catch {
    // best-effort
  }
}

export async function probe(): Promise<ProbeResult> {
  try {
    await execFileAsync("tmux", ["-V"], { maxBuffer: 64 * 1024 });
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
  await writeFile(payloadPath, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
  await writeFile(
    runnerPath,
    `import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

const payloadPath = process.argv[2];
const payload = JSON.parse(await readFile(payloadPath, "utf8"));
await rm(dirname(payloadPath), { recursive: true, force: true }).catch(() => undefined);

const child = spawn(payload.command, Array.isArray(payload.args) ? payload.args : [], {
  env: { ...process.env, ...(payload.env && typeof payload.env === "object" ? payload.env : {}) },
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
    listSessionStates,
    setUserOptions,
    attachCommand,
    attachSession,
  };
}
