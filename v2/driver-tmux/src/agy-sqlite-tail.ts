/**
 * agy TUI transcript mirror over Antigravity's local SQLite store.
 *
 * Live discovery (2026-09-03, agy 1.1.24): the TUI writes one SQLite DB per
 * conversation under `$HOME/.gemini/antigravity-cli/conversations/<id>.db`.
 * The transcript-bearing rows are `steps.step_payload` protobuf blobs:
 *   - step_type 14: user input, text at proto paths 19.2 / 19.3.1
 *   - step_type 15: assistant response, text at proto paths 20.1 / 20.8
 *
 * This reader never mutates the DB. It emits synthetic agy stream-json lines
 * for session-log rendering only; tmux lifecycle must come from hooks or
 * another structured harness event source, never from these protobuf blobs.
 */
import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";

type JsonObject = Record<string, unknown>;

interface StepRow {
  idx: number;
  stepType: number;
  status: number;
  payload: Uint8Array;
}

interface AssistantStepState {
  text: string;
  done: boolean;
}

const USER_STEP_TYPE = 14;
const ASSISTANT_STEP_TYPE = 15;
const DONE_STATUS = 3;
const USER_TEXT_PATHS: readonly (readonly number[])[] = [[19, 2], [19, 3, 1]];
const ASSISTANT_TEXT_PATHS: readonly (readonly number[])[] = [[20, 1], [20, 8]];

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function blob(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array && value.length > 0 ? value : null;
}

function parseStepRow(value: unknown): StepRow | null {
  const row = asObject(value);
  if (!row) return null;
  const idx = finiteInteger(row.idx);
  const stepType = finiteInteger(row.step_type);
  const status = finiteInteger(row.status);
  const payload = blob(row.step_payload);
  return idx == null || stepType == null || status == null || payload == null
    ? null
    : { idx, stepType, status, payload };
}

function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length && pos - offset < 10) {
    const byte = buf[pos];
    if (byte == null) return null;
    result += (byte & 0x7f) * 2 ** shift;
    pos += 1;
    if ((byte & 0x80) === 0) {
      return Number.isSafeInteger(result) ? { value: result, next: pos } : null;
    }
    shift += 7;
  }
  return null;
}

function utf8String(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.includes("\uFFFD")) return null;
  const cleaned = text.replace(/^\r+/, "");
  return cleaned.trim().length > 0 ? cleaned : null;
}

function stringsAtPath(buf: Uint8Array, path: readonly number[]): string[] {
  if (path.length === 0) return [];
  const target = path[0];
  if (target == null) return [];
  const rest = path.slice(1);
  const out: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (key == null) return out;
    pos = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value & 7;
    if (field <= 0) return out;

    if (wire === 0) {
      const scalar = readVarint(buf, pos);
      if (scalar == null) return out;
      pos = scalar.next;
      continue;
    }
    if (wire === 1) {
      pos += 8;
      if (pos > buf.length) return out;
      continue;
    }
    if (wire === 5) {
      pos += 4;
      if (pos > buf.length) return out;
      continue;
    }
    if (wire !== 2) return out;

    const len = readVarint(buf, pos);
    if (len == null) return out;
    pos = len.next;
    if (len.value < 0 || pos + len.value > buf.length) return out;
    const bytes = buf.subarray(pos, pos + len.value);
    pos += len.value;
    if (field !== target) continue;
    if (rest.length === 0) {
      const text = utf8String(bytes);
      if (text != null) out.push(text);
    } else {
      out.push(...stringsAtPath(bytes, rest));
    }
  }
  return out;
}

function firstTextAtPaths(buf: Uint8Array, paths: readonly (readonly number[])[]): string | null {
  const seen = new Set<string>();
  for (const path of paths) {
    for (const text of stringsAtPath(buf, path)) {
      if (seen.has(text)) continue;
      seen.add(text);
      return text;
    }
  }
  return null;
}

function dbConversationId(path: string): string {
  const file = basename(path);
  return file.endsWith(".db") ? file.slice(0, -3) : file;
}

