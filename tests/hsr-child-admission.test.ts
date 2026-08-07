import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { runHsrHost } from "../src/hsr/host.js";
import { reapDeadHosts } from "../src/hsr/observe.js";
import {
  capturePersistableProcessBirthFingerprint,
  captureProcessBirthFingerprint,
  inspectProcessBirth,
} from "../src/hsr/processIdentity.js";
import { spawnHsrHost } from "../src/hsr/runnerHost.js";
import { ensureHsrRunDir, hsrControlSocketPath, hsrMetaPath, hsrRunDir, readHsrMetaStrict, writeHsrMeta } from "../src/hsr/runDir.js";
import { stopHsrIncarnationByPid } from "../src/hsr/substrate.js";
import type { ProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import type { RunnerOpts } from "../src/hsr/types.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-admission-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function detachedRuntimeAvailable(): boolean {
  try {
    execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=", "-p", String(process.pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function opts(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

test("detached runner publishes an OS-comparable host birth fingerprint", { skip: !detachedRuntimeAvailable() }, async () => {
  await withTempStore(async () => {
    const bee = "cross-process-host-birth";
    const hostPid = await spawnHsrHost({
      bee,
      comb: bee,
      kind: "stub",
      cwd: process.cwd(),
      authKind: "subscription",
      spec: { command: process.execPath, args: [], env: process.env as Record<string, string> },
    });
    try {
      const meta = await readHsrMetaStrict(bee);
      assert.equal(meta?.hostPid, hostPid);
      assert.ok(meta?.hostFingerprint);
      assert.doesNotMatch(meta.hostFingerprint.startedAt, /^node-time-origin:/);
      assert.equal(await inspectProcessBirth(hostPid, meta.hostFingerprint), "match");
    } finally {
      const stopped = await stopHsrIncarnationByPid(bee, hostPid);
      assert.equal(stopped.ok, true, stopped.stderr);
    }
  });
});

test("contained self fallback stays process-local and cannot become a durable detached identity", async () => {
  const denied = async (): Promise<never> => { throw new Error("process census denied"); };
  assert.equal(await capturePersistableProcessBirthFingerprint(process.pid, denied), undefined);
  const local = await captureProcessBirthFingerprint(process.pid, denied);
  assert.ok(local);
  assert.match(local.startedAt, /^node-time-origin:/);
  assert.equal(await inspectProcessBirth(process.pid, local, denied), "match");
  assert.equal(
    await captureProcessBirthFingerprint(process.pid + 1, denied),
    undefined,
    "the synthetic token is never minted for an external/detached pid",
  );
});

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("child identity is durable before readiness so a crashed host reaper stops the exact group", async () => {
  await withTempStore(async () => {
    const bee = "publication-barrier";
    const births = new Map<number, ProcessBirthFingerprint>();
    const capture = async (pid: number): Promise<ProcessBirthFingerprint> => {
      const fingerprint = births.get(pid) ?? { pgid: pid, startedAt: `test-birth:${pid}` };
      births.set(pid, fingerprint);
      return fingerprint;
    };
    let admitted!: { pid: number; pgid: number };
    let entered!: () => void;
    const admissionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let rejectBarrier!: (error: Error) => void;
    const barrier = new Promise<void>((_resolve, reject) => { rejectBarrier = reject; });

    const starting = runHsrHost({
      bee,
      adapter: stubAdapter,
      opts: opts(bee),
      queueStartup: true,
      processBirthCapture: { capture, timeoutMs: 0 },
      afterChildAdmission: async (identity) => {
        admitted = identity;
        entered();
        await barrier;
      },
    });
    await admissionEntered;
    const published = await readHsrMetaStrict(bee);
    assert.equal(published?.status, "queued", "readiness publication is still paused");
    assert.equal(published?.childAdmission, "admitted");
    assert.equal(published?.childPid, admitted.pid);
    assert.deepEqual(published?.childFingerprint, births.get(admitted.pid));
    assert.equal(isGroupAlive(admitted.pgid), true);

    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const reaped = await reapDeadHosts({
      readProcessIdentity: async (pid) => pid === process.pid
        ? null
        : isGroupAlive(admitted.pgid) ? births.get(pid) ?? null : null,
      isProcessGroupAlive: isGroupAlive,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        process.kill(pid, signal);
      },
    });
    assert.deepEqual(reaped, [bee]);
    assert.ok(signals.some(([pid, signal]) => pid === -admitted.pgid && signal === "SIGTERM"));
    await waitFor(() => !isGroupAlive(admitted.pgid), "admitted child group exit");

    rejectBarrier(new Error("simulated host crash at readiness barrier"));
    await assert.rejects(starting, /simulated host crash at readiness barrier/);
    assert.equal((await readHsrMetaStrict(bee))?.status, "exited");
  });
});

test("a dead host with incomplete child admission remains unresolved", async () => {
  await withTempStore(async () => {
    const bee = "pending-admission";
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: 5101,
      hostFingerprint: { pgid: 5101, startedAt: "test-host-birth" },
      childAdmission: "pending",
      startedAt: "2026-08-07T10:00:00.000Z",
      controlSocket: hsrControlSocketPath(bee),
      status: "queued",
    });
    const reaped = await reapDeadHosts({ readProcessIdentity: async () => null });
    assert.deepEqual(reaped, []);
    assert.equal((await readHsrMetaStrict(bee))?.status, "queued");
  });
});

