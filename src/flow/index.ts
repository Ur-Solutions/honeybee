import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { appendLedger } from "../store.js";
import { loadTsModule as loadTs } from "../tsLoader.js";
import { parseJsonFlow } from "./json.js";

/**
 * Flow registry + types + TS SDK helper. Storage mirrors src/frame.ts:
 *   ~/.hive/flows/<name>.json      — canonical declarative source
 *   ~/.hive/flows/<name>.ts        — TS source (requires tsx)
 *   ~/.hive/flows/<name>.source    — absolute path of the original file
 *
 * The runtime (HiveFacade, run dirs, foreground/background execution) lands in
 * patches 11 and 12. This patch ships only the registry, parser, and the
 * shape of FlowContext/BeeHandle/Flow so flow authors can start writing
 * declarative flows today.
 */

/** Optional argument declaration. Defaults are applied by the runtime. */
export type FlowArg = {
  name: string;
  default?: unknown;
};

/** Cleanup policy at end-of-flow. Default is 'keep' — bees stay inspectable. */
export type FlowCleanup = "keep" | "kill-on-end";

/**
 * Substrate-neutral handle for a bee spawned inside a flow. Note: no
 * `tmuxTarget` — that is a local-tmux detail. Runtime callers should use the
 * `id` and resolve the substrate via substrateForRecord (patch 11).
 */
export type BeeHandle = {
  id: string;
  name: string;
  agent: string;
  cwd?: string;
  node?: string;
};

/**
 * Runtime context passed to the user-authored or JSON-compiled run() function.
 * The actual implementation of `hive` lives in src/flow/sdk.ts (patch 11).
 * Compiled JSON flows in this patch only depend on the surface declared here.
 */
export type FlowContext = {
  /** Run identifier — `<ts>-<8hex>` allocated by the runtime. */
  runId: string;
  /** Flow name (canonical, post-rename). */
  flowName: string;
  /** Caller-supplied arg values, defaults already applied. */
  args: Record<string, unknown>;
  /** Bindings written by spawn ops (`as` → BeeHandle). */
  bindings: Record<string, BeeHandle>;
  /** Aborts when the foreground run is cancelled (SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Substrate-neutral facade. The runtime supplies an implementation. */
  hive: FlowHive;
};

/**
 * Minimal facade surface that compiled JSON flows touch. The full HiveFacade
 * (patch 11) is a superset — it adds collect/buz primitives, return-value
 * shapes, and stricter typing. JSON authoring only needs the verbs below.
 */
export type FlowHive = {
  spawn(spec: FlowSpawnInput): Promise<BeeHandle>;
  send(target: BeeHandle | string, text: string): Promise<void>;
  brief(target: BeeHandle | string, text: string): Promise<void>;
  waitForSeal(target: BeeHandle | string, options?: { timeoutMs?: number }): Promise<unknown>;
  wait(target: BeeHandle | string, options?: { idleMs?: number; timeoutMs?: number }): Promise<void>;
  kill(target: BeeHandle | string): Promise<void>;
  seal(target: BeeHandle | string, artifactPath: string): Promise<unknown>;
  log(message: string): Promise<void> | void;
};

export type FlowSpawnInput = {
  bee: string;
  name?: string;
  cwd?: string;
  home?: string;
  node?: string;
  colony?: string;
  swarmId?: string;
};

// Quest adoption of flow-spawned bees (`hive quest start --flow`) is threaded as
// an `onSpawned` callback through ExecuteFlowOptions → HiveFacade, NOT as a flow
// authoring field: FlowSpawnInput is deliberately NOT widened so a JSON/TS flow
// author can never claim a questId/workspaceId — the quest owns those, and the
// membership stamp + window link live in cli.ts (keeping HiveFacade neutral).

/** The compiled flow. `run` receives the runtime-built FlowContext. */
export type Flow = {
  name: string;
  description?: string;
  args?: FlowArg[];
  cleanup?: FlowCleanup;
  run: (ctx: FlowContext) => Promise<unknown> | unknown;
  /**
   * Set on placeholder entries returned by listFlows() for registry files
   * that failed to load (e.g. a TS flow whose imports no longer resolve).
   * Such a flow's run() throws; the marker lets `hive flow list` surface the
   * breakage instead of silently hiding the flow.
   */
  loadError?: string;
};

/** User-facing input to defineFlow. `cleanup` defaults to 'keep' at parse time. */
export type FlowSpec = {
  name: string;
  description?: string;
  args?: FlowArg[];
  cleanup?: FlowCleanup;
  run: (ctx: FlowContext) => Promise<unknown> | unknown;
};

const FLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function validFlowName(name: string): boolean {
  return FLOW_NAME_RE.test(name);
}

/**
 * TS SDK barrel. Pass-through identity helper used by flows authored in TS:
 *
 *   import { defineFlow } from "honeybee/flow";
 *   export default defineFlow({ name: "review", run: async (ctx) => {...} });
 */
