#!/usr/bin/env node
/**
 * Minimal detached HSR child entry. This module owns only payload hydration and
 * the runner-host lifecycle; parent-side spawning stays in runnerHost.ts.
 */

import { execFile } from "node:child_process";
import { constants, existsSync, realpathSync } from "node:fs";
import { lstat, open, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadAdapterFor } from "./adapter-loader.js";
import {
  initializeCellSandbox,
  shutdownCellSandbox,
  withoutAmbientProviderState,
} from "./cellSandbox.js";
import { runHsrHost } from "./host.js";
import { hsrRunDir, type HsrStartupFailure } from "./runDir.js";
import type { RunnerOpts } from "./types.js";

/** The JSON payload handed to a detached local HSR host. */
export type HsrRunPayload = {
  bee: string;
  kind: string;
  cwd: string;
  sessionId?: string;
  authKind?: "subscription" | "api-key";
  accountId?: string;
  model?: string;
  /** Trusted execution-protocol filesystem boundary. */
  filesystemWriteScope?: "cwd";
  /**
   * Extra allow-listed sandbox write roots (`hive spawn --sandbox-write`) —
   * Apiary Cell Layout v2 wrapper dirs. Additive and only meaningful together
   * with filesystemWriteScope: an unsandboxed runner ignores them.
   */
  extraWriteRoots?: string[];
  /** Resume an existing provider session instead of starting fresh. */
  resume?: boolean;
  /** Lineage for HIVE_COMB/HIVE_PARENT env stamping (APIA-82). */
  comb?: string;
  parent?: string;
  spec: { command: string; args: string[]; env: Record<string, string> };
};

function payloadStrings(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.length > 0) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) payloadStrings(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) payloadStrings(item, found);
  }
  return found;
}

/** Strip every payload-derived string from an error before it crosses a process boundary. */
export function redactHsrPayloadError(error: unknown, payload: HsrRunPayload): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [...payloadStrings(payload)].sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(value, "[redacted]");
  }
  return new Error(message || "HSR runner startup failed");
}

/** Build the safe, actionable startup cause published to the spawning parent. */
export function hsrStartupFailureForPayload(error: unknown, payload: HsrRunPayload): HsrStartupFailure {
  const rawCode = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(rawCode)
    ? rawCode
    : undefined;
  if (code === "ENOENT") {
    return {
      stage: "adapter-start",
      code,
      message: existsSync(payload.cwd)
        ? "HSR harness executable could not be started"
        : "HSR working directory disappeared during harness startup",
    };
  }
  return {
    stage: "adapter-start",
    ...(code ? { code } : {}),
    message: code
      ? `HSR harness failed during startup (${code}); inspect host.log for provider diagnostics`
      : "HSR harness failed during startup; inspect host.log for provider diagnostics",
  };
}

/**
 * Space-directory shape shared by both Apiary Cell layouts: kaia allocates
 * `<repo>-space-<id>` (Layout v1 as the Cell cwd itself, Layout v2 as the
 * checkout inside the wrapper). Mirrors Apiary's CELL_DIRECTORY_PATTERN.
 */
const CELL_SPACE_DIRECTORY = /^[a-z0-9][a-z0-9-]*-space-[a-z0-9]+$/;

