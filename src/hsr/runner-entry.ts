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
import {
  CELL_BROKER_CAPABILITY_ENV,
  isCellBrokerCapabilityToken,
} from "../cellBrokerCapability.js";
import { driverIdentityEnvKeysForAgent } from "../driverIdentityEnv.js";
import { hasExactLocalGithubSessionCredentialLease } from "../execution/localCredentials.js";
import { loadAdapterFor } from "./adapter-loader.js";
import {
  initializeCellSandbox,
  shutdownCellSandbox,
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
  /** Run identity and exact runtime credential authority for execution Cells. */
  executionRunId?: string;
  runtimeCredentialLeaseIds?: string[];
  /** Runtime-only bearer capability for the local Cell broker. */
  cellBrokerCapability?: string;
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

/**
 * Non-authority-bearing process settings reviewed for execution Cells. This is
 * intentionally a list, never a prefix match: API tokens, SSH/keychain agents,
 * provider homes, Node preload hooks, and arbitrary gateway variables must not
 * cross from the Honeybee daemon merely because they exist in process.env.
 *
 * `inherit-node` retains the node's proxy and public trust configuration. The
 * execution Cell sandbox replaces HOME/tmp/cache later, and Honeybee stamps
 * its own HIVE_BEE/HIVE_CELL identity after this filter.
 */
export const EXECUTION_CELL_AMBIENT_ENV_KEYS = [
  "PATH",
  // Runner-host only credential discovery. hsrHarnessEnvironment removes all
  // three before the provider child and the Cell sandbox installs scratch HOME.
  "HOME",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "MISE_DATA_DIR",
  "HIVE_STORE_ROOT",
  "HIVE_HSR_OBSERVATION_CONCURRENCY",
  "HIVE_CODEX_START_CONCURRENCY",
  "HIVE_CODEX_START_QUEUE_TIMEOUT_MS",
] as const;

const EXECUTION_CELL_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

function copyStringEnvironment(source: EnvironmentSource): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function proxyUrlContainsCredentials(value: string): boolean {
  // `new URL("user:pass@host:8080")` treats `user:` as a custom scheme and
  // reports no username/password. Proxy implementations commonly accept that
  // scheme-less authority form, so raw `@` is a fail-closed userinfo signal.
  if (value.includes("@")) return true;
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    // Preserve existing support for odd but credential-free node proxy
    // syntax. An authority containing `@` is nevertheless an unmistakable
    // userinfo shape even when the rest of the URL is malformed.
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
    return authority?.includes("@") === true;
  }
}

/**
 * `inherit-node` authorizes node routing, not ambient credential material.
 * Refuse before execution launch dispatch instead of silently stripping
 * userinfo into a broken proxy or leaking it without a signed credential
 * lease. Ordinary HSR never calls this policy gate.
 */
export function assertExecutionCellProxyEnvironment(
  inherited: EnvironmentSource = process.env,
): void {
  for (const key of EXECUTION_CELL_PROXY_ENV_KEYS) {
    const value = inherited[key];
    if (typeof value === "string" && proxyUrlContainsCredentials(value)) {
      throw new Error(
        `execution Cell refuses credential-bearing ${key}; inherit-node permits proxy routing but not ambient proxy credentials`,
      );
    }
  }
}

