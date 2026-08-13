// Cross-stack tests for the integrated H1+H3+admin baseline: seams where the
// canonical-nodeId admin invariant, the H3 operation surface, and the launcher
// parent/account enhancements overlap and an auto-merge could have masked
// behavior. Focus: trusted parent authorship (admission-validated parentRunId,
// ActorContext-derived spawnedById, fail-closed persisted initiator) and the
// canonical Apiary nodeId in H3's wire-visible collect evidence.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject } from "../src/execution/contract.js";
import { admitRunStart, readReservation, runDir } from "../src/execution/runStore.js";
import type { RunLaunchRequest, RunLauncher } from "../src/execution/service.js";
import {
  beeNameForRun,
  buildOperationEnvelope,
  buildRunStartEnvelope,
  countingLauncher,
  installTestAuthority,
  makeService,
  withTempStore,
  CANONICAL_NODE_ID,
  OWNER_SCOPE,
  WORKSPACE,
  type EnvelopeOverrides,
  type TestAuthority,
} from "./executionTestKit.js";

const RUN_ID = "run-0001";

function errorCode(response: JsonObject): string | undefined {
  const error = response.error as JsonObject | undefined;
  return typeof error?.code === "string" ? error.code : undefined;
}

/** A launcher that records the full RunLaunchRequest the coordinator sends. */
function capturingLauncher(): { launcher: RunLauncher; requests: RunLaunchRequest[] } {
  const requests: RunLaunchRequest[] = [];
  const inner = countingLauncher();
  const launcher: RunLauncher = async (request) => {
    requests.push(request);
    return inner.launcher(request);
  };
  return { launcher, requests };
}

const AGENT_ACTOR = { initiator: { kind: "agent", id: "BEE.orchestrator-7" } };

/** run.start envelope whose lease + authority ActorContext is an agent. */
function agentEnvelope(ctx: TestAuthority, overrides: EnvelopeOverrides = {}): JsonObject {
  return buildRunStartEnvelope(ctx, {
    ...overrides,
    mutateLease: (lease) => {
      lease.actor = structuredClone(AGENT_ACTOR);
      overrides.mutateLease?.(lease);
    },
    mutateAuthority: (authority) => {
      authority.actor = structuredClone(AGENT_ACTOR);
      overrides.mutateAuthority?.(authority);
    },
  });
}

test("run.start with an agent initiator launches with spawnedById = the admitted agent id", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const { launcher, requests } = capturingLauncher();
    const service = makeService({ launcher });
    const response = (await service.runStart(agentEnvelope(ctx))) as JsonObject;
    assert.equal(errorCode(response), undefined, JSON.stringify(response));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.spawnedById, "BEE.orchestrator-7");
    // The fact is persisted immutably on the reservation for crash relaunch.
    const reservation = await readReservation(RUN_ID);
    assert.deepEqual(reservation?.initiator, { kind: "agent", id: "BEE.orchestrator-7" });
  });
});

test("run.start with a human initiator launches with NO spawnedById (no invented parent)", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const { launcher, requests } = capturingLauncher();
    const service = makeService({ launcher });
    const response = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.equal(errorCode(response), undefined, JSON.stringify(response));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.spawnedById, undefined);
    assert.deepEqual((await readReservation(RUN_ID))?.initiator, { kind: "user", id: "user-ada" });
  });
});

test("run.start rejects an unknown parentRunId typed, before any reservation exists", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const { launcher, requests } = capturingLauncher();
    const service = makeService({ launcher });
    const envelope = agentEnvelope(ctx, {
      mutateIntent: (intent) => {
        intent.parentRunId = "run-nope";
      },
    });
    const response = (await service.runStart(envelope)) as JsonObject;
    assert.equal(errorCode(response), "RUN_UNKNOWN");
    assert.equal(requests.length, 0, "nothing launched");
    assert.equal(await readReservation(RUN_ID), null, "refusal admits no effect");
  });
});

test("run.start rejects a cross-scope parentRunId rather than inventing a parent", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    // Stage a parent reservation in a DIFFERENT owner scope/workspace directly
    // (bypassing validation, as a foreign-scope record on the same node).
    await admitRunStart({
      runId: "run-foreign",
      effectKey: "job-x/run-foreign/start",
      requestDigest: "sha256:" + "1".repeat(64),
      protocolVersion: "0.1",
      schemaDigest: "sha256:" + "0".repeat(64),
      ownerScopeId: "oscope-other",
      workspaceId: "wsp-other",
      jobId: "job-x",
      leaseId: "lease-x",
      leaseExpiresAt: "2036-01-01T00:00:00Z",
      capabilityLeaseId: "cap-lease-x",
      intent: { runId: "run-foreign" },
    });
    const service = makeService();
    const envelope = agentEnvelope(ctx, {
      mutateIntent: (intent) => {
        intent.parentRunId = "run-foreign";
      },
    });
    const response = (await service.runStart(envelope)) as JsonObject;
    assert.equal(errorCode(response), "LEASE_DENIED");
    assert.equal(await readReservation(RUN_ID), null);
  });
});

