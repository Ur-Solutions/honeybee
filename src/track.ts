import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger, safeName } from "./store.js";

export const TRACK_STEP_STATUSES = ["pending", "done", "skipped"] as const;

export type TrackStepStatus = (typeof TRACK_STEP_STATUSES)[number];

export type TrackStep = {
  id: string;
  title: string;
  description?: string;
};

export type Track = {
  name: string;
  description?: string;
  steps: TrackStep[];
};

export type TrackStepChange = {
  status: TrackStepStatus;
  at: string;
  note?: string;
};

export type TrackStepState = TrackStep & {
  status: TrackStepStatus;
  updatedAt: string;
  note?: string;
  history: TrackStepChange[];
};

export type TrackException = {
  note: string;
  at: string;
};

export type TrackAttachment = {
  track: string;
  bee: string;
  beeId?: string;
  attachedAt: string;
  updatedAt: string;
  steps: TrackStepState[];
  exceptions: TrackException[];
};

export type AttachTrackOptions = {
  bee: string;
  beeId?: string;
  now?: () => Date;
  deliver?: (postscript: string, attachment: TrackAttachment) => Promise<void>;
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

export function trackDefinitionPath(name: string): string {
  return join(trackDefinitionsRoot(), `${safeName(name)}.json`);
}

export function trackAttachmentPath(bee: string): string {
  return join(trackAttachmentsRoot(), `${safeName(bee)}.json`);
}

function trackAttachmentLockPath(bee: string): string {
  return join(trackAttachmentsRoot(), `${safeName(bee)}.lock`);
}

export function validTrackName(name: string): boolean {
  return TRACK_NAME_RE.test(name);
}

export function validateTrack(value: unknown, expectedName?: string): Track {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid track: expected an object");
  }
  const object = value as Record<string, unknown>;
  const name = object.name;
  if (typeof name !== "string" || !validTrackName(name)) {
    throw new Error("Invalid track: name must contain only letters, numbers, dots, dashes, and underscores");
  }
  if (expectedName !== undefined && name !== expectedName) {
    throw new Error(`Track name mismatch: file declares "${name}", expected "${expectedName}"`);
  }
  if (!Array.isArray(object.steps) || object.steps.length === 0) {
    throw new Error(`Invalid track ${name}: steps must be a non-empty array`);
  }

  const seen = new Set<string>();
  const steps = object.steps.map((entry, index) => {
    const step = validateTrackStep(entry, index, name);
    if (seen.has(step.id)) throw new Error(`Invalid track ${name}: duplicate step id "${step.id}"`);
    seen.add(step.id);
    return step;
  });
  return {
    name,
    ...(typeof object.description === "string" ? { description: object.description } : {}),
    steps,
  };
}

