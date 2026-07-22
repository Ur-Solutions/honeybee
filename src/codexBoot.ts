import { homedir } from "node:os";
import { join } from "node:path";
import { type LockOptions, withFileLock } from "./lock.js";
import { spawnTimingEnabled } from "./spawnTiming.js";

const CODEX_BOOT_LOCK_FILENAME = ".hive-app-server-boot.lock";
const CODEX_BOOT_LOCK_TIMEOUT_MS = 10 * 60_000;
const CODEX_BOOT_LOCK_STALE_MS = 2 * 60_000;

export type CodexBootLockState = {
  /** True when another boot held this home's lock before this caller acquired it. */
  waited: boolean;
};

/** Resolve the credential home used by `codex app-server`. */
export function codexHomeFromEnv(env: Record<string, string | undefined>): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

/**
 * Serialize only the app-server boot window for one CODEX_HOME.
 *
 * The lock lives inside the home, so independent homes never share a lock. The
 * caller releases it as soon as the startup RPC succeeds or fails; the running
 * app-server remains outside the critical section.
 */
export async function withCodexHomeBootLock<T>(
  home: string,
  fn: (state: CodexBootLockState) => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  let waited = false;
  const callerOnWait = options.onWait;
  return withFileLock(join(home, CODEX_BOOT_LOCK_FILENAME), () => fn({ waited }), {
    ...options,
    timeoutMs: options.timeoutMs ?? CODEX_BOOT_LOCK_TIMEOUT_MS,
    // Heartbeats keep a legitimately slow boot fresh; a hard-crashed holder is
    // reclaimable well before the waiter's overall patience expires.
    staleMs: options.staleMs ?? CODEX_BOOT_LOCK_STALE_MS,
    onWait: () => {
      waited = true;
      if (spawnTimingEnabled()) {
        process.stderr.write(`hive: debug: waiting for codex boot lock (${home})\n`);
      }
      callerOnWait?.();
    },
  });
}
