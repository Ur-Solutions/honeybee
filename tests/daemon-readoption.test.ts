import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isHsrReAdoptionCandidate,
  probeHsrReAdoption,
  runBootReAdoptionSweep,
  type HsrControlProbe,
} from "../src/daemon/reAdoption.js";
import type { HsrMeta } from "../src/hsr/runDir.js";
import type { SessionRecord } from "../src/store.js";

const observedAt = "2026-08-11T19:00:00.000Z";
const hostBirth = { pgid: 4701, startedAt: "Tue Aug 11 18:59:00 2026" };

function record(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    runnerPid: hostBirth.pgid,
    id: name,
    createdAt: observedAt,
    updatedAt: observedAt,
    status: "running",
    lastObservedState: "working",
    ...overrides,
  };
}

function meta(bee: string, overrides: Partial<HsrMeta> = {}): HsrMeta {
  return {
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: hostBirth.pgid,
    hostFingerprint: hostBirth,
    childAdmission: "none",
    startedAt: observedAt,
    controlSocket: `/tmp/${bee}.sock`,
    status: "running",
    ...overrides,
  };
}

function fixedProbe(bee: string, overrides: {
  disk?: HsrMeta;
  control?: HsrControlProbe;
  host?: "match" | "mismatch" | "gone" | "unverifiable";
} = {}) {
  const disk = overrides.disk ?? meta(bee);
  return {
    readMeta: async () => disk,
    inspectHost: async () => overrides.host ?? "match" as const,
    probeControl: async () => overrides.control ?? { status: "matched" as const, meta: disk },
    now: () => Date.parse(observedAt),
    makeProbeId: () => `probe-${bee}`,
  };
}

test("exact host-birth and socket-owned incarnation prove a live re-adoption", async () => {
  const bee = "adopt-live";
  const result = await probeHsrReAdoption(record(bee), "daemon-new", fixedProbe(bee));

  assert.equal(result.classification, "live");
  assert.deepEqual(result.evidence, {
    kind: "probe",
    probeId: `probe-${bee}`,
    observerId: "daemon-new",
    observedAt,
    outcome: "alive",
    target: { substrate: "hsr", runnerPid: hostBirth.pgid },
    detail: "host birth matched; control socket owns running incarnation",
  });
  if (result.classification === "live") {
    assert.equal(result.ownedMeta.hostPid, hostBirth.pgid);
    assert.equal(result.staleExitedMeta, false);
  }
});

test("an exited disk stamp is stale when the exact live host owns running metadata", async () => {
  const bee = "adopt-false-exit";
  const disk = meta(bee, {
    status: "exited",
    endedAt: "2026-08-11T18:58:00.000Z",
    exitCode: null,
  });
  const owned = meta(bee, { status: "running" });
  const result = await probeHsrReAdoption(record(bee, { lastObservedState: "crashed" }), "daemon-new", fixedProbe(bee, {
    disk,
    control: { status: "matched", meta: owned },
  }));

  assert.equal(result.classification, "live");
  if (result.classification === "live") {
    assert.equal(result.staleExitedMeta, true);
    assert.equal(result.diskMeta.status, "exited");
    assert.equal(result.ownedMeta.status, "running");
  }
});

test("gone or birth-mismatched pid plus absent socket is probe-verified death", async () => {
  for (const host of ["gone", "mismatch"] as const) {
    const bee = `adopt-dead-${host}`;
    const result = await probeHsrReAdoption(record(bee), "daemon-new", fixedProbe(bee, {
      host,
      control: { status: "absent", detail: "no socket at path" },
    }));

    assert.equal(result.classification, "dead");
    assert.equal(result.evidence.outcome, "dead");
    assert.equal(result.evidence.target.runnerPid, hostBirth.pgid);
    if (result.classification === "dead") assert.equal(result.hostVerdict, host);
  }
});

test("a living pid can never be converted to crashed by a dying-daemon sweep", async () => {
  const bee = "incident-2026-08-10";
  const result = await probeHsrReAdoption(record(bee), "daemon-old", fixedProbe(bee, {
    host: "match",
    control: { status: "absent", detail: "observer is shutting down" },
  }));

  assert.equal(result.classification, "uncertain");
  assert.equal(result.evidence.outcome, "unreachable");
  assert.match(result.detail, /host=match; control=absent/);
});

test("timeouts, unverifiable births, and contradictory witnesses stay uncertain", async () => {
  const cases = [
    {
      bee: "adopt-timeout",
      host: "gone" as const,
      control: { status: "unreachable" as const, detail: "rpc timed out" },
    },
    {
      bee: "adopt-unverifiable",
      host: "unverifiable" as const,
      control: { status: "absent" as const, detail: "no socket at path" },
    },
    {
      bee: "adopt-recycled-socket",
      host: "mismatch" as const,
      control: { status: "matched" as const, meta: meta("adopt-recycled-socket") },
    },
  ];

  for (const scenario of cases) {
    const result = await probeHsrReAdoption(record(scenario.bee), "daemon-new", fixedProbe(scenario.bee, scenario));
    assert.equal(result.classification, "uncertain", scenario.bee);
    assert.equal(result.evidence.outcome, "unreachable", scenario.bee);
  }
});

test("an incarnation change during the probe invalidates all accumulated proof", async () => {
  const bee = "adopt-race";
  const initial = meta(bee);
  const replacement = meta(bee, {
    hostPid: 9912,
    hostFingerprint: { pgid: 9912, startedAt: "Tue Aug 11 19:00:01 2026" },
    startedAt: "2026-08-11T19:00:01.000Z",
  });
  let reads = 0;
  const result = await probeHsrReAdoption(record(bee), "daemon-new", {
    ...fixedProbe(bee),
    readMeta: async () => reads++ === 0 ? initial : replacement,
  });

  assert.equal(result.classification, "uncertain");
  if (result.classification === "uncertain") assert.equal(result.detail, "runtime incarnation changed during probe");
});

test("boot sweep probes three live HSR records without changing their runner pids", async () => {
  const live = ["restart-a", "restart-b", "restart-c"].map((name, index) =>
    record(name, { runnerPid: hostBirth.pgid + index }),
  );
  const before = live.map(({ name, runnerPid }) => ({ name, runnerPid }));
  const metas = new Map(live.map((candidate) => [
    candidate.name,
    meta(candidate.name, {
      hostPid: candidate.runnerPid!,
      hostFingerprint: { ...hostBirth, pgid: candidate.runnerPid! },
    }),
  ]));
  const records = [
    ...live,
    record("archived-hsr", { status: "done" }),
    record("local-bee", { substrate: "local-tmux" }),
  ];

  const results = await runBootReAdoptionSweep({
    observerId: "daemon-new",
    listRecords: async () => records,
    readMeta: async (bee) => metas.get(bee) ?? null,
    inspectHost: async () => "match",
    probeControl: async (disk) => ({ status: "matched", meta: disk }),
    now: () => Date.parse(observedAt),
    makeProbeId: () => "restart-probe",
    concurrency: 2,
  });

  assert.deepEqual(results.map(({ classification }) => classification), ["live", "live", "live"]);
  assert.deepEqual(live.map(({ name, runnerPid }) => ({ name, runnerPid })), before, "the sweep is observation-only");
  assert.ok(records.every(isHsrReAdoptionCandidate) === false, "mixed record set includes excluded records");
  assert.deepEqual(records.filter(isHsrReAdoptionCandidate).map(({ name }) => name), ["restart-a", "restart-b", "restart-c"]);
});
