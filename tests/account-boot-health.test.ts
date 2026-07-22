import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACCOUNT_BOOT_FAILURE_COOLDOWN_MS,
  recentAccountBootFailures,
  recordAccountBootFailure,
} from "../src/accounts.js";
import { CodexBootProbeError } from "../src/codexBoot.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { runHsrHost, type HsrHostHandle } from "../src/hsr/host.js";
import type { RunnerAdapter, RunnerOpts } from "../src/hsr/types.js";

async function withTempStore(fn: (root: string) => Promise<void>): Promise<void> {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const root = await mkdtemp(join(tmpdir(), "honeybee-account-boot-health-"));
  process.env.HIVE_STORE_ROOT = root;
  try {
    await fn(root);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

function opts(root: string, bee: string, accountId: string): RunnerOpts {
  return {
    bee,
    accountId,
    cwd: process.cwd(),
    env: { CODEX_HOME: join(root, "codex-home") },
    runDir: join(root, "hsr", bee),
  };
}

test("codex HSR boot failure records the breaker and a later success clears it", async () => {
  await withTempStore(async (root) => {
    const accountId = "codex-health-test";
    const failingAdapter: RunnerAdapter = {
      harness: "codex",
      tier: () => "server",
      async start(): Promise<never> {
        throw new CodexBootProbeError("alive-but-unresponsive", new Error("fake app-server boot failure"));
      },
    };
    await assert.rejects(
      runHsrHost({ bee: "failed-boot", adapter: failingAdapter, opts: opts(root, "failed-boot", accountId) }),
      /fake app-server boot failure/,
    );
    assert.equal((await recentAccountBootFailures()).has(accountId), true);

    const healthyAdapter: RunnerAdapter = {
      harness: "codex",
      tier: () => "server",
      start: (runnerOpts) => stubAdapter.start(runnerOpts),
    };
    let handle: HsrHostHandle | undefined;
    try {
      handle = await runHsrHost({ bee: "healthy-boot", adapter: healthyAdapter, opts: opts(root, "healthy-boot", accountId) });
      assert.equal((await recentAccountBootFailures()).has(accountId), false);
    } finally {
      await handle?.stop().catch(() => undefined);
    }
  });
});

test("codex HSR does not record non-probe startup failures in the account breaker", async () => {
  await withTempStore(async (root) => {
    const accountId = "codex-non-probe-failure";
    const failingAdapter: RunnerAdapter = {
      harness: "codex",
      tier: () => "server",
      async start(): Promise<never> {
        throw new Error("startup admission or lock failure");
      },
    };

    await assert.rejects(
      runHsrHost({ bee: "non-probe-failure", adapter: failingAdapter, opts: opts(root, "non-probe-failure", accountId) }),
      /startup admission or lock failure/,
    );
    assert.equal((await recentAccountBootFailures()).has(accountId), false);
  });
});

test("account boot failures expire after the fixed cooldown", async () => {
  await withTempStore(async () => {
    const failedAt = Date.parse("2026-07-22T06:00:00Z");
    await recordAccountBootFailure("codex-expired", failedAt);
    const afterCooldown = failedAt + ACCOUNT_BOOT_FAILURE_COOLDOWN_MS + 1;
    assert.equal((await recentAccountBootFailures(afterCooldown)).has("codex-expired"), false);
  });
});
