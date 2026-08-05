// Explicit-placement materialization proof (H1 exit): a registered working
// copy satisfies a lease only when it materializes the LEASED snapshot —
// productId, snapshotDigest, and any registered origin/revision must match
// the intent's target. A copy of product B can never run snapshot A.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionProtocolError } from "../src/execution/errors.js";
import { materializeExplicitPlacement } from "../src/execution/launcher.js";
import { readWorkingCopy, registerWorkingCopy } from "../src/execution/workingCopies.js";
import type { JsonObject } from "../src/execution/contract.js";
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
