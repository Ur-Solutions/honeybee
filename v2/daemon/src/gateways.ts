/** Read-only v2 daemon view of live operator MCP gateway registrations. */
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface LiveGateway {
  name: string;
  shim: { command: string; args: string[] };
  env: Record<string, string>;
  pid?: number;
  stateless?: boolean;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROTECTED_ENV = new Set(["HIVE_BEE", "HIVE_BEE_ID", "HIVE_PARENT", "HIVE_COMB"]);

export function parseGatewayRecord(raw: string): LiveGateway | null {
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
  if (record.stateless !== undefined && typeof record.stateless !== "boolean") return null;
  if (typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))) return null;
  if (typeof shimRecord.command !== "string" || !isAbsolute(shimRecord.command) || shimRecord.command.includes("\0")) return null;
  if (!Array.isArray(shimRecord.args) || !shimRecord.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) return null;
  if (!record.env || typeof record.env !== "object" || Array.isArray(record.env)) return null;
  const envEntries = Object.entries(record.env as Record<string, unknown>);
  if (envEntries.some(([key, item]) => !ENV_KEY.test(key) || typeof item !== "string" || item.includes("\0"))) return null;
  const stateless = record.stateless === true;
  if (
    (!stateless || record.socketPath !== undefined)
    && (typeof record.socketPath !== "string" || !isAbsolute(record.socketPath) || record.socketPath.includes("\0"))
  ) return null;
  if (!stateless && (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0)) return null;
  if (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0)) return null;
  return {
    name: record.name,
    shim: { command: shimRecord.command, args: [...shimRecord.args] as string[] },
    env: Object.fromEntries(envEntries.filter(([key]) => !PROTECTED_ENV.has(key))) as Record<string, string>,
    ...(record.pid !== undefined ? { pid: Number(record.pid) } : {}),
    ...(stateless ? { stateless: true } : {}),
  };
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function liveGateways(storeRoot = process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive")): LiveGateway[] {
  if (process.env.HIVE_GATEWAYS_DISABLE === "1") return [];
  let names: string[];
  try {
    names = readdirSync(join(storeRoot, "gateways"))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const record = parseGatewayRecord(readFileSync(join(storeRoot, "gateways", name), "utf8"));
      if (!record) return [];
      const live = record.stateless === true
        ? executable(record.shim.command)
        : record.pid !== undefined && processIsLive(record.pid);
      return live ? [record] : [];
    } catch {
      return [];
    }
  });
}
