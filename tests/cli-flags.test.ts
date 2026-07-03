import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

async function hiveExpectFail(dir: string, ...args: string[]): Promise<string> {
  try {
    await hive(dir, ...args);
    throw new Error(`expected command to fail: hive ${args.join(" ")}`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    return err.stderr ?? "";
  }
}

async function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-flags-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedSession(dir: string, name: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const record = {
    name,
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget: `tg-${name}`,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "running",
    id: name,
    ...overrides,
  };
  await writeFile(join(sessionsDir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function seedArgsFlow(dir: string): Promise<void> {
  const flowsDir = join(dir, "flows");
  await mkdir(flowsDir, { recursive: true });
  const sdk = join(process.cwd(), "src/flow/index.ts");
  await writeFile(
    join(flowsDir, "arg-types.ts"),
    `import { defineFlow } from "${sdk}";\n` +
    `export default defineFlow({ name: "arg-types", run: async (ctx) => ctx.args });\n`,
    { mode: 0o600 },
  );
}

function parseFlowRunId(stdout: string, flowName: string): string {
  const match = new RegExp(`^flow\\.run\\t${flowName}\\t([^\\t\\n]+)`, "m").exec(stdout);
  assert.ok(match, `expected flow.run line in stdout:\n${stdout}`);
  return match[1]!;
}

// ─── valueless string flags must not become the literal "true" ───────────

test("hive send rejects a bare -p / --prompt with no value", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    assert.match(await hiveExpectFail(dir, "send", "some-bee", "-p"), /-p requires a value/);
    assert.match(await hiveExpectFail(dir, "send", "some-bee", "--prompt", "--json"), /--prompt requires a value/);
  });
});

test("hive run / x / brief reject a bare prompt flag; spawn rejects bare --cwd", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    assert.match(await hiveExpectFail(dir, "run", "codex", "-p"), /-p requires a value/);
    assert.match(await hiveExpectFail(dir, "x", "codex", "--prompt"), /--prompt requires a value/);
    assert.match(await hiveExpectFail(dir, "brief", "some-bee", "--brief"), /--brief requires a value/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--cwd"), /--cwd requires a value/);
  });
});

// ─── spawn --count validation + incompatible flag combinations ───────────

test("hive spawn validates --count from the raw flag value", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--count", "0"), /--count must be an integer >= 2/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--count", "nope"), /--count must be an integer >= 2/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--count"), /--count must be an integer >= 2/);
  });
});

test("hive spawn rejects --name/--brief with --count > 1 and --name/--brief with --frame", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--count", "2", "--name", "x"), /--name cannot be combined with --count/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--count", "2", "--brief", "hello"), /--brief\/--briefed cannot be combined with --count/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--count", "2", "--briefed"), /--brief\/--briefed cannot be combined with --count/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--frame", "any", "--name", "x"), /--name cannot be combined with --frame/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--frame", "any", "--brief", "hello"), /--brief cannot be combined with --frame/);
  });
});

test("hive run refuses swarm spawns (--count / --frame)", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    assert.match(await hiveExpectFail(dir, "run", "codex", "-p", "hi", "--count", "2"), /hive run spawns a single bee/);
    assert.match(await hiveExpectFail(dir, "run", "codex", "-p", "hi", "--frame", "review"), /hive run spawns a single bee/);
  });
});

// ─── node management ──────────────────────────────────────────────────────

test("hive node register/update reject --ssh-args without the = form", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    const stderr = await hiveExpectFail(dir, "node", "register", "mini01", "--kind", "ssh-tmux", "--endpoint", "u@h", "--ssh-args", "-F");
    assert.match(stderr, /--ssh-args requires a value; use --ssh-args="-F \/path\/to\/config"/);
    // Nothing was registered.
    assert.match(await hiveExpectFail(dir, "node", "inspect", "mini01"), /Unknown node/);

    await hive(dir, "node", "register", "mini01", "--kind", "ssh-tmux", "--endpoint", "u@h");
    const update = await hiveExpectFail(dir, "node", "update", "mini01", "--ssh-args", "-F");
    assert.match(update, /--ssh-args requires a value/);
    // The = form works.
    await hive(dir, "node", "update", "mini01", "--ssh-args=-F /tmp/cfg");
    const inspect = await hive(dir, "node", "inspect", "mini01");
    assert.deepEqual(JSON.parse(inspect.stdout).sshArgs, ["-F", "/tmp/cfg"]);
  });
});

test("hive node unregister refuses while bees reference the node, unless --force", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    await hive(dir, "node", "register", "mini01", "--kind", "ssh-tmux", "--endpoint", "u@h");
    await seedSession(dir, "remote-bee", { node: "mini01" });

    const stderr = await hiveExpectFail(dir, "node", "unregister", "mini01");
    assert.match(stderr, /still has 1 bee\(s\): remote-bee/);
    assert.match(stderr, /--force/);

    const forced = await hive(dir, "node", "unregister", "mini01", "--force");
    assert.match(forced.stdout, /unregistered\tmini01/);
  });
});

// ─── --substrate alias validation ─────────────────────────────────────────

