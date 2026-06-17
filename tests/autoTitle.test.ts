import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_TITLE_RETRY_BACKOFF_MS,
  AUTO_TITLE_WATCHDOG_MS,
  createAutoTitleDispatcher,
  isAutoTitleCandidate,
  MAX_AUTO_TITLE_ATTEMPTS,
  type AutoTitleDeps,
} from "../src/daemon/autoTitle.js";
import type { TitleContext } from "../src/naming.js";
import type { SessionRecord } from "../src/store.js";

function bee(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CL.a3f",
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: "hive:CL-a3f",
    createdAt: "2026-06-10T11:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

const NOW = Date.parse("2026-06-11T10:00:00.000Z");

type Capture = {
  claims: Array<{ name: string; fields: Partial<SessionRecord> }>;
  updates: Array<{ name: string; patch: Partial<SessionRecord> }>;
};

function buildDeps(args: {
  store: Map<string, SessionRecord>;
  capture: Capture;
  contextFor?: AutoTitleDeps["contextFor"];
  generate?: AutoTitleDeps["generate"];
  enabled?: boolean;
  now?: number;
}): Partial<AutoTitleDeps> {
  return {
    enabled: () => args.enabled ?? true,
    loadSession: async (name) => args.store.get(name) ?? null,
    touchSession: async (name, fields) => {
      const existing = args.store.get(name);
      if (!existing) return null;
      args.capture.claims.push({ name, fields });
      const merged = { ...existing, ...fields };
      args.store.set(name, merged);
      return merged;
    },
    updateSession: async (name, patch) => {
      const existing = args.store.get(name);
      if (!existing) return null;
      args.capture.updates.push({ name, patch });
      const merged = { ...existing, ...patch };
      args.store.set(name, merged);
      return merged;
    },
    contextFor: args.contextFor ?? (async () => ({ brief: "fix things" })),
    generate: args.generate ?? (async () => "Generated title"),
    mirrorTitle: async () => undefined,
    now: () => args.now ?? NOW,
  };
}

async function settle(): Promise<void> {
  // Generation runs detached from the dispatch call; let its promise chain flush.
  await new Promise((resolve) => setImmediate(resolve));
}

/* ----------------------------- eligibility ------------------------------ */

test("isAutoTitleCandidate: untitled and unattempted is eligible", () => {
  assert.equal(isAutoTitleCandidate(bee(), NOW), true);
});

test("isAutoTitleCandidate: any existing title (or source) is done", () => {
  assert.equal(isAutoTitleCandidate(bee({ title: "x" }), NOW), false);
  assert.equal(isAutoTitleCandidate(bee({ titleSource: "auto" }), NOW), false);
  assert.equal(isAutoTitleCandidate(bee({ titleSource: "user", title: "x" }), NOW), false);
});

test("isAutoTitleCandidate: respects the attempt cap", () => {
  assert.equal(isAutoTitleCandidate(bee({ autoTitleAttempts: MAX_AUTO_TITLE_ATTEMPTS - 1, autoTitleAt: new Date(NOW - AUTO_TITLE_RETRY_BACKOFF_MS).toISOString() }), NOW), true);
  assert.equal(isAutoTitleCandidate(bee({ autoTitleAttempts: MAX_AUTO_TITLE_ATTEMPTS }), NOW), false);
});

test("isAutoTitleCandidate: backoff gates retries between attempts", () => {
  const recent = new Date(NOW - 60_000).toISOString(); // 1 min ago
  const old = new Date(NOW - AUTO_TITLE_RETRY_BACKOFF_MS - 1).toISOString();
  assert.equal(isAutoTitleCandidate(bee({ autoTitleAttempts: 1, autoTitleAt: recent }), NOW), false);
  assert.equal(isAutoTitleCandidate(bee({ autoTitleAttempts: 1, autoTitleAt: old }), NOW), true);
});

/* ------------------------------ dispatch -------------------------------- */

test("auto-title: claims (attempt #1), generates in the background, reports next tick", async () => {
  const record = bee({ brief: "fix things" });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture }));

  assert.deepEqual(await dispatch([record]), []);
  assert.equal(capture.claims.length, 1);
  assert.ok(capture.claims[0]!.fields.autoTitleAt);
  assert.equal(capture.claims[0]!.fields.autoTitleAttempts, 1);

  await settle();
  const outcomes = await dispatch([store.get(record.name)!]);
  assert.deepEqual(outcomes, [{ bee: record.name, ok: true, title: "Generated title" }]);
  assert.equal(capture.updates[0]!.patch.title, "Generated title");
  assert.equal(capture.updates[0]!.patch.titleSource, "auto");

  // Titled now — no further attempts.
  assert.deepEqual(await dispatch([store.get(record.name)!]), []);
  assert.equal(capture.claims.length, 1);
});

