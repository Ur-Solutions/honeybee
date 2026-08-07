import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  accountDir,
  activationHomeOwnerPath,
  addAccount,
  canonicalActivationHomePath,
  type AccountRecord,
} from "../src/accounts.js";
import {
  credentialHarvestQueueRoot,
  listCredentialHarvestWorkItems,
} from "../src/accounts/credentialHarvestQueue.js";
import { runCredentialSweep } from "../src/daemon/credentialSweep.js";
import { ensureHsrRunDir, hsrEventsPath } from "../src/hsr/runDir.js";
import { purgeSessionData, transactionalRetire } from "../src/kill.js";
import { recordSeal, sealsRoot, validateSealArtifact } from "../src/seal.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { KillResult, Substrate } from "../src/substrates/types.js";

process.env.HIVE_KIT_DISABLE = "1";

async function withTempStore<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hive-harvest-recovery-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const previousKeychain = process.env.HIVE_NO_KEYCHAIN;
  process.env.HIVE_STORE_ROOT = root;
  process.env.HIVE_NO_KEYCHAIN = "1";
  try {
    return await fn(root);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    if (previousKeychain === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = previousKeychain;
    await rm(root, { recursive: true, force: true });
  }
}

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${body}.signature`;
}

function codexAuth(email: string, refreshedAt: string, token: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: fakeJwt({ email }),
      access_token: `access-${token}`,
      refresh_token: `refresh-${token}`,
      account_id: `provider-${email}`,
    },
    last_refresh: refreshedAt,
  });
}

async function writeDated(path: string, content: string, timestamp: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
  const when = new Date(timestamp);
  await utimes(path, when, when);
}

function record(account: AccountRecord, homePath: string, name: string): SessionRecord {
  return {
    name,
    agent: "codex",
    accountId: account.id,
    homePath,
    cwd: "/tmp",
    command: "codex --token embedded-command-secret",
    notes: "embedded-notes-secret",
    tmuxTarget: name,
    createdAt: "2026-08-07T09:00:00.000Z",
    updatedAt: "2026-08-07T09:00:00.000Z",
    runtimeGeneration: 7,
    status: "dead",
  };
}

async function seedCredentials(root: string, label: string): Promise<{
  account: AccountRecord;
  home: string;
  vault: string;
}> {
  const email = `${label}@example.com`;
  const account = await addAccount("codex", email);
  const home = join(root, "custom-homes", label);
  const vault = join(accountDir(account), "auth.json");
  await writeDated(vault, codexAuth(email, "2026-08-01T00:00:00.000Z", `${label}-old`), "2026-08-01T00:00:00.000Z");
  await writeDated(join(home, "auth.json"), codexAuth(email, "2026-08-07T09:30:00.000Z", `${label}-rotated`), "2026-08-07T09:30:00.000Z");
  return { account, home, vault };
}

async function addArtifacts(candidate: SessionRecord): Promise<void> {
  await recordSeal(candidate.name, validateSealArtifact({ status: "done", summary: "temporary seal" }));
  await ensureHsrRunDir(candidate.name);
  await writeFile(hsrEventsPath(candidate.name), "temporary events\n");
}

function gone(path: string): Promise<null> {
  return readFile(path, "utf8").then(() => {
    assert.fail(`expected ${path} to be absent`);
  }, () => null);
}

function killOk(): KillResult {
  return { ok: true, stdout: "", stderr: "", exitCode: 0 };
}

function stoppedSubstrate(): Substrate {
  return {
    kind: "local-tmux",
    node: "local",
    hasSession: async () => false,
    kill: async () => killOk(),
  } as unknown as Substrate;
}

test("custom-home final harvest failure/timeout survives purge and restart, then succeeds", async () => {
  await withTempStore(async (root) => {
    let releaseTimedOutSync!: () => void;
    const timedOutSync = new Promise<void>((resolve) => { releaseTimedOutSync = resolve; });
    const cases = [
      { label: "failure", sync: async () => { throw new Error("keychain unavailable"); } },
      { label: "timeout", sync: async () => timedOutSync },
    ];
    const seeded: Array<Awaited<ReturnType<typeof seedCredentials>>> = [];
    for (const scenario of cases) {
      const credential = await seedCredentials(root, scenario.label);
      seeded.push(credential);
      const candidate = record(credential.account, credential.home, `CO.${scenario.label}`);
      await saveSession(candidate);
      await addArtifacts(candidate);
      await purgeSessionData(candidate, {
        emitLedger: false,
        finalCredentialSync: scenario.sync,
        finalCredentialSyncBudgetMs: 20,
      });

      assert.equal(await loadSession(candidate.name), null, "metadata purge still completes after durable handoff");
      await assert.rejects(() => readdir(join(sealsRoot(), candidate.name)), /ENOENT/);
      await gone(hsrEventsPath(candidate.name));
    }

    const queued = await listCredentialHarvestWorkItems();
    assert.equal(queued.length, 2);
    releaseTimedOutSync();
    await timedOutSync;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      (await listCredentialHarvestWorkItems()).length,
      2,
      "late settlement of a non-cancellable injected sync cannot remove quarantine",
    );
    const rawQueueEntries = await Promise.all(
      (await readdir(credentialHarvestQueueRoot())).map((entry) => readFile(join(credentialHarvestQueueRoot(), entry), "utf8")),
    );
    const rawQueue = rawQueueEntries.join("\n");
    for (const forbidden of [
      "access-failure-rotated",
      "refresh-failure-rotated",
      "access-timeout-rotated",
      "refresh-timeout-rotated",
      "embedded-command-secret",
      "embedded-notes-secret",
    ]) assert.doesNotMatch(rawQueue, new RegExp(forbidden), `queue must not persist ${forbidden}`);
    const allowedQueueFields = new Set([
      "version", "id", "accountId", "home", "evidence", "createdAt", "updatedAt",
      "attempts", "lastAttemptAt", "lastOutcome",
    ]);
    for (const raw of rawQueueEntries) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.ok(Object.keys(parsed).every((key) => allowedQueueFields.has(key)), "queue schema rejects arbitrary secret fields");
    }

    // A fresh invocation models daemon restart: it reconstructs all work from
    // the queue directory, without SessionRecord or in-memory state.
    const sweep = await runCredentialSweep({ accountHomes: async () => [], concurrency: 1 });
    assert.equal(sweep.quarantinedItems, 2);
    assert.equal(sweep.completedQuarantinedItems, 2);
    assert.equal(sweep.retainedQuarantinedItems, 0);
    assert.equal((await listCredentialHarvestWorkItems()).length, 0);
    for (const credential of seeded) {
      assert.match(await readFile(credential.vault, "utf8"), new RegExp(`access-${credential.account.label.split("@")[0]}-rotated`));
    }
  });
});

test("rebound owner and newer foreign session evidence retain quarantined work closed", async () => {
  await withTempStore(async (root) => {
    const original = await seedCredentials(root, "original");
    const foreign = await addAccount("codex", "foreign@example.com");
    const reboundRecord = record(original.account, original.home, "CO.rebound-source");
    await saveSession(reboundRecord);
    const ownerPath = await activationHomeOwnerPath(original.home);
    await mkdir(dirname(ownerPath), { recursive: true });
    await writeFile(ownerPath, JSON.stringify({
      version: 1,
      homePath: await canonicalActivationHomePath(original.home),
      accountId: original.account.id,
      generation: "original-owner-generation",
      state: "ready",
      activatedAt: "2026-08-07T09:00:00.000Z",
      updatedAt: "2026-08-07T09:00:00.000Z",
    }));
    await purgeSessionData(reboundRecord, {
      emitLedger: false,
      finalCredentialSync: async () => { throw new Error("temporary failure"); },
    });

    await writeFile(ownerPath, JSON.stringify({
      version: 1,
      homePath: await canonicalActivationHomePath(original.home),
      accountId: foreign.id,
      generation: "foreign-rebound-generation",
      state: "ready",
      activatedAt: "2026-08-07T10:00:00.000Z",
      updatedAt: "2026-08-07T10:00:00.000Z",
    }));
    await writeDated(
      join(original.home, "auth.json"),
      codexAuth("foreign@example.com", "2026-08-07T10:00:00.000Z", "foreign-owner"),
      "2026-08-07T10:00:00.000Z",
    );

    const reboundSweep = await runCredentialSweep({ accountHomes: async () => [], concurrency: 1 });
    assert.equal(reboundSweep.completedQuarantinedItems, 0);
    assert.equal(reboundSweep.retainedQuarantinedItems, 1);
    assert.match(await readFile(original.vault, "utf8"), /access-original-old/);
    assert.equal((await listCredentialHarvestWorkItems())[0]?.lastOutcome, "home-rebound");

    const legacy = await seedCredentials(root, "legacy");
    const legacySource = record(legacy.account, legacy.home, "CO.legacy-source");
    await saveSession(legacySource);
    await purgeSessionData(legacySource, {
      emitLedger: false,
      finalCredentialSync: async () => { throw new Error("temporary failure"); },
    });
    await saveSession({
      ...record(foreign, legacy.home, "CO.foreign-live"),
      updatedAt: "2026-08-07T10:05:00.000Z",
      status: "running",
    });
    const foreignSweep = await runCredentialSweep({ accountHomes: async () => [], concurrency: 1 });
    assert.equal(foreignSweep.completedQuarantinedItems, 0);
    assert.equal(foreignSweep.retainedQuarantinedItems, 2);
    assert.match(await readFile(legacy.vault, "utf8"), /access-legacy-old/);
    const legacyItem = (await listCredentialHarvestWorkItems()).find((item) => item.accountId === legacy.account.id);
    assert.equal(legacyItem?.lastOutcome, "home-rebound");
  });
});

test("quarantine is removed only after positive credential content evidence", async () => {
  await withTempStore(async (root) => {
    const credential = await seedCredentials(root, "positive-only");
    const candidate = record(credential.account, credential.home, "CO.positive-only");
    await saveSession(candidate);
    await purgeSessionData(candidate, {
      emitLedger: false,
      finalCredentialSync: async () => { throw new Error("temporary failure"); },
    });
    await rm(join(credential.home, "auth.json"));

    const missing = await runCredentialSweep({ accountHomes: async () => [], concurrency: 1 });
    assert.equal(missing.completedQuarantinedItems, 0);
    assert.equal(missing.retainedQuarantinedItems, 1);
    assert.equal((await listCredentialHarvestWorkItems())[0]?.lastOutcome, "no-credential-evidence");

    await writeDated(
      join(credential.home, "auth.json"),
      codexAuth("positive-only@example.com", "2026-08-07T10:00:00.000Z", "positive-only-later"),
      "2026-08-07T10:00:00.000Z",
    );
    const positive = await runCredentialSweep({ accountHomes: async () => [], concurrency: 1 });
    assert.equal(positive.completedQuarantinedItems, 1);
    assert.equal((await listCredentialHarvestWorkItems()).length, 0);
  });
});

test("quarantine enqueue and duplicate purge are idempotent across the crash window", async () => {
  await withTempStore(async (root) => {
    const credential = await seedCredentials(root, "crash");
    const candidate = record(credential.account, credential.home, "CO.crash-window");
    await saveSession(candidate);
    await addArtifacts(candidate);
    const interruptedOptions = {
      emitLedger: false,
      finalCredentialSync: async () => { throw new Error("temporary failure"); },
      afterFinalCredentialQuarantine: async () => { throw new Error("simulated crash after atomic queue write"); },
    };

    await assert.rejects(() => purgeSessionData(candidate, interruptedOptions), /refusing to purge/);
    await assert.rejects(() => purgeSessionData(candidate, interruptedOptions), /refusing to purge/);
    assert.equal((await listCredentialHarvestWorkItems()).length, 1, "duplicate handoff upserts one physical account/home item");
    assert.ok(await loadSession(candidate.name), "record-last purge has not begun at the crash barrier");
    assert.ok((await readdir(join(sealsRoot(), candidate.name))).length > 0);
    assert.match(await readFile(hsrEventsPath(candidate.name), "utf8"), /temporary events/);

    const recovered = await runCredentialSweep({ accountHomes: async () => [], concurrency: 1 });
    assert.equal(recovered.completedQuarantinedItems, 1, "restart recovery can run before purge retry");
    assert.equal((await listCredentialHarvestWorkItems()).length, 0);

    await purgeSessionData(candidate, { emitLedger: false, finalCredentialSync: async () => undefined });
    await purgeSessionData(candidate, { emitLedger: false, finalCredentialSync: async () => assert.fail("idempotent duplicate must not resync") });
    assert.equal(await loadSession(candidate.name), null);
    await assert.rejects(() => readdir(join(sealsRoot(), candidate.name)), /ENOENT/);
    await gone(hsrEventsPath(candidate.name));
  });
});

test("retire preserves history as its retry contract while purge preserves only quarantine", async () => {
  await withTempStore(async (root) => {
    const retiredCredential = await seedCredentials(root, "retire-mode");
    const retired = record(retiredCredential.account, retiredCredential.home, "CO.retire-mode");
    await saveSession(retired);
    await addArtifacts(retired);
    const retiredOutcome = await transactionalRetire(retired, {
      substrate: stoppedSubstrate(),
      emitLedger: false,
      finalCredentialSync: async () => { throw new Error("temporary failure"); },
      pollIntervalMs: 0,
    });
    assert.equal(retiredOutcome.ok, true);
    assert.equal((await loadSession(retired.name))?.status, "done");
    assert.ok((await readdir(join(sealsRoot(), retired.name))).length > 0);
    assert.match(await readFile(hsrEventsPath(retired.name), "utf8"), /temporary events/);
    assert.equal((await listCredentialHarvestWorkItems()).length, 0, "retire's retained record is already the durable retry handle");

    const purgedCredential = await seedCredentials(root, "purge-mode");
    const purged = record(purgedCredential.account, purgedCredential.home, "CO.purge-mode");
    await saveSession(purged);
    await addArtifacts(purged);
    await purgeSessionData(purged, {
      emitLedger: false,
      finalCredentialSync: async () => { throw new Error("temporary failure"); },
    });
    assert.equal(await loadSession(purged.name), null);
    await assert.rejects(() => readdir(join(sealsRoot(), purged.name)), /ENOENT/);
    await gone(hsrEventsPath(purged.name));
    assert.equal((await listCredentialHarvestWorkItems()).length, 1, "purge retains only the secret-free recovery artifact");
  });
});
