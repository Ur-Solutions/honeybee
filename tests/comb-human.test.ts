import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachBeeToRun } from "../src/comb/attachment.js";
import {
  sweepCombs,
  type AgentAdoptRequest,
  type CombSweepDeps,
} from "../src/comb/controller.js";
import type { ForumPacketEffectRequest } from "../src/comb/forum.js";
import {
  createRun,
  listSweepableRuns,
  loadRun,
  mutateRun,
  readRunEvents,
} from "../src/comb/store.js";
import type {
  ActivationRecord,
  CombSpec,
  ForumPacket,
  JsonValue,
  RunRecord,
} from "../src/comb/types.js";
import type { SealRecord } from "../src/seal.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-comb-human-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function agentNode(id: string, brief = `Work as ${id}`) {
  return {
    id,
    executor: "agent" as const,
    binding: "strict" as const,
    agent: {
      capacity: { kind: "spawn" as const, bee: "codex" },
      brief,
    },
  };
}

function humanNode(id: string, destination: "bee" | "new-agent" = "new-agent") {
  return {
    id,
    executor: "human" as const,
    binding: "strict" as const,
    human: {
      title: `Verify ${id}`,
      packetKind: "code" as const,
      summary: "Check the work",
      checklist: [{ text: "Work is correct", done: false }],
      feedbackDestination: destination === "bee"
        ? { type: "bee" as const, fromNodeId: "work" }
        : { type: "new-agent" as const },
    },
  };
}

function humanLastDefinition(): CombSpec {
  return {
    formatVersion: 2,
    name: "human-last",
    input: { kind: "informal", description: "none" },
    nodes: [agentNode("work"), humanNode("verify", "bee")],
    edges: [
      { id: "work-verify", from: "work", to: "verify", kind: "forward", on: "done" },
      { id: "verify-work", from: "verify", to: "work", kind: "retry", on: "failed" },
    ],
  };
}

function session(dir: string): SessionRecord {
  return {
    name: "attached-bee",
    id: "bee-id",
    agent: "codex",
    cwd: dir,
    command: "codex",
    tmuxTarget: "attached-bee",
    substrate: "hsr",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    status: "running",
  };
}

function seal(
  activation: ActivationRecord,
  beeName: string,
  sealedAt: string,
  output?: JsonValue,
): SealRecord {
  return {
    beeName,
    sealedAt,
    status: "done",
    summary: "done",
    taskId: activation.taskId,
    attempt: activation.address.attempt,
    ...(output !== undefined ? { output } : {}),
  };
}

function packetFor(
  request: ForumPacketEffectRequest,
  id: string,
  blockingSince: string,
): ForumPacket {
  return {
    id,
    title: request.human.title,
    status: "needs_review",
    kind: request.human.packetKind,
    origin: "comb",
    cwd: request.cwd,
    summary: request.human.summary ?? null,
    checklist: request.human.checklist ?? [],
    native_session_id:
      request.destination.type === "bee" ? request.destination.sessionId : null,
    blocking_since: blockingSince,
    run_id: request.runId,
    comb_name: request.combName,
    base_rev: null,
    proposed_rev: null,
    graph_base: null,
    graph_proposed: null,
    definition_digest: null,
    action_binding_digest: null,
    subject_revision: null,
    verdict: null,
  };
}

function verdict(
  packet: ForumPacket,
  choice: "approve" | "request_changes",
  comment: string,
  recordedAt: string,
): NonNullable<ForumPacket["verdict"]> {
  return {
    packet_id: packet.id,
    verdict: choice,
    comment,
    destination: packet.native_session_id
      ? { type: "bee", sessionId: packet.native_session_id }
      : { type: "new-agent" },
    actor: "human-reviewer",
    definition_digest: packet.definition_digest,
    action_binding_digest: packet.action_binding_digest,
    subject_revision: packet.subject_revision,
    recorded_at: recordedAt,
  };
}

function current(run: RunRecord, nodeId: string): ActivationRecord {
  const activation = Object.values(run.activations)
    .filter((candidate) => candidate.address.nodeId === nodeId && !candidate.invalidatedAt)
    .sort((left, right) => right.address.attempt - left.address.attempt)[0];
  assert.ok(activation, `expected current activation for ${nodeId}`);
  return activation;
}

