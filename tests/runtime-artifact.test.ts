// Redistributable runtime artifact (src/runtimeArtifact.ts, driven by
// scripts/build-runtime-artifact.mjs). Exercises the manifest / hash / tar
// layout over a fake stage directory: no git, npm, or build ever runs here.
// The one invariant that matters most: the manifest's artifactHash must be
// exactly what `hive deploy` would record in deploys.json for the same bytes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILD_STAMP_FILENAME, hashDirectoryTree, readBuildStamp } from "../src/deploySettle.js";
import { computeSchemaDigest, loadExecutionContract } from "../src/execution/contract.js";
import {
  RUNTIME_ARTIFACT_MANIFEST_FILENAME,
  RUNTIME_ARTIFACT_SUMS_FILENAME,
  describeRuntimeArtifact,
  formatSha256Sums,
  packRuntimeArtifact,
  parseRuntimeArtifactManifest,
  readArtifactExecutionDigest,
  readArtifactProtocol,
  runtimeArtifactTarballName,
  sha256File,
} from "../src/runtimeArtifact.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const FIXED_NOW = () => new Date("2026-08-26T10:00:00.000Z");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hive-runtime-artifact-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Fake stage dir shaped like buildDeployArtifact's output: dist/ with the
 * CLI and the v2 bundle, the REAL committed execution corpus (copied from
 * this checkout), package.json, a production node_modules, and the tmux conf.
 */
