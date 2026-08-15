import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountDir, type AccountRecord } from "./registry.js";
import { parseClaudeChainStrict } from "./claudeChain.js";
import { cursorAuthUnavailableReason, readCursorAuthFile } from "./cursorAuth.js";
import { grokAuthUnavailableReason, readGrokAuthFile } from "./grokAuth.js";
import { expFromJwt } from "./utils.js";

/**
 * Cheap, read-only credential preflight for automatic account selection.
 *
 * This deliberately reports only credentials that are PROVABLY unable to
 * start. Refreshable OAuth chains and formats whose expiry cannot be decoded
 * remain eligible: the activation/harness is still the authority, and an
 * account picker must never consume a rotating refresh token merely to rank
 * candidates.
 */
export async function accountCredentialUnavailableReason(
  account: AccountRecord,
  now = Date.now(),
): Promise<string | null> {
  const root = accountDir(account);
  if (account.tool === "claude") {
    const chain = parseClaudeChainStrict(
      await readFile(join(root, ".credentials.json"), "utf8").catch(() => null),
      "vault",
    );
    if (!chain) return "Claude OAuth credential is unreadable";
    // Activation can safely refresh a stale chain, but not one whose refresh
    // token is already absent. Match activation's one-minute handshake skew.
    if (chain.expiresAt <= now + 60_000 && !chain.refreshToken?.trim()) {
      return "Claude OAuth token expired or expires too soon and has no refresh token";
    }
    return null;
  }

  if (account.tool === "cursor") {
    const snapshot = await readCursorAuthFile(join(root, "auth.json"), "vault");
    return cursorAuthUnavailableReason(snapshot, now);
  }

  if (account.tool === "grok") {
    const snapshot = await readGrokAuthFile(join(root, "auth.json"), "vault");
    return grokAuthUnavailableReason(snapshot, now);
  }

  if (account.tool === "codex") {
    const raw = await readFile(join(root, "auth.json"), "utf8").catch(() => null);
    if (!raw) return "missing Codex auth.json";
    try {
      const parsed = JSON.parse(raw) as {
        OPENAI_API_KEY?: unknown;
        tokens?: {
          access_token?: unknown;
          refresh_token?: unknown;
        };
      };
      if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0) {
        return null;
      }
      const access = parsed.tokens?.access_token;
      if (typeof access !== "string" || access.trim().length === 0) {
        return "Codex OAuth access token is missing";
      }
      const exp = expFromJwt(access);
      // Opaque/provider-changed token shapes fail open; Codex remains the
      // format authority. A decodable stale token is usable only when Codex
      // has a refresh token with which to rotate it at boot.
      if (exp === undefined || exp * 1000 > now + 60_000) return null;
      const refresh = parsed.tokens?.refresh_token;
      return typeof refresh === "string" && refresh.trim().length > 0
        ? null
        : "Codex OAuth token expired or expires too soon and has no refresh token";
    } catch {
      return "Codex auth.json is unreadable";
    }
  }

  // Other drivers/providers have no stable expiry vocabulary here. Do not
  // turn format ignorance into a fleet-wide refusal.
  return null;
}
