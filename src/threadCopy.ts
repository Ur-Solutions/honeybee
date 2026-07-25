// Thread-copy fork mechanics (session-fork-and-handoff epic).
//
// A thread-preserving fork copies the source bee's provider transcript —
// optionally truncated at a turn anchor — under a FRESH provider session id
// into the destination store, then resumes the copy. Verified against claude
// 2.1.x (2026-07-24): `claude -p --resume <id>` is purely file-based, so a
// copied JSONL resumes with full history across cwds, across homes/accounts,
// and even across the interactive↔headless store split that blocks native
// resume (docs/HSR_EXPLORATION.md §7 2026-07-03).
//
// The truncation/anchor logic is pure (lines in → lines out) so the risky
// decisions — what counts as a turn boundary, where a cut lands, which
// summary rows survive — are unit-testable without touching a provider store.

import { appendFile, copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { atomicWriteFile } from "./fsx.js";
import { claudeProjectFolder } from "./transcripts/claude.js";

/** Where a fork/handoff cuts the source thread. */
export type ForkAnchor =
  | { kind: "tip" }
  | { kind: "turn"; eventId?: string; ordinal?: number };

/** One finished-turn boundary, enumerated for `hive fork --list-anchors`. */
export type TurnAnchor = {
  /** 1-based turn number (a turn starts at a real user message). */
  ordinal: number;
  /**
   * Provider uuid of the user message that starts the turn. Absent for
   * harnesses whose user rows carry no ids (codex) — anchor by `turn:N` there.
   */
  userEventId?: string;
  /** Provider id of the last id-bearing row of the turn (the turn-end anchor). */
  endEventId?: string;
  /** Whether the turn has at least one assistant reply (a "finished" turn). */
  completed: boolean;
  ts?: string;
  /** First line of the user message, for display. */
  preview: string;
};

/**
 * Parse the `--at` flag. Accepted forms:
 *   (absent) / "tip"  → fork from the tip (last finished turn).
 *   "turn:N"          → the Nth turn boundary (1-based, from --list-anchors).
 *   any other value   → a provider event uuid (user or assistant row).
 */
export function parseAnchorFlag(value: string | undefined): ForkAnchor {
  if (value === undefined || value === "" || value === "tip") return { kind: "tip" };
  const turnMatch = value.match(/^turn:(\d+)$/);
  if (turnMatch) {
    const ordinal = Number(turnMatch[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error(`--at turn:${turnMatch[1]}: turn ordinal must be >= 1`);
    return { kind: "turn", ordinal };
  }
  return { kind: "turn", eventId: value };
}

type ClaudeRow = Record<string, unknown>;

function parseRows(lines: string[]): Array<{ raw: string; row: ClaudeRow | null }> {
  return lines.map((raw) => {
    try {
      const row = JSON.parse(raw) as unknown;
      return { raw, row: row && typeof row === "object" && !Array.isArray(row) ? (row as ClaudeRow) : null };
    } catch {
      return { raw, row: null };
    }
  });
}

function messageContent(row: ClaudeRow): unknown {
  const message = row.message;
  if (!message || typeof message !== "object") return undefined;
  return (message as Record<string, unknown>).content;
}

/**
 * A REAL user message (a turn start): typed by the human/driver, not a
 * tool_result carrier, not a sidechain (subagent) row, not meta.
 */
export function isTurnStartRow(row: ClaudeRow): boolean {
  if (row.type !== "user" || row.isSidechain === true || row.isMeta === true) return false;
  const content = messageContent(row);
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text");
  }
  return false;
}

function isAssistantRow(row: ClaudeRow): boolean {
  return row.type === "assistant" && row.isSidechain !== true;
}

function rowText(row: ClaudeRow): string {
  const content = messageContent(row);
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return "";
}

function previewOf(row: ClaudeRow): string {
  const firstLine = rowText(row).split("\n", 1)[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

/**
 * Enumerate turn boundaries in a claude session file. Pure: takes raw JSONL
 * lines. A turn spans from a real user message up to (excluding) the next one;
 * its end anchor is the last uuid-bearing row in that span.
 */
export function listClaudeTurnAnchors(lines: string[]): TurnAnchor[] {
  const parsed = parseRows(lines);
  const anchors: TurnAnchor[] = [];
  let current: TurnAnchor | null = null;
  for (const { row } of parsed) {
    if (!row) continue;
    if (isTurnStartRow(row) && typeof row.uuid === "string") {
      if (current) anchors.push(current);
      current = {
        ordinal: anchors.length + 1,
        userEventId: row.uuid,
        completed: false,
        ...(typeof row.timestamp === "string" ? { ts: row.timestamp } : {}),
        preview: previewOf(row),
      };
      continue;
    }
    if (!current) continue;
    if (typeof row.uuid === "string") current.endEventId = row.uuid;
    if (isAssistantRow(row)) current.completed = true;
  }
  if (current) anchors.push(current);
  return anchors;
}

export type TruncateResult = {
  kept: string[];
  /** The turn the cut landed on (the last turn fully included), when known. */
  boundaryOrdinal?: number;
};

/**
 * Cut the thread at an anchor. Semantics (epic, decided 2026-07-24):
 *   - user-message anchor    → keep everything BEFORE that message;
 *   - any other event anchor → keep through the END of the turn containing it
 *                              (a cut never lands mid-turn: dangling tool_use
 *                              chains would poison the resumed thread);
 *   - turn:N                 → keep turns 1..N (cut before turn N+1's user row).
 * Summary rows whose leafUuid points past the cut are dropped; the tail is
 * additionally trimmed so the thread never ends on a dangling tool_use.
 */
export function truncateClaudeThread(lines: string[], anchor: ForkAnchor): TruncateResult {
  if (anchor.kind === "tip") return { kept: [...lines] };
  const parsed = parseRows(lines);
  const anchors = listClaudeTurnAnchors(lines);
  if (anchors.length === 0) throw new Error("source thread has no turns to anchor on");

  // Row index of each turn start, aligned with `anchors`.
  const turnStartIndexes: number[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const row = parsed[i]!.row;
    if (row && isTurnStartRow(row) && typeof row.uuid === "string") turnStartIndexes.push(i);
  }

  let cutAfter: number; // keep rows [0..cutAfter]
  let boundaryOrdinal: number;
  if (anchor.ordinal !== undefined) {
    if (anchor.ordinal > anchors.length) {
      throw new Error(`--at turn:${anchor.ordinal}: source has only ${anchors.length} turn(s)`);
    }
    const nextStart = turnStartIndexes[anchor.ordinal] ?? parsed.length;
    cutAfter = nextStart - 1;
    boundaryOrdinal = anchor.ordinal;
  } else if (anchor.eventId !== undefined) {
    const eventIndex = parsed.findIndex(({ row }) => row !== null && row.uuid === anchor.eventId);
    if (eventIndex < 0) throw new Error(`--at ${anchor.eventId}: no such event in the source thread`);
    const anchorRow = parsed[eventIndex]!.row!;
    // Which turn does the event belong to? (last turn start at or before it)
    let turnIdx = -1;
    for (let t = 0; t < turnStartIndexes.length; t += 1) {
      if (turnStartIndexes[t]! <= eventIndex) turnIdx = t;
    }
    if (isTurnStartRow(anchorRow)) {
      // Cut BEFORE this user message: keep turns 1..turnIdx (turnIdx is this
      // message's own turn, so the boundary is the previous one).
      if (turnIdx <= 0) throw new Error(`--at ${anchor.eventId}: anchoring before the first message leaves an empty thread`);
      cutAfter = turnStartIndexes[turnIdx]! - 1;
      boundaryOrdinal = turnIdx; // 1-based ordinal of the last kept turn
    } else {
      // Keep through the end of the containing turn.
      if (turnIdx < 0) throw new Error(`--at ${anchor.eventId}: event precedes the first turn`);
      const nextStart = turnStartIndexes[turnIdx + 1] ?? parsed.length;
      cutAfter = nextStart - 1;
      boundaryOrdinal = turnIdx + 1;
    }
  } else {
    return { kept: [...lines] };
  }

  // Trim a dangling tail: the kept thread must not end on an assistant row
  // whose tool_use has no tool_result yet (an interrupted final turn).
  const pendingToolUse = new Set<string>();
  for (let i = 0; i <= cutAfter; i += 1) {
    const row = parsed[i]!.row;
    if (!row) continue;
    const content = messageContent(row);
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "tool_use" && typeof p.id === "string") pendingToolUse.add(p.id);
      if (p.type === "tool_result" && typeof p.tool_use_id === "string") pendingToolUse.delete(p.tool_use_id);
    }
  }
  while (cutAfter >= 0 && pendingToolUse.size > 0) {
    const row = parsed[cutAfter]!.row;
    const content = row ? messageContent(row) : undefined;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "tool_use" && typeof p.id === "string") pendingToolUse.delete(p.id);
        if (p.type === "tool_result" && typeof p.tool_use_id === "string") pendingToolUse.add(p.tool_use_id);
      }
    }
    cutAfter -= 1;
  }
  if (cutAfter < 0) throw new Error("anchor leaves an empty thread after trimming a dangling tool call");

  // Drop summary rows whose leafUuid was cut away.
  const keptUuids = new Set<string>();
  for (let i = 0; i <= cutAfter; i += 1) {
    const row = parsed[i]!.row;
    if (row && typeof row.uuid === "string") keptUuids.add(row.uuid);
  }
  const kept: string[] = [];
  for (let i = 0; i <= cutAfter; i += 1) {
    const { raw, row } = parsed[i]!;
    if (row && row.type === "summary" && typeof row.leafUuid === "string" && !keptUuids.has(row.leafUuid)) continue;
    kept.push(raw);
  }
  if (!kept.some((line) => {
    try {
      const row = JSON.parse(line) as ClaudeRow;
      return isTurnStartRow(row);
    } catch {
      return false;
    }
  })) {
    throw new Error("anchor leaves an empty thread (no user turn survives the cut)");
  }
  return { kept, boundaryOrdinal };
}

