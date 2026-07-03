import type { SealRecord, SealStatus } from "../seal.js";

const SEAL_STATUSES = new Set<SealStatus>(["done", "blocked", "needs_input", "failed"]);

export type LoopStopConfig = {
  max: number | null;
  maxDurationMs: number | null;
  forever: boolean;
  until: string | null;
  stopOnSeal: SealStatus[];
  stopOnSentinel: string | null;
  judge: string | null;
};

export type LoopStopInput = {
  until?: string;
  max?: number;
  maxDuration?: string;
  forever?: boolean;
  stopOnSeal?: string;
  stopOnSentinel?: string;
  judge?: string;
};

export type LoopStopPhase = "pre" | "post";
export type LoopStopDecision = { status: "done" | "paused"; reason: string };

export type LoopStopEvaluationContext = {
  phase: LoopStopPhase;
  cfg: { cwd: string; stop: LoopStopConfig };
  completedIterations: number;
  started: number;
  now: () => number;
  signal?: AbortSignal | undefined;
  seal?: SealRecord | null | undefined;
  boundaryBlocked?: boolean | undefined;
  recordStopCheck: (condition: string, result: boolean) => Promise<void>;
  runStopPredicate: (command: string, cwd: string, options?: { signal?: AbortSignal | undefined }) => Promise<boolean>;
  scanSentinel: (pattern: string) => Promise<boolean>;
  judgeSaysStop: () => Promise<boolean>;
};

export type LoopStopFlowArg = {
  name: string;
  default?: unknown;
  description?: string;
};

export type LoopStopConditionDescriptor = {
  name: string;
  inputKey?: keyof LoopStopInput;
  flowArg?: LoopStopFlowArg;
  phaseOrder?: Partial<Record<LoopStopPhase, number>>;
  coerce?: (input: Record<string, unknown>, draft: LoopStopConfig) => Partial<LoopStopConfig>;
  evaluate: (ctx: LoopStopEvaluationContext) => Promise<LoopStopDecision | null>;
};

export const LOOP_STOP_CONDITIONS: readonly LoopStopConditionDescriptor[] = [
  {
    name: "until",
    inputKey: "until",
    flowArg: { name: "until", default: "", description: "stop once this command/condition succeeds (a shell test; blank = ignore)" },
    phaseOrder: { pre: 30 },
    coerce: (input) => ({ until: optionalString(input.until) }),
    evaluate: async (ctx) => {
      const command = ctx.cfg.stop.until;
      if (!command) return null;
      const hit = await ctx.runStopPredicate(command, ctx.cfg.cwd, { signal: ctx.signal });
      await ctx.recordStopCheck("until", hit);
      return hit ? { status: "done", reason: "until" } : null;
    },
  },
  {
    name: "max",
    inputKey: "max",
    flowArg: { name: "max", default: 100, description: "stop after this many iterations" },
    phaseOrder: { pre: 10, post: 60 },
    coerce: (input) => ({ max: coerceMax(input.max, coerceBool(input.forever)) }),
    evaluate: async (ctx) => {
      const { stop } = ctx.cfg;
      if (!stop.forever && stop.max != null && ctx.completedIterations >= stop.max) {
        await ctx.recordStopCheck("max", true);
        return { status: "done", reason: "max" };
      }
      return null;
    },
  },
  {
    name: "max-duration",
    inputKey: "maxDuration",
    flowArg: { name: "maxDuration", default: "", description: "stop after this much wall-clock (e.g. 2h, 90m; blank = no limit)" },
    phaseOrder: { pre: 20, post: 70 },
    coerce: (input) => ({ maxDurationMs: coerceDuration(input.maxDuration) }),
    evaluate: async (ctx) => {
      const maxDurationMs = ctx.cfg.stop.maxDurationMs;
      if (maxDurationMs != null && ctx.now() - ctx.started >= maxDurationMs) {
        await ctx.recordStopCheck("max-duration", true);
        return { status: "done", reason: "max-duration" };
      }
      return null;
    },
  },
  {
    name: "forever",
    inputKey: "forever",
    flowArg: { name: "forever", default: false, description: "ignore max/maxDuration - run until a stop condition or `hive loop stop`" },
    coerce: (input) => ({ forever: coerceBool(input.forever) }),
    evaluate: async () => null,
  },
  {
    name: "stop-on-seal",
    inputKey: "stopOnSeal",
    flowArg: { name: "stopOnSeal", default: "done", description: "stop when the bee emits a seal of this status (e.g. done; blank = never)" },
    phaseOrder: { post: 10 },
    coerce: (input) => ({ stopOnSeal: coerceStopOnSeal(input.stopOnSeal) }),
    evaluate: async (ctx) => {
      const seal = ctx.seal ?? null;
      if (seal && ctx.cfg.stop.stopOnSeal.length > 0 && ctx.cfg.stop.stopOnSeal.includes(seal.status)) {
        await ctx.recordStopCheck("stop-on-seal", true);
        return { status: "done", reason: `seal:${seal.status}` };
      }
      return null;
    },
  },
  {
    name: "blocked-seal",
    phaseOrder: { post: 20 },
    evaluate: async (ctx) => {
      const seal = ctx.seal ?? null;
      return seal && (seal.status === "blocked" || seal.status === "needs_input")
        ? { status: "paused", reason: `seal:${seal.status}` }
        : null;
    },
  },
  {
    name: "boundary-permission-prompt",
    phaseOrder: { post: 30 },
    evaluate: async (ctx) =>
      !ctx.seal && ctx.boundaryBlocked ? { status: "paused", reason: "boundary:permission_prompt" } : null,
  },
  {
    name: "stop-on-sentinel",
    inputKey: "stopOnSentinel",
    flowArg: { name: "stopOnSentinel", default: "", description: "stop when this text appears in the bee's pane (blank = off)" },
    phaseOrder: { post: 40 },
    coerce: (input) => ({ stopOnSentinel: optionalString(input.stopOnSentinel) }),
    evaluate: async (ctx) => {
      const pattern = ctx.cfg.stop.stopOnSentinel;
      if (!pattern) return null;
      const hit = await ctx.scanSentinel(pattern);
      await ctx.recordStopCheck("stop-on-sentinel", hit);
      return hit ? { status: "done", reason: "sentinel" } : null;
    },
  },
  {
    name: "judge",
    inputKey: "judge",
    flowArg: { name: "judge", default: "", description: "optional judge bee/command that decides whether to continue" },
    phaseOrder: { post: 50 },
    coerce: (input) => ({ judge: optionalString(input.judge) }),
    evaluate: async (ctx) => {
      if (!ctx.cfg.stop.judge) return null;
      const hit = await ctx.judgeSaysStop();
      await ctx.recordStopCheck("judge", hit);
      return hit ? { status: "done", reason: "judge" } : null;
    },
  },
];

