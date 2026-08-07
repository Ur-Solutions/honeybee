import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { withFileLock } from "./lock.js";
import { storeRoot } from "./fsx.js";

const execFileP = promisify(execFile);

/**
 * trmdy/kit integration — capability materialization (skills, MCP config,
 * instructions) into harness homes. Kit is OPTIONAL by design: hive shells out
 * to the `kit` CLI (honeybee stays zero-dependency), and when no binary is
 * found every hook here is a silent no-op. Contract: kit only ever touches
 * files its own ownership manifest (<home>/.kit/manifest.json) claims; hive's
 * seeders own everything else.
 *
 * Env: HIVE_KIT_BIN overrides the binary; HIVE_KIT_DISABLE=1 forces the
 * integration off.
 */

export interface KitHomeStamp {
  /** Kit content version materialized into the home (e.g. "0.2.0"). */
  kitVersion?: string;
  /** Kit profile the home was last materialized with (e.g. "web-qa"). */
  kitProfile?: string;
}

export interface KitMaterializeOptions {
  /** Explicit kit profile; omitted → kit's per-target/default profile. */
  profile?: string;
  /**
   * strict: the caller explicitly asked for a capability set — failures throw.
   * Default (false): best-effort; failures go to `warn` and never break the
   * caller (activation must not fail on capability sync).
   */
  strict?: boolean;
  warn?: (message: string) => void;
  /**
   * Best-effort sync freshness window. A recently materialized home can skip
   * both Kit subprocesses during a spawn burst; strict profile requests always
   * synchronize. Defaults to HIVE_KIT_SYNC_TTL_MS or 60 seconds.
   */
  freshnessTtlMs?: number;
  /** Clock seam for freshness tests. */
  now?: () => number;
  /** Always-on, secret-free phase observation. Callback failures are ignored. */
  onTiming?: (timing: KitMaterializeTiming) => void;
}

export type KitMaterializeTiming = {
  totalMs: number;
  freshnessCheckMs: number;
  probeMs: number;
  lockWaitMs: number;
  lockHeldMs: number;
  syncMs: number;
  freshness: "hit" | "miss" | "disabled" | "unavailable";
  singleFlight: boolean;
};

export const DEFAULT_KIT_SYNC_TTL_MS = 60_000;

function kitBin(): string {
  return process.env.HIVE_KIT_BIN || "kit";
}

function kitDisabled(): boolean {
  return process.env.HIVE_KIT_DISABLE === "1";
}

