import type { BeeHandle, Flow, FlowArg, FlowContext, FlowSpawnInput } from "./index.js";

/**
 * JSON flow shape:
 *   {
 *     "name": "deep-review",
 *     "description": "...",
 *     "args": [{ "name": "target", "default": "src" }],
 *     "cleanup": "keep" | "kill-on-end",
 *     "steps": [
 *       { "op": "spawn", "as": "arch", "bee": "claude", "cwd": "{{target}}" },
 *       { "op": "brief", "to": "{{arch.id}}", "text": "Review {{target}}." },
 *       { "op": "waitForSeal", "of": "{{arch.id}}" }
 *     ]
 *   }
 *
 * The compiler validates each step shape, then emits a sequential async
 * run() closure that dispatches into ctx.hive at execution time. Substitution
 * supports `{{name}}` and `{{name.field}}` against (1) spawn bindings and
 * (2) args; arbitrary expressions are rejected.
 */

/** Supported declarative ops in JSON. Parallel/loops/sub-flows are TS-only. */
export type JsonFlowOp =
  | { op: "spawn"; as: string; bee: string; name?: string; cwd?: string; home?: string; node?: string; colony?: string; swarmId?: string }
  | { op: "send"; to: string; text: string }
  | { op: "brief"; to: string; text: string }
  | { op: "waitForSeal"; of: string; timeoutMs?: number }
  | { op: "wait"; of: string; idleMs?: number; timeoutMs?: number }
  | { op: "kill"; of: string }
  | { op: "seal"; of: string; from: string }
  | { op: "log"; message: string }
  | { op: "return"; value?: unknown };

export type JsonFlow = {
  name: string;
  description?: string;
  args?: FlowArg[];
  cleanup?: "keep" | "kill-on-end";
  steps: JsonFlowOp[];
};

export type ParseOptions = {
  expectedName?: string;
};

// The Flow type does not embed steps; we re-export the op union for callers
// that want to introspect the compiled output (e.g. `hive flow inspect` could
// hydrate the JSON via the source file).
export type CompiledStep = JsonFlowOp;

const SUPPORTED_OPS = new Set<string>([
  "spawn",
  "send",
  "brief",
  "waitForSeal",
  "wait",
  "kill",
  "seal",
  "log",
  "return",
]);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Parse + validate a JSON flow object and compile it into a runnable Flow.
 * Throws on unknown ops, missing fields, name mismatches, or invalid syntax.
 */
export function parseJsonFlow(value: unknown, options: ParseOptions = {}): Flow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid flow: expected an object");
  }
  const object = value as Record<string, unknown>;
  const name = object.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(
      `Invalid flow: missing or invalid name${options.expectedName ? ` (file declares ${String(name)}, expected ${options.expectedName})` : ""}`,
    );
  }
  if (options.expectedName && name !== options.expectedName) {
    throw new Error(`Flow name mismatch: file declares "${name}", expected "${options.expectedName}"`);
  }
  const rawSteps = object.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error(`Invalid flow ${name}: steps must be a non-empty array`);
  }
  const steps: JsonFlowOp[] = rawSteps.map((step, index) => validateStep(step, index, name));

  const flow: Flow = {
    name,
    run: compileSteps(steps, name),
  };
  if (typeof object.description === "string") flow.description = object.description;
  if (Array.isArray(object.args)) flow.args = normalizeArgs(object.args, name);
  flow.cleanup = object.cleanup === "kill-on-end" ? "kill-on-end" : "keep";
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

function validateStep(value: unknown, index: number, flowName: string): JsonFlowOp {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid step #${index} in flow ${flowName}: expected an object`);
  }
  const step = value as Record<string, unknown>;
  const op = step.op;
  if (typeof op !== "string") {
    throw new Error(`Invalid step #${index} in flow ${flowName}: missing op`);
  }
  if (!SUPPORTED_OPS.has(op)) {
    throw new Error(
      `Invalid step #${index} in flow ${flowName}: unknown op "${op}". Supported: ${[...SUPPORTED_OPS].sort().join(", ")}`,
    );
  }
  switch (op) {
    case "spawn":
      return validateSpawn(step, index, flowName);
    case "send":
    case "brief":
      return validateSendLike(step, op, index, flowName);
    case "waitForSeal":
      return validateWaitForSeal(step, index, flowName);
    case "wait":
      return validateWait(step, index, flowName);
    case "kill":
      return validateKill(step, index, flowName);
    case "seal":
      return validateSeal(step, index, flowName);
    case "log":
      return validateLog(step, index, flowName);
    case "return":
      return { op: "return", ...("value" in step ? { value: step.value } : {}) };
    default:
      // Unreachable — SUPPORTED_OPS guards the switch — but TS narrows nicely.
      throw new Error(`Invalid step #${index} in flow ${flowName}: unhandled op "${op}"`);
  }
}