/** Rewrite every row's sessionId to the fork's fresh id. Pure. */
export function rewriteClaudeSessionId(lines: string[], newSessionId: string): string[] {
  return lines.map((raw) => {
    try {
      const row = JSON.parse(raw) as ClaudeRow;
      if ("sessionId" in row) row.sessionId = newSessionId;
      return JSON.stringify(row);
    } catch {
      return raw;
    }
  });
}

/** Effective claude config dir for a bee: explicit home > ambient env > ~/.claude. */
export function effectiveClaudeConfigDir(explicitHome?: string): string {
  return explicitHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Path of a claude bee's provider session file. */
export function claudeSessionFilePath(input: { cwd: string; providerSessionId: string; homePath?: string }): string {
  return join(claudeProjectFolder(input.cwd, effectiveClaudeConfigDir(input.homePath)), `${input.providerSessionId}.jsonl`);
}

export type CopyThreadInput = {
  /** Source provider session file (claude JSONL). */
  sourcePath: string;
  /** The fork's cwd — the copy lands under this cwd's project key. */
  destCwd: string;
  /** The fork's claude config dir (account home or default). */
  destConfigDir: string;
  /** Fresh provider session id minted for the fork. */
  newSessionId: string;
  anchor: ForkAnchor;
};

export type CopyThreadResult = {
  path: string;
  keptRows: number;
  boundaryOrdinal?: number;
  /**
   * The provider-facing id of the copy, when it differs from the raw uuid the
   * caller minted (kimi prefixes `session_<uuid>`). Callers must record/resume
   * this id, not the raw uuid.
   */
  newProviderSessionId?: string;
};

/**
 * Copy (and optionally truncate) a claude thread under a fresh session id in
 * the destination store. The write is atomic; the source is never touched.
 */
export async function copyClaudeThread(input: CopyThreadInput): Promise<CopyThreadResult> {
  const lines = await readThreadLines(input.sourcePath);
  const { kept, boundaryOrdinal } = truncateClaudeThread(lines, input.anchor);
  const rewritten = rewriteClaudeSessionId(kept, input.newSessionId);
  const destDir = claudeProjectFolder(input.destCwd, input.destConfigDir);
  await mkdir(destDir, { recursive: true });
  const path = join(destDir, `${input.newSessionId}.jsonl`);
  await atomicWriteFile(path, `${rewritten.join("\n")}\n`, { mode: 0o600 });
  return { path, keptRows: rewritten.length, ...(boundaryOrdinal !== undefined ? { boundaryOrdinal } : {}) };
}

async function readThreadLines(sourcePath: string): Promise<string[]> {
  const raw = await readFile(sourcePath, "utf8").catch(() => {
    throw new Error(`no provider session file at ${sourcePath} — seed from a seal or log instead`);
  });
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error(`provider session file at ${sourcePath} is empty`);
  return lines;
}

// ── codex ────────────────────────────────────────────────────────────────────
//
// Codex rollout files (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`)
// are also purely file-based for resume (verified 2026-07-24: a rollout copied
// under a fresh uuid — even v4, codex mints v7 — resumes with full history via
// `codex resume <id>`). Turn anatomy: each turn is [prelude: task_started /
// thread_settings_applied / world_state] → `turn_context` → real user
// response_item → … → task_complete. User rows carry NO ids (anchoring is
// turn-ordinal-grained); assistant rows carry stable `msg_…` ids usable as
// turn-end anchors.

/** Effective codex home: explicit home > ambient env > ~/.codex. */
export function effectiveCodexHome(explicitHome?: string): string {
  return explicitHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Recursively find the rollout file for a codex thread id under a home. */
export async function locateCodexRolloutFile(codexHome: string, threadId: string): Promise<string> {
  const root = join(codexHome, "sessions");
  const suffix = `-${threadId}.jsonl`;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) return full;
    }
  }
  throw new Error(`no codex rollout for thread ${threadId} under ${root} — seed from a seal or log instead`);
}

