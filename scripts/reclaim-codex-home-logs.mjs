#!/usr/bin/env node

// Reclaim the tracing DBs codex keeps in each CODEX_HOME (logs_*.sqlite).
//
// Codex maintains these itself: it prunes rows to a byte budget, sets
// auto_vacuum=INCREMENTAL, and checkpoints with wal_checkpoint(PASSIVE). That
// design assumes roughly one app-server per home. Hive runs 4-10 concurrently
// against the same home, so a PASSIVE checkpoint never finds the quiet moment it
// needs: the WAL is never truncated, freed pages are never released, and the file
// grows without bound. Measured here: six homes at 99.8% freelist, and one that
// reached 5.1M live rows behind a 1.4GB WAL and started timing out codex's boot
// handshake outright (bee CO.66ad0).
//
// So the reclaim has to come from outside codex. Two operations, picked per home:
//
//   incremental_vacuum  Releases freelist pages. Safe while app-servers are live
//                       and very effective (one home went 2420MB -> 2MB), but it
//                       costs ~2.5min of CPU on a multi-GB file and parks the
//                       page churn in the WAL until a checkpoint can drain it.
//   VACUUM              Rewrites the file in one pass, WAL included. Takes an
//                       exclusive lock, so it is idle-homes-only.
//
// wal_checkpoint(TRUNCATE) follows both. It is instant and harmless, but only
// truncates once no reader holds an older snapshot — on a busy home it reclaims
// nothing and that is expected, not a failure.

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// A busy home should wait its turn briefly rather than fail instantly, but never
// long enough to stall an app-server's own writes behind this maintenance.
const BUSY_TIMEOUT_MS = 5_000;

function parseArgs(argv) {
  const flags = new Set();
  let homesDir = join(homedir(), ".hive", "homes");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--dry-run", "--skip-busy", "--full"].includes(arg)) flags.add(arg.slice(2));
    else if (arg === "--homes") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--homes requires a value");
      homesDir = value;
      i += 1;
    } else throw new Error(`unexpected argument: ${arg}`);
  }
  return {
    dryRun: flags.has("dry-run"),
    skipBusy: flags.has("skip-busy"),
    full: flags.has("full"),
    homesDir,
  };
}

const mb = (bytes) => (bytes / 1048576).toFixed(0).padStart(6);

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Live `codex app-server` PIDs whose CODEX_HOME is this home. */
async function busyPids(home) {
  let pids = [];
  try {
    const { stdout } = await execFileP("pgrep", ["-f", "codex app-server"]);
    pids = stdout.split("\n").filter(Boolean);
  } catch {
    return []; // pgrep exits non-zero when nothing matches
  }
  const owners = [];
  for (const pid of pids) {
    try {
      // `ps -E` prints the environment after the command; match the assignment
      // exactly so codex-th-ursolutions.no can't match codex-ursolutions.no.
      const { stdout } = await execFileP("ps", ["-Eww", "-p", pid]);
      if (stdout.split(/\s+/).includes(`CODEX_HOME=${home}`)) owners.push(pid);
    } catch {
      // process exited between pgrep and ps
    }
  }
  return owners;
}

async function sqlite(dbPath, sql, timeoutMs = 30 * 60_000) {
  const { stdout } = await execFileP("sqlite3", [dbPath, `pragma busy_timeout=${BUSY_TIMEOUT_MS}; ${sql}`], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout.trim();
}

/** Page/freelist stats read without touching the WAL, so a survey never mutates. */
async function survey(dbPath) {
  const raw = await sqlite(
    `file:${dbPath}?immutable=1`,
    "select (select * from pragma_page_count())||' '||(select * from pragma_freelist_count());",
  ).catch(() => "0 0");
  const [pages, free] = raw.split("\n").pop().split(" ").map(Number);
  return { pages, free, freePct: pages > 0 ? (100 * free) / pages : 0 };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let entries;
  try {
    entries = (await readdir(opts.homesDir)).filter((name) => name.startsWith("codex-")).sort();
  } catch (error) {
    throw new Error(`cannot read homes dir ${opts.homesDir}: ${error.message}`);
  }

  console.log(`${opts.dryRun ? "survey" : "reclaim"} ${opts.homesDir}\n`);
  console.log(`${"home".padEnd(34)} ${"before".padStart(6)} ${"after".padStart(6)}  free%  action`);

  let reclaimed = 0;
  for (const name of entries) {
    const home = join(opts.homesDir, name);
    let dbs;
    try {
      dbs = (await readdir(home)).filter((f) => /^logs_\d+\.sqlite$/.test(f));
    } catch {
      continue;
    }

    const owners = await busyPids(home);
    for (const db of dbs) {
      const dbPath = join(home, db);
      const wal = `${dbPath}-wal`;
      const before = (await sizeOf(dbPath)) + (await sizeOf(wal));
      const { freePct } = await survey(dbPath);
      const pct = freePct.toFixed(1).padStart(6);
      const row = (after, action) => {
        console.log(`${name.padEnd(34)} ${mb(before)} ${after} ${pct}  ${action}`);
      };

      // A full VACUUM needs the exclusive lock no live app-server will yield.
      const idle = owners.length === 0;
      const plan = idle && !opts.dryRun ? "vacuum" : opts.full && !idle ? "vacuum" : "incremental";

      if (opts.dryRun) {
        row("     -", idle ? "idle: would vacuum" : `${owners.length} live: would ${plan}`);
        continue;
      }
      if (owners.length > 0 && opts.skipBusy) {
        row("     -", `skipped: ${owners.length} live app-server(s)`);
        continue;
      }

      try {
        if (plan === "vacuum") await sqlite(dbPath, "vacuum;");
        // Releases the freelist without the exclusive lock. On a busy home the
        // pages it frees land in the WAL, so the file shrinks well before the
        // total does; the next checkpoint on a quiet home collects the rest.
        else await sqlite(dbPath, "pragma incremental_vacuum;");
        await sqlite(dbPath, "pragma wal_checkpoint(truncate);");

        const after = (await sizeOf(dbPath)) + (await sizeOf(wal));
        reclaimed += before - after;
        row(mb(after), owners.length > 0 ? `${plan}, ${owners.length} live app-server(s)` : plan);
      } catch (error) {
        row("     -", `failed: ${error.message.split("\n")[0]}`);
      }
    }
  }

  if (!opts.dryRun) {
    const gib = reclaimed / 1073741824;
    console.log(`\nreclaimed ${gib.toFixed(2)} GiB`);
    if (gib < 0) console.log("(negative: a busy home parked page churn in its WAL; it drains once that home goes idle)");
  }
}

main().catch((error) => {
  console.error(`reclaim-codex-home-logs: ${error.message}`);
  process.exit(1);
});
