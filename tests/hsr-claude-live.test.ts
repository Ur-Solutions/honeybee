/**
 * OPT-IN live claude tier-B smoke test (APIA-74).
 *
 * Skipped unless HSR_LIVE_CLAUDE=1. When enabled it spawns a REAL `claude -p`
 * (haiku) against your real auth — CLAUDE_CONFIG_DIR is intentionally NOT
 * isolated so subscription/OAuth works — runs one turn over the control socket,
 * and asserts a text reply, a turn_end + usage, and that the provider session id
 * was learned into meta.json. For manual/orchestrator validation only.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { claudeAdapter } from "../src/hsr/adapters/claude.js";
import { hsrRunDir, readHsrMeta } from "../src/hsr/runDir.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-claude-live-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

test("live claude: one turn yields text + usage and learns the session id", { skip: process.env.HSR_LIVE_CLAUDE !== "1" }, async () => {
  await withTempStore(async () => {
    const bee = "claudelive";
    const sessionId = randomUUID();
    const cwd = await mkdtemp(join(tmpdir(), "honeybee-hsr-claude-live-cwd-"));

    const opts: RunnerOpts = {
      bee,
      cwd,
      // Real auth: use the ambient env (real ~/.claude), do NOT isolate CLAUDE_CONFIG_DIR.
      env: process.env as Record<string, string>,
      sessionId,
      runDir: hsrRunDir(bee),
      command: "claude",
      args: ["--model", "haiku", "--session-id", sessionId, "--dangerously-skip-permissions"],
      authKind: "subscription",
    };

    const handle = await runHsrHost({ bee, adapter: claudeAdapter, opts });
    const client = await connectRpcClient(handle.controlSocket);
    const events: RunnerEvent[] = [];
    client.on("event", (p) => events.push(p as RunnerEvent));

    try {
      await client.call("send", { text: "Reply with exactly: hi there" });

      await waitFor(() => events.some((e) => e.type === "text" && e.text.length > 0), "text event");
      await waitFor(() => events.some((e) => e.type === "turn_end"), "turn_end");
      await waitFor(() => events.some((e) => e.type === "usage"), "usage");

      const usage = events.find((e) => e.type === "usage") as
        | (RunnerEvent & { type: "usage" })
        | undefined;
      assert.ok(usage, "a usage event was emitted");
      assert.ok((usage?.outputTokens ?? 0) > 0, "usage.outputTokens > 0");

      await waitFor(async () => {
        const meta = await readHsrMeta(bee);
        return typeof meta?.sessionId === "string" && meta.sessionId.length > 0;
      }, "provider session id learned into meta");
    } finally {
      client.close();
      await handle.stop().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
