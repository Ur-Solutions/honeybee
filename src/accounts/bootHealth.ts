import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";

export const ACCOUNT_BOOT_FAILURE_COOLDOWN_MS = 10 * 60_000;

export type AccountBootFailure = {
  failedAt: string;
  /** Absent records were written by older builds and mean adapter boot. */
  stage?: "boot" | "activation";
};

type AccountBootHealthFile = Record<string, AccountBootFailure | undefined>;

export function accountBootHealthPath(): string {
  return join(storeRoot(), "account-boot-health.json");
}

function accountBootHealthLockPath(): string {
  return `${accountBootHealthPath()}.lock`;
}

async function readAccountBootHealthFile(): Promise<AccountBootHealthFile> {
  const raw = await readFile(accountBootHealthPath(), "utf8").catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const file: AccountBootHealthFile = {};
    for (const [accountId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const failedAt = (value as Record<string, unknown>).failedAt;
      const stage = (value as Record<string, unknown>).stage;
      if (typeof failedAt === "string" && Number.isFinite(Date.parse(failedAt))) {
        file[accountId] = {
          failedAt,
          ...(stage === "boot" || stage === "activation" ? { stage } : {}),
        };
      }
    }
    return file;
  } catch {
    return {};
  }
}

function isRecent(failure: AccountBootFailure, now: number, cooldownMs: number): boolean {
  return now - Date.parse(failure.failedAt) < cooldownMs;
}

/** Recent failures keyed by account id; malformed and expired entries are ignored. */
export async function recentAccountBootFailures(
  now = Date.now(),
  cooldownMs = ACCOUNT_BOOT_FAILURE_COOLDOWN_MS,
): Promise<Map<string, AccountBootFailure>> {
  const file = await readAccountBootHealthFile();
  return new Map(Object.entries(file).filter((entry): entry is [string, AccountBootFailure] =>
    entry[1] !== undefined && isRecent(entry[1], now, cooldownMs)));
}

/** Record the latest failed account-startup stage, pruning expired entries. */
export async function recordAccountBootFailure(
  accountId: string,
  now = Date.now(),
  stage: "boot" | "activation" = "boot",
): Promise<void> {
  await withFileLock(accountBootHealthLockPath(), async () => {
    const file = await readAccountBootHealthFile();
    const kept: AccountBootHealthFile = {};
    for (const [id, failure] of Object.entries(file)) {
      if (failure && isRecent(failure, now, ACCOUNT_BOOT_FAILURE_COOLDOWN_MS)) kept[id] = failure;
    }
    kept[accountId] = { failedAt: new Date(now).toISOString(), stage };
    await atomicWriteFile(accountBootHealthPath(), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  });
}

/** A proven-successful startup stage closes only its matching breaker. */
export async function clearAccountBootFailure(
  accountId: string,
  stage?: "boot" | "activation",
  /** Do not let an older success erase a newer concurrent failure. */
  observedBefore?: number,
): Promise<void> {
  await withFileLock(accountBootHealthLockPath(), async () => {
    const file = await readAccountBootHealthFile();
    const current = file[accountId];
    if (!current) return;
    const currentStage = current.stage ?? "boot";
    if (stage !== undefined && stage !== currentStage) return;
    if (observedBefore !== undefined && Date.parse(current.failedAt) >= observedBefore) return;
    delete file[accountId];
    await atomicWriteFile(accountBootHealthPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  });
}
