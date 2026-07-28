import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { canonicalDigest } from "../src/comb/canonical.js";
import { attachBeeToRun } from "../src/comb/attachment.js";
import { ingestForumVerdictEvidence, ingestSealEvidence } from "../src/comb/evidence.js";
import { applyHumanVerdict, reconcileMachine } from "../src/comb/machine.js";
import { mutateRun, readEvidence, recordRunEvent } from "../src/comb/store.js";
import { cmdComb } from "../src/commands/comb.js";
import { parse } from "../src/parse.js";
import { saveSession, type SessionRecord } from "../src/store.js";
import type { ForumPacket, JsonValue } from "../src/comb/types.js";
import type { SealRecord } from "../src/seal.js";

const execFileAsync = promisify(execFile);

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

async function invoke(
  args: string[],
  fault?: { code: string; message: string },
): Promise<{ envelope: Envelope; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  process.exitCode = undefined;
  console.log = (...values: unknown[]) => stdout.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => stderr.push(values.map(String).join(" "));
  try {
    await cmdComb(parse(["comb", ...args]), {
      ...(fault
        ? {
            beforeExecute: () => {
              throw Object.assign(new Error(fault.message), { code: fault.code });
            },
          }
        : {}),
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1, `expected exactly one stdout envelope, got: ${stdout.join("\n")}`);
  return { envelope: JSON.parse(stdout[0]!) as Envelope, exitCode: Number(process.exitCode ?? 0) };
}

type GoldenArrangement =
  | { kind: "write-store-file"; path: string; contents: string }
  | { kind: "save-session"; session: SessionRecord }
  | { kind: "attach-bee"; runId: string; beeName: string; entryNodeId: string; now: string }
  | { kind: "reconcile-machine"; runId: string; now: string }
  | {
      kind: "link-human-packet";
      runId: string;
      activationId: string;
      packetId: string;
      now: string;
      capturePacketDigest: string;
    }
  | {
      kind: "ingest-forum-verdict";
      runId: string;
      activationId: string;
      packetId: string;
      now: string;
      actor: string;
      comment: string;
      captureEvidenceId: string;
      expectedResult?: "match" | "stale";
      verdictDefinitionDigest?: string;
    }
  | {
      kind: "ingest-late-seal";
      runId: string;
      activationId: string;
      filename: string;
      invalidatedAt: string;
      seal: SealRecord;
      captureEvidenceId: string;
    }
  | {
      kind: "ingest-seal";
      runId: string;
      activationId: string;
      filename: string;
      seal: SealRecord;
      captureEvidenceId: string;
      assertProjection: string;
    };

type GoldenCase = {
  id: string;
  argv?: string[];
  fault?: { code: string; message: string };
  arrange?: GoldenArrangement[];
  capture?: Record<string, string>;
  exitCode: number;
  stdout?: { command: string } & Record<string, unknown>;
  stderr?: unknown;
};

type GoldenCorpus = {
  schemaVersion: number;
  runnerVersion: number;
  exitCodes: Record<string, number>;
  fixtures: Record<string, JsonValue>;
  projectionFixtures: Record<string, unknown>;
  cases: GoldenCase[];
};

test("versioned public corpus executes every argv, arrangement, projection, envelope, and exit code", async () => {
  const corpus = JSON.parse(
    await readFile(resolve("contracts/combs/v1/cli-golden.json"), "utf8"),
  ) as GoldenCorpus;
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.runnerVersion, 1);
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
  const commands = new Set(corpus.cases.flatMap((fixture) =>
    fixture.stdout ? [fixture.stdout.command] : []
  ));
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
  const caseIds = new Set(corpus.cases.map((fixture) => fixture.id));
  for (const required of [
    "comb-run-attached-adoption",
    "comb-status-human-thread",
    "comb-runs-human-packet-board",
    "comb-events-human-packet-lifecycle",
    "comb-events-stale-human-verdict",
    "comb-events-late-invalidated-seal",
    "comb-status-human-verdict-done",
    "spawn-comb-argv-surface",
    "x-comb-argv-surface",
  ]) {
    assert.ok(caseIds.has(required), `public corpus is missing ${required}`);
  }

  await withTempStore(async (dir) => {
    const variables = new Map<string, unknown>([
      ["fixtureCwd", dir],
      ...Object.entries(corpus.projectionFixtures).map(([name, value]) => [`${name}Projection`, value] as const),
    ]);
    const fixtureRoot = join(dir, "corpus-fixtures");
    await mkdir(fixtureRoot, { recursive: true });
    for (const [name, value] of Object.entries(corpus.fixtures)) {
      const path = join(fixtureRoot, `${name}.json`);
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
      variables.set(name, path);
    }

    for (const fixture of corpus.cases) {
      for (const arrangement of fixture.arrange ?? []) {
        const arranged = resolveGoldenValue(arrangement, variables) as GoldenArrangement;
        if (arranged.kind === "write-store-file") {
          const path = join(dir, arranged.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, arranged.contents);
          continue;
        }
        if (arranged.kind === "save-session") {
          await saveSession(arranged.session);
          continue;
        }
        if (arranged.kind === "attach-bee") {
          await attachBeeToRun({
            runId: arranged.runId,
            beeName: arranged.beeName,
            entryNodeId: arranged.entryNodeId,
            deliver: false,
            now: () => Date.parse(arranged.now),
          });
          continue;
        }
        if (arranged.kind === "reconcile-machine") {
          await mutateRun(arranged.runId, (run) => {
            reconcileMachine(run, arranged.now);
          });
          continue;
        }
        if (arranged.kind === "link-human-packet") {
          await mutateRun(arranged.runId, (run) => {
            const activation = run.activations[arranged.activationId];
            assert.ok(activation, `${fixture.id}: missing arranged activation ${arranged.activationId}`);
            const packet = corpusHumanPacket(run, activation, arranged.packetId, "needs_review", null, arranged.now);
            const digest = canonicalDigest(packet as unknown as JsonValue);
            activation.status = "waiting-human";
            activation.startedAt = arranged.now;
            activation.claim.attemptStartedAt = arranged.now;
            activation.packetId = packet.id;
            activation.packetDigest = digest;
            activation.threadId = `${activation.address.nodeId}#${activation.address.itemIndex}`;
            activation.blockingSince = arranged.now;
            run.packetThreads.push({
              key: activation.threadId,
              nodeId: activation.address.nodeId,
              itemIndex: activation.address.itemIndex,
              packetCount: 1,
              packetTail: [{
                packetId: packet.id,
                snapshotRevision: activation.nodeSnapshotRevision,
                definitionDigest: run.currentSnapshot.definitionDigest,
                actionBindingDigest: run.currentSnapshot.actionBindingDigest,
                subject: activation.subject,
                status: "current",
                createdAt: arranged.now,
              }],
              currentPacketId: packet.id,
              subject: activation.subject,
              createdAt: arranged.now,
              updatedAt: arranged.now,
            });
            recordRunEvent(run, "comb.activation.waiting_human", activation.address, {
              packetId: packet.id,
              packetDigest: digest,
              threadId: activation.threadId,
            });
            variables.set(arranged.capturePacketDigest, digest);
          });
          continue;
        }
        if (arranged.kind === "ingest-forum-verdict") {
          await mutateRun(arranged.runId, async (run) => {
            const activation = run.activations[arranged.activationId];
            assert.ok(activation, `${fixture.id}: missing arranged activation ${arranged.activationId}`);
            const expected = run.packetThreads
              .find((thread) => thread.key === activation.threadId)
              ?.packetTail.find((packet) => packet.packetId === arranged.packetId);
            assert.ok(expected, `${fixture.id}: missing arranged packet ref ${arranged.packetId}`);
            const packet = corpusHumanPacket(
              run,
              activation,
              arranged.packetId,
              "approved",
              {
                packet_id: arranged.packetId,
                verdict: "approve",
                comment: arranged.comment,
                destination: { type: "new-agent" },
                actor: arranged.actor,
                definition_digest: arranged.verdictDefinitionDigest ?? expected.definitionDigest,
                action_binding_digest: expected.actionBindingDigest,
                subject_revision: expected.subject.revision,
                recorded_at: arranged.now,
              },
              activation.blockingSince ?? arranged.now,
            );
            const ingested = await ingestForumVerdictEvidence(run, activation, packet, expected);
            assert.equal(
              ingested.result,
              arranged.expectedResult ?? "match",
              `${fixture.id}: verdict arrangement result`,
            );
            variables.set(arranged.captureEvidenceId, activation.evidenceTail.at(-1)!.id);
            if (ingested.result !== "match") return;
            assert.ok(ingested.verdict);
            applyHumanVerdict(run, activation, {
              verdict: ingested.verdict.verdict,
              comment: ingested.verdict.comment,
              destination: ingested.verdict.destination,
            }, arranged.now);
            reconcileMachine(run, arranged.now);
          });
          continue;
        }
        if (arranged.kind === "ingest-late-seal") {
          await mutateRun(arranged.runId, async (run) => {
            const activation = run.activations[arranged.activationId];
            assert.ok(activation, `${fixture.id}: missing arranged activation ${arranged.activationId}`);
            activation.invalidatedAt = arranged.invalidatedAt;
            const result = await ingestSealEvidence(
              run,
              activation,
              arranged.filename,
              arranged.seal,
            );
            assert.equal(result, "late-invalidated", `${fixture.id}: late seal must be inert`);
            variables.set(arranged.captureEvidenceId, activation.evidenceTail.at(-1)!.id);
          });
          continue;
        }
        await mutateRun(arranged.runId, async (run) => {
          const activation = run.activations[arranged.activationId];
          assert.ok(activation, `${fixture.id}: missing arranged activation ${arranged.activationId}`);
          const result = await ingestSealEvidence(
            run,
            activation,
            arranged.filename,
            arranged.seal,
          );
          assert.equal(result, "match", `${fixture.id}: seal arrangement must match`);
          const ref = activation.evidenceTail.at(-1);
          assert.ok(ref, `${fixture.id}: seal arrangement did not retain evidence`);
          variables.set(arranged.captureEvidenceId, ref.id);
          const envelope = await readEvidence(run.id, ref);
          assertGoldenMatch(
            envelope,
            resolveGoldenValue(corpus.projectionFixtures[arranged.assertProjection], variables),
            `${fixture.id}.projection.${arranged.assertProjection}`,
          );
        });
      }

      assert.ok(fixture.argv, `${fixture.id}: missing executable argv`);
      const argv = resolveGoldenValue(fixture.argv, variables) as string[];
      if (argv[0] !== "comb") {
        const actual = await invokeFullCli(argv);
        assert.equal(actual.exitCode, fixture.exitCode, `${fixture.id}: exit code`);
        assertGoldenMatch(actual.stderr.trim(), resolveGoldenValue(fixture.stderr, variables), `${fixture.id}.stderr`);
        continue;
      }
      assert.ok(fixture.stdout, `${fixture.id}: comb command must declare stdout`);
      const actual = await invoke(argv.slice(1), fixture.fault);

      for (const [name, pointer] of Object.entries(fixture.capture ?? {})) {
        variables.set(name, resolvePointer(actual.envelope, pointer, fixture.id));
      }
      assert.equal(actual.exitCode, fixture.exitCode, `${fixture.id}: exit code`);
      assertGoldenMatch(
        actual.envelope,
        resolveGoldenValue(fixture.stdout, variables),
        `${fixture.id}.stdout`,
      );
    }
  });
});

async function invokeFullCli(
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...argv],
      {
        cwd: process.cwd(),
        env: { ...process.env, HIVE_BEE: "", NO_COLOR: "1" },
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

function corpusHumanPacket(
  run: Parameters<typeof reconcileMachine>[0],
  activation: Parameters<typeof applyHumanVerdict>[1],
  packetId: string,
  status: ForumPacket["status"],
  verdict: ForumPacket["verdict"],
  blockingSince: string,
): ForumPacket {
  return {
    id: packetId,
    title: "Corpus human verification",
    status,
    kind: "code",
    origin: "comb",
    cwd: run.cwd,
    summary: "Public seam corpus packet",
    checklist: [{ text: "Work is correct", done: false }],
    native_session_id: null,
    blocking_since: blockingSince,
    run_id: run.id,
    comb_name: run.currentSnapshot.definition.name,
    base_rev: null,
    proposed_rev: activation.nodeSnapshotRevision,
    graph_base: null,
    graph_proposed: null,
    definition_digest: run.currentSnapshot.definitionDigest,
    action_binding_digest: run.currentSnapshot.actionBindingDigest,
    subject_revision: activation.subject.revision,
    verdict,
  };
}

function resolvePointer(value: unknown, pointer: string, fixtureId: string): unknown {
  assert.match(pointer, /^($|\/)/, `${fixtureId}: capture pointer must be RFC 6901`);
  let current = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    assert.ok(current !== null && typeof current === "object", `${fixtureId}: ${pointer} did not resolve`);
    current = (current as Record<string, unknown>)[key];
  }
  assert.notEqual(current, undefined, `${fixtureId}: ${pointer} did not resolve`);
  return current;
}

function resolveGoldenValue(value: unknown, variables: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = /^\$([A-Za-z][A-Za-z0-9]*)$/.exec(value);
    if (exact && variables.has(exact[1]!)) {
      return resolveGoldenValue(variables.get(exact[1]!), variables);
    }
    return value.replace(/\$([A-Za-z][A-Za-z0-9]*)/g, (whole, name: string) => {
      const replacement = variables.get(name);
      return typeof replacement === "string" || typeof replacement === "number"
        ? String(replacement)
        : whole;
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveGoldenValue(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveGoldenValue(item, variables)]),
    );
  }
  return value;
}

