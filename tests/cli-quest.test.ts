// Integration coverage for `hive quest` (WORKSPACES_AND_QUESTS_PRD Phase 3,
// acceptance Q1) against a PRIVATE throwaway tmux socket + a temp store. We drive
// the real CLI as a subprocess (HIVE_STORE_ROOT + HIVE_TMUX_SOCKET so the child's
// tmux calls hit our private socket) and use the in-process tmux helper (pinned
// to the same socket) to assert live tmux state. The frame's bees spawn
// hermetically via HIVE_CLAUDE_CMD (a held shell), exactly like cli-workspace's
// restore rig — no real claude binary needed.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// `sh -c 'sleep 120' --` keeps the spawned frame-bee window alive AND absorbs any
// trailing agent args as ignored positional params, so a frame bee spawns as a
// hermetic held shell with no real claude binary (cli-workspace's RESTORE_ENV
// trick). --no-wait keeps spawn from blocking on readiness of the held shell.
const CLAUDE_ENV = { HIVE_CLAUDE_CMD: "sh -c 'sleep 120' --" } as const;

async function seedFrame(store: string, name: string, bee = "claude"): Promise<void> {
  const framesDir = join(store, "frames");
  await mkdir(framesDir, { recursive: true });
  const frame = {
    name,
    description: `${name} (test frame)`,
    castes: [{ name: "reviewer", bee, count: 1, brief: "review it" }],
  };
  await writeFile(join(framesDir, `${name}.json`), `${JSON.stringify(frame, null, 2)}\n`);
}

function hive(store: string, socket: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: store,
      HIVE_TMUX_SOCKET: socket,
      HIVE_NO_KEYCHAIN: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      ...extraEnv,
    },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function readQuestRecord(store: string, id: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(store, "quests", id, "quest.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readWs(store: string, name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(store, "workspaces", `${name}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function listBeeRecords(store: string): Promise<Array<Record<string, unknown>>> {
  const dir = join(store, "sessions");
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json"));
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as Record<string, unknown>);
  return out;
}

async function sessionWindowIds(session: string): Promise<string[]> {
  const r = await tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"], { reject: false });
  return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

async function hasSessionLocal(name: string): Promise<boolean> {
  const r = await tmux(["has-session", "-t", `=${name}`], { reject: false });
  return r.ok;
}

async function withRig(fn: (ctx: { store: string; socket: string }) => Promise<void>): Promise<void> {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-quest-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-quest-store-"));
  setTmuxSocket(socket);
  try {
    await fn({ store, socket });
  } finally {
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

test("Q1a: quest create makes the quest record + its dedicated workspace, status open", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const out = await hive(store, socket, ["quest", "create", "review 1255", "--colony", "reviews"]);
    // plain output: quest-created\t<id>\t<colony>\t<workspace>
    const m = out.stdout.match(/quest-created\t(\S+)\t(\S+)\t(\S+)/);
    assert.ok(m, `quest create prints quest-created line: ${out.stdout}`);
    const [, id, colony, workspace] = m!;
    assert.equal(colony, "reviews", "quest carries the --colony");
    assert.equal(workspace, id, "quest owns a workspace named after its id (not the colony)");

    // quests/<id>/quest.json exists with colony=reviews, status=open.
    const quest = await readQuestRecord(store, id!);
    assert.equal(quest.id, id);
    assert.equal(quest.colony, "reviews");
    assert.equal(quest.workspace, id);
    assert.equal(quest.status, "open");
    assert.deepEqual(quest.swarmIds, []);
    assert.equal(quest.title, "review 1255");

    // A workspace record named <id> exists (so ws-<id> is the quest's own ws).
    const ws = await readWs(store, id!);
    assert.equal(ws.name, id);
    assert.equal(ws.colony, "reviews");
    assert.equal(ws.questId, id, "the workspace is stamped with its owning quest");
    // And it is NOT the colony's shared workspace.
    assert.notEqual(ws.name, "reviews", "quest workspace is dedicated, not the colony-shared one");
  });
});

