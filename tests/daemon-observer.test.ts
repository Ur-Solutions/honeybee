import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createIsolatedHsrObservations, runHsrObserveWorker, type ObserverChild } from "../src/daemon/observerProcess.js";
import type { HsrObservation } from "../src/hsr/observe.js";

/**
 * A scriptable fake child: requests written to stdin invoke `serve`, whose
 * return value (if any) is written back on stdout as the response.
 */
function fakeChild(serve: (request: { id: number; bees: string[] }) => Record<string, unknown> | null): ObserverChild & {
  killed: NodeJS.Signals[];
  emitter: EventEmitter;
  stdout: PassThrough;
} {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const killed: NodeJS.Signals[] = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const request = JSON.parse(line) as { id: number; bees: string[] };
      const response = serve(request);
      if (response) stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  return {
    stdin,
    stdout,
    killed,
    emitter,
    kill: (signal?: NodeJS.Signals) => {
      killed.push(signal ?? "SIGTERM");
    },
    on: (event: "exit" | "error", listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
    },
  };
}

const OBS: HsrObservation = { live: true, state: "active", snapshot: "hello" };

test("isolated observer: round-trips observations through the child protocol", async () => {
  const child = fakeChild((request) => ({ id: request.id, ok: true, observations: request.bees.map((bee) => [bee, OBS]) }));
  const observe = createIsolatedHsrObservations({ timeoutMs: 1_000, spawnChild: () => child });
  const result = await observe(["alpha", "beta"]);
  assert.equal(result.size, 2);
  assert.deepEqual(result.get("alpha"), OBS);
  await observe.close();
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("isolated observer: decodes a large chunked response and restores the single event array alias", async () => {
  let child: ReturnType<typeof fakeChild>;
  child = fakeChild((request) => {
    const event = { type: "text", ts: 1, text: `${"x".repeat(1_000_000)}🐝` };
    const response = Buffer.from(`${JSON.stringify({
      id: request.id,
      ok: true,
      observations: [["alpha", {
        live: true,
        state: "active",
        snapshot: "large",
        eventSnapshot: {
          events: [event],
          activity: { at: 1, fingerprint: "text-1", eventType: "text" },
          usage: { totals: null },
          pendingNeedsInput: null,
        },
      }]],
    })}\n`);
    for (let offset = 0; offset < response.length; offset += 2_047) {
      child.stdout.write(response.subarray(offset, offset + 2_047));
    }
    return null;
  });
  const observe = createIsolatedHsrObservations({ timeoutMs: 5_000, spawnChild: () => child });

  const result = await observe(["alpha"]);
  const snapshot = result.get("alpha")?.eventSnapshot;
  assert.equal(snapshot?.events[0]?.type, "text");
  assert.equal((snapshot?.events[0] as { text?: string }).text?.endsWith("🐝"), true);
  assert.equal(snapshot?.tailEvents, snapshot?.events, "wire response carries events once and restores the alias locally");
  await observe.close();
});

test("isolated observer: child error responses reject the request", async () => {
  const child = fakeChild((request) => ({ id: request.id, ok: false, error: "run dir unreadable" }));
  const observe = createIsolatedHsrObservations({ timeoutMs: 1_000, spawnChild: () => child });
  await assert.rejects(() => observe(["alpha"]), /run dir unreadable/);
  await observe.close();
});

test("isolated observer: a deadline breach SIGKILLs the child and the next request respawns", async () => {
  let spawns = 0;
  const wedged = fakeChild(() => null); // never answers
  const healthy = fakeChild((request) => ({ id: request.id, ok: true, observations: [["alpha", OBS]] }));
  const observe = createIsolatedHsrObservations({
    timeoutMs: 40,
    spawnChild: () => {
      spawns += 1;
      return spawns === 1 ? wedged : healthy;
    },
  });
  await assert.rejects(() => observe(["alpha"]), /timed out after 40ms \(child killed\)/);
  assert.deepEqual(wedged.killed, ["SIGKILL"]);
  const result = await observe(["alpha"]);
  assert.equal(result.get("alpha")?.snapshot, "hello");
  assert.equal(spawns, 2);
  await observe.close();
});

test("isolated observer: a child exit rejects in-flight requests and the next respawns", async () => {
  let spawns = 0;
  const dying = fakeChild(() => null);
  const healthy = fakeChild((request) => ({ id: request.id, ok: true, observations: [] }));
  const observe = createIsolatedHsrObservations({
    timeoutMs: 5_000,
    spawnChild: () => {
      spawns += 1;
      return spawns === 1 ? dying : healthy;
    },
  });
  const inFlight = observe(["alpha"]);
  dying.emitter.emit("exit");
  await assert.rejects(() => inFlight, /hsr observer child exited/);
  const result = await observe(["alpha"]);
  assert.equal(result.size, 0);
  await observe.close();
});

test("worker: serves observation requests over JSONL and survives garbage", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runHsrObserveWorker(input, output);
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  input.write("not-json\n");
  input.write(`${JSON.stringify({ id: 7, bees: [] })}\n`);
  input.end();
  await done;
  const lines = chunks.join("").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]!) as { id: number; ok: boolean; observations: unknown[] };
  assert.equal(response.id, 7);
  assert.equal(response.ok, true);
  assert.deepEqual(response.observations, []);
});

test("CR-12: an async child 'error' event rejects in-flight work instead of crashing, and the next request respawns", async () => {
  let spawns = 0;
  const broken = fakeChild(() => null);
  const healthy = fakeChild((request) => ({ id: request.id, ok: true, observations: [] }));
  const observe = createIsolatedHsrObservations({
    timeoutMs: 5_000,
    spawnChild: () => {
      spawns += 1;
      return spawns === 1 ? broken : healthy;
    },
  });
  const inFlight = observe(["alpha"]);
  broken.emitter.emit("error", new Error("spawn ENOENT"));
  await assert.rejects(() => inFlight, /hsr observer child error: spawn ENOENT/);
  const result = await observe(["alpha"]);
  assert.equal(result.size, 0);
  assert.equal(spawns, 2);
  await observe.close();
});
