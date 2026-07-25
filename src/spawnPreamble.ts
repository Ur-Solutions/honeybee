/**
 * Spawn-time composition of the session preamble: config + identity + the
 * spawning environment's host layer, resolved against the harness's delivery
 * channel. Kept out of preamble.ts so that module stays pure (no config/driver
 * reads) and trivially testable.
 *
 * Both `hive spawn` and `hive fork` call this at the same point in their
 * sequence: AFTER the bee identity is allocated and stamped (the preamble
 * quotes the id), BEFORE the SessionRecord is built. A fork therefore RE-renders
 * with the new bee's identity rather than inheriting its parent's text.
 */

import { preambleConfig } from "./config.js";
import { preambleChannelForAgent, systemPromptArgsForAgent } from "./drivers.js";
import { hasPreamble, prependPreamble, renderPreamble, type PreambleIdentity } from "./preamble.js";
import { updateSession, type SessionPreamble, type SessionRecord } from "./store.js";

export type SpawnPreambleInput = {
  /** Canonical agent kind (spec.kind) — decides the delivery channel. */
  kind: string;
  identity: PreambleIdentity;
  /** Host layer from the spawning environment (`--preamble`), verbatim. */
  host?: string;
  /** `--no-preamble`: skip entirely for this spawn. */
  disabled?: boolean;
  /** Over-budget notice sink. Never fatal — a spawn must not fail over text. */
  warn?: (message: string) => void;
};

export type SpawnPreamblePlan = {
  /** Persisted on the SessionRecord. */
  record: SessionPreamble;
  /**
   * Args to append to BOTH spec.args (this launch) and launchArgv (so revive
   * re-applies them). Empty for the `message` channel.
   */
  args: string[];
};

/**
 * Resolve the preamble for one spawn, or null when there is nothing to inject
 * (disabled by flag or config, or every layer empty).
 */
export function planSpawnPreamble(input: SpawnPreambleInput): SpawnPreamblePlan | null {
  if (input.disabled) return null;
  // Process-wide kill switch, same shape as HIVE_KIT_DISABLE. For debugging a
  // harness against a byte-identical bare invocation, and for tests that assert
  // on the exact text a bee receives.
  if (process.env.HIVE_PREAMBLE_DISABLE === "1") return null;
  const config = preambleConfig();
  if (!config.enabled) return null;

  const rendered = renderPreamble(
    {
      ...(config.identity ? { identity: input.identity } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(config.text ? { custom: config.text } : {}),
    },
    config.maxChars !== undefined ? { maxChars: config.maxChars } : {},
  );
  if (!rendered.text) return null;
  if (rendered.overBudget) {
    input.warn?.(
      `session preamble for ${input.identity.name} is ${rendered.chars} chars (budget ${config.maxChars ?? "default"}); it is injected anyway — trim it with \`hive config\` preamble.text or the host's settings`,
    );
  }

  const channel = preambleChannelForAgent(input.kind);
  const args = channel === "system-prompt" ? (systemPromptArgsForAgent(input.kind, rendered.text) ?? []) : [];
  return {
    record: { text: rendered.text, channel },
    args,
  };
}

/**
 * Message-channel delivery: fold a pending preamble into the bee's FIRST
 * delivered text and mark it consumed, so a second delivery does not repeat it.
 *
 * A no-op (returns `text` unchanged) when the bee has no preamble, took the
 * system-prompt channel, already consumed it, or when the text visibly carries
 * one already — the last guard covers callers that re-send a stored brief.
 *
 * The `delivered` flag is persisted BEFORE the caller sends, so a send that
 * fails does not leave the preamble armed for an unrelated later message; the
 * bee losing one preamble is cheaper than a bee seeing it twice mid-session.
 */
export async function consumePreambleForDelivery(record: SessionRecord, text: string): Promise<string> {
  const preamble = record.preamble;
  if (!preamble || preamble.channel !== "message" || preamble.delivered) return text;
  if (hasPreamble(text)) return text;
  await updateSession(record.name, { preamble: { ...preamble, delivered: true } });
  return prependPreamble(text, preamble.text);
}
