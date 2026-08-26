/**
 * Spec 08 at the RPC tier — a REAL daemon process over a temp socket:
 *  - account CRUD verbs + typed errors (account_not_found, account_referenced,
 *    account_paused, harness_mismatch, account_unavailable); one-key
 *    idempotency on account.add; snapshot/watch carry accounts + limits
 *  - spawn {account}: explicit → bees.account + home env in the runtime's
 *    env; paused / mismatch refused; 'auto' resolves BEFORE createBee (never
 *    stored) and short-circuits a lone candidate; null = unbound
 *  - bee.swapAccount (fake-claude): stop → rebind → revive with resume; the
 *    conversation resumes under a NEW session id (--fork-session); the next
 *    message is delivered on the new generation in the new home; cross-harness
 *    refused; a stopped bee is rebound only
 *  - automatic rotation on exhaustion (fake-claude @ratelimit): resource_blocked
 *    → selection excludes the current account → swap → the next turn continues
 *    on the new account; `autoswap=false` opt-out honored; no candidate → flagged,
 *    no loop; auth_needed evidence → account status + bee flag
 * SAFETY: temp dirs only (vault/homes inside the daemon dir); never ~/.hive,
 * never a real harness; HIVE_NO_KEYCHAIN in the daemon env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError, type ListResult, type MailboxResult, type SendRpcResult, type SnapshotResult, type SpawnResult, type ViewResult, type WatchFrame } from "../src/protocol.ts";
import type {
  AccountAddResult,
  AccountBackfillResult,
  AccountGetResult,
  AccountLimitsResult,
  AccountListResult,
  AccountRemoveResult,
  AccountUpdateResult,
  SwapAccountResult,
} from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");

function jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T);
}

async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return;
  }
  assert.fail(`expected ${code}`);
}

async function waitState(client: RpcClient, beeId: string, state: string, what: string): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === state ? v : null;
  }, what, 12_000);
}

async function waitDelivered(client: RpcClient, beeId: string, messageId: number, what: string): Promise<number> {
  return (await waitFor(async () => {
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    const m = messages.find((x) => x.id === messageId);
    return m?.deliveredAt != null ? m.deliveredGeneration : null;
  }, what, 12_000)) as number;
}

/** Seed a vault entry so the account counts as credentialed. */
function seedVault(dir: string, harness: string, id: string, file: string, content = "{}"): void {
  const d = join(dir, "vault", harness, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), content);
}

