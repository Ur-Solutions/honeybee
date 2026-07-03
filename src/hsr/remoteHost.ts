/**
 * HSR remote runner-host entry (APIA-90, Phase B) — the process that runs ON
 * THE REMOTE node. It is bundled by `buildRunnerHostBundle.ts` into a single
 * self-contained `.mjs` (no node_modules on the remote), deployed over ssh by
 * `hive node bootstrap`, and invoked there as:
 *
 *   node hive-runner-host-<version>.mjs --version          (the handshake target)
 *   node hive-runner-host-<version>.mjs serve --socket <p> (the control plane)
 *
 * APIA-90 scope is a DEPLOYABLE, HANDSHAKEABLE artifact plus a minimal serve
 * surface (`ping` + `liveness`). The full spawn/observe/steer surface that
 * mirrors the daemon aggregate endpoint (src/daemon/hsrControl.ts) — spawn,
 * send, interrupt, answer, stop, snapshot, observe-relay — lands in APIA-91/92;
 * see the marker in the method map below.
 *
 * Runs on the REMOTE's own `~/.hive` (its storeRoot), so `liveness()` reflects
 * HSR bees hosted on that node. Node builtins + the local HSR modules only —
 * everything is inlined at bundle time.
 */

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { startRpcServer, type RpcMethodHandler } from "./rpc.js";
import { hsrObservations } from "./observe.js";

// The package version this host was built from. Bundle-time esbuild `define`
// replaces __HIVE_RUNNER_HOST_VERSION__ with a string literal
// (`<pkgVersion>+<shortGitSha|nogit>`). Under a direct (unbundled) tsx run the
// identifier is absent — `typeof` on an undeclared name is safe and yields
// "undefined", so we fall back to computing it from package.json + git.
declare const __HIVE_RUNNER_HOST_VERSION__: string;
const PKG_VERSION = "0.0.1";

function injectedVersionCore(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof __HIVE_RUNNER_HOST_VERSION__ !== "undefined" && __HIVE_RUNNER_HOST_VERSION__) {
    return __HIVE_RUNNER_HOST_VERSION__;
  }
  return undefined;
}

/** `<pkgVersion>+<shortGitSha|nogit>`. Injected at bundle time; git-probed otherwise. */
export function versionCore(): string {
  const injected = injectedVersionCore();
  if (injected) return injected;
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
    // Not a git checkout (e.g. the bundle deployed to a bare remote) — nogit.
  }
  return `${PKG_VERSION}+${sha}`;
}

/** The full handshake string printed by `--version` and returned by `ping`. */
export function versionString(): string {
  return `runner-host ${versionCore()}`;
}

/** Build the serve method map. Exported so tests can drive it without a socket. */
export function buildMethods(): Record<string, RpcMethodHandler> {
  const version = versionString();
  return {
    // Handshake / health: cheap, side-effect-free, mirrors the --version target.
    ping: () => ({ ok: true, version }),

    // Read-only cross-process liveness of this node's HSR bees (run-dir based).
    liveness: async () => {
      const out: Record<string, boolean> = {};
      for (const [bee, observation] of await hsrObservations()) out[bee] = observation.live;
      return out;
    },

    // APIA-92: spawn/send/interrupt/answer/stop/snapshot/observe — mirror the
    // daemon aggregate endpoint (src/daemon/hsrControl.ts) over this socket, which
    // the local node then forwards over the ssh tunnel.
  };
}

/** Start the runner-host control socket. Returns the started RpcServer. */
export async function serve(socketPath: string): Promise<Awaited<ReturnType<typeof startRpcServer>>> {
  return startRpcServer({ socketPath, methods: buildMethods() });
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];

  if (cmd === "--version" || cmd === "version") {
    process.stdout.write(`${versionString()}\n`);
    return 0;
  }

  if (cmd === "serve") {
    // Parse `--socket <path>` (or `--socket=<path>`).
    let socketPath: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--socket") {
        socketPath = argv[++i];
      } else if (arg.startsWith("--socket=")) {
        socketPath = arg.slice("--socket=".length);
      }
    }
    if (!socketPath) {
      process.stderr.write("runner-host serve: --socket <path> is required\n");
      return 2;
    }
    const server = await serve(socketPath);
    process.stdout.write(`runner-host serving on ${server.path} (${versionString()})\n`);
    // Keep the process alive until signalled; close the socket cleanly on exit.
    const shutdown = (): void => {
      void server.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Never resolves — the server owns the event loop.
    return await new Promise<number>(() => {});
  }

  process.stderr.write(
    `runner-host: unknown command ${cmd ?? "(none)"}\n` +
      "usage: runner-host --version | serve --socket <path>\n",
  );
  return 2;
}

// Standalone-entry guard: run main() only when invoked directly (bundled .mjs or
// `tsx remoteHost.ts`), never on import (tests import versionString/buildMethods).
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // The ESM loader realpath-resolves import.meta.url (on macOS `/var` →
    // `/private/var`), but process.argv[1] is left as-invoked — so compare both
    // through realpath to avoid a symlink mismatch that would skip main().
    const self = fileURLToPath(import.meta.url);
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error) => {
      process.stderr.write(`runner-host: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