function codexPayload(row: ClaudeRow): Record<string, unknown> | undefined {
  const payload = row.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
}

function isCodexTurnContext(row: ClaudeRow): boolean {
  return row.type === "turn_context";
}

function isCodexUserMessage(row: ClaudeRow): boolean {
  const payload = codexPayload(row);
  return row.type === "response_item" && payload?.type === "message" && payload.role === "user";
}

function isCodexAssistantMessage(row: ClaudeRow): boolean {
  const payload = codexPayload(row);
  return row.type === "response_item" && payload?.type === "message" && payload.role === "assistant";
}

/** A row that belongs to the NEXT turn's prelude when it trails a cut. */
function isCodexTurnPrelude(row: ClaudeRow): boolean {
  if (row.type === "world_state") return true;
  if (row.type !== "event_msg") return false;
  const payload = codexPayload(row);
  return payload?.type === "task_started" || payload?.type === "thread_settings_applied";
}

function codexRowText(row: ClaudeRow): string {
  const content = codexPayload(row)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object") {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return "";
}

/** Enumerate codex turn boundaries. A turn starts at a `turn_context` row. */
export function listCodexTurnAnchors(lines: string[]): TurnAnchor[] {
  const parsed = parseRows(lines);
  const anchors: TurnAnchor[] = [];
  let current: TurnAnchor | null = null;
  let sawUser = false;
  for (const { row } of parsed) {
    if (!row) continue;
    if (isCodexTurnContext(row)) {
      if (current) anchors.push(current);
      current = { ordinal: anchors.length + 1, completed: false, preview: "" };
      sawUser = false;
      continue;
    }
    if (!current) continue;
    if (!sawUser && isCodexUserMessage(row)) {
      sawUser = true;
      const firstLine = codexRowText(row).split("\n", 1)[0] ?? "";
      current.preview = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
      if (typeof row.timestamp === "string") current.ts = row.timestamp;
      continue;
    }
    if (isCodexAssistantMessage(row)) {
      current.completed = true;
      const id = codexPayload(row)?.id;
      if (typeof id === "string") current.endEventId = id;
    }
  }
  if (current) anchors.push(current);
  return anchors;
}

