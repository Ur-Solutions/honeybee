/**
 * Workspaces — persisted, first-class tmux UI sessions
 * (WORKSPACES_AND_QUESTS_PRD §6, §7.1). A workspace has a store record
 * (`WorkspaceRecord`), a file root, an optional colony, and a set of members
 * (linked bee windows + ordinary shell/command panes). Its tmux session is
 * `ws-<name>` (`detach-on-destroy off`), kept distinct from `view-*` so neither
 * leaks into the other's listing/selectors.
 *
 * CRUD + ledger conventions mirror src/colony.ts / src/swarm.ts exactly:
 * validate-before-path-join, embedded-name-must-match-file-stem, one lock per
 * mutation, a defensive reader that drops malformed entries.
 *
 * NOTE: this module is one-way — it does NOT import colony.ts (colony.ts
 * imports it, to auto-provision a workspace on colony creation). Keeping the
 * dependency directional avoids an import cycle.
 */
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger } from "./store.js";

export type WorkspaceMember =
  | { kind: "bee"; beeId: string } // linked bee window
  | { kind: "pane"; name: string; command?: string }; // shell/command at root

export type WorkspaceRecord = {
  name: string; // WS_NAME_RE: /^[A-Za-z0-9][A-Za-z0-9_-]*$/
  rootDir: string; // the file root (may be "" until resolved on first open)
  colony?: string; // colony this workspace belongs to (auto-workspaces)
  questId?: string; // set while a quest owns this workspace (Phase 3)
  members: WorkspaceMember[];
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  archivedAt?: string;
  description?: string;
  // Geometry snapshot (Phase 2): per-window tmux window_layout strings — omitted here.
};

export const WORKSPACE_PREFIX = "ws-";

const WS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validWorkspaceName(name: string): boolean {
  return WS_NAME_RE.test(name);
}

/** `ws-<bare>`, mirroring viewSessionName: strip the prefix if present, validate. */
export function workspaceSessionName(name: string): string {
  const bare = name.startsWith(WORKSPACE_PREFIX) ? name.slice(WORKSPACE_PREFIX.length) : name;
  if (!validWorkspaceName(bare)) throw new Error(`Invalid workspace name: ${name}`);
  return `${WORKSPACE_PREFIX}${bare}`;
}

