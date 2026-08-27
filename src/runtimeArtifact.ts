/**
 * Redistributable runtime artifact (distribution plan H1 / rollout F2).
 *
 * `hive deploy <sha>` builds a self-sufficient stage directory (dist/,
 * contracts/, package.json, production node_modules/) and installs it under
 * `~/.hive/runtime/<sha>/`. This module turns that SAME stage directory into
 * something a machine with no git, npm, or checkout can install later:
 *
 *   honeybee-runtime-<sha>.tar.gz   the stage dir, byte for byte, plus manifest.json
 *   manifest.json                   sha, artifactHash, protocol, corpus digest, engines
 *   SHA256SUMS                      digests of the tarball and the manifest
 *
 * `artifactHash` is exactly the digest `hive deploy` records in deploys.json:
 * deploySettle's tree digest of dist/ (stamp excluded), written into
 * dist/.build-stamp.json BEFORE the tarball is cut, so the stamp travels with
 * the bytes it describes and a later `hive deploy --artifact` can re-verify.
 *
 * Pure orchestration over an already-built artifact directory: nothing here
 * runs git, npm, or the build. scripts/build-runtime-artifact.mjs supplies the
 * real `buildDeployArtifact` stage; tests supply a fake directory.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { writeBuildStamp } from "./deploySettle.js";
import { computeSchemaDigest, loadExecutionContract } from "./execution/contract.js";

const execFileAsync = promisify(execFile);

export const RUNTIME_ARTIFACT_MANIFEST_FILENAME = "manifest.json";
export const RUNTIME_ARTIFACT_SUMS_FILENAME = "SHA256SUMS";
export const RUNTIME_ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Which verification the artifact's build actually passed. */
export type RuntimeArtifactGate = "full" | "tests-skipped";

export type RuntimeArtifactManifest = {
  schemaVersion: typeof RUNTIME_ARTIFACT_MANIFEST_SCHEMA_VERSION;
  /** Full 40-hex commit the artifact was built from. */
  sha: string;
  /** deploySettle tree digest of dist/ — equals deploys.json's artifactHash for this sha. */
  artifactHash: string;
  /** Daemon RPC protocol the bundled v2 CLI speaks (`hive deploy-info`.protocol). */
  protocol: string;
  /** Execution corpus schemaDigest (contracts/execution/v1/digest.json, recomputed). */
  executionCorpusDigest: string;
  engines: { node: string };
  package: { name: string; version: string };
  tarball: string;
  gate: RuntimeArtifactGate;
  builtAt: string;
};

export type PackRuntimeArtifactOptions = {
  /** The stage directory `buildDeployArtifact` returned (its CONTENTS are the runtime). */
  artifactDir: string;
  sha: string;
  outDir: string;
  gate?: RuntimeArtifactGate;
  now?: () => Date;
  log?: (line: string) => void;
};

export type PackRuntimeArtifactOutcome = {
  tarballPath: string;
  manifestPath: string;
  sumsPath: string;
  manifest: RuntimeArtifactManifest;
  sums: Array<{ name: string; sha256: string; bytes: number }>;
};

