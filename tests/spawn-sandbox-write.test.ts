// `hive spawn --sandbox-write` (cell-smoothness Phase 2): the repeatable
// fs-grant seam Apiary's Cell Layout v2 rides. Covers the CLI flag shape, the
// help-probe contract, payload/record threading through spawnBee, replay on
// revive, and the execution launcher's v2 wrapper derivation.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolveSandboxWriteFlag,
  spawnBee,
  spawnSingleBee,
  type SpawnRuntimeDependencies,
} from "../src/commands/spawn.js";
import { reviveRecord } from "../src/commands/migrate.js";
import { buildHsrSpawnFlags, resolveHsrHarnessLaunchConfig } from "../src/execution/launcher.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import type { HsrRunPayload } from "../src/hsr/runnerHost.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { Parsed } from "../src/parse.js";

const HOST_PID = 47251;

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-sandbox-write-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = join(dir, "store");
  await mkdir(join(dir, "store"), { recursive: true });
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function parsedWith(flags: Map<string, string | true | string[]>, args: string[] = []): Parsed {
  return { command: "spawn", args, flags, rest: [] };
}

function admissionDeps(captured: HsrRunPayload[]): SpawnRuntimeDependencies {
  return {
    spawnHsrHost: async (payload) => {
      captured.push(payload);
      return HOST_PID;
    },
    readHsrMetaStrict: async (bee) => ({
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: HOST_PID,
      hostFingerprint: { pgid: HOST_PID, startedAt: "fake-host-birth" },
      childAdmission: "none",
      startedAt: "2026-08-07T00:00:00.000Z",
      controlSocket: "/tmp/fake-hsr-control.sock",
      status: "queued",
    }),
    stopHsrIncarnationByPid: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
  };
}

test("hive spawn usage advertises --sandbox-write (Apiary probes the help text for the literal flag)", async () => {
  await assert.rejects(
    spawnSingleBee(parsedWith(new Map())),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /--sandbox-write/);
      return true;
    },
  );
});

test("resolveSandboxWriteFlag accepts repeated absolute dirs and refuses relative or bare flags", () => {
  assert.equal(resolveSandboxWriteFlag(parsedWith(new Map())), undefined);
  assert.deepEqual(
    resolveSandboxWriteFlag(parsedWith(new Map([["sandbox-write", "/tmp/wrapper"]]))),
    ["/tmp/wrapper"],
  );
  assert.deepEqual(
    resolveSandboxWriteFlag(parsedWith(new Map([["sandbox-write", ["/tmp/a", "/tmp/b"]]]))),
    ["/tmp/a", "/tmp/b"],
  );
  assert.throws(
    () => resolveSandboxWriteFlag(parsedWith(new Map([["sandbox-write", "relative/dir"]]))),
    /absolute directory/,
  );
  assert.throws(
    () => resolveSandboxWriteFlag(parsedWith(new Map([["sandbox-write", true]]))),
    /absolute directory/,
  );
});

test("spawnBee threads --sandbox-write into the HSR payload and stamps the record", async () => {
  await withTempStore(async (dir) => {
    const wrapper = join(dir, "cells", "wrapper");
    const checkout = join(wrapper, "checkout");
    await mkdir(checkout, { recursive: true });
    const captured: HsrRunPayload[] = [];
    const record = await spawnBee({
      agent: "node",
      extraArgs: [],
      cwd: checkout,
      yolo: false,
      name: "sandbox-write-thread",
      substrate: "hsr",
      executionRunId: "run-sandbox-write",
      sandboxWriteRoots: [wrapper],
    }, admissionDeps(captured));

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.filesystemWriteScope, "cwd");
    assert.deepEqual(captured[0]!.extraWriteRoots, [wrapper]);
    assert.deepEqual(record.sandboxWriteRoots, [wrapper]);
    const persisted = await loadSession(record.name);
    assert.deepEqual(persisted?.sandboxWriteRoots, [wrapper], "the grants survive the record round-trip");
  });
});

test("protocol spawn argv ignores an ambient account-model overlay", async () => {
  await withTempStore(async (dir) => {
    const checkout = join(dir, "checkout");
    await mkdir(checkout, { recursive: true });
    const captured: HsrRunPayload[] = [];
    await spawnBee({
      agent: "claude",
      extraArgs: ["--model", "claude-sonnet-5", "--effort", "high"],
      cwd: checkout,
      yolo: false,
      name: "protocol-model-authority",
      substrate: "hsr",
      executionRunId: "run-protocol-model-authority",
      protocolLaunch: true,
      // This is the shape spawnSingleBee previously derived from the selected
      // account. It must not add a second selector or enter payload.model.
      model: "ambient-account-default",
    }, admissionDeps(captured));

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.model, undefined);
    assert.equal(captured[0]!.spec.args.includes("ambient-account-default"), false);
    const modelIndexes = captured[0]!.spec.args.flatMap((value, index) => value === "--model" ? [index] : []);
    assert.equal(modelIndexes.length, 1);
    assert.equal(captured[0]!.spec.args[modelIndexes[0]! + 1], "claude-sonnet-5");
  });
});

