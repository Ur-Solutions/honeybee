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
  const finished: AutoTitleOutcome[] = [];

  return async (records) => {
    const outcomes = finished.splice(0);
    if (inFlight || !deps.enabled()) return outcomes;

    for (const candidate of records) {
      if (candidate.title || candidate.titleSource || candidate.autoTitleAt) continue;
      // Re-read before deciding: this tick's transcript refresh may have just
      // written a provider title that the in-memory record predates.
      const record = await deps.loadSession(candidate.name);
      if (!record || record.title || record.titleSource || record.autoTitleAt) continue;
      const context = await deps.contextFor(record);
      if (!context) continue;

      // Claim before the slow call so a crash or wedged generator cannot
      // become one subprocess per tick. One attempt per bee — `hive rename
      // --auto` is the manual retry.
      const claimed = await deps.touchSession(record.name, { autoTitleAt: new Date(deps.now()).toISOString() });
      if (!claimed) continue;

      inFlight = true;
      void deps
        .generate(context)
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
          inFlight = false;
        });
      break;
    }

    return outcomes;
  };
}
