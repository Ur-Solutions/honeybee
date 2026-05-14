#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { resolveAgent, shellCommand } from "./agents.js";
import { appendLedger, deleteSession, listSessions, loadSession, safeName, saveSession, type SessionRecord } from "./store.js";
import { capture, hasSession, kill, listTmuxSessions, newSession, sendText } from "./tmux.js";
import { lastAssistantText, latestTranscript, renderTranscript } from "./transcripts.js";

const VERSION = "0.0.1";

type Parsed = {
  command: string;
  args: string[];
  flags: Map<string, string | true | string[]>;
  rest: string[];
};

async function main(argv: string[]) {
  const parsed = parse(argv);
  switch (parsed.command) {
    case "spawn":
      await cmdSpawn(parsed);
      break;
    case "send":
      await cmdSend(parsed);
      break;
    case "tail":
    case "cat":
      await cmdTail(parsed);
      break;
    case "list":
    case "ls":
      await cmdList();
      break;
    case "transcript":
    case "tx":
      await cmdTranscript(parsed);
      break;
    case "last":
      await cmdLast(parsed);
      break;
    case "kill":
      await cmdKill(parsed);
      break;
    case "run":
      await cmdRun(parsed);
      break;
    case "attach":
      await cmdAttach(parsed);
      break;
    case "help":
    case "--help":
    case "-h":
    case "":
      printHelp();
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    default:
      throw new Error(`Unknown command: ${parsed.command}\nRun: ap help`);
  }
}

async function cmdSpawn(parsed: Parsed): Promise<SessionRecord> {
  const agent = parsed.args[0];
  if (!agent) throw new Error("Usage: ap spawn <agent> [--name name] [--cwd dir] [-- <agent-args...>]");

  const name = safeName(String(flag(parsed, "name") ?? `${agent}-${shortId()}`));
  if (await hasSession(name)) throw new Error(`tmux session already exists: ${name}`);

  const cwd = resolve(String(flag(parsed, "cwd") ?? process.cwd()).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const spec = resolveAgent(agent, parsed.rest);
  const command = shellCommand(spec);
  await newSession(name, cwd, command);

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    agent,
    cwd,
    command,
    tmuxTarget: name,
    createdAt: now,
    updatedAt: now,
    status: "running",
  };
  await saveSession(record);
  console.log(`${name}\t${agent}\t${cwd}`);
  return record;
}

async function cmdSend(parsed: Parsed) {
  const target = parsed.args[0];
  const prompt = String(flag(parsed, "prompt") ?? flag(parsed, "p") ?? parsed.args.slice(1).join(" "));
  if (!target || !prompt) throw new Error("Usage: ap send <session> <prompt> OR ap send <session> -p <prompt>");
  const record = await resolveSession(target);
  await ensureLive(record.tmuxTarget);
  await sendText(record.tmuxTarget, prompt);
  await saveSession({ ...record, updatedAt: new Date().toISOString(), status: "running" });
  await appendLedger({ type: "prompt.send", session: record.name, agent: record.agent, cwd: record.cwd, chars: prompt.length });
  console.log(`sent\t${record.name}\t${prompt.length} chars`);
}

async function cmdTail(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: ap tail <session> [-n lines]");
  const lines = Number(flag(parsed, "n") ?? flag(parsed, "lines") ?? 80);
  const record = await resolveSession(target);
  await ensureLive(record.tmuxTarget);
  console.log(await capture(record.tmuxTarget, Number.isFinite(lines) ? lines : 80));
}

async function cmdList() {
  const [records, tmuxSessions] = await Promise.all([listSessions(), listTmuxSessions()]);
  const live = new Set(tmuxSessions);
  for (const record of records) {
    const status = live.has(record.tmuxTarget) ? "running" : "dead";
    console.log(`${status}\t${record.name}\t${record.agent}\t${record.cwd}\t${record.command}`);
  }
}

