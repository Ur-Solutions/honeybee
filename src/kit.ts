import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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
}

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
  const warn = options.warn ?? (() => undefined);
  if (kitDisabled()) {
    if (options.strict) throw new Error("kit integration is disabled (HIVE_KIT_DISABLE=1)");
    return;
  }
  // Apiary fan-outs commonly activate the same account home several times in
  // one second. A successful Kit sync stamps materializedAt in its ownership
  // manifest; within this small freshness window the exact same convergence
  // work is redundant and costs two Node subprocesses (~100ms locally). Keep
  // explicit --kit-profile strict: it is a requested capability transition,
  // not best-effort background convergence.
  if (
    !options.strict &&
    await kitHomeWasMaterializedRecently(
      homePath,
      options.profile,
      kitSyncTtlMs(options.freshnessTtlMs),
      options.now?.() ?? Date.now(),
    )
  ) return;
  if ((await kitAvailableVersion()) === null) {
    if (options.strict) {
      throw new Error("kit binary not found — install trmdy/kit (npm link) or set HIVE_KIT_BIN");
    }
    return;
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
  try {
    // Timeout budget: the best-effort activation path runs inside the account
    // lock, whose waiters give up after 30s (registry.ts). 15s + hard kill
    // bounds kit's OWN hang so a wedged binary can't hold the lock indefinitely
    // — but it is additive to the other lock-held work (credential copy + OAuth
    // refresh), so a slow-but-not-hung kit can still contribute to lock
    // pressure. kit self-serializes per home (its own .kit/sync lock), so
    // concurrent syncs to one home don't corrupt regardless of this lock. The
    // explicit strict --kit-profile path (outside the account lock) gets 120s.
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
  }
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
