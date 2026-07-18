/**
 * Guarded real-provider verification:
 *   HSR_LIVE_KIMI=1 npm test -- --test-name-pattern="Kimi live"
 *
 * Uses the caller's existing Kimi login but never reads or prints credentials.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startKimiRunner } from "../src/hsr/adapters/kimi.js";
import type { RunnerEvent, RunnerSession } from "../src/hsr/types.js";

const enabled = process.env.HSR_LIVE_KIMI === "1";

function env(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function collectTurn(session: RunnerSession, marker: string): Promise<{ events: RunnerEvent[]; sawUsage: boolean }> {
  const iterator = session.events[Symbol.asyncIterator]();
  await session.send(`Reply with exactly ${marker} and no other text. Do not use tools.`);
  const events: RunnerEvent[] = [];
  const deadline = Date.now() + 90_000;
  let ended = false;
  let sawUsage = false;
  while (Date.now() < deadline && (!ended || !sawUsage)) {
    const remaining = deadline - Date.now();
    const result = await new Promise<IteratorResult<RunnerEvent>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Kimi live turn timed out")), remaining);
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
  return { events, sawUsage };
}

test("Kimi live ACP new, prompt, native usage telemetry, stop, and resume", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-kimi-live-"));
  const previousStore = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  const command = process.env.KIMI_BIN ?? "kimi";
  let first: RunnerSession | undefined;
  let resumed: RunnerSession | undefined;
  try {
    first = await startKimiRunner({
      bee: "KM-live-new",
      cwd: root,
      env: env(),
      runDir: join(root, "run-new"),
      command,
      args: ["--yolo"],
      model: "kimi-code/k3",
    });
    const initialId = first.sessionId;
    assert.match(initialId, /^session_/);
    const firstTurn = await collectTurn(first, "HONEYBEE_KIMI_LIVE_OK");
    assert.match(firstTurn.events.filter((event) => event.type === "text").map((event) => event.text).join(""), /HONEYBEE_KIMI_LIVE_OK/);
    assert.equal(firstTurn.sawUsage, true, "native wire telemetry should emit usage");
    await first.stop();
    first = undefined;

    resumed = await startKimiRunner({
      bee: "KM-live-resume",
      cwd: root,
      env: env(),
      runDir: join(root, "run-resume"),
      command,
      args: ["--yolo"],
      model: "kimi-code/k3",
      resume: true,
      sessionId: initialId,
    });
    assert.equal(resumed.sessionId, initialId);
    const resumedTurn = await collectTurn(resumed, "HONEYBEE_KIMI_RESUME_OK");
    assert.match(resumedTurn.events.filter((event) => event.type === "text").map((event) => event.text).join(""), /HONEYBEE_KIMI_RESUME_OK/);
  } finally {
    await resumed?.stop().catch(() => undefined);
    await first?.stop().catch(() => undefined);
    if (previousStore === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousStore;
    await rm(root, { recursive: true, force: true });
  }
});