test("spawnBee fails fast on a guard-refused grant instead of launching the host", async () => {
  await withTempStore(async (dir) => {
    const cellsRoot = join(dir, "cells");
    const checkout = join(cellsRoot, "wrapper", "checkout");
    await mkdir(checkout, { recursive: true });
    const captured: HsrRunPayload[] = [];
    await assert.rejects(
      spawnBee({
        agent: "node",
        extraArgs: [],
        cwd: checkout,
        yolo: false,
        name: "sandbox-write-guard",
        substrate: "hsr",
        executionRunId: "run-sandbox-write-guard",
        // Two levels above the Cell: would fence in every sibling wrapper.
        sandboxWriteRoots: [cellsRoot],
      }, admissionDeps(captured)),
      /above the Cell/,
    );
    assert.equal(captured.length, 0, "the detached host is never forked on a refused grant");
  });
});

test("spawnBee refuses --sandbox-write on a remote node spawn (grants are local paths)", async () => {
  await withTempStore(async (dir) => {
    const wrapper = join(dir, "wrapper");
    await mkdir(wrapper, { recursive: true });
    await assert.rejects(
      spawnBee({
        agent: "node",
        extraArgs: [],
        cwd: dir,
        yolo: false,
        name: "sandbox-write-remote",
        node: { name: "far", kind: "ssh-tmux", host: "far.example" } as never,
        sandboxWriteRoots: [wrapper],
      }),
      /--sandbox-write grants local directories/,
    );
  });
});

test("revive replays the Cell write boundary and --sandbox-write grants from the record", async () => {
  await withTempStore(async (dir) => {
    const wrapper = join(dir, "cells", "wrapper");
    const checkout = join(wrapper, "checkout");
    await mkdir(checkout, { recursive: true });
    const bee = "sandbox-write-revive";
    const record: SessionRecord = {
      name: bee,
      agent: "codex",
      requestedAgent: "codex",
      cwd: checkout,
      command: process.execPath,
      launchArgv: [process.execPath],
      tmuxTarget: bee,
      substrate: "hsr",
      runnerPid: 999_983,
      id: bee,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      status: "running",
      executionRunId: "run-revive-cell",
      sandboxWriteRoots: [wrapper],
    };
    await saveSession(record);
    // A finalized previous incarnation: revive's strict pre-stop confirms it
    // without signalling (dead pid, child admission "none").
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "codex",
      tier: "stream",
      hostPid: 999_983,
      hostFingerprint: { pgid: 999_983, startedAt: "Fri Aug  7 10:00:00 2026" },
      childAdmission: "none",
      startupFailure: {
        stage: "adapter-start",
        message: "fixture provider was durably never started",
      },
      startedAt: "2026-08-07T00:00:00.000Z",
      controlSocket: join(dir, "gone.sock"),
      status: "exited",
    });

    const payloads: HsrRunPayload[] = [];
    await reviveRecord(record, {
      fresh: true,
      spawnHsrHost: async (payload) => {
        payloads.push(payload);
        // Publish an admitted meta for the fresh incarnation so revive's
        // birth-admission gate passes.
        await writeHsrMeta(bee, {
          bee,
          harness: "codex",
          tier: "stream",
          hostPid: HOST_PID,
          hostFingerprint: { pgid: HOST_PID, startedAt: "fresh-host-birth" },
          childAdmission: "none",
          startedAt: new Date().toISOString(),
          controlSocket: join(dir, "fresh.sock"),
          status: "running",
        });
        return HOST_PID;
      },
      waitForHsrHost: async () => true,
    });

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]!.filesystemWriteScope, "cwd", "an execution Cell revive stays contained");
    assert.deepEqual(payloads[0]!.extraWriteRoots, [wrapper], "the v2 wrapper grant survives revive");
  });
});

test("execution launcher derives the v2 wrapper grant from the working-copy locator", () => {
  const config = resolveHsrHarnessLaunchConfig({
    harness: {
      driverId: "codex",
      config: { brief: "do the thing", cellLayout: "v2" },
    },
  });
  assert.equal(config.cellLayout, "v2");
  const flags = buildHsrSpawnFlags("XR.cell", "/work/cells/wrapper/checkout", config);
  assert.deepEqual(flags.get("sandbox-write"), ["/work/cells/wrapper"]);
  // v1 (or absent) derives no grant.
  const v1 = buildHsrSpawnFlags("XR.cell", "/work/cells/wrapper/checkout", { ...config, cellLayout: "v1" });
  assert.equal(v1.get("sandbox-write"), undefined);
  assert.throws(
    () => resolveHsrHarnessLaunchConfig({ harness: { driverId: "codex", config: { cellLayout: "v3" } } }),
    /cellLayout/,
  );
});