test("Q1b: quest start --frame spawns the swarm into ws-<id>, every bee tagged questId/colony", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    await seedFrame(store, "review");

    const created = await hive(store, socket, ["quest", "create", "review 1255", "--colony", "reviews"]);
    const id = created.stdout.match(/quest-created\t(\S+)\t/)![1]!;

    // start: spawn the frame's swarm into the quest. --no-wait keeps the held
    // shell hermetic (no readiness probe on a non-agent shell).
    const started = await hive(store, socket, ["quest", "start", id, "--frame", "review", "--no-wait"], CLAUDE_ENV);
    const sm = started.stdout.match(/quest-started\t(\S+)\t(\S*)\t(\d+)/);
    assert.ok(sm, `quest start prints quest-started line: ${started.stdout}`);
    const [, startedId, swarmId, beeCountStr] = sm!;
    assert.equal(startedId, id);
    assert.ok(swarmId && swarmId.length > 0, "a swarm id is reported");
    assert.equal(Number(beeCountStr), 1, "the one-caste frame spawned exactly one bee");

    // ws-<id> session exists with the frame's bee window linked in.
    const session = `ws-${id}`;
    assert.equal(await hasSessionLocal(session), true, "ws-<id> session exists");

    // Every spawned bee record carries questId=<id> and colony=reviews.
    const bees = await listBeeRecords(store);
    const questBees = bees.filter((b) => b.questId === id);
    assert.equal(questBees.length, 1, "exactly one bee is stamped with the quest id");
    for (const b of questBees) {
      assert.equal(b.colony, "reviews", "quest bee carries the quest's colony");
      assert.equal(b.workspaceId, id, "quest bee carries the quest's workspace");
      assert.equal(b.caste, "reviewer", "the frame caste is recorded");
    }
    const bee = questBees[0]!;

    // The bee's window is actually linked into ws-<id> (real link, not just a record).
    const beeWindow = (await tmux(["display-message", "-p", "-t", `=${String(bee.tmuxTarget)}:`, "#{window_id}"], { reject: false })).stdout.trim();
    assert.ok(beeWindow.length > 0, "bee window id resolved");
    assert.ok((await sessionWindowIds(session)).includes(beeWindow), "the bee's window is linked into ws-<id>");

    // The workspace record gained the bee membership (so restore brings it back).
    const ws = await readWs(store, id);
    const members = ws.members as Array<{ kind: string; beeId?: string }>;
    assert.ok(members.some((m) => m.kind === "bee" && m.beeId === bee.id), "bee membership persisted on the workspace");

    // `hive list quest:<id> --json` resolves EXACTLY those bees (the derived tag lit up).
    const rows = JSON.parse((await hive(store, socket, ["list", `quest:${id}`, "--json"])).stdout) as Array<{ name: string }>;
    assert.deepEqual(rows.map((r) => r.name).sort(), questBees.map((b) => String(b.name)).sort(), "quest:<id> resolves exactly the quest's bees");

    // The quest flipped to active with a non-empty swarmIds and an activatedAt.
    const quest = await readQuestRecord(store, id);
    assert.equal(quest.status, "active", "quest is active after start");
    assert.ok(Array.isArray(quest.swarmIds) && (quest.swarmIds as string[]).length >= 1, "swarmIds non-empty after start");
    assert.equal((quest.swarmIds as string[])[0], swarmId, "the spawned swarm id is recorded on the quest");
    assert.ok(typeof quest.activatedAt === "string" && (quest.activatedAt as string).length > 0, "activatedAt stamped");
  });
});

test("Q1c: quest create without --colony auto-creates a colony from the title slug", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const out = await hive(store, socket, ["quest", "create", "Migrate the Auth Flow!"]);
    const id = out.stdout.match(/quest-created\t(\S+)\t(\S+)\t/)![1]!;
    const quest = await readQuestRecord(store, id);
    assert.equal(quest.colony, "migrate-the-auth-flow", "colony auto-derived from a slug of the title");

    // The auto-created colony exists.
    const colony = JSON.parse(await readFile(join(store, "colonies", "migrate-the-auth-flow.json"), "utf8")) as { name: string };
    assert.equal(colony.name, "migrate-the-auth-flow");
  });
});

