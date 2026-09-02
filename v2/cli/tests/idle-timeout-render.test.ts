/**
 * Idle-timeout reaper — operator surface (pure renderers, no daemon):
 *  - `hive ls` shows idle bees with time-since-idle (`idle 12m`), a per-bee
 *    `keep` marker for bees the reaper leaves alone, and `idle-timeout` for a
 *    reaped one (distinct from `stopped` / `crashed` / `restart`)
 *  - `view` keeps the full `stopped(idle_timeout)` token and the per-bee value
 *  - `hive daemon status` prints the effective timeout
 *  - duration parsing/formatting for `hive bee set-idle-timeout`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDurationMs, parseDurationMs, stripAnsi } from "../src/style.ts";
import { idleFor, listRuntimeLabel, renderBeeList, renderBeeView, renderHealth, runtimeLabel } from "../src/render.ts";
import type { HealthResult, ViewResult } from "../../daemon/src/protocol.ts";
import type { RuntimeRow } from "../../core/src/index.ts";

const NOW = 1_700_000_000_000;

function view(
  runtimeState: "booting" | "running" | "idle" | "stopped" | null,
  opts: { exitCause?: string | null; idleSince?: number; idleTimeoutMs?: number | null; name?: string } = {},
): ViewResult {
  const state = runtimeState;
  const runtime =
    state == null
      ? null
      : {
          beeId: "b1",
          generation: 1,
          state,
          exitCause: (opts.exitCause ?? null) as RuntimeRow["exitCause"],
          pid: 1,
          pidStartedAt: 1,
          bootEvidence: "real" as const,
          startedAt: NOW - 3_600_000,
          updatedAt: opts.idleSince ?? NOW - 720_000,
        };
  return {
    view: {
      beeId: "b1",
      exists: true,
      lifecycle: "active",
      generation: 1,
      runtimeState: state,
      exitCause: runtime?.exitCause ?? null,
      working: state === "booting" || state === "running",
      waitingForYou: state === "idle",
      lastOutputAt: null,
      reachable: true,
      blocked: false,
      flags: [],
    },
    bee: {
      id: "b1",
      name: opts.name ?? "worker",
      agent: "claude",
      substrate: "hsr",
      cwd: "/tmp/w",
      title: null,
      tags: [],
      sessionLogPath: null,
      lifecycle: "active",
      createdAt: 1,
      archivedAt: null,
      lastOutputAt: null,
      providerSessionId: null,
      env: {},
      importedFrom: null,
      spawnFailures: 0,
      args: null,
      parentId: null,
      forkedFrom: null,
      forkSeed: null,
      account: null,
      handle: "CL.b1b1",
      idleTimeoutMs: opts.idleTimeoutMs ?? null,
    },
    runtime,
  } as ViewResult;
}

test("render.idle.1: ls shows idle bees with time-since-idle, `keep` for a never-reaped bee, and `idle-timeout` for a reaped one", () => {
  assert.equal(listRuntimeLabel(view("idle"), NOW), "idle 12m");
  assert.equal(listRuntimeLabel(view("idle", { idleSince: NOW - 5_000 }), NOW), "idle 5s");
  assert.equal(listRuntimeLabel(view("idle", { idleTimeoutMs: 0 }), NOW), "idle 12m keep");
  assert.equal(listRuntimeLabel(view("idle", { idleTimeoutMs: 60_000 }), NOW), "idle 12m", "a finite override reads like any idle bee");
  assert.equal(listRuntimeLabel(view("stopped", { exitCause: "idle_timeout" }), NOW), "idle-timeout");
  assert.equal(listRuntimeLabel(view("stopped", { exitCause: "stopped_by_user" }), NOW), "stopped");
  assert.equal(listRuntimeLabel(view("stopped", { exitCause: "stopped_by_system" }), NOW), "stopped");
  assert.equal(listRuntimeLabel(view("stopped", { exitCause: "crashed" }), NOW), "crashed");
  assert.equal(listRuntimeLabel(view("stopped", { exitCause: "machine_restart" }), NOW), "restart");
  assert.equal(listRuntimeLabel(view("running"), NOW), "running");
  assert.equal(listRuntimeLabel(view("booting"), NOW), "booting");
  assert.equal(idleFor(view("running"), NOW), null);
  const lines = renderBeeList([view("idle"), view("stopped", { exitCause: "idle_timeout", name: "reaped" })], false, "bees", NOW).map(stripAnsi);
  assert.ok(lines.some((l) => /worker.*idle 12m/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /reaped.*idle-timeout/.test(l)), lines.join("\n"));
});

test("render.idle.2: view keeps the full stopped(idle_timeout) token, idle-since on the headline, and the per-bee value", () => {
  assert.equal(runtimeLabel(view("stopped", { exitCause: "idle_timeout" }), NOW), "stopped(idle_timeout)");
  assert.equal(runtimeLabel(view("idle"), NOW), "idle 12m");
  const plain = renderBeeView(view("idle"), false).map(stripAnsi);
  assert.ok(!plain.some((l) => l.includes("idle timeout")), "inherit: no per-bee line");
  const never = renderBeeView(view("idle", { idleTimeoutMs: 0 }), false).map(stripAnsi);
  assert.ok(never.some((l) => l.includes("idle timeout") && l.includes("never (per-bee)")), never.join("\n"));
  const own = renderBeeView(view("idle", { idleTimeoutMs: 5_400_000 }), false).map(stripAnsi);
  assert.ok(own.some((l) => l.includes("1h30m (per-bee)")), own.join("\n"));
});

test("render.idle.3: daemon status prints the effective timeout (or that the reaper is off)", () => {
  const health = (idleTimeoutMs: number): HealthResult => ({
    protocol: "v2/1",
    pid: 1,
    startedAt: 0,
    uptimeMs: 1000,
    ticks: 5,
    lastTickAt: 1,
    tickErrors: 0,
    stopping: false,
    lastBoot: null,
    i1Violations: 0,
    bees: { total: 0, active: 0, archived: 0 },
    idleTimeoutMs,
  });
  const on = renderHealth(health(900_000)).map(stripAnsi);
  assert.ok(on.some((l) => l.startsWith("idle timeout") && l.includes("15m")), on.join("\n"));
  const off = renderHealth(health(0)).map(stripAnsi);
  assert.ok(off.some((l) => l.startsWith("idle timeout") && l.includes("never")), off.join("\n"));
});

test("render.idle.4: durations — format and parse round-trip; never/0 disable; garbage refused", () => {
  assert.equal(formatDurationMs(900_000), "15m");
  assert.equal(formatDurationMs(5_400_000), "1h30m");
  assert.equal(formatDurationMs(90_000), "1m30s");
  assert.equal(formatDurationMs(45_000), "45s");
  assert.equal(formatDurationMs(500), "500ms");
  assert.equal(formatDurationMs(0), "never");
  assert.equal(formatDurationMs(null), "—");
  assert.equal(parseDurationMs("15m"), 900_000);
  assert.equal(parseDurationMs("1h30m"), 5_400_000);
  assert.equal(parseDurationMs("90s"), 90_000);
  assert.equal(parseDurationMs("2d"), 172_800_000);
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("900000"), 900_000, "bare number = ms");
  assert.equal(parseDurationMs("0"), 0);
  assert.equal(parseDurationMs("never"), 0);
  assert.equal(parseDurationMs("OFF"), 0);
  for (const bad of ["", "soon", "15", "m15", "1h30", "-5m", "1.5.2m"]) {
    if (bad === "15") continue; // a bare integer is ms by contract
    assert.throws(() => parseDurationMs(bad), /invalid duration/, bad);
  }
});
