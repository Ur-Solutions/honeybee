// ──────────────────────────────────────────────────────────────────────────
// Seats: the paying identities the ledger attributes spend to. A seat is one
// harness config dir. Two sources, both scanned read-only:
//   1. Interactive CLIs under the home directory — ~/.claude, ~/.claude-2,
//      ~/.codex, ~/.codex-1, …
//   2. honeybee's own per-account agent homes under the store —
//      ~/.hive/homes/<account>/ and ~/.hive/login-homes/<account>/, where bees
//      run bound to a vault account. These hold the bulk of agent usage and
//      were the big blind spot: without them the ledger sees almost nothing.
// We scaffold one entry per dir with provider/plan/monthlyUsd left for the user
// to fill in, and merge on re-discovery so those user-filled fields survive.
//
// Source transcript dirs are only ever READ here; nothing under a config dir is
// written or moved. The only file this module writes is our own seats.json.
// ──────────────────────────────────────────────────────────────────────────

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { seatsPath } from "./paths.js";
import type { Harness, Seat, SeatsFile } from "./types.js";

/** Names containing these are backups/mirrors of a config dir, never a seat. */
function isBackupName(name: string): boolean {
  return /backup/i.test(name);
}

/** Match a home-dir entry to its harness, or null when it is not a config dir. */
function harnessForConfigName(name: string): Harness | null {
  if (name === ".claude" || name.startsWith(".claude-")) return "claude";
  if (name === ".codex" || name.startsWith(".codex-")) return "codex";
  return null;
}

/**
 * Glob a home directory for harness config dirs and scaffold a Seat per dir.
 * Skips backups and anything that is not a directory (e.g. stray `.json`
 * files). Seat id is `${harness}:${basename==".claude"?"default":basename
 * without the leading dot}` — e.g. ~/.claude -> claude:default, ~/.codex-1 ->
 * codex:codex-1. provider/plan/monthlyUsd are intentionally left undefined.
 */
export async function discoverConfigDirs(homeDir: string = homedir()): Promise<Seat[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(homeDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const seats: Seat[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!entry.isDirectory()) continue; // stray files (incl. *.json) are not seats
    if (isBackupName(name)) continue; // *-backups / *-sync-backups mirrors
    if (name.endsWith(".json")) continue; // belt-and-suspenders for a dir named *.json
    const harness = harnessForConfigName(name);
    if (!harness) continue;

    const suffix = name === `.${harness}` ? "default" : name.replace(/^\./, "");
    seats.push({
      id: `${harness}:${suffix}`,
      harness,
      configDir: resolve(join(homeDir, name)),
      label: name,
    });
  }
  seats.sort((a, b) => a.id.localeCompare(b.id));
  return seats;
}

/** Map a honeybee account-home name to the harness spend can price, or null. */
function harnessForAccountName(name: string): Harness | null {
  if (name.startsWith("claude-") || name === "claude") return "claude";
  if (name.startsWith("codex-") || name === "codex") return "codex";
  return null; // grok/opencode/other: no priced extractor yet → not a seat
}

/** True when `dir` exists and is readable as a directory (holds transcripts). */
async function dirExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover honeybee's per-account agent homes as seats. Scans
 * `<store>/homes/*` and `<store>/login-homes/*`; a home becomes a seat only when
 * it actually holds this harness's transcripts (`projects/` for claude,
 * `sessions/` for codex), so empty/login-only homes don't clutter seats.json.
 * Seat id drops the redundant harness prefix from the account id, e.g.
 * ~/.hive/homes/claude-tormod-thto.no -> claude:tormod-thto.no; the login-homes
 * variant gets an `@login` suffix so it stays distinct. Global request-id dedup
 * means a session mirrored across homes is still counted once.
 */
export async function discoverHiveHomeSeats(storeDir: string = storeRoot()): Promise<Seat[]> {
  const seats: Seat[] = [];
  for (const base of ["homes", "login-homes"] as const) {
    const root = join(storeDir, base);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // store or root absent → nothing to scan
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const harness = harnessForAccountName(entry.name);
      if (!harness) continue;
      const configDir = resolve(join(root, entry.name));
      const transcriptSub = harness === "codex" ? "sessions" : "projects";
      if (!(await dirExists(join(configDir, transcriptSub)))) continue;
      const account = entry.name.startsWith(`${harness}-`) ? entry.name.slice(harness.length + 1) : entry.name;
      const suffix = base === "login-homes" ? `${account}@login` : account;
      seats.push({
        id: `${harness}:${suffix}`,
        harness,
        configDir,
        label: `${base}/${entry.name}`,
        accountId: entry.name,
      });
    }
  }
  seats.sort((a, b) => a.id.localeCompare(b.id));
  return seats;
}

