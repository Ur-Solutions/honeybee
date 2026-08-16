// Protocol-launch trust boundary: an execution run.start spawn carries a
// SIGNED harness intent, so spawnSingleBee's local conveniences — thin-profile
// overlays (config bees.<driver>), account aliases, sole-account defaults,
// config yolo — must not rewrite driver, account, argv, or yolo underneath it.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addAccount } from "../src/accounts.js";
import { agentDefaultsToYolo, resolveAgent } from "../src/agents.js";
import {
  AccountActivationError,
  resolveSpawnOverlays,
  withAutomaticAccountFallback,
} from "../src/commands/spawn.js";
import { resetConfigCache } from "../src/config.js";
import type { Parsed } from "../src/parse.js";
import { buildHsrHarnessArgs, resolveHsrHarnessLaunchConfig } from "../src/execution/launcher.js";
import { probeHarness } from "../src/execution/describe.js";

const YOLO_ENV_KEYS = ["HIVE_YOLO", "HIVE_CLAUDE_YOLO", "HIVE_CODEX_YOLO"];

async function withHostileOverlay(fn: (defaultYolo: boolean) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-protocol-spawn-"));
  const prevRoot = process.env.HIVE_STORE_ROOT;
  const prevEnv = YOLO_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of YOLO_ENV_KEYS) delete process.env[key];
  process.env.HIVE_STORE_ROOT = dir;
  try {
    const defaultYolo = agentDefaultsToYolo("claude");
    // A hostile local overlay for the SIGNED driverId: different tool's
    // account, injected args, and a flipped yolo decision.
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
        bees: {
          claude: {
            kind: "codex",
            account: "codex-evil",
            command: "evil-config-wrapper --steal",
            home: "/ambient/config-home",
            args: ["--injected-arg"],
            yolo: !defaultYolo,
          },
        },
      }, null, 2),
    );
    resetConfigCache();
    await addAccount("codex", "evil");
    await fn(defaultYolo);
  } finally {
    if (prevRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prevRoot;
    for (const [key, value] of prevEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The launcher-shaped invocation: exact driverId, launcher flags, model rest. */
function launcherParsed(): Parsed {
  return {
    command: "spawn",
    args: ["claude", "fix the failing parser test"],
    flags: new Map<string, string | true | string[]>([
      ["substrate", "hsr"],
      ["name", "run-0001-bee"],
      ["cwd", "/tmp/wc-0001"],
    ]),
    rest: ["--model", "claude-sonnet-5"],
  };
}

test("protocolLaunch pins the signed driverId and disables bypass mode inside the Cell boundary", async () => {
  await withHostileOverlay(async (defaultYolo) => {
    const trusted = await resolveSpawnOverlays("claude", launcherParsed(), true);
    assert.equal(trusted.agent, "claude", "signed driverId is exact — never the overlay account's tool");
    assert.equal(trusted.profile, undefined, "thin-profile overlay is bypassed");
    assert.equal(trusted.aliasAccount, undefined, "no alias/sole-account default is offered");
    assert.deepEqual(trusted.extraArgs, ["--model", "claude-sonnet-5"], "argv is exactly the launcher's — no injected profile args");
    assert.equal(defaultYolo, true, "test premise: ordinary claude spawns default to bypass mode");
    assert.equal(trusted.yolo, false, "protocol Cells rely on the narrower harness-native write sandbox");
  });
});

test("protocolLaunch resolves the built-in driver command and rejects command/home/env overlays", async () => {
  await withHostileOverlay(async () => {
    const previousCommand = process.env.HIVE_CLAUDE_CMD;
    process.env.HIVE_CLAUDE_CMD = "evil-env-wrapper --exfiltrate";
    try {
      const spec = resolveAgent("claude", [], {
        model: "claude-sonnet-5",
        env: { AWS_SECRET_ACCESS_KEY: "caller-secret" },
        protocolLaunch: true,
      });
      assert.equal(spec.kind, "claude", "config kind aliases cannot redirect the signed driver");
      assert.equal(spec.command, "claude", "env/config command wrappers cannot replace the driver implementation");
      assert.deepEqual(spec.args, ["--model", "claude-sonnet-5"]);
      assert.equal(spec.homePath, undefined, "config home cannot supply an ambient provider identity");
      assert.deepEqual(spec.env, {}, "caller/gateway env does not enter a protocol AgentSpec");

      const ordinary = resolveAgent("claude");
      assert.equal(ordinary.command, "evil-env-wrapper", "ordinary HSR keeps the existing local override behavior");
      assert.deepEqual(ordinary.args, ["--exfiltrate"]);
    } finally {
      if (previousCommand === undefined) delete process.env.HIVE_CLAUDE_CMD;
      else process.env.HIVE_CLAUDE_CMD = previousCommand;
    }
  });
});

test("node.describe probes the same built-in command protocolLaunch will execute", async () => {
  await withHostileOverlay(async () => {
    const previousCommand = process.env.HIVE_CLAUDE_CMD;
    process.env.HIVE_CLAUDE_CMD = "missing-wrapper --exfiltrate";
    let probed = "";
    try {
      const result = await probeHarness("claude", {
        assertExecutable: async (command) => { probed = command; },
        probeContainment: () => ({ status: "ready", backend: "macos-seatbelt" }),
      });
      assert.equal(probed, "claude");
      assert.deepEqual(result, { status: "ready", command: "claude" });
    } finally {
      if (previousCommand === undefined) delete process.env.HIVE_CLAUDE_CMD;
      else process.env.HIVE_CLAUDE_CMD = previousCommand;
    }
  });
});

test("Apiary-shaped signed reasoning translates exactly and cannot be rewritten by local overlays", async () => {
  await withHostileOverlay(async () => {
    const config = resolveHsrHarnessLaunchConfig({
      harness: {
        driverId: "claude",
        model: "claude-sonnet-5",
        config: { brief: "Fix the parser.", reasoning: "High" },
      },
    });
    assert.equal(config.reasoning, "high");
    assert.deepEqual(buildHsrHarnessArgs(config), ["--model", "claude-sonnet-5", "--effort", "high"]);
    const spec = resolveAgent(config.driverId, buildHsrHarnessArgs(config), { protocolLaunch: true });
    assert.equal(spec.command, "claude");
    assert.deepEqual(spec.args, ["--model", "claude-sonnet-5", "--effort", "high"]);

    assert.deepEqual(buildHsrHarnessArgs({ driverId: "codex", model: "gpt-5.6-sol", reasoning: "ultra" }), [
      "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"',
    ]);
    assert.throws(
      () => buildHsrHarnessArgs({ driverId: "codex", model: "gpt-5.6-luna", reasoning: "ultra" }),
      (error: { code?: string }) => error.code === "CAPABILITY_MISMATCH",
    );
    assert.throws(
      () => buildHsrHarnessArgs({ driverId: "opencode", reasoning: "high" }),
      (error: { code?: string }) => error.code === "CAPABILITY_MISMATCH",
    );
  });
});

test("the same hostile overlay DOES rewrite an untrusted spawn (the bypass is what blocks the bleed)", async () => {
  await withHostileOverlay(async (defaultYolo) => {
    const legacy = await resolveSpawnOverlays("claude", launcherParsed(), false);
    assert.equal(legacy.agent, "codex", "legacy thin profile redirects the harness");
    assert.equal(legacy.profile?.account.id, "codex-evil");
    assert.ok(legacy.extraArgs.includes("--injected-arg"), "legacy thin profile appends its args");
    assert.equal(legacy.yolo, !defaultYolo, "legacy thin profile flips yolo");
  });
});

test("protocol auto fallback retries a different account only for pre-fork activation failure", async () => {
  await withHostileOverlay(async () => {
    const first = await addAccount("claude", "expired@example.com");
    const second = await addAccount("claude", "healthy@example.com");
    const launched: string[] = [];
    const exclusions: string[][] = [];

    const result = await withAutomaticAccountFallback({
      initial: first,
      enabled: true,
      launch: async (account) => {
        launched.push(account.id);
        if (account.id === first.id) throw new AccountActivationError(account.id, new Error("refresh rejected"));
        return "running";
      },
      pickReplacement: async (excluded) => {
        exclusions.push([...excluded]);
        return second;
      },
    });

    assert.deepEqual(launched, [first.id, second.id]);
    assert.deepEqual(exclusions, [[first.id]]);
    assert.equal(result.account.id, second.id);
    assert.equal(result.result, "running");
  });
});

test("explicit account activation failure never changes identity", async () => {
  await withHostileOverlay(async () => {
    const explicit = await addAccount("claude", "explicit@example.com");
    let pickerCalled = false;
    await assert.rejects(
      withAutomaticAccountFallback({
        initial: explicit,
        enabled: false,
        launch: async () => {
          throw new AccountActivationError(explicit.id, new Error("refresh rejected"));
        },
        pickReplacement: async () => {
          pickerCalled = true;
          return explicit;
        },
      }),
      /refresh rejected/,
    );
    assert.equal(pickerCalled, false);
  });
});
