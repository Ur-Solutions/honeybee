import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HsrHostHandle } from "../src/hsr/host.js";
import { readHsrEventIntegrityReceipt } from "../src/hsr/eventIntegrity.js";
import { captureProcessBirthFingerprint, type ProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import { readDeliveredCredentials, shredDeliveredCredentials } from "../src/hsr/remoteCreds.js";
import { buildController, versionString } from "../src/hsr/remoteHost.js";
import type { RpcServer } from "../src/hsr/rpc.js";
import {
  appendHsrEvent,
  hsrControlSocketPath,
  hsrRunDir,
  readHsrMetaStrict,
  sealHsrEventStreamClosure,
  writeHsrMeta,
} from "../src/hsr/runDir.js";

const CTX = { connectionId: 1, close() {} };

type AuthorityReceipt = { ok?: boolean; launchId?: string; incarnation?: string };

function authorityParams(receipt: AuthorityReceipt): { launchId: string; incarnation: string } {
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.ok(receipt.launchId);
  assert.ok(receipt.incarnation);
  return { launchId: receipt.launchId, incarnation: receipt.incarnation };
}

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-remote-controller-life-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeRunHost(
  hostBirth: ProcessBirthFingerprint,
  options: { rejectStop?: boolean; child?: { pid: number; birth: ProcessBirthFingerprint }; onStop?: () => void } = {},
) {
  return async (params: Parameters<typeof import("../src/hsr/host.js").runHsrHost>[0]): Promise<HsrHostHandle> => {
    const startedAt = new Date().toISOString();
    const running = {
      bee: params.bee,
      harness: params.adapter.harness,
      tier: params.adapter.tier(),
      hostPid: process.pid,
      hostFingerprint: hostBirth,
      ...(options.child
        ? {
            childPid: options.child.pid,
            childPgid: options.child.pid,
            childFingerprint: options.child.birth,
            childAdmission: "admitted" as const,
          }
        : { childAdmission: "none" as const }),
      startedAt,
      runningAt: startedAt,
      ...(params.opts.sessionId ? { sessionId: params.opts.sessionId } : {}),
      controlSocket: hsrControlSocketPath(params.bee),
      status: "running" as const,
    };
    await writeHsrMeta(params.bee, running);
    const eventHost = {
      hostPid: running.hostPid,
      startedAt: running.startedAt,
      hostFingerprint: running.hostFingerprint,
    };
    await appendHsrEvent(params.bee, { type: "host_epoch", ts: Date.now(), host: eventHost });
    return {
      bee: params.bee,
      controlSocket: running.controlSocket,
      done: new Promise<void>(() => undefined),
      async stop() {
        options.onStop?.();
        if (options.rejectStop) throw new Error("injected handle stop rejection");
        await appendHsrEvent(params.bee, { type: "exit", ts: Date.now(), code: 0, host: eventHost });
        const eventStreamClosure = await sealHsrEventStreamClosure(params.bee, running);
        await writeHsrMeta(params.bee, {
          ...running,
          status: "exited",
          endedAt: new Date().toISOString(),
          eventStreamClosure,
        });
      },
    };
  };
}

function attachFakeServe(controller: ReturnType<typeof buildController>, onClose: () => void = () => {}): void {
  controller.attachServer({
    path: "/tmp/fake-runner-host-control.sock",
    broadcast() {},
    connectionCount: () => 0,
    broadcastDroppedCount: () => 0,
    async close() { onClose(); },
  } satisfies RpcServer);
}

async function selfBirth(): Promise<ProcessBirthFingerprint> {
  const fingerprint = await captureProcessBirthFingerprint(process.pid);
  assert.ok(fingerprint);
  return fingerprint;
}

test("quiescent upgrade prepares only an empty authority and token-qualified commit closes its socket", async () => {
  await withTempStore(async () => {
    let socketCloses = 0;
    const controller = buildController();
    attachFakeServe(controller, () => { socketCloses += 1; });
    const replacementVersion = "runner-host 0.0.1+sha256.dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const prepared = await controller.methods.prepareUpgrade!({
      expectedVersion: versionString(),
      replacementVersion,
    }, CTX) as { ok?: boolean; token?: string; error?: string };
    assert.equal(prepared.ok, true, prepared.error);
    assert.ok(prepared.token);
    const fencedPing = await controller.methods.ping!(undefined, CTX) as { ok?: boolean; error?: string };
    assert.equal(fencedPing.ok, false);
    assert.match(fencedPing.error ?? "", /closing/);

    const wrong = await controller.methods.commitUpgrade!({
      token: "wrong-token",
      replacementVersion,
    }, CTX) as { ok?: boolean };
    assert.equal(wrong.ok, false);
    assert.equal(socketCloses, 0);

    const committed = await controller.methods.commitUpgrade!({
      token: prepared.token,
      replacementVersion,
    }, CTX) as { ok?: boolean };
    assert.equal(committed.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(socketCloses, 1);
  });
});

