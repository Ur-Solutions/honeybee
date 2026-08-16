#!/usr/bin/env node
// Deploy with a settle barrier: build -> stamp -> immutable npm pack -> global
// install -> PROVE the
// globally installed module tree equals the local build -> rebind launchd to
// that exact installed CLI -> restart. Encodes the incident where a daemon
// restart mid-copy booted a stale module mix and false-reaped 8 live runners;
// the daemon must never
// restart over a tree that has not settled. Settle logic lives (typed and
// unit-tested) in src/deploySettle.ts; this orchestrator imports the copy the
// build it just ran emitted.
//
//   npm run deploy
//   HIVE_DEPLOY_SETTLE_TIMEOUT_MS=120000 npm run deploy   # slow disks/NFS
//
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const localDist = join(repoRoot, "dist");

function run(command, args) {
  console.log(`deploy-settle: ${command} ${args.join(" ")}`);
  const outcome = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) {
    throw new Error(`deploy-settle: '${command} ${args.join(" ")}' exited with ${outcome.status}`);
  }
}

run("npm", ["run", "build"]);

// Import from the build that just ran, so script and daemon share one
// settle implementation and the script needs no compile step of its own.
const { waitForSettledInstall, writeBuildStamp } = await import(
  new URL("../dist/deploySettle.js", import.meta.url).href
);
const {
  EXECUTION_VALIDATION_SURFACE_VERSION,
  computeExecutionValidationSurfaceDigest,
  computeSchemaDigest,
  executionBaselineFeatures,
  loadExecutionContract,
} = await import(
  new URL("../dist/execution/index.js", import.meta.url).href
);
const { assertExecutionMaterializationMatches, preflightInstalledExecutionConsumer } = await import(
  new URL("../dist/execution/consumerRollout.js", import.meta.url).href
);

const executionContract = loadExecutionContract();
const executionProfile = executionContract.profile;
const computedExecutionDigest = computeSchemaDigest(executionContract);
if (executionContract.committedDigest !== computedExecutionDigest) {
  throw new Error(
    `deploy-settle: execution corpus digest drift (${executionContract.committedDigest} != ${computedExecutionDigest})`,
  );
}
const contractCorpusPath = "contracts/execution/v1";
const dirtyContractCorpus = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all", "--", contractCorpusPath],
  { cwd: repoRoot, encoding: "utf8" },
).trim();
if (dirtyContractCorpus.length > 0) {
  throw new Error(
    `deploy-settle: execution corpus has uncommitted bytes; commit and certify them before deploy\n${dirtyContractCorpus}`,
  );
}
const executionSourceRevision = execFileSync(
  "git",
  ["log", "-1", "--format=%H", "--", contractCorpusPath],
  { cwd: repoRoot, encoding: "utf8" },
).trim();
if (!/^[a-f0-9]{40}$/.test(executionSourceRevision)) {
  throw new Error(`deploy-settle: cannot resolve execution corpus source revision (${executionSourceRevision || "empty"})`);
}
const executionCandidate = {
  contract: String(executionProfile.contract ?? ""),
  contractVersion: String(executionProfile.contractVersion ?? ""),
  protocolVersion: String(executionProfile.protocolVersion ?? ""),
  schemaDigest: computedExecutionDigest,
  validationSurfaceVersion: EXECUTION_VALIDATION_SURFACE_VERSION,
  validationSurfaceDigest: computeExecutionValidationSurfaceDigest(executionContract),
  sourceRevision: executionSourceRevision,
  features: executionBaselineFeatures(executionContract),
};
const consumer = preflightInstalledExecutionConsumer(executionCandidate, {
  ...(process.env.APIARY_APP_BUNDLE !== undefined
    ? { appBundlePath: process.env.APIARY_APP_BUNDLE }
    : {}),
});
console.log(
  consumer.kind === "accepted"
    ? `deploy-settle: ${consumer.product} accepts execution contract (${consumer.mode}, surface ` +
      `v${executionCandidate.validationSurfaceVersion}, source ${executionCandidate.sourceRevision.slice(0, 12)})`
    : `deploy-settle: execution consumer preflight skipped (${consumer.detail})`,
);

