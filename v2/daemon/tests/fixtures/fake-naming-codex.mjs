import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.FAKE_NAMING_CODEX_LOG;
let thread = 0;
let turn = 0;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, `${JSON.stringify(message)}\n`);
  if (message.method === "initialize") {
    emit({ jsonrpc: "2.0", id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start") {
    thread += 1;
    emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: `title-thread-${thread}` } } });
    return;
  }
  if (message.method === "turn/start") {
    turn += 1;
    const threadId = message.params.threadId;
    const turnId = `title-turn-${turn}`;
    emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turnId } } });
    setImmediate(() => {
      emit({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", text: 'Title: "Warm Naming Service."', phase: "final" },
        },
      });
      emit({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed", error: null } },
      });
      if (Number(process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN ?? 0) === turn) {
        setTimeout(() => process.exit(17), 5);
      }
    });
  }
});