test("routine upgrade refuses active remote work, sends no stop, and reopens admission", async () => {
  await withTempStore(async () => {
    const bee = "upgrade-must-not-stop";
    const hostBirth = await selfBirth();
    let stopCalls = 0;
    const controller = buildController({
      runHost: fakeRunHost(hostBirth, { onStop: () => { stopCalls += 1; } }),
      processSignals: { readProcessIdentity: async () => hostBirth },
    });
    attachFakeServe(controller);
    const spawned = await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: "controller-lifecycle-test",
      kind: "stub",
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX) as AuthorityReceipt;
    const authority = authorityParams(spawned);

    const prepared = await controller.methods.prepareUpgrade!({
      expectedVersion: versionString(),
      replacementVersion: "runner-host 0.0.1+sha256.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    }, CTX) as { ok?: boolean; active?: string[]; error?: string };
    assert.equal(prepared.ok, false);
    assert.deepEqual(prepared.active, [bee]);
    assert.match(prepared.error ?? "", /stop\/retire.*rerun hive node bootstrap/);
    assert.equal(stopCalls, 0, "routine bootstrap preparation must not signal live work");
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
    const reopenedPing = await controller.methods.ping!(undefined, CTX) as { ok?: boolean };
    assert.equal(reopenedPing.ok, true, "a refused upgrade must not wedge the existing authority");

    const killed = await controller.methods.kill!({ bee, ...authority }, CTX) as { ok?: boolean };
    assert.equal(killed.ok, true);
    assert.equal(stopCalls, 1);
    await controller.close();
  });
});

test("rejecting in-memory stop with a live unverifiable child fails kill, refresh, and close without losing artifacts", async () => {
  await withTempStore(async (dir) => {
    const bee = "rejecting-live-handle";
    const hostBirth = await selfBirth();
    const child = { pid: 88_221, birth: { pgid: 88_221, startedAt: "live-child-birth" } };
    const home = join(dir, "home");
    const credential = join(home, "old.json");
    const controller = buildController({
      runHost: fakeRunHost(hostBirth, { rejectStop: true, child }),
      processSignals: {
        readProcessIdentity: async (pid) => {
          if (pid === process.pid) return hostBirth;
          throw new Error("child census unavailable");
        },
        isProcessGroupAlive: () => true,
      },
    });
    const spawned = await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: "controller-lifecycle-test",
      kind: "stub",
      home,
      sessionId: "thread-live",
      creds: { files: [{ homeRelPath: "old.json", contentB64: Buffer.from("old-secret").toString("base64"), mode: 0o600 }] },
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX) as AuthorityReceipt;
    const authority = authorityParams(spawned);

    const killed = await controller.methods.kill!({ bee, ...authority }, CTX) as { ok?: boolean; error?: string };
    assert.equal(killed.ok, false);
    assert.match(killed.error ?? "", /stop unconfirmed/);
    assert.equal(await readFile(credential, "utf8"), "old-secret");
    assert.equal(existsSync(hsrRunDir(bee)), true);

    const refreshed = await controller.methods.refreshCreds!({
      bee,
      ...authority,
      creds: { files: [{ homeRelPath: "new.json", contentB64: Buffer.from("new-secret").toString("base64"), mode: 0o600 }] },
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(refreshed.ok, false);
    assert.match(refreshed.error ?? "", /stopping/);
    assert.equal(await readFile(credential, "utf8"), "old-secret");
    assert.deepEqual(await readDeliveredCredentials(bee), [await realpath(credential)]);

    await assert.rejects(controller.close(), /unconfirmed HSR runtimes.*rejecting-live-handle/);
    assert.equal(existsSync(hsrRunDir(bee)), true);
    assert.equal(await readFile(credential, "utf8"), "old-secret");
  });
});

test("exact child absence cannot launder an unclosed source stream after in-memory stop rejects", async () => {
  await withTempStore(async () => {
    const bee = "rejecting-absent-handle";
    const hostBirth = await selfBirth();
    const controller = buildController({
      runHost: fakeRunHost(hostBirth, { rejectStop: true }),
      processSignals: { readProcessIdentity: async () => hostBirth },
    });
    const spawned = await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: "controller-lifecycle-test",
      kind: "stub",
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX) as AuthorityReceipt;
    const authority = authorityParams(spawned);
    const killed = await controller.methods.kill!({ bee, ...authority }, CTX) as { ok?: boolean; error?: string };
    assert.equal(killed.ok, false);
    assert.match(killed.error ?? "", /stop unconfirmed/);
    assert.equal(existsSync(hsrRunDir(bee)), true, "runtime and history authority remain occupied");
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(receipt, null, "child absence alone cannot claim that the rejecting live host stopped");
  });
});

test("credential erase failure blocks kill run-dir removal and an idempotent retry succeeds", async () => {
  await withTempStore(async (dir) => {
    const bee = "erase-retry-kill";
    const hostBirth = await selfBirth();
    const home = join(dir, "home");
    const credential = join(home, "auth.json");
    let rejectErase = true;
    const controller = buildController({
      runHost: fakeRunHost(hostBirth),
      processSignals: { readProcessIdentity: async () => hostBirth },
      shredCredentials: async (target) => {
        if (rejectErase) return { ok: false, error: "injected erase failure" };
        await shredDeliveredCredentials(target);
        return { ok: true };
      },
    });
    const spawned = await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: "controller-lifecycle-test",
      kind: "stub",
      home,
      creds: { files: [{ homeRelPath: "auth.json", contentB64: Buffer.from("secret").toString("base64"), mode: 0o600 }] },
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX) as AuthorityReceipt;
    const authority = authorityParams(spawned);

    const first = await controller.methods.kill!({ bee, ...authority }, CTX) as { ok?: boolean; error?: string };
    assert.equal(first.ok, false);
    assert.match(first.error ?? "", /credential erasure unconfirmed/);
    assert.equal(await readFile(credential, "utf8"), "secret");
    assert.equal(existsSync(hsrRunDir(bee)), true);

    rejectErase = false;
    const retry = await controller.methods.kill!({ bee, ...authority }, CTX) as { ok?: boolean };
    assert.equal(retry.ok, true);
    assert.equal(existsSync(credential), false);
    assert.equal(existsSync(hsrRunDir(bee)), false);
    await controller.close();
  });
});

