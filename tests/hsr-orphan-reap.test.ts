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
import { test } from "node:test";
import { killOrphanedChildGroup, reapDeadHosts } from "../src/hsr/observe.js";
import { serve } from "../src/hsr/remoteHost.js";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { ensureHsrRunDir, hsrRunDir, readHsrMeta, writeHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";

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

/** A pid that is guaranteed dead: a child that already ran to completion. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid as number;
}

/**
 * Write the crash aftermath: meta says "running" but hostPid is dead and the
 * detached child (childPgid) is still alive with no control socket.
 */
async function writeOrphanedMeta(bee: string, childPid: number, storeDir: string): Promise<void> {
  await ensureHsrRunDir(bee);
  await writeHsrMeta(bee, {
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: await deadPid(),
    childPid,
    childPgid: childPid, // detached ⇒ pgid === child pid
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
  const gone = await deadPid();
  assert.equal(
    await killOrphanedChildGroup({
      bee: "x",
      harness: "stub",
      tier: "stream",
      hostPid: gone,
      childPid: gone,
      childPgid: gone,
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
