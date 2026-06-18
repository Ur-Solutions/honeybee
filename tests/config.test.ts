import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgent } from "../src/agents.js";
import { beeConfig, briefFooter, DEFAULT_BRIEF_FOOTER, loadConfig, namingConfig, resetConfigCache } from "../src/config.js";

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

test("config kind alias canonicalizes to the driver's kind, home env, and own command", async () => {
  await withTempConfig(
    {
      bees: {
        minimax: {
          kind: "opencode",
          home: "~/.opencode-minimax",
          command: "opencode run --interactive --model minimax/MiniMax-M2",
        },
      },
    },
    () => {
      const spec = resolveAgent("minimax");
      // Canonicalized onto the opencode driver, but remembers it was requested as minimax.
      assert.equal(spec.kind, "opencode");
      assert.equal(spec.requestedKind, "minimax");
      // Profile-specific command (model selection) wins.
      assert.equal(spec.command, "opencode");
      assert.deepEqual(spec.args, ["run", "--interactive", "--model", "minimax/MiniMax-M2"]);
      // opencode's home env points at the profile's own config dir.
      assert.match(spec.homePath ?? "", /\.opencode-minimax$/);
      assert.equal(spec.env.OPENCODE_CONFIG_DIR, spec.homePath);
    },
  );
});

test("config kind alias without a command falls back to the canonical default command", async () => {
  const oldCmd = process.env.HIVE_OPENCODE_CMD;
  const oldReq = process.env.HIVE_GLM_CMD;
  delete process.env.HIVE_OPENCODE_CMD;
  delete process.env.HIVE_GLM_CMD;
  try {
    await withTempConfig({ bees: { glm: { kind: "opencode", home: "~/.opencode-glm" } } }, () => {
      const spec = resolveAgent("glm");
      assert.equal(spec.kind, "opencode");
      assert.equal(spec.command, "opencode");
      assert.match(spec.homePath ?? "", /\.opencode-glm$/);
    });
  } finally {
    if (oldCmd === undefined) delete process.env.HIVE_OPENCODE_CMD;
    else process.env.HIVE_OPENCODE_CMD = oldCmd;
    if (oldReq === undefined) delete process.env.HIVE_GLM_CMD;
    else process.env.HIVE_GLM_CMD = oldReq;
  }
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

test("namingConfig defaults: auto-titling on, claude with haiku, low effort", async () => {
  await withTempConfig(null, () => {
    assert.deepEqual(namingConfig(), { auto: true, tool: "claude", model: "haiku", effort: "low" });
  });
});

test("namingConfig honors overrides; codex gets no default model", async () => {
  await withTempConfig({ naming: { auto: false, tool: "codex" } }, () => {
    assert.deepEqual(namingConfig(), { auto: false, tool: "codex", effort: "low" });
  });
  await withTempConfig({ naming: { tool: "codex", model: "gpt-5.5", command: "my-titler", effort: "high" } }, () => {
    assert.deepEqual(namingConfig(), { auto: true, tool: "codex", model: "gpt-5.5", command: "my-titler", effort: "high" });
  });
});

test("namingConfig drops invalid values, including an unknown effort", async () => {
  await withTempConfig({ naming: { auto: "yes", tool: "grok", model: 7, command: "", effort: "turbo" } }, () => {
    assert.deepEqual(namingConfig(), { auto: true, tool: "claude", model: "haiku", effort: "low" });
  });
});

test("corrupt config.json warns once and falls back to empty config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-config-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  await writeFile(join(dir, "config.json"), "{not valid json");
  resetConfigCache();

  const warnings: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    assert.deepEqual(loadConfig(), {});
    // Cached: a second call must not warn again.
    assert.deepEqual(loadConfig(), {});
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes(join(dir, "config.json")), `warning should name the config path: ${warnings[0]}`);
  } finally {
    console.error = original;
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
});
