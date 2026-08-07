/**
 * Opt-in per-phase spawn timing. A bare `hive spawn` has no breadcrumb showing
 * which phase ate the wall-clock when it is "sometimes really really slow" —
 * account OAuth refresh (network, 15s cap), accounts-lock contention, the tmux
 * launch, or the readiness wait (which silently burns its full timeout when the
 * agent's ready prompt is never detected). Set HIVE_DEBUG_SPAWN=1 to print a
 * greppable breakdown to stderr at the end of each spawn:
 *
 *   spawn-timing CL-ab12: total 15234ms · resolve 12ms · activate 8ms ·
 *     exec-check 3ms · allocate 5ms · session-create 41ms · ready 15120ms
 *
 * Measurement is always on and uses a monotonic clock so the durable ledger can
 * diagnose production stalls. HIVE_DEBUG_SPAWN controls only stderr rendering.
 */
import { performance } from "node:perf_hooks";

export type SpawnTimingReport = {
  label: string;
  totalMs: number;
  phases: Array<{ name: string; ms: number }>;
};

export type SpawnTimer = {
  /** Record the elapsed time since the previous mark (or timer start) under `phase`. */
  mark(phase: string): void;
  /** Emit the accumulated breakdown to stderr. `label` overrides the start label (e.g. the final bee name). */
  report(label?: string): SpawnTimingReport;
};

export function spawnTimingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.HIVE_DEBUG_SPAWN;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * A live timer when HIVE_DEBUG_SPAWN is set, else a shared no-op. Time is read
 * lazily on each mark/report so the caller never threads a clock through.
 */
export function startSpawnTimer(label: string, env: NodeJS.ProcessEnv = process.env): SpawnTimer {
  const debug = spawnTimingEnabled(env);
  const start = performance.now();
  let last = start;
  const phases: Array<{ name: string; ms: number }> = [];
  return {
    mark(phase: string) {
      const now = performance.now();
      phases.push({ name: phase, ms: now - last });
      last = now;
    },
    report(reportLabel?: string) {
      const total = performance.now() - start;
      const parts = phases.map((p) => `${p.name} ${p.ms}ms`).join(" · ");
      const name = reportLabel ?? label;
      if (debug) process.stderr.write(`spawn-timing ${name}: total ${Math.round(total)}ms${parts ? ` · ${phases.map((p) => `${p.name} ${Math.round(p.ms)}ms`).join(" · ")}` : ""}\n`);
      return { label: name, totalMs: total, phases: phases.map((phase) => ({ ...phase })) };
    },
  };
}
