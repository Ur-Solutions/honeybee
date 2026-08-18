/**
 * Mirror-shape contract (spec 06 §2.2): the EXACT row shapes apiaryd
 * materializes into interface.sqlite mirror tables. apiaryd's materializer
 * codes against these types and nothing else; the daemon's `list()` /
 * `snapshot()` / `watch()` results are built from them verbatim.
 *
 * "No derivation in apiaryd": a bee mirror row is hive's `view()` output plus
 * the raw bee + current runtime rows — never an interpretation. Templates and
 * tracks mirror as their store rows. Deltas are audit rows; the mirror is
 * always exactly "hive at seq N".
 *
 * Changing anything here is a protocol change (bump PROTOCOL in the daemon).
 * The shape snapshot test (tests/mirror.test.ts) fails on any drift.
 */
import type { AuditRow, BeeRow, BeeView, RuntimeRow, TemplateRow, TrackRow } from "./types.ts";

/** One bee as apiaryd stores it: B8 view verbatim + record + current runtime. */
export interface MirrorBeeRow {
  view: BeeView;
  /** null only for a view of a deleted/never-existed bee (never in snapshots). */
  bee: BeeRow | null;
  runtime: RuntimeRow | null;
}

/** Templates mirror as their store rows, verbatim. */
export type MirrorTemplateRow = TemplateRow;

/** Tracks mirror as their store rows, verbatim. */
export type MirrorTrackRow = TrackRow;

/**
 * The versioned snapshot: replace all three mirror tables in one transaction
 * stamped `seq`, then apply deltas with `baseSeq === seq`.
 */
export interface MirrorSnapshot {
  seq: number;
  bees: MirrorBeeRow[];
  templates: MirrorTemplateRow[];
  tracks: MirrorTrackRow[];
}

/** A watch delta is a contiguous run of audit rows (see daemon protocol.ts WatchFrame). */
export type MirrorDelta = AuditRow;

/**
 * Audit kinds that touch the template/track mirror tables. Payload shapes:
 *   template.put     → { template: TemplateRow, outcome: "created" | "updated" }
 *   template.deleted → { templateId: string, deletedAt: number }
 *   track.put        → { track: TrackRow, outcome: "created" | "updated" }
 *   track.deleted    → { trackId: string, deletedAt: number }
 * Every other kind (bee.*, runtime.*, flag.*, mail.*, command.*, output.*, boot.*)
 * touches bee mirror rows; a materializer that cannot re-derive a bee row from
 * the delta re-reads that bee (view) — or takes the snapshot path.
 * v3 adds `bee.provider_session` (bee row: providerSessionId changed) and
 * `bee.imported` (informational provenance; no row change beyond the
 * preceding bee.created). v4 adds `bee.spawn_failures` (bee row:
 * spawnFailures changed) and `wake.suppressed` (informational: a wake was
 * not enqueued because `spawn_failed` is set; no row change).
 * v5 adds `bee.args_set` (bee row: args changed;
 * payload { beeId, args: string[] | null, previous }).
 */
export const MIRROR_TEMPLATE_AUDIT_KINDS = ["template.put", "template.deleted"] as const;
export const MIRROR_TRACK_AUDIT_KINDS = ["track.put", "track.deleted"] as const;
export type MirrorTemplateAuditKind = (typeof MIRROR_TEMPLATE_AUDIT_KINDS)[number];
export type MirrorTrackAuditKind = (typeof MIRROR_TRACK_AUDIT_KINDS)[number];

/** Key lists — the shape snapshot; a materializer's column map must cover exactly these. */
export const MIRROR_BEE_ROW_KEYS = ["view", "bee", "runtime"] as const;
export const MIRROR_BEE_VIEW_KEYS = [
  "beeId",
  "exists",
  "lifecycle",
  "generation",
  "runtimeState",
  "exitCause",
  "working",
  "waitingForYou",
  "lastOutputAt",
  "reachable",
  "blocked",
  "flags",
] as const;
export const MIRROR_BEE_RECORD_KEYS = [
  "id",
  "name",
  "agent",
  "substrate",
  "cwd",
  "title",
  "tags",
  "sessionLogPath",
  "lifecycle",
  "createdAt",
  "archivedAt",
  "lastOutputAt",
  // v3 (WP7): additive — a v2/1 materializer that ignores unknown keys stays correct.
  "providerSessionId",
  "env",
  "importedFrom",
  // v4: consecutive boot failures (the spawn-retry budget); additive likewise.
  "spawnFailures",
  // v5: additive — per-bee spawn args (string[] | null).
  "args",
] as const;
export const MIRROR_RUNTIME_KEYS = [
  "beeId",
  "generation",
  "state",
  "exitCause",
  "pid",
  "pidStartedAt",
  "startedAt",
  "updatedAt",
] as const;
export const MIRROR_TEMPLATE_KEYS = [
  "id",
  "name",
  "scope",
  "source",
  "description",
  "agent",
  "substrate",
  "model",
  "effort",
  "args",
  "prompt",
  "preamble",
  "preambleEnabled",
  "cwdPolicy",
  "cwd",
  "env",
  "account",
  "yolo",
  "tags",
  "createdAt",
  "updatedAt",
] as const;
export const MIRROR_TRACK_KEYS = ["id", "name", "scope", "source", "description", "steps", "tags", "createdAt", "updatedAt"] as const;
export const MIRROR_TRACK_STEP_KEYS = ["id", "name", "kind", "templateId", "instruction", "note", "status"] as const;
