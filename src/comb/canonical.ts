import { createHash } from "node:crypto";
import type { JsonValue } from "./types.js";

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortValue(value));
}

export function canonicalDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key] as JsonValue)]));
  }
  return value;
}

export function assertCanonicalData(value: unknown, path = "$", seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: non-finite numbers are not valid comb data`);
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${path}: ${typeof value} is not valid comb data`);
  }
  if (seen.has(value)) throw new Error(`${path}: cyclic values are not valid comb data`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCanonicalData(entry, `${path}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertCanonicalData(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}
