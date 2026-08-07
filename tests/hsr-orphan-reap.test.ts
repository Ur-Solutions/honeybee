/**
 * HIVE-53: detached harness children must not orphan when their host dies
 * without finalize (SIGKILL/OOM — locally a crashed `__hsr-run`, remotely the
 * serve whose in-process runners share its pid as meta.hostPid).
 *
 * Each test fabricates the crash aftermath for real: a live detached child
 * (its own group leader, like a harness child) recorded in meta.json as
 * childPid/childPgid, with hostPid pointing at an already-dead process and
 * status stuck "running". Then asserts the recovery path actually stops the
 * child:
 *   - reapDeadHosts kills the orphan group and flips meta to "exited"
 *   - remoteHost.serve() runs that reaper at startup (serve-restart adoption)
 *   - the remote `kill` RPC signals the child group when the host is gone
 *     (previously it rm'd the run dir and leaked the still-running harness)
 *   - the local substrate kill does the same for a crashed local host
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { killOrphanedChildGroup, reapDeadHosts } from "../src/hsr/observe.js";
import { buildController, serve } from "../src/hsr/remoteHost.js";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { ensureHsrRunDir, hsrRunDir, readHsrMeta, writeHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate, stopHsrIncarnation } from "../src/hsr/substrate.js";
import { captureProcessBirthFingerprint, type ProcessBirthFingerprint } from "../src/hsr/processIdentity.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SHORT /tmp base (not tmpdir()): serve()'s AF_UNIX socket path lives under the
 * store root and macOS caps socket paths at ~104 chars.
 */
async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-orph-");
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A stand-in harness child: detached (own group leader) and long-lived. */
function spawnOrphan(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
}

async function fingerprint(pid: number): Promise<ProcessBirthFingerprint> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await captureProcessBirthFingerprint(pid);
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`could not fingerprint pid ${pid}`);
}

async function deadProcessIdentity(): Promise<{ pid: number; fingerprint: ProcessBirthFingerprint }> {
  const child = spawnOrphan();
  const pid = child.pid as number;
  const identity = await fingerprint(pid);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { pid, fingerprint: identity };
}

/**
 * Write the crash aftermath: meta says "running" but hostPid is dead and the
 * detached child (childPgid) is still alive with no control socket.
 */
async function writeOrphanedMeta(bee: string, childPid: number, storeDir: string): Promise<void> {
  const childFingerprint = await fingerprint(childPid);
  const deadHost = await deadProcessIdentity();
  await ensureHsrRunDir(bee);
  await writeHsrMeta(bee, {
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: deadHost.pid,
    hostFingerprint: deadHost.fingerprint,
    childPid,
    childPgid: childPid, // detached ⇒ pgid === child pid
    childFingerprint,
    startedAt: new Date().toISOString(),
    controlSocket: join(storeDir, "gone.sock"), // never existed — connect fails
    status: "running",
  });
}

test("reapDeadHosts kills the orphaned harness child group and flips meta to exited", async () => {
  await withTempStore(async (dir) => {
    const bee = "orphanreap";
    const orphan = spawnOrphan();
    try {
      await writeOrphanedMeta(bee, orphan.pid as number, dir);
      assert.ok(isPidAlive(orphan.pid as number), "orphan child is alive before the reap");

      const reaped = await reapDeadHosts();
      assert.ok(reaped.includes(bee), "reap reports the orphaned bee");

      await waitFor(() => !isPidAlive(orphan.pid as number), "orphan child killed by the reap");
      const meta = await readHsrMeta(bee);
      assert.equal(meta?.status, "exited");
      assert.ok(meta?.endedAt, "reaped meta carries endedAt");
    } finally {
      try {
        orphan.kill("SIGKILL");
      } catch {
        // already dead — the expected outcome
      }
    }
  });
});

test("killOrphanedChildGroup is a no-op (false) for a dead group or a meta without a child pgid", async () => {
  const gone = await deadProcessIdentity();
  assert.equal(
    await killOrphanedChildGroup({
      bee: "x",
      harness: "stub",
      tier: "stream",
      hostPid: gone.pid,
      hostFingerprint: gone.fingerprint,
      childPid: gone.pid,
      childPgid: gone.pid,
      childFingerprint: gone.fingerprint,
      startedAt: new Date().toISOString(),
      controlSocket: "/tmp/none.sock",
      status: "running",
    }),
    false,
    "dead child group → nothing to signal",
  );
  assert.equal(await killOrphanedChildGroup(null), false);
});