test("human verification keeps one thread, rerequests after comment-driven retry, ignores stale pins, and approves", async () => {
  await withTempStore(async (dir) => {
    const bee = session(dir);
    const created = await createRun({
      definition: humanLastDefinition(),
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "attached", beeName: bee.name, entryNodeId: "work" },
      now: "2026-07-28T12:00:00.000Z",
      policies: {
        retryBackoffMs: 0,
        retireAgentsOnTerminal: false,
      },
    });
    let now = Date.parse("2026-07-28T12:00:01.000Z");
    const packets = new Map<string, ForumPacket>();
    const packetOperations: ForumPacketEffectRequest["operation"][] = [];
    const adoptions: AgentAdoptRequest[] = [];
    const latestSeals = new Map<string, SealRecord>();
    const deps: CombSweepDeps = {
      listRuns: listSweepableRuns,
      latestSeal: async (name) => {
        const found = latestSeals.get(name);
        return found ? { filename: `${name}-${found.attempt}.json`, seal: found } : null;
      },
      spawnAgent: async (request) => ({ name: request.name }),
      adoptAgent: async (request) => {
        adoptions.push(request);
        return { name: bee.name, id: bee.id };
      },
      lookupAgent: async () => bee,
      retireAgent: async () => undefined,
      listHumanPackets: async () => [...packets.values()],
      executeHumanEffect: async (request) => {
        packetOperations.push(request.operation);
        if (request.operation === "create") {
          const createdPacket = packetFor(request, "PKT.thread", new Date(now).toISOString());
          packets.set(createdPacket.id, createdPacket);
          return createdPacket;
        }
        const predecessor = packets.get(request.predecessorPacketId!);
        assert.ok(predecessor);
        if (request.operation === "rerequest") {
          predecessor.status = "needs_review";
          predecessor.verdict = null;
          predecessor.blocking_since = new Date(now).toISOString();
          return predecessor;
        }
        throw new Error(`unexpected operation ${request.operation}`);
      },
      now: () => now,
    };
    const records = [bee];

    await sweepCombs(deps, records, new Map());
    assert.equal(adoptions.length, 1);
    assert.equal(adoptions[0]?.attempt, 1);
    let run = (await loadRun(created.id))!;
    assert.equal(current(run, "work").beeHandles[0]?.source, "adopted");

    const work1 = current(run, "work");
    latestSeals.set(bee.name, seal(work1, bee.name, "2026-07-28T12:00:02.000Z"));
    now = Date.parse("2026-07-28T12:00:03.000Z");
    await sweepCombs(deps, records, new Map());
    run = (await loadRun(created.id))!;
    const verify1 = current(run, "verify");
    assert.equal(verify1.status, "waiting-human");
    assert.equal(verify1.packetId, "PKT.thread");
    assert.equal(run.packetThreads.length, 1);

    const reviewPacket = packets.get("PKT.thread")!;
    reviewPacket.status = "changes_requested";
    reviewPacket.verdict = verdict(
      reviewPacket,
      "request_changes",
      "Add the missing second line.",
      "2026-07-28T12:00:04.000Z",
    );
    now = Date.parse("2026-07-28T12:00:05.000Z");
    await sweepCombs(deps, records, new Map());
    run = (await loadRun(created.id))!;
    const work2 = current(run, "work");
    assert.equal(work2.address.attempt, 2);
    assert.equal(adoptions.length, 2);
    assert.match(adoptions[1]!.brief, /Add the missing second line/);
    assert.equal(adoptions[1]!.name, bee.name);

    latestSeals.set(bee.name, seal(work2, bee.name, "2026-07-28T12:00:06.000Z"));
    now = Date.parse("2026-07-28T12:00:07.000Z");
    await sweepCombs(deps, records, new Map());
    run = (await loadRun(created.id))!;
    const verify2 = current(run, "verify");
    assert.equal(verify2.address.attempt, 2);
    assert.equal(verify2.status, "waiting-human");
    assert.equal(verify2.packetId, "PKT.thread");
    assert.deepEqual(packetOperations, ["create", "rerequest"]);
    assert.equal(run.packetThreads.length, 1);
    assert.equal(run.packetThreads[0]?.packetCount, 1);

    reviewPacket.status = "approved";
    reviewPacket.verdict = verdict(
      reviewPacket,
      "approve",
      "stale approval",
      "2026-07-28T12:00:08.000Z",
    );
    reviewPacket.verdict.definition_digest = "sha256:stale-definition";
    now = Date.parse("2026-07-28T12:00:09.000Z");
    await sweepCombs(deps, records, new Map());
    run = (await loadRun(created.id))!;
    assert.equal(current(run, "verify").status, "waiting-human");
    assert.equal(run.status, "active");
    assert.ok(
      (await readRunEvents(run.id, { after: 0, limit: 1_000 })).events
        .some((event) => event.type === "comb.evidence.stale_verdict"),
    );

    reviewPacket.verdict = verdict(
      reviewPacket,
      "approve",
      "Looks good now.",
      "2026-07-28T12:00:10.000Z",
    );
    now = Date.parse("2026-07-28T12:00:11.000Z");
    await sweepCombs(deps, records, new Map());
    run = (await loadRun(created.id))!;
    assert.equal(run.status, "done");
    assert.deepEqual(current(run, "verify").output, {
      verdict: "approve",
      comment: "Looks good now.",
      destination: { type: "bee", sessionId: "bee-id" },
    });
    assert.equal(run.packetThreads[0]?.currentPacketId, "PKT.thread");
    assert.equal(run.packetThreads[0]?.packetTail.length, 1);
  });
});