test("child birth capture failure rolls back the live ChildProcess and never publishes running", async () => {
  await withTempStore(async () => {
    const bee = "child-capture-failure";
    let childPid: number | undefined;
    const selfBirth = { pgid: process.pid, startedAt: "test-self-birth" };
    await assert.rejects(
      runHsrHost({
        bee,
        adapter: stubAdapter,
        opts: opts(bee),
        processBirthCapture: {
          timeoutMs: 0,
          capture: async (pid) => {
            if (pid === process.pid) return selfBirth;
            childPid = pid;
            return undefined;
          },
        },
      }),
      /HSR child birth admission failed.*no matching birth fingerprint/,
    );
    assert.ok(childPid, "the adapter spawned a child before injected capture failed");
    await waitFor(() => {
      try {
        process.kill(childPid!, 0);
        return false;
      } catch {
        return true;
      }
    }, "capture-failed child rollback");
    const meta = await readHsrMetaStrict(bee);
    assert.equal(meta?.status, "exited");
    assert.notEqual(meta?.status, "running");
    assert.equal(meta?.childAdmission, "pending");
  });
});

test("host birth capture failure starts no adapter and publishes no runtime metadata", async () => {
  await withTempStore(async () => {
    const bee = "host-capture-failure";
    let adapterStarts = 0;
    await assert.rejects(
      runHsrHost({
        bee,
        adapter: {
          ...stubAdapter,
          async start(runnerOpts) {
            adapterStarts += 1;
            return stubAdapter.start(runnerOpts);
          },
        },
        opts: opts(bee),
        processBirthCapture: { timeoutMs: 0, capture: async () => undefined },
      }),
      /HSR host birth admission failed/,
    );
    assert.equal(adapterStarts, 0);
    assert.equal(await readHsrMetaStrict(bee), null);
  });
});

test("startup never overwrites a corrupt existing HSR child locator", async () => {
  await withTempStore(async () => {
    const bee = "corrupt-startup-locator";
    await ensureHsrRunDir(bee);
    const corrupt = `{"bee":"${bee}","childPid":9090`;
    await writeFile(hsrMetaPath(bee), corrupt, { mode: 0o600 });
    let adapterStarts = 0;
    await assert.rejects(
      runHsrHost({
        bee,
        adapter: {
          ...stubAdapter,
          async start(runnerOpts) {
            adapterStarts += 1;
            return stubAdapter.start(runnerOpts);
          },
        },
        opts: opts(bee),
        processBirthCapture: {
          timeoutMs: 0,
          capture: async (pid) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
        },
      }),
      /Invalid JSON in HSR metadata/,
    );
    assert.equal(adapterStarts, 0);
    assert.equal(await readFile(hsrMetaPath(bee), "utf8"), corrupt);
  });
});
