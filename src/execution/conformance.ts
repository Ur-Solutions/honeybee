// Self-validation for the execution contract corpus (slice C0 exit gate):
// schemas compile, the digest is deterministic and committed, golden fixtures
// pass, invalid fixtures fail, transition tables mirror states.json, hello
// negotiation fixtures are internally consistent, coverage is complete, and
// no valid fixture carries machine paths or secret-looking bytes. Apiary runs
// this same corpus through runConformance for the C0/C1 digest parity gate.
import { canonicalDigest } from "../comb/canonical.js";
import type { JsonValue } from "../comb/types.js";
import {
  computeSchemaDigest,
  createExecutionValidator,
  loadExecutionContract,
  stateMachine,
  type ExecutionContract,
  type JsonObject,
} from "./contract.js";

export type ConformanceIssue = { check: string; subject: string; detail: string };

export type ConformanceReport = {
  ok: boolean;
  issues: ConformanceIssue[];
  schemaDigest: string;
  counts: { schemas: number; fixtures: number; values: number; transitions: number; negotiations: number };
};

// Machine-path and secret shapes that must never appear in valid golden
// fixtures (RFC: examples contain no machine paths or secret bytes).
const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "posix-machine-path", pattern: /\/(?:Users|home|private|var\/folders|tmp|opt\/homebrew)\// },
  { name: "windows-machine-path", pattern: /[A-Za-z]:\\\\/ },
  { name: "file-url", pattern: /file:\/\// },
  { name: "pem-block", pattern: /-----BEGIN/ },
  { name: "github-token", pattern: /\bghp_[A-Za-z0-9]{8,}/ },
  { name: "api-key", pattern: /\bsk-[A-Za-z0-9-]{8,}/ },
  { name: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", pattern: /\bxox[bpors]-/ },
];

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function profileSection(contract: ExecutionContract, name: string): JsonObject | undefined {
  return asObject(asObject(contract.profile.profiles)?.[name]);
}

export function runConformance(contract: ExecutionContract = loadExecutionContract()): ConformanceReport {
  const issues: ConformanceIssue[] = [];
  const flag = (check: string, subject: string, detail: string) => issues.push({ check, subject, detail });
  const validator = createExecutionValidator(contract);

  // 1. Schema hygiene: filename-matching $id, a title, and compilability.
  for (const [name, schema] of contract.schemas) {
    const expectedId = `https://honeybee.dev/contracts/execution/v1/${name}.schema.json`;
    if (schema.$id !== expectedId) flag("schema-id", name, `expected $id ${expectedId}`);
    if (typeof schema.title !== "string" || schema.title.length === 0) flag("schema-title", name, "missing title");
    try {
      validator.validate(name, {});
    } catch (error) {
      flag("schema-compile", name, String(error));
    }
  }

  // 2. Deterministic digest, matching digest.json.
  const digestA = computeSchemaDigest(contract);
  const digestB = computeSchemaDigest(contract);
  if (digestA !== digestB) flag("digest-deterministic", "digest.json", `${digestA} != ${digestB}`);
  if (contract.committedDigest !== digestA) {
    flag("digest-committed", "digest.json", `committed ${contract.committedDigest || "(missing)"} != computed ${digestA}; run: npm run execution:digest`);
  }

  // 3. Profile sanity: local-core-v1 on, runtime-target-v1 reserved and off,
  //    every referenced schema present.
  const localCore = profileSection(contract, "local-core-v1");
  const runtimeTarget = profileSection(contract, "runtime-target-v1");
  if (!localCore || localCore.defaultEnabled !== true) flag("profile", "local-core-v1", "must exist with defaultEnabled true");
  if (!runtimeTarget || runtimeTarget.defaultEnabled !== false || runtimeTarget.schemasOnly !== true) {
    flag("profile", "runtime-target-v1", "must exist with defaultEnabled false and schemasOnly true");
  }
  const methods = (Array.isArray(localCore?.methods) ? localCore!.methods : []) as JsonValue[];
  for (const entry of methods) {
    const method = asObject(entry);
    if (!method || typeof method.method !== "string") {
      flag("profile-method", "local-core-v1", "method entries need a method name");
      continue;
    }
    for (const key of ["requestSchema", "responseSchema", "bodySchema"] as const) {
      const schemaName = method[key];
      if (schemaName === undefined) continue;
      if (typeof schemaName !== "string" || !contract.schemas.has(schemaName)) {
        flag("profile-method", method.method, `${key} references unknown schema ${String(schemaName)}`);
      }
    }
  }
  for (const schemaName of stringArray(runtimeTarget?.schemas)) {
    const schema = contract.schemas.get(schemaName);
    if (!schema) flag("profile-schema", "runtime-target-v1", `reserved schema ${schemaName} is missing`);
    else if (schema["x-reserved"] !== "runtime-target-v1") {
      flag("profile-schema", schemaName, "reserved runtime-target schema must be marked x-reserved");
    }
  }

  // 4. Fixture validation. Valid fixtures must pass (and reserved schemas can
  //    have none); invalid fixtures must fail. Envelope fixtures must carry
  //    requestDigest = canonicalDigest(body) and validate body against
  //    bodySchema when declared.
  let valueCount = 0;
  for (const fixture of contract.fixtures) {
    if (!contract.schemas.has(fixture.schema)) {
      flag("fixture-schema", fixture.path, `unknown schema ${fixture.schema}`);
      continue;
    }
    if (fixture.valid && contract.schemas.get(fixture.schema)?.["x-reserved"] !== undefined) {
      flag("fixture-reserved", fixture.path, `schema ${fixture.schema} is reserved; it cannot have valid fixtures yet`);
      continue;
    }
    fixture.values.forEach((value, index) => {
      valueCount += 1;
      const subject = fixture.values.length === 1 ? fixture.path : `${fixture.path}[${index}]`;
      const result = validator.validate(fixture.schema, value);
      if (fixture.valid && !result.valid) {
        flag("fixture-valid", subject, result.errors.join("; ") || "did not validate");
        return;
      }
      if (!fixture.valid && result.valid) {
        flag("fixture-invalid", subject, "expected validation to fail, but it passed");
        return;
      }
      if (!fixture.valid) return;
      const object = asObject(value as JsonValue);
      if (fixture.schema === "execution-request-envelope" && object) {
        const digest = canonicalDigest(object.body as JsonValue);
        if (object.requestDigest !== digest) {
          flag("fixture-request-digest", subject, `requestDigest must equal canonical digest of body (${digest}); run: npm run execution:digest`);
        }
      }
      if (fixture.bodySchema && object) {
        const body = validator.validate(fixture.bodySchema, object.body);
        if (!body.valid) flag("fixture-body", subject, body.errors.join("; "));
      }
      const serialized = JSON.stringify(value);
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(serialized)) flag("fixture-hygiene", subject, `matches forbidden pattern ${name}`);
      }
    });
  }

  // 5. Transition fixtures exactly mirror states.json.
  for (const transition of contract.transitions) {
    let machine;
    try {
      machine = stateMachine(contract, transition.entity);
    } catch (error) {
      flag("transition-entity", transition.path, String(error));
      continue;
    }
    const canonical = new Set(machine.transitions.map(([from, to]) => `${from}->${to}`));
    const fixtureAllowed = new Set(transition.allowed.map(([from, to]) => `${from}->${to}`));
    for (const pair of canonical) {
      if (!fixtureAllowed.has(pair)) flag("transition-allowed", transition.path, `missing canonical transition ${pair}`);
    }
    for (const pair of fixtureAllowed) {
      if (!canonical.has(pair)) flag("transition-allowed", transition.path, `${pair} is not a canonical transition`);
    }
    const known = new Set(machine.states);
    for (const [from, to] of transition.rejected) {
      if (canonical.has(`${from}->${to}`)) flag("transition-rejected", transition.path, `${from}->${to} is canonically allowed`);
      if (!known.has(from) || !known.has(to)) flag("transition-rejected", transition.path, `${from}->${to} names unknown states`);
    }
    for (const state of machine.terminal) {
      if (machine.transitions.some(([from]) => from === state)) {
        flag("transition-terminal", transition.entity, `terminal state ${state} has outgoing transitions`);
      }
    }
  }

  // 6. Negotiation fixtures: schema-valid, internally consistent, and pinned
  //    to the current schema digest (RFC acceptance test 1).
  for (const negotiation of contract.negotiations) {
    const request = validator.validate("protocol-hello-request", negotiation.request);
    if (!request.valid) flag("negotiation-request", negotiation.path, request.errors.join("; "));
    const response = validator.validate("protocol-hello-response", negotiation.response);
    if (!response.valid) flag("negotiation-response", negotiation.path, response.errors.join("; "));
    if (!request.valid || !response.valid) continue;
    const requestDoc = asObject(negotiation.request)!;
    const responseDoc = asObject(negotiation.response)!;
    const required = stringArray(requestDoc.requiredFeatures);
    const optional = stringArray(requestDoc.optionalFeatures);
    const selected = stringArray(responseDoc.selectedFeatures);
    const missing = stringArray(responseDoc.missingRequiredFeatures);
    const offered = new Set([...required, ...optional]);
    if ((responseDoc.compatibility === "incompatible") !== missing.length > 0) {
      flag("negotiation-consistency", negotiation.path, "compatibility must be incompatible exactly when required features are missing");
    }
    for (const feature of missing) {
      if (!required.includes(feature)) flag("negotiation-consistency", negotiation.path, `missing feature ${feature} was not required`);
    }
    for (const feature of selected) {
      if (!offered.has(feature)) flag("negotiation-consistency", negotiation.path, `selected feature ${feature} was not requested`);
    }
    if (responseDoc.compatibility === "ready") {
      for (const feature of required) {
        if (!selected.includes(feature)) flag("negotiation-consistency", negotiation.path, `ready response must select required feature ${feature}`);
      }
    }
    if (responseDoc.schemaDigest !== digestA) {
      flag("negotiation-digest", negotiation.path, `schemaDigest must equal the corpus digest ${digestA}; run: npm run execution:digest`);
    }
  }

  // 7. Coverage: every local-core-v1 method, error code, event family, and
  //    state-machine entity has fixture coverage.
  const coveredMethods = new Set(contract.fixtures.filter((f) => f.valid && f.method).map((f) => f.method!));
  for (const entry of methods) {
    const method = asObject(entry)?.method;
    if (typeof method === "string" && !coveredMethods.has(method)) {
      flag("coverage-method", method, "no golden fixture exercises this method");
    }
  }
  const errorCodes = Object.keys(asObject(contract.profile.errorCodes) ?? {});
  const coveredCodes = new Set<string>();
  for (const fixture of contract.fixtures) {
    if (!fixture.valid || fixture.schema !== "error") continue;
    for (const value of fixture.values) {
      const code = asObject(value)?.code;
      if (typeof code === "string") coveredCodes.add(code);
    }
  }
  for (const code of errorCodes) {
    if (!coveredCodes.has(code)) flag("coverage-error", code, "no golden error fixture");
  }
  const registeredEvents = new Set([
    ...stringArray(localCore?.eventTypes),
    ...stringArray(localCore?.optionalEventTypes),
    ...stringArray(runtimeTarget?.eventTypes),
  ]);
  const seenEvents = new Set<string>();
  for (const fixture of contract.fixtures) {
    if (!fixture.valid || (fixture.schema !== "run-events-page" && fixture.schema !== "run-event")) continue;
    for (const value of fixture.values) {
      const events = fixture.schema === "run-event" ? [value] : (asObject(value)?.events as JsonValue[] | undefined) ?? [];
      for (const event of events) {
        const type = asObject(event)?.type;
        if (typeof type !== "string") continue;
        seenEvents.add(type);
        if (!registeredEvents.has(type)) flag("event-registry", fixture.path, `event type ${type} is not registered in profile.json`);
      }
    }
  }
  for (const type of stringArray(localCore?.eventTypes)) {
    if (!seenEvents.has(type)) flag("coverage-event", type, "no golden event fixture emits this control event");
  }
  const entities = Object.keys(asObject(contract.states.entities) ?? {});
  const coveredEntities = new Set(contract.transitions.map((t) => t.entity));
  for (const entity of entities) {
    if (!coveredEntities.has(entity)) flag("coverage-transitions", entity, "no transition fixture mirrors this state machine");
  }

  return {
    ok: issues.length === 0,
    issues,
    schemaDigest: digestA,
    counts: {
      schemas: contract.schemas.size,
      fixtures: contract.fixtures.length,
      values: valueCount,
      transitions: contract.transitions.length,
      negotiations: contract.negotiations.length,
    },
  };
}
