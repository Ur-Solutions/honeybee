import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { loadSession } from "../store.js";
import { loadTsModule } from "../tsLoader.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { cancelRun, boardView, listRuns, readRunEvents, requireRun } from "../comb/store.js";
import { defineCombFromFile, defineCombVersion, listCombVersions, loadCombVersion } from "../comb/registry.js";
import { asCombError, CombError } from "../comb/errors.js";
import { instantiateRun } from "../comb/instantiate.js";
import { lintComb } from "../comb/schema.js";
import type { CombCliFailure, CombCliSuccess, CombSpec, JsonValue, RunStatus } from "../comb/types.js";

const COMB_HELP = `hive comb — durable orchestration graphs

Usage
  hive comb list [--json]
  hive comb lint <file.json|file.ts|-> [--json]
  hive comb define <file.json|file.ts|-> [name] [--base-version <n>] [--json]
  hive comb inspect <name> [--version <n>] [--json]
  hive comb run <name> [--version <n>] --input <file|-> [--cwd <path>] [--product <key>] [--json]
  hive comb run --graph <file|-> --input <file|-> [--cwd <path>] [--product <key>] [--json]
  hive comb runs [--comb <name>] [--status active|failed|cancelled|done] [--active] [--last <1..1000>] [--json]
  hive comb status <run-id> [--activation <activation-id>] [--json]
  hive comb cancel <run-id> [--reason <text>] [--json]
  hive comb events <run-id> [--after <sequence>] [--limit <1..1000>] [--json]`;

export async function cmdComb(parsed: Parsed): Promise<void> {
  const subcommand = parsed.args[0];
  const command = `comb.${subcommand ?? "help"}`;
  try {
    let result: unknown;
    switch (subcommand) {
      case undefined:
      case "help":
        console.log(COMB_HELP);
        return;
      case "list":
        result = { combs: await listCombVersions() };
        break;
      case "lint":
        result = await combLint(parsed);
        break;
      case "define":
        result = await combDefine(parsed);
        break;
      case "inspect":
        result = await combInspect(parsed);
        break;
      case "run":
        result = await combRun(parsed);
        break;
      case "runs":
        result = await combRuns(parsed);
        break;
      case "status":
        result = await combStatus(parsed);
        break;
      case "cancel":
        result = await combCancel(parsed);
        break;
      case "events":
        result = await combEvents(parsed);
        break;
      default:
        throw new CombError("invalid_argument", `unknown comb subcommand: ${subcommand}`);
    }
    emitSuccess(command, result, truthy(flag(parsed, "json")));
  } catch (error) {
    const combError = asCombError(error);
    emitFailure(command, combError, truthy(flag(parsed, "json")));
    process.exitCode = combError.exitCode;
  }
}

/** Internal one-shot entrypoint used by daemon integration and acceptance tests. */
export async function runCombSweepExec(): Promise<void> {
  const [{ createCombSweeper }, { listSessions }] = await Promise.all([
    import("../daemon/combSweep.js"),
    import("../store.js"),
  ]);
  const sweep = createCombSweeper({}, { detached: false });
  console.log(JSON.stringify(await sweep(await listSessions(), new Map()), null, 2));
}

async function combLint(parsed: Parsed) {
  const source = requiredArg(parsed, 1, "Usage: hive comb lint <file.json|file.ts|-> [--json]");
  const value = await loadDefinition(source);
  return lintComb(value);
}

async function combDefine(parsed: Parsed) {
  const source = requiredArg(parsed, 1, "Usage: hive comb define <file.json|file.ts|-> [name] [--base-version <n>] [--json]");
  const nameOverride = parsed.args[2];
  const baseVersion = optionalIntegerFlag(parsed, "base-version", 1);
  if (source !== "-") {
    return defineCombFromFile(source, {
      ...(nameOverride ? { nameOverride } : {}),
      ...(baseVersion !== undefined ? { baseVersion } : {}),
    });
  }
  const raw = await readStdin();
  const definition = parseJson(raw, "comb definition");
  return defineCombVersion({
    definition,
    provenance: {
      kind: "file",
      sourcePath: "-",
      sourceDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    },
    source: { contents: raw, extension: ".json" },
    ...(nameOverride ? { nameOverride } : {}),
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  });
}

