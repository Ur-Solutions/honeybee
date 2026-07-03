/**
 * Credential-parameter normalization for the runner-host control plane (APIA-93).
 * Split out of remoteHost.ts so the controller stays focused on RPC wiring. The
 * runner host receives an untyped `creds` RPC param (opaque, base64 in transit)
 * and must validate it into a DeliveredCredentials before writing anything into a
 * bee's isolated home. Node builtins only (bundle-safe).
 */

import type { DeliveredCredentials, EphemeralCredentialFile } from "./remoteCreds.js";

/**
 * Validate the untyped `creds` RPC param into a DeliveredCredentials, dropping
 * malformed entries. Never throws and never logs the (opaque) credential bytes.
 */
export function normalizeCreds(value: unknown): DeliveredCredentials | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as { files?: unknown; env?: unknown };
  const files: EphemeralCredentialFile[] = [];
  if (Array.isArray(object.files)) {
    for (const entry of object.files) {
      if (!entry || typeof entry !== "object") continue;
      const f = entry as Record<string, unknown>;
      if (typeof f.homeRelPath !== "string" || typeof f.contentB64 !== "string") continue;
      // Reject path escapes so a delivered file can never land outside the home.
      if (f.homeRelPath.startsWith("/") || f.homeRelPath.split("/").includes("..")) continue;
      files.push({
        homeRelPath: f.homeRelPath,
        contentB64: f.contentB64,
        mode: typeof f.mode === "number" ? f.mode : 0o600,
      });
    }
  }
  const env: Record<string, string> = {};
  if (object.env && typeof object.env === "object" && !Array.isArray(object.env)) {
    for (const [key, val] of Object.entries(object.env as Record<string, unknown>)) {
      if (typeof val === "string") env[key] = val;
    }
  }
  const hasEnv = Object.keys(env).length > 0;
  if (files.length === 0 && !hasEnv) return undefined;
  return { ...(files.length ? { files } : {}), ...(hasEnv ? { env } : {}) };
}
