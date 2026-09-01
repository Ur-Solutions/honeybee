/**
 * Cell substrate in the REAL daemon (WP5 driver wired per spec 05 + the WP6
 * §5 exit-path verbs `cell.capture` / `cell.remove`): a real daemon process
 * + real CellDriver (composed over its own HsrDriver) + the cell stub agent
 * (`@sh` directive: commands run INSIDE the spawned child, in the cell) over
 * temp dirs. Covers:
 *  - spawn {substrate:'cell'} → bee row (substrate=cell, cwd=space dir) +
 *    seed ledger at spawn → provisioning on first start → the agent's turn
 *    commits inside the cell
 *  - cell.capture: landed onto a throwaway branch (origin working tree
 *    untouched, no transient refs left) → nothing_to_capture → conflict
 *    report → target_checked_out refusal → idempotent replay (deduped, same
 *    report); typed errors (bee_not_found, invalid_request for a non-cell bee)
 *  - cell.remove: runtime_refused while live → refused-dirty (report, nothing
 *    changed) → forced (deleted + delete command; bee gone; replay keeps the
 *    cell status, never the command status) → absent path
 *  - daemon SIGKILL → restart re-adopts a cell bee (cellOf re-hydrated from
 *    cell.json; the next runtime provisions by replay, cwd = the same space)
 *  - the RPC result shapes vs the Apiary-expected fixture (type + runtime keys)
 *  - spawn param validation; async provisioning failure lands on the B5
 *    budget/flag surface after admission (never a wedged command)
 *
 * SAFETY: temp dirs only (daemon data dir, cells root, fixture origins). No
 * ~/.hive, no live daemon, no user repos, stub agents only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive } from "../../driver-hsr/src/psutil.ts";
import { commitOn, fingerprintOrigin, g, makeOrigin, type FixtureOrigin } from "../../driver-cell/tests/helpers.ts";
import { CELL_SPACE_DIRECTORY, readLedger } from "../../driver-cell/src/index.ts";
import {
  RPC_ERROR_CODES,
  RPC_VERBS,
  type CellCaptureParams,
  type CellCaptureResult,
  type CellDirtyReport,
  type CellRemoveParams,
  type CellRemoveResult,
  type CommandsResult,
  type HealthResult,
  type MailboxResult,
  type SendRpcResult,
  type SpawnResult,
  type ViewResult,
} from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import {
  CAPTURE_RESULT_KEYS,
  CELL_VERB_ERROR_CODES,
  DIRTY_REPORT_KEYS,
  REMOVE_RESULT_KEYS,
  type HiveCellCaptureParams,
  type HiveCellCaptureResult,
  type HiveCellDirtyReport,
  type HiveCellRemoveParams,
  type HiveCellRemoveResult,
} from "./fixtures/apiary-cell-shapes.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The cell stub: WP3 stub protocol + `@sh <cmd>` run inside the child's cwd (the cell). */
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

// ---------------------------------------------------------------------------
// Shape drift guard — compile-time. If honeybee's protocol shapes and the
// Apiary fixture ever disagree, `npm run v2:check` fails right here.
// ---------------------------------------------------------------------------

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const _captureResultMatches: Equals<CellCaptureResult, HiveCellCaptureResult> = true;
const _removeResultMatches: Equals<CellRemoveResult, HiveCellRemoveResult> = true;
const _dirtyReportMatches: Equals<CellDirtyReport, HiveCellDirtyReport> = true;
// Apiary always sends the key; honeybee accepts it optional — Apiary's params must be accepted verbatim.
const _captureParamsAccepted: HiveCellCaptureParams extends CellCaptureParams ? true : false = true;
const _removeParamsAccepted: HiveCellRemoveParams extends CellRemoveParams ? true : false = true;
void [_captureResultMatches, _removeResultMatches, _dirtyReportMatches, _captureParamsAccepted, _removeParamsAccepted];

// ---------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------

interface CellRig {
  dir: string;
  cellsRoot: string;
  origin: FixtureOrigin;
  cleanup: () => void;
}

