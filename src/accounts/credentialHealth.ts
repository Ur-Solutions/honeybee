import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readClaudeKeychain } from "../keychain.js";
import { parseClaudeChain, readVaultClaudeChain, type ClaudeChain } from "./claudeChain.js";
import type { AccountRecord } from "./registry.js";

export type ClaudeDiskCredentialHealth =
  | { valid: true; expiresAt: number }
  | {
      valid: false;
      reason:
        | "missing"
        | "malformed-or-incomplete"
        | "missing-access-token"
        | "missing-refresh-token"
        | "invalid-expiry"
        | "expired";
    };

export type ClaudeCredentialInvalidReason = Extract<ClaudeDiskCredentialHealth, { valid: false }>["reason"];

export type ClaudeRecoveryCredentialPlan =
  | {
      ready: true;
      source: "home" | "vault";
      expiresAt: number;
      reason: "home-current" | "vault-newer" | "vault-only";
    }
  | {
      ready: false;
      reason: "no-valid-home-or-vault";
      homeReason: ClaudeCredentialInvalidReason;
      vaultReason: ClaudeCredentialInvalidReason;
    };

function inspectClaudeChain(
  chain: ClaudeChain | null,
  options: { now?: () => number } = {},
): ClaudeDiskCredentialHealth {
  if (!chain) return { valid: false, reason: "malformed-or-incomplete" };
  if (typeof chain.oauth.accessToken !== "string" || chain.oauth.accessToken.trim().length === 0) {
    return { valid: false, reason: "missing-access-token" };
  }
  if (typeof chain.refreshToken !== "string" || chain.refreshToken.trim().length === 0) {
    return { valid: false, reason: "missing-refresh-token" };
  }
  if (!Number.isFinite(chain.expiresAt)) return { valid: false, reason: "invalid-expiry" };
  if (chain.expiresAt <= (options.now ?? Date.now)()) return { valid: false, reason: "expired" };
  return { valid: true, expiresAt: chain.expiresAt };
}

/**
 * Verify Claude's fallback credential file. Recovery decisions must use
 * planClaudeRecoveryCredentials instead because macOS Claude prefers the
 * per-home Keychain entry. This deliberately returns metadata only: tokens
 * never leave the parser and are never safe to include in logs or ledger rows.
 */
export async function inspectClaudeDiskCredentials(
  homePath: string,
  options: { now?: () => number } = {},
): Promise<ClaudeDiskCredentialHealth> {
  const raw = await readFile(join(homePath, ".credentials.json"), "utf8").catch(() => null);
  if (raw === null) return { valid: false, reason: "missing" };
  const chain = parseClaudeChain(raw, "home-file");
  return inspectClaudeChain(chain, options);
}

/**
 * Read the credential Claude actually resolves on macOS: the per-home
 * Keychain entry wins over the fallback file. A health check that only reads
 * .credentials.json can bless a newer file while Claude still boots with a
 * stale Keychain entry.
 */
export async function readEffectiveClaudeHomeChain(homePath: string): Promise<ClaudeChain | null> {
  const keychain = parseClaudeChain(await readClaudeKeychain(homePath), `${homePath}:keychain`);
  if (keychain) return keychain;
  return parseClaudeChain(
    await readFile(join(homePath, ".credentials.json"), "utf8").catch(() => null),
    `${homePath}:file`,
  );
}

/**
 * Decide which persisted OAuth chain an auth recovery must boot with without
 * exposing token material. A fresh interactive login rotates the refresh
 * chain, so a structurally valid but older home credential is not reusable
 * merely because its expiresAt is still in the future.
 */
export async function planClaudeRecoveryCredentials(
  account: AccountRecord,
  homePath: string,
  options: {
    now?: () => number;
    readHome?: (homePath: string) => Promise<ClaudeChain | null>;
    readVault?: (account: AccountRecord) => Promise<ClaudeChain | null>;
  } = {},
): Promise<ClaudeRecoveryCredentialPlan> {
  const [home, vault] = await Promise.all([
    (options.readHome ?? readEffectiveClaudeHomeChain)(homePath),
    (options.readVault ?? readVaultClaudeChain)(account),
  ]);
  const healthOptions = { ...(options.now ? { now: options.now } : {}) };
  const homeHealth = inspectClaudeChain(home, healthOptions);
  const vaultHealth = inspectClaudeChain(vault, healthOptions);

  if (!homeHealth.valid) {
    if (vaultHealth.valid) {
      return { ready: true, source: "vault", expiresAt: vaultHealth.expiresAt, reason: "vault-only" };
    }
    return {
      ready: false,
      reason: "no-valid-home-or-vault",
      homeReason: homeHealth.reason,
      vaultReason: vaultHealth.reason,
    };
  }
  if (!vaultHealth.valid) {
    return { ready: true, source: "home", expiresAt: homeHealth.expiresAt, reason: "home-current" };
  }

  const sameChain = home!.oauth.accessToken === vault!.oauth.accessToken && home!.refreshToken === vault!.refreshToken;
  if (!sameChain && vault!.expiresAt >= home!.expiresAt) {
    return { ready: true, source: "vault", expiresAt: vault!.expiresAt, reason: "vault-newer" };
  }
  return { ready: true, source: "home", expiresAt: home!.expiresAt, reason: "home-current" };
}
