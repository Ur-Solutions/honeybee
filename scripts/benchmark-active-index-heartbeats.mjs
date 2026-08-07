import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  activeSessionIndexPath,
  rebuildActiveSessionIndex,
  touchSession,
} from "../src/store.ts";
import { accountCommitments } from "../src/limits/commitments.ts";

const counts = process.argv.slice(2).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
const scales = counts.length > 0 ? counts : [3_000, 10_000];
const iterations = 8;
const baseTime = Date.parse("2026-08-01T00:00:00.000Z");

function record(index, root) {
  const active = index % 20 === 0;
  return {
    name: `CO.${String(index).padStart(5, "0")}`,
    agent: "codex",
    accountId: `codex-${index % 4}`,
    cwd: root,
    command: "codex",
    tmuxTarget: `CO-${index}`,
    createdAt: new Date(baseTime).toISOString(),
    updatedAt: new Date(baseTime + index).toISOString(),
    status: active ? "running" : "done",
    lastObservedState: active ? "working" : "done",
    lastObservedStateAt: new Date(baseTime).toISOString(),
  };
}

async function seed(root, count) {
  const directory = join(root, "sessions");
  await mkdir(directory, { recursive: true });
  for (let offset = 0; offset < count; offset += 250) {
    await Promise.all(Array.from({ length: Math.min(250, count - offset) }, (_, inner) => {
      const candidate = record(offset + inner, root);
      return writeFile(join(directory, `${candidate.name}.json`), JSON.stringify(candidate));
    }));
  }
}

for (const count of scales) {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const root = await mkdtemp(join(tmpdir(), `honeybee-heartbeat-bench-${count}-`));
  process.env.HIVE_STORE_ROOT = root;
  try {
    await seed(root, count);
    await rebuildActiveSessionIndex();
    let priorReconciledAt = JSON.parse(await readFile(activeSessionIndexPath(), "utf8")).reconciledAt;
    let rebuilds = 0;
    const latencies = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const activeIndex = (iteration * 20) % count;
      await touchSession(`CO.${String(activeIndex).padStart(5, "0")}`, {
        lastObservedState: "working",
        lastObservedStateAt: new Date(baseTime + (iteration + 1) * 61_000).toISOString(),
      });
      const started = performance.now();
      await accountCommitments("codex");
      latencies.push(performance.now() - started);
      const reconciledAt = JSON.parse(await readFile(activeSessionIndexPath(), "utf8")).reconciledAt;
      if (reconciledAt !== priorReconciledAt) rebuilds += 1;
      priorReconciledAt = reconciledAt;
    }
    const sorted = [...latencies].sort((left, right) => left - right);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    process.stdout.write(JSON.stringify({
      count,
      active: count / 20,
      iterations,
      rebuilds,
      totalMs: latencies.reduce((sum, value) => sum + value, 0),
      p50Ms: p50,
      p95Ms: p95,
      maxMs: Math.max(...latencies),
    }) + "\n");
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}
