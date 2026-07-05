/**
 * Remote codex token refresher (UNIT 2) — the daemon-side task that keeps a LIVE
 * remote ephemeral-token codex bee's access token fresh.
 *
 * A remote codex bee runs on an access-token-only credential: the vault ships a
 * FRESH access token with the refresh token BLANKED (hsr/remoteCreds.ts). The
 * access token lasts ~10 days, so mid-run expiry is RARE — but once it dies the
 * remote codex CANNOT self-refresh (blanked refresh_token) and errors. Two paths
 * converge here on the SAME recovery (mint a fresh token centrally → re-deliver
 * to the remote → restart the runner with resume so codex re-reads auth.json):
 *
 *   PROACTIVE (primary): a bee whose persisted `remoteTokenExpiresAt` is within
 *     the refresh window (default 60m) is refreshed BEFORE the token dies.
 *   REACTIVE (backstop): a bee whose mirrored events carry a NEW `auth_expired`
 *     (the codex adapter classifies the "Failed to refresh token … empty_string"
 *     / 401 failure) is refreshed immediately.
 *
 * Minting runs HERE (the daemon has the accounts/vault); the remote bundle never
 * gains the accounts graph. Serialized per bee: an in-flight refresh, and a short
 * cooldown after any attempt, keep ticks from stacking refreshes. Secret-free.
 *
 * Node builtins + existing honeybee modules only.
 */

import { listAccounts as defaultListAccounts, type AccountRecord } from "../accounts.js";
import { mintEphemeralCredential, type EphemeralCredential } from "../hsr/remoteCreds.js";
import type { HsrObservation } from "../hsr/observe.js";
import type { RemoteHsrSubstrate } from "../substrates/remote-hsr.js";
import { remoteHsrSubstrateForNode } from "../substrates/index.js";
import { authPolicyOf, loadNode as defaultLoadNode, LOCAL_NODE_NAME, type NodeRecord } from "../node.js";
import { appendLedger as defaultAppendLedger, updateSession as defaultUpdateSession, type SessionRecord } from "../store.js";

/** Default refresh window: re-deliver when the token has under this TTL remaining. */
export const DEFAULT_TOKEN_REFRESH_WINDOW_MS = 60 * 60_000;
/** After ANY refresh attempt for a bee, wait this long before another (throttle retries). */
export const DEFAULT_TOKEN_REFRESH_COOLDOWN_MS = 60_000;

/** Only these harnesses ship an access-token-only credential (blanked refresh) today. */
const REFRESHABLE_HARNESS = "codex";

export type TokenRefreshOutcome = {
  bee: string;
  account?: string;
  ok: boolean;
  /** Why the refresh fired. Absent on a skip. */
  trigger?: "proactive" | "reactive";
  /** The new token expiry (unix seconds) on success. */
  expiresAt?: number;
  /** Set when the bee was considered but not acted on (never logged as a refresh). */
  skipped?: string;
  error?: string;
};

export type TokenRefresherDeps = {
  loadNode?: (name: string) => Promise<NodeRecord | null>;
  listAccounts?: () => Promise<AccountRecord[]>;
  /** Mint a fresh ephemeral credential (freshens the vault token centrally first). */
  mint?: (account: AccountRecord, kind: string) => Promise<EphemeralCredential>;
  /** Build the remote-hsr substrate for a node (shares the mirror's per-node transport). */
  substrateForNode?: (node: NodeRecord) => RemoteHsrSubstrate;
  /** Persist the new expiry back onto the SessionRecord. */
  updateSession?: (name: string, patch: Partial<SessionRecord>) => Promise<SessionRecord | null>;
  /** Durable, secret-free audit line per refresh. */
  appendLedger?: (event: Record<string, unknown>) => Promise<void>;
  windowMs?: number;
  cooldownMs?: number;
  now?: () => number;
};

export type TokenRefresher = (
  records: SessionRecord[],
  hsrObs: ReadonlyMap<string, HsrObservation>,
  nowMs: number,
) => Promise<TokenRefreshOutcome[]>;

/** The newest `auth_expired` event ts for a bee in its mirrored event tail, or undefined. */
function latestAuthExpiredTs(observation: HsrObservation | undefined): number | undefined {
  const events = observation?.eventSnapshot?.events;
  if (!events || events.length === 0) return undefined;
  let latest: number | undefined;
  for (const event of events) {
    if (event.type !== "auth_expired") continue;
    const ts = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : 0;
    if (latest === undefined || ts > latest) latest = ts;
  }
  return latest;
}

/** A record eligible for token refresh: a remote (non-local), account-bound, running codex bee. */
function isRefreshCandidate(record: SessionRecord): boolean {
  if (record.agent !== REFRESHABLE_HARNESS) return false;
  if (record.status !== "running") return false;
  if (!record.node || record.node === LOCAL_NODE_NAME) return false;
  if (!record.accountId) return false;
  return true;
}

/**
 * Build the stateful per-tick token refresher. Call ONCE per daemon run (it holds
 * the in-flight set + per-bee cooldown + handled-`auth_expired` cursor across
 * ticks); invoke every tick with the current records and this tick's HSR
 * observations (which carry the mirrored remote events).
 */
