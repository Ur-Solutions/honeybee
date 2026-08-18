/**
 * WP7 (spec 07 B4 + §F) — the resume-on-revive test over the REAL daemon:
 *
 *  1. a frozen old-world store built from REAL claude/codex record shapes
 *     (copied 2026-08-18, scrubbed) + FROZEN marker
 *  2. `import.fromFrozen` over RPC (dry-run first, then for real, then again
 *     for idempotency) — bees land stopped, id preserved, provider session id
 *     + harness home env on the row
 *  3. message each imported bee → send_wake → revive → the driver spawns the
 *     harness WITH the resume selector: fake claude sees `--resume <that id>`
 *     and CLAUDE_CONFIG_DIR = the old home; fake codex sees `thread/resume
 *     {threadId: <that id>}` and CODEX_HOME = the old home; the new generation
 *     reports the SAME session id, which the daemon records unchanged — AND
 *     with the per-bee args the importer kept from the old launch argv
 *     (schema v5): fake claude sees `--model fable --effort high
 *     --dangerously-skip-permissions --resume <id>`; fake codex sees
 *     `-c model_reasoning_effort="ultra"` on argv and `model: gpt-5.6-sol`
 *     in thread/resume (lifted off argv), never the dropped old plumbing
 *  4. the same continuity for a v2-born bee: first boot mints a session id →
 *     recorded → stop → message → generation 2 resumes it (scale-to-zero pause);
 *     spawned with `args`, then `bee.setArgs` before the stop → generation 2
 *     runs with the replaced args + the resume selector
 *
 * SAFETY: temp dirs only; the "agents" are fake-claude.mjs / fake-codex.mjs
 * (v2/driver-hsr/test-agent) — no real CLI, no tokens; the frozen fixture's
 * pids are impossible values so the real preflight cannot collide with a live
 * process on the test host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportFromFrozenResult, ListResult, MailboxResult, SendRpcResult, SetArgsResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import {
  CLAUDE_HSR_SESSION_ID,
  CODEX_HSR_THREAD_ID,
  claudeHsrRecord,
  codexHsrRecord,
  makeFrozenFixture,
} from "../../core/tests/frozen-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");
const FAKE_CODEX = join(here, "..", "..", "driver-hsr", "test-agent", "fake-codex.mjs");

/** Impossible pids: no live process on the test host can match (real preflight probes run in the daemon). */
const NO_SUCH_PID = 4_190_000;

function jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T);
}

