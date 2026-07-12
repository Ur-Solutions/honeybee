import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrObservations, isAuthNeededMessage, structuredStateFromEvents } from "../src/hsr/observe.js";
import { hsrRunDir } from "../src/hsr/runDir.js";
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
