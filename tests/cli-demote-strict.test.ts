import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { hasSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

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
  setTmuxSocket(socket);
  try {
    await tmux(["new-session", "-d", "-s", target, "sleep 120"]);
    const pane = await tmux(["display-message", "-p", "-t", `=${target}:`, "#{pane_pid}"]);
    const launcherPgid = Number(pane.stdout.trim());
    assert.ok(Number.isSafeInteger(launcherPgid) && launcherPgid > 0);
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
      /exact cleanup unconfirmed.*missing or mismatched birth fingerprint/,
    );

    const persisted = JSON.parse(await readFile(join(store, "sessions", `${bee}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.substrate, undefined, "record remains a tmux incarnation");
    assert.equal(persisted.runtimeGeneration, undefined, "no replacement generation is committed");
    assert.equal(await hasSession(target), false, "pane absence alone did not authorize HSR spawn");
  } finally {
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});