test("quest start --flow fails loud as later-increment work", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const created = await hive(store, socket, ["quest", "create", "later 1"]);
    const id = created.stdout.match(/quest-created\t(\S+)\t/)![1]!;

    // --flow on start is deferred to a later increment.
    let flowErr: (Error & { stderr?: string }) | undefined;
    try {
      await hive(store, socket, ["quest", "start", id, "--flow", "x"]);
    } catch (e) {
      flowErr = e as Error & { stderr?: string };
    }
    assert.ok(flowErr, "quest start --flow exits non-zero");
    assert.match(`${flowErr?.stderr ?? ""}${flowErr?.message ?? ""}`, /later increment/, "start --flow explains it is deferred");
  });
});

// A seal on disk under HIVE_STORE_ROOT/seals/<bee>/, matching seal.ts's stamp
// scheme (sealedAt with `:`/`.` mapped to `-`) so quest done's copyBeeSeals
// files it. Driving `hive seal` would need a live agent pane; writing the file
// directly is the documented test shortcut (testPlan E).
async function seedSeal(store: string, beeName: string, summary = "done"): Promise<string> {
  const dir = join(store, "seals", beeName);
  await mkdir(dir, { recursive: true });
  const sealedAt = new Date().toISOString();
  const stamp = sealedAt.replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}.json`);
  await writeFile(file, `${JSON.stringify({ beeName, sealedAt, status: "done", summary }, null, 2)}\n`);
  return `${stamp}.json`;
}

test("Q2: quest done files seals + snapshot, kills + archives the bee, hides it from list/clean, completes the quest", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    await seedFrame(store, "review");
    const created = await hive(store, socket, ["quest", "create", "finish me", "--colony", "reviews"]);
    const id = created.stdout.match(/quest-created\t(\S+)\t/)![1]!;
    await hive(store, socket, ["quest", "start", id, "--frame", "review", "--no-wait"], CLAUDE_ENV);

    const bees = (await listBeeRecords(store)).filter((b) => b.questId === id);
    assert.equal(bees.length, 1, "one quest bee spawned");
    const bee = bees[0]!;
    const beeName = String(bee.name);

    // Seed a seal on disk so done files a COPY of it.
    const sealFile = await seedSeal(store, beeName);

    const done = await hive(store, socket, ["quest", "done", id]);
    assert.match(done.stdout, /quest-done\t/, `quest done prints quest-done line: ${done.stdout}`);

    // Filed COPY exists under quests/<id>/seals/<bee>/<stamp>.json AND the
    // original sealsRoot copy still exists (never moved).
    const filedSeal = await readFile(join(store, "quests", id, "seals", beeName, sealFile), "utf8");
    assert.match(filedSeal, /"summary": "done"/, "the seal was filed as a copy");
    const origSeal = await readFile(join(store, "seals", beeName, sealFile), "utf8");
    assert.match(origSeal, /"summary": "done"/, "the original seal is left intact (copy, not move)");

    // quests/<id>/workspace.json exists with a members snapshot.
    const filedWs = JSON.parse(await readFile(join(store, "quests", id, "workspace.json"), "utf8")) as { name: string; members: unknown[] };
    assert.equal(filedWs.name, id, "filed workspace snapshot is the quest's ws");

    // The bee's tmux session is gone (transactional kill happened).
    assert.equal(await hasSessionLocal(String(bee.tmuxTarget)), false, "the bee session was killed");

    // The bee's SessionRecord still exists with status archived (in-place index).
    const afterBee = (await listBeeRecords(store)).find((b) => b.name === beeName);
    assert.ok(afterBee, "the bee record still exists (filed in place, not deleted)");
    assert.equal(afterBee!.status, "archived", "the bee record is marked archived");

    // `hive list` (default) hides the archived bee; --archived re-includes it.
    const listDefault = JSON.parse((await hive(store, socket, ["list", "--json"])).stdout) as Array<{ name: string }>;
    assert.ok(!listDefault.some((r) => r.name === beeName), "default list hides the archived bee");
    const listArchived = JSON.parse((await hive(store, socket, ["list", "--archived", "--json"])).stdout) as Array<{ name: string; beeState: string }>;
    assert.ok(listArchived.some((r) => r.name === beeName && r.beeState === "archived"), "--archived re-includes the archived bee with state archived");

    // `hive clean --dead --dry-run` does NOT list the archived bee (skipped).
    const cleanDry = await hive(store, socket, ["clean", "--dead", "--dry-run"]);
    assert.ok(!cleanDry.stdout.includes(beeName), "clean --dead does not offer the archived bee");

    // quest.json status done + completedAt; ws session closed; WorkspaceRecord.archived true.
    const quest = await readQuestRecord(store, id);
    assert.equal(quest.status, "done", "quest is done");
    assert.ok(typeof quest.completedAt === "string" && (quest.completedAt as string).length > 0, "completedAt stamped");
    assert.equal(await hasSessionLocal(`ws-${id}`), false, "the quest workspace session was closed");
    const ws = await readWs(store, id);
    assert.equal(ws.archived, true, "the workspace record is archived");

    // quest inspect STILL surfaces the archived bee (questId direct read).
    const inspected = JSON.parse((await hive(store, socket, ["quest", "inspect", id, "--json"])).stdout) as { bees: Array<{ name: string; status: string }> };
    assert.ok(inspected.bees.some((b) => b.name === beeName && b.status === "archived"), "quest inspect still shows the filed bee");

    // Default SELECTOR resolution (resolveSelector, used by list <sel>/send/view)
    // excludes the archived bee: `list quest:<id>` returns nothing because the
    // selector path filters status==="archived" (Chokepoint 3), even though the
    // bee is still in the store and inspect (questId direct read) shows it.
    const selRows = JSON.parse((await hive(store, socket, ["list", `quest:${id}`, "--json"])).stdout) as Array<{ name: string }>;
    assert.ok(!selRows.some((r) => r.name === beeName), "the archived bee is excluded from default selector resolution");
  });
});

test("Q2 --keep-bees: bee stays alive (status running, in default list), seals filed, quest done", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    await seedFrame(store, "review");
    const created = await hive(store, socket, ["quest", "create", "keep them", "--colony", "reviews"]);
    const id = created.stdout.match(/quest-created\t(\S+)\t/)![1]!;
    await hive(store, socket, ["quest", "start", id, "--frame", "review", "--no-wait"], CLAUDE_ENV);

    const bee = (await listBeeRecords(store)).find((b) => b.questId === id)!;
    const beeName = String(bee.name);
    await seedSeal(store, beeName);

    await hive(store, socket, ["quest", "done", id, "--keep-bees"]);

    // The bee session is STILL alive and the record is STILL running (never hide a live bee).
    assert.equal(await hasSessionLocal(String(bee.tmuxTarget)), true, "the bee session stays alive with --keep-bees");
    const afterBee = (await listBeeRecords(store)).find((b) => b.name === beeName)!;
    assert.equal(afterBee.status, "running", "a kept bee is NOT marked archived");

    // It STILL appears in the default list.
    const listDefault = JSON.parse((await hive(store, socket, ["list", "--json"])).stdout) as Array<{ name: string }>;
    assert.ok(listDefault.some((r) => r.name === beeName), "a kept bee is still visible in the default list");

    // Seals were STILL filed; quest is done.
    await readFile(join(store, "quests", id, "workspace.json"), "utf8");
    const filedSeals = await readdir(join(store, "quests", id, "seals", beeName)).catch(() => []);
    assert.ok(filedSeals.length > 0, "seals are filed even with --keep-bees");
    const quest = await readQuestRecord(store, id);
    assert.equal(quest.status, "done", "quest is done even with --keep-bees");
  });
});

test("Q2: quest archive after done flips the quest to archived + archivedAt", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const created = await hive(store, socket, ["quest", "create", "archive me", "--colony", "reviews"]);
    const id = created.stdout.match(/quest-created\t(\S+)\t/)![1]!;
    await hive(store, socket, ["quest", "done", id]);

    // archive flips done → archived.
    await hive(store, socket, ["quest", "archive", id]);
    const quest = await readQuestRecord(store, id);
    assert.equal(quest.status, "archived", "quest is archived");
    assert.ok(typeof quest.archivedAt === "string" && (quest.archivedAt as string).length > 0, "archivedAt stamped");

    // Default quest list hides it; --status archived surfaces it.
    const listDefault = JSON.parse((await hive(store, socket, ["quest", "list", "--json"])).stdout) as Array<{ id: string }>;
    assert.ok(!listDefault.some((q) => q.id === id), "archived quest hidden from default quest list");
    const listArchived = JSON.parse((await hive(store, socket, ["quest", "list", "--status", "archived", "--json"])).stdout) as Array<{ id: string }>;
    assert.ok(listArchived.some((q) => q.id === id), "--status archived surfaces the archived quest");
  });
});

test("Q2: quest archive before done is rejected; quest done is idempotent-guarded", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const created = await hive(store, socket, ["quest", "create", "guard me", "--colony", "reviews"]);
    const id = created.stdout.match(/quest-created\t(\S+)\t/)![1]!;

    // archive before done is rejected.
    let archiveErr: (Error & { stderr?: string }) | undefined;
    try {
      await hive(store, socket, ["quest", "archive", id]);
    } catch (e) {
      archiveErr = e as Error & { stderr?: string };
    }
    assert.ok(archiveErr, "archive before done exits non-zero");

    // done, then a second done is rejected as already-done.
    await hive(store, socket, ["quest", "done", id]);
    let doneErr: (Error & { stderr?: string }) | undefined;
    try {
      await hive(store, socket, ["quest", "done", id]);
    } catch (e) {
      doneErr = e as Error & { stderr?: string };
    }
    assert.ok(doneErr, "a second quest done exits non-zero (already done)");
    assert.match(`${doneErr?.stderr ?? ""}${doneErr?.message ?? ""}`, /already done/, "explains it is already done");
  });
});

test("Q2 --close-linear: succeeds and prints the deferred-Linear note on stderr", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const created = await hive(store, socket, ["quest", "create", "linear later", "--colony", "reviews"]);
    const id = created.stdout.match(/quest-created\t(\S+)\t/)![1]!;
    const done = await hive(store, socket, ["quest", "done", id, "--close-linear"]);
    assert.match(done.stderr, /Linear write-back lands in a later increment/, "prints the deferred Linear note");
    const quest = await readQuestRecord(store, id);
    assert.equal(quest.status, "done", "quest done with --close-linear still completes");
  });
});

test("quest list and inspect surface the quest and roll up its bees", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    await seedFrame(store, "review");
    const created = await hive(store, socket, ["quest", "create", "list me", "--colony", "reviews"]);
    const id = created.stdout.match(/quest-created\t(\S+)\t/)![1]!;
    await hive(store, socket, ["quest", "start", id, "--frame", "review", "--no-wait"], CLAUDE_ENV);

    // list --json includes the active quest.
    const quests = JSON.parse((await hive(store, socket, ["quest", "list", "--json"])).stdout) as Array<{ id: string; status: string }>;
    assert.ok(quests.some((q) => q.id === id && q.status === "active"), "quest list --json shows the active quest");

    // list --status filters.
    const open = JSON.parse((await hive(store, socket, ["quest", "list", "--status", "open", "--json"])).stdout) as Array<{ id: string }>;
    assert.ok(!open.some((q) => q.id === id), "an active quest is excluded by --status open");

    // inspect --json dumps the record + the rolled-up bee summary.
    const inspected = JSON.parse((await hive(store, socket, ["quest", "inspect", id, "--json"])).stdout) as { id: string; bees: Array<{ name: string; caste?: string }> };
    assert.equal(inspected.id, id);
    assert.equal(inspected.bees.length, 1, "inspect rolls up the quest's one bee");
    assert.equal(inspected.bees[0]!.caste, "reviewer");
  });
});
