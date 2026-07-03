import type { SealRecord } from "../seal.js";
import type { SearchOptions } from "../search.js";
import type { SessionRecord } from "../store.js";

export function sealHaystack(record: SealRecord): string {
  // Concatenate every searchable field into a single string. Order matters only
  // for snippet quality (matches earlier in the string get more "after" room).
  const parts: string[] = [
    record.beeName,
    record.status,
    record.summary,
    record.type ?? "",
    (record.filesChanged ?? []).join(" "),
    (record.risks ?? []).join(" "),
    (record.nextActions ?? []).join(" "),
    ...(record.testsRun ?? []).map((t) => `${t.command} ${t.result} ${t.notes ?? ""}`),
  ];
  return redactSearchText(parts.filter((p) => p && p.length > 0).join("\n"));
}

export function sessionHaystack(record: SessionRecord): string {
  const parts: string[] = [
    record.name,
    record.agent,
    record.command,
    record.cwd,
    record.title ?? "",
    record.lastPrompt ?? "",
    record.brief ?? "",
    record.notes ?? "",
  ];
  return redactSearchText(parts.filter((p) => p && p.length > 0).join("\n"));
}

const REDACTED = "[redacted]";
const SECRET_ASSIGNMENT_RE = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',;)}\]]+/gi;
const BEARER_SECRET_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi;
const KNOWN_SECRET_VALUE_RE = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9][A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export function redactSearchText(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT_RE, `$1${REDACTED}`)
    .replace(BEARER_SECRET_RE, `$1${REDACTED}`)
    .replace(KNOWN_SECRET_VALUE_RE, REDACTED)
    .replace(JWT_RE, REDACTED);
}

export function passesLedgerFilters(parsed: Record<string, unknown> | undefined, options: SearchOptions): boolean {
  // The ledger is JSONL; the reader parses each row once and passes the object
  // through. Bad lines are skipped silently when structured filters are needed
  // because we never want one malformed row to abort a long search.
  if (!options.colony && !options.swarm && !options.bee) return true;
  if (!parsed) return false;
  if (options.colony && parsed.colony !== options.colony) return false;
  if (options.swarm && parsed.swarmId !== options.swarm && parsed.swarm !== options.swarm) return false;
  if (options.bee) {
    const session = typeof parsed.session === "string" ? parsed.session : undefined;
    const name = typeof parsed.name === "string" ? parsed.name : undefined;
    if (session !== options.bee && name !== options.bee) return false;
  }
  return true;
}
