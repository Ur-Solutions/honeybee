import type { ProcessBirthFingerprint } from "./hsr/processIdentity.js";

/** Exact detached runtime incarnation returned at the HSR fork boundary. */
export type HsrSpawnRuntimeIdentity = {
  kind: "hsr";
  beeName: string;
  hostPid: number;
  hostFingerprint?: ProcessBirthFingerprint;
};

export type SpawnRuntimeCleanup = {
  stopped: boolean;
  detail: string;
};

/** In-memory authority to tear down only the concrete runtime just launched. */
export type SpawnedRuntimeHandle = {
  identity: HsrSpawnRuntimeIdentity;
  stop(): Promise<SpawnRuntimeCleanup>;
};

/**
 * A spawn crossed the irreversible host-fork boundary and then failed. The
 * exact incarnation cleanup verdict is retained so protocol launchers cannot
 * flatten an unconfirmed cleanup into an ordinary terminal failure.
 */
export class SpawnAfterForkError extends Error {
  readonly code = "HIVE_SPAWN_AFTER_FORK";

  constructor(
    readonly phase: "runtime-admission" | "runtime-publish" | "session-save" | "spawn-options",
    readonly runtime: SpawnedRuntimeHandle,
    readonly cleanup: SpawnRuntimeCleanup,
    readonly original: unknown,
  ) {
    const cause = original instanceof Error ? original.message : String(original);
    super(
      `${cause}; exact launched ${runtime.identity.kind} incarnation cleanup `
      + `${cleanup.stopped ? "confirmed" : `unconfirmed: ${cleanup.detail}`}`,
      { cause: original },
    );
    this.name = "SpawnAfterForkError";
  }
}