export function runtimeArtifactTarballName(sha: string): string {
  if (!SHA_PATTERN.test(sha)) throw new Error(`runtime-artifact: expected a full 40-hex sha, got '${sha}'`);
  return `honeybee-runtime-${sha}.tar.gz`;
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** `sha256sum -c` / `shasum -a 256 -c` compatible: two spaces, bare filename. */
export function formatSha256Sums(entries: Array<{ name: string; sha256: string }>): string {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n`;
}

/**
 * The protocol the artifact's own daemon will announce. Read from the
 * artifact bytes (the esbuild v2 bundle keeps `var PROTOCOL = "v2/N"`)
 * rather than the working tree, so the manifest describes the sha that was
 * built, not whoever ran the script.
 */
export async function readArtifactProtocol(artifactDir: string): Promise<string> {
  const bundle = join(artifactDir, "dist", "v2", "cli.js");
  let source: string;
  try {
    source = await readFile(bundle, "utf8");
  } catch {
    throw new Error(`runtime-artifact: no v2 CLI bundle at ${bundle}`);
  }
  const match = /\bPROTOCOL\d* = "(v2\/\d+)"/.exec(source);
  if (!match) throw new Error(`runtime-artifact: cannot find the daemon PROTOCOL constant in ${bundle}`);
  return match[1]!;
}

/**
 * Recompute the execution corpus digest from the artifact's contracts and
 * refuse drift against the committed digest.json (same check deploy-settle
 * runs on the installed tree).
 */
export function readArtifactExecutionDigest(artifactDir: string): string {
  const corpusDir = join(artifactDir, "contracts", "execution", "v1");
  const contract = loadExecutionContract(corpusDir);
  const computed = computeSchemaDigest(contract);
  if (contract.committedDigest !== computed) {
    throw new Error(
      `runtime-artifact: execution corpus digest drift in ${corpusDir} (${contract.committedDigest} != ${computed})`,
    );
  }
  return computed;
}

async function readArtifactPackage(artifactDir: string): Promise<{ name: string; version: string; node: string }> {
  const path = join(artifactDir, "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8")) as {
    name?: unknown;
    version?: unknown;
    engines?: { node?: unknown };
  };
  if (pkg.name !== "honeybee") throw new Error(`runtime-artifact: ${path} is not the honeybee package (${String(pkg.name)})`);
  if (typeof pkg.version !== "string") throw new Error(`runtime-artifact: ${path} has no version`);
  if (typeof pkg.engines?.node !== "string") throw new Error(`runtime-artifact: ${path} declares no engines.node`);
  return { name: pkg.name, version: pkg.version, node: pkg.engines.node };
}

/**
 * Stamp dist/ exactly as deployVersion does and gather the manifest facts.
 * Stamping is idempotent on content: a re-run over the same bytes yields the
 * same artifactHash (the stamp file itself is excluded from the digest).
 */
export async function describeRuntimeArtifact(
  options: Pick<PackRuntimeArtifactOptions, "artifactDir" | "sha" | "gate" | "now">,
): Promise<RuntimeArtifactManifest> {
  const { artifactDir, sha } = options;
  const tarball = runtimeArtifactTarballName(sha);
  if (!existsSync(join(artifactDir, "dist", "cli.js"))) {
    throw new Error(`runtime-artifact: built artifact has no dist/cli.js under ${artifactDir}`);
  }
  const stamp = await writeBuildStamp(join(artifactDir, "dist"));
  const protocol = await readArtifactProtocol(artifactDir);
  const executionCorpusDigest = readArtifactExecutionDigest(artifactDir);
  const pkg = await readArtifactPackage(artifactDir);
  return {
    schemaVersion: RUNTIME_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    sha,
    artifactHash: stamp.hash,
    protocol,
    executionCorpusDigest,
    engines: { node: pkg.node },
    package: { name: pkg.name, version: pkg.version },
    tarball,
    gate: options.gate ?? "full",
    builtAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * Cut the tarball from the stage directory (top-level entries, no `./`
 * prefix, no macOS AppleDouble sidecars) after dropping manifest.json inside
 * it, then write manifest.json + SHA256SUMS beside the tarball.
 */
export async function packRuntimeArtifact(options: PackRuntimeArtifactOptions): Promise<PackRuntimeArtifactOutcome> {
  const log = options.log ?? (() => undefined);
  const manifest = await describeRuntimeArtifact(options);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  // The in-tarball copy lets a single downloaded file describe itself
  // (`hive deploy --artifact <tarball>` reads sha/artifactHash from it).
  await writeFile(join(options.artifactDir, RUNTIME_ARTIFACT_MANIFEST_FILENAME), manifestText);

  await mkdir(options.outDir, { recursive: true });
  const tarballPath = join(options.outDir, manifest.tarball);
  const entries = (await readdir(options.artifactDir)).sort();
  log(`runtime-artifact: tar ${entries.join(" ")} -> ${tarballPath}`);
  await execFileAsync("tar", ["-czf", tarballPath, "-C", options.artifactDir, ...entries], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });

  const manifestPath = join(options.outDir, RUNTIME_ARTIFACT_MANIFEST_FILENAME);
  await writeFile(manifestPath, manifestText);
  const sums = [];
  for (const path of [tarballPath, manifestPath]) {
    const digest = await sha256File(path);
    sums.push({ name: basename(path), ...digest });
  }
  const sumsPath = join(options.outDir, RUNTIME_ARTIFACT_SUMS_FILENAME);
  await writeFile(sumsPath, formatSha256Sums(sums));
  return { tarballPath, manifestPath, sumsPath, manifest, sums };
}

/** Parse a manifest back, validating the fields installers depend on. */
export function parseRuntimeArtifactManifest(raw: string): RuntimeArtifactManifest {
  const value = JSON.parse(raw) as Partial<RuntimeArtifactManifest>;
  if (value.schemaVersion !== RUNTIME_ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`runtime-artifact: unsupported manifest schemaVersion ${String(value.schemaVersion)}`);
  }
  if (typeof value.sha !== "string" || !SHA_PATTERN.test(value.sha)) throw new Error("runtime-artifact: manifest sha is not a full sha");
  if (typeof value.artifactHash !== "string" || value.artifactHash.length !== 64) {
    throw new Error("runtime-artifact: manifest artifactHash is not a sha256 hex digest");
  }
  for (const key of ["protocol", "executionCorpusDigest", "tarball", "builtAt"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) throw new Error(`runtime-artifact: manifest ${key} missing`);
  }
  if (typeof value.engines?.node !== "string") throw new Error("runtime-artifact: manifest engines.node missing");
  if (value.gate !== "full" && value.gate !== "tests-skipped") throw new Error("runtime-artifact: manifest gate invalid");
  return value as RuntimeArtifactManifest;
}
