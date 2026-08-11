import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listMessages } from "../src/buz.js";
import { handleBrokerOperation, verifyBrokerCallerClaim } from "../src/daemon/broker.js";
import type { BrokerAcl } from "../src/daemon/brokerPolicy.js";
import { capturePersistableProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import { writeHsrMeta } from "../src/hsr/runDir.js";
import { listSeals } from "../src/seal.js";

async function seedSession(store: string, name: string, id = name): Promise<void> {
  const sessions = join(store, "sessions");
  await mkdir(sessions, { recursive: true });
  const now = "2026-08-10T12:00:00.000Z";
  await writeFile(join(sessions, `${name}.json`), `${JSON.stringify({
    name,
    id,
    agent: "codex",
    cwd: process.cwd(),
    command: "codex",
    tmuxTarget: `broker-test-${name}`,
    substrate: "hsr",
    createdAt: now,
    updatedAt: now,
    status: "dead",
  }, null, 2)}\n`, { mode: 0o600 });
}

async function withStore(fn: (store: string) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "hive-daemon-broker-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    await fn(store);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(store, { recursive: true, force: true });
  }
}

const loadDefaultAcl = async (): Promise<BrokerAcl> => ({});
const verifiedTestCaller = async (): Promise<void> => undefined;
const defaultOptions = { loadAcl: loadDefaultAcl, verifyCaller: verifiedTestCaller };

test("broker handlers perform buz send/inbox, self-scoped state, and self seal", async () => {
  await withStore(async (store) => {
    await seedSession(store, "cell-caller", "CO.caller");
    await seedSession(store, "cell-recipient", "CO.recipient");

    const send = await handleBrokerOperation("broker:buz-send", {
      callerBee: "cell-caller",
      target: "cell-recipient",
      tier: "queue",
      body: "broker hello",
      subject: "test",
    }, defaultOptions);
    assert.equal(send.ok, true);
    const sendRows = send.results as Array<{ recordName: string; result: { message: { id: string; from: { kind: string; id: string } } } }>;
    assert.equal(sendRows.length, 1);
    assert.equal(sendRows[0]!.recordName, "cell-recipient");
    assert.deepEqual(sendRows[0]!.result.message.from, { kind: "bee", id: "CO.caller" });
    assert.equal((await listMessages("cell-recipient", "queue")).length, 1);

    const selfSend = await handleBrokerOperation("broker:buz-send", {
      callerBee: "cell-caller",
      target: "cell-caller",
      tier: "passive",
      body: "mail to self",
    }, defaultOptions);
    assert.equal(selfSend.ok, true);
    const inbox = await handleBrokerOperation("broker:buz-inbox", {
      callerBee: "cell-caller",
      target: "cell-caller",
      limit: 1,
      fromFilter: "CO.caller",
    }, defaultOptions);
    assert.equal(inbox.ok, true);
    assert.equal(inbox.recordName, "cell-caller");
    assert.equal((inbox.listing as unknown[]).length, 1);
    assert.equal(inbox.quarantined, 0);

    const state = await handleBrokerOperation("broker:state", {
      callerBee: "cell-caller",
      target: "cell-caller",
      mode: "ls",
    }, defaultOptions);
    assert.equal(state.ok, true);
    const list = state.list as { bees: Array<{ bee: { name: string } }> };
    assert.deepEqual(list.bees.map((view) => view.bee.name), ["cell-caller"]);

    const explained = await handleBrokerOperation("broker:state", {
      callerBee: "cell-caller",
      mode: "explain",
    }, defaultOptions);
    assert.equal(explained.ok, true);
    assert.equal((explained.view as { bee: { name: string } }).bee.name, "cell-caller");

    const sealed = await handleBrokerOperation("broker:seal", {
      callerBee: "cell-caller",
      target: "cell-caller",
      artifact: { status: "done", summary: "brokered seal", type: "implementation" },
    }, defaultOptions);
    assert.equal(sealed.ok, true);
    assert.equal(sealed.recordName, "cell-caller");
    assert.equal((sealed.stored as { summary: string }).summary, "brokered seal");
    assert.equal((await listSeals("cell-caller"))[0]!.summary, "brokered seal");
  });
});

