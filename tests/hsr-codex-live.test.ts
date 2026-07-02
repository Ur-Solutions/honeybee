/**
 * OPT-IN live codex tier-S smoke test (APIA-75).
 *
 * Skipped unless HSR_LIVE_CODEX=1. When enabled it spawns a REAL `codex
 * app-server` against your real CODEX auth — CODEX_HOME is intentionally NOT
 * isolated so the ChatGPT-plan/OAuth sign-in works — runs one turn over the
 * control socket, and asserts a text reply, a turn_end, and that the provider
 * thread id was learned into meta.sessionId. For manual/orchestrator validation.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { codexAdapter } from "../src/hsr/adapters/codex.js";
import { hsrRunDir, readHsrMeta } from "../src/hsr/runDir.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-codex-live-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

test("live codex: one turn yields text + turn_end and learns the thread id", { skip: process.env.HSR_LIVE_CODEX !== "1" }, async () => {
  await withTempStore(async () => {
    const bee = "codexlive";
    const cwd = await mkdtemp(join(tmpdir(), "honeybee-hsr-codex-live-cwd-"));

    const opts: RunnerOpts = {
      bee,
      cwd,
      // Real auth: use the ambient env (real ~/.codex / CODEX_HOME), do NOT isolate.
      env: process.env as Record<string, string>,
      runDir: hsrRunDir(bee),
      command: "codex",
      authKind: "subscription",
      // model left unset → app-server default; set opts.model to pin a cheaper model.
    };

    const handle = await runHsrHost({ bee, adapter: codexAdapter, opts });
    const client = await connectRpcClient(handle.controlSocket);
    const events: RunnerEvent[] = [];
    client.on("event", (p) => events.push(p as RunnerEvent));

    try {
      await client.call("send", { text: "Reply with exactly: hi there" });

      await waitFor(() => events.some((e) => e.type === "text" && e.text.length > 0), "text event");
      await waitFor(() => events.some((e) => e.type === "turn_end"), "turn_end");

      await waitFor(async () => {
        const meta = await readHsrMeta(bee);
        return typeof meta?.sessionId === "string" && meta.sessionId.length > 0;
      }, "provider thread id learned into meta");
    } finally {
      client.close();
      await handle.stop().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
