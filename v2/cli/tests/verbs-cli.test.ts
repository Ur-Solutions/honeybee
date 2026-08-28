/**
 * CLI v1-alignment tier (reset/cli-v1-alignment): the sugar verbs (x, xa, run,
 * wait, here), the reading verbs (transcript, tail, last, events), and the
 * v1-shaped sugar (set-model, ls/ps aliases, usage, attach, login/swap-account
 * top-level). Temp dirs only; stub agent only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import {
  agentAccountSelection,
  loginFlowExitCode,
  runV2Cli,
  shouldFollowLogin,
  withModelArg,
  type CliIo,
} from "../src/main.ts";
import { renderLoginFlow } from "../src/render.ts";
import type { LoginFlowRow } from "../../daemon/src/protocol.ts";
import { stripAnsi } from "../src/style.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(stripAnsi(l)), err: (l) => err.push(stripAnsi(l)) }, out, err };
}

test("verbs.agent-account-selector: auto/rr suffixes collapse without hijacking ordinary hyphenated agents", () => {
  assert.deepEqual(agentAccountSelection("codex-auto"), { agent: "codex", account: "auto" });
  assert.deepEqual(agentAccountSelection("claude-rr"), { agent: "claude", account: "rr" });
  assert.deepEqual(agentAccountSelection("my-agent"), { agent: "my-agent" });
  assert.deepEqual(agentAccountSelection("-auto"), { agent: "-auto" });
});

test("verbs.login-flow: interactive logins are driven from the terminal; json/no-wait just start; the rendered flow carries no secret and no attach target", () => {
  const interactive = { json: false, noWait: false, stdinIsTTY: true, stdoutIsTTY: true };
  assert.equal(shouldFollowLogin(interactive), true);
  assert.equal(shouldFollowLogin({ ...interactive, json: true }), false);
  assert.equal(shouldFollowLogin({ ...interactive, noWait: true }), false);
  assert.equal(shouldFollowLogin({ ...interactive, stdinIsTTY: false }), false);
  assert.equal(loginFlowExitCode("succeeded"), 0);
  for (const phase of ["failed", "cancelled", "expired", "interrupted"] as const) assert.equal(loginFlowExitCode(phase), 1);

  const flow: LoginFlowRow = {
    id: "lf-1",
    account: "claude-work",
    harness: "claude",
    provider: null,
    revision: 2,
    methodId: "claude-oauth",
    methods: [
      { id: "claude-oauth", kind: "browser_code", label: "Sign in with Claude", description: null, remoteCapable: true, fields: [] },
      { id: "other", kind: "api_key", label: "Use a key", description: null, remoteCapable: true, fields: [] },
    ],
    phase: "waiting_input",
    detail: "Paste the code from the sign-in page.",
    authorizationUrl: "https://claude.ai/oauth/authorize?x=1",
    userCode: null,
    inputFields: [{ id: "code", label: "Authorization code", help: "Paste it", required: true, secret: true, inputType: "password", placeholder: null, pattern: null, options: null, scope: null }],
    error: { code: "invalid_credential", message: "rejected" },
    retryable: true,
    remote: false,
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
    completedAt: null,
  };
  const text = renderLoginFlow(flow).map(stripAnsi).join("\n");
  assert.match(text, /claude-work/);
  assert.match(text, /open: https:\/\/claude\.ai\/oauth\/authorize\?x=1/);
  assert.match(text, /needs: Authorization code/);
  assert.match(text, /invalid_credential: rejected/);
  assert.match(text, /other methods: other \(Use a key\)/);
  assert.doesNotMatch(text, /tmux|attach/);
});

async function idleBee(dir: string, needle: string): Promise<void> {
  await waitFor(async () => {
    const l = capture();
    await runV2Cli(["view", needle, "--data-dir", dir, "--json"], l.io);
    return (JSON.parse(l.out[0] ?? "{}") as { view?: { runtimeState: string } }).view?.runtimeState === "idle";
  }, `${needle} idle`, 10_000);
}

test("verbs.x: spawn + first send in one shot (fire-and-forget); prompt lands in the mailbox; usage error without a prompt", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const a = capture();
    assert.equal(await runV2Cli(["x", "zip", "say", "hi", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], a.io), 0);
    const r = JSON.parse(a.out[0] ?? "{}") as { beeId: string; commandId: number; messageId: number };
    assert.ok(r.beeId.length > 0);
    assert.ok(r.commandId > 0);
    assert.ok(r.messageId > 0);
    // The mailbox row is the durable prompt; it delivers when the bee boots.
    await waitFor(async () => {
      const m = capture();
      await runV2Cli(["mailbox", "zip", "--data-dir", dir, "--json"], m.io);
      const mail = JSON.parse(m.out[0] ?? "{}") as { messages: Array<{ id: number; body: string; deliveredAt: number | null }> };
      const row = mail.messages.find((x) => x.id === r.messageId);
      return row?.body === "say hi" && row.deliveredAt != null;
    }, "x prompt delivered", 10_000);
    // human mode mentions the send
    const h = capture();
    assert.equal(await runV2Cli(["x", "zap", "work", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir], h.io), 0);
    assert.ok(h.out[0]?.includes("sent message"), h.out[0]);
    // usage error: no prompt
    const bad = capture();
    assert.equal(await runV2Cli(["x", "nope", "--agent", "stub", "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err[0]?.includes("usage: hive x"), bad.err[0]);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.run: spawn + send + wait + print the reply + archive; --keep leaves the bee", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const a = capture();
    assert.equal(await runV2Cli(["run", "job", "-p", "hello", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], a.io), 0);
    const r = JSON.parse(a.out[0] ?? "{}") as { beeId: string; reply: string | null; archived: boolean; archiveCommandId: number | null };
    assert.equal(r.reply, "echo:hello", "the stub's assistant text is the reply");
    assert.equal(r.archived, true);
    assert.ok((r.archiveCommandId ?? 0) > 0);
    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["list", "--archived", "--data-dir", dir, "--json"], l.io);
      const listed = JSON.parse(l.out[0] ?? "{}") as { views: Array<{ bee: { id: string } }> };
      return listed.views.some((v) => v.bee.id === r.beeId);
    }, "run bee archived", 10_000);

    // human: reply on stdout, archive note on stderr
    const h = capture();
    assert.equal(await runV2Cli(["run", "job2", "-p", "ping", "--agent", "stub", "--cwd", "/tmp", "--keep", "--data-dir", dir], h.io), 0);
    assert.equal(h.out[0], "echo:ping");
    assert.ok(h.err.some((l) => l.includes("kept ")), h.err.join("\n"));
    const l2 = capture();
    await runV2Cli(["list", "--data-dir", dir, "--json"], l2.io);
    const active = JSON.parse(l2.out[0] ?? "{}") as { views: Array<{ bee: { name: string } }> };
    assert.ok(active.views.some((v) => v.bee.name === "job2"), "--keep leaves the bee active");
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.wait: blocks until idle with no queued mail; a hung turn times out with exit 1", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    assert.equal(await runV2Cli(["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir], capture().io), 0);
    await idleBee(dir, "worker");
    assert.equal(await runV2Cli(["send", "worker", "@slow:400", "--data-dir", dir], capture().io), 0);
    const w = capture();
    assert.equal(await runV2Cli(["wait", "worker", "--timeout", "10000", "--data-dir", dir], w.io), 0);
    assert.ok(w.out[0]?.includes("idle"), w.out[0]);

    assert.equal(await runV2Cli(["send", "worker", "@hang", "--data-dir", dir], capture().io), 0);
    const t = capture();
    assert.equal(await runV2Cli(["wait", "worker", "--timeout", "1200", "--data-dir", dir], t.io), 1);
    assert.ok(t.err[0]?.startsWith("timeout:"), t.err[0]);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.here: the HIVE_BEE_ID stamp — full line, --json, and the loud unset error", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  const savedEnv = process.env.HIVE_BEE_ID;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(await runV2Cli(["spawn", "selfy", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], s.io), 0);
    const beeId = (JSON.parse(s.out[0] ?? "{}") as { beeId: string }).beeId;
    process.env.HIVE_BEE_ID = beeId;

    const h = capture();
    assert.equal(await runV2Cli(["here", "--data-dir", dir], h.io), 0);
    assert.ok(h.out[0]?.startsWith(`here ${beeId}  selfy`), h.out[0]);
    const j = capture();
    assert.equal(await runV2Cli(["here", "--json", "--data-dir", dir], j.io), 0);
    const parsed = JSON.parse(j.out[0] ?? "{}") as { id: string; name: string; agent: string };
    assert.equal(parsed.id, beeId);
    assert.equal(parsed.name, "selfy");
    assert.equal(parsed.agent, "stub");

    delete process.env.HIVE_BEE_ID;
    const bad = capture();
    assert.equal(await runV2Cli(["here", "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err[0]?.includes("HIVE_BEE_ID"), bad.err[0]);
  } finally {
    if (savedEnv === undefined) delete process.env.HIVE_BEE_ID;
    else process.env.HIVE_BEE_ID = savedEnv;
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.transcript+last: stub session log rendered as turns; --raw verbatim; --tail bounds; last = newest assistant text", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    assert.equal(await runV2Cli(["x", "talker", "first", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir], capture().io), 0);
    await waitFor(async () => {
      const w = capture();
      return (await runV2Cli(["wait", "talker", "--timeout", "8000", "--data-dir", dir], w.io)) === 0;
    }, "talker settled", 10_000);
    assert.equal(await runV2Cli(["send", "talker", "second", "--wait", "--data-dir", dir], capture().io), 0);
    const w2 = capture();
    assert.equal(await runV2Cli(["wait", "talker", "--timeout", "8000", "--data-dir", dir], w2.io), 0);

    const t = capture();
    assert.equal(await runV2Cli(["transcript", "talker", "--data-dir", dir], t.io), 0);
    assert.ok(t.err[0]?.startsWith("# session log "), t.err[0]);
    assert.deepEqual(t.out, ["[assistant] echo:first", "[assistant] echo:second"]);

    // --tail bounds the rendered turns; alias tx routes here too.
    const tl = capture();
    assert.equal(await runV2Cli(["tx", "talker", "--tail", "1", "--data-dir", dir], tl.io), 0);
    assert.deepEqual(tl.out, ["[assistant] echo:second"]);

    // --raw is the verbatim jsonl (native stream truth).
    const raw = capture();
    assert.equal(await runV2Cli(["transcript", "talker", "--raw", "--data-dir", dir], raw.io), 0);
    assert.ok(raw.out.every((l) => l.startsWith("{")), raw.out[0]);
    assert.ok(raw.out.some((l) => l.includes('"event":"ready"')), "raw includes protocol lines the renderer elides");

    // json shapes
    const j = capture();
    assert.equal(await runV2Cli(["transcript", "talker", "--json", "--data-dir", dir], j.io), 0);
    const parsed = JSON.parse(j.out[0] ?? "{}") as { turns: Array<{ role: string; text: string }> };
    assert.deepEqual(parsed.turns.map((x) => x.text), ["echo:first", "echo:second"]);

    const last = capture();
    assert.equal(await runV2Cli(["last", "talker", "--data-dir", dir], last.io), 0);
    assert.equal(last.out[0], "echo:second");

    // tail renders like transcript (v1 tail showed the readable pane; a
    // pane-less bee must not get raw jsonl instead — contract §6). --raw is
    // the verbatim stream. Default is dump-and-exit; -f/--follow streams.
    const tail = capture();
    assert.equal(await runV2Cli(["tail", "talker", "--data-dir", dir], tail.io), 0);
    assert.deepEqual(tail.out, ["[assistant] echo:first", "[assistant] echo:second"]);
    const tailRaw = capture();
    assert.equal(await runV2Cli(["tail", "talker", "--raw", "--data-dir", dir], tailRaw.io), 0);
    assert.ok(tailRaw.out.every((l) => l.startsWith("{")), tailRaw.out[0]);
    // -n bounds the rendered lines.
    const tailN = capture();
    assert.equal(await runV2Cli(["tail", "talker", "-n", "1", "--data-dir", dir], tailN.io), 0);
    assert.deepEqual(tailN.out, ["[assistant] echo:second"]);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

const CLAUDE_FIXTURE = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "let me look" }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "file-a\nfile-b" }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "two files:\nfile-a and file-b" }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "two files:\nfile-a and file-b" }),
].join("\n");

test("verbs.transcript: claude-format fixture — text turns kept, tool traffic one-lined, thinking/result elided; stale offline read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-verbs-"));
  try {
    const logPath = join(dir, "claude.jsonl");
    writeFileSync(logPath, `${CLAUDE_FIXTURE}\n`);
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "cl-1", name: "clbee", agent: "claude", substrate: "hsr", cwd: "/tmp", sessionLogPath: logPath });
    store.close();

    const t = capture();
    assert.equal(await runV2Cli(["transcript", "clbee", "--data-dir", dir], t.io), 0);
    assert.ok(t.err[0]?.startsWith("STALE"), t.err[0]);
    assert.deepEqual(t.out, [
      "[assistant] let me look",
      "[tool] [tool_use: Bash]",
      "[tool] [tool_result]",
      "[assistant] two files:",
      "  file-a and file-b",
    ]);

    const j = capture();
    assert.equal(await runV2Cli(["transcript", "clbee", "--json", "--data-dir", dir], j.io), 0);
    const parsed = JSON.parse(j.out[0] ?? "{}") as { stale?: boolean; turns: Array<{ role: string }> };
    assert.equal(parsed.stale, true);
    assert.deepEqual(parsed.turns.map((x) => x.role), ["assistant", "tool", "tool", "assistant"]);

    // last picks the final assistant text (multi-line preserved).
    const last = capture();
    assert.equal(await runV2Cli(["last", "clbee", "--data-dir", dir], last.io), 0);
    assert.deepEqual(last.out, ["two files:\nfile-a and file-b"]);

    // a bee with no session log recorded is a loud, helpful error
    const store2 = openCoreStore(join(dir, "core.sqlite3"));
    // (read-only CLI never writes; create the second bee with a fresh writable handle)
    store2.createBee({ id: "cl-2", name: "nolog", agent: "claude", substrate: "hsr", cwd: "/tmp" });
    store2.close();
    const bad = capture();
    assert.equal(await runV2Cli(["transcript", "nolog", "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err.some((l) => l.includes("no session log recorded")), bad.err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runFollowUntil(
  argv: string[],
  cap: { io: CliIo; out: string[] },
  afterStart: () => void,
  predicate: () => boolean,
  label: string,
): Promise<number> {
  const before = new Set(process.listeners("SIGINT"));
  const done = runV2Cli(argv, cap.io);
  await waitFor(
    () => process.listeners("SIGINT").some((l) => !before.has(l)),
    `${label}: follow started`,
    5000,
  );
  afterStart();
  await waitFor(predicate, label, 5000);
  const added = process.listeners("SIGINT").filter((l) => !before.has(l));
  assert.ok(added.length > 0, `${label}: follow registered its SIGINT stop`);
  for (const listener of added) (listener as () => void)();
  return done;
}

test("verbs.tail: rendered backlog with -n (--raw for verbatim); -f/--follow streams appends until SIGINT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-verbs-"));
  try {
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${["a", "b", "c"].map((t) => JSON.stringify({ event: "text", text: t })).join("\n")}\n`);
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "tail-1", name: "tailee", agent: "stub", substrate: "hsr", cwd: "/tmp", sessionLogPath: logPath });
    store.close();

    // Default: dump-and-exit, rendered turns (v1 tail showed readable pane output).
    const a = capture();
    assert.equal(await runV2Cli(["tail", "tailee", "-n", "2", "--data-dir", dir], a.io), 0);
    assert.deepEqual(a.out, ["[assistant] b", "[assistant] c"]);

    // --raw is the verbatim session log.
    const rawTail = capture();
    assert.equal(await runV2Cli(["tail", "tailee", "-n", "2", "--raw", "--data-dir", dir], rawTail.io), 0);
    assert.deepEqual(rawTail.out, [JSON.stringify({ event: "text", text: "b" }), JSON.stringify({ event: "text", text: "c" })]);

    // --no-follow still dumps even if --follow is also passed.
    const nof = capture();
    assert.equal(await runV2Cli(["tail", "tailee", "-n", "1", "--follow", "--no-follow", "--raw", "--data-dir", dir], nof.io), 0);
    assert.deepEqual(nof.out, [JSON.stringify({ event: "text", text: "c" })]);

    // --follow: appended lines stream out; SIGINT ends the follow. Invoke the
    // follow's own SIGINT listener directly (a synthetic process.emit would
    // also hit the test runner's handlers).
    const f = capture();
    assert.equal(
      await runFollowUntil(
        ["tail", "tailee", "-n", "1", "--raw", "--follow", "--data-dir", dir],
        f,
        () => appendFileSync(logPath, `${JSON.stringify({ event: "text", text: "d" })}\n`),
        () => f.out.some((l) => l.includes('"text":"d"')),
        "tail --follow appended line",
      ),
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verbs.transcript: -f/--follow streams appended lines until SIGINT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-verbs-"));
  try {
    const logPath = join(dir, "tx.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ event: "text", text: "hello" })}\n`);
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "tx-1", name: "txbee", agent: "stub", substrate: "hsr", cwd: "/tmp", sessionLogPath: logPath });
    store.close();

    const dump = capture();
    assert.equal(await runV2Cli(["transcript", "txbee", "--data-dir", dir], dump.io), 0);
    assert.deepEqual(dump.out, ["[assistant] hello"]);

    const f = capture();
    assert.equal(
      await runFollowUntil(
        ["transcript", "txbee", "-n", "1", "-f", "--data-dir", dir],
        f,
        () => appendFileSync(logPath, `${JSON.stringify({ event: "text", text: "world" })}\n`),
        () => f.out.includes("[assistant] world"),
        "transcript -f appended turn",
      ),
      0,
    );
    assert.deepEqual(
      f.out.filter((l) => l.startsWith("[assistant]")),
      ["[assistant] hello", "[assistant] world"],
    );

    const raw = capture();
    assert.equal(
      await runFollowUntil(
        ["tx", "txbee", "--raw", "--follow", "--data-dir", dir],
        raw,
        () => appendFileSync(logPath, `${JSON.stringify({ event: "text", text: "again" })}\n`),
        () => raw.out.some((l) => l.includes('"text":"again"')),
        "tx --follow --raw appended line",
      ),
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verbs.last: falls back to the latest seal when the log has no assistant text; --seal skips straight there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-verbs-"));
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "s-1", name: "sealed", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store.createSeal("s-1", { title: "handoff done", body: "all green\nsee refs" });
    store.close();

    const a = capture();
    assert.equal(await runV2Cli(["last", "sealed", "--data-dir", dir], a.io), 0);
    assert.deepEqual(a.out, ["handoff done", "all green", "see refs"]);
    assert.ok(a.err.some((l) => l.includes("latest seal")), a.err.join("\n"));

    const b = capture();
    assert.equal(await runV2Cli(["last", "sealed", "--seal", "--json", "--data-dir", dir], b.io), 0);
    const parsed = JSON.parse(b.out[0] ?? "{}") as { seal: { title: string } };
    assert.equal(parsed.seal.title, "handoff done");

    // nothing at all → loud error
    const store2 = openCoreStore(join(dir, "core.sqlite3"));
    store2.createBee({ id: "s-2", name: "empty", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store2.close();
    const bad = capture();
    assert.equal(await runV2Cli(["last", "empty", "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err.some((l) => l.includes("no assistant output or seal")), bad.err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verbs.events: audit-row tail with --kind glob and --bee filters; stale fallback when the daemon is down", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const s1 = capture();
    assert.equal(await runV2Cli(["spawn", "ev-a", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], s1.io), 0);
    const beeA = (JSON.parse(s1.out[0] ?? "{}") as { beeId: string }).beeId;
    assert.equal(await runV2Cli(["spawn", "ev-b", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir], capture().io), 0);
    await idleBee(dir, "ev-a");

    const all = capture();
    assert.equal(await runV2Cli(["events", "--tail", "200", "--json", "--data-dir", dir], all.io), 0);
    const rows = (JSON.parse(all.out[0] ?? "{}") as { rows: Array<{ seq: number; kind: string; beeId: string | null }> }).rows;
    assert.ok(rows.some((r) => r.kind === "bee.created"), "audit backlog includes bee.created");
    assert.ok(rows.some((r) => r.kind.startsWith("runtime.")), "…and runtime rows");
    assert.ok(rows.every((r, i) => i === 0 || r.seq > (rows[i - 1] as { seq: number }).seq), "ordered by seq");

    const kinds = capture();
    assert.equal(await runV2Cli(["events", "--kind", "bee.*", "--tail", "200", "--json", "--data-dir", dir], kinds.io), 0);
    const beeKinds = (JSON.parse(kinds.out[0] ?? "{}") as { rows: Array<{ kind: string }> }).rows;
    assert.ok(beeKinds.length > 0);
    assert.ok(beeKinds.every((r) => r.kind.startsWith("bee.")), "glob filters kinds");

    const scoped = capture();
    assert.equal(await runV2Cli(["events", "--bee", "ev-a", "--tail", "200", "--json", "--data-dir", dir], scoped.io), 0);
    const scopedRows = (JSON.parse(scoped.out[0] ?? "{}") as { rows: Array<{ beeId: string | null }> }).rows;
    assert.ok(scopedRows.length > 0);
    assert.ok(scopedRows.every((r) => r.beeId === beeA), "--bee scopes to the bee's rows");

    // human line shape
    const h = capture();
    assert.equal(await runV2Cli(["events", "--kind", "bee.created", "--data-dir", dir], h.io), 0);
    assert.ok(h.out[0]?.includes("bee.created") && h.out[0]?.includes("bee="), h.out[0]);

    // stale: daemon down, read-only audit tail still answers
    await daemon.stop();
    daemon = null;
    const stale = capture();
    assert.equal(await runV2Cli(["events", "--kind", "bee.created", "--tail", "200", "--json", "--data-dir", dir], stale.io), 0);
    const staleParsed = JSON.parse(stale.out[0] ?? "{}") as { stale?: boolean; rows: unknown[] };
    assert.equal(staleParsed.stale, true);
    assert.equal(staleParsed.rows.length, 2);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.set-model: arg surgery — grammar-aware for claude/codex, conservative in-place for unknown harnesses; CLI applies via bee.setArgs", async (t) => {
  await t.test("withModelArg unit surface", () => {
    // claude grammar: later valued flag wins, position of the winner kept.
    assert.deepEqual(withModelArg("claude", ["--model", "opus", "--effort", "high"], "fable"), ["--effort", "high", "--model", "fable"]);
    // alias folding (codex -m) and --model=x spellings collapse onto one selector.
    assert.deepEqual(withModelArg("codex", ["-m", "opus"], "gpt-5"), ["--model", "gpt-5"]);
    assert.deepEqual(withModelArg("claude", ["--model=opus"], "fable"), ["--model", "fable"]);
    // unknown tokens ride along verbatim.
    assert.deepEqual(withModelArg("claude", ["--weird", "x"], "fable"), ["--weird", "x", "--model", "fable"]);
    // clear strips the selector; empty result clears the row (null).
    assert.equal(withModelArg("claude", ["--model", "opus"], null), null);
    assert.deepEqual(withModelArg("claude", ["--model", "opus", "--effort", "max"], null), ["--effort", "max"]);
    // unknown harness: in-place replace, else append; clear strips.
    assert.deepEqual(withModelArg("stub", ["--model", "a", "--x"], "b"), ["--model", "b", "--x"]);
    assert.deepEqual(withModelArg("stub", ["--x"], "b"), ["--x", "--model", "b"]);
    assert.deepEqual(withModelArg("stub", ["--model", "a", "--x"], null), ["--x"]);
    assert.equal(withModelArg("stub", null, null), null);
  });

  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    assert.equal(await runV2Cli(["spawn", "modely", "--agent", "stub", "--cwd", "/tmp", "--arg", "--model", "--arg", "opus", "--data-dir", dir], capture().io), 0);
    const a = capture();
    assert.equal(await runV2Cli(["set-model", "modely", "fable", "--data-dir", dir, "--json"], a.io), 0);
    const r = JSON.parse(a.out[0] ?? "{}") as { applied: boolean; bee: { args: string[] | null } };
    assert.equal(r.applied, true);
    assert.deepEqual(r.bee.args, ["--model", "fable"]);
    // human: says it applies on the next runtime
    const h = capture();
    assert.equal(await runV2Cli(["set-model", "modely", "opus", "--data-dir", dir], h.io), 0);
    assert.ok(h.out[0]?.includes("applies to the next runtime"), h.out[0]);
    // --clear returns the bee to the harness default (args cleared here).
    const c = capture();
    assert.equal(await runV2Cli(["set-model", "modely", "--clear", "--data-dir", dir, "--json"], c.io), 0);
    assert.equal((JSON.parse(c.out[0] ?? "{}") as { bee: { args: unknown } }).bee.args, null);
    // usage guards
    assert.equal(await runV2Cli(["set-model", "modely", "--data-dir", dir], capture().io), 1);
    assert.equal(await runV2Cli(["set-model", "modely", "x", "--clear", "--data-dir", dir], capture().io), 1);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.aliases: ls and ps are list; usage is limits-shaped over account_limits; login/swap-account top-level route through", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    assert.equal(await runV2Cli(["spawn", "ally", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir], capture().io), 0);
    const ls = capture();
    assert.equal(await runV2Cli(["ls", "--data-dir", dir, "--json"], ls.io), 0);
    assert.equal((JSON.parse(ls.out[0] ?? "{}") as { views: unknown[] }).views.length, 1);
    const ps = capture();
    assert.equal(await runV2Cli(["ps", "--data-dir", dir, "--json"], ps.io), 0);
    assert.equal((JSON.parse(ps.out[0] ?? "{}") as { views: unknown[] }).views.length, 1);

    // usage with no accounts: friendly empty
    const u = capture();
    assert.equal(await runV2Cli(["usage", "--data-dir", dir], u.io), 0);
    assert.ok(u.out[0]?.includes("no accounts"), u.out[0]);

    // top-level login/swap-account delegate to the account/bee verbs (typed errors prove the route).
    const l = capture();
    assert.equal(await runV2Cli(["login", "--data-dir", dir], l.io), 1);
    assert.ok(l.err[0]?.includes("usage: hive login"), l.err[0]);
    const l2 = capture();
    assert.equal(await runV2Cli(["login", "nope", "--data-dir", dir], l2.io), 1);
    assert.ok(l2.err[0]?.includes("account_not_found"), l2.err[0]);
    const sa = capture();
    assert.equal(await runV2Cli(["swap-account", "ally", "--data-dir", dir], sa.io), 1);
    assert.ok(sa.err[0]?.includes("usage: hive swap-account"), sa.err[0]);
    const sa2 = capture();
    assert.equal(await runV2Cli(["swap-account", "ally", "nope", "--data-dir", dir], sa2.io), 1);
    assert.ok(sa2.err[0]?.includes("account_not_found"), sa2.err[0]);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.account-capture: an already-authenticated home is validated, backed up, and marked logged in", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const addedOut = capture();
    assert.equal(await runV2Cli(["account", "add", "codex", "recovery", "--data-dir", dir, "--json"], addedOut.io), 0);
    const added = JSON.parse(addedOut.out[0] ?? "{}") as { account: { id: string; homePath: string } };
    mkdirSync(added.account.homePath, { recursive: true });
    const credential = '{"tokens":{"access_token":"fresh"}}';
    writeFileSync(join(added.account.homePath, "auth.json"), credential);

    const capturedOut = capture();
    assert.equal(await runV2Cli(["account", "capture", "codex-recovery", "--data-dir", dir, "--json"], capturedOut.io), 0);
    const captured = JSON.parse(capturedOut.out[0] ?? "{}") as {
      account: { id: string; status: string; lastLoginAt: number | null };
      captured: string[];
      source: string;
    };
    assert.equal(captured.account.id, "codex-recovery");
    assert.equal(captured.account.status, "ok");
    assert.ok(captured.account.lastLoginAt !== null);
    assert.deepEqual(captured.captured, ["auth.json"]);
    assert.equal(captured.source, "home");
    assert.equal(readFileSync(join(dir, "vault", "codex", "codex-recovery", "auth.json"), "utf8"), credential);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.usage: renders the cached account_limits rows (stale, read-only) with pct + resets, v1-usage style", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-verbs-"));
  try {
    const now = Date.now();
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createAccount({ id: "claude-a", harness: "claude", homePath: join(dir, "homes", "claude-a"), label: "a" });
    store.putAccountLimits("claude-a", {
      readable: true,
      plan: "max",
      fiveHour: { usedPercent: 52, resetsAt: now + 2 * 60 * 60 * 1000 },
      weekly: { usedPercent: 23, resetsAt: now + 3 * 24 * 60 * 60 * 1000 },
      fableWeekly: { usedPercent: 9, resetsAt: now + 3 * 24 * 60 * 60 * 1000 },
    });
    store.createAccount({ id: "claude-b", harness: "claude", homePath: join(dir, "homes", "claude-b"), label: "b" });
    store.putAccountLimits("claude-b", { readable: false, error: "no credential" });
    store.close();

    const a = capture();
    assert.equal(await runV2Cli(["usage", "--data-dir", dir], a.io), 0);
    assert.ok(a.out[0]?.includes("ACCOUNT") && a.out[0]?.includes("WEEKLY"), a.out[0]);
    const rowA = a.out.find((l) => l.includes("claude-a"));
    assert.ok(rowA?.includes("52%") && rowA.includes("⟳ 2h") && rowA.includes("23%") && rowA.includes("9%") && rowA.includes("max"), rowA);
    assert.ok(rowA?.startsWith("stale: "), "stale-labeled when the daemon is down");
    const rowB = a.out.find((l) => l.includes("claude-b"));
    assert.ok(rowB?.includes("unreadable: no credential"), rowB);

    // [account] filter + --json
    const j = capture();
    assert.equal(await runV2Cli(["usage", "CLAUDE-A", "--json", "--data-dir", dir], j.io), 0, "daemon-down usage shares the fuzzy/case-insensitive selector");
    const parsed = JSON.parse(j.out[0] ?? "{}") as { stale?: boolean; limits: Array<{ account: string }> };
    assert.equal(parsed.stale, true);
    assert.deepEqual(parsed.limits.map((l) => l.account), ["claude-a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("verbs.xa: v1 shape is <agent> (not a bee name); refuses pane-less substrates; tmux spawn + --print", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const usage = capture();
    assert.equal(await runV2Cli(["xa", "--data-dir", dir], usage.io), 1);
    assert.ok(usage.err[0]?.includes("usage: hive xa"), usage.err[0]);

    const clash = capture();
    assert.equal(await runV2Cli(["xa", "stub", "--agent", "claude", "--data-dir", dir], clash.io), 1);
    assert.ok(clash.err[0]?.includes("disagree"), clash.err[0]);

    const hsr = capture();
    assert.equal(await runV2Cli(["xa", "stub", "--substrate", "hsr", "--data-dir", dir], hsr.io), 1);
    const hsrMsg = hsr.err.join("\n");
    assert.ok(hsrMsg.includes("hsr bees don't have"), hsrMsg);
    assert.ok(hsrMsg.includes("hive x"), hsrMsg);

    const cell = capture();
    assert.equal(await runV2Cli(["xa", "stub", "--substrate", "cell", "--data-dir", dir], cell.io), 1);
    assert.ok(cell.err.join("\n").includes("cell bees don't have"), cell.err.join("\n"));

    if (!tmuxAvailable) return;

    const printed = capture();
    assert.equal(
      await runV2Cli(
        ["xa", "stub", "--name", "screenful", "--cwd", "/tmp", "--print", "--timeout", "10000", "--data-dir", dir, "--json"],
        printed.io,
      ),
      0,
    );
    const attach = JSON.parse(printed.out[0] ?? "{}") as { beeId: string; session: string; socket: string; command: string };
    assert.ok(attach.beeId.length > 0);
    assert.equal(attach.socket, join(dir, "tmux.sock"));
    assert.equal(attach.session, `hive-v2-${attach.beeId}-g1`);
    assert.equal(attach.command, `tmux -S ${attach.socket} attach-session -t =${attach.session}`);

    const view = capture();
    assert.equal(await runV2Cli(["view", "screenful", "--data-dir", dir, "--json"], view.io), 0);
    const listed = JSON.parse(view.out[0] ?? "{}") as { bee?: { name: string; agent: string; substrate: string } };
    assert.equal(listed.bee?.name, "screenful");
    assert.equal(listed.bee?.agent, "stub");
    assert.equal(listed.bee?.substrate, "tmux");

    const selected = capture();
    assert.equal(
      await runV2Cli(
        ["xa", "stub-auto", "--name", "auto-screen", "--cwd", "/tmp", "--print", "--timeout", "10000", "--data-dir", dir, "--json"],
        selected.io,
      ),
      0,
    );
    const selectedView = capture();
    assert.equal(await runV2Cli(["view", "auto-screen", "--data-dir", dir, "--json"], selectedView.io), 0);
    assert.equal((JSON.parse(selectedView.out[0] ?? "{}") as { bee?: { agent: string } }).bee?.agent, "stub");
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.attach: refuses hsr/cell bees with the v2 guidance; tmux bees get the recorded session (via --print)", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    assert.equal(await runV2Cli(["spawn", "paneless", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir], capture().io), 0);
    await idleBee(dir, "paneless");
    const a = capture();
    assert.equal(await runV2Cli(["attach", "paneless", "--data-dir", dir], a.io), 1);
    const message = a.err.join("\n");
    assert.ok(message.includes("pane-less"), message);
    assert.ok(message.includes("hive tail paneless --follow"), message);
    assert.ok(message.includes("transcript paneless --follow"), message);
    await daemon.stop();
    daemon = null;

    // a tmux-substrate bee resolves to the driver's session-name convention
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "tm-1", name: "screenful", agent: "claude", substrate: "tmux", cwd: "/tmp" });
    store.close();
    const p = capture();
    assert.equal(await runV2Cli(["attach", "screenful", "--print", "--data-dir", dir], p.io), 0);
    assert.equal(p.out[0], `tmux -S ${join(dir, "tmux.sock")} attach-session -t =hive-v2-tm-1-g1`);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("verbs.help: the grouped v1-style overview lists the new verbs under their sections", async () => {
  const a = capture();
  assert.equal(await runV2Cli(["help"], a.io), 0);
  const text = a.out.join("\n");
  for (const section of ["Spawn & run:", "Message:", "Observe:", "Manage bees:", "Accounts:", "Daemon:"]) {
    assert.ok(text.includes(section), `help has section ${section}`);
  }
  for (const verb of ["x <name>", "xa <agent>", "run <name> -p", "transcript <bee>", "tail <bee>", "last <bee>", "wait <bee>", "events [", "here [", "usage [", "set-model <bee>", "attach <bee>", "account capture <selector>", "swap-account <bee>"]) {
    assert.ok(text.includes(verb), `help mentions ${verb}`);
  }
});

// ---------------------------------------------------------------------------
// v10 — pretty handles: the resolution ladder (id → handle → name → unique
// prefix), unit-level over synthetic views + live handle display.
// ---------------------------------------------------------------------------

test("handles.ladder: exact id → exact handle (case-insensitive) → exact name → unique prefix; ambiguity lists candidates", async () => {
  const { resolveBeeIn } = await import("../src/main.ts");
  const mk = (id: string, handle: string | null, name: string) =>
    ({ bee: { id, handle, name }, view: { beeId: id }, runtime: null }) as never;
  const views = [
    mk("aaaa1111-0000-0000-0000-000000000001", "CL.a3f2", "reviewer"),
    mk("bbbb2222-0000-0000-0000-000000000002", "CO.a401", "builder"),
    mk("cccc3333-0000-0000-0000-000000000003", "CL.b7c9", "builder-2"),
  ];
  // exact id
  assert.equal(resolveBeeIn(views, "aaaa1111-0000-0000-0000-000000000001"), "aaaa1111-0000-0000-0000-000000000001");
  // exact handle, case-insensitive
  assert.equal(resolveBeeIn(views, "CL.a3f2"), "aaaa1111-0000-0000-0000-000000000001");
  assert.equal(resolveBeeIn(views, "cl.a3f2"), "aaaa1111-0000-0000-0000-000000000001");
  // exact name
  assert.equal(resolveBeeIn(views, "reviewer"), "aaaa1111-0000-0000-0000-000000000001");
  // unique prefix over handle and name
  assert.equal(resolveBeeIn(views, "CL.b"), "cccc3333-0000-0000-0000-000000000003");
  assert.equal(resolveBeeIn(views, "builder-"), "cccc3333-0000-0000-0000-000000000003");
  assert.equal(resolveBeeIn(views, "bbbb"), "bbbb2222-0000-0000-0000-000000000002");
  // ambiguous prefix: loud error listing candidates
  assert.throws(
    () => resolveBeeIn(views, "CL."),
    (err: unknown) => err instanceof Error && /ambiguous/.test(err.message) && /CL\.a3f2/.test(err.message) && /CL\.b7c9/.test(err.message),
  );
  // 'builder' is an exact name AND a prefix of builder-2 — exact wins, no ambiguity
  assert.equal(resolveBeeIn(views, "builder"), "bbbb2222-0000-0000-0000-000000000002");
  // sub-3-char non-exact needles never prefix-match
  assert.throws(() => resolveBeeIn(views, "CL"), (err: unknown) => err instanceof Error && /not found/.test(err.message));
});

test("handles.live: spawn returns the minted handle; ls leads with it and keeps id= tail; every verb takes the handle", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(await runV2Cli(["spawn", "prettybee", "--agent", "stub", "--cwd", dir, "--data-dir", dir, "--socket", daemon.socketPath], s.io), 0);
    const m = /spawned (ST\.[0-9a-f]{4,8}) \(([0-9a-f-]{36});/.exec(s.out[0] ?? "");
    assert.ok(m, `spawn output leads with the handle: ${s.out[0]}`);
    const handle = m![1] as string;
    const uuid = m![2] as string;
    const ls = capture();
    assert.equal(await runV2Cli(["ls", "--data-dir", dir, "--socket", daemon.socketPath], ls.io), 0);
    const row = ls.out.find((l) => l.includes("prettybee")) ?? "";
    assert.ok(row.includes(handle), `ls shows handle: ${row}`);
    assert.doesNotMatch(row, /args=/);
    // the handle resolves in a mutation verb round-trip; uuid lives on view, not ls.
    const v = capture();
    assert.equal(await runV2Cli(["view", handle.toLowerCase(), "--data-dir", dir, "--socket", daemon.socketPath], v.io), 0);
    assert.ok(v.out[0]?.includes("prettybee"));
    assert.ok(v.out.join("\n").includes(uuid), `view keeps the uuid: ${v.out.join(" | ")}`);
    const st = capture();
    assert.equal(await runV2Cli(["stop", handle, "--data-dir", dir, "--socket", daemon.socketPath], st.io), 0);
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("verbs.buz: v1 compat — buz send maps tiers onto urgency + sender; buz inbox = mailbox; retired subs guide loudly", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  const savedBeeId = process.env.HIVE_BEE_ID;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(
      await runV2Cli(["spawn", "peer", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], s.io),
      0,
    );
    await idleBee(dir, "peer");

    // The exact muscle-memory shape from old preambles:
    //   hive buz send <bee> --sender <me> -p "<body>" --tier queue
    const a = capture();
    assert.equal(
      await runV2Cli(
        ["buz", "send", "peer", "--sender", "CL.7920", "-p", "status please", "--tier", "queue", "--data-dir", dir, "--json"],
        a.io,
      ),
      0,
    );
    const m = capture();
    await runV2Cli(["mailbox", "peer", "--data-dir", dir, "--json"], m.io);
    const mail = JSON.parse(m.out[0] ?? "{}") as {
      messages: Array<{ sender: string; body: string; urgency: string }>;
    };
    const row = mail.messages.find((x) => x.body === "status please");
    assert.equal(row?.sender, "CL.7920");
    assert.equal(row?.urgency, "idle", "tier queue maps to urgency idle");

    // --sender-human → human:<name>; positional body works like plain send.
    const b = capture();
    assert.equal(
      await runV2Cli(["buz", "send", "peer", "hello", "there", "--sender-human", "tormod", "--data-dir", dir, "--json"], b.io),
      0,
    );
    const m2 = capture();
    await runV2Cli(["mailbox", "peer", "--data-dir", dir, "--json"], m2.io);
    const mail2 = JSON.parse(m2.out[0] ?? "{}") as { messages: Array<{ sender: string; body: string; urgency: string }> };
    const row2 = mail2.messages.find((x) => x.body === "hello there");
    assert.equal(row2?.sender, "human:tormod");
    assert.equal(row2?.urgency, "next", "no tier → the v2 default");

    // Ambient sender: HIVE_BEE_ID fills --sender, exactly the old default.
    process.env.HIVE_BEE_ID = "CO.amb";
    const c = capture();
    assert.equal(await runV2Cli(["buz", "send", "peer", "-p", "ambient", "--data-dir", dir, "--json"], c.io), 0);
    const m3 = capture();
    await runV2Cli(["mailbox", "peer", "--data-dir", dir, "--json"], m3.io);
    const mail3 = JSON.parse(m3.out[0] ?? "{}") as { messages: Array<{ sender: string; body: string }> };
    assert.equal(mail3.messages.find((x) => x.body === "ambient")?.sender, "CO.amb");

    // buz inbox <bee> renders the same mailbox.
    const d = capture();
    assert.equal(await runV2Cli(["buz", "inbox", "peer", "--data-dir", dir], d.io), 0);
    assert.ok(d.out.some((l) => l.includes("status please")));

    // Unknown tier is loud; retired subcommands guide to the v2 verbs.
    const e = capture();
    assert.equal(await runV2Cli(["buz", "send", "peer", "-p", "x", "--tier", "sometime", "--data-dir", dir], e.io), 1);
    assert.match([...e.err, ...e.out].join("\n"), /unknown tier "sometime"/);
    const f = capture();
    assert.equal(await runV2Cli(["buz", "queue", "--data-dir", dir], f.io), 1);
    assert.match([...f.err, ...f.out].join("\n"), /retired — buz is the mailbox now/);
  } finally {
    if (savedBeeId === undefined) delete process.env.HIVE_BEE_ID;
    else process.env.HIVE_BEE_ID = savedBeeId;
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
