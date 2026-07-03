import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" });

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

// Drop a SessionRecord directly into the store so we don't need a live tmux
// to test the buz CLI surface. Mirrors how the seal CLI is tested.
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

test("hive buz send --sender CL.cc9 --tier queue stores in queue/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    await seedSession(dir, "CL.cc9");
    const { stdout } = await hive(dir, "buz", "send", "CO.aaa", "--sender", "CL.cc9", "--tier", "queue", "-p", "hello");
    assert.match(stdout, /buz\.send\tCO\.aaa\t/);
    const queue = await readdir(join(dir, "buz", "CO.aaa", "queue"));
    assert.equal(queue.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz send --sender and --sender-human are mutually exclusive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    await seedSession(dir, "CL.cc9");
    const stderr = await hiveExpectFail(dir, "buz", "send", "CO.aaa", "--sender", "CL.cc9", "--sender-human", "tormod", "--tier", "queue", "-p", "x");
    assert.match(stderr, /mutually exclusive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz send requires exactly one of --sender or --sender-human", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    const stderr = await hiveExpectFail(dir, "buz", "send", "CO.aaa", "--tier", "queue", "-p", "x");
    assert.match(stderr, /exactly one of --sender/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz send --sender-human routes outbox via _external/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    const { stdout } = await hive(dir, "buz", "send", "CO.aaa", "--sender-human", "Tormod Haugland", "--tier", "passive", "-p", "hi");
    assert.match(stdout, /buz\.send\tCO\.aaa/);
    const ext = await readdir(join(dir, "buz", "_external", "tormod_haugland", "outbox"));
    assert.equal(ext.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz send rejects an unknown tier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    const stderr = await hiveExpectFail(dir, "buz", "send", "CO.aaa", "--sender-human", "t", "--tier", "shout", "-p", "x");
    assert.match(stderr, /unknown tier|--tier must be one of/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz inbox lists messages with --limit and --from filters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    await hive(dir, "buz", "send", "CO.aaa", "--sender-human", "alice", "--tier", "passive", "-p", "from alice 1");
    await new Promise((r) => setTimeout(r, 5));
    await hive(dir, "buz", "send", "CO.aaa", "--sender-human", "bob", "--tier", "passive", "-p", "from bob");
    const { stdout: all } = await hive(dir, "buz", "inbox", "CO.aaa");
    assert.equal(all.trim().split("\n").length, 2);
    const { stdout: limited } = await hive(dir, "buz", "inbox", "CO.aaa", "--limit", "1");
    assert.equal(limited.trim().split("\n").length, 1);
    const { stdout: filtered } = await hive(dir, "buz", "inbox", "CO.aaa", "--from", "human:bob");
    assert.match(filtered, /human:bob/);
    assert.equal(filtered.trim().split("\n").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz outbox shows the sender's outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    await seedSession(dir, "CL.cc9");
    await hive(dir, "buz", "send", "CO.aaa", "--sender", "CL.cc9", "--tier", "queue", "-p", "x");
    const { stdout } = await hive(dir, "buz", "outbox", "CL.cc9");
    assert.match(stdout, /buz\.outbox\tCL\.cc9/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz outbox resolves display-name bees to their id-backed outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    await seedSession(dir, "chief-display", { id: "CL.chief" });
    await hive(dir, "buz", "send", "CO.aaa", "--sender", "chief-display", "--tier", "queue", "-p", "x");
    const { stdout } = await hive(dir, "buz", "outbox", "chief-display");
    assert.match(stdout, /buz\.outbox\tchief-display\t/);
    assert.match(stdout, /CL\.chief/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz read --consume moves the message from inbox/ to read/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    const send = await hive(dir, "buz", "send", "CO.aaa", "--sender-human", "tormod", "--tier", "passive", "-p", "x");
    // stdout: buz.send\tCO.aaa\t<id>\t...
    const id = send.stdout.split("\t")[2]!;
    const { stdout } = await hive(dir, "buz", "read", id, "--consume", "--bee", "CO.aaa");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.id, id);
    assert.equal(parsed.consumed, true);
    const inbox = await readdir(join(dir, "buz", "CO.aaa", "inbox"));
    assert.equal(inbox.length, 0);
    const read = await readdir(join(dir, "buz", "CO.aaa", "read"));
    assert.equal(read.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz read finds a message without --bee", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    await seedSession(dir, "CO.bbb");
    await seedSession(dir, "CO.zzz");
    const send = await hive(dir, "buz", "send", "CO.zzz", "--sender-human", "tormod", "--tier", "passive", "-p", "x");
    const id = send.stdout.split("\t")[2]!;
    const { stdout } = await hive(dir, "buz", "read", id);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.id, id);
    assert.equal(parsed.bee, "CO.zzz");
    assert.equal(parsed.mailbox, "inbox");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz read --consume reports consumed:false when the message is not in inbox/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    await seedSession(dir, "CL.cc9");
    // tier queue lands in queue/, not inbox/, so --consume has nothing to move.
    const send = await hive(dir, "buz", "send", "CO.aaa", "--sender", "CL.cc9", "--tier", "queue", "-p", "x");
    const id = send.stdout.split("\t")[2]!;
    const { stdout, stderr } = await hive(dir, "buz", "read", id, "--consume", "--bee", "CO.aaa");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.consumed, false);
    assert.match(stderr, /--consume only applies to inbox/);
    const queue = await readdir(join(dir, "buz", "CO.aaa", "queue"));
    assert.equal(queue.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz send rejects a bare -p with no value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    const stderr = await hiveExpectFail(dir, "buz", "send", "CO.aaa", "--sender-human", "t", "--tier", "passive", "-p");
    assert.match(stderr, /-p requires a value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz purge --all clears every mailbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    await hive(dir, "buz", "send", "CO.aaa", "--sender-human", "tormod", "--tier", "passive", "-p", "x");
    const { stdout } = await hive(dir, "buz", "purge", "CO.aaa", "--all");
    assert.match(stdout, /buz\.purge\tCO\.aaa\tall\t1/);
    const inbox = await readdir(join(dir, "buz", "CO.aaa", "inbox")).catch(() => []);
    assert.equal(inbox.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz purge rejects multiple scope flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    const stderr = await hiveExpectFail(dir, "buz", "purge", "CO.aaa", "--all", "--read");
    assert.match(stderr, /mutually exclusive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive buz config --accept persists buzAccept on the SessionRecord", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    await seedSession(dir, "CO.aaa");
    const { stdout } = await hive(dir, "buz", "config", "CO.aaa", "--accept", "interrupt,queue");
    assert.match(stdout, /buz\.config\tCO\.aaa\tinterrupt,queue/);
    const inspect = await hive(dir, "buz", "config", "CO.aaa");
    assert.match(inspect.stdout, /buz\.config\tCO\.aaa\tinterrupt,queue/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completion: --tier value only completes under the buz command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    const buzTier = await hive(dir, "__complete", "hive", "buz", "send", "CO.aaa", "--tier", "");
    const tierLines = buzTier.stdout.trim().split("\n").filter(Boolean);
    assert.deepEqual(tierLines.sort(), ["interrupt", "passive", "queue"]);

    // --tier under any other verb falls back to top-level flag completion
    // (or empty), NOT the buz-tier enum.
    const sendTier = await hive(dir, "__complete", "hive", "send", "CO.aaa", "--tier", "");
    const sendLines = sendTier.stdout.trim().split("\n").filter(Boolean);
    assert.ok(!sendLines.includes("interrupt"), "non-buz --tier must not complete to buz tiers");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completion: buz subcommands and --accept values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-cli-"));
  try {
    const subs = await hive(dir, "__complete", "hive", "buz", "");
    const subLines = subs.stdout.trim().split("\n").filter(Boolean);
    for (const sub of ["send", "inbox", "outbox", "queue", "read", "purge", "config"]) {
      assert.ok(subLines.includes(sub), `expected buz subcommand: ${sub}`);
    }
    const accept = await hive(dir, "__complete", "hive", "buz", "config", "CO.aaa", "--accept", "");
    const acceptLines = accept.stdout.trim().split("\n").filter(Boolean);
    assert.ok(acceptLines.includes("queue,passive"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