test("run.start with a same-scope started parent prefers the parent's actual bee identity", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const { launcher, requests } = capturingLauncher();
    const service = makeService({ launcher });
    // Parent run starts first (countingLauncher persists its session and
    // reports sessionRef BEE.<beeName>).
    const parent = (await service.runStart(
      buildRunStartEnvelope(ctx, { runId: "run-0009", jobId: "job-0009", requestId: "req-parent" }),
    )) as JsonObject;
    assert.equal(errorCode(parent), undefined, JSON.stringify(parent));
    // Child names the parent run; the ACTUAL parent bee identity wins over
    // the (also-agent) initiator id.
    const child = (await service.runStart(
      agentEnvelope(ctx, {
        requestId: "req-child",
        mutateIntent: (intent) => {
          intent.parentRunId = "run-0009";
        },
      }),
    )) as JsonObject;
    assert.equal(errorCode(child), undefined, JSON.stringify(child));
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.spawnedById, `BEE.${beeNameForRun("run-0009")}`);
  });
});

test("identical run.start retry replays read-only even after its parent run's record is gone", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const service = makeService();
    const started = (await service.runStart(
      buildRunStartEnvelope(ctx, { runId: "run-0009", jobId: "job-0009", requestId: "req-parent" }),
    )) as JsonObject;
    assert.equal(errorCode(started), undefined);
    const envelope = agentEnvelope(ctx, {
      mutateIntent: (intent) => {
        intent.parentRunId = "run-0009";
      },
    });
    const first = (await service.runStart(envelope)) as JsonObject;
    assert.equal(errorCode(first), undefined, JSON.stringify(first));
    // Simulate the parent's reservation record disappearing (released +
    // retention swept) — the identical retry must still replay its receipt,
    // never re-run parent admission checks.
    const parentPath = join(runDir("run-0009"), "reservation.json");
    await writeFile(parentPath, "", "utf8");
    const replay = (await service.runStart(envelope)) as JsonObject;
    assert.equal(errorCode(replay), undefined, JSON.stringify(replay));
    assert.equal((replay.receipt as JsonObject).outcome, "replayed");
  });
});

test("a malformed persisted initiator fails closed on read (restart-safe, never cast through)", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const service = makeService();
    const started = (await service.runStart(agentEnvelope(ctx))) as JsonObject;
    assert.equal(errorCode(started), undefined);
    // Corrupt the durable initiator fact (empty id) as a crashed/hostile
    // writer could leave it, then read through a FRESH service (restart).
    const path = join(runDir(RUN_ID), "reservation.json");
    const record = JSON.parse(await readFile(path, "utf8")) as JsonObject;
    record.initiator = { kind: "agent", id: "" };
    await writeFile(path, JSON.stringify(record, null, 2), "utf8");
    await assert.rejects(readReservation(RUN_ID), (error: { code?: string }) => error.code === "AUTHORITY_UNAVAILABLE");
    const restarted = makeService();
    const projection = (await restarted.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { error?: JsonObject };
    assert.equal((projection.error as JsonObject | undefined)?.code, "AUTHORITY_UNAVAILABLE");
    // An unknown initiator kind fails closed the same way.
    record.initiator = { kind: "daemon", id: "BEE.x" };
    await writeFile(path, JSON.stringify(record, null, 2), "utf8");
    await assert.rejects(readReservation(RUN_ID), (error: { code?: string }) => error.code === "AUTHORITY_UNAVAILABLE");
  });
});

test("run.collect evidence refs and the environment manifest speak the canonical bound nodeId", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const service = makeService();
    const started = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.equal(errorCode(started), undefined, JSON.stringify(started));
    const collected = (await service.runCollect(
      buildOperationEnvelope(ctx, `${RUN_ID}/collect`, { runId: RUN_ID }, { requestId: "req-collect-1" }),
    )) as JsonObject;
    assert.equal(errorCode(collected), undefined, JSON.stringify(collected));
    const manifest = collected.result as JsonObject;
    const entries = (manifest.entries ?? []) as JsonObject[];
    assert.ok(entries.length > 0, "collect produced evidence entries");
    for (const entry of entries) {
      const ref = entry.ref as JsonObject;
      assert.equal(ref.nodeId, CANONICAL_NODE_ID, `${String(entry.kind)} evidence ref speaks the bound Apiary nodeId`);
    }
    const envEntry = entries.find((entry) => entry.kind === "environment-manifest");
    assert.ok(envEntry, "environment manifest collected");
    const { readEvidence } = await import("../src/execution/evidence.js");
    const envManifest = JSON.parse((await readEvidence(String((envEntry!.ref as JsonObject).token))).toString()) as JsonObject;
    assert.equal(envManifest.nodeId, CANONICAL_NODE_ID, "environment manifest speaks the bound Apiary nodeId");
  });
});

