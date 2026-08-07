import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  createIsolatedSessionLister,
  runSessionListWorker,
  type SessionListChild,
} from "../src/daemon/sessionListProcess.js";
import { listActiveSessionsHot, rebuildActiveSessionIndex, saveSession, type SessionRecord } from "../src/store.js";

function record(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget: name,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function fakeChild(serve: (
  request: { id: number; root: string },
) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>): SessionListChild & {
  killed: NodeJS.Signals[];
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
      const response = serve(JSON.parse(line) as { id: number; root: string });
      if (response instanceof Promise) {
        void response.then((resolved) => {
          if (resolved) stdout.write(`${JSON.stringify(resolved)}\n`);
        }).catch((error: unknown) => emitter.emit("error", error));
      } else if (response) {
        stdout.write(`${JSON.stringify(response)}\n`);
      }
    }
  });
  return {
    stdin,
    stdout,
    killed,
    kill: (signal?: NodeJS.Signals) => {
      killed.push(signal ?? "SIGTERM");
    },
    on: (event, listener) => emitter.on(event, listener),
  };
}

test("isolated session list kills a never-settling scan and recovers on the next request", async () => {
  let spawns = 0;
  const wedged = fakeChild(() => null);
  const healthy = fakeChild((request) => ({ id: request.id, ok: true, records: [record("CO.recovered")] }));
  const list = createIsolatedSessionLister({
    timeoutMs: 30,
    root: () => "/tmp/hive-a",
    spawnChild: () => (++spawns === 1 ? wedged : healthy),
    reconcileActiveIndex: async () => 0,
    onReconcileTelemetry: () => undefined,
  });

  await assert.rejects(() => list(), /timed out after 30ms \(child killed\)/);
  assert.deepEqual(wedged.killed, ["SIGKILL"]);
  assert.deepEqual((await list()).map((candidate) => candidate.name), ["CO.recovered"]);
  assert.equal(spawns, 2);
  await list.close();
});

