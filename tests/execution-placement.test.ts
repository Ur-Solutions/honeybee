// Explicit-placement materialization proof (H1 exit): a registered working
// copy satisfies a lease only when it materializes the LEASED snapshot —
// productId, snapshotDigest, and any registered origin/revision must match
// the intent's target. A copy of product B can never run snapshot A.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionProtocolError, IndeterminateExecutionError } from "../src/execution/errors.js";
import { createHsrRunLauncher, materializeExplicitPlacement } from "../src/execution/launcher.js";
import { readWorkingCopy, registerWorkingCopy } from "../src/execution/workingCopies.js";
import type { JsonObject } from "../src/execution/contract.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import { captureProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import { withTempStore, SNAPSHOT_DIGEST } from "./executionTestKit.js";

const NODE = "node-test";

function intentFor(overrides: Partial<Record<"productId" | "digest" | "origin" | "revision" | "workingCopyId", string>> = {}): JsonObject {
  return {
    runId: "run-0001",
    target: {
      productId: overrides.productId ?? "prod-a",
      source: {
        kind: "git",
        normalizedOrigin: overrides.origin ?? "https://git.example.com/acme/a.git",
        revision: overrides.revision ?? "3f9c2b7d1a6e4f0c9b8a7d6e5f4c3b2a1d0e9f8c",
      },
      digest: overrides.digest ?? SNAPSHOT_DIGEST,
    },
    placement: { kind: "explicit", workingCopyId: overrides.workingCopyId ?? "wc-a", nodeId: NODE },
  };
}

async function expectCode(promise: Promise<unknown>, code: string, label: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExecutionProtocolError, `${label}: ${String(error)}`);
    assert.equal(error.code, code, `${label}: got ${error.code}: ${error.message}`);
    return;
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`);
}

async function registerCopy(): Promise<void> {
  await registerWorkingCopy({
    workingCopyId: "wc-a",
    productId: "prod-a",
    path: "/tmp/wc-a",
    snapshotDigest: SNAPSHOT_DIGEST,
    origin: "https://git.example.com/acme/a.git",
    revision: "3f9c2b7d1a6e4f0c9b8a7d6e5f4c3b2a1d0e9f8c",
  });
}

test("explicit placement: matching snapshot claims the copy for the run", async () => {
  await withTempStore(async () => {
    await registerCopy();
    const copy = await materializeExplicitPlacement(NODE, { runId: "run-0001", intent: intentFor() });
    assert.equal(copy.occupancy?.claimedByRunId, "run-0001");
  });
});

test("explicit placement: product, digest, origin, and revision mismatches are SNAPSHOT_UNAVAILABLE before any claim", async () => {
  await withTempStore(async () => {
    await registerCopy();
    const cases: Array<[string, JsonObject]> = [
      ["different product", intentFor({ productId: "prod-b" })],
      ["different snapshot digest", intentFor({ digest: "sha256:" + "3".repeat(64) })],
      ["different origin", intentFor({ origin: "https://git.example.com/acme/other.git" })],
      ["different revision", intentFor({ revision: "b".repeat(40) })],
    ];
    for (const [label, intent] of cases) {
      await expectCode(materializeExplicitPlacement(NODE, { runId: "run-0001", intent }), "SNAPSHOT_UNAVAILABLE", label);
    }
    const copy = await readWorkingCopy("wc-a");
    assert.equal(copy?.occupancy, undefined, "refused placements must not claim occupancy");
  });
});

test("explicit placement: unregistered copy, wrong node, and string placements stay typed", async () => {
  await withTempStore(async () => {
    await registerCopy();
    await expectCode(
      materializeExplicitPlacement(NODE, { runId: "run-0001", intent: intentFor({ workingCopyId: "wc-missing" }) }),
      "MATERIALIZATION_FAILED",
      "unregistered copy",
    );
    await expectCode(
      materializeExplicitPlacement("node-elsewhere", { runId: "run-0001", intent: intentFor() }),
      "MATERIALIZATION_FAILED",
      "wrong node",
    );
    const fresh = { ...intentFor(), placement: "fresh" };
    await expectCode(
      materializeExplicitPlacement(NODE, { runId: "run-0001", intent: fresh }),
      "MATERIALIZATION_FAILED",
      "fresh placement not materializable in H1",
    );
  });
});

test("HSR readiness timeout stops a runtime that becomes ready just after the deadline", async () => {
  await withTempStore(async () => {
    await registerCopy();
    let lateReady = false;
    let stopCalls = 0;
    const launcher = createHsrRunLauncher({
      nodeId: async () => NODE,
      readinessTimeoutMs: 1,
      spawn: async (request) => ({ name: request.beeName, id: "CO.canonical" }),
      waitForReadiness: async () => {
        lateReady = true; // readiness raced the timeout boundary
        return false;
      },
      stop: async () => {
        stopCalls += 1;
        return { stopped: lateReady, detail: "late-ready host stopped and confirmed" };
      },
    });
    await assert.rejects(
      () => launcher({
        runId: "run-0001",
        beeName: "xr-provisional",
        intent: { ...intentFor(), harness: { driverId: "claude", config: {} } },
        lease: {},
      }),
      (error: unknown) => error instanceof ExecutionProtocolError && !(error instanceof IndeterminateExecutionError),
    );
    assert.equal(stopCalls, 1, "timeout always stops even when readiness lands late");
  });
});

test("HSR readiness timeout is indeterminate when known spawn metadata is delayed", async () => {
  await withTempStore(async () => {
    await registerCopy();
    const bee = "xr-provisional";
    const launcher = createHsrRunLauncher({
      nodeId: async () => NODE,
      readinessTimeoutMs: 1,
      spawn: async (request) => ({ name: request.beeName, id: "CO.canonical" }),
      waitForReadiness: async () => false,
    });
    await assert.rejects(
      () => launcher({
        runId: "run-0001",
        beeName: bee,
        intent: { ...intentFor(), harness: { driverId: "claude", config: {} } },
        lease: {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof IndeterminateExecutionError);
        assert.equal(error.cause, "readiness_stop_unconfirmed");
        return true;
      },
    );

    // Publication can land after the timeout/stop attempt. The strict
    // execution stop must not have treated missing meta as proof of death.
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "claude",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: (await captureProcessBirthFingerprint(process.pid))!,
      startedAt: new Date().toISOString(),
      runningAt: new Date().toISOString(),
      controlSocket: "/tmp/honeybee-late-ready.sock",
      status: "running",
    });
    assert.equal(await hsrSubstrate().hasSession(bee), true, "late-ready host remains observable for reconciliation");
  });
});
