import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { storeRoot } from "../fsx.js";
import { sealsRoot, type SealRecord } from "../seal.js";
import type { CorpusReader, LedgerFilter, LedgerLine, SealFilter, SessionFilter } from "../search.js";
import { ledgerPath, listSessions, safeName, type SessionRecord } from "../store.js";

const LEDGER_READ_CHUNK_BYTES = 64 * 1024;

export function defaultCorpusReader(): CorpusReader {
  return {
    listLedgerFiles,
    readSeals: defaultReadSeals,
    readSessionRecords: defaultReadSessionRecords,
    readLedgerLines: defaultReadLedgerLines,
  };
}

export async function listLedgerFiles(root: string = storeRoot()): Promise<string[]> {
  const base = ledgerPath();
  const dir = root === storeRoot() ? root : join(root);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const ledgerName = basename(base);
  // The current ledger is `ledger.jsonl`; rotations land as
  // `ledger.jsonl.<ISO-with-colons-replaced>`. We sort newest-first so callers
  // get the most recent activity at the top.
  const matches = entries.filter((entry) => entry === ledgerName || entry.startsWith(`${ledgerName}.`));
  const withMtime: { file: string; mtime: number }[] = [];
  for (const file of matches) {
    const full = join(dir, file);
    try {
      const info = await stat(full);
      withMtime.push({ file: full, mtime: info.mtimeMs });
    } catch {
      // file disappeared mid-scan; skip
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.map((entry) => entry.file);
}

async function* defaultReadSeals(filter: SealFilter): AsyncIterable<{ path: string; record: SealRecord }> {
  const root = sealsRoot();
  const beeDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  // First, build list of (beeName, filename) to enable filter pruning before IO.
  const candidates: { beeName: string; filePath: string }[] = [];
  for (const entry of beeDirs) {
    if (!entry.isDirectory()) continue;
    const beeName = entry.name;
    if (filter.bee && beeName !== filter.bee) continue;
    const sealDir = join(root, beeName);
    const files = await readdir(sealDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      candidates.push({ beeName, filePath: join(sealDir, file) });
    }
  }
  // Sort newest-first by filename (timestamp-based names sort lexicographically).
  candidates.sort((a, b) => b.filePath.localeCompare(a.filePath));
  for (const { filePath } of candidates) {
    let record: SealRecord;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as SealRecord;
      record = parsed;
    } catch {
      continue;
    }
    if (filter.status && record.status !== filter.status) continue;
    // Colony/swarm don't live on the seal - they're an attribute of the bee's
    // SessionRecord. When the caller passes those filters, we resolve them via
    // a small in-process cache lookup. Keep that out of the hot path by only
    // doing it when needed.
    if (filter.colony || filter.swarm) {
      const sessionMatch = await sessionMetaFor(record.beeName);
      if (filter.colony && sessionMatch?.colony !== filter.colony) continue;
      if (filter.swarm && sessionMatch?.swarmId !== filter.swarm) continue;
    }
    yield { path: filePath, record };
  }
}

let cachedSessionMeta: Map<string, { colony?: string; swarmId?: string }> | null = null;
async function sessionMetaFor(beeName: string): Promise<{ colony?: string; swarmId?: string } | null> {
  if (!cachedSessionMeta) {
    cachedSessionMeta = new Map();
    const records = await listSessions().catch(() => [] as SessionRecord[]);
    for (const record of records) {
      cachedSessionMeta.set(record.name, {
        ...(record.colony ? { colony: record.colony } : {}),
        ...(record.swarmId ? { swarmId: record.swarmId } : {}),
      });
    }
  }
  return cachedSessionMeta.get(beeName) ?? null;
}

export function resetSessionMetaCache(): void {
  cachedSessionMeta = null;
}

async function* defaultReadSessionRecords(filter: SessionFilter): AsyncIterable<{ path: string; record: SessionRecord }> {
  const records = await listSessions().catch(() => [] as SessionRecord[]);
  // Sessions are stored as <storeRoot>/sessions/<safeName>.json. We surface that
  // path so the CLI can print it next to the snippet.
  const sessionsDir = join(storeRoot(), "sessions");
  for (const record of records) {
    if (filter.bee && record.name !== filter.bee) continue;
    if (filter.colony && record.colony !== filter.colony) continue;
    if (filter.swarm && record.swarmId !== filter.swarm) continue;
    yield { path: join(sessionsDir, `${safeName(record.name)}.json`), record };
  }
}

async function* defaultReadLedgerLines(filter: LedgerFilter): AsyncIterable<LedgerLine> {
  const files = await listLedgerFiles();
  for (const file of files) {
    try {
      for await (const line of readFileLinesNewestFirst(file)) {
        const parsed = parseLedgerLine(line);
        const ts = typeof parsed?.ts === "string" ? parsed.ts : "";
        if (filter.sinceMs !== undefined) {
          const tsMs = Date.parse(ts);
          if (Number.isFinite(tsMs) && tsMs < filter.sinceMs) continue;
        }
        yield { path: file, line, ...(parsed ? { parsed } : {}), ts };
      }
    } catch {
      continue;
    }
  }
}

async function* readFileLinesNewestFirst(file: string): AsyncIterable<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    let position = info.size;
    let carry = Buffer.alloc(0);

    while (position > 0) {
      const chunkSize = Math.min(LEDGER_READ_CHUNK_BYTES, position);
      position -= chunkSize;
      const chunk = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, position);
      if (bytesRead <= 0) continue;
      const buffer = bytesRead === chunkSize ? chunk : chunk.subarray(0, bytesRead);
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i -= 1) {
        if (buffer[i] !== 0x0a) continue;
        const segment = buffer.subarray(i + 1, end);
        const lineBuffer = carry.length > 0 ? Buffer.concat([segment, carry]) : segment;
        const line = trimTrailingCarriageReturn(lineBuffer.toString("utf8"));
        if (line.length > 0) yield line;
        carry = Buffer.alloc(0);
        end = i;
      }
      const prefix = buffer.subarray(0, end);
      carry = carry.length > 0 ? Buffer.concat([prefix, carry]) : Buffer.from(prefix);
    }

    if (carry.length > 0) {
      const line = trimTrailingCarriageReturn(carry.toString("utf8"));
      if (line.length > 0) yield line;
    }
  } finally {
    await handle.close();
  }
}

function trimTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseLedgerLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}
