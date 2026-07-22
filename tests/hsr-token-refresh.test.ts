/**
 * UNIT 2 — remote codex access-token refresh.
 *
 * Three layers, all hermetic (no network, no real codex/ssh):
 *   A. codex adapter classifies the auth-expiry failure into `auth_expired`
 *      (and keeps every other error a generic `error`).
 *   B. the daemon token refresher (createTokenRefresher) picks the right bees
 *      (near-expiry proactive + auth_expired reactive), mints, re-delivers via
 *      refreshCredsRemote, persists the new expiry, and skips non-codex /
 *      non-remote / non-ephemeral / cooldown'd bees.
 *   C. the runner-host `refreshCreds` RPC restarts the runner WITH RESUME and
 *      shreds the OLD delivered credential while recording the NEW one for kill.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { test } from "node:test";

import { codexNotificationToEvents, isCodexAuthExpiryError } from "../src/hsr/adapters/codex.js";
import { createTokenRefresher, type TokenRefreshOutcome } from "../src/daemon/tokenRefresh.js";
import type { EphemeralCredential } from "../src/hsr/remoteCreds.js";
import { readDeliveredCredentials } from "../src/hsr/remoteCreds.js";
import { readHsrMeta } from "../src/hsr/runDir.js";
import { buildController } from "../src/hsr/remoteHost.js";
import type { HsrObservation } from "../src/hsr/observe.js";
import type { RemoteHsrSubstrate, RemoteRefreshCredsParams } from "../src/substrates/remote-hsr.js";
import type { NodeRecord } from "../src/node.js";
import type { AccountRecord } from "../src/accounts.js";
import type { SessionRecord } from "../src/store.js";
import type { RunnerEvent } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/** Minimal RpcConnectionCtx for calling a controller method handler directly. */
const CTX = { connectionId: 0, close: () => undefined };

// ── A. codex auth-expiry classification ─────────────────────────────────────

test("codex adapter: the empty_string refresh failure classifies as auth_expired, not error", () => {
  const message =
    "Failed to refresh token: 400 Bad Request: Invalid 'refresh_token': empty string \"code\":\"empty_string\"";
  const params = { error: { message }, willRetry: false, threadId: "t-1", turnId: "turn-1" };
  assert.deepEqual(
    codexNotificationToEvents("error", params).map((e) => e.type),
    ["auth_expired"],
  );
});

test("codex adapter: a 401 unauthorized boot failure classifies as auth_expired", () => {
  const params = { error: { message: "401 Unauthorized: token rejected" } };
  assert.deepEqual(
    codexNotificationToEvents("error", params).map((e) => e.type),
    ["auth_expired"],
  );
});

test("codex adapter: an unrelated error stays a generic error event", () => {
  const params = { error: { message: "the model is overloaded" } };
  const events = codexNotificationToEvents("error", params);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "error");
  assert.equal(isCodexAuthExpiryError("the model is overloaded"), false);
});

test("isCodexAuthExpiryError matches the documented signatures", () => {
  assert.equal(isCodexAuthExpiryError("Failed to refresh token: 400 Bad Request"), true);
  assert.equal(isCodexAuthExpiryError("Invalid 'refresh_token': empty string"), true);
  assert.equal(isCodexAuthExpiryError("code: empty_string"), true);
  assert.equal(isCodexAuthExpiryError("Unauthorized"), true);
  assert.equal(isCodexAuthExpiryError("tool timed out"), false);
});

// ── B. daemon token refresher ───────────────────────────────────────────────

function record(overrides: Partial<SessionRecord> & Pick<SessionRecord, "name">): SessionRecord {
  return {
    agent: "codex",
    cwd: "/remote/cwd",
    command: "codex",
    tmuxTarget: overrides.name,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    status: "running",
    node: "n1",
    accountId: "a1",
    ...overrides,
  };
}

