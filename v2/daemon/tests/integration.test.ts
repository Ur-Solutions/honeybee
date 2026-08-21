/**
 * WP4 integration tier (spec 04 test plan): a REAL daemon process + real
 * HsrDriver + stub agent over a temp store/socket. Covers:
 *  - full verb round-trips (spawn → turn → send/--wait semantics → stop →
 *    revive → archive/unarchive → delete) + reads + typed errors + hello
 *  - watch stream: versioned snapshot, contiguous seq deltas, induced gap →
 *    snapshot refetch
 *  - daemon SIGKILL mid-turn → restart → B7 zero failed states + surviving
 *    runtime re-adopted (pid + start-time) → next message rotates cleanly
 *  - scale-to-zero with a tiny window → revive-on-message
 *  - induced I1 breach → i1_violations row surfaces in health()
 *
 * SAFETY: temp dirs only; the daemon under test binds a socket inside its own
 * mkdtemp dir; no services are installed; the only agent is the stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { pidAlive } from "../../driver-hsr/src/psutil.ts";
import type {
  CommandsResult,
  HealthResult,
  ListResult,
  MailboxResult,
  SendRpcResult,
  SnapshotResult,
  SpawnResult,
  ViewResult,
  WatchFrame,
} from "../src/protocol.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, sleep, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

async function spawnAndSettle(client: RpcClient, name: string): Promise<string> {
  const spawned = await client.request<SpawnResult>("spawn", { name, agent: "stub", cwd: "/tmp" });
  await waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    return v.view.runtimeState === "idle";
  }, `${name} idle`);
  return spawned.beeId;
}

async function waitDelivered(client: RpcClient, beeId: string, messageId: number, what: string): Promise<number> {
  const gen = await waitFor(async () => {
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    const m = messages.find((x) => x.id === messageId);
    return m?.deliveredAt != null ? m.deliveredGeneration : null;
  }, what, 12_000);
  return gen as number;
}

test("int.1: verb round-trips over the real socket — the full bee lifecycle", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();

    // spawn → boots to idle (stub: ready → booted + turn_ended)
    const beeId = await spawnAndSettle(client, "worker");
    const view1 = await client.request<ViewResult>("view", { beeId });
    assert.equal(view1.view.generation, 1);
    assert.equal(view1.view.lifecycle, "active");
    assert.ok(view1.runtime?.pid != null && view1.runtime.pid > 0, "pid recorded");

    // send (Q3: returns ids immediately); then block on the delivery mark
    const sent = await client.request<SendRpcResult>("send", { beeId, body: "hello bee" });
    assert.ok(sent.messageId > 0);
    const gen = await waitDelivered(client, beeId, sent.messageId, "message delivered");
    assert.equal(gen, 1);

    // the turn produced output → waiting_for_you once idle again
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "idle" && v.view.waitingForYou;
    }, "turn ended with output");

    // stop → stopped(stopped_by_user); bee remains reachable
    await client.request("stop", { beeId });
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "stopped";
    }, "stopped");
    const stopped = await client.request<ViewResult>("view", { beeId });
    assert.equal(stopped.view.exitCause, "stopped_by_user");
    assert.equal(stopped.view.reachable, true);

    // revive → generation 2
    await client.request("revive", { beeId });
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.generation === 2 && v.view.runtimeState === "idle";
    }, "revived to gen 2");

    // archive (idle runtime gets no implicit stop — archived is a lifecycle, not a runtime, fact)
    await client.request("archive", { beeId });
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.lifecycle === "archived";
    }, "archived");

    // send to archived → auto-unarchive (Q3 spec01) and delivery
    const sent2 = await client.request<SendRpcResult>("send", { beeId, body: "wake from archive" });
    assert.equal(sent2.unarchived, true);
    await waitDelivered(client, beeId, sent2.messageId, "archived bee revived by message");
    const afterUnarchive = await client.request<ViewResult>("view", { beeId });
    assert.equal(afterUnarchive.view.lifecycle, "active");

    // reads
    const list = await client.request<ListResult>("list");
    assert.equal(list.views.length, 1);
    const cmds = await client.request<CommandsResult>("commands", { beeId });
    assert.ok(cmds.commands.every((c) => c.status !== "failed"), "no failed commands in a clean run");
    const health = await client.request<HealthResult>("health");
    assert.equal(health.i1Violations, 0);
    assert.equal(health.bees.total, 1);
    const info = await client.request<{ protocol: string }>("deployInfo");
    assert.equal(info.protocol, "v2/1");

    // delete → everything gone; view reports unreachable non-existence
    await client.request("delete", { beeId });
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.exists === false;
    }, "deleted");
    const gone = await client.request<ViewResult>("view", { beeId });
    assert.equal(gone.view.reachable, false);

    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("int.2: typed errors — closed list only (bee_not_found, invalid_request, protocol_mismatch)", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();

    await assert.rejects(
      () => client.request("send", { beeId: "nope", body: "x" }),
      (err: Error & { code?: string }) => err.code === "bee_not_found",
    );
    await assert.rejects(
      () => client.request("mailbox", { beeId: "nope" }),
      (err: Error & { code?: string }) => err.code === "bee_not_found",
    );
    await assert.rejects(
      () => client.request("spawn", { name: "x", agent: "no-such-agent", cwd: "/tmp" }),
      (err: Error & { code?: string }) => err.code === "invalid_request",
    );
    await assert.rejects(
      () => client.request("spawn", { name: "", agent: "stub", cwd: "/tmp" }),
      (err: Error & { code?: string }) => err.code === "invalid_request",
    );
    client.close();

    // A raw connection offering the wrong protocol is refused and closed.
    const raw = createConnection(daemon.socketPath);
    const frames: string[] = [];
    raw.setEncoding("utf8");
    raw.on("data", (c: string) => frames.push(...c.split("\n").filter((l) => l.trim().length > 0)));
    await waitFor(() => frames.length >= 1, "server hello");
    raw.write(`${JSON.stringify({ protocol: "v1/999" })}\n`);
    await waitFor(() => frames.length >= 2, "mismatch reply");
    const reply = JSON.parse(frames[1] as string) as { ok: boolean; error: { code: string } };
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, "protocol_mismatch");
    await waitFor(() => raw.destroyed || raw.readableEnded, "server closed the connection");
    raw.destroy();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("int.3: watch — snapshot + contiguous seq deltas; induced gap forces a snapshot refetch", async () => {
  // watchMaxBatch 5 with a burst of writes inside one tick = a guaranteed gap.
  const { dir, cleanup } = makeDaemonDir({ watchMaxBatch: 5, tickMs: 120 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const worker = await daemon.client();
    const beeId = await spawnAndSettle(worker, "watched");

    const watcher = await daemon.client();
    const deltas: Array<{ baseSeq: number; seq: number; count: number }> = [];
    let gaps = 0;
    let cursor = -1;
    let chainBroken = false;
    let refetchedSeq: number | null = null;
    watcher.onEvent = (frame: WatchFrame) => {
      if (frame.type === "gap") {
        gaps += 1;
        // Fail-closed cursor: refetch the snapshot on any gap.
        void watcher.request<SnapshotResult>("snapshot").then((snap) => {
          refetchedSeq = snap.seq;
          cursor = snap.seq;
        });
        return;
      }
      if (frame.baseSeq !== cursor) chainBroken = true; // the client-side gap detector
      cursor = frame.seq;
      deltas.push({ baseSeq: frame.baseSeq, seq: frame.seq, count: frame.events.length });
    };
    const snap = await watcher.request<SnapshotResult>("watch");
    assert.ok(snap.seq > 0, "versioned snapshot");
    assert.equal(snap.views.length, 1);
    cursor = snap.seq;

    // Gentle traffic: contiguous deltas.
    const m1 = await worker.request<SendRpcResult>("send", { beeId, body: "one" });
    await waitDelivered(worker, beeId, m1.messageId, "one delivered");
    await waitFor(() => deltas.length >= 1, "deltas flowing");
    assert.equal(chainBroken, false, "delta chain must be contiguous before the burst");

    // Burst: > watchMaxBatch audit rows within one tick → server sends a gap.
    for (let i = 0; i < 10; i++) {
      await worker.request<SendRpcResult>("send", { beeId, body: `burst ${i}` });
    }
    await waitFor(() => gaps >= 1, "induced gap", 10_000);
    await waitFor(() => refetchedSeq != null, "snapshot refetched after gap");

    // After the refetch the stream must be consistent again.
    chainBroken = false;
    const m2 = await worker.request<SendRpcResult>("send", { beeId, body: "after gap" });
    await waitDelivered(worker, beeId, m2.messageId, "post-gap delivery");
    await waitFor(() => cursor >= 0 && deltas.some((d) => d.seq >= (refetchedSeq ?? Infinity)), "post-gap deltas", 10_000);
    assert.equal(chainBroken, false, "stream contiguous again after refetch");

    watcher.close();
    worker.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("int.4: daemon SIGKILL mid-turn → restart → zero failed states (B7) + runtime re-adopted", async () => {
  const { dir, cleanup } = makeDaemonDir({
    // The agent outlives the daemon (detached + survive-stdin-close) and works
    // a long turn so the kill happens mid-turn.
    stubEnv: { STUB_SURVIVE_STDIN_CLOSE: "1", STUB_TURN_MS: "60000" },
    turnHangTimeoutMs: 120_000, // hang policy must not race the assertions
    bootHangTimeoutMs: 8000,
  });
  let daemon: DaemonHandle | null = null;
  // Survive-stdin-close stubs outlive the daemon BY DESIGN (shutdown detaches,
  // never kills) — so this test must kill every agent pid it minted itself, or
  // the gen-2 survivor (60s turns + a keep-alive interval, deaf to stdin close)
  // leaks past the test run.
  const agentPids: number[] = [];
  try {
    daemon = await startDaemon(dir);
    let client = await daemon.client();
    const beeId = await spawnAndSettle(client, "survivor");
    const sent = await client.request<SendRpcResult>("send", { beeId, body: "long task" });
    await waitDelivered(client, beeId, sent.messageId, "first message delivered to gen 1");
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "running";
    }, "mid-turn");
    const before = await client.request<ViewResult>("view", { beeId });
    const agentPid = before.runtime?.pid as number;
    agentPids.push(agentPid);
    assert.ok(agentPid > 0);

    // SIGKILL the daemon mid-turn; the detached agent must survive.
    client.close();
    await daemon.kill();
    assert.ok(pidAlive(agentPid), "agent survived the daemon SIGKILL");

    // Restart: boot must re-adopt the survivor by pid + start-time.
    daemon = await startDaemon(dir);
    client = await daemon.client();
    const health = await client.request<HealthResult>("health");
    assert.equal(health.lastBoot?.adopted, 1, "surviving runtime re-adopted at boot");
    assert.equal(health.lastBoot?.stoppedByReconcile, 0, "no runtime falsely reconciled away");

    const after = await client.request<ViewResult>("view", { beeId });
    assert.equal(after.view.generation, 1, "same generation — adopted, not restarted");
    assert.notEqual(after.view.runtimeState, "stopped");
    // B7: a daemon restart mints ZERO failed states.
    const cmds = await client.request<CommandsResult>("commands", { beeId });
    assert.ok(cmds.commands.every((c) => c.status !== "failed"), "zero failed commands after restart");
    assert.deepEqual(after.view.flags, [], "zero flags after restart");

    // WP5 runner host: the adopted runtime is FULLY capable — mail delivers
    // to the SAME generation over the reconnected host socket, and the
    // surviving process keeps working. (Pre-host, this rotated to gen 2 via
    // the degraded stop-on-mail policy; that policy now applies only to
    // legacy host-less adoptions.)
    const sent2 = await client.request<SendRpcResult>("send", { beeId, body: "post-restart task" });
    const gen2 = await waitDelivered(client, beeId, sent2.messageId, "post-restart delivery", );
    assert.equal(gen2, 1, "delivered to the ADOPTED generation — no rotation");
    assert.equal(pidAlive(agentPid), true, "the survivor keeps running across the restart");
    const finalCmds = await client.request<CommandsResult>("commands", { beeId });
    assert.ok(finalCmds.commands.every((c) => c.status !== "failed"));
    const rt1 = (await client.request<ViewResult>("view", { beeId })).runtime;
    assert.equal(rt1?.generation, 1);
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    // The after-hook the survive-stub demands: reap every agent this test
    // spawned — pids were captured moments ago, and each stub leads its own
    // process group, so kill the group first, the pid as fallback.
    for (const pid of agentPids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* no group — fall through */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    cleanup();
  }
});

