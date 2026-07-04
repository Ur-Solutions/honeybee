/**
 * Turn-tier runner: one child per turn, session id learned from the first
 * turn's init line and threaded into later turns' resume args, no terminal
 * exit event until stop(). Exercised with a stub node child that speaks a
 * cursor-shaped stream-json envelope and echoes its argv, so the resume
 * threading is observable from the events alone.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startTurnRunner, type TurnRunnerConfig } from "../src/hsr/turnRunner.js";
import type { RunnerEvent, RunnerOpts, RunnerSession } from "../src/hsr/types.js";

// Reads the prompt from stdin, then emits init + assistant (echoing prompt and
// argv) + result. `node -e <script> <extra args>` puts the extra args at
// process.argv[1..].
const STUB_SCRIPT = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString();
  const args = process.argv.slice(1);
  const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  line({ type: "system", subtype: "init", session_id: "chat-1" });
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "echo:" + prompt + "|args:" + args.join(",") }] }, session_id: "chat-1" });
  line({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "chat-1" });
});
`;

function stubConfig(): TurnRunnerConfig {
  return {
    harness: "stub-turn",
    command: process.execPath,
    // "--" keeps node from parsing the per-turn --resume=<id> as its own option.
    baseArgs: ["-e", STUB_SCRIPT, "--"],
    turnArgs: (sessionId) => (sessionId ? [`--resume=${sessionId}`] : []),
    parseLine: (line) => {
      let parsed: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      if (parsed.type === "assistant") {
        const text = parsed.message?.content?.[0]?.text ?? "";
        return [{ type: "text", ts: Date.now(), text }];
      }
      if (parsed.type === "result") return [{ type: "turn_end", ts: Date.now() }];
      return [];
    },
    sessionIdFromEvent: (_event, raw) => {
      const obj = raw as { session_id?: unknown } | undefined;
      return obj && typeof obj.session_id === "string" ? obj.session_id : undefined;
    },
  };
}

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-turn-runner-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    // Debounced ring.txt writes may still be landing; retry the teardown.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  }
}

/** Collect events until `count` turn_ends have landed (with a hard timeout). */
async function collectTurns(session: RunnerSession, count: number, timeoutMs = 15_000): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  let turnEnds = 0;
  const deadline = Date.now() + timeoutMs;
  const iterator = session.events[Symbol.asyncIterator]();
  while (turnEnds < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} turn_end(s); got ${JSON.stringify(events)}`);
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === "turn_end") turnEnds += 1;
  }
  return events;
}

test("turn runner: learns the session id on turn 1 and resumes it on turn 2", async () => {
  await withTempStore(async () => {
    const opts: RunnerOpts = { bee: "turn-bee", cwd: process.cwd(), env: { ...process.env } as Record<string, string>, runDir: "unused" };
    const session = await startTurnRunner(stubConfig(), opts);
    try {
      assert.equal(session.tier, "turn");
      assert.equal(session.sessionId, "", "fresh session has no provider id yet");

      await session.send("first prompt");
      const first = await collectTurns(session, 1);
      const firstText = first.find((e) => e.type === "text") as { text: string } | undefined;
      assert.ok(firstText, "turn 1 produced text");
      assert.match(firstText!.text, /echo:first prompt\|/, "the prompt travelled over stdin");
      assert.doesNotMatch(firstText!.text, /--resume=/, "turn 1 is fresh — no resume selector");
      assert.equal(session.sessionId, "chat-1", "the init line taught the session id");

      await session.send("second prompt");
      const second = await collectTurns(session, 1);
      const secondText = second.find((e) => e.type === "text") as { text: string } | undefined;
      assert.ok(secondText, "turn 2 produced text");
      assert.match(secondText!.text, /--resume=chat-1/, "turn 2 resumes the learned chat id");

      assert.ok(!([...first, ...second] as RunnerEvent[]).some((e) => e.type === "exit"), "per-turn child exits emit no exit event");
      assert.match(session.snapshot(), /echo:first prompt/, "the ring spans turns");
    } finally {
      await session.stop();
    }
  });
});

test("turn runner: an explicit resume seeds the session id for the first turn", async () => {
  await withTempStore(async () => {
    const opts: RunnerOpts = {
      bee: "turn-bee-resume",
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      runDir: "unused",
      resume: true,
      sessionId: "chat-preexisting",
    };
    const session = await startTurnRunner(stubConfig(), opts);
    try {
      await session.send("resumed prompt");
      const events = await collectTurns(session, 1);
      const text = events.find((e) => e.type === "text") as { text: string } | undefined;
      assert.match(text!.text, /--resume=chat-preexisting/, "the first turn already resumes");
    } finally {
      await session.stop();
    }
  });
});

test("turn runner: stop emits the terminal exit event and ends the stream; send then throws", async () => {
  await withTempStore(async () => {
    const opts: RunnerOpts = { bee: "turn-bee-stop", cwd: process.cwd(), env: { ...process.env } as Record<string, string>, runDir: "unused" };
    const session = await startTurnRunner(stubConfig(), opts);
    const seen: RunnerEvent[] = [];
    const pump = (async () => {
      for await (const event of session.events) seen.push(event);
    })();
    await session.stop();
    await pump;
    assert.equal(seen.at(-1)?.type, "exit", "stop() is the only source of the exit event");
    await assert.rejects(() => session.send("late"), /session stopped/);
  });
});

test("turn runner: a crashing turn surfaces an error and still closes the turn bracket", async () => {
  await withTempStore(async () => {
    const config: TurnRunnerConfig = {
      ...stubConfig(),
      baseArgs: ["-e", "process.exit(3)", "--"],
    };
    const opts: RunnerOpts = { bee: "turn-bee-crash", cwd: process.cwd(), env: { ...process.env } as Record<string, string>, runDir: "unused" };
    const session = await startTurnRunner(config, opts);
    try {
      await session.send("doomed");
      const events = await collectTurns(session, 1);
      assert.ok(events.some((e) => e.type === "error" && /exited with code 3/.test(e.message)), "non-zero exit surfaces");
      assert.equal(events.at(-1)?.type, "turn_end", "the bracket closes even without a result line");
    } finally {
      await session.stop();
    }
  });
});
