import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRELOAD_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);
const PRELOAD_PREFIXES = ["--import=", "--require=", "--loader=", "--experimental-loader="];
const MODULE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

/**
 * Preserve only hooks needed to load a source TypeScript CLI. A daemon worker
 * must not inherit the embedding process's execution mode: under `node --test`
 * those flags describe the test worker, not the Hive child being launched.
 */
export function inheritableExecArgvForDaemonWorker(
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const inherited: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index]!;
    if (
      PRELOAD_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
      (arg.startsWith("-r") && arg !== "-r" && !arg.startsWith("--"))
    ) {
      inherited.push(arg);
      continue;
    }
    if (!PRELOAD_FLAGS.has(arg)) continue;
    const value = execArgv[index + 1];
    if (value === undefined) continue;
    inherited.push(arg, value);
    index += 1;
  }
  return inherited;
}

/**
 * Resolve Hive's CLI from the daemon module that owns the spawn.
 *
 * `process.argv[1]` belongs to the embedding executable. When a daemon module
 * is imported by a test, it is the test file; re-executing it recursively
 * forks the suite and eventually leaves broken stdout pipes. The module's own
 * location is stable in both source (`src/daemon/*.ts`) and builds
 * (`dist/daemon/*.js`), so the CLI is its sibling one directory up.
 */
export function daemonCliEntryForModule(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const extension = extname(modulePath);
  if (!MODULE_EXTENSIONS.has(extension)) {
    throw new Error(`cannot resolve daemon CLI entrypoint from ${modulePath}`);
  }
  return join(dirname(modulePath), "..", `cli${extension}`);
}

export function daemonWorkerArgv(command: string, moduleUrl: string): string[] {
  return [
    ...inheritableExecArgvForDaemonWorker(),
    daemonCliEntryForModule(moduleUrl),
    "daemon",
    command,
  ];
}