test("int.5: scale-to-zero with a tiny window → stopped_by_system → revive-on-message", async () => {
  const { dir, cleanup } = makeDaemonDir({ idleWindowMs: 250, tickMs: 40 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const beeId = await spawnAndSettle(client, "sleepy");
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "stopped";
    }, "scale-to-zero stop", 10_000);
    const stopped = await client.request<ViewResult>("view", { beeId });
    assert.equal(stopped.view.exitCause, "stopped_by_system");
    assert.equal(stopped.view.reachable, true, "a scaled-to-zero bee is still reachable");

    const sent = await client.request<SendRpcResult>("send", { beeId, body: "revive me" });
    assert.ok(sent.commandId != null, "send to a stopped bee enqueues the wake in the same transaction");
    const gen = await waitDelivered(client, beeId, sent.messageId, "revive-on-message delivery");
    assert.equal(gen, 2);
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("int.6: induced I1 breach — a boot-hanging agent leaves mail undelivered past the deadline → violation row", async () => {
  const { dir, cleanup } = makeDaemonDir({
    stubEnv: { STUB_HANG_ON_BOOT: "1" },
    bootHangTimeoutMs: 250,
    turnHangTimeoutMs: 250,
    bootAllowanceMs: 100,
    turnAllowanceMs: 100,
    tickMs: 40,
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "hanger", agent: "stub", cwd: "/tmp" });
    const sent = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "never arrives" });
    assert.ok(sent.messageId > 0);
    // Floor = max(250,250)+100+100 = 450ms; the runtime hangs on every boot,
    // so the message must breach and land in i1_violations.
    const health = await waitFor(async () => {
      const h = await client.request<HealthResult>("health");
      return h.i1Violations >= 1 ? h : null;
    }, "i1 violation recorded", 12_000);
    assert.equal(health.i1Violations, 1, "one message, one violation row (deduped)");
    await sleep(80);
    const still = await client.request<HealthResult>("health");
    assert.equal(still.i1Violations, 1, "re-detection never double-counts");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("int.7: immediate-exit agent → bounded revives on backoff, spawn_failed at the budget; the counter survives a daemon SIGKILL; operator revive recovers once the agent is fixed", async () => {
  // The WP7 importer hazard, end to end over the real daemon: an agent that
  // exits before it ever boots (missing cwd/binary shape) used to revive at
  // tick speed forever because every send_wake was a fresh B5 command.
  const { dir, cleanup } = makeDaemonDir({
    stubEnv: { STUB_EXIT_BEFORE_READY: "1" },
    retry: { maxAttempts: 4, backoffBaseMs: 60 },
    tickMs: 20,
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    let client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "doomed", agent: "stub", cwd: "/tmp" });
    const beeId = spawned.beeId;
    const sent = await client.request<SendRpcResult>("send", { beeId, body: "hello?" });

    // Two boot failures in, SIGKILL the daemon mid-budget.
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return (v.bee?.spawnFailures ?? 0) >= 2 && v.view.runtimeState === "stopped" ? v : null;
    }, "two boot failures counted", 12_000);
    client.close();
    await daemon.kill();

    daemon = await startDaemon(dir);
    client = await daemon.client();
    const afterRestart = await client.request<ViewResult>("view", { beeId });
    assert.ok((afterRestart.bee?.spawnFailures ?? 0) >= 2, "spawn-failure counter survived the SIGKILL restart");
    // The restart itself never mints a failed state or a flag (B7).
    assert.deepEqual(afterRestart.view.flags, [], `restart raised a flag: ${JSON.stringify(afterRestart.view.flags)}`);

    // The budget (4) is reached across the restart — flag set, revives stop.
    const flagged = await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.flags.includes("spawn_failed") ? v : null;
    }, "spawn_failed at the budget", 12_000);
    assert.equal(flagged.bee?.spawnFailures, 4);
    assert.equal(flagged.view.blocked, true);
    assert.equal(flagged.view.reachable, true);
    const genAtFlag = flagged.view.generation as number;
    // Bounded: 4 boot failures = at most 4 generations plus one machine_restart
    // row if the kill landed mid-boot — nowhere near "hundreds per second".
    assert.ok(genAtFlag <= 5, `generations at the flag: ${genAtFlag}`);
    await sleep(400); // ≫ every backoff step (60,120,240ms): a loop would show
    const later = await client.request<ViewResult>("view", { beeId });
    assert.equal(later.view.generation, genAtFlag, "no revive while spawn_failed is set");
    const cmds = await client.request<CommandsResult>("commands", { beeId });
    assert.equal(cmds.commands.filter((c) => c.status === "queued" || c.status === "running").length, 0, "no wake pending");
    // More mail: durable, no wake.
    const sent2 = await client.request<SendRpcResult>("send", { beeId, body: "still there?" });
    assert.equal(sent2.commandId, null, "send enqueues no wake while spawn_failed is set");
    const mail = await client.request<MailboxResult>("mailbox", { beeId });
    assert.equal(mail.messages.filter((m) => m.deliveredAt == null).length, 2, "mail stays durable");
    client.close();

    // Fix the agent (config change → daemon restart), then an operator revive
    // retries regardless of the flag; booted clears it and the mail lands.
    await daemon.stop();
    const configPath = `${dir}/config.json`;
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { agents: { stub: { env: Record<string, string> } } };
    delete config.agents.stub.env.STUB_EXIT_BEFORE_READY;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    daemon = await startDaemon(dir);
    client = await daemon.client();
    const stillFlagged = await client.request<ViewResult>("view", { beeId });
    assert.deepEqual(stillFlagged.view.flags, ["spawn_failed"], "a restart is not contrary evidence");
    await client.request("revive", { beeId });
    await waitDelivered(client, beeId, sent.messageId, "first message delivered after the operator revive");
    await waitDelivered(client, beeId, sent2.messageId, "second message delivered too");
    const recovered = await client.request<ViewResult>("view", { beeId });
    assert.deepEqual(recovered.view.flags, [], "booted cleared spawn_failed");
    assert.equal(recovered.bee?.spawnFailures, 0, "counter reset");
    assert.equal(recovered.view.generation, genAtFlag + 1, "exactly one revive");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Delivery urgency (schema v8 — spec 01 Q2 amendment) against the REAL stack:
