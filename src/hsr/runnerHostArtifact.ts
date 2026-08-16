/** Integrity and identity contract for the build-staged remote runner host. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const RUNNER_HOST_ARTIFACT_SCHEMA_VERSION = 1;
export const RUNNER_HOST_ARTIFACT_FILENAME = "runner-host.mjs";
export const RUNNER_HOST_ARTIFACT_MANIFEST_FILENAME = "runner-host.manifest.json";

export type RunnerHostArtifactManifest = {
  schemaVersion: 1;
  artifact: typeof RUNNER_HOST_ARTIFACT_FILENAME;
  packageVersion: string;
  sha256: string;
  bytes: number;
};

export type StagedRunnerHostArtifact = {
  artifactPath: string;
  manifestPath: string;
  bytes: Buffer;
  digest: string;
  version: string;
  manifest: RunnerHostArtifactManifest;
};

export function runnerHostArtifactDir(): string {
  const adjacent = fileURLToPath(new URL("./artifacts/", import.meta.url));
  if (existsSync(join(adjacent, RUNNER_HOST_ARTIFACT_MANIFEST_FILENAME))) return adjacent;
  // Source-mode development runs from src/hsr while `npm run build` stages the
  // certified artifact under dist/hsr. Installed and compiled-test modules find
  // their adjacent copy first, so this fallback never reaches outside a package.
  const built = fileURLToPath(new URL("../../dist/hsr/artifacts/", import.meta.url));
  if (existsSync(join(built, RUNNER_HOST_ARTIFACT_MANIFEST_FILENAME))) return built;
  return adjacent;
}

export function runnerHostArtifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function runnerHostVersionForDigest(packageVersion: string, digest: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(packageVersion)) {
    throw new Error(`runner-host artifact has invalid packageVersion ${JSON.stringify(packageVersion)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`runner-host artifact has invalid sha256 ${JSON.stringify(digest)}`);
  }
  return `${packageVersion}+sha256.${digest}`;
}

/** Exact wire value returned by runner-host `--version` and `ping`. */
export function runnerHostHandshakeVersion(version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`invalid runner-host version ${JSON.stringify(version)}`);
  }
  return `runner-host ${version}`;
}

export function parseRunnerHostArtifactManifest(value: unknown): RunnerHostArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runner-host artifact manifest must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = ["artifact", "bytes", "packageVersion", "schemaVersion", "sha256"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("runner-host artifact manifest has unsupported fields");
  }
  if (
    candidate.schemaVersion !== RUNNER_HOST_ARTIFACT_SCHEMA_VERSION
    || candidate.artifact !== RUNNER_HOST_ARTIFACT_FILENAME
    || typeof candidate.packageVersion !== "string"
    || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(candidate.packageVersion)
    || typeof candidate.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.sha256)
    || !Number.isSafeInteger(candidate.bytes)
    || Number(candidate.bytes) <= 0
  ) {
    throw new Error("runner-host artifact manifest is malformed");
  }
  return {
    schemaVersion: 1,
    artifact: RUNNER_HOST_ARTIFACT_FILENAME,
    packageVersion: candidate.packageVersion,
    sha256: candidate.sha256,
    bytes: Number(candidate.bytes),
  };
}

/** Read and byte-verify the exact artifact that the package build staged. */
export function readStagedRunnerHostArtifactSync(
  artifactDir = runnerHostArtifactDir(),
): StagedRunnerHostArtifact {
  const manifestPath = join(artifactDir, RUNNER_HOST_ARTIFACT_MANIFEST_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `runner-host staged artifact manifest is unavailable at ${manifestPath}; run \`npm run build\` before bootstrap`,
      { cause: error },
    );
  }
  const manifest = parseRunnerHostArtifactManifest(parsed);
  const artifactPath = join(artifactDir, manifest.artifact);
  let bytes: Buffer;
  try {
    bytes = readFileSync(artifactPath);
  } catch (error) {
    throw new Error(`runner-host staged artifact is unavailable at ${artifactPath}`, { cause: error });
  }
  const digest = runnerHostArtifactDigest(bytes);
  if (bytes.byteLength !== manifest.bytes || digest !== manifest.sha256) {
    throw new Error(
      `runner-host staged artifact integrity mismatch at ${artifactPath} `
      + `(manifest bytes=${manifest.bytes} sha256=${manifest.sha256}, actual bytes=${bytes.byteLength} sha256=${digest})`,
    );
  }
  return {
    artifactPath,
    manifestPath,
    bytes,
    digest,
    version: runnerHostVersionForDigest(manifest.packageVersion, digest),
    manifest,
  };
}
