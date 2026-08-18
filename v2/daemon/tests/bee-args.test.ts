/**
 * Per-bee spawn args (schema v5) — daemon tier:
 *  - composeSpawn (the resolveSpawnSpec core, pure): spec.args < spec.defaultArgs
 *    < bee.args < resume args, with de-dup; codex model lifted into the thread
 *    request and approval flags absorbed; stub/unknown adapters concat verbatim
 *  - config: agents.<name>.defaultArgs parsed + validated
 *  - RPC: `bee.setArgs` (typed errors, idempotency key, null clears), `spawn`
 *    args validation, `revive` with replacement args over a live daemon (stub
 *    agent) — the store row reflects them and the audit carries bee.args_set
 *
 * Temp dirs only; the only process spawned is the stub agent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSpawn } from "../src/daemon.ts";
import { ConfigError, loadNodeConfig, BUILTIN_AGENTS } from "../src/config.ts";
import type { CommandsResult, SetArgsResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import { codexThreadRequest } from "../../adapters/src/index.ts";

const bee = (o: Partial<{ cwd: string; args: string[] | null; providerSessionId: string | null }> = {}) => ({
  cwd: "/tmp/w",
  args: null,
  providerSessionId: null,
  ...o,
});

test("args.daemon.1: composeSpawn precedence — claude: spec.args < defaultArgs < bee.args < --resume; later --model wins; boolean idempotent", () => {
  const spec = { ...BUILTIN_AGENTS.claude!, defaultArgs: ["--model", "opus", "--dangerously-skip-permissions"] };
  const base = BUILTIN_AGENTS.claude!.args!;
  // no bee args, no session: base + defaults
  assert.deepEqual(composeSpawn(spec, "claude", bee()).args, [...base, "--model", "opus", "--dangerously-skip-permissions"]);
  // bee args override the node default model; boolean not repeated; resume last
  const r = composeSpawn(spec, "claude", bee({ args: ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high"], providerSessionId: "sid-9" }));
  assert.deepEqual(r.args, [...base, "--dangerously-skip-permissions", "--model", "fable", "--effort", "high", "--resume", "sid-9"]);
  assert.equal(r.adapter?.harness, "claude");
  assert.equal(r.model, undefined, "claude keeps --model on argv (no lifting)");
  // no defaults, no bee args: today's shape exactly (spec args + resume)
  assert.deepEqual(composeSpawn(BUILTIN_AGENTS.claude!, "claude", bee({ providerSessionId: "s" })).args, [...base, "--resume", "s"]);
  // a bee arg can override a base-layer plumbing flag (the operator asked for it); the survivor keeps its LATER position
  assert.deepEqual(composeSpawn(BUILTIN_AGENTS.claude!, "claude", bee({ args: ["--output-format", "json"] })).args, ["-p", "--input-format", "stream-json", "--verbose", "--output-format", "json"]);
});

test("args.daemon.2: composeSpawn codex — model lifted into thread/start|resume, approval flag absorbed, -c overrides stay on argv after app-server", () => {
  const spec = { ...BUILTIN_AGENTS.codex!, defaultArgs: ["-c", "model_reasoning_effort=\"medium\"", "--model", "gpt-5.5"] };
  const r = composeSpawn(spec, "codex", bee({ args: ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"'], providerSessionId: "thread-1" }));
  assert.deepEqual(r.args, ["app-server", "-c", 'model_reasoning_effort="ultra"'], "later -c wins per key; model + approval lifted; positional kept");
  assert.equal(r.model, "gpt-5.6-sol");
  assert.equal(r.adapter?.harness, "codex");
  // the adapter's thread request carries the lifted model + the resume id
  const req = codexThreadRequest({ cwd: "/tmp/w", model: r.model, resumeThreadId: "thread-1" });
  assert.equal(req.method, "thread/resume");
  assert.deepEqual(req.params, { threadId: "thread-1", model: "gpt-5.6-sol", cwd: "/tmp/w", approvalPolicy: "never", sandbox: "danger-full-access" });
  // no model anywhere → none in the request
  const plain = composeSpawn(BUILTIN_AGENTS.codex!, "codex", bee());
  assert.deepEqual(plain.args, ["app-server"]);
  assert.equal(plain.model, undefined);
});

test("args.daemon.3: composeSpawn stub/unknown — verbatim concatenation, no de-dup, no resume; unknown adapter → null", () => {
  const spec = { command: "node", args: ["agent.mjs", "--x"], defaultArgs: ["--x"] };
  const r = composeSpawn(spec, "stub", bee({ args: ["--x", "--y"], providerSessionId: "ignored" }));
  assert.deepEqual(r.args, ["agent.mjs", "--x", "--x", "--x", "--y"]);
  assert.equal(r.adapter?.harness, "stub");
  assert.equal(composeSpawn(spec, "no-such-adapter", bee()).adapter, null);
});

test("args.daemon.4: config — agents.<name>.defaultArgs parsed; wrong type fails loudly; absent = undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cfg-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ agents: { claude: { command: "claude", args: ["-p"], defaultArgs: ["--model", "opus"] }, stub: { command: "node" } } }));
    const cfg = loadNodeConfig(dir);
    assert.deepEqual(cfg.agents.claude?.defaultArgs, ["--model", "opus"]);
    assert.equal(cfg.agents.stub?.defaultArgs, undefined);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ agents: { claude: { command: "claude", defaultArgs: "--model opus" } } }));
    assert.throws(() => loadNodeConfig(dir), (e: unknown) => e instanceof ConfigError && /defaultArgs must be a string array/.test(e.message));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ agents: { claude: { command: "claude", defaultArgs: [1] } } }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args.daemon.5: RPC — spawn args, bee.setArgs (typed errors, idempotency, null clears), revive with replacement args over the real daemon", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    // spawn: args validated + stored
    await assert.rejects(() => client.request("spawn", { name: "bad", agent: "stub", cwd: "/tmp", args: "nope" }), (e: Error & { code?: string }) => e.code === "invalid_request");
    await assert.rejects(() => client.request("spawn", { name: "bad", agent: "stub", cwd: "/tmp", args: [1] }), (e: Error & { code?: string }) => e.code === "invalid_request");
    const spawned = await client.request<SpawnResult>("spawn", { name: "w", agent: "stub", cwd: "/tmp", args: ["--flag-a"] });
    const beeId = spawned.beeId;
    assert.deepEqual((await client.request<ViewResult>("view", { beeId })).bee?.args, ["--flag-a"]);
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "stub idle");

    // setArgs: typed errors
    await assert.rejects(() => client.request("bee.setArgs", { beeId: "ghost", args: [] }), (e: Error & { code?: string }) => e.code === "bee_not_found");
    await assert.rejects(() => client.request("bee.setArgs", { beeId, args: "x" }), (e: Error & { code?: string }) => e.code === "invalid_request");
    await assert.rejects(() => client.request("bee.setArgs", { beeId }), (e: Error & { code?: string }) => e.code === "invalid_request");
    // setArgs: applied, no-op, idempotency replay, null clears
    const set = await client.request<SetArgsResult>("bee.setArgs", { beeId, args: ["--flag-b"], idempotencyKey: "k-set-1" });
    assert.equal(set.applied, true);
    assert.deepEqual(set.bee.args, ["--flag-b"]);
    const replay = await client.request<SetArgsResult>("bee.setArgs", { beeId, args: ["--flag-b"], idempotencyKey: "k-set-1" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.applied, true, "replay answers with the ORIGINAL result");
    const noop = await client.request<SetArgsResult>("bee.setArgs", { beeId, args: ["--flag-b"] });
    assert.equal(noop.applied, false);
    const cleared = await client.request<SetArgsResult>("bee.setArgs", { beeId, args: null });
    assert.equal(cleared.applied, true);
    assert.equal(cleared.bee.args, null);
    // the current runtime is untouched by setArgs (still generation 1, idle)
    const v1 = await client.request<ViewResult>("view", { beeId });
    assert.equal(v1.view.generation, 1);
    assert.equal(v1.view.runtimeState, "idle");

    // revive with replacement args: stop → revive {args} → generation 2 + row updated
    await client.request("stop", { beeId });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", "stopped");
    await assert.rejects(() => client.request("revive", { beeId, args: 5 }), (e: Error & { code?: string }) => e.code === "invalid_request");
    const revived = await client.request<{ commandId: number }>("revive", { beeId, args: ["--flag-c"] });
    await waitFor(async () => {
      const { commands } = await client.request<CommandsResult>("commands", { beeId });
      return commands.find((c) => c.id === revived.commandId)?.status === "done";
    }, "revive settled");
    const v2 = await client.request<ViewResult>("view", { beeId });
    assert.equal(v2.view.generation, 2);
    assert.deepEqual(v2.bee?.args, ["--flag-c"]);
    const { commands } = await client.request<CommandsResult>("commands", { beeId });
    assert.deepEqual(commands.find((c) => c.id === revived.commandId)?.args, { args: ["--flag-c"] }, "the command row carries the args");
    // revive without args leaves them alone
    await client.request("stop", { beeId });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", "stopped again");
    await client.request("revive", { beeId });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.generation === 3, "gen 3");
    assert.deepEqual((await client.request<ViewResult>("view", { beeId })).bee?.args, ["--flag-c"]);
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
