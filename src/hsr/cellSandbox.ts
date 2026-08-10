/**
 * OS-enforced filesystem containment for execution-protocol Cells.
 *
 * One detached HSR runner process owns exactly one Cell, so a module-local
 * policy is sufficient: initialize once before loading the harness, then wrap
 * every provider child at the shared spawn seam. macOS uses Seatbelt;
 * Linux uses Bubblewrap. Network is deliberately NOT namespaced or proxied:
 * execution providers advertise `network: shared`, and dev servers must bind
 * where Apiary and the operator can reach them.
 */

import { accessSync, constants, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";

export type CellSandboxBackend = "macos-seatbelt" | "linux-bubblewrap";

export type CellSandboxProbe =
  | { status: "ready"; backend: CellSandboxBackend }
  | { status: "absent"; installHint: string };

export type CellSandboxState = {
  backend: CellSandboxBackend;
  cwd: string;
  scratchRoot: string;
  allowWrite: string[];
  denyWrite: string[];
  bashPath: string;
  bwrapPath?: string;
  rgPath?: string;
};

type Platform = NodeJS.Platform;

const DEFAULT_PROVIDER_HOMES: Readonly<Record<string, readonly string[]>> = {
  claude: [".claude"],
  codex: [".codex"],
  grok: [".grok"],
  kimi: [".kimi-code", ".kimi"],
  opencode: [".config/opencode", ".local/share/opencode", ".cache/opencode"],
};

const PROVIDER_HOME_ENV: Readonly<Record<string, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
  kimi: "KIMI_CODE_HOME",
  opencode: "OPENCODE_CONFIG_DIR",
};

const ALL_PROVIDER_HOME_ENV = [...new Set(Object.values(PROVIDER_HOME_ENV))];

let activeState: CellSandboxState | undefined;
let previousClaudeCodeTmpdir: string | undefined;

/**
 * A protocol launch may inherit the shell that happened to start Honeybee.
 * Provider homes are identity-bearing state, so only the values deliberately
 * resolved onto this spawn's AgentSpec may cross into the Cell. With no
 * explicit value, the provider uses its ordinary home-relative default.
 */
export function withoutAmbientProviderState(
  kind: string,
  inherited: Record<string, string>,
  explicit: Record<string, string>,
): Record<string, string> {
  const next = { ...inherited };
  for (const key of ALL_PROVIDER_HOME_ENV) {
    if (!Object.hasOwn(explicit, key)) delete next[key];
  }
  if (kind === "opencode" && !Object.hasOwn(explicit, "XDG_DATA_HOME")) delete next.XDG_DATA_HOME;
  return next;
}

function executableOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = name.includes("/")
    ? [name]
    : (env.PATH ?? "").split(":").filter(Boolean).map((directory) => resolve(directory, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching. A failed explicit path simply produces `undefined`.
    }
  }
  return undefined;
}

/** Dependency-only probe used by node.describe before it advertises a driver. */
export function probeCellSandbox(
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CellSandboxProbe {
  const bashPath = executableOnPath("bash", env);
  if (!bashPath) {
    return { status: "absent", installHint: "install bash to enable execution Cell containment" };
  }
  if (platform === "darwin") {
    const seatbelt = executableOnPath("/usr/bin/sandbox-exec", env);
    if (!seatbelt) {
      return { status: "absent", installHint: "macOS sandbox-exec is unavailable; execution Cells fail closed" };
    }
    const check = spawnSync(seatbelt, ["-p", "(version 1) (allow default)", "/usr/bin/true"], {
      env,
      stdio: "ignore",
      timeout: 2_000,
    });
    return check.status === 0
      ? { status: "ready", backend: "macos-seatbelt" }
      : { status: "absent", installHint: "macOS Seatbelt refused a containment self-check" };
  }
  if (platform === "linux") {
    const bwrap = executableOnPath("bwrap", env);
    if (!bwrap) {
      return {
        status: "absent",
        installHint: "install bubblewrap (bwrap) to enable execution Cell containment",
      };
    }
    const rg = executableOnPath("rg", env);
    if (!rg) {
      return {
        status: "absent",
        installHint: "install ripgrep (rg) to enable execution Cell containment",
      };
    }
    const check = spawnSync(bwrap, [
      "--new-session",
      "--die-with-parent",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--unshare-user",
      "--cap-drop", "ALL",
      "--unshare-pid",
      "--proc", "/proc",
      "--", "/bin/true",
    ], { env, stdio: "ignore", timeout: 3_000 });
    if (check.status !== 0) {
      return {
        status: "absent",
        installHint: "bubblewrap cannot create the required unprivileged user/PID namespaces on this host",
      };
    }
    return { status: "ready", backend: "linux-bubblewrap" };
  }
  return {
    status: "absent",
    installHint: `execution Cells support macOS and Linux; ${platform} is not supported`,
  };
}

function canonicalExistingDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`Cell sandbox ${label} must be absolute`);
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`Cell sandbox ${label} does not exist: ${path}`);
  }
}

function ensurePrivateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Cell sandbox writable root must be absolute: ${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

function canonicalPotentialPath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function assertNarrowProviderRoot(path: string, cwd: string): void {
  const normalized = canonicalPotentialPath(path);
  const deviceRoot = parse(normalized).root;
  const userHome = realpathSync(homedir());
  if (normalized === deviceRoot || normalized === userHome || cwd.startsWith(`${normalized}${sep}`)) {
    throw new Error(`Cell sandbox refuses broad provider state root: ${path}`);
  }
}

function providerWriteRoots(kind: string, env: Record<string, string>, cwd: string): string[] {
  const roots = new Set<string>();
  const homeKey = PROVIDER_HOME_ENV[kind];
  const configuredHome = homeKey ? env[homeKey] : undefined;
  if (configuredHome) {
    if (!isAbsolute(configuredHome)) throw new Error(`Cell sandbox ${homeKey} must be absolute`);
    assertNarrowProviderRoot(configuredHome, cwd);
    roots.add(ensurePrivateDirectory(configuredHome));
  }
  if (kind === "opencode" && env.XDG_DATA_HOME) {
    if (!isAbsolute(env.XDG_DATA_HOME)) throw new Error("Cell sandbox XDG_DATA_HOME must be absolute");
    const opencodeData = join(env.XDG_DATA_HOME, "opencode");
    assertNarrowProviderRoot(opencodeData, cwd);
    roots.add(ensurePrivateDirectory(opencodeData));
  }
  if (roots.size === 0) {
    for (const relative of DEFAULT_PROVIDER_HOMES[kind] ?? []) {
      const candidate = join(homedir(), relative);
      assertNarrowProviderRoot(candidate, cwd);
      roots.add(ensurePrivateDirectory(candidate));
    }
  }
  return [...roots];
}

/**
 * Hive buz must be explicitly available inside a Cell. The session preamble
 * instructs every bee to report over `hive buz`, and any local OS process may
 * already send buz unconditionally, so allowing the mailbox subtree grants no
 * authority the Cell contract means to withhold — while leaving it under the
 * store-wide write deny strands a cell-bound bee's reports (observed live as
 * `EPERM: mkdir ~/.hive/buz/<bee>`). The rest of the hive store (sessions,
 * daemon state, machine identity) stays read-only.
 *
 * Every send also appends one audit line to `<store>/ledger.jsonl`, allowed as
 * a single file and pre-created because the Linux backend can only bind paths
 * that exist at wrap time. Ledger ROTATION is a different story: its lock
 * protocol creates randomly named store-root siblings that a file-granular
 * policy cannot cover, so buildCellSandboxState pins HIVE_LEDGER_MAX_BYTES=0
 * in the Cell env — in-cell appends skip rotation entirely and the next
 * host-side append rotates as usual.
 */
function hiveBuzWritePaths(env: Record<string, string>, cwd: string): string[] {
  const home = env.HOME ?? homedir();
  const configuredRoot = env.HIVE_STORE_ROOT ?? join(home, ".hive");
  const buzDir = ensurePrivateDirectory(join(configuredRoot, "buz"));
  if (cwd === buzDir || cwd.startsWith(`${buzDir}${sep}`)) {
    throw new Error(`Cell sandbox refuses a buz root that contains the Cell: ${buzDir}`);
  }
  const ledgerFile = join(realpathSync(configuredRoot), "ledger.jsonl");
  // Append-mode create: never truncates an existing ledger, and matches
  // appendLedger's own 0600 create mode.
  writeFileSync(ledgerFile, "", { flag: "a", mode: 0o600 });
  return [buzDir, ledgerFile];
}

/**
 * Operator/Apiary-granted extra write roots (`hive spawn --sandbox-write`) —
 * the fs-grant seam Apiary's Cell Layout v2 rides: the harness cwd stays the
 * checkout while the wrapper directory one level up (holding `box/`) becomes
 * writable. Guards mirror assertNarrowProviderRoot: a grant must be a real,
 * pre-existing, non-symlink directory and must never be broad enough to defeat
 * containment — never the device root or $HOME, never a directory holding the
 * hive store, and never an ancestor of the Cell other than its immediate
 * parent (the one legitimate ancestor grant: the v2 wrapper; anything higher
 * would fence in sibling Cells and the workspace itself).
 */
export function resolveCellSandboxExtraWriteRoots(
  roots: readonly string[] | undefined,
  cwd: string,
  env: Record<string, string | undefined>,
): string[] {
  if (!roots || roots.length === 0) return [];
  const canonicalCwd = realpathSync(cwd);
  const homes = new Set([realpathSync(homedir())]);
  if (env.HOME && isAbsolute(env.HOME)) homes.add(canonicalPotentialPath(env.HOME));
  const storeRoot = canonicalPotentialPath(env.HIVE_STORE_ROOT ?? join(env.HOME ?? homedir(), ".hive"));
  const resolved = new Set<string>();
  for (const root of roots) {
    if (!isAbsolute(root)) throw new Error(`Cell sandbox extra write root must be absolute: ${root}`);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(root);
    } catch {
      throw new Error(`Cell sandbox extra write root does not exist: ${root}`);
    }
    if (info.isSymbolicLink()) throw new Error(`Cell sandbox extra write root must not be a symlink: ${root}`);
    if (!info.isDirectory()) throw new Error(`Cell sandbox extra write root must be a directory: ${root}`);
    const normalized = realpathSync(root);
    const deviceRoot = parse(normalized).root;
    if (normalized === deviceRoot || homes.has(normalized)) {
      throw new Error(`Cell sandbox refuses broad extra write root: ${root}`);
    }
    if (storeRoot === normalized || storeRoot.startsWith(`${normalized}${sep}`)) {
      throw new Error(`Cell sandbox refuses an extra write root that contains the hive store: ${root}`);
    }
    if (canonicalCwd.startsWith(`${normalized}${sep}`) && normalized !== dirname(canonicalCwd)) {
      throw new Error(`Cell sandbox refuses an extra write root above the Cell: ${root}`);
    }
    resolved.add(normalized);
  }
  return [...resolved];
}

