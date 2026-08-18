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
import type { AccountLimitsRow, AccountRow, AuditRow, BeeRow, BeeView, QuestionRow, RuntimeRow, SealRow, TemplateRow, TrackRow } from "./types.ts";

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

/** v6: questions mirror as their store rows, verbatim (Apiary's inbox surfaces `status = open`). */
export type MirrorQuestionRow = QuestionRow;

/** v6: seals mirror as their store rows, verbatim. */
export type MirrorSealRow = SealRow;

/** v7 (spec 08): accounts mirror as their store rows, verbatim (`hive_accounts`). */
export type MirrorAccountRow = AccountRow;

/** v7: the latest limits snapshot per account, verbatim (`hive_account_limits` — the account-menu usage hint). */
export type MirrorAccountLimitsRow = AccountLimitsRow;

/**
 * The versioned snapshot: replace all mirror tables in one transaction
 * stamped `seq`, then apply deltas with `baseSeq === seq`. `questions` and
 * `seals` are v6 additions — additive: a v2/1 materializer that ignores
 * unknown keys stays correct.
 */
export interface MirrorSnapshot {
  seq: number;
  bees: MirrorBeeRow[];
  templates: MirrorTemplateRow[];
  tracks: MirrorTrackRow[];
  questions: MirrorQuestionRow[];
  seals: MirrorSealRow[];
  /** v7 (additive): accounts + their latest limits, store rows verbatim. */
  accounts: MirrorAccountRow[];
  accountLimits: MirrorAccountLimitsRow[];
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
 * v6 (pre-flip verbs) adds, all additive:
 *   bee.renamed        → { beeId, name, previous }                     (bee row: name)
 *   bee.tagged         → { beeId, tags, previous, added, removed }     (bee row: tags)
 *   bee.orphaned       → { beeId, parentId, reason }                   (bee row: parentId → null)
 *   bee.forked         → { beeId, forkedFrom, forkSeed }               (informational; row via bee.created)
 *   bee.interrupted    → { beeId, generation, interrupted, reason }    (informational; no row change)
 *   question.asked     → { question: QuestionRow }                     (questions table: insert)
 *   question.answered  → { questionId, beeId, answer, answeredAt, answeredBy, deliveryMessageId }
 *                                                                        (questions table: status/answer)
 *   seal.created       → { seal: SealRow }                             (seals table: insert)
 * `bee.provider_session` may now also carry `forkSeedConsumed` (bee row: forkSeed → null).
 * v7 (accounts, spec 08) adds, all additive:
 *   account.put          → { account: AccountRow, outcome: "created"|"updated", changed?, previous?, reason? }
 *                                                                        (accounts table: upsert the row verbatim)
 *   account.removed      → { accountId, harness, removedAt, cursorCleared }  (accounts + account_limits: delete)
 *   account_limits.put   → { limits: AccountLimitsRow }                 (account_limits table: upsert)
 *   selection_cursor.set → { cursor }                                   (internal; no mirror table)
 *   bee.account_set      → { beeId, account, previous }                 (bee row: account)
 *   bee.env_set          → { beeId, env, previous }                     (bee row: env)
 *   bee.session_rekeyed  → { beeId, forkSeed, previousProviderSessionId } (bee row: forkSeed set, providerSessionId → null)
 * v8 (delivery urgency, spec 01 Q2 amendment) is additive INSIDE an existing
 * payload: `mail.enqueued`'s MessageRow gains `urgency` ('now'|'next'|'idle');
 * pre-v8 deltas simply lack the key and mean `next`. The daemon's `mailbox`
 * read returns the same shape. No new kinds; a materializer that ignores
 * unknown keys stays correct.
 */
export const MIRROR_TEMPLATE_AUDIT_KINDS = ["template.put", "template.deleted"] as const;
export const MIRROR_TRACK_AUDIT_KINDS = ["track.put", "track.deleted"] as const;
export const MIRROR_QUESTION_AUDIT_KINDS = ["question.asked", "question.answered"] as const;
export const MIRROR_SEAL_AUDIT_KINDS = ["seal.created"] as const;
export const MIRROR_ACCOUNT_AUDIT_KINDS = ["account.put", "account.removed"] as const;
export const MIRROR_ACCOUNT_LIMITS_AUDIT_KINDS = ["account_limits.put", "account.removed"] as const;
export type MirrorAccountAuditKind = (typeof MIRROR_ACCOUNT_AUDIT_KINDS)[number];
export type MirrorAccountLimitsAuditKind = (typeof MIRROR_ACCOUNT_LIMITS_AUDIT_KINDS)[number];
export type MirrorTemplateAuditKind = (typeof MIRROR_TEMPLATE_AUDIT_KINDS)[number];
export type MirrorTrackAuditKind = (typeof MIRROR_TRACK_AUDIT_KINDS)[number];
export type MirrorQuestionAuditKind = (typeof MIRROR_QUESTION_AUDIT_KINDS)[number];
export type MirrorSealAuditKind = (typeof MIRROR_SEAL_AUDIT_KINDS)[number];

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
  // v6: additive — parenting (parentId), fork provenance (forkedFrom) and the
  // one-shot fork seed (forkSeed; null once consumed).
  "parentId",
  "forkedFrom",
  "forkSeed",
  // v7: additive — the account binding (accounts.id | null).
  "account",
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
export const MIRROR_QUESTION_KEYS = [
  "id",
  "beeId",
  "generation",
  "text",
  "options",
  "status",
  "answer",
  "askedAt",
  "answeredAt",
  "answeredBy",
  "deliveryMessageId",
] as const;
export const MIRROR_SEAL_KEYS = ["id", "beeId", "generation", "title", "body", "refs", "createdAt"] as const;
export const MIRROR_ACCOUNT_KEYS = [
  "id",
  "harness",
  "homePath",
  "label",
  "status",
  "penalty",
  "lastLoginAt",
  "exhaustedAt",
  "addedAt",
  "updatedAt",
] as const;
export const MIRROR_ACCOUNT_LIMITS_KEYS = [
  "account",
  "fetchedAt",
  "readable",
  "error",
  "plan",
  "fiveHourPct",
  "fiveHourResetsAt",
  "fiveHourMinutes",
  "weeklyPct",
  "weeklyResetsAt",
  "weeklyMinutes",
  "fableWeeklyPct",
  "fableResetsAt",
  "fableMinutes",
] as const;
