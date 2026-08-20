import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeTestCliFlags, signalExitCode, terminateTestProcessTree } from "./test-process-control.mjs";
import { testEnv } from "./test-env.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, ".test-dist", "test-files.json");
const testFiles = JSON.parse(await readFile(manifestPath, "utf8"));

if (!Array.isArray(testFiles) || testFiles.some((path) => typeof path !== "string" || !path.startsWith(".test-dist/tests/"))) {
  throw new Error(`invalid compiled-test manifest: ${manifestPath}`);
}

const concurrency = process.env.HIVE_TEST_CONCURRENCY?.trim() || "8";
const reporter = process.env.HIVE_TEST_REPORTER?.trim() || "dot";
const timeout = process.env.HIVE_TEST_TIMEOUT?.trim() || "60000";
const forwarded = process.argv.slice(2);
const requestedFiles = forwarded.filter((arg) => /\.(?:[cm]?[jt]s)$/.test(arg));
const nodeArgs = forwarded.filter((arg) => !requestedFiles.includes(arg));
const selectedTests = requestedFiles.length === 0
  ? testFiles
  : requestedFiles.map((path) => {
      const compiled = path.startsWith("tests/")
        ? join(".test-dist", path).replace(/\.ts$/, ".js")
        : path;
      if (!testFiles.includes(compiled)) throw new Error(`unknown compiled test file: ${path}`);
      return compiled;
    });

// Only these tests intentionally load user-authored TypeScript at runtime.
// Keep tsx scoped to their worker group instead of paying its startup and
// transform cost in every one of the 277 test-file processes.
const tsxTests = new Set([
  ".test-dist/tests/flow.test.js",
  ".test-dist/tests/tsLoader.test.js",
]);

async function runGroup(files, execArgv = []) {
  if (files.length === 0) return 0;
  const child = spawn(
    process.execPath,
    [
      ...execArgv,
      ...nodeTestCliFlags({ concurrency, reporter, timeout, extra: nodeArgs }),
      ...files,
    ],
    {
      cwd: root,
      stdio: "inherit",
      // `node --test` starts worker descendants. A dedicated process group lets
      // Ctrl-C/termination reap the whole tree instead of orphaning workers.
      detached: process.platform !== "win32",
      env: testEnv({ HIVE_TEST_BUILT_CLI: "1" }),
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

const fastResult = await runGroup(selectedTests.filter((path) => !tsxTests.has(path)));
const tsxResult = await runGroup(selectedTests.filter((path) => tsxTests.has(path)), ["--import", "tsx"]);
process.exitCode = fastResult || tsxResult;
