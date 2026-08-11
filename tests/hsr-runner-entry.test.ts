import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  HSR_HOST_POLL_INTERVAL_MS,
  dedicatedHsrEntryCandidate,
  hsrEntryArgv,
  inheritableExecArgvForHsr,
  resolveHsrEntry,
  waitForHsrHost,
} from "../src/hsr/runnerHost.js";
import {
  applyCellEnvironmentStamp,
  applyCellGithubCredential,
  cellSpaceKeyForCwd,
} from "../src/hsr/runner-entry.js";

const execFileAsync = promisify(execFile);

test("cellSpaceKeyForCwd names the space from either Cell layout and stays silent otherwise", () => {
  // Layout v1: the Cell cwd IS the kaia space directory.
  assert.equal(cellSpaceKeyForCwd("/cells/honeybee-space-y2y8meccja7t"), "honeybee-space-y2y8meccja7t");
  // Layout v2: `<wrapper>/<repo>-space-<id>` — the checkout is the space dir.
  assert.equal(
    cellSpaceKeyForCwd("/cells/honeybee-space-ab12cd34ef56/honeybee-space-y2y8meccja7t"),
    "honeybee-space-y2y8meccja7t",
  );
  // A cwd one level inside a space dir still resolves via the parent.
  assert.equal(cellSpaceKeyForCwd("/cells/apiary-space-77/checkout"), "apiary-space-77");
  assert.equal(cellSpaceKeyForCwd("/home/user/ordinary-checkout"), undefined);
  assert.equal(cellSpaceKeyForCwd("/tmp/space-station/repo"), undefined, "bare 'space-' prefix is not a Cell");
});

test("Cell spawns are stamped HIVE_CELL=1 + HIVE_CELL_SPACE; non-Cell spawns are scrubbed", () => {
  const cellEnv: Record<string, string> = { PATH: "/usr/bin" };
  applyCellEnvironmentStamp(cellEnv, {
    filesystemWriteScope: "cwd",
    cwd: "/cells/honeybee-space-y2y8meccja7t",
  });
  assert.equal(cellEnv.HIVE_CELL, "1");
  assert.equal(cellEnv.HIVE_CELL_SPACE, "honeybee-space-y2y8meccja7t");

  // Unknown space: the containment marker still lands, the space stamp does
  // not — and a stale inherited value never leaks through.
  const anonymous: Record<string, string> = { HIVE_CELL_SPACE: "stale-space-1" };
  applyCellEnvironmentStamp(anonymous, { filesystemWriteScope: "cwd", cwd: "/somewhere/plain" });
  assert.equal(anonymous.HIVE_CELL, "1");
  assert.equal("HIVE_CELL_SPACE" in anonymous, false);

  // Non-Cell spawn: ambient stamps from a Cell-hosted parent must be removed.
  const plain: Record<string, string> = { HIVE_CELL: "1", HIVE_CELL_SPACE: "honeybee-space-y2y8meccja7t" };
  applyCellEnvironmentStamp(plain, { cwd: "/home/user/repo" });
  assert.equal("HIVE_CELL" in plain, false);
  assert.equal("HIVE_CELL_SPACE" in plain, false);
});

test("Cell spawns borrow the host gh session token; explicit tokens and opt-out win", async () => {
  const cell = (): Parameters<typeof applyCellGithubCredential>[1] => ({ filesystemWriteScope: "cwd" });

  const stamped: Record<string, string> = {};
  await applyCellGithubCredential(stamped, cell(), async () => "gho_host_session_token\n");
  assert.equal(stamped.GH_TOKEN, "gho_host_session_token");

  // Non-Cell spawns are never stamped — the operator env already governs.
  const plain: Record<string, string> = {};
  await applyCellGithubCredential(plain, {}, async () => "gho_host_session_token");
  assert.equal("GH_TOKEN" in plain, false);

  // An explicit spawn-env credential always wins over the borrowed session.
  const explicit: Record<string, string> = { GITHUB_TOKEN: "ghs_explicit" };
  await applyCellGithubCredential(explicit, cell(), async () => "gho_host_session_token");
  assert.equal("GH_TOKEN" in explicit, false);

  // HIVE_CELL_GH=0 on the host opts the machine out entirely.
  process.env.HIVE_CELL_GH = "0";
  try {
    const opted: Record<string, string> = {};
    await applyCellGithubCredential(opted, cell(), async () => "gho_host_session_token");
    assert.equal("GH_TOKEN" in opted, false);
  } finally {
    delete process.env.HIVE_CELL_GH;
  }

  // Not-a-token shapes (gh error prose, empties) and resolver failures are
  // soft: the Cell simply stays unauthenticated.
  const prose: Record<string, string> = {};
  await applyCellGithubCredential(prose, cell(), async () => "no oauth token found\n");
  assert.equal("GH_TOKEN" in prose, false);
  const empty: Record<string, string> = {};
  await applyCellGithubCredential(empty, cell(), async () => "  \n");
  assert.equal("GH_TOKEN" in empty, false);
  const failing: Record<string, string> = {};
  await applyCellGithubCredential(failing, cell(), async () => { throw new Error("gh missing"); });
  assert.equal("GH_TOKEN" in failing, false);
});