async function seedArtifact(dir: string, options: { protocol?: string } = {}): Promise<string> {
  const stage = join(dir, "stage");
  await mkdir(join(stage, "dist", "v2"), { recursive: true });
  await mkdir(join(stage, "node_modules", "uuid"), { recursive: true });
  await mkdir(join(stage, "docs"), { recursive: true });
  await writeFile(join(stage, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('hive');\n");
  await writeFile(
    join(stage, "dist", "v2", "cli.js"),
    `// bundle\nvar PROTOCOL = ${JSON.stringify(options.protocol ?? "v2/1")};\nconsole.log(PROTOCOL);\n`,
  );
  await cp(join(process.cwd(), "contracts", "execution", "v1"), join(stage, "contracts", "execution", "v1"), { recursive: true });
  await writeFile(
    join(stage, "package.json"),
    `${JSON.stringify({ name: "honeybee", version: "0.0.1", engines: { node: ">=20" } }, null, 2)}\n`,
  );
  await writeFile(join(stage, "package-lock.json"), "{}\n");
  await writeFile(join(stage, "node_modules", "uuid", "index.js"), "module.exports = {};\n");
  await writeFile(join(stage, "docs", "honeybee.tmux.conf"), "# tmux\n");
  return stage;
}

function tarList(tarballPath: string): string[] {
  return execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" }).trim().split("\n").sort();
}

test("tarball name carries the full sha and refuses short refs", () => {
  assert.equal(runtimeArtifactTarballName(SHA), `honeybee-runtime-${SHA}.tar.gz`);
  assert.throws(() => runtimeArtifactTarballName("abc123"), /full 40-hex sha/);
  assert.throws(() => runtimeArtifactTarballName("HEAD"), /full 40-hex sha/);
});

test("manifest artifactHash equals the deploy build stamp of dist/ and is idempotent", async () => {
  await withTempDir(async (dir) => {
    const stage = await seedArtifact(dir);
    const expectedHash = await hashDirectoryTree(join(stage, "dist"));

    const manifest = await describeRuntimeArtifact({ artifactDir: stage, sha: SHA, now: FIXED_NOW });
    assert.equal(manifest.artifactHash, expectedHash);
    // The stamp lives inside dist/ exactly as deployVersion writes it.
    const stamp = await readBuildStamp(join(stage, "dist"));
    assert.equal(stamp?.hash, expectedHash);
    // Stamping again over the same bytes yields the same digest (stamp excluded from itself).
    const again = await describeRuntimeArtifact({ artifactDir: stage, sha: SHA, now: FIXED_NOW });
    assert.equal(again.artifactHash, expectedHash);
    assert.equal(await hashDirectoryTree(join(stage, "dist")), expectedHash);

    assert.equal(manifest.sha, SHA);
    assert.equal(manifest.protocol, "v2/1");
    assert.equal(manifest.engines.node, ">=20");
    assert.deepEqual(manifest.package, { name: "honeybee", version: "0.0.1" });
    assert.equal(manifest.gate, "full");
    assert.equal(manifest.builtAt, "2026-08-26T10:00:00.000Z");
    assert.equal(manifest.tarball, runtimeArtifactTarballName(SHA));
    // Corpus digest is recomputed from the artifact's own contracts and matches its digest.json.
    const contract = loadExecutionContract(join(stage, "contracts", "execution", "v1"));
    assert.equal(manifest.executionCorpusDigest, computeSchemaDigest(contract));
    assert.equal(manifest.executionCorpusDigest, contract.committedDigest);
    assert.match(manifest.executionCorpusDigest, /^sha256:[0-9a-f]{64}$/);
  });
});

test("a changed dist byte changes artifactHash; other stage files do not", async () => {
  await withTempDir(async (dir) => {
    const stage = await seedArtifact(dir);
    const base = (await describeRuntimeArtifact({ artifactDir: stage, sha: SHA, now: FIXED_NOW })).artifactHash;
    await writeFile(join(stage, "node_modules", "uuid", "index.js"), "module.exports = { v: 2 };\n");
    assert.equal((await describeRuntimeArtifact({ artifactDir: stage, sha: SHA, now: FIXED_NOW })).artifactHash, base);
    await writeFile(join(stage, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('hive!');\n");
    assert.notEqual((await describeRuntimeArtifact({ artifactDir: stage, sha: SHA, now: FIXED_NOW })).artifactHash, base);
  });
});

test("protocol is read from the artifact's own v2 bundle", async () => {
  await withTempDir(async (dir) => {
    const stage = await seedArtifact(dir, { protocol: "v2/7" });
    assert.equal(await readArtifactProtocol(stage), "v2/7");
    await writeFile(join(stage, "dist", "v2", "cli.js"), "// no constant here\n");
    await assert.rejects(readArtifactProtocol(stage), /cannot find the daemon PROTOCOL constant/);
    await rm(join(stage, "dist", "v2", "cli.js"));
    await assert.rejects(readArtifactProtocol(stage), /no v2 CLI bundle/);
  });
});

test("execution corpus drift inside the artifact is refused", async () => {
  await withTempDir(async (dir) => {
    const stage = await seedArtifact(dir);
    assert.match(readArtifactExecutionDigest(stage), /^sha256:/);
    await writeFile(
      join(stage, "contracts", "execution", "v1", "digest.json"),
      `${JSON.stringify({ schemaDigest: "sha256:0000" })}\n`,
    );
    assert.throws(() => readArtifactExecutionDigest(stage), /execution corpus digest drift/);
  });
});

test("describe refuses an artifact without dist/cli.js or a foreign package", async () => {
  await withTempDir(async (dir) => {
    const stage = await seedArtifact(dir);
    await writeFile(join(stage, "package.json"), `${JSON.stringify({ name: "other", version: "1.0.0", engines: { node: ">=20" } })}\n`);
    await assert.rejects(describeRuntimeArtifact({ artifactDir: stage, sha: SHA }), /not the honeybee package/);
    await rm(join(stage, "dist", "cli.js"));
    await assert.rejects(describeRuntimeArtifact({ artifactDir: stage, sha: SHA }), /no dist\/cli\.js/);
  });
});

test("pack writes tarball + manifest + SHA256SUMS; tarball is the stage dir with the stamp and manifest inside", async () => {
  await withTempDir(async (dir) => {
    const stage = await seedArtifact(dir);
    const outDir = join(dir, "out", "nested");
    const outcome = await packRuntimeArtifact({ artifactDir: stage, sha: SHA, outDir, now: FIXED_NOW });

    assert.equal(outcome.tarballPath, join(outDir, `honeybee-runtime-${SHA}.tar.gz`));
    assert.equal(outcome.manifestPath, join(outDir, RUNTIME_ARTIFACT_MANIFEST_FILENAME));
    assert.equal(outcome.sumsPath, join(outDir, RUNTIME_ARTIFACT_SUMS_FILENAME));
    for (const path of [outcome.tarballPath, outcome.manifestPath, outcome.sumsPath]) assert.ok(existsSync(path), path);

    // Tarball layout: top-level stage entries, no ./ prefix, no AppleDouble sidecars.
    const listed = tarList(outcome.tarballPath);
    for (const required of [
      "dist/cli.js",
      "dist/v2/cli.js",
      `dist/${BUILD_STAMP_FILENAME}`,
      "contracts/execution/v1/digest.json",
      "contracts/execution/v1/profile.json",
      "package.json",
      "package-lock.json",
      "node_modules/uuid/index.js",
      "docs/honeybee.tmux.conf",
      RUNTIME_ARTIFACT_MANIFEST_FILENAME,
    ]) {
      assert.ok(listed.includes(required), `tarball is missing ${required}: ${listed.join(", ")}`);
    }
    for (const entry of listed) {
      assert.doesNotMatch(entry, /^\.\//, `entry has ./ prefix: ${entry}`);
      assert.doesNotMatch(entry, /(^|\/)\._/, `AppleDouble sidecar leaked: ${entry}`);
      assert.doesNotMatch(entry, /^(src|tests|\.git)\//, `development tree leaked: ${entry}`);
    }

    // The manifest beside the tarball equals the one inside it, and parses.
    const outside = await readFile(outcome.manifestPath, "utf8");
    const parsed = parseRuntimeArtifactManifest(outside);
    assert.deepEqual(parsed, outcome.manifest);
    const extracted = join(dir, "extracted");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", outcome.tarballPath, "-C", extracted]);
    assert.equal(await readFile(join(extracted, RUNTIME_ARTIFACT_MANIFEST_FILENAME), "utf8"), outside);
    // The extracted dist re-hashes to the recorded artifactHash — what `hive deploy --artifact` will verify.
    assert.equal(await hashDirectoryTree(join(extracted, "dist")), parsed.artifactHash);
    assert.equal((await readBuildStamp(join(extracted, "dist")))?.hash, parsed.artifactHash);

    // SHA256SUMS covers exactly the tarball and the manifest, in sha256sum -c format.
    const sums = await readFile(outcome.sumsPath, "utf8");
    assert.equal(sums, formatSha256Sums(outcome.sums));
    const lines = sums.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `${(await sha256File(outcome.tarballPath)).sha256}  honeybee-runtime-${SHA}.tar.gz`);
    assert.equal(lines[1], `${(await sha256File(outcome.manifestPath)).sha256}  ${RUNTIME_ARTIFACT_MANIFEST_FILENAME}`);
    assert.equal(outcome.sums[0]!.bytes, (await readFile(outcome.tarballPath)).length);
    // The shipped shasum tool accepts the file as-is.
    execFileSync("shasum", ["-a", "256", "-c", RUNTIME_ARTIFACT_SUMS_FILENAME], { cwd: outDir, stdio: "pipe" });
  });
});

test("a tests-skipped build is marked in the manifest so it cannot pass for a release", async () => {
  await withTempDir(async (dir) => {
    const stage = await seedArtifact(dir);
    const outcome = await packRuntimeArtifact({ artifactDir: stage, sha: SHA, outDir: join(dir, "out"), gate: "tests-skipped" });
    assert.equal(outcome.manifest.gate, "tests-skipped");
    assert.equal(parseRuntimeArtifactManifest(await readFile(outcome.manifestPath, "utf8")).gate, "tests-skipped");
  });
});

test("manifest parsing rejects malformed manifests", () => {
  const good = {
    schemaVersion: 1,
    sha: SHA,
    artifactHash: "a".repeat(64),
    protocol: "v2/1",
    executionCorpusDigest: "sha256:abc",
    engines: { node: ">=20" },
    package: { name: "honeybee", version: "0.0.1" },
    tarball: runtimeArtifactTarballName(SHA),
    gate: "full",
    builtAt: "2026-08-26T10:00:00.000Z",
  };
  assert.deepEqual(parseRuntimeArtifactManifest(JSON.stringify(good)), good);
  assert.throws(() => parseRuntimeArtifactManifest(JSON.stringify({ ...good, schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => parseRuntimeArtifactManifest(JSON.stringify({ ...good, sha: "abc" })), /full sha/);
  assert.throws(() => parseRuntimeArtifactManifest(JSON.stringify({ ...good, artifactHash: "short" })), /artifactHash/);
  assert.throws(() => parseRuntimeArtifactManifest(JSON.stringify({ ...good, protocol: "" })), /protocol/);
  assert.throws(() => parseRuntimeArtifactManifest(JSON.stringify({ ...good, engines: {} })), /engines\.node/);
  assert.throws(() => parseRuntimeArtifactManifest(JSON.stringify({ ...good, gate: "yolo" })), /gate/);
});

test("the artifact script reuses buildDeployArtifact and packRuntimeArtifact instead of forking them", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "build-runtime-artifact.mjs"), "utf8");
  assert.match(source, /import \{ buildDeployArtifact \} from "\.\.\/src\/commands\/deploy\.ts"/);
  assert.match(source, /import \{ packRuntimeArtifact \} from "\.\.\/src\/runtimeArtifact\.ts"/);
  assert.match(source, /\["-C", repoRoot, "rev-parse", "--verify", `\$\{ref\}\^\{commit\}`\]/);
  assert.match(source, /gate: options\.skipTests \? "tests-skipped" : "full"/);
  assert.doesNotMatch(source, /npm", \["ci"\]|git", \["archive"/, "the script must not re-implement the deploy build steps");
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["runtime:artifact"], "tsx scripts/build-runtime-artifact.mjs");
});
