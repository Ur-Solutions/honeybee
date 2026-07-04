// `hive pool` — checkout pools: named sets of pre-cloned pro checkouts that
// bees claim round-robin (CHECKOUT_POOLS_PRD §6.5). Config/membership are
// pro's truth (porcelain); hive derives occupancy and owns claims/cursor/parks.
// Dispatch pattern of colony.ts (HIVE-15).
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ageFlag, hasFlag } from "../cli/shared.js";
import { actionLine, bold, dim, formatTable, gray, green, isPretty, note, tildify, yellow } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";
import {
  allocatePoolMembers,
  claimSpecificPoolMember,
  occupantsForPath,
  poolLiveBees,
  poolsForProject,
  poolStatus,
  projectRepresentatives,
  releasePoolMemberClaims,
  resolvePoolRef,
  setPoolMemberParked,
  type LiveBee,
  type MemberOccupancy,
  type PoolStatus,
  type ResolvedPool,
} from "../pool.js";
import { choosePoolLaunch, poolCapacityCell, type PoolLaunchRow } from "../poolLaunchTui.js";
import {
  extendProPool,
  listProRepoEntries,
  ProPoolsUnavailableError,
  resolveProEntryForCwd,
  syncProCheckouts,
  type ProRepoEntry,
} from "../proProjects.js";
import { cmdSpawn, loadSpawnBeeOptions } from "./spawn.js";

export async function cmdPool(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return poolList(parsed);
    case "status":
      return poolStatusCmd(parsed);
    case "spawn":
      return poolSpawnCmd(parsed);
    case "launch":
      return poolLaunchCmd(parsed);
    case "extend":
      return poolExtendCmd(parsed);
    case "sync":
      return poolSyncCmd(parsed);
    case "claim":
      return poolClaimCmd(parsed);
    case "release":
      return poolReleaseCmd(parsed);
    case "park":
      return poolParkCmd(parsed, true);
    case "unpark":
      return poolParkCmd(parsed, false);
    default:
      throw new Error(`Unknown pool subcommand: ${sub}\nUsage: hive pool <list|status|spawn|launch|extend|sync|claim|release|park|unpark>`);
  }
}


/**
 * Pools in scope: the cwd's pro project when inside one, else every project
 * (one porcelain call per project). A pool-less pro surfaces its typed,
 * actionable error instead of reading as "no pools".
 */
async function poolsInScope(): Promise<{ pools: ResolvedPool[]; entries: ProRepoEntry[]; scoped: boolean }> {
  const entries = await listProRepoEntries();
  const cwdEntry = resolveProEntryForCwd(entries, process.cwd());
  const scopes = cwdEntry ? [cwdEntry] : projectRepresentatives(entries);
  const pools: ResolvedPool[] = [];
  for (const scope of scopes) {
    try {
      pools.push(...(await poolsForProject(scope, entries)));
    } catch (error) {
      if (error instanceof ProPoolsUnavailableError) throw error;
      // A single unreadable project must not sink an all-projects sweep.
      if (cwdEntry) throw error;
    }
  }
  return { pools, entries, scoped: Boolean(cwdEntry) };
}


/** Resolve `<pool>` (arg) or fall back to scope; used by status/sync. */
async function resolveTargets(ref: string | undefined, all: boolean): Promise<ResolvedPool[]> {
  if (ref) return [await resolvePoolRef(ref, process.cwd())];
  if (all) {
    const entries = await listProRepoEntries();
    const pools: ResolvedPool[] = [];
    for (const scope of projectRepresentatives(entries)) {
      try {
        pools.push(...(await poolsForProject(scope, entries)));
      } catch (error) {
        if (error instanceof ProPoolsUnavailableError) throw error;
      }
    }
    return pools;
  }
  return (await poolsInScope()).pools;
}


// ── list ──────────────────────────────────────────────────────────────────────

export async function poolList(parsed: Parsed) {
  const { pools, scoped } = await poolsInScope();
  const liveBees = pools.length > 0 ? await poolLiveBees() : [];
  const statuses: PoolStatus[] = [];
  for (const pool of pools) statuses.push(await poolStatus(pool, { liveBees }));

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), pools: statuses }, null, 2));
    return;
  }
  if (!isPretty()) {
    for (const s of statuses) {
      console.log(`${s.key}\t${s.pool}\t${s.repo}\t${s.branch}\t${s.size}\t${s.busy}\t${s.free}\t${s.maxOccupancy}\t${s.maxSize}`);
    }
    return;
  }
  if (statuses.length === 0) {
    console.log(dim(`No pools${scoped ? " in this project" : ""}. Create one with: pro pool create <name> [--size N]`));
    return;
  }
  console.log(formatTable(
    [
      { header: "POOL" },
      { header: "REPO" },
      { header: "BRANCH" },
      { header: "MEMBERS", align: "right" },
      { header: "OCCUPANCY" },
      { header: "CAP" },
    ],
    statuses.map((s) => [
      bold(s.pool),
      dim(`${s.area}/${s.project}/${s.repo}`),
      s.branch,
      `${s.free}/${s.size}`,
      `${s.busy > 0 ? yellow(`${s.busy} busy`) : dim("0 busy")} · ${s.free > 0 ? green(`${s.free} free`) : yellow("0 free (will extend)")}`,
      dim(`occ ${s.maxOccupancy} · max ${s.maxSize}`),
    ]),
  ));
  for (const s of statuses) {
    if (s.exceedsMaxSize) console.error(note(`pool ${s.pool} exceeds maxSize: ${s.size}/${s.maxSize} — consider cleaning or raising maxSize`));
  }
}


