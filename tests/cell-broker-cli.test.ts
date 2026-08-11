import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CELL_BROKER_DENIAL_PREFIX } from "../src/cellBroker.js";
import { startHsrControlServer } from "../src/daemon/hsrControl.js";
import { capturePersistableProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import { startRpcServer } from "../src/hsr/rpc.js";
import { writeHsrMeta } from "../src/hsr/runDir.js";
import { listSeals } from "../src/seal.js";
import type { BeeViewV1 } from "../src/view/types.js";

const execFileAsync = promisify(execFile);

async function seedSession(store: string, name: string, id = name, liveRunner = true): Promise<void> {
  const sessions = join(store, "sessions");
  await mkdir(sessions, { recursive: true });
  const now = "2026-08-10T12:00:00.000Z";
  await writeFile(join(sessions, `${name}.json`), `${JSON.stringify({
    name,
    id,
    agent: "codex",
    cwd: process.cwd(),
    command: "codex",
    tmuxTarget: `cell-broker-test-${name}`,
    substrate: "hsr",
    createdAt: now,
    updatedAt: now,
    status: "dead",
  }, null, 2)}\n`, { mode: 0o600 });
  if (liveRunner) {
    const hostFingerprint = await capturePersistableProcessBirthFingerprint(process.pid);
    assert.ok(hostFingerprint, "the test process must have a persistable birth fingerprint");
    await writeHsrMeta(name, {
      bee: name,
      harness: "codex",
      tier: "server",
      hostPid: process.pid,
      hostFingerprint,
      startedAt: new Date().toISOString(),
      controlSocket: join(store, `${name}.sock`),
      status: "running",
    });
  }
}

function cliEnv(store: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIVE_STORE_ROOT: store,
    HIVE_NO_KEYCHAIN: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function hive(store: string, env: Record<string, string | undefined>, ...args: string[]) {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: cliEnv(store, env),
  });
}

async function hiveFailure(store: string, env: Record<string, string | undefined>, ...args: string[]): Promise<string> {
  try {
    await hive(store, env, ...args);
    throw new Error("expected hive command to fail");
  } catch (error) {
    return (error as { stderr?: string }).stderr ?? "";
  }
}

async function withStore(fn: (store: string) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "hive-cell-broker-cli-"));
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

test("Cell CLI brokers buz send/inbox, self state, and self seal over the daemon socket", async () => {
  await withStore(async (store) => {
    await seedSession(store, "cell-caller", "CO.caller");
    await seedSession(store, "cell-recipient", "CO.recipient");
    const artifactPath = join(store, "seal-input.json");
    await writeFile(artifactPath, JSON.stringify({ status: "done", summary: "brokered from Cell", type: "implementation" }));
    const server = await startHsrControlServer();
    const env = { HIVE_CELL: "1", HIVE_BEE_NAME: "cell-caller" };
    try {
      const sent = await hive(store, env, "buz", "send", "cell-recipient", "--sender", "cell-caller", "--tier", "queue", "-p", "hello from Cell");
      assert.match(sent.stdout, /^buz\.send\tcell-recipient\t/m);
      assert.equal((await readdir(join(store, "buz", "cell-recipient", "queue"))).length, 1);

      await hive(store, env, "buz", "send", "cell-caller", "--tier", "passive", "-p", "self note");
      const inbox = await hive(store, env, "buz", "inbox", "cell-caller", "--limit", "1");
      assert.match(inbox.stdout, /^buz\.inbox\tcell-caller\t/m);
      assert.match(inbox.stdout, /CO\.caller/);

      const explained = await hive(store, env, "state", "explain", "cell-caller", "--json");
      const view = JSON.parse(explained.stdout) as BeeViewV1;
      assert.equal(view.bee.name, "cell-caller");

      const sealed = await hive(store, env, "seal", "cell-caller", "--from", artifactPath);
      assert.match(sealed.stdout, /^sealed\tcell-caller\tdone\timplementation\t/m);
      assert.equal((await listSeals("cell-caller"))[0]!.summary, "brokered from Cell");
    } finally {
      await server.close();
    }
  });
});