/** A daemon data dir with the cell stub registered as agent `cellstub`, plus a fixture origin. */
function makeCellRig(extra: Parameters<typeof makeDaemonDir>[0] = {}): CellRig {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-cells-"));
  const origin = makeOrigin(root);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot, { recursive: true });
  const { dir, cleanup } = makeDaemonDir({
    cells: { root: cellsRoot },
    ...extra,
    agents: {
      cellstub: {
        command: process.execPath,
        args: [CELL_AGENT_PATH],
        adapter: "stub",
        env: {
          // The stub's `@sh git commit` needs an identity; keep the user's
          // global git config out of the child like the driver does.
          GIT_AUTHOR_NAME: "cell-bee",
          GIT_AUTHOR_EMAIL: "bee@hive.invalid",
          GIT_COMMITTER_NAME: "cell-bee",
          GIT_COMMITTER_EMAIL: "bee@hive.invalid",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      },
      ...(extra.agents ?? {}),
    },
  });
  return {
    dir,
    cellsRoot,
    origin,
    cleanup: () => {
      cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function spawnCell(
  client: RpcClient,
  name: string,
  originRepo: string,
  extra: Record<string, unknown> = {},
): Promise<{ beeId: string; view: ViewResult }> {
  const spawned = await client.request<SpawnResult>("spawn", {
    name,
    agent: "cellstub",
    substrate: "cell",
    cell: { originRepo, ...((extra.cell as object | undefined) ?? {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "cell")),
  });
  const view = await waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    return v.view.runtimeState === "idle" ? v : null;
  }, `${name} idle`, 15_000);
  return { beeId: spawned.beeId, view };
}

async function waitDelivered(client: RpcClient, beeId: string, messageId: number, what: string): Promise<void> {
  await waitFor(async () => {
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    return messages.find((x) => x.id === messageId)?.deliveredAt != null;
  }, what, 15_000);
}

/** Send `@sh <cmd>` to the cell stub and wait for the turn to finish. */
async function shInCell(client: RpcClient, beeId: string, cmd: string): Promise<void> {
  const before = (await client.request<ViewResult>("view", { beeId })).view;
  const sent = await client.request<SendRpcResult>("send", { beeId, body: `@sh ${cmd}` });
  await waitDelivered(client, beeId, sent.messageId, `delivered: ${cmd}`);
  await waitFor(async () => {
    const v = (await client.request<ViewResult>("view", { beeId })).view;
    return v.runtimeState === "idle" && (v.lastOutputAt ?? 0) > (before.lastOutputAt ?? 0);
  }, `turn ended: ${cmd}`, 15_000);
}

async function stopAndWait(client: RpcClient, beeId: string): Promise<void> {
  await client.request("stop", { beeId });
  await waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === "stopped";
  }, "stopped");
}

function assertKeys(actual: object, expected: readonly string[], what: string): void {
  assert.deepEqual(Object.keys(actual).filter((k) => k !== "deduped").sort(), [...expected].sort(), `${what} keys`);
}

const rpcCode = (code: string) => (err: Error & { code?: string }) => err.code === code;

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("cells.0: the verb list + error list carry the cell verbs Apiary calls, and only closed-list codes", () => {
  assert.ok(RPC_VERBS.includes("cell.capture"));
  assert.ok(RPC_VERBS.includes("cell.remove"));
  for (const code of CELL_VERB_ERROR_CODES) assert.ok((RPC_ERROR_CODES as readonly string[]).includes(code), code);
});

