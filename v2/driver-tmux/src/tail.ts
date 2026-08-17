/**
 * Polling jsonl tailer (WP5, spec 05 observation stack).
 *
 * Port of the discipline the old kimi wire tailer proved
 * (src/hsr/adapters/kimiTelemetry.ts in the v1 tree, read-only reference):
 *  - deferred discovery: the file may not exist yet; keep looking;
 *  - rotation detection via dev:ino — on identity change, jump to EOF
 *    (never replay another file's history);
 *  - resume semantics: `skipExisting` seeks to EOF on first open so an
 *    adopted runtime's past turns are not replayed;
 *  - truncation (size < position) resets to 0;
 *  - bounded reads (1 MiB per poll) + partial-line carry-over, tolerant of
 *    the provider writing the final line while we read.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 512 * 1024;

export class JsonlTail {
  readonly path: string;
  private position = 0;
  private identity: string | null = null;
  private rest = "";
  private readonly skipExisting: boolean;
  private opened = false;

  constructor(path: string, opts: { skipExisting?: boolean } = {}) {
    this.path = path;
    this.skipExisting = opts.skipExisting ?? false;
  }

  /** Complete new lines appended since the last poll (empty when none). */
  poll(): string[] {
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(this.path);
    } catch {
      // Not there (yet, or anymore). Forget identity so a reappearing file
      // is treated as fresh.
      this.identity = null;
      this.rest = "";
      return [];
    }
    const identity = `${info.dev}:${info.ino}`;
    if (this.identity !== identity) {
      const firstOpen = !this.opened;
      this.identity = identity;
      this.rest = "";
      // First open of a pre-existing file honors skipExisting (resume);
      // any later identity change is a rotation — jump to EOF, never replay.
      this.position = firstOpen && !this.skipExisting ? 0 : info.size;
      this.opened = true;
    }
    if (info.size < this.position) this.position = 0; // truncated
    if (info.size === this.position) return [];

    const toRead = Math.min(info.size - this.position, MAX_READ_BYTES);
    const buf = Buffer.alloc(toRead);
    let bytes = 0;
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "r");
      bytes = readSync(fd, buf, 0, toRead, this.position);
    } catch {
      return []; // raced a rotation; next poll re-resolves identity
    } finally {
      if (fd != null) closeSync(fd);
    }
    this.position += bytes;

    const data = this.rest + buf.toString("utf8", 0, bytes);
    const lines = data.split("\n");
    this.rest = lines.pop() ?? "";
    if (this.rest.length > MAX_LINE_BYTES) this.rest = ""; // pathological line: drop
    return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.trim().length > 0);
  }
}
