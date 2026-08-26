/**
 * Per-harness identity recipes (spec 08 "Vault"): how a provider's login
 * materializes on disk, so the login seat can capture credentials out of a
 * home into the vault and activation can copy them back into an EMPTY home.
 * Ported from the old src/drivers.ts `identity` table — data only.
 *
 * `credentialFiles[0]` is the PRIMARY credential: a home/vault without it is
 * not logged in (the rest are supporting snapshots). `configFiles` are
 * preserved when present but never gate anything.
 */
import { HARNESS_HOME_ENV } from "./import-frozen.ts";

export interface IdentityRecipe {
  /** Home-relative credential files; the same relative paths are used inside the vault. */
  credentialFiles: string[];
  /** Extra home-relative copies written on activation, keyed by canonical credential file. */
  activationMirrors?: Record<string, string>;
  /** Non-credential, home-relative config files preserved with an account. */
  configFiles?: string[];
  /** Explicit extra env for activated spawns. "{home}" expands to the home path. */
  extraEnv?: Record<string, string>;
  /**
   * The harness's own login invocation for the login seat. Prefer a native
   * login subcommand when the harness exposes one; bare interactive TUIs are
   * reserved for tools whose login still lives in the TUI. Node config
   * `agents.<a>.login` overrides it.
   */
  login: { command: string; args: string[] };
}

export const ACCOUNT_RECIPES: Readonly<Record<string, IdentityRecipe>> = {
  claude: {
    // With CLAUDE_CONFIG_DIR set, all three live inside the config dir. On
    // macOS the OAuth credential itself is the Keychain item for the home
    // (see daemon keychain.ts); the vault keeps it as .credentials.json.
    credentialFiles: [".credentials.json", ".claude.json", "settings.json"],
    // Claude Code 2.1.x exposes this directly. Starting the auth flow avoids
    // relying on a correctly-timed `/login` keystroke after TUI boot.
    login: { command: "claude", args: ["auth", "login"] },
  },
  codex: {
    credentialFiles: ["auth.json"],
    // Keep the legacy mirror for older Codex auth discovery, but do not set
    // HOME: developer tools inside Codex must see the user's real home.
    activationMirrors: { "auth.json": ".codex/auth.json" },
    configFiles: ["config.toml"],
    login: { command: "codex", args: ["login"] },
  },
  opencode: {
    // opencode keeps auth under $XDG_DATA_HOME/opencode/auth.json; the
    // activated home carries a private xdg-data/ subtree for it.
    credentialFiles: ["xdg-data/opencode/auth.json"],
    extraEnv: { XDG_DATA_HOME: "{home}/xdg-data" },
    login: { command: "opencode", args: ["auth", "login"] },
  },
  grok: {
    credentialFiles: ["auth.json"],
    configFiles: ["config.toml"],
    login: { command: "grok", args: [] },
  },
  kimi: {
    credentialFiles: ["credentials/kimi-code.json"],
    configFiles: ["config.toml", "tui.toml"],
    login: { command: "kimi", args: [] },
  },
  cursor: {
    // cursor-agent's credential store is NOT home-relative (machine-global
    // keychain / $XDG_CONFIG_HOME); the vault keeps a canonical auth.json.
    credentialFiles: ["auth.json", "cli-config.json"],
    login: { command: "cursor-agent", args: ["login"] },
  },
};

/** The env var that selects a harness's home (CLAUDE_CONFIG_DIR, CODEX_HOME, …); undefined for unknown harnesses. */
export function homeEnvFor(harness: string): string | undefined {
  return HARNESS_HOME_ENV[harness];
}

export function recipeFor(harness: string): IdentityRecipe | undefined {
  return ACCOUNT_RECIPES[harness];
}

/** The account id for (harness, label): `<harness>-<safe(label)>`, lower-cased — the old registry's rule. */
export function accountIdFor(harness: string, label: string): string {
  return safeName(`${harness}-${label.trim()}`).toLowerCase();
}

/** The old store's safeName (src/store.ts): each byte outside [A-Za-z0-9_.:-] becomes `-` (`tormod@thto.no` → `tormod-thto.no`). */
export function safeName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/g, "-");
  if (/^[.]*$/.test(sanitized)) return sanitized.replace(/[.]/g, "-") || "-";
  return sanitized;
}

/** Recipe extra env with `{home}` expanded (empty for harnesses without extras). */
export function recipeEnvFor(harness: string, homePath: string): Record<string, string> {
  const recipe = ACCOUNT_RECIPES[harness];
  if (!recipe?.extraEnv) return {};
  return Object.fromEntries(Object.entries(recipe.extraEnv).map(([k, v]) => [k, v.replaceAll("{home}", homePath)]));
}
