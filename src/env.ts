import { userInfo } from "node:os";

/** The developer's OS account home, not a provider/account sandbox home. */
export function realUserHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.HIVE_REAL_HOME;
  if (explicit && explicit.trim().length > 0) return explicit;
  try {
    const home = userInfo().homedir;
    if (home && home.length > 0) return home;
  } catch {
    // Fall back below.
  }
  return env.HOME;
}

/**
 * Environment for launching developer tools. Provider identity env may still
 * override HOME explicitly, but inherited fake account homes do not leak onward.
 */
export function launchEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const home = realUserHome(base);
  if (home) env.HOME = home;
  return { ...env, ...extra };
}