test("broker handlers deny every cross-bee subject by default", async () => {
  await withStore(async (store) => {
    await seedSession(store, "cell-caller");
    await seedSession(store, "cell-other");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["broker:buz-send", { target: "cell-caller", senderBee: "cell-other", tier: "queue", body: "forged" }],
      ["broker:buz-inbox", { target: "cell-other" }],
      ["broker:state", { target: "cell-other", mode: "explain" }],
      ["broker:seal", { target: "cell-other", artifact: { status: "done", summary: "forged" } }],
    ];
    for (const [op, params] of cases) {
      const reply = await handleBrokerOperation(op, { callerBee: "cell-caller", ...params }, defaultOptions);
      assert.equal(reply.ok, false, op);
      assert.match(reply.error ?? "", /cell-other is not granted/, op);
    }
    assert.equal((await listMessages("cell-caller", "queue")).length, 0);
    assert.equal((await listSeals("cell-other")).length, 0);
  });
});

test("broker handler honors an explicit per-bee grant", async () => {
  await withStore(async (store) => {
    await seedSession(store, "cell-coordinator");
    await seedSession(store, "cell-worker");
    const acl: BrokerAcl = {
      "cell-coordinator": { "broker:state": ["cell-worker"] },
    };
    const reply = await handleBrokerOperation("broker:state", {
      callerBee: "cell-coordinator",
      target: "cell-worker",
      mode: "explain",
    }, { loadAcl: async () => acl, verifyCaller: verifiedTestCaller });
    assert.equal(reply.ok, true);
    assert.equal((reply.view as { bee: { name: string } }).bee.name, "cell-worker");
  });
});

test("broker handler returns a flat denial for unknown operations", async () => {
  assert.deepEqual(await handleBrokerOperation("broker:unknown", { callerBee: "cell-caller" }), {
    ok: false,
    error: "unknown broker operation: broker:unknown",
  });
});

test("broker caller verification accepts a live birth-bound runner and denies a dead claim", async () => {
  await withStore(async (store) => {
    await seedSession(store, "cell-caller");
    const hostFingerprint = await capturePersistableProcessBirthFingerprint(process.pid);
    assert.ok(hostFingerprint, "the test process must have a persistable birth fingerprint");
    await writeHsrMeta("cell-caller", {
      bee: "cell-caller",
      harness: "codex",
      tier: "server",
      hostPid: process.pid,
      hostFingerprint,
      startedAt: new Date().toISOString(),
      controlSocket: join(store, "cell-caller.sock"),
      status: "running",
    });

    await assert.doesNotReject(verifyBrokerCallerClaim("cell-caller"));
    const live = await handleBrokerOperation("broker:buz-inbox", {
      callerBee: "cell-caller",
      target: "cell-caller",
    }, { loadAcl: loadDefaultAcl });
    assert.equal(live.ok, true);

    await writeHsrMeta("cell-caller", {
      bee: "cell-caller",
      harness: "codex",
      tier: "server",
      hostPid: 2_147_483_647,
      hostFingerprint: { pgid: 2_147_483_647, startedAt: "Mon Aug 10 12:00:00 2026" },
      startedAt: new Date().toISOString(),
      controlSocket: join(store, "dead-cell-caller.sock"),
      status: "running",
    });
    const dead = await handleBrokerOperation("broker:buz-inbox", {
      callerBee: "cell-caller",
      target: "cell-caller",
    }, { loadAcl: loadDefaultAcl });
    assert.equal(dead.ok, false);
    assert.match(dead.error ?? "", /no live birth-verified HSR runner/);
  });
});

test("HIVE_BROKER_VERIFY=0 restores v1 claimed-identity behavior", async () => {
  await withStore(async (store) => {
    await seedSession(store, "unverified-cell");
    const previous = process.env.HIVE_BROKER_VERIFY;
    process.env.HIVE_BROKER_VERIFY = "0";
    try {
      const reply = await handleBrokerOperation("broker:buz-inbox", {
        callerBee: "unverified-cell",
        target: "unverified-cell",
      }, { loadAcl: loadDefaultAcl });
      assert.equal(reply.ok, true);
    } finally {
      if (previous === undefined) delete process.env.HIVE_BROKER_VERIFY;
      else process.env.HIVE_BROKER_VERIFY = previous;
    }
  });
});
