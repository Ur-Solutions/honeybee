import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readLastLines, tailDaemonLog } from "../src/daemon/logs.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-daemon-logs-"));
  const prev = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("readLastLines returns last N lines in source order", async () => {
  await withTempStore(async () => {
    const path = join(process.env.HIVE_STORE_ROOT!, "daemon", "log.txt");
    await mkdir(dirname(path), { recursive: true });
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    await writeFile(path, `${lines.join("\n")}\n`);

    const last5 = await readLastLines(path, 5);
    assert.deepEqual(last5, ["line 195", "line 196", "line 197", "line 198", "line 199"]);

    const last0 = await readLastLines(path, 0);
    assert.deepEqual(last0, []);

    const last500 = await readLastLines(path, 500);
    assert.equal(last500.length, 200);
    assert.equal(last500[0], "line 0");
    assert.equal(last500[199], "line 199");
  });
});

test("readLastLines does not corrupt multi-byte UTF-8 chars straddling chunk boundaries", async () => {
  await withTempStore(async () => {
    const path = join(process.env.HIVE_STORE_ROOT!, "daemon", "log.txt");
    await mkdir(dirname(path), { recursive: true });
    // Mix of 2-byte (é), 3-byte (✓) and 4-byte (🐝) characters; with a tiny
    // chunk size every reverse-read boundary lands inside some character.
    const lines = Array.from({ length: 20 }, (_, i) => `bee🐝-${i}-é✓`);
    await writeFile(path, `${lines.join("\n")}\n`);

    for (const chunkSize of [1, 2, 3, 5, 7]) {
      const last4 = await readLastLines(path, 4, chunkSize);
      assert.deepEqual(last4, lines.slice(-4), `chunkSize=${chunkSize}`);
      for (const line of last4) {
        assert.doesNotMatch(line, /�/, `chunkSize=${chunkSize} produced replacement chars`);
      }
    }
  });
});

test("readLastLines returns empty list when file is missing", async () => {
  await withTempStore(async () => {
    const path = join(process.env.HIVE_STORE_ROOT!, "daemon", "missing.txt");
    const result = await readLastLines(path, 50);
    assert.deepEqual(result, []);
  });
});

test("tailDaemonLog (no follow) prints requested lines via the writer", async () => {
  await withTempStore(async () => {
    const path = join(process.env.HIVE_STORE_ROOT!, "daemon", "log.txt");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "a\nb\nc\nd\ne\n");

    const out: string[] = [];
    await tailDaemonLog({
      path,
      lines: 3,
      follow: false,
      write: (chunk) => out.push(chunk),
    });
    assert.deepEqual(out, ["c\n", "d\n", "e\n"]);
  });
});

test("tailDaemonLog --follow aborts cleanly when the signal fires", async () => {
  await withTempStore(async () => {
    const path = join(process.env.HIVE_STORE_ROOT!, "daemon", "log.txt");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "head\n");

    const controller = new AbortController();
    const out: string[] = [];
    const promise = tailDaemonLog({
      path,
      lines: 10,
      follow: true,
      signal: controller.signal,
      write: (chunk) => out.push(chunk),
    });
    // Give the loop a chance to enter its watch state, then abort.
    setTimeout(() => controller.abort(), 50);
    await promise;
    assert.ok(out.length >= 1, "expected at least the initial head line");
    assert.equal(out[0], "head\n");
  });
});