function ephemeralNode(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "n1",
    kind: "remote-hsr",
    endpoint: "me@remote",
    capabilities: ["*"],
    authPolicy: "ephemeral-token",
    runnerHostVersion: "0.0.1+deadbeef1234",
    status: "unknown",
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function account(): AccountRecord {
  return { id: "a1", tool: "codex", label: "primary", provider: "openai", addedAt: "2026-07-05T00:00:00.000Z" };
}

function authExpiredObs(ts: number): HsrObservation {
  const events: RunnerEvent[] = [{ type: "auth_expired", ts }];
  return {
    live: true,
    snapshot: "",
    eventSnapshot: { events, tailEvents: events, activity: { at: ts, fingerprint: `auth-expired-${ts}`, eventType: "auth_expired" }, usage: { totals: null }, pendingNeedsInput: null },
  };
}

type RefreshCall = RemoteRefreshCredsParams;

function harness(opts: {
  nodeFor?: (name: string) => NodeRecord | null;
  minted?: EphemeralCredential;
  refreshResult?: () => { ok: boolean; sessionId?: string; error?: string };
  windowMs?: number;
  cooldownMs?: number;
}) {
  const mintCalls: string[] = [];
  const refreshCalls: RefreshCall[] = [];
  const updates: Array<{ name: string; patch: Partial<SessionRecord> }> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const minted: EphemeralCredential = opts.minted ?? {
    files: [{ homeRelPath: "auth.json", contentB64: Buffer.from("fresh").toString("base64"), mode: 0o600 }],
    expiresAt: 2_000_000_000,
    kindNote: "codex: fresh",
  };
  const fakeSub = {
    refreshCredsRemote: async (params: RefreshCall) => {
      refreshCalls.push(params);
      return opts.refreshResult ? opts.refreshResult() : { ok: true, sessionId: "thread-x" };
    },
  } as unknown as RemoteHsrSubstrate;

  const refresher = createTokenRefresher({
    loadNode: async (name) => (opts.nodeFor ? opts.nodeFor(name) : ephemeralNode()),
    listAccounts: async () => [account()],
    mint: async (acc, kind) => {
      mintCalls.push(`${acc.id}:${kind}`);
      return minted;
    },
    substrateForNode: () => fakeSub,
    updateSession: async (name, patch) => {
      updates.push({ name, patch });
      return null;
    },
    appendLedger: async (event) => {
      ledger.push(event);
    },
    ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
    cooldownMs: opts.cooldownMs ?? 0,
    now: () => 1_000_000_000_000,
  });

  return { refresher, mintCalls, refreshCalls, updates, ledger };
}

test("refresher: proactive picks the near-expiry remote codex bee and skips the rest", async () => {
  const nowMs = 1_000_000_000_000; // fixed clock the harness uses
  const soon = Math.floor(nowMs / 1000) + 30 * 60; // 30 min out → inside a 60 min window
  const far = Math.floor(nowMs / 1000) + 5 * 60 * 60; // 5 h out → outside

  const records: SessionRecord[] = [
    record({ name: "near", remoteTokenExpiresAt: soon }),
    record({ name: "far", remoteTokenExpiresAt: far }),
    record({ name: "claude", agent: "claude", remoteTokenExpiresAt: soon }),
    record({ name: "localbee", node: undefined, remoteTokenExpiresAt: soon }),
    record({ name: "noacct", accountId: undefined, remoteTokenExpiresAt: soon }),
  ];

  const h = harness({});
  const outcomes = await h.refresher(records, new Map(), nowMs);

  assert.deepEqual(h.mintCalls, ["a1:codex"], "only the near-expiry codex bee is minted");
  assert.equal(h.refreshCalls.length, 1);
  assert.equal(h.refreshCalls[0]!.bee, "near");
  // The minted files (base64) are what crossed to the remote.
  assert.deepEqual(h.refreshCalls[0]!.creds.files?.map((f) => f.homeRelPath), ["auth.json"]);
  assert.deepEqual(h.updates, [{ name: "near", patch: { remoteTokenExpiresAt: 2_000_000_000 } }]);
  assert.equal(h.ledger.length, 1);
  assert.equal(h.ledger[0]!.type, "token.refresh");

  const ok = outcomes.filter((o: TokenRefreshOutcome) => o.ok);
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.bee, "near");
  assert.equal(ok[0]!.trigger, "proactive");
  assert.equal(ok[0]!.expiresAt, 2_000_000_000);
});

test("refresher: reactive fires on a fresh auth_expired and does not re-fire for the same event", async () => {
  const nowMs = 1_000_000_000_000;
  // No near-expiry: only the mirrored auth_expired event should trigger it.
  const records = [record({ name: "expired" })];
  const obs = new Map<string, HsrObservation>([["expired", authExpiredObs(555)]]);

  const h = harness({});
  const first = await h.refresher(records, obs, nowMs);
  assert.equal(h.mintCalls.length, 1);
  assert.equal(first.find((o) => o.ok)?.trigger, "reactive");

  // Same event ts on the next tick → already handled → no second refresh.
  const second = await h.refresher(records, obs, nowMs);
  assert.equal(h.mintCalls.length, 1, "the same auth_expired event never re-fires");
  assert.equal(second.length, 0);

  // A NEWER auth_expired (higher ts) does fire again.
  const third = await h.refresher(records, new Map([["expired", authExpiredObs(999)]]), nowMs);
  assert.equal(h.mintCalls.length, 2);
  assert.equal(third.find((o) => o.ok)?.trigger, "reactive");
});

