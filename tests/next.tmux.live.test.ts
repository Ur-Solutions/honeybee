import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { newSession, setTmuxSocket, setUserOptions, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

// Integration coverage for `hive next` (PRD §9, Tier 1) against a PRIVATE
// throwaway tmux socket so it never touches the user's server; skips cleanly
// when tmux is unavailable. We drive the real CLI as a subprocess with both
// HIVE_STORE_ROOT (store records → ordering timestamps) and HIVE_TMUX_SOCKET
// (the child's tmux calls hit our private socket). TMUX is set so the inside-
// tmux branch emits switch-client.

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function seed(
  storeDir: string,
  name: string,
  overrides: { lastObservedStateAt?: string; updatedAt?: string } = {},
): Promise<void> {
  const sessionsDir = join(storeDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const now = "2026-06-17T00:00:00.000Z";
  const record = {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "sleep 30",
    tmuxTarget: name,
    id: name,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
    status: "running" as const,
    ...(overrides.lastObservedStateAt ? { lastObservedStateAt: overrides.lastObservedStateAt } : {}),
  };
  await writeFile(join(sessionsDir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function hiveNext(
  store: string,
  socket: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "next", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: store,
      HIVE_TMUX_SOCKET: socket,
      HIVE_NO_KEYCHAIN: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      // Force the inside-tmux branch so `next --print` emits switch-client.
      TMUX: `${socket},0,0`,
    },
  });
}

test("hive next --print emits switch-client for the right next/prev bee", { skip: !tmuxAvailable() }, async () => {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-next-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-next-store-"));
  setTmuxSocket(socket);

  const older = `hive-next-older-${process.pid}`; // waiting, oldest
  const newer = `hive-next-newer-${process.pid}`; // waiting, newer
  const finished = `hive-next-done-${process.pid}`; // done (after the waiting group)
  const worker = `hive-next-worker-${process.pid}`; // working → never in the set; "current"

  try {
    // Seed store records first so ordering timestamps exist. older is the
    // longest-waiting; newer waits less; finished is done; worker is working.
    await seed(store, older, { lastObservedStateAt: "2026-06-17T00:01:00.000Z" });
    await seed(store, newer, { lastObservedStateAt: "2026-06-17T00:05:00.000Z" });
    await seed(store, finished, { lastObservedStateAt: "2026-06-17T00:02:00.000Z" });
    await seed(store, worker, { lastObservedStateAt: "2026-06-17T00:06:00.000Z" });

    // Create the sessions; worker LAST so `tmux display-message` (no attached
    // client) reports it as "current" — and it is NOT in the attention set, so
    // `next` enters at the front of the ordered queue and `--prev` at the back.
    await newSession(older, "/tmp", { command: "sh", args: ["-c", "sleep 30"] });
    await newSession(newer, "/tmp", { command: "sh", args: ["-c", "sleep 30"] });
    await newSession(finished, "/tmp", { command: "sh", args: ["-c", "sleep 30"] });
    await newSession(worker, "/tmp", { command: "sh", args: ["-c", "sleep 30"] });

    await setUserOptions(older, { "@hive_state": "waiting" });
    await setUserOptions(newer, { "@hive_state": "waiting" });
    await setUserOptions(finished, { "@hive_state": "done" });
    await setUserOptions(worker, { "@hive_state": "working" });

    // Ordered attention queue: older (waiting, oldest) → newer (waiting) →
    // finished (done). Current = worker (not in the set) → next enters at front.
    const fwd = await hiveNext(store, socket, ["--print"]);
    assert.match(fwd.stdout, /switch-client/, "emits switch-client inside tmux");
    assert.match(fwd.stdout, new RegExp(`-t =${older}\\b`), "next lands on the oldest waiting bee");

    // --prev enters at the back of the queue (the done bee).
    const back = await hiveNext(store, socket, ["--prev", "--print"]);
    assert.match(back.stdout, /switch-client/);
    assert.match(back.stdout, new RegExp(`-t =${finished}\\b`), "prev lands on the last queue entry");

    // --state waiting narrows the set to the two waiting bees; front is still
    // the oldest waiting one, and the done bee is excluded.
    const onlyWaiting = await hiveNext(store, socket, ["--state", "waiting", "--print"]);
    assert.match(onlyWaiting.stdout, new RegExp(`-t =${older}\\b`));
    assert.doesNotMatch(onlyWaiting.stdout, new RegExp(`=${finished}\\b`), "done bee excluded by --state waiting");
  } finally {
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("hive next prints 'no bees need attention' when the set is empty", { skip: !tmuxAvailable() }, async () => {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-next-empty-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-next-empty-store-"));
  setTmuxSocket(socket);

  const worker = `hive-next-empty-worker-${process.pid}`;
  try {
    await seed(store, worker);
    await newSession(worker, "/tmp", { command: "sh", args: ["-c", "sleep 30"] });
    // Only a working bee exists → the attention set is empty.
    await setUserOptions(worker, { "@hive_state": "working" });

    const out = await hiveNext(store, socket, ["--print"]);
    assert.match(out.stdout, /no bees need attention/);
    assert.doesNotMatch(out.stdout, /switch-client/, "nothing to switch to");
  } finally {
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});
