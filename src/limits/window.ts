// ──────────────────────────────────────────────────────────────────────────
// Pure math over a usage window (WindowUsage): how a snapshot's used% relates
// to how much of the window has elapsed. Shared by the auto pick (effective
// load) and the usage display (pace/rollover badges).
// ──────────────────────────────────────────────────────────────────────────

import type { WindowUsage } from "./types.js";

/**
 * Pace: used% minus elapsed% of the window. Positive = burning faster than
 * the window refills (on track to exhaust before reset); negative = headroom.
 * Null when the window boundary is unknown or already passed.
 */
export function paceDelta(window: WindowUsage, now = Date.now()): number | null {
  if (!window.resetsAt || !window.windowMinutes) return null;
  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= now) return null;
  const durationMs = window.windowMinutes * 60_000;
  const elapsedPct = Math.min(100, Math.max(0, ((durationMs - (resetMs - now)) / durationMs) * 100));
  return window.usedPercent - elapsedPct;
}

/** True when the snapshot's window boundary has passed — its used% no longer applies. */
export function windowRolledOver(window: WindowUsage, now = Date.now()): boolean {
  if (!window.resetsAt) return false;
  const resetMs = Date.parse(window.resetsAt);
  return Number.isFinite(resetMs) && resetMs <= now;
}