test("rpc.accounts.1: CRUD verbs, typed errors, idempotent add, spawn binding (explicit / paused / mismatch / auto / unbound), snapshot + watch carry accounts", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const watch = await daemon.client();
    const frames: WatchFrame[] = [];
    watch.onEvent = (f: WatchFrame) => frames.push(f);
    await watch.request("watch");

    // add (default id + home), get, list, idempotent replay
    const added = await client.request<AccountAddResult>("account.add", { harness: "stub", label: "Alpha One", idempotencyKey: "acct-add-1" });
    assert.equal(added.account.id, "stub-alpha-one");
    assert.equal(added.account.homePath, join(dir, "homes", "stub-alpha-one"));
    assert.equal(added.account.status, "ok");
    const replay = await client.request<AccountAddResult>("account.add", { harness: "stub", label: "Alpha One", idempotencyKey: "acct-add-1" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.account.id, "stub-alpha-one");
    await rejects(() => client.request("account.add", { harness: "stub", label: "Alpha One" }), "invalid_request");
    const two = await client.request<AccountAddResult>("account.add", { harness: "stub", label: "two", penalty: 10, homePath: join(dir, "custom-home") });
    assert.equal(two.account.penalty, 10);
    assert.equal(two.account.homePath, join(dir, "custom-home"));
    await client.request<AccountAddResult>("account.add", { harness: "codex", label: "cx" });
    const list = await client.request<AccountListResult>("account.list");
    assert.deepEqual(list.accounts.map((a) => a.id).sort(), ["codex-cx", "stub-alpha-one", "stub-two"]);
    assert.deepEqual((await client.request<AccountListResult>("account.list", { harness: "stub" })).accounts.map((a) => a.id).sort(), ["stub-alpha-one", "stub-two"]);
    await rejects(() => client.request("account.get", { id: "nope" }), "account_not_found");
    const got = await client.request<AccountGetResult>("account.get", { id: "stub-two" });
    assert.equal(got.credentialed, true, "the stub harness has no recipe: always credentialed");
    assert.equal(got.loginSeat, null);
    assert.deepEqual(got.bees, []);

    // pause / unpause / penalty
    const paused = await client.request<AccountUpdateResult>("account.pause", { id: "stub-two" });
    assert.equal(paused.account.status, "paused");
    assert.equal((await client.request<AccountUpdateResult>("account.pause", { id: "stub-two" })).applied, false);
    const pen = await client.request<AccountUpdateResult>("account.setPenalty", { id: "stub-two", penalty: 33 });
    assert.equal(pen.account.penalty, 33);
    await rejects(() => client.request("account.setPenalty", { id: "stub-two", penalty: 101 }), "invalid_request");

    // spawn: explicit paused → refused; mismatch → refused; unknown → not found
    await rejects(() => client.request("spawn", { name: "p", agent: "stub", cwd: dir, account: "stub-two" }), "account_paused");
    await rejects(() => client.request("spawn", { name: "p", agent: "stub", cwd: dir, account: "codex-cx" }), "harness_mismatch");
    await rejects(() => client.request("spawn", { name: "p", agent: "stub", cwd: dir, account: "nope" }), "account_not_found");
    assert.equal((await client.request<ListResult>("list")).views.length, 0, "refusals mint no bee");
    // explicit ok → bees.account + home env (stub has no home env var: env stays empty, binding recorded)
    const explicit = await client.request<SpawnResult>("spawn", { name: "e", agent: "stub", cwd: dir, account: "stub-alpha-one" });
    assert.equal(explicit.account, "stub-alpha-one");
    const ev = await client.request<ViewResult>("view", { beeId: explicit.beeId });
    assert.equal(ev.bee?.account, "stub-alpha-one");
    // auto (default): stub-two is paused → the lone candidate is alpha-one; never 'auto' in the row
    const auto = await client.request<SpawnResult>("spawn", { name: "a", agent: "stub", cwd: dir });
    assert.equal(auto.account, "stub-alpha-one");
    assert.match(auto.accountReason ?? "", /only stub account with credentials/);
    assert.equal((await client.request<ViewResult>("view", { beeId: auto.beeId })).bee?.account, "stub-alpha-one");
    // null → unbound
    const unbound = await client.request<SpawnResult>("spawn", { name: "u", agent: "stub", cwd: dir, account: null });
    assert.equal(unbound.account, null);
    // all paused → auto refuses (typed), explicit-null still spawns
    await client.request("account.pause", { id: "stub-alpha-one" });
    await rejects(() => client.request("spawn", { name: "x", agent: "stub", cwd: dir }), "account_unavailable");
    await client.request("account.unpause", { id: "stub-alpha-one" });
    // remove refused while referenced; ok after the bees are deleted
    await rejects(() => client.request("account.remove", { id: "stub-alpha-one" }), "account_referenced");
    const gotRef = await client.request<AccountGetResult>("account.get", { id: "stub-alpha-one" });
    assert.deepEqual(gotRef.bees.sort(), [explicit.beeId, auto.beeId].sort());
    const removed = await client.request<AccountRemoveResult>("account.remove", { id: "stub-two" });
    assert.equal(removed.account.id, "stub-two");
    await rejects(() => client.request("account.remove", { id: "stub-two" }), "account_not_found");
    // backfill verb round-trips (nothing to bind here)
    const bf = await client.request<AccountBackfillResult>("account.backfill", { dryRun: true });
    assert.deepEqual(bf.bound, []);
    // snapshot + watch
    const snap = await client.request<SnapshotResult>("snapshot");
    assert.deepEqual(snap.accounts.map((a) => a.id).sort(), ["codex-cx", "stub-alpha-one"]);
    assert.deepEqual(snap.accountLimits, []);
    await waitFor(() => frames.some((f) => f.type === "delta" && f.events.some((e) => e.kind === "account.put")), "account.put in the watch stream");
    await waitFor(() => frames.some((f) => f.type === "delta" && f.events.some((e) => e.kind === "account.removed")), "account.removed in the watch stream");
    watch.close();
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.accounts.fuzzy: one selector works across account verbs, spawn agent shorthand, explicit override, and swap", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "stub", label: "owner@gmail.com", id: "stub-personal" });
    await client.request("account.add", { harness: "stub", label: "owner@company.com", id: "stub-work" });
    await client.request("account.add", { harness: "stub", label: "remove-me", id: "stub-archive" });
    await client.request("account.add", { harness: "codex", label: "coder@gmail.com", id: "codex-personal" });

    const got = await client.request<AccountGetResult>("account.get", { id: "stub-gmail" });
    assert.equal(got.account.id, "stub-personal");

    assert.equal((await client.request<AccountUpdateResult>("account.pause", { id: "COMPANY" })).account.id, "stub-work");
    assert.equal((await client.request<AccountUpdateResult>("account.unpause", { id: "stub-company" })).account.id, "stub-work");
    const penalty = await client.request<AccountUpdateResult>("account.setPenalty", { id: "company", penalty: 17 });
    assert.equal(penalty.account.id, "stub-work");
    assert.equal(penalty.account.penalty, 17);
    const limits = await client.request<AccountLimitsResult>("account.limits", { id: "company" });
    assert.deepEqual(limits.limits.map((row) => row.account), ["stub-work"]);
    // Stub intentionally has no login recipe. `invalid_request` (instead of
    // account_not_found) proves the fuzzy selector reached that harness gate.
    await rejects(() => client.request("account.login", { id: "stub-company" }), "invalid_request");

    // Embedded selector: the daemon normalizes the concrete agent and binds
    // the fuzzy account before creating the bee row.
    const embedded = await client.request<SpawnResult>("spawn", { name: "fuzzy", agent: "stub-gmail", cwd: dir });
    assert.equal(embedded.agent, "stub");
    assert.equal(embedded.account, "stub-personal");
    const embeddedView = await client.request<ViewResult>("view", { beeId: embedded.beeId });
    assert.equal(embeddedView.bee?.agent, "stub");
    assert.equal(embeddedView.bee?.account, "stub-personal");

    // Explicit account selection still wins over the account embedded in the
    // agent token, while the harness portion is normalized consistently.
    const overridden = await client.request<SpawnResult>("spawn", {
      name: "override",
      agent: "stub-gmail",
      account: "company",
      cwd: dir,
    });
    assert.equal(overridden.agent, "stub");
    assert.equal(overridden.account, "stub-work");

    const swap = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: embedded.beeId, account: "stub-company" });
    assert.equal(swap.to, "stub-work");
    const removed = await client.request<AccountRemoveResult>("account.remove", { id: "REMOVE" });
    assert.equal(removed.account.id, "stub-archive");

    await rejects(() => client.request("account.get", { id: "gmail" }), "invalid_request");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.accounts.2: bee.swapAccount (fake-claude) — same-harness stop → rebind → revive with resume under a NEW session id in the new home; cross-harness refused; stopped bee rebound only", async () => {
  const argvLog = join(makeDaemonDir().dir, "argv.jsonl");
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
        env: { FAKE_CLAUDE_ARGV_LOG: argvLog },
      },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    // two claude accounts with vault credentials (activation copies them into the empty homes)
    seedVault(dir, "claude", "claude-a", ".credentials.json", '{"claudeAiOauth":{"accessToken":"a","expiresAt":1}}');
    seedVault(dir, "claude", "claude-b", ".credentials.json", '{"claudeAiOauth":{"accessToken":"b","expiresAt":1}}');
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "claude", label: "a" });
    await client.request("account.add", { harness: "claude", label: "b" });
    await client.request("account.add", { harness: "codex", label: "c" });
    const homeA = join(dir, "homes", "claude-a");
    const homeB = join(dir, "homes", "claude-b");

    const spawned = await client.request<SpawnResult>("spawn", { name: "mover", agent: "claude", cwd: dir, account: "claude-a" });
    const first = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "hello" });
    await waitDelivered(client, spawned.beeId, first.messageId, "first delivered");
    await waitState(client, spawned.beeId, "idle", "idle after hello");
    const sid1 = (await client.request<ViewResult>("view", { beeId: spawned.beeId })).bee?.providerSessionId;
    assert.ok(sid1, "session id recorded");
    // activation happened into home A (empty → vault copy + defaults); the runtime saw CLAUDE_CONFIG_DIR = home A
    assert.equal(readFileSync(join(homeA, ".credentials.json"), "utf8"), '{"claudeAiOauth":{"accessToken":"a","expiresAt":1}}');
    assert.ok(existsSync(join(homeA, "settings.json")));
    const boots1 = jsonl<{ env: { CLAUDE_CONFIG_DIR: string | null }; resumed: string | null; forked: boolean; sessionId: string }>(argvLog);
    assert.equal(boots1.length, 1);
    assert.equal(boots1[0]?.env.CLAUDE_CONFIG_DIR, homeA);

    // cross-harness refused, typed; paused refused
    await rejects(() => client.request("bee.swapAccount", { beeId: spawned.beeId, account: "codex-c" }), "harness_mismatch");
    await client.request("account.pause", { id: "claude-b" });
    await rejects(() => client.request("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b" }), "account_paused");
    await client.request("account.unpause", { id: "claude-b" });
    await rejects(() => client.request("bee.swapAccount", { beeId: spawned.beeId, account: "nope" }), "account_not_found");

    // the swap: stop → rebind (+ rekey for claude) → revive with --resume <sid1> --fork-session
    const swap = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b", idempotencyKey: "swap-1" });
    assert.equal(swap.action, "stop_then_revive");
    assert.equal(swap.from, "claude-a");
    assert.equal(swap.to, "claude-b");
    assert.equal(swap.rekeyed, true);
    assert.ok(swap.commandId);
    const replay = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b", idempotencyKey: "swap-1" });
    assert.equal(replay.deduped, true);
    // the operator continues the conversation: the message rides the swap and
    // is delivered to generation 2, which boots in home B and reports a NEW
    // session id (claude stream-json emits its init only on the first message)
    const second = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "again" });
    assert.equal(await waitDelivered(client, spawned.beeId, second.messageId, "second delivered"), 2);
    const gen2 = await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return v.view.generation === 2 && v.view.runtimeState !== "stopped" && v.bee?.providerSessionId && v.bee.providerSessionId !== sid1 ? v : null;
    }, "generation 2 with a fresh session id", 15_000);
    assert.equal(gen2.bee?.account, "claude-b");
    assert.equal(gen2.bee?.env.CLAUDE_CONFIG_DIR, homeB);
    assert.equal(gen2.bee?.forkSeed, null, "seed consumed once the fork's own id is known");
    await waitState(client, spawned.beeId, "idle", "idle on generation 2");
    const boots2 = jsonl<{ env: { CLAUDE_CONFIG_DIR: string | null }; resumed: string | null; forked: boolean; sessionId: string }>(argvLog);
    assert.equal(boots2.length, 2);
    assert.equal(boots2[1]?.env.CLAUDE_CONFIG_DIR, homeB);
    assert.equal(boots2[1]?.resumed, sid1, "resumes the source conversation");
    assert.equal(boots2[1]?.forked, true, "…under a new session (--fork-session)");
    assert.equal(readFileSync(join(homeB, ".credentials.json"), "utf8"), '{"claudeAiOauth":{"accessToken":"b","expiresAt":1}}', "home B activated from ITS vault entry");
    // swapping to the same account is a no-op
    const noop = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b" });
    assert.equal(noop.action, "noop");
    // a stopped bee is only rebound; its next wake runs on the new account
    await client.request("stop", { beeId: spawned.beeId });
    await waitState(client, spawned.beeId, "stopped", "stopped");
    const back = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: spawned.beeId, account: "claude-a" });
    assert.equal(back.action, "rebind_only");
    assert.equal(back.commandId, null);
    const rebound = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.equal(rebound.bee?.account, "claude-a");
    assert.equal(rebound.bee?.env.CLAUDE_CONFIG_DIR, homeA);
    assert.equal(rebound.view.runtimeState, "stopped");
    client.close();
  } finally {
    if (process.env.HB_DEBUG && existsSync(join(dir, "hived.log"))) process.stderr.write(readFileSync(join(dir, "hived.log"), "utf8"));
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.accounts.3: automatic rotation on exhaustion (fake-claude @ratelimit) — swap to the untried account, the next turn continues there; opt-out honored; no candidate = flagged, no loop; auth_needed evidence → account status", async () => {
  const argvLog = join(makeDaemonDir().dir, "argv.jsonl");
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
        env: { FAKE_CLAUDE_ARGV_LOG: argvLog },
      },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json");
    seedVault(dir, "claude", "claude-b", ".credentials.json");
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "claude", label: "a" });
    await client.request("account.add", { harness: "claude", label: "b" });
    const homeB = join(dir, "homes", "claude-b");

    // 1) rotation: a bee on A hits the wall → swapped to B → next turn on B
    const bee = await client.request<SpawnResult>("spawn", { name: "rot", agent: "claude", cwd: dir, account: "claude-a" });
    const m1 = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "warm up" });
    await waitDelivered(client, bee.beeId, m1.messageId, "warm up delivered");
    await waitState(client, bee.beeId, "idle", "idle");
    const m2 = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "@ratelimit please" });
    await waitDelivered(client, bee.beeId, m2.messageId, "ratelimit delivered");
    const swapped = await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: bee.beeId });
      return v.bee?.account === "claude-b" && v.view.generation === 2 && v.view.runtimeState !== "stopped" ? v : null;
    }, "rotated to claude-b on generation 2", 15_000);
    assert.equal(swapped.bee?.env.CLAUDE_CONFIG_DIR, homeB);
    // the exhausted account carries the evidence; the bee's flag was set by the adapter evidence
    const acctA = await client.request<AccountGetResult>("account.get", { id: "claude-a" });
    assert.ok(acctA.account.exhaustedAt, "exhaustion evidence recorded on the account");
    const m3 = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "continue" });
    assert.equal(await waitDelivered(client, bee.beeId, m3.messageId, "continue delivered on gen 2"), 2);
    // a successful turn on B clears resource_blocked (contrary evidence)
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: bee.beeId });
      return !v.view.flags.includes("resource_blocked") ? true : null;
    }, "resource_blocked cleared by the served turn");
    const boots = jsonl<{ env: { CLAUDE_CONFIG_DIR: string | null }; forked: boolean }>(argvLog);
    assert.equal(boots.length, 2);
    assert.equal(boots[1]?.env.CLAUDE_CONFIG_DIR, homeB);
    assert.equal(boots[1]?.forked, true);

    // 2) no candidate: B is now the only non-exhausted account for THIS bee… exhaust it too:
    //    A is inside its exhaustion cool-off → no candidate → the bee stays flagged on B, no loop
    const m4 = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "@ratelimit again" });
    await waitDelivered(client, bee.beeId, m4.messageId, "second ratelimit delivered");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: bee.beeId })).view.flags.includes("resource_blocked") ? true : null, "flagged again");
    await new Promise((r) => setTimeout(r, 200));
    const stuck = await client.request<ViewResult>("view", { beeId: bee.beeId });
    assert.equal(stuck.bee?.account, "claude-b", "no rotation back onto the recently exhausted account");
    assert.equal(stuck.view.generation, 2);
    assert.ok(stuck.view.flags.includes("resource_blocked"), "stays visibly flagged");
    assert.match(daemon.output() + readFileSync(join(dir, "hived.log"), "utf8"), /account\.rotate bee=\S+ account=claude-b skipped=no_candidate/);

    // 3) opt-out: a bee tagged autoswap=false is never rotated
    const opt = await client.request<SpawnResult>("spawn", { name: "opt", agent: "claude", cwd: dir, account: "claude-a", tags: ["autoswap=false"] });
    const o1 = await client.request<SendRpcResult>("send", { beeId: opt.beeId, body: "@ratelimit" });
    await waitDelivered(client, opt.beeId, o1.messageId, "opt-out ratelimit delivered");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: opt.beeId })).view.flags.includes("resource_blocked") ? true : null, "opt-out flagged");
    await new Promise((r) => setTimeout(r, 150));
    const optView = await client.request<ViewResult>("view", { beeId: opt.beeId });
    assert.equal(optView.bee?.account, "claude-a");
    assert.equal(optView.view.generation, 1);
    assert.match(readFileSync(join(dir, "hived.log"), "utf8"), /account\.rotate bee=\S+ account=claude-a skipped=autoswap_disabled/);

    // 4) auth_needed evidence → account status + bee flag; a successful turn clears both
    const au = await client.request<SpawnResult>("spawn", { name: "au", agent: "claude", cwd: dir, account: "claude-b" });
    const a1 = await client.request<SendRpcResult>("send", { beeId: au.beeId, body: "@authfail" });
    await waitDelivered(client, au.beeId, a1.messageId, "authfail delivered");
    await waitFor(async () => (await client.request<AccountGetResult>("account.get", { id: "claude-b" })).account.status === "auth_needed" ? true : null, "account auth_needed");
    assert.ok((await client.request<ViewResult>("view", { beeId: au.beeId })).view.flags.includes("auth_needed"));
    const a2 = await client.request<SendRpcResult>("send", { beeId: au.beeId, body: "fine now" });
    await waitDelivered(client, au.beeId, a2.messageId, "authenticated turn delivered");
    await waitFor(async () => (await client.request<AccountGetResult>("account.get", { id: "claude-b" })).account.status === "ok" ? true : null, "account back to ok");
    await waitFor(async () => !(await client.request<ViewResult>("view", { beeId: au.beeId })).view.flags.includes("auth_needed") ? true : null, "bee flag cleared");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});
