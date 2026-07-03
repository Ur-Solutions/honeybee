import { readFileSync, statSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { appendLedger } from "./store.js";

export type NodeKind = "local-tmux" | "ssh-tmux" | "remote-hsr";

export type NodeStatus = "online" | "offline" | "unknown";

/**
 * Per-node credential-delivery policy (APIA-93). SECURITY-SENSITIVE: it decides
 * whether an `--account`-bound bee may run on a REMOTE node, and if so, how the
 * account's login reaches it. Default is the strict, historical rule.
 *
 * - "local-only"      — the vault NEVER leaves this machine; account-bound bees
 *                       run only on local-tmux. Any account spawn on this node
 *                       is refused. (Default when unset.)
 * - "ephemeral-token" — a SHORT-LIVED credential (a minted claude setup-token,
 *                       or the account's codex auth.json) is delivered into the
 *                       remote's per-bee isolated home at spawn and DESTROYED on
 *                       kill. The vault itself is never copied to the remote.
 * - "api-key"         — an API key is delivered as env (e.g. ANTHROPIC_API_KEY).
 *                       A thin variant; see remoteCreds.ts / spawnBee.
 */
export type AuthPolicy = "local-only" | "ephemeral-token" | "api-key";

export const AUTH_POLICIES: readonly AuthPolicy[] = ["local-only", "ephemeral-token", "api-key"];

export function isAuthPolicy(value: unknown): value is AuthPolicy {
  return typeof value === "string" && (AUTH_POLICIES as readonly string[]).includes(value);
}

/** A node's effective policy: the stored value, or the strict default when unset. */
export function authPolicyOf(node: Pick<NodeRecord, "authPolicy">): AuthPolicy {
  return node.authPolicy ?? "local-only";
}

/** One-line human meaning for `hive node inspect` and error surfaces. */
export function describeAuthPolicy(policy: AuthPolicy): string {
  switch (policy) {
    case "local-only":
      return "vault never leaves this machine; account-bound bees are local-only";
    case "ephemeral-token":
      return "short-lived credential delivered to the remote isolated home at spawn, destroyed on kill";
    case "api-key":
      return "API key delivered as env to the remote (thin variant)";
  }
}

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
  /** For kind "remote-hsr": the handshaked runner-host version deployed on the node. */
  runnerHostVersion?: string;
  /**
   * Credential-delivery policy (APIA-93). Absent === "local-only" (the strict
   * default). Only "ephemeral-token"/"api-key" permit account-bound bees on a
   * remote node. See {@link authPolicyOf}.
   */
  authPolicy?: AuthPolicy;
  createdAt: string;
  updatedAt: string;
};

export class InvalidNodeRecordError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidNodeRecordError";
  }
}

