import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `security` can block indefinitely on a keychain-unlock or consent dialog —
// fatal for headless callers (the daemon's credential sync wedges its tick).
// One minute is enough for a human to answer an interactive prompt; after
// that the call fails closed (read → unreadable, write → false).
const SECURITY_EXEC_TIMEOUT_MS = 60_000;

export type ClaudeKeychainReadResult =
  | { status: "present"; raw: string }
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "unreadable"; reason: "timeout" | "security-error" };

type KeychainReadDeps = {
  available?: () => boolean;
  execSecurity?: (args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
};

// ──────────────────────────────────────────────────────────────────────────
// macOS Keychain bridge for Claude Code credentials.
//
// On macOS, Claude Code stores its OAuth credentials in the Keychain rather
// than .credentials.json: a generic password whose service name embeds the
// config dir — "Claude Code-credentials" for the default ~/.claude, and
// "Claude Code-credentials-<first 8 hex of sha256(config dir path)>" for any
// other CLAUDE_CONFIG_DIR. (Derivation verified against a real keychain:
// ~/.claude-1 → a9fc6b50, ~/.claude-2 → 41fe2218, ~/.claude-3 → 117ae561.)
//
// The vault stays file-based (.credentials.json) either way; this bridge
// captures keychain creds into it and seeds the right keychain entry on
// activation so claude in an activated home finds the new identity instead
// of a stale entry.
// ──────────────────────────────────────────────────────────────────────────

export function keychainAvailable(): boolean {
  // HIVE_NO_KEYCHAIN lets tests exercise activation against temp homes
  // without writing entries into the developer's real keychain.
  return process.platform === "darwin" && !process.env.HIVE_NO_KEYCHAIN;
}

export function claudeKeychainService(homePath: string): string {
  const path = resolve(homePath);
  if (path === resolve(homedir(), ".claude")) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
}

function explicitItemNotFound(error: unknown): boolean {
  const failure = error as { code?: unknown; stderr?: unknown };
  // `security` exits with errSecItemNotFound (-25300) truncated to 44 on
  // macOS. Keep the full status and exact diagnostic for test doubles and
  // potential future wrappers, but do not classify any other failure as
  // absence: locked keychains, ACL rejection, missing `security`, and timeouts
  // all mean an authoritative store could exist but could not be inspected.
  if (failure.code === -25_300) return true;
  const stderr = typeof failure.stderr === "string" ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : "";
  return /(?:errSecItemNotFound|The specified item could not be found in the keychain)/i.test(stderr);
}

function keychainReadFailureReason(error: unknown): "timeout" | "security-error" {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  if (
    failure.code === "ETIMEDOUT"
    || failure.killed === true
    || failure.signal === "SIGTERM"
    || (typeof failure.message === "string" && /timed?\s*out/i.test(failure.message))
  ) return "timeout";
  return "security-error";
}

/**
 * Inspect the exact `security -w` rendering without erasing authority state.
 * Only an explicit errSecItemNotFound is absence. A successful empty password
 * is still a present (malformed) item, while locked/ACL/timeout failures are
 * unreadable and callers must quarantine or fail closed instead of consulting
 * `.credentials.json`.
 */
export async function readClaudeKeychainState(homePath: string, deps: KeychainReadDeps = {}): Promise<ClaudeKeychainReadResult> {
  const available = deps.available ?? keychainAvailable;
  if (!available()) return { status: "unavailable" };
  const execSecurity = deps.execSecurity ?? (async (args, options) => {
    const { stdout } = await execFileAsync("security", args, options);
    return { stdout: String(stdout) };
  });
  try {
    // macOS may show a one-time "security wants to access ..." consent dialog
    // for items created by Claude Code itself; Always Allow makes it stick.
    const { stdout } = await execSecurity(["find-generic-password", "-w", "-s", claudeKeychainService(homePath)], { timeout: SECURITY_EXEC_TIMEOUT_MS });
    return { status: "present", raw: stdout.trim() };
  } catch (error) {
    if (explicitItemNotFound(error)) return { status: "absent" };
    return { status: "unreadable", reason: keychainReadFailureReason(error) };
  }
}

export class ClaudeKeychainUnreadableError extends Error {
  constructor(homePath: string, readonly reason: Extract<ClaudeKeychainReadResult, { status: "unreadable" }>["reason"]) {
    super(`Could not read the authoritative macOS Keychain entry for ${homePath} (${reason})`);
    this.name = "ClaudeKeychainUnreadableError";
  }
}

/** Raw `security -w` rendering. Throws when an authoritative item is unreadable. */
export async function readClaudeKeychainRaw(homePath: string): Promise<string | null> {
  const result = await readClaudeKeychainState(homePath);
  if (result.status === "present") return result.raw;
  if (result.status === "unreadable") throw new ClaudeKeychainUnreadableError(homePath, result.reason);
  return null;
}

/** Read credentials with legacy hex decoding for migration/rescue callers. */
export async function readClaudeKeychain(homePath: string): Promise<string | null> {
  const raw = await readClaudeKeychainRaw(homePath);
  return raw === null ? null : decodeSecurityPasswordOutput(raw);
}

/**
 * `security find-generic-password -w` renders non-plain/multiline data as hex.
 * Normalize that transport representation at the bridge boundary so no caller
 * can mistake hex text for Claude's credential JSON or persist it into vaults.
 */
export function decodeSecurityPasswordOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(trimmed)) return raw;
  try {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    JSON.parse(decoded);
    return decoded;
  } catch {
    return raw;
  }
}