test("hive spawn --substrate validates kind prefixes", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--substrate", "ssh:"), /missing node name after the kind prefix/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--substrate", "docker:mini01"), /unknown kind "docker"/);
    assert.match(await hiveExpectFail(dir, "spawn", "codex", "--substrate", "ssh:local"), /requests kind ssh-tmux, but node "local" is local-tmux/);
  });
});

// ─── loop logs / status ───────────────────────────────────────────────────

async function seedLoop(dir: string, loopId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const loopDir = join(dir, "loops", loopId);
  await mkdir(loopDir, { recursive: true });
  const cfg = {
    loopId,
    bee: "codex",
    cwd: "/tmp",
    context: "ralph",
    carrier: "fresh",
    memory: "none",
    prompt: "go",
    stop: { max: null, maxDurationMs: null, forever: true, until: null, stopOnSeal: [], stopOnSentinel: null, judge: null },
    summarizer: "self",
    yolo: false,
    status: "stopped",
    iteration: 1,
    startedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
  await writeFile(join(loopDir, "loop.json"), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

test("hive loop logs --iter validates its value and reports missing iteration logs", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    await seedLoop(dir, "lp1");
    assert.match(await hiveExpectFail(dir, "loop", "logs", "lp1", "--iter"), /--iter requires an iteration number/);
    assert.match(await hiveExpectFail(dir, "loop", "logs", "lp1", "--iter", "1", "-f"), /--iter cannot be combined with -f\/--follow/);
    assert.match(await hiveExpectFail(dir, "loop", "logs", "lp1", "--iter", "99"), /No log for iteration 99 of loop lp1/);
  });
});

test("hive loop logs -n prints exactly n lines even without a trailing newline", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    await seedLoop(dir, "lp1");
    const logDir = join(dir, "flows", "loop", "runs", "lp1");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "log.txt"), "one\ntwo\nthree");
    const noTrailing = await hive(dir, "loop", "logs", "lp1", "-n", "2");
    assert.equal(noTrailing.stdout, "two\nthree\n");

    await writeFile(join(logDir, "log.txt"), "one\ntwo\nthree\n");
    const trailing = await hive(dir, "loop", "logs", "lp1", "-n", "2");
    assert.equal(trailing.stdout, "two\nthree\n");
  });
});

// A pid far above any plausible live process; process.kill(pid, 0) -> ESRCH.
const DEAD_PID = 1_000_000;

test("hive loop status/list downgrade a running loop with a dead driver pid to orphaned", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    await seedLoop(dir, "lp1", { status: "running", pid: DEAD_PID });

    const status = await hive(dir, "loop", "status", "lp1");
    assert.match(status.stdout, /\torphaned\t/);

    const json = await hive(dir, "loop", "status", "lp1", "--json");
    assert.equal(JSON.parse(json.stdout).status, "orphaned");

    const list = await hive(dir, "loop", "list");
    assert.match(list.stdout, /loop\.run\tlp1\tralph\torphaned\t/);
  });
});

test("hive loop status/list downgrade a stale pid-less running loop to orphaned", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    await seedLoop(dir, "lp1", { status: "running", startedAt: "2000-01-01T00:00:00.000Z" });

    const status = await hive(dir, "loop", "status", "lp1");
    assert.match(status.stdout, /\torphaned\t/);

    const json = await hive(dir, "loop", "status", "lp1", "--json");
    assert.equal(JSON.parse(json.stdout).status, "orphaned");

    const list = await hive(dir, "loop", "list");
    assert.match(list.stdout, /loop\.run\tlp1\tralph\torphaned\t/);
  });
});

// ─── flow status --json emits the reconciled status ───────────────────────

test("hive flow status --json reports orphaned for a running meta with a dead pid", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    const runDir = join(dir, "flows", "myflow", "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    const meta = {
      runId: "run-1",
      flowName: "myflow",
      args: {},
      status: "running",
      startedAt: "2026-06-01T00:00:00.000Z",
      pid: DEAD_PID,
    };
    await writeFile(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

    const { stdout } = await hive(dir, "flow", "status", "run-1", "--json");
    assert.equal(JSON.parse(stdout).meta.status, "orphaned");
  });
});

test("hive flow run --arg preserves values that do not round-trip through Number", { timeout: 30_000 }, async () => {
  await withStore(async (dir) => {
    await seedArgsFlow(dir);

    const { stdout } = await hive(
      dir,
      "flow",
      "run",
      "arg-types",
      "--foreground",
      "--arg",
      "zip=01234",
      "--arg",
      "version=1.10",
      "--arg",
      "id=007",
      "--arg",
      "large=9007199254740993",
      "--arg",
      "flag=false",
      "--arg",
      "truth=true",
      "--arg",
      "count=12",
      "--arg",
      "ratio=1.25",
    );
    const runId = parseFlowRunId(stdout, "arg-types");
    const result = JSON.parse(await readFile(join(dir, "flows", "arg-types", "runs", runId, "result.json"), "utf8")) as {
      value: Record<string, unknown>;
    };

    assert.deepEqual(result.value, {
      zip: "01234",
      version: "1.10",
      id: "007",
      large: "9007199254740993",
      flag: "false",
      truth: "true",
      count: 12,
      ratio: 1.25,
    });
  });
});
