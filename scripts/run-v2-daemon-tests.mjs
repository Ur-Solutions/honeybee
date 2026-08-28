/**
 * v2 daemon/CLI tests: in-process unit files run in parallel; files that spawn
 * a real daemon, tmux seat, or cell stay serial. Cross-file parallelism of the
 * process-spawning group flaked the deploy gate (2026-08-19).
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signalExitCode, terminateTestProcessTree } from "./test-process-control.mjs";
import { testEnv } from "./test-env.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const UNIT_FILES = new Set([
  "v2/daemon/tests/accounts-service.test.ts",
  "v2/daemon/tests/login-flows.test.ts",
  "v2/daemon/tests/login-worker.test.ts",
  "v2/daemon/tests/config.test.ts",
  "v2/daemon/tests/naming.test.ts",
  "v2/daemon/tests/autoTitle.test.ts",
  "v2/daemon/tests/envelope.test.ts",
  "v2/daemon/tests/loops.test.ts",
  "v2/daemon/tests/service.test.ts",
  "v2/daemon/tests/telemetry.test.ts",
]);

function listTests(dir, prefix) {
  return readdirSync(join(root, dir))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `${prefix}/${name}`)
    .sort();
}

const daemonTests = listTests("v2/daemon/tests", "v2/daemon/tests");
const cliTests = listTests("v2/cli/tests", "v2/cli/tests");
for (const path of UNIT_FILES) {
  if (!daemonTests.includes(path)) throw new Error(`v2 daemon unit file missing: ${path}`);
}
const unitFiles = daemonTests.filter((path) => UNIT_FILES.has(path));
const intFiles = [...daemonTests.filter((path) => !UNIT_FILES.has(path)), ...cliTests];

const forwarded = process.argv.slice(2);
const requestedFiles = forwarded.filter((arg) => /\.test\.ts$/.test(arg));
const nodeArgs = forwarded.filter((arg) => !requestedFiles.includes(arg));
const unitConcurrency = process.env.HIVE_TEST_CONCURRENCY?.trim() || "8";
const reporter = process.env.HIVE_TEST_REPORTER?.trim();

async function runGroup(files, concurrency, extraArgs = []) {
  if (files.length === 0) return 0;
  const child = spawn(
    process.execPath,
    [
      "--test",
      `--test-concurrency=${concurrency}`,
      ...(reporter ? [`--test-reporter=${reporter}`] : []),
      ...extraArgs,
      ...nodeArgs,
      ...files,
    ],
    {
      cwd: root,
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: testEnv(),
    },
  );

  let requestedSignal;
  let termination;
  const forwardSignal = (signal) => {
    requestedSignal ??= signal;
    termination ??= terminateTestProcessTree(child, signal);
  };
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const forwardTermination = () => forwardSignal("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  const result = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  process.removeListener("SIGINT", forwardInterrupt);
  process.removeListener("SIGTERM", forwardTermination);
  if (termination) await termination;
  if (result.error) throw result.error;
  if (requestedSignal) return signalExitCode(requestedSignal);
  if (result.signal) {
    await terminateTestProcessTree(child, result.signal);
    return signalExitCode(result.signal);
  }
  return result.code ?? 1;
}

if (requestedFiles.length > 0) {
  const unknown = requestedFiles.filter((path) => !daemonTests.includes(path) && !cliTests.includes(path));
  if (unknown.length > 0) throw new Error(`unknown v2 daemon/cli test file: ${unknown.join(", ")}`);
  const unit = requestedFiles.filter((path) => UNIT_FILES.has(path));
  const serial = requestedFiles.filter((path) => !UNIT_FILES.has(path));
  const unitResult = await runGroup(unit, unitConcurrency, ["--test-isolation=none"]);
  const intResult = await runGroup(serial, "1");
  process.exitCode = unitResult || intResult;
} else {
  const unitResult = await runGroup(unitFiles, unitConcurrency, ["--test-isolation=none"]);
  const intResult = await runGroup(intFiles, "1");
  process.exitCode = unitResult || intResult;
}
