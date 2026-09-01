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
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HsrDriver, type SpawnSpec } from "../src/index.ts";
import { codexAdapter, stubAdapter } from "../../adapters/src/index.ts";
import type { DriverObservation } from "../../harness/src/driver.ts";
import { AGENT_PATH, drainUntil as drainDriverUntil, ofKind, pidAlive, sleep } from "./helpers.ts";

const FAKE_CODEX_PATH = join(dirname(AGENT_PATH), "fake-codex.mjs");
const HOST_TEST_TIMEOUT_MS = 60_000;

function drainUntil(
  driver: HsrDriver,
  predicate: (events: DriverObservation[]) => boolean,
  timeoutMs = HOST_TEST_TIMEOUT_MS,
): Promise<DriverObservation[]> {
  return drainDriverUntil(driver, predicate, timeoutMs);
}

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

function makeCodexDriver(dir: string): HsrDriver {
  return new HsrDriver({
    sessionLogDir: join(dir, "logs"),
    stopKillGraceMs: 400,
    resolve(): SpawnSpec {
      return {
        adapter: codexAdapter({ cwd: dir }),
        command: process.execPath,
        args: [FAKE_CODEX_PATH],
        cwd: dir,
        env: { ...(process.env as Record<string, string>) },
      };
    },
  });
}

async function waitForJournal(path: string, predicate: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + HOST_TEST_TIMEOUT_MS;
  for (;;) {
    try {
      const text = readFileSync(path, "utf8");
      if (predicate(text)) return text;
    } catch {
      // The host creates the journal before it becomes adoptable; startup may
      // still be racing this test's first probe.
    }
    if (Date.now() > deadline) throw new Error(`journal condition timed out: ${path}`);
    await sleep(10);
  }
}

function checkpointOf(driver: HsrDriver, beeId: string): number {
  const evidence = driver.observeRecoveryCursors().find((row) => row.beeId === beeId);
  assert.ok(evidence, `missing recovery cursor for ${beeId}`);
  return evidence.cursor;
}