test("import.int: frozen import over RPC → revive resumes claude (--resume) and codex (thread/resume) with the imported ids; v2-born bees resume across stop", async () => {
  const fx = makeFrozenFixture();
  const claudeArgvLog = join(fx.root, "fake-claude-argv.jsonl");
  const codexRpcLog = join(fx.root, "fake-codex-rpc.jsonl");
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      claude: { command: process.execPath, args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], adapter: "claude", env: { FAKE_CLAUDE_ARGV_LOG: claudeArgvLog } },
      codex: { command: process.execPath, args: [FAKE_CODEX, "app-server"], adapter: "codex", env: { FAKE_CODEX_RPC_LOG: codexRpcLog } },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    fx.writeMarker();
    fx.writeRecord("apiary-waggle-msx67afb-1.json", claudeHsrRecord(fx.root, { runnerPid: NO_SUCH_PID, runnerFingerprint: { pgid: NO_SUCH_PID, startedAt: "Tue Aug 18 07:42:57 2026" } }));
    fx.writeRecord("xr-dfc1452083e3.json", codexHsrRecord(fx.root, { runnerPid: NO_SUCH_PID + 1, runnerFingerprint: { pgid: NO_SUCH_PID + 1, startedAt: "Tue Aug 18 08:54:30 2026" } }));
    fx.writeRecord("done.json", claudeHsrRecord(fx.root, { id: "CL.done", name: "done-bee", status: "done" }));
    fx.writeRecord("kf.json", claudeHsrRecord(fx.root, { id: "CL.kf", name: "kf-bee", status: "kill_failed", runnerPid: NO_SUCH_PID + 2 }));
    fx.writeRecord("grok.json", claudeHsrRecord(fx.root, { id: "GR.1", name: "grok-bee", agent: "grok", runnerPid: NO_SUCH_PID + 3 }));
    const claudeHome = join(fx.root, "homes", "claude-fixture-account");
    const codexHome = join(fx.root, "homes", "codex-fixture-account");

    daemon = await startDaemon(dir);
    const client = await daemon.client();

    // --- dry-run: the plan, nothing written -----------------------------------
    const dry = await client.request<ImportFromFrozenResult>("import.fromFrozen", { root: fx.root, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.applied, false);
    assert.equal(dry.refusal, null, "marker present, impossible pids → preflight ok");
    assert.equal(dry.preflight.ok, true);
    assert.equal(dry.plan.counts.import, 2);
    assert.deepEqual(dry.plan.counts.byReason, { done: 1, kill_failed: 1, unsupported_agent: 1 });
    assert.equal((await client.request<ListResult>("list", {})).views.length, 0);

    // --- the import -------------------------------------------------------------
    const imported = await client.request<ImportFromFrozenResult>("import.fromFrozen", { root: fx.root });
    assert.equal(imported.applied, true, imported.refusal ?? "");
    assert.deepEqual(imported.imported.map((i) => i.beeId).sort(), ["CL.fe6f", "CO.3ae1"]);
    const claudeView = await client.request<ViewResult>("view", { beeId: "CL.fe6f" });
    assert.equal(claudeView.view.runtimeState, "stopped");
    assert.equal(claudeView.view.reachable, true);
    assert.equal(claudeView.bee?.providerSessionId, CLAUDE_HSR_SESSION_ID);
    assert.deepEqual(claudeView.bee?.env, { CLAUDE_CONFIG_DIR: claudeHome });
    assert.equal(claudeView.bee?.importedFrom, "frozen");
    assert.equal(claudeView.bee?.name, "apiary-waggle-msx67afb-1");
    assert.deepEqual(claudeView.bee?.args, ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high"], "per-bee args kept from the old launch argv (schema v5)");
    const codexView = await client.request<ViewResult>("view", { beeId: "CO.3ae1" });
    assert.deepEqual(codexView.bee?.args, ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"']);
    // list carries args too (mirror row shape)
    const listed = await client.request<ListResult>("list", {});
    assert.deepEqual(listed.views.find((v) => v.bee?.id === "CL.fe6f")?.bee?.args, claudeView.bee?.args);

    // idempotent re-run over RPC: no dupes
    const again = await client.request<ImportFromFrozenResult>("import.fromFrozen", { root: fx.root });
    assert.equal(again.applied, true);
    assert.equal(again.imported.length, 0);
    assert.equal(again.plan.counts.byReason.already_imported, 2);
    assert.equal((await client.request<ListResult>("list", {})).views.length, 2);

    // --- §F: message the imported claude bee → revive → --resume <imported id> --
    const sentClaude = await client.request<SendRpcResult>("send", { beeId: "CL.fe6f", body: "do you remember our conversation?" });
    assert.ok(sentClaude.commandId != null, "no live runtime → send_wake enqueued");
    const claudeGen = await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId: "CL.fe6f" });
      const m = messages.find((x) => x.id === sentClaude.messageId);
      return m?.deliveredAt != null ? m.deliveredGeneration : null;
    }, "claude message delivered to the revived generation", 12_000);
    assert.equal(claudeGen, 2, "revive minted generation 2 (generation 1 = the imported, stopped placeholder)");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: "CL.fe6f" })).view.runtimeState === "idle", "claude turn ended", 12_000);
    const claudeBoots = jsonl<{ argv: string[]; env: { CLAUDE_CONFIG_DIR: string | null }; sessionId: string; resumed: string | null; cwd: string }>(claudeArgvLog);
    assert.equal(claudeBoots.length, 1, "exactly one fake-claude spawn");
    const boot = claudeBoots[0]!;
    assert.deepEqual(boot.argv.slice(-2), ["--resume", CLAUDE_HSR_SESSION_ID], `spawned with --resume <imported id>: ${JSON.stringify(boot.argv)}`);
    assert.ok(boot.argv.includes("--output-format"), "the agent spec's own args are kept ahead of the resume selector");
    // schema v5: the imported per-bee args ride between the spec's args and the resume selector
    assert.deepEqual(
      boot.argv.slice(boot.argv.indexOf("--verbose") + 1),
      ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high", "--resume", CLAUDE_HSR_SESSION_ID],
      `spec args < bee args < resume: ${JSON.stringify(boot.argv)}`,
    );
    assert.equal(boot.argv.includes("--session-id"), false, "old --session-id dropped (never combined with --resume)");
    assert.equal(boot.argv.includes("--append-system-prompt"), false, "old system-prompt plumbing dropped");
    assert.equal(boot.env.CLAUDE_CONFIG_DIR, claudeHome, "runs under the imported home (the session lives there)");
    assert.equal(boot.resumed, CLAUDE_HSR_SESSION_ID);
    // the new generation reported the same session id; the daemon recorded it unchanged
    const afterClaude = await client.request<ViewResult>("view", { beeId: "CL.fe6f" });
    assert.equal(afterClaude.bee?.providerSessionId, CLAUDE_HSR_SESSION_ID);
    assert.equal(afterClaude.view.generation, 2);
    // the verbatim v2 session log for this generation carries the init line with that id
    const claudeStream = jsonl<{ type: string; subtype?: string; session_id?: string }>(join(dir, "session-logs", "CL.fe6f.jsonl"));
    assert.equal(claudeStream.find((l) => l.type === "system" && l.subtype === "init")?.session_id, CLAUDE_HSR_SESSION_ID);

    // --- §F: message the imported codex bee → revive → thread/resume {threadId: <imported id>} --
    const sentCodex = await client.request<SendRpcResult>("send", { beeId: "CO.3ae1", body: "and you?" });
    const codexGen = await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId: "CO.3ae1" });
      const m = messages.find((x) => x.id === sentCodex.messageId);
      return m?.deliveredAt != null ? m.deliveredGeneration : null;
    }, "codex message delivered to the revived generation", 12_000);
    assert.equal(codexGen, 2);
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: "CO.3ae1" })).view.runtimeState === "idle", "codex turn ended", 12_000);
    const codexCalls = jsonl<{ method: string; params: Record<string, unknown> | null; env: { CODEX_HOME: string | null } }>(codexRpcLog);
    const resume = codexCalls.find((c) => c.method === "thread/resume");
    assert.ok(resume, `thread/resume sent; saw ${JSON.stringify(codexCalls.map((c) => c.method))}`);
    assert.equal(resume.params?.threadId, CODEX_HSR_THREAD_ID);
    assert.equal(resume.env.CODEX_HOME, codexHome, "runs under the imported CODEX_HOME (the rollout lives there)");
    assert.equal(codexCalls.some((c) => c.method === "thread/start"), false, "never a fresh thread for a resumable bee");
    const turn = codexCalls.find((c) => c.method === "turn/start");
    assert.equal(turn?.params?.threadId, CODEX_HSR_THREAD_ID, "the delivered turn targets the resumed thread");
    const afterCodex = await client.request<ViewResult>("view", { beeId: "CO.3ae1" });
    assert.equal(afterCodex.bee?.providerSessionId, CODEX_HSR_THREAD_ID);
    // schema v5, codex mapping: `-c model_reasoning_effort` reaches the app-server child's argv;
    // `--model` is lifted into thread/resume; the approval flag is absorbed by the adapter's policy
    const codexArgv = (resume as unknown as { argv: string[] }).argv;
    assert.deepEqual(codexArgv.slice(codexArgv.indexOf("app-server")), ["app-server", "-c", 'model_reasoning_effort="ultra"'], `codex child argv: ${JSON.stringify(codexArgv)}`);
    assert.equal(resume.params?.model, "gpt-5.6-sol", "-m lifted into the thread request");
    assert.equal(resume.params?.approvalPolicy, "never");
    assert.equal(resume.params?.sandbox, "danger-full-access");
    assert.equal(codexArgv.some((a) => a.includes("service_tier") || a.includes("fast_mode")), false, "old service_tier/fast_mode plumbing dropped");

    // --- continuity for a v2-born bee (scale-to-zero pause shape) --------------
    const born = await client.request<SpawnResult>("spawn", { name: "fresh", agent: "claude", cwd: fx.root, args: ["--model", "opus"] });
    assert.deepEqual((await client.request<ViewResult>("view", { beeId: born.beeId })).bee?.args, ["--model", "opus"], "spawn args land on the row");
    const first = await client.request<SendRpcResult>("send", { beeId: born.beeId, body: "first" });
    await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId: born.beeId });
      return messages.find((x) => x.id === first.messageId)?.deliveredAt != null;
    }, "fresh bee first delivery", 12_000);
    const minted = await waitFor(async () => (await client.request<ViewResult>("view", { beeId: born.beeId })).bee?.providerSessionId, "fresh bee's session id recorded", 12_000);
    assert.notEqual(minted, CLAUDE_HSR_SESSION_ID);
    // bee.setArgs before the stop: generation 2 must run with the replaced args
    const setArgs = await client.request<SetArgsResult>("bee.setArgs", { beeId: born.beeId, args: ["--model", "fable", "--dangerously-skip-permissions"] });
    assert.equal(setArgs.applied, true);
    assert.deepEqual(setArgs.bee.args, ["--model", "fable", "--dangerously-skip-permissions"]);
    assert.equal((await client.request<SetArgsResult>("bee.setArgs", { beeId: born.beeId, args: ["--model", "fable", "--dangerously-skip-permissions"] })).applied, false, "identical = no-op");
    await client.request("stop", { beeId: born.beeId });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: born.beeId })).view.runtimeState === "stopped", "fresh bee stopped", 12_000);
    const second = await client.request<SendRpcResult>("send", { beeId: born.beeId, body: "second" });
    const gen2 = await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId: born.beeId });
      const m = messages.find((x) => x.id === second.messageId);
      return m?.deliveredAt != null ? m.deliveredGeneration : null;
    }, "fresh bee second delivery", 12_000);
    assert.equal(gen2, 2);
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: born.beeId })).view.runtimeState === "idle", "fresh bee gen 2 idle", 12_000);
    const bornBoots = jsonl<{ argv: string[]; sessionId: string; resumed: string | null; env: { CLAUDE_CONFIG_DIR: string | null } }>(claudeArgvLog).slice(1);
    assert.equal(bornBoots.length, 2, "fresh bee: two spawns (gen 1 fresh, gen 2 resumed)");
    assert.equal(bornBoots[0]?.resumed, null, "generation 1 had nothing to resume");
    assert.equal(bornBoots[0]?.sessionId, minted);
    assert.deepEqual(bornBoots[0]?.argv.slice(-2), ["--model", "opus"], "generation 1 ran with the spawn args");
    assert.equal(bornBoots[1]?.resumed, minted, "generation 2 resumes the id generation 1 minted");
    assert.deepEqual(bornBoots[1]?.argv.slice(-5), ["--model", "fable", "--dangerously-skip-permissions", "--resume", minted], `generation 2 ran with the replaced args + resume: ${JSON.stringify(bornBoots[1]?.argv)}`);
    assert.equal(bornBoots[1]?.argv.filter((a) => a === "--model").length, 1, "one --model after de-dup");
    // no per-bee env for a v2-born bee: it inherits whatever the daemon process had (possibly a CLAUDE_CONFIG_DIR of its own), never the imported home
    assert.equal(bornBoots[1]?.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR ?? null);
    assert.notEqual(bornBoots[1]?.env.CLAUDE_CONFIG_DIR, claudeHome);
    assert.equal((await client.request<ViewResult>("view", { beeId: born.beeId })).bee?.providerSessionId, minted);

    client.close();
    // hygiene: the importer never wrote into the frozen root (only our fake logs + the marker we wrote live there)
    assert.equal(existsSync(join(fx.root, "v2")), false);
  } catch (err) {
    process.stderr.write(`DAEMON OUTPUT:\n${daemon?.output().split("\n").slice(-60).join("\n")}\n`);
    try { process.stderr.write(`LOG:\n${readFileSync(join(dir, "hived.log"), "utf8").split("\n").slice(-60).join("\n")}\n`); } catch {}
    throw err;
  } finally {
    if (daemon) await daemon.stop().catch(() => undefined);
    cleanup();
    fx.cleanup();
  }
});
