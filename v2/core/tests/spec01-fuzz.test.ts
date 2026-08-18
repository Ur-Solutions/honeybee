/**
 * spec01.14 — fuzz: random interleaving of verbs/crashes never produces a state
 * outside the model. Every op either succeeds or throws a CoreError (an expected
 * contract rejection); after every op the full store must satisfy the model
 * invariants, and at the end the audit log must replay to the exact state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_STATUSES,
  CoreError,
  EXIT_CAUSES,
  FLAGS,
  LIFECYCLES,
  RUNTIME_STATES,
  VERBS,
  replayAudit,
  type CoreStore,
  type StateDump,
} from "../src/index.ts";
import { harness } from "./helpers.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_ATTEMPTS = 3;

function checkInvariants(dump: StateDump): void {
  const beeIds = new Set(dump.bees.map((b) => b.id));
  for (const bee of dump.bees) {
    // Q1: 'deleted' never appears as stored state — deleted bees have no row.
    assert.ok(bee.lifecycle === "active" || bee.lifecycle === "archived");
    assert.ok((LIFECYCLES as readonly string[]).includes(bee.lifecycle));
    assert.equal(bee.lifecycle === "archived", bee.archivedAt != null);
    const gens = dump.runtimes.filter((r) => r.beeId === bee.id).map((r) => r.generation);
    assert.ok(gens.length >= 1, `bee ${bee.id} has no runtime`);
    assert.deepEqual(gens, Array.from({ length: gens.length }, (_, i) => i + 1)); // contiguous 1..N
  }
  for (const rt of dump.runtimes) {
    assert.ok(beeIds.has(rt.beeId)); // no orphans
    assert.ok((RUNTIME_STATES as readonly string[]).includes(rt.state)); // exactly four states
    assert.equal(rt.state === "stopped", rt.exitCause != null); // exit cause iff stopped
    if (rt.exitCause != null) assert.ok((EXIT_CAUSES as readonly string[]).includes(rt.exitCause));
    const highest = Math.max(
      ...dump.runtimes.filter((r) => r.beeId === rt.beeId).map((r) => r.generation),
    );
    if (rt.generation !== highest) assert.equal(rt.state, "stopped"); // only current gen may live
  }
  for (const flag of dump.flags) {
    assert.ok(beeIds.has(flag.beeId));
    assert.ok((FLAGS as readonly string[]).includes(flag.flag)); // closed list
    if (flag.clearedAt != null) assert.ok(flag.clearedAt >= flag.setAt);
  }
  for (const msg of dump.mailbox) {
    assert.ok(beeIds.has(msg.beeId));
    assert.equal(msg.deliveredAt != null, msg.deliveredGeneration != null);
  }
  // v6: questions/seals belong to live bees; answered iff answer facts present;
  // a bee's parent edge points at a live bee or is null (orphaned on delete).
  for (const q of dump.questions) {
    assert.ok(beeIds.has(q.beeId));
    assert.equal(q.status === "answered", q.answeredAt != null);
    assert.equal(q.status === "answered", q.answer != null);
    assert.equal(q.status === "answered", q.deliveryMessageId != null);
    if (q.deliveryMessageId != null) assert.ok(dump.mailbox.some((m) => m.id === q.deliveryMessageId && m.beeId === q.beeId));
  }
  for (const sl of dump.seals) assert.ok(beeIds.has(sl.beeId));
  for (const bee of dump.bees) if (bee.parentId != null) assert.ok(beeIds.has(bee.parentId), `dangling parent ${bee.parentId}`);
  const seenKeys = new Set<string>();
  for (const cmd of dump.commands) {
    // Spec 06 §4.2 one-key rule: a key never lands on two commands.
    if (cmd.idempotencyKey != null) {
      assert.ok(!seenKeys.has(cmd.idempotencyKey), `duplicate idempotency key ${cmd.idempotencyKey}`);
      seenKeys.add(cmd.idempotencyKey);
    }
    assert.ok((VERBS as readonly string[]).includes(cmd.verb));
    assert.ok((COMMAND_STATUSES as readonly string[]).includes(cmd.status));
    assert.ok(cmd.attempts <= MAX_ATTEMPTS);
    if (cmd.status === "failed") assert.ok(cmd.failureCause != null && (FLAGS as readonly string[]).includes(cmd.failureCause));
    if (cmd.status === "done" || cmd.status === "failed") assert.ok(cmd.finishedAt != null);
    if (cmd.status === "queued" || cmd.status === "running") assert.equal(cmd.finishedAt, null);
  }
}

function fuzzRun(seed: number, ops: number): void {
  const h = harness();
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const opts = { maxAttempts: MAX_ATTEMPTS, backoffBaseMs: 1 };
  let store: CoreStore = h.open(opts);
  let pidCounter = 1;
  let beeCounter = 0;
  const livePids: Array<{ pid: number; startedAt: number }> = [];

  const actions: Array<() => void> = [
    () => {
      if (store.listBees().length >= 6) return;
      beeCounter += 1;
      // v6: sometimes a child of an existing bee, sometimes a fork with a seed
      const parent = rnd() < 0.5 ? pick(store.listBees()) : undefined;
      store.createBee({
        name: `fz-${beeCounter}`,
        agent: "claude",
        substrate: "hsr",
        cwd: "/tmp",
        ...(parent ? { parentId: parent.id } : {}),
        ...(parent && rnd() < 0.5 ? { forkedFrom: parent.id, forkSeed: parent.providerSessionId ?? `seed-${beeCounter}` } : {}),
      });
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.renameBee(bee.id, `fz-r${Math.floor(rnd() * 5)}`);
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.tagBee(bee.id, { add: [`t${Math.floor(rnd() * 4)}`], remove: [`t${Math.floor(rnd() * 4)}`] });
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.recordProviderSessionId(bee.id, `sid-${Math.floor(rnd() * 4)}`);
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.askQuestion(bee.id, { text: `q${Math.floor(rnd() * 100)}`, options: rnd() < 0.5 ? ["a", "b"] : null });
    },
    () => {
      const q = pick(store.listQuestions());
      if (q) store.answerQuestion(q.id, `a${Math.floor(rnd() * 100)}`);
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.createSeal(bee.id, { title: `s${Math.floor(rnd() * 100)}`, body: "b", refs: rnd() < 0.5 ? ["r"] : [] });
    },
    () => {
      const bee = pick(store.listBees());
      if (!bee) return;
      const rt = store.currentRuntime(bee.id);
      const gen = rnd() < 0.8 ? (rt?.generation ?? 1) : Math.ceil(rnd() * 3);
      const state = pick(RUNTIME_STATES);
      if (state === "stopped") {
        store.updateRuntimeState(bee.id, gen, "stopped", { exitCause: pick(EXIT_CAUSES) });
      } else if (state === "running" && rt?.state === "booting") {
        const pid = pidCounter++;
        store.updateRuntimeState(bee.id, gen, "running", { pid, pidStartedAt: pid });
        if (rnd() < 0.6) livePids.push({ pid, startedAt: pid });
      } else {
        store.updateRuntimeState(bee.id, gen, state);
      }
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.send(bee.id, `msg ${Math.floor(rnd() * 1000)}`, { priority: Math.floor(rnd() * 3) });
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.reviveBee(bee.id);
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.archiveBee(bee.id);
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.unarchiveBee(bee.id);
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.deleteBee(bee.id);
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.setFlag(bee.id, pick(FLAGS), "fuzz");
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.clearFlag(bee.id, pick(FLAGS));
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.enqueueCommand(pick(VERBS), bee.id);
    },
    () => {
      // Keyed enqueue from a small pool: collisions dedup to the ORIGINAL
      // command (spec 06 §4.2) and must keep replay/state equality intact.
      const bee = pick(store.listBees());
      if (bee) store.enqueueCommand(pick(VERBS), bee.id, {}, { idempotencyKey: `fz-key-${Math.floor(rnd() * 8)}` });
    },
    () => {
      store.claimNextCommand();
    },
    () => {
      const running = store.listCommands({ status: "running" });
      const cmd = pick(running);
      if (!cmd) return;
      if (rnd() < 0.5) store.completeCommand(cmd.id);
      else store.reportCommandFailure(cmd.id, pick(FLAGS), "fuzz failure");
    },
    () => {
      const bee = pick(store.listBees());
      if (!bee) return;
      const msg = pick(store.undeliveredMessages(bee.id));
      if (msg) store.markDelivered(msg.id, Math.ceil(rnd() * 3));
    },
    () => {
      const bee = pick(store.listBees());
      if (bee) store.recordOutput(bee.id);
    },
    () => {
      // Crash + reboot: close without cleanup, reopen, reconcile against a random
      // subset of previously live pids.
      store.close();
      store = h.open(opts);
      const survivors = livePids.filter(() => rnd() < 0.5);
      store.reconcileAtBoot(survivors);
    },
  ];

  for (let i = 0; i < ops; i++) {
    const action = pick(actions);
    try {
      action();
    } catch (err) {
      // Contract rejections are expected under random inputs; anything else is a bug.
      if (!(err instanceof CoreError)) throw err;
    }
    checkInvariants(store.dumpState());
  }

  // The audit log must replay to the exact final state (test 13 property, under fuzz).
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
  h.cleanup();
}

test("spec01.14: fuzz — random interleaving of verbs/crashes never leaves the legal state space", () => {
  for (const seed of [1, 20260817, 424242]) fuzzRun(seed, 250);
});
