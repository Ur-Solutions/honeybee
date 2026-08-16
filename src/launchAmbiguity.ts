import { SpawnAfterForkError } from "./spawnRuntime.js";
import { RemoteSpawnIndeterminateError } from "./substrates/remote-hsr.js";

/**
 * True when a launch crossed (or may have crossed) its irreversible boundary
 * and exact cleanup was not proved. Callers must retain ownership and must not
 * turn this into an ordinary retry on a new name/attempt.
 */
export function isLaunchOwnershipIndeterminate(error: unknown): boolean {
  if (error instanceof SpawnAfterForkError) return !error.cleanup.stopped;
  if (error instanceof RemoteSpawnIndeterminateError) return true;

  let cursor: unknown = error;
  const seen = new Set<unknown>();
  while (cursor instanceof Error && !seen.has(cursor)) {
    seen.add(cursor);
    const message = cursor.message.toLowerCase();
    if (
      message.includes("cleanup unconfirmed") ||
      message.includes("cleanup was unconfirmed") ||
      message.includes("stop-doubt ownership")
    ) return true;
    cursor = cursor.cause;
  }
  return false;
}
