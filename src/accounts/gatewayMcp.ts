import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import { gatewaysAreDisabled, liveGateways, type GatewayRecord } from "../gateways.js";
import { withFileLock } from "../lock.js";
import { tomlLines } from "./homeDefaults.js";

const STAMP_FILE = ".hive-gateways.json";
const STAMP_SCHEMA = 1;
const CODEX_GATEWAY_IDENTITY_ENV_VARS = ["HIVE_BEE", "HIVE_BEE_ID"] as const;

type McpEntry = { command: string; args: string[]; envVars?: string[] };

export type GatewayMcpStamp = {
  schema: 1;
  files: Record<string, Record<string, McpEntry>>;
};

export type GatewayMcpSeedResult = {
  status: "seeded" | "skipped";
  reason?: string;
  written: string[];
};

export type SeedGatewayMcpOptions = {
  gateways?: GatewayRecord[];
};

type StampRead = { status: "missing"; stamp: GatewayMcpStamp } | { status: "ok"; stamp: GatewayMcpStamp } | { status: "invalid" };
type FileRead = { status: "missing"; text: "" } | { status: "ok"; text: string } | { status: "unreadable" };

function gatewayMcpDebug(message: string): void {
  if (process.env.HIVE_DEBUG_GATEWAYS === "1") console.error(`[hive gateways] ${message}`);
}

function targetFileForHarness(harness: string): string | undefined {
  if (harness === "claude") return ".claude.json";
  if (harness === "codex") return "config.toml";
  return undefined;
}

function desiredEntries(gateways: GatewayRecord[], harness: string): Record<string, McpEntry> {
  return Object.fromEntries(gateways.map((gateway) => [gateway.name, {
    command: gateway.shim.command,
    args: [...gateway.shim.args],
    ...(harness === "codex"
      ? { envVars: [...new Set([...Object.keys(gateway.env).sort(), ...CODEX_GATEWAY_IDENTITY_ENV_VARS])] }
      : {}),
  }]));
}

function isMcpEntry(value: unknown): value is McpEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.command === "string"
    && Array.isArray(entry.args)
    && entry.args.every((arg) => typeof arg === "string")
    && (entry.envVars === undefined
      || (Array.isArray(entry.envVars) && entry.envVars.every((name) => typeof name === "string")));
}

async function readStamp(homePath: string): Promise<StampRead> {
  const path = join(homePath, STAMP_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing", stamp: { schema: STAMP_SCHEMA, files: {} } }
      : { status: "invalid" };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid" };
    const record = value as Record<string, unknown>;
    if (record.schema !== STAMP_SCHEMA || !record.files || typeof record.files !== "object" || Array.isArray(record.files)) {
      return { status: "invalid" };
    }
    const files: Record<string, Record<string, McpEntry>> = {};
    for (const [file, entries] of Object.entries(record.files)) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { status: "invalid" };
      const parsedEntries: Record<string, McpEntry> = {};
      for (const [name, entry] of Object.entries(entries)) {
        if (!isMcpEntry(entry)) return { status: "invalid" };
        parsedEntries[name] = {
          command: entry.command,
          args: [...entry.args],
          ...(entry.envVars ? { envVars: [...entry.envVars] } : {}),
        };
      }
      files[file] = parsedEntries;
    }
    return { status: "ok", stamp: { schema: STAMP_SCHEMA, files } };
  } catch {
    return { status: "invalid" };
  }
}

async function readTarget(path: string): Promise<FileRead> {
  try {
    return { status: "ok", text: await readFile(path, "utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing", text: "" }
      : { status: "unreadable" };
  }
}

async function kitClaimsTarget(homePath: string, targetFile: string): Promise<"claimed" | "unclaimed" | "invalid"> {
  const manifestPath = join(homePath, ".kit", "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unclaimed" : "invalid";
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
    const manifest = value as Record<string, unknown>;
    if (manifest.schema !== 1 || !Array.isArray(manifest.entries)) return "invalid";
    const target = resolve(homePath, targetFile);
    for (const entry of manifest.entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "invalid";
      const path = (entry as Record<string, unknown>).path;
      if (typeof path !== "string") return "invalid";
      if (resolve(homePath, path) === target) return "claimed";
    }
    return "unclaimed";
  } catch {
    return "invalid";
  }
}

function sameEntry(left: unknown, right: McpEntry): boolean {
  if (!isMcpEntry(left) || left.command !== right.command) return false;
  if (left.args.length !== right.args.length || !left.args.every((arg, index) => arg === right.args[index])) return false;
  const leftEnvVars = left.envVars ?? [];
  const rightEnvVars = right.envVars ?? [];
  return leftEnvVars.length === rightEnvVars.length
    && leftEnvVars.every((name, index) => name === rightEnvVars[index]);
}

type TopLevelJsonLayout = {
  openBrace: number;
  closeBrace: number;
  propertyCount: number;
  lastValueEnd: number;
  target?: { start: number; end: number };
};

function skipJsonWhitespace(input: string, start: number): number {
  let index = start;
  while (/\s/u.test(input[index] ?? "")) index += 1;
  return index;
}

function jsonStringEnd(input: string, start: number): number | null {
  if (input[start] !== '"') return null;
  for (let index = start + 1; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1;
      continue;
    }
    if (input[index] === '"') return index + 1;
  }
  return null;
}

