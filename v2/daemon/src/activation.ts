/**
 * Vault ↔ home file operations (spec 08 "Activation" + "The one design
 * change"): the HOME is authoritative. Activation copies vault → home ONLY
 * when the home is empty (no primary credential file); a populated home is
 * never touched by a spawn — byte for byte. The login seat's capture copies
 * home → vault (seed and backup, never synced). No locks, owner stamps or
 * generation fences: one account has exactly one home, so there is never a
 * second copy to reconcile.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { recipeFor, type IdentityRecipe } from "../../core/src/index.ts";
import { seedClaudeHomeAcceptance, seedClaudeHomeDefaults, seedCodexHomeDefaults } from "./homeDefaults.ts";
import type { KeychainWriter } from "./keychain.ts";

/** `<vaultDir>/<harness>/<accountId>` — the old layout, so the operator's vault reads as-is. */
export function vaultDirFor(vaultDir: string, harness: string, accountId: string): string {
  return join(vaultDir, harness, accountId);
}

/** `<homesDir>/<accountId>` — the account's one run-home. */
export function defaultHomeFor(homesDir: string, accountId: string): string {
  return join(homesDir, accountId);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The recipe's PRIMARY credential file (relative). */
export function primaryCredentialFile(recipe: IdentityRecipe): string {
  return recipe.credentialFiles[0] as string;
}

/** A dir "has credentials" iff the recipe's primary credential file exists in it. */
export function dirHasCredentials(dir: string, recipe: IdentityRecipe): boolean {
  return isFile(join(dir, primaryCredentialFile(recipe)));
}

/** True iff the account's home is EMPTY of credentials (the activation trigger). */
export function homeIsEmpty(homePath: string, recipe: IdentityRecipe): boolean {
  return !dirHasCredentials(homePath, recipe);
}

/** Every recipe file (credential + config + mirrors), relative. */
export function recipeFiles(recipe: IdentityRecipe): string[] {
  return [...recipe.credentialFiles, ...(recipe.configFiles ?? [])];
}

function copyInto(srcDir: string, dstDir: string, rel: string): boolean {
  const src = join(srcDir, rel);
  if (!isFile(src)) return false;
  const dst = join(dstDir, rel);
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  copyFileSync(src, dst);
  return true;
}

export interface ActivationResult {
  /** True iff the home was empty and got activated now. */
  activated: boolean;
  /** Recipe files copied vault → home (relative), incl. activation mirrors. */
  copied: string[];
  /** Why nothing happened (populated home / no vault credentials / unknown recipe). */
  reason?: "home_populated" | "vault_empty" | "no_recipe";
  /** claude: whether the home's Keychain item was seeded from the vault (macOS only). */
  keychainSeeded?: boolean;
}

export interface ActivationOptions {
  /** claude: the bee's cwd to pre-trust in .claude.json (avoids the trust dialog). */
  trustCwd?: string;
  /** claude: pre-accept bypass-permissions mode. Default true (hive bees are unattended). */
  yolo?: boolean;
  /** claude on macOS: seed the home's Keychain item from the vault credential (injected; absent = skip). */
  keychainWriter?: KeychainWriter;
}

/**
 * Activate an account's home from the vault IF AND ONLY IF the home carries
 * no primary credential. Copies every recipe file present in the vault (plus
 * activation mirrors), then applies the harness's home defaults (bypass flag /
 * default model / onboarding + trust acceptance for claude; model / effort /
 * service tier / notice for codex). A populated home returns
 * `activated:false, reason:"home_populated"` having touched NOTHING.
 */
export function activateHomeIfEmpty(
  harness: string,
  homePath: string,
  vaultDir: string,
  opts: ActivationOptions = {},
): ActivationResult {
  const recipe = recipeFor(harness);
  if (!recipe) return { activated: false, copied: [], reason: "no_recipe" };
  if (!homeIsEmpty(homePath, recipe)) return { activated: false, copied: [], reason: "home_populated" };
  if (!dirHasCredentials(vaultDir, recipe)) return { activated: false, copied: [], reason: "vault_empty" };
  mkdirSync(homePath, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  for (const rel of recipeFiles(recipe)) if (copyInto(vaultDir, homePath, rel)) copied.push(rel);
  for (const [canonical, mirror] of Object.entries(recipe.activationMirrors ?? {})) {
    if (copyInto(vaultDir, homePath, canonical)) {
      // the mirror is a second home-relative copy of the same vault file
      const dst = join(homePath, mirror);
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      copyFileSync(join(vaultDir, canonical), dst);
      copied.push(mirror);
    }
  }
  const result: ActivationResult = { activated: true, copied };
  if (harness === "claude") {
    seedClaudeHomeDefaults(homePath);
    seedClaudeHomeAcceptance(homePath, { yolo: opts.yolo ?? true, ...(opts.trustCwd ? { trustCwd: opts.trustCwd } : {}) });
    result.keychainSeeded = false;
  } else if (harness === "codex") {
    seedCodexHomeDefaults(homePath);
  }
  return result;
}

/**
 * claude on macOS: the Keychain item is the credential claude actually reads.
 * After a file activation, seed the home's item from the vault credential
 * (async because `security` is a child process). Best-effort; the file copy
 * already happened.
 */
export async function seedClaudeKeychainFromVault(homePath: string, vaultDir: string, writer: KeychainWriter | undefined): Promise<boolean> {
  if (!writer) return false;
  const path = join(vaultDir, ".credentials.json");
  if (!isFile(path)) return false;
  try {
    return await writer(homePath, readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Login capture: copy the recipe files present in the home into the vault
 * (home → vault; the seed/backup direction). `overrides` supplies file
 * contents that live OUTSIDE the home (claude's Keychain item → the vault's
 * .credentials.json). Returns the relative paths written.
 */
export function captureHomeToVault(
  harness: string,
  homePath: string,
  vaultDir: string,
  overrides: Record<string, string> = {},
): string[] {
  const recipe = recipeFor(harness);
  if (!recipe) return [];
  mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const rel of recipeFiles(recipe)) {
    const override = overrides[rel];
    if (override !== undefined) {
      const dst = join(vaultDir, rel);
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      writeFileSync(dst, override, { mode: 0o600 });
      written.push(rel);
      continue;
    }
    if (copyInto(homePath, vaultDir, rel)) written.push(rel);
  }
  return written;
}

/** A byte-level fingerprint of a directory's recipe files (for "populated home untouched" tests). */
export function recipeFingerprint(dir: string, harness: string): Record<string, string> {
  const recipe = recipeFor(harness);
  if (!recipe) return {};
  const out: Record<string, string> = {};
  for (const rel of recipeFiles(recipe)) {
    const path = join(dir, rel);
    if (isFile(path)) out[rel] = readFileSync(path, "utf8");
  }
  return out;
}

/** mtime (ms) of the primary credential in a dir, or null when absent. */
export function primaryCredentialMtime(dir: string, recipe: IdentityRecipe): number | null {
  try {
    return statSync(join(dir, primaryCredentialFile(recipe))).mtimeMs;
  } catch {
    return null;
  }
}

/** Whether a directory exists and is non-empty (used to answer "is this a home?"). */
export function dirExistsNonEmpty(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}
