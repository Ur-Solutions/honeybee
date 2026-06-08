// Stop-predicate evaluator — runs the `--until` shell command as a child
// process in the loop cwd between iterations. The loop stops when the command
// exits 0. A predicate error (spawn failure, timeout, non-zero exit) means
// "not satisfied" → keep looping; this function NEVER throws to the caller.

import { spawn } from "node:child_process";

export type RunStopPredicateOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export async function runStopPredicate(
  cmd: string,
  cwd: string,
  opts: RunStopPredicateOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, { cwd, shell: true, stdio: "ignore" });
    } catch {
      // Spawn itself failed (e.g. invalid cwd) — treat as not satisfied.
      resolve(false);
      return;
    }

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(false);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(false);
    }, timeoutMs);

    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}