function jsonValueEnd(input: string, start: number): number | null {
  if (input[start] === '"') return jsonStringEnd(input, start);
  if (input[start] === "{" || input[start] === "[") {
    const stack = [input[start] === "{" ? "}" : "]"];
    for (let index = start + 1; index < input.length; index += 1) {
      if (input[index] === '"') {
        const end = jsonStringEnd(input, index);
        if (end === null) return null;
        index = end - 1;
        continue;
      }
      if (input[index] === "{") stack.push("}");
      else if (input[index] === "[") stack.push("]");
      else if (input[index] === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return index + 1;
      }
    }
    return null;
  }
  let end = start;
  while (end < input.length && !/[\s,}\]]/u.test(input[end]!)) end += 1;
  return end > start ? end : null;
}

function topLevelJsonLayout(input: string, targetKey: string): TopLevelJsonLayout | null {
  let index = skipJsonWhitespace(input, 0);
  if (input[index] !== "{") return null;
  const openBrace = index;
  index += 1;
  let propertyCount = 0;
  let lastValueEnd = index;
  let target: { start: number; end: number } | undefined;
  while (true) {
    index = skipJsonWhitespace(input, index);
    if (input[index] === "}") {
      const closeBrace = index;
      if (skipJsonWhitespace(input, closeBrace + 1) !== input.length) return null;
      return { openBrace, closeBrace, propertyCount, lastValueEnd, ...(target ? { target } : {}) };
    }
    const keyEnd = jsonStringEnd(input, index);
    if (keyEnd === null) return null;
    let key: unknown;
    try {
      key = JSON.parse(input.slice(index, keyEnd));
    } catch {
      return null;
    }
    index = skipJsonWhitespace(input, keyEnd);
    if (input[index] !== ":") return null;
    index = skipJsonWhitespace(input, index + 1);
    const valueStart = index;
    const valueEnd = jsonValueEnd(input, valueStart);
    if (valueEnd === null) return null;
    propertyCount += 1;
    lastValueEnd = valueEnd;
    if (key === targetKey) {
      if (target) return null;
      target = { start: valueStart, end: valueEnd };
    }
    index = skipJsonWhitespace(input, valueEnd);
    if (input[index] === ",") {
      index += 1;
      continue;
    }
    if (input[index] !== "}") return null;
  }
}

