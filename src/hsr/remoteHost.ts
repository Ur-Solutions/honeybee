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
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  connectRpcClient,
  startRpcServer,
  type RpcClient,
  type RpcMethodHandler,
  type RpcServer,
} from "./rpc.js";
import { hsrObservations, pendingNeedsInput } from "./observe.js";
import { readHsrMeta, hsrRunDir } from "./runDir.js";
import { runHsrHost, type HsrHostHandle } from "./host.js";
import { adapterFor } from "./adapters/index.js";
import type { RunnerOpts } from "./types.js";

/** Signal-0 liveness probe; EPERM means the pid exists but isn't ours. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * The runner-host control-plane controller (APIA-92). Mirrors the daemon
 * aggregate endpoint (src/daemon/hsrControl.ts) — liveness/list/send/interrupt/
 * answer/stop/snapshot/observe-relay over THIS node's own run dirs + per-bee
 * control sockets — PLUS a `spawn` that forks a runner host IN-PROCESS on the
 * remote (the `hive __hsr-run` payload path, invoked here rather than shelled),
 * and a `kill` that stops a runner and removes its run dir.
 *
 * `attachServer` is called once the RpcServer exists so `observe` can broadcast
 * relayed `hsr.event` notifications; handlers run strictly after that, so the
 * late-bound reference is always defined by call time.
 */
export type RunnerHostController = {
  methods: Record<string, RpcMethodHandler>;
  attachServer(server: RpcServer): void;
  close(): Promise<void>;
};

