import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AccountRecord, accountDir, listAccounts } from "./accounts.js";
import { storeRoot } from "./fsx.js";
import { readClaudeKeychain } from "./keychain.js";

// ──────────────────────────────────────────────────────────────────────────
// Provider limit windows (Phase 3 follow-up): remaining 5h/weekly usage
// relative to the REAL limits, per account.
//
//  - claude: the OAuth usage endpoint Claude Code's /usage panel uses
//    (GET api.anthropic.com/api/oauth/usage) — live utilization + reset
//    times. We query it with the freshest token we can find for the
//    account across the vault, home credential files, and keychain.
//  - codex: live via `codex app-server`'s account/rateLimits/read RPC (run
//    against the account's home). When the binary or RPC is unavailable we
//    fall back to the newest rate_limits snapshot codex wrote into its
//    session rollouts — only as fresh as the account's last local activity,
//    stamped asOf.
// ──────────────────────────────────────────────────────────────────────────

export type WindowUsage = {
  usedPercent: number;
  resetsAt?: string;
  /** Window length, when known (claude: implied 300/10080; codex: from the snapshot). */
  windowMinutes?: number;
};

/**
 * Pace: used% minus elapsed% of the window. Positive = burning faster than
 * the window refills (on track to exhaust before reset); negative = headroom.
 * Null when the window boundary is unknown or already passed.
 */
export function paceDelta(window: WindowUsage, now = Date.now()): number | null {
  if (!window.resetsAt || !window.windowMinutes) return null;
  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= now) return null;
  const durationMs = window.windowMinutes * 60_000;
  const elapsedPct = Math.min(100, Math.max(0, ((durationMs - (resetMs - now)) / durationMs) * 100));
  return window.usedPercent - elapsedPct;
}

/** True when the snapshot's window boundary has passed — its used% no longer applies. */
export function windowRolledOver(window: WindowUsage, now = Date.now()): boolean {
  if (!window.resetsAt) return false;
  const resetMs = Date.parse(window.resetsAt);
  return Number.isFinite(resetMs) && resetMs <= now;
}

export type AccountLimits = {
  account: string;
  tool: string;
  ok: boolean;
  error?: string;
  fiveHour?: WindowUsage;
  weekly?: WindowUsage;
  plan?: string;
  /** Snapshot time for disk-sourced data; undefined when live. */
  asOf?: string;
  source: "oauth-api" | "app-server" | "session-snapshot" | "unsupported";
};

export type LimitsDeps = {
  fetchClaudeUsage?: (accessToken: string) => Promise<ClaudeUsageResponse>;
  /** Resolve the email a token actually belongs to (OAuth profile endpoint). */
  fetchClaudeProfileEmail?: (accessToken: string) => Promise<string | null>;
  /** Live codex rate limits for a home via the app-server RPC; null on failure. */
  codexLiveRateLimits?: (homePath: string) => Promise<CodexLiveRateLimits | null>;
  readKeychain?: typeof readClaudeKeychain;
  now?: () => number;
};

