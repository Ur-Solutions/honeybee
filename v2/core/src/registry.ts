/**
 * Template + track input normalization — the ONE validator both the store's
 * put verbs and the package importer go through, so a row can only ever hold
 * a canonical field set (unknown fields dropped, defaults applied, closed
 * lists enforced). Timestamps and ids are owned by the store, never by input.
 */
import { isAbsolute } from "node:path";
import {
  CWD_POLICIES,
  PackageError,
  SCOPES,
  TRACK_STEP_STATUSES,
  type CwdPolicy,
  type RowSource,
  type Scope,
  type TemplateRow,
  type TrackRow,
  type TrackStep,
  type TrackStepStatus,
} from "./types.ts";

/** Names: portable, filename-safe (matches the old template/track name rule). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** The content fields of a template — everything except id/timestamps. */
export type TemplateFields = Omit<TemplateRow, "id" | "createdAt" | "updatedAt">;
/** The content fields of a track — everything except id/timestamps. */
export type TrackFields = Omit<TrackRow, "id" | "createdAt" | "updatedAt">;

export interface NormalizeOptions {
  /** Applied when the input carries no scope. Default `personal`. */
  defaultScope?: Scope;
  /** Applied when the input carries no source. Default `api`. */
  defaultSource?: RowSource;
  /** Label for error messages (a file path, "rpc", …). */
  label?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isRowSource(v: unknown): v is RowSource {
  return typeof v === "string" && (v === "api" || v === "local-config" || (v.startsWith("package:") && v.length > "package:".length));
}

export function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}

function fail(label: string | undefined, msg: string): never {
  throw new PackageError(`${label ? `${label}: ` : ""}${msg}`);
}

function optString(o: Record<string, unknown>, key: string, label?: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") fail(label, `${key} must be a string`);
  return v.length === 0 ? null : v;
}

function stringArray(o: Record<string, unknown>, key: string, label?: string): string[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(label, `${key} must be an array of strings`);
  return [...(v as string[])];
}

function stringRecord(o: Record<string, unknown>, key: string, label?: string): Record<string, string> {
  const v = o[key];
  if (v === undefined || v === null) return {};
  if (!isObject(v) || !Object.values(v).every((x) => typeof x === "string")) {
    fail(label, `${key} must be an object of string values`);
  }
  // Sorted keys → deterministic serialization.
  const out: Record<string, string> = {};
  for (const k of Object.keys(v).sort()) out[k] = v[k] as string;
  return out;
}

function optBool(o: Record<string, unknown>, key: string, fallback: boolean, label?: string): boolean {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") fail(label, `${key} must be a boolean`);
  return v;
}

function scopeAndSource(o: Record<string, unknown>, opts: NormalizeOptions): { scope: Scope; source: RowSource } {
  const scope = o.scope === undefined || o.scope === null ? (opts.defaultScope ?? "personal") : o.scope;
  if (!isScope(scope)) fail(opts.label, `scope must be one of ${SCOPES.join("|")}`);
  const source = o.source === undefined || o.source === null ? (opts.defaultSource ?? "api") : o.source;
  if (!isRowSource(source)) fail(opts.label, `source must be 'api', 'local-config' or 'package:<path>'`);
  return { scope, source };
}

function requireName(o: Record<string, unknown>, label?: string): string {
  const name = o.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    fail(label, `name must match ${NAME_RE.source}`);
  }
  return name;
}

