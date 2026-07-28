import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cmdComb } from "../src/commands/comb.js";
import { parse } from "../src/parse.js";

type Envelope = {
  ok: boolean;
  command: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
};

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-comb-cli-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  }
}

async function invoke(args: string[]): Promise<{ envelope: Envelope; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  process.exitCode = undefined;
  console.log = (...values: unknown[]) => stdout.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => stderr.push(values.map(String).join(" "));
  try {
    await cmdComb(parse(["comb", ...args]));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1, `expected exactly one stdout envelope, got: ${stdout.join("\n")}`);
  return { envelope: JSON.parse(stdout[0]!) as Envelope, exitCode: Number(process.exitCode ?? 0) };
}

test("versioned public corpus pins every implemented command envelope and canonical exit code", async () => {
  const corpus = JSON.parse(await readFile(resolve("contracts/combs/v1/cli-golden.json"), "utf8")) as {
    schemaVersion: number;
    exitCodes: Record<string, number>;
    cases: Array<{ id: string; stdout: { command: string } }>;
  };
  assert.equal(corpus.schemaVersion, 1);
  assert.deepEqual(corpus.exitCodes, {
    success_or_durable_ack: 0,
    invalid_argument_or_schema: 2,
    not_found: 3,
    version_claim_or_idempotency_conflict: 4,
    ambiguous_activation_or_approval_required: 5,
    unresolved_effect_ambiguity: 6,
    external_dependency: 7,
    internal_or_corrupt_state: 70,
  });
  const commands = new Set(corpus.cases.map((fixture) => fixture.stdout.command));
  assert.deepEqual(commands, new Set([
    "comb.list",
    "comb.lint",
    "comb.define",
    "comb.inspect",
    "comb.run",
    "comb.runs",
    "comb.status",
    "comb.cancel",
    "comb.events",
  ]));
});

test("CLI emits exactly one success envelope for define/run/read/cancel lifecycle", async () => {
  await withTempStore(async (dir) => {
    const fixture = resolve("contracts/deep-review.strict.comb.json");
    const inputPath = join(dir, "input.json");
    await writeFile(inputPath, JSON.stringify({ ref: "HEAD", effort: "low" }));

    const lint = await invoke(["lint", fixture, "--json"]);
    assert.equal(lint.exitCode, 0);
    assert.equal(lint.envelope.command, "comb.lint");
    assert.equal(lint.envelope.result?.valid, true);

    const defined = await invoke(["define", fixture, "--json"]);
    assert.equal(defined.envelope.command, "comb.define");
    assert.equal((defined.envelope.result?.comb as { version: number }).version, 1);
    assert.equal(defined.envelope.result?.created, true);

    const duplicate = await invoke(["define", fixture, "--base-version", "1", "--json"]);
    assert.equal(duplicate.envelope.result?.created, false);

    const inspect = await invoke(["inspect", "deep-review-strict", "--version", "1", "--json"]);
    assert.equal((inspect.envelope.result?.comb as { name: string }).name, "deep-review-strict");

    const started = await invoke([
      "run",
      "deep-review-strict",
      "--version",
      "1",
      "--input",
      inputPath,
      "--cwd",
      dir,
      "--product",
      "honeybee",
      "--json",
    ]);
    const runResult = started.envelope.result as { run: { id: string; status: string }; created: boolean; joinedExisting: boolean; replayedDelivery: boolean; intakeReady: boolean };
    assert.equal(runResult.created, true);
    assert.equal(runResult.joinedExisting, false);
    assert.equal(runResult.replayedDelivery, false);
    assert.equal(runResult.intakeReady, false);
    assert.equal(runResult.run.status, "active");
    const runId = runResult.run.id;

    const runs = await invoke(["runs", "--board", "--last", "1", "--json"]);
    assert.equal((runs.envelope.result?.runs as Array<{ id: string }>)[0]?.id, runId);

    const status = await invoke(["status", runId, "--activation", "architecture@1#0", "--json"]);
    assert.equal((status.envelope.result?.run as { id: string }).id, runId);
    assert.equal((status.envelope.result?.hydratedActivation as { id: string }).id, "architecture@1#0");

    const events = await invoke(["events", runId, "--after", "0", "--limit", "2", "--json"]);
    assert.equal((events.envelope.result?.events as unknown[]).length, 2);
    assert.equal(events.envelope.result?.hasMore, true);

    const cancelled = await invoke(["cancel", runId, "--reason", "test", "--json"]);
    assert.equal(cancelled.envelope.result?.status, "cancelled");
    assert.equal((cancelled.envelope.result?.fence as { epoch: number }).epoch, 1);
  });
});

test("CLI failure envelopes use canonical codes/exits and stdout purity", async () => {
  await withTempStore(async () => {
    const notFound = await invoke(["status", "missing", "--json"]);
    assert.deepEqual(notFound.envelope, {
      ok: false,
      command: "comb.status",
      error: { code: "not_found", message: "comb run not found: missing" },
    });
    assert.equal(notFound.exitCode, 3);

    const invalid = await invoke(["run", "x", "--version", "nope", "--input", "missing", "--json"]);
    assert.equal(invalid.envelope.ok, false);
    assert.equal(invalid.envelope.error?.code, "invalid_argument");
    assert.equal(invalid.exitCode, 2);
  });
});

test("comb run requires an explicit product identity instead of deriving one from cwd", async () => {
  await withTempStore(async (dir) => {
    const fixture = resolve("contracts/deep-review.strict.comb.json");
    const inputPath = join(dir, "input.json");
    await writeFile(inputPath, JSON.stringify({ ref: "HEAD", effort: "low" }));
    await invoke(["define", fixture, "--json"]);

    const missingProduct = await invoke([
      "run",
      "deep-review-strict",
      "--version",
      "1",
      "--input",
      inputPath,
      "--cwd",
      dir,
      "--json",
    ]);
    assert.equal(missingProduct.exitCode, 2);
    assert.deepEqual(missingProduct.envelope.error, {
      code: "invalid_argument",
      message: "--product is required in strict-spine slice 1; product identity is never inferred from cwd",
    });
  });
});

test("trigger delivery replay is idempotent and a conflicting digest exits 4", async () => {
  await withTempStore(async (dir) => {
    const fixture = resolve("contracts/deep-review.strict.comb.json");
    const inputPath = join(dir, "input.json");
    await writeFile(inputPath, JSON.stringify({ ref: "HEAD", effort: "low" }));
    await invoke(["define", fixture, "--json"]);
    const argv = [
      "run", "deep-review-strict", "--version", "1", "--input", inputPath,
      "--cwd", dir, "--product", "honeybee",
      "--origin-trigger", "trigger-1", "--origin-delivery", "delivery-1", "--json",
    ];
    const first = await invoke(argv);
    const second = await invoke(argv);
    assert.equal((first.envelope.result as { replayedDelivery: boolean }).replayedDelivery, false);
    assert.equal((second.envelope.result as { replayedDelivery: boolean }).replayedDelivery, true);
    assert.equal(
      ((first.envelope.result as { run: { id: string } }).run.id),
      ((second.envelope.result as { run: { id: string } }).run.id),
    );

    await writeFile(inputPath, JSON.stringify({ ref: "OTHER", effort: "low" }));
    const conflict = await invoke(argv);
    assert.equal(conflict.exitCode, 4);
    assert.equal(conflict.envelope.error?.code, "version_conflict");
  });
});