export async function accountLimits(accounts: AccountRecord[], deps: LimitsDeps = {}): Promise<AccountLimits[]> {
  return Promise.all(
    accounts.map(async (account) => {
      try {
        if (account.tool === "claude") return await claudeLimits(account, deps);
        if (account.tool === "codex") return await codexLimits(account, deps);
        return { account: account.id, tool: account.tool, ok: false, source: "unsupported" as const, error: `${account.tool} has no limits source yet` };
      } catch (error) {
        return {
          account: account.id,
          tool: account.tool,
          ok: false,
          source: account.tool === "claude" ? ("oauth-api" as const) : ("session-snapshot" as const),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/* ------------------------------------------------------------------ */
/* claude — live OAuth usage endpoint                                  */
/* ------------------------------------------------------------------ */

export type ClaudeUsageResponse = {
  five_hour?: { utilization?: number | null; resets_at?: string | null } | null;
  seven_day?: { utilization?: number | null; resets_at?: string | null } | null;
};

type ClaudeOauthCredentials = {
  accessToken: string;
  expiresAt: number;
  subscriptionType?: string;
};

async function claudeLimits(account: AccountRecord, deps: LimitsDeps): Promise<AccountLimits> {
  const now = (deps.now ?? Date.now)();
  const candidates = await claudeCredentialCandidates(account, deps.readKeychain ?? readClaudeKeychain);
  if (candidates.length === 0) {
    return {
      account: account.id,
      tool: account.tool,
      ok: false,
      source: "oauth-api",
      error: "no OAuth token found in vault, homes, or keychain",
    };
  }
  const fresh = candidates.filter((candidate) => candidate.expiresAt > now);
  if (fresh.length === 0) {
    const newest = candidates[0]!;
    return {
      account: account.id,
      tool: account.tool,
      ok: false,
      source: "oauth-api",
      error: `OAuth token expired ${new Date(newest.expiresAt).toISOString()}; run: hive open ${account.id} once, then hive account capture ${account.id} --home <its home>`,
    };
  }

  // A token's location does NOT prove its identity: vaults get mislabeled,
  // homes get re-logged-in, refresh keeps a wrong token fresh forever. Ask
  // the profile endpoint who each candidate actually is and use the first
  // (freshest) one that matches the account.
  const profileOf = deps.fetchClaudeProfileEmail ?? fetchClaudeProfileEmail;
  const expectedEmail = account.email ?? (account.label.includes("@") ? account.label : undefined);
  let credential: ClaudeOauthCredentials | undefined;
  const imposters = new Set<string>();
  for (const candidate of fresh) {
    if (!expectedEmail) {
      credential = candidate;
      break;
    }
    const actualEmail = await profileOf(candidate.accessToken).catch(() => null);
    if (actualEmail === expectedEmail) {
      credential = candidate;
      break;
    }
    if (actualEmail) imposters.add(actualEmail);
  }
  if (!credential) {
    return {
      account: account.id,
      tool: account.tool,
      ok: false,
      source: "oauth-api",
      error: `found ${fresh.length} fresh token(s) but none belong to ${expectedEmail}${imposters.size > 0 ? ` (they belong to: ${[...imposters].join(", ")})` : ""}; re-login with: hive login ${account.id}`,
    };
  }

  const fetcher = deps.fetchClaudeUsage ?? fetchClaudeUsage;
  const usage = await fetcher(credential.accessToken);
  const result: AccountLimits = {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "oauth-api",
    ...(credential.subscriptionType ? { plan: credential.subscriptionType } : {}),
  };
  if (typeof usage.five_hour?.utilization === "number") {
    result.fiveHour = { usedPercent: usage.five_hour.utilization, windowMinutes: 300, ...(usage.five_hour.resets_at ? { resetsAt: usage.five_hour.resets_at } : {}) };
  }
  if (typeof usage.seven_day?.utilization === "number") {
    result.weekly = { usedPercent: usage.seven_day.utilization, windowMinutes: 10_080, ...(usage.seven_day.resets_at ? { resetsAt: usage.seven_day.resets_at } : {}) };
  }
  if (!result.fiveHour && !result.weekly) {
    result.ok = false;
    result.error = "usage endpoint returned no windows";
  }
  return result;
}

async function fetchClaudeUsage(accessToken: string): Promise<ClaudeUsageResponse> {
  return claudeOauthGet(accessToken, "https://api.anthropic.com/api/oauth/usage") as Promise<ClaudeUsageResponse>;
}

async function fetchClaudeProfileEmail(accessToken: string): Promise<string | null> {
  const profile = (await claudeOauthGet(accessToken, "https://api.anthropic.com/api/oauth/profile")) as {
    account?: { email?: unknown; email_address?: unknown };
  };
  const email = profile.account?.email ?? profile.account?.email_address;
  return typeof email === "string" ? email : null;
}

async function claudeOauthGet(accessToken: string, url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

/**
 * The vault copy of a claude token is a snapshot from capture time and may
 * be long expired while the account's active home holds a freshly refreshed
 * one (claude refreshes on use, file or keychain). Gather every candidate —
 * vault file, per-home credential files, per-home keychain entries — for
 * homes whose .claude.json email matches the account, freshest first.
 * Identity is verified separately: location is a heuristic, not proof.
 */
async function claudeCredentialCandidates(
  account: AccountRecord,
  readKeychain: typeof readClaudeKeychain,
): Promise<ClaudeOauthCredentials[]> {
  const candidates: ClaudeOauthCredentials[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null) => {
    const parsed = parseClaudeCredentials(raw);
    if (parsed && !seen.has(parsed.accessToken)) {
      seen.add(parsed.accessToken);
      candidates.push(parsed);
    }
  };

  push(await readFile(join(accountDir(account), ".credentials.json"), "utf8").catch(() => null));

  for (const home of await claudeHomesForAccount(account)) {
    push(await readFile(join(home, ".credentials.json"), "utf8").catch(() => null));
    push(await readKeychain(home));
  }

  // The account's true login may live in a home we cannot attribute (the
  // default ~/.claude has no in-home .claude.json). Include every claude
  // home's keychain as a last-resort candidate pool — identity verification
  // filters out the wrong ones.
  for (const home of await candidateHomes("claude")) {
    push(await readKeychain(home));
  }

  candidates.sort((a, b) => b.expiresAt - a.expiresAt);
  return candidates;
}

function parseClaudeCredentials(raw: string | null): ClaudeOauthCredentials | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown } };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || typeof oauth.expiresAt !== "number") return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt,
      ...(typeof oauth.subscriptionType === "string" ? { subscriptionType: oauth.subscriptionType } : {}),
    };
  } catch {
    return null;
  }
}

async function claudeHomesForAccount(account: AccountRecord): Promise<string[]> {
  const matched: string[] = [];
  // The account's dedicated slots are theirs by construction.
  for (const dir of [join(storeRoot(), "homes", account.id), join(storeRoot(), "login-homes", account.id)]) {
    if ((await stat(dir).catch(() => null))?.isDirectory()) matched.push(dir);
  }
  // Shared/legacy homes are claimed by the logged-in email in .claude.json.
  const email = account.email ?? (account.label.includes("@") ? account.label : undefined);
  if (!email) return matched;
  for (const home of await candidateHomes("claude")) {
    const raw = await readFile(join(home, ".claude.json"), "utf8").catch(() => null);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } };
      if (parsed.oauthAccount?.emailAddress === email) matched.push(home);
    } catch {
      // unparseable .claude.json — skip
    }
  }
  return matched;
}

