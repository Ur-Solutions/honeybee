import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { captureProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import { hasSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";
import { terminateProcessGroup } from "../src/substrates/local-tmux.js";
import type { ProcessBirthFingerprint } from "../src/hsr/processIdentity.js";

const execFileAsync = promisify(execFile);

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("demote aborts before HSR spawn when pane kill cannot confirm the old process group", { skip: !tmuxAvailable() }, async () => {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-demote-strict-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-demote-strict-store-"));
  const bee = "CO.demote-unconfirmed";
  const target = "CO-demote-unconfirmed";
  let launcherPgid: number | undefined;
  let cleanupFingerprint: ProcessBirthFingerprint | undefined;
  setTmuxSocket(socket);
  try {
    // --now sends C-c before strict teardown. Keep this exact fixture group
    // alive through that interrupt so the missing record fingerprint (not a
    // scheduling race with sleep exiting) deterministically fails closed.
    await tmux(["new-session", "-d", "-s", target, "trap '' INT HUP TERM; while :; do sleep 1; done"]);
    const pane = await tmux(["display-message", "-p", "-t", `=${target}:`, "#{pane_pid}"]);
    launcherPgid = Number(pane.stdout.trim());
    assert.ok(Number.isSafeInteger(launcherPgid) && launcherPgid > 0);
    cleanupFingerprint = await captureProcessBirthFingerprint(launcherPgid);
    assert.ok(cleanupFingerprint);
    assert.equal(cleanupFingerprint.pgid, launcherPgid);
    await mkdir(join(store, "sessions"), { recursive: true });
    await writeFile(join(store, "sessions", `${bee}.json`), `${JSON.stringify({
      name: bee,
      agent: "codex",
      requestedAgent: "codex",
      cwd: store,
      launchArgv: ["codex"],
      command: "codex --dangerously-bypass-approvals-and-sandbox",
      tmuxTarget: target,
      providerSessionId: "sess-demote",
      launcherPgid,
      id: bee,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      status: "running",
    }, null, 2)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, ["tests/cli-entry.mjs", "demote", bee, "--now"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HIVE_STORE_ROOT: store,
          HIVE_TMUX_SOCKET: socket,
          HIVE_NO_KEYCHAIN: "1",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      }),
      /exact cleanup unconfirmed.*(?:missing|mismatched) birth fingerprint/,
    );

    const persisted = JSON.parse(await readFile(join(store, "sessions", `${bee}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.substrate, undefined, "record remains a tmux incarnation");
    assert.equal(persisted.runtimeGeneration, undefined, "no replacement generation is committed");
    assert.equal(persisted.status, "kill_failed", "demote fences work before signalling the pane");
    const journalFiles = await readdir(join(store, "launch-reservations"));
    const journal = JSON.parse(await readFile(join(store, "launch-reservations", journalFiles[0]!), "utf8")) as Record<string, unknown>;
    assert.equal(journal.operation, "demote");
    assert.equal(journal.phase, "stopping");
    assert.equal(await hasSession(target), false, "pane absence alone did not authorize HSR spawn");
  } finally {
    const cleanup = await Promise.allSettled([
      launcherPgid && cleanupFingerprint
        ? terminateProcessGroup(launcherPgid, cleanupFingerprint)
        : Promise.resolve(undefined),
      tmux(["kill-session", "-t", `=${target}`], { reject: false }),
    ]);
    assert.equal(cleanup[0].status, "fulfilled", "exact fixture process-group cleanup completes");
    if (cleanup[0].status === "fulfilled" && cleanup[0].value) {
      assert.equal(cleanup[0].value.status, "confirmed", cleanup[0].value.reason);
    }
    setTmuxSocket(undefined);
    await Promise.allSettled([
      rm(socketDir, { recursive: true, force: true }),
      rm(store, { recursive: true, force: true }),
    ]);
  }
});

test("demote refuses a remote HSR record before stop or replacement admission", async () => {
  const store = await mkdtemp(join(tmpdir(), "hive-demote-remote-store-"));
  const bee = "CO.remote-demote";
  try {
    await mkdir(join(store, "sessions"), { recursive: true });
    const record = {
      name: bee,
      agent: "codex",
      requestedAgent: "codex",
      cwd: "/remote/cwd",
      command: "codex",
      tmuxTarget: bee,
      providerSessionId: "remote-thread",
      node: "remote-one",
      remoteLaunchId: "launch-old",
      remoteIncarnation: "inc-old",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      status: "running",
    };
    await writeFile(join(store, "sessions", `${bee}.json`), `${JSON.stringify(record, null, 2)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, ["tests/cli-entry.mjs", "demote", bee], {
        cwd: process.cwd(),
        env: { ...process.env, HIVE_STORE_ROOT: store, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" },
      }),
      /remote node remote-one; demote only supports local tmux bees/,
    );
    const persisted = JSON.parse(await readFile(join(store, "sessions", `${bee}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.status, "running");
    assert.equal((await readdir(join(store, "launch-reservations")).catch(() => [])).length, 0);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
