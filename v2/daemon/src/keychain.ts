/**
 * macOS Keychain bridge for Claude Code credentials — the ESSENTIAL part of
 * the old src/keychain.ts (spec 08: "the essential part of keychain.ts kept;
 * the baseline-arbitration hack goes with vault-authority").
 *
 * On macOS, Claude Code stores its OAuth credentials in the Keychain rather
 * than .credentials.json: a generic password whose service name embeds the
 * config dir — "Claude Code-credentials" for the default ~/.claude, and
 * "Claude Code-credentials-<first 8 hex of sha256(config dir path)>" for any
 * other CLAUDE_CONFIG_DIR. (Derivation verified against a real keychain:
 * ~/.claude-1 → a9fc6b50, ~/.claude-2 → 41fe2218, ~/.claude-3 → 117ae561.)
 *
 * The vault stays file-based (.credentials.json) either way: the login seat
 * captures the keychain item into it, and activation of an EMPTY home seeds
 * the home's keychain entry from it so claude finds the identity.
 *
 * Everything here is INJECTED into the daemon (KeychainReader / KeychainWriter)
 * so tests never touch a real keychain; the default reader is a no-op off
 * macOS or under HIVE_NO_KEYCHAIN.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `security` can block indefinitely on a keychain-unlock or consent dialog —
// fatal for headless callers. One minute is enough for a human to answer an
// interactive prompt; after that the call fails closed (read → null).
const SECURITY_EXEC_TIMEOUT_MS = 60_000;

/** Raw credential JSON for a home's Keychain item, or null when absent/unreadable/unavailable. */
export type KeychainReader = (homePath: string) => Promise<string | null>;
/** Write the credential JSON as the home's Keychain item; false when unavailable/rejected. */
export type KeychainWriter = (homePath: string, credentials: string) => Promise<boolean>;

export function keychainAvailable(env: Record<string, string | undefined> = process.env): boolean {
  // HIVE_NO_KEYCHAIN lets tests exercise activation against temp homes
  // without writing entries into the developer's real keychain.
  return process.platform === "darwin" && !env.HIVE_NO_KEYCHAIN;
}

export function claudeKeychainService(homePath: string): string {
  const path = resolve(homePath);
  if (path === resolve(homedir(), ".claude")) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
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

/** The default reader: `security find-generic-password -w -s <service>`; null on absence or any failure. */
export const readClaudeKeychain: KeychainReader = async (homePath) => {
  if (!keychainAvailable()) return null;
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", claudeKeychainService(homePath)], {
      timeout: SECURITY_EXEC_TIMEOUT_MS,
    });
    const raw = String(stdout).trim();
    return raw.length === 0 ? null : decodeSecurityPasswordOutput(raw);
  } catch {
    return null;
  }
};

// `security -i` reads one command per line from stdin. Its tokenizer splits
// on whitespace, groups "double-quoted" tokens, and treats \X as literal X —
// so \ and " are the only characters that need a backslash escape inside a
// quoted token.
function quoteSecurityToken(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

// `security -i` reads each command with a ~4096-byte line buffer.
const SECURITY_LINE_MAX = 4000;

/** Build the `security -i` add-generic-password line (compact JSON, `-U` updates in place); null when it cannot fit. */
export function buildAddGenericPasswordCommand(account: string, service: string, secret: string): string | null {
  let compact = secret;
  try {
    compact = JSON.stringify(JSON.parse(secret));
  } catch {
    // non-JSON secrets keep their exact representation
  }
  const command = ["add-generic-password", "-U", "-a", quoteSecurityToken(account), "-s", quoteSecurityToken(service), "-w", quoteSecurityToken(compact)].join(" ");
  return command.length > SECURITY_LINE_MAX || /[\r\n\0]/.test(command) ? null : command;
}

/** Fallback payload when the full credential JSON overflows the line buffer: the identity alone. */
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
 * The default writer: create/update the home's Keychain item via `security -i`
 * (the secret never travels via argv), verify by reading it back. Retries with
 * the identity-only subset when the full payload cannot be represented.
 */
export const writeClaudeKeychainEntry: KeychainWriter = async (homePath, credentials) => {
  if (!keychainAvailable()) return false;
  const normalized = decodeSecurityPasswordOutput(credentials);
  try {
    JSON.parse(normalized);
  } catch {
    return false;
  }
  const username = userInfo().username;
  const service = claudeKeychainService(homePath);
  const writeAndVerify = async (command: string, expected: string): Promise<boolean> => {
    try {
      const pending = execFileAsync("security", ["-i"], { timeout: SECURITY_EXEC_TIMEOUT_MS });
      const stdin = pending.child.stdin;
      if (stdin) {
        stdin.on("error", () => {});
        stdin.end(`${command}\n`);
      }
      await pending;
      const readback = await readClaudeKeychain(homePath);
      return readback !== null && JSON.stringify(JSON.parse(readback)) === JSON.stringify(JSON.parse(expected));
    } catch {
      return false;
    }
  };
  const full = buildAddGenericPasswordCommand(username, service, normalized);
  if (full !== null && (await writeAndVerify(full, normalized))) return true;
  const minimal = identityOnlyCredentials(normalized);
  const minimalCommand = minimal === null ? null : buildAddGenericPasswordCommand(username, service, minimal);
  return minimal !== null && minimalCommand !== null && (await writeAndVerify(minimalCommand, minimal));
};

export function credentialDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