/** Best-effort space identity for a Cell cwd: the space directory's name. */
export function cellSpaceKeyForCwd(cwd: string): string | undefined {
  const resolved = resolve(cwd);
  for (const candidate of [basename(resolved), basename(dirname(resolved))]) {
    if (CELL_SPACE_DIRECTORY.test(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Stamp (or scrub) the managed-Cell env markers on a child env, in place.
 * HIVE_CELL=1 lets in-cell tools — the hive CLI first — detect containment
 * and route store-mutating verbs over the daemon socket instead of hitting
 * sandbox write denials; HIVE_CELL_SPACE names the space when the cwd reveals
 * it. A non-Cell spawn must never inherit another Cell's stamps from the
 * ambient host environment, so the else-branch deletes rather than ignores.
 */
export function applyCellEnvironmentStamp(
  env: Record<string, string>,
  payload: Pick<HsrRunPayload, "filesystemWriteScope" | "cwd">,
): void {
  if (payload.filesystemWriteScope === "cwd") {
    env.HIVE_CELL = "1";
    const spaceKey = cellSpaceKeyForCwd(payload.cwd);
    if (spaceKey) env.HIVE_CELL_SPACE = spaceKey;
    else delete env.HIVE_CELL_SPACE;
  } else {
    delete env.HIVE_CELL;
    delete env.HIVE_CELL_SPACE;
  }
}

/**
 * Stamp the operator's GitHub credential into a managed Cell.
 *
 * gh inside a Cell resolves its config from the bee's HOME (the per-account
 * hive home), which holds no gh session — bees were observed ssh-hopping to
 * other machines just to reach an authenticated gh. gh accepts a token by
 * env, so borrow the HOST session's token (`gh auth token` under the
 * operator HOME) and stamp GH_TOKEN. This is the LOCAL trust model only
 * (Cells are anti-footgun containment); cloud Cells mint short-lived
 * repo-scoped GitHub App installation tokens instead. Fail-soft throughout:
 * no gh on PATH, no session, or a slow probe leaves the env unstamped and gh
 * degrades to its normal unauthenticated errors. HIVE_CELL_GH=0 in the host
 * env opts out; an explicit GH_TOKEN/GITHUB_TOKEN in the spawn env wins.
 */
export async function applyCellGithubCredential(
  env: Record<string, string>,
  payload: Pick<HsrRunPayload, "filesystemWriteScope">,
  resolveToken: () => Promise<string> = hostGithubSessionToken,
): Promise<void> {
  if (payload.filesystemWriteScope !== "cwd") return;
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return;
  if (process.env.HIVE_CELL_GH === "0") return;
  try {
    const token = (await resolveToken()).trim();
    // A credential is a single opaque line; anything else is not a token.
    if (token.length === 0 || /[\s\u0000-\u001f\u007f]/.test(token)) return;
    env.GH_TOKEN = token;
  } catch {
    // Fail-soft by design: an unauthenticated Cell is degraded, not broken.
  }
}

function hostGithubSessionToken(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "gh",
      ["auth", "token"],
      // The HOST environment on purpose: the operator HOME owns the gh
      // session; the bee env points HOME at a hive home with no session.
      { timeout: 3000, env: process.env, encoding: "utf8" },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout);
      },
    );
  });
}

async function validatedHsrPayloadPath(payloadPath: string): Promise<{ payloadPath: string; dir: string }> {
  if (basename(payloadPath) !== "payload.json") throw new Error("invalid HSR payload handoff path");
  const rawDir = dirname(resolve(payloadPath));
  const [realTmp, realDir, dirStat, payloadStat] = await Promise.all([
    realpath(tmpdir()),
    realpath(rawDir),
    lstat(rawDir),
    lstat(payloadPath),
  ]).catch(() => { throw new Error("invalid HSR payload handoff path"); });
  const owns = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();
  if (
    dirname(realDir) !== realTmp ||
    !basename(realDir).startsWith("hive-hsr-payload-") ||
    !dirStat.isDirectory() || dirStat.isSymbolicLink() || !owns(dirStat.uid) || (dirStat.mode & 0o077) !== 0 ||
    !payloadStat.isFile() || payloadStat.isSymbolicLink() || !owns(payloadStat.uid) || (payloadStat.mode & 0o077) !== 0 ||
    await realpath(payloadPath) !== join(realDir, "payload.json")
  ) {
    throw new Error("invalid HSR payload handoff path");
  }
  return { payloadPath: join(realDir, "payload.json"), dir: realDir };
}

/**
 * Consume the private launch capability before any harness/provider await.
 * Keeping the descriptor open while unlinking makes the exact bytes we read
 * independent of the pathname; removing the now-empty directory closes the
 * durable secret-retention window even when parsing or startup later fails.
 */