test("Forum create can crash after the external write and confirm idempotently on the next sweep", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "packet-crash",
      input: { kind: "informal", description: "none" },
      nodes: [humanNode("verify")],
      edges: [],
    };
    const created = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { retireAgentsOnTerminal: false },
    });
    const packets = new Map<string, ForumPacket>();
    let calls = 0;
    const deps: CombSweepDeps = {
      listRuns: listSweepableRuns,
      latestSeal: async () => null,
      spawnAgent: async (request) => ({ name: request.name }),
      lookupAgent: async () => null,
      retireAgent: async () => undefined,
      listHumanPackets: async () => [...packets.values()],
      executeHumanEffect: async (request) => {
        calls += 1;
        let packet = packets.get("PKT.crash");
        if (!packet) {
          packet = packetFor(request, "PKT.crash", "2026-07-28T12:00:00.000Z");
          packets.set(packet.id, packet);
        }
        if (calls === 1) throw new Error("simulated process loss after Forum create");
        return packet;
      },
      now: () => Date.parse("2026-07-28T12:00:01.000Z"),
    };

    await sweepCombs(deps, [], new Map());
    let run = (await loadRun(created.id))!;
    assert.equal(current(run, "verify").status, "active");
    assert.equal(Object.values(run.effects)[0]?.status, "executing");
    assert.equal(packets.size, 1);

    await sweepCombs(deps, [], new Map());
    run = (await loadRun(created.id))!;
    assert.equal(current(run, "verify").status, "waiting-human");
    assert.equal(current(run, "verify").packetId, "PKT.crash");
    assert.equal(Object.values(run.effects)[0]?.status, "confirmed");
    assert.equal(packets.size, 1);
    assert.equal(calls, 2);
  });
});

test("subject revision movement creates a successor in the same human packet thread", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "packet-successor",
      input: { kind: "informal", description: "none" },
      nodes: [humanNode("verify")],
      edges: [],
    };
    const created = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { retireAgentsOnTerminal: false },
    });
    const packets = new Map<string, ForumPacket>();
    const operations: string[] = [];
    const deps: CombSweepDeps = {
      listRuns: listSweepableRuns,
      latestSeal: async () => null,
      spawnAgent: async (request) => ({ name: request.name }),
      lookupAgent: async () => null,
      retireAgent: async () => undefined,
      listHumanPackets: async () => [...packets.values()],
      executeHumanEffect: async (request) => {
        operations.push(request.operation);
        if (request.operation === "create") {
          const packet = packetFor(request, "PKT.one", "2026-07-28T12:00:00.000Z");
          packets.set(packet.id, packet);
          return packet;
        }
        assert.equal(request.operation, "successor");
        const predecessor = packets.get(request.predecessorPacketId!);
        assert.ok(predecessor);
        predecessor.status = "superseded";
        const successor = packetFor(request, "PKT.two", "2026-07-28T12:00:10.000Z");
        packets.set(successor.id, successor);
        return successor;
      },
      now: () => Date.parse("2026-07-28T12:00:10.000Z"),
    };

    await sweepCombs(deps, [], new Map());
    await mutateRun(created.id, (run) => {
      run.snapshotRevision = 1;
      run.currentSnapshot.revision = 1;
      run.currentSnapshot.definitionDigest = "sha256:revision-two";
      const activation = current(run, "verify");
      activation.nodeSnapshotRevision = 1;
      activation.subject = { ...activation.subject, revision: "revision-two" };
      activation.status = "pending";
      delete activation.startedAt;
      delete activation.endedAt;
    });
    await sweepCombs(deps, [], new Map());
    const run = (await loadRun(created.id))!;
    assert.deepEqual(operations, ["create", "successor"]);
    assert.equal(run.packetThreads.length, 1);
    assert.equal(run.packetThreads[0]?.packetCount, 2);
    assert.equal(run.packetThreads[0]?.currentPacketId, "PKT.two");
    assert.equal(run.packetThreads[0]?.packetTail[0]?.status, "superseded");
    assert.equal(run.packetThreads[0]?.packetTail[0]?.successorPacketId, "PKT.two");
    assert.equal(current(run, "verify").packetId, "PKT.two");
  });
});