function scratchEnvironment(scratchRoot: string): Record<string, string> {
  const temp = ensurePrivateDirectory(join(scratchRoot, "tmp"));
  const cache = ensurePrivateDirectory(join(scratchRoot, "cache"));
  return {
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CLAUDE_CODE_TMPDIR: temp,
    XDG_CACHE_HOME: cache,
    npm_config_cache: ensurePrivateDirectory(join(cache, "npm")),
    PNPM_STORE_DIR: ensurePrivateDirectory(join(cache, "pnpm-store")),
    YARN_CACHE_FOLDER: ensurePrivateDirectory(join(cache, "yarn")),
    PIP_CACHE_DIR: ensurePrivateDirectory(join(cache, "pip")),
    UV_CACHE_DIR: ensurePrivateDirectory(join(cache, "uv")),
    GOCACHE: ensurePrivateDirectory(join(cache, "go-build")),
    GOMODCACHE: ensurePrivateDirectory(join(cache, "go-mod")),
    GRADLE_USER_HOME: ensurePrivateDirectory(join(cache, "gradle")),
  };
}

/** Pure enough for policy tests; filesystem roots must already exist. */
export function buildCellSandboxState(input: {
  kind: string;
  cwd: string;
  runDir: string;
  env: Record<string, string>;
  /** Extra allow-listed write roots (`--sandbox-write`), guarded above. */
  extraWriteRoots?: readonly string[];
  platform?: Platform;
}): { state: CellSandboxState; env: Record<string, string> } {
  const platform = input.platform ?? process.platform;
  const support = probeCellSandbox(platform, input.env);
  if (support.status !== "ready") throw new Error(`Cell sandbox unavailable: ${support.installHint}`);
  const cwd = canonicalExistingDirectory(input.cwd, "cwd");
  const runDir = ensurePrivateDirectory(input.runDir);
  const scratchRoot = ensurePrivateDirectory(join(runDir, "cell-sandbox"));
  // HIVE_LEDGER_MAX_BYTES=0 disables in-cell ledger rotation; the rotation
  // lock cannot work under the file-granular ledger allowance (see
  // hiveBuzWritePaths). Deliberately overrides any inherited value: a nonzero
  // setting would break every in-cell `hive buz` send at rotation pressure.
  const nextEnv = { ...input.env, ...scratchEnvironment(scratchRoot), HIVE_LEDGER_MAX_BYTES: "0" };
  const hostHome = homedir();
  const allowWrite = [...new Set([
    ...getDefaultWritePaths(),
    cwd,
    scratchRoot,
    ...providerWriteRoots(input.kind, nextEnv, cwd),
    ...hiveBuzWritePaths(nextEnv, cwd),
    ...resolveCellSandboxExtraWriteRoots(input.extraWriteRoots, cwd, nextEnv),
  ])];
  // Sandbox Runtime intentionally includes a few compatibility paths by
  // default. They are not part of Apiary's Cell contract, so carve them back
  // out; the per-run scratch and provider home above are the only writable
  // state outside the Cell.
  const denyWrite = [
    "/tmp/claude",
    "/private/tmp/claude",
    join(hostHome, ".npm", "_logs"),
    join(hostHome, ".claude", "debug"),
  ].filter((path) => !path.startsWith(`${scratchRoot}/`));
  const bashPath = executableOnPath("bash", input.env);
  if (!bashPath) throw new Error("Cell sandbox unavailable: bash is not executable");
  const state: CellSandboxState = {
    backend: support.backend,
    cwd,
    scratchRoot,
    allowWrite,
    denyWrite,
    bashPath,
    ...(support.backend === "linux-bubblewrap"
      ? {
          bwrapPath: executableOnPath("bwrap", input.env),
          rgPath: executableOnPath("rg", input.env),
        }
      : {}),
  };
  return { state, env: nextEnv };
}

