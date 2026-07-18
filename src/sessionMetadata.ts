import { join } from "node:path";
import { storeRoot } from "./fsx.js";
import { writeHiveTitle } from "./hiveState.js";
import { withFileLock } from "./lock.js";
import { canWriteTitle } from "./naming.js";
import { listSessions, touchSession, type SessionRecord } from "./store.js";
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

  // Bootstrap claims serialize across daemon/CLI processes. Without this, two
  // prompt-identical siblings refreshing concurrently can both observe the
  // transcript as unclaimed and persist the same provider identity.
  const persisted = needsOwnershipClaim
    ? await withFileLock(join(storeRoot(), "sessions", ".transcript-ownership.lock"), async () => {
        const claimed = await isClaimedBySibling(record, tx);
        return persistFields(record, tx, options, anchored && !claimed);
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

async function isClaimedBySibling(record: SessionRecord, tx: TranscriptFile): Promise<boolean> {
  const records = await listSessions();
  return records.some((candidate) => {
    if (candidate.name === record.name || candidate.agent !== record.agent) return false;
    // Ownership outlives process state: dead/sealed/archived records still own
    // their history. A deliberate resume is preserved because the new record's
    // explicit stored id/path takes the confirmed-identity path above and never
    // enters this heuristic bootstrap claim.
    return candidate.providerSessionId === tx.sessionId || Boolean(candidate.transcriptPath && samePath(candidate.transcriptPath, tx.path));
  });
}