test("HSR launcher: a non-string harness config.account is refused typed, never coerced", async () => {
  await withTempStore(async () => {
    const { createHsrRunLauncher } = await import("../src/execution/launcher.js");
    const { registerWorkingCopy } = await import("../src/execution/workingCopies.js");
    const { SNAPSHOT_DIGEST } = await import("./executionTestKit.js");
    await registerWorkingCopy({
      workingCopyId: "wc-0001",
      productId: "prod-honeycomb-app",
      path: "/tmp/wc-0001",
      snapshotDigest: SNAPSHOT_DIGEST,
    });
    const launcher = createHsrRunLauncher({ nodeId: async () => CANONICAL_NODE_ID });
    const intent: JsonObject = {
      runId: RUN_ID,
      target: { productId: "prod-honeycomb-app", digest: SNAPSHOT_DIGEST },
      placement: { kind: "explicit", workingCopyId: "wc-0001", nodeId: CANONICAL_NODE_ID },
      harness: { driverId: "claude", config: { brief: "hi", account: 123 } },
    };
    await assert.rejects(
      launcher({ runId: RUN_ID, beeName: beeNameForRun(RUN_ID), intent, lease: {} }),
      (error: { code?: string }) => error.code === "HARNESS_UNAVAILABLE",
    );
  });
});

test("HSR launcher config keeps signed preamble separate from the operator brief", async () => {
  const { buildHsrSpawnFlags, resolveHsrHarnessLaunchConfig } = await import("../src/execution/launcher.js");
  const resolved = resolveHsrHarnessLaunchConfig({
    harness: {
      driverId: "codex",
      model: "gpt-5.6-sol",
      config: {
        brief: "Fix the transcript regression.",
        preamble: "You are inside Apiary.",
        account: "auto",
        kitProfile: "web-qa",
      },
    },
  });
  assert.deepEqual(resolved, {
    driverId: "codex",
    model: "gpt-5.6-sol",
    brief: "Fix the transcript regression.",
    preamble: "You are inside Apiary.",
    account: "auto",
    kitProfile: "web-qa",
  });
  assert.deepEqual([...buildHsrSpawnFlags("run-0001", "/tmp/cell", resolved)], [
    ["substrate", "hsr"],
    ["name", "run-0001"],
    ["cwd", "/tmp/cell"],
    ["account", "auto"],
    ["preamble", "You are inside Apiary."],
    ["kit-profile", "web-qa"],
  ]);
});

test("HSR launcher config refuses a non-string signed preamble", async () => {
  const { resolveHsrHarnessLaunchConfig } = await import("../src/execution/launcher.js");
  assert.throws(
    () => resolveHsrHarnessLaunchConfig({ harness: { driverId: "codex", config: { brief: "hi", preamble: 123 } } }),
    (error: { code?: string }) => error.code === "HARNESS_UNAVAILABLE",
  );
});

test("HSR launcher config refuses an absent-value Kit profile instead of silently using the standing home", async () => {
  const { resolveHsrHarnessLaunchConfig } = await import("../src/execution/launcher.js");
  for (const kitProfile of [true, "", "   "]) {
    assert.throws(
      () => resolveHsrHarnessLaunchConfig({ harness: { driverId: "codex", config: { kitProfile } } }),
      (error: { code?: string; message?: string }) =>
        error.code === "HARNESS_UNAVAILABLE" && /kitProfile must be a non-empty string/.test(error.message ?? ""),
    );
  }
});

test("scope sanity: test-kit canonical nodeId differs from the minted identity", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const { loadNodeIdentity } = await import("../src/execution/nodeState.js");
    const identity = await loadNodeIdentity();
    assert.equal(ctx.nodeId, CANONICAL_NODE_ID);
    assert.notEqual(identity.nodeId, CANONICAL_NODE_ID, "kit must keep the ids distinct or canonical-id tests prove nothing");
    assert.equal(OWNER_SCOPE.length > 0 && WORKSPACE.length > 0, true);
  });
});