/**
 * Cut a codex rollout at an anchor. Codex anchoring is turn-grained: `turn:N`
 * keeps turns 1..N; an event id (an assistant `msg_…` id) keeps through the
 * end of the turn containing it. There is no "before this user message" form —
 * codex user rows carry no ids. The cut lands after turn N's last row, then
 * walks back past the next turn's prelude and any dangling function_call.
 */
export function truncateCodexThread(lines: string[], anchor: ForkAnchor): TruncateResult {
  if (anchor.kind === "tip") return { kept: [...lines] };
  const parsed = parseRows(lines);
  const turnStarts: number[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const row = parsed[i]!.row;
    if (row && isCodexTurnContext(row)) turnStarts.push(i);
  }
  if (turnStarts.length === 0) throw new Error("source thread has no turns to anchor on");

  let boundaryOrdinal: number;
  if (anchor.ordinal !== undefined) {
    if (anchor.ordinal > turnStarts.length) {
      throw new Error(`--at turn:${anchor.ordinal}: source has only ${turnStarts.length} turn(s)`);
    }
    boundaryOrdinal = anchor.ordinal;
  } else if (anchor.eventId !== undefined) {
    const eventIndex = parsed.findIndex(({ row }) => row !== null && codexPayload(row)?.id === anchor.eventId);
    if (eventIndex < 0) {
      throw new Error(`--at ${anchor.eventId}: no such event in the source thread (codex anchors are assistant msg ids or turn:N)`);
    }
    let turnIdx = -1;
    for (let t = 0; t < turnStarts.length; t += 1) {
      if (turnStarts[t]! <= eventIndex) turnIdx = t;
    }
    if (turnIdx < 0) throw new Error(`--at ${anchor.eventId}: event precedes the first turn`);
    boundaryOrdinal = turnIdx + 1;
  } else {
    return { kept: [...lines] };
  }

  let cutAfter = (turnStarts[boundaryOrdinal] ?? parsed.length) - 1;
  // Trim the NEXT turn's prelude rows off the tail.
  while (cutAfter >= 0 && parsed[cutAfter]!.row && isCodexTurnPrelude(parsed[cutAfter]!.row!)) cutAfter -= 1;

  // Trim a dangling function_call chain (an interrupted final turn).
  const pendingCalls = new Set<string>();
  for (let i = 0; i <= cutAfter; i += 1) {
    const payload = parsed[i]!.row ? codexPayload(parsed[i]!.row!) : undefined;
    if (!payload) continue;
    if (payload.type === "function_call" && typeof payload.call_id === "string") pendingCalls.add(payload.call_id);
    if (payload.type === "function_call_output" && typeof payload.call_id === "string") pendingCalls.delete(payload.call_id);
  }
  while (cutAfter >= 0 && pendingCalls.size > 0) {
    const payload = parsed[cutAfter]!.row ? codexPayload(parsed[cutAfter]!.row!) : undefined;
    if (payload?.type === "function_call" && typeof payload.call_id === "string") pendingCalls.delete(payload.call_id);
    if (payload?.type === "function_call_output" && typeof payload.call_id === "string") pendingCalls.add(payload.call_id);
    cutAfter -= 1;
  }
  if (cutAfter < 0) throw new Error("anchor leaves an empty thread after trimming a dangling tool call");

  const kept = parsed.slice(0, cutAfter + 1).map(({ raw }) => raw);
  if (!kept.some((line) => {
    try {
      return isCodexUserMessage(JSON.parse(line) as ClaudeRow);
    } catch {
      return false;
    }
  })) {
    throw new Error("anchor leaves an empty thread (no user turn survives the cut)");
  }
  return { kept, boundaryOrdinal };
}