const stamp = await writeBuildStamp(localDist);
console.log(`deploy-settle: local build ${stamp.hash.slice(0, 12)} stamped`);

// Installing `.` globally can leave npm's package entry as a symlink to the
// invoking checkout. That makes a successful deploy depend on a disposable
// worktree remaining forever. Pack the already-certified bytes and install
// the archive: npm must materialize an independent global tree.
const packRoot = mkdtempSync(join(tmpdir(), "honeybee-deploy-pack-"));
try {
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", packRoot],
    { cwd: repoRoot, encoding: "utf8" },
  ));
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0 || basename(filename) !== filename) {
    throw new Error(`deploy-settle: npm pack returned an invalid filename (${String(filename)})`);
  }
  run("npm", ["i", "-g", join(packRoot, filename)]);
} finally {
  rmSync(packRoot, { recursive: true, force: true });
}

// Prove npm did not retain the invoking checkout despite the archive boundary.
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const installedPackageRoot = realpathSync(join(globalRoot, "honeybee"));
if (installedPackageRoot === realpathSync(repoRoot)) {
  throw new Error("deploy-settle: global Honeybee still resolves to the invoking checkout");
}
const installedDist = join(installedPackageRoot, "dist");

const timeoutMs = Number(process.env.HIVE_DEPLOY_SETTLE_TIMEOUT_MS);
const settled = await waitForSettledInstall(localDist, installedDist, {
  ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
});
console.log(`deploy-settle: installed tree settled at ${settled.hash.slice(0, 12)} (${settled.attempts} probe${settled.attempts === 1 ? "" : "s"})`);

// The contract corpus is packaged beside dist/, so the dist settle hash does
// not cover it. Reload the installed corpus and prove the bytes that the
// daemon will actually read still equal the preflighted candidate.
const installedExecutionContract = loadExecutionContract(
  join(installedPackageRoot, "contracts", "execution", "v1"),
);
const installedExecutionDigest = computeSchemaDigest(installedExecutionContract);
const installedExecutionSurface = computeExecutionValidationSurfaceDigest(installedExecutionContract);
const installedExecutionFeatures = executionBaselineFeatures(installedExecutionContract);
if (installedExecutionContract.committedDigest !== installedExecutionDigest) {
  throw new Error(
    `deploy-settle: globally installed execution corpus digest drift ` +
      `(${installedExecutionContract.committedDigest} != ${installedExecutionDigest})`,
  );
}
assertExecutionMaterializationMatches(
  executionCandidate,
  {
    schemaDigest: installedExecutionDigest,
    validationSurfaceVersion: EXECUTION_VALIDATION_SURFACE_VERSION,
    validationSurfaceDigest: installedExecutionSurface,
    features: installedExecutionFeatures,
  },
  "globally installed execution corpus",
);
console.log(
  `deploy-settle: installed execution corpus verified (${installedExecutionDigest.slice(0, 19)}, ` +
    `surface ${installedExecutionSurface.slice(0, 19)})`,
);

// A LaunchAgent records the absolute CLI path from the shell that originally
// installed it. Merely invoking `hive daemon restart` can therefore restart a
// stale checkout even though the global module above settled correctly. Run
// the verified installed CLI itself and force-rewrite the plist first. The
// following restart is both a liveness check and a non-zero failure signal if
// launchctl bootstrap did not actually take.
const installedCli = join(installedDist, "cli.js");
run(process.execPath, [installedCli, "daemon", "install", "--force"]);
run(process.execPath, [installedCli, "daemon", "restart"]);
console.log("deploy-settle: daemon rebound and restarted on the settled installed module tree");