test("cells.1: spawn {substrate:cell} → row + seed ledger → provisioned on start → agent works INSIDE the cell → capture lands onto a throwaway branch (origin untouched otherwise)", async () => {
  const rig = makeCellRig();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const originBefore = fingerprintOrigin(rig.origin.repo);

    // spawn: the row is the mirror truth Apiary gates on.
    const spawned = await client.request<SpawnResult>("spawn", {
      name: "worker",
      agent: "cellstub",
      cwd: "/ignored",
      substrate: "cell",
      cell: { originRepo: rig.origin.repo },
    });
    const early = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.equal(early.bee?.substrate, "cell");
    const spaceDir = early.bee?.cwd as string;
    assert.ok(CELL_SPACE_DIRECTORY.test(basename(spaceDir)), `cwd is the space dir: ${spaceDir}`);
    assert.ok(spaceDir.startsWith(rig.cellsRoot), "space lives under cells.root");
    const wrapperDir = dirname(spaceDir);
    const ledgerPath = join(wrapperDir, "box", "cell.json");
    // Seed ledger written IN the spawn call (durable allocation truth before any start).
    const seed = readLedger(ledgerPath);
    assert.ok(seed, "seed ledger exists at spawn");
    assert.equal(seed.beeId, spawned.beeId);
    assert.equal(seed.origin, rig.origin.repo);
    assert.equal(seed.sha, rig.origin.sha, "sha defaults to origin HEAD");
    assert.equal(basename(wrapperDir).startsWith("worker-"), true, "wrapper is <name>-<hash>");

    // First start provisions against the ledger; the runtime is idle in the cell.
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return v.view.runtimeState === "idle";
    }, "cell bee idle", 15_000);
    assert.ok(existsSync(join(spaceDir, ".git")), "space has a .git");
    assert.ok(existsSync(join(spaceDir, "README.md")), "working tree materialized");
    assert.equal(g(spaceDir, ["rev-parse", "HEAD"]), rig.origin.sha, "checked out at the origin sha");
    const provisioned = readLedger(ledgerPath);
    assert.ok(provisioned && Object.values(provisioned.operations).some((op) => op.completedAt != null), "ledger marks provisioning complete");

    // The agent's turn runs INSIDE the cell: a file + commit made by the child.
    const beeId = spawned.beeId;
    await shInCell(client, beeId, "printf 'from the bee\\n' > work.txt && git add -A && git commit -q -m 'bee work'");
    const cellHead = g(spaceDir, ["rev-parse", "HEAD"]);
    assert.notEqual(cellHead, rig.origin.sha, "the cell advanced");
    assert.ok(existsSync(join(spaceDir, "work.txt")), "the file was written in the cell, not elsewhere");
    assert.equal(existsSync(join(rig.origin.repo, "work.txt")), false, "…and never in the origin working tree");

    // cell.capture onto a throwaway branch → landed (branch created).
    const key1 = "cap-1";
    const landed = await client.request<CellCaptureResult>("cell.capture", {
      beeId,
      targetBranch: "throwaway/landing",
      mode: "merge",
      idempotencyKey: key1,
    });
    assertKeys(landed, CAPTURE_RESULT_KEYS, "capture result");
    assert.equal(landed.status, "landed");
    assert.equal(landed.mode, "merge");
    assert.equal(landed.targetBranch, "throwaway/landing");
    assert.equal(landed.cellHead, cellHead);
    assert.equal(landed.baseTarget, null, "branch created");
    assert.equal(landed.resultSha, cellHead);
    assert.deepEqual(landed.conflicts, []);
    assert.equal(landed.reason, null);
    assert.equal(landed.deduped, undefined);
    assert.equal(g(rig.origin.repo, ["rev-parse", "refs/heads/throwaway/landing"]), cellHead, "origin branch advanced");
    // Zero artifacts beyond the one branch: same HEAD/branch/status, no transient refs.
    const originAfter = fingerprintOrigin(rig.origin.repo);
    assert.equal(originAfter.head, originBefore.head);
    assert.equal(originAfter.branch, originBefore.branch);
    assert.equal(originAfter.status, originBefore.status);
    assert.equal(originAfter.refs.includes("refs/hive/"), false, "no transient refs left behind");
    assert.equal(
      originAfter.refs.split("\n").length,
      originBefore.refs.split("\n").length + 1,
      "exactly one new ref (the branch asked for)",
    );

    // Replay with the same key: the ORIGINAL report, marked deduped — not a second land.
    const replay = await client.request<CellCaptureResult>("cell.capture", {
      beeId,
      targetBranch: "throwaway/landing",
      mode: "merge",
      idempotencyKey: key1,
    });
    assert.equal(replay.deduped, true);
    assert.equal(replay.status, "landed");
    assert.equal(replay.resultSha, cellHead);
    assert.equal((replay as { status: string }).status, "landed", "own status survives replay");

    // Nothing to capture: the branch already contains the cell head.
    const nothing = await client.request<CellCaptureResult>("cell.capture", {
      beeId,
      targetBranch: "throwaway/landing",
      mode: "rebase",
      idempotencyKey: "cap-2",
    });
    assert.equal(nothing.status, "nothing_to_capture");
    assert.equal(nothing.baseTarget, cellHead);

    // Refusal: landing onto the branch the origin has checked out (main).
    const refused = await client.request<CellCaptureResult>("cell.capture", {
      beeId,
      targetBranch: "main",
      mode: "merge",
      idempotencyKey: "cap-3",
    });
    assert.equal(refused.status, "refused");
    assert.equal(refused.reason, "target_checked_out");
    assert.equal(refused.cellHead, cellHead);
    assert.equal(g(rig.origin.repo, ["rev-parse", "main"]), rig.origin.sha, "main untouched");

    // Conflict: a branch in the origin that edits work.txt differently.
    g(rig.origin.repo, ["branch", "throwaway/other", rig.origin.sha]);
    g(rig.origin.repo, ["checkout", "-q", "throwaway/other"]);
    commitOn(rig.origin.repo, "work.txt", "from the origin\n", "origin work");
    g(rig.origin.repo, ["checkout", "-q", "main"]);
    const otherTip = g(rig.origin.repo, ["rev-parse", "throwaway/other"]);
    const fpBeforeConflict = fingerprintOrigin(rig.origin.repo);
    const conflict = await client.request<CellCaptureResult>("cell.capture", {
      beeId,
      targetBranch: "throwaway/other",
      mode: "merge",
      idempotencyKey: "cap-4",
    });
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.conflicts, ["work.txt"]);
    assert.equal(conflict.baseTarget, otherTip);
    assert.equal(conflict.resultSha, null);
    assert.deepEqual(fingerprintOrigin(rig.origin.repo), fpBeforeConflict, "failed land: origin bit-identical");
    // …and the rebase flavor conflicts the same way, leaving nothing behind.
    const conflict2 = await client.request<CellCaptureResult>("cell.capture", {
      beeId,
      targetBranch: "throwaway/other",
      mode: "rebase",
      idempotencyKey: "cap-5",
    });
    assert.equal(conflict2.status, "conflict");
    assert.equal(conflict2.mode, "rebase");
    assert.deepEqual(fingerprintOrigin(rig.origin.repo), fpBeforeConflict, "failed rebase land: origin bit-identical");

    // Typed errors.
    await assert.rejects(
      () => client.request("cell.capture", { beeId: "nope", targetBranch: "x", mode: "merge" }),
      rpcCode("bee_not_found"),
    );
    await assert.rejects(
      () => client.request("cell.capture", { beeId, targetBranch: "x", mode: "squash" }),
      rpcCode("invalid_request"),
    );
    const hsrBee = await client.request<SpawnResult>("spawn", { name: "plain", agent: "stub", cwd: "/tmp" });
    await assert.rejects(
      () => client.request("cell.capture", { beeId: hsrBee.beeId, targetBranch: "x", mode: "merge" }),
      rpcCode("invalid_request"),
    );
    await assert.rejects(
      () => client.request("cell.remove", { beeId: hsrBee.beeId }),
      rpcCode("invalid_request"),
    );

    // The hsr bee kept its own routing: cwd as given, substrate hsr, boots fine.
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: hsrBee.beeId })).view.runtimeState === "idle", "hsr bee idle");
    const hsrView = await client.request<ViewResult>("view", { beeId: hsrBee.beeId });
    assert.equal(hsrView.bee?.substrate, "hsr");
    assert.equal(hsrView.bee?.cwd, "/tmp");

    const health = await client.request<HealthResult>("health");
    assert.equal(health.i1Violations, 0);
    const cmds = await client.request<CommandsResult>("commands", { beeId });
    assert.ok(cmds.commands.every((c) => c.status !== "failed"), "no failed commands");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    rig.cleanup();
  }
});