/** Environment inherited by the detached runner host itself. */
export function hsrHostEnvironment(
  payload: Pick<HsrRunPayload, "filesystemWriteScope">,
  inherited: EnvironmentSource = process.env,
): Record<string, string> {
  if (payload.filesystemWriteScope !== "cwd") return copyStringEnvironment(inherited);
  assertExecutionCellProxyEnvironment(inherited);
  const env: Record<string, string> = {};
  for (const key of EXECUTION_CELL_AMBIENT_ENV_KEYS) {
    const value = inherited[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/**
 * Provider env authorized by this execution launch. Accountless Cells get no
 * provider identity variables at all: resolveAgent may have adopted a daemon
 * home or merged a gateway, neither of which is lease authority. An explicit
 * signed account selection is reduced to the selected driver's exact identity
 * keys; cross-provider and arbitrary variables remain excluded.
 */
export function executionCellProviderEnvironment(
  payload: Pick<HsrRunPayload, "kind" | "accountId" | "spec">,
): Record<string, string> {
  if (!payload.accountId) return {};
  const env: Record<string, string> = {};
  for (const key of driverIdentityEnvKeysForAgent(payload.kind)) {
    const value = payload.spec.env[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/** Remove unleased env bytes before an execution payload is handed off. */
export function sanitizeExecutionCellPayload(payload: HsrRunPayload): HsrRunPayload {
  if (payload.filesystemWriteScope !== "cwd") return payload;
  return {
    ...payload,
    spec: {
      ...payload.spec,
      env: executionCellProviderEnvironment(payload),
    },
  };
}

/** Final pre-sandbox harness environment (sandbox HOME/tmp are added next). */
export function hsrHarnessEnvironment(
  payload: HsrRunPayload,
  inherited: EnvironmentSource = process.env,
): Record<string, string> {
  if (payload.filesystemWriteScope !== "cwd") {
    const env = { ...copyStringEnvironment(inherited), ...payload.spec.env };
    // Broker authority belongs only to the exact execution Cell payload. Never
    // let an ambient parent capability flow into an ordinary HSR child.
    delete env.HIVE_CELL_BROKER_SOCKET;
    delete env[CELL_BROKER_CAPABILITY_ENV];
    return env;
  }
  const env = {
    ...hsrHostEnvironment(payload, inherited),
    ...executionCellProviderEnvironment(payload),
  };
  // The host needs the canonical store for run metadata and startup locks, but
  // exposing HIVE_STORE_ROOT to arbitrary Cell subprocesses turns a shared-read
  // sandbox into a discoverable control-plane database. Cells reach exactly
  // the authenticated broker socket instead; non-brokered hive reads resolve
  // against the isolated HOME created by the sandbox.
  const storeRoot = env.HIVE_STORE_ROOT;
  delete env.HIVE_STORE_ROOT;
  delete env.HOME;
  delete env.GH_CONFIG_DIR;
  delete env.XDG_CONFIG_HOME;
  if (storeRoot && isCellBrokerCapabilityToken(payload.cellBrokerCapability)) {
    env.HIVE_CELL_BROKER_SOCKET = join(storeRoot, "daemon", "hsr-control.sock");
    env[CELL_BROKER_CAPABILITY_ENV] = payload.cellBrokerCapability;
  }
  return env;
}

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
 * Resolve local-core-v1's sole ambient credential compatibility grant. The
 * operator explicitly chose host `gh` OAuth for local Cells; unlike the old
 * implicit fallback, injection now requires Apiary's signed, Run-bound
 * local-gh-session-v1 lease to survive all the way into this exact payload.
 * No GH_* or GITHUB_* variable is inherited from the daemon.
 */
export async function applyCellGithubCredential(
  env: Record<string, string>,
  payload: Pick<
    HsrRunPayload,
    "filesystemWriteScope" | "executionRunId" | "runtimeCredentialLeaseIds"
  >,
  resolveToken: () => Promise<string> = hostGithubSessionToken,
): Promise<void> {
  if (payload.filesystemWriteScope !== "cwd") return;
  if (!hasExactLocalGithubSessionCredentialLease(payload.executionRunId, payload.runtimeCredentialLeaseIds)) return;
  try {
    const token = (await resolveToken()).trim();
    // A credential is a single opaque line; anything else is not a token.
    if (token.length === 0 || /[\s\u0000-\u001f\u007f]/.test(token)) return;
    env.GH_TOKEN = token;
  } catch {
    // The signed lease grants resolution; it does not fabricate a missing host
    // session. The provider starts unauthenticated and gh reports normally.
  }
}

/** Exact host-only environment used to locate gh's authenticated config. */
export function hostGithubCredentialResolverEnvironment(
  inherited: EnvironmentSource = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"] as const) {
    const value = inherited[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/** Invoke the real gh CLI through the reviewed resolver-only environment. */
export function hostGithubSessionToken(inherited: EnvironmentSource = process.env): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "gh",
      ["auth", "token"],
      // Exactly one validated token line crosses into the Cell; the host
      // discovery roots themselves never enter the provider child.
      { timeout: 3000, env: hostGithubCredentialResolverEnvironment(inherited), encoding: "utf8" },
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
    return sanitizeExecutionCellPayload(JSON.parse(raw) as HsrRunPayload);
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
  // Ordinary HSR preserves its historical full environment. Execution Cells
  // start from the reviewed ambient allowlist plus the exact selected-provider
  // identity env; no daemon/gateway credential is an implicit fallback.
  let childEnv = hsrHarnessEnvironment(payload);
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
