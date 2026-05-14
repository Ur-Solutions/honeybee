import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function tmux(args: string[], options: { reject?: boolean } = {}) {
  const reject = options.reject ?? true;
  try {
    const result = await execFileAsync("tmux", args, { maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    if (reject) throw new Error(err.stderr || err.message);
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, exitCode: typeof err.code === "number" ? err.code : 1 };
  }
}

export async function hasSession(target: string): Promise<boolean> {
  const result = await tmux(["has-session", "-t", target], { reject: false });
  return result.ok;
}

export async function newSession(name: string, cwd: string, command: string) {
  await tmux(["new-session", "-d", "-s", name, "-c", cwd, command]);
}

export async function sendText(target: string, text: string) {
  const buffer = `agentpit-${target.replace(/[^A-Za-z0-9_.:-]/g, "-")}`;
  await tmux(["set-buffer", "-b", buffer, text]);
  await tmux(["paste-buffer", "-b", buffer, "-t", target]);
  await tmux(["send-keys", "-t", target, "Enter"]);
}

export async function capture(target: string, lines = 80): Promise<string> {
  const start = Math.max(0, lines);
  const result = await tmux(["capture-pane", "-pt", target, "-S", `-${start}`]);
  return result.stdout.trimEnd();
}

export async function kill(target: string) {
  return tmux(["kill-session", "-t", target], { reject: false });
}

export async function listTmuxSessions(): Promise<string[]> {
  const result = await tmux(["list-sessions", "-F", "#{session_name}"], { reject: false });
  if (!result.ok) return [];
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}
