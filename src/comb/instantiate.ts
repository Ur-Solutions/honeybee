import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { generateRunId } from "../flow/runs.js";
import { withFileLock } from "../lock.js";
import { canonicalDigest } from "./canonical.js";
import { deriveSubjectClaim, withPreparedClaim } from "./claims.js";
import { CombError } from "./errors.js";
import { createRun, boardView, listRuns, loadRun } from "./store.js";
import type {
  CombSpec,
  JsonValue,
  RunBoardView,
  RunOrigin,
  RunPolicies,
  RunRecord,
  StoredCombVersion,
} from "./types.js";

type DeliveryRecord = {
  schemaVersion: 1;
  deliveryId: string;
  requestDigest: string;
  runId: string;
  created: boolean;
  joinedExisting: boolean;
  createdAt: string;
};

export type InstantiateResult = {
  run: RunBoardView;
  created: boolean;
  joinedExisting: boolean;
  replayedDelivery: boolean;
  intakeReady: boolean;
};

export async function instantiateRun(options: {
  storedComb?: StoredCombVersion;
  definition?: CombSpec;
  input: JsonValue;
  cwd: string;
  productKey: string;
  origin: RunOrigin;
  collision?: "refuse" | "join-existing";
  policies?: Partial<RunPolicies>;
}): Promise<InstantiateResult> {
  const definition = options.storedComb?.definition ?? options.definition;
  if (!definition) throw new CombError("invalid_argument", "run requires a registry comb or ad-hoc graph");
  if (options.origin.kind === "trigger") {
    const digest = deliveryRequestDigest({ ...options, definition });
    return withDelivery(
      options.origin.deliveryId,
      digest,
      () => instantiateFresh({ ...options, definition, originDeliveryRequestDigest: digest }),
    );
  }
  return instantiateFresh({ ...options, definition });
}

export function deliveryRequestDigest(options: {
  storedComb?: StoredCombVersion;
  definition?: CombSpec;
  input: JsonValue;
  cwd: string;
  productKey: string;
  origin: RunOrigin;
  collision?: "refuse" | "join-existing";
}): string {
  const definition = options.storedComb?.definition ?? options.definition;
  if (!definition) throw new CombError("invalid_argument", "delivery digest requires a registry comb or ad-hoc graph");
  return canonicalDigest({
    comb: options.storedComb
      ? { name: options.storedComb.name, version: options.storedComb.version, digest: options.storedComb.digest }
      : { digest: canonicalDigest(definition as unknown as JsonValue) },
    input: options.input,
    cwd: options.cwd,
    productKey: options.productKey,
    origin: options.origin,
    collision: options.collision ?? definition.claim?.collision ?? "refuse",
  });
}

async function instantiateFresh(
  options: Parameters<typeof instantiateRun>[0] & {
    definition: CombSpec;
    originDeliveryRequestDigest?: string;
  },
): Promise<InstantiateResult> {
  const runId = generateRunId();
  const declaredCollision = options.definition.claim?.collision ?? "refuse";
  const requestedCollision = options.collision ?? declaredCollision;
  if (declaredCollision === "refuse" && requestedCollision === "join-existing") {
    throw new CombError("invalid_argument", "run --collision may make a claim stricter, not weaker");
  }
  const claim = deriveSubjectClaim({
    definition: options.definition,
    ...(options.storedComb ? { storedComb: options.storedComb } : {}),
    productKey: options.productKey,
    input: options.input,
    runId,
  });
  const outcome = await withPreparedClaim<Awaited<ReturnType<typeof createRun>>>(
    claim,
    requestedCollision,
    async (subjectClaimId) => {
      const run = await createRun({
        ...(options.storedComb ? { storedComb: options.storedComb } : { definition: options.definition }),
        input: options.input,
        cwd: options.cwd,
        productKey: options.productKey,
        origin: options.origin,
        ...(options.policies ? { policies: options.policies } : {}),
        runId,
        ...(subjectClaimId ? { subjectClaimId } : {}),
        ...(options.originDeliveryRequestDigest
          ? { originDeliveryRequestDigest: options.originDeliveryRequestDigest }
          : {}),
      });
      return { value: run, run };
    },
  );
  return {
    run: boardView(outcome.run),
    created: !outcome.joinedExisting,
    joinedExisting: outcome.joinedExisting,
    replayedDelivery: false,
    intakeReady: outcome.run.intakeReady,
  };
}

async function withDelivery(
  deliveryId: string,
  requestDigest: string,
  create: () => Promise<InstantiateResult>,
): Promise<InstantiateResult> {
  const digest = canonicalDigest(deliveryId).slice("sha256:".length);
  const root = join(storeRoot(), "combs", "deliveries");
  const path = join(root, `${digest}.json`);
  const lock = join(root, `.${digest}.lock`);
  return withFileLock(lock, async () => {
    const existing = await readDelivery(path);
    if (existing) {
      if (existing.deliveryId !== deliveryId || existing.requestDigest !== requestDigest) {
        throw new CombError("version_conflict", `origin delivery ${deliveryId} was already used with a different request`);
      }
      const run = await loadRun(existing.runId);
      if (!run) throw new CombError("corrupt_state", `delivery ${deliveryId} points to missing run ${existing.runId}`);
      return {
        run: boardView(run),
        created: existing.created,
        joinedExisting: existing.joinedExisting,
        replayedDelivery: true,
        intakeReady: run.intakeReady,
      };
    }
    const recovered = await recoverDeliveryRun(deliveryId, requestDigest);
    if (recovered) {
      const record: DeliveryRecord = {
        schemaVersion: 1,
        deliveryId,
        requestDigest,
        runId: recovered.id,
        created: true,
        joinedExisting: false,
        createdAt: recovered.createdAt,
      };
      await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      return {
        run: boardView(recovered),
        created: true,
        joinedExisting: false,
        replayedDelivery: true,
        intakeReady: recovered.intakeReady,
      };
    }
    const result = await create();
    const record: DeliveryRecord = {
      schemaVersion: 1,
      deliveryId,
      requestDigest,
      runId: result.run.id,
      created: result.created,
      joinedExisting: result.joinedExisting,
      createdAt: new Date().toISOString(),
    };
    await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return result;
  });
}

async function recoverDeliveryRun(
  deliveryId: string,
  requestDigest: string,
): Promise<RunRecord | null> {
  const matches = (await listRuns()).filter(
    (run) => run.origin.kind === "trigger" && run.origin.deliveryId === deliveryId,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new CombError("corrupt_state", `origin delivery ${deliveryId} has multiple durable runs`);
  }
  const run = matches[0]!;
  if (!run.originDeliveryRequestDigest) {
    throw new CombError("corrupt_state", `run ${run.id} is missing its delivery request digest`);
  }
  if (run.originDeliveryRequestDigest !== requestDigest) {
    throw new CombError("version_conflict", `origin delivery ${deliveryId} was already used with a different request`);
  }
  return run;
}

async function readDelivery(path: string): Promise<DeliveryRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as DeliveryRecord;
    if (value.schemaVersion !== 1) throw new CombError("corrupt_state", `unsupported delivery record at ${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