function assertGoldenMatch(actual: unknown, expected: unknown, path: string): void {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const matcher = expected as Record<string, unknown>;
    if ("$type" in matcher) {
      const type = matcher.$type;
      const matches = type === "array"
        ? Array.isArray(actual)
        : type === "object"
          ? actual !== null && typeof actual === "object" && !Array.isArray(actual)
          : type === "integer"
            ? Number.isInteger(actual)
            : typeof actual === type;
      assert.equal(matches, true, `${path}: expected type ${String(type)}, received ${typeof actual}`);
    }
    if ("$pattern" in matcher) {
      assert.equal(typeof actual, "string", `${path}: pattern target must be a string`);
      assert.match(actual as string, new RegExp(String(matcher.$pattern)), path);
    }
    if ("$contains" in matcher) {
      assert.ok(Array.isArray(actual), `${path}: $contains target must be an array`);
      for (const [index, wanted] of (matcher.$contains as unknown[]).entries()) {
        let matched = false;
        for (const candidate of actual) {
          try {
            assertGoldenMatch(candidate, wanted, `${path}.$contains[${index}]`);
            matched = true;
            break;
          } catch {
            // Try the next candidate; the final assertion reports the missing fixture.
          }
        }
        assert.equal(matched, true, `${path}: no array element matched $contains[${index}]`);
      }
    }
    if (Array.isArray(matcher.$required)) {
      assert.ok(actual && typeof actual === "object", `${path}: $required target must be an object`);
      for (const key of matcher.$required as string[]) {
        assert.ok(key in (actual as Record<string, unknown>), `${path}: missing required key ${key}`);
      }
    }
    const fields = Object.entries(matcher).filter(([key]) => !key.startsWith("$"));
    if (fields.length > 0) {
      assert.ok(actual && typeof actual === "object" && !Array.isArray(actual), `${path}: expected object`);
      for (const [key, child] of fields) {
        const record = actual as Record<string, unknown>;
        const optional = child && typeof child === "object" && !Array.isArray(child) &&
          (child as Record<string, unknown>).$optional === true;
        if (!(key in record) && optional) continue;
        assert.ok(key in record, `${path}: missing key ${key}`);
        assertGoldenMatch(record[key], child, `${path}.${key}`);
      }
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected array`);
    assert.equal(actual.length, expected.length, `${path}: array length`);
    expected.forEach((item, index) => assertGoldenMatch(actual[index], item, `${path}[${index}]`));
    return;
  }
  assert.deepEqual(actual, expected, path);
}

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
