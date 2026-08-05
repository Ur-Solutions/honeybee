// Loader and validators for the canonical execution protocol corpus at
// contracts/execution/v1 (Phase 0-1 slice C0). The corpus is the contract:
// language-neutral JSON Schemas, state machines, profiles, and golden
// fixtures. Apiary consumes this module through the package subpath
// `honeybee/execution/v1` instead of copying types, so both repositories can
// pin one contractVersion + schemaDigest pair.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { canonicalDigest } from "../comb/canonical.js";
import type { JsonValue } from "../comb/types.js";

export type JsonObject = { [key: string]: JsonValue };

export const EXECUTION_CONTRACT_SCHEMA_ID_BASE = "https://honeybee.dev/contracts/execution/v1/";

export type ExecutionFixture = {
  /** Fixture path relative to the fixtures/ directory. */
  path: string;
  description: string;
  /** Schema name (schema file basename without .schema.json). */
  schema: string;
  /** Whether the values must validate (true) or must be rejected (false). */
  valid: boolean;
  /** Protocol method this fixture exercises, for coverage accounting. */
  method?: string;
  /** Feature profile the fixture belongs to (defaults to local-core-v1). */
  profile?: string;
  /** Extra schema the envelope `body` of each value must also satisfy. */
  bodySchema?: string;
  values: JsonValue[];
};

export type TransitionFixture = {
  path: string;
  entity: string;
  allowed: Array<[string, string]>;
  rejected: Array<[string, string]>;
};

export type NegotiationFixture = {
  path: string;
  description: string;
  request: JsonValue;
  response: JsonValue;
};

export type ExecutionContract = {
  rootDir: string;
  profile: JsonObject;
  states: JsonObject;
  /** Schema name -> parsed schema document, sorted by name. */
  schemas: Map<string, JsonObject>;
  fixtures: ExecutionFixture[];
  transitions: TransitionFixture[];
  negotiations: NegotiationFixture[];
  /** Digest committed in digest.json. */
  committedDigest: string;
};

/** Absolute path of the canonical corpus directory inside this package. */
export function executionContractRoot(): string {
  return fileURLToPath(new URL("../../contracts/execution/v1/", import.meta.url));
}

function readJson(path: string): JsonValue {
  return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
}

function asObject(value: JsonValue, subject: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject}: expected a JSON object`);
  }
  return value as JsonObject;
}

function walkJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
}

function pairList(value: JsonValue, subject: string): Array<[string, string]> {
  if (!Array.isArray(value)) throw new Error(`${subject}: expected an array of [from, to] pairs`);
  return value.map((pair, index) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      throw new Error(`${subject}[${index}]: expected [from, to] string pair`);
    }
    return [pair[0], pair[1]];
  });
}

export function loadExecutionContract(rootDir: string = executionContractRoot()): ExecutionContract {
  const profile = asObject(readJson(join(rootDir, "profile.json")), "profile.json");
  const states = asObject(readJson(join(rootDir, "states.json")), "states.json");
  const digestDoc = asObject(readJson(join(rootDir, "digest.json")), "digest.json");
  const committedDigest = typeof digestDoc.schemaDigest === "string" ? digestDoc.schemaDigest : "";

  const schemas = new Map<string, JsonObject>();
  const schemasDir = join(rootDir, "schemas");
  for (const file of readdirSync(schemasDir).sort()) {
    if (!file.endsWith(".schema.json")) continue;
    const name = file.slice(0, -".schema.json".length);
    schemas.set(name, asObject(readJson(join(schemasDir, file)), `schemas/${file}`));
  }

  const fixtures: ExecutionFixture[] = [];
  const transitions: TransitionFixture[] = [];
  const negotiations: NegotiationFixture[] = [];
  const fixturesDir = join(rootDir, "fixtures");
  for (const file of walkJsonFiles(fixturesDir)) {
    const path = relative(fixturesDir, file);
    const doc = asObject(readJson(file), `fixtures/${path}`);
    if (typeof doc.entity === "string") {
      transitions.push({
        path,
        entity: doc.entity,
        allowed: pairList(doc.allowed ?? [], `fixtures/${path}#allowed`),
        rejected: pairList(doc.rejected ?? [], `fixtures/${path}#rejected`),
      });
      continue;
    }
    if (doc.request !== undefined && doc.response !== undefined) {
      negotiations.push({
        path,
        description: typeof doc.description === "string" ? doc.description : path,
        request: doc.request as JsonValue,
        response: doc.response as JsonValue,
      });
      continue;
    }
    if (typeof doc.schema !== "string" || typeof doc.valid !== "boolean") {
      throw new Error(`fixtures/${path}: expected schema/valid fields (or entity/request+response forms)`);
    }
    const values = doc.values !== undefined ? doc.values : doc.value !== undefined ? [doc.value] : undefined;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`fixtures/${path}: expected a non-empty value or values`);
    }
    fixtures.push({
      path,
      description: typeof doc.description === "string" ? doc.description : path,
      schema: doc.schema,
      valid: doc.valid,
      ...(typeof doc.method === "string" ? { method: doc.method } : {}),
      ...(typeof doc.profile === "string" ? { profile: doc.profile } : {}),
      ...(typeof doc.bodySchema === "string" ? { bodySchema: doc.bodySchema } : {}),
      values: values as JsonValue[],
    });
  }

  return { rootDir, profile, states, schemas, fixtures, transitions, negotiations, committedDigest };
}