function rewriteTopLevelJsonProperty(input: string, key: string, value: unknown): string | null {
  const layout = topLevelJsonLayout(input, key);
  if (!layout) return null;
  if (layout.target) {
    const lineStart = input.lastIndexOf("\n", layout.target.start - 1) + 1;
    const padding = " ".repeat(layout.target.start - lineStart);
    const rendered = JSON.stringify(value, null, 2).replaceAll("\n", `\n${padding}`);
    return `${input.slice(0, layout.target.start)}${rendered}${input.slice(layout.target.end)}`;
  }
  const rendered = `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  const insertAt = layout.propertyCount === 0 ? layout.openBrace + 1 : layout.lastValueEnd;
  const prefix = layout.propertyCount === 0 ? "" : ",";
  return `${input.slice(0, insertAt)}${prefix}${rendered}${input.slice(insertAt)}`;
}

function reconcileClaude(
  input: string,
  desired: Record<string, McpEntry>,
  owned: Record<string, McpEntry>,
): { text: string; owned: Record<string, McpEntry> } | null {
  let config: Record<string, unknown> = {};
  if (input.trim()) {
    try {
      const value = JSON.parse(input) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      config = value as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const rawServers = config.mcpServers;
  if (rawServers !== undefined && (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers))) return null;
  const servers = { ...((rawServers as Record<string, unknown> | undefined) ?? {}) };
  const nextOwned: Record<string, McpEntry> = {};
  let changed = false;

  for (const [name, prior] of Object.entries(owned)) {
    const current = servers[name];
    const next = desired[name];
    if (next) {
      if (!sameEntry(current, next)) changed = true;
      servers[name] = next;
      nextOwned[name] = next;
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (!sameEntry(current, prior)) continue;
    delete servers[name];
    changed = true;
  }

  for (const [name, entry] of Object.entries(desired)) {
    if (name in owned || sameEntry(servers[name], entry)) continue;
    servers[name] = entry;
    nextOwned[name] = entry;
    changed = true;
  }

  if (!changed) return { text: input, owned: nextOwned };
  if (!input.trim()) return { text: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, owned: nextOwned };
  const rewritten = rewriteTopLevelJsonProperty(input, "mcpServers", servers);
  return rewritten === null ? null : { text: rewritten, owned: nextOwned };
}

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name);
}

function renderCodexEntry(name: string, entry: McpEntry): string {
  return [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    ...(entry.envVars
      ? [`env_vars = [${entry.envVars.map((envVar) => JSON.stringify(envVar)).join(", ")}]`]
      : []),
  ].join("\n");
}

type TomlBalance = { square: number; curly: number };

function scanTomlValue(value: string, initial: TomlBalance): TomlBalance | null {
  let square = initial.square;
  let curly = initial.curly;
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (const char of value) {
    if (escaping) {
      escaping = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "#" && quote === null) break;
    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote) continue;
    if (char === "[") square += 1;
    if (char === "]") square -= 1;
    if (char === "{") curly += 1;
    if (char === "}") curly -= 1;
    if (square < 0 || curly < 0) return null;
  }
  return quote === null ? { square, curly } : null;
}

function validTomlForMerge(lines: string[]): boolean {
  const key = String.raw`(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')`;
  const assignment = new RegExp(`^\\s*${key}(?:\\s*\\.\\s*${key})*\\s*=\\s*(.+)$`, "u");
  const header = new RegExp(`^\\s*(?:\\[${key}(?:\\s*\\.\\s*${key})*\\]|\\[\\[${key}(?:\\s*\\.\\s*${key})*\\]\\])\\s*(?:#.*)?$`, "u");
  let balance: TomlBalance = { square: 0, curly: 0 };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (balance.square > 0 || balance.curly > 0) {
      const next = scanTomlValue(line, balance);
      if (!next) return false;
      balance = next;
      continue;
    }
    if (trimmed.startsWith("[")) {
      if (!header.test(line)) return false;
      continue;
    }
    const match = assignment.exec(line);
    if (!match) return false;
    const next = scanTomlValue(match[1]!, balance);
    if (!next) return false;
    balance = next;
  }
  return balance.square === 0 && balance.curly === 0;
}

type TomlSection = { name: string; start: number; end: number; raw: string };

function codexSections(lines: string[]): TomlSection[] | null {
  const headers: Array<{ name: string; start: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*\[mcp_servers\.("(?:\\.|[^"\\])*"|[A-Za-z0-9_-]+)\]\s*(?:#.*)?$/u.exec(lines[index]!);
    if (!match) continue;
    const rawName = match[1]!.trim();
    let name: string;
    if (/^[A-Za-z0-9_-]+$/u.test(rawName)) name = rawName;
    else {
      try {
        const parsed = JSON.parse(rawName) as unknown;
        if (typeof parsed !== "string") return null;
        name = parsed;
      } catch {
        return null;
      }
    }
    if (headers.some((header) => header.name === name)) return null;
    headers.push({ name, start: index });
  }
  return headers.map((header) => {
    const next = lines.findIndex((line, index) => index > header.start && /^\s*\[/.test(line));
    const end = next === -1 ? lines.length : next;
    return { name: header.name, start: header.start, end, raw: lines.slice(header.start, end).join("\n").trim() };
  });
}

function appendTomlSection(lines: string[], rendered: string): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (out.length > 0) out.push("");
  out.push(...rendered.split("\n"));
  return out;
}

function replaceTomlSection(lines: string[], section: TomlSection, rendered: string | null): string[] {
  const replacement = rendered ? rendered.split("\n") : [];
  const next = [...lines.slice(0, section.start), ...replacement, ...lines.slice(section.end)];
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  return next;
}

