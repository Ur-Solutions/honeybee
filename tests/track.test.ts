import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { deliverTrackFollowUp, renderTrackStatus } from "../src/commands/track.js";
import { recordSeal, validateSealArtifact } from "../src/seal.js";
import { listActiveSessions, loadSession, saveSession, updateSession, type SessionRecord } from "../src/store.js";
import {
  attachTrack,
  defineTrackFromFile,
  detachTrack,
  flattenTrackNodes,
  loadTrack,
  loadTrackAttachment,
  queueTrack,
  recordTrackException,
  trackAttachmentPath,
  trackDefinitionPath,
  trackDefinitionVersionPath,
  trackPostscript,
  updateTrackStep,
  updateTrackSubTask,
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
      .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
    assert.deepEqual(events.map((event) => event.type), [
      "track.define",
      "track.attach",
      "track.step",
      "track.step",
      "track.exception",
    ]);
    assert.ok(!("version" in events[0]!) && !("version" in events[1]!));

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

test("track follow-up retires the completed-turn boundary and re-enters the active index", async () => {
  await withStore(async (store) => {
    const record: SessionRecord = {
      name: "CO.track-follow-up",
      id: "CO.track-follow-up",
      agent: "codex",
      cwd: store,
      command: "codex",
      tmuxTarget: "CO.track-follow-up",
      createdAt: "2026-08-07T08:00:00.000Z",
      updatedAt: "2026-08-07T08:01:00.000Z",
      status: "running",
      lastObservedState: "done",
      lastObservedStateAt: "2026-08-07T08:01:00.000Z",
    };
    await saveSession(record);
    await recordSeal(record.name, validateSealArtifact({ status: "done", summary: "previous track turn" }));
    assert.deepEqual(await listActiveSessions(), [], "completed warm turn starts outside the daemon hot set");

    let delivered = false;
    await deliverTrackFollowUp(record, "next standing track instructions", {
      deliver: async () => {
        delivered = true;
        assert.deepEqual(await listActiveSessions(), [], "turn boundary is persisted only after delivery succeeds");
      },
      writeState: async () => undefined,
      now: () => new Date("2026-08-07T08:02:00.000Z"),
    });
    assert.equal(delivered, true);
    assert.deepEqual((await listActiveSessions()).map((candidate) => candidate.name), [record.name]);
    const stored = await loadSession(record.name);
    assert.equal(stored?.lastObservedState, undefined);
    assert.equal(stored?.lastObservedStateAt, undefined);
    assert.equal(stored?.lastPrompt, "next standing track instructions");
    assert.equal(typeof stored?.sealHighWaterFilename, "string", "previous turn's seal becomes the high-water boundary");

    await updateSession(record.name, {
      lastObservedState: "done",
      lastObservedStateAt: "2026-08-07T08:03:00.000Z",
    });
    const completedAgain = await loadSession(record.name);
    assert.ok(completedAgain);
    await assert.rejects(
      () => deliverTrackFollowUp(completedAgain!, "failed follow-up", {
        deliver: async () => { throw new Error("transport down"); },
        writeState: async () => undefined,
      }),
      /transport down/,
    );
    assert.equal((await loadSession(record.name))?.lastObservedState, "done", "failed delivery preserves the completed boundary");
    assert.deepEqual(await listActiveSessions(), []);
  });
});

test("track validation rejects duplicate ids and the injected postscript carries the whole agent contract", () => {
  assert.throws(
    () => validateTrack({ ...TRACK, steps: [TRACK.steps[0], TRACK.steps[0]] }),
    /duplicate step id/,
  );
  const postscript = trackPostscript(validateTrack(TRACK));
  assert.match(postscript, /\[inspect\] ACTION Inspect the change/);
  assert.match(postscript, /\[verify\] ACTION Run verification/);
  assert.match(postscript, /\[report\] ACTION Report the result/);
  assert.match(postscript, /hive track step <id> done\|skip \[--note "\.\.\."\]/);
  assert.match(postscript, /hive track subtask <name> queued\|running\|done/);
  assert.match(postscript, /hive track exception "<why>" \[--step <id>\]/);
  assert.match(postscript, /hive track status/);
  assert.match(postscript, /Deviation is allowed; record it as an exception\./);
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
    const normalized = JSON.parse(shown.stdout) as {
      schemaVersion: number;
      version: number;
      items: Array<{ type: string; id: string; name: string }>;
    };
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.version, 1);
    assert.deepEqual(normalized.items.map(({ type, id, name }) => ({ type, id, name })), [
      { type: "action", id: "inspect", name: "Inspect the change" },
      { type: "action", id: "verify", name: "Run verification" },
      { type: "action", id: "report", name: "Report the result" },
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

const V2_TRACK = {
  name: "typed-release",
  description: "Exercise every v2 node",
  items: [
    { type: "action", name: "Inspect", instruction: "Read the diff.", note: "Keep this terse." },
    {
      type: "orchestrate",
      id: "fan",
      name: "Fan out checks",
      instruction: "Split verification by package.",
      subAgents: { max: 3, harness: "codex" },
      expectation: "One report per package.",
    },
    {
      branch: [
        [
          { type: "action", id: "docs", name: "Check docs", instruction: "Review docs.", when: "docs changed" },
          { type: "deploy", id: "preview", name: "Preview", target: { kind: "nectar", label: "mesh preview", lane: "fast" } },
        ],
        [
          { type: "ask", id: "question", name: "Confirm scope", question: "Is the migration in scope?", blocking: true },
          { type: "deploy", id: "stage", name: "Stage", target: { kind: "named", name: "staging" } },
          { type: "deploy", id: "manual", name: "Manual target", target: { kind: "text", description: "the named customer sandbox" } },
        ],
      ],
    },
    {
      type: "review",
      id: "packet",
      name: "Release verdict",
      denied: [
        { type: "action", id: "fix-review", name: "Fix review findings", instruction: "Address every denied item." },
        { type: "action", id: "rerequest", name: "Re-request packet", instruction: "Update the same packet." },
      ],
    },
    { type: "review", id: "default-packet", name: "Final packet" },
  ],
} as const;

async function defineValue(store: string, value: unknown, file = "definition.json") {
  const source = join(store, file);
  await writeFile(source, `${JSON.stringify(value, null, 2)}\n`);
  return defineTrackFromFile(source);
}

test("v1 definitions migrate to schema v2 action nodes", () => {
  const migrated = validateTrack(TRACK);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.version, 1);
  assert.deepEqual(migrated.items[0], {
    type: "action",
    id: "inspect",
    name: "Inspect the change",
    instruction: "Read the diff.",
  });
  assert.ok(flattenTrackNodes(migrated.items).every((node) => node.type === "action"));
  assert.throws(
    () => validateTrack({ name: "old-do", items: [{ type: "do", id: "old", name: "Old spelling" }] }),
    /unsupported node type "do"/,
  );
});

test("shipped v1 definition and attachment files load as schema v2", async () => {
  await withStore(async (store) => {
    await mkdir(join(store, "tracks", "definitions"), { recursive: true });
    await writeFile(trackDefinitionPath(TRACK.name), `${JSON.stringify(TRACK, null, 2)}\n`);
    const loaded = await loadTrack(TRACK.name);
    assert.equal(loaded?.schemaVersion, 2);
    assert.equal(loaded?.version, 1);
    assert.equal(loaded?.items[0] && "type" in loaded.items[0] ? loaded.items[0].type : null, "action");

    const at = "2026-07-29T12:00:00.000Z";
    await mkdir(join(store, "tracks", "attachments"), { recursive: true });
    await writeFile(trackAttachmentPath("CO.legacy"), `${JSON.stringify({
      track: TRACK.name,
      bee: "CO.legacy",
      attachedAt: at,
      updatedAt: at,
      steps: TRACK.steps.map((step) => ({
        ...step,
        status: "pending",
        updatedAt: at,
        history: [{ status: "pending", at }],
      })),
      exceptions: [],
    }, null, 2)}\n`);
    const attachment = await loadTrackAttachment("CO.legacy");
    assert.equal(attachment?.schemaVersion, 2);
    assert.equal(attachment?.version, 1);
    assert.equal(attachment?.items[0] && "type" in attachment.items[0] ? attachment.items[0].type : null, "action");
    assert.deepEqual(attachment?.queue, []);
    assert.deepEqual(attachment?.steps.map((step) => step.id), ["inspect", "verify", "report"]);
  });
});

test("define bumps immutable versions and generated ids freeze in canonical JSON", async () => {
  await withStore(async (store) => {
    const first = await defineValue(store, {
      name: "versioned",
      items: [
        { type: "action", name: "First" },
        { type: "review", name: "Packet" },
      ],
    }, "versioned-1.json");
    assert.equal(first.version, 1);
    assert.deepEqual(flattenTrackNodes(first.items).map((node) => node.id), ["n1", "n2"]);

    const second = await defineValue(store, {
      ...first,
      items: [
        first.items[0],
        { ...first.items[1], note: "Edited without changing identity." },
      ],
    }, "versioned-2.json");
    assert.equal(second.version, 2);
    assert.deepEqual(flattenTrackNodes(second.items).map((node) => node.id), ["n1", "n2"]);

    const v1 = await loadTrack("versioned", 1);
    const v2 = await loadTrack("versioned", 2);
    assert.equal(v1?.version, 1);
    assert.equal(v2?.version, 2);
    assert.equal((v1?.items[1] as { note?: string }).note, undefined);
    assert.equal((v2?.items[1] as { note?: string }).note, "Edited without changing identity.");
    assert.equal(JSON.parse(await readFile(trackDefinitionVersionPath("versioned", 1), "utf8")).version, 1);
  });
});

test("branch projection flattens main-spine lanes and omits review outcome arms", async () => {
  await withStore(async (store) => {
    const track = await defineValue(store, V2_TRACK);
    assert.equal(track.items[0] && "id" in track.items[0] ? track.items[0].id : null, "n1");
    const attachment = await attachTrack(track.name, { bee: "CO.branch" });
    assert.equal(attachment.schemaVersion, 2);
    assert.deepEqual(attachment.steps.map((step) => step.id), [
      "n1",
      "fan",
      "docs",
      "preview",
      "question",
      "stage",
      "manual",
      "packet",
      "default-packet",
    ]);
    assert.ok(!attachment.steps.some((step) => step.id === "fix-review" || step.id === "rerequest"));

    const review = attachment.items[3];
    assert.ok(review && "type" in review && review.type === "review");
    assert.deepEqual(review.denied?.map((node) => node.id), ["fix-review", "rerequest"]);
    await updateTrackStep("CO.branch", "fix-review", "done", "denied arm exercised");
    const updated = await loadTrackAttachment("CO.branch");
    const updatedReview = updated?.items[3];
    assert.ok(updatedReview && "type" in updatedReview && updatedReview.type === "review");
    assert.equal(updatedReview.denied?.[0]?.status, "done");
    assert.ok(!updated?.steps.some((step) => step.id === "fix-review"));
  });
});

test("attach --start-at pre-marks all earlier main-spine nodes", async () => {
  await withStore(async (store) => {
    await defineValue(store, V2_TRACK);
    const attachment = await attachTrack(V2_TRACK.name, { bee: "CO.start", startAt: "question" });
    const questionIndex = attachment.steps.findIndex((step) => step.id === "question");
    assert.ok(questionIndex > 0);
    assert.ok(attachment.steps.slice(0, questionIndex).every((step) =>
      step.status === "done" && step.note === "pre-marked at attach"
    ));
    assert.equal(attachment.steps[questionIndex]?.status, "pending");
  });
});

test("queue auto-attaches on terminal completion and detach with an exception", async () => {
  await withStore(async (store) => {
    const one = await defineValue(store, {
      name: "queue-one",
      items: [{ type: "action", id: "one", name: "One" }],
    }, "queue-one.json");
    const two = await defineValue(store, {
      name: "queue-two",
      items: [{ type: "action", id: "two", name: "Two" }],
    }, "queue-two.json");
    const three = await defineValue(store, {
      name: "queue-three",
      items: [{ type: "action", id: "three", name: "Three" }],
    }, "queue-three.json");
    const delivered: string[] = [];

    await attachTrack(one.name, { bee: "CO.complete" });
    await queueTrack(two.name, "CO.complete", { queuedBy: "tester" });
    await updateTrackStep("CO.complete", "one", "done", undefined, () => new Date("2026-07-31T06:00:00.000Z"), {
      deliver: async (postscript) => {
        delivered.push(postscript);
      },
    });
    const afterComplete = await loadTrackAttachment("CO.complete");
    assert.equal(afterComplete?.track, two.name);
    assert.equal(afterComplete?.version, two.version);
    assert.match(delivered[0] ?? "", /Track: queue-two@1/);

    await attachTrack(one.name, { bee: "CO.detach" });
    await queueTrack(three.name, "CO.detach", { version: three.version, queuedBy: "tester" });
    await recordTrackException("CO.detach", "The operator ended this path.", { stepId: "one" });
    const detached = await detachTrack("CO.detach", {
      deliver: async (postscript) => {
        delivered.push(postscript);
      },
    });
    assert.equal(detached.track, one.name);
    const afterDetach = await loadTrackAttachment("CO.detach");
    assert.equal(afterDetach?.track, three.name);
    assert.equal(afterDetach?.version, three.version);
  });
});

test("subtasks set startedAt and step-scoped exceptions retain compatible ledger events", async () => {
  await withStore(async (store) => {
    await defineValue(store, {
      name: "runtime-v2",
      items: [
        { type: "orchestrate", id: "orchestrate", name: "Split", instruction: "Delegate it." },
      ],
    });
    await attachTrack("runtime-v2", { bee: "CO.runtime" });
    await updateTrackSubTask("CO.runtime", "pkg/core", "queued", {
      now: () => new Date("2026-07-31T07:00:00.000Z"),
    });
    await updateTrackSubTask("CO.runtime", "pkg/core", "running", {
      now: () => new Date("2026-07-31T07:01:00.000Z"),
    });
    await recordTrackException("CO.runtime", "Ran a focused check first.", {
      stepId: "orchestrate",
      now: () => new Date("2026-07-31T07:02:00.000Z"),
    });
    const attachment = await loadTrackAttachment("CO.runtime");
    assert.equal(attachment?.steps[0]?.startedAt, "2026-07-31T07:00:00.000Z");
    assert.deepEqual(attachment?.steps[0]?.subTasks, [{ name: "pkg/core", status: "running" }]);
    assert.equal(attachment?.exceptions[0]?.stepId, "orchestrate");

    const events = (await readFile(join(store, "ledger.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const subtask = events.find((event) => event.type === "track.subtask");
    const exception = events.find((event) => event.type === "track.exception");
    assert.equal(subtask?.step, "orchestrate");
    assert.equal(subtask?.subtask, "pkg/core");
    assert.equal(exception?.step, "orchestrate");
  });
});

test("v2 postscript renders packet mechanics, review routing, default iteration, branches, and all deploy targets", () => {
  const track = validateTrack(V2_TRACK);
  const postscript = trackPostscript(track);
  assert.match(postscript, /\[n1\] ACTION Inspect/);
  assert.doesNotMatch(postscript, /\bDO\b/);
  assert.match(postscript, /REVIEW PACKET Release verdict/);
  assert.match(postscript, /MUST send with forum packet create/);
  assert.match(postscript, /MUST NOT proceed past this node without a verdict/);
  assert.match(postscript, /forum packet show <packet-id> --json/);
  assert.match(postscript, /--verdict approve maps to APPROVED/);
  assert.match(postscript, /--verdict request_changes maps to DENIED/);
  assert.match(postscript, /DENIED:\s*\n\s+- \[fix-review\] ACTION Fix review findings/);
  assert.match(postscript, /DENIED \(default iterate\): fix the issues raised in the verdict and re-request the SAME packet/);
  assert.match(postscript, /forum packet rerequest <packet-id>/);
  assert.match(postscript, /parallel lanes and an unordered set: you may do lanes in any order or interleaved/);
  assert.match(postscript, /nectar "mesh preview" \(lane fast\)/);
  assert.match(postscript, /named "staging"/);
  assert.match(postscript, /the named customer sandbox/);
  assert.match(postscript, /no computational enforcement/);
});

test("agent-side CLI reports subtask and step-scoped exception in schema v2 status", async () => {
  await withStore(async (store) => {
    await defineValue(store, {
      name: "cli-runtime-v2",
      items: [
        { type: "orchestrate", id: "work", name: "Work", instruction: "Split it." },
        {
          type: "review",
          id: "review",
          name: "Review",
          denied: [{ type: "action", id: "fix", name: "Fix", instruction: "Address the verdict." }],
        },
      ],
    });
    await seedSession(store, "CO.cli-v2");
    await attachTrack("cli-runtime-v2", { bee: "CO.cli-v2", beeId: "CO.cli-v2" });
    const env = { HIVE_BEE: "CO.cli-v2" };
    await hive(store, ["track", "subtask", "pkg/core", "done"], env);
    await hive(store, ["track", "exception", "Used a focused suite.", "--step", "work"], env);
    const deniedResult = await hive(store, [
      "track",
      "step",
      "fix",
      "done",
      "--note",
      "Denied arm exercised.",
      "--json",
    ], env);
    const deniedNode = JSON.parse(deniedResult.stdout) as { id: string; type: string; status: string };
    assert.equal(deniedNode.id, "fix");
    assert.equal(deniedNode.type, "action");
    assert.equal(deniedNode.status, "done");
    const { stdout } = await hive(store, ["track", "status", "--json"], env);
    const status = JSON.parse(stdout) as {
      schemaVersion: number;
      items: Array<{
        subTasks?: Array<{ name: string; status: string }>;
        denied?: Array<{ id: string; status: string }>;
      }>;
      exceptions: Array<{ stepId?: string }>;
      steps: Array<{ id: string }>;
    };
    assert.equal(status.schemaVersion, 2);
    assert.deepEqual(status.items[0]?.subTasks, [{ name: "pkg/core", status: "done" }]);
    assert.deepEqual(status.items[1]?.denied?.map((node) => [node.id, node.status]), [["fix", "done"]]);
    assert.equal(status.exceptions[0]?.stepId, "work");
    assert.deepEqual(status.steps.map((step) => step.id), ["work", "review"]);
  });
});