test("remoteHost.serve() reaps orphans at startup: a serve restart adopts and kills the leaked harness", async () => {
  await withTempStore(async (dir) => {
    const bee = "servereap";
    const orphan = spawnOrphan();
    let server: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      // The aftermath of the OLD serve dying without finalize: its in-process
      // runner's meta still says "running" with hostPid = the dead serve's pid.
      await writeOrphanedMeta(bee, orphan.pid as number, dir);

      // A NEW serve starting on the same node must adopt the orphan.
      server = await serve(join(dir, "control.sock"));

      await waitFor(() => !isPidAlive(orphan.pid as number), "startup reaper killed the orphan");
      const meta = await readHsrMeta(bee);
      assert.equal(meta?.status, "exited");
    } finally {
      await server?.close();
      try {
        orphan.kill("SIGKILL");
      } catch {
        // already dead — the expected outcome
      }
    }
  });
});

test("remote kill RPC signals the orphaned child group when the host is gone (and still removes the run dir)", async () => {
  await withTempStore(async (dir) => {
    const bee = "killorphan";
    let orphan: ChildProcess | undefined;
    const server = await serve(join(dir, "control.sock"));
    try {
      // Orphan created AFTER serve start, so the startup reaper cannot have
      // handled it — this exercises the kill path's own fallback.
      orphan = spawnOrphan();
      await writeOrphanedMeta(bee, orphan.pid as number, dir);

      const client = await connectRpcClient(join(dir, "control.sock"));
      try {
        const result = (await client.call("kill", { bee })) as { ok?: boolean };
        assert.equal(result.ok, true);
      } finally {
        client.close();
      }

      await waitFor(() => !isPidAlive(orphan!.pid as number), "kill stopped the orphaned harness child");
      assert.equal(existsSync(hsrRunDir(bee)), false, "kill removed the run dir");
    } finally {
      await server.close();
      try {
        orphan?.kill("SIGKILL");
      } catch {
        // already dead — the expected outcome
      }
    }
  });
});

test("local substrate kill signals the orphaned child group of a crashed local host", async () => {
  await withTempStore(async (dir) => {
    const bee = "localorphan";
    const orphan = spawnOrphan();
    try {
      await writeOrphanedMeta(bee, orphan.pid as number, dir);

      const result = await hsrSubstrate().kill(bee);
      assert.equal(result.ok, true);

      await waitFor(() => !isPidAlive(orphan.pid as number), "local kill stopped the orphaned harness child");
    } finally {
      try {
        orphan.kill("SIGKILL");
      } catch {
        // already dead — the expected outcome
      }
    }
  });
});

test("local substrate stop never adopts a replacement incarnation's child process group", { timeout: 10_000 }, async () => {
  await withTempStore(async (dir) => {
    const bee = "replacement-race";
    const initialHost = spawnOrphan();
    const replacementHost = spawnOrphan();
    const replacementChild = spawnOrphan();
    const [initialFingerprint, replacementFingerprint, replacementChildFingerprint] = await Promise.all([
      fingerprint(initialHost.pid as number),
      fingerprint(replacementHost.pid as number),
      fingerprint(replacementChild.pid as number),
    ]);
    const socketPath = join(dir, "race.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        void writeHsrMeta(bee, {
          bee,
          harness: "stub",
          tier: "stream",
          hostPid: replacementHost.pid as number,
          hostFingerprint: replacementFingerprint,
          childPid: replacementChild.pid as number,
          childPgid: replacementChild.pid as number,
          childFingerprint: replacementChildFingerprint,
          startedAt: new Date().toISOString(),
          runningAt: new Date().toISOString(),
          controlSocket: socketPath,
          status: "running",
        }).finally(() => socket.destroy());
      });
    });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, resolveListen);
      });
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, {
        bee,
        harness: "stub",
        tier: "stream",
        hostPid: initialHost.pid as number,
        hostFingerprint: initialFingerprint,
        startedAt: new Date().toISOString(),
        controlSocket: socketPath,
        status: "queued",
      });

      const result = await hsrSubstrate().kill(bee);
      assert.equal(result.ok, false, "a still-live initial pid plus replacement meta is honestly unconfirmed");
      assert.equal(isPidAlive(initialHost.pid as number), true, "initial host is not blindly signalled after identity changes");
      assert.equal(isPidAlive(replacementHost.pid as number), true, "replacement host is untouched");
      assert.equal(isPidAlive(replacementChild.pid as number), true, "replacement child process group is untouched");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const processToStop of [initialHost, replacementHost]) {
        try {
          processToStop.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
      try {
        process.kill(-(replacementChild.pid as number), "SIGKILL");
      } catch {
        // already dead
      }
    }
  });
});

