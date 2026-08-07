import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HsrHostHandle } from "../src/hsr/host.js";
import { captureProcessBirthFingerprint, type ProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import { readDeliveredCredentials, shredDeliveredCredentials } from "../src/hsr/remoteCreds.js";
import { buildController } from "../src/hsr/remoteHost.js";
import { hsrControlSocketPath, hsrRunDir, readHsrMetaStrict, writeHsrMeta } from "../src/hsr/runDir.js";

const CTX = { connectionId: 1, close() {} };

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
  options: { rejectStop?: boolean; child?: { pid: number; birth: ProcessBirthFingerprint } } = {},
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
    return {
      bee: params.bee,
      controlSocket: running.controlSocket,
      done: new Promise<void>(() => undefined),
      async stop() {
        if (options.rejectStop) throw new Error("injected handle stop rejection");
        await writeHsrMeta(params.bee, {
          ...running,
          status: "exited",
          endedAt: new Date().toISOString(),
        });
      },
    };
  };
}

async function selfBirth(): Promise<ProcessBirthFingerprint> {
  const fingerprint = await captureProcessBirthFingerprint(process.pid);
  assert.ok(fingerprint);
  return fingerprint;
}

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
      kind: "stub",
      home,
      sessionId: "thread-live",
      creds: { files: [{ homeRelPath: "old.json", contentB64: Buffer.from("old-secret").toString("base64"), mode: 0o600 }] },
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX) as { ok?: boolean };
    assert.equal(spawned.ok, true);

    const killed = await controller.methods.kill!({ bee }, CTX) as { ok?: boolean; error?: string };
    assert.equal(killed.ok, false);
    assert.match(killed.error ?? "", /stop unconfirmed/);
    assert.equal(await readFile(credential, "utf8"), "old-secret");
    assert.equal(existsSync(hsrRunDir(bee)), true);

    const refreshed = await controller.methods.refreshCreds!({
      bee,
      creds: { files: [{ homeRelPath: "new.json", contentB64: Buffer.from("new-secret").toString("base64"), mode: 0o600 }] },
    }, CTX) as { ok?: boolean; error?: string };
    assert.equal(refreshed.ok, false);
    assert.match(refreshed.error ?? "", /stop unconfirmed/);
    assert.equal(await readFile(credential, "utf8"), "old-secret");
    assert.deepEqual(await readDeliveredCredentials(bee), [credential]);

    await assert.rejects(controller.close(), /unconfirmed HSR runtimes.*rejecting-live-handle/);
    assert.equal(existsSync(hsrRunDir(bee)), true);
    assert.equal(await readFile(credential, "utf8"), "old-secret");
  });
});

test("rejecting in-memory stop may continue only after exact child absence is proven", async () => {
  await withTempStore(async () => {
    const bee = "rejecting-absent-handle";
    const hostBirth = await selfBirth();
    const controller = buildController({
      runHost: fakeRunHost(hostBirth, { rejectStop: true }),
      processSignals: { readProcessIdentity: async () => hostBirth },
    });
    const spawned = await controller.methods.spawn!({
      bee,
      kind: "stub",
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX) as { ok?: boolean };
    assert.equal(spawned.ok, true);
    const killed = await controller.methods.kill!({ bee }, CTX) as { ok?: boolean };
    assert.equal(killed.ok, true);
    assert.equal(existsSync(hsrRunDir(bee)), false);
    await controller.close();
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
    await controller.methods.spawn!({
      bee,
      kind: "stub",
      home,
      creds: { files: [{ homeRelPath: "auth.json", contentB64: Buffer.from("secret").toString("base64"), mode: 0o600 }] },
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX);

    const first = await controller.methods.kill!({ bee }, CTX) as { ok?: boolean; error?: string };
    assert.equal(first.ok, false);
    assert.match(first.error ?? "", /credential erasure unconfirmed/);
    assert.equal(await readFile(credential, "utf8"), "secret");
    assert.equal(existsSync(hsrRunDir(bee)), true);

    rejectErase = false;
    const retry = await controller.methods.kill!({ bee }, CTX) as { ok?: boolean };
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
    await controller.methods.spawn!({
      bee,
      kind: "stub",
      home,
      sessionId: "thread-refresh",
      creds: { files: [{ homeRelPath: "old.json", contentB64: Buffer.from("old").toString("base64"), mode: 0o600 }] },
      spec: { command: process.execPath, args: [], env: {} },
    }, CTX);

    const request = {
      bee,
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
