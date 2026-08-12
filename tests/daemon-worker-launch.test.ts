import assert from "node:assert/strict";
import { test } from "node:test";
import {
  daemonCliEntryForModule,
  daemonWorkerArgv,
  inheritableExecArgvForDaemonWorker,
} from "../src/daemon/workerLaunch.js";

test("daemon worker entry is anchored to its module, never the embedding test entry", () => {
  assert.equal(
    daemonCliEntryForModule("file:///repo/src/daemon/sessionListProcess.ts"),
    "/repo/src/cli.ts",
  );
  assert.equal(
    daemonCliEntryForModule("file:///repo/dist/daemon/observerProcess.js"),
    "/repo/dist/cli.js",
  );
});

test("daemon workers inherit source loaders but drop test and inspector execution modes", () => {
  assert.deepEqual(
    inheritableExecArgvForDaemonWorker([
      "--test",
      "--test-concurrency=16",
      "--inspect=0",
      "--require",
      "/pkg/preflight.cjs",
      "--import",
      "tsx",
      "--watch",
      "--loader=file:///pkg/loader.mjs",
      "-r/pkg/register.cjs",
    ]),
    [
      "--require",
      "/pkg/preflight.cjs",
      "--import",
      "tsx",
      "--loader=file:///pkg/loader.mjs",
      "-r/pkg/register.cjs",
    ],
  );
});

test("daemonWorkerArgv cannot recursively target process.argv[1]", () => {
  const original = process.execArgv;
  try {
    process.execArgv = ["--test", "--import", "tsx"];
    assert.deepEqual(
      daemonWorkerArgv("session-list-worker", "file:///repo/src/daemon/sessionListProcess.ts"),
      ["--import", "tsx", "/repo/src/cli.ts", "daemon", "session-list-worker"],
    );
  } finally {
    process.execArgv = original;
  }
});
