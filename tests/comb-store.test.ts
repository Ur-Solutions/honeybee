import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveSubjectClaim, loadClaim, releaseClaim, withPreparedClaim } from "../src/comb/claims.js";
import { boardView, cancelRun, createRun, listRuns, loadRun, mutateRun, readRunEvents, recordRunEvent } from "../src/comb/store.js";
import type { CombSpec, RunRecord } from "../src/comb/types.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-comb-store-"));
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

function claimedComb(): CombSpec {
  return {
    formatVersion: 2,
    name: "claimed",
    input: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { repo: { type: "string" }, ref: { type: "string" } },
        required: ["repo", "ref"],
      },
    },
    claim: { scope: "product-comb", inputPointer: "/ref", collision: "refuse" },
    nodes: [{
      id: "work",
      executor: "agent",
      binding: "strict",
      agent: { capacity: { kind: "spawn", bee: "codex" }, brief: "Review {{input.repo}} at {{input.ref}}" },
    }],
    edges: [],
  };
}

test("run storage embeds revision-zero truth, writes bounded board/events, and dirty-checks no-ops", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: claimedComb(),
      input: { repo: "honeybee", ref: "main" },
      cwd: dir,
      productKey: "trmd-honeybee-repo",
      origin: { kind: "manual", actor: "test" },
      now: "2026-07-28T10:00:00.000Z",
    });
    assert.equal(run.currentSnapshot.revision, 0);
    assert.equal(run.snapshotRevision, 0);
    assert.equal(run.activations["work@1#0"]?.claim.taskId, `${run.id}/work/0`);
    assert.equal(run.activations["work@1#0"]?.cohortId, `${run.id}:g0:i0`);
    assert.equal((await listRuns()).length, 1);
    assert.equal(boardView(run).lastEventSequence, 2);

    const before = (await loadRun(run.id))!.updatedAt;
    const unchanged = await mutateRun(run.id, () => undefined);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.run.updatedAt, before);

    await mutateRun(run.id, (record) => {
      recordRunEvent(record, "comb.test", undefined, { n: 1 });
    });
    const events = await readRunEvents(run.id, { after: 1, limit: 2 });
    assert.deepEqual(events.events.map((event) => event.sequence), [2, 3]);
    assert.equal(events.nextAfter, 3);
    assert.equal(events.hasMore, false);
  });
});

test("subject claims refuse the exact holder and remain held across cancellation", async () => {
  await withTempStore(async (dir) => {
    const definition = claimedComb();
    const input = { repo: "honeybee", ref: "main" } as const;
    const runId = "0000000000001-abcd";
    const claim = deriveSubjectClaim({ definition, productKey: "product", input, runId, now: "2026-07-28T10:00:00.000Z" })!;
    const first = await withPreparedClaim<RunRecord>(claim, "refuse", async (claimId) => {
      const run = await createRun({
        definition,
        input,
        cwd: dir,
        productKey: "product",
        origin: { kind: "manual", actor: "test" },
        runId,
        subjectClaimId: claimId,
      });
      return { value: run, run };
    });
    assert.equal(first.joinedExisting, false);
    assert.equal((await loadClaim(claim.id))?.status, "held");

    const competitorId = "0000000000002-abcd";
    const competitor = deriveSubjectClaim({ definition, productKey: "product", input, runId: competitorId })!;
    await assert.rejects(
      withPreparedClaim<RunRecord>(competitor, "refuse", async () => {
        throw new Error("must not create");
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "claim_conflict");
        assert.deepEqual((error as { details?: unknown }).details, {
          claimId: claim.id,
          holdingRunId: runId,
          holdingRunStatus: "active",
          cleanupStatus: "not-required",
        });
        return true;
      },
    );
    await assert.rejects(
      withPreparedClaim<RunRecord>(competitor, "join-existing", async () => {
        throw new Error("must not create");
      }),
      (error: unknown) => (error as { code?: string }).code === "claim_conflict",
    );

    await cancelRun(runId);
    assert.equal((await loadClaim(claim.id))?.status, "held");
    await releaseClaim(claim.id, runId);
    assert.equal((await loadClaim(claim.id))?.status, "released");
  });
});
