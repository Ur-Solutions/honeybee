import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const controls = await import(pathToFileURL(join(process.cwd(), "scripts", "test-process-control.mjs")).href) as {
  signalExitCode: (signal: NodeJS.Signals) => number;
  terminateTestProcessTree: (
    child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
    signal: NodeJS.Signals,
    options?: {
      platform?: NodeJS.Platform;
      graceMs?: number;
      sendSignal?: (pid: number, signal: NodeJS.Signals | 0) => true;
      sleep?: (ms: number) => Promise<void>;
    },
  ) => Promise<void>;
};

test("test runner maps forwarded termination signals to shell exit codes", () => {
  assert.equal(controls.signalExitCode("SIGINT"), 130);
  assert.equal(controls.signalExitCode("SIGTERM"), 143);
  assert.equal(controls.signalExitCode("SIGHUP"), 1);
});

test("test runner terminates the complete POSIX worker process group", async () => {
  const calls: Array<[number, NodeJS.Signals | 0]> = [];
  await controls.terminateTestProcessTree(
    { pid: 4321, kill: () => true },
    "SIGINT",
    {
      platform: "darwin",
      graceMs: 1,
      sendSignal: (pid, signal) => {
        calls.push([pid, signal]);
        if (signal === 0) {
          const error = Object.assign(new Error("gone"), { code: "ESRCH" });
          throw error;
        }
        return true;
      },
      sleep: async () => undefined,
    },
  );

  assert.deepEqual(calls, [
    [-4321, "SIGINT"],
    [-4321, 0],
  ]);
});

test("test runner falls back to the direct child signal off POSIX", async () => {
  const signals: Array<NodeJS.Signals | undefined> = [];
  await controls.terminateTestProcessTree(
    { pid: 4321, kill: (signal) => (signals.push(signal), true) },
    "SIGTERM",
    { platform: "win32" },
  );
  assert.deepEqual(signals, ["SIGTERM"]);
});
