import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger, safeName } from "./store.js";

export const TRACK_SCHEMA_VERSION = 2 as const;
export const TRACK_NODE_TYPES = ["action", "orchestrate", "review", "ask", "deploy"] as const;
export const TRACK_STEP_STATUSES = ["pending", "done", "skipped"] as const;
export const TRACK_SUBTASK_STATUSES = ["queued", "running", "done"] as const;

export type TrackNodeType = (typeof TRACK_NODE_TYPES)[number];
export type TrackStepStatus = (typeof TRACK_STEP_STATUSES)[number];
export type TrackSubTaskStatus = (typeof TRACK_SUBTASK_STATUSES)[number];

export type TrackNodeBase = {
  id: string;
  name: string;
  note?: string;
  when?: string;
};

export type TrackActionNode = TrackNodeBase & {
  type: "action";
  instruction?: string;
};

export type TrackOrchestrateNode = TrackNodeBase & {
  type: "orchestrate";
  instruction: string;
  subAgents?: {
    max: number;
    harness: string;
  };
  expectation?: string;
};

export type TrackReviewNode = TrackNodeBase & {
  type: "review";
  approved?: TrackNode[];
  denied?: TrackNode[];
};

export type TrackAskNode = TrackNodeBase & {
  type: "ask";
  question: string;
  blocking: boolean;
};

export type TrackDeployTarget =
  | { kind: "nectar"; label: string; lane?: string }
  | { kind: "named"; name: string }
  | { kind: "text"; description: string };

export type TrackDeployNode = TrackNodeBase & {
  type: "deploy";
  target: TrackDeployTarget;
};

export type TrackNode =
  | TrackActionNode
  | TrackOrchestrateNode
  | TrackReviewNode
  | TrackAskNode
  | TrackDeployNode;

export type TrackBranch = {
  branch: TrackNode[][];
};

export type TrackItem = TrackNode | TrackBranch;

export type Track = {
  schemaVersion: typeof TRACK_SCHEMA_VERSION;
  name: string;
  description?: string;
  version: number;
  items: TrackItem[];
};

// Compatibility projection consumed by the shipped Apiary track card.
export type TrackStep = {
  id: string;
  title: string;
  description?: string;
};

export type TrackStepChange = {
  status: TrackStepStatus;
  at: string;
  note?: string;
};

export type TrackSubTask = {
  name: string;
  status: TrackSubTaskStatus;
};

export type TrackNodeRuntime = {
  status: TrackStepStatus;
  updatedAt: string;
  startedAt?: string;
  statusNote?: string;
  history: TrackStepChange[];
  subTasks: TrackSubTask[];
};

export type TrackNodeState =
  | ((TrackActionNode | TrackOrchestrateNode | TrackAskNode | TrackDeployNode) & TrackNodeRuntime)
  | (Omit<TrackReviewNode, "approved" | "denied"> & TrackNodeRuntime & {
      approved?: TrackNodeState[];
      denied?: TrackNodeState[];
    });

export type TrackStateItem = TrackNodeState | {
  branch: TrackNodeState[][];
};

export type TrackStepState = TrackStep & {
  status: TrackStepStatus;
  updatedAt: string;
  startedAt?: string;
  note?: string;
  history: TrackStepChange[];
  subTasks?: TrackSubTask[];
};

export type TrackException = {
  note: string;
  at: string;
  stepId?: string;
};

export type TrackQueueEntry = {
  track: string;
  version?: number;
  queuedAt: string;
  queuedBy: string;
};

export type TrackAttachment = {
  schemaVersion: typeof TRACK_SCHEMA_VERSION;
  track: string;
  version: number;
  bee: string;
  beeId?: string;
  attachedAt: string;
  updatedAt: string;
  items: TrackStateItem[];
  steps: TrackStepState[];
  exceptions: TrackException[];
  queue: TrackQueueEntry[];
};

export type TrackDelivery = (postscript: string, attachment: TrackAttachment) => Promise<void>;

export type AttachTrackOptions = {
  bee: string;
  beeId?: string;
  version?: number;
  startAt?: string;
  now?: () => Date;
  deliver?: TrackDelivery;
};

export type TrackLifecycleOptions = {
  now?: () => Date;
  deliver?: TrackDelivery;
};

export type DetachTrackOptions = TrackLifecycleOptions & {
  exception?: string;
  stepId?: string;
};

const TRACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TRACK_STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export function tracksRoot(): string {
  return join(storeRoot(), "tracks");
}

export function trackDefinitionsRoot(): string {
  return join(tracksRoot(), "definitions");
}

export function trackAttachmentsRoot(): string {
  return join(tracksRoot(), "attachments");
}

// The latest canonical definition stays at the v1 path so existing readers can
// discover it. Immutable snapshots live under the adjacent name directory.
export function trackDefinitionPath(name: string): string {
  return join(trackDefinitionsRoot(), `${safeName(name)}.json`);
}

export function trackDefinitionVersionPath(name: string, version: number): string {
  return join(trackDefinitionsRoot(), safeName(name), "versions", `${String(version).padStart(6, "0")}.json`);
}

export function trackAttachmentPath(bee: string): string {
  return join(trackAttachmentsRoot(), `${safeName(bee)}.json`);
}

function trackDefinitionLockPath(name: string): string {
  return join(trackDefinitionsRoot(), safeName(name), ".lock");
}

function trackAttachmentLockPath(bee: string): string {
  return join(trackAttachmentsRoot(), `${safeName(bee)}.lock`);
}

export function validTrackName(name: string): boolean {
  return TRACK_NAME_RE.test(name);
}

