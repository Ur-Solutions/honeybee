/**
 * Single ssh exec hook shared by the runner-host bootstrap (bootstrap.ts) and
 * the remote transport (remoteTransport.ts). Spawns a child (ssh), collects
 * stdout/stderr, and — by default — bounds wall-clock time so a wedged ssh child
 * can never hang a daemon tick. Two near-identical copies used to live in those
 * two files, one WITH a timeout and one WITHOUT; that divergence is what let the
 * daemon-tick-hang bug in (HIVE-30). Interactive/long-running callers (the bundle
 * deploy) opt out of the bound with `{ timeoutMs: 0 }`. Node builtins only.
 */

import { spawn } from "node:child_process";

/** Default wall-clock bound for a single ssh exec (daemon-tick safety). */
export const DEFAULT_SSH_EXEC_TIMEOUT_MS = 8_000;

export type SshExecHook = (
  argv: string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Default ssh exec hook: spawn ssh and collect stdout/stderr, optionally
 * streaming a payload on stdin (the cat-pipe deploy). Bounds wall-clock time to
 * `opts.timeoutMs` (default `DEFAULT_SSH_EXEC_TIMEOUT_MS`); pass `{ timeoutMs: 0 }`
 * (or a non-finite value) to disable the bound for interactive/long operations.
 */
export function defaultSshExecHook(
  argv: string[],
  input?: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [command, ...args] = argv;
  if (!command) return Promise.reject(new Error("Empty argv"));
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const requested = opts.timeoutMs ?? DEFAULT_SSH_EXEC_TIMEOUT_MS;
    const bounded = Number.isFinite(requested) && requested > 0;
    const timeoutMs = bounded ? Math.max(1, requested) : 0;
    const settle = (result: { stdout: string; stderr: string; exitCode: number }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = bounded
      ? setTimeout(() => {
          child.kill("SIGTERM");
          const timeoutMessage = `timed out after ${timeoutMs}ms`;
          const timeoutStderr = stderr ? `${stderr}${stderr.endsWith("\n") ? "" : "\n"}${timeoutMessage}` : timeoutMessage;
          settle({ stdout, stderr: timeoutStderr, exitCode: 1 });
        }, timeoutMs)
      : undefined;
    timer?.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => settle({ stdout, stderr: stderr || error.message, exitCode: 1 }));
    child.on("close", (code, signal) => settle({ stdout, stderr, exitCode: code ?? (signal ? 130 : 1) }));
    child.stdin.on("error", () => undefined);
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}
