import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_TITLE_MAX_RETRY_BACKOFF_MS,
  AUTO_TITLE_WATCHDOG_MS,
  autoTitleDecision,
  autoTitleRetryBackoffMs,
  createAutoTitleDispatcher,
  type AutoTitleBookkeeping,
  type AutoTitleDeps,
} from "../src/autoTitle.ts";
import type { BeeRow, MessageRow } from "../../core/src/index.ts";

function bee(overrides: Partial<BeeRow> = {}): BeeRow {
  return {
    id: "bee-1",
    name: "apiary-waggle-1",
    agent: "grok",
    substrate: "hsr",
    cwd: "/tmp",
    title: null,
    tags: [],
    sessionLogPath: null,
    lifecycle: "active",
    createdAt: 1,
    archivedAt: null,
    lastOutputAt: 2,
    providerSessionId: null,
    env: {},
    importedFrom: null,
    spawnFailures: 0,
    args: null,
    parentId: null,
    forkedFrom: null,
    forkSeed: null,
    account: null,
    handle: "GR.1",
    ...overrides,
  };
}

function mail(body: string, id = 1): MessageRow {
  return {
    id,
    beeId: "bee-1",
    sender: "operator",
    body,
    priority: 0,
    urgency: "next",
    enqueuedAt: 1,
    deliveredAt: 1,
    deliveredGeneration: 1,
  };
}

const NOW = 1_000_000;

test("autoTitleDecision: thin first opener defers; second message generates", () => {
  const untitled = bee({ lastOutputAt: null });
  assert.equal(autoTitleDecision(untitled, ["hi"], undefined, NOW).action, "defer");
  assert.equal(autoTitleDecision(untitled, ["hi", "Enable auto-titling"], undefined, NOW).action, "generate");
});

test("autoTitleDecision: substantial first message waits for output, then generates", () => {
  assert.equal(autoTitleDecision(bee({ lastOutputAt: null }), ["Enable auto-titling"], undefined, NOW).action, "defer");
  assert.equal(autoTitleDecision(bee({ lastOutputAt: 9 }), ["Enable auto-titling"], undefined, NOW).action, "generate");
});

test("autoTitleDecision: existing title and archived skip; failures retry with bounded backoff", () => {
  assert.equal(autoTitleDecision(bee({ title: "Already" }), ["Enable auto-titling"], undefined, NOW).action, "skip");
  assert.equal(autoTitleDecision(bee({ lifecycle: "archived" }), ["Enable auto-titling"], undefined, NOW).action, "skip");
  const failed: AutoTitleBookkeeping = {
    attempts: 20,
    lastAt: NOW,
    userTurns: 1,
    deferred: false,
    signature: "x",
  };
  assert.equal(autoTitleRetryBackoffMs(failed.attempts), AUTO_TITLE_MAX_RETRY_BACKOFF_MS);
  assert.equal(autoTitleDecision(bee(), ["Enable auto-titling"], failed, NOW).action, "skip");
  assert.equal(
    autoTitleDecision(bee(), ["Enable auto-titling"], failed, NOW + AUTO_TITLE_MAX_RETRY_BACKOFF_MS).action,
    "generate",
  );
});

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("dispatcher: thin opener does not burn an attempt; second message titles", async () => {
  const row = bee({ lastOutputAt: null });
  const store = new Map<string, BeeRow>([[row.id, row]]);
  const messages = [mail("hi")];
  const bookkeeping = new Map<string, AutoTitleBookkeeping>();
  const titles: string[] = [];
  const deps: AutoTitleDeps = {
    enabled: () => true,
    naming: () => ({
      auto: true,
      backend: "codex-app-server",
      tool: "codex",
      model: "gpt-5.6-luna",
      effort: "medium",
      generatorCwd: "/tmp",
    }),
    listBees: () => [...store.values()],
    listMessages: () => messages,
    getBee: (id) => store.get(id) ?? null,
    setTitle: (id, title) => {
      const existing = store.get(id);
      if (!existing) return { applied: false };
      store.set(id, { ...existing, title });
      titles.push(title);
      return { applied: true };
    },
    loadState: (id) => bookkeeping.get(id),
    saveState: (id, state) => {
      bookkeeping.set(id, state);
    },
    generate: async () => "Enable Auto Titler",
    now: () => NOW,
    log: () => undefined,
  };
  const dispatch = createAutoTitleDispatcher(deps);
  await dispatch();
  await settle();
  assert.equal(titles.length, 0);
  assert.equal(bookkeeping.get(row.id)?.deferred, true);
  assert.equal(bookkeeping.get(row.id)?.attempts, 0);

  messages.push(mail("Please enable the auto-titler for grok bees.", 2));
  store.set(row.id, { ...row, lastOutputAt: 9 });
  await dispatch();
  await settle();
  assert.deepEqual(titles, ["Enable Auto Titler"]);
  assert.equal(store.get(row.id)?.title, "Enable Auto Titler");
});

test("dispatcher: watchdog recovery ignores the stale generator completion", async () => {
  let now = NOW;
  let row = bee();
  const bookkeeping = new Map<string, AutoTitleBookkeeping>();
  const resolves: Array<(title: string) => void> = [];
  const dispatch = createAutoTitleDispatcher({
    enabled: () => true,
    naming: () => ({
      auto: true,
      backend: "codex-app-server",
      tool: "codex",
      model: "gpt-5.6-luna",
      effort: "none",
      generatorCwd: "/tmp",
    }),
    listBees: () => [row],
    listMessages: () => [mail("Repair automatic naming")],
    getBee: () => row,
    setTitle: (_id, title) => {
      row = { ...row, title };
      return { applied: true };
    },
    loadState: (id) => bookkeeping.get(id),
    saveState: (id, state) => bookkeeping.set(id, state),
    generate: () => new Promise((resolve) => resolves.push(resolve)),
    now: () => now,
    log: () => undefined,
  });

  await dispatch();
  await settle();
  assert.equal(resolves.length, 1);

  now += AUTO_TITLE_WATCHDOG_MS + 1;
  const watchdog = await dispatch();
  await settle();
  assert.equal(watchdog[0]?.error?.includes("watchdog"), true);
  assert.equal(resolves.length, 2);

  resolves[0]!("Stale Title");
  await settle();
  assert.equal(row.title, null);
  resolves[1]!("Fresh Title");
  await settle();
  assert.equal(row.title, "Fresh Title");
});

test("dispatcher: disabled naming skips everything", async () => {
  const dispatch = createAutoTitleDispatcher({
    enabled: () => false,
    naming: () => ({
      auto: false,
      backend: "codex-app-server",
      tool: "codex",
      model: "gpt-5.6-luna",
      effort: "medium",
      generatorCwd: "/tmp",
    }),
    listBees: () => [bee()],
    listMessages: () => [mail("Enable auto-titling")],
    getBee: () => bee(),
    setTitle: () => {
      throw new Error("should not title");
    },
    loadState: () => undefined,
    saveState: () => undefined,
    generate: async () => "Nope",
    now: () => NOW,
    log: () => undefined,
  });
  const outcomes = await dispatch();
  assert.deepEqual(outcomes, []);
});