export function validateTrack(value: unknown, expectedName?: string, forcedVersion?: number): Track {
  const object = objectAt(value, "Invalid track: expected an object");
  const name = object.name;
  if (typeof name !== "string" || !validTrackName(name)) {
    throw new Error("Invalid track: name must contain only letters, numbers, dots, dashes, and underscores");
  }
  if (expectedName !== undefined && name !== expectedName) {
    throw new Error(`Track name mismatch: file declares "${name}", expected "${expectedName}"`);
  }

  const version = forcedVersion ?? validateVersion(object.version, `Invalid track ${name}: version`, 1);
  const description = typeof object.description === "string" ? object.description : undefined;
  if (Array.isArray(object.items)) {
    if (object.items.length === 0) throw new Error(`Invalid track ${name}: items must be a non-empty array`);
    const ids = new NodeIdAllocator(object.items, name);
    const items = object.items.map((entry, index) => validateTrackItem(entry, index, name, ids));
    return {
      schemaVersion: TRACK_SCHEMA_VERSION,
      name,
      ...(description !== undefined ? { description } : {}),
      version,
      items,
    };
  }

  // v1 migration: old plain steps become typed `action` nodes. Description maps to
  // the optional instruction so no authored context is discarded.
  if (!Array.isArray(object.steps) || object.steps.length === 0) {
    throw new Error(`Invalid track ${name}: items must be a non-empty array`);
  }
  const ids = new NodeIdAllocator(object.steps, name);
  const items: TrackItem[] = object.steps.map((entry, index) => {
    const step = objectAt(entry, `Invalid step #${index + 1} in track ${name}: expected an object`);
    const id = ids.take(step.id, `step #${index + 1}`);
    if (typeof step.title !== "string" || step.title.trim().length === 0) {
      throw new Error(`Invalid step ${id} in track ${name}: title must be a non-empty string`);
    }
    return {
      type: "action",
      id,
      name: step.title,
      ...(typeof step.description === "string" ? { instruction: step.description } : {}),
    };
  });
  return {
    schemaVersion: TRACK_SCHEMA_VERSION,
    name,
    ...(description !== undefined ? { description } : {}),
    version,
    items,
  };
}

class NodeIdAllocator {
  private readonly used = new Set<string>();
  private generated = 1;

  constructor(entries: unknown[], private readonly trackName: string) {
    for (const raw of rawNodes(entries)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const id = (raw as Record<string, unknown>).id;
      if (id === undefined) continue;
      if (typeof id !== "string" || !TRACK_STEP_ID_RE.test(id)) {
        throw new Error(`Invalid node id in track ${trackName}: id must be command-safe`);
      }
      if (this.used.has(id)) throw new Error(`Invalid track ${trackName}: duplicate step id "${id}"`);
      this.used.add(id);
    }
  }

  take(value: unknown, location: string): string {
    if (value !== undefined) {
      if (typeof value !== "string" || !TRACK_STEP_ID_RE.test(value)) {
        throw new Error(`Invalid ${location} in track ${this.trackName}: id must be command-safe`);
      }
      return value;
    }
    for (;;) {
      const candidate = `n${this.generated++}`;
      if (this.used.has(candidate)) continue;
      this.used.add(candidate);
      return candidate;
    }
  }
}

function rawNodes(entries: unknown[]): unknown[] {
  const nodes: unknown[] = [];
  const addNode = (entry: unknown) => {
    nodes.push(entry);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const object = entry as Record<string, unknown>;
    if (Array.isArray(object.approved)) object.approved.forEach(addNode);
    if (Array.isArray(object.denied)) object.denied.forEach(addNode);
  };
  for (const entry of entries) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && Array.isArray((entry as Record<string, unknown>).branch)) {
      for (const lane of (entry as { branch: unknown[] }).branch) {
        if (Array.isArray(lane)) lane.forEach(addNode);
      }
    } else {
      addNode(entry);
    }
  }
  return nodes;
}

function validateTrackItem(value: unknown, index: number, trackName: string, ids: NodeIdAllocator): TrackItem {
  const object = objectAt(value, `Invalid item #${index + 1} in track ${trackName}: expected an object`);
  if (Array.isArray(object.branch)) {
    if (object.branch.length === 0) throw new Error(`Invalid branch #${index + 1} in track ${trackName}: lanes must be non-empty`);
    const branch = object.branch.map((lane, laneIndex) => {
      if (!Array.isArray(lane) || lane.length === 0) {
        throw new Error(`Invalid lane #${laneIndex + 1} in branch #${index + 1} of track ${trackName}: nodes must be non-empty`);
      }
      return lane.map((node, nodeIndex) =>
        validateTrackNode(node, `branch #${index + 1} lane #${laneIndex + 1} node #${nodeIndex + 1}`, trackName, ids)
      );
    });
    return { branch };
  }
  return validateTrackNode(object, `item #${index + 1}`, trackName, ids);
}

