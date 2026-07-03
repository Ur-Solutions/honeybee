import type { AccountRecord } from "./registry.js";

// Small, provider-agnostic helpers shared across the account modules.

export function accountEmail(account: Pick<AccountRecord, "email" | "label">): string | undefined {
  return account.email ?? (account.label.includes("@") ? account.label : undefined);
}

export function emailFromJwt(jwt: string): string | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof decoded.email === "string" ? decoded.email : null;
  } catch {
    return null;
  }
}

export function parseTimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
