import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { storeRoot } from "../fsx.js";
import type { AccountRecord } from "./registry.js";

// Where an account's credentials materialize on disk: dedicated hive slots and
// the shared `~/.{tool}` homes a machine may already have.

/** All `~/.{tool}` / `~/.{tool}-N` style shared homes present on this machine. */
export async function candidateHomes(tool: string): Promise<string[]> {
  const homes: string[] = [];
  const candidates = [join(homedir(), `.${tool}`)];
  for (let slot = 1; slot <= 9; slot += 1) candidates.push(join(homedir(), `.${tool}-${slot}`));
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) homes.push(candidate);
  }
  return homes;
}

export function dedicatedHomesFor(account: AccountRecord): string[] {
  return [join(storeRoot(), "homes", account.id), join(storeRoot(), "login-homes", account.id)];
}

export function isDedicatedHomeForAccount(account: AccountRecord, homePath: string): boolean {
  const target = resolve(homePath);
  return dedicatedHomesFor(account).some((dir) => resolve(dir) === target);
}

/** Default dedicated home slot for an account when no --home is given. */
export function defaultHomeForAccount(account: AccountRecord): string {
  return join(storeRoot(), "homes", account.id);
}
