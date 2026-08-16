/**
 * Turn-tier runner: one child per turn, session id learned from the first
 * turn's init line and threaded into later turns' resume args, no terminal
 * exit event until stop(). Exercised with a stub node child that speaks a
 * cursor-shaped stream-json envelope and echoes its argv, so the resume
 * threading is observable from the events alone.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startTurnRunner, type TurnRunnerConfig } from "../src/hsr/turnRunner.js";
import { ensureHsrRunDir } from "../src/hsr/runDir.js";
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

const BACKGROUND_TOOL_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const pidFile = process.argv[1];
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  line({ type: "tool" });
  setTimeout(() => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(pidFile, String(child.pid));
    setTimeout(() => {
      line({ type: "result" });
      setTimeout(() => {}, 2_500);
    }, 250);
  }, 50);
});
`;

// The per-turn process exits immediately after handing its stdout fd to a
// short-lived descendant. Node emits ChildProcess `exit` for the parent first,
// then the descendant writes the final (unterminated) provider frame, EOFs the
// shared pipe, and only then allows ChildProcess `close`.
const EXIT_BEFORE_STDIO_CLOSE_SCRIPT = `
const { spawn } = require("node:child_process");
process.stdin.resume();
process.stdin.on("end", () => {
  const frame = Buffer.from(JSON.stringify({ type: "late-result", text: "tail-after-exit" })).toString("base64");
  const tail = spawn(process.execPath, [
    "-e",
    "setTimeout(() => process.stdout.write(Buffer.from(process.argv[1], 'base64')), 150)",
    frame,
  ], { stdio: ["ignore", 1, "ignore"] });
  tail.unref();
});
`;

// The parent emits an exact turn_end, then exits while a tracked detached tool
// keeps the inherited stdout write end open indefinitely. Waiting for the
// ChildProcess `close` event would wedge the turn queue forever even though the
// provider protocol has already supplied its terminal boundary.
const INHERITED_STDOUT_AFTER_TURN_END_SCRIPT = `
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const pidFile = process.argv[1];
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", 1, "ignore"],
  });
  descendant.unref();
  appendFileSync(pidFile, String(descendant.pid) + "\\n");
  line({ type: "tool" });
  // Give event-driven process ownership its bounded post-tool census before
  // the parent exits and loses the ancestry link.
  setTimeout(() => line({ type: "result" }), 350);
});
`;

const INHERITED_STDOUT_WITHOUT_TURN_END_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const pidFile = process.argv[1];
process.stdin.resume();
process.stdin.on("end", () => {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", 1, "ignore"],
  });
  descendant.unref();
  writeFileSync(pidFile, String(descendant.pid));
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startTestTurnRunner(config: TurnRunnerConfig, opts: RunnerOpts): Promise<RunnerSession> {
  await ensureHsrRunDir(opts.bee);
  return startTurnRunner(config, opts);
}

test("turn runner: learns the session id on turn 1 and resumes it on turn 2", async () => {
  await withTempStore(async () => {
    const opts: RunnerOpts = { bee: "turn-bee", cwd: process.cwd(), env: { ...process.env } as Record<string, string>, runDir: "unused" };
    const session = await startTestTurnRunner(stubConfig(), opts);
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

test("turn runner: every per-turn fork publishes pending before admitting the new child", async () => {
  await withTempStore(async () => {
    const phases: string[] = [];
    const admissions = [0, 1].map(() => {
      let entered!: (identity: { pid: number; pgid: number }) => void;
      let release!: () => void;
      return {
        entered: new Promise<{ pid: number; pgid: number }>((resolve) => { entered = resolve; }),
        release: new Promise<void>((resolve) => { release = resolve; }),
        noteEntered: entered,
        admit: release,
      };
    });
    let admissionIndex = 0;
    const opts: RunnerOpts = {
      bee: "turn-bee-child-admission",
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      runDir: "unused",
      onChildSpawnPending: async () => { phases.push("pending"); },
      onChildSpawn: async (identity) => {
        const admission = admissions[admissionIndex++]!;
        admission.noteEntered(identity);
        await admission.release;
        phases.push("admitted");
      },
      onChildSpawnFailure: async () => { phases.push("none"); },
    };
    const session = await startTestTurnRunner(stubConfig(), opts);
    try {
      await session.send("first");
      const first = await admissions[0]!.entered;
      assert.deepEqual(phases, ["pending"], "the first detached child exists while durable admission remains pending");
      assert.equal(isPidAlive(first.pid), true);
      admissions[0]!.admit();
      await collectTurns(session, 1);
      await session.send("second");
      const second = await admissions[1]!.entered;
      assert.deepEqual(phases, ["pending", "admitted", "pending"], "the prior child locator is cleared before the second fork is admitted");
      assert.equal(isPidAlive(second.pid), true);
      admissions[1]!.admit();
      await collectTurns(session, 1);
      assert.deepEqual(phases, ["pending", "admitted", "pending", "admitted"]);
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
    const session = await startTestTurnRunner(stubConfig(), opts);
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
    const session = await startTestTurnRunner(stubConfig(), opts);
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
    const session = await startTestTurnRunner(config, opts);
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

test("turn runner: child exit cannot overtake delayed final stdout and EOF", async () => {
  await withTempStore(async () => {
    const config: TurnRunnerConfig = {
      ...stubConfig(),
      baseArgs: ["-e", EXIT_BEFORE_STDIO_CLOSE_SCRIPT, "--"],
      parseLine: (line) => {
        const parsed = JSON.parse(line) as { type?: string; text?: string };
        if (parsed.type !== "late-result") return [];
        return [
          { type: "text", ts: Date.now(), text: parsed.text ?? "" },
          { type: "turn_end", ts: Date.now() },
        ];
      },
      sessionIdFromEvent: undefined,
    };
    const opts: RunnerOpts = {
      bee: "turn-bee-exit-before-close",
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      runDir: "unused",
    };
    const session = await startTestTurnRunner(config, opts);
    try {
      await session.send("drain the final pipe frame");
      const events = await collectTurns(session, 1);
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn_start", "text", "turn_end"],
        "the real final frame, not a premature synthetic turn_end, closes the turn",
      );
      assert.equal((events[1] as Extract<RunnerEvent, { type: "text" }>).text, "tail-after-exit");
    } finally {
      await session.stop();
    }
  });
});

test("turn runner: exact turn_end advances past an inherited stdout pipe and session stop reaps descendants", async () => {
  await withTempStore(async (dir) => {
    const pidFile = join(dir, "inherited-stdout-descendants.pid");
    const config: TurnRunnerConfig = {
      ...stubConfig(),
      baseArgs: ["-e", INHERITED_STDOUT_AFTER_TURN_END_SCRIPT, pidFile, "--"],
      parseLine: (line) => {
        const parsed = JSON.parse(line) as { type?: string };
        if (parsed.type === "tool") return [{ type: "tool_use", ts: Date.now(), tool: "preview" }];
        if (parsed.type === "result") return [{ type: "turn_end", ts: Date.now() }];
        return [];
      },
      sessionIdFromEvent: undefined,
    };
    const session = await startTestTurnRunner(config, {
      bee: "turn-bee-inherited-stdout",
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      runDir: "unused",
    });
    let descendantPids: number[] = [];
    try {
      await session.send("first preview");
      await session.send("second preview");
      const events = await collectTurns(session, 2, 5_000);
      assert.equal(events.filter((event) => event.type === "turn_end").length, 2);
      descendantPids = (await readFile(pidFile, "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      assert.equal(descendantPids.length, 2, "the second turn started without waiting for the first inherited pipe EOF");
      assert.equal(descendantPids.every(isPidAlive), true, "tool descendants remain owned but alive between turns");
      await session.stop();
      await waitFor(() => descendantPids.every((pid) => !isPidAlive(pid)), "inherited-pipe descendants to stop with session");
    } finally {
      await session.stop().catch(() => undefined);
      for (const pid of descendantPids) {
        if (!isPidAlive(pid)) continue;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

test("turn runner: exited child without turn_end or pipe EOF fails within a bound", async () => {
  await withTempStore(async (dir) => {
    const pidFile = join(dir, "unterminated-inherited-stdout.pid");
    const config: TurnRunnerConfig = {
      ...stubConfig(),
      baseArgs: ["-e", INHERITED_STDOUT_WITHOUT_TURN_END_SCRIPT, pidFile, "--"],
      parseLine: () => [],
      sessionIdFromEvent: undefined,
      pipeDrainTimeoutMs: 100,
    };
    const session = await startTestTurnRunner(config, {
      bee: "turn-bee-unverified-pipe",
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      runDir: "unused",
    });
    let descendantPid: number | undefined;
    try {
      const consume = (async () => {
        for await (const _event of session.events) {
          // consume until the bounded integrity failure rejects the iterator
        }
      })();
      await session.send("no terminal boundary");
      await assert.rejects(consume, /without a terminal turn boundary or verified pipe EOF/);
      descendantPid = Number(await readFile(pidFile, "utf8"));
      assert.equal(isPidAlive(descendantPid), true);
      await session.stop();
    } finally {
      await session.stop().catch(() => undefined);
      if (descendantPid && isPidAlive(descendantPid)) {
        try {
          process.kill(-descendantPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

test("turn runner: detached tool process survives its turn and dies with the session", async () => {
  await withTempStore(async (dir) => {
    const pidFile = join(dir, "background.pid");
    const config: TurnRunnerConfig = {
      ...stubConfig(),
      baseArgs: ["-e", BACKGROUND_TOOL_SCRIPT, pidFile, "--"],
      parseLine: (line) => {
        const parsed = JSON.parse(line) as { type?: string };
        if (parsed.type === "tool") return [{ type: "tool_use", ts: Date.now(), tool: "exec" }];
        if (parsed.type === "result") return [{ type: "turn_end", ts: Date.now() }];
        return [];
      },
    };
    const opts: RunnerOpts = {
      bee: "turn-bee-background",
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      runDir: "unused",
    };
    const session = await startTestTurnRunner(config, opts);
    let backgroundPid: number | undefined;
    try {
      await session.send("start preview");
      await collectTurns(session, 1);
      backgroundPid = Number(await readFile(pidFile, "utf8"));
      // Let the per-turn child exit after its result; its background group must
      // remain alive for later turns until the session itself is stopped.
      await new Promise((resolve) => setTimeout(resolve, 2_700));
      assert.equal(isPidAlive(backgroundPid), true, "background process survives the per-turn child");
      await session.stop();
      await waitFor(() => !isPidAlive(backgroundPid!), "background process to stop with session");
    } finally {
      await session.stop().catch(() => undefined);
      if (backgroundPid && isPidAlive(backgroundPid)) {
        try {
          process.kill(-backgroundPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});
