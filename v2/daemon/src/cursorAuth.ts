/**
 * Minimal Cursor credential bridge required by spec 08.
 *
 * Cursor's login secret is machine-global (macOS Keychain, or the global
 * auth.json fallback); CURSOR_CONFIG_DIR only relocates cli-config.json. An
 * explicit account.login therefore watches this live store for digest drift
 * and snapshots the resulting auth.json into that account's one home/vault.
 * At runtime we lift the home snapshot into Cursor's documented env override
 * so two account homes do not depend on whichever identity touched the global
 * slot last.
 *
 * This intentionally does not bring back v1's credential synchronizer,
 * freshness arbitration, or background harvesting. Login is the only
 * global-store → account-home transition.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { keychainAvailable } from "./keychain.ts";

const execFileAsync = promisify(execFile);
const SECURITY_EXEC_TIMEOUT_MS = 60_000;

export interface CursorAuthSnapshot {
  raw: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  source: string;
}

export type CursorAuthReader = () => Promise<CursorAuthSnapshot | null>;

/** Parse Cursor's own auth.json shape. A refresh token alone cannot authenticate a run. */
export function parseCursorAuth(raw: string | null, source = "auth.json"): CursorAuthSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const accessToken = typeof value.accessToken === "string" && value.accessToken.length > 0 ? value.accessToken : undefined;
    const refreshToken = typeof value.refreshToken === "string" && value.refreshToken.length > 0 ? value.refreshToken : undefined;
    const apiKey = typeof value.apiKey === "string" && value.apiKey.length > 0 ? value.apiKey : undefined;
    if (!accessToken && !apiKey) return null;
    return {
      raw,
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(apiKey ? { apiKey } : {}),
      source,
    };
  } catch {
    return null;
  }
}

function cursorGlobalAuthPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.HIVE_CURSOR_AUTH_PATH?.trim();
  if (override) return override;
  if (process.platform === "darwin") return join(homedir(), ".cursor", "auth.json");
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "cursor", "auth.json");
}

function readCursorAuthFile(path: string): CursorAuthSnapshot | null {
  try {
    if (!statSync(path).isFile()) return null;
    return parseCursorAuth(readFileSync(path, "utf8"), path);
  } catch {
    return null;
  }
}

async function readCursorKeychainSecret(service: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-a", "cursor-user", "-s", service, "-w"],
      { timeout: SECURITY_EXEC_TIMEOUT_MS },
    );
    const value = String(stdout).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Read the live credential store written by `cursor-agent login`. */
export const readCursorLiveAuth: CursorAuthReader = async () => {
  if (keychainAvailable()) {
    const [accessToken, refreshToken, apiKey] = await Promise.all([
      readCursorKeychainSecret("cursor-access-token"),
      readCursorKeychainSecret("cursor-refresh-token"),
      readCursorKeychainSecret("cursor-api-key"),
    ]);
    if (accessToken || apiKey) {
      const raw = `${JSON.stringify({
        ...(accessToken ? { accessToken } : {}),
        ...(refreshToken ? { refreshToken } : {}),
        ...(apiKey ? { apiKey } : {}),
      }, null, 2)}\n`;
      const parsed = parseCursorAuth(raw, "keychain");
      if (parsed) return parsed;
    }
  }
  return readCursorAuthFile(cursorGlobalAuthPath());
};

/** Runtime-only secret env derived from an account's authoritative home. */
export function cursorCredentialEnv(homePath: string): Record<string, string> {
  const auth = readCursorAuthFile(join(homePath, "auth.json"));
  if (auth?.apiKey) return { CURSOR_API_KEY: auth.apiKey };
  if (auth?.accessToken) return { CURSOR_AUTH_TOKEN: auth.accessToken };
  return {};
}
