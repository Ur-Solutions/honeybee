// Phase C integration tests for `hive fork` on a throwaway tmux server.
// No real agent or account/home is touched: agent launches are redirected to a
// long-lived `sleep` via HIVE_<TOOL>_CMD, parent records are seeded directly,
// and a temp HIVE_STORE_ROOT isolates the vault/store.
//   C1  same-harness + known providerSessionId → native resume baked in command
//   C1  --agent codex (cross-harness) → seeds from the latest seal, no resume
//   C3  account-bound parent → refuses without --account; with --account the
//       fork's home/account differ from the parent's
//   lineage + fork.create ledger + --model application
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { hasSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "hive-fork-itest-"));
delete process.env.TMUX;
process.env.HIVE_TMUX_SOCKET = join(process.env.TMUX_TMPDIR, "s.sock");
setTmuxSocket(process.env.HIVE_TMUX_SOCKET);

// Redirect every agent launch to a harmless long-lived process so the tmux pane
// stays alive but no real CLI ever runs. The resume/model args we append still
// land in the frozen command, which is what the C1/model assertions inspect.
const AGENT_CMD_ENV = {
  HIVE_CLAUDE_CMD: "sleep 600",
  HIVE_CODEX_CMD: "sleep 600",
};

after(async () => {
  await tmux(["kill-server"], { reject: false });
  setTmuxSocket(undefined);
  delete process.env.HIVE_TMUX_SOCKET;
  rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, NO_COLOR: "1" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

async function readRecord(storeRoot: string, name: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(join(storeRoot, "sessions", `${name}.json`), "utf8").catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

async function listRecords(storeRoot: string): Promise<Record<string, unknown>[]> {
  const files = await readdir(join(storeRoot, "sessions")).catch(() => []);
  const out: Record<string, unknown>[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(join(storeRoot, "sessions", file), "utf8").catch(() => null);
    if (raw) out.push(JSON.parse(raw));
  }
  return out;
}

// Write a parent SessionRecord directly into the store. tmuxTarget points at a
// real (live) session we create so the fork's spawn path has a sane source, but
// the fork itself never reads the parent's pane.
async function seedParent(
  storeRoot: string,
  name: string,
  cwd: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const now = "2026-06-16T10:00:00.000Z";
  const record = {
    name,
    agent: "claude",
    cwd,
    command: "sleep 600",
    tmuxTarget: name,
    combId: name,
    createdAt: now,
    updatedAt: now,
    status: "running",
    id: name,
    requestedAgent: "claude",
    ...overrides,
  };
  await mkdir(join(storeRoot, "sessions"), { recursive: true });
  await writeFile(join(storeRoot, "sessions", `${name}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

async function seedSeal(storeRoot: string, beeName: string, summary: string): Promise<void> {
  const sealedAt = "2026-06-16T09:30:00.000Z";
  const seal = {
    beeName,
    sealedAt,
    status: "done",
    summary,
    filesChanged: ["a.ts", "b.ts"],
    nextActions: ["run tests"],
  };
  const dir = join(storeRoot, "seals", beeName);
  await mkdir(dir, { recursive: true });
  const stamp = sealedAt.replace(/[:.]/g, "-");
  await writeFile(join(dir, `${stamp}.json`), `${JSON.stringify(seal, null, 2)}\n`, { mode: 0o600 });
}

function forkRecordOf(records: Record<string, unknown>[], parentName: string): Record<string, unknown> {
  const fork = records.find((r) => r.name !== parentName && r.forkedFromId !== undefined);
  assert.ok(fork, "a fork record was created");
  return fork!;
}

// ---- C1: same-harness resume ---------------------------------------------

test("C1: same-harness fork with a known providerSessionId bakes native resume args", { timeout: 40_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-fork-resume-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-fork-cwd-"));
  const env = { ...AGENT_CMD_ENV, HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `forkp-resume-${process.pid}`;
  try {
    const parent = await seedParent(storeRoot, parentName, cwd, { providerSessionId: "PS-123" });

    const fork = await runCli(["fork", parentName, "--no-wait", "--print"], env);
    assert.equal(fork.code, 0, fork.stderr);

    const forkRec = forkRecordOf(await listRecords(storeRoot), parentName);
    assert.match(String(forkRec.command), /--resume PS-123/, "resume args baked into the command");
    assert.equal(forkRec.seedMode, "resume");
    assert.equal(forkRec.forkCheckpoint, "resume:PS-123");
    assert.equal(forkRec.forkedFromId, parent.id);
    assert.ok(typeof forkRec.forkedAt === "string", "forkedAt set");
    assert.equal(forkRec.providerSessionId, undefined, "fork does NOT inherit the parent's providerSessionId");
    assert.ok(typeof forkRec.lastPromptAt === "string", "anti-cross-match lastPromptAt set");
    assert.equal(forkRec.combId, forkRec.tmuxTarget, "fork is its own comb");
  } finally {
    await runCli(["kill", parentName, "--comb"], env).catch(() => undefined);
    const recs = await listRecords(storeRoot);
    for (const r of recs) await tmux(["kill-session", "-t", `=${r.tmuxTarget}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---- C1: cross-harness seal ----------------------------------------------

test("C1: cross-harness fork (--agent codex) seeds from the latest seal, never resume", { timeout: 40_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-fork-seal-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-fork-cwd-"));
  const env = { ...AGENT_CMD_ENV, HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `forkp-seal-${process.pid}`;
  try {
    await seedParent(storeRoot, parentName, cwd, { providerSessionId: "PS-456" });
    await seedSeal(storeRoot, parentName, "Implemented the parser");

    // Seal seeding briefs via deliverBrief, which waits for readiness; the
    // sleep-pane never reaches a prompt, so --force-send sends after a short
    // boot timeout instead of failing.
    const fork = await runCli(
      ["fork", parentName, "--agent", "codex", "--no-wait", "--force-send", "--boot-ms", "500", "--no-wait-footer"],
      env,
    );
    assert.equal(fork.code, 0, fork.stderr);

    const forkRec = forkRecordOf(await listRecords(storeRoot), parentName);
    assert.equal(forkRec.agent, "codex", "fork runs codex");
    assert.equal(forkRec.seedMode, "seal");
    assert.match(String(forkRec.forkCheckpoint), /^seal:/);
    assert.doesNotMatch(String(forkRec.command), /resume/, "cross-harness fork has no resume args");
  } finally {
    const recs = await listRecords(storeRoot);
    for (const r of recs) await tmux(["kill-session", "-t", `=${r.tmuxTarget}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---- C3: account safety ---------------------------------------------------

test("C3: account-bound parent refuses a fork without --account, and with --account the home differs", { timeout: 40_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-fork-acct-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-fork-cwd-"));
  const env = { ...AGENT_CMD_ENV, HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `forkp-acct-${process.pid}`;
  const parentHome = join(storeRoot, "parent-home");
  try {
    // Codex parent bound to an account (avoids claude's keychain/OAuth path).
    await seedParent(storeRoot, parentName, cwd, {
      agent: "codex",
      requestedAgent: "codex",
      accountId: "codex-parent",
      homePath: parentHome,
    });
    await seedSeal(storeRoot, parentName, "Codex parent state");

    // (a) No --account → refuse, mentioning account-bound / --account.
    const refused = await runCli(["fork", parentName, "--agent", "codex", "--no-wait", "--boot-ms", "500"], env);
    assert.notEqual(refused.code, 0, "fork of an account-bound parent without --account is refused");
    assert.match(refused.stderr, /account-bound|--account/, refused.stderr);
    assert.equal((await listRecords(storeRoot)).length, 1, "no fork record was written on refusal");

    // (b) Register a distinct codex account and seed its vault credentials so
    // activation succeeds, then fork with --account.
    const other = await runCli(["account", "add", "codex", "fork-other@a.b"], env);
    assert.equal(other.code, 0, other.stderr);
    const otherId = "codex-fork-other-a.b";
    const vaultDir = join(storeRoot, "vault", "codex", otherId);
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, "auth.json"), JSON.stringify({ tokens: { access_token: "x" } }), { mode: 0o600 });

    const forked = await runCli(
      ["fork", parentName, "--agent", "codex", "--account", otherId, "--no-wait", "--force-send", "--boot-ms", "500", "--no-wait-footer"],
      env,
    );
    assert.equal(forked.code, 0, forked.stderr);

    const forkRec = forkRecordOf(await listRecords(storeRoot), parentName);
    assert.notEqual(forkRec.homePath, parentHome, "fork home differs from the parent's home");
    assert.equal(forkRec.accountId, otherId, "fork is bound to the distinct account");
    assert.notEqual(forkRec.accountId, "codex-parent", "fork account differs from the parent's");
    assert.match(String(forkRec.homePath), new RegExp(otherId), "fork home is the account's dedicated home");
  } finally {
    const recs = await listRecords(storeRoot);
    for (const r of recs) await tmux(["kill-session", "-t", `=${r.tmuxTarget}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("C3b: fork onto the parent's OWN account is refused (per-account OAuth-rotation guard)", { timeout: 40_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-fork-same-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-fork-cwd-"));
  const env = { ...AGENT_CMD_ENV, HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `forkp-same-${process.pid}`;
  try {
    // Register the account, then seed the parent bound to it at its DEDICATED
    // default home (storeRoot/homes/<id>) — the production layout the C3 test
    // above never reaches (it uses a custom homePath that can't equal it, which
    // is exactly what masked the original blocker).
    const add = await runCli(["account", "add", "codex", "fork-same@a.b"], env);
    assert.equal(add.code, 0, add.stderr);
    const acctId = "codex-fork-same-a.b";
    await seedParent(storeRoot, parentName, cwd, {
      agent: "codex",
      requestedAgent: "codex",
      accountId: acctId,
      homePath: join(storeRoot, "homes", acctId),
    });
    await seedSeal(storeRoot, parentName, "Codex parent state");

    // Fork onto the SAME account → must refuse BEFORE any activation, so the
    // parent's live OAuth chain is never rotated by a second bee on one account.
    const refused = await runCli(
      ["fork", parentName, "--agent", "codex", "--account", acctId, "--no-wait", "--boot-ms", "500"],
      env,
    );
    assert.notEqual(refused.code, 0, "fork onto the parent's own account is refused");
    assert.match(refused.stderr, /own account|log each other out|§7\.1/, refused.stderr);
    assert.equal((await listRecords(storeRoot)).length, 1, "no fork record written on refusal");
  } finally {
    const recs = await listRecords(storeRoot);
    for (const r of recs) await tmux(["kill-session", "-t", `=${r.tmuxTarget}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---- lineage, ledger, model ----------------------------------------------

test("lineage + fork.create ledger + --model are persisted", { timeout: 40_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-fork-lineage-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-fork-cwd-"));
  const env = { ...AGENT_CMD_ENV, HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `forkp-lineage-${process.pid}`;
  try {
    await seedParent(storeRoot, parentName, cwd, { providerSessionId: "PS-789" });

    const fork = await runCli(["fork", parentName, "--model", "opus", "--no-wait", "--print"], env);
    assert.equal(fork.code, 0, fork.stderr);

    const forkRec = forkRecordOf(await listRecords(storeRoot), parentName);
    assert.equal(forkRec.model, "opus", "model stored first-class");
    assert.match(String(forkRec.command), /--model opus/, "claude model flag baked into command");
    assert.match(String(forkRec.command), /--resume PS-789/, "resume still applies alongside the model");
    assert.equal(forkRec.forkedFromId, parentName);
    assert.ok(typeof forkRec.forkedAt === "string");
    assert.equal(forkRec.seedMode, "resume");

    const ledger = await readFile(join(storeRoot, "ledger.jsonl"), "utf8").catch(() => "");
    const forkEvents = ledger
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.type === "fork.create");
    assert.equal(forkEvents.length, 1, "one fork.create ledger event");
    assert.equal(forkEvents[0]!.forkedFromId, parentName);
    assert.equal(forkEvents[0]!.seedMode, "resume");
    assert.equal(forkEvents[0]!.model, "opus");
  } finally {
    const recs = await listRecords(storeRoot);
    for (const r of recs) await tmux(["kill-session", "-t", `=${r.tmuxTarget}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---- a smoke check that the throwaway tmux server is reachable ------------

test("fork smoke: the spawned fork session is actually live", { timeout: 40_000 }, async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-fork-smoke-"));
  const cwd = await mkdtemp(join(tmpdir(), "hive-fork-cwd-"));
  const env = { ...AGENT_CMD_ENV, HIVE_STORE_ROOT: storeRoot, TMUX_TMPDIR: process.env.TMUX_TMPDIR! };
  const parentName = `forkp-smoke-${process.pid}`;
  try {
    await seedParent(storeRoot, parentName, cwd, { providerSessionId: "PS-1" });
    // --seed none boots cold (no resume/model args appended), so the stub
    // command stays a clean `sleep 600` that keeps the pane — and the server —
    // alive for the liveness assertion. (Resume forks append flags the `sleep`
    // stub rejects, which is fine for the command-string assertions in C1 but
    // would kill the pane here.)
    const fork = await runCli(["fork", parentName, "--seed", "none", "--no-wait"], env);
    assert.equal(fork.code, 0, fork.stderr);
    const forkRec = forkRecordOf(await listRecords(storeRoot), parentName);
    assert.equal(forkRec.seedMode, "none");
    assert.equal(await hasSession(String(forkRec.tmuxTarget)), true, "fork tmux session is live");
  } finally {
    const recs = await listRecords(storeRoot);
    for (const r of recs) await tmux(["kill-session", "-t", `=${r.tmuxTarget}`], { reject: false });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
