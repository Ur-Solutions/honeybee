import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isHsrReAdoptionCandidate,
  markBootCursorsUnverified,
  markObserverOffline,
  probeHsrReAdoption,
  reconcileBootReAdoption,
  runBootReAdoptionSweep,
  type HsrControlProbe,
} from "../src/daemon/reAdoption.js";
import type { UnverifiedCursorMarker } from "../src/stateMachine.js";
import type { HsrMeta } from "../src/hsr/runDir.js";
import { ledgerPath, loadSession, saveSession, type SessionRecord } from "../src/store.js";

const observedAt = "2026-08-11T19:00:00.000Z";
const hostBirth = { pgid: 4701, startedAt: "Tue Aug 11 18:59:00 2026" };

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-readoption-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

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

test("a record-to-meta pid mismatch cannot prove life or death", async () => {
  const bee = "adopt-record-pid-race";
  const result = await probeHsrReAdoption(
    record(bee, { runnerPid: hostBirth.pgid + 1 }),
    "daemon-new",
    fixedProbe(bee),
  );

  assert.equal(result.classification, "uncertain");
  if (result.classification === "uncertain") {
    assert.match(result.detail, /session runner pid .* does not name metadata host/);
  }
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

test("shutdown stamps observer uncertainty without changing any bee cursor or pid", async () => {
  const records = ["shutdown-a", "shutdown-b", "shutdown-c"].map((name, index) =>
    record(name, { runnerPid: 8000 + index }),
  );
  const before = records.map(({ name, runnerPid, lastObservedState }) => ({ name, runnerPid, lastObservedState }));
  const markers = new Map<string, UnverifiedCursorMarker>();
  const outcomes = await markObserverOffline({
    observerId: "daemon-old",
    reason: "signal:SIGTERM",
    lastSeenAt: "2026-08-11T18:59:59.000Z",
    listRecords: async () => records,
    markUnverified: async (name, marker) => {
      markers.set(name, marker);
      return records.find((candidate) => candidate.name === name) ?? null;
    },
    now: () => Date.parse(observedAt),
  });

  assert.deepEqual(outcomes.map(({ status }) => status), ["marked", "marked", "marked"]);
  assert.deepEqual(records.map(({ name, runnerPid, lastObservedState }) => ({ name, runnerPid, lastObservedState })), before);
  for (const marker of markers.values()) {
    assert.deepEqual(marker, {
      since: observedAt,
      reason: "observer-offline",
      probeScheduledAt: observedAt,
      observer: {
        observerId: "daemon-old",
        offlineSince: observedAt,
        lastSeenAt: "2026-08-11T18:59:59.000Z",
        reason: "signal:SIGTERM",
      },
    });
  }
});

test("boot marks the complete set unverified before probing and preserves offline provenance", async () => {
  const existing: UnverifiedCursorMarker = {
    since: "2026-08-11T18:59:30.000Z",
    reason: "observer-offline",
    probeScheduledAt: "2026-08-11T18:59:30.000Z",
    observer: {
      observerId: "daemon-old",
      offlineSince: "2026-08-11T18:59:30.000Z",
      reason: "upgrade",
    },
  };
  const old = record("boot-old") as SessionRecord & { stateUnverified?: UnverifiedCursorMarker };
  old.stateUnverified = existing;
  const fresh = record("boot-fresh");
  const markers = new Map<string, UnverifiedCursorMarker>();

  const outcomes = await markBootCursorsUnverified({
    observerId: "daemon-new",
    records: [old, fresh],
    markUnverified: async (name, marker) => {
      markers.set(name, marker);
      return name === old.name ? old : fresh;
    },
    now: () => Date.parse(observedAt),
  });

  assert.deepEqual(outcomes.map(({ status }) => status), ["marked", "marked"]);
  assert.deepEqual(markers.get(old.name), { ...existing, probeScheduledAt: observedAt });
  assert.deepEqual(markers.get(fresh.name), {
    since: observedAt,
    reason: "stale-cursor",
    probeScheduledAt: observedAt,
  });
});

test("restart audit: three live cursors are unverified as one set, then verified with no pid/state transitions", async () => {
  await withTempStore(async () => {
    const records = ["audit-a", "audit-b", "audit-c"].map((name, index) =>
      record(name, {
        runnerPid: 9100 + index,
        ...(index === 0 ? { lastObservedState: "crashed" } : {}),
      }),
    );
    for (const candidate of records) await saveSession(candidate);
    const metas = new Map(records.map((candidate) => [
      candidate.name,
      meta(candidate.name, {
        hostPid: candidate.runnerPid!,
        hostFingerprint: { pgid: candidate.runnerPid!, startedAt: `${hostBirth.startedAt}:${candidate.runnerPid}` },
      }),
    ]));
    let firstProbe = true;
    const before = records.map(({ name, runnerPid }) => ({ name, runnerPid }));

    const outcomes = await reconcileBootReAdoption({
      observerId: "daemon-new",
      listRecords: async () => records,
      readMeta: async (bee) => {
        if (firstProbe) {
          firstProbe = false;
          for (const candidate of records) {
            assert.ok((await loadSession(candidate.name))?.stateUnverified, `${candidate.name} is marked before probing starts`);
          }
        }
        return metas.get(bee) ?? null;
      },
      inspectHost: async () => "match",
      probeControl: async (disk) => ({ status: "matched", meta: disk }),
      now: () => Date.parse(observedAt),
      makeProbeId: () => "restart-audit-probe",
      concurrency: 3,
    });

    assert.deepEqual(outcomes.map(({ action }) => action), ["verified-live", "verified-live", "verified-live"]);
    for (const expected of before) {
      const stored = await loadSession(expected.name);
      assert.equal(stored?.runnerPid, expected.runnerPid, "re-adoption never relaunches or replaces a pid");
      assert.equal(stored?.stateUnverified, undefined, "conclusive proof clears uncertainty");
    }
    assert.equal((await loadSession(records[0]!.name))?.lastObservedState, undefined, "alive proof heals false crash");
    assert.equal((await loadSession(records[1]!.name))?.lastObservedState, "working", "non-terminal cursor is unchanged");

    const ledger = (await readFile(ledgerPath(), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(ledger.filter(({ type }) => type === "daemon.readoption.start").length, 1);
    assert.equal(ledger.filter(({ type }) => type === "daemon.readoption.probe").length, 3);
    assert.equal(ledger.filter(({ type }) => type === "daemon.readoption.complete").length, 1);
    assert.equal(ledger.filter(({ type }) => type === "state.transition").length, 0, "daemon restart emits no bee transition");
  });
});

test("boot hands stale-working death to H2 with proof before clearing uncertainty", async () => {
  const bee = "boot-dead-working";
  const candidate = record(bee, { lastObservedState: "working" });
  const disk = meta(bee);
  const order: string[] = [];
  let handedProbe: unknown;

  const outcomes = await reconcileBootReAdoption({
    observerId: "daemon-new",
    listRecords: async () => [candidate],
    markUnverified: async () => {
      order.push("marked-unverified");
      return candidate;
    },
    markVerified: async (_name, probe) => {
      order.push("marked-verified");
      assert.equal(probe, handedProbe, "the same proof authorizes the supervisor event and verification");
      return candidate;
    },
    readMeta: async () => disk,
    inspectHost: async () => "gone",
    probeControl: async () => ({ status: "absent", detail: "no socket at path" }),
    onVerifiedDeath: async (probe) => {
      order.push("h2-death-event");
      handedProbe = probe.evidence;
      assert.equal(probe.evidence.outcome, "dead");
      assert.equal(probe.evidence.target.runnerPid, disk.hostPid);
      return "handled";
    },
    appendAudit: async () => undefined,
    now: () => Date.parse(observedAt),
    makeProbeId: () => "boot-death-proof",
  });

  assert.deepEqual(outcomes.map(({ action }) => action), ["verified-dead"]);
  assert.deepEqual(order, ["marked-unverified", "h2-death-event", "marked-verified"]);
});
