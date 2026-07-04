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

/** The reporting bucket size. "day" is a YYYY-MM-DD, "week" an ISO week
 * (YYYY-Www), "month" a YYYY-MM. */
export type Granularity = "day" | "week" | "month";

/**
 * Fold an Oslo calendar day (YYYY-MM-DD) into its reporting-period label for the
 * given granularity: the day itself, its ISO-8601 week ("2026-W27"), or its
 * month ("2026-07"). Returns the input unchanged if it isn't a parseable date.
 */
export function periodOf(day: string, granularity: Granularity): string {
  if (granularity === "month") return day.slice(0, 7);
  if (granularity === "week") return isoWeekLabel(day);
  return day;
}

/** ISO-8601 week label ("YYYY-Www") for a YYYY-MM-DD day. */
function isoWeekLabel(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  // Thursday of the target day's week determines its ISO week-year.
  const thursday = new Date(ms);
  const dayNum = (thursday.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  thursday.setUTCDate(thursday.getUTCDate() - dayNum + 3);
  const isoYear = thursday.getUTCFullYear();
  // Week 1 is the week containing Jan 4; anchor on its Thursday.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Every calendar day (YYYY-MM-DD) that belongs to a period label: the day
 * itself for "day", the 1..N days of the month for "month", or Monday..Sunday
 * of the ISO week for "week". Returns [] for a label that doesn't match the
 * granularity. Used to render a dense sparkline over an entire period.
 */
export function daysInPeriod(period: string, granularity: Granularity): string[] {
  if (granularity === "day") return /^\d{4}-\d{2}-\d{2}$/.test(period) ? [period] : [];
  if (granularity === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(period);
    if (!m) return [];
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-based
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month
    const days: string[] = [];
    for (let d = 1; d <= last; d += 1) days.push(`${period}-${String(d).padStart(2, "0")}`);
    return days;
  }
  const m = /^(\d{4})-W(\d{2})$/.exec(period);
  if (!m) return [];
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const start = new Date(week1Monday);
  start.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const days: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
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
