import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutoTitleDispatcher, type AutoTitleDeps } from "../src/daemon/autoTitle.js";
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
    now: () => Date.parse("2026-06-11T10:00:00.000Z"),
  };
}

async function settle(): Promise<void> {
  // Generation runs detached from the dispatch call; let its promise chain flush.
  await new Promise((resolve) => setImmediate(resolve));
}

test("auto-title: claims, generates in the background, reports on the next tick", async () => {
  const record = bee({ brief: "fix things" });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture }));

  assert.deepEqual(await dispatch([record]), []);
  assert.equal(capture.claims.length, 1);
  assert.ok(capture.claims[0]!.fields.autoTitleAt);

  await settle();
  const outcomes = await dispatch([store.get(record.name)!]);
  assert.deepEqual(outcomes, [{ bee: record.name, ok: true, title: "Generated title" }]);
  assert.equal(capture.updates.length, 1);
  assert.equal(capture.updates[0]!.patch.title, "Generated title");
  assert.equal(capture.updates[0]!.patch.titleSource, "auto");

  // Titled now — nothing further happens.
  assert.deepEqual(await dispatch([store.get(record.name)!]), []);
  assert.equal(capture.claims.length, 1);
});

test("auto-title: skips titled, claimed, and source-marked bees", async () => {
  const records = [
    bee({ name: "titled", title: "Has one" }),
    bee({ name: "claimed", autoTitleAt: "2026-06-11T09:00:00.000Z" }),
    bee({ name: "sourced", titleSource: "user", title: "Mine" }),
  ];
  const store = new Map(records.map((r) => [r.name, r]));
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture }));

  assert.deepEqual(await dispatch(records), []);
  await settle();
  assert.deepEqual(await dispatch(records), []);
  assert.equal(capture.claims.length, 0);
});

test("auto-title: stale in-memory record is re-read before claiming", async () => {
  const stale = bee();
  // On disk the provider already titled it this tick.
  const fresh = { ...stale, title: "Provider title", titleSource: "provider" as const };
  const store = new Map([[stale.name, fresh]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture }));

  assert.deepEqual(await dispatch([stale]), []);
  await settle();
  assert.equal(capture.claims.length, 0);
});

test("auto-title: no claim while the initial exchange is missing; titles once it lands", async () => {
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
  const outcomes = await dispatch([store.get(record.name)!]);
  assert.equal(outcomes[0]?.ok, true);
});

test("auto-title: disabled config does nothing", async () => {
  const record = bee({ brief: "fix things" });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(buildDeps({ store, capture, enabled: false }));

  assert.deepEqual(await dispatch([record]), []);
  assert.equal(capture.claims.length, 0);
});

test("auto-title: generator failure reports the error and keeps the claim", async () => {
  const record = bee({ brief: "fix things" });
  const store = new Map([[record.name, record]]);
  const capture: Capture = { claims: [], updates: [] };
  const dispatch = createAutoTitleDispatcher(
    buildDeps({ store, capture, generate: async () => { throw new Error("claude failed: boom"); } }),
  );

  await dispatch([record]);
  await settle();
  const outcomes = await dispatch([store.get(record.name)!]);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0]?.error ?? "", /boom/);
  assert.equal(capture.updates.length, 0);
  assert.ok(store.get(record.name)?.autoTitleAt, "claim stays so the daemon retries via rename --auto only");
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