export function buildController(): RunnerHostController {
  const version = versionString();

  // Live event relays, one cached client per observed bee (ref-counted across
  // subscribers) — mirrors hsrControl.ts. server is assigned by attachServer.
  type Relay = { client: RpcClient; refCount: number; unsubscribe: () => void };
  const relays = new Map<string, Relay>();
  // In-process runner hosts we spawned, so `kill` can stop them cleanly.
  const handles = new Map<string, HsrHostHandle>();
  let server: RpcServer | undefined;

  /**
   * Connect a bee's control socket, invoke one method, and close. Returns
   * `{ ok:true, result }` or `{ ok:false, error }`; never throws.
   */
  async function proxyCall(bee: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!bee) return { ok: false, error: "bee required" };
    const meta = await readHsrMeta(bee);
    if (!meta || meta.status !== "running" || !meta.controlSocket) {
      return { ok: false, error: `no live host for ${bee}` };
    }
    let client: RpcClient;
    try {
      client = await connectRpcClient(meta.controlSocket);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    try {
      const result = await client.call(method, params);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    } finally {
      client.close();
    }
  }

  /** Wrap a handler so it can never throw out to the transport. */
  function guarded(fn: (params: unknown) => Promise<unknown>): RpcMethodHandler {
    return async (params) => {
      try {
        return await fn(params);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    };
  }

  /** Stop a runner: prefer the in-process handle, else control-socket stop + SIGTERM fallback. */
  async function stopRunner(bee: string): Promise<void> {
    const handle = handles.get(bee);
    if (handle) {
      handles.delete(bee);
      await handle.stop().catch(() => undefined);
      return;
    }
    const meta = await readHsrMeta(bee);
    let stopped = false;
    if (meta?.controlSocket && meta.status === "running") {
      const result = await proxyCall(bee, "stop");
      if (result.ok) {
        const deadline = Date.now() + 2_500;
        while (Date.now() < deadline) {
          const m = await readHsrMeta(bee);
          if (!m || m.status !== "running" || !isPidAlive(m.hostPid)) {
            stopped = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
    if (!stopped && meta && meta.status === "running" && isPidAlive(meta.hostPid)) {
      try {
        process.kill(meta.hostPid, "SIGTERM");
      } catch {
        // already gone / not signalable
      }
    }
  }

  const methods: Record<string, RpcMethodHandler> = {
    // Handshake / health: cheap, side-effect-free, mirrors the --version target.
    ping: () => ({ ok: true, version }),

    // Read-only cross-process liveness of this node's HSR bees (run-dir based).
    liveness: guarded(async () => {
      const out: Record<string, boolean> = {};
      for (const [bee, observation] of await hsrObservations()) out[bee] = observation.live;
      return out;
    }),

    list: guarded(async () => {
      const observations = await hsrObservations();
      const rows: Array<Record<string, unknown>> = [];
      for (const [bee, observation] of observations) {
        const meta = await readHsrMeta(bee);
        rows.push({
          bee,
          live: observation.live,
          state: observation.state ?? null,
          tier: meta?.tier ?? null,
          sessionId: meta?.sessionId ?? null,
          status: meta?.status ?? null,
          controlSocket: meta?.controlSocket ?? null,
        });
      }
      return rows;
    }),

    // Fork a runner host IN-PROCESS from a resolved spec (the local side already
    // ran resolveAgent — no resolveAgent on the remote). Mirrors the body of
    // cli.ts runHsrHostFromPayload but invoked directly rather than via a
    // detached `hive __hsr-run` child.
    spawn: guarded(async (params) => {
      const p = (params ?? {}) as {
        bee?: unknown;
        kind?: unknown;
        cwd?: unknown;
        sessionId?: unknown;
        resume?: unknown;
        authKind?: unknown;
        model?: unknown;
        comb?: unknown;
        parent?: unknown;
        spec?: { command?: unknown; args?: unknown; env?: unknown };
      };
      const bee = String(p.bee ?? "");
      const kind = String(p.kind ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      if (!kind) return { ok: false, error: "kind required" };
      const adapter = adapterFor(kind);
      if (!adapter) return { ok: false, error: `no HSR adapter for harness "${kind}"` };
      const spec = p.spec ?? {};
      const command = typeof spec.command === "string" ? spec.command : "";
      const args = Array.isArray(spec.args) ? spec.args.map((a) => String(a)) : [];
      const specEnv = spec.env && typeof spec.env === "object" ? (spec.env as Record<string, string>) : {};
      // The harness child needs a complete env (PATH etc.), not just the spawn
      // overrides — overlay spec.env on the serve process's own env.
      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") childEnv[key] = value;
      }
      Object.assign(childEnv, specEnv);
      childEnv.HIVE_BEE = bee;
      childEnv.HIVE_COMB = typeof p.comb === "string" && p.comb ? p.comb : bee;
      if (typeof p.parent === "string" && p.parent) childEnv.HIVE_PARENT = p.parent;
      const opts: RunnerOpts = {
        bee,
        cwd: typeof p.cwd === "string" && p.cwd ? p.cwd : process.cwd(),
        env: childEnv,
        ...(typeof p.sessionId === "string" && p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(typeof p.authKind === "string" ? { authKind: p.authKind as "subscription" | "api-key" } : {}),
        ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
        ...(p.resume === true ? { resume: true } : {}),
        command,
        args,
        runDir: hsrRunDir(bee),
      };
      const handle = await runHsrHost({ bee, adapter, opts });
      handles.set(bee, handle);
      // Drop the handle once the session exits so `kill` doesn't retain a dead one.
      void handle.done.then(() => {
        if (handles.get(bee) === handle) handles.delete(bee);
      });
      return { ok: true, bee, tier: adapter.tier() };
    }),

    send: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; text?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "send", { text: String(p.text ?? "") });
      return result.ok ? { ok: true } : result;
    }),

    interrupt: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "interrupt");
      return result.ok ? { ok: true } : result;
    }),

    answer: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; requestId?: unknown; answer?: unknown };
      const bee = String(p.bee ?? "");
      let requestId = typeof p.requestId === "string" && p.requestId ? p.requestId : undefined;
      if (!requestId) {
        const pending = await pendingNeedsInput(bee).catch(() => null);
        requestId = pending?.requestId;
      }
      const result = await proxyCall(bee, "answer", { requestId: requestId ?? "", answer: String(p.answer ?? "") });
      return result.ok ? { ok: true } : result;
    }),

    stop: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "stop");
      return result.ok ? { ok: true, result: result.result } : result;
    }),

    snapshot: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; lines?: unknown };
      const args = typeof p.lines === "number" ? { lines: p.lines } : {};
      return await proxyCall(String(p.bee ?? ""), "snapshot", args);
    }),

    // Establish (or ref-count into) a relay of the bee's live event stream. Each
    // `event` the bee's control socket pushes is re-broadcast to ALL clients as
    // `hsr.event` { bee, event } — the local transport re-emits it upward.
    observe: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const existing = relays.get(bee);
      if (existing) {
        existing.refCount += 1;
        return { ok: true };
      }
      const meta = await readHsrMeta(bee);
      if (!meta || meta.status !== "running" || !meta.controlSocket) {
        return { ok: false, error: `no live host for ${bee}` };
      }
      let client: RpcClient;
      try {
        client = await connectRpcClient(meta.controlSocket);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const unsubscribe = client.on("event", (event) => {
        try {
          server?.broadcast("hsr.event", { bee, event });
        } catch {
          // A closing socket must not wedge the relay pump.
        }
      });
      relays.set(bee, { client, refCount: 1, unsubscribe });
      void client.closed.then(() => {
        const relay = relays.get(bee);
        if (relay && relay.client === client) relays.delete(bee);
      });
      return { ok: true };
    }),

    // Stop the runner (control-socket stop + fallback) and remove its run dir.
    // The LOCAL side keeps the SessionRecord — this only reclaims remote state.
    kill: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const relay = relays.get(bee);
      if (relay) {
        try {
          relay.unsubscribe();
          relay.client.close();
        } catch {
          // best-effort
        }
        relays.delete(bee);
      }
      await stopRunner(bee);
      await rm(hsrRunDir(bee), { recursive: true, force: true }).catch(() => undefined);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }),
  };

  return {
    methods,
    attachServer(s: RpcServer): void {
      server = s;
    },
    async close(): Promise<void> {
      for (const relay of relays.values()) {
        try {
          relay.unsubscribe();
          relay.client.close();
        } catch {
          // best-effort teardown
        }
      }
      relays.clear();
      for (const handle of handles.values()) {
        await handle.stop().catch(() => undefined);
      }
      handles.clear();
    },
  };
}

/** Start the runner-host control socket. Returns an RpcServer whose close also tears down the controller. */
export async function serve(socketPath: string): Promise<RpcServer> {
  const controller = buildController();
  const server = await startRpcServer({ socketPath, methods: controller.methods });
  controller.attachServer(server);
  return {
    path: server.path,
    broadcast: (method, params) => server.broadcast(method, params),
    connectionCount: () => server.connectionCount(),
    async close(): Promise<void> {
      await controller.close();
      await server.close();
    },
  };
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
