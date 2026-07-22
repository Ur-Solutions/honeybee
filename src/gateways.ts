import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { storeRoot } from "./fsx.js";
import { isValidEnvEntry, PROTECTED_SPAWN_ENV_KEYS } from "./spawnEnv.js";

export type GatewayRecord = {
  name: string;
  protocol: "mcp";
  socketPath: string;
  shim: { command: string; args: string[] };
  env: Record<string, string>;
  pid: number;
  startedAt: string;
  gatewayRev: 1;
};

export type GatewayStatus = GatewayRecord & {
  live: boolean;
  registryPath: string;
};

type CachedGatewayFile = {
  signature: string;
  record: GatewayRecord | null;
};

let cachedRoot = "";
let cachedFiles = new Map<string, CachedGatewayFile>();

export function gatewaysAreDisabled(): boolean {
  return process.env.HIVE_GATEWAYS_DISABLE === "1";
}

function gatewayDebug(message: string): void {
  if (process.env.HIVE_DEBUG_GATEWAYS === "1") console.error(`[hive gateways] ${message}`);
}

function gatewayDir(): string {
  return join(storeRoot(), "gateways");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => typeof item === "string" && isValidEnvEntry(key, item));
}

function parseGatewayRecord(raw: string): GatewayRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const shim = record.shim;
  if (!shim || typeof shim !== "object" || Array.isArray(shim)) return null;
  const shimRecord = shim as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0 || /[\u0000-\u001f]/u.test(record.name)) return null;
  if (record.protocol !== "mcp" || record.gatewayRev !== 1) return null;
  if (typeof record.socketPath !== "string" || record.socketPath.includes("\0") || !isAbsolute(record.socketPath)) return null;
  if (typeof shimRecord.command !== "string" || shimRecord.command.includes("\0") || !isAbsolute(shimRecord.command)) return null;
  if (!Array.isArray(shimRecord.args) || !shimRecord.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) return null;
  if (!isStringRecord(record.env)) return null;
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) return null;
  if (typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))) return null;
  return {
    name: record.name,
    protocol: "mcp",
    socketPath: record.socketPath,
    shim: { command: shimRecord.command, args: [...shimRecord.args] as string[] },
    env: { ...record.env },
    pid: Number(record.pid),
    startedAt: record.startedAt,
    gatewayRev: 1,
  };
}

function cachedGatewayRecords(): Array<{ record: GatewayRecord; registryPath: string }> {
  const root = gatewayDir();
  if (root !== cachedRoot) {
    cachedRoot = root;
    cachedFiles = new Map();
  }
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    cachedFiles.clear();
    return [];
  }

  const nextCache = new Map<string, CachedGatewayFile>();
  const out: Array<{ record: GatewayRecord; registryPath: string }> = [];
  for (const name of names) {
    const path = join(root, name);
    try {
      const info = statSync(path, { bigint: true });
      const signature = `${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
      const prior = cachedFiles.get(path);
      const record = prior?.signature === signature ? prior.record : parseGatewayRecord(readFileSync(path, "utf8"));
      nextCache.set(path, { signature, record });
      if (!record) {
        gatewayDebug(`skipping malformed registry file ${path}`);
        continue;
      }
      out.push({ record, registryPath: path });
    } catch (error) {
      gatewayDebug(`skipping unreadable registry file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cachedFiles = nextCache;
  return out;
}

export function gatewayPidIsLive(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function gatewaysWithLiveness(): GatewayStatus[] {
  if (gatewaysAreDisabled()) return [];
  try {
    return cachedGatewayRecords().map(({ record, registryPath }) => ({
      ...record,
      live: gatewayPidIsLive(record.pid),
      registryPath,
    }));
  } catch (error) {
    gatewayDebug(`registry read failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export function liveGateways(): GatewayRecord[] {
  return gatewaysWithLiveness().filter((gateway) => gateway.live).map(({ live: _live, registryPath: _path, ...gateway }) => gateway);
}

export function liveGatewayEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const gateway of liveGateways()) {
    for (const [key, value] of Object.entries(gateway.env)) {
      if (PROTECTED_SPAWN_ENV_KEYS.has(key)) {
        gatewayDebug(`ignoring protected env key ${key} from gateway ${gateway.name}`);
        continue;
      }
      env[key] = value;
    }
  }
  return env;
}

/** Test seam: forget parsed registry files after changing HIVE_STORE_ROOT. */
export function resetGatewayCacheForTests(): void {
  cachedRoot = "";
  cachedFiles.clear();
}
