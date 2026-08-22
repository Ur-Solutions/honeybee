/**
 * Schema v6 pre-flip verb set at the daemon tier — a REAL daemon process
 * over a temp socket (stub agent; fake-claude / fake-codex for fork):
 *  - bee.rename / bee.tag / bee.children round-trips + one-key idempotency
 *  - bee.interrupt: mid-turn interrupt → turn_ended, runtime still live, the
 *    next message delivers to the SAME generation; idle = reasoned no-op
 *  - bee.fork: fake-claude honors `--resume <src> --fork-session`; the fork
 *    boots with the source's id as its seed and reports a NEW id that is
 *    recorded on the fork (seed consumed); parentId/forkedFrom set; a later
 *    revive resumes the fork's OWN id; codex forks via thread/fork
 *  - parenting: spawn {parentId} → HIVE_BEE / HIVE_BEE_ID / HIVE_PARENT env
 *    stamps; archive parent leaves children; delete parent orphans
 *    (bee.orphaned in the watch stream)
 *  - questions: ask → open row → answer → delivered as mailbox message →
 *    answered; seals CRUD; snapshot/watch carry the new tables + kinds
 *  - typed errors: question_not_found, seal_not_found, invalid_request
 *
 * SAFETY: temp dirs only; never ~/.hive, never the live daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChildrenResult,
  ForkResult,
  InterruptResult,
  ListResult,
  MailboxResult,
  MutationResult,
  QuestionAnswerResult,
  QuestionAskResult,
  QuestionListResult,
  RenameResult,
  SealCreateResult,
  SealGetResult,
  SealListResult,
  SendRpcResult,
  SnapshotResult,
  SpawnResult,
  TagResult,
  ViewResult,
  WatchFrame,
} from "../src/protocol.ts";
import { RpcError } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, sleep, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");
const FAKE_CODEX = join(here, "..", "..", "driver-hsr", "test-agent", "fake-codex.mjs");

function jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T);
}

async function spawnAndSettle(client: RpcClient, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const spawned = await client.request<SpawnResult>("spawn", { name, agent: "stub", cwd: "/tmp", ...extra });
  await waitFor(async () => (await client.request<ViewResult>("view", { beeId: spawned.beeId })).view.runtimeState === "idle", `${name} idle`);
  return spawned.beeId;
}

async function waitDelivered(
  client: RpcClient,
  beeId: string,
  messageId: number,
  what: string,
  timeoutMs = 12_000,
): Promise<number> {
  return (await waitFor(async () => {
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    const m = messages.find((x) => x.id === messageId);
    return m?.deliveredAt != null ? m.deliveredGeneration : null;
  }, what, timeoutMs)) as number;
}

async function waitState(
  client: RpcClient,
  beeId: string,
  state: string,
  what: string,
  timeoutMs = 12_000,
): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === state ? v : null;
  }, what, timeoutMs);
}

test("v6.rpc.1: rename / tag / children round-trips, idempotent replays, typed refusals; snapshot + watch carry the new rows/kinds", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const watcher = await daemon.client();
    const frames: WatchFrame[] = [];
    watcher.onEvent = (f: WatchFrame) => frames.push(f);
    await watcher.request<SnapshotResult>("watch");

    const beeId = await spawnAndSettle(client, "worker", { tags: ["apiary:workspace=old"] });

    // rename
    const r1 = await client.request<RenameResult>("bee.rename", { beeId, name: "worker-2", idempotencyKey: "ren-1" });
    assert.equal(r1.applied, true);
    assert.equal(r1.bee.name, "worker-2");
    const r1b = await client.request<RenameResult>("bee.rename", { beeId, name: "worker-2", idempotencyKey: "ren-1" });
    assert.equal(r1b.deduped, true);
    assert.equal(r1b.applied, true, "replay answers the ORIGINAL result");
    const r1c = await client.request<RenameResult>("bee.rename", { beeId, name: "worker-2" });
    assert.equal(r1c.applied, false, "fresh call: already that name");
    await assert.rejects(client.request("bee.rename", { beeId, name: "" }), (e: unknown) => e instanceof RpcError && e.code === "invalid_request");
    await assert.rejects(client.request("bee.rename", { beeId: "nope", name: "x" }), (e: unknown) => e instanceof RpcError && e.code === "bee_not_found");

    // tag: move between apiary workspaces
    const t1 = await client.request<TagResult>("bee.tag", { beeId, remove: ["apiary:workspace=old"], add: ["apiary:workspace=new", "x"], idempotencyKey: "tag-1" });
    assert.deepEqual(t1.bee.tags, ["apiary:workspace=new", "x"]);
    assert.deepEqual(t1.added, ["apiary:workspace=new", "x"]);
    assert.deepEqual(t1.removed, ["apiary:workspace=old"]);
    const t1b = await client.request<TagResult>("bee.tag", { beeId, remove: ["apiary:workspace=old"], add: ["apiary:workspace=new", "x"], idempotencyKey: "tag-1" });
    assert.equal(t1b.deduped, true);
    assert.deepEqual(t1b.added, ["apiary:workspace=new", "x"], "original result replayed");
    await assert.rejects(client.request("bee.tag", { beeId }), (e: unknown) => e instanceof RpcError && e.code === "invalid_request");
    await assert.rejects(client.request("bee.tag", { beeId, add: "x" }), (e: unknown) => e instanceof RpcError && e.code === "invalid_request");
    const listed = await client.request<ListResult>("list");
    assert.deepEqual(listed.views[0]?.bee?.tags, ["apiary:workspace=new", "x"], "list carries the tags verbatim");

    // children (parenting) via spawn {parentId}
    const child = await client.request<SpawnResult>("spawn", { name: "kid", agent: "stub", cwd: "/tmp", parentId: beeId });
    const kids = await client.request<ChildrenResult>("bee.children", { beeId });
    assert.deepEqual(kids.children.map((v) => v.bee?.id), [child.beeId]);
    assert.equal(kids.children[0]?.bee?.parentId, beeId);
    await assert.rejects(client.request("spawn", { name: "orphan", agent: "stub", cwd: "/tmp", parentId: "no-such-parent" }), (e: unknown) => e instanceof RpcError && e.code === "bee_not_found");

    // snapshot carries questions/seals arrays (empty here) — additive keys
    const snap = await client.request<SnapshotResult>("snapshot");
    assert.deepEqual(snap.questions, []);
    assert.deepEqual(snap.seals, []);
    assert.equal(snap.views.find((v) => v.bee?.id === beeId)?.bee?.name, "worker-2");

    // watch stream saw the new audit kinds, contiguous
    await waitFor(() => frames.some((f) => f.type === "delta" && f.events.some((e) => e.kind === "bee.tagged")), "bee.tagged delta");
    const kinds = frames.flatMap((f) => (f.type === "delta" ? f.events.map((e) => e.kind) : []));
    assert.ok(kinds.includes("bee.renamed"));
    assert.ok(kinds.includes("bee.tagged"));
    assert.equal(frames.some((f) => f.type === "gap"), false);
    watcher.close();
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("v6.rpc.2: bee.interrupt — idle no-op; mid-turn (hung) interrupt → turn_ended, runtime live, next message delivers to the same generation; replay dedups", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const beeId = await spawnAndSettle(client, "hanger");
    const idle = await client.request<InterruptResult>("bee.interrupt", { beeId });
    assert.deepEqual(idle, { beeId, generation: 1, interrupted: false, reason: "idle" });

    // a hung turn: running forever
    const hang = await client.request<SendRpcResult>("send", { beeId, body: "@hang" });
    await waitDelivered(client, beeId, hang.messageId, "hang delivered");
    await waitState(client, beeId, "running", "turn started");
    await sleep(150);
    assert.equal((await client.request<ViewResult>("view", { beeId })).view.runtimeState, "running", "still hung");

    const r = await client.request<InterruptResult>("bee.interrupt", { beeId, idempotencyKey: "int-1" });
    assert.deepEqual(r, { beeId, generation: 1, interrupted: true });
    const back = await waitState(client, beeId, "idle", "interrupted turn ended");
    assert.equal(back.view.generation, 1, "same generation — the runtime was not ended");
    assert.equal(back.runtime?.state, "idle");
    const replay = await client.request<InterruptResult>("bee.interrupt", { beeId, idempotencyKey: "int-1" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.interrupted, true, "replay answers the original outcome (no second interrupt)");

    // next message delivers to generation 1 and completes
    const next = await client.request<SendRpcResult>("send", { beeId, body: "after interrupt" });
    assert.equal(await waitDelivered(client, beeId, next.messageId, "next delivered"), 1);
    const logPath = join(dir, "session-logs", `${beeId}.jsonl`);
    await waitFor(() => /echo:after interrupt/.test(readFileSync(logPath, "utf8")), "next turn worked by the same runtime");
    await waitState(client, beeId, "idle", "next turn ended");
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /"interrupted":true/);
    assert.equal((await client.request<ViewResult>("view", { beeId })).view.generation, 1);

    // audit: bee.interrupted rows (informational) exist for both calls
    const snap = await client.request<SnapshotResult>("snapshot");
    assert.ok(snap.seq > 0);
    // stopped runtime → no_process (no error)
    await client.request("stop", { beeId });
    await waitState(client, beeId, "stopped", "stopped");
    const gone = await client.request<InterruptResult>("bee.interrupt", { beeId });
    assert.equal(gone.interrupted, false);
    assert.equal(gone.reason, "no_process");
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("v6.rpc.3: bee.fork (claude) — forks the source session into a NEW one (--resume <src> --fork-session), records the fork's own id (seed consumed), parentId/forkedFrom set, HIVE_* env stamps; revive resumes the fork's own id; prompt lands as first mail; replay dedups", async () => {
  const argvLog = join(process.env.TMPDIR ?? "/tmp", `hb-v6-fork-${process.pid}-${Date.now()}.jsonl`);
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
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    type Boot = { argv: string[]; env: { HIVE_BEE: string | null; HIVE_BEE_ID: string | null; HIVE_PARENT: string | null }; sessionId: string; resumed: string | null; forked: boolean };

    // source: boot + first message so it reports its session id
    const src = await client.request<SpawnResult>("spawn", { name: "src", agent: "claude", cwd: dir, args: ["--model", "opus"], tags: ["team:a"] });
    const first = await client.request<SendRpcResult>("send", { beeId: src.beeId, body: "hello" });
    await waitDelivered(client, src.beeId, first.messageId, "source first delivery");
    const srcSession = await waitFor(async () => (await client.request<ViewResult>("view", { beeId: src.beeId })).bee?.providerSessionId, "source session id recorded");
    await waitState(client, src.beeId, "idle", "source idle");
    const srcBoot = jsonl<Boot>(argvLog)[0]!;
    assert.equal(srcBoot.env.HIVE_BEE, "src");
    assert.equal(srcBoot.env.HIVE_BEE_ID, src.beeId);
    assert.equal(srcBoot.env.HIVE_PARENT, null, "a root bee has no parent stamp");

    // fork
    const fork = await client.request<ForkResult>("bee.fork", { beeId: src.beeId, name: "src-b", prompt: "carry on", idempotencyKey: "fork-1" });
    assert.equal(fork.forkedFrom, src.beeId);
    assert.equal(fork.forkSeed, srcSession);
    assert.equal(fork.bee.parentId, src.beeId);
    assert.equal(fork.bee.forkedFrom, src.beeId);
    assert.equal(fork.bee.forkSeed, srcSession);
    assert.equal(fork.bee.providerSessionId, null, "no session of its own yet");
    assert.equal(fork.bee.name, "src-b");
    assert.equal(fork.bee.agent, "claude");
    assert.equal(fork.bee.cwd, dir);
    assert.deepEqual(fork.bee.args, ["--model", "opus"], "same args");
    assert.deepEqual(fork.bee.tags, ["team:a"], "same tags");
    assert.ok(fork.messageId != null, "prompt enqueued as the fork's first mail");
    const replay = await client.request<ForkResult>("bee.fork", { beeId: src.beeId, name: "src-b", prompt: "carry on", idempotencyKey: "fork-1" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.beeId, fork.beeId, "no second fork minted");
    assert.equal((await client.request<ListResult>("list")).views.length, 2);

    // the fork boots with --resume <src> --fork-session and reports a NEW id
    await waitDelivered(client, fork.beeId, fork.messageId as number, "fork prompt delivered");
    const forkSession = await waitFor(async () => (await client.request<ViewResult>("view", { beeId: fork.beeId })).bee?.providerSessionId, "fork's own session id recorded");
    assert.notEqual(forkSession, srcSession, "the fork owns a NEW session");
    await waitState(client, fork.beeId, "idle", "fork idle");
    const forkView = await client.request<ViewResult>("view", { beeId: fork.beeId });
    assert.equal(forkView.bee?.forkSeed, null, "seed consumed on first boot");
    assert.equal(forkView.bee?.forkedFrom, src.beeId, "provenance stays");
    assert.equal(forkView.bee?.parentId, src.beeId);
    const forkBoot = jsonl<Boot>(argvLog).find((b) => b.env.HIVE_BEE_ID === fork.beeId)!;
    assert.ok(forkBoot, "fork booted");
    assert.equal(forkBoot.resumed, srcSession);
    assert.equal(forkBoot.forked, true);
    const resumeAt = forkBoot.argv.indexOf("--resume");
    assert.deepEqual(forkBoot.argv.slice(resumeAt), ["--resume", srcSession, "--fork-session"], `fork argv tail: ${JSON.stringify(forkBoot.argv)}`);
    assert.ok(forkBoot.argv.includes("--model") && forkBoot.argv.includes("opus"), "same per-bee args");
    assert.equal(forkBoot.argv.includes("--session-id"), false, "never pinned");
    assert.equal(forkBoot.env.HIVE_PARENT, src.beeId, "child stamped with its parent");
    assert.equal(forkBoot.env.HIVE_BEE, "src-b");
    assert.equal(forkBoot.sessionId, forkSession);
    // children read sees the fork
    const kids = await client.request<ChildrenResult>("bee.children", { beeId: src.beeId });
    assert.deepEqual(kids.children.map((v) => v.bee?.id), [fork.beeId]);
    // the source is untouched
    assert.equal((await client.request<ViewResult>("view", { beeId: src.beeId })).bee?.providerSessionId, srcSession);

    // stop + revive the fork → plain --resume <fork's own id>, no --fork-session
    await client.request("stop", { beeId: fork.beeId });
    await waitState(client, fork.beeId, "stopped", "fork stopped");
    const again = await client.request<SendRpcResult>("send", { beeId: fork.beeId, body: "again" });
    assert.equal(await waitDelivered(client, fork.beeId, again.messageId, "fork revived delivery"), 2);
    await waitState(client, fork.beeId, "idle", "fork gen 2 idle");
    const boots = jsonl<Boot>(argvLog).filter((b) => b.env.HIVE_BEE_ID === fork.beeId);
    assert.equal(boots.length, 2);
    const revived = boots[1]!;
    assert.equal(revived.forked, false);
    assert.deepEqual(revived.argv.slice(revived.argv.indexOf("--resume")), ["--resume", forkSession]);
    assert.equal((await client.request<ViewResult>("view", { beeId: fork.beeId })).bee?.providerSessionId, forkSession, "continuity kept across the revive");

    // a fork of a bee with NO session boots fresh, provenance still recorded
    const fresh = await client.request<SpawnResult>("spawn", { name: "never-spoke", agent: "claude", cwd: dir });
    const forkFresh = await client.request<ForkResult>("bee.fork", { beeId: fresh.beeId });
    assert.equal(forkFresh.forkSeed, null);
    assert.equal(forkFresh.bee.name, "never-spoke-fork");
    assert.equal(forkFresh.bee.forkedFrom, fresh.beeId);
    assert.equal(forkFresh.messageId, null);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("v6.rpc.4: bee.fork (codex) — the fork's handshake sends thread/fork {threadId: source}; the NEW thread id is recorded; delivery targets the new thread", async () => {
  const rpcLog = join(process.env.TMPDIR ?? "/tmp", `hb-v6-codex-fork-${process.pid}-${Date.now()}.jsonl`);
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      codex: { command: process.execPath, args: [FAKE_CODEX, "app-server"], adapter: "codex", env: { FAKE_CODEX_RPC_LOG: rpcLog } },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const src = await client.request<SpawnResult>("spawn", { name: "csrc", agent: "codex", cwd: dir });
    const srcThread = await waitFor(async () => (await client.request<ViewResult>("view", { beeId: src.beeId })).bee?.providerSessionId, "codex source thread id");
    await waitState(client, src.beeId, "idle", "codex source idle");
    const fork = await client.request<ForkResult>("bee.fork", { beeId: src.beeId, prompt: "go on" });
    assert.equal(fork.forkSeed, srcThread);
    const forkThread = await waitFor(async () => (await client.request<ViewResult>("view", { beeId: fork.beeId })).bee?.providerSessionId, "codex fork thread id");
    assert.notEqual(forkThread, srcThread);
    await waitDelivered(client, fork.beeId, fork.messageId as number, "codex fork prompt delivered");
    await waitState(client, fork.beeId, "idle", "codex fork idle");
    const calls = jsonl<{ method: string; params: Record<string, unknown> | null }>(rpcLog);
    const forkCall = calls.find((c) => c.method === "thread/fork");
    assert.ok(forkCall, `thread/fork sent; saw ${JSON.stringify(calls.map((c) => c.method))}`);
    assert.equal(forkCall.params?.threadId, srcThread);
    assert.equal(forkCall.params?.cwd, dir);
    const turns = calls.filter((c) => c.method === "turn/start");
    assert.ok(turns.some((t) => t.params?.threadId === forkThread), "the fork's turn targets its own new thread");
    assert.equal(calls.filter((c) => c.method === "thread/resume").length, 0, "fork never plain-resumes the source thread");
    assert.equal((await client.request<ViewResult>("view", { beeId: fork.beeId })).bee?.forkSeed, null);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("daemon restart: an adopted codex runtime keeps its persisted thread id and accepts the next message", async () => {
  const rpcLog = join(process.env.TMPDIR ?? "/tmp", `hb-v6-codex-adopt-${process.pid}-${Date.now()}.jsonl`);
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      codex: { command: process.execPath, args: [FAKE_CODEX, "app-server"], adapter: "codex", env: { FAKE_CODEX_RPC_LOG: rpcLog } },
    },
  });
  let daemon: DaemonHandle | null = null;
  let client: RpcClient | null = null;
  let hostPid: number | null = null;
  try {
    daemon = await startDaemon(dir);
    client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "codex-adopt", agent: "codex", cwd: dir });
    const threadId = await waitFor(
      async () => (await client!.request<ViewResult>("view", { beeId: spawned.beeId })).bee?.providerSessionId,
      "codex thread id",
      30_000,
    );
    const before = await waitState(client, spawned.beeId, "idle", "codex idle before daemon restart", 30_000);
    hostPid = before.runtime?.pid ?? null;
    assert.ok(hostPid != null && hostPid > 0);

    client.close();
    client = null;
    await daemon.kill();

    daemon = await startDaemon(dir);
    client = await daemon.client();
    const adopted = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.equal(adopted.view.generation, 1, "the surviving runtime is adopted, not replaced");
    assert.equal(adopted.bee?.providerSessionId, threadId, "the durable provider thread is unchanged");

    const sent = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "after restart" });
    assert.equal(
      await waitDelivered(client, spawned.beeId, sent.messageId, "post-restart codex delivery", 30_000),
      1,
      "mail reaches the adopted generation",
    );
    await waitFor(
      async () => jsonl<{ method: string; params: Record<string, unknown> | null }>(rpcLog)
        .some((call) => call.method === "turn/start" && call.params?.threadId === threadId),
      "post-restart turn/start targets the restored thread id",
      30_000,
    );
    await waitState(client, spawned.beeId, "idle", "codex idle after daemon restart", 30_000);

    await client.request("stop", { beeId: spawned.beeId });
    await waitState(client, spawned.beeId, "stopped", "codex stopped after adoption test", 30_000);
  } finally {
    client?.close();
    await daemon?.stop().catch(() => {});
    if (hostPid != null) {
      try { process.kill(-hostPid, "SIGKILL"); } catch { /* already stopped */ }
      try { process.kill(hostPid, "SIGKILL"); } catch { /* already stopped */ }
    }
    cleanup();
  }
});

