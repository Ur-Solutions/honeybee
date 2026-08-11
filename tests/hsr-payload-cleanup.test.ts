import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import {
  consumeHsrRunPayload,
  hsrStartupFailureForPayload,
  startHsrHostFromPayload,
  type HsrRunPayload,
} from "../src/hsr/runner-entry.js";
import { spawnHsrHost } from "../src/hsr/runnerHost.js";
import { hsrControlSocketPath, writeHsrMeta } from "../src/hsr/runDir.js";

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

test("a non-Cell host scrubs ambient HIVE_CELL stamps before starting the harness child", async () => {
  const handoff = await writePayload(`${JSON.stringify(payload())}\n`);
  const previousCell = process.env.HIVE_CELL;
  const previousSpace = process.env.HIVE_CELL_SPACE;
  process.env.HIVE_CELL = "1";
  process.env.HIVE_CELL_SPACE = "honeybee-space-ambient1";
  let observedEnv: Record<string, string> | undefined;
  try {
    await startHsrHostFromPayload(handoff.path, {
      loadAdapter: async () => stubAdapter,
      runHost: async ({ bee, opts }) => {
        observedEnv = opts.env;
        return {
          bee,
          controlSocket: "/tmp/test.sock",
          done: Promise.resolve(),
          stop: async () => undefined,
        };
      },
    });
  } finally {
    if (previousCell === undefined) delete process.env.HIVE_CELL;
    else process.env.HIVE_CELL = previousCell;
    if (previousSpace === undefined) delete process.env.HIVE_CELL_SPACE;
    else process.env.HIVE_CELL_SPACE = previousSpace;
  }
  assert.ok(observedEnv, "runHost received the hydrated child env");
  assert.equal("HIVE_CELL" in observedEnv!, false, "non-Cell child never inherits HIVE_CELL");
  assert.equal("HIVE_CELL_SPACE" in observedEnv!, false, "non-Cell child never inherits HIVE_CELL_SPACE");
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

test("startup failure metadata distinguishes a vanished cwd from an unavailable harness", () => {
  const missingCwd = join(tmpdir(), "definitely-missing-hsr-cwd-71f23a");
  const spawnError = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  assert.deepEqual(hsrStartupFailureForPayload(spawnError, { ...payload(), cwd: missingCwd }), {
    stage: "adapter-start",
    code: "ENOENT",
    message: "HSR working directory disappeared during harness startup",
  });
  assert.deepEqual(hsrStartupFailureForPayload(spawnError, payload()), {
    stage: "adapter-start",
    code: "ENOENT",
    message: "HSR harness executable could not be started",
  });
  const providerFailure = hsrStartupFailureForPayload(
    new Error(`provider response leaked ${SECRET}`),
    payload(),
  );
  assert.equal(providerFailure.message, "HSR harness failed during startup; inspect host.log for provider diagnostics");
  assert.doesNotMatch(providerFailure.message, new RegExp(SECRET));
});

test("parent surfaces the detached startup cause without a false rollback warning", async () => {
  const store = await mkdtemp(join(tmpdir(), "hive-hsr-startup-cause-store-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  const bee = "parent-startup-cause";
  const hostPid = 7654321;
  let spawnOptions: import("node:child_process").SpawnOptions | undefined;
  try {
    await assert.rejects(
      spawnHsrHost(payload(bee), {
        resolveEntry: async () => ({ path: "/unused/runner-entry.js", mode: "dedicated" }),
        spawn: ((_command: string, _args: readonly string[], options: import("node:child_process").SpawnOptions) => {
          spawnOptions = options;
          const child = new EventEmitter() as EventEmitter & {
            pid: number;
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
            unref(): void;
            kill(signal?: NodeJS.Signals | number): boolean;
          };
          child.pid = hostPid;
          child.exitCode = null;
          child.signalCode = null;
          child.unref = () => undefined;
          child.kill = (signal = "SIGTERM") => {
            child.signalCode = typeof signal === "string" ? signal : "SIGTERM";
            queueMicrotask(() => child.emit("exit", null, child.signalCode));
            return true;
          };
          queueMicrotask(() => {
            void writeHsrMeta(bee, {
              bee,
              harness: "stub",
              tier: "stream",
              hostPid,
              hostFingerprint: { pgid: hostPid, startedAt: "test-parent-startup" },
              childAdmission: "none",
              startupFailure: {
                stage: "adapter-start",
                code: "ENOENT",
                message: "HSR working directory disappeared during harness startup",
              },
              startedAt: "2026-08-09T08:14:03.958Z",
              controlSocket: hsrControlSocketPath(bee),
              status: "exited",
              endedAt: "2026-08-09T08:14:03.969Z",
            });
          });
          return child;
        }) as unknown as typeof import("node:child_process").spawn,
      }),
      (error: Error) => {
        assert.equal(error.message, "HSR working directory disappeared during harness startup");
        assert.doesNotMatch(error.message, /rollback is unconfirmed/);
        return true;
      },
    );
    assert.equal(spawnOptions?.detached, true, "runner host owns a new session/process group");
    assert.equal(spawnOptions?.stdio?.[0], "ignore", "runner host cannot retain daemon stdin");
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(store, { recursive: true, force: true });
  }
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

test("parent rejects a missing working directory before spawning a detached host", async () => {
  const missingCwd = join(tmpdir(), "definitely-missing-parent-hsr-cwd-71f23a");
  let spawned = false;
  await assert.rejects(
    spawnHsrHost({ ...payload("missing-parent-cwd"), cwd: missingCwd }, {
      spawn: (() => {
        spawned = true;
        throw new Error("must not spawn");
      }) as typeof import("node:child_process").spawn,
    }),
    /HSR working directory is no longer available.*restore or recreate the working copy/,
  );
  assert.equal(spawned, false);
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