test("cells.2: cell.remove — runtime_refused while live; refused-dirty leaves everything; forced deletes cell + enqueues delete; replay keeps its own status; absent path", async () => {
  const rig = makeCellRig();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const { beeId, view } = await spawnCell(client, "dirty-bee", rig.origin.repo);
    const spaceDir = view.bee?.cwd as string;
    const wrapperDir = dirname(spaceDir);

    // Live runtime → typed runtime_refused; nothing removed.
    await assert.rejects(() => client.request("cell.remove", { beeId, idempotencyKey: "rm-0" }), rpcCode("runtime_refused"));
    assert.ok(existsSync(spaceDir));

    // Dirty the cell from inside (uncommitted change), stop, then remove → refused with the report.
    await shInCell(client, beeId, "printf 'wip\\n' >> README.md");
    await stopAndWait(client, beeId);
    const refused = await client.request<CellRemoveResult>("cell.remove", { beeId, idempotencyKey: "rm-1" });
    assertKeys(refused, REMOVE_RESULT_KEYS, "remove result");
    assert.equal(refused.status, "refused");
    assert.equal(refused.forced, false);
    assert.equal(refused.commandId, null);
    assert.ok(refused.report);
    assertKeys(refused.report, DIRTY_REPORT_KEYS, "dirty report");
    assert.deepEqual(refused.report, { dirty: true, uncommitted: true, unpushed: false, originUnknown: false });
    assert.ok(existsSync(spaceDir), "refused: cell still there");
    assert.equal((await client.request<ViewResult>("view", { beeId })).bee?.id, beeId, "refused: bee still there");
    // Replay of the refused key: same answer, deduped.
    const refusedAgain = await client.request<CellRemoveResult>("cell.remove", { beeId, idempotencyKey: "rm-1" });
    assert.equal(refusedAgain.deduped, true);
    assert.equal(refusedAgain.status, "refused");

    // Forced: cell gone, delete enqueued, bee gone once it runs.
    const forced = await client.request<CellRemoveResult>("cell.remove", { beeId, force: true, idempotencyKey: "rm-2" });
    assertKeys(forced, REMOVE_RESULT_KEYS, "forced remove result");
    assert.equal(forced.status, "deleted");
    assert.equal(forced.forced, true, "forced through a dirty guard");
    assert.equal(forced.report?.dirty, true);
    assert.ok(typeof forced.commandId === "number" && forced.commandId > 0, "delete command enqueued");
    assert.equal(existsSync(wrapperDir), false, "wrapper dir removed");
    await waitFor(async () => {
      try {
        await client.request<ViewResult>("view", { beeId });
        const v = await client.request<ViewResult>("view", { beeId });
        return v.bee == null ? true : null;
      } catch {
        return true;
      }
    }, "bee deleted by the executor");
    // Replay after the delete settled: the recorded cell result (status
    // 'deleted'), marked deduped — NOT the command's status, and no error
    // even though the bee row is gone.
    const forcedReplay = await client.request<CellRemoveResult>("cell.remove", { beeId, force: true, idempotencyKey: "rm-2" });
    assert.equal(forcedReplay.deduped, true);
    assert.equal(forcedReplay.status, "deleted");
    assert.equal(forcedReplay.commandId, forced.commandId);

    // Absent: a cell bee whose cell dir is already gone → absent + delete enqueued.
    const second = await spawnCell(client, "vanishing", rig.origin.repo);
    await stopAndWait(client, second.beeId);
    rmSync(dirname(second.view.bee?.cwd as string), { recursive: true, force: true });
    const absent = await client.request<CellRemoveResult>("cell.remove", { beeId: second.beeId, idempotencyKey: "rm-3" });
    assert.equal(absent.status, "absent");
    assert.equal(absent.forced, false);
    assert.equal(absent.report, null);
    assert.ok(typeof absent.commandId === "number");

    // Clean cell (committed + captured) removes without force; unpushed commits refuse.
    const third = await spawnCell(client, "clean-bee", rig.origin.repo);
    await shInCell(client, third.beeId, "printf 'x\\n' > x.txt && git add -A && git commit -q -m x");
    await stopAndWait(client, third.beeId);
    const uncaptured = await client.request<CellRemoveResult>("cell.remove", { beeId: third.beeId, idempotencyKey: "rm-4" });
    assert.equal(uncaptured.status, "refused");
    assert.deepEqual(uncaptured.report, { dirty: true, uncommitted: false, unpushed: true, originUnknown: false });
    const cap = await client.request<CellCaptureResult>("cell.capture", {
      beeId: third.beeId,
      targetBranch: "throwaway/clean",
      mode: "merge",
      idempotencyKey: "cap-clean",
    });
    assert.equal(cap.status, "landed");
    const clean = await client.request<CellRemoveResult>("cell.remove", { beeId: third.beeId, idempotencyKey: "rm-5" });
    assert.equal(clean.status, "deleted");
    assert.equal(clean.forced, false);
    assert.deepEqual(clean.report, { dirty: false, uncommitted: false, unpushed: false, originUnknown: false });

    // Unknown bee.
    await assert.rejects(() => client.request("cell.remove", { beeId: "nope" }), rpcCode("bee_not_found"));
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    rig.cleanup();
  }
});

