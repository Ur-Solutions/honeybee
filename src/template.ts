/**
 * Agent templates — named presets for spawning one bee with a canned prompt.
 *
 * The store follows loop-template's defensive read/write discipline and
 * frame's JSON/TypeScript import + remembered-source behavior. Mutations are
 * serialized through one templates lock and every stored record is canonical:
 * unknown/malformed fields are dropped and timestamps are owned by hive.
 */
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger } from "./store.js";
import { loadTsModule as loadTs } from "./tsLoader.js";

export type AgentTemplate = {
  name: string;
  description?: string;
  bee: string;
  prompt: string;
  cwd: "caller" | string;
  args?: string[];
  account?: string;
  env?: Record<string, string>;
  yolo?: boolean;
  preamble?: string | false;
  createdAt: string;
  updatedAt: string;
};

export type AgentTemplateInput =
  & Omit<AgentTemplate, "createdAt" | "updatedAt" | "cwd">
  & { cwd?: AgentTemplate["cwd"] };
type ValidatedTemplate = Omit<AgentTemplate, "createdAt" | "updatedAt">;

const TEMPLATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validTemplateName(name: string): boolean {
  return TEMPLATE_NAME_RE.test(name);
}

export async function listTemplates(): Promise<AgentTemplate[]> {
  await ensureDir();
  const files = await readdir(templatesDir()).catch(() => []);
  const names = new Set<string>();
  for (const file of files) {
    const ext = extname(file);
    if (ext !== ".json" && ext !== ".ts") continue;
    names.add(file.slice(0, -ext.length));
  }
  const records: AgentTemplate[] = [];
  for (const name of names) {
    const record = await loadTemplate(name).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadTemplate(name: string): Promise<AgentTemplate | null> {
  if (!validTemplateName(name)) return null;
  const definition = await templateDefinitionFile(name);
  if (!definition) return null;
  return readStoredTemplate(definition.path, name, definition.ext);
}

export async function templateExists(name: string): Promise<boolean> {
  return (await loadTemplate(name)) !== null;
}

export async function templateDefinitionFile(
  name: string,
): Promise<{ path: string; ext: ".json" | ".ts" } | null> {
  if (!validTemplateName(name)) return null;
  // TypeScript wins, matching frames.
  for (const ext of [".ts", ".json"] as const) {
    const path = templateFilePath(name, ext);
    if (await pathExists(path)) return { path, ext };
  }
  return null;
}

/**
 * Save a programmatically-created template as canonical JSON. Existing
 * createdAt is preserved; define/update ledger choice follows existence.
 */
export async function saveTemplate(input: AgentTemplateInput): Promise<AgentTemplate> {
  const draft = validateTemplate(input);
  return withTemplatesLock(async () => {
    const existing = await loadTemplate(draft.name);
    const record = timestamped(draft, existing);
    await writeStoredTemplate(record, ".json");
    await rm(templateFilePath(record.name, ".ts"), { force: true });
    await appendLedger({ type: existing ? "template.update" : "template.define", name: record.name });
    return record;
  });
}

export async function defineTemplateFromFile(
  sourcePath: string,
  nameOverride?: string,
): Promise<AgentTemplate> {
  const absolute = resolve(sourcePath);
  if (!(await pathExists(absolute))) throw new Error(`Source file not found: ${sourcePath}`);
  const rawExt = extname(absolute);
  if (rawExt !== ".json" && rawExt !== ".ts") {
    throw new Error(`Unsupported template source extension ${rawExt}. Use .json or .ts.`);
  }
  const ext: ".json" | ".ts" = rawExt;
  const loaded = ext === ".ts"
    ? await loadTs(absolute, { kind: "template", cacheBust: true })
    : JSON.parse(await readFile(absolute, "utf8"));
  const draft = validateTemplate(loaded);
  // Match frame's TS rename discipline: the remembered source must continue to
  // declare the stored name when `template update <name>` re-imports it.
  if (ext === ".ts" && nameOverride !== undefined && nameOverride !== draft.name) {
    throw new Error(
      `Cannot rename a .ts template at define time: the source declares "${draft.name}". Rename it in the source file, or use a .json template.`,
    );
  }
  const finalName = nameOverride ?? draft.name;
  if (!validTemplateName(finalName)) throw new Error(`Invalid template name: ${finalName}`);
  const renamed = validateTemplate({ ...draft, name: finalName });

  return withTemplatesLock(async () => {
    const existing = await loadTemplate(finalName);
    const record = timestamped(renamed, existing);
    await writeStoredTemplate(record, ext);
    await rm(templateFilePath(finalName, ext === ".json" ? ".ts" : ".json"), { force: true });
    await atomicWriteFile(templateSourcePath(finalName), `${absolute}\n`, { mode: 0o600 });
    await appendLedger({ type: "template.define", name: finalName, source: absolute });
    return record;
  });
}

export async function updateTemplateFromSource(name: string): Promise<AgentTemplate> {
  if (!validTemplateName(name)) throw new Error(`Invalid template name: ${name}`);
  return withTemplatesLock(async () => {
    const existing = await loadTemplate(name);
    if (!existing) throw new Error(`Unknown template: ${name}`);
    const source = await loadTemplateSource(name);
    if (!source) {
      throw new Error(`No source path recorded for template ${name}. Re-import once with: hive template define <path>`);
    }
    if (!(await pathExists(source))) {
      throw new Error(`Source file no longer exists: ${source}\nRe-import with: hive template define <new-path> ${name}`);
    }
    const rawExt = extname(source);
    if (rawExt !== ".json" && rawExt !== ".ts") {
      throw new Error(`Unsupported template source extension ${rawExt}. Use .json or .ts.`);
    }
    const ext: ".json" | ".ts" = rawExt;
    const loaded = ext === ".ts"
      ? await loadTs(source, { kind: "template", cacheBust: true })
      : JSON.parse(await readFile(source, "utf8"));
    const imported = validateTemplate(loaded);
    // JSON definitions may be renamed at define time; keep applying that
    // remembered override on update. TS renames are refused at define time, so
    // their source must continue to declare the stored name.
    const draft = ext === ".ts"
      ? validateTemplate(imported, name)
      : validateTemplate({ ...imported, name });
    const record = timestamped(draft, existing);
    await writeStoredTemplate(record, ext);
    await rm(templateFilePath(name, ext === ".json" ? ".ts" : ".json"), { force: true });
    await appendLedger({ type: "template.update", name, source });
    return record;
  });
}

export async function writeTemplateFromObject(input: AgentTemplateInput): Promise<AgentTemplate> {
  const draft = validateTemplate(input);
  return withTemplatesLock(async () => {
    const existing = await loadTemplate(draft.name);
    if (!existing) throw new Error(`Unknown template: ${draft.name}`);
    const record = timestamped(draft, existing);
    await writeStoredTemplate(record, ".json");
    await rm(templateFilePath(record.name, ".ts"), { force: true });
    await appendLedger({ type: "template.update", name: record.name });
    return record;
  });
}

export async function loadTemplateSource(name: string): Promise<string | null> {
  if (!validTemplateName(name)) return null;
  try {
    const raw = await readFile(templateSourcePath(name), "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removeTemplate(name: string): Promise<boolean> {
  if (!validTemplateName(name)) return false;
  return withTemplatesLock(async () => {
    const existing = await loadTemplate(name);
    if (!existing) return false;
    await rm(templateFilePath(name, ".json"), { force: true });
    await rm(templateFilePath(name, ".ts"), { force: true });
    await rm(templateSourcePath(name), { force: true });
    await appendLedger({ type: "template.remove", name });
    return true;
  });
}

export function validateTemplate(value: unknown, expectedName?: string): ValidatedTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid template: expected an object");
  }
  const object = value as Record<string, unknown>;
  const name = object.name;
  if (typeof name !== "string" || !validTemplateName(name)) {
    throw new Error(
      `Invalid template: missing or invalid name${expectedName ? ` (file declares ${String(name)}, expected ${expectedName})` : ""}`,
    );
  }
  if (expectedName && name !== expectedName) {
    throw new Error(`Template name mismatch: file declares "${name}", expected "${expectedName}"`);
  }
  if (typeof object.bee !== "string" || object.bee.trim().length === 0) {
    throw new Error(`Invalid template ${name}: bee must be a non-empty string`);
  }
  if (typeof object.prompt !== "string" || object.prompt.trim().length === 0) {
    throw new Error(`Invalid template ${name}: prompt must be a non-empty string`);
  }

  const draft: ValidatedTemplate = {
    name,
    bee: object.bee,
    prompt: object.prompt,
    cwd: "caller",
  };
  if (typeof object.description === "string" && object.description.length > 0) {
    draft.description = object.description;
  }
  if (object.cwd !== undefined) {
    if (object.cwd !== "caller" && (typeof object.cwd !== "string" || !isAbsolute(object.cwd))) {
      throw new Error(`Invalid template ${name}: cwd must be "caller" or an absolute path`);
    }
    draft.cwd = object.cwd as string;
  }
  if (object.args !== undefined) {
    if (!Array.isArray(object.args) || !object.args.every((arg) => typeof arg === "string")) {
      throw new Error(`Invalid template ${name}: args must be an array of strings`);
    }
    if (object.args.length > 0) draft.args = [...object.args] as string[];
  }
  if (object.account !== undefined) {
    if (typeof object.account !== "string" || object.account.trim().length === 0) {
      throw new Error(`Invalid template ${name}: account must be a non-empty string`);
    }
    draft.account = object.account;
  }
  if (object.env !== undefined) {
    if (!object.env || typeof object.env !== "object" || Array.isArray(object.env)) {
      throw new Error(`Invalid template ${name}: env must be an object of string values`);
    }
    const entries = Object.entries(object.env);
    if (!entries.every(([, envValue]) => typeof envValue === "string")) {
      throw new Error(`Invalid template ${name}: env must be an object of string values`);
    }
    if (entries.length > 0) draft.env = Object.fromEntries(entries) as Record<string, string>;
  }
  if (object.yolo !== undefined) {
    if (typeof object.yolo !== "boolean") {
      throw new Error(`Invalid template ${name}: yolo must be a boolean`);
    }
    draft.yolo = object.yolo;
  }
  if (object.preamble !== undefined) {
    if (object.preamble !== false && typeof object.preamble !== "string") {
      throw new Error(`Invalid template ${name}: preamble must be a string or false`);
    }
    draft.preamble = object.preamble;
  }
  return draft;
}

function timestamped(draft: ValidatedTemplate, existing?: AgentTemplate | null): AgentTemplate {
  const now = new Date().toISOString();
  return {
    ...draft,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function readStoredTemplate(
  path: string,
  expectedName: string,
  ext: ".json" | ".ts",
): Promise<AgentTemplate> {
  const raw = ext === ".ts"
    ? await loadTs(path, { kind: "template", cacheBust: true })
    : JSON.parse(await readFile(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid template at ${path}`);
  }
  const object = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> = {
    name: object.name,
    bee: object.bee,
    prompt: object.prompt,
  };
  if (typeof object.description === "string") candidate.description = object.description;
  if (object.cwd === "caller" || (typeof object.cwd === "string" && isAbsolute(object.cwd))) {
    candidate.cwd = object.cwd;
  }
  if (Array.isArray(object.args) && object.args.every((arg) => typeof arg === "string")) {
    candidate.args = object.args;
  }
  if (typeof object.account === "string" && object.account.length > 0) candidate.account = object.account;
  if (object.env && typeof object.env === "object" && !Array.isArray(object.env)) {
    const validEntries = Object.entries(object.env).filter(([, value]) => typeof value === "string");
    if (validEntries.length > 0) candidate.env = Object.fromEntries(validEntries);
  }
  if (typeof object.yolo === "boolean") candidate.yolo = object.yolo;
  if (typeof object.preamble === "string" || object.preamble === false) candidate.preamble = object.preamble;
  const draft = validateTemplate(candidate, expectedName);
  if (typeof object.createdAt !== "string") {
    throw new Error(`Invalid template at ${path}: missing createdAt`);
  }
  return {
    ...draft,
    createdAt: object.createdAt,
    updatedAt: typeof object.updatedAt === "string" ? object.updatedAt : object.createdAt,
  };
}

async function writeStoredTemplate(record: AgentTemplate, ext: ".json" | ".ts"): Promise<void> {
  await ensureDir();
  const json = JSON.stringify(record, null, 2);
  const content = ext === ".ts" ? `export default ${json} as const;\n` : `${json}\n`;
  await atomicWriteFile(templateFilePath(record.name, ext), content, { mode: 0o600 });
}

async function withTemplatesLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureDir();
  return withFileLock(join(templatesDir(), ".templates.lock"), fn);
}

async function ensureDir(): Promise<void> {
  await mkdir(templatesDir(), { recursive: true });
}

async function pathExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

export function templatesDir(): string {
  return join(storeRoot(), "templates");
}

function templateFilePath(name: string, extension: ".json" | ".ts"): string {
  return join(templatesDir(), `${name}${extension}`);
}

function templateSourcePath(name: string): string {
  return join(templatesDir(), `${name}.source`);
}
