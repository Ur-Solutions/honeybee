import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `security` can block indefinitely on a keychain-unlock or consent dialog —
// fatal for headless callers (the daemon's credential sync wedges its tick).
// One minute is enough for a human to answer an interactive prompt; after
// that the call fails closed (read → null, write → false).
const SECURITY_EXEC_TIMEOUT_MS = 60_000;

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

/** Read the claude credentials for a home from the keychain; null when absent/unavailable. */
export async function readClaudeKeychain(homePath: string): Promise<string | null> {
  if (!keychainAvailable()) return null;
  try {
    // macOS may show a one-time "security wants to access ..." consent dialog
    // for items created by Claude Code itself; Always Allow makes it stick.
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", claudeKeychainService(homePath)], { timeout: SECURITY_EXEC_TIMEOUT_MS });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
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
 * Build the `security -i` command line that stores a secret. The secret is
 * hex-encoded (-X) so it needs no quoting and survives arbitrary content —
 * including the multi-line pretty-printed JSON that mergeCredentialsJson
 * produces. When the hex of the exact bytes would overflow the interpreter's
 * line buffer, the secret is re-serialized as compact JSON (semantically
 * identical for every consumer; the login-seat digest baseline is computed
 * from a post-write read-back, never from this input). Returns null when it
 * still cannot fit, or when account/service/keychain contain bytes that
 * would break the one-command-per-line protocol — callers fail closed
 * rather than fall back to argv. The optional trailing keychain path targets
 * a specific keychain file; tests use it to stay out of the login keychain.
 * Exported for tests.
 */
export function buildAddGenericPasswordCommand(account: string, service: string, secret: string, keychainPath?: string): string | null {
  const assemble = (data: string): string | null => {
    const parts = ["add-generic-password", "-U", "-a", quoteSecurityToken(account), "-s", quoteSecurityToken(service), "-X", Buffer.from(data, "utf8").toString("hex")];
    if (keychainPath !== undefined) parts.push(quoteSecurityToken(keychainPath));
    const command = parts.join(" ");
    return command.length > SECURITY_LINE_MAX || /[\r\n\0]/.test(command) ? null : command;
  };
  const exact = assemble(secret);
  if (exact !== null) return exact;
  try {
    return assemble(JSON.stringify(JSON.parse(secret)));
  } catch {
    return null;
  }
}

/** Create/update the keychain entry for a home. Returns false when unavailable or rejected. */
export async function writeClaudeKeychain(homePath: string, credentials: string): Promise<boolean> {
  if (!keychainAvailable()) return false;
  // -U updates in place. The secret must not travel via argv — argv is
  // visible to any local process while `security` runs — so the whole
  // command is fed to `security -i` on stdin instead. A failing command
  // sets the exit status, which rejects the promise below.
  const command = buildAddGenericPasswordCommand(userInfo().username, claudeKeychainService(homePath), credentials);
  if (command === null) return false; // unrepresentable secret: fail closed, never argv
  try {
    const pending = execFileAsync("security", ["-i"], { timeout: SECURITY_EXEC_TIMEOUT_MS });
    const stdin = pending.child.stdin;
    if (stdin) {
      // Swallow EPIPE from an early security exit; the exit status carries
      // the real failure.
      stdin.on("error", () => {});
      stdin.end(`${command}\n`);
    }
    await pending;
    return true;
  } catch {
    return false;
  }
}

export function credentialDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