test("cells.3: daemon SIGKILL → restart re-adopts a cell bee; the next generation provisions by replay into the SAME space", async () => {
  // The WP3 stub (agent `stub`) with survive-stdin-close + a long turn so the
  // kill lands mid-turn — run as a CELL bee (any harness can live in a cell).
  const rig = makeCellRig({
    stubEnv: { STUB_SURVIVE_STDIN_CLOSE: "1", STUB_TURN_MS: "60000" },
    bootHangTimeoutMs: 8000,
  });
  let daemon: DaemonHandle | null = null;
  const agentPids: number[] = [];
  try {
    daemon = await startDaemon(rig.dir);
    let client = await daemon.client();
    const { beeId, view } = await spawnCell(client, "survivor", rig.origin.repo, { agent: "stub" });
    const spaceDir = view.bee?.cwd as string;
    const sent = await client.request<SendRpcResult>("send", { beeId, body: "long task" });
    await waitDelivered(client, beeId, sent.messageId, "delivered to gen 1");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "running", "mid-turn");
    const agentPid = (await client.request<ViewResult>("view", { beeId })).runtime?.pid as number;
    agentPids.push(agentPid);
    assert.ok(agentPid > 0);

    client.close();
    await daemon.kill();
    assert.ok(pidAlive(agentPid), "cell agent survived the daemon SIGKILL");

    daemon = await startDaemon(rig.dir);
    client = await daemon.client();
    const health = await client.request<HealthResult>("health");
    assert.equal(health.lastBoot?.adopted, 1, "cell runtime re-adopted at boot (routed to the cell driver)");
    assert.equal(health.lastBoot?.stoppedByReconcile, 0);
    const after = await client.request<ViewResult>("view", { beeId });
    assert.equal(after.view.generation, 1);
    assert.equal(after.bee?.substrate, "cell");
    assert.equal(after.bee?.cwd, spaceDir);

    // Mail rotates the degraded survivor out; gen 2 starts INSIDE the same
    // cell — provisioning replays from cell.json (no re-clone, no new dir).
    const ledgerBefore = readFileSync(join(dirname(spaceDir), "box", "cell.json"), "utf8");
    const sent2 = await client.request<SendRpcResult>("send", { beeId, body: "post-restart" });
    await waitDelivered(client, beeId, sent2.messageId, "post-restart delivery");
    const rt2 = (await client.request<ViewResult>("view", { beeId })).runtime;
    if (typeof rt2?.pid === "number" && rt2.pid > 0) agentPids.push(rt2.pid);
    assert.equal(rt2?.generation, 2);
    assert.equal(pidAlive(agentPid), false, "old survivor stopped by exact identity");
    assert.equal(readFileSync(join(dirname(spaceDir), "box", "cell.json"), "utf8"), ledgerBefore, "replayed provisioning: ledger unchanged");
    assert.equal((await client.request<ViewResult>("view", { beeId })).bee?.cwd, spaceDir, "same space");
    const cmds = await client.request<CommandsResult>("commands", { beeId });
    assert.ok(cmds.commands.every((c) => c.status !== "failed"), "zero failed commands across the restart");

    // The re-hydrated driver still serves the exit path for this bee.
    await client.request("stop", { beeId });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", "stopped", 15_000);
    const cap = await client.request<CellCaptureResult>("cell.capture", { beeId, targetBranch: "throwaway/x", mode: "merge" });
    assert.equal(cap.status, "landed", "capture served after restart (cellOf re-hydrated from cell.json)");
    assert.equal(cap.baseTarget, null, "new branch");
    assert.equal(cap.resultSha, rig.origin.sha, "cell head == origin sha (no work) → branch created at the base");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    for (const pid of agentPids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* no group */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    rig.cleanup();
  }
});

