#!/usr/bin/env node
// Deploy with a settle barrier: build -> stamp -> npm i -g . -> PROVE the
// globally installed module tree equals the local build -> hive daemon
// restart. Encodes the incident where a daemon restart mid-copy booted a
// stale module mix and false-reaped 8 live runners; the daemon must never
// restart over a tree that has not settled. Settle logic lives (typed and
// unit-tested) in src/deploySettle.ts; this orchestrator imports the copy the
// build it just ran emitted.
//
//   npm run deploy
//   HIVE_DEPLOY_SETTLE_TIMEOUT_MS=120000 npm run deploy   # slow disks/NFS
//
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
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

const stamp = await writeBuildStamp(localDist);
console.log(`deploy-settle: local build ${stamp.hash.slice(0, 12)} stamped`);

run("npm", ["i", "-g", "."]);

// The global install may be a plain copy or a symlink into a worktree;
// realpath makes the settle check observe whatever tree the daemon would
// actually load.
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const installedDist = realpathSync(join(globalRoot, "honeybee", "dist"));

const timeoutMs = Number(process.env.HIVE_DEPLOY_SETTLE_TIMEOUT_MS);
const settled = await waitForSettledInstall(localDist, installedDist, {
  ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
});
console.log(`deploy-settle: installed tree settled at ${settled.hash.slice(0, 12)} (${settled.attempts} probe${settled.attempts === 1 ? "" : "s"})`);

run("hive", ["daemon", "restart"]);
console.log("deploy-settle: daemon restarted on a settled module tree");