test("session-list worker scopes roots and serializes only the active projection", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "hive-session-list-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "hive-session-list-b-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    for (const [root, name] of [[firstRoot, "CO.first"], [secondRoot, "CO.second"]] as const) {
      await mkdir(join(root, "sessions"), { recursive: true });
      await writeFile(join(root, "sessions", `${name}.json`), JSON.stringify(record(name)));
      await writeFile(join(root, "sessions", `${name}-history.json`), JSON.stringify(record(`${name}-history`, {
        status: "done",
        lastObservedState: "done",
      })));
    }
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    const done = runSessionListWorker(input, output);
    input.write(`${JSON.stringify({ id: 1, root: firstRoot })}\n`);
    input.write(`${JSON.stringify({ id: 2, root: secondRoot })}\n`);
    input.end();
    await done;

    const responses = chunks.join("").trim().split("\n").map((line) => JSON.parse(line) as {
      id: number;
      records: SessionRecord[];
    });
    assert.deepEqual(responses.map((response) => response.records.map((candidate) => candidate.name)), [["CO.first"], ["CO.second"]]);
    assert.equal(process.env.HIVE_STORE_ROOT, previousRoot, "worker restores the embedding process environment");
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("daemon-owned lister keeps hot snapshots flowing while one canonical reconcile is slow", async () => {
  let reconcileStarts = 0;
  let hotLists = 0;
  let finishReconcile!: (active: number) => void;
  const slowReconcile = new Promise<number>((resolve) => { finishReconcile = resolve; });
  let reconcileFinished!: () => void;
  const reconciled = new Promise<void>((resolve) => { reconcileFinished = resolve; });
  const child = fakeChild((request) => ({
    id: request.id,
    ok: true,
    records: [record(`CO.hot-${++hotLists}`)],
  }));
  const list = createIsolatedSessionLister({
    spawnChild: () => child,
    root: () => "/tmp/hive-cadence",
    canonicalReconcileIntervalMs: 100,
    now: () => 0,
    reconcileActiveIndex: async () => {
      reconcileStarts += 1;
      return slowReconcile;
    },
    onReconcileTelemetry: () => {
      reconcileFinished();
    },
  });
  const snapshots = [await list(), await list(), await list()];
  finishReconcile(3);
  await reconciled;

  assert.equal(reconcileStarts, 1, "single-flight reconciliation never multiplies with hot ticks");
  assert.equal(hotLists, 3, "every tick still consumes the active projection");
  assert.deepEqual(
    snapshots.map((records) => records[0]?.name),
    ["CO.hot-1", "CO.hot-2", "CO.hot-3"],
  );
  await list.close();
});

test("snapshot-worker replacement does not restart the parent-owned canonical reconcile", async () => {
  let firstRequests = 0;
  let spawns = 0;
  let reconcileStarts = 0;
  let finishReconcile!: (active: number) => void;
  const slowReconcile = new Promise<number>((resolve) => { finishReconcile = resolve; });
  let reconcileFinished!: () => void;
  const reconciled = new Promise<void>((resolve) => { reconcileFinished = resolve; });
  const replaced = fakeChild((request) => {
    firstRequests += 1;
    return firstRequests === 1
      ? { id: request.id, ok: true, records: [record("CO.before-replacement")] }
      : null;
  });
  const recovered = fakeChild((request) => ({
    id: request.id,
    ok: true,
    records: [record("CO.after-replacement")],
  }));
  const list = createIsolatedSessionLister({
    timeoutMs: 30,
    spawnChild: () => (++spawns === 1 ? replaced : recovered),
    root: () => "/tmp/hive-parent-owned-reconcile",
    canonicalReconcileIntervalMs: 60_000,
    reconcileActiveIndex: async () => {
      reconcileStarts += 1;
      return slowReconcile;
    },
    onReconcileTelemetry: () => reconcileFinished(),
  });

  assert.equal((await list())[0]?.name, "CO.before-replacement");
  await assert.rejects(() => list(), /timed out after 30ms/);
  assert.equal((await list())[0]?.name, "CO.after-replacement");
  assert.equal(spawns, 2);
  assert.equal(reconcileStarts, 1, "new snapshot worker shares the daemon controller's in-flight state");
  finishReconcile(2);
  await reconciled;
  await list.close();
});

test("failed canonical reconcile emits telemetry but the next active snapshot still succeeds", async () => {
  let telemetryResolve!: () => void;
  const telemetrySeen = new Promise<void>((resolve) => { telemetryResolve = resolve; });
  const events: Array<{ ok: boolean; error?: string }> = [];
  let hotLists = 0;
  const child = fakeChild((request) => ({
    id: request.id,
    ok: true,
    records: [record(`CO.snapshot-${++hotLists}`)],
  }));
  const list = createIsolatedSessionLister({
    spawnChild: () => child,
    root: () => "/tmp/hive-failed-reconcile",
    canonicalReconcileIntervalMs: 1_000,
    now: () => 100,
    reconcileActiveIndex: async () => { throw new Error("historical scan EIO"); },
    onReconcileTelemetry: (event) => {
      events.push(event);
      telemetryResolve();
    },
  });
  const first = await list();
  await telemetrySeen;
  const second = await list();

  assert.equal(events[0]?.ok, false);
  assert.match(events[0]?.error ?? "", /historical scan EIO/);
  assert.deepEqual(
    [first[0]?.name, second[0]?.name],
    ["CO.snapshot-1", "CO.snapshot-2"],
  );
  await list.close();
});

test("non-blocking startup reconcile repairs an exact older-writer omission for the next snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-session-list-old-writer-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    process.env.HIVE_STORE_ROOT = root;
    await saveSession(record("CO.indexed"));
    await writeFile(
      join(root, "sessions", "CO.old-writer.json"),
      JSON.stringify(record("CO.old-writer")),
    );
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;

    const child = fakeChild(async (request) => {
      const before = process.env.HIVE_STORE_ROOT;
      process.env.HIVE_STORE_ROOT = request.root;
      try {
        return { id: request.id, ok: true, records: await listActiveSessionsHot() };
      } finally {
        if (before === undefined) delete process.env.HIVE_STORE_ROOT;
        else process.env.HIVE_STORE_ROOT = before;
      }
    });
    let reconcileResolve!: () => void;
    const reconcileDone = new Promise<void>((resolve) => { reconcileResolve = resolve; });
    const list = createIsolatedSessionLister({
      spawnChild: () => child,
      root: () => root,
      canonicalReconcileIntervalMs: 60_000,
      reconcileActiveIndex: async (targetRoot) => {
        const before = process.env.HIVE_STORE_ROOT;
        process.env.HIVE_STORE_ROOT = targetRoot;
        try {
          return await rebuildActiveSessionIndex();
        } finally {
          if (before === undefined) delete process.env.HIVE_STORE_ROOT;
          else process.env.HIVE_STORE_ROOT = before;
        }
      },
      onReconcileTelemetry: (event) => {
        if (event.ok) reconcileResolve();
      },
    });

    const first = await list();
    assert.deepEqual(
      first.map((candidate) => candidate.name),
      ["CO.indexed"],
      "startup serves the checksum-valid hot projection without blocking on history",
    );
    await reconcileDone;
    const second = await list();
    assert.deepEqual(
      second.map((candidate) => candidate.name).sort(),
      ["CO.indexed", "CO.old-writer"],
      "the completed canonical pass makes the old writer visible on the next hot snapshot",
    );
    await list.close();
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
