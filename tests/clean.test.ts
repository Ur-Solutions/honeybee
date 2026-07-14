import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { deadSessionRecords, idleOlderThanMillis, olderThanMillis, parseAge } from "../src/clean.js";
import { liveTargetKey } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import { hasSession as tmuxHasSession, kill as tmuxKill, newSession as tmuxNewSession } from "../src/tmux.js";

const execFileAsync = promisify(execFile);

test("deadSessionRecords returns sessions whose tmux target is not live", () => {
  const records = [
    session("CO.aaa", "CO-aaa"),
    session("CL.bbb", "CL-bbb"),
    session("GR.ccc", "GR-ccc"),
  ];

  const live = new Set([liveTargetKey(undefined, "CO-aaa"), liveTargetKey(undefined, "GR-ccc")]);
  assert.deepEqual(deadSessionRecords(records, live).map((record) => record.name), ["CL.bbb"]);
});

test("deadSessionRecords does not let a same-named session on another node protect a dead record", () => {
  const localDead = session("CO.aaa", "CO-aaa");
  const remoteLive = { ...session("CO.bbb", "CO-aaa"), node: "mini01" };

  // Only mini01 has a live "CO-aaa" session; the local record is dead.
  const live = new Set([liveTargetKey("mini01", "CO-aaa")]);
  assert.deepEqual(deadSessionRecords([localDead, remoteLive], live).map((record) => record.name), ["CO.aaa"]);
});

test("olderThanMillis filters by last update age", () => {
  const now = Date.parse("2026-05-28T12:00:00.000Z");
  const fresh = session("fresh", "fresh-target");
  fresh.updatedAt = "2026-05-28T11:45:00.000Z";
  const stale = session("stale", "stale-target");
  stale.updatedAt = "2026-05-28T09:30:00.000Z";

  assert.deepEqual(olderThanMillis([fresh, stale], 60 * 60 * 1000, now).map((record) => record.name), ["stale"]);
});

test("idleOlderThanMillis filters by last prompt age", () => {
  const now = Date.parse("2026-05-28T12:00:00.000Z");
  const fresh = session("fresh", "fresh-target");
  fresh.updatedAt = "2026-05-28T00:00:00.000Z";
  fresh.lastPromptAt = "2026-05-28T11:45:00.000Z";
  const stale = session("stale", "stale-target");
  stale.updatedAt = "2026-05-28T11:55:00.000Z";
  stale.lastPromptAt = "2026-05-28T09:30:00.000Z";

  assert.deepEqual(idleOlderThanMillis([fresh, stale], 60 * 60 * 1000, now).map((record) => record.name), ["stale"]);
});

