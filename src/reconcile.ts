import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { listSessions } from "./store.js";

// ──────────────────────────────────────────────────────────────────────────
// Session reconciliation (Phase 3 patch 3.8, req 8). Scans every known home
// (default tool homes, numbered slots, account homes, homes referenced by
// session records) and builds a unified index keyed by provider session id —
// so a thread orphaned in ~/.claude-1 is discoverable from one place.
// Duplicate ids across homes and syncthing conflict files are flagged, not
// auto-resolved: retrieval primitive, no judgment.
// ──────────────────────────────────────────────────────────────────────────

export type SessionIndexEntry = {
  provider: "claude" | "codex";
  sessionId: string;
  home: string;
  path: string;
  mtimeMs: number;
  /** Claude project-folder key the transcript belongs to (claude only). */
  projectKey?: string;
};

export type SessionIndex = {
  generatedAt: string;
  scannedHomes: string[];
  entries: SessionIndexEntry[];
  /** Session ids that exist in more than one home (possible divergence). */
  duplicates: { sessionId: string; locations: { home: string; path: string; mtimeMs: number }[] }[];
  /** Syncthing conflict files found under the scanned homes. */
  conflicts: string[];
};

export function sessionIndexPath(): string {
  return join(storeRoot(), "sessions-index.json");
}

export type ReconcileOptions = {
  /** Additional homes to scan beyond the discovered set. */
  extraHomes?: string[];
  /** Replace home discovery entirely (tests / explicit scans). */
  homes?: string[];
};

export async function reconcileSessions(options: ReconcileOptions = {}): Promise<SessionIndex> {
  const homes = options.homes ?? (await discoverHomes(options.extraHomes ?? []));
  const entries: SessionIndexEntry[] = [];
  const conflicts: string[] = [];

  for (const home of homes) {
    await scanClaudeHome(home, entries, conflicts);
    await scanCodexHome(home, entries, conflicts);
  }

  const byId = new Map<string, SessionIndexEntry[]>();
  for (const entry of entries) {
    const list = byId.get(entry.sessionId) ?? [];
    list.push(entry);
    byId.set(entry.sessionId, list);
  }
  const duplicates: SessionIndex["duplicates"] = [];
  for (const [sessionId, list] of byId) {
    const homesForId = new Set(list.map((entry) => entry.home));
    if (homesForId.size < 2) continue;
    duplicates.push({
      sessionId,
      locations: list
        .map(({ home, path, mtimeMs }) => ({ home, path, mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs),
    });
  }
  duplicates.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const index: SessionIndex = {
    generatedAt: new Date().toISOString(),
    scannedHomes: homes,
    entries: entries.sort((a, b) => b.mtimeMs - a.mtimeMs),
    duplicates,
    conflicts: conflicts.sort(),
  };
  await atomicWriteFile(sessionIndexPath(), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  return index;
}

// Known homes: the default per-tool dirs, the numbered slot convention,
// account homes under ~/.hive/homes, and any homePath a session record carries.
async function discoverHomes(extra: string[]): Promise<string[]> {
  const candidates = new Set<string>(extra);
  for (const tool of ["claude", "codex"]) {
    candidates.add(join(homedir(), `.${tool}`));
    for (let slot = 1; slot <= 9; slot += 1) candidates.add(join(homedir(), `.${tool}-${slot}`));
  }
  const accountHomes = await readdir(join(storeRoot(), "homes")).catch(() => []);
  for (const name of accountHomes) candidates.add(join(storeRoot(), "homes", name));
  const records = await listSessions().catch(() => []);
  for (const record of records) {
    if (record.homePath) candidates.add(record.homePath);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isDirectory()) existing.push(candidate);
  }
  return existing.sort();
}

async function scanClaudeHome(home: string, entries: SessionIndexEntry[], conflicts: string[]): Promise<void> {
  const projectsDir = join(home, "projects");
  const projects = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const dir = join(projectsDir, project.name);
    const files = await readdir(dir).catch(() => []);
    for (const file of files) {
      const path = join(dir, file);
      if (isSyncConflict(file)) {
        conflicts.push(path);
        continue;
      }
      if (!file.endsWith(".jsonl")) continue;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      entries.push({
        provider: "claude",
        sessionId: file.replace(/\.jsonl$/, ""),
        home,
        path,
        mtimeMs: info.mtimeMs,
        projectKey: project.name,
      });
    }
  }
}

const UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

async function scanCodexHome(home: string, entries: SessionIndexEntry[], conflicts: string[]): Promise<void> {
  const sessionsDir = join(home, "sessions");
  await walk(sessionsDir, 5, async (path) => {
    const file = basename(path);
    if (isSyncConflict(file)) {
      conflicts.push(path);
      return;
    }
    if (!file.endsWith(".jsonl")) return;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return;
    // Codex rollout filenames embed the session uuid; avoid reading every file.
    const sessionId = file.match(UUID_PATTERN)?.[1] ?? file.replace(/\.jsonl$/, "");
    entries.push({ provider: "codex", sessionId, home, path, mtimeMs: info.mtimeMs });
  });
}

async function walk(dir: string, maxDepth: number, visit: (path: string) => Promise<void>): Promise<void> {
  if (maxDepth < 0) return;
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await walk(path, maxDepth - 1, visit);
    else if (item.isFile()) await visit(path);
  }
}

function isSyncConflict(name: string): boolean {
  return name.includes(".sync-conflict");
}

// ──────────────────────────────────────────────────────────────────────────
// Sync manifest (req 9). honeybee owns *what* the durable state is; an
// external tool (syncthing) owns the transport. Credentials never leave the
// machine: the vault and every credential file are excluded.
// ──────────────────────────────────────────────────────────────────────────

export type SyncManifest = {
  generatedAt: string;
  include: string[];
  exclude: string[];
  note: string;
};

export function buildSyncManifest(): SyncManifest {
  return {
    generatedAt: new Date().toISOString(),
    include: [
      "~/.hive/**",
      "~/.claude-*/projects/**",
      "~/.claude/projects/**",
      "~/.codex-*/sessions/**",
      "~/.codex/sessions/**",
    ],
    exclude: [
      "~/.hive/vault/**",
      "~/.hive/homes/**",
      "~/.hive/*.lock",
      "**/.credentials.json",
      "**/auth.json",
      "**/.cache/**",
      "*.sync-conflict*",
    ],
    note: "Credentials never sync; each machine builds its own vault via `hive account login` or `hive account import-caam`.",
  };
}

export function syncManifestPath(): string {
  return join(storeRoot(), "sync-manifest.json");
}

export async function writeSyncManifest(): Promise<SyncManifest> {
  const manifest = buildSyncManifest();
  await atomicWriteFile(syncManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}