function validateTrackNode(
  value: unknown,
  location: string,
  trackName: string,
  ids: NodeIdAllocator,
): TrackNode {
  const object = objectAt(value, `Invalid ${location} in track ${trackName}: expected an object`);
  const type = object.type;
  if (!TRACK_NODE_TYPES.includes(type as TrackNodeType)) {
    throw new Error(`Invalid ${location} in track ${trackName}: unsupported node type "${String(type)}"`);
  }
  const id = ids.take(object.id, location);
  if (typeof object.name !== "string" || object.name.trim().length === 0) {
    throw new Error(`Invalid node ${id} in track ${trackName}: name must be a non-empty string`);
  }
  const base: TrackNodeBase = {
    id,
    name: object.name,
    ...(typeof object.note === "string" ? { note: object.note } : {}),
    ...(typeof object.when === "string" ? { when: object.when } : {}),
  };
  switch (type) {
    case "action":
      return {
        ...base,
        type,
        ...(typeof object.instruction === "string" ? { instruction: object.instruction } : {}),
      };
    case "orchestrate": {
      if (typeof object.instruction !== "string" || object.instruction.trim().length === 0) {
        throw new Error(`Invalid orchestrate node ${id} in track ${trackName}: instruction must be a non-empty string`);
      }
      let subAgents: TrackOrchestrateNode["subAgents"];
      if (object.subAgents !== undefined) {
        const raw = objectAt(object.subAgents, `Invalid orchestrate node ${id} in track ${trackName}: subAgents must be an object`);
        if (!Number.isSafeInteger(raw.max) || Number(raw.max) < 1 || typeof raw.harness !== "string" || raw.harness.trim().length === 0) {
          throw new Error(`Invalid orchestrate node ${id} in track ${trackName}: subAgents needs max >= 1 and a harness`);
        }
        subAgents = { max: Number(raw.max), harness: raw.harness };
      }
      return {
        ...base,
        type,
        instruction: object.instruction,
        ...(subAgents ? { subAgents } : {}),
        ...(typeof object.expectation === "string" ? { expectation: object.expectation } : {}),
      };
    }
    case "review": {
      const approved = validateOutcomeArm(object.approved, "approved", id, trackName, ids);
      const denied = validateOutcomeArm(object.denied, "denied", id, trackName, ids);
      return {
        ...base,
        type,
        ...(approved ? { approved } : {}),
        ...(denied ? { denied } : {}),
      };
    }
    case "ask":
      if (typeof object.question !== "string" || object.question.trim().length === 0 || typeof object.blocking !== "boolean") {
        throw new Error(`Invalid ask node ${id} in track ${trackName}: question and blocking:boolean are required`);
      }
      return { ...base, type, question: object.question, blocking: object.blocking };
    case "deploy":
      return { ...base, type, target: validateDeployTarget(object.target, id, trackName) };
    default:
      throw new Error(`Invalid ${location} in track ${trackName}: unsupported node type "${String(type)}"`);
  }
}

function validateOutcomeArm(
  value: unknown,
  arm: "approved" | "denied",
  reviewId: string,
  trackName: string,
  ids: NodeIdAllocator,
): TrackNode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid review node ${reviewId} in track ${trackName}: ${arm} must be an array`);
  }
  return value.map((node, index) =>
    validateTrackNode(node, `review ${reviewId} ${arm} node #${index + 1}`, trackName, ids)
  );
}

function validateDeployTarget(value: unknown, id: string, trackName: string): TrackDeployTarget {
  const target = objectAt(value, `Invalid deploy node ${id} in track ${trackName}: target must be an object`);
  if (target.kind === "nectar") {
    if (typeof target.label !== "string" || target.label.trim().length === 0) {
      throw new Error(`Invalid deploy node ${id} in track ${trackName}: nectar target needs a label`);
    }
    return {
      kind: "nectar",
      label: target.label,
      ...(typeof target.lane === "string" ? { lane: target.lane } : {}),
    };
  }
  if (target.kind === "named") {
    if (typeof target.name !== "string" || target.name.trim().length === 0) {
      throw new Error(`Invalid deploy node ${id} in track ${trackName}: named target needs a name`);
    }
    return { kind: "named", name: target.name };
  }
  if (target.kind === "text") {
    if (typeof target.description !== "string" || target.description.trim().length === 0) {
      throw new Error(`Invalid deploy node ${id} in track ${trackName}: text target needs a description`);
    }
    return { kind: "text", description: target.description };
  }
  throw new Error(`Invalid deploy node ${id} in track ${trackName}: target kind must be nectar, named, or text`);
}

function objectAt(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function validateVersion(value: unknown, message: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${message} must be an integer >= 1`);
  return Number(value);
}

export async function defineTrackFromFile(sourcePath: string): Promise<Track> {
  let raw: string;
  let source: string;
  if (sourcePath === "-") {
    raw = await readStdin();
    source = "stdin";
  } else {
    const absolute = resolve(sourcePath);
    try {
      raw = await readFile(absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Track source file not found: ${sourcePath}`);
      }
      throw error;
    }
    source = absolute;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid track JSON from ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = validateTrack(parsed, undefined, 1);
  await mkdir(trackDefinitionsRoot(), { recursive: true });
  return withFileLock(trackDefinitionLockPath(candidate.name), async () => {
    const latest = await loadTrack(candidate.name);
    const version = (latest?.version ?? 0) + 1;
    if (latest) await persistTrackVersionIfMissing(latest);
    const track: Track = { ...candidate, version };
    await mkdir(join(trackDefinitionsRoot(), safeName(track.name), "versions"), { recursive: true });
    await atomicWriteFile(trackDefinitionVersionPath(track.name, version), `${JSON.stringify(track, null, 2)}\n`, { mode: 0o600 });
    await atomicWriteFile(trackDefinitionPath(track.name), `${JSON.stringify(track, null, 2)}\n`, { mode: 0o600 });
    await appendLedger({ type: "track.define", track: track.name, source });
    return track;
  });
}

