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
  listActiveSessions,
  listSessions,
  rebuildActiveSessionIndex,
  type SessionRecord,
} from "../src/store.js";

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

test("active index scales at 100/1k/3k/10k with 95% terminal history", { timeout: 120_000 }, async (t) => {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  try {
    for (const count of [100, 1_000, 3_000, 10_000]) {
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
        const active = await listActiveSessions();
        const hotMs = performance.now() - hotStarted;

        const expectedActive = count / 20;
        assert.equal(full.length, count);
        assert.equal(indexed, expectedActive);
        assert.equal(active.length, expectedActive);
        assert.ok(active.every((candidate) => candidate.status === "running" && candidate.lastObservedState === undefined));

        const manifest = JSON.parse(await readFile(activeSessionIndexPath(), "utf8")) as { active: string[] };
        assert.equal(manifest.active.length, expectedActive, "steady-state candidates equal 5% of history");
        t.diagnostic(
          `session-hotpath n=${count} terminal=95% fullRows=${full.length} hotRows=${active.length} ` +
          `full=${fullMs.toFixed(1)}ms rebuild=${rebuildMs.toFixed(1)}ms hot=${hotMs.toFixed(1)}ms`,
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
    const active = await listActiveSessions();
    assert.equal(active.length, 40);
    assert.equal(new Set(active.map((candidate) => candidate.name)).size, 40);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
