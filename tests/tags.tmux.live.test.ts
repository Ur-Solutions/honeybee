import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeHiveTags } from "../src/hiveState.js";
import { newSession, setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";
import type { SessionRecord } from "../src/store.js";

// T5 (PRD §9.1, §15): the sentinel-wrapped @hive_tags lets `tmux ls -f` match a
// tag at word boundaries without store reads — `migration` matches but
// `migration-foo` does not. Runs against a private throwaway socket so it never
// touches the user's tmux server; skips cleanly when tmux is unavailable.
function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function record(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: name,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    status: "running",
    id: name,
    ...overrides,
  };
}

test("T5: @hive_tags is sentinel-wrapped and tmux ls -f matches at word boundaries", { skip: !tmuxAvailable() }, async () => {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-tags-tmux-"));
  const socket = join(socketDir, "sock");
  setTmuxSocket(socket);
  const tagged = `hive-tags-live-tagged-${process.pid}`;
  const decoy = `hive-tags-live-decoy-${process.pid}`;
  try {
    await newSession(tagged, "/tmp", { command: "sh", args: ["-c", "sleep 30"] });
    await newSession(decoy, "/tmp", { command: "sh", args: ["-c", "sleep 30"] });

    // tagged carries `migration`; decoy carries the look-alike `migration-foo`.
    await writeHiveTags(record(tagged, { tags: ["migration"], id: tagged }));
    await writeHiveTags(record(decoy, { tags: ["migration-foo"], id: decoy }));

    // The option is sentinel-wrapped: the leading space survives `show-options
    // -v` (tmux trims trailing whitespace in this display, so we verify the
    // trailing boundary via the word-boundary filter below — the behavior that
    // actually matters).
    const opt = await tmux(["show-options", "-v", "-t", `=${tagged}:`, "@hive_tags"]);
    assert.ok(opt.stdout.startsWith(" "), "leading space");
    assert.match(opt.stdout, / migration/);

    // The word-boundary filter matches the tagged session and NOT the decoy
    // (whose look-alike `migration-foo` must not false-match `migration`).
    const matched = await tmux([
      "list-sessions",
      "-f",
      "#{m:* migration *,#{@hive_tags}}",
      "-F",
      "#{session_name}",
    ]);
    const names = matched.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(names, [tagged], "only the migration-tagged session matches");
  } finally {
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
  }
});
