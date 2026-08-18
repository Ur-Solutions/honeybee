/**
 * WP4 CLI tier: the thin client — RPC when the daemon is up, read-only
 * SQLite fallback clearly labeled stale when it is down, `send --wait` (Q3),
 * and the service-layer glue (label/exec-args). Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { runV2Cli, serviceExecArgs, serviceLabel, type CliIo } from "../src/main.ts";
import { claudeHsrRecord, makeFrozenFixture } from "../../core/tests/frozen-fixture.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

test("cli.1: help prints and exits 0; unknown command exits 1", async () => {
  const a = capture();
  assert.equal(await runV2Cli(["help"], a.io), 0);
  assert.ok(a.out.join("\n").includes("hive v2"));
  const b = capture();
  assert.equal(await runV2Cli(["frobnicate"], b.io), 1);
  assert.ok(b.err[0]?.includes("unknown v2 command"));
});

test("cli.2: reads fall back to the read-only store when the daemon is down — labeled stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cli-"));
  try {
    // Build a store offline (no daemon): one bee, runtime stopped(crashed).
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "bee-a", name: "alpha", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store.updateRuntimeState("bee-a", 1, "stopped", { exitCause: "crashed" });
    store.send("bee-a", "queued while down");
    store.close();

    // json: stale flag set.
    const j = capture();
    assert.equal(await runV2Cli(["list", "--all", "--data-dir", dir, "--json"], j.io), 0);
    const parsed = JSON.parse(j.out[0] ?? "{}") as { stale?: boolean; views: Array<{ view: { beeId: string } }> };
    assert.equal(parsed.stale, true);
    assert.equal(parsed.views[0]?.view.beeId, "bee-a");

    // human: STALE banner on stderr, stale-prefixed rows, view by NAME resolves.
    const h = capture();
    assert.equal(await runV2Cli(["view", "alpha", "--data-dir", dir], h.io), 0);
    assert.ok(h.err[0]?.startsWith("STALE"), `stderr labeled: ${h.err[0]}`);
    assert.ok(h.out[0]?.startsWith("stale: "), `row labeled: ${h.out[0]}`);
    assert.ok(h.out[0]?.includes("stopped(crashed)"));

    // mailbox fallback too.
    const m = capture();
    assert.equal(await runV2Cli(["mailbox", "alpha", "--data-dir", dir, "--json"], m.io), 0);
    const mail = JSON.parse(m.out[0] ?? "{}") as { stale?: boolean; messages: Array<{ body: string }> };
    assert.equal(mail.stale, true);
    assert.equal(mail.messages[0]?.body, "queued while down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.3: mutations NEVER fall back — daemon down means a loud, typed failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cli-"));
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "bee-a", name: "alpha", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store.close();
    const a = capture();
    assert.equal(await runV2Cli(["send", "alpha", "hi", "--data-dir", dir], a.io), 1);
    assert.ok(a.err[0]?.includes("daemon not reachable"), a.err[0]);
    const b = capture();
    assert.equal(await runV2Cli(["stop", "alpha", "--data-dir", dir], b.io), 1);
    assert.ok(b.err[0]?.includes("daemon not reachable"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.4: against a live daemon — spawn, list (not stale), send --wait blocks on the delivery mark", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(
      await runV2Cli(["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], s.io),
      0,
    );
    const spawned = JSON.parse(s.out[0] ?? "{}") as { beeId: string; commandId: number };
    assert.ok(spawned.beeId.length > 0);
    assert.ok(spawned.commandId > 0, "mutation returns the enqueued command id");

    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["view", "worker", "--data-dir", dir, "--json"], l.io);
      const v = JSON.parse(l.out[0] ?? "{}") as { stale?: boolean; view?: { runtimeState: string } };
      assert.notEqual(v.stale, true, "live daemon reads are never stale-labeled");
      return v.view?.runtimeState === "idle";
    }, "worker idle", 10_000);

    // Q3: --wait returns only after delivered_generation is marked.
    const w = capture();
    assert.equal(
      await runV2Cli(["send", "worker", "do the thing", "--wait", "--data-dir", dir, "--json"], w.io),
      0,
    );
    const sent = JSON.parse(w.out[0] ?? "{}") as { messageId: number; deliveredGeneration?: number };
    assert.equal(sent.deliveredGeneration, 1);

    // health through the CLI.
    const h = capture();
    assert.equal(await runV2Cli(["health", "--data-dir", dir, "--json"], h.io), 0);
    const health = JSON.parse(h.out[0] ?? "{}") as { i1Violations: number; bees: { total: number } };
    assert.equal(health.i1Violations, 0);
    assert.equal(health.bees.total, 1);

    // daemon status via RPC probe (no service manager involved).
    const st = capture();
    assert.equal(await runV2Cli(["daemon", "status", "--data-dir", dir, "--json"], st.io), 0);
    assert.equal((JSON.parse(st.out[0] ?? "{}") as { running: boolean }).running, true);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.4b: --idempotency-key passes through on spawn and send — replays dedup to the original", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);

    const a = capture();
    assert.equal(
      await runV2Cli(
        ["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--idempotency-key", "cli-spawn-1", "--data-dir", dir, "--json"],
        a.io,
      ),
      0,
    );
    const first = JSON.parse(a.out[0] ?? "{}") as { beeId: string; commandId: number; deduped?: boolean };
    assert.ok(first.beeId.length > 0);
    assert.notEqual(first.deduped, true);

    const b = capture();
    assert.equal(
      await runV2Cli(
        ["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--idempotency-key", "cli-spawn-1", "--data-dir", dir, "--json"],
        b.io,
      ),
      0,
    );
    const replay = JSON.parse(b.out[0] ?? "{}") as { beeId: string; commandId: number; deduped?: boolean };
    assert.equal(replay.deduped, true, "second spawn with the same key is a dedup");
    assert.equal(replay.beeId, first.beeId);
    assert.equal(replay.commandId, first.commandId);

    // Only one bee exists.
    const l = capture();
    assert.equal(await runV2Cli(["list", "--all", "--data-dir", dir, "--json"], l.io), 0);
    assert.equal((JSON.parse(l.out[0] ?? "{}") as { views: unknown[] }).views.length, 1);

    // send: same key → same message id, marked deduped in human output too.
    const s1 = capture();
    assert.equal(
      await runV2Cli(["send", "worker", "ping", "--idempotency-key", "cli-send-1", "--data-dir", dir, "--json"], s1.io),
      0,
    );
    const sent = JSON.parse(s1.out[0] ?? "{}") as { messageId: number };
    const s2 = capture();
    assert.equal(
      await runV2Cli(["send", "worker", "ping", "--idempotency-key", "cli-send-1", "--data-dir", dir], s2.io),
      0,
    );
    assert.ok(s2.out[0]?.startsWith("deduped: already sent message"), s2.out[0]);
    assert.ok(s2.out[0]?.includes(`message ${sent.messageId} `), "same message id on replay");
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.5: daemon status when nothing runs and no service is installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cli-"));
  try {
    const a = capture();
    process.env.HIVE_V2_SERVICE_DIR = join(dir, "no-services");
    try {
      assert.equal(await runV2Cli(["daemon", "status", "--data-dir", dir, "--json"], a.io), 0);
    } finally {
      delete process.env.HIVE_V2_SERVICE_DIR;
    }
    const parsed = JSON.parse(a.out[0] ?? "{}") as { running: boolean; service: unknown };
    assert.equal(parsed.running, false);
    assert.equal(parsed.service, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.6: service glue — label never the live daemon's, exec args env override wins", () => {
  assert.equal(serviceLabel({}), "dev.honeybee.hive.v2");
  assert.notEqual(serviceLabel({}), "dev.honeybee.hive");
  assert.equal(serviceLabel({ HIVE_V2_SERVICE_LABEL: "x.test" }), "x.test");
  assert.deepEqual(
    serviceExecArgs("/data", { HIVE_V2_SERVICE_ARGS: JSON.stringify(["/bin/node", "/x.js", "daemon", "run"]) }),
    ["/bin/node", "/x.js", "daemon", "run"],
  );
  const computed = serviceExecArgs("/data", {});
  assert.equal(computed[0], process.execPath);
  assert.deepEqual(computed.slice(-3), ["run", "--data-dir", "/data"]);
});

test("cli.7: cutover verbs — `freeze` writes/refuses locally; `import --from-frozen` reports (dry-run, marker refusal, real import, idempotent) over RPC", async () => {
  const fx = makeFrozenFixture();
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    fx.writeRecord("a.json", claudeHsrRecord(fx.root, { runnerPid: 4_190_000, runnerFingerprint: { pgid: 4_190_000, startedAt: "Tue Aug 18 07:42:57 2026" } }));
    fx.writeRecord("kf.json", claudeHsrRecord(fx.root, { id: "CL.kf", name: "kf-bee", status: "kill_failed" }));
    daemon = await startDaemon(dir);

    // import before freeze → refused (marker missing), exit 1, nothing written
    const r0 = capture();
    assert.equal(await runV2Cli(["import", "--from-frozen", "--root", fx.root, "--data-dir", dir], r0.io), 1);
    assert.ok(r0.out.some((l) => l.includes("FROZEN MISSING")), r0.out.join("\n"));
    assert.ok(r0.out.some((l) => l.startsWith("REFUSED:") && l.includes("hive v2 freeze")), r0.out.join("\n"));

    // usage guard
    const bad = capture();
    assert.equal(await runV2Cli(["import", "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err[0]?.includes("usage: hive v2 import --from-frozen"));

    // freeze: lock pid alive → refused; impossible pid → written; again → already frozen
    fx.writeDaemonLock({ pid: process.pid, startedAt: new Date().toISOString() });
    const f0 = capture();
    assert.equal(await runV2Cli(["freeze", "--root", fx.root, "--data-dir", dir], f0.io), 1);
    assert.ok(f0.out[0]?.includes("refused") && f0.out[0]?.includes(String(process.pid)), f0.out[0]);
    fx.writeDaemonLock({ pid: 4_190_001, startedAt: "2026-08-17T12:22:29.035Z" });
    const f1 = capture();
    assert.equal(await runV2Cli(["freeze", "--root", fx.root, "--data-dir", dir, "--json"], f1.io), 0);
    assert.equal((JSON.parse(f1.out[0] ?? "{}") as { outcome: string }).outcome, "written");
    const f2 = capture();
    assert.equal(await runV2Cli(["freeze", "--root", fx.root, "--data-dir", dir], f2.io), 0);
    assert.ok(f2.out[0]?.startsWith("already frozen"));

    // dry-run: plan listed, nothing written, exit 0
    const d = capture();
    assert.equal(await runV2Cli(["import", "--from-frozen", "--root", fx.root, "--dry-run", "--data-dir", dir], d.io), 0);
    assert.ok(d.out.some((l) => l.startsWith("dry-run: import --from-frozen")), d.out.join("\n"));
    assert.ok(d.out.some((l) => l.includes("would import 1, skip 1")), d.out.join("\n"));
    assert.ok(d.out.some((l) => l.includes("import CL.fe6f") && l.includes("resume=native(9aa1f08d")), d.out.join("\n"));
    assert.ok(d.out.some((l) => l.includes("skip   CL.kf") && l.includes("reason=kill_failed")), d.out.join("\n"));
    assert.ok(d.out.some((l) => l === "dry-run: nothing written"));
    const l0 = capture();
    await runV2Cli(["list", "--all", "--data-dir", dir, "--json"], l0.io);
    assert.equal((JSON.parse(l0.out[0] ?? "{}") as { views: unknown[] }).views.length, 0);

    // real import, json
    const i1 = capture();
    assert.equal(await runV2Cli(["import", "--from-frozen", "--root", fx.root, "--data-dir", dir, "--json"], i1.io), 0);
    const report = JSON.parse(i1.out[0] ?? "{}") as { applied: boolean; imported: Array<{ beeId: string; resume: string }> };
    assert.equal(report.applied, true);
    assert.deepEqual(report.imported, [{ beeId: "CL.fe6f", name: "apiary-waggle-msx67afb-1", agent: "claude", resume: "harness_native" }]);
    // the bee is visible + stopped + reachable through the normal read path
    const v = capture();
    assert.equal(await runV2Cli(["view", "CL.fe6f", "--data-dir", dir], v.io), 0);
    assert.ok(v.out[0]?.includes("stopped(stopped_by_system)"), v.out[0]);

    // idempotent re-run through the CLI
    const i2 = capture();
    assert.equal(await runV2Cli(["import", "--from-frozen", "--root", fx.root, "--data-dir", dir], i2.io), 0);
    assert.ok(i2.out.some((l) => l.includes("already_imported=1")), i2.out.join("\n"));
    assert.ok(i2.out.some((l) => l === "imported 0 bee(s)"));
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
    fx.cleanup();
  }
});