test("parseAge accepts compact duration strings", () => {
  assert.equal(parseAge("30m"), 30 * 60 * 1000);
  assert.equal(parseAge("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseAge("7d"), 7 * 24 * 60 * 60 * 1000);
});

test("hive clean --idle kills idle local tmux sessions and leaves active sessions alone", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-idle-"));
  const oldIdleTarget = `hive-clean-idle-old-${process.pid}`;
  const newIdleTarget = `hive-clean-idle-new-${process.pid}`;
  const activeTarget = `hive-clean-active-${process.pid}`;
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await tmuxNewSession(oldIdleTarget, "/tmp", { command: "sleep", args: ["30"] });
    await tmuxNewSession(newIdleTarget, "/tmp", { command: "sleep", args: ["30"] });
    await tmuxNewSession(activeTarget, "/tmp", { command: "sleep", args: ["30"] });

    const oldIdle = session(oldIdleTarget, oldIdleTarget);
    oldIdle.id = "CO.old";
    oldIdle.lastPrompt = "done with the older task";
    oldIdle.lastPromptAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    oldIdle.updatedAt = oldIdle.lastPromptAt;
    const newIdle = session(newIdleTarget, newIdleTarget);
    newIdle.id = "CO.new";
    newIdle.lastPrompt = "done with the newer task";
    newIdle.lastPromptAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    newIdle.updatedAt = newIdle.lastPromptAt;
    const active = session(activeTarget, activeTarget);
    active.id = "CO.actv";
    active.lastPrompt = "still working";
    active.lastPromptAt = new Date().toISOString();
    active.updatedAt = active.lastPromptAt;
    await writeFile(join(dir, "sessions", `${oldIdle.name}.json`), `${JSON.stringify(oldIdle)}\n`);
    await writeFile(join(dir, "sessions", `${newIdle.name}.json`), `${JSON.stringify(newIdle)}\n`);
    await writeFile(join(dir, "sessions", `${active.name}.json`), `${JSON.stringify(active)}\n`);

    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--idle", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });
    assert.match(dryRun.stdout, new RegExp(`idle\\tCO\\.old\\t${oldIdleTarget}`));
    assert.match(dryRun.stdout, new RegExp(`idle\\tCO\\.new\\t${newIdleTarget}`));
    assert.ok(dryRun.stdout.indexOf(oldIdleTarget) < dryRun.stdout.indexOf(newIdleTarget), "oldest idle session should be listed first");
    assert.doesNotMatch(dryRun.stdout, new RegExp(activeTarget));

    const cleaned = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--idle"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });
    assert.match(cleaned.stdout, new RegExp(`cleaned\\t${oldIdleTarget}`));
    assert.match(cleaned.stdout, new RegExp(`cleaned\\t${newIdleTarget}`));
    assert.doesNotMatch(cleaned.stdout, new RegExp(activeTarget));
    assert.equal(await tmuxHasSession(oldIdleTarget), false);
    assert.equal(await tmuxHasSession(newIdleTarget), false);
    assert.equal(await tmuxHasSession(activeTarget), true);
    await assert.rejects(readFile(join(dir, "sessions", `${oldIdle.name}.json`), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(dir, "sessions", `${newIdle.name}.json`), "utf8"), /ENOENT/);
    await readFile(join(dir, "sessions", `${active.name}.json`), "utf8");
  } finally {
    await tmuxKill(oldIdleTarget).catch(() => undefined);
    await tmuxKill(newIdleTarget).catch(() => undefined);
    await tmuxKill(activeTarget).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive clean -i rejects --dry-run and --older-than", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-interactive-"));
  try {
    for (const extra of [["--dry-run"], ["--older-than", "1h"]]) {
      await assert.rejects(
        execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "-i", ...extra], {
          cwd: process.cwd(),
          env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
        }),
        /does not support --dry-run\/--older-than/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive clean --interactive requires a TTY when there are targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-interactive-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const dead = session("dead", "dead-target");
    await writeFile(join(dir, "sessions", "dead.json"), `${JSON.stringify(dead)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--interactive"], {
        cwd: process.cwd(),
        env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
      }),
      /requires a TTY/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive clean --dead removes dead session metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const dead = session("dead", "dead-target");
    dead.updatedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await writeFile(join(dir, "sessions", "dead.json"), `${JSON.stringify(dead)}\n`);

    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(dryRun.stdout, /dead\tdead\tdead\tcodex\t\d+[smhdwoy]\t\/tmp/);
    await readFile(join(dir, "sessions", "dead.json"), "utf8");

    const cleaned = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(cleaned.stdout, /cleaned\tdead/);
    await assert.rejects(readFile(join(dir, "sessions", "dead.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive clean --crashed removes only uncommanded dead running records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-crashed-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const crashed = session("crashed", "crashed-target");
    crashed.id = "CO.crs";
    crashed.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const dead = session("dead", "dead-target");
    dead.id = "CO.ded";
    dead.status = "dead";
    dead.updatedAt = crashed.updatedAt;
    await writeFile(join(dir, "sessions", "crashed.json"), `${JSON.stringify(crashed)}\n`);
    await writeFile(join(dir, "sessions", "dead.json"), `${JSON.stringify(dead)}\n`);

    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--crashed", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(dryRun.stdout, /crashed\tCO\.crs\tcrashed\tcodex\t\d+[smhdwoy]\t\/tmp/);
    assert.doesNotMatch(dryRun.stdout, /dead/);
    await readFile(join(dir, "sessions", "crashed.json"), "utf8");
    await readFile(join(dir, "sessions", "dead.json"), "utf8");

    const cleaned = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--crashed"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(cleaned.stdout, /cleaned\tcrashed/);
    assert.doesNotMatch(cleaned.stdout, /dead/);
    await assert.rejects(readFile(join(dir, "sessions", "crashed.json"), "utf8"), /ENOENT/);
    await readFile(join(dir, "sessions", "dead.json"), "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive clean --dead --older-than only removes stale dead sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const fresh = session("fresh", "fresh-target");
    fresh.updatedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const stale = session("stale", "stale-target");
    stale.updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await writeFile(join(dir, "sessions", "fresh.json"), `${JSON.stringify(fresh)}\n`);
    await writeFile(join(dir, "sessions", "stale.json"), `${JSON.stringify(stale)}\n`);

    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead", "--older-than", "1h", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.doesNotMatch(dryRun.stdout, /fresh/);
    assert.match(dryRun.stdout, /stale/);

    const cleaned = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead", "--older-than", "1h"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(cleaned.stdout, /cleaned\tstale/);
    assert.doesNotMatch(cleaned.stdout, /fresh/);
    await readFile(join(dir, "sessions", "fresh.json"), "utf8");
    await assert.rejects(readFile(join(dir, "sessions", "stale.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive clean --dead does not reap a live HSR bee (HIVE-1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-hsr-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    // A pane-less HSR bee: no live tmux target, so the dead-sweep would reap it
    // unless the run-dir HSR observer reports it live.
    const live: SessionRecord = { ...session("hsr-live", "hsr-live"), substrate: "hsr" };
    live.updatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const dead: SessionRecord = { ...session("hsr-dead", "hsr-dead"), substrate: "hsr" };
    dead.updatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await writeFile(join(dir, "sessions", "hsr-live.json"), `${JSON.stringify(live)}\n`);
    await writeFile(join(dir, "sessions", "hsr-dead.json"), `${JSON.stringify(dead)}\n`);

    // Run-dir meta: the live bee's host pid is this test process (alive); the
    // dead bee's host pid is a never-allocated pid.
    await mkdir(join(dir, "hsr", "hsr-live"), { recursive: true });
    await mkdir(join(dir, "hsr", "hsr-dead"), { recursive: true });
    const meta = (bee: string, hostPid: number) => JSON.stringify({
      bee,
      harness: "claude",
      tier: "interactive",
      hostPid,
      startedAt: new Date().toISOString(),
      controlSocket: "/tmp/none.sock",
      status: "running",
    });
    await writeFile(join(dir, "hsr", "hsr-live", "meta.json"), meta("hsr-live", process.pid));
    await writeFile(join(dir, "hsr", "hsr-dead", "meta.json"), meta("hsr-dead", 2 ** 22));

    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });
    assert.doesNotMatch(dryRun.stdout, /hsr-live/, "a live HSR bee must never be listed as dead");
    assert.match(dryRun.stdout, /hsr-dead/, "an HSR bee with a dead host is dead");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// list and clean share buildStateContext, so both must see the HSR run-dir
// observations — the clean copy of the context assembly once omitted them and
// derived every live HSR bee as dead (the HIVE-1 data loss). Pin the shared
// helper's HSR threading through the list path too (HIVE-16).
test("hive list derives HSR liveness through the shared state context (HIVE-16)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-list-hsr-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const live: SessionRecord = { ...session("hsr-live", "hsr-live"), substrate: "hsr" };
    const dead: SessionRecord = { ...session("hsr-dead", "hsr-dead"), substrate: "hsr" };
    await writeFile(join(dir, "sessions", "hsr-live.json"), `${JSON.stringify(live)}\n`);
    await writeFile(join(dir, "sessions", "hsr-dead.json"), `${JSON.stringify(dead)}\n`);

    await mkdir(join(dir, "hsr", "hsr-live"), { recursive: true });
    await mkdir(join(dir, "hsr", "hsr-dead"), { recursive: true });
    const meta = (bee: string, hostPid: number) => JSON.stringify({
      bee,
      harness: "claude",
      tier: "interactive",
      hostPid,
      startedAt: new Date().toISOString(),
      controlSocket: "/tmp/none.sock",
      status: "running",
    });
    await writeFile(join(dir, "hsr", "hsr-live", "meta.json"), meta("hsr-live", process.pid));
    await writeFile(join(dir, "hsr", "hsr-dead", "meta.json"), meta("hsr-dead", 2 ** 22));

    const listed = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "list", "--json"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });
    const rows = JSON.parse(listed.stdout) as Array<{ name: string; beeState: string }>;
    const liveRow = rows.find((row) => row.name === "hsr-live");
    const deadRow = rows.find((row) => row.name === "hsr-dead");
    assert.ok(liveRow, "live HSR bee should be listed");
    assert.ok(deadRow, "dead HSR bee should be listed");
    assert.notEqual(liveRow.beeState, "dead", "a live HSR bee must not derive as dead");
    // A dead host under a never-retired record is an un-commanded death → "crashed".
    assert.equal(deadRow.beeState, "crashed", "an HSR bee with a dead host derives as crashed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function session(name: string, tmuxTarget: string): SessionRecord {
  return {
    name,
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "running",
  };
}
