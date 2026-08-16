/**
 * Materialize the build-staged, self-contained remote runner-host artifact.
 *
 * `npm run build` creates and hashes the artifact under `dist/hsr/artifacts`.
 * Installed Honeybee copies those already-certified bytes into its local cache;
 * it never invokes git, a TypeScript loader, or esbuild at runtime.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import {
  readStagedRunnerHostArtifactSync,
  runnerHostArtifactDigest,
  runnerHostArtifactDir,
} from "./runnerHostArtifact.js";

/** Content-derived identity of the exact artifact shipped in this package. */
export function runnerHostVersionCore(options: { artifactDir?: string } = {}): string {
  return readStagedRunnerHostArtifactSync(options.artifactDir ?? runnerHostArtifactDir()).version;
}

/** Local cache dir for immutable runner-host bundles: `~/.hive/runner-host`. */
export function runnerHostCacheDir(): string {
  return join(storeRoot(), "runner-host");
}

/** Cache path for a safe version core. */
export function runnerHostBundlePath(version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`invalid runner-host version for cache path: ${JSON.stringify(version)}`);
  }
  return join(runnerHostCacheDir(), `hive-runner-host-${version}.mjs`);
}

export type RunnerHostBundle = { path: string; version: string };

async function cachedArtifactMatches(path: string, expectedDigest: string): Promise<boolean> {
  try {
    return runnerHostArtifactDigest(await readFile(path)) === expectedDigest;
  } catch {
    return false;
  }
}

/**
 * Copy the verified staged artifact to its content-addressed cache path.
 * A corrupt/stale file at that path is atomically replaced and re-verified.
 */
export async function ensureRunnerHostBundle(
  options: { force?: boolean; artifactDir?: string } = {},
): Promise<RunnerHostBundle> {
  const staged = readStagedRunnerHostArtifactSync(options.artifactDir ?? runnerHostArtifactDir());
  const outPath = runnerHostBundlePath(staged.version);
  if (!options.force && await cachedArtifactMatches(outPath, staged.digest)) {
    return { path: outPath, version: staged.version };
  }

  await atomicWriteFile(outPath, staged.bytes, { mode: 0o600 });
  if (!(await cachedArtifactMatches(outPath, staged.digest))) {
    throw new Error(`runner-host cache write failed integrity verification at ${outPath}`);
  }
  return { path: outPath, version: staged.version };
}
