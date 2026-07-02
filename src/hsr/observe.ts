/**
 * HSR cross-process run-dir observer (APIA-78).
 *
 * The daemon, `hive bees`, and SubstrateHsr do NOT hold runner pipes — the
 * detached host does (HSR_EXPLORATION.md §7). They observe HSR bees purely by
 * reading run dirs: liveness from meta.json's host pid, snapshot from ring.txt.
 *
 * Liveness model: the HOST pid is authoritative. A bee is alive iff its meta
 * says `status: "running"` AND the host process is still alive — the host owns
 * the harness child's pipes, so a dead host means the live protocol stream is
 * gone regardless of whether the harness child lingers. "Crash adoption v1"
 * (`reapDeadHosts`) reconciles stale `running` meta with dead host pids; it does
 * not recover pipes.
 *
 * Node builtins only.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import {
  hsrMetaPath,
  hsrRingPath,
  hsrRoot,
  readHsrMeta,
  writeHsrMeta,
} from "./runDir.js";

/** Signal-0 liveness probe; EPERM means the pid exists but isn't ours. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** All bees with a run dir containing a meta.json, sorted. */
export async function listHsrBees(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(hsrRoot());
  } catch {
    return []; // no hsr root yet
  }
  const bees: string[] = [];
  for (const name of names) {
    try {
      await stat(hsrMetaPath(name));
      bees.push(name);
    } catch {
      // no meta.json (or not a dir) — not an HSR run dir
    }
  }
  return bees.sort();
}

/** bee → alive (host-pid authoritative; see file docs). */
export async function hsrLiveness(): Promise<Map<string, boolean>> {
  const liveness = new Map<string, boolean>();
  for (const bee of await listHsrBees()) {
    const meta = await readHsrMeta(bee);
    const alive = !!meta && meta.status === "running" && isPidAlive(meta.hostPid);
    liveness.set(bee, alive);
  }
  return liveness;
}

/** Tail of ring.txt (last `lines`, or all). Empty string if absent. */
export async function hsrSnapshot(bee: string, lines?: number): Promise<string> {
  let text: string;
  try {
    text = await readFile(hsrRingPath(bee), "utf8");
  } catch {
    return "";
  }
  if (lines === undefined) return text;
  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * Reconcile stale `running` meta whose host pid is dead: flip status to
 * "exited" (with endedAt) and return the reaped bee names. Crash-adoption v1 —
 * no pipe recovery.
 */
export async function reapDeadHosts(): Promise<string[]> {
  const reaped: string[] = [];
  for (const bee of await listHsrBees()) {
    const meta = await readHsrMeta(bee);
    if (!meta || meta.status !== "running") continue;
    if (isPidAlive(meta.hostPid)) continue;
    await writeHsrMeta(bee, { ...meta, status: "exited", endedAt: new Date().toISOString() });
    reaped.push(bee);
  }
  return reaped;
}
