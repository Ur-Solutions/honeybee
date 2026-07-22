/**
 * Runner-host bundle build (APIA-90, Phase B).
 *
 * Bundles `src/hsr/remoteHost.ts` (+ its local graph: rpc/observe/runDir/fsx —
 * all node builtins) into ONE self-contained ESM `.mjs` so the remote node needs
 * no node_modules, no tsx, no repo checkout — just a `node` runtime. esbuild is a
 * devDep and is imported dynamically (never at module load), so nothing here adds
 * a runtime dependency.
 *
 * The bundle is cached locally at
 *   ~/.hive/runner-host/hive-runner-host-<version>.mjs
 * keyed by `<pkgVersion>+<shortGitSha|nogit>`, and built ONCE per version — a
 * second call with the same version returns the cached path without re-bundling.
 * The version is frozen INTO the bundle via an esbuild `define`, so the deployed
 * artifact's `--version` handshake is deterministic regardless of the remote's
 * git state.
 */

import { execFileSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { storeRoot } from "../fsx.js";

const PKG_VERSION = "0.0.1";

/** `<pkgVersion>+<shortGitSha|nogit>` — the frozen identity of a built bundle. */
export function runnerHostVersionCore(): string {
  let sha = "nogit";
  try {
    const out = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (out) sha = out;
  } catch {
    // Not a git checkout — pin "nogit" so the version is still well-formed.
  }
  return `${PKG_VERSION}+${sha}`;
}

/** Local cache dir for built runner-host bundles: `~/.hive/runner-host`. */
export function runnerHostCacheDir(): string {
  return join(storeRoot(), "runner-host");
}

/** Cache path for a given version's bundle. */
export function runnerHostBundlePath(version: string): string {
  return join(runnerHostCacheDir(), `hive-runner-host-${version}.mjs`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export type RunnerHostBundle = { path: string; version: string };

/**
 * Ensure the runner-host bundle for the current version exists locally, building
 * it once and caching it. Returns its path + version. Idempotent per version.
 */
export async function ensureRunnerHostBundle(opts?: { force?: boolean }): Promise<RunnerHostBundle> {
  const version = runnerHostVersionCore();
  const outPath = runnerHostBundlePath(version);

  if (!opts?.force && (await fileExists(outPath))) {
    return { path: outPath, version };
  }

  await mkdir(runnerHostCacheDir(), { recursive: true, mode: 0o700 });

  // Dynamic import keeps esbuild a build-time-only devDep — importing at module
  // top-level would make every `hive` invocation fail where esbuild is absent.
  const esbuild = (await import("esbuild")) as typeof import("esbuild");
  // Under tsx/tests this module runs from src/ and the .ts sibling exists; from
  // the compiled dist/ it does not — bundle the compiled .js graph instead.
  const tsEntry = fileURLToPath(new URL("./remoteHost.ts", import.meta.url));
  const entry = (await fileExists(tsEntry))
    ? tsEntry
    : fileURLToPath(new URL("./remoteHost.js", import.meta.url));

  await esbuild.build({
    entryPoints: [entry],
    outfile: outPath,
    bundle: true,
    platform: "node",
    format: "esm",
    // Minimum supported node on the remote (bootstrap precheck requires >=18).
    target: "node18",
    minify: false,
    // Freeze the version into the artifact so its --version is deterministic and
    // independent of the remote's git state (which is usually absent).
    define: {
      __HIVE_RUNNER_HOST_VERSION__: JSON.stringify(version),
    },
    logLevel: "silent",
  });

  return { path: outPath, version };
}
