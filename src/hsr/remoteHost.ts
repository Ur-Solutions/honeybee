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
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultIsPidAlive as isPidAlive } from "../fsx.js";
// homeEnvForAgent maps a harness kind → its home env var (CODEX_HOME /
// CLAUDE_CONFIG_DIR / …). drivers.js is already in the runner-host bundle closure
// (via remoteCreds' homeDirForSpec) and imports NO accounts/vault graph, so this
// keeps the esbuild DCE lean.
import { homeEnvForAgent } from "../drivers.js";
import {
  connectRpcClient,
  startRpcServer,
  type RpcClient,
  type RpcMethodHandler,
  type RpcServer,
} from "./rpc.js";
import { hsrObservations, killOrphanedChildGroup, pendingNeedsInput, reapDeadHosts } from "./observe.js";
import { readHsrMeta, hsrRunDir, readHsrRestart, writeHsrRestart } from "./runDir.js";
import {
  recordDeliveredCredentials,
  shredDeliveredCredentials,
  writeDeliveredCredentials,
} from "./remoteCreds.js";
import { runHsrHost, type HsrHostHandle } from "./host.js";
import { adapterFor } from "./adapters/index.js";
import { harnessSupportsRemoteHsr } from "./harness.js";
import { normalizeCreds } from "./credsParams.js";
import { provisionCheckout, enumerateCheckouts, type ProvisionParams } from "./provisioning.js";
import type { RunnerOpts, RunnerTier } from "./types.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Secret-free policy failure used by both the RPC path and hermetic tests. */
export function remoteHarnessPolicyError(kind: string): string | undefined {
  return harnessSupportsRemoteHsr(kind)
    ? undefined
    : `${kind} HSR is local-only: remote credential delivery is not implemented or tested`;
}

/**
 * Resolve a remote-hsr spawn's working dir. The remote runner-host OWNS its
 * filesystem layout: a client only ships a cwd when it is already a real REMOTE
 * path (a provisioned checkout, APIA-95) — otherwise a local `/Users/…` path
 * would not exist here and Node's `spawn()` throws ENOENT. When none is given we
 * DERIVE a per-bee dir under this node's own store (`<storeRoot>/hsr/<bee>/cwd`),
 * nested under the run dir so `kill`'s run-dir removal reclaims it. `derived`
 * flags whether the caller must mkdir it.
 */
export function resolveRemoteSpawnCwd(bee: string, cwd: unknown): { cwd: string; derived: boolean } {
  if (typeof cwd === "string" && cwd) return { cwd, derived: false };
  return { cwd: join(hsrRunDir(bee), "cwd"), derived: true };
}

/**
 * Resolve the isolated home + its harness env for a credential-delivering
 * remote-hsr spawn. The remote DERIVES the home under its own store
 * (`<storeRoot>/hsr/<bee>/home`) — a local home path shipped from the client is
 * meaningless here (the vault stays local; only the ephemeral material crosses).
 * An explicit REMOTE `home` is honored as-is. `homeEnv` is the harness's home
 * env var (CODEX_HOME / CLAUDE_CONFIG_DIR / …) the child must read the delivered
 * auth from; undefined for a harness with no home env (e.g. the test stub).
 */