function validateSpawn(step: Record<string, unknown>, index: number, flowName: string): JsonFlowOp {
  const as = step.as;
  if (typeof as !== "string" || !NAME_RE.test(as)) {
    throw new Error(`Invalid step #${index} (spawn) in flow ${flowName}: 'as' must be a valid binding name`);
  }
  const bee = step.bee;
  if (typeof bee !== "string" || bee.length === 0) {
    throw new Error(`Invalid step #${index} (spawn) in flow ${flowName}: 'bee' must be a non-empty string`);
  }
  const out: JsonFlowOp = { op: "spawn", as, bee };
  for (const k of ["name", "cwd", "home", "node", "colony", "swarmId"] as const) {
    const v = step[k];
    if (v !== undefined) {
      if (typeof v !== "string") {
        throw new Error(`Invalid step #${index} (spawn) in flow ${flowName}: '${k}' must be a string`);
      }
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function validateSendLike(
  step: Record<string, unknown>,
  op: "send" | "brief",
  index: number,
  flowName: string,
): JsonFlowOp {
  const to = step.to;
  if (typeof to !== "string" || to.length === 0) {
    throw new Error(`Invalid step #${index} (${op}) in flow ${flowName}: 'to' must be a non-empty string`);
  }
  const text = step.text;
  if (typeof text !== "string") {
    throw new Error(`Invalid step #${index} (${op}) in flow ${flowName}: 'text' must be a string`);
  }
  return { op, to, text };
}

function validateWaitForSeal(step: Record<string, unknown>, index: number, flowName: string): JsonFlowOp {
  const of = step.of;
  if (typeof of !== "string" || of.length === 0) {
    throw new Error(`Invalid step #${index} (waitForSeal) in flow ${flowName}: 'of' must be a non-empty string`);
  }
  const out: JsonFlowOp = { op: "waitForSeal", of };
  if (step.timeoutMs !== undefined) {
    if (typeof step.timeoutMs !== "number" || !Number.isFinite(step.timeoutMs) || step.timeoutMs < 0) {
      throw new Error(`Invalid step #${index} (waitForSeal) in flow ${flowName}: 'timeoutMs' must be a non-negative number`);
    }
    out.timeoutMs = step.timeoutMs;
  }
  return out;
}

function validateWait(step: Record<string, unknown>, index: number, flowName: string): JsonFlowOp {
  const of = step.of;
  if (typeof of !== "string" || of.length === 0) {
    throw new Error(`Invalid step #${index} (wait) in flow ${flowName}: 'of' must be a non-empty string`);
  }
  const out: JsonFlowOp = { op: "wait", of };
  for (const k of ["idleMs", "timeoutMs"] as const) {
    const v = step[k];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`Invalid step #${index} (wait) in flow ${flowName}: '${k}' must be a non-negative number`);
      }
      out[k] = v;
    }
  }
  return out;
}

function validateKill(step: Record<string, unknown>, index: number, flowName: string): JsonFlowOp {
  const of = step.of;
  if (typeof of !== "string" || of.length === 0) {
    throw new Error(`Invalid step #${index} (kill) in flow ${flowName}: 'of' must be a non-empty string`);
  }
  return { op: "kill", of };
}

function validateSeal(step: Record<string, unknown>, index: number, flowName: string): JsonFlowOp {
  const of = step.of;
  if (typeof of !== "string" || of.length === 0) {
    throw new Error(`Invalid step #${index} (seal) in flow ${flowName}: 'of' must be a non-empty string`);
  }
  const from = step.from;
  if (typeof from !== "string" || from.length === 0) {
    throw new Error(`Invalid step #${index} (seal) in flow ${flowName}: 'from' must be a non-empty string`);
  }
  return { op: "seal", of, from };
}

