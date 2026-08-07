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

const execFileAsync = promisify(execFile);

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
