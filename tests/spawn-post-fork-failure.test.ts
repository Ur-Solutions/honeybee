import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnBee, type SpawnRuntimeDependencies } from "../src/commands/spawn.js";
import type { JsonObject } from "../src/execution/contract.js";
import { createHsrRunLauncher } from "../src/execution/launcher.js";
import { IndeterminateExecutionError } from "../src/execution/errors.js";
import { registerWorkingCopy } from "../src/execution/workingCopies.js";
import { saveSession } from "../src/store.js";
import { SpawnAfterForkError, type SpawnedRuntimeHandle } from "../src/spawnRuntime.js";
import {
  buildRunStartEnvelope,
  CANONICAL_NODE_ID,
  installTestAuthority,
  SNAPSHOT_DIGEST,
  withTempStore,
} from "./executionTestKit.js";

const HOST_PID = 43123;

function baseRuntimeDeps(overrides: SpawnRuntimeDependencies): SpawnRuntimeDependencies {
  return {
    spawnHsrHost: async () => HOST_PID,
    captureProcessBirthFingerprint: async () => ({ pgid: HOST_PID, startedAt: "fake-host-birth" }),
    stopHsrIncarnationByPid: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    ...overrides,
  };
}

function spawnOptions() {
  return {
    agent: "node",
    extraArgs: [] as string[],
    cwd: process.cwd(),
    yolo: false,
    name: "protocol-post-fork-test",
    substrate: "hsr" as const,
    executionRunId: "run-post-fork-test",
  };
}

test("saveSession failure after HSR fork tears down the exact returned host incarnation", async () => {
  await withTempStore(async () => {
    const stops: Array<{ bee: string; pid: number }> = [];
    await assert.rejects(
      spawnBee(spawnOptions(), baseRuntimeDeps({
        saveSession: async () => { throw new Error("injected saveSession failure"); },
        stopHsrIncarnationByPid: async (bee, pid) => {
          stops.push({ bee, pid });
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
      })),
      (error: unknown) => {
        assert.ok(error instanceof SpawnAfterForkError);
        assert.equal(error.phase, "session-save");
        assert.equal(error.runtime.identity.hostPid, HOST_PID);
        assert.equal(error.cleanup.stopped, true);
        return true;
      },
    );
    assert.deepEqual(stops, [{ bee: "protocol-post-fork-test", pid: HOST_PID }]);
  });
});

test("writeSpawnOptions failure after HSR fork reports unconfirmed exact teardown phase", async () => {
  await withTempStore(async () => {
    await assert.rejects(
      spawnBee(spawnOptions(), baseRuntimeDeps({
        saveSession,
        writeSpawnOptions: async () => { throw new Error("injected writeSpawnOptions failure"); },
        stopHsrIncarnationByPid: async () => ({
          ok: false,
          stdout: "",
          stderr: "injected exact absence unconfirmed",
          exitCode: 1,
        }),
      })),
      (error: unknown) => {
        assert.ok(error instanceof SpawnAfterForkError);
        assert.equal(error.phase, "spawn-options");
        assert.equal(error.runtime.identity.hostPid, HOST_PID);
        assert.equal(error.cleanup.stopped, false);
        assert.match(error.cleanup.detail, /absence unconfirmed/);
        return true;
      },
    );
  });
});

test("protocol launcher maps an unconfirmed post-fork cleanup to IndeterminateExecutionError", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const envelope = buildRunStartEnvelope(ctx);
    const intent = (envelope.body as JsonObject).intent as JsonObject;
    await registerWorkingCopy({
      workingCopyId: "wc-0001",
      productId: "prod-honeycomb-app",
      path: process.cwd(),
      snapshotDigest: SNAPSHOT_DIGEST,
      origin: "https://git.example.com/acme/honeycomb-app.git",
      revision: "3f9c2b7d1a6e4f0c9b8a7d6e5f4c3b2a1d0e9f8c",
    });
    const runtime: SpawnedRuntimeHandle = {
      identity: { kind: "hsr", beeName: "xr-post-fork", hostPid: HOST_PID },
      stop: async () => ({ stopped: false, detail: "injected exact absence unconfirmed" }),
    };
    const launcher = createHsrRunLauncher({
      nodeId: async () => CANONICAL_NODE_ID,
      spawn: async () => {
        throw new SpawnAfterForkError(
          "spawn-options",
          runtime,
          { stopped: false, detail: "injected exact absence unconfirmed" },
          new Error("injected writeSpawnOptions failure"),
        );
      },
    });

    await assert.rejects(
      launcher({ runId: "run-0001", beeName: "xr-post-fork", intent, lease: {} }),
      (error: unknown) => {
        assert.ok(error instanceof IndeterminateExecutionError);
        assert.equal(error.cause, "spawn_cleanup_unconfirmed");
        assert.match(error.message, /exact cleanup was unconfirmed/);
        return true;
      },
    );
  });
});
