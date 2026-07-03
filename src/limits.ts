// ──────────────────────────────────────────────────────────────────────────
// Provider limit windows: remaining 5h/weekly usage relative to the REAL
// limits, per account, plus the on-disk cache and the auto/round-robin account
// pickers built on top.
//
// This is the public barrel. The implementation lives in limits/*: the shared
// types + window math, the per-provider fetchers (claude OAuth usage, codex
// live RPC + session snapshots), the provider-keyed dispatch, the limits cache,
// and account selection (least-loaded `auto` + round-robin `rr`). Every symbol
// below kept its original name and signature so existing imports of
// "./limits.js" are unaffected.
// ──────────────────────────────────────────────────────────────────────────

export type {
  WindowUsage,
  AccountLimits,
  LimitsDeps,
  ClaudeUsageResponse,
  CodexLiveWindow,
  CodexLiveRateLimits,
} from "./limits/types.js";

export { paceDelta, windowRolledOver } from "./limits/window.js";

export { CLAUDE_PROFILE_EMAIL_CACHE_MAX } from "./limits/claude.js";

export { lastRateLimitsInFile } from "./limits/codex.js";

export { accountLimits, allAccountLimits, sortAccountsForLimitsDisplay } from "./limits/dispatch.js";

export {
  type LimitsCacheEntry,
  type CachedLimitsOptions,
  limitsCachePath,
  cachedAccountLimits,
} from "./limits/cache.js";

export {
  AUTO_FIVE_HOUR_SATURATION_PERCENT,
  AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT,
  AUTO_ACCOUNT_TTL_MS,
  effectiveWindowLoad,
  selectLeastLoadedAccount,
  pickLeastLoadedAccount,
  type AutoAccountCandidate,
  type AutoAccountChoice,
  type PickAccountDeps,
} from "./limits/autoPick.js";

export type { RefreshedClaudeToken } from "./accounts.js";
export { codexAuthEmail, emailFromJwt } from "./accounts.js";