/**
 * Rewrite a codex rollout's thread id. Plain per-line string replacement of
 * the uuid — exactly the transformation verified live; the id appears in the
 * session_meta payload (`id`, `session_id`) and nowhere ambiguous (uuids).
 */
export function rewriteCodexThreadId(lines: string[], oldThreadId: string, newThreadId: string): string[] {
  return lines.map((line) => line.split(oldThreadId).join(newThreadId));
}

export type CopyCodexThreadInput = {
  sourcePath: string;
  oldThreadId: string;
  newThreadId: string;
  /** The fork's codex home (account home or default). */
  destCodexHome: string;
  anchor: ForkAnchor;
};

/** Copy (and optionally truncate) a codex rollout under a fresh thread id. */
export async function copyCodexThread(input: CopyCodexThreadInput): Promise<CopyThreadResult> {
  const lines = await readThreadLines(input.sourcePath);
  const { kept, boundaryOrdinal } = truncateCodexThread(lines, input.anchor);
  const rewritten = rewriteCodexThreadId(kept, input.oldThreadId, input.newThreadId);
  // Mirror the source's dated directory under the destination home; the
  // filename keeps its timestamp with only the thread id swapped.
  const sourceDir = dirname(input.sourcePath);
  const sourceHomeSessions = sourceDir.split(`${sep}sessions${sep}`);
  const datedPart = sourceHomeSessions.length > 1 ? sourceHomeSessions.at(-1)! : "";
  const destDir = join(input.destCodexHome, "sessions", datedPart);
  await mkdir(destDir, { recursive: true });
  const fileName = basename(input.sourcePath).split(input.oldThreadId).join(input.newThreadId);
  const path = join(destDir, fileName);
  await atomicWriteFile(path, `${rewritten.join("\n")}\n`, { mode: 0o600 });
  return { path, keptRows: rewritten.length, ...(boundaryOrdinal !== undefined ? { boundaryOrdinal } : {}) };
}