/** Initialize the one-Cell policy before the provider adapter starts. */
export function initializeCellSandbox(input: {
  kind: string;
  cwd: string;
  runDir: string;
  env: Record<string, string>;
  extraWriteRoots?: readonly string[];
}): { backend: CellSandboxBackend; env: Record<string, string> } {
  if (activeState) throw new Error("Cell sandbox is already initialized in this runner process");
  const built = buildCellSandboxState(input);
  activeState = built.state;
  previousClaudeCodeTmpdir = process.env.CLAUDE_CODE_TMPDIR;
  process.env.CLAUDE_CODE_TMPDIR = built.env.TMPDIR;
  return { backend: built.state.backend, env: built.env };
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function commandString(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

/** Wrap one harness root; every descendant inherits the same OS policy. */
export async function wrapCellSandboxCommand(
  command: string,
  args: string[],
): Promise<{ command: string; args: string[] }> {
  const state = activeState;
  if (!state) return { command, args };
  return wrapCellSandboxCommandForState(state, command, args);
}

/** Explicit-state form kept public for cross-platform policy conformance tests. */
export async function wrapCellSandboxCommandForState(
  state: CellSandboxState,
  command: string,
  args: string[],
): Promise<{ command: string; args: string[] }> {
  const raw = commandString(command, args);
  const common = {
    command: raw,
    needsNetworkRestriction: false,
    readConfig: { denyOnly: [], allowWithinDeny: [] },
    writeConfig: { allowOnly: state.allowWrite, denyWithinAllow: state.denyWrite },
    unsetEnvVars: [],
    setEnvVars: {},
    allowAllUnixSockets: true,
    allowGitConfig: false,
    gitSafeDirectories: [state.cwd],
    binShell: state.bashPath,
  };
  const wrapped = state.backend === "macos-seatbelt"
    ? wrapCommandWithSandboxMacOS({ ...common, allowLocalBinding: true })
    : await wrapCommandWithSandboxLinux({
        ...common,
        bwrapPath: state.bwrapPath,
        ripgrepConfig: { command: state.rgPath as string },
      });
  return { command: state.bashPath, args: ["-c", wrapped] };
}

/** Match Linux's per-command mount-point accounting; a no-op on macOS. */
export function cleanupCellSandboxCommand(): void {
  if (activeState?.backend === "linux-bubblewrap") cleanupBwrapMountPoints();
}

export function shutdownCellSandbox(): void {
  if (activeState?.backend === "linux-bubblewrap") cleanupBwrapMountPoints({ force: true });
  if (previousClaudeCodeTmpdir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
  else process.env.CLAUDE_CODE_TMPDIR = previousClaudeCodeTmpdir;
  activeState = undefined;
  previousClaudeCodeTmpdir = undefined;
}

export function activeCellSandboxBackend(): CellSandboxBackend | undefined {
  return activeState?.backend;
}