function validateTrackStep(value: unknown, index: number, trackName: string): TrackStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid step #${index + 1} in track ${trackName}: expected an object`);
  }
  const object = value as Record<string, unknown>;
  if (typeof object.id !== "string" || !TRACK_STEP_ID_RE.test(object.id)) {
    throw new Error(`Invalid step #${index + 1} in track ${trackName}: id must be command-safe`);
  }
  if (typeof object.title !== "string" || object.title.trim().length === 0) {
    throw new Error(`Invalid step ${object.id} in track ${trackName}: title must be a non-empty string`);
  }
  return {
    id: object.id,
    title: object.title,
    ...(typeof object.description === "string" ? { description: object.description } : {}),
  };
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
  const track = validateTrack(parsed);
  await mkdir(trackDefinitionsRoot(), { recursive: true });
  await atomicWriteFile(trackDefinitionPath(track.name), `${JSON.stringify(track, null, 2)}\n`, { mode: 0o600 });
  await appendLedger({ type: "track.define", track: track.name, source });
  return track;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function loadTrack(name: string): Promise<Track | null> {
  if (!validTrackName(name)) return null;
  try {
    return validateTrack(JSON.parse(await readFile(trackDefinitionPath(name), "utf8")), name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
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

export function trackPostscript(track: Track): string {
  const steps = track.steps.flatMap((step, index) => [
    `${index + 1}. [${step.id}] ${step.title}`,
    ...(step.description ? [`   ${step.description}`] : []),
  ]);
  return [
    "--- TRACK (hive track) ---",
    `Track: ${track.name}${track.description ? ` — ${track.description}` : ""}`,
    "Expected steps:",
    ...steps,
    "",
    "Keep this standing track updated as you work:",
    '  hive track step <id> done|skip [--note "..."]',
    '  hive track exception "<why>"',
    "  hive track status",
    "Deviating is allowed but must be recorded as an exception.",
  ].join("\n");
}

export async function attachTrack(trackName: string, options: AttachTrackOptions): Promise<TrackAttachment> {
  const track = await loadTrack(trackName);
  if (!track) throw new Error(`Unknown track: ${trackName}`);
  const path = trackAttachmentPath(options.bee);
  return withFileLock(trackAttachmentLockPath(options.bee), async () => {
    const existing = await loadTrackAttachment(options.bee);
    if (existing) {
      throw new Error(`Bee ${options.bee} already has active track ${existing.track}; detach it first`);
    }
    const now = (options.now ?? (() => new Date()))().toISOString();
    const attachment: TrackAttachment = {
      track: track.name,
      bee: options.bee,
      ...(options.beeId ? { beeId: options.beeId } : {}),
      attachedAt: now,
      updatedAt: now,
      steps: track.steps.map((step) => ({
        ...step,
        status: "pending",
        updatedAt: now,
        history: [{ status: "pending", at: now }],
      })),
      exceptions: [],
    };
    await atomicWriteFile(path, `${JSON.stringify(attachment, null, 2)}\n`, { mode: 0o600 });
    try {
      await options.deliver?.(trackPostscript(track), attachment);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    await appendLedger({ type: "track.attach", track: track.name, bee: options.bee, beeId: options.beeId, at: now });
    return attachment;
  });
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
): Promise<TrackAttachment> {
  return withFileLock(trackAttachmentLockPath(bee), async () => {
    const attachment = await loadTrackAttachment(bee);
    if (!attachment) throw new Error(`Bee ${bee} has no active track`);
    const index = attachment.steps.findIndex((step) => step.id === stepId);
    if (index < 0) throw new Error(`Track ${attachment.track} has no step "${stepId}"`);
    const at = now().toISOString();
    const current = attachment.steps[index]!;
    const change: TrackStepChange = { status, at, ...(note ? { note } : {}) };
    attachment.steps[index] = {
      id: current.id,
      title: current.title,
      ...(current.description ? { description: current.description } : {}),
      status,
      updatedAt: at,
      ...(note ? { note } : {}),
      history: [...current.history, change],
    };
    attachment.updatedAt = at;
    await writeTrackAttachment(attachment);
    await appendLedger({
      type: "track.step",
      track: attachment.track,
      bee: attachment.bee,
      step: stepId,
      from: current.status,
      status,
      ...(note ? { note } : {}),
      at,
    });
    return attachment;
  });
}

export async function recordTrackException(
  bee: string,
  note: string,
  now: () => Date = () => new Date(),
): Promise<TrackAttachment> {
  if (note.trim().length === 0) throw new Error("Track exception must not be empty");
  return withFileLock(trackAttachmentLockPath(bee), async () => {
    const attachment = await loadTrackAttachment(bee);
    if (!attachment) throw new Error(`Bee ${bee} has no active track`);
    const at = now().toISOString();
    attachment.exceptions.push({ note, at });
    attachment.updatedAt = at;
    await writeTrackAttachment(attachment);
    await appendLedger({ type: "track.exception", track: attachment.track, bee: attachment.bee, note, at });
    return attachment;
  });
}

export async function detachTrack(bee: string, now: () => Date = () => new Date()): Promise<TrackAttachment> {
  return withFileLock(trackAttachmentLockPath(bee), async () => {
    const attachment = await loadTrackAttachment(bee);
    if (!attachment) throw new Error(`Bee ${bee} has no active track`);
    await rm(trackAttachmentPath(bee), { force: true });
    await appendLedger({
      type: "track.detach",
      track: attachment.track,
      bee: attachment.bee,
      at: now().toISOString(),
    });
    return attachment;
  });
}

async function writeTrackAttachment(attachment: TrackAttachment): Promise<void> {
  await atomicWriteFile(trackAttachmentPath(attachment.bee), `${JSON.stringify(attachment, null, 2)}\n`, { mode: 0o600 });
}

function validateTrackAttachment(value: unknown, expectedBee: string): TrackAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid track attachment for ${expectedBee}: expected an object`);
  }
  const object = value as Record<string, unknown>;
  for (const key of ["track", "bee", "attachedAt", "updatedAt"] as const) {
    if (typeof object[key] !== "string") {
      throw new Error(`Invalid track attachment for ${expectedBee}: missing string ${key}`);
    }
  }
  if (object.bee !== expectedBee) {
    throw new Error(`Track attachment bee mismatch: file declares "${String(object.bee)}", expected "${expectedBee}"`);
  }
  if (!Array.isArray(object.steps) || !Array.isArray(object.exceptions)) {
    throw new Error(`Invalid track attachment for ${expectedBee}: steps and exceptions must be arrays`);
  }
  const steps = object.steps.map((step, index) => validateTrackStepState(step, index, expectedBee));
  const exceptions = object.exceptions.map((entry, index) => validateTrackException(entry, index, expectedBee));
  return {
    track: object.track as string,
    bee: object.bee as string,
    ...(typeof object.beeId === "string" ? { beeId: object.beeId } : {}),
    attachedAt: object.attachedAt as string,
    updatedAt: object.updatedAt as string,
    steps,
    exceptions,
  };
}

function validateTrackStepState(value: unknown, index: number, bee: string): TrackStepState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid track attachment step #${index + 1} for ${bee}`);
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.id !== "string" ||
    typeof object.title !== "string" ||
    !TRACK_STEP_STATUSES.includes(object.status as TrackStepStatus) ||
    typeof object.updatedAt !== "string" ||
    !Array.isArray(object.history)
  ) {
    throw new Error(`Invalid track attachment step #${index + 1} for ${bee}`);
  }
  const history = object.history.map((entry, historyIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid history #${historyIndex + 1} for track step ${object.id}`);
    }
    const raw = entry as Record<string, unknown>;
    if (!TRACK_STEP_STATUSES.includes(raw.status as TrackStepStatus) || typeof raw.at !== "string") {
      throw new Error(`Invalid history #${historyIndex + 1} for track step ${object.id}`);
    }
    return {
      status: raw.status as TrackStepStatus,
      at: raw.at,
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    };
  });
  return {
    id: object.id,
    title: object.title,
    ...(typeof object.description === "string" ? { description: object.description } : {}),
    status: object.status as TrackStepStatus,
    updatedAt: object.updatedAt,
    ...(typeof object.note === "string" ? { note: object.note } : {}),
    history,
  };
}

function validateTrackException(value: unknown, index: number, bee: string): TrackException {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid track exception #${index + 1} for ${bee}`);
  }
  const object = value as Record<string, unknown>;
  if (typeof object.note !== "string" || typeof object.at !== "string") {
    throw new Error(`Invalid track exception #${index + 1} for ${bee}`);
  }
  return { note: object.note, at: object.at };
}