// ── directory-store harnesses: grok, kimi, cursor ───────────────────────────
//
// These three keep a session as a DIRECTORY (chat/state files + sidecars), and
// all three resume a verbatim-copied directory under a fresh id (verified live
// 2026-07-24: grok `--resume <copy>`, kimi `-r <copy>` after an index append,
// cursor `--resume <copy>` with no rewrite at all). Turn-anchored truncation
// inside their per-turn files is NOT yet verified, so these are tip-only:
// an anchored fork refuses with a pointer at handoff.

/** Copy a session directory, rewriting the id in text files; .lock files are skipped, binaries copied verbatim. */
export async function copySessionDirRewritingIds(srcDir: string, destDir: string, oldId: string, newId: string): Promise<number> {
  await mkdir(destDir, { recursive: true });
  let files = 0;
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      files += await copySessionDirRewritingIds(src, dest, oldId, newId);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".lock")) continue;
    if (/\.(json|jsonl|txt)$/.test(entry.name)) {
      const raw = await readFile(src, "utf8");
      await atomicWriteFile(dest, raw.split(oldId).join(newId), { mode: 0o600 });
    } else {
      await copyFile(src, dest);
    }
    files += 1;
  }
  return files;
}

/** Effective grok home: explicit home > ambient env > ~/.grok. */
export function effectiveGrokHome(explicitHome?: string): string {
  return explicitHome ?? process.env.GROK_HOME ?? join(homedir(), ".grok");
}

/** Grok keys session folders by encodeURIComponent(cwd). */
export function grokSessionDir(grokHome: string, cwd: string, sessionId: string): string {
  return join(grokHome, "sessions", encodeURIComponent(cwd), sessionId);
}

/** Effective kimi home: explicit home > ambient env > ~/.kimi. */
export function effectiveKimiHome(explicitHome?: string): string {
  return explicitHome ?? process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi");
}

/** Kimi session dirs live under sessions/wd_<base>_<hash>/<session_id>; the hash is private, so scan. */
export async function findKimiSessionDir(kimiHome: string, sessionId: string): Promise<string> {
  const root = join(kimiHome, "sessions");
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, sessionId);
    if ((await readdir(candidate).catch(() => null)) !== null) return candidate;
  }
  throw new Error(`no kimi session ${sessionId} under ${root} — seed from a seal or log instead`);
}

/** Cursor chats are MACHINE-GLOBAL (~/.cursor/chats/<project-hash>/<chat-id>), regardless of account home. */
export async function findCursorChatDir(chatId: string): Promise<string> {
  const root = join(homedir(), ".cursor", "chats");
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, chatId);
    if ((await readdir(candidate).catch(() => null)) !== null) return candidate;
  }
  throw new Error(`no cursor chat ${chatId} under ${root} — seed from a seal or log instead`);
}

function assertTipAnchor(kind: string, anchor: ForkAnchor): void {
  if (anchor.kind !== "tip") {
    throw new Error(`turn-anchored forks are not supported for ${kind} yet (tip-only thread copy) — use hive handoff to branch from a summary`);
  }
}

// ── generic dispatch (used by cmdFork) ──────────────────────────────────────

export type ThreadCopySource = { cwd: string; providerSessionId: string; homePath?: string };

