/**
 * Newline-delimited line reader shared across the HSR JSON-RPC/stream plumbing
 * (rpc.ts, streamRunner.ts, adapters/codexRpc.ts). Buffers partial lines across
 * chunks and yields one line per complete newline, with a trailing `\r` stripped
 * (CRLF tolerance) and whitespace-only lines skipped. Node builtins only.
 */

/** Split a byte stream into complete lines; buffers the partial trailing line. */
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
