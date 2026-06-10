import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", claudeKeychainService(homePath)]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Create/update the keychain entry for a home. Returns false when unavailable or rejected. */
export async function writeClaudeKeychain(homePath: string, credentials: string): Promise<boolean> {
  if (!keychainAvailable()) return false;
  try {
    // -U updates in place. The secret travels via argv, which is briefly
    // visible in the local process list — same tradeoff caam made; the
    // alternative interactive stdin mode is not scriptable.
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-a",
      userInfo().username,
      "-s",
      claudeKeychainService(homePath),
      "-w",
      credentials,
    ]);
    return true;
  } catch {
    return false;
  }
}

export function credentialDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
