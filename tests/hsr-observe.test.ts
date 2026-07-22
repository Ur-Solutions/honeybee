import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrActivityFromEvents, hsrObservations, isAuthNeededMessage, structuredStateFromEvents } from "../src/hsr/observe.js";
import { ensureHsrRunDir, hsrRingPath, hsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { deriveState, type BeeState, type StateContext } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-observe-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Poll `cond` on a short interval until true, or throw after `timeoutMs`. */
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function optsFor(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

/** Build a StateContext from a fresh batch of HSR observations. */
async function contextFromObservations(): Promise<StateContext> {
  const obs = await hsrObservations();
  const hsrLive = new Set<string>();
  const hsrStates = new Map<string, BeeState>();
  const hsrSnapshots = new Map<string, string>();
  for (const [bee, observation] of obs) {
    if (observation.live) hsrLive.add(bee);
    if (observation.state) hsrStates.set(bee, observation.state);
    hsrSnapshots.set(bee, observation.snapshot);
  }
  return { liveTargets: new Set(), hsrLive, hsrStates, hsrSnapshots, now: Date.now() };
}

function hsrRecord(name: string): SessionRecord {
  const iso = new Date().toISOString();
  return {
    name,
    agent: "stub",
    cwd: process.cwd(),
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    createdAt: iso,
    updatedAt: iso,
    status: "running",
  };
}

test("hsrObservations: scopes reads to requested bees and skips exited payloads", async () => {
  await withTempStore(async () => {
    const requested = "requested-live";
    const ignored = "ignored-live";
    const exited = "requested-exited";
    const startedAt = new Date().toISOString();

    for (const bee of [requested, ignored, exited]) {
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, {
        bee,
        harness: "stub",
        tier: "stream",
        hostPid: process.pid,
        startedAt,
        controlSocket: "/tmp/unused.sock",
        status: bee === exited ? "exited" : "running",
      });
    }
    await writeFile(hsrRingPath(requested), "live output\n");
    await writeFile(hsrRingPath(ignored), "must not be observed\n");
    await writeFile(hsrRingPath(exited), "stale exited output\n");

    const observations = await hsrObservations({
      bees: [requested, exited, "missing", requested],
      includeEvents: true,
      concurrency: 2,
    });

    assert.deepEqual([...observations.keys()], [requested, exited].sort());
    assert.equal(observations.has(ignored), false);
    assert.equal(observations.get(requested)?.live, true);
    assert.equal(observations.get(requested)?.snapshot, "live output\n");
    assert.deepEqual(observations.get(exited), { live: false, snapshot: "" });
  });
});

test("hsrObservations: live structured state feeds deriveState (not dead), dead host → dead", async () => {
  await withTempStore(async () => {
    const bee = "observee";
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee) });
    const client = await connectRpcClient(handle.controlSocket);
    const events: RunnerEvent[] = [];
    client.on("event", (p) => events.push(p as RunnerEvent));

    try {
      const record = hsrRecord(bee);

      // 1. Observed live before any turn. deriveState must NOT read it as dead
      //    (the whole point — pane-less bees have no tmux liveness).
      await waitFor(async () => (await hsrObservations()).get(bee)?.live === true, "bee live");
      const bootCtx = await contextFromObservations();
      const bootDerived = deriveState(record, bootCtx);
      assert.notEqual(bootDerived.state, "dead", "live HSR bee must not derive dead");

      // 2. Send a turn → the stub emits a text echo + turn_end. The structured
      //    state is idle_with_output (last turn marker is turn_end) and the
      //    snapshot carries the echo.
      await client.call("send", { text: "hello" });
      await waitFor(() => events.some((e) => e.type === "turn_end"), "turn_end broadcast");
      await waitFor(async () => {
        const obs = await hsrObservations();
        return obs.get(bee)?.state === "idle_with_output" && (obs.get(bee)?.snapshot ?? "").includes("echo:hello");
      }, "structured idle_with_output + echo snapshot");

      const idleCtx = await contextFromObservations();
      const idleObs = (await hsrObservations()).get(bee)!;
      assert.equal(idleObs.state, "idle_with_output");
      assert.match(idleObs.snapshot, /echo:hello/);
      assert.equal(deriveState(record, idleCtx).state, "idle_with_output");

      // 3. Stop the host → not live; deriveState → dead.
      await client.call("stop");
      await handle.done;

      await waitFor(async () => (await hsrObservations()).get(bee)?.live === false, "bee not live after stop");
      const deadCtx = await contextFromObservations();
      // The record is still status:"running" (nothing retired it), so a stopped host derives "crashed".
      assert.equal(deriveState(record, deadCtx).state, "crashed", "stopped HSR bee derives crashed");
    } finally {
      client.close();
      await handle.stop().catch(() => undefined);
    }
  });
});

