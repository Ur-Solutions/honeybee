/**
 * `<tool>-rr` / `--account rr`: pick the next account in a persistent
 * round-robin order, advancing a cursor stored on disk. Sibling of the
 * least-loaded picker in limits.ts, but explicitly NOT limits-aware: the
 * operator wants the workload spread evenly across accounts regardless of
 * remaining quota.
 *
 * The cursor lives in `<storeRoot>/round-robin.json` as `{ [tool]: { lastAccountId } }`,
 * serialized by a file lock so two concurrent spawns can't pick the same
 * account or skip one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalAgentKind } from "./agents.js";
import { accountHasCredentials, listAccounts, type AccountRecord } from "./accounts.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";

export type RoundRobinChoice = {
  account: AccountRecord;
  reason: string;
};

type CursorFile = Record<string, { lastAccountId?: string } | undefined>;

function cursorPath(): string {
  return join(storeRoot(), "round-robin.json");
}

function cursorLockPath(): string {
  return join(storeRoot(), ".round-robin.lock");
}

async function readCursor(): Promise<CursorFile> {
  try {
    const raw = await readFile(cursorPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CursorFile;
  } catch {
    return {};
  }
}

async function writeCursor(cursor: CursorFile): Promise<void> {
  await atomicWriteFile(cursorPath(), `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Pick the next account in round-robin order for `tool`, advancing and
 * persisting the cursor. Candidate set mirrors {@link pickLeastLoadedAccount}:
 * registered + credentialed accounts only, sorted stably by `addedAt` (then
 * `id`) so the cycle order is deterministic across hosts and registrations.
 *
 * Throws with the same error shapes as the auto picker when no candidates
 * exist / no candidate has credentials.
 */
export async function pickRoundRobinAccount(tool: string): Promise<RoundRobinChoice> {
  const kind = canonicalAgentKind(tool).toLowerCase();
  const registered = (await listAccounts()).filter((account) => account.tool === kind);
  if (registered.length === 0) {
    throw new Error(`No ${kind} accounts registered; add one with: hive account add ${kind} <label>`);
  }
  const candidates: AccountRecord[] = [];
  for (const account of registered) {
    if (await accountHasCredentials(account)) candidates.push(account);
  }
  if (candidates.length === 0) {
    throw new Error(`No ${kind} account has vaulted credentials; capture some with: hive login <account>`);
  }
  candidates.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id));
  // A single candidate cycle is a no-op; still update the cursor so a later
  // registration starts cleanly from a known anchor.
  return withFileLock(cursorLockPath(), async () => {
    const cursor = await readCursor();
    const prevId = cursor[kind]?.lastAccountId;
    const prevIndex = prevId ? candidates.findIndex((a) => a.id === prevId) : -1;
    const nextIndex = (prevIndex + 1) % candidates.length;
    const chosen = candidates[nextIndex]!;
    const next: CursorFile = { ...cursor, [kind]: { lastAccountId: chosen.id } };
    await writeCursor(next);
    const reason = prevId
      ? `round-robin: next after ${prevId}`
      : candidates.length === 1
        ? `only ${kind} account with credentials`
        : "round-robin: first pick";
    return { account: chosen, reason };
  });
}
