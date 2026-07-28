import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { validFlowName } from "../flow/index.js";
import { assertCanonicalData, canonicalDigest, canonicalJson } from "./canonical.js";
import {
  COMB_DEFINITION_FORMAT,
  type ActivationRecord,
  type CombNode,
  type CombSpec,
  type DataContract,
  type JsonObject,
  type JsonPointer,
  type JsonValue,
  type PredicateSpec,
  type ValueSource,
} from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validatorCache = new Map<string, ValidateFunction>();
const TEMPLATE_RE = /\{\{([^{}]+)\}\}/g;

export type CombLintResult = {
  valid: true;
  definitionDigest: string;
  normalized: CombSpec;
  warnings: string[];
};

export function normalizeComb(value: unknown, expectedName?: string): CombSpec {
  assertCanonicalData(value);
  const cloned = JSON.parse(canonicalJson(value)) as unknown;
  const root = objectAt(cloned, "$");
  const formatVersion = root.formatVersion ?? COMB_DEFINITION_FORMAT;
  if (formatVersion !== COMB_DEFINITION_FORMAT) {
    fail("$.formatVersion", `must equal ${COMB_DEFINITION_FORMAT}`);
  }
  const name = stringAt(root.name, "$.name");
  if (!validFlowName(name)) fail("$.name", "must use the flow name grammar");
  if (expectedName !== undefined && name !== expectedName) {
    fail("$.name", `must equal registry name ${JSON.stringify(expectedName)}`);
  }
  const input = normalizeContract(root.input, "$.input");
  const nodesRaw = arrayAt(root.nodes, "$.nodes");
  if (nodesRaw.length === 0) fail("$.nodes", "must contain at least one node");
  const nodes = nodesRaw.map((entry, index) => normalizeNode(entry, `$.nodes[${index}]`));
  const edges = arrayAt(root.edges, "$.edges").map((entry, index) => {
    const edge = objectAt(entry, `$.edges[${index}]`);
    const kind = enumAt(edge.kind, `$.edges[${index}].kind`, ["forward", "retry", "waiting"] as const);
    const on = enumAt(edge.on, `$.edges[${index}].on`, ["done", "failed", "waiting"] as const);
    return {
      id: stringAt(edge.id, `$.edges[${index}].id`),
      from: stringAt(edge.from, `$.edges[${index}].from`),
      to: stringAt(edge.to, `$.edges[${index}].to`),
      kind,
      on,
      ...(edge.when !== undefined ? { when: normalizePredicate(edge.when, `$.edges[${index}].when`) } : {}),
    };
  });

  const normalized: CombSpec = {
    formatVersion: COMB_DEFINITION_FORMAT,
    name,
    input,
    nodes,
    edges,
  };
  if (typeof root.description === "string") normalized.description = root.description;
  if (root.annotations !== undefined) normalized.annotations = root.annotations as CombSpec["annotations"];
  if (root.output !== undefined) {
    const output = objectAt(root.output, "$.output");
    normalized.output = {
      contract: normalizeContract(output.contract, "$.output.contract"),
      value: normalizeValueSource(output.value, "$.output.value"),
    };
  }
  if (root.claim !== undefined) normalized.claim = root.claim as CombSpec["claim"];
  if (root.subscriptions !== undefined) normalized.subscriptions = root.subscriptions as CombSpec["subscriptions"];

  validateNormalizedComb(normalized);
  return normalized;
}

export function lintComb(value: unknown, expectedName?: string): CombLintResult {
  const normalized = normalizeComb(value, expectedName);
  const warnings: string[] = [];
  if (normalized.claim && normalized.claim.inputPointer !== "" && /^\/[^/]+$/.test(normalized.claim.inputPointer)) {
    warnings.push("claim inputPointer selects a bare scalar; prefer a repository-qualified product identity");
  }
  return {
    valid: true,
    definitionDigest: canonicalDigest(normalized as unknown as JsonValue),
    normalized,
    warnings,
  };
}