/** Validate + canonicalize a template input. Throws PackageError on any violation. */
export function normalizeTemplate(value: unknown, opts: NormalizeOptions = {}): TemplateFields {
  if (!isObject(value)) fail(opts.label, "template must be an object");
  const o = value;
  const label = opts.label;
  const name = requireName(o, label);
  const { scope, source } = scopeAndSource(o, opts);
  if (typeof o.agent !== "string" || o.agent.trim().length === 0) fail(label, `template ${name}: agent must be a non-empty string`);
  if (typeof o.prompt !== "string" || o.prompt.trim().length === 0) fail(label, `template ${name}: prompt must be a non-empty string`);

  let cwdPolicy: CwdPolicy = "caller";
  if (o.cwdPolicy !== undefined && o.cwdPolicy !== null) {
    if (typeof o.cwdPolicy !== "string" || !(CWD_POLICIES as readonly string[]).includes(o.cwdPolicy)) {
      fail(label, `template ${name}: cwdPolicy must be one of ${CWD_POLICIES.join("|")}`);
    }
    cwdPolicy = o.cwdPolicy as CwdPolicy;
  }
  const cwd = optString(o, "cwd", label);
  if (cwdPolicy === "fixed") {
    if (cwd === null || !isAbsolute(cwd)) fail(label, `template ${name}: cwdPolicy 'fixed' requires an absolute cwd`);
  } else if (cwd !== null) {
    fail(label, `template ${name}: cwd is only allowed with cwdPolicy 'fixed'`);
  }
  const preamble = optString(o, "preamble", label);
  const preambleEnabled = optBool(o, "preambleEnabled", true, label);
  if (!preambleEnabled && preamble !== null) fail(label, `template ${name}: preamble text requires preambleEnabled = true`);

  return {
    name,
    scope,
    source,
    description: optString(o, "description", label),
    agent: o.agent,
    substrate: optString(o, "substrate", label),
    model: optString(o, "model", label),
    effort: optString(o, "effort", label),
    args: stringArray(o, "args", label),
    prompt: o.prompt,
    preamble,
    preambleEnabled,
    cwdPolicy,
    cwd: cwdPolicy === "fixed" ? cwd : null,
    env: stringRecord(o, "env", label),
    account: optString(o, "account", label),
    yolo: optBool(o, "yolo", false, label),
    tags: stringArray(o, "tags", label),
  };
}

function normalizeStep(value: unknown, index: number, seen: Set<string>, label?: string): TrackStep {
  if (!isObject(value)) fail(label, `steps[${index}] must be an object`);
  const o = value;
  const id = o.id === undefined || o.id === null ? `s${index + 1}` : o.id;
  if (typeof id !== "string" || !STEP_ID_RE.test(id)) fail(label, `steps[${index}].id must match ${STEP_ID_RE.source}`);
  if (seen.has(id)) fail(label, `steps[${index}].id '${id}' is duplicated`);
  seen.add(id);
  if (typeof o.name !== "string" || o.name.trim().length === 0) fail(label, `steps[${index}].name must be a non-empty string`);
  const kind = optString(o, "kind", label) ?? "action";
  const status = o.status === undefined || o.status === null ? "pending" : o.status;
  if (typeof status !== "string" || !(TRACK_STEP_STATUSES as readonly string[]).includes(status)) {
    fail(label, `steps[${index}].status must be one of ${TRACK_STEP_STATUSES.join("|")}`);
  }
  return {
    id,
    name: o.name,
    kind,
    templateId: optString(o, "templateId", label),
    instruction: optString(o, "instruction", label),
    note: optString(o, "note", label),
    status: status as TrackStepStatus,
  };
}

/** Validate + canonicalize a track input. Throws PackageError on any violation. */
export function normalizeTrack(value: unknown, opts: NormalizeOptions = {}): TrackFields {
  if (!isObject(value)) fail(opts.label, "track must be an object");
  const o = value;
  const label = opts.label;
  const name = requireName(o, label);
  const { scope, source } = scopeAndSource(o, opts);
  const rawSteps = o.steps === undefined || o.steps === null ? [] : o.steps;
  if (!Array.isArray(rawSteps)) fail(label, `track ${name}: steps must be an array`);
  const seen = new Set<string>();
  const steps = rawSteps.map((s, i) => normalizeStep(s, i, seen, label));
  return {
    name,
    scope,
    source,
    description: optString(o, "description", label),
    steps,
    tags: stringArray(o, "tags", label),
  };
}

/** JSON with recursively sorted object keys — order-independent structural identity. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Structural equality on content fields (the "unchanged" test for idempotent puts). */
export function fieldsEqual(a: object, b: object): boolean {
  return stableStringify(a) === stableStringify(b);
}