test("structuredStateFromEvents surfaces login-required auth failures as auth-needed", () => {
  assert.equal(
    isAuthNeededMessage("Your access token could not be refreshed. Please log out and sign in again."),
    true,
  );
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "error", ts: 2, message: "Your access token could not be refreshed. Please log out and sign in again." },
      { type: "turn_end", ts: 3 },
    ]),
    "auth-needed",
  );
});

test("structuredStateFromEvents recognizes Claude's /login error as auth-needed", () => {
  const message = "authentication_failed: Not logged in · Please run /login";
  assert.equal(isAuthNeededMessage(message), true);
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "error", ts: 2, message },
      { type: "turn_end", ts: 3 },
    ]),
    "auth-needed",
  );
});

test("hsrActivityFromEvents derives genuine progress from runner event boundaries", () => {
  const cases: Array<{ name: string; events: RunnerEvent[]; at: number; eventType: RunnerEvent["type"] }> = [
    {
      name: "unterminated turn_start",
      events: [{ type: "turn_start", ts: 10 }],
      at: 10,
      eventType: "turn_start",
    },
    {
      name: "tool_use after turn_end",
      events: [
        { type: "turn_start", ts: 20 },
        { type: "turn_end", ts: 21 },
        { type: "tool_use", ts: 22, tool: "Bash" },
      ],
      at: 22,
      eventType: "tool_use",
    },
    {
      name: "text and usage progress",
      events: [
        { type: "turn_start", ts: 30 },
        { type: "text", ts: 31, text: "working" },
        { type: "usage", ts: 32, inputTokens: 7, outputTokens: 3 },
      ],
      at: 32,
      eventType: "usage",
    },
    {
      name: "needs_input boundary",
      events: [
        { type: "turn_start", ts: 40 },
        { type: "needs_input", ts: 41, kind: "question", question: "continue?" },
      ],
      at: 41,
      eventType: "needs_input",
    },
    {
      name: "turn_end after needs_input",
      events: [
        { type: "turn_start", ts: 50 },
        { type: "needs_input", ts: 51, kind: "question", question: "continue?" },
        { type: "turn_end", ts: 52 },
      ],
      at: 52,
      eventType: "turn_end",
    },
  ];

  for (const entry of cases) {
    const activity = hsrActivityFromEvents(entry.events);
    assert.equal(activity?.at, entry.at, entry.name);
    assert.equal(activity?.eventType, entry.eventType, entry.name);
    assert.match(activity?.fingerprint ?? "", new RegExp(`^${entry.eventType}:${entry.at}:`), entry.name);
  }
});

test("hsrActivityFromEvents scopes lifecycle boundaries to the root thread", () => {
  const activity = hsrActivityFromEvents(
    [
      { type: "turn_start", ts: 1, threadId: "root-thread" },
      { type: "turn_end", ts: 2, threadId: "nested-thread" },
    ],
    { rootThreadId: "root-thread" },
  );

  assert.equal(activity?.at, 1);
  assert.equal(activity?.eventType, "turn_start");
});

test("hsrActivityFromEvents fingerprints are stable for unchanged tails and advance on same-timestamp events", () => {
  const unchanged: RunnerEvent[] = [
    { type: "turn_start", ts: 100 },
    { type: "text", ts: 101, text: "step" },
  ];
  const first = hsrActivityFromEvents(unchanged);
  const second = hsrActivityFromEvents([...unchanged]);
  assert.equal(first?.fingerprint, second?.fingerprint);

  const advanced = hsrActivityFromEvents([
    ...unchanged,
    { type: "usage", ts: 101, inputTokens: 1, outputTokens: 1 },
  ]);
  assert.equal(advanced?.at, 101);
  assert.equal(advanced?.eventType, "usage");
  assert.notEqual(advanced?.fingerprint, first?.fingerprint);
});

test("hsrActivityFromEvents fingerprints survive event-log compaction reindexing", () => {
  const latest: RunnerEvent = { type: "usage", ts: 101, inputTokens: 1, outputTokens: 1 };
  const beforeCompaction = hsrActivityFromEvents([
    { type: "turn_start", ts: 100 },
    { type: "text", ts: 100, text: "working" },
    latest,
  ]);
  const afterCompaction = hsrActivityFromEvents([latest]);

  assert.equal(beforeCompaction?.fingerprint, afterCompaction?.fingerprint);
});