test("blocking_since produces clock evidence, fires the timeout edge, and notifies once", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "human-stall",
      input: { kind: "informal", description: "none" },
      nodes: [humanNode("verify"), agentNode("timeout")],
      edges: [{
        id: "verify-timeout",
        from: "verify",
        to: "timeout",
        kind: "waiting",
        on: "waiting",
        when: { kind: "clock", afterMs: 1_000, from: "blocking-since" },
      }],
    };
    const created = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { retireAgentsOnTerminal: false },
    });
    const packets = new Map<string, ForumPacket>();
    const notices: string[] = [];
    let now = Date.parse("2026-07-28T12:00:00.000Z");
    const deps: CombSweepDeps = {
      listRuns: listSweepableRuns,
      latestSeal: async () => null,
      spawnAgent: async (request) => ({ name: request.name }),
      lookupAgent: async () => null,
      retireAgent: async () => undefined,
      listHumanPackets: async () => [...packets.values()],
      executeHumanEffect: async (request) => {
        const packet = packetFor(request, "PKT.stall", "2026-07-28T12:00:00.000Z");
        packets.set(packet.id, packet);
        return packet;
      },
      notifyOperator: async (notice) => {
        notices.push(notice.packetId);
      },
      now: () => now,
    };

    await sweepCombs(deps, [], new Map());
    now = Date.parse("2026-07-28T12:00:02.000Z");
    await sweepCombs(deps, [], new Map());
    await sweepCombs(deps, [], new Map());
    const run = (await loadRun(created.id))!;
    const verify = current(run, "verify");
    assert.equal(notices.length, 1);
    assert.equal(verify.stallNotifiedAt, "2026-07-28T12:00:02.000Z");
    assert.ok(verify.evidenceTail.some((evidence) => evidence.kind === "clock"));
    assert.ok(current(run, "timeout"));
    assert.ok(run.edgeFiringTail.some((firing) => firing.edgeId === "verify-timeout"));
  });
});

test("comb run attachment durably adopts the bee before evidence can count", async () => {
  await withTempStore(async (dir) => {
    const bee = session(dir);
    await saveSession(bee);
    const created = await createRun({
      definition: {
        formatVersion: 2,
        name: "attached",
        input: { kind: "informal", description: "none" },
        nodes: [agentNode("work")],
        edges: [],
      },
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "attached", beeName: bee.name, entryNodeId: "work" },
      now: "2026-07-28T12:00:00.000Z",
      policies: { retireAgentsOnTerminal: false },
    });
    const attached = await attachBeeToRun({
      runId: created.id,
      beeName: bee.name,
      deliver: false,
      now: () => Date.parse("2026-07-28T12:00:05.000Z"),
    });
    assert.equal(attached.bee, bee.name);
    assert.match(attached.trackPostscript, /Review, human verification, and landing are driven by the track/);
    const run = (await loadRun(created.id))!;
    const activation = current(run, "work");
    assert.equal(activation.status, "active");
    assert.equal(activation.claim.attemptStartedAt, "2026-07-28T12:00:05.000Z");
    assert.equal(activation.beeHandles[0]?.source, "adopted");
    assert.equal(Object.values(run.effects)[0]?.kind, "agent-adopt");
    assert.equal(Object.values(run.effects)[0]?.status, "confirmed");
    const storedBee = await loadSession(bee.name);
    assert.equal(storedBee?.combActivations?.[0]?.runId, run.id);
    assert.equal(storedBee?.combActivations?.[0]?.attachedAt, "2026-07-28T12:00:05.000Z");
    assert.match(storedBee?.brief ?? "", new RegExp(run.id));
  });
});
