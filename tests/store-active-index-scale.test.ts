import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  activeSessionIndexPath,
  listActiveSessionsHot,
  listSessions,
  rebuildActiveSessionIndex,
  touchSession,
  type SessionRecord,
} from "../src/store.js";
import { accountCommitments } from "../src/limits/commitments.js";

const execFileAsync = promisify(execFile);

function record(index: number, root: string): SessionRecord {
  const slot = index % 20;
  const terminal = slot !== 0;
  return {
    name: `CO.${String(index).padStart(5, "0")}`,
    agent: index % 2 === 0 ? "codex" : "claude",
    cwd: root,
    command: "agent",
    tmuxTarget: `CO-${index}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + index).toISOString(),
    status: !terminal ? "running" : slot < 9 ? "done" : slot < 14 ? "dead" : "running",
    ...(slot >= 14 ? { lastObservedState: slot % 3 === 0 ? "done" : slot % 3 === 1 ? "sealed" : "crashed" } : {}),
  };
}

async function seedScale(root: string, count: number): Promise<void> {
  const dir = join(root, "sessions");
  await mkdir(dir, { recursive: true });
  for (let offset = 0; offset < count; offset += 250) {
    await Promise.all(Array.from({ length: Math.min(250, count - offset) }, (_, inner) => {
      const candidate = record(offset + inner, root);
      return writeFile(join(dir, `${candidate.name}.json`), JSON.stringify(candidate));
    }));
  }
}

async function seedHeartbeatScale(root: string, count: number): Promise<void> {
  const dir = join(root, "sessions");
  await mkdir(dir, { recursive: true });
  for (let offset = 0; offset < count; offset += 250) {
    await Promise.all(Array.from({ length: Math.min(250, count - offset) }, (_, inner) => {
      const index = offset + inner;
      const candidate = record(index, root);
      const heartbeatCandidate: SessionRecord = index % 20 === 0 ? {
        ...candidate,
        accountId: `codex-${index % 4}`,
        lastObservedState: "working",
        lastObservedStateAt: "2026-08-01T00:00:00.000Z",
      } : candidate;
      return writeFile(join(dir, `${heartbeatCandidate.name}.json`), JSON.stringify(heartbeatCandidate));
    }));
  }
}

const SCALE = process.env.HIVE_TEST_SCALE === "1";

test("active index scales at 100/1k/3k/10k with 95% terminal history", { timeout: SCALE ? 120_000 : 30_000 }, async (t) => {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    // 3k/10k file writes belong on HIVE_TEST_SCALE=1 — they dominate `npm test`
    // wall time and hammer FSEvents on a shared workstation.
    for (const count of SCALE ? [100, 1_000, 3_000, 10_000] : [100, 1_000]) {
      const root = await mkdtemp(join(tmpdir(), `honeybee-hotpath-${count}-`));
      process.env.HIVE_STORE_ROOT = root;
      try {
        await seedScale(root, count);

        const fullStarted = performance.now();
        const full = await listSessions();
        const fullMs = performance.now() - fullStarted;

        const rebuildStarted = performance.now();
        const indexed = await rebuildActiveSessionIndex();
        const rebuildMs = performance.now() - rebuildStarted;

        const hotStarted = performance.now();
        const active = await listActiveSessionsHot();
        const hotMs = performance.now() - hotStarted;

        // All status:running records stay probeable, including the six slots
        // carrying terminal observation cursors (7/20 total).
        const expectedActive = count * 7 / 20;
        assert.equal(full.length, count);
        assert.equal(indexed, expectedActive);
        assert.equal(active.length, expectedActive);
        assert.ok(active.every((candidate) => candidate.status === "running"));
        assert.ok(active.some((candidate) => candidate.lastObservedState === "crashed"));

        const manifestText = await readFile(activeSessionIndexPath(), "utf8");
        const manifest = JSON.parse(manifestText) as { active: string[]; reconciledAt: string };
        assert.equal(manifest.active.length, expectedActive, "every active lifecycle remains in the probe set");

        const repeatStarted = performance.now();
        for (let pass = 0; pass < 5; pass += 1) {
          assert.equal((await listActiveSessionsHot()).length, expectedActive);
        }
        const repeatMs = performance.now() - repeatStarted;
        assert.equal(
          await readFile(activeSessionIndexPath(), "utf8"),
          manifestText,
          "fresh repeated hot reads do not rewrite/rebuild the canonical index",
        );
        t.diagnostic(
          `session-hotpath n=${count} terminal=95% fullRows=${full.length} hotRows=${active.length} ` +
          `full=${fullMs.toFixed(1)}ms rebuild=${rebuildMs.toFixed(1)}ms hot=${hotMs.toFixed(1)}ms ` +
          `hot5=${repeatMs.toFixed(1)}ms reconciled=${manifest.reconciledAt}`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
  }
});

test("fresh direct-list process trusts an unchanged directory generation without scanning history", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-index-fresh-process-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    process.env.HIVE_STORE_ROOT = root;
    await seedScale(root, 100);
    await rebuildActiveSessionIndex();
    const before = await readFile(activeSessionIndexPath(), "utf8");
    const env = { ...process.env, HIVE_STORE_ROOT: root };
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      'import { listActiveSessions } from "./src/store.ts"; process.stdout.write(String((await listActiveSessions()).length));',
    ], { cwd: process.cwd(), env });
    assert.equal(stdout, "35");
    assert.equal(
      await readFile(activeSessionIndexPath(), "utf8"),
      before,
      "a first call in a new process performs only cheap freshness reads when the generation is covered",
    );
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("continuous active heartbeats keep strict commitments hot at 3k/10k", {
  timeout: 120_000,
  skip: !SCALE && "set HIVE_TEST_SCALE=1 for 3k/10k heartbeat benches",
}, async (t) => {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    for (const count of [3_000, 10_000]) {
      const root = await mkdtemp(join(tmpdir(), `honeybee-heartbeat-scale-${count}-`));
      process.env.HIVE_STORE_ROOT = root;
      let running = true;
      let writer: Promise<void> | null = null;
      try {
        await seedHeartbeatScale(root, count);
        await rebuildActiveSessionIndex();
        const indexBefore = await readFile(activeSessionIndexPath(), "utf8");
        let heartbeat = 0;
        let firstHeartbeat!: () => void;
        const firstHeartbeatWritten = new Promise<void>((resolve) => { firstHeartbeat = resolve; });
        writer = (async () => {
          while (running) {
            const activeIndex = (heartbeat % (count / 20)) * 20;
            heartbeat += 1;
            await touchSession(`CO.${String(activeIndex).padStart(5, "0")}`, {
              lastObservedState: "working",
              lastObservedStateAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + heartbeat * 61_000).toISOString(),
            });
            if (heartbeat === 1) firstHeartbeat();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })();
        await firstHeartbeatWritten;

        const latencies: number[] = [];
        for (let pass = 0; pass < 5; pass += 1) {
          const started = performance.now();
          const commitments = await accountCommitments("codex");
          latencies.push(performance.now() - started);
          assert.ok([...commitments.values()].reduce((sum, value) => sum + value, 0) > 0);
        }
        running = false;
        await writer;
        writer = null;

        assert.equal(
          await readFile(activeSessionIndexPath(), "utf8"),
          indexBefore,
          "continuous same-state heartbeats must cause zero membership rebuilds",
        );
        const sorted = [...latencies].sort((left, right) => left - right);
        t.diagnostic(
          `heartbeat-commitments n=${count} active=${count / 20} rebuilds=0 writes=${heartbeat} ` +
          `p50=${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)}ms max=${Math.max(...latencies).toFixed(1)}ms`,
        );
      } finally {
        running = false;
        await writer?.catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
  }
});

test("a cross-process legacy writer remains visible during a modern heartbeat", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-heartbeat-legacy-race-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    process.env.HIVE_STORE_ROOT = root;
    const indexed: SessionRecord = {
      ...record(0, root),
      accountId: "indexed-account",
      lastObservedState: "working",
      lastObservedStateAt: "2026-08-01T00:00:00.000Z",
    };
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "sessions", `${indexed.name}.json`), JSON.stringify(indexed));
    await rebuildActiveSessionIndex();

    const legacy: SessionRecord = {
      ...indexed,
      name: "CO.legacy-race",
      tmuxTarget: "CO-legacy-race",
      accountId: "legacy-account",
    };
    const env = { ...process.env, HIVE_STORE_ROOT: root, LEGACY_RECORD: JSON.stringify(legacy) };
    await touchSession(indexed.name, {
      lastObservedState: "working",
      lastObservedStateAt: "2026-08-01T00:01:01.000Z",
    }, {
      onBeforeObservationWrite: async () => {
        await execFileAsync(process.execPath, [
          "--input-type=module",
          "--eval",
          'import { writeFile } from "node:fs/promises"; import { join } from "node:path"; const value = JSON.parse(process.env.LEGACY_RECORD); await writeFile(join(process.env.HIVE_STORE_ROOT, "sessions", `${value.name}.json`), JSON.stringify(value));',
        ], { cwd: process.cwd(), env });
      },
    });

    const commitments = await accountCommitments("codex");
    assert.equal(commitments.get("indexed-account"), 8);
    assert.equal(commitments.get("legacy-account"), 8, "strict selection rebuilds for the un-signalled writer");
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("separate heartbeat writers preserve the newest observation lease", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-heartbeat-processes-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    process.env.HIVE_STORE_ROOT = root;
    const indexed: SessionRecord = {
      ...record(0, root),
      lastObservedState: "working",
      lastObservedStateAt: "2026-08-01T00:00:00.000Z",
    };
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "sessions", `${indexed.name}.json`), JSON.stringify(indexed));
    await rebuildActiveSessionIndex();
    const indexBefore = await readFile(activeSessionIndexPath(), "utf8");
    const env = { ...process.env, HIVE_STORE_ROOT: root };
    const writer = (observedAt: string) => execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { touchSession } from "./src/store.ts"; await touchSession("${indexed.name}", { lastObservedState: "working", lastObservedStateAt: "${observedAt}" });`,
    ], { cwd: process.cwd(), env });

    await Promise.all([
      writer("2026-08-01T00:01:01.000Z"),
      writer("2026-08-01T00:02:02.000Z"),
    ]);

    assert.equal(
      (await listActiveSessionsHot())[0]?.lastObservedStateAt,
      "2026-08-01T00:02:02.000Z",
      "lock serialization plus monotonic persistence prevents an older writer from winning",
    );
    assert.equal(await readFile(activeSessionIndexPath(), "utf8"), indexBefore);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("separate writer processes serialize active-index membership without lost updates", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-index-processes-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const writer = (prefix: string) => `
    import { saveSession } from "./src/store.ts";
    await Promise.all(Array.from({ length: 20 }, (_, index) => saveSession({
      name: "${prefix}." + String(index).padStart(2, "0"),
      agent: "codex",
      cwd: process.env.HIVE_STORE_ROOT,
      command: "codex",
      tmuxTarget: "${prefix}-" + index,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      status: "running"
    })));
  `;
  try {
    process.env.HIVE_STORE_ROOT = root;
    const env = { ...process.env, HIVE_STORE_ROOT: root };
    await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", writer("CO.left")], { cwd: process.cwd(), env }),
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", writer("CO.right")], { cwd: process.cwd(), env }),
    ]);
    const active = await listActiveSessionsHot();
    assert.equal(active.length, 40);
    assert.equal(new Set(active.map((candidate) => candidate.name)).size, 40);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