export function buildLoopStopConfig(input: Record<string, unknown>): LoopStopConfig {
  const stop: LoopStopConfig = {
    max: null,
    maxDurationMs: null,
    forever: false,
    until: null,
    stopOnSeal: ["done"],
    stopOnSentinel: null,
    judge: null,
  };
  for (const condition of LOOP_STOP_CONDITIONS) {
    if (condition.coerce) Object.assign(stop, condition.coerce(input, stop));
  }
  return stop;
}

export function loopStopFlowArgs(): LoopStopFlowArg[] {
  return LOOP_STOP_CONDITIONS.flatMap((condition) => (condition.flowArg ? [condition.flowArg] : []));
}

export function appendDefinedLoopStopArgs(input: LoopStopInput, target: Record<string, unknown>): void {
  for (const condition of LOOP_STOP_CONDITIONS) {
    if (!condition.inputKey) continue;
    const value = input[condition.inputKey];
    if (value !== undefined) target[condition.inputKey] = value;
  }
}

export function loopStopConditionsForPhase(phase: LoopStopPhase): LoopStopConditionDescriptor[] {
  return LOOP_STOP_CONDITIONS.filter((condition) => condition.phaseOrder?.[phase] !== undefined).sort(
    (a, b) => (a.phaseOrder?.[phase] ?? 0) - (b.phaseOrder?.[phase] ?? 0),
  );
}

export async function evaluateLoopStopConditions(ctx: LoopStopEvaluationContext): Promise<LoopStopDecision | null> {
  for (const condition of loopStopConditionsForPhase(ctx.phase)) {
    const decision = await condition.evaluate(ctx);
    if (decision) return decision;
  }
  return null;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.trim().length === 0 ? null : s;
}

function coerceBool(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  const s = String(value).toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function coerceMax(value: unknown, forever: boolean): number | null {
  // --forever disables the iteration cap entirely. The flow arg default
  // (max=100) is applied unconditionally by the runtime, so a forever loop
  // would otherwise have a phantom cap written into loop.json ("N / 100").
  if (forever) return null;
  if (value === undefined || value === null || value === "") {
    throw new Error("Loop requires --max <N> (a positive integer) unless --forever is set.");
  }
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --max "${String(value)}": expected a positive integer.`);
  }
  return n;
}

function coerceStopOnSeal(value: unknown): SealStatus[] {
  if (value === undefined || value === null) return ["done"];
  const parts = String(value)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return [];
  for (const part of parts) {
    if (!SEAL_STATUSES.has(part as SealStatus)) {
      throw new Error(`Invalid --stop-on-seal "${part}". Use any of: done, blocked, needs_input, failed.`);
    }
  }
  return parts as SealStatus[];
}

/**
 * Parse a duration like `30s`, `10m`, `2h` (or a bare number of milliseconds)
 * into milliseconds. Returns null when no duration is supplied.
 */
export function coerceDuration(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --max-duration "${value}".`);
    return Math.floor(value);
  }
  const s = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!match) throw new Error(`Invalid --max-duration "${s}". Use e.g. 30s, 10m, 2h.`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = Math.floor(amount * multiplier);
  if (ms <= 0) throw new Error(`Invalid --max-duration "${s}".`);
  return ms;
}
