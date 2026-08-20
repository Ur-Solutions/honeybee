/**
 * Auto-titler: untitled active bees get a semantic title from their mailbox
 * once there is a real task signal. A thin first opener ("hi") defers until
 * a later message. Generation shells out, so at most one subprocess is in
 * flight; outcomes surface on a later tick.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BeeRow, CoreStore, MessageRow } from "../../core/src/index.ts";
import type { ResolvedNamingConfig } from "./config.ts";
import {
  clampUserMessage,
  generateTitle,
  isThinOpener,
  type TitleContext,
} from "./naming.ts";

export type AutoTitleOutcome = {
  beeId: string;
  ok: boolean;
  title?: string;
  skipped?: string;
  error?: string;
};

export type AutoTitleBookkeeping = {
  attempts: number;
  lastAt: number;
  userTurns: number;
  deferred: boolean;
  signature: string;
};

export type AutoTitleDeps = {
  enabled: () => boolean;
  naming: () => ResolvedNamingConfig;
  listBees: () => BeeRow[];
  listMessages: (beeId: string) => MessageRow[];
  getBee: (beeId: string) => BeeRow | null;
  setTitle: (beeId: string, title: string) => { applied: boolean };
  loadState: (beeId: string) => AutoTitleBookkeeping | undefined;
  saveState: (beeId: string, state: AutoTitleBookkeeping) => void;
  generate: (context: TitleContext) => Promise<string>;
  now: () => number;
  log: (op: string) => void;
};

export const MAX_AUTO_TITLE_ATTEMPTS = 3;
export const AUTO_TITLE_RETRY_BACKOFF_MS = 10 * 60_000;
export const AUTO_TITLE_WATCHDOG_MS = 2 * 60_000;
export const AUTO_TITLE_CONTEXT_PROBES_PER_TICK = 1;

export function userTaskMessages(messages: readonly MessageRow[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const text = clampUserMessage(message.body);
    if (text) out.push(text);
  }
  return out;
}

export function contextSignature(bee: BeeRow, userMessages: readonly string[]): string {
  return [bee.lifecycle, String(bee.lastOutputAt ?? ""), String(userMessages.length), userMessages[0] ?? ""].join(
    "\0",
  );
}

/**
 * Ready to generate now? Substantial first message waits for output (or a
 * second user turn). A thin opener waits for the second user message.
 */
export function autoTitleDecision(
  bee: BeeRow,
  userMessages: readonly string[],
  bookkeeping: AutoTitleBookkeeping | undefined,
  now: number,
): { action: "skip"; reason: string } | { action: "defer"; reason: string } | { action: "generate" } {
  if (bee.lifecycle !== "active") return { action: "skip", reason: "not active" };
  if (bee.title) return { action: "skip", reason: "already titled" };
  if ((bookkeeping?.attempts ?? 0) >= MAX_AUTO_TITLE_ATTEMPTS) return { action: "skip", reason: "attempt cap" };
  if (bookkeeping?.lastAt && now - bookkeeping.lastAt < AUTO_TITLE_RETRY_BACKOFF_MS && !bookkeeping.deferred) {
    return { action: "skip", reason: "backoff" };
  }
  if (userMessages.length === 0) return { action: "defer", reason: "no user message" };
  if (userMessages.length === 1 && isThinOpener(userMessages[0]!)) {
    return { action: "defer", reason: "thin opener" };
  }
  if (userMessages.length === 1 && bee.lastOutputAt == null) {
    return { action: "defer", reason: "waiting for output" };
  }
  return { action: "generate" };
}

