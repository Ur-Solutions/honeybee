import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { storeRoot } from "../fsx.js";

export const BROKER_SELF_OPS = [
  "broker:buz-send",
  "broker:buz-inbox",
  "broker:state",
  "broker:seal",
] as const;

export const BROKER_OPS = [...BROKER_SELF_OPS, "broker:spawn"] as const;

export type BrokerOp = (typeof BROKER_OPS)[number];

/**
 * Optional per-caller grants from `<store>/broker-acl.json`.
 *
 * The top-level key is the calling bee name. Each operation maps to the bee
 * names that caller may act AS (or `"*"`). `broker:spawn` is the exception:
 * its subjects are absolute cwd prefixes and it has no self default. Recipient
 * bees are deliberately not authorization subjects for buz-send: messaging
 * another bee is the normal operation, while forging another sender is the
 * cross-bee action.
 *
 * Example:
 * {
 *   "CL.coordinator": {
 *     "broker:state": ["CL.worker"],
 *     "broker:seal": ["CL.worker"],
 *     "broker:spawn": ["/Users/me/Projects/scratch"]
 *   }
 * }
 */
export type BrokerAcl = Record<string, Partial<Record<BrokerOp, string[]>>>;

export type BrokerPolicyRequest = {
  op: string;
  callerBee: string;
  subjectBee: string;
};

export type BrokerSpawnPolicyRequest = {
  callerBee: string;
  cwd: string;
};

export type BrokerPolicyDecision = {
  allowed: boolean;
  reason: string;
  source: "default-self" | "acl" | "deny";
};

const BROKER_OP_SET = new Set<string>(BROKER_OPS);

export function brokerAclPath(): string {
  return join(storeRoot(), "broker-acl.json");
}

export function decideBrokerPolicy(
  request: BrokerPolicyRequest,
  acl: BrokerAcl = {},
): BrokerPolicyDecision {
  if (!BROKER_OP_SET.has(request.op)) {
    return {
      allowed: false,
      reason: `unknown broker operation: ${request.op}`,
      source: "deny",
    };
  }
  if (!request.callerBee) {
    return { allowed: false, reason: "calling bee identity is required", source: "deny" };
  }
  if (!request.subjectBee) {
    return { allowed: false, reason: "subject bee identity is required", source: "deny" };
  }
  if (request.op === "broker:spawn") {
    return {
      allowed: false,
      reason: "broker:spawn requires cwd-prefix authorization",
      source: "deny",
    };
  }
  if (request.callerBee === request.subjectBee) {
    return { allowed: true, reason: "self operation", source: "default-self" };
  }

  const grants = acl[request.callerBee]?.[request.op as BrokerOp] ?? [];
  if (grants.includes(request.subjectBee) || grants.includes("*")) {
    return { allowed: true, reason: "explicit broker ACL grant", source: "acl" };
  }

  return {
    allowed: false,
    reason: `${request.op} may only act as ${request.callerBee}; ${request.subjectBee} is not granted`,
    source: "deny",
  };
}

function isInsidePathPrefix(cwd: string, prefix: string): boolean {
  const suffix = relative(prefix, cwd);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Filesystem spawns have no self grant: an absolute cwd prefix is mandatory. */
export function decideBrokerSpawnPolicy(
  request: BrokerSpawnPolicyRequest,
  acl: BrokerAcl = {},
): BrokerPolicyDecision {
  if (!request.callerBee) {
    return { allowed: false, reason: "calling bee identity is required", source: "deny" };
  }
  if (!request.cwd || !isAbsolute(request.cwd)) {
    return { allowed: false, reason: "broker:spawn cwd must be absolute", source: "deny" };
  }
  const prefixes = acl[request.callerBee]?.["broker:spawn"] ?? [];
  if (prefixes.some((prefix) => !isAbsolute(prefix))) {
    return { allowed: false, reason: "broker:spawn grants must be absolute cwd prefixes", source: "deny" };
  }
  if (prefixes.some((prefix) => isInsidePathPrefix(request.cwd, prefix))) {
    return { allowed: true, reason: "explicit broker ACL cwd-prefix grant", source: "acl" };
  }
  return {
    allowed: false,
    reason: `broker:spawn cwd ${request.cwd} is outside the allowed prefixes for ${request.callerBee}`,
    source: "deny",
  };
}

export async function loadBrokerAcl(path = brokerAclPath()): Promise<BrokerAcl> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid broker ACL JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid broker ACL at ${path}: expected an object keyed by bee name`);
  }

  const acl: BrokerAcl = {};
  for (const [callerBee, rawGrants] of Object.entries(parsed as Record<string, unknown>)) {
    if (!rawGrants || typeof rawGrants !== "object" || Array.isArray(rawGrants)) {
      throw new Error(`invalid broker ACL at ${path}: ${callerBee} grants must be an object`);
    }
    const grants: Partial<Record<BrokerOp, string[]>> = {};
    for (const [op, rawSubjects] of Object.entries(rawGrants as Record<string, unknown>)) {
      if (!BROKER_OP_SET.has(op)) {
        throw new Error(`invalid broker ACL at ${path}: unknown operation ${op}`);
      }
      if (!Array.isArray(rawSubjects) || rawSubjects.some((subject) => typeof subject !== "string" || subject.length === 0)) {
        throw new Error(`invalid broker ACL at ${path}: ${callerBee}.${op} must be an array of non-empty strings`);
      }
      if (op === "broker:spawn" && rawSubjects.some((subject) => !isAbsolute(subject as string))) {
        throw new Error(`invalid broker ACL at ${path}: ${callerBee}.${op} must contain absolute cwd prefixes`);
      }
      grants[op as BrokerOp] = [...rawSubjects] as string[];
    }
    acl[callerBee] = grants;
  }
  return acl;
}
