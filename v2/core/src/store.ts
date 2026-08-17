/**
 * The v2 core store — the single serialized write API (B9).
 *
 * One SQLite database per node, WAL journal, EXCLUSIVE locking mode: this process's
 * connection is the only writer (and, under WAL+EXCLUSIVE, the only reader) for the
 * lifetime of the handle. A second `openCoreStore` on the same path fails loudly.
 *
 * Every write is transactional and appends audit rows in the same transaction (test 13:
 * replaying the audit log reproduces the exact table state — see audit.ts).
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  BeeNotFoundError,
  CommandProtocolError,
  CoreError,
  EXIT_CAUSES,
  FLAGS,
  IllegalTransitionError,
  RUNTIME_TRANSITIONS,
  RUNTIME_VERBS,
  SecondWriterError,
  UnknownFailureCauseError,
  UnknownFlagError,
  UnknownVerbError,
  VERBS,
  type AuditRow,
  type BeeRow,
  type BeeView,
  type CommandRow,
  type ExitCause,
  type FailureCause,
  type Flag,
  type FlagRow,
  type MessageRow,
  type RuntimeRow,
  type RuntimeState,
  type StateDump,
  type Verb,
} from "./types.ts";
import { SCHEMA_SQL } from "./schema.ts";

export interface CoreStoreOptions {
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** B5 bounded retries: attempts allowed before a command settles `failed`. Default 5. */
  maxAttempts?: number;
  /** B5 backoff base: next_attempt_at = now + base * 2^(attempts-1). Default 30s. */
  backoffBaseMs?: number;
}

export interface CreateBeeInput {
  /** Known process identity at spawn time, so a daemon restart mid-boot can re-adopt (WP2 finding). */
  proc?: { pid: number; pidStartedAt: number };
  id?: string;
  name: string;
  agent: string;
  substrate: string;
  cwd: string;
  title?: string;
  tags?: string[];
  sessionLogPath?: string;
}

export interface SendResult {
  message: MessageRow;
  /** The send_wake enqueued in the same transaction when no live runtime existed (B4/B5). */
  wakeCommand: CommandRow | null;
  /** True when the send auto-unarchived an archived bee (Q3). */
  unarchived: boolean;
}

export interface DeleteResult {
  beeId: string;
  /** Path of the session log file (outside the DB) the caller must remove (Q1). */
  sessionLogPath: string | null;
  /** Pid of a non-stopped runtime at delete time, for the daemon to reap. */
  livePid: number | null;
  /** Pending (queued/running) commands settled as moot by the delete. */
  settledCommandIds: number[];
}

export interface ReconcileResult {
  /** Runtimes transitioned to stopped(machine_restart). NEVER a failed state (B7). */
  stopped: Array<{ beeId: string; generation: number }>;
  /** Surviving runtimes re-adopted by pid + pid_started_at match. */
  adopted: Array<{ beeId: string; generation: number; pid: number }>;
  /** Commands reverted running → queued at boot (B5); requeued by open(), reported here. */
  requeuedCommandIds: number[];
}

export interface LivePid {
  pid: number;
  startedAt: number;
}

const LIVE_STATES: readonly RuntimeState[] = ["booting", "running", "idle"];

type Row = Record<string, unknown>;