export function resolveRemoteSpawnHome(bee: string, kind: string, home: unknown): { homeDir: string; homeEnv: string | undefined } {
  const homeDir = (typeof home === "string" && home) ? home : join(hsrRunDir(bee), "home");
  return { homeDir, homeEnv: homeEnvForAgent(kind) };
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
  // Bees currently mid-refresh (UNIT 2), so a re-entrant refreshCreds is refused
  // rather than racing a second stop→re-deliver→restart against the first.
  const refreshing = new Set<string>();
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
    if (!stopped && meta && meta.status === "running") {
      if (isPidAlive(meta.hostPid)) {
        try {
          process.kill(meta.hostPid, "SIGTERM");
        } catch {
          // already gone / not signalable
        }
      } else {
        // The host died without finalize (a previous serve was SIGKILLed/OOMed:
        // its in-process runners carried the serve's pid as hostPid), so the
        // harness child group is orphaned and unreachable over any control
        // socket. Signal the recorded child group directly (HIVE-53).
        await killOrphanedChildGroup(meta);
      }
    }
  }

  type SpawnLikeParams = {
    bee?: unknown;
    kind?: unknown;
    cwd?: unknown;
    sessionId?: unknown;
    resume?: unknown;
    authKind?: unknown;
    model?: unknown;
    comb?: unknown;
    parent?: unknown;
    creds?: unknown;
    home?: unknown;
    spec?: { command?: unknown; args?: unknown; env?: unknown };
  };

  type StartResult = { ok: boolean; bee?: string; tier?: RunnerTier; cwd?: string; sessionId?: string; error?: string };

  /**
   * Fork a runner host IN-PROCESS from a resolved spec (the local side already ran
   * resolveAgent — no resolveAgent here). Shared by `spawn` (fresh) and
   * `refreshCreds` (restart with resume, UNIT 2). `override.resume` / `.sessionId`
   * let the refresh path force a resume onto the bee's learned thread id. Persists
   * a restart descriptor (no creds) so a later refresh can restart faithfully.
   * May throw (runner never started) — the caller's `guarded` maps that to error.
   */
  async function startRunner(params: unknown, override: { resume?: boolean; sessionId?: string } = {}): Promise<StartResult> {
    const p = (params ?? {}) as SpawnLikeParams;
    const bee = String(p.bee ?? "");
    const kind = String(p.kind ?? "");
    if (!bee) return { ok: false, error: "bee required" };
    if (!kind) return { ok: false, error: "kind required" };
    const policyError = remoteHarnessPolicyError(kind);
    if (policyError) return { ok: false, error: policyError };
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

    // Resolve the working dir the remote OWNS (derive per-bee under this store
    // unless the client shipped a real remote checkout path). A local client cwd
    // would not exist here → Node spawn() ENOENT (the bug this fixes).
    const { cwd: cwdDir, derived: cwdDerived } = resolveRemoteSpawnCwd(bee, p.cwd);
    if (cwdDerived) {
      try {
        await mkdir(cwdDir, { recursive: true, mode: 0o700 });
      } catch {
        return { ok: false, error: `could not create the remote working dir for ${bee}` };
      }
    }

    // APIA-93 credential delivery: the ephemeral-token policy ships a SHORT-LIVED
    // credential (opaque, base64 in transit) that we write into this bee's
    // isolated home (0700 dir / 0600 files) BEFORE forking the runner, and record
    // so `kill` (and the next refresh) can shred it. The vault never reaches the
    // remote. Secrets are never logged.
    const creds = normalizeCreds(p.creds);
    let deliveredCredPaths: string[] = [];
    if (creds?.env) Object.assign(childEnv, creds.env);
    let homeDirResolved: string | undefined;
    if (creds?.files?.length) {
      const { homeDir, homeEnv } = resolveRemoteSpawnHome(bee, kind, p.home);
      homeDirResolved = homeDir;
      try {
        deliveredCredPaths = await writeDeliveredCredentials(homeDir, creds);
        // Record BEFORE forking so a failed runner start still shreds the creds.
        await recordDeliveredCredentials(bee, deliveredCredPaths);
      } catch {
        await shredDeliveredCredentials(bee).catch(() => undefined);
        return { ok: false, error: "failed to write delivered credentials into the remote home" };
      }
      if (homeEnv) childEnv[homeEnv] = homeDir;
    }

    const resume = override.resume ?? p.resume === true;
    const sessionId =
      typeof override.sessionId === "string" && override.sessionId
        ? override.sessionId
        : typeof p.sessionId === "string" && p.sessionId
          ? p.sessionId
          : undefined;

    const opts: RunnerOpts = {
      bee,
      cwd: cwdDir,
      env: childEnv,
      ...(sessionId ? { sessionId } : {}),
      ...(typeof p.authKind === "string" ? { authKind: p.authKind as "subscription" | "api-key" } : {}),
      ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
      ...(resume ? { resume: true } : {}),
      command,
      args,
      runDir: hsrRunDir(bee),
    };

    // Persist a restart descriptor (spec + resolved cwd/home, NO creds and NO
    // process.env) so a later `refreshCreds` restarts this runner faithfully with
    // resume (UNIT 2). Best-effort: a failed write only degrades refresh, not spawn.
    await writeHsrRestart(bee, {
      kind,
      command,
      args,
      env: specEnv,
      cwd: cwdDir,
      ...(homeDirResolved
        ? { home: homeDirResolved }
        : typeof p.home === "string" && p.home
          ? { home: p.home }
          : {}),
      ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
      ...(typeof p.authKind === "string" ? { authKind: p.authKind as "subscription" | "api-key" } : {}),
      ...(typeof p.comb === "string" && p.comb ? { comb: p.comb } : {}),
      ...(typeof p.parent === "string" && p.parent ? { parent: p.parent } : {}),
    }).catch(() => undefined);

    let handle: HsrHostHandle;
    try {
      handle = await runHsrHost({ bee, adapter, opts });
    } catch (error) {
      // Runner never started — do not leave the delivered credential on disk.
      if (deliveredCredPaths.length > 0) await shredDeliveredCredentials(bee).catch(() => undefined);
      throw error;
    }
    handles.set(bee, handle);
    // Drop the handle once the session exits so `kill` doesn't retain a dead one.
    void handle.done.then(() => {
      if (handles.get(bee) === handle) handles.delete(bee);
    });
    // Echo the resolved remote cwd back so the local SessionRecord stores a real
    // remote path (the derived per-bee dir, or the checkout the client sent).
    return { ok: true, bee, tier: adapter.tier(), cwd: cwdDir, ...(sessionId ? { sessionId } : {}) };
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
    // ran resolveAgent — no resolveAgent on the remote). Delegates to startRunner
    // (shared with refreshCreds); guarded maps a thrown runner-start to error.
    spawn: guarded((params) => startRunner(params)),

    // UNIT 2 token refresh: re-deliver a FRESH access-token credential to a live
    // bee and get the harness to adopt it. A running codex app-server holds the
    // access token in memory and won't pick up a hot-swapped auth.json (on 401 it
    // reads the BLANKED refresh_token and dies), so adoption REQUIRES a restart:
    // stop the runner (keeping the run dir), shred the OLD credential, write the
    // NEW one into the bee's home, then restart the SAME runner with resume + the
    // learned thread id so codex re-reads auth.json at boot and resumes the thread.
    // Atomic per bee (a re-entrant refresh is refused). The daemon side mints; the
    // vault never reaches the remote.
    refreshCreds: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; creds?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const creds = normalizeCreds(p.creds);
      if (!creds?.files?.length) return { ok: false, error: "refreshCreds requires credential files" };
      if (refreshing.has(bee)) return { ok: false, error: `refresh already in flight for ${bee}` };
      const descriptor = await readHsrRestart(bee);
      if (!descriptor) return { ok: false, error: `no restart descriptor for ${bee} (spawned before refresh support?)` };
      // The learned provider session id (codex thread id) lives in THIS node's
      // meta — read it before stopping so the restart can resume the same thread.
      const meta = await readHsrMeta(bee);
      const sessionId = meta?.sessionId;
      if (!sessionId) return { ok: false, error: `no learned session id for ${bee}; cannot resume` };
      refreshing.add(bee);
      try {
        // Stop the current runner but KEEP the run dir (meta / descriptor / events).
        await stopRunner(bee);
        // Destroy the OLD delivered credential BEFORE writing the fresh one, so the
        // dead access token never lingers on the remote.
        await shredDeliveredCredentials(bee).catch(() => undefined);
        const result = await startRunner(
          {
            bee,
            kind: descriptor.kind,
            spec: { command: descriptor.command, args: descriptor.args, env: descriptor.env },
            cwd: descriptor.cwd,
            ...(descriptor.home ? { home: descriptor.home } : {}),
            ...(descriptor.model ? { model: descriptor.model } : {}),
            ...(descriptor.authKind ? { authKind: descriptor.authKind } : {}),
            ...(descriptor.comb ? { comb: descriptor.comb } : {}),
            ...(descriptor.parent ? { parent: descriptor.parent } : {}),
            creds,
          },
          { resume: true, sessionId },
        );
        if (!result.ok) return result;
        return { ok: true, bee, sessionId: result.sessionId ?? sessionId };
      } finally {
        refreshing.delete(bee);
      }
    }),

    send: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; text?: unknown; mode?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "send", {
        text: String(p.text ?? ""),
        ...(p.mode === "next-tool" ? { mode: "next-tool" } : {}),
      });
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
      const answer = Array.isArray(p.answer) ? p.answer : String(p.answer ?? "");
      const result = await proxyCall(bee, "answer", { requestId: requestId ?? "", answer });
      return result.ok ? { ok: true } : result;
    }),

    pendingInput: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      return pendingNeedsInput(String(p.bee ?? ""));
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
    // `sync` (reconnect reconciliation, HIVE-56): instead of incrementing, SET
    // the refcount to the caller's subscriber count — a re-issued observe after
    // a tunnel flap must not inflate the count past what unobserve will return.
    observe: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; sync?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const sync = typeof p.sync === "number" && Number.isFinite(p.sync) ? Math.max(1, Math.floor(p.sync)) : undefined;
      const existing = relays.get(bee);
      if (existing) {
        existing.refCount = sync ?? existing.refCount + 1;
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
      relays.set(bee, { client, refCount: sync ?? 1, unsubscribe });
      void client.closed.then(() => {
        const relay = relays.get(bee);
        if (relay && relay.client === client) relays.delete(bee);
      });
      return { ok: true };
    }),

    // Release a relay subscription (HIVE-56): decrement the refcount by `count`
    // (default 1) and close the per-bee control-socket client once it hits zero.
    // Idempotent — a relay already gone (bee killed, client.closed pruned it)
    // is a success, so teardown/unsubscribe races never surface errors.
    unobserve: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; count?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const count = typeof p.count === "number" && Number.isFinite(p.count) ? Math.max(1, Math.floor(p.count)) : 1;
      const relay = relays.get(bee);
      if (!relay) return { ok: true };
      relay.refCount -= count;
      if (relay.refCount > 0) return { ok: true };
      relays.delete(bee);
      try {
        relay.unsubscribe();
        relay.client.close();
      } catch {
        // best-effort teardown
      }
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
      // APIA-93: destroy any ephemeral credential delivered into the remote home
      // BEFORE removing the run dir (which holds the delivered-paths record), so
      // nothing persists remotely once the bee is gone. Best-effort shred.
      await shredDeliveredCredentials(bee).catch(() => undefined);
      await rm(hsrRunDir(bee), { recursive: true, force: true }).catch(() => undefined);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }),

    // APIA-95 working-copy provisioning: clone (or idempotently reuse) a git
    // checkout under this node's `<storeRoot>/worktrees/<name>` so a spawn can run
    // the bee inside a fresh checkout of a repo/branch. Never throws (git failures
    // surface as { ok:false, error }). Groundwork for Apiary's "where-it-lives"
    // selector on non-local substrates (substrates-research §5.3 / arch §7.5).
    provision: guarded((params) => provisionCheckout((params ?? {}) as ProvisionParams)),

    // Enumerate this node's existing checkouts (best-effort; tolerates non-git dirs).
    listCheckouts: guarded(() => enumerateCheckouts()),
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
  // Startup reaper (HIVE-53): a previous serve that died without finalize
  // (SIGKILL/OOM) left its in-process runners' meta "running" with hostPid =
  // the dead serve's pid and their detached harness children orphaned. Adopt
  // them before accepting control traffic: kill the orphaned child groups and
  // flip their meta so the control plane restarts from a truthful view.
  await reapDeadHosts().catch(() => undefined);
  const controller = buildController();
  const server = await startRpcServer({ socketPath, methods: controller.methods });
  controller.attachServer(server);
  return {
    path: server.path,
    broadcast: (method, params) => server.broadcast(method, params),
    connectionCount: () => server.connectionCount(),
    broadcastDroppedCount: () => server.broadcastDroppedCount(),
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
