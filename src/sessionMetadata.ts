import { writeHiveTitle } from "./hiveState.js";
import { canWriteTitle } from "./naming.js";
import { touchSession, type SessionRecord } from "./store.js";
import { latestTranscript, type TranscriptFile, type TranscriptLookupOptions } from "./transcripts.js";

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

  if (tx.path !== record.transcriptPath) fields.transcriptPath = tx.path;
  if (tx.sessionId !== record.providerSessionId) fields.providerSessionId = tx.sessionId;
  if (tx.title && tx.title !== record.title && canWriteTitle(record, "provider")) {
    fields.title = tx.title;
    fields.titleSource = "provider";
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
