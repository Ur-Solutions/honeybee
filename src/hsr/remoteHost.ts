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
import { realpathSync, existsSync, type Dirent } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import {
  connectRpcClient,
  startRpcServer,
  type RpcClient,
  type RpcMethodHandler,
  type RpcServer,
} from "./rpc.js";
import { hsrObservations, pendingNeedsInput } from "./observe.js";
import { readHsrMeta, hsrRunDir, worktreesRoot } from "./runDir.js";
import {
  homeDirForSpec,
  recordDeliveredCredentials,
  shredDeliveredCredentials,
  writeDeliveredCredentials,
  type DeliveredCredentials,
  type EphemeralCredentialFile,
} from "./remoteCreds.js";
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

/**
 * Validate the untyped `creds` RPC param into a DeliveredCredentials, dropping
 * malformed entries. Never throws and never logs the (opaque) credential bytes.
 */
function normalizeCreds(value: unknown): DeliveredCredentials | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as { files?: unknown; env?: unknown };
  const files: EphemeralCredentialFile[] = [];
  if (Array.isArray(object.files)) {
    for (const entry of object.files) {
      if (!entry || typeof entry !== "object") continue;
      const f = entry as Record<string, unknown>;
      if (typeof f.homeRelPath !== "string" || typeof f.contentB64 !== "string") continue;
      // Reject path escapes so a delivered file can never land outside the home.
      if (f.homeRelPath.startsWith("/") || f.homeRelPath.split("/").includes("..")) continue;
      files.push({
        homeRelPath: f.homeRelPath,
        contentB64: f.contentB64,
        mode: typeof f.mode === "number" ? f.mode : 0o600,
      });
    }
  }
  const env: Record<string, string> = {};
  if (object.env && typeof object.env === "object" && !Array.isArray(object.env)) {
    for (const [key, val] of Object.entries(object.env as Record<string, unknown>)) {
      if (typeof val === "string") env[key] = val;
    }
  }
  const hasEnv = Object.keys(env).length > 0;
  if (files.length === 0 && !hasEnv) return undefined;
  return { ...(files.length ? { files } : {}), ...(hasEnv ? { env } : {}) };
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

// ──────────────────────────────────────────────────────────────────────────
// Working-copy provisioning (APIA-95) — clone/enumerate git checkouts ON THE
// REMOTE under `<storeRoot>/worktrees/<name>`, so a bee can be spawned inside a
// fresh checkout of a repo/branch on the node. git is driven via child_process
// (present on any node that runs honeybee); no new deps, bundle stays inlinable.
//
// Groundwork for Apiary's "where-it-lives" selector on non-local substrates
// (substrates-research §5.3 / architecture §7.5): `provision` + `listCheckouts`
// are the substrate primitives that selector will drive — no Apiary work here.
// ──────────────────────────────────────────────────────────────────────────

/** Run git without throwing: resolves `{ ok, stdout, stderr, code }`. */
function runGit(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
        return;
      }
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolve({ ok: false, stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}

/** Normalize a git url for identity comparison (strip trailing `.git` / slashes). */
function normRepo(url: string): string {
  return url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
}

function sameRepo(a: string, b: string): boolean {
  return normRepo(a) === normRepo(b);
}

/** Derive a filesystem-safe checkout name from a repo url (last path segment, no `.git`). */
function slugForRepo(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/i, "").replace(/[/\\]+$/, "");
  const seg = trimmed.split(/[/:\\]/).filter(Boolean).pop() ?? "repo";
  const cleaned = seg.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "repo";
}

/**
 * Validate a checkout name can never escape the worktrees dir: a single path
 * segment, no `..`, no separators, no absolute/NUL. Returns null when invalid.
 */
function safeCheckoutName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith("/")) return null;
  return name;
}

/** Current branch of a checkout (`HEAD` when detached → undefined). Best-effort. */
async function currentBranch(path: string): Promise<string | undefined> {
  const res = await runGit(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!res.ok) return undefined;
  const branch = res.stdout.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}

type ProvisionParams = { repo?: unknown; branch?: unknown; name?: unknown; ref?: unknown };

/**
 * Clone (or idempotently reuse) a git checkout under `<storeRoot>/worktrees/<name>`.
 * Shallow (`--depth 1`) unless a `ref` needs history. Never throws — a git failure
 * (git missing, bad url, auth) surfaces as `{ ok:false, error }`.
 */
