import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    if (reject) throw new Error(err.stderr || err.message);
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      exitCode: typeof err.status === "number" ? err.status : 1,
    };
  }
}

export async function hasSession(target: string): Promise<boolean> {
  const result = await tmux(["has-session", "-t", target], { reject: false });
  return result.ok;
}

export async function newSession(name: string, cwd: string, spec: LaunchSpec): Promise<void> {
  const launcher = await createLauncher(spec);
  await tmux(["new-session", "-d", "-s", name, "-c", cwd, shellCommand([process.execPath, launcher.runnerPath, launcher.payloadPath])]);
}

export async function sendText(target: string, text: string): Promise<void> {
  const buffer = `hive-${target.replace(/[^A-Za-z0-9_.:-]/g, "-")}`;
  await tmux(["set-buffer", "-b", buffer, text]);
  await tmux(["paste-buffer", "-p", "-b", buffer, "-t", target]);
  await sendEnter(target);
}

export async function sendEnter(target: string): Promise<void> {
  await sendKey(target, "Enter");
}

export async function sendKey(target: string, key: string): Promise<void> {
  await tmux(["send-keys", "-t", target, key]);
}

export async function capture(target: string, lines = 80): Promise<string> {
  const start = Math.max(1, Math.floor(lines));
  const result = await tmux(["capture-pane", "-pt", target, "-S", `-${start}`]);
  return result.stdout.trimEnd();
}

export async function kill(target: string): Promise<KillResult> {
  return tmux(["kill-session", "-t", target], { reject: false });
}

export function attachCommand(target: string): string[] {
  return process.env.TMUX ? ["tmux", "switch-client", "-t", target] : ["tmux", "attach-session", "-t", target];
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

export async function listSessions(): Promise<string[]> {
  const result = await tmux(["list-sessions", "-F", "#{session_name}"], { reject: false });
  if (!result.ok) return [];
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export const listTmuxSessions = listSessions;

export async function probe(): Promise<ProbeResult> {
  try {
    await execFileAsync("tmux", ["-V"], { maxBuffer: 64 * 1024 });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
}

async function createLauncher(spec: LaunchSpec): Promise<{ runnerPath: string; payloadPath: string }> {
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
  return { runnerPath, payloadPath };
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
    attachCommand,
    attachSession,
  };
}
