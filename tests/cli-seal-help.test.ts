import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { getCompletionsFromState } from "../src/completion.js";
import { SEAL_STATUSES, SEAL_TYPES, TEST_RUN_RESULTS, validateSealArtifact } from "../src/seal.js";

const execFileAsync = promisify(execFile);
const emptyCompletionState = { records: [], liveTargets: new Set<string>() };

async function hive(store: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HIVE_STORE_ROOT: store, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" },
  });
}

async function withTempStore(fn: (store: string) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "hive-seal-help-"));
  try {
    await fn(store);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
}

test("hive seal --help prints the complete contract and self-seal recipe without a target", async () => {
  await withTempStore(async (store) => {
    const { stdout, stderr } = await hive(store, "seal", "--help");
    assert.equal(stderr, "");
    assert.match(stdout, /Usage\n  hive seal <selector> --from <path-to-seal\.json>/);
    for (const field of ["status", "summary", "type", "filesChanged", "testsRun", "command", "result", "notes", "risks", "nextActions", "confidence"]) {
      assert.match(stdout, new RegExp(`\\b${field}\\b`), `help includes ${field}`);
    }
    for (const value of [...SEAL_STATUSES, ...SEAL_TYPES, ...TEST_RUN_RESULTS]) {
      assert.match(stdout, new RegExp(`\\b${value}\\b`), `help includes enum value ${value}`);
    }
    assert.match(stdout, /bee="\$\(hive here --id\)"/);
    assert.match(stdout, /hive seal "\$bee" --from "\$artifact"/);
    assert.doesNotThrow(() => validateSealArtifact(JSON.parse(extractExample(stdout))));
    assert.deepEqual(await readdir(store), [], "help must not mutate Hive state");
  });
});

test("hive help seal routes to the same detailed help", async () => {
  await withTempStore(async (store) => {
    const direct = await hive(store, "seal", "--help");
    const routed = await hive(store, "help", "seal");
    assert.equal(routed.stderr, "");
    assert.equal(routed.stdout, direct.stdout);
    assert.deepEqual(await readdir(store), []);
  });
});

test("hive seal --example prints valid JSON without a target or state mutation", async () => {
  await withTempStore(async (store) => {
    const { stdout, stderr } = await hive(store, "seal", "--example");
    assert.equal(stderr, "");
    const parsed = JSON.parse(stdout) as unknown;
    const artifact = validateSealArtifact(parsed);
    assert.equal(artifact.status, "done");
    assert.ok(artifact.filesChanged?.length);
    assert.ok(artifact.testsRun?.length);
    assert.deepEqual(await readdir(store), [], "example must not mutate Hive state");
  });
});

test("seal completion advertises help and example modes", () => {
  const flags = getCompletionsFromState(["hive", "seal", "--"], emptyCompletionState);
  assert.ok(flags.includes("--from"));
  assert.ok(flags.includes("--help"));
  assert.ok(flags.includes("--example"));
});

function extractExample(help: string): string {
  const match = help.match(/Example artifact JSON\n([\s\S]*?)\n\nSelf-seal the current bee/);
  assert.ok(match, "help contains a JSON example section");
  return match[1]!;
}
