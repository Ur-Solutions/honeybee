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
}

function kitBin(): string {
  return process.env.HIVE_KIT_BIN || "kit";
}

function kitDisabled(): boolean {
  return process.env.HIVE_KIT_DISABLE === "1";
}

// One probe per process; a missing binary is the common steady state on
// machines without kit and must cost one failed exec, not one per activation.
let kitProbe: Promise<string | null> | undefined;

export function kitAvailableVersion(): Promise<string | null> {
  if (kitDisabled()) return Promise.resolve(null);
  kitProbe ??= execFileP(kitBin(), ["version", "--json"], { timeout: 10_000 })
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
 * Idempotent and merge-based on kit's side; concurrent activations of the same
 * home are already serialized by the account lock at the call site.
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
    await execFileP(kitBin(), args, { timeout: 120_000, maxBuffer: 4_000_000 });
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