// ── status (the PATH-6 detail view; --json is the Apiary contract) ────────────

export async function poolStatusCmd(parsed: Parsed) {
  const ref = parsed.args[1];
  const targets = await resolveTargets(ref, false);
  if (targets.length === 0 && !truthy(flag(parsed, "json"))) {
    console.log(dim("No pools in scope. Create one with: pro pool create <name>"));
    return;
  }
  const liveBees = await poolLiveBees();
  const statuses: PoolStatus[] = [];
  for (const pool of targets) statuses.push(await poolStatus(pool, { liveBees }));
  const entries = await listProRepoEntries();
  const adhoc = await adhocCheckoutOccupancy(targets, entries, liveBees);

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), pools: statuses, adhocCheckouts: adhoc }, null, 2));
    return;
  }

  for (const s of statuses) {
    if (!isPretty()) {
      for (const m of s.members) {
        console.log(`${s.key}\t${m.n}\t${m.path}\t${m.branch}\t${memberStateLabel(m)}\t${m.occupants.join(",")}\t${m.pendingClaims.length}\t${m.dirty ? 1 : 0}`);
      }
      continue;
    }
    const cap = `occ ${s.maxOccupancy} · max ${s.maxSize}${s.exceedsMaxSize ? ` — ${yellow("EXCEEDED")}` : ""}`;
    console.log(`${bold(s.pool)} ${dim("—")} ${dim(`${s.area}/${s.project}/${s.repo}`)} @ ${s.branch} ${dim("·")} ${s.size} members ${dim("·")} ${s.busy} busy ${dim("·")} ${s.free} free ${dim(`(${cap})`)}`);
    console.log(formatTable(
      [
        { header: "N", align: "right" },
        { header: "MEMBER" },
        { header: "STATE" },
        { header: "BEES" },
        { header: "BRANCH" },
        { header: "Δ", align: "right" },
        { header: "PATH" },
      ],
      s.members.map((m) => [
        String(m.n),
        `${s.pool}-${m.n}`,
        formatMemberState(m),
        m.occupants.length > 0 ? m.occupants.join(", ") : dim("-"),
        m.branch === s.branch ? m.branch : yellow(m.branch),
        m.ahead !== undefined || m.behind !== undefined ? `${m.ahead ?? "?"}↑ ${m.behind ?? "?"}↓` : dim("-"),
        dim(tildify(m.path)),
      ]),
    ));
    console.log("");
  }

  const occupied = adhoc.filter((row) => row.occupants.length > 0);
  if (isPretty() && occupied.length > 0) {
    console.log(dim("Ad-hoc checkouts with live bees:"));
    for (const row of occupied) {
      console.log(`  ${gray("⎇")} ${row.repo}/${row.name} ${dim("·")} ${row.occupants.join(", ")} ${dim(tildify(row.path))}`);
    }
  }
}

function memberStateLabel(m: MemberOccupancy): string {
  if (m.parked) return "parked";
  if (m.occupants.length > 0) return "busy";
  if (m.pendingClaims.length > 0) return "claimed";
  return "free";
}

function formatMemberState(m: MemberOccupancy): string {
  const dirty = m.dirty ? ` ${yellow("dirty")}` : "";
  switch (memberStateLabel(m)) {
    case "parked":
      return `${gray("◌")} parked${dirty}`;
    case "busy":
      return `${green("●")} busy${dirty}`;
    case "claimed":
      return `${yellow("◍")} claimed${dirty}`;
    default:
      return `${dim("○")} free${dirty}`;
  }
}

export type AdhocCheckoutRow = {
  area: string;
  project: string;
  repo: string;
  name: string;
  path: string;
  occupants: string[];
};

/**
 * Non-pool checkouts of the target repos with derived occupancy (§6.2: "any
 * repo checkout can be marked as inhabited"). Enumerated from the same
 * `<project>/checkouts/<repo>/` layout resolveProSlotForCwd knows, minus the
 * pool member directories.
 */
