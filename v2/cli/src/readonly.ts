/**
 * Read-only SQLite fallback for CLI reads when the daemon is down (spec 04
 * CLI). Contract §3.5: direct store access is read-only — this module opens
 * the database with `readOnly: true` and can never write. Views derive
 * through core's `deriveBeeView` (B8: one read-model function). All output
 * from this path is labeled stale by the CLI.
 */
import { DatabaseSync } from "node:sqlite";
import {
  deriveBeeView,
  type TemplateRow,
  type TrackRow,
  type BeeRow,
  type BeeView,
  type CommandRow,
  type ExitCause,
  type Flag,
  type MessageRow,
  type RuntimeRow,
  type RuntimeState,
} from "../../core/src/index.ts";

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
    // v3 columns; tolerate a pre-v3 store file read cold (columns absent).
    providerSessionId: (r.provider_session_id as string | null | undefined) ?? null,
    env: JSON.parse((r.env as string | null | undefined) ?? "{}") as Record<string, string>,
    importedFrom: (r.imported_from as string | null | undefined) ?? null,
    spawnFailures: Number((r.spawn_failures as number | null | undefined) ?? 0),
    // v5 column; same tolerance.
    args: r.args == null ? null : (JSON.parse(String(r.args)) as string[]),
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
    verb: r.verb as CommandRow["verb"],
    beeId: r.bee_id as string,
    args: JSON.parse(r.args as string) as Record<string, unknown>,
    targetGeneration: r.target_generation == null ? null : Number(r.target_generation),
    status: r.status as CommandRow["status"],
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    enqueuedAt: Number(r.enqueued_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    failureCause: (r.failure_cause as CommandRow["failureCause"]) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
  };
}

function mapTemplateRow(r: Row): TemplateRow {
  return {
    id: r.id as string,
    name: r.name as string,
    scope: r.scope as TemplateRow["scope"],
    source: r.source as TemplateRow["source"],
    description: (r.description as string | null) ?? null,
    agent: r.agent as string,
    substrate: (r.substrate as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    args: JSON.parse(r.args as string) as string[],
    prompt: r.prompt as string,
    preamble: (r.preamble as string | null) ?? null,
    preambleEnabled: Number(r.preamble_enabled) === 1,
    cwdPolicy: r.cwd_policy as TemplateRow["cwdPolicy"],
    cwd: (r.cwd as string | null) ?? null,
    env: JSON.parse(r.env as string) as Record<string, string>,
    account: (r.account as string | null) ?? null,
    yolo: Number(r.yolo) === 1,
    tags: JSON.parse(r.tags as string) as string[],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapTrackRow(r: Row): TrackRow {
  return {
    id: r.id as string,
    name: r.name as string,
    scope: r.scope as TrackRow["scope"],
    source: r.source as TrackRow["source"],
    description: (r.description as string | null) ?? null,
    steps: JSON.parse(r.steps as string) as TrackRow["steps"],
    tags: JSON.parse(r.tags as string) as string[],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export interface StaleViewResult {
  view: BeeView;
  bee: BeeRow | null;
  runtime: RuntimeRow | null;
}

export class ReadOnlyStore {
  private readonly db: DatabaseSync;

  constructor(storePath: string) {
    this.db = new DatabaseSync(storePath, { readOnly: true });
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  getBee(beeId: string): BeeRow | null {
    const row = this.db.prepare("SELECT * FROM bees WHERE id = ?").get(beeId) as Row | undefined;
    return row ? mapBee(row) : null;
  }

  listBees(): BeeRow[] {
    return (this.db.prepare("SELECT * FROM bees ORDER BY id").all() as Row[]).map(mapBee);
  }

  currentRuntime(beeId: string): RuntimeRow | null {
    const row = this.db
      .prepare("SELECT * FROM runtimes WHERE bee_id = ? ORDER BY generation DESC LIMIT 1")
      .get(beeId) as Row | undefined;
    return row ? mapRuntime(row) : null;
  }

  activeFlags(beeId: string): Flag[] {
    const rows = this.db
      .prepare("SELECT flag FROM flags WHERE bee_id = ? AND cleared_at IS NULL ORDER BY id")
      .all(beeId) as Row[];
    return rows.map((r) => r.flag as Flag);
  }

  view(beeId: string): StaleViewResult {
    const bee = this.getBee(beeId);
    return {
      view: deriveBeeView(
        beeId,
        bee,
        bee ? this.currentRuntime(beeId) : null,
        bee ? this.activeFlags(beeId) : [],
      ),
      bee,
      runtime: bee ? this.currentRuntime(beeId) : null,
    };
  }

  list(lifecycle: string | null): StaleViewResult[] {
    return this.listBees()
      .filter((b) => lifecycle == null || b.lifecycle === lifecycle)
      .map((b) => this.view(b.id));
  }

  mailbox(beeId: string): MessageRow[] {
    return (this.db.prepare("SELECT * FROM mailbox WHERE bee_id = ? ORDER BY id").all(beeId) as Row[]).map(
      mapMessage,
    );
  }

  listTemplates(): TemplateRow[] {
    return (this.db.prepare("SELECT * FROM templates ORDER BY id").all() as Row[]).map(mapTemplateRow);
  }

  listTracks(): TrackRow[] {
    return (this.db.prepare("SELECT * FROM tracks ORDER BY id").all() as Row[]).map(mapTrackRow);
  }

  commands(beeId: string): CommandRow[] {
    return (this.db.prepare("SELECT * FROM commands WHERE bee_id = ? ORDER BY id").all(beeId) as Row[]).map(
      mapCommand,
    );
  }
}