export function createAutoTitleDispatcher(deps: AutoTitleDeps): (bees?: BeeRow[]) => Promise<AutoTitleOutcome[]> {
  let inFlight = false;
  let inFlightSince = 0;
  let inFlightBee = "";
  let inFlightToken = 0;
  let nextInFlightToken = 0;
  const finished: AutoTitleOutcome[] = [];

  return async (bees) => {
    const outcomes = finished.splice(0);
    if (!deps.enabled()) return outcomes;

    const now = deps.now();
    if (inFlight) {
      if (now - inFlightSince < AUTO_TITLE_WATCHDOG_MS) return outcomes;
      const staleBee = inFlightBee;
      inFlight = false;
      inFlightSince = 0;
      inFlightBee = "";
      inFlightToken = 0;
      outcomes.push({
        beeId: staleBee,
        ok: false,
        error: `generation watchdog fired after ${AUTO_TITLE_WATCHDOG_MS}ms; freeing the slot`,
      });
    }

    const records = bees ?? deps.listBees();
    let probes = 0;
    for (const candidate of records) {
      if (probes >= AUTO_TITLE_CONTEXT_PROBES_PER_TICK) break;
      const bee = deps.getBee(candidate.id) ?? candidate;
      const userMessages = userTaskMessages(deps.listMessages(bee.id));
      const signature = contextSignature(bee, userMessages);
      const bookkeeping = deps.loadState(bee.id);
      if (bookkeeping?.signature === signature && bookkeeping.deferred) {
        // Same mailbox/output snapshot we already deferred on.
        continue;
      }
      const decision = autoTitleDecision(bee, userMessages, bookkeeping, now);
      if (decision.action === "skip") continue;
      probes += 1;
      if (decision.action === "defer") {
        deps.saveState(bee.id, {
          attempts: bookkeeping?.attempts ?? 0,
          lastAt: bookkeeping?.lastAt ?? 0,
          userTurns: userMessages.length,
          deferred: true,
          signature,
        });
        continue;
      }

      const claimed: AutoTitleBookkeeping = {
        attempts: (bookkeeping?.attempts ?? 0) + 1,
        lastAt: now,
        userTurns: userMessages.length,
        deferred: false,
        signature,
      };
      deps.saveState(bee.id, claimed);

      inFlight = true;
      inFlightSince = now;
      inFlightBee = bee.id;
      const generationToken = ++nextInFlightToken;
      inFlightToken = generationToken;
      const context: TitleContext = { userMessages: userMessages.slice(-3) };
      void Promise.resolve()
        .then(() => deps.generate(context))
        .then((title) => {
          const fresh = deps.getBee(bee.id);
          if (!fresh) {
            finished.push({ beeId: bee.id, ok: false, skipped: "record removed while generating" });
            return;
          }
          if (fresh.title) {
            finished.push({ beeId: bee.id, ok: false, skipped: "title set while generating" });
            return;
          }
          deps.setTitle(bee.id, title);
          deps.log(`autoTitle bee=${bee.id} title=${JSON.stringify(title)}`);
          finished.push({ beeId: bee.id, ok: true, title });
        })
        .catch((error) => {
          finished.push({
            beeId: bee.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
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

export function createStoreAutoTitleDispatcher(
  store: CoreStore,
  options: {
    naming: () => ResolvedNamingConfig;
    statePath: string;
    now?: () => number;
    log?: (op: string) => void;
    generate?: (context: TitleContext) => Promise<string>;
  },
): (bees?: BeeRow[]) => Promise<AutoTitleOutcome[]> {
  const state = loadBookkeepingFile(options.statePath);
  return createAutoTitleDispatcher({
    enabled: () => options.naming().auto,
    naming: options.naming,
    listBees: () => store.listBees(),
    listMessages: (beeId) => store.listMessages(beeId),
    getBee: (beeId) => store.getBee(beeId),
    setTitle: (beeId, title) => store.setBeeTitle(beeId, title, "auto"),
    loadState: (beeId) => state.get(beeId),
    saveState: (beeId, next) => {
      state.set(beeId, next);
      persistBookkeepingFile(options.statePath, state);
    },
    generate:
      options.generate ??
      ((context) => generateTitle(context, { config: options.naming() })),
    now: options.now ?? Date.now,
    log: options.log ?? (() => undefined),
  });
}

function loadBookkeepingFile(path: string): Map<string, AutoTitleBookkeeping> {
  const map = new Map<string, AutoTitleBookkeeping>();
  if (!existsSync(path)) return map;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    for (const [beeId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (typeof row.attempts !== "number" || typeof row.lastAt !== "number") continue;
      map.set(beeId, {
        attempts: row.attempts,
        lastAt: row.lastAt,
        userTurns: typeof row.userTurns === "number" ? row.userTurns : 0,
        deferred: row.deferred === true,
        signature: typeof row.signature === "string" ? row.signature : "",
      });
    }
  } catch {
    // Corrupt sidecar: start empty; the next save overwrites it.
  }
  return map;
}

function persistBookkeepingFile(path: string, state: Map<string, AutoTitleBookkeeping>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const object: Record<string, AutoTitleBookkeeping> = {};
    for (const [beeId, row] of state) object[beeId] = row;
    writeFileSync(path, `${JSON.stringify(object)}\n`);
  } catch {
    // Bookkeeping is best-effort; a failed write retries next claim.
  }
}