test("auto-title: skips already-titled and capped bees", async () => {
  const records = [
    bee({ name: "titled", title: "Has one" }),
    bee({ name: "sourced", titleSource: "user", title: "Mine" }),
    bee({ name: "capped", autoTitleAttempts: MAX_AUTO_TITLE_ATTEMPTS }),
    bee({ name: "backoff", autoTitleAttempts: 1, autoTitleAt: new Date(NOW - 60_000).toISOString() }),
  ];
  const store = new Map(records.map((r) => [r.name, r]));
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture }));

  assert.deepEqual(await dispatch(records), []);
  await settle();
  assert.equal(capture.claims.length, 0);
});

test("auto-title: retries a previously-failed bee once past the backoff window", async () => {
  // A bee that failed once: attempts=1, last attempt older than the backoff.
  const record = bee({ autoTitleAttempts: 1, autoTitleAt: new Date(NOW - AUTO_TITLE_RETRY_BACKOFF_MS - 1).toISOString() });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture }));

  await dispatch([record]);
  assert.equal(capture.claims.length, 1);
  assert.equal(capture.claims[0]!.fields.autoTitleAttempts, 2, "second attempt bumps the counter");
  await settle();
  const outcomes = await dispatch([store.get(record.name)!]);
  assert.equal(outcomes[0]?.ok, true);
});

test("auto-title: failure reports the error and the claim persists (counts toward the cap)", async () => {
  const record = bee({ brief: "fix things" });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(
    buildDeps({ store, capture, generate: async () => { throw new Error("claude failed (exit 1): usage limit reached"); } }),
  );

  await dispatch([record]);
  await settle();
  const outcomes = await dispatch([store.get(record.name)!]);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0]?.error ?? "", /usage limit/);
  assert.equal(capture.updates.length, 0, "no title written on failure");
  assert.equal(store.get(record.name)?.autoTitleAttempts, 1, "attempt counted so the cap can engage");
});

test("auto-title: stops generating after MAX failed attempts across backoff windows", async () => {
  const record = bee();
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  let attempts = 0;
  // One round past the cap; each round advances `now` beyond the backoff so
  // only the attempt cap (not the backoff) can stop it.
  let now = NOW;
  for (let round = 0; round < MAX_AUTO_TITLE_ATTEMPTS + 1; round += 1) {
    const dispatch = createAutoTitleDispatcher(
      buildDeps({ store, capture, now, generate: async () => { attempts += 1; throw new Error("boom"); } }),
    );
    await dispatch([store.get(record.name)!]);
    await settle();
    now += AUTO_TITLE_RETRY_BACKOFF_MS + 1;
  }
  assert.equal(attempts, MAX_AUTO_TITLE_ATTEMPTS, "generation stops once the cap is hit");
  assert.equal(store.get(record.name)?.autoTitleAttempts, MAX_AUTO_TITLE_ATTEMPTS);
});

test("auto-title: stale in-memory record is re-read before claiming", async () => {
  const stale = bee();
  const fresh = { ...stale, title: "Provider title", titleSource: "provider" as const };
  const store = new Map([[stale.name, fresh]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture }));

  assert.deepEqual(await dispatch([stale]), []);
  await settle();
  assert.equal(capture.claims.length, 0);
});

test("auto-title: defers while the initial exchange is missing; titles once it lands", async () => {
  const record = bee();
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  let ready = false;
  const dispatch = createAutoTitleDispatcher(
    buildDeps({ store, capture, contextFor: async () => (ready ? { brief: "go" } : null) }),
  );

  await dispatch([record]);
  assert.equal(capture.claims.length, 0);

  ready = true;
  await dispatch([store.get(record.name)!]);
  assert.equal(capture.claims.length, 1);
  await settle();
  assert.equal((await dispatch([store.get(record.name)!]))[0]?.ok, true);
});

