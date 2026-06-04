import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { appendLedger } from "./store.js";
import { loadTsModule as loadTs } from "./tsLoader.js";

export type Caste = {
  name: string;
  bee: string;
  count: number;
  brief?: string;
  home?: string;
};

export type Frame = {
  name: string;
  description?: string;
  castes: Caste[];
};

const FRAME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CASTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function validFrameName(name: string): boolean {
  return FRAME_NAME_RE.test(name);
}

export async function listFrames(): Promise<Frame[]> {
  await ensureDir();
  const files = await readdir(framesDir()).catch(() => []);
  const seen = new Set<string>();
  const frames: Frame[] = [];
  for (const file of files) {
    const ext = extname(file);
    if (ext !== ".json" && ext !== ".ts") continue;
    const name = file.slice(0, -ext.length);
    if (seen.has(name)) continue;
    seen.add(name);
    const frame = await loadFrame(name).catch(() => null);
    if (frame) frames.push(frame);
  }
  return frames.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadFrame(name: string): Promise<Frame | null> {
  const tsPath = frameFilePath(name, ".ts");
  if (await pathExists(tsPath)) return validateFrame(await loadTsModule(tsPath), name);
  const jsonPath = frameFilePath(name, ".json");
  if (await pathExists(jsonPath)) return validateFrame(JSON.parse(await readFile(jsonPath, "utf8")), name);
  return null;
}

export async function frameExists(name: string): Promise<boolean> {
  return (await loadFrame(name)) !== null;
}

export async function writeFrameFromObject(frame: Frame): Promise<Frame> {
  const validated = validateFrame(frame);
  await ensureDir();
  const target = frameFilePath(validated.name, ".json");
  await atomicWriteFile(target, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  return validated;
}

export async function defineFrameFromFile(sourcePath: string, nameOverride?: string): Promise<Frame> {
  const absolute = resolve(sourcePath);
  if (!(await pathExists(absolute))) throw new Error(`Source file not found: ${sourcePath}`);
  const rawExt = extname(absolute);
  if (rawExt !== ".json" && rawExt !== ".ts") throw new Error(`Unsupported frame source extension ${rawExt}. Use .json or .ts.`);
  const ext: ".json" | ".ts" = rawExt;

  const loaded = ext === ".ts" ? await loadTsModule(absolute) : JSON.parse(await readFile(absolute, "utf8"));
  const draft = validateFrame(loaded);
  const finalName = nameOverride ?? draft.name;
  if (!validFrameName(finalName)) throw new Error(`Invalid frame name: ${finalName}`);
  const frame: Frame = { ...draft, name: finalName };

  await ensureDir();
  const target = frameFilePath(finalName, ext);
  await copyFile(absolute, target);
  // For TS frames there is no normalization step; for JSON we rewrite with the canonical name.
  if (ext === ".json") await atomicWriteFile(target, `${JSON.stringify(frame, null, 2)}\n`, { mode: 0o600 });
  await atomicWriteFile(frameSourcePath(finalName), `${absolute}\n`, { mode: 0o600 });
  await appendLedger({ type: "frame.define", name: finalName, source: absolute });
  return frame;
}

export async function loadFrameSource(name: string): Promise<string | null> {
  try {
    const raw = await readFile(frameSourcePath(name), "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removeFrame(name: string): Promise<boolean> {
  let removed = false;
  for (const ext of [".ts", ".json"] as const) {
    const path = frameFilePath(name, ext);
    if (await pathExists(path)) {
      await rm(path, { force: true });
      removed = true;
    }
  }
  await rm(frameSourcePath(name), { force: true });
  if (removed) await appendLedger({ type: "frame.remove", name });
  return removed;
}

export function validateFrame(value: unknown, expectedName?: string): Frame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid frame: expected an object");
  }
  const object = value as Record<string, unknown>;
  const name = object.name;
  if (typeof name !== "string" || !validFrameName(name)) {
    throw new Error(`Invalid frame: missing or invalid name${expectedName ? ` (file declares ${name}, expected ${expectedName})` : ""}`);
  }
  if (expectedName && name !== expectedName) {
    throw new Error(`Frame name mismatch: file declares "${name}", expected "${expectedName}"`);
  }
  const castes = object.castes;
  if (!Array.isArray(castes) || castes.length === 0) {
    throw new Error(`Invalid frame ${name}: castes must be a non-empty array`);
  }
  const validatedCastes: Caste[] = castes.map((entry, index) => validateCaste(entry, index, name));
  const frame: Frame = { name, castes: validatedCastes };
  if (typeof object.description === "string") frame.description = object.description;
  return frame;
}

function validateCaste(value: unknown, index: number, frameName: string): Caste {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid caste #${index} in frame ${frameName}: expected an object`);
  }
  const object = value as Record<string, unknown>;
  const name = object.name;
  if (typeof name !== "string" || !CASTE_NAME_RE.test(name)) {
    throw new Error(`Invalid caste #${index} in frame ${frameName}: bad name`);
  }
  const bee = object.bee;
  if (typeof bee !== "string" || bee.length === 0) {
    throw new Error(`Invalid caste ${name} in frame ${frameName}: bee must be a non-empty string`);
  }
  const count = object.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid caste ${name} in frame ${frameName}: count must be a positive integer`);
  }
  const caste: Caste = { name, bee, count };
  if (typeof object.brief === "string") caste.brief = object.brief;
  if (object.home !== undefined) {
    if (typeof object.home !== "string" || object.home.length === 0) {
      throw new Error(`Invalid caste ${name} in frame ${frameName}: home must be a non-empty string`);
    }
    caste.home = object.home;
  }
  return caste;
}

async function loadTsModule(path: string): Promise<unknown> {
  return loadTs(path, { kind: "frame" });
}

async function pathExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function ensureDir(): Promise<void> {
  await mkdir(framesDir(), { recursive: true });
}

function framesDir(): string {
  return join(storeRoot(), "frames");
}

function frameFilePath(name: string, extension: ".json" | ".ts"): string {
  return join(framesDir(), `${name}${extension}`);
}

function frameSourcePath(name: string): string {
  return join(framesDir(), `${name}.source`);
}
