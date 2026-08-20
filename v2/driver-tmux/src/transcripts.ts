/**
 * Transcript-file observers (WP5, spec 05 observation source 2 — the
 * MANDATORY baseline for every supported harness under A3).
 *
 * Every harness CLI writes session/transcript files; the adapter tails the
 * bee's transcript and derives turn boundaries + output recency from file
 * truth. Formats below are distilled from the v1 tree's transcript layer
 * (src/transcripts/{claude,codex,grok}.ts and src/threadCopy.ts, read-only
 * reference — v2 imports nothing from it).
 *
 * Per-harness confidence (documented per the spec):
 *
 *  - claude  — HIGH (format). Path `~/.claude/projects/<projectKey>/<sessionId>.jsonl`,
 *    projectKey = resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g,"-").
 *    Rows `{type:"user"|"assistant", timestamp, message:{role,content},
 *    sessionId, uuid, isSidechain?, isMeta?}`. Turn start = user row that is
 *    not a sidechain/meta row and carries real text (v1 threadCopy.ts
 *    isTurnStartRow). NO explicit turn-end record exists in the file —
 *    turn_ended is quiescence-derived here, and the v1 incident record
 *    (2026-07-13: claude emits mid-turn lulls during long tool chains) is
 *    why hooks (Stop) are the preferred source when present. Confidence on
 *    quiescence-derived ends: MEDIUM — verify against a live stream in the
 *    WP5 manual smoke.
 *
 *  - codex   — HIGH. Path `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
 *    Rows `{timestamp, type, payload}`: `turn_context` marks a turn start,
 *    `event_msg`/`task_started` its prelude, `event_msg`/`task_complete` an
 *    EXPLICIT turn end, `event_msg`/`agent_message` + `response_item`
 *    assistant messages are output. (Messages appear twice — event_msg and
 *    response_item — which the phase machine dedups naturally.)
 *
 *  - grok    — MEDIUM (fixture-derived; the transcript-only observer
 *    PATTERN). Path `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl`
 *    with a sibling summary.json. Rows: role from `message.role ?? type`,
 *    content string or `[{type:"text",text}]` blocks. No explicit end →
 *    quiescence-derived, like claude. Shapes come from v1's fixtures
 *    (tests/transcripts.test.ts), NOT from a captured live stream — verify
 *    in a real-grok smoke before relying on it in production.
 */
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { createCodexProjector } from "./codex-projection.ts";
import type { TranscriptProjectedEvent, TranscriptProjector } from "./transcript-projection.ts";

export type TranscriptEvent =
  | { kind: "turn_started" }
  | { kind: "turn_ended" }
  /** Output/recency evidence (assistant text, tool traffic, …). */
  | { kind: "output" };

export interface TranscriptParser {
  readonly harness: string;
  /**
   * Whether this format carries an explicit turn-completion record. When
   * false the observer derives turn_ended from quiescence (no appends for
   * the configured window after output was seen).
   */
  readonly explicitTurnEnd: boolean;
  /** Pure, stateless: one raw transcript line → zero or more events. */
  parseLine(line: string): TranscriptEvent[];
}

function jsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Partial/corrupt line while the provider is still writing — skip
    // (the v1 readJsonl tolerance).
  }
  return null;
}