async function candidateHomes(tool: string): Promise<string[]> {
  const homes: string[] = [];
  const candidates = [join(homedir(), `.${tool}`)];
  for (let slot = 1; slot <= 9; slot += 1) candidates.push(join(homedir(), `.${tool}-${slot}`));
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) homes.push(candidate);
  }
  return homes;
}

/* ------------------------------------------------------------------ */
/* codex — rate_limits snapshots from session rollouts                 */
/* ------------------------------------------------------------------ */

type CodexRateLimits = {
  primary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
  secondary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
  plan_type?: string | null;
};

async function codexLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const homes = await codexHomesForAccount(account);
  if (homes.length === 0) {
    return { account: account.id, tool: account.tool, ok: false, source: "session-snapshot", error: "no home found with this account's auth.json" };
  }

  // Live first: the app-server RPC answers with the server's current window
  // state. Try each matched home until one authenticates.
  const live = deps.codexLiveRateLimits ?? fetchCodexLiveRateLimits;
  for (const home of homes) {
    const limits = await live(home).catch(() => null);
    if (!limits) continue;
    const result: AccountLimits = {
      account: account.id,
      tool: account.tool,
      ok: true,
      source: "app-server",
      ...(limits.planType ? { plan: limits.planType } : {}),
    };
    if (limits.primary) result.fiveHour = liveWindow(limits.primary);
    if (limits.secondary) result.weekly = liveWindow(limits.secondary);
    if (result.fiveHour || result.weekly) return result;
  }

  let best: { limits: CodexRateLimits; ts: string } | null = null;
  for (const home of homes) {
    const snapshot = await newestRateLimitSnapshot(join(home, "sessions"));
    if (snapshot && (!best || snapshot.ts > best.ts)) best = snapshot;
  }
  if (!best) {
    return { account: account.id, tool: account.tool, ok: false, source: "session-snapshot", error: "no rate-limit snapshot on disk yet (run codex on this account once)" };
  }

  const result: AccountLimits = {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "session-snapshot",
    asOf: best.ts,
    ...(best.limits.plan_type ? { plan: best.limits.plan_type } : {}),
  };
  if (typeof best.limits.primary?.used_percent === "number") {
    result.fiveHour = {
      usedPercent: best.limits.primary.used_percent,
      ...(best.limits.primary.resets_at ? { resetsAt: new Date(best.limits.primary.resets_at * 1000).toISOString() } : {}),
      ...(typeof best.limits.primary.window_minutes === "number" ? { windowMinutes: best.limits.primary.window_minutes } : {}),
    };
  }
  if (typeof best.limits.secondary?.used_percent === "number") {
    result.weekly = {
      usedPercent: best.limits.secondary.used_percent,
      ...(best.limits.secondary.resets_at ? { resetsAt: new Date(best.limits.secondary.resets_at * 1000).toISOString() } : {}),
      ...(typeof best.limits.secondary.window_minutes === "number" ? { windowMinutes: best.limits.secondary.window_minutes } : {}),
    };
  }
  return result;
}

