/**
 * WP5 runner-host separation: a daemon restart must not kill an hsr runtime
 * or degrade its delivery. The runtime lives under a detached host that owns
 * the agent's pipes; a "restarted daemon" (a fresh HsrDriver over the same
 * dirs) re-adopts by host pid identity at FULL capability — same agent
 * process, working deliver, observed turns — where the old direct-child
 * design lost the pipes and rotated the generation on the next message
 * (the "deploys kill all hsr runtimes" incident class).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HsrDriver, type SpawnSpec } from "../src/index.ts";
import { stubAdapter } from "../../adapters/src/index.ts";
import { AGENT_PATH, drainUntil, ofKind, pidAlive, sleep } from "./helpers.ts";

function makeDriver(dir: string): HsrDriver {
  return new HsrDriver({
    sessionLogDir: join(dir, "logs"),
    stopKillGraceMs: 400,
    resolve(): SpawnSpec {
      return {
        adapter: stubAdapter,
        command: process.execPath,
        args: [AGENT_PATH],
        cwd: dir,
        env: { ...process.env, STUB_TURN_MS: "5" },
      };
    },
  });
}

test("daemon restart: the runtime survives and the successor daemon delivers at full capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-runner-host-"));
  const first = makeDriver(dir);
  let second: HsrDriver | null = null;
  try {
    first.start("bee-r", 1);
    await drainUntil(first, (e) => ofKind(e, "booted").length > 0);
    assert.equal(first.deliver("bee-r", 1, 1, "hello before restart").accepted, true);
    await drainUntil(first, (e) => ofKind(e, "turn_ended").length > 0);
    const proc = first.procOf("bee-r", 1)!;
    assert.ok(proc.pid > 0);

    // "Daemon restart": the first driver releases its handles WITHOUT
    // signaling (the real daemon's shutdown path), and a fresh driver over
    // the same directories adopts by recorded identity.
    first.detachAll();
    assert.ok(pidAlive(proc.pid), "the runtime must survive the daemon");

    second = makeDriver(dir);
    // The store knew the runtime was idle at shutdown; the hint opens the
    // accept point immediately and avoids fabricating a running turn (the
    // 2026-08-21 deploy-soak hang_stop lesson).
    assert.equal(second.adopt("bee-r", 1, proc.pid, proc.pidStartedAt, "idle"), true);
    assert.equal(second.isDegraded("bee-r", 1), false, "host adoption is never degraded");
    assert.ok(second.hasProcess("bee-r", 1));

    // Full capability: an idle-adopted runtime accepts on the first attempt
    // once the socket is up.
    const deadline = Date.now() + 4000;
    let accepted = false;
    while (!accepted && Date.now() < deadline) {
      second.observe();
      accepted = second.deliver("bee-r", 1, 2, "hello after restart").accepted;
      if (!accepted) await sleep(20);
    }
    assert.ok(accepted, "successor daemon must deliver to the adopted runtime");
    await drainUntil(second, (e) => ofKind(e, "turn_ended").length > 0);

    // Same agent, same host: nothing was respawned across the restart.
    const after = second.procOf("bee-r", 1)!;
    assert.equal(after.pid, proc.pid);

    // Both deliveries are in ONE verbatim session log (Q1 held throughout).
    const log = readFileSync(join(dir, "logs", "bee-r.jsonl"), "utf8");
    assert.ok(log.includes("hello before restart"));
    assert.ok(log.includes("hello after restart"));

    // Stop through the successor: the exact host pid dies with its agent.
    assert.deepEqual(second.stop("bee-r", 1, "stopped_by_user"), { hadProcess: true });
    await drainUntil(second, (e) => ofKind(e, "exited").length > 0);
    await sleep(30);
    assert.ok(!pidAlive(proc.pid), "host and agent must be gone after stop");
  } finally {
    second?.disposeAll();
    first.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoption with dead host artifacts falls back to refusing, never a phantom runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-runner-host-"));
  const driver = makeDriver(dir);
  try {
    driver.start("bee-x", 1);
    await drainUntil(driver, (e) => ofKind(e, "booted").length > 0);
    const proc = driver.procOf("bee-x", 1)!;
    driver.stop("bee-x", 1, "stopped_by_user");
    await drainUntil(driver, (e) => ofKind(e, "exited").length > 0);
    await sleep(30);

    const successor = makeDriver(dir);
    // The recorded pid is dead: adoption must refuse (the daemon then marks
    // the runtime stopped), never fabricate a live process.
    assert.equal(successor.adopt("bee-x", 1, proc.pid, proc.pidStartedAt), false);
    successor.disposeAll();
  } finally {
    driver.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