function validateLog(step: Record<string, unknown>, index: number, flowName: string): JsonFlowOp {
  const message = step.message;
  if (typeof message !== "string") {
    throw new Error(`Invalid step #${index} (log) in flow ${flowName}: 'message' must be a string`);
  }
  return { op: "log", message };
}

/* ------------------------------------------------------------------ */
/*  Compiler — turns the validated step list into an async run(ctx).  */
/* ------------------------------------------------------------------ */

function compileSteps(steps: JsonFlowOp[], flowName: string): Flow["run"] {
  return async function compiledRun(ctx: FlowContext): Promise<unknown> {
    let returnValue: unknown = undefined;
    for (let i = 0; i < steps.length; i += 1) {
      if (ctx.signal?.aborted) {
        throw new Error(`Flow ${flowName} aborted at step #${i}`);
      }
      const step = steps[i]!;
      switch (step.op) {
        case "spawn": {
          const spec: FlowSpawnInput = { bee: substituteString(step.bee, ctx) };
          if (step.name !== undefined) spec.name = substituteString(step.name, ctx);
          if (step.cwd !== undefined) spec.cwd = substituteString(step.cwd, ctx);
          if (step.home !== undefined) spec.home = substituteString(step.home, ctx);
          if (step.node !== undefined) spec.node = substituteString(step.node, ctx);
          if (step.colony !== undefined) spec.colony = substituteString(step.colony, ctx);
          if (step.swarmId !== undefined) spec.swarmId = substituteString(step.swarmId, ctx);
          const handle: BeeHandle = await ctx.hive.spawn(spec);
          ctx.bindings[step.as] = handle;
          break;
        }
        case "send":
          await ctx.hive.send(substituteString(step.to, ctx), substituteString(step.text, ctx));
          break;
        case "brief":
          await ctx.hive.brief(substituteString(step.to, ctx), substituteString(step.text, ctx));
          break;
        case "waitForSeal": {
          const opts = step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : undefined;
          await ctx.hive.waitForSeal(substituteString(step.of, ctx), opts);
          break;
        }
        case "wait": {
          const opts: { idleMs?: number; timeoutMs?: number } = {};
          if (step.idleMs !== undefined) opts.idleMs = step.idleMs;
          if (step.timeoutMs !== undefined) opts.timeoutMs = step.timeoutMs;
          await ctx.hive.wait(substituteString(step.of, ctx), Object.keys(opts).length > 0 ? opts : undefined);
          break;
        }
        case "kill":
          await ctx.hive.kill(substituteString(step.of, ctx));
          break;
        case "seal":
          await ctx.hive.seal(substituteString(step.of, ctx), substituteString(step.from, ctx));
          break;
        case "log":
          await ctx.hive.log(substituteString(step.message, ctx));
          break;
        case "return":
          returnValue = step.value;
          return returnValue;
      }
    }
    return returnValue;
  };
}

/* ------------------------------------------------------------------ */
/*  Variable substitution: {{name}} and {{name.field}} only.          */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Replace `{{path}}` placeholders in `template` using the run's bindings + args.
 *
 * Resolution order: ctx.bindings first (spawn outputs), then ctx.args.
 * Dot paths walk one level deep into the resolved value (BeeHandle.id etc.).
 * Bracket indexing, function calls, and anything else are rejected by the
 * regex — the placeholder simply doesn't match and stays as-is, which surfaces
 * the typo loudly when the bee receives the literal text.
 */
export function substituteString(template: string, ctx: FlowContext): string {
  if (typeof template !== "string") return template;
  return template.replace(PLACEHOLDER_RE, (match, raw: string) => {
    const path = raw.split(".");
    const head = path[0]!;
    let value: unknown;
    if (Object.prototype.hasOwnProperty.call(ctx.bindings, head)) {
      value = ctx.bindings[head];
    } else if (Object.prototype.hasOwnProperty.call(ctx.args, head)) {
      value = ctx.args[head];
    } else {
      // Unknown identifier → leave the placeholder verbatim so the failure is
      // visible (e.g. in the bee's pane / the run log). Throwing here would
      // abort an otherwise-recoverable flow.
      return match;
    }
    for (let i = 1; i < path.length; i += 1) {
      if (value == null || typeof value !== "object") return match;
      value = (value as Record<string, unknown>)[path[i]!];
    }
    if (value == null) return match;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return match;
    }
  });
}

