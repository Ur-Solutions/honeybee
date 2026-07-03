import { canonicalAgentKind } from "../agents.js";
import { hasAgentDriver, identityRecipeForAgent } from "../drivers.js";
import { listAccounts, matchAccount, type AccountRecord } from "./registry.js";

// Turning operator-typed tokens (`codex-ur`, `claude`, `minimax`, `codex2`)
// into an account + agent. The account-first keystone lives here.

export async function findAccount(idOrLabel: string, tool?: string): Promise<AccountRecord> {
  const accounts = await listAccounts();
  const pool = tool ? accounts.filter((account) => account.tool === canonicalAgentKind(tool).toLowerCase()) : accounts;
  try {
    return matchAccount(pool, idOrLabel);
  } catch (error) {
    // `<tool>-<query>` shorthand (codex-ur, claude-thto): scope the fuzzy
    // match to the tool named by the prefix. Only a fallback — a verbatim
    // id/label match above always wins.
    if (!tool) {
      const shorthand = splitToolShorthand(idOrLabel);
      if (shorthand) {
        const scoped = accounts.filter((account) => account.tool === shorthand.tool);
        try {
          return matchAccount(scoped, shorthand.query);
        } catch {
          // fall through to the original error
        }
      }
    }
    throw error;
  }
}

function splitToolShorthand(value: string): { tool: string; query: string } | undefined {
  const dash = value.indexOf("-");
  if (dash <= 0 || dash === value.length - 1) return undefined;
  const tool = canonicalAgentKind(value.slice(0, dash)).toLowerCase();
  if (!hasAgentDriver(tool) || !identityRecipeForAgent(tool)) return undefined;
  return { tool, query: value.slice(dash + 1) };
}

/**
 * Reserved account query: `--account auto` / `<tool>-auto` ask for the tool's
 * least-loaded account instead of naming one. The pick itself lives in
 * limits.ts (it needs the provider windows); this module only reserves the
 * word so it never falls through to fuzzy matching.
 */
export const AUTO_ACCOUNT_QUERY = "auto";

/**
 * Reserved account query: `--account rr` / `<tool>-rr` ask for the next account
 * in a persistent round-robin order. Unlike `auto`, the pick ignores live
 * limits and just advances a cursor through the tool's credentialed accounts —
 * useful when the operator wants to drain workload evenly across accounts
 * regardless of remaining quota. Cursor lives in `<storeRoot>/round-robin.json`.
 */
export const RR_ACCOUNT_QUERY = "rr";

/** `<tool>-auto` spawn alias → the tool whose least-loaded account to pick, else undefined. */
export function autoAccountTool(value: string): string | undefined {
  const shorthand = splitToolShorthand(value);
  return shorthand?.query === AUTO_ACCOUNT_QUERY ? shorthand.tool : undefined;
}

/** `<tool>-rr` spawn alias → the tool whose next round-robin account to pick, else undefined. */
export function roundRobinAccountTool(value: string): string | undefined {
  const shorthand = splitToolShorthand(value);
  return shorthand?.query === RR_ACCOUNT_QUERY ? shorthand.tool : undefined;
}

export type SpawnAgentSpec = {
  agent: string;
  account?: AccountRecord;
};

/**
 * Resolve a spawn-spec token into an agent plus an optional vault account.
 * An exact account id binds the account directly (`minimax`,
 * `claude-ursolutions`) — the account-first keystone. Plain tools and home
 * aliases pass through (`claude`, `cc1`, `codex2`); `<tool>-<query>` binds an
 * account by tool-scoped fuzzy match (`codex-ur`, `claude-thto`). Unknown
 * tokens pass through unchanged so arbitrary executables (`my-agent`) still
 * spawn.
 */
export async function resolveSpawnAgent(kind: string): Promise<SpawnAgentSpec> {
  // 1. Account-first (the keystone): an exact account-id match resolves the
  //    spawn to that account's CLI + account record, so every account-spawned
  //    bee is account-bound by construction. Matched on `id` ONLY — never on
  //    the free-form `label` (adversarial review fix #2). A label may legally
  //    be "claude"/"cc1"/"codex2"; matching it here would hijack the bare
  //    driver-kind token away from branch 2. Account ids are always
  //    `<tool>-<label>`, so a bare driver kind ("claude") is never an id and
  //    correctly falls through to branch 2.
  const exact = (await listAccounts()).find((account) => account.id === kind.trim());
  if (exact) return { agent: exact.tool, account: exact };
  // 2. Plain driver kind passthrough (claude, cc1, codex2) — unchanged.
  if (hasAgentDriver(canonicalAgentKind(kind).toLowerCase())) return { agent: kind };
  // 3. `<tool>-<query>` shorthand — tool-scoped fuzzy account bind — unchanged.
  const shorthand = splitToolShorthand(kind);
  if (shorthand) {
    try {
      return { agent: shorthand.tool, account: await findAccount(shorthand.query, shorthand.tool) };
    } catch {
      // not an account shorthand — treat as an arbitrary executable
    }
  }
  return { agent: kind };
}
