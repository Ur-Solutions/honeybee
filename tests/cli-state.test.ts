import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { BeeViewListV1, BeeViewV1 } from "../src/view/types.js";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

type SeedRecord = {
  name: string;
  agent?: string;
  colony?: string;
  swarmId?: string;
  status?: "running" | "dead" | "done" | "kill_failed";
  contract?: Record<string, unknown>;
  lastObservedState?: string;
  lastObservedStateAt?: string;
};

async function seed(dir: string, record: SeedRecord): Promise<void> {
  const sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const now = "2026-06-17T00:00:00.000Z";
  const full = {
    name: record.name,
    agent: record.agent ?? "claude",
    cwd: "/tmp",
    command: "claude --foo",
    tmuxTarget: record.name,
    id: record.name,
    createdAt: now,
    updatedAt: now,
    status: record.status ?? "running",
    ...(record.colony ? { colony: record.colony } : {}),
    ...(record.swarmId ? { swarmId: record.swarmId } : {}),
    ...(record.contract ? { contract: record.contract } : {}),
    ...(record.lastObservedState ? { lastObservedState: record.lastObservedState } : {}),
    ...(record.lastObservedStateAt ? { lastObservedStateAt: record.lastObservedStateAt } : {}),
  };
  await writeFile(join(sessionsDir, `${record.name}.json`), `${JSON.stringify(full, null, 2)}\n`);
}

async function seedSeal(dir: string, name: string, seal: Record<string, unknown> = {}): Promise<void> {
  const sealDir = join(dir, "seals", name);
  await mkdir(sealDir, { recursive: true });
  const record = {
    beeName: name,
    sealedAt: "2026-06-17T01:00:00.000Z",
    status: "done",
    summary: "finished the fixture task",
    type: "implementation",
    ...seal,
  };
  await writeFile(join(sealDir, "2026-06-17T01-00-00-000Z-0000-abc123.json"), `${JSON.stringify(record, null, 2)}\n`);
}

async function withStore(fn: (store: string) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "hive-cli-state-"));
  try {
    await fn(store);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
}

// Fixture names are prefixed so they can never collide with real live tmux
// sessions on the machine running the tests.
const CRASHY = "svw-crashy";
const STOPPED = "svw-stopped";
const FILED = "svw-filed";
const SEALED = "svw-sealed";

test("hive state ls --json emits the BeeViewListV1 shape verbatim", async () => {
  await withStore(async (store) => {
    await seed(store, { name: CRASHY, status: "running" });
    await seed(store, { name: STOPPED, status: "dead" });

    const { stdout } = await hive(store, "state", "ls", "--json");
    const list = JSON.parse(stdout) as BeeViewListV1;
    assert.equal(list.schemaVersion, 1);
    assert.equal(list.node, "local");
    assert.ok(Array.isArray(list.unreachableNodes));
    assert.ok(typeof list.generatedAt === "string" && Number.isFinite(Date.parse(list.generatedAt)));
    assert.deepEqual(list.bees.map((b) => b.bee.name).sort(), [CRASHY, STOPPED]);

    const crashy = list.bees.find((b) => b.bee.name === CRASHY)!;
    assert.equal(crashy.schemaVersion, 1);
    assert.equal(crashy.displayState, "crashed"); // status running, no live runtime
    assert.match(crashy.displayStateReason, /^crashed — /);
    assert.equal(crashy.bee.lifecycle, "active");
    assert.equal(crashy.latestRuntime.state, "exited");
    assert.equal(crashy.latestRuntime.exitClass, "crashed");
    assert.equal(crashy.latestRuntime.evidence.grade, "observer");
    assert.deepEqual(crashy.openRequests, []);
    assert.equal(crashy.currentTurn, undefined); // reserved in schemaVersion 1
    assert.equal(crashy.compatibilityFields.beeState, "crashed");
    assert.equal(crashy.compatibilityFields.sessionStatus, "running");
    assert.ok(crashy.observationFreshness.sources.some((s) => s.source === "node-probe"));

    const stopped = list.bees.find((b) => b.bee.name === STOPPED)!;
    assert.equal(stopped.displayState, "offline");
    assert.equal(stopped.latestRuntime.exitClass, "stopped");
  });
});

test("hive state ls hides retired bees by default; --done and --state retired reveal them", async () => {
  await withStore(async (store) => {
    await seed(store, { name: CRASHY, status: "running" });
    await seed(store, { name: FILED, status: "done" });

    const defaults = JSON.parse((await hive(store, "state", "ls", "--json")).stdout) as BeeViewListV1;
    assert.deepEqual(defaults.bees.map((b) => b.bee.name), [CRASHY]);

    const withDone = JSON.parse((await hive(store, "state", "ls", "--done", "--json")).stdout) as BeeViewListV1;
    assert.deepEqual(new Set(withDone.bees.map((b) => b.bee.name)), new Set([CRASHY, FILED]));
    const filed = withDone.bees.find((b) => b.bee.name === FILED)!;
    assert.equal(filed.displayState, "retired");
    assert.equal(filed.bee.lifecycle, "retired");

    const retiredOnly = JSON.parse((await hive(store, "state", "ls", "--state", "retired", "--json")).stdout) as BeeViewListV1;
    assert.deepEqual(retiredOnly.bees.map((b) => b.bee.name), [FILED]);
  });
});

