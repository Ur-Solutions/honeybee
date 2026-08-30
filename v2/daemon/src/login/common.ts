/**
 * Shared vocabulary of the login runners and their service: static detail
 * copy, typed error construction, private-file writers, and the bounded,
 * token-free error text. Nothing here touches the flow row directly.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoginFlowError, LoginFlowErrorCode, LoginFlowRow } from "../../../core/src/index.ts";
import { atomicWriteFileSync } from "../homeDefaults.ts";

export const STATIC_DETAIL = {
  starting: "Starting the sign-in…",
  browser: "Finish signing in in your browser.",
  device: "Enter the code on the sign-in page.",
  code: "Paste the code from the sign-in page.",
  input: "Enter the requested details.",
  validating: "Checking the credential…",
  succeeded: "Signed in.",
} as const;

export function err(code: LoginFlowErrorCode, message: string): LoginFlowError {
  return { code, message };
}

export function isTerminal(phase: LoginFlowRow["phase"]): boolean {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled" || phase === "expired" || phase === "interrupted";
}

export function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export function writePrivateRaw(path: string, raw: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, raw, 0o600);
}

/** Bounded error text with anything token-shaped removed. */
export function safeMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return text.replace(/[A-Za-z0-9_\-]{32,}/g, "…").slice(0, 200);
}
