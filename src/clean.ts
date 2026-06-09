import type { SessionRecord } from "./store.js";
import { formatRelativeTime } from "./format.js";

export function deadSessionRecords(records: SessionRecord[], liveTargets: Set<string>): SessionRecord[] {
  return records.filter((record) => !liveTargets.has(record.tmuxTarget));
}

export function olderThanMillis(records: SessionRecord[], ageMs: number, now = Date.now()): SessionRecord[] {
  return records.filter((record) => {
    const ts = Date.parse(record.updatedAt);
    return Number.isFinite(ts) && now - ts >= ageMs;
  });
}

export function deadSessionAge(record: SessionRecord, now = Date.now()): string {
  return formatRelativeTime(record.updatedAt, now);
}

export function idleSessionAge(record: SessionRecord, now = Date.now()): string {
  return formatRelativeTime(idleAgeSource(record), now);
}

export function idleOlderThanMillis(records: SessionRecord[], ageMs: number, now = Date.now()): SessionRecord[] {
  return records.filter((record) => {
    const ts = Date.parse(idleAgeSource(record));
    return Number.isFinite(ts) && now - ts >= ageMs;
  });
}

export function idleAgeSource(record: SessionRecord): string {
  return record.lastPromptAt ?? record.updatedAt;
}

export function parseAge(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|mo|y)$/i);
  if (!match) throw new Error(`Invalid age duration: ${value}. Use values like 30m, 2h, 7d, or 4w.`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[unit]!;
}
