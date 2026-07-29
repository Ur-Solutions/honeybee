import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { renderTrackStatus } from "../src/commands/track.js";
import {
  attachTrack,
  defineTrackFromFile,
  detachTrack,
  loadTrackAttachment,
  recordTrackException,
  trackPostscript,
  updateTrackStep,
  validateTrack,
} from "../src/track.js";

const execFileAsync = promisify(execFile);
const TRACK = {
  name: "release-check",
  description: "A small release path",
  steps: [
    { id: "inspect", title: "Inspect the change", description: "Read the diff." },
    { id: "verify", title: "Run verification" },
    { id: "report", title: "Report the result" },
  ],
};

async function hive(store: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HIVE_STORE_ROOT: store, NO_COLOR: "1", TERM: "dumb", ...env },
  });
}

async function hiveWithInput(store: string, args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: store, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`hive exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

async function seedSession(store: string, name: string): Promise<void> {
  await mkdir(join(store, "sessions"), { recursive: true });
  const at = "2026-07-29T12:00:00.000Z";
  await writeFile(join(store, "sessions", `${name}.json`), `${JSON.stringify({
    name,
    id: name,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    createdAt: at,
    updatedAt: at,
    status: "running",
  }, null, 2)}\n`, { mode: 0o600 });
}

async function withStore<T>(fn: (store: string) => Promise<T>): Promise<T> {
  const store = await mkdtemp(join(tmpdir(), "hive-track-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    return await fn(store);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(store, { recursive: true, force: true });
  }
}

async function defineFixture(store: string): Promise<void> {
  const source = join(store, "track-source.json");
  await writeFile(source, `${JSON.stringify(TRACK, null, 2)}\n`);
  await defineTrackFromFile(source);
}

test("track define/attach/status lifecycle persists timestamps, history, exceptions, and ledger events", async () => {
  await withStore(async (store) => {
    await defineFixture(store);
    let delivered = "";
    let tick = Date.parse("2026-07-29T12:00:00.000Z");
    const now = () => new Date(tick += 1_000);
    const initial = await attachTrack(TRACK.name, {
      bee: "CO.track",
      beeId: "CO.track",
      now,
      deliver: async (postscript) => {
        delivered = postscript;
      },
    });
    assert.equal(initial.steps.length, 3);
    assert.ok(initial.steps.every((step) => step.status === "pending" && step.history.length === 1));
    assert.match(delivered, /hive track step <id> done\|skip/);
    await assert.rejects(() => attachTrack(TRACK.name, { bee: "CO.track" }), /already has active track/);

    await updateTrackStep("CO.track", "inspect", "done", "diff read", now);
    await updateTrackStep("CO.track", "verify", "skipped", "manual smoke", now);
    await recordTrackException("CO.track", "Used the smoke harness instead of the full suite.", now);
    const active = await loadTrackAttachment("CO.track");
    assert.ok(active);
    assert.equal(active.steps[0]?.status, "done");
    assert.equal(active.steps[0]?.history.length, 2);
    assert.equal(active.steps[1]?.status, "skipped");
    assert.equal(active.exceptions.length, 1);
    assert.match(renderTrackStatus(active, tick + 1_000), /\[✓\].*inspect[\s\S]*\[-\].*verify[\s\S]*Exceptions \(1\)/);

    const events = (await readFile(join(store, "ledger.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(events.map((event) => event.type), [
      "track.define",
      "track.attach",
      "track.step",
      "track.step",
      "track.exception",
    ]);

    const detached = await detachTrack("CO.track", now);
    assert.equal(detached.track, TRACK.name);
    assert.equal(await loadTrackAttachment("CO.track"), null);
    const finalLedger = await readFile(join(store, "ledger.jsonl"), "utf8");
    assert.match(finalLedger, /"type":"track\.detach"/);
  });
});

test("track attachment rolls back when standing-postscript delivery fails", async () => {
  await withStore(async (store) => {
    await defineFixture(store);
    await assert.rejects(
      () => attachTrack(TRACK.name, {
        bee: "CO.failed",
        deliver: async () => {
          throw new Error("transport down");
        },
      }),
      /transport down/,
    );
    assert.equal(await loadTrackAttachment("CO.failed"), null);
    const ledger = await readFile(join(store, "ledger.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /track\.attach/);
  });
});

test("track validation rejects duplicate ids and the injected postscript carries the whole agent contract", () => {
  assert.throws(
    () => validateTrack({ ...TRACK, steps: [TRACK.steps[0], TRACK.steps[0]] }),
    /duplicate step id/,
  );
  const postscript = trackPostscript(validateTrack(TRACK));
  assert.match(postscript, /\[inspect\] Inspect the change/);
  assert.match(postscript, /\[verify\] Run verification/);
  assert.match(postscript, /\[report\] Report the result/);
  assert.match(postscript, /hive track step <id> done\|skip \[--note "\.\.\."\]/);
  assert.match(postscript, /hive track exception "<why>"/);
  assert.match(postscript, /hive track status/);
  assert.match(postscript, /Deviating is allowed but must be recorded as an exception\./);
});

test("agent-side step, exception, and status resolve self from HIVE_BEE", async () => {
  await withStore(async (store) => {
    await defineFixture(store);
    await seedSession(store, "CO.self");
    await attachTrack(TRACK.name, { bee: "CO.self", beeId: "CO.self" });

    const env = { HIVE_BEE: "CO.self" };
    await hive(store, ["track", "step", "inspect", "done", "--note", "self update"], env);
    await hive(store, ["track", "exception", "Changed the verification order."], env);
    const { stdout } = await hive(store, ["track", "status", "--json"], env);
    const status = JSON.parse(stdout) as {
      bee: string;
      steps: Array<{ id: string; status: string; note?: string }>;
      exceptions: Array<{ note: string }>;
    };
    assert.equal(status.bee, "CO.self");
    assert.equal(status.steps[0]?.id, "inspect");
    assert.equal(status.steps[0]?.status, "done");
    assert.equal(status.steps[0]?.note, "self update");
    assert.equal(status.exceptions[0]?.note, "Changed the verification order.");
  });
});

test("CLI defines a track from stdin and exposes list/show JSON", async () => {
  const store = await mkdtemp(join(tmpdir(), "hive-track-cli-"));
  try {
    const define = await hiveWithInput(store, ["track", "define", "-", "--json"], JSON.stringify(TRACK));
    assert.equal(JSON.parse(define.stdout).name, TRACK.name);
    const listed = await hive(store, ["track", "list", "--json"]);
    assert.equal(JSON.parse(listed.stdout).length, 1);
    const shown = await hive(store, ["track", "show", TRACK.name, "--json"]);
    assert.deepEqual(JSON.parse(shown.stdout), TRACK);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