async function persistTrackVersionIfMissing(track: Track): Promise<void> {
  const path = trackDefinitionVersionPath(track.name, track.version);
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(join(trackDefinitionsRoot(), safeName(track.name), "versions"), { recursive: true });
    await atomicWriteFile(path, `${JSON.stringify(track, null, 2)}\n`, { mode: 0o600 });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function loadTrack(name: string, version?: number): Promise<Track | null> {
  if (!validTrackName(name)) return null;
  if (version !== undefined) validateVersion(version, "Track version");
  const path = version === undefined ? trackDefinitionPath(name) : trackDefinitionVersionPath(name, version);
  try {
    return validateTrack(JSON.parse(await readFile(path, "utf8")), name, version);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (version === undefined) return null;
    // A shipped v1 store has only the latest file. Treat that file as immutable
    // version 1 until the first v2 define writes its snapshot.
    const latest = await loadTrack(name);
    return latest?.version === version ? latest : null;
  }
}

export async function listTracks(): Promise<Track[]> {
  const files = (await readdir(trackDefinitionsRoot()).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const tracks: Track[] = [];
  for (const file of files) {
    const name = file.slice(0, -".json".length);
    const track = await loadTrack(name);
    if (track) tracks.push(track);
  }
  return tracks.sort((left, right) => left.name.localeCompare(right.name));
}

export function flattenTrackNodes(items: TrackItem[]): TrackNode[] {
  // Compatibility/main-spine traversal: branch lanes are part of the spine,
  // review outcome arms are deliberately omitted.
  return items.flatMap((item) => "branch" in item ? item.branch.flatMap((lane) => lane) : [item]);
}

export function flattenTrackStateNodes(items: TrackStateItem[]): TrackNodeState[] {
  // This is also the source for the legacy `steps` projection. Outcome arms are
  // v2-only and therefore never leak into the shipped Apiary card's flat list.
  return items.flatMap((item) => "branch" in item ? item.branch.flatMap((lane) => lane) : [item]);
}

function allTrackStateNodes(items: TrackStateItem[]): TrackNodeState[] {
  const all: TrackNodeState[] = [];
  const add = (node: TrackNodeState) => {
    all.push(node);
    if (node.type !== "review") return;
    node.approved?.forEach(add);
    node.denied?.forEach(add);
  };
  flattenTrackStateNodes(items).forEach(add);
  return all;
}

export function findTrackStateNode(items: TrackStateItem[], id: string): TrackNodeState | undefined {
  return allTrackStateNodes(items).find((node) => node.id === id);
}

export function trackPostscript(track: Track): string {
  const rendered: string[] = [];
  let ordinal = 0;
  for (const item of track.items) {
    if ("branch" in item) {
      rendered.push("BRANCH — parallel lanes (unordered)");
      item.branch.forEach((lane, laneIndex) => {
        const condition = lane[0]?.when ? `; when: ${lane[0].when}` : "";
        rendered.push(`  lane ${laneIndex + 1}${condition}`);
        for (const node of lane) {
          rendered.push(`    ${++ordinal}. ${renderPostscriptNode(node)}`);
          renderReviewArms(rendered, node, "      ");
        }
      });
    } else {
      rendered.push(`${++ordinal}. ${renderPostscriptNode(item)}`);
      renderReviewArms(rendered, item, "  ");
    }
  }
  return [
    "--- TRACK v2 (hive track) ---",
    `Track: ${track.name}@${track.version}${track.description ? ` — ${track.description}` : ""}`,
    ...rendered,
    "Action/orchestrate/ask/deploy nodes and conditions are advisory expectations.",
    "Review packets are REQUIRED expectations, but there is no computational enforcement; proceeding without a verdict is an exception.",
    "Branches are parallel lanes and an unordered set: you may do lanes in any order or interleaved; when on a lane's first node is an advisory condition for skipping the lane.",
    "Interpret when as free text yourself; no machine evaluates it.",
    "Report: hive track step <id> done|skip [--note \"...\"]",
    "Sub-task: hive track subtask <name> queued|running|done",
    "Exception: hive track exception \"<why>\" [--step <id>]",
    "Status: hive track status",
    "Deviation is allowed; record it as an exception.",
  ].join("\n");
}

function renderPostscriptNode(node: TrackNode): string {
  const when = node.when ? ` (when: ${node.when})` : "";
  const note = node.note ? ` Note: ${node.note}` : "";
  switch (node.type) {
    case "action":
      return `[${node.id}] ACTION ${node.name}${when}${node.instruction ? ` — ${node.instruction}` : ""}${note}`;
    case "orchestrate": {
      const agents = node.subAgents ? `; sub-agents: up to ${node.subAgents.max} via ${node.subAgents.harness}` : "";
      const expectation = node.expectation ? `; expectation: ${node.expectation}` : "";
      return `[${node.id}] ORCHESTRATE ${node.name}${when} — ${node.instruction}${agents}${expectation}${note}`;
    }
    case "review":
      return `[${node.id}] REVIEW PACKET ${node.name}${when} — REQUIRED: MUST send with forum packet create; MUST NOT proceed past this node without a verdict. Wait via forum packet show <packet-id> --json. forum packet feedback <packet-id> --verdict approve maps to APPROVED; --verdict request_changes maps to DENIED.${note}`;
    case "ask":
      return `[${node.id}] ASK ${node.name}${when} — ${node.question}; ${
        node.blocking
          ? "stop and wait for the answer before continuing (advisory)"
          : "raise the question and continue while awaiting an answer"
      }.${note}`;
    case "deploy":
      return `[${node.id}] DEPLOY ${node.name}${when} — target: ${renderDeployTarget(node.target)}.${note}`;
  }
}

function renderReviewArms(lines: string[], node: TrackNode, indent: string): void {
  if (node.type !== "review") return;
  if (node.approved === undefined) {
    lines.push(`${indent}APPROVED (default): continue to the next item on the spine.`);
  } else {
    lines.push(`${indent}APPROVED:`);
    renderOutcomeNodes(lines, node.approved, `${indent}  `);
  }
  if (node.denied === undefined) {
    lines.push(`${indent}DENIED (default iterate): fix the issues raised in the verdict and re-request the SAME packet with forum packet rerequest <packet-id>; repeat until approved.`);
  } else {
    lines.push(`${indent}DENIED:`);
    renderOutcomeNodes(lines, node.denied, `${indent}  `);
  }
}

function renderOutcomeNodes(lines: string[], nodes: TrackNode[], indent: string): void {
  nodes.forEach((node) => {
    lines.push(`${indent}- ${renderPostscriptNode(node)}`);
    renderReviewArms(lines, node, `${indent}  `);
  });
}

function renderDeployTarget(target: TrackDeployTarget): string {
  switch (target.kind) {
    case "nectar":
      return `nectar "${target.label}"${target.lane ? ` (lane ${target.lane})` : ""}`;
    case "named":
      return `named "${target.name}"`;
    case "text":
      return target.description;
  }
}

export async function attachTrack(trackName: string, options: AttachTrackOptions): Promise<TrackAttachment> {
  const track = await loadTrack(trackName, options.version);
  if (!track) throw new Error(options.version ? `Unknown track: ${trackName}@${options.version}` : `Unknown track: ${trackName}`);
  const path = trackAttachmentPath(options.bee);
  return withFileLock(trackAttachmentLockPath(options.bee), async () => {
    const existing = await loadTrackAttachment(options.bee);
    if (existing) {
      throw new Error(`Bee ${options.bee} already has active track ${existing.track}; detach it first`);
    }
    const now = (options.now ?? (() => new Date()))().toISOString();
    const attachment = createAttachment(track, {
      bee: options.bee,
      ...(options.beeId ? { beeId: options.beeId } : {}),
      now,
      ...(options.startAt ? { startAt: options.startAt } : {}),
      queue: [],
    });
    await atomicWriteFile(path, `${JSON.stringify(attachment, null, 2)}\n`, { mode: 0o600 });
    try {
      await options.deliver?.(trackPostscript(track), attachment);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    await appendTrackAttachLedger(attachment, now);
    return attachment;
  });
}

function createAttachment(
  track: Track,
  options: { bee: string; beeId?: string; now: string; startAt?: string; queue: TrackQueueEntry[] },
): TrackAttachment {
  const flat = flattenTrackNodes(track.items);
  const startIndex = options.startAt === undefined ? 0 : flat.findIndex((node) => node.id === options.startAt);
  if (options.startAt !== undefined && startIndex < 0) {
    throw new Error(`Track ${track.name}@${track.version} has no step "${options.startAt}"`);
  }
  let flatIndex = 0;
  const items = track.items.map((item): TrackStateItem => {
    if ("branch" in item) {
      return {
        branch: item.branch.map((lane) => lane.map((node) =>
          createNodeState(node, options.now, flatIndex++ < startIndex)
        )),
      };
    }
    return createNodeState(item, options.now, flatIndex++ < startIndex);
  });
  const attachment: TrackAttachment = {
    schemaVersion: TRACK_SCHEMA_VERSION,
    track: track.name,
    version: track.version,
    bee: options.bee,
    ...(options.beeId ? { beeId: options.beeId } : {}),
    attachedAt: options.now,
    updatedAt: options.now,
    items,
    steps: [],
    exceptions: [],
    queue: options.queue,
  };
  attachment.steps = projectLegacySteps(attachment.items);
  return attachment;
}

function createNodeState(node: TrackNode, at: string, preMarked: boolean): TrackNodeState {
  const status = preMarked ? "done" : "pending";
  const runtime: TrackNodeRuntime = {
    status,
    updatedAt: at,
    ...(preMarked ? { startedAt: at, statusNote: "pre-marked at attach" } : {}),
    history: [
      { status: "pending", at },
      ...(preMarked ? [{ status: "done" as const, at, note: "pre-marked at attach" }] : []),
    ],
    subTasks: [],
  };
  if (node.type === "review") {
    const { approved, denied, ...review } = node;
    return {
      ...review,
      ...runtime,
      ...(approved ? { approved: approved.map((armNode) => createNodeState(armNode, at, false)) } : {}),
      ...(denied ? { denied: denied.map((armNode) => createNodeState(armNode, at, false)) } : {}),
    };
  }
  return {
    ...node,
    ...runtime,
  };
}

export async function loadTrackAttachment(bee: string): Promise<TrackAttachment | null> {
  try {
    return validateTrackAttachment(JSON.parse(await readFile(trackAttachmentPath(bee), "utf8")), bee);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function updateTrackStep(
  bee: string,
  stepId: string,
  status: Exclude<TrackStepStatus, "pending">,
  note?: string,
  now: () => Date = () => new Date(),
  lifecycle: Omit<TrackLifecycleOptions, "now"> = {},
): Promise<TrackAttachment> {
  return withFileLock(trackAttachmentLockPath(bee), async () => {
    const attachment = await loadTrackAttachment(bee);
    if (!attachment) throw new Error(`Bee ${bee} has no active track`);
    const node = allTrackStateNodes(attachment.items).find((candidate) => candidate.id === stepId);
    if (!node) throw new Error(`Track ${attachment.track} has no step "${stepId}"`);
    const at = now().toISOString();
    const from = node.status;
    node.status = status;
    node.updatedAt = at;
    node.startedAt ??= at;
    if (note) node.statusNote = note;
    else delete node.statusNote;
    node.history.push({ status, at, ...(note ? { note } : {}) });
    attachment.updatedAt = at;
    syncLegacyProjection(attachment);
    await writeTrackAttachment(attachment);
    await appendLedger({
      type: "track.step",
      track: attachment.track,
      bee: attachment.bee,
      step: stepId,
      from,
      status,
      ...(note ? { note } : {}),
      at,
    });
    if (isTerminal(attachment) && attachment.queue.length > 0) {
      await activateNextQueuedTrack(attachment, at, lifecycle.deliver);
    }
    return attachment;
  });
}

export async function updateTrackSubTask(
  bee: string,
  name: string,
  status: TrackSubTaskStatus,
  options: TrackLifecycleOptions & { stepId?: string } = {},
): Promise<TrackAttachment> {
  if (name.trim().length === 0) throw new Error("Track sub-task name must not be empty");
  if (!TRACK_SUBTASK_STATUSES.includes(status)) throw new Error(`Invalid track sub-task status: ${status}`);
  return withFileLock(trackAttachmentLockPath(bee), async () => {
    const attachment = await loadTrackAttachment(bee);
    if (!attachment) throw new Error(`Bee ${bee} has no active track`);
    const nodes = allTrackStateNodes(attachment.items);
    const node = options.stepId
      ? nodes.find((candidate) => candidate.id === options.stepId)
      : nodes.find((candidate) => candidate.status === "pending" && candidate.type === "orchestrate");
    if (!node) {
      throw new Error(options.stepId
        ? `Track ${attachment.track} has no step "${options.stepId}"`
        : `Track ${attachment.track} has no pending orchestrate step`);
    }
    if (node.type !== "orchestrate") {
      throw new Error(`Track step ${node.id} is ${node.type}, not orchestrate`);
    }
    const at = (options.now ?? (() => new Date()))().toISOString();
    const existing = node.subTasks.find((candidate) => candidate.name === name);
    const from = existing?.status;
    if (existing) existing.status = status;
    else node.subTasks.push({ name, status });
    node.startedAt ??= at;
    node.updatedAt = at;
    attachment.updatedAt = at;
    syncLegacyProjection(attachment);
    await writeTrackAttachment(attachment);
    await appendLedger({
      type: "track.subtask",
      track: attachment.track,
      bee: attachment.bee,
      step: node.id,
      subtask: name,
      ...(from ? { from } : {}),
      status,
      at,
    });
    return attachment;
  });
}

export async function recordTrackException(
  bee: string,
  note: string,
  nowOrOptions: (() => Date) | (TrackLifecycleOptions & { stepId?: string }) = () => new Date(),
): Promise<TrackAttachment> {
  if (note.trim().length === 0) throw new Error("Track exception must not be empty");
  const options = typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
  return withFileLock(trackAttachmentLockPath(bee), async () => {
    const attachment = await loadTrackAttachment(bee);
    if (!attachment) throw new Error(`Bee ${bee} has no active track`);
    if (options.stepId && !allTrackStateNodes(attachment.items).some((node) => node.id === options.stepId)) {
      throw new Error(`Track ${attachment.track} has no step "${options.stepId}"`);
    }
    const at = (options.now ?? (() => new Date()))().toISOString();
    attachment.exceptions.push({ note, at, ...(options.stepId ? { stepId: options.stepId } : {}) });
    attachment.updatedAt = at;
    await writeTrackAttachment(attachment);
    await appendTrackExceptionLedger(attachment, note, at, options.stepId);
    return attachment;
  });
}

export async function queueTrack(
  trackName: string,
  bee: string,
  options: TrackLifecycleOptions & { version?: number; queuedBy: string },
): Promise<TrackAttachment> {
  const track = await loadTrack(trackName, options.version);
  if (!track) throw new Error(options.version ? `Unknown track: ${trackName}@${options.version}` : `Unknown track: ${trackName}`);
  return withFileLock(trackAttachmentLockPath(bee), async () => {
    const attachment = await loadTrackAttachment(bee);
    if (!attachment) throw new Error(`Bee ${bee} has no active track`);
    const at = (options.now ?? (() => new Date()))().toISOString();
    const entry: TrackQueueEntry = {
      track: trackName,
      ...(options.version !== undefined ? { version: options.version } : {}),
      queuedAt: at,
      queuedBy: options.queuedBy,
    };
    attachment.queue.push(entry);
    attachment.updatedAt = at;
    await writeTrackAttachment(attachment);
    await appendLedger({
      type: "track.queue",
      track: trackName,
      ...(options.version !== undefined ? { version: options.version } : {}),
      bee,
      queuedBy: options.queuedBy,
      at,
    });
    return attachment;
  });
}

export async function detachTrack(
  bee: string,
  nowOrOptions: (() => Date) | DetachTrackOptions = () => new Date(),
): Promise<TrackAttachment> {
  const options = typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
  return withFileLock(trackAttachmentLockPath(bee), async () => {
    const attachment = await loadTrackAttachment(bee);
    if (!attachment) throw new Error(`Bee ${bee} has no active track`);
    const at = (options.now ?? (() => new Date()))().toISOString();
    if (options.exception) {
      if (options.stepId && !allTrackStateNodes(attachment.items).some((node) => node.id === options.stepId)) {
        throw new Error(`Track ${attachment.track} has no step "${options.stepId}"`);
      }
      attachment.exceptions.push({
        note: options.exception,
        at,
        ...(options.stepId ? { stepId: options.stepId } : {}),
      });
      attachment.updatedAt = at;
      await writeTrackAttachment(attachment);
      await appendTrackExceptionLedger(attachment, options.exception, at, options.stepId);
    }
    if (attachment.exceptions.length > 0 && attachment.queue.length > 0) {
      await activateNextQueuedTrack(attachment, at, options.deliver);
      return attachment;
    }
    await rm(trackAttachmentPath(bee), { force: true });
    await appendTrackDetachLedger(attachment, at);
    return attachment;
  });
}

async function activateNextQueuedTrack(
  current: TrackAttachment,
  at: string,
  deliver?: TrackDelivery,
): Promise<TrackAttachment> {
  const [entry, ...queue] = current.queue;
  if (!entry) return current;
  const track = await loadTrack(entry.track, entry.version);
  if (!track) {
    throw new Error(entry.version
      ? `Queued track no longer exists: ${entry.track}@${entry.version}`
      : `Queued track no longer exists: ${entry.track}`);
  }
  const next = createAttachment(track, {
    bee: current.bee,
    ...(current.beeId ? { beeId: current.beeId } : {}),
    now: at,
    queue,
  });
  await writeTrackAttachment(next);
  try {
    await deliver?.(trackPostscript(track), next);
  } catch (error) {
    // The completion/detach remains real, but queue advancement did not. Restore
    // that completed attachment and its FIFO so a later retry cannot lose work.
    await writeTrackAttachment(current);
    throw error;
  }
  await appendTrackDetachLedger(current, at, "queue-advance");
  await appendTrackAttachLedger(next, at);
  return next;
}

function isTerminal(attachment: TrackAttachment): boolean {
  return flattenTrackStateNodes(attachment.items).every((node) => node.status !== "pending");
}

async function appendTrackAttachLedger(attachment: TrackAttachment, at: string): Promise<void> {
  await appendLedger({
    type: "track.attach",
    track: attachment.track,
    bee: attachment.bee,
    beeId: attachment.beeId,
    at,
  });
}

async function appendTrackDetachLedger(attachment: TrackAttachment, at: string, _reason?: string): Promise<void> {
  await appendLedger({
    type: "track.detach",
    track: attachment.track,
    bee: attachment.bee,
    at,
  });
}

async function appendTrackExceptionLedger(
  attachment: TrackAttachment,
  note: string,
  at: string,
  stepId?: string,
): Promise<void> {
  await appendLedger({
    type: "track.exception",
    track: attachment.track,
    bee: attachment.bee,
    note,
    ...(stepId ? { step: stepId } : {}),
    at,
  });
}

async function writeTrackAttachment(attachment: TrackAttachment): Promise<void> {
  syncLegacyProjection(attachment);
  await atomicWriteFile(trackAttachmentPath(attachment.bee), `${JSON.stringify(attachment, null, 2)}\n`, { mode: 0o600 });
}

function syncLegacyProjection(attachment: TrackAttachment): void {
  attachment.schemaVersion = TRACK_SCHEMA_VERSION;
  attachment.steps = projectLegacySteps(attachment.items);
}

function projectLegacySteps(items: TrackStateItem[]): TrackStepState[] {
  return flattenTrackStateNodes(items).map((node) => ({
    id: node.id,
    title: node.name,
    ...(legacyDescription(node) ? { description: legacyDescription(node) } : {}),
    status: node.status,
    updatedAt: node.updatedAt,
    ...(node.startedAt ? { startedAt: node.startedAt } : {}),
    ...(node.statusNote ? { note: node.statusNote } : {}),
    history: node.history,
    ...(node.subTasks.length > 0 ? { subTasks: node.subTasks } : {}),
  }));
}

function legacyDescription(node: TrackNode): string | undefined {
  switch (node.type) {
    case "action":
    case "orchestrate":
      return node.instruction;
    case "ask":
      return node.question;
    case "review":
      return undefined;
    case "deploy":
      return renderDeployTarget(node.target);
  }
}

function validateTrackAttachment(value: unknown, expectedBee: string): TrackAttachment {
  const object = objectAt(value, `Invalid track attachment for ${expectedBee}: expected an object`);
  for (const key of ["track", "bee", "attachedAt", "updatedAt"] as const) {
    if (typeof object[key] !== "string") {
      throw new Error(`Invalid track attachment for ${expectedBee}: missing string ${key}`);
    }
  }
  if (object.bee !== expectedBee) {
    throw new Error(`Track attachment bee mismatch: file declares "${String(object.bee)}", expected "${expectedBee}"`);
  }
  if (!Array.isArray(object.exceptions)) {
    throw new Error(`Invalid track attachment for ${expectedBee}: exceptions must be an array`);
  }

  let items: TrackStateItem[];
  if (Array.isArray(object.items)) {
    if (object.items.length === 0) throw new Error(`Invalid track attachment for ${expectedBee}: items must be non-empty`);
    const ids = new NodeIdAllocator(object.items, String(object.track));
    items = object.items.map((item, index) => validateTrackStateItem(item, index, expectedBee, String(object.track), ids));
  } else if (Array.isArray(object.steps)) {
    // Existing active v1 attachments remain usable without rewriting them first.
    const ids = new NodeIdAllocator(object.steps, String(object.track));
    items = object.steps.map((step, index) => migrateLegacyStepState(step, index, expectedBee, String(object.track), ids));
  } else {
    throw new Error(`Invalid track attachment for ${expectedBee}: items or steps must be an array`);
  }

  const attachment: TrackAttachment = {
    schemaVersion: TRACK_SCHEMA_VERSION,
    track: object.track as string,
    version: validateVersion(object.version, `Invalid track attachment version for ${expectedBee}`, 1),
    bee: object.bee as string,
    ...(typeof object.beeId === "string" ? { beeId: object.beeId } : {}),
    attachedAt: object.attachedAt as string,
    updatedAt: object.updatedAt as string,
    items,
    steps: [],
    exceptions: object.exceptions.map((entry, index) => validateTrackException(entry, index, expectedBee)),
    queue: Array.isArray(object.queue)
      ? object.queue.map((entry, index) => validateTrackQueueEntry(entry, index, expectedBee))
      : [],
  };
  syncLegacyProjection(attachment);
  return attachment;
}

function validateTrackStateItem(
  value: unknown,
  index: number,
  bee: string,
  trackName: string,
  ids: NodeIdAllocator,
): TrackStateItem {
  const object = objectAt(value, `Invalid track attachment item #${index + 1} for ${bee}`);
  if (Array.isArray(object.branch)) {
    if (object.branch.length === 0) throw new Error(`Invalid track attachment branch #${index + 1} for ${bee}`);
    return {
      branch: object.branch.map((lane, laneIndex) => {
        if (!Array.isArray(lane) || lane.length === 0) {
          throw new Error(`Invalid track attachment lane #${laneIndex + 1} for ${bee}`);
        }
        return lane.map((node, nodeIndex) =>
          validateTrackNodeState(node, `${index + 1}.${laneIndex + 1}.${nodeIndex + 1}`, bee, trackName, ids)
        );
      }),
    };
  }
  return validateTrackNodeState(object, String(index + 1), bee, trackName, ids);
}

function validateTrackNodeState(
  value: unknown,
  location: string,
  bee: string,
  trackName: string,
  ids: NodeIdAllocator,
): TrackNodeState {
  const object = objectAt(value, `Invalid track attachment node ${location} for ${bee}`);
  const node = validateTrackNode(object, `attachment node ${location}`, trackName, ids);
  const runtime = validateRuntimeState(object, `track node ${node.id}`, bee);
  if (node.type === "review") {
    const { approved: _approved, denied: _denied, ...review } = node;
    const approved = Array.isArray(object.approved)
      ? object.approved.map((armNode, index) =>
          validateTrackNodeState(armNode, `${location}.approved.${index + 1}`, bee, trackName, ids)
        )
      : undefined;
    const denied = Array.isArray(object.denied)
      ? object.denied.map((armNode, index) =>
          validateTrackNodeState(armNode, `${location}.denied.${index + 1}`, bee, trackName, ids)
        )
      : undefined;
    return {
      ...review,
      ...runtime,
      ...(approved ? { approved } : {}),
      ...(denied ? { denied } : {}),
    };
  }
  return {
    ...node,
    ...runtime,
  };
}

function migrateLegacyStepState(
  value: unknown,
  index: number,
  bee: string,
  trackName: string,
  ids: NodeIdAllocator,
): TrackNodeState {
  const object = objectAt(value, `Invalid track attachment step #${index + 1} for ${bee}`);
  const id = ids.take(object.id, `attachment step #${index + 1}`);
  if (typeof object.title !== "string") throw new Error(`Invalid track attachment step #${index + 1} for ${bee}`);
  return {
    type: "action",
    id,
    name: object.title,
    ...(typeof object.description === "string" ? { instruction: object.description } : {}),
    ...validateRuntimeState(object, `track step ${id}`, bee, true),
  };
}

function validateRuntimeState(
  object: Record<string, unknown>,
  label: string,
  bee: string,
  legacy = false,
): TrackNodeRuntime {
  if (
    !TRACK_STEP_STATUSES.includes(object.status as TrackStepStatus) ||
    typeof object.updatedAt !== "string" ||
    !Array.isArray(object.history)
  ) {
    throw new Error(`Invalid ${label} for ${bee}`);
  }
  const history = object.history.map((entry, historyIndex) => {
    const raw = objectAt(entry, `Invalid history #${historyIndex + 1} for ${label}`);
    if (!TRACK_STEP_STATUSES.includes(raw.status as TrackStepStatus) || typeof raw.at !== "string") {
      throw new Error(`Invalid history #${historyIndex + 1} for ${label}`);
    }
    return {
      status: raw.status as TrackStepStatus,
      at: raw.at,
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    };
  });
  const rawSubTasks = Array.isArray(object.subTasks) ? object.subTasks : [];
  return {
    status: object.status as TrackStepStatus,
    updatedAt: object.updatedAt,
    ...(typeof object.startedAt === "string" ? { startedAt: object.startedAt } : {}),
    ...(typeof object.statusNote === "string"
      ? { statusNote: object.statusNote }
      : legacy && typeof object.note === "string"
        ? { statusNote: object.note }
        : {}),
    history,
    subTasks: rawSubTasks.map((entry, index) => validateTrackSubTask(entry, index, label)),
  };
}

function validateTrackSubTask(value: unknown, index: number, label: string): TrackSubTask {
  const object = objectAt(value, `Invalid sub-task #${index + 1} for ${label}`);
  if (typeof object.name !== "string" || !TRACK_SUBTASK_STATUSES.includes(object.status as TrackSubTaskStatus)) {
    throw new Error(`Invalid sub-task #${index + 1} for ${label}`);
  }
  return { name: object.name, status: object.status as TrackSubTaskStatus };
}

function validateTrackException(value: unknown, index: number, bee: string): TrackException {
  const object = objectAt(value, `Invalid track exception #${index + 1} for ${bee}`);
  if (typeof object.note !== "string" || typeof object.at !== "string") {
    throw new Error(`Invalid track exception #${index + 1} for ${bee}`);
  }
  return {
    note: object.note,
    at: object.at,
    ...(typeof object.stepId === "string" ? { stepId: object.stepId } : {}),
  };
}

function validateTrackQueueEntry(value: unknown, index: number, bee: string): TrackQueueEntry {
  const object = objectAt(value, `Invalid track queue entry #${index + 1} for ${bee}`);
  if (
    typeof object.track !== "string" ||
    !validTrackName(object.track) ||
    typeof object.queuedAt !== "string" ||
    typeof object.queuedBy !== "string"
  ) {
    throw new Error(`Invalid track queue entry #${index + 1} for ${bee}`);
  }
  return {
    track: object.track,
    ...(object.version !== undefined
      ? { version: validateVersion(object.version, `Invalid queue version #${index + 1} for ${bee}`) }
      : {}),
    queuedAt: object.queuedAt,
    queuedBy: object.queuedBy,
  };
}