test("credential erase failure blocks refresh replacement and retry safely resumes", async () => {
  await withTempStore(async (dir) => {
    const bee = "erase-retry-refresh";
    const hostBirth = await selfBirth();
    const home = join(dir, "home");
    const oldCredential = join(home, "old.json");
    const newCredential = join(home, "new.json");
    let rejectErase = true;
    const controller = buildController({
      runHost: fakeRunHost(hostBirth),
      processSignals: { readProcessIdentity: async () => hostBirth },
      shredCredentials: async (target) => {
        if (rejectErase) throw new Error("injected erase failure");
        await shredDeliveredCredentials(target);
      },
    });
    const spawned = await controller.methods.spawn!({
      bee,
      launchId: randomUUID(),
      consumerId: "controller-lifecycle-test",
      kind: "stub",
      home,
      sessionId: "thread-refresh",
      creds: { files: [{ homeRelPath: "old.json", contentB64: Buffer.from("old").toString("base64"), mode: 0o600 }] },
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX) as AuthorityReceipt;
    const authority = authorityParams(spawned);

    const request = {
      bee,
      ...authority,
      creds: { files: [{ homeRelPath: "new.json", contentB64: Buffer.from("new").toString("base64"), mode: 0o600 }] },
    };
    const first = await controller.methods.refreshCreds!(request, CTX) as { ok?: boolean; error?: string };
    assert.equal(first.ok, false);
    assert.match(first.error ?? "", /old credential erasure unconfirmed/);
    assert.equal(await readFile(oldCredential, "utf8"), "old");
    assert.equal(existsSync(newCredential), false);

    rejectErase = false;
    const retry = await controller.methods.refreshCreds!(request, CTX) as { ok?: boolean; sessionId?: string; error?: string };
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.sessionId, "thread-refresh");
    assert.equal(existsSync(oldCredential), false);
    assert.equal(await readFile(newCredential, "utf8"), "new");
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
    await controller.close();
  });
});
