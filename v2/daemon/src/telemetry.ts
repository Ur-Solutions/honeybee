/**
 * I1 violation telemetry (spec 04 behavior 5) — the 99.99% counter.
 *
 * Structured violation rows, same shape as the harness ledger
 * (v2/harness/src/invariants.ts formatViolation), persisted in an
 * `i1_violations` table. The table lives in a daemon-owned telemetry database
 * NEXT TO the core store, not inside it: the core store is EXCLUSIVE-locked
 * by its single writer and its schema is spec-01's closed contract; telemetry
 * is daemon-operational data with the daemon as its sole writer.
 *
 * Rows are keyed by message id (UNIQUE): a breach is recorded once per
 * message across daemon restarts — INSERT OR IGNORE makes re-detection after
 * a reboot a no-op, so the counter never double-counts.
 */
import { DatabaseSync } from "node:sqlite";
import type { I1ViolationEvent } from "./loops.ts";

const TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS i1_violations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL UNIQUE,
  bee_id      TEXT NOT NULL,
  invariant   TEXT NOT NULL DEFAULT 'I1',
  detected_at INTEGER NOT NULL,
  enqueued_at INTEGER NOT NULL,
  deadline    INTEGER NOT NULL,
  detail      TEXT NOT NULL,
  ops         TEXT NOT NULL DEFAULT '[]'
) STRICT;
`;

export interface I1ViolationRow {
  id: number;
  messageId: number;
  beeId: string;
  invariant: "I1";
  detectedAt: number;
  enqueuedAt: number;
  deadline: number;
  detail: string;
  ops: string[];
}

/** The ledger line (harness `formatViolation` shape) for the daemon log. */
export function formatI1Violation(v: I1ViolationEvent, ops: string[]): string {
  return JSON.stringify({
    step: v.detectedAt,
    bee: v.beeId,
    invariant: "I1",
    detail: v.detail,
    ops,
  });
}

export class TelemetryStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(TELEMETRY_SCHEMA);
  }

  /** Record a breach; returns false when the message was already recorded (dedup). */
  recordI1(v: I1ViolationEvent, ops: string[] = []): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO i1_violations(message_id, bee_id, detected_at, enqueued_at, deadline, detail, ops)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.messageId, v.beeId, v.detectedAt, v.enqueuedAt, v.deadline, v.detail, JSON.stringify(ops));
    return res.changes > 0;
  }

  i1Count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM i1_violations").get() as
      | { n: number | bigint }
      | undefined;
    return row ? Number(row.n) : 0;
  }

  listI1(): I1ViolationRow[] {
    const rows = this.db.prepare("SELECT * FROM i1_violations ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: Number(r.id),
      messageId: Number(r.message_id),
      beeId: r.bee_id as string,
      invariant: "I1",
      detectedAt: Number(r.detected_at),
      enqueuedAt: Number(r.enqueued_at),
      deadline: Number(r.deadline),
      detail: r.detail as string,
      ops: JSON.parse(r.ops as string) as string[],
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