function reconcileCodex(
  input: string,
  desired: Record<string, McpEntry>,
  owned: Record<string, McpEntry>,
): { text: string; owned: Record<string, McpEntry> } | null {
  let lines = tomlLines(input);
  if (!validTomlForMerge(lines) || codexSections(lines) === null) return null;
  const nextOwned: Record<string, McpEntry> = {};

  for (const [name, prior] of Object.entries(owned)) {
    const sections = codexSections(lines);
    if (!sections) return null;
    const current = sections.find((section) => section.name === name);
    const next = desired[name];
    if (next) {
      if (current) lines = replaceTomlSection(lines, current, renderCodexEntry(name, next));
      else lines = appendTomlSection(lines, renderCodexEntry(name, next));
      nextOwned[name] = next;
      continue;
    }
    if (!current) {
      continue;
    }
    if (current.raw !== renderCodexEntry(name, prior)) continue;
    lines = replaceTomlSection(lines, current, null);
  }

  for (const [name, entry] of Object.entries(desired)) {
    if (name in owned) continue;
    const sections = codexSections(lines);
    if (!sections) return null;
    const current = sections.find((section) => section.name === name);
    const rendered = renderCodexEntry(name, entry);
    if (current?.raw === rendered) continue;
    if (current) lines = replaceTomlSection(lines, current, rendered);
    else lines = appendTomlSection(lines, rendered);
    nextOwned[name] = entry;
  }
  return { text: lines.length > 0 ? `${lines.join("\n")}\n` : "", owned: nextOwned };
}

async function reconcileLocked(
  homePath: string,
  harness: string,
  targetFile: string,
  gateways: GatewayRecord[],
  initialStamp: GatewayMcpStamp,
): Promise<GatewayMcpSeedResult> {
  const kitClaim = await kitClaimsTarget(homePath, targetFile);
  if (kitClaim !== "unclaimed") {
    const reason = kitClaim === "claimed" ? `kit owns ${targetFile}` : "kit manifest is malformed or unreadable";
    gatewayMcpDebug(`skipping ${homePath}: ${reason}`);
    return { status: "skipped", reason, written: [] };
  }
  const targetPath = join(homePath, targetFile);
  const target = await readTarget(targetPath);
  if (target.status === "unreadable") {
    const reason = `${targetFile} is unreadable`;
    gatewayMcpDebug(`skipping ${homePath}: ${reason}`);
    return { status: "skipped", reason, written: [] };
  }
  const desired = desiredEntries(gateways, harness);
  const owned = initialStamp.files[targetFile] ?? {};
  const reconciled = harness === "claude"
    ? reconcileClaude(target.text, desired, owned)
    : reconcileCodex(target.text, desired, owned);
  if (!reconciled) {
    const reason = `${targetFile} is malformed; left untouched`;
    gatewayMcpDebug(`skipping ${homePath}: ${reason}`);
    return { status: "skipped", reason, written: [] };
  }

  const nextFiles = { ...initialStamp.files };
  if (targetFile in initialStamp.files || Object.keys(reconciled.owned).length > 0) {
    nextFiles[targetFile] = reconciled.owned;
  }
  const nextStamp: GatewayMcpStamp = { schema: STAMP_SCHEMA, files: nextFiles };
  const currentStampText = `${JSON.stringify(initialStamp, null, 2)}\n`;
  const nextStampText = `${JSON.stringify(nextStamp, null, 2)}\n`;
  const written: string[] = [];
  if (reconciled.text !== target.text) {
    await atomicWriteFile(targetPath, reconciled.text, { mode: 0o600 });
    written.push(targetFile);
  }
  if (nextStampText !== currentStampText) {
    await atomicWriteFile(join(homePath, STAMP_FILE), nextStampText, { mode: 0o600 });
    written.push(STAMP_FILE);
  }
  return { status: "seeded", written };
}

export async function seedGatewayMcp(
  homePath: string,
  harness: string,
  options: SeedGatewayMcpOptions = {},
): Promise<GatewayMcpSeedResult> {
  const targetFile = targetFileForHarness(harness);
  if (!targetFile) {
    const reason = `no MCP config dialect for ${harness}`;
    gatewayMcpDebug(`skipping ${homePath}: ${reason}`);
    return { status: "skipped", reason, written: [] };
  }
  if (options.gateways === undefined && gatewaysAreDisabled()) {
    const reason = "gateway discovery is disabled; existing MCP seed state left untouched";
    gatewayMcpDebug(`skipping ${homePath}: ${reason}`);
    return { status: "skipped", reason, written: [] };
  }
  try {
    const gateways = options.gateways ?? liveGateways();
    const stampExists = (await stat(join(homePath, STAMP_FILE)).catch(() => null))?.isFile() === true;
    if (gateways.length === 0 && !stampExists) return { status: "seeded", written: [] };
    return await withFileLock(join(homePath, ".hive-gateways.lock"), async () => {
      const stampRead = await readStamp(homePath);
      if (stampRead.status === "invalid") {
        const reason = `${STAMP_FILE} is malformed or unreadable; left untouched`;
        gatewayMcpDebug(`skipping ${homePath}: ${reason}`);
        return { status: "skipped" as const, reason, written: [] };
      }
      return reconcileLocked(homePath, harness, targetFile, gateways, stampRead.stamp);
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gatewayMcpDebug(`seeding skipped for ${homePath}: ${reason}`);
    return { status: "skipped", reason, written: [] };
  }
}
