#!/usr/bin/env node

// Reclaim the tracing DBs codex keeps in each CODEX_HOME (logs_*.sqlite), across
// every home at once, with a budget far larger than a bee boot can afford.
//
// The reclaim itself is `reclaimCodexHomeLogs` from src/codexHomeMaintenance.ts —
// the same code hive runs on the codex boot path. Sharing it matters: that
// version gates the vacuum on wal_checkpoint(TRUNCATE) reporting no reader, and
// freeing pages while a reader IS live pushes them into the WAL and grows the
// home instead of shrinking it (measured: 1577MB -> 2356MB). An independent
// implementation here would be the one place that hazard could come back.
//
// The boot path gets 5s and converges over many boots. This is for the case
// where you want the whole backlog now, so it spends minutes per home.
//
// Run `npm run build` first — this imports the built module.
//
//   node scripts/reclaim-codex-home-logs.mjs [--dry-run] [--budget-ms 120000]

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let reclaimCodexHomeLogs;
try {
  ({ reclaimCodexHomeLogs } = await import(join(here, "..", "dist", "codexHomeMaintenance.js")));
} catch (error) {
  console.error(`reclaim-codex-home-logs: cannot load dist — run \`npm run build\` first (${error.message})`);
  process.exit(1);
}

const DEFAULT_BUDGET_MS = 120_000;

function parseArgs(argv) {
  let dryRun = false;
  let budgetMs = DEFAULT_BUDGET_MS;
  let homesDir = join(homedir(), ".hive", "homes");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--budget-ms" || arg === "--homes") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--homes") homesDir = value;
      else {
        budgetMs = Number(value);
        if (!Number.isInteger(budgetMs) || budgetMs < 1) throw new Error("--budget-ms must be a positive integer");
      }
      i += 1;
    } else throw new Error(`unexpected argument: ${arg}`);
  }
  return { dryRun, budgetMs, homesDir };
}

const mb = (bytes) => (bytes / 1048576).toFixed(0).padStart(6);

async function homeSize(home) {
  let total = 0;
  for (const name of await readdir(home).catch(() => [])) {
    if (!/^logs_\d+\.sqlite(-wal)?$/.test(name)) continue;
    total += await stat(join(home, name)).then((s) => s.size).catch(() => 0);
  }
  return total;
}

const opts = parseArgs(process.argv.slice(2));
const homes = (await readdir(opts.homesDir).catch(() => [])).filter((n) => n.startsWith("codex-")).sort();
if (homes.length === 0) {
  console.error(`reclaim-codex-home-logs: no codex homes under ${opts.homesDir}`);
  process.exit(1);
}

console.log(`${opts.dryRun ? "survey" : "reclaim"} ${opts.homesDir}  (budget ${opts.budgetMs}ms/home)\n`);
console.log(`${"home".padEnd(34)} ${"before".padStart(6)} ${"after".padStart(6)}  note`);

let total = 0;
for (const name of homes) {
  const home = join(opts.homesDir, name);
  const before = await homeSize(home);
  if (opts.dryRun) {
    console.log(`${name.padEnd(34)} ${mb(before)} ${"     -"}  survey only`);
    continue;
  }
  const result = await reclaimCodexHomeLogs(home, { budgetMs: opts.budgetMs }).catch((error) => ({
    reclaimedBytes: 0,
    busy: false,
    error: error.message,
  }));
  const after = await homeSize(home);
  total += before - after;
  const note = result.error
    ? `failed: ${result.error}`
    : result.busy
      ? "a live app-server held the WAL — nothing reclaimed"
      : before - after > 0
        ? "reclaimed"
        : "already compact";
  console.log(`${name.padEnd(34)} ${mb(before)} ${mb(after)}  ${note}`);
}

if (!opts.dryRun) console.log(`\nreclaimed ${(total / 1073741824).toFixed(2)} GiB`);