async function cmdTranscript(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: ap transcript <session> [-n rows] [--json]");
  const record = await resolveSession(target);
  const tx = await latestTranscript(record.agent, record.cwd, record.createdAt);
  if (!tx) throw new Error(`No transcript provider/file found for ${record.agent} session ${record.name}`);
  const limitRaw = flag(parsed, "n") ?? flag(parsed, "limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const json = truthy(flag(parsed, "json"));
  console.error(`# ${tx.provider} transcript: ${tx.path}`);
  console.log(renderTranscript(tx.rows, { limit: Number.isFinite(limit) ? limit : undefined, json }));
}

async function cmdLast(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: ap last <session>");
  const record = await resolveSession(target);
  const tx = await latestTranscript(record.agent, record.cwd, record.createdAt);
  if (!tx) throw new Error(`No transcript provider/file found for ${record.agent} session ${record.name}`);
  const text = lastAssistantText(tx.rows);
  if (!text) throw new Error(`No assistant text found in transcript: ${tx.path}`);
  console.error(`# ${tx.provider} transcript: ${tx.path}`);
  console.log(text);
}

async function cmdKill(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: ap kill <session>");
  const record = await resolveSession(target);
  const result = await kill(record.tmuxTarget);
  await deleteSession(record.name);
  console.log(`${result.ok ? "killed" : "gone"}\t${record.name}`);
}

async function cmdRun(parsed: Parsed) {
  const agent = parsed.args[0];
  const prompt = String(flag(parsed, "prompt") ?? flag(parsed, "p") ?? parsed.args.slice(1).join(" "));
  if (!agent || !prompt) throw new Error("Usage: ap run <agent> -p <prompt> [--cwd dir] [--keep]");

  const spawnParsed: Parsed = {
    command: "spawn",
    args: [agent],
    flags: new Map(parsed.flags),
    rest: parsed.rest,
  };
  if (!spawnParsed.flags.has("name")) spawnParsed.flags.set("name", `${agent}-${shortId()}`);
  const record = await cmdSpawn(spawnParsed);

  // Give TUIs a short moment to draw their prompt before paste. This is not
  // semantic waiting; v0 is a cockpit, not a transcript parser.
  await sleep(Number(flag(parsed, "boot-ms") ?? 1200));
  await sendText(record.tmuxTarget, prompt);
  await appendLedger({ type: "prompt.run", session: record.name, agent: record.agent, cwd: record.cwd, chars: prompt.length });

  const waitMs = Number(flag(parsed, "wait-ms") ?? 1000);
  if (waitMs > 0) await sleep(waitMs);
  const lines = Number(flag(parsed, "n") ?? flag(parsed, "lines") ?? 80);
  console.log(await capture(record.tmuxTarget, Number.isFinite(lines) ? lines : 80));

  if (!truthy(flag(parsed, "keep"))) {
    console.error(`\n(ap: session kept by default would be safer; pass 'ap kill ${record.name}' when done.)`);
  }
}

async function cmdAttach(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: ap attach <session>");
  const record = await resolveSession(target);
  console.log(`tmux attach -t ${record.tmuxTarget}`);
}

async function resolveSession(name: string): Promise<SessionRecord> {
  const exact = await loadSession(name);
  if (exact) return exact;
  const records = await listSessions();
  const matches = records.filter((record) => record.name.startsWith(name));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous session ${name}: ${matches.map((m) => m.name).join(", ")}`);
  throw new Error(`Unknown session: ${name}`);
}

async function ensureLive(target: string) {
  if (!(await hasSession(target))) throw new Error(`tmux session is not running: ${target}`);
}

function parse(argv: string[]): Parsed {
  const [command = "", ...tail] = argv;
  const flags = new Map<string, string | true | string[]>();
  const args: string[] = [];
  let rest: string[] = [];

  for (let i = 0; i < tail.length; i += 1) {
    const item = tail[i]!;
    if (item === "--") {
      rest = tail.slice(i + 1);
      break;
    }
    if (item.startsWith("--")) {
      const eq = item.indexOf("=");
      const key = item.slice(2, eq > -1 ? eq : undefined);
      const value = eq > -1 ? item.slice(eq + 1) : tail[i + 1] && !tail[i + 1]!.startsWith("-") ? tail[++i]! : true;
      setFlag(flags, key, value);
      continue;
    }
    if (item.startsWith("-") && item.length > 1) {
      const key = item.slice(1);
      const value = tail[i + 1] && !tail[i + 1]!.startsWith("-") ? tail[++i]! : true;
      setFlag(flags, key, value);
      continue;
    }
    args.push(item);
  }

  return { command, args, flags, rest };
}

function setFlag(flags: Map<string, string | true | string[]>, key: string, value: string | true) {
  const existing = flags.get(key);
  if (Array.isArray(existing)) existing.push(String(value));
  else if (existing !== undefined) flags.set(key, [String(existing), String(value)]);
  else flags.set(key, value);
}

function flag(parsed: Parsed, key: string): string | true | string[] | undefined {
  return parsed.flags.get(key);
}

function truthy(value: unknown) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function shortId() {
  return randomUUID().slice(0, 8);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`agentpit ${VERSION}

Usage:
  ap spawn <agent> [--name name] [--cwd dir] [-- <agent-args...>]
  ap run <agent> -p <prompt> [--cwd dir] [--keep] [-- <agent-args...>]
  ap send <session> <prompt>
  ap tail <session> [-n lines]
  ap transcript <session> [-n rows] [--json]
  ap last <session>
  ap list
  ap kill <session>
  ap attach <session>

Agents:
  claude, codex, opencode, pi, droid, or any executable name.

Env overrides:
  AP_CLAUDE_CMD="claude --model sonnet" ap spawn claude
  AP_DROID_CMD="python3 ~/bin/droid.py" ap spawn droid
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`ap: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
