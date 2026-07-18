/**
 * Guarded real-provider verification (one paid prompt total):
 *   HSR_LIVE_GROK=1 node --import tsx --test tests/hsr-grok-live.test.ts
 *
 * Uses the caller's existing Grok login but never reads or prints credentials.
 * Resume is verified by loading the native session and stopping without a
 * second prompt, keeping the smoke deliberately cheap.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startGrokRunner } from "../src/hsr/adapters/grok.js";
import type { RunnerEvent, RunnerSession } from "../src/hsr/types.js";

const enabled = process.env.HSR_LIVE_GROK === "1";

function env(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function collectTurn(session: RunnerSession, marker: string): Promise<RunnerEvent[]> {
  const iterator = session.events[Symbol.asyncIterator]();
  await session.send(`Reply with exactly ${marker} and no other text. Do not use tools.`);
  const events: RunnerEvent[] = [];
  const deadline = Date.now() + 90_000;
  let ended = false;
  let sawUsage = false;
  while (Date.now() < deadline && (!ended || !sawUsage)) {
    const remaining = deadline - Date.now();
    const result = await new Promise<IteratorResult<RunnerEvent>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Grok live turn timed out")), remaining);
      void iterator.next().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    if (result.done) break;
    events.push(result.value);
    if (result.value.type === "turn_end") ended = true;
    if (result.value.type === "usage") sawUsage = true;
  }
  return events;
}

test("Grok live ACP new, prompt, exact usage, stop, and no-prompt resume", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-grok-live-"));
  const command = process.env.GROK_BIN ?? "grok";
  let first: RunnerSession | undefined;
  let resumed: RunnerSession | undefined;
  try {
    first = await startGrokRunner({
      bee: "GR-live-new",
      cwd: root,
      env: env(),
      runDir: join(root, "run-new"),
      command,
      args: ["--always-approve"],
    });
    const initialId = first.sessionId;
    assert.ok(initialId.length > 0);
    const events = await collectTurn(first, "HONEYBEE_GROK_LIVE_OK");
    assert.match(events.filter((event) => event.type === "text").map((event) => event.text).join(""), /HONEYBEE_GROK_LIVE_OK/);
    const usage = events.find((event): event is Extract<RunnerEvent, { type: "usage" }> => event.type === "usage");
    assert.ok(usage, "native prompt result should carry exact usage");
    assert.ok((usage.totalTokens ?? 0) > 0);
    await first.stop();
    first = undefined;

    resumed = await startGrokRunner({
      bee: "GR-live-resume",
      cwd: root,
      env: env(),
      runDir: join(root, "run-resume"),
      command,
      args: ["--always-approve"],
      resume: true,
      sessionId: initialId,
    });
    assert.equal(resumed.sessionId, initialId);
  } finally {
    await resumed?.stop().catch(() => undefined);
    await first?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