function textDelta(previous: string, next: string): string {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

export class AgySqliteTail {
  readonly path: string;
  private readonly skipExisting: boolean;
  private db: DatabaseSync | null = null;
  private initialized = false;
  private emittedInit = false;
  private conversationId: string | null = null;
  private emittedUsers = new Set<number>();
  private assistantSteps = new Map<number, AssistantStepState>();
  private resultTurns = 0;

  constructor(path: string, opts: { skipExisting?: boolean } = {}) {
    this.path = path;
    this.skipExisting = opts.skipExisting ?? false;
  }

  poll(): string[] {
    const db = this.open();
    if (db == null) return [];
    let rows: StepRow[];
    try {
      this.conversationId = this.readConversationId(db) ?? this.conversationId ?? dbConversationId(this.path);
      rows = this.readSteps(db);
    } catch {
      this.close();
      return [];
    }

    if (!this.initialized) {
      this.initialized = true;
      if (this.skipExisting) {
        this.emittedInit = true;
        this.markExisting(rows);
        return [];
      }
    }

    const lines: string[] = [];
    if (!this.emittedInit) {
      this.emittedInit = true;
      lines.push(JSON.stringify({
        event: "init",
        conversation_id: this.threadId(),
        init: { source: "agy-tui-sqlite" },
      }));
    }
    for (const row of rows) {
      if (row.stepType === USER_STEP_TYPE) {
        lines.push(...this.userLines(row));
      } else if (row.stepType === ASSISTANT_STEP_TYPE) {
        lines.push(...this.assistantLines(row));
      }
    }
    return lines;
  }

  private open(): DatabaseSync | null {
    if (this.db != null) return this.db;
    try {
      this.db = new DatabaseSync(this.path, { readOnly: true });
      return this.db;
    } catch {
      return null;
    }
  }

  private close(): void {
    if (this.db == null) return;
    try {
      this.db.close();
    } catch {
      // A later poll will try a fresh read-only connection.
    }
    this.db = null;
  }

  private readConversationId(db: DatabaseSync): string | null {
    const row = asObject(db.prepare("select cascade_id from trajectory_meta limit 1").get());
    return nonEmptyString(row?.cascade_id);
  }

  private readSteps(db: DatabaseSync): StepRow[] {
    return db
      .prepare("select idx, step_type, status, step_payload from steps order by idx")
      .all()
      .flatMap((row) => {
        const parsed = parseStepRow(row);
        return parsed == null ? [] : [parsed];
      });
  }

  private threadId(): string {
    return this.conversationId ?? dbConversationId(this.path);
  }

  private markExisting(rows: readonly StepRow[]): void {
    for (const row of rows) {
      if (row.stepType === USER_STEP_TYPE && firstTextAtPaths(row.payload, USER_TEXT_PATHS) != null) {
        this.emittedUsers.add(row.idx);
      } else if (row.stepType === ASSISTANT_STEP_TYPE) {
        const text = firstTextAtPaths(row.payload, ASSISTANT_TEXT_PATHS);
        const done = row.status === DONE_STATUS;
        if (text != null) this.assistantSteps.set(row.idx, { text, done });
        if (done) this.resultTurns += 1;
      }
    }
  }

  private userLines(row: StepRow): string[] {
    if (this.emittedUsers.has(row.idx)) return [];
    const text = firstTextAtPaths(row.payload, USER_TEXT_PATHS);
    if (text == null) return [];
    this.emittedUsers.add(row.idx);
    return [JSON.stringify({
      event: "user",
      message: { content: [{ type: "text", text }] },
    })];
  }

  private assistantLines(row: StepRow): string[] {
    const text = firstTextAtPaths(row.payload, ASSISTANT_TEXT_PATHS);
    const previous = this.assistantSteps.get(row.idx);
    const previousText = previous?.text ?? "";
    const alreadyDone = previous?.done ?? false;
    const done = row.status === DONE_STATUS;
    if (text == null && (!done || alreadyDone)) return [];

    const nextText = text ?? previousText;
    const delta = text == null ? "" : textDelta(previousText, nextText);
    this.assistantSteps.set(row.idx, { text: nextText, done: alreadyDone || done });

    const lines: string[] = [];
    if (delta.length > 0 || (done && !alreadyDone)) {
      lines.push(JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: this.threadId(),
          step_index: row.idx,
          state: done ? "DONE" : "ACTIVE",
          step_type: "agent_response",
          text_delta: delta,
        },
      }));
    }
    if (done && !alreadyDone) {
      this.resultTurns += 1;
      lines.push(JSON.stringify({
        event: "result",
        result: {
          conversation_id: this.threadId(),
          status: "SUCCESS",
          response: nextText,
          num_turns: this.resultTurns,
        },
      }));
    }
    return lines;
  }
}
