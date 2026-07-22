import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { writeHiveTitle } from "./hiveState.js";
import { withFileLock } from "./lock.js";
import { canWriteTitle } from "./naming.js";
import { listSessions, loadSession, touchSession, type SessionRecord } from "./store.js";
import { isAnchoredTranscriptMatch, latestTranscript, type TranscriptFile, type TranscriptLookupOptions } from "./transcripts.js";
import { samePath } from "./transcripts/util.js";

export type PersistTranscriptMetadataOptions = {
  markRunning?: boolean;
};

export function transcriptLookupForSession(record: SessionRecord): TranscriptLookupOptions {
  return {
    sinceIso: record.lastPromptAt ?? record.createdAt,
    prompt: record.lastPrompt,
    transcriptPath: record.transcriptPath,
    sessionId: record.providerSessionId,
    homePath: record.homePath,
    // An unanchored bee never adopts a sibling's older transcript (see
    // TranscriptLookupOptions.notBeforeIso).
    notBeforeIso: record.createdAt,
  };
}

export async function refreshSessionTranscriptMetadata(record: SessionRecord): Promise<SessionRecord | null> {
  if (!record.lastPromptAt && !record.transcriptPath) return record;
  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record));
  if (!tx) return record;
  return persistSessionTranscriptMetadata(record, tx);
}

export async function persistSessionTranscriptMetadata(
  record: SessionRecord,
  tx: TranscriptFile,
  options: PersistTranscriptMetadataOptions = {},
): Promise<SessionRecord> {
  const lookup = transcriptLookupForSession(record);
  const anchored = isAnchoredTranscriptMatch(tx, lookup);
  const needsOwnershipClaim = anchored && !record.transcriptPath && !record.providerSessionId;

  // TRANSITION LOCK: old Honeybee processes know only this global lock, while
  // new ones additionally persist per-identity claims. Keep the legacy lock
  // around the migration read+claim so a still-running old daemon/CLI cannot
  // double-adopt in the rollout window. The formerly expensive critical
  // section is now bounded: listSessions is 32-way + single-flight and terminal
  // records no longer repeat discovery. This lock can be removed only after
  // unsupported mixed-version processes are no longer allowed.
  const persisted = needsOwnershipClaim
    ? await withFileLock(join(storeRoot(), "sessions", ".transcript-ownership.lock"), async () => {
        const legacyOwner = await findClaimingSibling(record, tx);
        return claimTranscriptIdentity(record, tx, legacyOwner, options);
      })
    : await persistFields(record, tx, options, anchored);

  // Only when the title actually changed this call — this path runs on every
  // wait-loop fingerprint change and most daemon ticks. Keep tmux I/O outside
  // the ownership lock; the identity claim itself is already durable.
  if (persisted.titleChanged) await writeHiveTitle(record, persisted.record.title!);
  return persisted.record;
}

async function persistFields(
  record: SessionRecord,
  tx: TranscriptFile,
  options: PersistTranscriptMetadataOptions,
  allowMetadata: boolean,
): Promise<{ record: SessionRecord; titleChanged: boolean }> {
  const fields: Partial<SessionRecord> = {};

  // Identity (path/session-id) and title are only ever adopted from a
  // transcript that matched on durable evidence and is not already owned by a
  // live sibling. A weak match is still fine to display as a best guess.
  if (allowMetadata) {
    if (tx.path !== record.transcriptPath) fields.transcriptPath = tx.path;
    if (tx.sessionId !== record.providerSessionId) fields.providerSessionId = tx.sessionId;
    if (tx.title && tx.title !== record.title && canWriteTitle(record, "provider")) {
      fields.title = tx.title;
      fields.titleSource = "provider";
    }
  }
  if (options.markRunning && record.status !== "running") fields.status = "running";

  if (Object.keys(fields).length === 0) return { record, titleChanged: false };

  fields.updatedAt = new Date().toISOString();
  const updated = await touchSession(record.name, fields);
  return {
    record: updated ?? { ...record, ...fields },
    titleChanged: typeof fields.title === "string",
  };
}

type TranscriptOwnershipClaim = {
  owner: string;
  agent: string;
  identity: string;
  claimedAt: string;
};

async function claimTranscriptIdentity(
  record: SessionRecord,
  tx: TranscriptFile,
  legacyOwner: SessionRecord | null,
  options: PersistTranscriptMetadataOptions,
): ReturnType<typeof persistFields> {
  const identity = transcriptIdentity(record.agent, tx);
  const digest = createHash("sha256").update(identity).digest("hex");
  const claimPath = join(storeRoot(), "transcript-ownership", `${digest}.json`);

  return withFileLock(`${claimPath}.lock`, async () => {
    const durable = await readTranscriptOwnershipClaim(claimPath);
    if (durable && durable.owner !== record.name) {
      // A claim whose owner record was deliberately deleted may be reused.
      // Process state is irrelevant: sealed/archived owners retain history.
      const owner = await loadSession(durable.owner);
      // A pre-commit crash can leave a claim file whose owner never acquired
      // the identity. Do not strand it forever merely because that unrelated
      // session record still exists.
      if (owner && ownsTranscriptIdentity(owner, tx)) return persistFields(record, tx, options, false);
    }

    if (!durable && legacyOwner && legacyOwner.name !== record.name) {
      await writeTranscriptOwnershipClaim(claimPath, legacyOwner.name, record.agent, identity);
      return persistFields(record, tx, options, false);
    }

    // Reserve BEFORE persisting session fields. If this process crashes in the
    // tiny gap, only this same record can resume the claim; a sibling can never
    // double-adopt the transcript.
    if (!durable || durable.owner !== record.name) {
      await writeTranscriptOwnershipClaim(claimPath, record.name, record.agent, identity);
    }
    return persistFields(record, tx, options, true);
  });
}

function ownsTranscriptIdentity(record: SessionRecord, tx: TranscriptFile): boolean {
  return record.providerSessionId === tx.sessionId || Boolean(record.transcriptPath && samePath(record.transcriptPath, tx.path));
}

function transcriptIdentity(agent: string, tx: TranscriptFile): string {
  const providerIdentity = tx.sessionId.trim();
  return `${agent}\0${providerIdentity ? `session:${providerIdentity}` : `path:${resolve(tx.path)}`}`;
}

async function readTranscriptOwnershipClaim(path: string): Promise<TranscriptOwnershipClaim | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<TranscriptOwnershipClaim>;
    return typeof value.owner === "string" && typeof value.agent === "string" && typeof value.identity === "string" &&
      typeof value.claimedAt === "string"
      ? value as TranscriptOwnershipClaim
      : null;
  } catch {
    return null;
  }
}

async function writeTranscriptOwnershipClaim(path: string, owner: string, agent: string, identity: string): Promise<void> {
  const value: TranscriptOwnershipClaim = { owner, agent, identity, claimedAt: new Date().toISOString() };
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function findClaimingSibling(record: SessionRecord, tx: TranscriptFile): Promise<SessionRecord | null> {
  const records = await listSessions();
  return records.find((candidate) => {
    if (candidate.name === record.name || candidate.agent !== record.agent) return false;
    // Ownership outlives process state: dead/sealed/archived records still own
    // their history. A deliberate resume is preserved because the new record's
    // explicit stored id/path takes the confirmed-identity path above and never
    // enters this heuristic bootstrap claim.
    return candidate.providerSessionId === tx.sessionId || Boolean(candidate.transcriptPath && samePath(candidate.transcriptPath, tx.path));
  }) ?? null;
}
