/**
 * DRIFT FIXTURE — the Apiary consumer's expectation of the cell verbs.
 *
 * Copied VERBATIM (types only; formatting kept) from
 *   apiary: services/apiaryd/src/domains/hive/hiveProtocol.ts
 *   section "Cell verbs (spec 06 §5.1 / spec 05 points 4 + 6) — CLIENT CALL SHAPE"
 * as of 2026-08-18. cells.test.ts asserts, at the type level AND at runtime
 * (key sets of real daemon results), that honeybee's protocol.ts shapes are
 * exactly these. If either side moves, this file is where the drift shows;
 * update it from the apiary source, never by hand-editing to make the test
 * pass.
 */

export type HiveCellCaptureMode = 'merge' | 'rebase'

/** `cell.capture` params. */
export interface HiveCellCaptureParams {
  beeId: string
  /** Branch in the origin to land onto (created if absent). */
  targetBranch: string
  mode: HiveCellCaptureMode
  idempotencyKey: string
}

/**
 * `cell.capture` result — `CaptureReport` from `v2/driver-cell/src/capture.ts`
 * verbatim, plus the dedup markers. A failed land (`conflict` | `refused`)
 * leaves the origin's ref set bit-identical (A1 zero-artifact guarantee).
 */
export interface HiveCellCaptureResult {
  status: 'landed' | 'nothing_to_capture' | 'conflict' | 'refused'
  targetBranch: string
  mode: HiveCellCaptureMode
  /** The cell HEAD that was captured. */
  cellHead: string | null
  /** The target tip the operation started from (null = branch created). */
  baseTarget: string | null
  /** The commit the target branch now points at (landed only). */
  resultSha: string | null
  /** Conflicted paths (conflict only) — staged for the operator, never auto-resolved. */
  conflicts: string[]
  /** Refusal reason (refused only). */
  reason: 'target_checked_out' | 'target_moved' | 'no_cell_head' | null
  deduped?: boolean
}

/** `cell.remove` params. `force` = the `--force` equivalent (A2). */
export interface HiveCellRemoveParams {
  beeId: string
  force?: boolean
  idempotencyKey: string
}

/** `DirtyReport` from `v2/driver-cell/src/remove.ts` verbatim. */
export interface HiveCellDirtyReport {
  dirty: boolean
  /** Uncommitted working-tree changes in the space. */
  uncommitted: boolean
  /** Cell HEAD commits the origin repo does not contain. */
  unpushed: boolean
  /** The origin could not be consulted (missing/moved) — treated as dirty. */
  originUnknown: boolean
}

/**
 * `cell.remove` result. `deleted` = the cell directory is gone AND the bee's
 * lifecycle `delete` was enqueued in the same call (`commandId`); `refused` =
 * dirty without force (report carries the three causes, nothing changed);
 * `absent` = no provisioned cell (bee delete still enqueued). A bee with a
 * live runtime answers `ok:false, error.code = 'runtime_refused'` — stop it
 * first; a non-cell bee answers `invalid_request`.
 */
export interface HiveCellRemoveResult {
  status: 'deleted' | 'refused' | 'absent'
  forced: boolean
  report: HiveCellDirtyReport | null
  /** The lifecycle delete command (deleted | absent). */
  commandId: number | null
  deduped?: boolean
}

// ---------------------------------------------------------------------------
// Runtime key sets — what a real daemon result must consist of, exactly.
// ---------------------------------------------------------------------------

export const CAPTURE_RESULT_KEYS = [
  'status',
  'targetBranch',
  'mode',
  'cellHead',
  'baseTarget',
  'resultSha',
  'conflicts',
  'reason',
] as const

export const REMOVE_RESULT_KEYS = ['status', 'forced', 'report', 'commandId'] as const

export const DIRTY_REPORT_KEYS = ['dirty', 'uncommitted', 'unpushed', 'originUnknown'] as const

/** The Apiary error codes the two verbs may answer with (must be in honeybee's closed list). */
export const CELL_VERB_ERROR_CODES = ['bee_not_found', 'invalid_request', 'runtime_refused'] as const
