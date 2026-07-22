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
import type { SessionRecord } from "../src/store.js";

function record(name: string): SessionRecord {
  return {
    name,
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget: name,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    status: "running",
  };
}

function fakeChild(serve: (request: { id: number; root: string }) => Record<string, unknown> | null): SessionListChild & {
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
      if (response) stdout.write(`${JSON.stringify(response)}\n`);
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
  });

  await assert.rejects(() => list(), /timed out after 30ms \(child killed\)/);
  assert.deepEqual(wedged.killed, ["SIGKILL"]);
  assert.deepEqual((await list()).map((candidate) => candidate.name), ["CO.recovered"]);
  assert.equal(spawns, 2);
  await list.close();
});

test("session-list worker scopes consecutive requests to different HIVE_STORE_ROOT values", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "hive-session-list-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "hive-session-list-b-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    for (const [root, name] of [[firstRoot, "CO.first"], [secondRoot, "CO.second"]] as const) {
      await mkdir(join(root, "sessions"), { recursive: true });
      await writeFile(join(root, "sessions", `${name}.json`), JSON.stringify(record(name)));
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