/** v1 threadCopy.isTurnStartRow: real user text, not tool-result carriage. */
function hasUserText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(
      (b) => b != null && typeof b === "object" && (b as { type?: unknown }).type === "text",
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// claude — ~/.claude/projects/<projectKey>/<sessionId>.jsonl
// ---------------------------------------------------------------------------

export const claudeTranscriptParser: TranscriptParser = {
  harness: "claude",
  explicitTurnEnd: false,
  parseLine(line: string): TranscriptEvent[] {
    const row = jsonLine(line);
    if (!row) return [];
    if (row.isSidechain === true || row.isMeta === true) return [];
    const message = row.message as { content?: unknown } | undefined;
    if (row.type === "user" && hasUserText(message?.content)) return [{ kind: "turn_started" }];
    if (row.type === "assistant") return [{ kind: "output" }];
    return [];
  },
};

/**
 * Canonical cwd for cwd-derived transcript locator paths: resolved AND
 * realpathed. Harness CLIs key their transcript dirs off `process.cwd()`,
 * which the OS reports symlink-free — on macOS a `/var/...` spawn cwd
 * becomes `/private/var/...` inside the CLI (verified live 2026-08-17:
 * claude wrote `projects/-private-var-folders-...` while our raw-path key
 * bound nothing). Falls back to the resolved raw path when realpath throws
 * (path not created yet).
 */
export function canonicalCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** The v1 project-key derivation for a claude transcript dir (realpathed cwd). */
export function claudeProjectKey(cwd: string): string {
  return canonicalCwd(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
}

// ---------------------------------------------------------------------------
// codex — ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// ---------------------------------------------------------------------------

export const codexTranscriptParser: TranscriptParser = {
  harness: "codex",
  explicitTurnEnd: true,
  parseLine(line: string): TranscriptEvent[] {
    const row = jsonLine(line);
    if (!row) return [];
    if (typeof row.method === "string") {
      if (row.method === "turn/started") return [{ kind: "turn_started" }];
      if (row.method === "turn/completed") return [{ kind: "turn_ended" }];
      if (row.method === "item/completed") {
        const item = (row.params as { item?: { type?: unknown } } | undefined)?.item;
        if (
          item?.type === "agentMessage"
          || item?.type === "commandExecution"
          || item?.type === "mcpToolCall"
          || item?.type === "fileChange"
          || item?.type === "webSearch"
        ) {
          return [{ kind: "output" }];
        }
      }
      // turn/start is a client request without a native turn id. Deltas,
      // account updates, and other app-server traffic are not state edges.
      return [];
    }
    const payload = row.payload as { type?: unknown; role?: unknown } | undefined;
    if (row.type === "turn_context") return [{ kind: "turn_started" }];
    if (row.type === "event_msg") {
      if (payload?.type === "task_started") return [{ kind: "turn_started" }];
      if (payload?.type === "task_complete") return [{ kind: "turn_ended" }];
      if (payload?.type === "agent_message") return [{ kind: "output" }];
      return [];
    }
    if (row.type === "response_item" && payload?.type === "message" && payload.role === "assistant") {
      return [{ kind: "output" }];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// grok — ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/chat_history.jsonl
// (the transcript-only PATTERN: fixture-driven, no explicit end record)
// ---------------------------------------------------------------------------

export const grokTranscriptParser: TranscriptParser = {
  harness: "grok",
  explicitTurnEnd: false,
  parseLine(line: string): TranscriptEvent[] {
    const row = jsonLine(line);
    if (!row) return [];
    const message = row.message as { role?: unknown; content?: unknown } | undefined;
    const role = typeof message?.role === "string" ? message.role : row.type;
    const content = message?.content ?? row.content;
    // Live-file finding (2026-08-17 tmux smoke prep): grok appends SYNTHETIC
    // user rows (`synthetic_reason: "system_reminder" | "task_completed" | …`)
    // for injected context — real user text shape, but not a prompt. They can
    // arrive while idle with no response following, so treating them as turn
    // starts would open a turn that never ends (quiescence needs output).
    if (role === "user" && row.synthetic_reason != null) return [];
    if (role === "user" && hasUserText(content)) return [{ kind: "turn_started" }];
    if (role === "assistant") return [{ kind: "output" }];
    return [];
  },
};

export const TRANSCRIPT_PARSERS: Record<string, TranscriptParser> = {
  claude: claudeTranscriptParser,
  codex: codexTranscriptParser,
  grok: grokTranscriptParser,
};

// ---------------------------------------------------------------------------
// rendering — readable turns from a session-log / transcript jsonl line
// (the CLI's `transcript`/`last` verbs; same format knowledge as the parsers
// above, extended to TEXT extraction: sender/assistant text kept, tool
// traffic elided to one-liners)
// ---------------------------------------------------------------------------

export type TranscriptTurnRole = "user" | "assistant" | "tool" | "system";

export interface TranscriptTurn {
  role: TranscriptTurnRole;
  text: string;
}

export interface TranscriptRenderer {
  readonly harness: string;
  /** Pure, stateless: one raw jsonl line → zero or more readable turns. */
  renderLine(line: string): TranscriptTurn[];
}

/**
 * Content blocks (claude message.content and friends) → readable turns.
 * Text blocks join into one turn of `role`; tool blocks become one-liners.
 */
function turnsFromBlocks(role: TranscriptTurnRole, content: unknown): TranscriptTurn[] {
  if (typeof content === "string") {
    return content.trim().length > 0 ? [{ role, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const turns: TranscriptTurn[] = [];
  const texts: string[] = [];
  for (const b of content) {
    if (b == null || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.trim().length > 0) texts.push(block.text);
        break;
      case "input_text":
      case "output_text":
        if (typeof block.text === "string" && block.text.trim().length > 0) texts.push(block.text);
        break;
      case "tool_use":
        turns.push({ role: "tool", text: `[tool_use: ${typeof block.name === "string" ? block.name : "?"}]` });
        break;
      case "tool_result":
        turns.push({ role: "tool", text: "[tool_result]" });
        break;
      case "thinking":
      case "redacted_thinking":
        break; // elided
      default:
        break;
    }
  }
  if (texts.length > 0) turns.unshift({ role, text: texts.join("\n") });
  return turns;
}

/**
 * claude — handles BOTH the native stream-json envelope the HSR driver logs
 * verbatim ({type:"assistant"|"user"|"result"|"system", message:{content}})
 * and the transcript-file rows (~/.claude/projects/…): the two shapes agree
 * on type + message.content. `result` rows duplicate the final assistant
 * text and are skipped; system/thinking rows are elided.
 */
export const claudeTranscriptRenderer: TranscriptRenderer = {
  harness: "claude",
  renderLine(line: string): TranscriptTurn[] {
    const row = jsonLine(line);
    if (!row) return [];
    if (row.isSidechain === true || row.isMeta === true) return [];
    const message = row.message as { content?: unknown } | undefined;
    if (row.type === "user") return turnsFromBlocks("user", message?.content);
    if (row.type === "assistant") return turnsFromBlocks("assistant", message?.content);
    return [];
  },
};

/**
 * codex — rollout rows {timestamp, type, payload}. Rendering prefers the
 * `response_item` rows (both roles appear there); `event_msg`/`agent_message`
 * duplicates the assistant text and is skipped. function calls → one-liners.
 */
export const codexTranscriptRenderer: TranscriptRenderer = {
  harness: "codex",
  renderLine(line: string): TranscriptTurn[] {
    const row = jsonLine(line);
    if (!row) return [];
    // hsr substrate: the session log records the codex APP-SERVER protocol
    // (jsonrpc notifications), not the rollout file. `item/completed` carries
    // the same turns under a different envelope; `turn/completed` re-lists
    // them and is skipped to avoid duplicates (2026-08-19 soak finding —
    // `last`/`transcript` were blind to hsr codex output).
    if (typeof row.method === "string") {
      if (row.method !== "item/completed") return [];
      const item = (row.params as { item?: Record<string, unknown> } | undefined)?.item;
      if (!item || typeof item.type !== "string") return [];
      if (item.type === "agentMessage") {
        return typeof item.text === "string" && item.text.trim().length > 0
          ? [{ role: "assistant", text: item.text }]
          : [];
      }
      if (item.type === "userMessage") return turnsFromBlocks("user", item.content);
      if (item.type === "commandExecution") {
        return [{ role: "tool", text: `[command: ${typeof item.command === "string" ? item.command : "?"}]` }];
      }
      if (item.type === "mcpToolCall") {
        const inv = item.invocation as { tool?: unknown } | undefined;
        return [{ role: "tool", text: `[tool_use: ${typeof inv?.tool === "string" ? inv.tool : "?"}]` }];
      }
      if (item.type === "fileChange") return [{ role: "tool", text: "[file_change]" }];
      return []; // reasoning, webSearch previews etc: elided
    }
    if (row.type !== "response_item") return [];
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload) return [];
    if (payload.type === "message") {
      const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : null;
      return role ? turnsFromBlocks(role, payload.content) : [];
    }
    if (payload.type === "function_call") {
      return [{ role: "tool", text: `[tool_use: ${typeof payload.name === "string" ? payload.name : "?"}]` }];
    }
    if (payload.type === "function_call_output") return [{ role: "tool", text: "[tool_result]" }];
    return []; // reasoning etc: elided
  },
};

/** grok — chat_history rows; synthetic user rows (injected context) elided. */
export const grokTranscriptRenderer: TranscriptRenderer = {
  harness: "grok",
  renderLine(line: string): TranscriptTurn[] {
    const row = jsonLine(line);
    if (!row) return [];
    // hsr substrate: the session log is Grok ACP JSON-RPC (`grok agent stdio`),
    // not chat_history.jsonl. `session/update` carries the same turns as
    // chunks; `session/prompt` is stdin and is not logged.
    if (typeof row.method === "string") {
      // Client→server session/prompt (logged from stdin) is the operator's turn.
      if (row.method === "session/prompt") {
        const params = row.params as { prompt?: unknown } | undefined;
        const prompt = params?.prompt;
        const texts: string[] = [];
        if (typeof prompt === "string" && prompt.trim()) texts.push(prompt);
        else if (Array.isArray(prompt)) {
          for (const block of prompt) {
            if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
              const text = (block as { text: string }).text.trim();
              if (text) texts.push(text);
            }
          }
        }
        return texts.map((text) => ({ role: "user" as const, text }));
      }
      if (row.method !== "session/update" && row.method !== "_x.ai/session/update" && row.method !== "x.ai/session/update") {
        return [];
      }
      const params = row.params as Record<string, unknown> | undefined;
      const update = (params?.update as Record<string, unknown> | undefined) ?? params;
      if (!update) return [];
      const kind = update.sessionUpdate ?? update.session_update ?? update.type;
      const content = update.content;
      const text = (content && typeof content === "object" && !Array.isArray(content)
        ? (content as { text?: unknown }).text
        : undefined) ?? update.text;
      if (kind === "agent_message_chunk" || kind === "agent_message") {
        return typeof text === "string" && text.trim().length > 0 ? [{ role: "assistant", text }] : [];
      }
      if (kind === "user_message_chunk" || kind === "user_message") {
        return typeof text === "string" && text.trim().length > 0 ? [{ role: "user", text }] : [];
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const title = typeof update.title === "string" ? update.title
          : typeof update.kind === "string" ? update.kind : "tool";
        return [{ role: "tool", text: `[tool_use: ${title}]` }];
      }
      return [];
    }
    if (row.synthetic_reason != null) return [];
    const message = row.message as { role?: unknown; content?: unknown } | undefined;
    const role = typeof message?.role === "string" ? message.role : row.type;
    const content = message?.content ?? row.content;
    if (role === "user") return turnsFromBlocks("user", content);
    if (role === "assistant") return turnsFromBlocks("assistant", content);
    return [];
  },
};

/** stub — the test agent's NDJSON ({event:"text"|"error"|…}); text = assistant output. */
export const stubTranscriptRenderer: TranscriptRenderer = {
  harness: "stub",
  renderLine(line: string): TranscriptTurn[] {
    const row = jsonLine(line);
    if (!row || typeof row.event !== "string") return [];
    if (row.event === "text" && typeof row.text === "string") return [{ role: "assistant", text: row.text }];
    if (row.event === "error") return [{ role: "system", text: `[error: ${String(row.message ?? "?")}]` }];
    return [];
  },
};

export const TRANSCRIPT_RENDERERS: Record<string, TranscriptRenderer> = {
  claude: claudeTranscriptRenderer,
  codex: codexTranscriptRenderer,
  grok: grokTranscriptRenderer,
  stub: stubTranscriptRenderer,
};

/**
 * Render a batch of raw jsonl lines for a harness. An unknown harness falls
 * back to the claude-shaped projector (the most common envelope) — callers
 * can always reach the verbatim lines with `--raw`.
 */
function projectorFromRenderer(renderer: TranscriptRenderer): TranscriptProjector {
  return {
    harness: renderer.harness,
    pushLine(line: string): TranscriptProjectedEvent[] {
      return renderer.renderLine(line).map((turn): TranscriptProjectedEvent => {
        if (turn.role === "tool") {
          return { kind: "unknown", ts: null, nativeType: "rendered_tool", detail: turn.text };
        }
        return { kind: "message", ts: null, role: turn.role, text: turn.text };
      });
    },
    flush(): TranscriptProjectedEvent[] {
      return [];
    },
  };
}

/** The single harness registry for pane and CLI transcript projection. */
export function createTranscriptProjector(harness: string): TranscriptProjector {
  switch (harness) {
    case "codex":
      return createCodexProjector();
    case "grok":
      return projectorFromRenderer(grokTranscriptRenderer);
    case "stub":
      return projectorFromRenderer(stubTranscriptRenderer);
    case "claude":
    default:
      return projectorFromRenderer(claudeTranscriptRenderer);
  }
}

export function renderTranscriptLines(harness: string, lines: readonly string[]): TranscriptTurn[] {
  const projector = createTranscriptProjector(harness);
  const events = lines.flatMap((line) => projector.pushLine(line));
  events.push(...projector.flush());
  return events.flatMap(turnsFromProjectedEvent);
}

function turnsFromProjectedEvent(event: TranscriptProjectedEvent): TranscriptTurn[] {
  switch (event.kind) {
    case "message":
      return event.role === "developer" ? [] : [{ role: event.role, text: event.text }];
    case "shell":
      if (event.status === "started") {
        return [{ role: "tool", text: `[command: ${event.command ?? "?"}]` }];
      }
      return [{
        role: "tool",
        text: `[command_result: ${event.exitCode === undefined ? "?" : `exit ${event.exitCode}`}]`,
      }];
    case "tool_call":
      return [{ role: "tool", text: `[tool_use: ${event.name}]` }];
    case "tool_result":
      return [{ role: "tool", text: `[tool_result]` }];
    case "file_edit": {
      const paths = event.files.map((file) => file.path);
      return [{ role: "tool", text: paths.length > 0 ? `[file_change: ${paths.join(", ")}]` : "[file_change]" }];
    }
    case "compaction":
      return [{ role: "system", text: `[compaction${event.trigger ? `: ${event.trigger}` : ""}]` }];
    case "interrupt":
      return [{ role: "system", text: `[interrupt${event.reason ? `: ${event.reason}` : ""}]` }];
    case "unknown":
      return event.nativeType === "rendered_tool" && event.detail
        ? [{ role: "tool", text: event.detail }]
        : [];
    case "thinking":
    case "token_usage":
    case "turn_start":
    case "turn_end":
      return [];
  }
}

/** The most recent assistant turn's text, or null. */
export function lastAssistantText(turns: readonly TranscriptTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i] as TranscriptTurn;
    if (turn.role === "assistant") return turn.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// discovery — bind the newest matching file created around/after spawn
// ---------------------------------------------------------------------------

export interface TranscriptLocator {
  /** Directory to search (harness-specific, resolved by the caller). */
  dir: string;
  /** Filename filter (default: *.jsonl). */
  match?: RegExp;
  /** Recursive search depth (codex nests YYYY/MM/DD). Default 5. */
  depth?: number;
}

/**
 * Newest transcript file matching the locator whose mtime is at/after
 * `notBeforeMs` (the v1 created-floor idea, tightened to the exact spawn
 * stamp: a PREVIOUS generation's transcript in the same dir must never be
 * cross-matched to a fresh runtime — everything is same-clock local here).
 */
export function findTranscript(locator: TranscriptLocator, notBeforeMs: number): string | null {
  const match = locator.match ?? /\.jsonl$/;
  const maxDepth = locator.depth ?? 5;
  const floor = notBeforeMs;
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
        continue;
      }
      if (!match.test(entry.name)) continue;
      let mtime: number;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < floor) continue;
      if (best == null || mtime > best.mtime) best = { path: p, mtime };
    }
  };
  walk(locator.dir, 0);
  return best == null ? null : (best as { path: string; mtime: number }).path;
}