async function adhocCheckoutOccupancy(pools: ResolvedPool[], entries: ProRepoEntry[], liveBees: LiveBee[]): Promise<AdhocCheckoutRow[]> {
  const memberPaths = new Set(pools.flatMap((pool) => pool.members.map((member) => member.path)));
  const repoEntries = new Map<string, ProRepoEntry>();
  for (const pool of pools) {
    const entry = entries.find((e) => e.area === pool.area && e.project === pool.project && e.repo === pool.repo);
    if (entry) repoEntries.set(entry.path, entry);
  }
  const rows: AdhocCheckoutRow[] = [];
  for (const entry of repoEntries.values()) {
    const checkoutsDir = join(dirname(dirname(entry.path)), "checkouts", basename(entry.path));
    const names = await readdir(checkoutsDir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const path = join(checkoutsDir, name);
      const real = await realpath(path).catch(() => path);
      if (memberPaths.has(path) || memberPaths.has(real)) continue;
      rows.push({
        area: entry.area,
        project: entry.project,
        repo: entry.repo,
        name,
        path: real,
        occupants: occupantsForPath(real, liveBees).map((bee) => bee.name),
      });
    }
  }
  return rows;
}


// ── spawn (what the M-p popup will run in phase 3) ────────────────────────────

export async function poolSpawnCmd(parsed: Parsed) {
  const ref = parsed.args[1];
  const bee = parsed.args[2];
  if (!ref || !bee) throw new Error("Usage: hive pool spawn <pool> <bee> [spawn flags…]  (e.g. hive pool spawn core claude --count 3)");
  const flags = new Map(parsed.flags);
  flags.set("pool", ref);
  // Delegate to the normal spawn path: allocation, claim binding, rollback,
  // --count fan-out, --here linking all behave exactly like `spawn --pool`.
  await cmdSpawn({ command: "spawn", args: [bee, ...parsed.args.slice(3)], flags, rest: parsed.rest });
}


/**
 * `hive pool launch` — the M-P popup (§6.7): pick pool → pick agent → allocate,
 * spawn, and (inside tmux) --here-link the bee's window into the caller's
 * session. Zero-free pools stay pickable and show "(will extend)".
 */
export async function poolLaunchCmd(parsed: Parsed) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive pool launch needs a TTY — bind it to a tmux popup: bind -n M-P display-popup -E "hive pool launch"');
  }
  const { pools } = await poolsInScope();
  if (pools.length === 0) {
    throw new Error("hive pool launch: no pools found. Create one with: pro pool create <name> [--size N]");
  }
  const liveBees = await poolLiveBees();
  const rows: PoolLaunchRow[] = [];
  for (const pool of pools) {
    const status = await poolStatus(pool, { liveBees });
    rows.push({
      key: status.key,
      pool: status.pool,
      capacity: poolCapacityCell(status),
      context: `${status.area}/${status.project}/${status.repo} @ ${status.branch}`,
    });
  }

  const choice = await choosePoolLaunch({ pools: rows, loadBeeOptions: loadSpawnBeeOptions });
  if (!choice) {
    if (isPretty()) console.error(note("pool launch: cancelled"));
    return;
  }

  const flags = new Map<string, string | true | string[]>([["pool", choice.poolKey]]);
  // Land the bee where the operator is: link+select via the existing --here
  // path (skipped automatically outside tmux by maybeLinkHere).
  if (process.env.TMUX) flags.set("here", true);
  await cmdSpawn({ command: "spawn", args: [choice.bee], flags, rest: [] });
}


// ── extend (manual grow; delegates to pro) ────────────────────────────────────

export async function poolExtendCmd(parsed: Parsed) {
  const ref = parsed.args[1];
  if (!ref) throw new Error("Usage: hive pool extend <pool> [N]");
  const count = parsed.args[2] !== undefined ? Number(parsed.args[2]) : 1;
  if (!Number.isInteger(count) || count < 1) throw new Error(`hive pool extend: N must be a positive integer (got ${parsed.args[2]})`);
  const pool = await resolvePoolRef(ref, process.cwd());
  const newSize = pool.members.length + count;
  if (newSize > pool.config.maxSize) {
    console.error(note(`pool ${pool.pool} exceeds maxSize: ${newSize}/${pool.config.maxSize} — consider cleaning or raising maxSize`));
  }
  const created = await extendProPool(pool.repoPath, pool.pool, count);
  if (isPretty()) console.log(actionLine("ok", "pool", [bold(pool.pool), `extended by ${created.length}`]));
  for (const path of created) console.log(path);
}


// ── sync (occupancy-aware: free members only; pools only §6.5) ────────────────

