// Auto-titling dispatcher: once an untitled bee's first user/assistant
// exchange lands in its transcript, generate a short semantic title with the
// configured cheap-model CLI (naming.ts) and persist it as titleSource:"auto".
// Stateful across ticks (build once per daemon run, like the usage sampler):
// generation shells out for seconds, so it runs in the background with at most
// one subprocess in flight, and outcomes surface on a later tick.

import { namingConfig } from "../config.js";
import { writeHiveTitle } from "../hiveState.js";
import { canWriteTitle, gatherTitleContext, generateTitle, type TitleContext } from "../naming.js";
import { loadSession, touchSession, updateSession, type SessionRecord } from "../store.js";

export type AutoTitleOutcome = {
  bee: string;
  ok: boolean;
  title?: string;
  skipped?: string;
  error?: string;
};

export type AutoTitleDeps = {
  enabled: () => boolean;
  loadSession: (name: string) => Promise<SessionRecord | null>;
  touchSession: (name: string, fields: Partial<SessionRecord>) => Promise<SessionRecord | null>;
  updateSession: (name: string, patch: Partial<SessionRecord>) => Promise<SessionRecord | null>;
  /** null = initial exchange not observable yet; the bee stays a candidate. */
  contextFor: (record: SessionRecord) => Promise<TitleContext | null>;
  generate: (context: TitleContext) => Promise<string>;
  /** Best-effort mirror of the title onto the bee's tmux session (@hive_title). */
  mirrorTitle: (record: SessionRecord, title: string) => Promise<void>;
  now: () => number;
};

export type AutoTitleDispatcher = (records: SessionRecord[]) => Promise<AutoTitleOutcome[]>;

// A failed generation (auth blip, rate limit, transient CLI error) must not
// brand a bee untitled forever. We retry a few times with a backoff between
// attempts, then give up so a genuinely un-nameable bee stops burning calls.
// `hive rename --auto` is always available as a manual override past the cap.
export const MAX_AUTO_TITLE_ATTEMPTS = 3;
export const AUTO_TITLE_RETRY_BACKOFF_MS = 10 * 60_000;

// Watchdog for the single-in-flight guard. The generator subprocess is capped
// at 60s, but if it spawns a descendant that keeps the stdio pipes open, Node
// never fires the execFile callback and the generation promise never settles —
// which would wedge `inFlight=true` and silently disable ALL auto-titling for
// the daemon's lifetime. After this long we consider the in-flight slot stale,
// report it, and free the slot so titling recovers without a daemon restart.
export const AUTO_TITLE_WATCHDOG_MS = 2 * 60_000;

/**
 * Is this bee eligible for an auto-title attempt right now? Already-titled bees
 * (any source) are done. Otherwise it must be under the attempt cap and, if a
 * prior attempt was made, past the backoff window.
 */
export function isAutoTitleCandidate(record: SessionRecord, now: number, backoffMs = AUTO_TITLE_RETRY_BACKOFF_MS): boolean {
  // Archived/dead history is immutable and cannot acquire a new exchange.
  // Scanning it on every cold daemon start only reopens old transcripts.
  if (record.status !== "running") return false;
  if (record.title || record.titleSource) return false;
  if ((record.autoTitleAttempts ?? 0) >= MAX_AUTO_TITLE_ATTEMPTS) return false;
  if (!record.autoTitleAt) return true;
  const last = Date.parse(record.autoTitleAt);
  return !Number.isFinite(last) || now - last >= backoffMs;
}

export function createAutoTitleDispatcher(overrides: Partial<AutoTitleDeps> = {}): AutoTitleDispatcher {
  const deps: AutoTitleDeps = {
    enabled: () => namingConfig().auto,
    loadSession,
    touchSession,
    updateSession,
    contextFor: (record) => gatherTitleContext(record, { requireExchange: true }),
    generate: (context) => generateTitle(context),
    mirrorTitle: (record, title) => writeHiveTitle(record, title),
    now: () => Date.now(),
    ...overrides,
  };

  let inFlight = false;
  let inFlightSince = 0;
  let inFlightBee = "";
  let inFlightToken = 0;
  let nextInFlightToken = 0;
  const finished: AutoTitleOutcome[] = [];

  return async (records) => {
    const outcomes = finished.splice(0);
    if (!deps.enabled()) return outcomes;

    const now = deps.now();
    if (inFlight) {
      // A generation that never settled (wedged subprocess) must not disable
      // titling forever — free the slot once it's clearly stale.
      if (now - inFlightSince < AUTO_TITLE_WATCHDOG_MS) return outcomes;
      const staleBee = inFlightBee;
      inFlight = false;
      inFlightSince = 0;
      inFlightBee = "";
      inFlightToken = 0;
      outcomes.push({ bee: staleBee, ok: false, error: `generation watchdog fired after ${AUTO_TITLE_WATCHDOG_MS}ms; freeing the slot` });
    }

    for (const candidate of records) {
      if (!isAutoTitleCandidate(candidate, now)) continue;
      // Re-read before deciding: this tick's transcript refresh may have just
      // written a provider title that the in-memory record predates.
      const record = await deps.loadSession(candidate.name);
      if (!record || !isAutoTitleCandidate(record, now)) continue;
      const context = await deps.contextFor(record);
      if (!context) continue;

      // Claim before the slow call (bump the attempt counter and stamp the
      // attempt time) so a crash or wedged generator can't become one
      // subprocess per tick, and so a failure counts toward the retry cap.
      const claimed = await deps.touchSession(record.name, {
        autoTitleAt: new Date(now).toISOString(),
        autoTitleAttempts: (record.autoTitleAttempts ?? 0) + 1,
      });
      if (!claimed) continue;

      inFlight = true;
      inFlightSince = now;
      inFlightBee = record.name;
      const generationToken = ++nextInFlightToken;
      inFlightToken = generationToken;
      // Promise.resolve().then(...) so even a synchronously-throwing generate
      // dep becomes a rejection routed through .catch/.finally — inFlight is
      // always reset, never stranded. The token keeps a watchdog-reclaimed
      // stale completion from clearing a newer in-flight generation.
      void Promise.resolve()
        .then(() => deps.generate(context))
        .then(async (title) => {
          const fresh = await deps.loadSession(record.name);
          if (!fresh) {
            finished.push({ bee: record.name, ok: false, skipped: "record removed while generating" });
            return;
          }
          if (!canWriteTitle(fresh, "auto")) {
            finished.push({ bee: record.name, ok: false, skipped: "user title set while generating" });
            return;
          }
          await deps.updateSession(record.name, { title, titleSource: "auto", updatedAt: new Date(deps.now()).toISOString() });
          // Fire-and-forget: the tmux mirror is best-effort and must not delay
          // (or fail) the outcome report.
          void deps.mirrorTitle(fresh, title).catch(() => undefined);
          finished.push({ bee: record.name, ok: true, title });
        })
        .catch((error) => {
          finished.push({ bee: record.name, ok: false, error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          if (inFlightToken !== generationToken) return;
          inFlight = false;
          inFlightSince = 0;
          inFlightBee = "";
          inFlightToken = 0;
        });
      break;
    }

    return outcomes;
  };
}