test("auto-title: disabled config does nothing", async () => {
  const record = bee({ brief: "fix things" });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture, enabled: false }));

  assert.deepEqual(await dispatch([record]), []);
  assert.equal(capture.claims.length, 0);
});

test("auto-title: a user title set during generation wins", async () => {
  const record = bee({ brief: "fix things" });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => { release = resolve; });
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture, generate: () => gate }));

  await dispatch([record]);
  store.set(record.name, { ...store.get(record.name)!, title: "Mine", titleSource: "user" });
  release("Generated title");
  await settle();

  const outcomes = await dispatch([store.get(record.name)!]);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0]?.skipped ?? "", /user title/);
  assert.equal(store.get(record.name)?.title, "Mine");
});

test("auto-title: a never-settling generation is freed by the watchdog, not wedged forever", async () => {
  const a = bee({ name: "a", tmuxTarget: "hive:a", brief: "task a" });
  const b = bee({ name: "b", tmuxTarget: "hive:b", brief: "task b" });
  const store = new Map([[a.name, a], [b.name, b]]);
  const capture: Capture = { claims: [], updates: [] };
  // Single dispatcher (the watchdog state is per-instance) with a mutable clock.
  let clock = NOW;
  let calls = 0;
  const dispatch = createAutoTitleDispatcher({
    ...buildDeps({ store, capture }),
    now: () => clock,
    // The first generation hangs forever; the next resolves.
    generate: () => { calls += 1; return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("Title"); },
  });
  const args = () => [store.get(a.name)!, store.get(b.name)!];

  await dispatch(args()); // claims `a`; its generation never settles
  assert.equal(capture.claims.length, 1);

  clock += AUTO_TITLE_WATCHDOG_MS - 1; // still inside the window
  await dispatch(args());
  assert.equal(capture.claims.length, 1, "still in-flight within the watchdog window");

  clock += 2; // past the window
  const outcomes = await dispatch(args());
  assert.ok(outcomes.some((o) => o.bee === "a" && /watchdog/.test(o.error ?? "")), "stale slot is reported");
  assert.equal(capture.claims.length, 2, "the slot is freed so another bee can be claimed");
});

test("auto-title: mirrorTitle receives the fresh record + title, and a throwing mirror still yields ok", async () => {
  const record = bee({ brief: "fix things" });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  const mirrored: Array<{ name: string; title: string }> = [];
  const deps = buildDeps({ store, capture });
  deps.mirrorTitle = async (rec, title) => {
    mirrored.push({ name: rec.name, title });
    throw new Error("tmux mirror failed");
  };
  const dispatch = createAutoTitleDispatcher(deps);

  await dispatch([record]);
  await settle();
  const outcomes = await dispatch([store.get(record.name)!]);
  assert.deepEqual(outcomes, [{ bee: record.name, ok: true, title: "Generated title" }], "a throwing mirror does not break the outcome");
  assert.deepEqual(mirrored, [{ name: record.name, title: "Generated title" }]);
  assert.equal(store.get(record.name)?.title, "Generated title");
});

test("auto-title: one generation in flight at a time", async () => {
  const a = bee({ name: "a", tmuxTarget: "hive:a", brief: "task a" });
  const b = bee({ name: "b", tmuxTarget: "hive:b", brief: "task b" });
  const store = new Map([[a.name, a], [b.name, b]]);
  const capture: Capture = { claims: [], updates: [] };
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => { release = resolve; });
  let calls = 0;
  const dispatch = createAutoTitleDispatcher(
    buildDeps({ store, capture, generate: () => { calls += 1; return calls === 1 ? gate : Promise.resolve("Title B"); } }),
  );

  await dispatch([a, b]);
  assert.equal(capture.claims.length, 1, "only the first candidate is claimed");
  await dispatch([store.get(a.name)!, store.get(b.name)!]);
  assert.equal(calls, 1, "no second generation while one is in flight");

  release("Title A");
  await settle();
  const afterA = await dispatch([store.get(a.name)!, store.get(b.name)!]);
  assert.deepEqual(afterA, [{ bee: "a", ok: true, title: "Title A" }]);
  await settle();
  const afterB = await dispatch([store.get(a.name)!, store.get(b.name)!]);
  assert.deepEqual(afterB, [{ bee: "b", ok: true, title: "Title B" }]);
});