/**
 * Deterministic contract digest: sha256 over the canonical JSON (sorted keys)
 * of { profile, states, schemas }. Fixtures are excluded so golden responses
 * may embed the digest itself. This is the `schemaDigest` that
 * protocol.hello reports and every durable record stores.
 */
export function computeSchemaDigest(contract: ExecutionContract): string {
  const schemas: JsonObject = {};
  for (const name of [...contract.schemas.keys()].sort()) {
    schemas[name] = contract.schemas.get(name)!;
  }
  return canonicalDigest({ profile: contract.profile, states: contract.states, schemas });
}

export type ValidationResult = { valid: boolean; errors: string[] };

export type ExecutionValidator = {
  /** Validate a value against a schema by name (e.g. "run-intent"). */
  validate(schemaName: string, value: unknown): ValidationResult;
  hasSchema(schemaName: string): boolean;
};

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "$"} ${error.message ?? "invalid"}`);
}

export function createExecutionValidator(contract: ExecutionContract): ExecutionValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const schema of contract.schemas.values()) ajv.addSchema(schema as object);
  const compiled = new Map<string, ValidateFunction>();
  const lookup = (schemaName: string): ValidateFunction | undefined => {
    const cached = compiled.get(schemaName);
    if (cached) return cached;
    const validator = ajv.getSchema(`${EXECUTION_CONTRACT_SCHEMA_ID_BASE}${schemaName}.schema.json`);
    if (validator) compiled.set(schemaName, validator);
    return validator ?? undefined;
  };
  return {
    hasSchema: (schemaName) => lookup(schemaName) !== undefined,
    validate(schemaName, value) {
      const validator = lookup(schemaName);
      if (!validator) throw new Error(`unknown execution contract schema: ${schemaName}`);
      const valid = validator(value) === true;
      return { valid, errors: valid ? [] : formatErrors(validator.errors) };
    },
  };
}

export type StateMachine = {
  profile: string;
  initial: string;
  states: string[];
  terminal: string[];
  transitions: Array<[string, string]>;
};

export function stateMachine(contract: ExecutionContract, entity: string): StateMachine {
  const entities = asObject(contract.states.entities ?? {}, "states.json#entities");
  const machine = entities[entity];
  if (machine === undefined) throw new Error(`unknown state machine entity: ${entity}`);
  const doc = asObject(machine, `states.json#entities.${entity}`);
  return {
    profile: String(doc.profile ?? "local-core-v1"),
    initial: String(doc.initial ?? ""),
    states: (doc.states as string[] | undefined) ?? [],
    terminal: (doc.terminal as string[] | undefined) ?? [],
    transitions: pairList(doc.transitions ?? [], `states.json#entities.${entity}.transitions`),
  };
}

/** True when states.json allows the (from -> to) transition for the entity. */
export function isTransitionAllowed(contract: ExecutionContract, entity: string, from: string, to: string): boolean {
  return stateMachine(contract, entity).transitions.some(([a, b]) => a === from && b === to);
}
