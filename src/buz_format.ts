// Hand-rolled YAML-frontmatter serializer + parser for buz messages.
// Zero dependencies. Supports a flat key/value frontmatter (strings only)
// plus an optional Markdown body. The format is:
//
//   ---
//   key: value
//   another: "quoted with: colon"
//   ---
//   markdown body...
//
// Values are always stored as strings on disk (the buz layer is responsible
// for coercing typed fields like sentAt back to ISO strings). We single-line
// quote values that contain characters that would confuse a naive parser
// (`:` outside the first colon, `#`, leading/trailing whitespace, or empty
// strings). Multi-line values are not supported on purpose — keep tiny.
//
// The body is preserved exactly (including trailing newlines). CRLF input
// is normalized to LF inside the frontmatter window only, so the body
// preserves CRLF if the sender supplied it.
export type BuzFrontmatter = Record<string, string>;

export type BuzFrontmatterDoc = {
  frontmatter: BuzFrontmatter;
  body: string;
};

const FENCE = "---";

export function serializeBuzDocument(frontmatter: BuzFrontmatter, body: string): string {
  const lines: string[] = [FENCE];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!isValidKey(key)) throw new Error(`Invalid frontmatter key: ${JSON.stringify(key)}`);
    lines.push(`${key}: ${encodeValue(value)}`);
  }
  lines.push(FENCE);
  return `${lines.join("\n")}\n${body}`;
}

export function parseBuzDocument(text: string): BuzFrontmatterDoc {
  const normalized = text.replace(/^﻿/, "");
  if (!normalized.startsWith(`${FENCE}\n`) && !normalized.startsWith(`${FENCE}\r\n`)) {
    throw new Error("Missing opening --- fence in buz message");
  }

  const firstNewline = normalized.indexOf("\n");
  const afterOpen = normalized.slice(firstNewline + 1);
  const lines = afterOpen.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === FENCE) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) throw new Error("Missing closing --- fence in buz message");

  const frontmatter: BuzFrontmatter = {};
  for (let i = 0; i < closeIdx; i += 1) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) throw new Error(`Invalid frontmatter line (no colon): ${line}`);
    const key = line.slice(0, colonIdx).trim();
    if (!isValidKey(key)) throw new Error(`Invalid frontmatter key: ${JSON.stringify(key)}`);
    const rawValue = line.slice(colonIdx + 1).trim();
    frontmatter[key] = decodeValue(rawValue);
  }

  // Rebuild the body verbatim. Walk afterOpen counting newlines until we
  // land just past the closing-fence line. This keeps any code-fenced
  // markdown (e.g. ```js ... ```) byte-identical on round-trip.
  let bodyStart = -1;
  let lineCount = 0;
  for (let i = 0; i < afterOpen.length; i += 1) {
    if (afterOpen[i] === "\n") {
      lineCount += 1;
      if (lineCount === closeIdx + 1) {
        bodyStart = i + 1;
        break;
      }
    }
  }
  // If the walk never crossed the closing-fence boundary, the closing fence
  // was the final line with no trailing newline — the body is empty.
  return { frontmatter, body: bodyStart === -1 ? "" : afterOpen.slice(bodyStart) };
}

function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key);
}

function encodeValue(value: string): string {
  if (value.length === 0) return '""';
  if (/^\s/.test(value) || /\s$/.test(value)) return JSON.stringify(value);
  if (/[:#\n\r\t"]/.test(value)) return JSON.stringify(value);
  return value;
}

function decodeValue(raw: string): string {
  if (raw.length === 0) return "";
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      // fall through and treat literally
    }
  }
  return raw;
}