test("structuredStateFromEvents does not confuse daemon-recoverable auth_expired with auth-needed", () => {
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "auth_expired", ts: 2 },
      { type: "turn_end", ts: 3 },
    ]),
    "idle_with_output",
  );
});

test("structuredStateFromEvents treats an explicitly login-required auth expiry as auth-needed", () => {
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "auth_expired", ts: 2, requiresLogin: true, detail: "Run grok login, then resume." },
      { type: "turn_end", ts: 3 },
    ]),
    "auth-needed",
  );
});

test("an auth_resume marker un-sticks a stale auth-needed tail (CL.8d7, 2026-07-16)", () => {
  // The exact shape auth-resume leaves behind: the old error turn, the SIGTERM
  // exit from stopping the stuck runtime, then the marker. The resumed bee
  // sits idle without starting a new turn — it must NOT re-derive auth-needed.
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "error", ts: 2, message: "Not logged in · Please run /login" },
      { type: "turn_end", ts: 3 },
      { type: "exit", ts: 4, code: 143 },
      { type: "auth_resume", ts: 5 },
    ]),
    "idle_with_output",
  );
});

test("an auth error AFTER an auth_resume marker still wins (the login didn't take)", () => {
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "error", ts: 2, message: "Not logged in · Please run /login" },
      { type: "turn_end", ts: 3 },
      { type: "auth_resume", ts: 4 },
      { type: "turn_start", ts: 5 },
      { type: "error", ts: 6, message: "Not logged in · Please run /login" },
      { type: "turn_end", ts: 7 },
    ]),
    "auth-needed",
  );
});

// ─── idle must not fire while a tool is open ───────────────────────────────
// claude's stream-json emits a `result` (→ turn_end) MID-TURN on long tool
// chains, then keeps calling tools with no new turn_start. Reading that as
// idle_with_output drained queued buz messages into a live tool call (observed
// 2026-07-13 on a silent `Bash sleep` turn).

test("structuredStateFromEvents stays active when a tool fires after a mid-turn turn_end", () => {
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "tool_use", ts: 2, tool: "Read" },
      { type: "turn_end", ts: 3 }, // harness closed the turn early…
      { type: "tool_use", ts: 4, tool: "Bash" }, // …but it is still working
    ]),
    "active",
  );
});

test("structuredStateFromEvents stays active through a silent long tool call", () => {
  // The tail ends ON the tool_use: a `Bash sleep` produces no further events
  // until it returns, so this window is exactly what the daemon observes.
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "text", ts: 2, text: "running it now" },
      { type: "turn_end", ts: 3 },
      { type: "tool_use", ts: 4, tool: "Bash" },
    ]),
    "active",
  );
});

test("structuredStateFromEvents still reports idle after a turn whose tools all completed", () => {
  // The normal shape — every tool_use PRECEDES the closing turn_end.
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "tool_use", ts: 2, tool: "Bash" },
      { type: "text", ts: 3, text: "done" },
      { type: "turn_end", ts: 4 },
    ]),
    "idle_with_output",
  );
});

test("structuredStateFromEvents ignores nested-thread turn_end while the root turn is active", () => {
  assert.equal(
    structuredStateFromEvents(
      [
        { type: "turn_start", ts: 1, threadId: "root-thread" },
        { type: "turn_start", ts: 2, threadId: "nested-thread" },
        { type: "text", ts: 3, text: "nested output" },
        { type: "turn_end", ts: 4, threadId: "nested-thread" },
      ],
      { rootThreadId: "root-thread" },
    ),
    "active",
  );
});

test("structuredStateFromEvents reports idle when the root turn_end arrives after nested work", () => {
  assert.equal(
    structuredStateFromEvents(
      [
        { type: "turn_start", ts: 1, threadId: "root-thread" },
        { type: "turn_start", ts: 2, threadId: "nested-thread" },
        { type: "turn_end", ts: 3, threadId: "nested-thread" },
        { type: "turn_end", ts: 4, threadId: "root-thread" },
      ],
      { rootThreadId: "root-thread" },
    ),
    "idle_with_output",
  );
});

test("an unresolved needs_input still wins over an open tool", () => {
  assert.equal(
    structuredStateFromEvents([
      { type: "turn_start", ts: 1 },
      { type: "turn_end", ts: 2 },
      { type: "tool_use", ts: 3, tool: "Bash" },
      { type: "needs_input", ts: 4, kind: "permission", question: "run it?" },
    ]),
    "blocked",
  );
});
