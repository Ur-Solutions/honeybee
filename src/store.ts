import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionRecord = {
  name: string;
  agent: string;
  cwd: string;
  command: string;
  tmuxTarget: string;
  createdAt: string;
  updatedAt: string;
  status?: "running" | "dead";
  notes?: string;
  lastPrompt?: string;
  lastPromptAt?: string;
  transcriptPath?: string;
  providerSessionId?: string;
};

const root = join(homedir(), ".agentpit");
const sessionsDir = join(root, "sessions");
const ledgerPath = join(root, "ledger.jsonl");

export async function ensureStore() {
  await mkdir(sessionsDir, { recursive: true });
}

export async function saveSession(record: SessionRecord) {
  await ensureStore();
  await writeFile(recordPath(record.name), `${JSON.stringify(record, null, 2)}\n`);
  await appendLedger({ type: "session.save", ...record });
}

export async function loadSession(name: string): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath(name), "utf8")) as SessionRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteSession(name: string) {
  await rm(recordPath(name), { force: true });
  await appendLedger({ type: "session.delete", name, ts: new Date().toISOString() });
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureStore();
  const files = await readdir(sessionsDir);
  const records = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(join(sessionsDir, file), "utf8")) as SessionRecord),
  );
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function appendLedger(event: Record<string, unknown>) {
  await ensureStore();
  await writeFile(ledgerPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { flag: "a" });
}

function recordPath(name: string) {
  return join(sessionsDir, `${safeName(name)}.json`);
}

export function safeName(value: string) {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-");
}
