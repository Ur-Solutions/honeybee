// tmux pane-id shape validation and fused-stamp recovery.
//
// A tmux pane id, as printed by #{pane_id}, is always "%" + a decimal index
// ("%7", "%110"). Anything else stored in SessionRecord.agentPaneId is a
// mis-stamp: the pane-liveness probe can never match it, so a live bee reads
// as permanently crashed (review cell-review-2026-08-09 §1.1). The known
// mis-stamp family is the FUSED stamp: launch output formatted as
// "#{pane_id}\t#{pane_pid}" whose tab was sanitized to "_" by a tmux server
// running without a UTF-8 locale (launchd-started servers), fusing pane id
// and pid into one token like "%110_18981".

const PANE_ID_PATTERN = /^%\d+$/;

/** True when the value has the exact #{pane_id} shape ("%" + digits). */
export function isWellFormedPaneId(value: string): boolean {
  return PANE_ID_PATTERN.test(value);
}

/**
 * Recover the parts of a fused "%id\tpid" / "%id_pid" launch stamp.
 * Returns null for anything that is not exactly that shape — including an
 * already-well-formed pane id.
 */
export function splitFusedPaneStamp(value: string): { paneId: string; pid: number } | null {
  const match = value.match(/^(%\d+)[\t_](\d+)$/);
  if (!match) return null;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { paneId: match[1]!, pid };
}
