#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    values.set(key.slice(2), value);
    i += 1;
  }
  const integer = (key, fallback) => {
    const value = Number(values.get(key) ?? fallback);
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${key} must be a positive integer`);
    return value;
  };
  const until = values.get("until") ?? "first-text";
  if (!["turn-start", "first-text", "turn-end"].includes(until)) {
    throw new Error("--until must be turn-start, first-text, or turn-end");
  }
  return {
    harness: values.get("harness") ?? "codex",
    account: values.get("account"),
    samples: integer("samples", 5),
    concurrency: integer("concurrency", 1),
    timeoutMs: integer("timeout-ms", 90_000),
    pollMs: integer("poll-ms", 10),
    cwd: resolve(values.get("cwd") ?? process.cwd()),
    prompt: values.get("prompt") ?? "Reply exactly READY.",
    until,
    output: values.get("output") ? resolve(values.get("output")) : undefined,
    hiveBin: values.get("hive-bin") ?? process.env.HIVE_BENCH_BIN ?? "hive",
    xBin: values.get("x-bin") ?? process.env.HIVE_BENCH_X_BIN,
  };
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readEvents(path) {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function observedEventTs(events, type) {
  const event = events.find((candidate) => candidate?.type === type && Number.isFinite(candidate.ts));
  return event?.ts;
}

function phaseTimings(stderr) {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("spawn-timing "));
  if (!line) return undefined;
  const result = {};
  for (const match of line.matchAll(/(?:^| · )([a-z-]+) (\d+)ms/g)) result[match[1]] = Number(match[2]);
  const total = line.match(/: total (\d+)ms/);
  if (total) result.total = Number(total[1]);
  return result;
}

function apiaryLikeEnv() {
  const env = { ...process.env, HIVE_DEBUG_SPAWN: "1" };
  for (const key of [
    "HIVE_BEE",
    "HIVE_PARENT",
    "HIVE_COMB",
    "TMUX",
    "TMUX_PANE",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GROK_HOME",
    "KIMI_CODE_HOME",
    "OPENCODE_CONFIG_DIR",
    "CURSOR_CONFIG_DIR",
  ]) delete env[key];
  return env;
}

async function observeSample({ name, requestedAt, storeRoot, timeoutMs, pollMs, until, shouldStop }) {
  const sessionPath = join(storeRoot, "sessions", `${name}.json`);
  const runDir = join(storeRoot, "hsr", name);
  const metaPath = join(runDir, "meta.json");
  const eventsPath = join(runDir, "events.jsonl");
  const deadline = requestedAt + timeoutMs;
  let runningObservedAt;
  let session;
  let meta;
  let events = [];

  while (Date.now() < deadline) {
    if (shouldStop?.()) break;
    session ??= await readJson(sessionPath);
    meta = await readJson(metaPath) ?? meta;
    if (!runningObservedAt && meta?.status === "running") runningObservedAt = Date.now();
    events = await readEvents(eventsPath);
    const reachedTarget =
      (until === "turn-start" && observedEventTs(events, "turn_start") !== undefined) ||
      (until === "first-text" && observedEventTs(events, "text") !== undefined) ||
      (until === "turn-end" && observedEventTs(events, "turn_end") !== undefined);
    if (reachedTarget || events.some((event) => event?.type === "exit")) break;
    await wait(pollMs);
  }

  const firstTurnStartAt = observedEventTs(events, "turn_start");
  const firstTextAt = observedEventTs(events, "text");
  const firstTurnEndAt = observedEventTs(events, "turn_end");
  let retries = 0;
  try {
    const log = await readFile(join(runDir, "host.log"), "utf8");
    retries = [...log.matchAll(/restarting codex app-server/g)].length;
  } catch {
    // A harness with no host diagnostics simply has no retries to report.
  }
  return {
    sessionCreatedAt: session?.createdAt,
    queuedAt: meta?.queuedAt,
    hostStartedAt: meta?.startedAt,
    runningAt: meta?.runningAt,
    runningObservedAt,
    firstTurnStartAt,
    firstTextAt,
    firstTurnEndAt,
    finalHostStatus: meta?.status,
    retries,
  };
}

function delta(start, value) {
  if (typeof value === "number") return value - start;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed - start;
  }
  return undefined;
}

async function oneSample(config, index) {
  const suffix = `${Date.now().toString(36)}-${process.pid}-${index}`;
  const name = `startup-bench-${config.harness}-${suffix}`.slice(0, 63);
  const storeRoot = process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive");
  const xArgs = [
    config.harness,
    config.prompt,
    "--cwd",
    config.cwd,
    "--substrate",
    "hsr",
    "--name",
    name,
    "--yolo",
  ];
  if (config.account) xArgs.push("--account", config.account);
  const spawnArgs = config.xBin ? xArgs : ["x", ...xArgs];
  const spawnBin = config.xBin ?? config.hiveBin;

  const requestedAt = Date.now();
  let stopObservation = false;
  const observation = observeSample({
    name,
    requestedAt,
    storeRoot,
    timeoutMs: config.timeoutMs,
    pollMs: config.pollMs,
    until: config.until,
    shouldStop: () => stopObservation,
  });
  let cli;
  let cliError;
  try {
    cli = await execFileP(spawnBin, spawnArgs, {
      env: apiaryLikeEnv(),
      timeout: config.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    cliError = error instanceof Error ? error.message : String(error);
    cli = { stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" };
    stopObservation = true;
  }
  const cliReturnedAt = Date.now();
  const observed = await observation;
  const completedAt = Date.now();

  let retireError;
  try {
    await execFileP(config.hiveBin, ["retire", name], {
      env: apiaryLikeEnv(),
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    retireError = error instanceof Error ? error.message : String(error);
  }

  const metrics = {
    request_to_cli_return_ms: cliReturnedAt - requestedAt,
    request_to_session_record_ms: delta(requestedAt, observed.sessionCreatedAt),
    request_to_host_start_ms: delta(requestedAt, observed.hostStartedAt),
    request_to_running_ms: delta(requestedAt, observed.runningAt),
    request_to_running_observed_ms: delta(requestedAt, observed.runningObservedAt),
    request_to_turn_start_ms: delta(requestedAt, observed.firstTurnStartAt),
    request_to_first_text_ms: delta(requestedAt, observed.firstTextAt),
    request_to_turn_end_ms: delta(requestedAt, observed.firstTurnEndAt),
    observation_total_ms: completedAt - requestedAt,
    codex_handshake_retries: observed.retries,
  };
  return {
    index,
    name,
    requestedAt: new Date(requestedAt).toISOString(),
    metrics,
    phases: phaseTimings(String(cli.stderr ?? "")),
    finalHostStatus: observed.finalHostStatus,
    cliError,
    retireError,
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return undefined;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  const metricNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.metrics)))];
  return Object.fromEntries(metricNames.map((metric) => {
    const values = samples
      .map((sample) => sample.metrics[metric])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return [metric, {
      n: values.length,
      min: values[0],
      p50: percentile(values, 0.50),
      p95: percentile(values, 0.95),
      max: values.at(-1),
    }];
  }));
}

async function runBounded(total, concurrency, worker) {
  const results = new Array(total);
  let next = 0;
  async function consume() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= total) return;
      results[index] = await worker(index);
      process.stderr.write(`sample ${index + 1}/${total}: ${JSON.stringify(results[index].metrics)}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(total, concurrency) }, consume));
  return results;
}

const config = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const samples = await runBounded(config.samples, config.concurrency, (index) => oneSample(config, index));
const report = {
  schema: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  config: {
    harness: config.harness,
    account: config.account,
    samples: config.samples,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    pollMs: config.pollMs,
    until: config.until,
    cwd: config.cwd,
    hiveBin: config.hiveBin,
    ...(config.xBin ? { xBin: config.xBin } : {}),
  },
  failures: samples.filter((sample) => sample.cliError || sample.retireError || !Number.isFinite(sample.metrics.request_to_turn_start_ms)).length,
  summary: summarize(samples),
  samples,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (config.output) await writeFile(config.output, json, "utf8");
process.stdout.write(json);
