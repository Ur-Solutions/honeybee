import { readFileSync, statSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { appendLedger } from "./store.js";

export type NodeKind = "local-tmux" | "ssh-tmux";

export type NodeStatus = "online" | "offline" | "unknown";

export type NodeRecord = {
  name: string;
  kind: NodeKind;
  endpoint: string;
  capabilities: string[];
  status?: NodeStatus;
  lastSeen?: string;
  description?: string;
  sshCommand?: string;
  sshArgs?: string[];
  createdAt: string;
  updatedAt: string;
};

const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const LOCAL_NODE_NAME = "local";

const IMPLICIT_LOCAL: NodeRecord = {
  name: LOCAL_NODE_NAME,
  kind: "local-tmux",
  endpoint: "localhost",
  capabilities: ["*"],
  status: "online",
  description: "Implicit local node (no registration required)",
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export function validNodeName(name: string): boolean {
  return NODE_NAME_RE.test(name);
}

export function isLocalNode(record: Pick<NodeRecord, "kind">): boolean {
  return record.kind === "local-tmux";
}

export function supportsCapability(node: NodeRecord, capability: string): boolean {
  if (node.capabilities.includes("*")) return true;
  return node.capabilities.includes(capability);
}

export async function listNodes(): Promise<NodeRecord[]> {
  const files = await readdir(nodesDir()).catch(() => []);
  const explicit: NodeRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const record = await readNode(join(nodesDir(), file)).catch(() => null);
    if (record) explicit.push(record);
  }
  const hasExplicitLocal = explicit.some((r) => r.name === LOCAL_NODE_NAME);
  const all = hasExplicitLocal ? explicit : [IMPLICIT_LOCAL, ...explicit];
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadNode(name: string): Promise<NodeRecord | null> {
  try {
    return await readNode(nodePath(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (name === LOCAL_NODE_NAME) return IMPLICIT_LOCAL;
      return null;
    }
    throw error;
  }
}

export function loadNodeSync(name: string): NodeRecord | null {
  try {
    const raw = readFileSync(nodePath(name), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed ? normalizeNode(parsed, nodePath(name)) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (name === LOCAL_NODE_NAME) return IMPLICIT_LOCAL;
      return null;
    }
    throw error;
  }
}

export async function nodeExists(name: string): Promise<boolean> {
  return (await loadNode(name)) !== null;
}

export type RegisterNodeInput = {
  name: string;
  kind: NodeKind;
  endpoint: string;
  capabilities?: string[];
  description?: string;
  sshCommand?: string;
  sshArgs?: string[];
};

export async function registerNode(input: RegisterNodeInput): Promise<NodeRecord> {
  if (!validNodeName(input.name)) throw new Error(`Invalid node name: ${input.name}. Use alphanumerics, dashes, underscores, and dots.`);
  if (input.kind !== "local-tmux" && input.kind !== "ssh-tmux") throw new Error(`Invalid node kind: ${input.kind}. Use local-tmux or ssh-tmux.`);
  if (!input.endpoint || input.endpoint.length === 0) throw new Error("Node endpoint is required");
  if (input.sshCommand && /\s/.test(input.sshCommand)) {
    throw new Error(`--ssh-command must be a single binary path with no whitespace. Use --ssh-args for flags (e.g. --ssh-args "-F /etc/ssh/config").`);
  }

  const fileExists = isFileNode(nodePath(input.name));
  if (fileExists) throw new Error(`Node already exists: ${input.name}`);

  const now = new Date().toISOString();
  const record: NodeRecord = {
    name: input.name,
    kind: input.kind,
    endpoint: input.endpoint,
    capabilities: input.capabilities && input.capabilities.length > 0 ? [...input.capabilities] : ["*"],
    status: "unknown",
    createdAt: now,
    updatedAt: now,
    ...(input.description ? { description: input.description } : {}),
    ...(input.sshCommand ? { sshCommand: input.sshCommand } : {}),
    ...(input.sshArgs && input.sshArgs.length > 0 ? { sshArgs: input.sshArgs } : {}),
  };
  await saveNode(record);
  await appendLedger({ type: "node.register", name: record.name, kind: record.kind, endpoint: record.endpoint });
  return record;
}

export type UpdateNodePatch = {
  description?: string;
  capabilities?: string[];
  endpoint?: string;
  sshCommand?: string;
  sshArgs?: string[];
  status?: NodeStatus;
  lastSeen?: string;
};

export async function updateNode(name: string, patch: UpdateNodePatch): Promise<NodeRecord> {
  if (name === LOCAL_NODE_NAME && !isFileNode(nodePath(name))) {
    throw new Error(`Cannot modify implicit local node. Run 'hive node register local --kind local-tmux --endpoint localhost' first to override.`);
  }
  const existing = await loadNode(name);
  if (!existing) throw new Error(`Unknown node: ${name}`);
  const updated: NodeRecord = { ...existing };
  if (patch.description !== undefined) {
    if (patch.description === "") delete updated.description;
    else updated.description = patch.description;
  }
  if (patch.capabilities !== undefined) {
    updated.capabilities = patch.capabilities.length > 0 ? [...patch.capabilities] : ["*"];
  }
  if (patch.endpoint !== undefined) {
    if (!patch.endpoint || patch.endpoint.length === 0) throw new Error("Node endpoint cannot be empty");
    updated.endpoint = patch.endpoint;
  }
  if (patch.sshCommand !== undefined) {
    if (patch.sshCommand === "") delete updated.sshCommand;
    else {
      if (/\s/.test(patch.sshCommand)) throw new Error(`--ssh-command must be a single binary path with no whitespace. Use --ssh-args for flags.`);
      updated.sshCommand = patch.sshCommand;
    }
  }
  if (patch.sshArgs !== undefined) {
    if (patch.sshArgs.length === 0) delete updated.sshArgs;
    else updated.sshArgs = [...patch.sshArgs];
  }
  if (patch.status !== undefined) updated.status = patch.status;
  if (patch.lastSeen !== undefined) updated.lastSeen = patch.lastSeen;
  updated.updatedAt = new Date().toISOString();
  await saveNode(updated);
  await appendLedger({ type: "node.update", name });
  return updated;
}

export async function unregisterNode(name: string): Promise<void> {
  if (name === LOCAL_NODE_NAME && !isFileNode(nodePath(name))) {
    throw new Error(`Cannot unregister implicit local node.`);
  }
  const existing = await loadNode(name);
  if (!existing) throw new Error(`Unknown node: ${name}`);
  await rm(nodePath(name), { force: true });
  await appendLedger({ type: "node.unregister", name });
}

export async function saveNode(record: NodeRecord): Promise<void> {
  await atomicWriteFile(nodePath(record.name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function readNode(path: string): Promise<NodeRecord> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizeNode(parsed, path);
}

function normalizeNode(value: unknown, path: string): NodeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid node record at ${path}`);
  }
  const object = value as Record<string, unknown>;
  const name = object.name;
  const kind = object.kind;
  const endpoint = object.endpoint;
  if (typeof name !== "string" || typeof endpoint !== "string") {
    throw new Error(`Invalid node record at ${path}: missing required fields`);
  }
  if (kind !== "local-tmux" && kind !== "ssh-tmux") {
    throw new Error(`Invalid node record at ${path}: unknown kind`);
  }
  const capabilities = Array.isArray(object.capabilities)
    ? object.capabilities.filter((c): c is string => typeof c === "string")
    : ["*"];
  const createdAt = typeof object.createdAt === "string" ? object.createdAt : "1970-01-01T00:00:00.000Z";
  const updatedAt = typeof object.updatedAt === "string" ? object.updatedAt : createdAt;
  const record: NodeRecord = {
    name,
    kind,
    endpoint,
    capabilities,
    createdAt,
    updatedAt,
  };
  if (object.status === "online" || object.status === "offline" || object.status === "unknown") record.status = object.status;
  if (typeof object.lastSeen === "string") record.lastSeen = object.lastSeen;
  if (typeof object.description === "string") record.description = object.description;
  if (typeof object.sshCommand === "string") record.sshCommand = object.sshCommand;
  if (Array.isArray(object.sshArgs)) record.sshArgs = object.sshArgs.filter((a): a is string => typeof a === "string");
  return record;
}

function isFileNode(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function nodesDir(): string {
  return join(storeRoot(), "nodes");
}

function nodePath(name: string): string {
  return join(nodesDir(), `${name}.json`);
}
