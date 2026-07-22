export const PROTECTED_SPAWN_ENV_KEYS = new Set([
  "HIVE_BEE",
  "HIVE_BEE_ID",
  "HIVE_PARENT",
  "HIVE_COMB",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_CONFIG_DIR",
  "GROK_HOME",
  "KIMI_CODE_HOME",
  "CURSOR_CONFIG_DIR",
]);

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function assertCallerEnvAllowed(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) throw new Error(`Invalid spawn env key "${key}"; expected [A-Za-z_][A-Za-z0-9_]*`);
    if (value.includes("\0")) throw new Error(`Invalid spawn env value for ${key}: NUL bytes are not allowed`);
    if (PROTECTED_SPAWN_ENV_KEYS.has(key)) {
      throw new Error(`Spawn env may not override honeybee-owned key ${key}`);
    }
  }
}

export function parseEnvAssignments(assignments: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid --env value "${assignment}"; expected KEY=VALUE`);
    env[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  assertCallerEnvAllowed(env);
  return env;
}

export function mergeCallerEnv(target: Record<string, string>, callerEnv: Record<string, string> | undefined): void {
  if (!callerEnv) return;
  assertCallerEnvAllowed(callerEnv);
  Object.assign(target, callerEnv);
}