export function defineFlow(spec: FlowSpec): Flow {
  if (!spec || typeof spec !== "object") {
    throw new Error("defineFlow: expected an object");
  }
  if (typeof spec.name !== "string" || !validFlowName(spec.name)) {
    throw new Error(`defineFlow: invalid name "${spec.name}"`);
  }
  if (typeof spec.run !== "function") {
    throw new Error(`defineFlow: flow ${spec.name} must define run()`);
  }
  const flow: Flow = {
    name: spec.name,
    run: spec.run,
  };
  if (typeof spec.description === "string") flow.description = spec.description;
  if (Array.isArray(spec.args)) flow.args = normalizeArgs(spec.args, spec.name);
  flow.cleanup = spec.cleanup === "kill-on-end" ? "kill-on-end" : "keep";
  return flow;
}

function normalizeArgs(value: unknown, flowName: string): FlowArg[] {
  if (!Array.isArray(value)) throw new Error(`Invalid flow ${flowName}: args must be an array`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid arg #${index} in flow ${flowName}: expected an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.length === 0) {
      throw new Error(`Invalid arg #${index} in flow ${flowName}: name must be a non-empty string`);
    }
    const arg: FlowArg = { name: obj.name };
    if ("default" in obj) arg.default = obj.default;
    return arg;
  });
}

/* ------------------------------------------------------------------ */
/*  Built-in flow registry                                            */
/* ------------------------------------------------------------------ */

/**
 * Built-in flows ship with hive itself rather than living on disk under
 * ~/.hive/flows. They are resolved by loadFlow() BEFORE the disk lookup so a
 * fresh `__flow-exec` child can resolve them too (the single most important
 * seam for loops). The loaders use a function-level dynamic import to avoid the
 * static cycle flow/index ↔ loop/flow.
 */
const BUILTIN_FLOW_LOADERS: Record<string, () => Promise<Flow>> = {
  loop: async () => (await import("../loop/index.js")).loopFlow,
};

export const BUILTIN_FLOW_NAMES = Object.keys(BUILTIN_FLOW_LOADERS);

function isBuiltinFlow(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_FLOW_LOADERS, name);
}

/* ------------------------------------------------------------------ */
/*  Registry CRUD — mirrors src/frame.ts                              */
/* ------------------------------------------------------------------ */

export async function listFlows(): Promise<Flow[]> {
  await ensureDir();
  const files = await readdir(flowsDir()).catch(() => []);
  const seen = new Set<string>();
  const flows: Flow[] = [];
  // Built-in flows first so they always appear even with no on-disk flows.
  for (const name of BUILTIN_FLOW_NAMES) {
    if (seen.has(name)) continue;
    seen.add(name);
    const flow = await loadFlow(name).catch(() => null);
    if (flow) flows.push(flow);
  }
  for (const file of files) {
    const ext = extname(file);
    if (ext !== ".json" && ext !== ".ts") continue;
    const name = file.slice(0, -ext.length);
    if (seen.has(name)) continue;
    seen.add(name);
    try {
      const flow = await loadFlow(name);
      if (flow) flows.push(flow);
    } catch (error) {
      // A registered flow that fails to load must stay VISIBLE — silently
      // dropping it makes `hive flow list` lie about the registry. Surface a
      // placeholder whose loadError carries the diagnosis.
      flows.push(unloadableFlow(name, error));
    }
  }
  return flows.sort((a, b) => a.name.localeCompare(b.name));
}

function unloadableFlow(name: string, error: unknown): Flow {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name,
    description: `(unloadable: ${message})`,
    cleanup: "keep",
    loadError: message,
    run: async () => {
      throw new Error(`Flow ${name} failed to load: ${message}`);
    },
  };
}

export async function loadFlow(name: string): Promise<Flow | null> {
  const builtin = BUILTIN_FLOW_LOADERS[name];
  if (builtin) return builtin();
  const tsPath = flowFilePath(name, ".ts");
  if (await pathExists(tsPath)) {
    try {
      return validateFlow(await loadTsModule(tsPath), name);
    } catch (registryError) {
      // The registry copy is a SINGLE file — a TS flow with relative imports
      // validates at define time (imported from its original location) but its
      // registry copy cannot resolve those imports. Fall back to the recorded
      // source path before giving up.
      const source = await loadFlowSource(name).catch(() => null);
      if (source && resolve(source) !== resolve(tsPath) && (await pathExists(source))) {
        try {
          return validateFlow(await loadTsModule(source), name);
        } catch (sourceError) {
          const registryMsg = registryError instanceof Error ? registryError.message : String(registryError);
          const sourceMsg = sourceError instanceof Error ? sourceError.message : String(sourceError);
          throw new Error(`Flow ${name}: registry copy failed (${registryMsg}); source ${source} also failed (${sourceMsg})`);
        }
      }
      throw registryError;
    }
  }
  const jsonPath = flowFilePath(name, ".json");
  if (await pathExists(jsonPath)) {
    const raw = await readFile(jsonPath, "utf8");
    return parseJsonFlow(JSON.parse(raw), { expectedName: name });
  }
  return null;
}

export async function flowExists(name: string): Promise<boolean> {
  return (await loadFlow(name)) !== null;
}