test("hive state ls filters: --state, --colony, and a positional selector compose", async () => {
  await withStore(async (store) => {
    await seed(store, { name: CRASHY, status: "running", colony: "frontend" });
    await seed(store, { name: STOPPED, status: "dead", colony: "backend" });

    const crashed = JSON.parse((await hive(store, "state", "ls", "--state", "crashed", "--json")).stdout) as BeeViewListV1;
    assert.deepEqual(crashed.bees.map((b) => b.bee.name), [CRASHY]);

    const backend = JSON.parse((await hive(store, "state", "ls", "--colony", "backend", "--json")).stdout) as BeeViewListV1;
    assert.deepEqual(backend.bees.map((b) => b.bee.name), [STOPPED]);

    const bySelector = JSON.parse((await hive(store, "state", "ls", "colony:frontend", "--json")).stdout) as BeeViewListV1;
    assert.deepEqual(bySelector.bees.map((b) => b.bee.name), [CRASHY]);

    await assert.rejects(hive(store, "state", "ls", "--state", "bogus"), /Unknown display state/);
  });
});

test("a current-incarnation seal surfaces as latestContractResult with contract correlation", async () => {
  await withStore(async (store) => {
    await seed(store, { name: SEALED, status: "dead", contract: { completion: "seal", taskId: "T1" } });
    await seedSeal(store, SEALED); // keyless seal against a keyed contract

    const list = JSON.parse((await hive(store, "state", "ls", "--json")).stdout) as BeeViewListV1;
    const sealed = list.bees.find((b) => b.bee.name === SEALED)!;
    assert.equal(sealed.compatibilityFields.beeState, "done"); // sealed before exit
    assert.equal(sealed.displayState, "offline"); // completion never changes display state
    const contract = sealed.latestContractResult!;
    assert.equal(contract.verdict, "success");
    assert.equal(contract.sealStatus, "done");
    assert.equal(contract.sealedAt, "2026-06-17T01:00:00.000Z");
    assert.equal(contract.matchesContract, false); // keyless seal never satisfies a keyed contract
    assert.equal(contract.evidence.grade, "structured");
    assert.equal(contract.evidence.source, "seal");
    assert.equal(sealed.inboxSummary.hasUnretiredResult, true);
  });
});

test("hive state explain --json emits a single BeeViewV1 verbatim", async () => {
  await withStore(async (store) => {
    await seed(store, { name: CRASHY, status: "running", lastObservedState: "active", lastObservedStateAt: "2026-06-17T00:05:00.000Z" });

    const { stdout } = await hive(store, "state", "explain", CRASHY, "--json");
    const view = JSON.parse(stdout) as BeeViewV1;
    assert.equal(view.schemaVersion, 1);
    assert.equal(view.bee.name, CRASHY);
    assert.equal(view.displayState, "crashed");
    // Crashed while last observed active → interrupted, legacy grade.
    assert.equal(view.latestTurnResult!.outcome, "interrupted");
    assert.equal(view.latestTurnResult!.evidence.grade, "legacy");
    const daemonSource = view.observationFreshness.sources.find((s) => s.source === "daemon-observation")!;
    assert.equal(daemonSource.status, "stale");
    assert.match(daemonSource.caveat ?? "", /sweep stamp/);
  });
});

test("human output: state ls is TSV-shaped and state explain names the rule and grades", async () => {
  await withStore(async (store) => {
    await seed(store, { name: CRASHY, status: "running" });
    await seed(store, { name: STOPPED, status: "dead" });

    const ls = await hive(store, "state", "ls");
    const lines = ls.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    // Sorted by display-state precedence: crashed before offline.
    const first = lines[0]!.split("\t");
    assert.equal(first[0], "crashed");
    assert.equal(first[1], CRASHY);
    assert.equal(first[2], CRASHY);
    assert.equal(first[3], "-"); // REQS
    assert.equal(first[5], "live"); // FRESH
    const second = lines[1]!.split("\t");
    assert.equal(second[0], "offline");

    const explain = await hive(store, "state", "explain", CRASHY);
    assert.match(explain.stdout, /display: crashed — the latest generation exited without stop intent/);
    assert.match(explain.stdout, /Runtime/);
    assert.match(explain.stdout, /\[observer: node-probe/);
    assert.match(explain.stdout, /lifecycle: active/);
    assert.match(explain.stdout, /schema v1/);
  });
});

test("hive state without a subcommand prints usage", async () => {
  await withStore(async (store) => {
    await assert.rejects(hive(store, "state"), /Usage:\s*[\s\S]*state ls/);
  });
});