// `security -i` reads one command per line from stdin. Its tokenizer
// (verified empirically) splits on whitespace, groups "double-quoted"
// tokens, and treats \X as literal X — so \ and " are the only characters
// that need a backslash escape inside a quoted token.
function quoteSecurityToken(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

// `security -i` reads each command with a ~4096-byte line buffer (measured:
// ~4095 bytes of line + newline; longer lines are split and the tail runs as
// garbage commands). Kept conservative to absorb OS-version drift.
const SECURITY_LINE_MAX = 4000;

/**
 * Build the `security -i` command line that stores a secret as a NORMAL
 * password string (`-w`). Claude expects JSON text from its keychain bridge;
 * `-X` creates a data/hex representation that `security -w` renders as hex and
 * Claude rejects as "Not logged in". Multi-line JSON is compacted to one line
 * before quoting for the interpreter. Returns null when it
 * still cannot fit, or when account/service/keychain contain bytes that
 * would break the one-command-per-line protocol — callers fail closed
 * rather than fall back to argv. The optional trailing keychain path targets
 * a specific keychain file; tests use it to stay out of the login keychain.
 * Exported for tests.
 */
export function buildAddGenericPasswordCommand(account: string, service: string, secret: string, keychainPath?: string): string | null {
  const assemble = (data: string): string | null => {
    const parts = ["add-generic-password", "-U", "-a", quoteSecurityToken(account), "-s", quoteSecurityToken(service), "-w", quoteSecurityToken(data)];
    if (keychainPath !== undefined) parts.push(quoteSecurityToken(keychainPath));
    const command = parts.join(" ");
    return command.length > SECURITY_LINE_MAX || /[\r\n\0]/.test(command) ? null : command;
  };
  // Prefer compact JSON even when pretty JSON happens to fit: a one-line plain
  // password is the format Claude itself writes and reads.
  let compact: string | null = null;
  try {
    compact = JSON.stringify(JSON.parse(secret));
  } catch {
    // Non-JSON test/general secrets retain the exact representation when safe.
  }
  const exact = assemble(compact ?? secret);
  if (exact !== null) return exact;
  return null;
}

export type KeychainWriteReport =
  | { ok: true; mode: "full" | "identity-only" }
  | { ok: false; reason: "unavailable" | "unrepresentable" | "rejected" };

/**
 * Extract a `{claudeAiOauth}`-only payload from a credentials JSON string.
 * Fallback for entries whose full merge (mcpOAuth and other sibling keys can
 * add multiple KB) overflows the `security -i` line buffer: the identity must
 * always land — a stale claudeAiOauth silently bills every bee on the home to
 * the wrong account — while dropped siblings cost at most an MCP re-auth
 * (claude still finds them in the home's .credentials.json where present).
 * Exported for tests.
 */
export function identityOnlyCredentials(credentials: string): string | null {
  try {
    const parsed = JSON.parse(credentials) as Record<string, unknown> | null;
    const oauth = parsed?.claudeAiOauth;
    if (oauth === undefined || oauth === null || typeof oauth !== "object") return null;
    return JSON.stringify({ claudeAiOauth: oauth });
  } catch {
    return null;
  }
}

/**
 * Create/update the keychain entry for a home. When the full payload cannot
 * be represented (line-buffer overflow), retries with the identity-only
 * subset before giving up — callers can ledger the degradation but never
 * lose the identity stamp itself.
 */
export async function writeClaudeKeychainEntry(homePath: string, credentials: string): Promise<KeychainWriteReport> {
  if (!keychainAvailable()) return { ok: false, reason: "unavailable" };
  // Repair legacy vaults that captured `security -w`'s hex rendering. Refuse
  // anything that still is not credential JSON instead of faithfully storing
  // an unusable string and reporting success.
  const normalized = decodeSecurityPasswordOutput(credentials);
  try {
    JSON.parse(normalized);
  } catch {
    return { ok: false, reason: "unrepresentable" };
  }
  const username = userInfo().username;
  const service = claudeKeychainService(homePath);
  const writeAndVerify = async (command: string, expected: string): Promise<boolean> => {
    try {
      // -U updates in place. The secret must not travel via argv — argv is
      // visible to any local process while `security` runs — so the whole
      // command is fed to `security -i` on stdin instead. A failing command
      // sets the exit status, which rejects the promise below.
      const pending = execFileAsync("security", ["-i"], { timeout: SECURITY_EXEC_TIMEOUT_MS });
      const stdin = pending.child.stdin;
      if (stdin) {
        // Swallow EPIPE from an early security exit; the exit status carries
        // the real failure.
        stdin.on("error", () => {});
        stdin.end(`${command}\n`);
      }
      await pending;
      // Success from `security -i` is not sufficient: verify the exact service
      // reads back as semantically equivalent Claude JSON. This catches command
      // tokenizer/format changes and prevents another hex-text corruption from
      // being blessed as a healthy activation.
      const rawReadback = await readClaudeKeychainRaw(homePath);
      if (rawReadback === null || !rawReadback.trimStart().startsWith("{") || !credentialsJsonEquivalent(rawReadback, expected)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const fullCommand = buildAddGenericPasswordCommand(username, service, normalized);
  if (fullCommand !== null && await writeAndVerify(fullCommand, normalized)) return { ok: true, mode: "full" };

  // A representable full payload can still read back as hex when it contains
  // bytes Keychain does not classify as a plain password. Retry the minimal
  // OAuth identity, which is the load-bearing Claude login and is ASCII in
  // normal provider payloads; never report success without raw JSON readback.
  const minimal = identityOnlyCredentials(normalized);
  const minimalCommand = minimal === null ? null : buildAddGenericPasswordCommand(username, service, minimal);
  if (minimal !== null && minimalCommand !== null && await writeAndVerify(minimalCommand, minimal)) {
    return { ok: true, mode: "identity-only" };
  }
  return { ok: false, reason: fullCommand === null && minimalCommand === null ? "unrepresentable" : "rejected" };
}

function credentialsJsonEquivalent(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  try {
    return JSON.stringify(JSON.parse(actual)) === JSON.stringify(JSON.parse(expected));
  } catch {
    return false;
  }
}

export function credentialDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
