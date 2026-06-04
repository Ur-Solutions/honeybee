import { createReadStream, type ReadStream } from "node:fs";
import { open, stat, watch as fsWatch } from "node:fs/promises";
import { daemonLogPath } from "./log.js";

export type TailOptions = {
  lines?: number;
  follow?: boolean;
  /** Override path (testing). */
  path?: string;
  /** Output writer; defaults to process.stdout.write. */
  write?: (chunk: string) => void;
  /** AbortSignal to stop following. */
  signal?: AbortSignal;
};

const DEFAULT_LINES = 50;
const READ_CHUNK = 64 * 1024;

/**
 * Read the last N lines from the daemon log file. Returns the lines in
 * source order (oldest first). Used by `hive daemon logs --lines N`.
 */
export async function readLastLines(path: string, lines: number): Promise<string[]> {
  if (lines <= 0) return [];
  const info = await stat(path).catch(() => null);
  if (!info || info.size === 0) return [];
  const handle = await open(path, "r");
  try {
    const fileSize = info.size;
    // Read the whole file in reverse chunks, concatenating into an in-memory
    // string until we have at least `lines + 1` newlines or hit BOF. The
    // daemon log file is bounded by HIVE_DAEMON_LOG_MAX_BYTES (default 5MiB)
    // so this is bounded.
    let position = fileSize;
    let acc = "";
    while (position > 0) {
      const chunkSize = Math.min(READ_CHUNK, position);
      position -= chunkSize;
      const buffer = Buffer.alloc(chunkSize);
      await handle.read(buffer, 0, chunkSize, position);
      acc = buffer.toString("utf8") + acc;
      const newlineCount = countNewlines(acc);
      if (newlineCount > lines) break;
    }
    const split = acc.split("\n");
    // If the file ended with a newline, split() leaves a trailing "".
    // Drop it so it doesn't count as a "line".
    if (split.length > 0 && split[split.length - 1] === "") split.pop();
    // Take the last N elements; that gives us source order.
    return split.slice(-lines);
  } finally {
    await handle.close();
  }
}

function countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 0x0a) count += 1;
  return count;
}

/**
 * Print the last N lines from the daemon log and (optionally) follow new
 * writes until aborted. Honeybee uses a polling watcher because launchd
 * may rotate the log out from under us — fs.watch is unreliable for that
 * case.
 */
export async function tailDaemonLog(options: TailOptions = {}): Promise<void> {
  const path = options.path ?? daemonLogPath();
  const lines = Math.max(0, options.lines ?? DEFAULT_LINES);
  const write = options.write ?? ((chunk: string) => {
    process.stdout.write(chunk);
  });

  const last = await readLastLines(path, lines);
  for (const line of last) write(`${line}\n`);

  if (!options.follow) return;

  let position = (await stat(path).catch(() => null))?.size ?? 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  if (options.signal) {
    if (options.signal.aborted) return;
    options.signal.addEventListener("abort", stop, { once: true });
  }

  while (!stopped) {
    const info = await stat(path).catch(() => null);
    if (info && info.size < position) {
      // Log was rotated/truncated; resume from start.
      position = 0;
    }
    if (info && info.size > position) {
      const stream: ReadStream = createReadStream(path, { start: position, end: info.size - 1 });
      for await (const chunk of stream) {
        write(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
      }
      position = info.size;
    }
    if (stopped) break;
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// keep fsWatch reachable if a future implementation wants it; explicit
// no-op reference avoids the unused-import lint.
void fsWatch;