/** Lightly validate an untrusted parsed value into a SeatsFile. */
function validateSeatsFile(raw: unknown): SeatsFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("seats file must be an object");
  }
  const seatsValue = (raw as { seats?: unknown }).seats;
  if (!Array.isArray(seatsValue)) throw new Error("seats file must have a seats array");

  const seats: Seat[] = seatsValue.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`seat ${index} must be an object`);
    }
    const object = entry as Record<string, unknown>;
    if (typeof object.id !== "string" || object.id.length === 0) throw new Error(`seat ${index} must have an id`);
    if (object.harness !== "claude" && object.harness !== "codex" && object.harness !== "grok" && object.harness !== "opencode") {
      throw new Error(`seat ${index} has an unknown harness`);
    }
    if (typeof object.configDir !== "string" || object.configDir.length === 0) {
      throw new Error(`seat ${index} must have a configDir`);
    }
    const seat: Seat = {
      id: object.id,
      harness: object.harness,
      configDir: object.configDir,
      ...(typeof object.provider === "string" ? { provider: object.provider } : {}),
      ...(typeof object.plan === "string" ? { plan: object.plan } : {}),
      ...(typeof object.monthlyUsd === "number" && Number.isFinite(object.monthlyUsd) ? { monthlyUsd: object.monthlyUsd } : {}),
      ...(typeof object.label === "string" ? { label: object.label } : {}),
      ...(typeof object.accountId === "string" ? { accountId: object.accountId } : {}),
    };
    return seat;
  });
  return { seats };
}

/** Load seats.json, or an empty SeatsFile when it is absent. */
export async function loadSeats(path: string = seatsPath()): Promise<SeatsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { seats: [] };
    throw error;
  }
  return validateSeatsFile(JSON.parse(raw));
}

/** Persist seats.json, overwriting any existing file. Serialized by lock. */
export async function saveSeats(file: SeatsFile, path: string = seatsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(`${path}.lock`, async () => {
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  });
}

/**
 * Merge freshly discovered seats into an existing set, matched by id. Existing
 * seats win — their user-filled provider/plan/monthlyUsd/label are preserved
 * verbatim — and newly discovered ids are appended. Existing seats whose config
 * dir is no longer present are kept (the user may have configured them). Returns
 * the merged file plus the list of ids added this run.
 */
function mergeDiscoveredSeats(existing: SeatsFile, discovered: Seat[]): { file: SeatsFile; added: string[] } {
  const byId = new Map(existing.seats.map((seat) => [seat.id, seat]));
  const added: string[] = [];
  for (const seat of discovered) {
    if (byId.has(seat.id)) continue; // preserve the user's existing entry untouched
    byId.set(seat.id, seat);
    added.push(seat.id);
  }
  // Existing seats first (in their original order), then the newly added ones.
  const merged = [...existing.seats, ...added.map((id) => byId.get(id)!)];
  return { file: { seats: merged }, added };
}

/**
 * Load seats.json, discover config dirs under `homeDir`, merge (adding only new
 * ids without clobbering user edits on existing ones), write the result back,
 * and return the merged file. Newly added seat ids are logged for visibility.
 */
export async function ensureSeats(
  homeDir: string = homedir(),
  path: string = seatsPath(),
  storeDir: string = storeRoot(),
): Promise<SeatsFile> {
  const existing = await loadSeats(path);
  const [flat, hive] = await Promise.all([discoverConfigDirs(homeDir), discoverHiveHomeSeats(storeDir)]);
  const { file, added } = mergeDiscoveredSeats(existing, [...flat, ...hive]);
  await saveSeats(file, path);
  if (added.length > 0) {
    // Surface newly scaffolded seats so the user knows to fill in monthlyUsd.
    console.error(`spend: scaffolded ${added.length} new seat(s): ${added.join(", ")}`);
  }
  return file;
}