/** Locate a thread-copy-capable harness's provider session file (or directory). */
export async function locateThreadFile(kind: string, source: ThreadCopySource): Promise<string> {
  if (kind === "claude") {
    return claudeSessionFilePath({
      cwd: source.cwd,
      providerSessionId: source.providerSessionId,
      ...(source.homePath ? { homePath: source.homePath } : {}),
    });
  }
  if (kind === "codex") return locateCodexRolloutFile(effectiveCodexHome(source.homePath), source.providerSessionId);
  if (kind === "grok") {
    const dir = grokSessionDir(effectiveGrokHome(source.homePath), source.cwd, source.providerSessionId);
    if ((await readdir(dir).catch(() => null)) === null) {
      throw new Error(`no grok session ${source.providerSessionId} at ${dir} — seed from a seal or log instead`);
    }
    return dir;
  }
  if (kind === "kimi") return findKimiSessionDir(effectiveKimiHome(source.homePath), source.providerSessionId);
  if (kind === "cursor") return findCursorChatDir(source.providerSessionId);
  throw new Error(`${kind} has no thread-copy support`);
}

/** Enumerate turn anchors for a thread-copy-capable harness. */
export function listTurnAnchors(kind: string, lines: string[]): TurnAnchor[] {
  if (kind === "claude") return listClaudeTurnAnchors(lines);
  if (kind === "codex") return listCodexTurnAnchors(lines);
  if (kind === "grok" || kind === "kimi" || kind === "cursor") {
    throw new Error(`turn anchors are not supported for ${kind} yet (tip-only thread copy)`);
  }
  throw new Error(`${kind} has no thread-copy support`);
}

export type CopyThreadForForkInput = {
  kind: string;
  source: ThreadCopySource;
  destCwd: string;
  /** The fork's home (account home), when bound; the ambient default otherwise. */
  destHome?: string;
  newSessionId: string;
  anchor: ForkAnchor;
};

/** Copy a provider thread under a fresh id, per-harness. */
export async function copyThreadForFork(input: CopyThreadForForkInput): Promise<CopyThreadResult> {
  // Tip-only harnesses refuse anchors BEFORE any store lookup, so the caller
  // sees the capability message rather than a locate error.
  if (input.kind === "grok" || input.kind === "kimi" || input.kind === "cursor") assertTipAnchor(input.kind, input.anchor);
  const sourcePath = await locateThreadFile(input.kind, input.source);
  if (input.kind === "claude") {
    return copyClaudeThread({
      sourcePath,
      destCwd: input.destCwd,
      destConfigDir: effectiveClaudeConfigDir(input.destHome),
      newSessionId: input.newSessionId,
      anchor: input.anchor,
    });
  }
  if (input.kind === "codex") {
    return copyCodexThread({
      sourcePath,
      oldThreadId: input.source.providerSessionId,
      newThreadId: input.newSessionId,
      destCodexHome: effectiveCodexHome(input.destHome),
      anchor: input.anchor,
    });
  }
  if (input.kind === "grok") {
    const destDir = grokSessionDir(effectiveGrokHome(input.destHome), input.destCwd, input.newSessionId);
    const keptRows = await copySessionDirRewritingIds(sourcePath, destDir, input.source.providerSessionId, input.newSessionId);
    return { path: destDir, keptRows };
  }
  if (input.kind === "kimi") {
    // Kimi ids are `session_<uuid>`; the copy sits beside the source (the
    // wd_<hash> segment is private to kimi) and must be registered in the
    // home-root session index — resume is index-gated (verified 2026-07-24).
    const newProviderSessionId = `session_${input.newSessionId}`;
    const kimiHome = effectiveKimiHome(input.destHome);
    const destDir = join(dirname(sourcePath), newProviderSessionId);
    const keptRows = await copySessionDirRewritingIds(sourcePath, destDir, input.source.providerSessionId, newProviderSessionId);
    await appendFile(
      join(kimiHome, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: newProviderSessionId, sessionDir: destDir, workDir: input.source.cwd })}\n`,
    );
    return { path: destDir, keptRows, newProviderSessionId };
  }
  if (input.kind === "cursor") {
    // Cursor resumes a verbatim directory copy by its dir name alone; the chat
    // id appears nowhere inside the files (store.db is binary — never rewritten).
    const destDir = join(dirname(sourcePath), input.newSessionId);
    const keptRows = await copySessionDirRewritingIds(sourcePath, destDir, input.source.providerSessionId, input.newSessionId);
    return { path: destDir, keptRows };
  }
  throw new Error(`${input.kind} has no thread-copy support`);
}