function mapBee(r: Row): BeeRow {
  return {
    id: r.id as string,
    name: r.name as string,
    agent: r.agent as string,
    substrate: r.substrate as string,
    cwd: r.cwd as string,
    title: (r.title as string | null) ?? null,
    tags: JSON.parse(r.tags as string) as string[],
    sessionLogPath: (r.session_log_path as string | null) ?? null,
    lifecycle: r.lifecycle as BeeRow["lifecycle"],
    createdAt: Number(r.created_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    lastOutputAt: r.last_output_at == null ? null : Number(r.last_output_at),
  };
}

function mapRuntime(r: Row): RuntimeRow {
  return {
    beeId: r.bee_id as string,
    generation: Number(r.generation),
    state: r.state as RuntimeState,
    exitCause: (r.exit_cause as ExitCause | null) ?? null,
    pid: r.pid == null ? null : Number(r.pid),
    pidStartedAt: r.pid_started_at == null ? null : Number(r.pid_started_at),
    startedAt: Number(r.started_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapFlag(r: Row): FlagRow {
  return {
    id: Number(r.id),
    beeId: r.bee_id as string,
    flag: r.flag as Flag,
    detail: r.detail as string,
    setAt: Number(r.set_at),
    clearedAt: r.cleared_at == null ? null : Number(r.cleared_at),
  };
}

function mapMessage(r: Row): MessageRow {
  return {
    id: Number(r.id),
    beeId: r.bee_id as string,
    sender: r.sender as string,
    body: r.body as string,
    priority: Number(r.priority),
    enqueuedAt: Number(r.enqueued_at),
    deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
    deliveredGeneration: r.delivered_generation == null ? null : Number(r.delivered_generation),
  };
}

function mapCommand(r: Row): CommandRow {
  return {
    id: Number(r.id),
    verb: r.verb as Verb,
    beeId: r.bee_id as string,
    args: JSON.parse(r.args as string) as Record<string, unknown>,
    targetGeneration: r.target_generation == null ? null : Number(r.target_generation),
    status: r.status as CommandRow["status"],
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    enqueuedAt: Number(r.enqueued_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    failureCause: (r.failure_cause as FailureCause | null) ?? null,
  };
}

function mapAudit(r: Row): AuditRow {
  return {
    seq: Number(r.seq),
    ts: Number(r.ts),
    kind: r.kind as string,
    beeId: (r.bee_id as string | null) ?? null,
    payload: JSON.parse(r.payload as string) as Record<string, unknown>,
  };
}

export class CoreStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private txDepth = 0;
  private closed = false;
  /** Commands requeued running→queued by open() (B5 boot replay); reported by reconcileAtBoot. */
  private bootRequeuedCommandIds: number[] = [];

  constructor(path: string, opts: CoreStoreOptions = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 30_000;
    this.db = new DatabaseSync(path);
    try {
      // Fail immediately (no waiting) if another writer holds the lock.
      this.db.exec("PRAGMA busy_timeout = 0");
      // B9: WAL + EXCLUSIVE — the first write below acquires an exclusive lock that is
      // held until close(); any second connection's first access throws SQLITE_BUSY.
      this.db.exec("PRAGMA locking_mode = EXCLUSIVE");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(SCHEMA_SQL);
      this.tx(() => {
        // Guaranteed write on open: takes the exclusive lock now, not lazily.
        this.db
          .prepare("INSERT INTO meta(key, value) VALUES('opened_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(this.now()));
        this.bootRequeueRunningCommands();
      });
    } catch (err) {
      try {
        this.db.close();
      } catch {
        /* already unusable */
      }
      if (err instanceof CoreError) throw err;
      throw new SecondWriterError(path, err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Serialize every write into one IMMEDIATE transaction; nested calls join the outer tx. */
  private tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* rollback after failed commit */
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  private audit(kind: string, beeId: string | null, payload: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, ?, ?, ?)")
      .run(this.now(), kind, beeId, JSON.stringify(payload));
  }

  private mustGetBee(beeId: string): BeeRow {
    const bee = this.getBee(beeId);
    if (!bee) throw new BeeNotFoundError(beeId);
    return bee;
  }

  /** B5 — on library re-open ("boot"), all `running` commands revert to `queued`. */
  private bootRequeueRunningCommands(): void {
    const rows = this.db
      .prepare("SELECT id FROM commands WHERE status = 'running' ORDER BY id")
      .all() as Row[];
    this.bootRequeuedCommandIds = rows.map((r) => Number(r.id));
    if (this.bootRequeuedCommandIds.length === 0) return;
    const at = this.now();
    this.db
      .prepare("UPDATE commands SET status = 'queued', next_attempt_at = ? WHERE status = 'running'")
      .run(at);
    this.audit("command.boot_requeued", null, {
      commandIds: this.bootRequeuedCommandIds,
      nextAttemptAt: at,
    });
  }

  // -------------------------------------------------------------------------
  // B1 — bee lifecycle
  // -------------------------------------------------------------------------

  createBee(input: CreateBeeInput): { bee: BeeRow; runtime: RuntimeRow } {
    return this.tx(() => {
      const id = input.id ?? randomUUID();
      if (this.getBee(id)) throw new CoreError(`bee already exists: ${id}`);
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO bees(id, name, agent, substrate, cwd, title, tags, session_log_path, lifecycle, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          id,
          input.name,
          input.agent,
          input.substrate,
          input.cwd,
          input.title ?? null,
          JSON.stringify(input.tags ?? []),
          input.sessionLogPath ?? null,
          at,
        );
      const bee = this.mustGetBee(id);
      this.audit("bee.created", id, { bee });
      const runtime = this.insertRuntime(id, 1, at, input.proc);
      return { bee, runtime };
    });
  }

  getBee(beeId: string): BeeRow | null {
    const row = this.db.prepare("SELECT * FROM bees WHERE id = ?").get(beeId) as Row | undefined;
    return row ? mapBee(row) : null;
  }

  listBees(): BeeRow[] {
    const rows = this.db.prepare("SELECT * FROM bees ORDER BY id").all() as Row[];
    return rows.map(mapBee);
  }

  archiveBee(beeId: string): BeeRow {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.lifecycle !== "active") {
        throw new IllegalTransitionError(
          `lifecycle ${bee.lifecycle} → archived is outside B1's graph (bee ${beeId})`,
        );
      }
      return this.applyArchive(beeId);
    });
  }

  private applyArchive(beeId: string): BeeRow {
    const at = this.now();
    this.db.prepare("UPDATE bees SET lifecycle = 'archived', archived_at = ? WHERE id = ?").run(at, beeId);
    this.audit("bee.archived", beeId, { beeId, archivedAt: at });
    return this.mustGetBee(beeId);
  }

  unarchiveBee(beeId: string): BeeRow {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.lifecycle !== "archived") {
        throw new IllegalTransitionError(
          `lifecycle ${bee.lifecycle} → active is outside B1's graph (bee ${beeId})`,
        );
      }
      return this.applyUnarchive(beeId);
    });
  }

  private applyUnarchive(beeId: string): BeeRow {
    this.db.prepare("UPDATE bees SET lifecycle = 'active', archived_at = NULL WHERE id = ?").run(beeId);
    this.audit("bee.unarchived", beeId, { beeId });
    return this.mustGetBee(beeId);
  }

  /**
   * Q1 — delete is immediate: record, mailbox, runtimes, flags all removed now; the
   * session log path is returned for the caller to remove (core does no file I/O).
   * An active bee passes through `archived` first (audited) so every step stays on
   * B1's graph. Pending commands for the bee settle `done` (moot — B6 philosophy).
   */
  deleteBee(beeId: string): DeleteResult {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.lifecycle === "active") this.applyArchive(beeId);
      const current = this.currentRuntime(beeId);
      const livePid = current && current.state !== "stopped" ? current.pid : null;
      const at = this.now();
      const pending = this.db
        .prepare("SELECT id FROM commands WHERE bee_id = ? AND status IN ('queued','running') ORDER BY id")
        .all(beeId) as Row[];
      const settledCommandIds = pending.map((r) => Number(r.id));
      if (settledCommandIds.length > 0) {
        this.db
          .prepare("UPDATE commands SET status = 'done', finished_at = ? WHERE bee_id = ? AND status IN ('queued','running')")
          .run(at, beeId);
      }
      // ON DELETE CASCADE removes runtimes, flags, mailbox.
      this.db.prepare("DELETE FROM bees WHERE id = ?").run(beeId);
      this.audit("bee.deleted", beeId, {
        beeId,
        deletedAt: at,
        sessionLogPath: bee.sessionLogPath,
        settledCommandIds,
      });
      return { beeId, sessionLogPath: bee.sessionLogPath, livePid, settledCommandIds };
    });
  }

  // -------------------------------------------------------------------------
  // B2 — runtime states & generations
  // -------------------------------------------------------------------------

  currentRuntime(beeId: string): RuntimeRow | null {
    const row = this.db
      .prepare("SELECT * FROM runtimes WHERE bee_id = ? ORDER BY generation DESC LIMIT 1")
      .get(beeId) as Row | undefined;
    return row ? mapRuntime(row) : null;
  }

  listRuntimes(beeId: string): RuntimeRow[] {
    const rows = this.db
      .prepare("SELECT * FROM runtimes WHERE bee_id = ? ORDER BY generation")
      .all(beeId) as Row[];
    return rows.map(mapRuntime);
  }

  private insertRuntime(
    beeId: string,
    generation: number,
    at: number,
    proc?: { pid: number; pidStartedAt: number },
  ): RuntimeRow {
    this.db
      .prepare(
        `INSERT INTO runtimes(bee_id, generation, state, exit_cause, pid, pid_started_at, started_at, updated_at)
         VALUES(?, ?, 'booting', NULL, ?, ?, ?, ?)`,
      )
      .run(beeId, generation, proc?.pid ?? null, proc?.pidStartedAt ?? null, at, at);
    const runtime = this.currentRuntime(beeId);
    if (!runtime || runtime.generation !== generation) throw new CoreError("runtime insert lost");
    this.audit("runtime.created", beeId, { runtime });
    return runtime;
  }

  /**
   * B2 — state update stamped with the generation it refers to. An update for a
   * non-current generation is a recorded no-op (audit row, no state change).
   * Illegal transitions for the CURRENT generation throw.
   */
  updateRuntimeState(
    beeId: string,
    generation: number,
    state: RuntimeState,
    opts: { exitCause?: ExitCause; pid?: number; pidStartedAt?: number } = {},
  ): { applied: boolean } {
    if (!RUNTIME_TRANSITIONS[state]) {
      throw new IllegalTransitionError(`unknown runtime state: ${state}`);
    }
    return this.tx(() => {
      this.mustGetBee(beeId);
      const current = this.currentRuntime(beeId);
      if (!current) throw new CoreError(`bee ${beeId} has no runtime rows`);
      if (generation !== current.generation) {
        this.audit("runtime.stale_update", beeId, {
          beeId,
          generation,
          currentGeneration: current.generation,
          requestedState: state,
        });
        return { applied: false };
      }
      if (!RUNTIME_TRANSITIONS[current.state].includes(state)) {
        throw new IllegalTransitionError(
          `runtime ${beeId}#${generation}: ${current.state} → ${state} is outside B2's graph`,
        );
      }
      if (state === "stopped") {
        if (!opts.exitCause || !EXIT_CAUSES.includes(opts.exitCause)) {
          throw new IllegalTransitionError(
            `runtime ${beeId}#${generation}: stopped requires an exit_cause from (${EXIT_CAUSES.join(", ")})`,
          );
        }
      } else if (opts.exitCause) {
        throw new IllegalTransitionError(
          `runtime ${beeId}#${generation}: exit_cause is only valid on stopped`,
        );
      }
      if (opts.pid !== undefined && opts.pidStartedAt === undefined) {
        throw new CoreError("pid updates require pidStartedAt (boot re-adoption needs both)");
      }
      const at = this.now();
      const pid = opts.pid !== undefined ? opts.pid : current.pid;
      const pidStartedAt = opts.pidStartedAt !== undefined ? opts.pidStartedAt : current.pidStartedAt;
      this.db
        .prepare(
          `UPDATE runtimes SET state = ?, exit_cause = ?, pid = ?, pid_started_at = ?, updated_at = ?
           WHERE bee_id = ? AND generation = ?`,
        )
        .run(state, opts.exitCause ?? null, pid, pidStartedAt, at, beeId, generation);
      const runtime = this.currentRuntime(beeId);
      this.audit("runtime.updated", beeId, { runtime });
      return { applied: true };
    });
  }

  /** B2 — no transition out of stopped; revival creates generation N+1 (booting). */
  reviveBee(beeId: string, opts: { proc?: { pid: number; pidStartedAt: number } } = {}): RuntimeRow {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.lifecycle === "archived") this.applyUnarchive(beeId); // Q3 spirit: revival implies active
      const current = this.currentRuntime(beeId);
      if (current && current.state !== "stopped") {
        throw new IllegalTransitionError(
          `bee ${beeId}: cannot revive while generation ${current.generation} is ${current.state}`,
        );
      }
      const generation = (current?.generation ?? 0) + 1;
      return this.insertRuntime(beeId, generation, this.now(), opts.proc);
    });
  }

  // -------------------------------------------------------------------------
  // B3 — condition flags (closed list)
  // -------------------------------------------------------------------------

  private assertKnownFlag(flag: string): asserts flag is Flag {
    if (!(FLAGS as readonly string[]).includes(flag)) throw new UnknownFlagError(flag);
  }

  setFlag(beeId: string, flag: string, detail: string): FlagRow {
    this.assertKnownFlag(flag);
    return this.tx(() => {
      this.mustGetBee(beeId);
      return this.applySetFlag(beeId, flag, detail);
    });
  }

  private applySetFlag(beeId: string, flag: Flag, detail: string): FlagRow {
    const existing = this.db
      .prepare("SELECT * FROM flags WHERE bee_id = ? AND flag = ? AND cleared_at IS NULL")
      .get(beeId, flag) as Row | undefined;
    if (existing) {
      this.db.prepare("UPDATE flags SET detail = ? WHERE id = ?").run(detail, Number(existing.id));
      const row = mapFlag({ ...existing, detail });
      this.audit("flag.set", beeId, { flag: row });
      return row;
    }
    const at = this.now();
    const res = this.db
      .prepare("INSERT INTO flags(bee_id, flag, detail, set_at, cleared_at) VALUES(?, ?, ?, ?, NULL)")
      .run(beeId, flag, detail, at);
    const row: FlagRow = {
      id: Number(res.lastInsertRowid),
      beeId,
      flag,
      detail,
      setAt: at,
      clearedAt: null,
    };
    this.audit("flag.set", beeId, { flag: row });
    return row;
  }

  clearFlag(beeId: string, flag: string, detail?: string): { applied: boolean } {
    this.assertKnownFlag(flag);
    return this.tx(() => {
      this.mustGetBee(beeId);
      const existing = this.db
        .prepare("SELECT id FROM flags WHERE bee_id = ? AND flag = ? AND cleared_at IS NULL")
        .get(beeId, flag) as Row | undefined;
      if (!existing) {
        this.audit("flag.clear_noop", beeId, { beeId, flag });
        return { applied: false };
      }
      const at = this.now();
      this.db.prepare("UPDATE flags SET cleared_at = ? WHERE id = ?").run(at, Number(existing.id));
      this.audit("flag.cleared", beeId, {
        flagId: Number(existing.id),
        beeId,
        flag,
        clearedAt: at,
        detail: detail ?? null,
      });
      return { applied: true };
    });
  }

  activeFlags(beeId: string): FlagRow[] {
    const rows = this.db
      .prepare("SELECT * FROM flags WHERE bee_id = ? AND cleared_at IS NULL ORDER BY id")
      .all(beeId) as Row[];
    return rows.map(mapFlag);
  }

  // -------------------------------------------------------------------------
  // B4 / B4a — mailbox (buz IS this mailbox; sender is buz metadata)
  // -------------------------------------------------------------------------

  /**
   * B4 — a single transactional insert. Succeeds iff lifecycle ≠ deleted (a deleted
   * bee has no row → BeeNotFoundError). Archived bees auto-unarchive (Q3). When no
   * live runtime exists, a `send_wake` command is enqueued in the SAME transaction.
   */
  send(beeId: string, body: string, opts: { sender?: string; priority?: number } = {}): SendResult {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      let unarchived = false;
      if (bee.lifecycle === "archived") {
        this.applyUnarchive(beeId);
        unarchived = true;
      }
      const at = this.now();
      const res = this.db
        .prepare("INSERT INTO mailbox(bee_id, sender, body, priority, enqueued_at) VALUES(?, ?, ?, ?, ?)")
        .run(beeId, opts.sender ?? "operator", body, opts.priority ?? 0, at);
      const message: MessageRow = {
        id: Number(res.lastInsertRowid),
        beeId,
        sender: opts.sender ?? "operator",
        body,
        priority: opts.priority ?? 0,
        enqueuedAt: at,
        deliveredAt: null,
        deliveredGeneration: null,
      };
      this.audit("mail.enqueued", beeId, { message });
      const current = this.currentRuntime(beeId);
      let wakeCommand: CommandRow | null = null;
      if (!current || !LIVE_STATES.includes(current.state)) {
        const targetGeneration = current?.generation ?? 0;
        // Bounded queue: an identical pending wake for the same generation is enough.
        const dupe = this.db
          .prepare(
            `SELECT * FROM commands WHERE bee_id = ? AND verb = 'send_wake'
             AND status IN ('queued','running') AND target_generation = ? LIMIT 1`,
          )
          .get(beeId, targetGeneration) as Row | undefined;
        wakeCommand = dupe ? mapCommand(dupe) : this.applyEnqueue("send_wake", beeId, {}, targetGeneration);
      }
      return { message, wakeCommand, unarchived };
    });
  }

  /** Undelivered messages, per-bee FIFO (Q2 — priority column intentionally unused). */
  undeliveredMessages(beeId: string): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL ORDER BY id")
      .all(beeId) as Row[];
    return rows.map(mapMessage);
  }

  getMessage(messageId: number): MessageRow | null {
    const row = this.db.prepare("SELECT * FROM mailbox WHERE id = ?").get(messageId) as Row | undefined;
    return row ? mapMessage(row) : null;
  }

  /**
   * B4 — delivery marks delivered_generation; never twice, and only to the bee's
   * CURRENT generation (a stale consumer's mark is a recorded no-op, mirroring B6).
   */
  markDelivered(messageId: number, generation: number): { applied: boolean } {
    return this.tx(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new CoreError(`message not found: ${messageId}`);
      if (message.deliveredAt != null) {
        this.audit("mail.deliver_noop", message.beeId, {
          messageId,
          reason: "already_delivered",
          deliveredGeneration: message.deliveredGeneration,
        });
        return { applied: false };
      }
      const current = this.currentRuntime(message.beeId);
      if (!current || current.generation !== generation || !LIVE_STATES.includes(current.state)) {
        this.audit("mail.deliver_noop", message.beeId, {
          messageId,
          reason:
            current && current.generation === generation ? "generation_not_live" : "stale_generation",
          generation,
          currentGeneration: current?.generation ?? null,
        });
        return { applied: false };
      }
      const at = this.now();
      this.db
        .prepare("UPDATE mailbox SET delivered_at = ?, delivered_generation = ? WHERE id = ?")
        .run(at, generation, messageId);
      this.audit("mail.delivered", message.beeId, { messageId, deliveredAt: at, deliveredGeneration: generation });
      return { applied: true };
    });
  }

  // -------------------------------------------------------------------------
  // Output recency (a core fact; read cursors live at the client layer)
  // -------------------------------------------------------------------------

  recordOutput(beeId: string): void {
    this.tx(() => {
      this.mustGetBee(beeId);
      const at = this.now();
      this.db.prepare("UPDATE bees SET last_output_at = ? WHERE id = ?").run(at, beeId);
      this.audit("output.recorded", beeId, { beeId, at });
    });
  }

  // -------------------------------------------------------------------------
  // B5 / B6 — command queue with generation fencing
  // -------------------------------------------------------------------------

  enqueueCommand(verb: string, beeId: string, args: Record<string, unknown> = {}): CommandRow {
    if (!(VERBS as readonly string[]).includes(verb)) throw new UnknownVerbError(verb);
    return this.tx(() => {
      this.mustGetBee(beeId);
      const isRuntimeVerb = RUNTIME_VERBS.includes(verb as Verb);
      const targetGeneration = isRuntimeVerb ? (this.currentRuntime(beeId)?.generation ?? 0) : null;
      return this.applyEnqueue(verb as Verb, beeId, args, targetGeneration);
    });
  }

  private applyEnqueue(
    verb: Verb,
    beeId: string,
    args: Record<string, unknown>,
    targetGeneration: number | null,
  ): CommandRow {
    const at = this.now();
    const res = this.db
      .prepare(
        `INSERT INTO commands(verb, bee_id, args, target_generation, status, attempts, next_attempt_at, enqueued_at)
         VALUES(?, ?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(verb, beeId, JSON.stringify(args), targetGeneration, at, at);
    const command: CommandRow = {
      id: Number(res.lastInsertRowid),
      verb,
      beeId,
      args,
      targetGeneration,
      status: "queued",
      attempts: 0,
      nextAttemptAt: at,
      enqueuedAt: at,
      finishedAt: null,
      failureCause: null,
    };
    this.audit("command.enqueued", beeId, { command });
    return command;
  }

  getCommand(id: number): CommandRow | null {
    const row = this.db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as Row | undefined;
    return row ? mapCommand(row) : null;
  }

  listCommands(filter: { beeId?: string; status?: CommandRow["status"] } = {}): CommandRow[] {
    let sql = "SELECT * FROM commands";
    const where: string[] = [];
    const params: Array<string> = [];
    if (filter.beeId !== undefined) {
      where.push("bee_id = ?");
      params.push(filter.beeId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY id";
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapCommand);
  }

  /**
   * Claim the next ready command (queued → running). B6: a command whose
   * target_generation no longer matches the bee's current generation settles `done`
   * as a recorded no-op — the intent is moot, not failed — and claiming continues.
   */
  claimNextCommand(): CommandRow | null {
    return this.tx(() => {
      for (;;) {
        const row = this.db
          .prepare(
            "SELECT * FROM commands WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 1",
          )
          .get(this.now()) as Row | undefined;
        if (!row) return null;
        const command = mapCommand(row);
        if (command.targetGeneration != null) {
          const current = this.currentRuntime(command.beeId);
          const currentGeneration = current?.generation ?? 0;
          if (currentGeneration !== command.targetGeneration) {
            const at = this.now();
            this.db
              .prepare("UPDATE commands SET status = 'done', finished_at = ? WHERE id = ?")
              .run(at, command.id);
            this.audit("command.moot", command.beeId, {
              commandId: command.id,
              verb: command.verb,
              targetGeneration: command.targetGeneration,
              currentGeneration,
              finishedAt: at,
            });
            continue;
          }
        }
        this.db.prepare("UPDATE commands SET status = 'running' WHERE id = ?").run(command.id);
        this.audit("command.claimed", command.beeId, { commandId: command.id });
        return { ...command, status: "running" };
      }
    });
  }

  /** Settle a claimed command as done. Re-completing a settled command is a recorded no-op. */
  completeCommand(id: number): { applied: boolean } {
    return this.tx(() => {
      const command = this.getCommand(id);
      if (!command) throw new CoreError(`command not found: ${id}`);
      if (command.status === "done") {
        this.audit("command.complete_noop", command.beeId, { commandId: id });
        return { applied: false };
      }
      if (command.status !== "running") {
        throw new CommandProtocolError(`command ${id} is ${command.status}; claim before completing`);
      }
      const at = this.now();
      this.db.prepare("UPDATE commands SET status = 'done', finished_at = ? WHERE id = ?").run(at, id);
      this.audit("command.completed", command.beeId, { commandId: id, finishedAt: at });
      return { applied: true };
    });
  }

  /**
   * B5 — report a (real-world-boundary) execution failure: retries with exponential
   * backoff until maxAttempts, then settles `failed` with a closed-list failure_cause
   * and sets the corresponding bee flag. No unbounded background repair.
   */
  reportCommandFailure(
    id: number,
    cause: string,
    detail?: string,
  ): { status: "queued" | "failed"; attempts: number; nextAttemptAt: number | null } {
    if (!(FLAGS as readonly string[]).includes(cause)) throw new UnknownFailureCauseError(cause);
    return this.tx(() => {
      const command = this.getCommand(id);
      if (!command) throw new CoreError(`command not found: ${id}`);
      if (command.status !== "running") {
        throw new CommandProtocolError(`command ${id} is ${command.status}; claim before reporting failure`);
      }
      const attempts = command.attempts + 1;
      const at = this.now();
      if (attempts >= this.maxAttempts) {
        this.db
          .prepare("UPDATE commands SET status = 'failed', attempts = ?, finished_at = ?, failure_cause = ? WHERE id = ?")
          .run(attempts, at, cause, id);
        this.audit("command.failed", command.beeId, {
          commandId: id,
          attempts,
          finishedAt: at,
          failureCause: cause,
        });
        // Exhausted retries land in a §4.2 flag, visibly.
        if (this.getBee(command.beeId)) {
          this.applySetFlag(
            command.beeId,
            cause as FailureCause,
            detail ?? `${command.verb} failed after ${attempts} attempts: ${cause}`,
          );
        }
        return { status: "failed" as const, attempts, nextAttemptAt: null };
      }
      const nextAttemptAt = at + this.backoffBaseMs * 2 ** (attempts - 1);
      this.db
        .prepare("UPDATE commands SET status = 'queued', attempts = ?, next_attempt_at = ? WHERE id = ?")
        .run(attempts, nextAttemptAt, id);
      this.audit("command.requeued", command.beeId, {
        commandId: id,
        attempts,
        nextAttemptAt,
        cause,
        detail: detail ?? null,
      });
      return { status: "queued" as const, attempts, nextAttemptAt };
    });
  }

  // -------------------------------------------------------------------------
  // B7 — boot reconciliation
  // -------------------------------------------------------------------------

  /**
   * The single boot entry point: every runtime in booting/running/idle whose
   * (pid, pid_started_at) is not in livePids becomes stopped(machine_restart).
   * A reboot produces ZERO failed states. Surviving runtimes are re-adopted.
   */
  reconcileAtBoot(livePids: LivePid[]): ReconcileResult {
    return this.tx(() => {
      const live = new Set(livePids.map((p) => `${p.pid}:${p.startedAt}`));
      const rows = this.db
        .prepare("SELECT * FROM runtimes WHERE state != 'stopped' ORDER BY bee_id, generation")
        .all() as Row[];
      const stopped: ReconcileResult["stopped"] = [];
      const adopted: ReconcileResult["adopted"] = [];
      for (const raw of rows) {
        const rt = mapRuntime(raw);
        const alive =
          rt.pid != null && rt.pidStartedAt != null && live.has(`${rt.pid}:${rt.pidStartedAt}`);
        if (alive) {
          adopted.push({ beeId: rt.beeId, generation: rt.generation, pid: rt.pid as number });
          continue;
        }
        const at = this.now();
        this.db
          .prepare(
            `UPDATE runtimes SET state = 'stopped', exit_cause = 'machine_restart', updated_at = ?
             WHERE bee_id = ? AND generation = ?`,
          )
          .run(at, rt.beeId, rt.generation);
        const updated = this.db
          .prepare("SELECT * FROM runtimes WHERE bee_id = ? AND generation = ?")
          .get(rt.beeId, rt.generation) as Row;
        this.audit("runtime.updated", rt.beeId, { runtime: mapRuntime(updated) });
        stopped.push({ beeId: rt.beeId, generation: rt.generation });
      }
      this.audit("boot.reconciled", null, {
        stopped,
        adopted,
        requeuedCommandIds: this.bootRequeuedCommandIds,
      });
      return { stopped, adopted, requeuedCommandIds: this.bootRequeuedCommandIds };
    });
  }

  // -------------------------------------------------------------------------
  // B8 — derived reads (the ONLY place these questions are answered)
  // -------------------------------------------------------------------------

  view(beeId: string, opts: { readCursor?: number } = {}): BeeView {
    const bee = this.getBee(beeId);
    if (!bee) {
      // Deleted (or never-existed) bee: unreachable — the one lifecycle that is.
      return {
        beeId,
        exists: false,
        lifecycle: null,
        generation: null,
        runtimeState: null,
        exitCause: null,
        working: false,
        waitingForYou: false,
        lastOutputAt: null,
        reachable: false,
        blocked: false,
        flags: [],
      };
    }
    const runtime = this.currentRuntime(beeId);
    const flags = this.activeFlags(beeId).map((f) => f.flag);
    const state = runtime?.state ?? null;
    const working = state === "booting" || state === "running";
    const unreadOutput =
      bee.lastOutputAt != null && (opts.readCursor == null || opts.readCursor < bee.lastOutputAt);
    const waitingForYou = state === "idle" || (state === "stopped" && unreadOutput);
    return {
      beeId,
      exists: true,
      lifecycle: bee.lifecycle,
      generation: runtime?.generation ?? null,
      runtimeState: state,
      exitCause: runtime?.exitCause ?? null,
      working,
      waitingForYou,
      lastOutputAt: bee.lastOutputAt,
      reachable: true, // lifecycle ≠ deleted (deleted rows do not exist). Nothing else.
      blocked: flags.length > 0,
      flags,
    };
  }

  views(): BeeView[] {
    return this.listBees().map((b) => this.view(b.id));
  }

  // -------------------------------------------------------------------------
  // Audit access & snapshots
  // -------------------------------------------------------------------------

  auditRows(fromSeq = 0): AuditRow[] {
    const rows = this.db
      .prepare("SELECT * FROM audit WHERE seq > ? ORDER BY seq")
      .all(fromSeq) as Row[];
    return rows.map(mapAudit);
  }

  /** Deterministic snapshot of all replayable state (meta and audit excluded). */
  dumpState(): StateDump {
    return {
      bees: this.listBees(),
      runtimes: (this.db.prepare("SELECT * FROM runtimes ORDER BY bee_id, generation").all() as Row[]).map(
        mapRuntime,
      ),
      flags: (this.db.prepare("SELECT * FROM flags ORDER BY id").all() as Row[]).map(mapFlag),
      mailbox: (this.db.prepare("SELECT * FROM mailbox ORDER BY id").all() as Row[]).map(mapMessage),
      commands: (this.db.prepare("SELECT * FROM commands ORDER BY id").all() as Row[]).map(mapCommand),
    };
  }
}

/** Open (or create) the node's core store. The returned object is the single writer (B9). */
export function openCoreStore(path: string, opts: CoreStoreOptions = {}): CoreStore {
  return new CoreStore(path, opts);
}
