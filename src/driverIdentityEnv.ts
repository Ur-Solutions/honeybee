/**
 * Lightweight provider-identity environment metadata.
 *
 * The detached HSR entry imports this module before it chooses an adapter. Keep
 * it free of driver/adapter imports so loading one provider never evaluates all
 * sibling adapters (or the parent CLI graph).
 */
const DRIVER_IDENTITY_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  claude: ["CLAUDE_CONFIG_DIR"],
  codex: ["CODEX_HOME"],
  opencode: ["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"],
  grok: ["GROK_HOME"],
  kimi: ["KIMI_CODE_HOME"],
  cursor: ["CURSOR_AUTH_TOKEN", "CURSOR_API_KEY", "CURSOR_CONFIG_DIR"],
};

/** Identity-bearing environment keys authorized for exactly one driver. */
export function driverIdentityEnvKeysForAgent(kind: string): string[] {
  return [...(DRIVER_IDENTITY_ENV_KEYS[kind] ?? [])];
}

/** Every provider identity key, stable-sorted for policy construction. */
export function allDriverIdentityEnvKeys(): string[] {
  return [...new Set(Object.values(DRIVER_IDENTITY_ENV_KEYS).flat())].sort();
}
