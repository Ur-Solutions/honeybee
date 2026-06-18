/**
 * Loop templates — saved presets for `hive loop` (the ⌘⇧L launcher).
 *
 * A template captures a reusable loop: the prompt PLUS the loop config (context
 * type, bee, stop conditions). The repo (cwd) and loopId are NOT stored — they
 * are chosen per launch. CRUD mirrors src/workspace.ts / src/frame.ts exactly:
 * validate-before-path-join, embedded-name-must-match-stem, one lock per
 * mutation, a defensive reader that drops malformed fields.
 */
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger } from "./store.js";

export type LoopTemplate = {
  name: string; // LT_NAME_RE: /^[A-Za-z0-9][A-Za-z0-9_-]*$/
  /** The instruction sent each iteration. */
  prompt: string;
  /** Agent shorthand (claude, codex-auto, claude-<account>); blank ⇒ ask at launch. */
  bee?: string;
  /** Context mode: persistent | ralph | rolling. */
  context?: string;
  until?: string;
  max?: string;
  maxDuration?: string;
  forever?: boolean;
  stopOnSeal?: string;
  stopOnSentinel?: string;
  judge?: string;
  summarizer?: string;
  yolo?: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

const LT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validLoopTemplateName(name: string): boolean {
  return LT_NAME_RE.test(name);
}

/** The loop-config fields a template carries (everything except cwd/loopId). */
const STRING_FIELDS = ["prompt", "bee", "context", "until", "max", "maxDuration", "stopOnSeal", "stopOnSentinel", "judge", "summarizer", "description"] as const;
const BOOL_FIELDS = ["forever", "yolo"] as const;

export async function listLoopTemplates(): Promise<LoopTemplate[]> {
  await ensureDir();
  const files = await readdir(loopTemplatesDir()).catch(() => []);
  const records: LoopTemplate[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const record = await readLoopTemplate(join(loopTemplatesDir(), file)).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadLoopTemplate(name: string): Promise<LoopTemplate | null> {
  if (!validLoopTemplateName(name)) return null;
  try {
    return await readLoopTemplate(loopTemplatePath(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export type LoopTemplateInput = Omit<LoopTemplate, "createdAt" | "updatedAt">;

/** Create or overwrite a template (save-as semantics — templates are presets). */
export async function saveLoopTemplate(input: LoopTemplateInput): Promise<LoopTemplate> {
  if (!validLoopTemplateName(input.name)) {
    throw new Error(`Invalid loop template name: ${input.name}. Use alphanumerics, dashes, and underscores.`);
  }
  if (!input.prompt || input.prompt.trim().length === 0) {
    throw new Error("A loop template needs a prompt.");
  }
  return withLock(async () => {
    const existing = await loadLoopTemplate(input.name);
    const now = new Date().toISOString();
    const record: LoopTemplate = { ...sanitize(input), createdAt: existing?.createdAt ?? now, updatedAt: now };
    await save(record);
    await appendLedger({ type: existing ? "loop.template.update" : "loop.template.create", name: record.name });
    return record;
  });
}

export async function removeLoopTemplate(name: string): Promise<boolean> {
  if (!validLoopTemplateName(name)) return false;
  return withLock(async () => {
    const existing = await loadLoopTemplate(name);
    if (!existing) return false;
    await rm(loopTemplatePath(name), { force: true });
    await appendLedger({ type: "loop.template.remove", name });
    return true;
  });
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureDir();
  return withFileLock(join(loopTemplatesDir(), ".loop-templates.lock"), fn);
}

async function save(record: LoopTemplate): Promise<void> {
  await ensureDir();
  await atomicWriteFile(loopTemplatePath(record.name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Keep only well-formed fields (the defensive-reader discipline). */
function sanitize(input: LoopTemplateInput): LoopTemplateInput {
  const out: LoopTemplateInput = { name: input.name, prompt: String(input.prompt) };
  for (const key of STRING_FIELDS) {
    if (key === "prompt") continue;
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) (out as Record<string, unknown>)[key] = value;
  }
  for (const key of BOOL_FIELDS) {
    if ((input as Record<string, unknown>)[key] === true) (out as Record<string, unknown>)[key] = true;
  }
  return out;
}

async function readLoopTemplate(path: string): Promise<LoopTemplate> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid loop template at ${path}`);
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.name !== "string" || typeof object.prompt !== "string" || typeof object.createdAt !== "string") {
    throw new Error(`Invalid loop template at ${path}: missing name/prompt/createdAt`);
  }
  const stem = basename(path).replace(/\.json$/, "");
  if (object.name !== stem) {
    throw new Error(`Invalid loop template at ${path}: name ${object.name} does not match file name`);
  }
  const record: LoopTemplate = {
    name: object.name,
    prompt: object.prompt,
    createdAt: object.createdAt,
    updatedAt: typeof object.updatedAt === "string" ? object.updatedAt : object.createdAt,
  };
  for (const key of STRING_FIELDS) {
    if (key === "prompt") continue;
    if (typeof object[key] === "string") (record as Record<string, unknown>)[key] = object[key];
  }
  for (const key of BOOL_FIELDS) {
    if (object[key] === true) (record as Record<string, unknown>)[key] = true;
  }
  return record;
}

async function ensureDir(): Promise<void> {
  await mkdir(loopTemplatesDir(), { recursive: true });
}

export function loopTemplatesDir(): string {
  return join(storeRoot(), "loop-templates");
}

export function loopTemplatePath(name: string): string {
  return join(loopTemplatesDir(), `${name}.json`);
}
