import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import {
  consumeHsrRunPayload,
  startHsrHostFromPayload,
  type HsrRunPayload,
} from "../src/hsr/runner-entry.js";
import { spawnHsrHost } from "../src/hsr/runnerHost.js";

const SECRET = "hsr-payload-secret-sentinel-71f23a";

function payload(bee = "payload-cleanup"): HsrRunPayload {
  return {
    bee,
    kind: "stub",
    cwd: process.cwd(),
    spec: {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PROVIDER_TOKEN: SECRET },
    },
  };
}

async function writePayload(contents: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-payload-"));
  const path = join(dir, "payload.json");
  await writeFile(path, contents, { mode: 0o600 });
  return { dir, path };
}

test("successful child startup consumes the secret payload before adapter/provider awaits", async () => {
  const handoff = await writePayload(`${JSON.stringify(payload())}\n`);
  let observedConsumed = false;
  const started = await startHsrHostFromPayload(handoff.path, {
    loadAdapter: async () => {
      observedConsumed = !existsSync(handoff.path) && !existsSync(handoff.dir);
      return stubAdapter;
    },
    runHost: async ({ bee }) => ({
      bee,
      controlSocket: "/tmp/test.sock",
      done: Promise.resolve(),
      stop: async () => undefined,
    }),
  });
  assert.equal(observedConsumed, true);
  assert.equal(started.host.bee, "payload-cleanup");
});

test("malformed and no-adapter payload failures remove secrets without echoing them", async () => {
  const malformed = await writePayload(`{"spec":{"env":{"TOKEN":"${SECRET}"}}`);
  await assert.rejects(
    consumeHsrRunPayload(malformed.path),
    (error: Error) => {
      assert.match(error.message, /invalid payload JSON/);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    },
  );
  assert.equal(existsSync(malformed.dir), false);

  const absent = await writePayload(`${JSON.stringify({ ...payload(), kind: SECRET })}\n`);
  await assert.rejects(
    startHsrHostFromPayload(absent.path, { loadAdapter: async () => undefined }),
    (error: Error) => {
      assert.match(error.message, /no HSR adapter for requested harness/);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    },
  );
  assert.equal(existsSync(absent.dir), false);
});

test("startup errors are redacted after the payload directory is removed", async () => {
  const handoff = await writePayload(`${JSON.stringify(payload())}\n`);
  await assert.rejects(
    startHsrHostFromPayload(handoff.path, {
      loadAdapter: async () => stubAdapter,
      runHost: async () => { throw new Error(`provider startup exposed ${SECRET}`); },
    }),
    (error: Error) => {
      assert.match(error.message, /provider startup exposed \[redacted\]/);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    },
  );
  assert.equal(existsSync(handoff.dir), false);
});

test("parent spawn failure removes an unconsumed payload and redacts its contents", async () => {
  const store = await mkdtemp(join(tmpdir(), "hive-hsr-payload-store-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  let handoffDir: string | undefined;
  try {
    await assert.rejects(
      spawnHsrHost(payload("spawn-failure"), {
        makeTempDir: async (prefix) => {
          handoffDir = await mkdtemp(prefix);
          return handoffDir;
        },
        resolveEntry: async () => ({ path: "/unused/runner-entry.js", mode: "dedicated" }),
        spawn: (() => { throw new Error(`spawn failed with ${SECRET}`); }) as typeof import("node:child_process").spawn,
      }),
      (error: Error) => {
        assert.match(error.message, /spawn failed with \[redacted\]/);
        assert.doesNotMatch(error.message, new RegExp(SECRET));
        return true;
      },
    );
    assert.ok(handoffDir);
    assert.equal(existsSync(handoffDir!), false);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(store, { recursive: true, force: true });
  }
});

test("operator-supplied arbitrary payload paths are rejected without touching the file or directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-owned-payload-"));
  const path = join(dir, "payload.json");
  await writeFile(path, SECRET, { mode: 0o600 });
  try {
    await assert.rejects(consumeHsrRunPayload(path), /invalid HSR payload handoff path/);
    assert.equal(await readFile(path, "utf8"), SECRET);
    assert.equal(existsSync(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
