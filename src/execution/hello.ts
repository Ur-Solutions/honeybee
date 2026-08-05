// protocol.hello negotiation (RFC §6, corpus negotiation fixtures). Pure:
// request in, response out. The connection gate that refuses methods before a
// compatible hello lives in rpcMethods.ts; this module only computes the
// negotiation result, byte-compatible with the golden negotiation fixtures.
import type { JsonValue } from "../comb/types.js";
import type { ExecutionContract, ExecutionValidator, JsonObject } from "./contract.js";
import { executionError } from "./errors.js";

export const SERVER_PRODUCT = "honeybee";
/** Mirrors package.json; negotiation fixtures pin this server version. */
export const SERVER_VERSION = "0.0.1";

export type HelloResult = {
  response: JsonObject;
  compatibility: "ready" | "incompatible" | "degraded";
  selectedFeatures: string[];
};

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Features this server actually implements (H1: the baseline profile only). */
export function supportedFeatures(contract: ExecutionContract): string[] {
  const profiles = (contract.profile.profiles ?? {}) as JsonObject;
  const localCore = (profiles["local-core-v1"] ?? {}) as JsonObject;
  return stringArray(localCore.features as JsonValue).length > 0
    ? stringArray(localCore.features as JsonValue)
    : ["local-core-v1"];
}

function protocolVersion(contract: ExecutionContract): string {
  const version = contract.profile.protocolVersion;
  return typeof version === "string" ? version : "0.1";
}

/**
 * True when the client's protocolRange names a compatible major. Accepted
 * forms: exact ("0.1"), wildcard minor ("0.x"), or any token list containing
 * one of those. Anything that names no parseable version fails closed.
 */
function rangeCompatible(range: string, serverVersion: string): boolean {
  const serverMajor = serverVersion.split(".")[0] ?? "";
  const tokens = range.match(/[0-9]+\.(?:[0-9]+|x|\*)/g) ?? [];
  return tokens.some((token) => token.split(".")[0] === serverMajor);
}

/**
 * Negotiate one hello. Throws SCHEMA_UNSUPPORTED on an invalid request shape;
 * an incompatible-but-well-formed request gets a well-formed `incompatible`
 * response (the caller's gate then refuses mutations).
 */
export function negotiateHello(
  request: JsonValue,
  contract: ExecutionContract,
  validator: ExecutionValidator,
  schemaDigest: string,
): HelloResult {
  const check = validator.validate("protocol-hello-request", request);
  if (!check.valid) {
    throw executionError("SCHEMA_UNSUPPORTED", `invalid protocol.hello request: ${check.errors.join("; ")}`);
  }
  const doc = request as JsonObject;
  const client = doc.client as JsonObject;
  const required = stringArray(doc.requiredFeatures as JsonValue);
  const optional = stringArray(doc.optionalFeatures as JsonValue);
  const supported = new Set(supportedFeatures(contract));
  const version = protocolVersion(contract);

  const missingRequired = required.filter((feature) => !supported.has(feature));
  const versionOk = rangeCompatible(String(client.protocolRange ?? ""), version);
  const incompatible = missingRequired.length > 0 || !versionOk;
  // A ready response selects every supported feature the client asked for; an
  // incompatible one selects nothing (nothing was agreed).
  const selected = incompatible ? [] : [...required, ...optional].filter((feature) => supported.has(feature));

  const response: JsonObject = {
    server: { product: SERVER_PRODUCT, version: SERVER_VERSION, protocolVersion: version },
    selectedFeatures: selected,
    missingRequiredFeatures: missingRequired,
    compatibility: incompatible ? "incompatible" : "ready",
    schemaDigest,
  };
  return { response, compatibility: incompatible ? "incompatible" : "ready", selectedFeatures: selected };
}