test("resolveHsrEntry derives source and built entries from the runnerHost module", async () => {
  const sourcePaths = new Map([
    ["/linked/runnerHost", "/pkg/src/hsr/runnerHost.ts"],
    ["/pkg/src/hsr/runner-entry.ts", "/pkg/src/hsr/runner-entry.ts"],
  ]);
  const source = await resolveHsrEntry("/linked/runnerHost", async (path) => {
    const resolved = sourcePaths.get(path);
    if (!resolved) throw new Error("ENOENT");
    return resolved;
  });
  assert.deepEqual(source, { path: "/pkg/src/hsr/runner-entry.ts", mode: "dedicated" });
  assert.deepEqual(hsrEntryArgv(source, "/tmp/payload.json"), [
    "/pkg/src/hsr/runner-entry.ts",
    "/tmp/payload.json",
  ]);

  const built = await resolveHsrEntry("/pkg/dist/hsr/runnerHost.js", async (path) => path);
  assert.deepEqual(built, { path: "/pkg/dist/hsr/runner-entry.js", mode: "dedicated" });
});

test("resolveHsrEntry fails closed instead of relaunching an embedding test file", async () => {
  await assert.rejects(
    () => resolveHsrEntry("/pkg/tests/hsr-child-admission.test.ts", async (path) => {
      if (path.endsWith("hsr-child-admission.test.ts")) return path;
      throw new Error("ENOENT");
    }),
    /dedicated runner entry unavailable.*tests\/runner-entry\.ts/,
  );
  await assert.rejects(() => resolveHsrEntry(""), /runnerHost module entry path/);
});

test("hsrEntryArgv retains an explicit __hsr-run compatibility entry", () => {
  const fallback = { path: "/pkg/dist/cli.js", mode: "cli-fallback" } as const;
  assert.deepEqual(fallback, { path: "/pkg/dist/cli.js", mode: "cli-fallback" });
  assert.deepEqual(hsrEntryArgv(fallback, "/tmp/payload.json"), [
    "/pkg/dist/cli.js",
    "__hsr-run",
    "/tmp/payload.json",
  ]);
  assert.equal(dedicatedHsrEntryCandidate("/usr/local/bin/hive"), undefined);
});

test("inheritableExecArgvForHsr preserves only source loaders, never embedding execution modes", () => {
  const original = process.execArgv;
  try {
    process.execArgv = [
      "--input-type=module",
      "-e",
      "spawnHsrHost()",
      "--require",
      "/pkg/preflight.cjs",
      "--import",
      "tsx",
      "--test",
      "--test-reporter",
      "spec",
      "--test-concurrency=1",
      "--watch",
      "--watch-path",
      "src",
      "--inspect=0",
      "--loader=file:///pkg/loader.mjs",
      "-r/pkg/register.cjs",
    ];
    assert.deepEqual(inheritableExecArgvForHsr(), [
      "--require",
      "/pkg/preflight.cjs",
      "--import",
      "tsx",
      "--loader=file:///pkg/loader.mjs",
      "-r/pkg/register.cjs",
    ]);
  } finally {
    process.execArgv = original;
  }
});

test("waitForHsrHost observes newly published meta on the 10ms cadence", async () => {
  let now = 0;
  let probes = 0;
  const delays: number[] = [];
  const ready = await waitForHsrHost("bee", 100, {
    now: () => now,
    hasSession: async () => ++probes === 2,
    sleep: async (ms) => {
      delays.push(ms);
      now += ms;
    },
  });

  assert.equal(ready, true);
  assert.equal(HSR_HOST_POLL_INTERVAL_MS, 10);
  assert.equal(now, 10);
  assert.deepEqual(delays, [10]);
});

test("waitForHsrHost caps its final sleep at the unchanged timeout deadline", async () => {
  let now = 0;
  let probes = 0;
  const delays: number[] = [];
  const ready = await waitForHsrHost("bee", 25, {
    now: () => now,
    hasSession: async () => {
      probes += 1;
      return false;
    },
    sleep: async (ms) => {
      delays.push(ms);
      now += ms;
    },
  });

  assert.equal(ready, false);
  assert.equal(now, 25);
  assert.equal(probes, 3);
  assert.deepEqual(delays, [10, 10, 5]);
});

test("the dedicated source entry and __hsr-run fallback both remain executable under tsx", async () => {
  for (const argv of [
    ["src/hsr/runner-entry.ts"],
    ["src/cli.ts", "__hsr-run"],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", ...argv], { cwd: process.cwd() }),
      (error: Error & { code?: number | string; stderr?: string }) => {
        assert.equal(error.code, 1, argv.join(" "));
        assert.match(error.stderr ?? "", /hive __hsr-run: missing payload path/);
        return true;
      },
    );
  }
});
