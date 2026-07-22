import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  __testOnlyOwnedProcessGroups,
  attachSessionPlumbing,
  parseProcessRows,
  spawnSessionChild,
} from "../src/hsr/sessionBase.js";

const fixture = fileURLToPath(new URL("./fixtures/hsr-detached-grandchild.mjs", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function killPidOrGroup(pid: number | undefined, group = false): void {
  if (!pid) return;
  try {
    process.kill(group ? -pid : pid, "SIGKILL");
  } catch {
    // already gone
  }
}

test("parseProcessRows accepts a topology + birth census and rejects malformed rows", () => {
  assert.deepEqual(parseProcessRows(" 12  1  12 Tue Jul 22 12:01:02 2026\ninvalid\n"), [
    { pid: 12, ppid: 1, pgid: 12, startedAt: "Tue Jul 22 12:01:02 2026" },
  ]);
});

test("stop reaps a setsid grandchild without touching an untracked sibling group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-tree-"));
  const pidFile = join(dir, "grandchild.pid");
  let child: ChildProcess | undefined;
  let grandchildPid: number | undefined;
  const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  sibling.unref();
  try {
    child = await spawnSessionChild(process.execPath, [fixture, pidFile, "wait"], {
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
    });
    const plumbing = attachSessionPlumbing("session-base-stop", child);
    grandchildPid = await waitFor(() => readPid(pidFile), "grandchild pid");
    assert.notEqual(grandchildPid, child.pid, "grandchild has its own process group");

    await plumbing.stop();
    await waitFor(() => (alive(grandchildPid!) ? undefined : true), "grandchild exit");
    assert.equal(alive(sibling.pid as number), true, "untracked sibling remains alive");
  } finally {
    killPidOrGroup(child?.pid);
    killPidOrGroup(grandchildPid, true);
    killPidOrGroup(sibling.pid, true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a natural harness exit reaps a previously observed setsid grandchild", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-tree-natural-"));
  const pidFile = join(dir, "grandchild.pid");
  let child: ChildProcess | undefined;
  let grandchildPid: number | undefined;
  try {
    child = await spawnSessionChild(process.execPath, [fixture, pidFile, "natural-delayed"], {
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
    });
    const plumbing = attachSessionPlumbing("session-base-natural", child);
    // Real providers emit tool_use just before spawning the subprocess. The
    // fixture creates its setsid grandchild 50ms later; the one delayed event
    // sample must retain ownership before the harness exits naturally.
    plumbing.ingestEvent({ type: "tool_use", ts: Date.now(), tool: "exec" });
    child.stdin?.write("spawn\n");
    grandchildPid = await waitFor(() => readPid(pidFile), "grandchild pid");
    await waitFor(
      () => (__testOnlyOwnedProcessGroups(child!).includes(grandchildPid!) ? true : undefined),
      "delayed tool-use ownership sample",
    );
    child.stdin?.write("exit\n");
    await plumbing.exitedPromise;
    await waitFor(() => (alive(grandchildPid!) ? undefined : true), "grandchild exit");
  } finally {
    killPidOrGroup(child?.pid);
    killPidOrGroup(grandchildPid, true);
    await rm(dir, { recursive: true, force: true });
  }
});