export type CodexLiveWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
export type CodexLiveRateLimits = {
  primary?: CodexLiveWindow | null;
  secondary?: CodexLiveWindow | null;
  planType?: string | null;
};

function liveWindow(window: CodexLiveWindow): WindowUsage {
  return {
    usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : 0,
    ...(window.resetsAt ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() } : {}),
    ...(typeof window.windowDurationMins === "number" ? { windowMinutes: window.windowDurationMins } : {}),
  };
}

const CODEX_RPC_TIMEOUT_MS = 15_000;

/**
 * Query `codex app-server` (JSON-RPC over stdio) for the account's live rate
 * limits, with CODEX_HOME pointed at the account's home. Returns null on any
 * failure — missing binary, stale auth, protocol drift — so callers fall back
 * to the on-disk snapshot.
 */
async function fetchCodexLiveRateLimits(homePath: string): Promise<CodexLiveRateLimits | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, CODEX_HOME: homePath },
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: CodexLiveRateLimits | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), CODEX_RPC_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: { id?: number; result?: Record<string, unknown>; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(null);
            return;
          }
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })}\n`);
        }
        if (message.id === 2) {
          const rateLimits = message.result?.rateLimits as CodexLiveRateLimits | undefined;
          finish(rateLimits && (rateLimits.primary || rateLimits.secondary) ? rateLimits : null);
          return;
        }
      }
    });

    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "hive", title: "hive", version: "0.0.1" } } })}\n`,
    );
  });
}

async function codexHomesForAccount(account: AccountRecord): Promise<string[]> {
  const vaultEmail = await codexAuthEmail(join(accountDir(account), "auth.json"));
  const matched: string[] = [];
  for (const dir of [join(storeRoot(), "homes", account.id), join(storeRoot(), "login-homes", account.id)]) {
    if ((await stat(dir).catch(() => null))?.isDirectory()) matched.push(dir);
  }
  if (!vaultEmail) return matched;
  for (const home of await candidateHomes("codex")) {
    const email = await codexAuthEmail(join(home, "auth.json"));
    if (email && email === vaultEmail) matched.push(home);
  }
  return matched;
}

/** Email claim from auth.json's id_token JWT — decoded, not verified (local fact). */
export async function codexAuthEmail(authPath: string): Promise<string | null> {
  const raw = await readFile(authPath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { tokens?: { id_token?: unknown } };
    const idToken = parsed.tokens?.id_token;
    if (typeof idToken !== "string") return null;
    return emailFromJwt(idToken);
  } catch {
    return null;
  }
}

export function emailFromJwt(jwt: string): string | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof decoded.email === "string" ? decoded.email : null;
  } catch {
    return null;
  }
}

/** Newest rate_limits event across the most recent rollout files. */
async function newestRateLimitSnapshot(sessionsDir: string): Promise<{ limits: CodexRateLimits; ts: string } | null> {
  const files: { path: string; mtimeMs: number }[] = [];
  await walk(sessionsDir, 5, async (path) => {
    if (!path.endsWith(".jsonl")) return;
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) files.push({ path, mtimeMs: info.mtimeMs });
  });
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // A fresh session may not have emitted token_count yet; look back a few files.
  for (const file of files.slice(0, 5)) {
    const snapshot = await lastRateLimitsInFile(file.path);
    if (snapshot) return snapshot;
  }
  return null;
}

export async function lastRateLimitsInFile(path: string): Promise<{ limits: CodexRateLimits; ts: string } | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (!raw) return null;
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    try {
      const row = JSON.parse(line) as { timestamp?: string; payload?: { rate_limits?: CodexRateLimits } };
      const limits = row.payload?.rate_limits;
      if (limits && (limits.primary || limits.secondary)) {
        return { limits, ts: row.timestamp ?? new Date((await stat(path)).mtimeMs).toISOString() };
      }
    } catch {
      // torn line — keep scanning
    }
  }
  return null;
}

async function walk(dir: string, maxDepth: number, visit: (path: string) => Promise<void>): Promise<void> {
  if (maxDepth < 0) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, maxDepth - 1, visit);
    else if (entry.isFile()) await visit(path);
  }
}

export async function allAccountLimits(deps: LimitsDeps = {}): Promise<AccountLimits[]> {
  return accountLimits(await listAccounts(), deps);
}