/**
 * Import a flow from a `.json` or `.ts` file, copy it into the registry, and
 * persist `<name>.source` for later reload. Mirrors defineFrameFromFile.
 */
export async function defineFlowFromFile(sourcePath: string, nameOverride?: string): Promise<Flow> {
  const absolute = resolve(sourcePath);
  if (!(await pathExists(absolute))) throw new Error(`Source file not found: ${sourcePath}`);
  const rawExt = extname(absolute);
  if (rawExt !== ".json" && rawExt !== ".ts") {
    throw new Error(`Unsupported flow source extension ${rawExt}. Use .json or .ts.`);
  }
  const ext: ".json" | ".ts" = rawExt;

  const loaded =
    ext === ".ts"
      ? await loadTsModule(absolute)
      : parseJsonFlow(JSON.parse(await readFile(absolute, "utf8")));

  const draft = validateFlow(loaded);
  const finalName = nameOverride ?? draft.name;
  if (!validFlowName(finalName)) throw new Error(`Invalid flow name: ${finalName}`);
  if (isBuiltinFlow(finalName)) {
    throw new Error(`Cannot define flow "${finalName}": it is a built-in flow.`);
  }
  if (ext === ".ts" && nameOverride && nameOverride !== draft.name) {
    throw new Error(
      `cannot rename TS flows via nameOverride (got '${nameOverride}', source defines '${draft.name}'). ` +
        `Edit defineFlow({ name }) in the source file or convert to a JSON flow.`,
    );
  }
  const flow: Flow = { ...draft, name: finalName };

  await ensureDir();
  const target = flowFilePath(finalName, ext);
  await copyFile(absolute, target);
  if (ext === ".json") {
    // Rewrite the JSON canonically so the registered name matches finalName.
    const stored = await readFile(absolute, "utf8");
    const parsedObject = JSON.parse(stored) as Record<string, unknown>;
    parsedObject.name = finalName;
    await atomicWriteFile(target, `${JSON.stringify(parsedObject, null, 2)}\n`, { mode: 0o600 });
  }
  await atomicWriteFile(flowSourcePath(finalName), `${absolute}\n`, { mode: 0o600 });
  await appendLedger({ type: "flow.define", name: finalName, source: absolute });
  return flow;
}

export async function loadFlowSource(name: string): Promise<string | null> {
  try {
    const raw = await readFile(flowSourcePath(name), "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removeFlow(name: string): Promise<boolean> {
  if (isBuiltinFlow(name)) {
    throw new Error(`Cannot remove flow "${name}": it is a built-in flow.`);
  }
  let removed = false;
  for (const ext of [".ts", ".json"] as const) {
    const path = flowFilePath(name, ext);
    if (await pathExists(path)) {
      await rm(path, { force: true });
      removed = true;
    }
  }
  await rm(flowSourcePath(name), { force: true });
  if (removed) await appendLedger({ type: "flow.remove", name });
  return removed;
}

/**
 * Normalize an unknown value (TS dynamic import default, or already-parsed JSON
 * Flow shape) into a typed Flow. Reused by loadFlow + defineFlowFromFile.
 *
 * Accepts BOTH:
 *  - a Flow returned by defineFlow (has `run`)
 *  - a JSON Flow shape (has `steps`) — auto-compiled via parseJsonFlow
 */
export function validateFlow(value: unknown, expectedName?: string): Flow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid flow: expected an object");
  }
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.steps) && typeof object.run !== "function") {
    // JSON-shape coming through: re-route through the compiler so the same
    // validations apply.
    return parseJsonFlow(object, { expectedName });
  }
  const name = object.name;
  if (typeof name !== "string" || !validFlowName(name)) {
    throw new Error(
      `Invalid flow: missing or invalid name${expectedName ? ` (file declares ${String(name)}, expected ${expectedName})` : ""}`,
    );
  }
  if (expectedName && name !== expectedName) {
    throw new Error(`Flow name mismatch: file declares "${name}", expected "${expectedName}"`);
  }
  if (typeof object.run !== "function") {
    throw new Error(`Invalid flow ${name}: run must be a function (TS) or steps must be an array (JSON)`);
  }
  const flow: Flow = { name, run: object.run as Flow["run"] };
  if (typeof object.description === "string") flow.description = object.description;
  if (Array.isArray(object.args)) flow.args = normalizeArgs(object.args, name);
  flow.cleanup = object.cleanup === "kill-on-end" ? "kill-on-end" : "keep";
  return flow;
}

async function loadTsModule(path: string): Promise<unknown> {
  return loadTs(path, { kind: "flow" });
}

async function pathExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function ensureDir(): Promise<void> {
  await mkdir(flowsDir(), { recursive: true });
}

function flowsDir(): string {
  return join(storeRoot(), "flows");
}

function flowFilePath(name: string, extension: ".json" | ".ts"): string {
  return join(flowsDir(), `${name}${extension}`);
}

function flowSourcePath(name: string): string {
  return join(flowsDir(), `${name}.source`);
}
