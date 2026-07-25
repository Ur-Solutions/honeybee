import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb", HIVE_BEE: "", TMUX: "", TMUX_PANE: "" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

async function hiveExpectFail(dir: string, ...args: string[]): Promise<string> {
  try {
    await hive(dir, ...args);
    throw new Error("expected command to fail");
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    return err.stderr ?? "";
  }
}

async function seedSession(dir: string, name: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const record = {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: `tg-${name}`,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "dead",
    id: name,
    ...overrides,
  };
  await writeFile(join(sessionsDir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

test("task add/ls/show round-trip with --json shapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-task-cli-"));
  try {
    const { stdout: addOut } = await hive(
      dir, "task", "add", "CL.aaa",
      "--sender-human", "tormod",
      "-p", "make the button red",
      "--body", "It is currently blue.",
      "--context-json", '{"kind":"text"}',
      "--quest", "q-1",
      "--json",
    );
    const added = JSON.parse(addOut);
    assert.match(added.id, /^task_/);
    assert.equal(added.list, "bee:CL.aaa");
    assert.equal(added.title, "make the button red");
    assert.equal(added.body, "It is currently blue.");
    assert.deepEqual(added.context, { kind: "text" });
    assert.deepEqual(added.origin, { kind: "user", sender: "tormod" });
    assert.equal(added.auto, true, "user-origin defaults auto:true");
    assert.equal(added.status, "pending");
    assert.equal(added.questId, "q-1");
    assert.equal(added.claimedBy, null);
    assert.equal(added.buzMessageId, null);

    const { stdout: lsOut } = await hive(dir, "task", "ls", "CL.aaa", "--json");
    const ls = JSON.parse(lsOut);
    assert.equal(ls.list, "bee:CL.aaa");
    assert.equal(ls.tasks.length, 1);
    assert.equal(ls.tasks[0].id, added.id);

    const { stdout: showOut } = await hive(dir, "task", "show", added.id);
    assert.equal(JSON.parse(showOut).id, added.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task add --sender <bee> derives self vs bee origin (self never auto)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-task-cli-"));
  try {
    await seedSession(dir, "CL.aaa");
    await seedSession(dir, "CL.bbb");

    // Own list → self, auto:false even with --auto (warned on stderr).
    const { stdout: selfOut, stderr: selfErr } = await hive(
      dir, "task", "add", "CL.aaa", "--sender", "CL.aaa", "-p", "my own plan step", "--auto", "--json",
    );
    const selfTask = JSON.parse(selfOut);
    assert.deepEqual(selfTask.origin, { kind: "self", sender: "CL.aaa" });
    assert.equal(selfTask.auto, false);
    assert.match(selfErr, /self-origin/);

    // Another bee's list → bee, auto:false.
    const { stdout: beeOut } = await hive(
      dir, "task", "add", "CL.aaa", "--sender", "CL.bbb", "-p", "please fix", "--json",
    );
    const beeTask = JSON.parse(beeOut);
    assert.deepEqual(beeTask.origin, { kind: "bee", sender: "CL.bbb" });
    assert.equal(beeTask.auto, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task start/done/block transitions + edit auto rules via CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-task-cli-"));
  try {
    const { stdout } = await hive(dir, "task", "add", "shared:review", "--sender-human", "t", "-p", "review pr", "--json");
    const task = JSON.parse(stdout);

    const { stdout: started } = await hive(dir, "task", "start", task.id, "--json");
    assert.equal(JSON.parse(started).status, "in-progress");

    const { stdout: blocked } = await hive(dir, "task", "block", task.id, "-p", "needs design", "--json");
    const blockedTask = JSON.parse(blocked);
    assert.equal(blockedTask.status, "blocked");
    assert.equal(blockedTask.blockedReason, "needs design");

    const stderr = await hiveExpectFail(dir, "task", "done", task.id);
    assert.match(stderr, /requires one of/);

    const { stdout: restarted } = await hive(dir, "task", "start", task.id, "--json");
    assert.equal(JSON.parse(restarted).status, "in-progress");
    const { stdout: done } = await hive(dir, "task", "done", task.id, "--json");
    assert.equal(JSON.parse(done).status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task claim requires a bee claimant and claims in order; null when exhausted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-task-cli-"));
  try {
    await seedSession(dir, "CL.aaa");
    await hive(dir, "task", "add", "shared:review", "--sender-human", "t", "-p", "one");

    const stderr = await hiveExpectFail(dir, "task", "claim", "shared:review", "--sender-human", "t");
    assert.match(stderr, /must be a bee/);

    const { stdout } = await hive(dir, "task", "claim", "shared:review", "--sender", "CL.aaa", "--json");
    const claimed = JSON.parse(stdout);
    assert.equal(claimed.claimedBy, "CL.aaa");
    assert.equal(claimed.status, "in-progress");

    const { stdout: empty } = await hive(dir, "task", "claim", "shared:review", "--sender", "CL.aaa", "--json");
    assert.equal(JSON.parse(empty), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task mv reorders via --before/--after", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-task-cli-"));
  try {
    const ids: string[] = [];
    for (const title of ["a", "b", "c"]) {
      const { stdout } = await hive(dir, "task", "add", "CL.aaa", "--sender-human", "t", "-p", title, "--json");
      ids.push(JSON.parse(stdout).id);
    }
    await hive(dir, "task", "mv", ids[2]!, "--before", ids[0]!);
    const { stdout } = await hive(dir, "task", "ls", "CL.aaa", "--json");
    assert.deepEqual(JSON.parse(stdout).tasks.map((t: { title: string }) => t.title), ["c", "a", "b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task supply prints status, mutates config, --on clears breaker state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-task-cli-"));
  try {
    await seedSession(dir, "CL.aaa", { taskSupply: { on: true, limit: 5, feeds: 4, paused: true } });

    const { stdout: status } = await hive(dir, "task", "supply", "CL.aaa", "--json");
    assert.deepEqual(JSON.parse(status), { bee: "CL.aaa", on: true, limit: 5, feeds: 4, paused: true });

    const { stdout: off } = await hive(dir, "task", "supply", "CL.aaa", "--off", "--json");
    const offState = JSON.parse(off);
    assert.equal(offState.on, false);
    assert.equal(offState.feeds, 4, "--off keeps the counter");
    assert.equal(offState.paused, true, "--off keeps the tripped breaker");

    const { stdout: on } = await hive(dir, "task", "supply", "CL.aaa", "--on", "--limit", "3", "--json");
    assert.deepEqual(JSON.parse(on), { bee: "CL.aaa", on: true, limit: 3, feeds: 0, paused: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task lists enumerates lists with counts (--json)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-task-cli-"));
  try {
    await hive(dir, "task", "add", "CL.aaa", "--sender-human", "t", "-p", "a");
    await hive(dir, "task", "add", "shared:review", "--sender-human", "t", "-p", "b");
    const { stdout } = await hive(dir, "task", "lists", "--json");
    const lists = JSON.parse(stdout);
    assert.deepEqual(lists.map((l: { id: string }) => l.id), ["bee:CL.aaa", "shared:review"]);
    assert.equal(lists[0].counts.pending, 1);
    assert.equal(lists[0].total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task add without any sender and no ambient bee fails with guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-task-cli-"));
  try {
    const stderr = await hiveExpectFail(dir, "task", "add", "CL.aaa", "-p", "x");
    assert.match(stderr, /--sender <bee> or --sender-human/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
