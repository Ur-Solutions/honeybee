import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { canonicalDigest } from "./canonical.js";
import { CombError } from "./errors.js";
import { resolveJsonPointer } from "./schema.js";
import { loadRun } from "./store.js";
import type { CombSpec, JsonValue, RunRecord, StoredCombVersion, SubjectClaimRecord } from "./types.js";

export function combClaimsRoot(): string {
  return join(storeRoot(), "combs", "claims");
}

export function claimPath(claimId: string): string {
  return join(combClaimsRoot(), `${claimId}.json`);
}

function claimLockPath(claimId: string): string {
  return join(combClaimsRoot(), `.${claimId}.lock`);
}

export function deriveSubjectClaim(options: {
  definition: CombSpec;
  storedComb?: StoredCombVersion;
  productKey: string;
  input: JsonValue;
  runId: string;
  now?: string;
}): SubjectClaimRecord | null {
  const declaration = options.definition.claim;
  if (!declaration) return null;
  const selected = resolveJsonPointer(options.input, declaration.inputPointer);
  if (!selected.found) {
    throw new CombError("invalid_argument", `claim inputPointer ${JSON.stringify(declaration.inputPointer)} did not resolve`);
  }
  const valueDigest = canonicalDigest(selected.value);
  const identity: JsonValue = {
    scope: declaration.scope,
    productKey: options.productKey,
    ...(declaration.scope === "product-comb" ? { combName: options.definition.name } : {}),
    inputPointer: declaration.inputPointer,
    value: selected.value,
  };
  const id = canonicalDigest(identity).slice("sha256:".length);
  return {
    schemaVersion: 1,
    id,
    scope: declaration.scope,
    productKey: options.productKey,
    combName: options.definition.name,
    ...(options.storedComb ? { combVersion: options.storedComb.version } : {}),
    definitionDigest: canonicalDigest(options.definition as unknown as JsonValue),
    declarationPointer: declaration.inputPointer,
    value: selected.value,
    valueDigest,
    runId: options.runId,
    status: "prepared",
    preparedAt: options.now ?? new Date().toISOString(),
  };
}

export async function loadClaim(claimId: string): Promise<SubjectClaimRecord | null> {
  try {
    const value = JSON.parse(await readFile(claimPath(claimId), "utf8")) as SubjectClaimRecord;
    if (value.schemaVersion !== 1 || value.id !== claimId) throw new CombError("corrupt_state", `subject claim ${claimId} is invalid`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function withPreparedClaim<T>(
  claim: SubjectClaimRecord | null,
  collision: "refuse" | "join-existing",
  create: (claimId?: string) => Promise<{ value: T; run: RunRecord }>,
): Promise<{ value: T; run: RunRecord; joinedExisting: boolean }> {
  if (!claim) {
    const created = await create();
    return { ...created, joinedExisting: false };
  }
  await mkdir(combClaimsRoot(), { recursive: true });
  return withFileLock(claimLockPath(claim.id), async () => {
    const existing = await loadClaim(claim.id);
    if (existing && existing.status !== "released") {
      const holder = await loadRun(existing.runId);
      if (existing.status === "prepared" && !holder) {
        const released = { ...existing, status: "released" as const, releasedAt: new Date().toISOString() };
        await atomicWriteFile(claimPath(claim.id), `${JSON.stringify(released, null, 2)}\n`, { mode: 0o600 });
      } else {
        if (collision === "join-existing" && holder) {
          return { value: holder as unknown as T, run: holder, joinedExisting: true };
        }
        throw new CombError("claim_conflict", `claim conflict: held by ${existing.runId}`, {
          claimId: existing.id,
          holdingRunId: existing.runId,
          holdingRunStatus: holder?.status ?? "unknown",
          cleanupStatus: holder?.cleanup.status ?? "unknown",
        });
      }
    }
    await atomicWriteFile(claimPath(claim.id), `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
    try {
      const created = await create(claim.id);
      const held: SubjectClaimRecord = { ...claim, status: "held", heldAt: new Date().toISOString() };
      await atomicWriteFile(claimPath(claim.id), `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
      return { ...created, joinedExisting: false };
    } catch (error) {
      const released: SubjectClaimRecord = { ...claim, status: "released", releasedAt: new Date().toISOString() };
      await atomicWriteFile(claimPath(claim.id), `${JSON.stringify(released, null, 2)}\n`, { mode: 0o600 });
      throw error;
    }
  });
}

export async function releaseClaim(claimId: string, runId: string): Promise<void> {
  await withFileLock(claimLockPath(claimId), async () => {
    const claim = await loadClaim(claimId);
    if (!claim || claim.status === "released") return;
    if (claim.runId !== runId) throw new CombError("corrupt_state", `claim ${claimId} is held by ${claim.runId}, not ${runId}`);
    const released: SubjectClaimRecord = { ...claim, status: "released", releasedAt: new Date().toISOString() };
    await atomicWriteFile(claimPath(claimId), `${JSON.stringify(released, null, 2)}\n`, { mode: 0o600 });
  });
}