/** The bare workspace name from a `ws-`-prefixed or bare input (validated). */
export function workspaceBareName(name: string): string {
  const bare = name.startsWith(WORKSPACE_PREFIX) ? name.slice(WORKSPACE_PREFIX.length) : name;
  if (!validWorkspaceName(bare)) throw new Error(`Invalid workspace name: ${name}`);
  return bare;
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  await ensureDir();
  const files = await readdir(workspacesDir()).catch(() => []);
  const records: WorkspaceRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const record = await readWorkspace(join(workspacesDir(), file)).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadWorkspace(name: string): Promise<WorkspaceRecord | null> {
  // Validate before joining into a path so raw user input (`../escape`) can't
  // read arbitrary JSON files outside the workspaces directory.
  if (!validWorkspaceName(name)) return null;
  try {
    return await readWorkspace(workspacePath(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function workspaceExists(name: string): Promise<boolean> {
  return (await loadWorkspace(name)) !== null;
}

export type CreateWorkspaceInput = {
  name: string;
  rootDir: string;
  colony?: string;
  description?: string;
  members?: WorkspaceMember[];
};

export async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
  if (!validWorkspaceName(input.name)) {
    throw new Error(`Invalid workspace name: ${input.name}. Use alphanumerics, dashes, and underscores.`);
  }
  return withWorkspacesLock(async () => {
    const existing = await loadWorkspace(input.name);
    if (existing) throw new Error(`Workspace already exists: ${input.name}`);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      name: input.name,
      rootDir: input.rootDir,
      members: sanitizeMembers(input.members ?? []),
      createdAt: now,
      updatedAt: now,
      ...(input.colony ? { colony: input.colony } : {}),
      ...(input.description ? { description: input.description } : {}),
    };
    await saveWorkspace(record);
    await appendLedger({ type: "workspace.create", name: record.name });
    return record;
  });
}

export type WorkspacePatch = {
  rootDir?: string;
  colony?: string;
  questId?: string;
  description?: string;
  members?: WorkspaceMember[];
};

export async function updateWorkspace(name: string, patch: WorkspacePatch): Promise<WorkspaceRecord> {
  if (!validWorkspaceName(name)) {
    throw new Error(`Invalid workspace name: ${name}. Use alphanumerics, dashes, and underscores.`);
  }
  return withWorkspacesLock(async () => {
    const existing = await loadWorkspace(name);
    if (!existing) throw new Error(`Unknown workspace: ${name}`);
    const updated: WorkspaceRecord = { ...existing, updatedAt: new Date().toISOString() };
    if (patch.rootDir !== undefined) updated.rootDir = patch.rootDir;
    if (patch.members !== undefined) updated.members = sanitizeMembers(patch.members);
    if (patch.colony !== undefined) {
      if (patch.colony === "") delete updated.colony;
      else updated.colony = patch.colony;
    }
    if (patch.questId !== undefined) {
      if (patch.questId === "") delete updated.questId;
      else updated.questId = patch.questId;
    }
    if (patch.description !== undefined) {
      if (patch.description === "") delete updated.description;
      else updated.description = patch.description;
    }
    await saveWorkspace(updated);
    await appendLedger({ type: "workspace.update", name });
    return updated;
  });
}

export async function renameWorkspace(oldName: string, newName: string): Promise<WorkspaceRecord> {
  if (!validWorkspaceName(oldName)) throw new Error(`Invalid workspace name: ${oldName}. Use alphanumerics, dashes, and underscores.`);
  if (!validWorkspaceName(newName)) throw new Error(`Invalid workspace name: ${newName}. Use alphanumerics, dashes, and underscores.`);
  return withWorkspacesLock(async () => {
    const existing = await loadWorkspace(oldName);
    if (!existing) throw new Error(`Unknown workspace: ${oldName}`);
    if (oldName === newName) return existing;
    if (await loadWorkspace(newName)) throw new Error(`Workspace already exists: ${newName}`);
    const updated: WorkspaceRecord = { ...existing, name: newName, updatedAt: new Date().toISOString() };
    // Write the new record before removing the old one (colony.ts pattern): a
    // crash in between leaves the workspace alive under both names (an easily
    // deleted duplicate), not lost entirely on a failed write.
    await saveWorkspace(updated);
    await rm(workspacePath(oldName), { force: true });
    await appendLedger({ type: "workspace.rename", from: oldName, to: newName });
    return updated;
  });
}

export async function archiveWorkspace(name: string): Promise<WorkspaceRecord> {
  if (!validWorkspaceName(name)) throw new Error(`Invalid workspace name: ${name}. Use alphanumerics, dashes, and underscores.`);
  return withWorkspacesLock(async () => {
    const existing = await loadWorkspace(name);
    if (!existing) throw new Error(`Unknown workspace: ${name}`);
    if (existing.archived) return existing;
    const updated: WorkspaceRecord = { ...existing, archived: true, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await saveWorkspace(updated);
    await appendLedger({ type: "workspace.archive", name });
    return updated;
  });
}

// Serialize workspace mutations behind one lock so two concurrent
// check-then-write sequences can't both succeed.
async function withWorkspacesLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(join(workspacesDir(), ".workspaces.lock"), fn);
}

export async function saveWorkspace(record: WorkspaceRecord): Promise<void> {
  await ensureDir();
  await atomicWriteFile(workspacePath(record.name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Keep only well-formed members; coerce unknown member kinds out (swarm.ts pattern). */
function sanitizeMembers(members: unknown): WorkspaceMember[] {
  if (!Array.isArray(members)) return [];
  const result: WorkspaceMember[] = [];
  for (const raw of members) {
    if (!raw || typeof raw !== "object") continue;
    const member = raw as Record<string, unknown>;
    if (member.kind === "bee" && typeof member.beeId === "string") {
      result.push({ kind: "bee", beeId: member.beeId });
    } else if (member.kind === "pane" && typeof member.name === "string") {
      result.push({
        kind: "pane",
        name: member.name,
        ...(typeof member.command === "string" ? { command: member.command } : {}),
      });
    }
  }
  return result;
}

export async function readWorkspace(path: string): Promise<WorkspaceRecord> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid workspace record at ${path}`);
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.name !== "string" || typeof object.createdAt !== "string") {
    throw new Error(`Invalid workspace record at ${path}: missing name or createdAt`);
  }
  // A record whose embedded name disagrees with its file stem is debris (e.g. a
  // hand-copied file); treating it as live would create phantom duplicates.
  const stem = basename(path).replace(/\.json$/, "");
  if (object.name !== stem) {
    throw new Error(`Invalid workspace record at ${path}: name ${object.name} does not match file name`);
  }
  const record: WorkspaceRecord = {
    name: object.name,
    rootDir: typeof object.rootDir === "string" ? object.rootDir : "",
    members: sanitizeMembers(object.members),
    createdAt: object.createdAt,
    updatedAt: typeof object.updatedAt === "string" ? object.updatedAt : object.createdAt,
  };
  if (typeof object.colony === "string") record.colony = object.colony;
  if (typeof object.questId === "string") record.questId = object.questId;
  if (object.archived === true) record.archived = true;
  if (typeof object.archivedAt === "string") record.archivedAt = object.archivedAt;
  if (typeof object.description === "string") record.description = object.description;
  return record;
}

async function ensureDir(): Promise<void> {
  await mkdir(workspacesDir(), { recursive: true });
}

export function workspacesDir(): string {
  return join(storeRoot(), "workspaces");
}

export function workspacePath(name: string): string {
  return join(workspacesDir(), `${name}.json`);
}