export function validateNormalizedComb(spec: CombSpec): void {
  if (spec.annotations?.migrationTodos?.length) {
    fail("$.annotations.migrationTodos", "must be empty before lint/define");
  }
  const nodeById = new Map<string, CombNode>();
  for (const [index, node] of spec.nodes.entries()) {
    if (!validFlowName(node.id)) fail(`$.nodes[${index}].id`, "must use the node ID grammar");
    if (nodeById.has(node.id)) fail(`$.nodes[${index}].id`, `duplicate node ID ${node.id}`);
    nodeById.set(node.id, node);
    if (node.binding === "guided" && (node.executor !== "agent" || !node.agent.expectations?.length)) {
      fail(`$.nodes[${index}]`, "guided nodes must be agents with at least one enumerable expectation");
    }
    if (node.executor === "human" && node.binding !== "strict") {
      fail(`$.nodes[${index}].binding`, "human nodes must be strict");
    }
    if (node.executor === "human" && node.output !== undefined) {
      fail(`$.nodes[${index}].output`, "human nodes use the fixed verdict/comment/destination contract and may not override it");
    }
    if (node.executor === "engine" && node.binding !== "strict") {
      fail(`$.nodes[${index}].binding`, "engine nodes must be strict");
    }
    if (node.executor === "engine" && node.engine.kind === "predicate") {
      validatePredicateReference(node.engine.predicate, nodeById, spec.nodes, `$.nodes[${index}].engine.predicate`);
    }
  }

  const edgeIds = new Set<string>();
  const incomingForward = new Map<string, number>();
  for (const [index, edge] of spec.edges.entries()) {
    if (!validFlowName(edge.id)) fail(`$.edges[${index}].id`, "must use the edge ID grammar");
    if (edgeIds.has(edge.id)) fail(`$.edges[${index}].id`, `duplicate edge ID ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeById.has(edge.from)) fail(`$.edges[${index}].from`, `unknown node ${edge.from}`);
    if (!nodeById.has(edge.to)) fail(`$.edges[${index}].to`, `unknown node ${edge.to}`);
    if (edge.kind === "waiting") {
      if (edge.on !== "waiting" || edge.when?.kind !== "clock") {
        fail(`$.edges[${index}]`, 'waiting edges require on="waiting" and a clock predicate');
      }
    } else if (edge.on === "waiting") {
      fail(`$.edges[${index}].on`, 'on="waiting" is legal only for waiting edges');
    }
    if (edge.kind === "retry" && edge.on !== "done" && edge.on !== "failed") {
      fail(`$.edges[${index}].on`, "retry edges must route done or failed");
    }
    if (edge.kind === "forward") incomingForward.set(edge.to, (incomingForward.get(edge.to) ?? 0) + 1);
    if (edge.when) validatePredicateReference(edge.when, nodeById, spec.nodes, `$.edges[${index}].when`);
  }

  for (const [index, node] of spec.nodes.entries()) {
    const incoming = incomingForward.get(node.id) ?? 0;
    if (incoming > 1 && !node.join) fail(`$.nodes[${index}].join`, "is required for multiple incoming forward edges");
    const join = node.join ?? { mode: "all" as const, tolerateFailures: 0 };
    if (join.tolerateFailures !== undefined && (!Number.isSafeInteger(join.tolerateFailures) || join.tolerateFailures < 0)) {
      fail(`$.nodes[${index}].join.tolerateFailures`, "must be a non-negative integer");
    }
    if (join.mode === "quorum") {
      if (!Number.isSafeInteger(join.quorum) || (join.quorum ?? 0) < 1 || (join.quorum ?? 0) > incoming) {
        fail(`$.nodes[${index}].join.quorum`, `must be between 1 and ${incoming}`);
      }
    } else if (join.quorum !== undefined) {
      fail(`$.nodes[${index}].join.quorum`, 'is legal only when mode="quorum"');
    }
    node.join = { ...join, tolerateFailures: join.tolerateFailures ?? 0 };
  }

  assertForwardDag(spec);
  validateValueReferences(spec);
}

function normalizeNode(value: unknown, path: string): CombNode {
  const node = objectAt(value, path);
  const id = stringAt(node.id, `${path}.id`);
  const binding = enumAt(node.binding, `${path}.binding`, ["strict", "guided", "open"] as const);
  const executor = enumAt(node.executor, `${path}.executor`, ["agent", "human", "engine"] as const);
  const base = {
    id,
    binding,
    ...(typeof node.label === "string" ? { label: node.label } : {}),
    ...(node.subject !== undefined ? { subject: normalizeSubject(node.subject, `${path}.subject`) } : {}),
    ...(node.output !== undefined ? { output: normalizeContract(node.output, `${path}.output`) } : {}),
    ...(node.join !== undefined ? { join: normalizeJoin(node.join, `${path}.join`) } : {}),
    ...(node.checkout !== undefined ? { checkout: normalizeCheckout(node.checkout, `${path}.checkout`) } : {}),
  };
  if (executor === "agent") {
    const agent = objectAt(node.agent, `${path}.agent`);
    const capacity = objectAt(agent.capacity, `${path}.agent.capacity`);
    const capacityKind = enumAt(capacity.kind, `${path}.agent.capacity.kind`, ["spawn", "flight"] as const);
    return {
      ...base,
      executor,
      agent: {
        capacity:
          capacityKind === "spawn"
            ? {
                kind: "spawn",
                bee: stringAt(capacity.bee, `${path}.agent.capacity.bee`),
                ...(typeof capacity.account === "string" ? { account: capacity.account } : {}),
                ...(typeof capacity.model === "string" ? { model: capacity.model } : {}),
                ...(capacity.substrate !== undefined
                  ? { substrate: enumAt(capacity.substrate, `${path}.agent.capacity.substrate`, ["hsr", "local-tmux"] as const) }
                  : {}),
              }
            : {
                kind: "flight",
                flightId: stringAt(capacity.flightId, `${path}.agent.capacity.flightId`),
                ...(typeof capacity.mixKey === "string" ? { mixKey: capacity.mixKey } : {}),
              },
        brief: stringAt(agent.brief, `${path}.agent.brief`),
        ...(agent.expectations !== undefined ? { expectations: normalizeExpectations(agent.expectations, `${path}.agent.expectations`) } : {}),
      },
    };
  }
  if (executor === "human") {
    const human = objectAt(node.human, `${path}.human`);
    const destination = objectAt(human.feedbackDestination, `${path}.human.feedbackDestination`);
    const destinationType = enumAt(destination.type, `${path}.human.feedbackDestination.type`, ["bee", "new-agent", "pr-comment"] as const);
    return {
      ...base,
      executor,
      human: {
        title: stringAt(human.title, `${path}.human.title`),
        packetKind: enumAt(human.packetKind, `${path}.human.packetKind`, ["web", "desktop", "cli", "code"] as const),
        ...(typeof human.summary === "string" ? { summary: human.summary } : {}),
        ...(human.checklist !== undefined ? { checklist: human.checklist as Array<{ text: string; done: boolean }> } : {}),
        feedbackDestination: destinationType === "bee"
          ? { type: "bee", fromNodeId: stringAt(destination.fromNodeId, `${path}.human.feedbackDestination.fromNodeId`) }
          : { type: destinationType },
      },
    };
  }
  const engine = objectAt(node.engine, `${path}.engine`);
  const kind = enumAt(engine.kind, `${path}.engine.kind`, ["predicate", "action", "child-run"] as const);
  if (kind === "predicate") {
    return { ...base, executor, engine: { kind, predicate: normalizePredicate(engine.predicate, `${path}.engine.predicate`) } };
  }
  if (kind === "action") {
    return {
      ...base,
      executor,
      engine: {
        kind,
        intent: enumAt(engine.intent, `${path}.engine.intent`, ["land", "run"] as const),
        ...(engine.input !== undefined ? { input: engine.input as Record<string, ValueSource> } : {}),
      },
    };
  }
  return { ...base, executor, engine: engine as unknown as Extract<CombNode, { executor: "engine" }>["engine"] };
}

function normalizeContract(value: unknown, path: string): DataContract {
  const contract = objectAt(value, path);
  const kind = enumAt(contract.kind, `${path}.kind`, ["informal", "json-schema"] as const);
  if (kind === "informal") {
    return { kind, description: stringAt(contract.description, `${path}.description`) };
  }
  const schema = objectAt(contract.schema, `${path}.schema`) as JsonObject;
  compileSchema(schema, path);
  return { kind, schema };
}

function normalizeSubject(value: unknown, path: string) {
  const subject = objectAt(value, path);
  return {
    kind: stringAt(subject.kind, `${path}.kind`),
    key: normalizeValueSource(subject.key, `${path}.key`),
    revision: normalizeValueSource(subject.revision, `${path}.revision`),
  };
}

function normalizeJoin(value: unknown, path: string) {
  const join = objectAt(value, path);
  return {
    mode: enumAt(join.mode, `${path}.mode`, ["all", "any", "quorum"] as const),
    ...(join.quorum !== undefined ? { quorum: numberAt(join.quorum, `${path}.quorum`) } : {}),
    ...(join.tolerateFailures !== undefined ? { tolerateFailures: numberAt(join.tolerateFailures, `${path}.tolerateFailures`) } : {}),
  };
}

function normalizePredicate(value: unknown, path: string): PredicateSpec {
  const predicate = objectAt(value, path);
  const kind = enumAt(predicate.kind, `${path}.kind`, ["seal-present", "verdict", "ci-status", "output-equals", "clock"] as const);
  if (kind === "seal-present") {
    let statuses: Extract<PredicateSpec, { kind: "seal-present" }>["statuses"];
    if (predicate.statuses !== undefined) {
      statuses = arrayAt(predicate.statuses, `${path}.statuses`).map((status, index) =>
        enumAt(status, `${path}.statuses[${index}]`, ["done", "blocked", "needs_input", "failed"] as const),
      );
      if (statuses.length === 0) fail(`${path}.statuses`, "must not be empty");
    }
    return {
      kind,
      nodeId: stringAt(predicate.nodeId, `${path}.nodeId`),
      ...(statuses ? { statuses } : {}),
      ...(typeof predicate.sealType === "string" ? { sealType: predicate.sealType } : {}),
    };
  }
  if (kind === "verdict") {
    return { kind, nodeId: stringAt(predicate.nodeId, `${path}.nodeId`), equals: enumAt(predicate.equals, `${path}.equals`, ["approve", "request_changes"] as const) };
  }
  if (kind === "ci-status") {
    return {
      kind,
      equals: enumAt(predicate.equals, `${path}.equals`, ["success", "failure", "pending", "error"] as const),
      ...(typeof predicate.check === "string" ? { check: predicate.check } : {}),
    };
  }
  if (kind === "output-equals") {
    assertCanonicalData(predicate.equals, `${path}.equals`);
    return {
      kind,
      nodeId: stringAt(predicate.nodeId, `${path}.nodeId`),
      path: pointerAt(predicate.path, `${path}.path`),
      equals: predicate.equals,
    };
  }
  const afterMs = numberAt(predicate.afterMs, `${path}.afterMs`);
  if (!Number.isSafeInteger(afterMs) || afterMs < 0) fail(`${path}.afterMs`, "must be a non-negative integer");
  return { kind, afterMs, from: enumAt(predicate.from, `${path}.from`, ["activation-start", "blocking-since"] as const) };
}

function normalizeCheckout(value: unknown, path: string) {
  const checkout = objectAt(value, path);
  return {
    pool: stringAt(checkout.pool, `${path}.pool`),
    mode: enumAt(checkout.mode, `${path}.mode`, ["exclusive", "shared"] as const),
  };
}

function normalizeExpectations(value: unknown, path: string) {
  return arrayAt(value, path).map((entry, index) => {
    const expectation = objectAt(entry, `${path}[${index}]`);
    const evidence = objectAt(expectation.evidence, `${path}[${index}].evidence`);
    const kind = enumAt(evidence.kind, `${path}[${index}].evidence.kind`, ["agent-report", "seal-test", "seal-artifact", "seal-file"] as const);
    return {
      id: stringAt(expectation.id, `${path}[${index}].id`),
      description: stringAt(expectation.description, `${path}[${index}].description`),
      evidence:
        kind === "agent-report"
          ? { kind }
          : kind === "seal-test"
            ? { kind, ...(typeof evidence.commandIncludes === "string" ? { commandIncludes: evidence.commandIncludes } : {}) }
            : kind === "seal-artifact"
              ? {
                  kind,
                  artifactKind: enumAt(evidence.artifactKind, `${path}[${index}].evidence.artifactKind`, ["branch", "diff", "url", "fixture"] as const),
                }
              : { kind, glob: stringAt(evidence.glob, `${path}[${index}].evidence.glob`) },
    };
  });
}

export function normalizeValueSource(value: unknown, path = "$"): ValueSource {
  const source = objectAt(value, path);
  const kind = enumAt(source.source, `${path}.source`, ["literal", "run-input", "item", "node-output"] as const);
  if (kind === "literal") {
    assertCanonicalData(source.value, `${path}.value`);
    return { source: kind, value: source.value };
  }
  if (kind === "run-input") return { source: kind, pointer: pointerAt(source.pointer, `${path}.pointer`) };
  if (kind === "item") {
    return { source: kind, ...(source.pointer !== undefined ? { pointer: pointerAt(source.pointer, `${path}.pointer`) } : {}) };
  }
  const item = source.item;
  if (item !== "same" && item !== "aggregate") {
    const itemObject = objectAt(item, `${path}.item`);
    const index = numberAt(itemObject.index, `${path}.item.index`);
    if (!Number.isSafeInteger(index) || index < 0) fail(`${path}.item.index`, "must be a non-negative integer");
  }
  return {
    source: kind,
    nodeId: stringAt(source.nodeId, `${path}.nodeId`),
    pointer: pointerAt(source.pointer, `${path}.pointer`),
    lineage: enumAt(source.lineage, `${path}.lineage`, ["current"] as const),
    item: item as "same" | "aggregate" | { index: number },
  };
}

function validatePredicateReference(predicate: PredicateSpec, known: Map<string, CombNode>, allNodes: CombNode[], path: string): void {
  if (predicate.kind === "seal-present" || predicate.kind === "verdict" || predicate.kind === "output-equals") {
    const referenced = known.get(predicate.nodeId) ?? allNodes.find((node) => node.id === predicate.nodeId);
    if (!referenced) fail(`${path}.nodeId`, `unknown node ${predicate.nodeId}`);
    if (predicate.kind === "output-equals" && referenced.output?.kind !== "json-schema") {
      fail(path, "output-equals may reference only a node with a json-schema output contract");
    }
    if (predicate.kind === "verdict" && referenced.executor !== "human") {
      fail(path, "verdict predicates may reference only human nodes");
    }
  }
}

function validateValueReferences(spec: CombSpec): void {
  const ids = new Set(spec.nodes.map((node) => node.id));
  const validateSource = (source: ValueSource, path: string) => {
    if (source.source === "node-output" && !ids.has(source.nodeId)) fail(`${path}.nodeId`, `unknown node ${source.nodeId}`);
  };
  if (spec.output) validateSource(spec.output.value, "$.output.value");
  for (const [index, node] of spec.nodes.entries()) {
    if (node.subject) {
      validateSource(node.subject.key, `$.nodes[${index}].subject.key`);
      validateSource(node.subject.revision, `$.nodes[${index}].subject.revision`);
    }
  }
}

function assertForwardDag(spec: CombSpec): void {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(spec.nodes.map((node) => [node.id, 0]));
  for (const edge of spec.edges.filter((entry) => entry.kind === "forward")) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.shift()!;
    visited += 1;
    for (const next of outgoing.get(id) ?? []) {
      const count = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, count);
      if (count === 0) ready.push(next);
    }
  }
  if (visited !== spec.nodes.length) fail("$.edges", "forward edges must form a DAG; cycles require retry edges");
}

function compileSchema(schema: JsonObject, path: string): ValidateFunction {
  const key = canonicalJson(schema);
  const cached = validatorCache.get(key);
  if (cached) return cached;
  try {
    const validator = ajv.compile(schema);
    validatorCache.set(key, validator);
    return validator;
  } catch (error) {
    fail(path, `invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateContract(contract: DataContract | undefined, value: unknown): { valid: true } | { valid: false; errors: string[] } {
  if (!contract || contract.kind === "informal") return { valid: true };
  const validate = compileSchema(contract.schema, "$.schema");
  if (validate(value)) return { valid: true };
  return { valid: false, errors: formatAjvErrors(validate.errors) };
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

export function resolveJsonPointer(value: JsonValue, pointer: JsonPointer): { found: true; value: JsonValue } | { found: false } {
  if (pointer === "") return { found: true, value };
  if (!pointer.startsWith("/")) return { found: false };
  let current: JsonValue = value;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index]!;
    } else if (current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token]!;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

export function canonicalDeepEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function resolveValueSource(
  source: ValueSource,
  context: {
    input: JsonValue;
    item?: JsonValue;
    itemIndex: number;
    activations: Iterable<ActivationRecord>;
  },
): JsonValue {
  if (source.source === "literal") return source.value;
  if (source.source === "run-input") return mustResolvePointer(context.input, source.pointer);
  if (source.source === "item") return mustResolvePointer(context.item ?? null, source.pointer ?? "");
  const candidates = [...context.activations].filter(
    (activation) =>
      activation.address.nodeId === source.nodeId &&
      activation.invalidatedAt === undefined &&
      activation.status === "done" &&
      (source.item === "same"
        ? activation.address.itemIndex === context.itemIndex
        : source.item === "aggregate"
          ? activation.address.itemIndex === context.itemIndex
          : activation.address.itemIndex === source.item.index),
  );
  candidates.sort((a, b) => b.address.attempt - a.address.attempt);
  const selected = candidates[0];
  if (!selected) throw new Error(`node-output ${source.nodeId}: no current terminal activation`);
  const base = source.item === "aggregate" ? selected.aggregate : selected.output;
  if (base === undefined) throw new Error(`node-output ${source.nodeId}: selected output is missing`);
  return mustResolvePointer(base, source.pointer);
}

function mustResolvePointer(value: JsonValue, pointer: JsonPointer): JsonValue {
  const resolved = resolveJsonPointer(value, pointer);
  if (!resolved.found) throw new Error(`JSON pointer ${JSON.stringify(pointer)} did not resolve`);
  return resolved.value;
}

export function renderBrief(template: string, input: JsonValue, item: JsonValue | undefined, nodes: Iterable<ActivationRecord>): string {
  const nodeMap = new Map<string, ActivationRecord>();
  for (const activation of nodes) {
    if (activation.invalidatedAt || activation.status !== "done") continue;
    const existing = nodeMap.get(activation.address.nodeId);
    if (!existing || activation.address.attempt > existing.address.attempt) nodeMap.set(activation.address.nodeId, activation);
  }
  const unresolved: string[] = [];
  const rendered = template.replace(TEMPLATE_RE, (whole, expression: string) => {
    let resolved: { found: true; value: JsonValue } | { found: false } = { found: false };
    if (expression === "input") resolved = { found: true, value: input };
    else if (expression.startsWith("input.")) resolved = resolveJsonPointer(input, `/${expression.slice(6).split(".").join("/")}`);
    else if (expression === "item") resolved = { found: true, value: item ?? null };
    else if (expression.startsWith("item.")) resolved = resolveJsonPointer(item ?? null, `/${expression.slice(5).split(".").join("/")}`);
    else {
      const match = /^nodes\.([A-Za-z0-9_.-]+)\.output(?:\.(.*))?$/.exec(expression);
      if (match) {
        const output = nodeMap.get(match[1]!)?.output;
        if (output !== undefined) {
          resolved = resolveJsonPointer(output, match[2] ? `/${match[2].split(".").join("/")}` : "");
        }
      }
    }
    if (!resolved.found) {
      unresolved.push(whole);
      return whole;
    }
    return typeof resolved.value === "string" ? resolved.value : canonicalJson(resolved.value);
  });
  if (unresolved.length) throw new Error(`unresolved brief placeholders: ${unresolved.join(", ")}`);
  return rendered;
}

function pointerAt(value: unknown, path: string): JsonPointer {
  if (typeof value !== "string") fail(path, "must be a string");
  const pointer = value;
  if (pointer !== "" && !pointer.startsWith("/")) fail(path, 'must be "" or begin with "/"');
  if (/(?:~[^01])|~$/.test(pointer)) fail(path, "contains an invalid RFC 6901 escape");
  return pointer;
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  return value;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function enumAt<const T extends readonly string[]>(value: unknown, path: string, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) fail(path, `must be one of ${choices.join(", ")}`);
  return value as T[number];
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}