export async function consumeHsrRunPayload(payloadPath: string): Promise<HsrRunPayload> {
  // __hsr-run is operator-callable. Validate the exact parent-created handoff
  // before any cleanup so an arbitrary `.../payload.json` can never authorize
  // unlinking a user file or removing its directory.
  const validated = await validatedHsrPayloadPath(payloadPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let raw: string;
  try {
    handle = await open(validated.payloadPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    raw = await handle.readFile("utf8");
    await unlink(validated.payloadPath);
    await handle.close();
    handle = undefined;
    await rmdir(validated.dir);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(validated.payloadPath).catch(() => undefined);
    await rmdir(validated.dir).catch(() => undefined);
    throw new Error("hive __hsr-run: unable to securely consume payload");
  }
  try {
    return JSON.parse(raw) as HsrRunPayload;
  } catch {
    // JSON parser diagnostics can quote source fragments. Never let bytes from
    // a credential-bearing payload reach stderr or a parent error result.
    throw new Error("hive __hsr-run: invalid payload JSON");
  }
}

export type StartHsrHostFromPayloadDependencies = {
  loadAdapter?: typeof loadAdapterFor;
  runHost?: typeof runHsrHost;
};

/** Consume and start one host, separated from process-exit ownership for tests. */
export async function startHsrHostFromPayload(
  payloadPath: string | undefined,
  dependencies: StartHsrHostFromPayloadDependencies = {},
) {
  if (!payloadPath) throw new Error("hive __hsr-run: missing payload path");
  const payload = await consumeHsrRunPayload(payloadPath);
  try {
    return await startConsumedHsrPayload(payload, dependencies);
  } catch (error) {
    throw redactHsrPayloadError(error, payload);
  }
}

async function startConsumedHsrPayload(
  payload: HsrRunPayload,
  dependencies: StartHsrHostFromPayloadDependencies,
) {
  const adapter = await (dependencies.loadAdapter ?? loadAdapterFor)(payload.kind);
  if (!adapter) throw new Error("hive __hsr-run: no HSR adapter for requested harness");
  return hydrateAndStartConsumedPayload(payload, adapter, dependencies.runHost ?? runHsrHost);
}

/**
 * Read a payload, load its one harness adapter, and live exactly as long as the
 * provider session. Also exported through runnerHost.ts for the __hsr-run CLI
 * compatibility path.
 */
export async function runHsrHostFromPayload(payloadPath: string | undefined): Promise<void> {
  let handle;
  try {
    handle = await startHsrHostFromPayload(payloadPath);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "hive __hsr-run: startup failed"}\n`);
    process.exit(1);
  }
  if (!handle) return;
  const payload = handle.payload;
  const host = handle.host;
  const shutdown = async (): Promise<void> => {
    try {
      await host.stop();
    } catch {
      // best-effort; we're exiting regardless
    }
    shutdownCellSandbox();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await host.done;
  shutdownCellSandbox();
  process.exit(0);
}

async function hydrateAndStartConsumedPayload(
  payload: HsrRunPayload,
  adapter: NonNullable<Awaited<ReturnType<typeof loadAdapterFor>>>,
  runHost: typeof runHsrHost,
) {
  if (payload.filesystemWriteScope === "cwd") {
    // This detached process belongs to one execution Cell. Align process.cwd
    // before Sandbox Runtime discovers repository-local mandatory denies; the
    // provider child receives the same absolute cwd below.
    process.chdir(realpathSync(payload.cwd));
  }
  // The harness child needs a complete env (PATH etc.), not just the spawn
  // overrides. Overlay the payload's resolved spec on the inherited host env.
  let childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") childEnv[key] = value;
  }
  if (payload.filesystemWriteScope === "cwd") {
    childEnv = withoutAmbientProviderState(payload.kind, childEnv, payload.spec.env);
  }
  Object.assign(childEnv, payload.spec.env);
  // HSR children have no pane, so HIVE_BEE is the pane-less identity anchor.
  childEnv.HIVE_BEE = payload.bee;
  childEnv.HIVE_COMB = payload.comb ?? payload.bee;
  if (payload.parent) childEnv.HIVE_PARENT = payload.parent;
  applyCellEnvironmentStamp(childEnv, payload);
  await applyCellGithubCredential(childEnv, payload);
  let cellSandbox: RunnerOpts["cellSandbox"];
  if (payload.filesystemWriteScope === "cwd") {
    const initialized = initializeCellSandbox({
      kind: payload.kind,
      cwd: payload.cwd,
      runDir: hsrRunDir(payload.bee),
      env: childEnv,
      ...(payload.extraWriteRoots?.length ? { extraWriteRoots: payload.extraWriteRoots } : {}),
    });
    childEnv = initialized.env;
    cellSandbox = initialized.backend;
  }
  const opts: RunnerOpts = {
    bee: payload.bee,
    cwd: payload.cwd,
    env: childEnv,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.authKind ? { authKind: payload.authKind } : {}),
    ...(payload.accountId ? { accountId: payload.accountId } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.resume ? { resume: true } : {}),
    ...(payload.filesystemWriteScope ? { filesystemWriteScope: payload.filesystemWriteScope } : {}),
    ...(cellSandbox ? { cellSandbox } : {}),
    command: payload.spec.command,
    args: payload.spec.args,
    runDir: hsrRunDir(payload.bee),
  };
  const host = await runHost({
    bee: payload.bee,
    adapter,
    opts,
    queueStartup: true,
    formatStartupFailure: (error) => hsrStartupFailureForPayload(error, payload),
  });
  return { payload, host };
}

// Standalone dedicated-sibling guard. Fires ONLY when node/tsx invoked the
// dedicated `runner-entry` sibling directly (mode 'dedicated':
// `node runner-entry.mjs <payloadPath>`). The CLI imports this module through
// runnerHost.ts for its `__hsr-run` fallback, and the cloud runner-host bundle
// bundles this module alongside remoteHost.ts under a SHARED import.meta.url — a
// bare realpath self-check would then double-fire on every `connect`/`serve`/
// `--version`. The bundle is named `hive-runner-host-*.mjs`, so gating on the
// argv[1] basename stands this guard down inside the bundle; there remoteHost's
// main() is the sole owner of the `__hsr-run` dispatch.
const invokedAsDedicatedSibling = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  if (!basename(entry).startsWith("runner-entry")) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsDedicatedSibling) {
  runHsrHostFromPayload(process.argv[2]).catch((error) => {
    process.stderr.write(`hive __hsr-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
