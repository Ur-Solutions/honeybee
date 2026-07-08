import { writeHiveTitle } from "./hiveState.js";
import { canWriteTitle } from "./naming.js";
import { touchSession, type SessionRecord } from "./store.js";
import { isAnchoredTranscriptMatch, latestTranscript, type TranscriptFile, type TranscriptLookupOptions } from "./transcripts.js";

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
  const fields: Partial<SessionRecord> = {};

  // Identity (path/session-id) and title are only ever adopted from a
  // transcript that matched on real evidence. A weak match (mtime/cwd/since
  // only) is any sibling's newest file in the shared cwd folder — persisting it
  // once poisons the record's anchors, and every later lookup then "confirms"
  // the wrong transcript via its stored path. markRunning is still honored:
  // fresh pane/transcript activity is a liveness signal either way.
  const anchored = isAnchoredTranscriptMatch(tx);
  if (anchored) {
    if (tx.path !== record.transcriptPath) fields.transcriptPath = tx.path;
    if (tx.sessionId !== record.providerSessionId) fields.providerSessionId = tx.sessionId;
    if (tx.title && tx.title !== record.title && canWriteTitle(record, "provider")) {
      fields.title = tx.title;
      fields.titleSource = "provider";
    }
  }
  if (options.markRunning && record.status !== "running") fields.status = "running";

  if (Object.keys(fields).length === 0) return record;

  fields.updatedAt = new Date().toISOString();
  const updated = await touchSession(record.name, fields);
  // Only when the title actually changed this call — this path runs on every
  // wait-loop fingerprint change and most daemon ticks.
  if (typeof fields.title === "string") await writeHiveTitle(record, fields.title);
  return updated ?? { ...record, ...fields };
}