// daemon process + HsrDriver + stub agent.
// ---------------------------------------------------------------------------

test("int.urgency.1: mid-turn `now` — the turn is interrupted, the message delivers immediately, and the bee keeps working", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const beeId = await spawnAndSettle(client, "urgent-now");

    // Open a long turn (the stub works it for 4s), wait until it is running.
    const slow = await client.request<SendRpcResult>("send", { beeId, body: "@slow:800" });
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "running";
    }, "slow turn running");

    const before = Date.now();
    const urgent = await client.request<SendRpcResult>("send", { beeId, body: "drop everything", urgency: "now" });
    await waitDelivered(client, beeId, urgent.messageId, "now-message delivered mid-turn");
    assert.ok(Date.now() - before < 600, "delivered well before the 800ms turn would have ended");
    // Loop ops land in the op log file (hived.log), not stdout.
    await waitFor(() => readFileSync(`${dir}/hived.log`, "utf8").includes("deliver.interrupt"), "the delivery loop interrupted the turn");

    // The turn continues: the interrupted stub works the delivered message as
    // its own turn and the bee settles idle with nothing pending.
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "idle";
    }, "bee idle after the urgent turn");
    const mail = await client.request<MailboxResult>("mailbox", { beeId });
    assert.equal(mail.messages.filter((m) => m.deliveredAt == null).length, 0, "nothing left pending");
    assert.equal(mail.messages.find((m) => m.id === urgent.messageId)?.urgency, "now", "urgency surfaces on the mailbox read");
    assert.equal(mail.messages.find((m) => m.id === slow.messageId)?.urgency, "next", "default urgency is next");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("int.urgency.2: mid-turn `idle` — held while the turn runs, delivered only after it ends", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const beeId = await spawnAndSettle(client, "urgent-idle");

    await client.request<SendRpcResult>("send", { beeId, body: "@slow:400" });
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "running";
    }, "slow turn running");

    const later = await client.request<SendRpcResult>("send", { beeId, body: "when you are done", urgency: "idle" });
    // While the turn runs, the message must stay undelivered (poll a few ticks).
    for (let i = 0; i < 6; i++) {
      const v = await client.request<ViewResult>("view", { beeId });
      if (v.view.runtimeState !== "running") break;
      const mail = await client.request<MailboxResult>("mailbox", { beeId });
      assert.equal(mail.messages.find((m) => m.id === later.messageId)?.deliveredAt, null, "idle message held mid-turn");
      await sleep(40);
    }
    await waitDelivered(client, beeId, later.messageId, "idle message delivered after the turn ended");
    assert.ok(!readFileSync(`${dir}/hived.log`, "utf8").includes("deliver.interrupt"), "idle never interrupts");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("int.urgency.3: an unknown urgency is a typed invalid_request, and nothing is enqueued", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const beeId = await spawnAndSettle(client, "urgent-bad");
    await assert.rejects(
      client.request("send", { beeId, body: "x", urgency: "soon" }),
      (err: Error & { code?: string }) => err.code === "invalid_request",
    );
    const mail = await client.request<MailboxResult>("mailbox", { beeId });
    assert.equal(mail.messages.length, 0, "the refused send inserted nothing");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