test("Cell CLI surfaces broker ACL denials with the Cell pointer", async () => {
  await withStore(async (store) => {
    await seedSession(store, "cell-caller");
    await seedSession(store, "cell-other");
    const artifactPath = join(store, "seal-input.json");
    await writeFile(artifactPath, JSON.stringify({ status: "done", summary: "must be denied" }));
    const server = await startHsrControlServer();
    const env = { HIVE_CELL: "1", HIVE_BEE_NAME: "cell-caller" };
    try {
      const failures = await Promise.all([
        hiveFailure(store, env, "buz", "send", "cell-caller", "--sender", "cell-other", "--tier", "queue", "-p", "forged"),
        hiveFailure(store, env, "buz", "inbox", "cell-other"),
        hiveFailure(store, env, "state", "explain", "cell-other", "--json"),
        hiveFailure(store, env, "seal", "cell-other", "--from", artifactPath),
      ]);
      for (const stderr of failures) {
        assert.match(stderr, new RegExp(CELL_BROKER_DENIAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(stderr, /cell-other is not granted/);
        assert.doesNotMatch(stderr, /EPERM|at .*\.ts:\d+/);
      }
      assert.equal((await listSeals("cell-other")).length, 0);
    } finally {
      await server.close();
    }
  });
});

test("Cell CLI refuses politely when neither HIVE_BEE_NAME nor HIVE_BEE is present", async () => {
  await withStore(async (store) => {
    const stderr = await hiveFailure(
      store,
      { HIVE_CELL: "1", HIVE_BEE_NAME: undefined, HIVE_BEE: undefined },
      "state", "ls", "--json",
    );
    assert.match(stderr, new RegExp(CELL_BROKER_DENIAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(stderr, /HIVE_BEE_NAME \(or the Cell-stamped HIVE_BEE\) is required/);
    assert.doesNotMatch(stderr, /EPERM|at .*\.ts:\d+/);
  });
});

test("Cell CLI derives identity from the runner-stamped HIVE_BEE when HIVE_BEE_NAME is absent", async () => {
  await withStore(async (store) => {
    await seedSession(store, "cell-caller");
    await seedSession(store, "cell-other");
    const server = await startHsrControlServer();
    const env = { HIVE_CELL: "1", HIVE_BEE_NAME: undefined, HIVE_BEE: "cell-caller" };
    try {
      // A self-inbox read succeeding proves the daemon accepted HIVE_BEE as
      // the caller identity; a cross-bee read is denied AS that identity.
      await hive(store, env, "buz", "send", "cell-caller", "--tier", "passive", "-p", "self note");
      const inbox = await hive(store, env, "buz", "inbox", "cell-caller", "--limit", "1");
      assert.match(inbox.stdout, /^buz\.inbox\tcell-caller\t/m);
      const stderr = await hiveFailure(store, env, "buz", "inbox", "cell-other");
      assert.match(stderr, /cell-other is not granted/);
    } finally {
      await server.close();
    }
  });
});

test("Cell CLI denies a dead caller claim with the standard Cell pointer", async () => {
  await withStore(async (store) => {
    await seedSession(store, "dead-cell", "CO.dead", false);
    const server = await startHsrControlServer();
    try {
      const stderr = await hiveFailure(
        store,
        { HIVE_CELL: "1", HIVE_BEE_NAME: "dead-cell" },
        "state", "explain", "dead-cell", "--json",
      );
      assert.match(stderr, new RegExp(CELL_BROKER_DENIAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(stderr, /no live birth-verified HSR runner/);
      assert.doesNotMatch(stderr, /EPERM|at .*\.ts:\d+/);
    } finally {
      await server.close();
    }
  });
});

test("Cell CLI old-daemon fallback refuses instead of touching Hive state directly", async () => {
  await withStore(async (store) => {
    await seedSession(store, "cell-caller");
    const socketPath = join(store, "daemon", "hsr-control.sock");
    const oldDaemon = await startRpcServer({
      socketPath,
      methods: {
        capabilities: async () => ({ ok: true, message: 1 }),
      },
    });
    try {
      const stderr = await hiveFailure(store, { HIVE_CELL: "1", HIVE_BEE_NAME: "cell-caller" }, "state", "explain", "cell-caller", "--json");
      assert.match(stderr, new RegExp(CELL_BROKER_DENIAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(stderr, /does not advertise broker:1/);
      assert.doesNotMatch(stderr, /EPERM|at .*\.ts:\d+/);
    } finally {
      await oldDaemon.close();
    }
  });
});

test("outside Cells the existing direct CLI path is unchanged and needs no daemon", async () => {
  await withStore(async (store) => {
    await seedSession(store, "direct-caller");
    await seedSession(store, "direct-recipient");
    const sent = await hive(store, { HIVE_CELL: undefined, HIVE_BEE_NAME: undefined }, "buz", "send", "direct-recipient", "--sender", "direct-caller", "--tier", "queue", "-p", "direct");
    assert.match(sent.stdout, /^buz\.send\tdirect-recipient\t/m);
    assert.equal((await readdir(join(store, "buz", "direct-recipient", "queue"))).length, 1);
  });
});