export async function poolSyncCmd(parsed: Parsed) {
  const ref = parsed.args[1];
  const all = truthy(flag(parsed, "all"));
  if (ref && all) throw new Error("hive pool sync: pass a pool OR --all, not both");
  const targets = await resolveTargets(ref, all);
  if (targets.length === 0) {
    console.log(dim("No pools to sync."));
    return;
  }
  const liveBees = await poolLiveBees();
  let anyFailed = false;
  for (const pool of targets) {
    const status = await poolStatus(pool, { liveBees });
    // Sync only UNINHABITED, unclaimed, unparked members — pro's per-member
    // dirty/parked preflight is the second net, but the occupancy guarantee
    // lives here (§7): never rebase under a live bee.
    const busy = status.members.filter((m) => m.occupants.length > 0 || m.pendingClaims.length > 0);
    const freeMembers = status.members.filter((m) => !m.parked && m.occupants.length === 0 && m.pendingClaims.length === 0);
    for (const m of busy) {
      const line = `skipped-inhabited\t${m.path}\t${m.occupants.join(",") || "claimed"}`;
      if (isPretty()) console.log(`${yellow("skipped-inhabited")} ${dim(tildify(m.path))} ${dim(m.occupants.join(", ") || "claimed")}`);
      else console.log(line);
    }
    if (freeMembers.length === 0) continue;
    // REPO:NAME qualification keeps multi-repo projects unambiguous.
    const names = freeMembers.map((m) => `${pool.repo}:${pool.pool}-${m.n}`);
    const result = await syncProCheckouts(pool.repoPath, names, { rebase: true });
    if (!result.ok) anyFailed = true;
    for (const row of result.rows) {
      if (isPretty()) {
        const color = row.status.startsWith("failed") ? yellow : row.status.startsWith("synced") ? green : dim;
        console.log(`${color(row.status)} ${dim(tildify(row.path))}${row.detail ? ` ${dim(row.detail)}` : ""}`);
      } else {
        console.log(`${row.status}\t${row.path}${row.detail ? `\t${row.detail}` : ""}`);
      }
    }
    if (!result.ok && result.detail) console.error(note(result.detail.split("\n").slice(-3).join("\n")));
  }
  if (anyFailed) process.exitCode = 1;
}


// ── claim / release / park / unpark (manual escape hatches) ───────────────────

export async function poolClaimCmd(parsed: Parsed) {
  const ref = parsed.args[1];
  if (!ref) throw new Error("Usage: hive pool claim <pool> [n] [--ttl 10m]");
  const pool = await resolvePoolRef(ref, process.cwd());
  const ttlMs = ageFlag(parsed, ["ttl"]);
  const member = parsed.args[2] !== undefined ? Number(parsed.args[2]) : undefined;
  if (member !== undefined && (!Number.isInteger(member) || member < 1)) {
    throw new Error(`hive pool claim: member must be a positive integer (got ${parsed.args[2]})`);
  }
  const allocation = member !== undefined
    ? await claimSpecificPoolMember(pool, member, ttlMs !== undefined ? { ttlMs } : {})
    : (await allocatePoolMembers(pool, 1, ttlMs !== undefined ? { ttlMs } : {}))[0]!;
  if (isPretty()) {
    console.log(actionLine("ok", "pool", [bold(`${pool.pool}-${allocation.member}`), allocation.created ? "created + claimed" : "claimed", dim(`until ${allocation.claim.pendingUntil}`)]));
  }
  console.log(allocation.path);
}


export async function poolReleaseCmd(parsed: Parsed) {
  const ref = parsed.args[1];
  const member = Number(parsed.args[2]);
  if (!ref || !Number.isInteger(member)) throw new Error("Usage: hive pool release <pool> <n>");
  const pool = await resolvePoolRef(ref, process.cwd());
  const dropped = await releasePoolMemberClaims(pool.key, member);
  if (isPretty()) console.log(actionLine("ok", "pool", [bold(`${pool.pool}-${member}`), `${dropped} claim(s) released`]));
  else console.log(`released\t${pool.key}\t${member}\t${dropped}`);
}


export async function poolParkCmd(parsed: Parsed, park: boolean) {
  const ref = parsed.args[1];
  const member = Number(parsed.args[2]);
  if (!ref || !Number.isInteger(member)) throw new Error(`Usage: hive pool ${park ? "park" : "unpark"} <pool> <n>`);
  const pool = await resolvePoolRef(ref, process.cwd());
  await setPoolMemberParked(pool, member, park);
  if (isPretty()) console.log(actionLine("ok", "pool", [bold(`${pool.pool}-${member}`), park ? "parked (withheld from allocation)" : "unparked"]));
  else console.log(`${park ? "parked" : "unparked"}\t${pool.key}\t${member}`);
}
