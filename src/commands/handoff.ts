// `hive handoff` — compact a bee's thread into a summary and start a FRESH bee
// from it (session-fork-and-handoff epic). A handoff deliberately does NOT
// carry the provider thread: the summary artifact is a seal — self-written by
// the source bee (it holds the full context in-thread), or the latest existing
// seal via --from-seal — and the new bee boots from summary + an optional
// operator instruction. The spawn itself rides cmdFork's pipeline with
// `--seed summary`, so lineage, account policy, substrates, and the ledger
// behave exactly like fork (ledger type: handoff.create).

import { note } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { loadLatestSeal, scanLatestSeal } from "../seal.js";
import { resolveSelector } from "../selectors.js";
import type { SessionRecord } from "../store.js";
import { hasFlag, stringFlag } from "../cli/shared.js";
import { cmdFork } from "./fork.js";
import { cmdSend } from "./messaging.js";

const SELF_SEAL_WAIT_MS = 180_000;
const SELF_SEAL_POLL_MS = 2_500;

/** Flags forwarded verbatim from `hive handoff` to the underlying fork. */
const FORWARDED_FLAGS = ["agent", "model", "cwd", "name", "account", "node", "substrate", "here", "print", "json", "yolo", "ttl", "include-paused"] as const;

/**
 * hive handoff <bee> [-p <instruction>]
 *   [--from-seal] [--wait-ms <ms>]
 *   [--agent <kind>] [--model <m>] [--cwd <dir>] [--name <n>] [--account <a>]
 *   [--node <n>] [--substrate hsr|tmux] [--here] [--print] [--json]
 *
 * Default flow: ask the source to self-seal, wait for the artifact, then spawn
 * the new bee seeded from that seal plus the instruction. The instruction may
 * be absent — a pure compaction restart. --from-seal skips the self-seal ask
 * and uses the latest existing seal (also the fallback when the source is
 * unreachable or the wait times out and a seal exists).
 */
export async function cmdHandoff(parsed: Parsed): Promise<SessionRecord> {
  const selector = parsed.args[0];
  if (!selector) {
    throw new Error(
      "Usage: hive handoff <bee> [-p <instruction>] [--from-seal] [--wait-ms <ms>] " +
        "[--agent <kind>] [--model <m>] [--cwd <dir>] [--name <n>] [--account <a>] [--here] [--print] [--json]",
    );
  }
  if (hasFlag(parsed, "at")) {
    throw new Error(
      "hive handoff: --at (anchored handoff) is not supported yet — a self-seal summarizes the thread tip. " +
        "Use `hive fork --at` to branch from an earlier turn, or seal at the moment you want to hand off from.",
    );
  }

  const resolved = await resolveSelector(selector);
  if (resolved.kind !== "bee") throw new Error(`hive handoff: ${selector} matched multiple bees; pick one`);
  const source = resolved.record;

  const instruction = stringFlag(parsed, ["p", "prompt", "instruction"]);
  const fromSeal = truthy(flag(parsed, "from-seal"));
  const waitFlag = stringFlag(parsed, ["wait-ms"]);
  const waitMs = waitFlag !== undefined ? Number(waitFlag) : SELF_SEAL_WAIT_MS;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`hive handoff: invalid --wait-ms ${waitFlag}`);

  if (fromSeal) {
    const seal = await loadLatestSeal(source.name);
    if (!seal) throw new Error(`hive handoff: --from-seal but ${source.name} has no seal — let it self-seal (drop --from-seal) or run hive seal first`);
    console.error(note(`handoff seeds from ${source.name}'s latest seal (${seal.sealedAt})`));
  } else {
    await ensureFreshSelfSeal(source, waitMs);
  }

  // Ride the fork pipeline: --seed summary + the handoff marker/instruction.
  const flags = new Map<string, string | true | string[]>();
  flags.set("seed", "summary");
  flags.set("handoff", true);
  if (instruction !== undefined) flags.set("handoff-instruction", instruction);
  for (const key of FORWARDED_FLAGS) {
    const value = parsed.flags.get(key);
    if (value !== undefined) flags.set(key, value);
  }
  return cmdFork({ command: "fork", args: [source.name], flags, rest: [...parsed.rest] });
}

/**
 * Ask the source to seal itself and wait for the artifact. Falls back to the
 * latest existing seal (with a warning) when the source is unreachable or the
 * wait times out; refuses when there is nothing to seed from at all.
 */
async function ensureFreshSelfSeal(source: SessionRecord, waitMs: number): Promise<void> {
  const baseline = await scanLatestSeal(source.name);
  let requested = false;
  try {
    await cmdSend({ command: "send", args: [source.name, selfSealRequestText()], flags: new Map(), rest: [] });
    requested = true;
    console.error(note(`asked ${source.name} to self-seal; waiting up to ${Math.round(waitMs / 1000)}s (--wait-ms to adjust)…`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(note(`could not reach ${source.name} for a self-seal (${message})`));
  }

  if (requested) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const scan = await scanLatestSeal(source.name, { afterFilename: baseline.highWaterFilename });
      if (scan.seal) {
        console.error(note(`${source.name} sealed (${scan.seal.sealedAt}); starting the handoff`));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, SELF_SEAL_POLL_MS));
    }
    console.error(note(`${source.name} did not seal within ${Math.round(waitMs / 1000)}s`));
  }

  if (baseline.seal) {
    console.error(note(`falling back to the latest existing seal (${baseline.seal.sealedAt})`));
    return;
  }
  throw new Error(
    `hive handoff: ${source.name} did not produce a seal and has none to fall back to — ` +
      `retry with a longer --wait-ms, or seal it manually (hive seal --help) and re-run with --from-seal`,
  );
}

/** The self-seal ask delivered to the source bee. */
function selfSealRequestText(): string {
  return [
    "[handoff] Pause and record a seal of your current state NOW — a handoff will start a fresh bee from it.",
    "Compose your own seal JSON (schema: `hive seal --example`) with a THOROUGH summary — what you were doing,",
    "key decisions, exact current state — plus filesChanged, risks, and nextActions. Then run:",
    "",
    'bee="$(hive here --id)"',
    'hive seal "$bee" --from <path-to-your-seal.json>',
    "",
    "After sealing, hold — a successor bee takes over from your seal.",
  ].join("\n");
}