export function createTokenRefresher(deps: TokenRefresherDeps = {}): TokenRefresher {
  const loadNode = deps.loadNode ?? defaultLoadNode;
  const listAccounts = deps.listAccounts ?? defaultListAccounts;
  const mint = deps.mint ?? mintEphemeralCredential;
  const substrateForNode = deps.substrateForNode ?? remoteHsrSubstrateForNode;
  const updateSession = deps.updateSession ?? defaultUpdateSession;
  const appendLedger = deps.appendLedger ?? defaultAppendLedger;
  const windowMs = deps.windowMs ?? DEFAULT_TOKEN_REFRESH_WINDOW_MS;
  const cooldownMs = deps.cooldownMs ?? DEFAULT_TOKEN_REFRESH_COOLDOWN_MS;
  const now = deps.now ?? (() => Date.now());

  // Serialization state, keyed by bee name.
  const refreshing = new Set<string>();
  const lastAttemptAt = new Map<string, number>();
  const handledExpiredTs = new Map<string, number>();

  return async function refreshRemoteTokens(records, hsrObs, nowMs): Promise<TokenRefreshOutcome[]> {
    const outcomes: TokenRefreshOutcome[] = [];
    let accountsById: Map<string, AccountRecord> | undefined;

    for (const record of records) {
      if (!isRefreshCandidate(record)) continue;
      const bee = record.name;

      // Decide the trigger. Reactive (a NEW auth_expired) wins — it means the
      // token is already dead — else proactive when the TTL is within the window.
      const expiredTs = latestAuthExpiredTs(hsrObs.get(bee));
      const reactive = expiredTs !== undefined && expiredTs > (handledExpiredTs.get(bee) ?? -1);
      const proactive =
        !reactive &&
        record.remoteTokenExpiresAt !== undefined &&
        record.remoteTokenExpiresAt * 1000 - nowMs < windowMs;
      if (!reactive && !proactive) continue;
      const trigger: "proactive" | "reactive" = reactive ? "reactive" : "proactive";

      // Serialize: never stack a second refresh on a bee already mid-refresh, and
      // throttle repeated attempts (a failing refresh must not hammer every tick).
      if (refreshing.has(bee)) {
        outcomes.push({ bee, ok: false, skipped: "in-flight" });
        continue;
      }
      const nowTs = now();
      const last = lastAttemptAt.get(bee);
      if (last !== undefined && nowTs - last < cooldownMs) {
        outcomes.push({ bee, ok: false, skipped: "cooldown" });
        continue;
      }

      // Gate on the node: only an ephemeral-token remote-hsr node is refreshable.
      const node = await loadNode(record.node!).catch(() => null);
      if (!node || node.kind !== "remote-hsr" || authPolicyOf(node) !== "ephemeral-token") {
        outcomes.push({ bee, ok: false, skipped: "node-not-ephemeral" });
        continue;
      }

      if (!accountsById) accountsById = new Map((await listAccounts()).map((a) => [a.id, a]));
      const account = accountsById.get(record.accountId!);
      if (!account) {
        outcomes.push({ bee, ok: false, skipped: "account-missing" });
        continue;
      }

      // Mark the attempt (cursor + cooldown) up front so a failure doesn't re-fire
      // every tick, then run the mint → re-deliver → restart+resume recovery.
      lastAttemptAt.set(bee, nowTs);
      if (reactive && expiredTs !== undefined) handledExpiredTs.set(bee, expiredTs);
      refreshing.add(bee);
      try {
        let cred: EphemeralCredential;
        try {
          cred = await mint(account, record.agent);
        } catch (error) {
          outcomes.push({ bee, account: account.id, ok: false, trigger, error: messageOf(error) });
          continue;
        }
        if (cred.files.length === 0) {
          outcomes.push({ bee, account: account.id, ok: false, trigger, error: "minted credential carried no files to deliver" });
          continue;
        }
        const substrate = substrateForNode(node);
        const res = await substrate.refreshCredsRemote({
          bee,
          creds: {
            files: cred.files,
            ...(cred.env ? { env: cred.env } : {}),
          },
        });
        if (!res.ok) {
          outcomes.push({ bee, account: account.id, ok: false, trigger, error: res.error ?? "remote refresh failed" });
          continue;
        }
        // Persist the new expiry so the next tick's proactive check keys off it.
        if (cred.expiresAt !== undefined) {
          await updateSession(bee, { remoteTokenExpiresAt: cred.expiresAt }).catch(() => undefined);
        }
        await appendLedger({
          type: "token.refresh",
          session: bee,
          account: account.id,
          trigger,
          ...(cred.expiresAt !== undefined ? { expiresAt: new Date(cred.expiresAt * 1000).toISOString() } : {}),
        }).catch(() => undefined);
        outcomes.push({ bee, account: account.id, ok: true, trigger, ...(cred.expiresAt !== undefined ? { expiresAt: cred.expiresAt } : {}) });
      } finally {
        refreshing.delete(bee);
      }
    }

    return outcomes;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