test("v6.rpc.5: parenting policy over RPC — archive parent leaves children; delete parent orphans (bee.orphaned in the watch stream, children alive, parentId null); fork of a cell bee refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v6-cells-"));
  const origin = makeOrigin(root);
  const { dir, cleanup } = makeDaemonDir({ cells: { root: join(root, "cells") } });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const watcher = await daemon.client();
    const frames: WatchFrame[] = [];
    watcher.onEvent = (f: WatchFrame) => frames.push(f);
    await watcher.request<SnapshotResult>("watch");

    const parent = await spawnAndSettle(client, "boss");
    const c1 = await spawnAndSettle(client, "w1", { parentId: parent });
    const c2 = await spawnAndSettle(client, "w2", { parentId: parent });
    await client.request<MutationResult>("archive", { beeId: parent });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: parent })).view.lifecycle === "archived", "parent archived");
    for (const id of [c1, c2]) {
      const v = await client.request<ViewResult>("view", { beeId: id });
      assert.equal(v.view.lifecycle, "active", "archive parent ≠ archive children");
      assert.equal(v.bee?.parentId, parent);
    }
    await client.request<MutationResult>("delete", { beeId: parent });
    await waitFor(async () => !(await client.request<ViewResult>("view", { beeId: parent })).view.exists, "parent deleted");
    for (const id of [c1, c2]) {
      const v = await client.request<ViewResult>("view", { beeId: id });
      assert.equal(v.view.exists, true, "children survive — never cascaded");
      assert.equal(v.bee?.parentId, null, "orphaned");
      assert.ok(v.view.runtimeState !== "stopped", "children's runtimes untouched");
    }
    await waitFor(() => frames.some((f) => f.type === "delta" && f.events.some((e) => e.kind === "bee.orphaned")), "bee.orphaned delta");
    const orphaned = frames.flatMap((f) => (f.type === "delta" ? f.events.filter((e) => e.kind === "bee.orphaned") : []));
    assert.deepEqual(orphaned.map((e) => e.beeId).sort(), [c1, c2].sort());
    assert.deepEqual(orphaned.map((e) => e.payload.parentId), [parent, parent]);

    // a cell bee's checkout is single-tenant: fork is a typed refusal
    const celly = await client.request<SpawnResult>("spawn", { name: "celly", agent: "stub", substrate: "cell", cell: { originRepo: origin.repo, sha: origin.sha } });
    await assert.rejects(client.request("bee.fork", { beeId: celly.beeId }), (e: unknown) => e instanceof RpcError && e.code === "invalid_request" && /cell/.test(e.message));
    watcher.close();
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("v6.rpc.6: questions + seals — ask → open row → answer → delivered as mailbox message → answered; list filters; seals CRUD; typed not-found; idempotent replays; snapshot carries them", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const beeId = await spawnAndSettle(client, "asker");

    const asked = await client.request<QuestionAskResult>("question.ask", { beeId, text: "merge or rebase?", options: ["merge", "rebase"], idempotencyKey: "ask-1" });
    assert.equal(asked.question.status, "open");
    assert.equal(asked.question.generation, 1);
    assert.deepEqual(asked.question.options, ["merge", "rebase"]);
    const askedAgain = await client.request<QuestionAskResult>("question.ask", { beeId, text: "merge or rebase?", options: ["merge", "rebase"], idempotencyKey: "ask-1" });
    assert.equal(askedAgain.deduped, true);
    assert.equal(askedAgain.question.id, asked.question.id, "no second question");
    const open = await client.request<QuestionListResult>("question.list", { open: true });
    assert.deepEqual(open.questions.map((q) => q.id), [asked.question.id]);
    assert.deepEqual((await client.request<QuestionListResult>("question.list", { beeId })).questions.length, 1);
    assert.deepEqual((await client.request<SnapshotResult>("snapshot")).questions.map((q) => q.id), [asked.question.id]);

    const answered = await client.request<QuestionAnswerResult>("question.answer", { questionId: asked.question.id, answer: "rebase", answeredBy: "tormod", idempotencyKey: "ans-1" });
    assert.equal(answered.question.status, "answered");
    assert.equal(answered.question.answer, "rebase");
    assert.equal(answered.question.answeredBy, "tormod");
    assert.equal(answered.question.deliveryMessageId, answered.messageId);
    assert.equal(answered.commandId, null, "runtime is live: no wake needed");
    // the answer reaches the bee as ordinary mail, prefixed
    const gen = await waitDelivered(client, beeId, answered.messageId, "answer delivered");
    assert.equal(gen, 1);
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    const mail = messages.find((m) => m.id === answered.messageId)!;
    assert.ok(mail.body.startsWith(`[answer to question ${asked.question.id}] rebase`), mail.body);
    assert.equal(mail.sender, "tormod");
    // "delivered" only means the driver accepted the write; the runtime is
    // still reported idle until the daemon's next tick observes turn_started,
    // so waiting on idle here would pass BEFORE the turn — wait for the echo
    // (the stub's evidence it worked the answer) like the interrupt test does.
    const logPath = join(dir, "session-logs", `${beeId}.jsonl`);
    await waitFor(() => existsSync(logPath) && /echo:\[answer to question/.test(readFileSync(logPath, "utf8")), "answer worked by the bee", 12_000);
    await waitState(client, beeId, "idle", "answer turn ended");
    assert.match(readFileSync(logPath, "utf8"), /echo:\[answer to question/);
    const replay = await client.request<QuestionAnswerResult>("question.answer", { questionId: asked.question.id, answer: "rebase", answeredBy: "tormod", idempotencyKey: "ans-1" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.messageId, answered.messageId, "no second delivery");
    await assert.rejects(client.request("question.answer", { questionId: asked.question.id, answer: "merge" }), (e: unknown) => e instanceof RpcError && e.code === "invalid_request");
    await assert.rejects(client.request("question.answer", { questionId: "nope", answer: "x" }), (e: unknown) => e instanceof RpcError && e.code === "question_not_found");
    assert.deepEqual((await client.request<QuestionListResult>("question.list", { open: true })).questions, []);
    assert.equal((await client.request<QuestionListResult>("question.list", { open: false })).questions[0]?.status, "answered");

    // answering while the bee is stopped enqueues the wake (revive-on-answer)
    const q2 = await client.request<QuestionAskResult>("question.ask", { beeId, text: "ready?" });
    await client.request("stop", { beeId });
    await waitState(client, beeId, "stopped", "stopped");
    const a2 = await client.request<QuestionAnswerResult>("question.answer", { questionId: q2.question.id, answer: "yes" });
    assert.ok(a2.commandId != null, "send_wake enqueued");
    assert.equal(await waitDelivered(client, beeId, a2.messageId, "answer delivered to the revived generation"), 2);

    // seals
    const s1 = await client.request<SealCreateResult>("seal.create", { beeId, title: "done", body: "all green", refs: ["main@abc"], idempotencyKey: "seal-1" });
    assert.equal(s1.seal.generation, 2);
    assert.deepEqual(s1.seal.refs, ["main@abc"]);
    const s1b = await client.request<SealCreateResult>("seal.create", { beeId, title: "done", body: "all green", refs: ["main@abc"], idempotencyKey: "seal-1" });
    assert.equal(s1b.deduped, true);
    assert.equal(s1b.seal.id, s1.seal.id);
    const s2 = await client.request<SealCreateResult>("seal.create", { beeId, title: "review" });
    assert.equal(s2.seal.body, "");
    assert.deepEqual((await client.request<SealListResult>("seal.list", { beeId })).seals.map((s) => s.id), [s1.seal.id, s2.seal.id]);
    assert.deepEqual((await client.request<SealListResult>("seal.list")).seals.length, 2);
    assert.equal((await client.request<SealGetResult>("seal.get", { sealId: s1.seal.id })).seal.title, "done");
    await assert.rejects(client.request("seal.get", { sealId: "nope" }), (e: unknown) => e instanceof RpcError && e.code === "seal_not_found");
    await assert.rejects(client.request("seal.create", { beeId, title: "" }), (e: unknown) => e instanceof RpcError && e.code === "invalid_request");
    const snap = await client.request<SnapshotResult>("snapshot");
    assert.equal(snap.seals.length, 2);
    assert.equal(snap.questions.length, 2);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});
