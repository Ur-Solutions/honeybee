import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, ".test-dist", "test-files.json");
const testFiles = JSON.parse(await readFile(manifestPath, "utf8"));

if (!Array.isArray(testFiles) || testFiles.some((path) => typeof path !== "string" || !path.startsWith(".test-dist/tests/"))) {
  throw new Error(`invalid compiled-test manifest: ${manifestPath}`);
}

const concurrency = process.env.HIVE_TEST_CONCURRENCY?.trim() || "8";
const reporter = process.env.HIVE_TEST_REPORTER?.trim() || "dot";
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
      "--test",
      `--test-concurrency=${concurrency}`,
      `--test-reporter=${reporter}`,
      ...nodeArgs,
      ...files,
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, HIVE_TEST_BUILT_CLI: "1" },
    },
  );

  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTermination = () => child.kill("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  const result = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  process.removeListener("SIGINT", forwardInterrupt);
  process.removeListener("SIGTERM", forwardTermination);

  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  return result.code ?? 1;
}

const fastResult = await runGroup(selectedTests.filter((path) => !tsxTests.has(path)));
const tsxResult = await runGroup(selectedTests.filter((path) => tsxTests.has(path)), ["--import", "tsx"]);
process.exitCode = fastResult || tsxResult;
