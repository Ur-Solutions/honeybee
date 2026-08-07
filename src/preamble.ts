/**
 * Session preamble — the small, layered "where am I" block injected into every
 * bee at spawn (apiary/docs/epics/session-preamble.md).
 *
 * A bee wakes up knowing nothing: not its own id, not that other bees exist,
 * not that a host application (Apiary) is wired to it. Env vars carry some of
 * it (stampBeeIdentityEnv), but nothing tells the bee to read them. The
 * preamble is the smallest text that fixes that.
 *
 * It is deliberately NOT the manual. Deep conceptual knowledge ships as kit
 * skills, and live truth comes from introspection tools; the preamble only
 * makes a bee know those exist, plus the handful of facts it cannot derive.
 *
 * AUTHORING RULE — every line either states a fact the agent cannot derive, or
 * names exactly one command/tool to call for the rest. No explanations: an
 * explanation costs tokens in EVERY session, where a skill costs them only in
 * the sessions that need it. `defaultPreambleWithinBudget` (tests) is the
 * mechanical backstop.
 */

/**
 * Soft budget for a rendered preamble. Deliberately soft: `renderPreamble`
 * reports `overBudget` but never truncates — a preamble cut mid-sentence is
 * worse than a long one, and no spawn should fail over a text budget. Callers
 * warn; the settings UI shows the count; a unit test pins the default render.
 */
export const PREAMBLE_MAX_CHARS = 1200;

/** Honeybee-owned wrapper tags: identifiable in a transcript and strippable. */
export const PREAMBLE_OPEN_TAG = "<hive-session>";
export const PREAMBLE_CLOSE_TAG = "</hive-session>";

/**
 * Hosts may frame their opaque layer with their own sibling `*-session`
 * envelope (for example Apiary's `<apiary-session>`). Honeybee preserves a
 * complete host envelope instead of nesting it inside `<hive-session>`.
 */
const SESSION_ENVELOPE = /^<([a-z][a-z0-9-]*-session)>\n?[\s\S]*?\n?<\/\1>$/i;

export function isSessionPreambleEnvelope(text: string): boolean {
  return SESSION_ENVELOPE.test(text.trim());
}

/**
 * How a preamble reaches the bee.
 * - `system-prompt`: the harness has an append-to-system-prompt flag, so the
 *   text rides argv and survives resume/revive/compaction for free.
 * - `message`: no such flag — the text is prepended ONCE to the bee's first
 *   delivered text (brief, or first `hive x`/`run` prompt).
 */
export type PreambleChannel = "system-prompt" | "message";

/** The facts a bee cannot derive about itself. */
export type PreambleIdentity = {
  /** Display name other bees address (safeName of the record). */
  name: string;
  /** Canonical bee id, e.g. `CL.a1b`. */
  id: string;
  /** Comb the bee belongs to; omitted from the text when it equals `name`. */
  comb?: string;
  /** Spawning bee's id, when this bee was spawned by another bee. */
  parent?: string;
};

export type PreambleLayers = {
  /** L0 — honeybee's own identity layer. Omit to disable it. */
  identity?: PreambleIdentity;
  /**
   * L1/L2 — opaque text from the spawning environment (Apiary's host layer).
   * Honeybee never parses or interprets its body. A complete host-owned
   * `*-session` envelope is preserved; legacy plain text is framed as Hive.
   */
  host?: string;
  /** L3 — the operator's custom text (config.json `preamble.text`). */
  custom?: string;
};

export type RenderedPreamble = {
  /** The full wrapped block, or "" when no layer had anything to say. */
  text: string;
  /** Length of `text` (0 when empty). */
  chars: number;
  /** True when `chars` exceeds the budget. Advisory — nothing truncates. */
  overBudget: boolean;
};

/**
 * L0. Facts only, plus the one command a bee constantly needs and would
 * otherwise guess wrong (buz's selector/sender/tier shape is not derivable).
 */
export function identityLayer(identity: PreambleIdentity): string {
  const lines = [
    `You are a Honeybee bee: id ${identity.id}, name "${identity.name}". Other bees and the operator address you by that name.`,
  ];
  if (identity.comb && identity.comb !== identity.name) {
    lines.push(`You are in comb "${identity.comb}".`);
  }
  if (identity.parent) {
    lines.push(`You were spawned by ${identity.parent}; report back to it when your work is done.`);
  }
  lines.push(
    `Message another bee: \`hive buz send <bee> --sender ${identity.name} -p "<message>"\`. Read yours: \`hive buz inbox ${identity.name}\`.`,
  );
  return lines.join("\n");
}

/**
 * Compose the layers into strippable envelopes. Legacy/plain host text keeps
 * the original single `<hive-session>` block and fixed identity → host → custom
 * order. A host-owned `*-session` envelope becomes a sibling of the single Hive
 * block containing all Honeybee-owned text, so neither system has to parse the
 * other's content and each owner appears exactly once. The source grouping
 * means Honeybee custom text precedes a framed host; legacy ordering is
 * unchanged for an unframed host.
 * Empty/whitespace layers drop out entirely.
 */
export function renderPreamble(layers: PreambleLayers, opts: { maxChars?: number } = {}): RenderedPreamble {
  const identity = layers.identity ? identityLayer(layers.identity) : "";
  const host = layers.host?.trim() ?? "";
  const custom = layers.custom?.trim() ?? "";
  const framedHost = host && isSessionPreambleEnvelope(host) ? host : "";
  const wrapHive = (parts: string[]): string =>
    parts.length > 0 ? `${PREAMBLE_OPEN_TAG}\n${parts.join("\n\n")}\n${PREAMBLE_CLOSE_TAG}` : "";

  const sections = framedHost
    ? [wrapHive([identity, custom].filter(Boolean)), framedHost]
    : [wrapHive([identity, host, custom].filter(Boolean))];
  const text = sections.filter(Boolean).join("\n\n");
  if (!text) return { text: "", chars: 0, overBudget: false };

  const maxChars = opts.maxChars ?? PREAMBLE_MAX_CHARS;
  return { text, chars: text.length, overBudget: text.length > maxChars };
}

/**
 * Prepend a preamble to a bee's first delivered text (the `message` channel).
 * Separated by a blank line so the harness reads two distinct blocks. A bee
 * with no first text still gets the preamble as its whole first message.
 */
export function prependPreamble(text: string | undefined, preamble: string): string {
  const body = text?.trim() ?? "";
  if (!preamble) return body;
  return body ? `${preamble}\n\n${body}` : preamble;
}

/**
 * Whether a blob already carries a preamble block. Guards the message channel
 * against double-injection when a caller re-delivers a brief.
 */
export function hasPreamble(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  return /^\s*<[a-z][a-z0-9-]*-session>/i.test(text);
}