function kitSyncTtlMs(override: number | undefined): number {
  if (override !== undefined) return Number.isFinite(override) ? Math.max(0, override) : DEFAULT_KIT_SYNC_TTL_MS;
  const configured = Number(process.env.HIVE_KIT_SYNC_TTL_MS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_KIT_SYNC_TTL_MS;
  return configured;
}

async function kitHomeWasMaterializedRecently(
  homePath: string,
  profile: string | undefined,
  ttlMs: number,
  now: number,
): Promise<boolean> {
  if (ttlMs <= 0) return false;
  try {
    const manifest = JSON.parse(await readFile(join(homePath, ".kit", "manifest.json"), "utf8")) as {
      materializedAt?: unknown;
      profile?: unknown;
    };
    if (profile !== undefined && manifest.profile !== profile) return false;
    if (typeof manifest.materializedAt !== "string") return false;
    const materializedAt = Date.parse(manifest.materializedAt);
    const age = now - materializedAt;
    return Number.isFinite(materializedAt) && age >= 0 && age < ttlMs;
  } catch {
    return false;
  }
}

// One probe per process; a missing binary is the common steady state on
// machines without kit and must cost one failed exec, not one per activation.
// Deliberately caches for the process lifetime: a long-lived daemon that saw a
// transient probe failure (or had kit installed after start) skips kit until
// restart — acceptable for best-effort capability sync.
let kitProbe: Promise<string | null> | undefined;

export function kitAvailableVersion(): Promise<string | null> {
  if (kitDisabled()) return Promise.resolve(null);
  kitProbe ??= execFileP(kitBin(), ["version", "--json"], { timeout: 10_000, killSignal: "SIGKILL" })
    .then(({ stdout }) => {
      const version = (JSON.parse(stdout) as { version?: string }).version;
      return typeof version === "string" ? version : null;
    })
    .catch(() => null);
  return kitProbe;
}

/** Test seam: forget the cached probe (HIVE_KIT_BIN changes between tests). */
export function resetKitProbeForTests(): void {
  kitProbe = undefined;
  kitFlights.clear();
}

const kitFlights = new Map<string, Promise<KitMaterializeTiming>>();

function zeroTiming(freshness: KitMaterializeTiming["freshness"]): KitMaterializeTiming {
  return { totalMs: 0, freshnessCheckMs: 0, probeMs: 0, lockWaitMs: 0, lockHeldMs: 0, syncMs: 0, freshness, singleFlight: false };
}

function notifyTiming(callback: KitMaterializeOptions["onTiming"], timing: KitMaterializeTiming): void {
  try {
    callback?.(timing);
  } catch {
    // Observability is never authoritative for capability convergence.
  }
}

function kitHomeLockPath(homePath: string): string {
  const key = createHash("sha256").update(resolve(homePath)).digest("hex").slice(0, 32);
  return join(storeRoot(), "locks", "kit-homes", `${key}.lock`);
}

/**
 * Materialize a home's capability set via `kit sync --home … --json`.
 * Idempotent and merge-based on kit's side. Concurrent syncs to the SAME home
 * (e.g. an activation sync racing an explicit --kit-profile sync) are
 * serialized by kit's own per-home lock, so this is safe to call from both the
 * lock-held activation path and the lock-free explicit path.
 */
export async function kitMaterializeHome(
  homePath: string,
  harness: string,
  options: KitMaterializeOptions = {},
): Promise<void> {
  const key = JSON.stringify([resolve(homePath), harness, options.profile ?? "", options.strict === true]);
  const existing = kitFlights.get(key);
  if (existing) {
    const shared = await existing;
    notifyTiming(options.onTiming, { ...shared, singleFlight: true });
    return;
  }
  const flight = runKitMaterializeHome(homePath, harness, options);
  kitFlights.set(key, flight);
  try {
    const timing = await flight;
    notifyTiming(options.onTiming, timing);
  } finally {
    if (kitFlights.get(key) === flight) kitFlights.delete(key);
  }
}

async function runKitMaterializeHome(
  homePath: string,
  harness: string,
  options: KitMaterializeOptions,
): Promise<KitMaterializeTiming> {
  const warn = options.warn ?? (() => undefined);
  const started = performance.now();
  const timing = zeroTiming("miss");
  if (kitDisabled()) {
    if (options.strict) throw new Error("kit integration is disabled (HIVE_KIT_DISABLE=1)");
    return { ...timing, totalMs: performance.now() - started, freshness: "disabled" };
  }
  // Apiary fan-outs commonly activate the same account home several times in
  // one second. A successful Kit sync stamps materializedAt in its ownership
  // manifest; within this small freshness window the exact same convergence
  // work is redundant and costs two Node subprocesses (~100ms locally). Keep
  // explicit --kit-profile strict: it is a requested capability transition,
  // not best-effort background convergence.
  const freshnessStarted = performance.now();
  const fresh = !options.strict && await kitHomeWasMaterializedRecently(
      homePath,
      options.profile,
      kitSyncTtlMs(options.freshnessTtlMs),
      options.now?.() ?? Date.now(),
    );
  timing.freshnessCheckMs += performance.now() - freshnessStarted;
  if (fresh) {
    return { ...timing, totalMs: performance.now() - started, freshness: "hit" };
  }
  const probeStarted = performance.now();
  const available = await kitAvailableVersion();
  timing.probeMs = performance.now() - probeStarted;
  if (available === null) {
    if (options.strict) {
      throw new Error("kit binary not found — install trmdy/kit (npm link) or set HIVE_KIT_BIN");
    }
    return { ...timing, totalMs: performance.now() - started, freshness: "unavailable" };
  }
  const args = [
    "sync",
    "--home",
    homePath,
    "--harness",
    harness,
    ...(options.profile ? ["--profile", options.profile] : []),
    "--json",
  ];
  let lockAcquiredAt = 0;
  await withFileLock(kitHomeLockPath(homePath), async () => {
    lockAcquiredAt = performance.now();
    // Cross-process double-check: a sibling may have completed while this
    // process waited for the home. This is the important miss->hit fast path
    // during large Apiary fan-outs.
    if (!options.strict) {
      const recheckStarted = performance.now();
      const nowFresh = await kitHomeWasMaterializedRecently(
        homePath,
        options.profile,
        kitSyncTtlMs(options.freshnessTtlMs),
        options.now?.() ?? Date.now(),
      );
      timing.freshnessCheckMs += performance.now() - recheckStarted;
      if (nowFresh) {
        timing.freshness = "hit";
        return;
      }
    }
    const syncStarted = performance.now();
    try {
      await execFileP(kitBin(), args, {
        timeout: options.strict ? 120_000 : 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 4_000_000,
      });
    } catch (error) {
      const detail = describeExecError(error);
      if (options.strict) {
        throw new Error(`kit sync --profile ${options.profile ?? "(default)"} failed for ${homePath}: ${detail}`);
      }
      warn(`kit sync skipped for ${homePath}: ${detail}`);
    } finally {
      timing.syncMs = performance.now() - syncStarted;
    }
  }, {
    timeoutMs: options.strict ? 130_000 : 30_000,
    onAcquired: ({ waitMs }) => { timing.lockWaitMs = waitMs; },
  });
  timing.lockHeldMs = lockAcquiredAt > 0 ? performance.now() - lockAcquiredAt : 0;
  return { ...timing, totalMs: performance.now() - started };
}

/**
 * Read the kit stamp from a home's ownership manifest — what version/profile
 * the home actually carries. Cheap fs read, no subprocess; {} when the home
 * isn't kit-managed.
 */
export async function readKitHomeStamp(homePath: string): Promise<KitHomeStamp> {
  try {
    const raw = await readFile(join(homePath, ".kit", "manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as { kitVersion?: string; profile?: string };
    return {
      ...(typeof manifest.kitVersion === "string" ? { kitVersion: manifest.kitVersion } : {}),
      ...(typeof manifest.profile === "string" ? { kitProfile: manifest.profile } : {}),
    };
  } catch {
    return {};
  }
}

function describeExecError(error: unknown): string {
  const err = error as { stderr?: string; message?: string };
  const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
  return (stderr || err.message || String(error)).split("\n")[0]!;
}