async function combInspect(parsed: Parsed) {
  const name = requiredArg(parsed, 1, "Usage: hive comb inspect <name> [--version <n>] [--json]");
  const version = optionalIntegerFlag(parsed, "version", 1);
  const comb = await loadCombVersion(name, version);
  if (!comb) throw new CombError("not_found", version ? `comb not found: ${name}@${version}` : `comb not found: ${name}`);
  return { comb };
}

async function combRun(parsed: Parsed) {
  if (flag(parsed, "bee") !== undefined) {
    throw new CombError("invalid_argument", "attached --bee runs are not enabled in strict-spine slice 1");
  }
  const graphSource = stringFlag(parsed, "graph");
  const name = graphSource ? undefined : parsed.args[1];
  if (!graphSource && !name) throw new CombError("invalid_argument", "Usage: hive comb run <name> --input <file|-> [--json]");
  const inputSource = requiredStringFlag(parsed, "input");
  if (inputSource === "-" && graphSource === "-") {
    throw new CombError("invalid_argument", "--graph - and --input - cannot share stdin");
  }
  const input = await loadJsonValue(inputSource, "run input");
  const cwd = resolve(stringFlag(parsed, "cwd") ?? process.cwd());
  const productKey = stringFlag(parsed, "product") ?? basename(cwd);
  const collision = optionalEnumFlag(parsed, "collision", ["refuse", "join-existing"] as const);
  const triggerId = stringFlag(parsed, "origin-trigger");
  const deliveryId = stringFlag(parsed, "origin-delivery");
  if ((triggerId === undefined) !== (deliveryId === undefined)) {
    throw new CombError("invalid_argument", "--origin-trigger and --origin-delivery are an all-or-none pair");
  }
  const eventJson = stringFlag(parsed, "event-json");
  if (eventJson && !triggerId) throw new CombError("invalid_argument", "--event-json requires trigger provenance");
  const event = eventJson ? objectValue(parseJson(eventJson, "origin event"), "origin event") : undefined;
  if (event && (event.triggerId !== triggerId || event.deliveryId !== deliveryId)) {
    throw new CombError("invalid_argument", "origin event triggerId/deliveryId must equal provenance flags");
  }
  const origin = triggerId && deliveryId
    ? { kind: "trigger" as const, triggerId, deliveryId, ...(typeof event?.eventId === "string" ? { eventId: event.eventId } : {}) }
    : { kind: graphSource ? "ad-hoc" as const : "manual" as const, actor: process.env.HIVE_BEE ?? process.env.USER ?? "operator" };
  if (graphSource) {
    const definition = lintComb(await loadDefinition(graphSource)).normalized;
    return instantiateRun({
      definition,
      input,
      cwd,
      productKey,
      origin,
      ...(collision ? { collision } : {}),
    });
  }
  const version = optionalIntegerFlag(parsed, "version", 1);
  if (triggerId && version === undefined) {
    throw new CombError("invalid_argument", "trigger-origin comb runs require --version");
  }
  const comb = await loadCombVersion(name!, version);
  if (!comb) throw new CombError("not_found", version ? `comb not found: ${name}@${version}` : `comb not found: ${name}`);
  return instantiateRun({
    storedComb: comb,
    input,
    cwd,
    productKey,
    origin,
    ...(collision ? { collision } : {}),
  });
}

