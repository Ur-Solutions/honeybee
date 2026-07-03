/**
 * HSR shared NDJSON line reader (HIVE-21).
 *
 * The one transport primitive HIVE-20's sessionBase.ts extraction left behind:
 * the newline-delimited-JSON framing loop had been copy-pasted three ways —
 * streamRunner.ts (child stdout/stderr), adapters/codexRpc.ts (app-server stdio
 * JSON-RPC), and rpc.ts (daemon socket JSON-RPC). Any framing fix (a max-line
 * bound, backpressure, CRLF handling) had to be made in every copy and would
 * drift. This is the single source.
 *
 * Contract: buffer a byte stream, emit one line per '\n'. The partial trailing
 * line (no newline yet) is retained until the next chunk completes it. Each
 * emitted line has a trailing '\r' stripped (CRLF tolerance) but is otherwise
 * verbatim — leading and interior whitespace are preserved, so a consumer that
 * surfaces raw diagnostics keeps them intact. Lines that are empty or entirely
 * whitespace are dropped (never handed to `onLine`): blank framing gaps are not
 * payloads, and this keeps the daemon RPC server from parse-erroring on them.
 *
 * Node builtins only.
 */

/**
 * Build a `(chunk: Buffer) => void` data handler that splits the stream into
 * lines and invokes `onLine` once per non-blank line. Stateful over partial
 * lines — create one per stream.
 */
export function makeLineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.trim().length > 0) onLine(line);
      nl = buffer.indexOf("\n");
    }
  };
}
