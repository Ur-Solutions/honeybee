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