export type LoadNodeOptions = {
  /**
   * Treat an unreadable node record like a missing node. Substrate routing uses
   * this so a corrupt node overlay does not poison unrelated local operations.
   */
  tolerateInvalid?: boolean;
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

export async function loadNode(name: string, options: LoadNodeOptions = {}): Promise<NodeRecord | null> {
  try {
    return await readNode(nodePath(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (name === LOCAL_NODE_NAME) return IMPLICIT_LOCAL;
      return null;
    }
    if (options.tolerateInvalid && error instanceof InvalidNodeRecordError) {
      if (name === LOCAL_NODE_NAME) return IMPLICIT_LOCAL;
      return null;
    }
    throw error;
  }
}

export function loadNodeSync(name: string, options: LoadNodeOptions = {}): NodeRecord | null {
  try {
    const path = nodePath(name);
    const raw = readFileSync(path, "utf8");
    const parsed = parseNodeJson(raw, path);
    return normalizeNode(parsed, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (name === LOCAL_NODE_NAME) return IMPLICIT_LOCAL;
      return null;
    }
    if (options.tolerateInvalid && error instanceof InvalidNodeRecordError) {
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
  runnerHostVersion?: string;
  authPolicy?: AuthPolicy;
};

export async function registerNode(input: RegisterNodeInput): Promise<NodeRecord> {
  if (!validNodeName(input.name)) throw new Error(`Invalid node name: ${input.name}. Use alphanumerics, dashes, underscores, and dots.`);
  if (input.kind !== "local-tmux" && input.kind !== "ssh-tmux" && input.kind !== "remote-hsr") throw new Error(`Invalid node kind: ${input.kind}. Use local-tmux, ssh-tmux, or remote-hsr.`);
  if (!input.endpoint || input.endpoint.length === 0) throw new Error("Node endpoint is required");
  if (input.authPolicy !== undefined && !isAuthPolicy(input.authPolicy)) {
    throw new Error(`Invalid auth policy: ${input.authPolicy}. Use local-only, ephemeral-token, or api-key.`);
  }
  if (input.sshCommand && /\s/.test(input.sshCommand)) {
    // The flag parser treats a value starting with "-" as a boolean unless the
    // "=" form is used, so the hint must show --ssh-args="...".
    throw new Error(`--ssh-command must be a single binary path with no whitespace. Use --ssh-args="..." for flags (e.g. --ssh-args="-F /path/to/config").`);
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
    ...(input.runnerHostVersion ? { runnerHostVersion: input.runnerHostVersion } : {}),
    // Store only a non-default policy so plain records stay lean; absent === local-only.
    ...(input.authPolicy && input.authPolicy !== "local-only" ? { authPolicy: input.authPolicy } : {}),
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
  runnerHostVersion?: string;
  status?: NodeStatus;
  lastSeen?: string;
  /** "" resets to the default (local-only); a valid policy sets it. */
  authPolicy?: AuthPolicy | "";
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
      if (/\s/.test(patch.sshCommand)) throw new Error(`--ssh-command must be a single binary path with no whitespace. Use --ssh-args="..." for flags (e.g. --ssh-args="-F /path/to/config").`);
      updated.sshCommand = patch.sshCommand;
    }
  }
  if (patch.sshArgs !== undefined) {
    if (patch.sshArgs.length === 0) delete updated.sshArgs;
    else updated.sshArgs = [...patch.sshArgs];
  }
  if (patch.runnerHostVersion !== undefined) {
    if (patch.runnerHostVersion === "") delete updated.runnerHostVersion;
    else updated.runnerHostVersion = patch.runnerHostVersion;
  }
  if (patch.authPolicy !== undefined) {
    if (patch.authPolicy === "" || patch.authPolicy === "local-only") delete updated.authPolicy;
    else if (!isAuthPolicy(patch.authPolicy)) throw new Error(`Invalid auth policy: ${patch.authPolicy}. Use local-only, ephemeral-token, or api-key.`);
    else updated.authPolicy = patch.authPolicy;
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
  const parsed = parseNodeJson(raw, path);
  return normalizeNode(parsed, path);
}

function parseNodeJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new InvalidNodeRecordError(path, `Invalid JSON in node record ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeNode(value: unknown, path: string): NodeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidNodeRecordError(path, `Invalid node record at ${path}`);
  }
  const object = value as Record<string, unknown>;
  const name = object.name;
  const kind = object.kind;
  const endpoint = object.endpoint;
  if (typeof name !== "string" || typeof endpoint !== "string") {
    throw new InvalidNodeRecordError(path, `Invalid node record at ${path}: missing required fields`);
  }
  if (kind !== "local-tmux" && kind !== "ssh-tmux" && kind !== "remote-hsr") {
    throw new InvalidNodeRecordError(path, `Invalid node record at ${path}: unknown kind`);
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
  if (typeof object.runnerHostVersion === "string") record.runnerHostVersion = object.runnerHostVersion;
  // Only a valid, non-default policy is carried; garbage/local-only normalizes away.
  if (isAuthPolicy(object.authPolicy) && object.authPolicy !== "local-only") record.authPolicy = object.authPolicy;
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
