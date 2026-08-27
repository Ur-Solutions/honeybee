#!/usr/bin/env node
// Build a redistributable Honeybee runtime tarball for a committed sha
// (distribution plan H1 / rollout F2): the exact stage directory `hive deploy`
// installs, plus manifest.json and SHA256SUMS, so a machine with no git, npm,
// or checkout can install it later (`hive deploy --artifact`, H2).
//
//   npm run runtime:artifact                       # HEAD, full gate, .artifacts/runtime/
//   npm run runtime:artifact -- <sha|ref> --out <dir>
//   npm run runtime:artifact -- --skip-tests       # local iteration only; manifest gate=tests-skipped
//
// Runs through tsx (like scripts/update-execution-digest.mjs) so it shares
// the production build path — src/commands/deploy.ts buildDeployArtifact —
// and the manifest/hash/tar logic in src/runtimeArtifact.ts with `hive
// deploy` instead of forking either. The committed sha is exported with
// `git archive`; the working tree is only ever read.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeployArtifact } from "../src/commands/deploy.ts";
import { packRuntimeArtifact } from "../src/runtimeArtifact.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const USAGE = [
  "Usage: npm run runtime:artifact -- [<sha|ref>] [--out <dir>] [--skip-tests]",
  "  <sha|ref>     commit to build (default HEAD); resolved to a full sha",
  "  --out <dir>   output directory (default .artifacts/runtime/)",
  "  --skip-tests  skip the test gate (check + build still run); marks manifest gate=tests-skipped",
].join("\n");

function parseArgs(argv) {
  const options = { ref: "HEAD", out: join(repoRoot, ".artifacts", "runtime"), skipTests: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--skip-tests") {
      options.skipTests = true;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--out needs a directory\n${USAGE}`);
      options.out = resolve(value);
      index += 1;
    } else if (arg.startsWith("--out=")) {
      options.out = resolve(arg.slice("--out=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error(USAGE);
  if (positional.length === 1) options.ref = positional[0];
  return options;
}

function resolveCommit(ref) {
  let sha;
  try {
    sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`runtime-artifact: cannot resolve '${ref}' to a commit in ${repoRoot}\n${error instanceof Error ? error.message : String(error)}`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`runtime-artifact: unexpected rev-parse output: ${sha}`);
  return sha;
}

const options = parseArgs(process.argv.slice(2));
const pkgName = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).name;
if (pkgName !== "honeybee") throw new Error(`runtime-artifact: ${repoRoot} is not the honeybee repo (${String(pkgName)})`);
const sha = resolveCommit(options.ref);
const log = (line) => console.log(line);
log(`runtime-artifact: building ${sha} (${options.ref}) in a clean temp checkout${options.skipTests ? " [tests skipped]" : ""}`);

const workDir = await mkdtemp(join(tmpdir(), "hive-runtime-artifact-"));
try {
  const { artifactDir } = await buildDeployArtifact({
    repoRoot,
    sha,
    workDir,
    log,
    ...(options.skipTests ? { skipTests: true } : {}),
  });
  const outcome = await packRuntimeArtifact({
    artifactDir,
    sha,
    outDir: options.out,
    gate: options.skipTests ? "tests-skipped" : "full",
    log,
  });
  const { manifest } = outcome;
  log("");
  log(`runtime-artifact: ok ${sha.slice(0, 12)} gate=${manifest.gate}`);
  log(`  tarball:        ${outcome.tarballPath} (${outcome.sums[0].bytes} bytes)`);
  log(`  manifest:       ${outcome.manifestPath}`);
  log(`  sums:           ${outcome.sumsPath}`);
  log(`  artifactHash:   ${manifest.artifactHash}`);
  log(`  protocol:       ${manifest.protocol}`);
  log(`  corpus digest:  ${manifest.executionCorpusDigest}`);
  log(`  engines.node:   ${manifest.engines.node}`);
  for (const sum of outcome.sums) log(`  sha256 ${sum.sha256}  ${sum.name}`);
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}