test("orphan cleanup never signals a reused numeric child PID or PGID", async () => {
  const recorded = { pgid: 4242, startedAt: "Mon Aug  7 09:00:00 2026" };
  const replacement = { pgid: 4242, startedAt: "Mon Aug  7 09:01:00 2026" };
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const result = await killOrphanedChildGroup(
    {
      bee: "reused-child",
      harness: "stub",
      tier: "stream",
      hostPid: 111,
      hostFingerprint: { pgid: 111, startedAt: recorded.startedAt },
      childPid: 4242,
      childPgid: 4242,
      childFingerprint: recorded,
      startedAt: new Date().toISOString(),
      controlSocket: "/tmp/none.sock",
      status: "running",
    },
    {
      readProcessIdentity: async () => replacement,
      isProcessGroupAlive: () => true,
      kill: (pid, signal) => signals.push([pid, signal]),
    },
  );
  assert.equal(result, false);
  assert.deepEqual(signals, [], "recycled numeric group receives neither TERM nor KILL");
});

test("local HSR fallback treats a reused host PID as the old host gone without signalling", async () => {
  await withTempStore(async () => {
    const recorded = { pgid: 5151, startedAt: "Mon Aug  7 09:00:00 2026" };
    const replacement = { pgid: 5151, startedAt: "Mon Aug  7 09:02:00 2026" };
    const meta = {
      bee: "reused-host",
      harness: "stub",
      tier: "stream" as const,
      hostPid: 5151,
      hostFingerprint: recorded,
      startedAt: new Date().toISOString(),
      controlSocket: "/tmp/none.sock",
      status: "running" as const,
    };
    await ensureHsrRunDir(meta.bee);
    await writeHsrMeta(meta.bee, meta);
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const result = await stopHsrIncarnation(meta.bee, meta, {
      readProcessIdentity: async () => replacement,
      kill: (pid, signal) => signals.push([pid, signal]),
    });
    assert.equal(result.ok, true, "birth mismatch proves only the recorded host incarnation is gone");
    assert.deepEqual(signals, [], "replacement host is never signalled");
  });
});

test("remote kill and startup reaper never signal stale host/child numeric identities", async () => {
  await withTempStore(async (dir) => {
    const bee = "remote-reuse";
    const oldHost = { pgid: 6161, startedAt: "Mon Aug  7 09:00:00 2026" };
    const oldChild = { pgid: 6262, startedAt: "Mon Aug  7 09:00:01 2026" };
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: 6161,
      hostFingerprint: oldHost,
      childPid: 6262,
      childPgid: 6262,
      childFingerprint: oldChild,
      startedAt: new Date().toISOString(),
      controlSocket: join(dir, "gone.sock"),
      status: "running",
    });
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const deps = {
      readProcessIdentity: async (pid: number) => ({
        pgid: pid,
        startedAt: "Mon Aug  7 09:10:00 2026",
      }),
      isProcessGroupAlive: () => true,
      kill: (pid: number, signal: NodeJS.Signals | 0) => signals.push([pid, signal]),
    };

    const controller = buildController({ processSignals: deps });
    const killResult = await controller.methods.kill!({ bee }, { connectionId: 1, close() {} });
    assert.equal((killResult as { ok?: boolean }).ok, true);
    assert.deepEqual(signals, []);
    await controller.close();

    // Recreate the same stale record: serve startup runs reapDeadHosts before
    // accepting RPCs and must apply the identical fail-closed policy.
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: 6161,
      hostFingerprint: oldHost,
      childPid: 6262,
      childPgid: 6262,
      childFingerprint: oldChild,
      startedAt: new Date().toISOString(),
      controlSocket: join(dir, "gone.sock"),
      status: "running",
    });
    const server = await serve(join(dir, "reuse-control.sock"), { processSignals: deps });
    try {
      assert.deepEqual(signals, [], "startup orphan handling never signals recycled identities");
      assert.equal((await readHsrMeta(bee))?.status, "exited");
    } finally {
      await server.close();
    }
  });
});