test("refresher: a non-ephemeral node is skipped (no mint)", async () => {
  const nowMs = 1_000_000_000_000;
  const soon = Math.floor(nowMs / 1000) + 10 * 60;
  const records = [record({ name: "near", remoteTokenExpiresAt: soon })];

  const h = harness({ nodeFor: () => ephemeralNode({ authPolicy: "local-only" }) });
  const outcomes = await h.refresher(records, new Map(), nowMs);

  assert.deepEqual(h.mintCalls, []);
  assert.equal(h.refreshCalls.length, 0);
  assert.equal(outcomes[0]!.skipped, "node-not-ephemeral");
});

test("refresher: cooldown throttles a repeatedly-failing near-expiry bee", async () => {
  const nowMs = 1_000_000_000_000;
  const soon = Math.floor(nowMs / 1000) + 10 * 60;
  const records = [record({ name: "near", remoteTokenExpiresAt: soon })];

  const h = harness({ cooldownMs: 60_000 });
  await h.refresher(records, new Map(), nowMs);
  const second = await h.refresher(records, new Map(), nowMs);

  assert.equal(h.mintCalls.length, 1, "cooldown prevents a second refresh within the window");
  assert.equal(second[0]!.skipped, "cooldown");
});

// ── C. runner-host refreshCreds RPC (restart + resume, shred-on-replace) ─────

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-tr-");
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("refreshCreds RPC: restarts with resume, shreds the OLD credential, records the NEW one for kill", async () => {
  await withTempStore(async (dir) => {
    const controller = buildController();
    const bee = "refreshbee";
    const home = `${dir}/iso-home`;
    const OLD = "OLD-token-bytes-aaaa";
    const NEW = "NEW-token-bytes-bbbb";
    const oldPath = `${home}/cred-old.json`;
    const newPath = `${home}/cred-new.json`;

    try {
      const spawnRes = (await controller.methods.spawn!({
        bee,
        kind: "stub",
        home,
        sessionId: "thread-x",
        creds: { files: [{ homeRelPath: "cred-old.json", contentB64: Buffer.from(OLD).toString("base64"), mode: 0o600 }] },
        spec: { command: process.execPath, args: [], env: {} },
      }, CTX)) as { ok?: boolean };
      assert.equal(spawnRes.ok, true);

      // The bee comes up, learns its thread id, and the OLD credential is on disk.
      await waitFor(() => fileExists(oldPath), "old credential written");
      await waitFor(async () => (await readHsrMeta(bee))?.sessionId === "thread-x", "session id learned");
      assert.equal(await readFile(oldPath, "utf8"), OLD);
      assert.deepEqual(await readDeliveredCredentials(bee), [oldPath]);

      // Refresh: deliver a fresh credential (different filename) and restart+resume.
      const refreshRes = (await controller.methods.refreshCreds!({
        bee,
        creds: { files: [{ homeRelPath: "cred-new.json", contentB64: Buffer.from(NEW).toString("base64"), mode: 0o600 }] },
      }, CTX)) as { ok?: boolean; sessionId?: string; error?: string };
      assert.equal(refreshRes.ok, true, `refresh failed: ${refreshRes.error ?? ""}`);
      assert.equal(refreshRes.sessionId, "thread-x", "restart resumed the same learned thread id");

      // OLD credential shredded; NEW credential delivered (0600) and recorded for kill.
      await waitFor(async () => !(await fileExists(oldPath)), "old credential shredded on replace");
      await waitFor(() => fileExists(newPath), "new credential delivered");
      assert.equal(await readFile(newPath, "utf8"), NEW);
      assert.equal((await stat(newPath)).mode & 0o777, 0o600);
      assert.deepEqual(await readDeliveredCredentials(bee), [newPath], "kill now shreds the NEW credential");

      // The runner is live again on the SAME thread id after the restart.
      await waitFor(async () => {
        const meta = await readHsrMeta(bee);
        return meta?.status === "running" && meta.sessionId === "thread-x";
      }, "runner restarted and running");

      // kill shreds the current (new) credential.
      await controller.methods.kill!({ bee }, CTX);
      await waitFor(async () => !(await fileExists(newPath)), "new credential GONE after kill");
    } finally {
      await controller.close();
    }
  });
});
