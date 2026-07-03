// Resolve a bee token to an agent kind plus an optional bound account, for the
// flow / loop spawn paths. This is the headless sibling of cli.ts's
// resolveSpawnAgentWithAuto: the CLI version keeps the rich usage-percent
// logging used by `hive spawn` / `hive new`, while this one is callable from the
// flow runtime (HiveFacade) and the loop runner — neither of which has the CLI's
// Parsed flags or console policy.
//
// Account binding for flow-spawned bees used to be deferred (spawnBeeForFlow
// left them account-less), which is why `hive loop launch` with `codex-auto`
// died on spawn ("Executable not found on PATH: codex-auto"). Routing every
// flow/loop spawn token through here — including the `<tool>-auto` least-loaded
// pick — closes that gap. Auto is re-evaluated on every call, so a fresh-carrier
// loop re-picks the least-loaded account each iteration (a persistent-carrier
// loop spawns once, so it naturally picks once).
import { autoAccountTool, resolveSpawnAgent, roundRobinAccountTool, type SpawnAgentSpec } from "./accounts.js";
import { pickLeastLoadedAccount } from "./limits.js";
import { pickRoundRobinAccount } from "./limits/autoPick.js";

export type ResolveSpawnSpecOptions = {
  /** Max acceptable age (ms) for cached provider limits when auto-picking; 0 = always live. */
  ttlMs?: number;
  /** Sink for the "account auto → <id>" line (stderr in the loop log; silent if omitted). */
  onNote?: (message: string) => void;
};

/**
 * Resolve a bee token to its driver kind plus an optional bound account:
 *  - `<tool>-rr`              → the tool's next round-robin account (cursor-advanced)
 *  - `<tool>-auto`            → the tool's least-loaded account (live/cached pick)
 *  - `<tool>-<account>` / id  → that account (resolveSpawnAgent)
 *  - plain kind / executable  → no account (passes through unchanged)
 * Empty input passes through untouched (consumers enforce required-ness).
 */
export async function resolveSpawnSpec(token: string, options: ResolveSpawnSpecOptions = {}): Promise<SpawnAgentSpec> {
  const trimmed = token.trim();
  if (!trimmed) return { agent: trimmed };
  const rrTool = roundRobinAccountTool(trimmed);
  if (rrTool) {
    const choice = await pickRoundRobinAccount(rrTool);
    options.onNote?.(`account rr → ${choice.account.id} — ${choice.reason}`);
    return { agent: rrTool, account: choice.account };
  }
  const autoTool = autoAccountTool(trimmed);
  if (autoTool) {
    const choice = await pickLeastLoadedAccount(autoTool, options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {});
    options.onNote?.(`account auto → ${choice.account.id} — ${choice.reason}`);
    return { agent: autoTool, account: choice.account };
  }
  return resolveSpawnAgent(trimmed);
}
