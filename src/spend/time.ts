// ──────────────────────────────────────────────────────────────────────────
// Day bucketing. All spend reports bucket by Europe/Oslo calendar day so a
// session that crosses local midnight lands on the right day regardless of the
// machine's own timezone. Uses Intl (no external tz database dependency).
// ──────────────────────────────────────────────────────────────────────────

const OSLO = "Europe/Oslo";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: OSLO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The Europe/Oslo calendar day (YYYY-MM-DD) for an ISO timestamp or epoch ms.
 * Returns null for an unparseable input rather than guessing a day.
 */
export function osloDay(input: string | number): string | null {
  const ms = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  // en-CA formats as YYYY-MM-DD.
  return dayFormatter.format(new Date(ms));
}

/** USD/day for a monthly subscription, using a 365-day year (monthly*12/365). */
export function dailyProration(monthlyUsd: number): number {
  return (monthlyUsd * 12) / 365;
}

/**
 * Enumerate Oslo calendar days from `startDay` to `endDay` inclusive (both
 * YYYY-MM-DD). Used to build a dense leverage series (days with no spend still
 * carry subscription cost). Anchored at noon UTC to avoid DST edge slips.
 */
export function daysBetween(startDay: string, endDay: string): string[] {
  const days: string[] = [];
  let cursor = Date.parse(`${startDay}T12:00:00Z`);
  const end = Date.parse(`${endDay}T12:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end)) return days;
  while (cursor <= end) {
    const day = osloDay(cursor);
    if (day) days.push(day);
    cursor += 24 * 60 * 60 * 1000;
  }
  return days;
}