test("cells.4: spawn param validation (typed invalid_request), explicit sha/warm/sandbox land in the seed ledger, and a provisioning failure is a bounded spawn_failed — never a wedged command", async () => {
  const rig = makeCellRig({ retry: { maxAttempts: 2, backoffBaseMs: 30 } });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const bad = async (params: Record<string, unknown>) =>
      assert.rejects(() => client.request("spawn", { name: "b", agent: "cellstub", cwd: "/tmp", ...params }), rpcCode("invalid_request"));
    await bad({ substrate: "nope" });
    await bad({ substrate: "cell" });
    await bad({ substrate: "cell", cell: { originRepo: "relative/path" } });
    await bad({ substrate: "cell", cell: { originRepo: join(rig.dir, "not-a-repo") } });
    await bad({ substrate: "cell", cell: { originRepo: rig.origin.repo, sha: "deadbeef" } });
    await bad({ substrate: "cell", cell: { originRepo: rig.origin.repo, warm: "yes" } });
    await bad({ substrate: "cell", cell: { originRepo: rig.origin.repo, sandbox: "no" } });
    // Nothing leaked into the cells root from the refusals.
    assert.equal(existsSync(rig.cellsRoot) ? (await import("node:fs")).readdirSync(rig.cellsRoot).length : 0, 0);

    // Explicit sha (an older commit) + warm list + sandbox off → in the seed ledger; provisions at that sha.
    const older = rig.origin.sha;
    commitOn(rig.origin.repo, "later.txt", "later\n", "later commit");
    const spawned = await client.request<SpawnResult>("spawn", {
      name: "pinned",
      agent: "cellstub",
      cwd: "/x",
      substrate: "cell",
      cell: { originRepo: rig.origin.repo, sha: older, warm: ["node_modules"], sandbox: false },
    });
    const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    const ledger = readLedger(join(dirname(v.bee?.cwd as string), "box", "cell.json"));
    assert.equal(ledger?.sha, older);
    assert.deepEqual(ledger?.warm, ["node_modules"]);
    assert.equal(ledger?.sandbox, false);
    // This path performs a real worktree provision plus HSR startup. Keep the
    // assertion bounded, but allow for contention from the full daemon suite.
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: spawned.beeId })).view.runtimeState === "idle", "pinned idle", 30_000);
    assert.equal(g(v.bee?.cwd as string, ["rev-parse", "HEAD"]), older);
    assert.equal(existsSync(join(v.bee?.cwd as string, "later.txt")), false, "materialized at the pinned sha");

    // Provisioning failure: the origin vanishes between spawn and start.
    const doomedOrigin = makeOrigin(rig.dir, "doomed-origin");
    const doomed = await client.request<SpawnResult>("spawn", {
      name: "doomed",
      agent: "cellstub",
      cwd: "/x",
      substrate: "cell",
      cell: { originRepo: doomedOrigin.repo },
    });
    // The spawn command may already be claimed by the time we get here; make
    // the origin disappear either way — a replayed provisioning fails the same.
    rmSync(doomedOrigin.repo, { recursive: true, force: true });
    const outcome = await waitFor(async () => {
      const cmds = await client.request<CommandsResult>("commands", { beeId: doomed.beeId });
      const spawnCmd = cmds.commands.find((c) => c.verb === "spawn");
      const view = await client.request<ViewResult>("view", { beeId: doomed.beeId });
      if (view.view.flags.includes("spawn_failed") && view.view.runtimeState === "stopped") {
        return { spawnCmd, view, provisioningFailed: true as const };
      }
      // The race the other way: provisioning won before the rm — then the
      // bee is simply idle in a cell whose origin is gone (a valid state).
      if (view.view.runtimeState === "idle") return { spawnCmd, view, provisioningFailed: false as const };
      return null;
    }, "doomed spawn settles one way or the other", 20_000);
    assert.equal(outcome.spawnCmd?.status, "done", "admission command is not the async provisioning verdict");
    if (outcome.provisioningFailed) {
      assert.ok(outcome.view.view.flags.includes("spawn_failed"), "spawn_failed flag visible");
      assert.equal(outcome.view.bee?.spawnFailures, 2, "bounded by the retry budget");
    }
    const health = await client.request<HealthResult>("health");
    assert.equal(health.tickErrors, 0, "a driver start failure is never a tick error");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    rig.cleanup();
  }
});