async function combRuns(parsed: Parsed) {
  const combName = stringFlag(parsed, "comb");
  const status = optionalEnumFlag(parsed, "status", ["active", "failed", "cancelled", "done"] as const);
  const active = truthy(flag(parsed, "active"));
  if (active && status && status !== "active") throw new CombError("invalid_argument", "--active conflicts with a non-active --status");
  const since = stringFlag(parsed, "since");
  if (since && !Number.isFinite(Date.parse(since))) throw new CombError("invalid_argument", "--since must be an ISO-8601 timestamp");
  const last = optionalIntegerFlag(parsed, "last", 1, 1000) ?? 200;
  const runs = (await listRuns())
    .filter((run) => !combName || run.currentSnapshot.definition.name === combName)
    .filter((run) => {
      if (active) return run.status === "active" || run.cleanup.status !== "complete";
      return !status || run.status === status;
    })
    .filter((run) => !since || run.updatedAt > since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .slice(0, last)
    .map(boardView);
  return { runs };
}

async function combStatus(parsed: Parsed) {
  const runId = parsed.args[1] ?? await inferRunId();
  const run = await requireRun(runId);
  const activationId = stringFlag(parsed, "activation");
  if (activationId && !run.activations[activationId]) {
    throw new CombError("not_found", `activation not found: ${activationId}`);
  }
  return { run, ...(activationId ? { hydratedActivation: run.activations[activationId] } : {}) };
}

async function combCancel(parsed: Parsed) {
  const runId = requiredArg(parsed, 1, "Usage: hive comb cancel <run-id> [--reason <text>] [--json]");
  const run = await cancelRun(runId, { ...(stringFlag(parsed, "reason") ? { reason: stringFlag(parsed, "reason")! } : {}) });
  return { runId, status: "cancelled" as const, fence: run.cancellation!, cleanup: run.cleanup };
}

async function combEvents(parsed: Parsed) {
  const runId = requiredArg(parsed, 1, "Usage: hive comb events <run-id> [--after <n>] [--limit <n>] [--json]");
  const after = optionalIntegerFlag(parsed, "after", 0) ?? 0;
  const limit = optionalIntegerFlag(parsed, "limit", 1, 1000) ?? 256;
  return readRunEvents(runId, { after, limit });
}

async function inferRunId(): Promise<string> {
  const bee = process.env.HIVE_BEE;
  if (!bee) throw new CombError("not_found", "no run ID supplied and this process is not inside a bound bee");
  const record = await loadSession(bee);
  const candidates = record?.combActivations?.filter((binding) => binding.status === "current") ?? [];
  if (candidates.length === 0) throw new CombError("not_found", `bee ${bee} has no current comb activation`);
  if (candidates.length > 1) {
    throw new CombError("ambiguous_activation", `bee ${bee} has multiple current comb activations`, candidates as unknown as JsonValue);
  }
  return candidates[0]!.runId;
}

async function loadDefinition(source: string): Promise<unknown> {
  if (source === "-") return parseJson(await readStdin(), "comb definition");
  const extension = extname(source);
  if (extension === ".ts") return loadTsModule(resolve(source), { kind: "comb" });
  if (extension !== ".json") throw new CombError("invalid_argument", `unsupported comb source extension ${extension}; use .json or .ts`);
  return parseJson(await readFile(resolve(source), "utf8"), "comb definition");
}

async function loadJsonValue(source: string, label: string): Promise<JsonValue> {
  const raw = source === "-" ? await readStdin() : await readFile(resolve(source), "utf8");
  const value = parseJson(raw, label);
  return value as JsonValue;
}

let stdinPromise: Promise<string> | undefined;
function readStdin(): Promise<string> {
  stdinPromise ??= new Promise((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("end", () => resolveInput(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
  return stdinPromise;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CombError("invalid_argument", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CombError("invalid_argument", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredArg(parsed: Parsed, index: number, usage: string): string {
  const value = parsed.args[index];
  if (!value) throw new CombError("invalid_argument", usage);
  return value;
}

function stringFlag(parsed: Parsed, key: string): string | undefined {
  const value = flag(parsed, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CombError("invalid_argument", `--${key} requires a value`);
  return value;
}

function requiredStringFlag(parsed: Parsed, key: string): string {
  const value = stringFlag(parsed, key);
  if (value === undefined) throw new CombError("invalid_argument", `--${key} is required`);
  return value;
}

function optionalIntegerFlag(parsed: Parsed, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = flag(parsed, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CombError("invalid_argument", `--${key} must be an integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new CombError("invalid_argument", `--${key} must be between ${min} and ${max}`);
  }
  return number;
}

function optionalEnumFlag<const T extends readonly string[]>(parsed: Parsed, key: string, values: T): T[number] | undefined {
  const value = stringFlag(parsed, key);
  if (value === undefined) return undefined;
  if (!values.includes(value)) throw new CombError("invalid_argument", `--${key} must be one of ${values.join(", ")}`);
  return value as T[number];
}

function emitSuccess(command: string, result: unknown, json: boolean): void {
  const envelope: CombCliSuccess<unknown> = { ok: true, command, result };
  if (json) console.log(JSON.stringify(envelope));
  else console.log(`${command}\tok\n${JSON.stringify(result, null, 2)}`);
}

function emitFailure(command: string, error: CombError, json: boolean): void {
  const envelope: CombCliFailure = {
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
  if (json) console.log(JSON.stringify(envelope));
  else console.error(`${command}: ${error.message}`);
}

export { COMB_HELP };