async function provisionCheckout(params: ProvisionParams): Promise<Record<string, unknown>> {
  const repo = typeof params.repo === "string" ? params.repo.trim() : "";
  if (!repo) return { ok: false, error: "repo required" };
  const branch = typeof params.branch === "string" && params.branch ? params.branch : undefined;
  const ref = typeof params.ref === "string" && params.ref ? params.ref : undefined;
  const rawName = typeof params.name === "string" && params.name.trim() ? params.name.trim() : slugForRepo(repo);
  const name = safeCheckoutName(rawName);
  if (!name) return { ok: false, error: `invalid checkout name: ${rawName}` };

  const root = worktreesRoot();
  const path = join(root, name);

  if (existsSync(path)) {
    // Reuse an existing checkout of the SAME repo (fetch + checkout); refuse to
    // clobber a directory that is not this repo's checkout.
    const inside = await runGit(["-C", path, "rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
      return { ok: false, error: `${path} exists but is not a git checkout` };
    }
    const originRes = await runGit(["-C", path, "remote", "get-url", "origin"]);
    const origin = originRes.stdout.trim();
    if (originRes.ok && origin && !sameRepo(origin, repo)) {
      return { ok: false, error: `${path} is a checkout of a different repo (${origin})` };
    }
    const fetchArgs = ref
      ? ["-C", path, "fetch", "origin"]
      : ["-C", path, "fetch", "--depth", "1", "origin", ...(branch ? [branch] : [])];
    const fetched = await runGit(fetchArgs);
    if (!fetched.ok) return { ok: false, error: `fetch failed: ${firstLine(fetched.stderr) || `git exited ${fetched.code}`}` };
    if (ref) {
      const co = await runGit(["-C", path, "checkout", ref]);
      if (!co.ok) return { ok: false, error: `checkout ${ref} failed: ${firstLine(co.stderr) || `git exited ${co.code}`}` };
    } else if (branch) {
      const co = await runGit(["-C", path, "checkout", branch]);
      if (!co.ok) return { ok: false, error: `checkout ${branch} failed: ${firstLine(co.stderr) || `git exited ${co.code}`}` };
      // Best-effort fast-forward to the freshly fetched tip.
      await runGit(["-C", path, "reset", "--hard", `origin/${branch}`]);
    }
    const resolvedBranch = branch ?? (await currentBranch(path));
    return { ok: true, path, repo, ...(resolvedBranch ? { branch: resolvedBranch } : {}), reused: true };
  }

  await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const cloneArgs = ["clone"];
  // Shallow by default; a pinned ref may need history, so clone full then check it out.
  if (!ref) cloneArgs.push("--depth", "1");
  if (branch) cloneArgs.push("--branch", branch);
  cloneArgs.push(repo, path);
  const cloned = await runGit(cloneArgs);
  if (!cloned.ok) {
    return { ok: false, error: `clone failed: ${firstLine(cloned.stderr) || firstLine(cloned.stdout) || `git exited ${cloned.code}`}` };
  }
  if (ref) {
    const co = await runGit(["-C", path, "checkout", ref]);
    if (!co.ok) return { ok: false, error: `checkout ${ref} failed: ${firstLine(co.stderr) || `git exited ${co.code}`}` };
  }
  const resolvedBranch = branch ?? (await currentBranch(path));
  return { ok: true, path, repo, ...(resolvedBranch ? { branch: resolvedBranch } : {}), reused: false };
}

/** Enumerate `<storeRoot>/worktrees/*` that are git checkouts. Best-effort; tolerates non-git dirs. */
async function enumerateCheckouts(): Promise<Array<Record<string, unknown>>> {
  const root = worktreesRoot();
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const inside = await runGit(["-C", path, "rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") continue; // tolerate a non-git dir
    const originRes = await runGit(["-C", path, "remote", "get-url", "origin"]);
    const branch = await currentBranch(path);
    const dirtyRes = await runGit(["-C", path, "status", "--porcelain"]);
    rows.push({
      name: entry.name,
      path,
      repo: originRes.ok && originRes.stdout.trim() ? originRes.stdout.trim() : null,
      branch: branch ?? null,
      ...(dirtyRes.ok ? { dirty: dirtyRes.stdout.trim().length > 0 } : {}),
    });
  }
  return rows;
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
        creds?: unknown;
        home?: unknown;
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

      // APIA-93 credential delivery: the ephemeral-token policy ships a SHORT-LIVED
      // credential (opaque, base64 in transit) that we write into this bee's
      // isolated home (0700 dir / 0600 files) BEFORE forking the runner, and
      // record so `kill` can shred it. The vault itself never reaches the remote.
      // Secrets are never logged — on failure we surface only a generic message.
      const creds = normalizeCreds(p.creds);
      let deliveredCredPaths: string[] = [];
      if (creds?.env) Object.assign(childEnv, creds.env);
      if (creds?.files?.length) {
        // The local side is authoritative about the isolated home; fall back to
        // the harness home env in the resolved spec if it did not thread one.
        const homeDir = (typeof p.home === "string" && p.home) ? p.home : homeDirForSpec(kind, childEnv);
        if (!homeDir) return { ok: false, error: `cannot deliver credentials: no isolated home resolved for harness "${kind}"` };
        try {
          deliveredCredPaths = await writeDeliveredCredentials(homeDir, creds);
          // Record BEFORE forking so a failed runner start still shreds the creds.
          await recordDeliveredCredentials(bee, deliveredCredPaths);
        } catch {
          await shredDeliveredCredentials(bee).catch(() => undefined);
          return { ok: false, error: "failed to write delivered credentials into the remote home" };
        }
      }
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
