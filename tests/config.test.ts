import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgent } from "../src/agents.js";
import { beeConfig, briefFooter, DEFAULT_BRIEF_FOOTER, loadConfig, resetConfigCache } from "../src/config.js";

async function withTempConfig(contents: object | null, fn: () => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-config-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  if (contents) await writeFile(join(dir, "config.json"), JSON.stringify(contents, null, 2));
  resetConfigCache();
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadConfig returns empty object when file missing", async () => {
  await withTempConfig(null, () => {
    assert.deepEqual(loadConfig(), {});
    assert.deepEqual(beeConfig("codex"), {});
  });
});

test("beeConfig returns per-bee defaults", async () => {
  await withTempConfig({ bees: { codex: { yolo: true, home: "2" } } }, () => {
    assert.deepEqual(beeConfig("codex"), { yolo: true, home: "2" });
    assert.deepEqual(beeConfig("claude"), {});
  });
});

test("resolveAgent applies config-level yolo for codex without --yolo flag", async () => {
  await withTempConfig({ bees: { codex: { yolo: true } } }, () => {
    const spec = resolveAgent("codex");
    assert.match([spec.command, ...spec.args].join(" "), /--dangerously-bypass-approvals-and-sandbox/);
  });
});

test("resolveAgent honors config command override", async () => {
  await withTempConfig({ bees: { codex: { command: "codex --yolo --foo" } } }, () => {
    const spec = resolveAgent("codex");
    assert.equal(spec.command, "codex");
    assert.deepEqual(spec.args, ["--yolo", "--foo"]);
  });
});

test("resolveAgent honors config home, even when no --home flag", async () => {
  await withTempConfig({ bees: { codex: { home: "2" } } }, () => {
    const spec = resolveAgent("codex");
    assert.match(spec.homePath ?? "", /\.codex-2$/);
  });
});

test("explicit --yolo flag still wins over absent config", async () => {
  await withTempConfig(null, () => {
    const spec = resolveAgent("codex", [], { yolo: true });
    assert.match([spec.command, ...spec.args].join(" "), /--dangerously-bypass-approvals-and-sandbox/);
  });
});

test("briefFooter returns default when not configured", async () => {
  await withTempConfig(null, () => {
    assert.equal(briefFooter(), DEFAULT_BRIEF_FOOTER);
  });
});

test("briefFooter honors config override (including empty string for disable)", async () => {
  await withTempConfig({ briefFooter: "\n\n[custom footer]" }, () => {
    assert.equal(briefFooter(), "\n\n[custom footer]");
  });
  await withTempConfig({ briefFooter: "" }, () => {
    assert.equal(briefFooter(), "");
  });
});