async function deliverUntilAccepted(
  driver: HsrDriver,
  beeId: string,
  generation: number,
  messageId: number,
  body: string,
): Promise<void> {
  const deadline = Date.now() + HOST_TEST_TIMEOUT_MS;
  for (;;) {
    driver.observe();
    if (driver.deliver(beeId, generation, messageId, body).accepted) return;
    if (Date.now() > deadline) throw new Error(`delivery ${messageId} was never confirmed for ${beeId}`);
    await sleep(10);
  }
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
    const checkpoint = checkpointOf(first, "bee-r");
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
    assert.equal(second.adopt("bee-r", 1, proc.pid, proc.pidStartedAt, "idle", checkpoint), true);
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

test("adoption replays a runner-persisted completion missed by the dead daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-runner-recovery-"));
  const first = makeDriver(dir);
  let second: HsrDriver | null = null;
  try {
    first.start("bee-gap", 1);
    await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
    const checkpoint = checkpointOf(first, "bee-gap");
    const proc = first.procOf("bee-gap", 1)!;

    assert.equal(first.deliver("bee-gap", 1, 55, "@slow:80 persisted before crash").accepted, true);
    const journal = first.observationLogPath("bee-gap", 1);
    await waitForJournal(journal, (text) => text.includes('"turn_ended","messageId":55'));
    // Do not call observe(): this is the crash gap — the runner owns the
    // durable line but the old daemon never folds it.
    first.detachAll();

    second = makeDriver(dir);
    assert.equal(second.adopt("bee-gap", 1, proc.pid, proc.pidStartedAt, "running", checkpoint), true);
    assert.equal(second.isDegraded("bee-gap", 1), false);
    const recovered = await drainUntil(second, (events) => ofKind(events, "turn_ended").length > 0);
    assert.ok(ofKind(recovered, "turn_ended").some((event) => event.generation === 1));
    assert.ok(checkpointOf(second, "bee-gap") > checkpoint);

    second.stop("bee-gap", 1, "stopped_by_system");
    await drainUntil(second, (events) => ofKind(events, "exited").length > 0);
  } finally {
    second?.disposeAll();
    first.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery replay after the completion fold is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-runner-recovery-"));
  const first = makeDriver(dir);
  let second: HsrDriver | null = null;
  try {
    first.start("bee-dupe", 1);
    await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
    const checkpointBeforeTurn = checkpointOf(first, "bee-dupe");
    const proc = first.procOf("bee-dupe", 1)!;
    assert.equal(first.deliver("bee-dupe", 1, 56, "folded but not checkpointed").accepted, true);
    await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
    const checkpointAfterFold = checkpointOf(first, "bee-dupe");
    assert.ok(checkpointAfterFold > checkpointBeforeTurn);
    // The daemon commits phase/output/cursor as one observation fold. A crash
    // after that fold resumes beyond the completion and cannot account twice.
    first.detachAll();

    second = makeDriver(dir);
    assert.equal(
      second.adopt("bee-dupe", 1, proc.pid, proc.pidStartedAt, "idle", checkpointAfterFold),
      true,
    );
    const replayed = second.observe();
    await sleep(70);
    replayed.push(...second.observe());
    assert.equal(ofKind(replayed, "turn_ended").length, 0, "already-idle completion normalizes away");
    assert.equal(second.observeRecoveryCursors().length, 0, "no already-applied bytes are exposed again");

    second.stop("bee-dupe", 1, "stopped_by_system");
    await drainUntil(second, (events) => ofKind(events, "exited").length > 0);
  } finally {
    second?.disposeAll();
    first.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery preserves journal order when completion is followed by a newer turn start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-runner-recovery-"));
  const first = makeDriver(dir);
  let second: HsrDriver | null = null;
  try {
    first.start("bee-newer", 1);
    await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
    const checkpoint = checkpointOf(first, "bee-newer");
    const proc = first.procOf("bee-newer", 1)!;

    assert.equal(first.deliver("bee-newer", 1, 61, "first").accepted, true);
    await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
    // Deliberately leave the first turn's cursor uncommitted, then start a
    // newer long-running turn before the daemon dies.
    assert.equal(first.deliver("bee-newer", 1, 62, "@hang second").accepted, true);
    await waitForJournal(
      first.observationLogPath("bee-newer", 1),
      (text) => text.includes('"turn_started","messageId":62'),
    );
    first.detachAll();

    second = makeDriver(dir);
    assert.equal(second.adopt("bee-newer", 1, proc.pid, proc.pidStartedAt, "running", checkpoint), true);
    const recovered = await drainUntil(
      second,
      (events) => ofKind(events, "turn_ended").length > 0 && ofKind(events, "turn_started").length > 0,
    );
    const endIndex = recovered.findIndex((event) => event.kind === "turn_ended");
    const startIndex = recovered.findIndex((event) => event.kind === "turn_started");
    assert.ok(endIndex >= 0 && startIndex > endIndex, "newer start must win after the recovered completion");

    second.stop("bee-newer", 1, "stopped_by_system");
    await drainUntil(second, (events) => ofKind(events, "exited").length > 0);
  } finally {
    second?.disposeAll();
    first.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing or generation-corrupt recovery evidence fails closed without manufacturing idle", async () => {
  for (const corruption of ["missing-journal", "wrong-generation"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "hb-v2-runner-recovery-"));
    const first = makeDriver(dir);
    let second: HsrDriver | null = null;
    try {
      const beeId = `bee-${corruption}`;
      first.start(beeId, 1);
      await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
      const checkpoint = checkpointOf(first, beeId);
      const proc = first.procOf(beeId, 1)!;
      first.detachAll();

      if (corruption === "missing-journal") {
        unlinkSync(first.observationLogPath(beeId, 1));
      } else {
        const statusPath = join(dir, "runners", `${beeId}.1.status.json`);
        const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
        writeFileSync(statusPath, JSON.stringify({ ...status, generation: 999 }));
      }

      second = makeDriver(dir);
      assert.equal(second.adopt(beeId, 1, proc.pid, proc.pidStartedAt, "running", checkpoint), true);
      assert.equal(second.isDegraded(beeId, 1), true);
      await sleep(70);
      assert.equal(ofKind(second.observe(), "turn_ended").length, 0);
      assert.deepEqual(second.deliver(beeId, 1, 77, "must not slip through"), {
        accepted: false,
        reason: "not_ready",
      });

      second.stop(beeId, 1, "stopped_by_system");
      await drainUntil(second, (events) => ofKind(events, "exited").length > 0);
    } finally {
      second?.disposeAll();
      first.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a genuinely long-running silent turn stays running across adoption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-runner-recovery-"));
  const first = makeDriver(dir);
  let second: HsrDriver | null = null;
  try {
    first.start("bee-silent", 1);
    await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
    checkpointOf(first, "bee-silent");
    const proc = first.procOf("bee-silent", 1)!;
    assert.equal(first.deliver("bee-silent", 1, 81, "@hang").accepted, true);
    await drainUntil(first, (events) => ofKind(events, "turn_started").length > 0);
    await waitForJournal(
      first.observationLogPath("bee-silent", 1),
      (text) => text.includes('"turn_started","messageId":81'),
    );
    await sleep(70);
    first.observe();
    const runningCursor = checkpointOf(first, "bee-silent");
    first.detachAll();

    second = makeDriver(dir);
    assert.equal(second.adopt("bee-silent", 1, proc.pid, proc.pidStartedAt, "running", runningCursor), true);
    await sleep(180);
    assert.equal(ofKind(second.observe(), "turn_ended").length, 0, "silence is never completion evidence");
    assert.deepEqual(second.interrupt("bee-silent", 1), { interrupted: true });
    await drainUntil(second, (events) => ofKind(events, "turn_ended").length > 0);

    second.stop("bee-silent", 1, "stopped_by_system");
    await drainUntil(second, (events) => ofKind(events, "exited").length > 0);
  } finally {
    second?.disposeAll();
    first.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex thread/status idle plus turn/completed maps through adoption to one turn end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-codex-recovery-"));
  const first = makeCodexDriver(dir);
  let second: HsrDriver | null = null;
  try {
    first.start("bee-codex", 1);
    await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
    const checkpoint = checkpointOf(first, "bee-codex");
    const proc = first.procOf("bee-codex", 1)!;
    await deliverUntilAccepted(first, "bee-codex", 1, 91, "persist codex completion");
    const journal = await waitForJournal(
      first.observationLogPath("bee-codex", 1),
      (text) => text.includes('"method":"thread/status/changed"') && text.includes('"method":"turn/completed"'),
    );
    assert.match(journal, /"status":\{"type":"idle"\}/);
    first.detachAll();

    second = makeCodexDriver(dir);
    assert.equal(second.adopt("bee-codex", 1, proc.pid, proc.pidStartedAt, "running", checkpoint), true);
    const recovered = await drainUntil(second, (events) => ofKind(events, "turn_ended").length > 0);
    assert.equal(ofKind(recovered, "turn_ended").length, 1);

    second.stop("bee-codex", 1, "stopped_by_system");
    await drainUntil(second, (events) => ofKind(events, "exited").length > 0);
  } finally {
    second?.disposeAll();
    first.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex adoption restores the durable thread and active turn, then confirms steer and idle delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-codex-adopt-context-"));
  const first = makeCodexDriver(dir);
  let second: HsrDriver | null = null;
  let third: HsrDriver | null = null;
  try {
    first.start("bee-codex-adopt", 1);
    await drainUntil(first, (events) => ofKind(events, "turn_ended").length > 0);
    const sessionId = first.observeSessions().find((row) => row.beeId === "bee-codex-adopt")?.sessionId;
    assert.ok(sessionId, "the original daemon learns the Codex thread id");

    await deliverUntilAccepted(first, "bee-codex-adopt", 1, 92, "@slow:10000 original turn");
    await waitForJournal(
      first.observationLogPath("bee-codex-adopt", 1),
      (text) => text.includes('"method":"turn/started"'),
    );
    await sleep(70);
    first.observe();
    const runningCursor = checkpointOf(first, "bee-codex-adopt");
    const proc = first.procOf("bee-codex-adopt", 1)!;
    first.detachAll();

    second = makeCodexDriver(dir);
    assert.equal(
      second.adopt("bee-codex-adopt", 1, proc.pid, proc.pidStartedAt, "running", runningCursor, sessionId),
      true,
    );
    await deliverUntilAccepted(second, "bee-codex-adopt", 1, 93, "steered after daemon restart");
    const logPath = join(dir, "logs", "bee-codex-adopt.jsonl");
    await waitForJournal(
      logPath,
      (text) => text.includes('"method":"turn/steer"') && text.includes("steered after daemon restart"),
    );
    assert.deepEqual(second.interrupt("bee-codex-adopt", 1), { interrupted: true });
    await drainUntil(second, (events) => ofKind(events, "turn_ended").length > 0);

    const idleCursor = checkpointOf(second, "bee-codex-adopt");
    const sameProc = second.procOf("bee-codex-adopt", 1)!;
    second.detachAll();
    third = makeCodexDriver(dir);
    assert.equal(
      third.adopt("bee-codex-adopt", 1, sameProc.pid, sameProc.pidStartedAt, "idle", idleCursor, sessionId),
      true,
    );
    await deliverUntilAccepted(third, "bee-codex-adopt", 1, 94, "@slow:200 fresh turn after idle adoption");
    await drainUntil(third, (events) => ofKind(events, "turn_ended").length > 0);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /"method":"turn\/steer"/);
    assert.match(log, /"method":"turn\/start"/);

    third.stop("bee-codex-adopt", 1, "stopped_by_system");
    await drainUntil(third, (events) => ofKind(events, "exited").length > 0);
  } finally {
    third?.disposeAll();
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
