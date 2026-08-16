import assert from "node:assert/strict";
import { chmod, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { spawnBee, type SpawnRuntimeDependencies } from "../src/commands/spawn.js";
import { matchesCellBrokerCapability } from "../src/cellBrokerCapability.js";
import type { JsonObject } from "../src/execution/contract.js";
import { createHsrRunLauncher } from "../src/execution/launcher.js";
import { IndeterminateExecutionError } from "../src/execution/errors.js";
import { registerWorkingCopy } from "../src/execution/workingCopies.js";
import { loadSession, saveSession } from "../src/store.js";
import { beeNameLaunchReservationPath, readBeeNameLaunchReservation } from "../src/nameAdmission.js";
import { SpawnAfterForkError, type SpawnedRuntimeHandle } from "../src/spawnRuntime.js";
import { ensureHsrRunDir, hsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import type { HsrRunPayload } from "../src/hsr/runnerHost.js";
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
    readHsrMetaStrict: async (bee) => ({
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: HOST_PID,
      hostFingerprint: { pgid: HOST_PID, startedAt: "fake-host-birth" },
      childAdmission: "none",
      startedAt: "2026-08-07T00:00:00.000Z",
      controlSocket: "/tmp/fake-hsr-control.sock",
      status: "queued",
    }),
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

test("fresh execution Cell publishes only a generation-bound broker verifier", async () => {
  await withTempStore(async () => {
    let payload: HsrRunPayload | undefined;
    const record = await spawnBee(spawnOptions(), baseRuntimeDeps({
      spawnHsrHost: async (next) => {
        payload = next;
        return HOST_PID;
      },
      saveSession,
    }));
    assert.equal(typeof payload?.cellBrokerCapability, "string");
    assert.equal(matchesCellBrokerCapability(record, payload?.cellBrokerCapability), true);
    assert.equal(record.runtimeGeneration ?? 0, 0);
    assert.equal("cellBrokerCapability" in record, false, "plaintext token is not a SessionRecord field");
    assert.equal(JSON.stringify(record).includes(payload!.cellBrokerCapability!), false);
  });
});

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

test("save-after-rename is kill_failed-fenced before stop, then exact-purged", async () => {
  await withTempStore(async () => {
    let statusAtStop: string | undefined;
    await assert.rejects(
      spawnBee(spawnOptions(), baseRuntimeDeps({
        saveSession: async (record) => {
          await saveSession(record);
          throw new Error("injected acknowledgement loss after atomic SessionRecord rename");
        },
        stopHsrIncarnationByPid: async (bee) => {
          statusAtStop = (await loadSession(bee))?.status;
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
      })),
      /acknowledgement loss/,
    );
    assert.equal(statusAtStop, "kill_failed", "durable non-runnable fence precedes the first signal");
    assert.equal(await loadSession(spawnOptions().name), null);
    assert.equal(await readBeeNameLaunchReservation(spawnOptions().name), null);
  });
});

test("crash after rollback stop dispatch leaves canonical and journal stop doubt", async () => {
  await withTempStore(async () => {
    let statusAtStop: string | undefined;
    await assert.rejects(
      spawnBee(spawnOptions(), baseRuntimeDeps({
        saveSession,
        writeSpawnOptions: async () => { throw new Error("injected publication failure"); },
        stopHsrIncarnationByPid: async (bee) => {
          statusAtStop = (await loadSession(bee))?.status;
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
        afterLaunchRollbackStopDispatch: async () => {
          throw new Error("injected coordinator crash after stop dispatch");
        },
      })),
      /canonical publication settlement unconfirmed/,
    );
    assert.equal(statusAtStop, "kill_failed");
    assert.equal((await loadSession(spawnOptions().name))?.status, "kill_failed");
    assert.equal((await readBeeNameLaunchReservation(spawnOptions().name))?.phase, "stop_doubt");
  });
});

test("confirmed pre-publication HSR rollback removes exact run state and permits same-name retry", async () => {
  await withTempStore(async () => {
    const bee = spawnOptions().name;
    const fingerprint = { pgid: HOST_PID, startedAt: "fake-host-birth" };
    await assert.rejects(
      spawnBee(spawnOptions(), baseRuntimeDeps({
        spawnHsrHost: async () => {
          await ensureHsrRunDir(bee);
          await writeHsrMeta(bee, {
            bee,
            harness: "stub",
            tier: "stream",
            hostPid: HOST_PID,
            hostFingerprint: fingerprint,
            childAdmission: "none",
            startedAt: "2026-08-07T00:00:00.000Z",
            controlSocket: "/tmp/fake-hsr-control.sock",
            status: "queued",
          });
          return HOST_PID;
        },
        saveSession: async () => { throw new Error("injected pre-publication save failure"); },
        stopHsrIncarnationByPid: async () => {
          await writeHsrMeta(bee, {
            bee,
            harness: "stub",
            tier: "stream",
            hostPid: HOST_PID,
            hostFingerprint: fingerprint,
            childAdmission: "none",
            startedAt: "2026-08-07T00:00:00.000Z",
            controlSocket: "/tmp/fake-hsr-control.sock",
            status: "exited",
          });
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
      })),
      /pre-publication save failure/,
    );
    await assert.rejects(stat(hsrRunDir(bee)), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal(await readBeeNameLaunchReservation(bee), null);

    const retry = await spawnBee(spawnOptions(), baseRuntimeDeps({ saveSession }));
    assert.equal(retry.name, bee, "confirmed artifact cleanup makes the same logical name reusable");
  });
});

test("execution Cell credential-bearing proxy refusal happens before launch admission or dispatch", async () => {
  await withTempStore(async () => {
    const previous = process.env.HTTPS_PROXY;
    let dispatches = 0;
    process.env.HTTPS_PROXY = "http://proxy-user:proxy-secret@node-proxy.example:8080";
    try {
      await assert.rejects(
        spawnBee(spawnOptions(), baseRuntimeDeps({
          spawnHsrHost: async () => {
            dispatches += 1;
            return HOST_PID;
          },
        })),
        /credential-bearing HTTPS_PROXY/,
      );
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
    assert.equal(dispatches, 0);
    assert.equal(await readBeeNameLaunchReservation(spawnOptions().name), null);
    assert.equal(await loadSession(spawnOptions().name), null);
  });
});

test("unreadable HSR birth metadata after fork cannot leak the detached host", async () => {
  await withTempStore(async () => {
    const stops: Array<{ bee: string; pid: number }> = [];
    await assert.rejects(
      spawnBee(spawnOptions(), baseRuntimeDeps({
        readHsrMetaStrict: async () => { throw new Error("injected corrupt admission metadata"); },
        stopHsrIncarnationByPid: async (bee, pid) => {
          stops.push({ bee, pid });
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
      })),
      (error: unknown) => {
        assert.ok(error instanceof SpawnAfterForkError);
        assert.equal(error.phase, "runtime-admission");
        assert.equal(error.runtime.identity.hostPid, HOST_PID);
        assert.equal(error.cleanup.stopped, true);
        assert.match(error.message, /corrupt admission metadata/);
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

test("locator-journal write failure after dispatch cannot erase an unconfirmed runtime fence", async () => {
  await withTempStore(async () => {
    const name = spawnOptions().name;
    const reservationDir = dirname(beeNameLaunchReservationPath(name));
    let madeReadOnly = false;
    try {
      await assert.rejects(
        spawnBee(spawnOptions(), baseRuntimeDeps({
          spawnHsrHost: async () => {
            await chmod(reservationDir, 0o500);
            madeReadOnly = true;
            return HOST_PID;
          },
          stopHsrIncarnationByPid: async () => ({
            ok: false,
            stdout: "",
            stderr: "injected exact cleanup uncertainty",
            exitCode: 1,
          }),
        })),
        (error: unknown) => {
          assert.ok(error instanceof SpawnAfterForkError);
          assert.equal(error.phase, "runtime-admission");
          assert.equal(error.cleanup.stopped, false);
          return true;
        },
      );
    } finally {
      if (madeReadOnly) await chmod(reservationDir, 0o700);
    }

    const reservation = await readBeeNameLaunchReservation(name);
    assert.equal(reservation?.phase, "dispatching", "dispatch ambiguity remains fenced even when locator persistence failed");
    const ownership = await loadSession(name);
    assert.equal(ownership?.status, "kill_failed");
    assert.equal(ownership?.runnerPid, HOST_PID, "the fallback ownership row retains the exact runtime locator");
  });
});

test("confirmed post-fork rollback removes the stopped publication so recovery cannot revive it", async () => {
  await withTempStore(async () => {
    await assert.rejects(
      spawnBee(spawnOptions(), baseRuntimeDeps({
        saveSession,
        writeSpawnOptions: async () => { throw new Error("injected writeSpawnOptions failure"); },
      })),
      (error: unknown) => {
        assert.ok(error instanceof SpawnAfterForkError);
        assert.equal(error.phase, "spawn-options");
        assert.equal(error.cleanup.stopped, true);
        return true;
      },
    );
    const record = await loadSession("protocol-post-fork-test");
    assert.equal(record, null, "the stopped failed launch is not a runnable recovery candidate");
    assert.equal(
      await readBeeNameLaunchReservation("protocol-post-fork-test"),
      null,
      "exact runtime stop settles the matching name journal before failure is definite",
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
        assert.match(error.message, /exact canonical cleanup was unconfirmed/);
        return true;
      },
    );
  });
});
