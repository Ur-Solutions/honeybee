import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoTitleDecision,
  createAutoTitleDispatcher,
  MAX_AUTO_TITLE_ATTEMPTS,
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

test("autoTitleDecision: existing title / archived / attempt cap skip", () => {
  assert.equal(autoTitleDecision(bee({ title: "Already" }), ["Enable auto-titling"], undefined, NOW).action, "skip");
  assert.equal(autoTitleDecision(bee({ lifecycle: "archived" }), ["Enable auto-titling"], undefined, NOW).action, "skip");
  const capped: AutoTitleBookkeeping = {
    attempts: MAX_AUTO_TITLE_ATTEMPTS,
    lastAt: NOW,
    userTurns: 1,
    deferred: false,
    signature: "x",
  };
  assert.equal(autoTitleDecision(bee(), ["Enable auto-titling"], capped, NOW).action, "skip");
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

test("dispatcher: disabled naming skips everything", async () => {
  const dispatch = createAutoTitleDispatcher({
    enabled: () => false,
    naming: () => ({
      auto: false,
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
