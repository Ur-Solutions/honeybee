import type { SealRecord } from "../seal.js";
import { activationKey } from "../activation.js";
import { canonicalDeepEqual, resolveJsonPointer, resolveValueSource, validateContract } from "./schema.js";
import { activationId, emptyCleanup, recordRunEvent } from "./store.js";
import type {
  ActivationRecord,
  CombEdge,
  CombNode,
  JsonObject,
  JsonValue,
  JoinAggregateOutput,
  PredicateSpec,
  RunRecord,
} from "./types.js";

export type PredicateResult = { state: "waiting" } | { state: "true" } | { state: "false"; message: string };

export function applySealCompletion(run: RunRecord, activation: ActivationRecord, seal: SealRecord, now = new Date().toISOString()): void {
  if (run.cancellation || activation.invalidatedAt || activation.status === "done" || activation.status === "failed" || activation.status === "skipped") return;
  const node = nodeFor(run, activation.address.nodeId);
  if (node.executor !== "agent") return;
  if (seal.status !== "done") {
    failActivation(
      run,
      activation,
      `seal-${seal.status}`,
      `agent sealed with status ${seal.status}`,
      seal.status !== "failed",
      now,
    );
    return;
  }
  const output = seal.output as JsonValue | undefined;
  const validation = validateContract(node.output, output);
  if (!validation.valid || (node.output?.kind === "json-schema" && output === undefined)) {
    failActivation(
      run,
      activation,
      "invalid-output",
      `seal output does not match node contract: ${validation.valid ? "output is required" : validation.errors.join("; ")}`,
      true,
      now,
    );
    return;
  }
  activation.status = "done";
  activation.endedAt = now;
  if (output !== undefined) activation.output = output;
  recordRunEvent(run, "comb.activation.done", activation.address);
}

export function reconcileMachine(run: RunRecord, now = new Date().toISOString()): boolean {
  if (run.status !== "active") return false;
  let changed = false;
  const maxIterations = Math.max(16, run.currentSnapshot.definition.nodes.length * 8);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let iterationChanged = false;
    iterationChanged = reconcileEnginePredicates(run, now) || iterationChanged;
    iterationChanged = fireEligibleEdges(run, now) || iterationChanged;
    iterationChanged = reconcileForwardJoins(run, now) || iterationChanged;
    changed = changed || iterationChanged;
    if (!iterationChanged) break;
  }
  changed = deriveTerminalRun(run, now) || changed;
  return changed;
}

export function evaluatePredicate(
  run: RunRecord,
  predicate: PredicateSpec,
  context: { itemIndex: number; now: string; activation?: ActivationRecord },
): PredicateResult {
  if (predicate.kind === "clock") {
    const basis = context.activation?.startedAt;
    if (!basis) return { state: "waiting" };
    return Date.parse(context.now) >= Date.parse(basis) + predicate.afterMs
      ? { state: "true" }
      : { state: "waiting" };
  }
  if (predicate.kind === "ci-status") return { state: "waiting" };
  const referenced = currentActivation(run, predicate.nodeId, context.itemIndex);
  if (!referenced || (referenced.status !== "done" && referenced.status !== "failed" && referenced.status !== "skipped")) {
    return { state: "waiting" };
  }
  if (predicate.kind === "seal-present") {
    const desired = predicate.statuses ?? ["done"];
    const matching = referenced.evidenceTail.some((evidence) => {
      if (evidence.kind !== "seal") return false;
      const status = evidence.summary?.status;
      const type = evidence.summary?.type;
      return typeof status === "string" && desired.includes(status as (typeof desired)[number]) &&
        (predicate.sealType === undefined || type === predicate.sealType);
    });
    return matching ? { state: "true" } : { state: "false", message: `no matching seal on ${predicate.nodeId}` };
  }
  if (predicate.kind === "verdict") {
    const verdict = referenced.output && typeof referenced.output === "object" && !Array.isArray(referenced.output)
      ? referenced.output.verdict
      : undefined;
    return verdict === predicate.equals
      ? { state: "true" }
      : { state: "false", message: `verdict on ${predicate.nodeId} did not equal ${predicate.equals}` };
  }
  if (referenced.status !== "done" || referenced.output === undefined) return { state: "waiting" };
  const selected = resolveJsonPointer(referenced.output, predicate.path);
  if (!selected.found) return { state: "false", message: `output path ${predicate.path} is missing on ${predicate.nodeId}` };
  return canonicalDeepEqual(selected.value, predicate.equals)
    ? { state: "true" }
    : { state: "false", message: `output on ${predicate.nodeId}${predicate.path} did not equal the expected literal` };
}

export function activateAgent(run: RunRecord, activation: ActivationRecord, now = new Date().toISOString()): void {
  if (activation.status !== "pending" || run.cancellation) return;
  activation.status = "active";
  activation.startedAt = now;
  activation.claim.attemptStartedAt = now;
  recordRunEvent(run, "comb.activation.active", activation.address);
}

function reconcileEnginePredicates(run: RunRecord, now: string): boolean {
  let changed = false;
  for (const activation of currentActivations(run)) {
    const node = nodeFor(run, activation.address.nodeId);
    if (node.executor !== "engine" || node.engine.kind !== "predicate") continue;
    if (activation.status === "pending") {
      activation.status = "active";
      activation.startedAt = now;
      activation.claim.attemptStartedAt = now;
      recordRunEvent(run, "comb.activation.active", activation.address);
      changed = true;
    }
    if (activation.status !== "active" && activation.status !== "waiting-event") continue;
    const result = evaluatePredicate(run, node.engine.predicate, { itemIndex: activation.address.itemIndex, now, activation });
    if (result.state === "waiting") {
      if (activation.status !== "waiting-event") {
        activation.status = "waiting-event";
        recordRunEvent(run, "comb.activation.waiting_event", activation.address);
        changed = true;
      }
      continue;
    }
    if (result.state === "false") {
      failActivation(run, activation, "predicate-false", result.message, false, now);
      changed = true;
      continue;
    }
    activation.status = "done";
    activation.endedAt = now;
    activation.output = { matched: true };
    recordRunEvent(run, "comb.activation.done", activation.address);
    changed = true;
  }
  return changed;
}

function fireEligibleEdges(run: RunRecord, now: string): boolean {
  let changed = false;
  const definition = run.currentSnapshot.definition;
  for (const activation of currentActivations(run)) {
    if (!isTerminalActivation(activation)) continue;
    for (const edge of definition.edges.filter((candidate) => candidate.from === activation.address.nodeId)) {
      if (!edgeMatchesStatus(edge, activation.status)) continue;
      const firingId = edgeFiringId(edge, activation);
      if (run.edgeFiringTail.some((firing) => firing.id === firingId)) continue;
      if (edge.when) {
        const result = evaluatePredicate(run, edge.when, { itemIndex: activation.address.itemIndex, now, activation });
        if (result.state !== "true") continue;
      }
      const firing = {
        id: firingId,
        edgeId: edge.id,
        from: activation.address,
        toNodeId: edge.to,
        cohortId: activation.cohortId,
        subject: activation.subject,
        firedAt: now,
      };
      run.edgeFiringTail.push(firing);
      if (run.edgeFiringTail.length > 256) run.edgeFiringTail.splice(0, run.edgeFiringTail.length - 256);
      recordRunEvent(run, "comb.edge.fired", activation.address, { edgeId: edge.id, toNodeId: edge.to });
      changed = true;
      if (edge.kind === "retry") {
        changed = createRetryAttempt(run, edge, activation, firing.id, now) || changed;
      }
    }
  }
  return changed;
}

function reconcileForwardJoins(run: RunRecord, now: string): boolean {
  let changed = false;
  const definition = run.currentSnapshot.definition;
  const cohorts = new Set(currentActivations(run).map((activation) => activation.cohortId));
  for (const node of definition.nodes) {
    const incoming = definition.edges.filter((edge) => edge.kind === "forward" && edge.to === node.id);
    if (incoming.length === 0) continue;
    for (const cohortId of cohorts) {
      const itemIndex = cohortItemIndex(cohortId);
      if (currentActivations(run).some((activation) => activation.address.nodeId === node.id && activation.cohortId === cohortId)) continue;
      const sources = incoming.map((edge) => ({
        edge,
        activation: currentActivations(run).find(
          (activation) => activation.address.nodeId === edge.from && activation.cohortId === cohortId,
        ),
      }));
      const terminal = sources.filter((source) => source.activation && isTerminalActivation(source.activation));
      const successful = sources.filter((source) => {
        const activation = source.activation;
        if (!activation || !isTerminalActivation(activation) || !edgeMatchesStatus(source.edge, activation.status)) return false;
        return run.edgeFiringTail.some((firing) => firing.id === edgeFiringId(source.edge, activation));
      });
      const failures = terminal.filter((source) => !successful.includes(source));
      const unresolved = sources.length - terminal.length;
      const policy = node.join ?? { mode: "all" as const, tolerateFailures: 0 };
      const tolerance = policy.tolerateFailures ?? 0;
      let ready = false;
      let impossible = failures.length > tolerance;
      if (policy.mode === "all") ready = unresolved === 0 && !impossible;
      if (policy.mode === "any") {
        ready = successful.length >= 1;
        impossible = terminal.length === sources.length && successful.length === 0;
      }
      if (policy.mode === "quorum") {
        const quorum = policy.quorum ?? 1;
        ready = successful.length >= quorum && failures.length <= tolerance;
        impossible = failures.length > tolerance || successful.length + unresolved < quorum;
      }
      if (!ready && !impossible) continue;
      if (ready && (policy.mode === "any" || policy.mode === "quorum")) {
        for (const source of sources) {
          if (source.activation && !isTerminalActivation(source.activation)) {
            source.activation.status = "skipped";
            source.activation.endedAt = now;
            recordRunEvent(run, "comb.activation.skipped", source.activation.address);
          }
        }
      }
      const aggregate = aggregateFromSources(sources.flatMap((source) => source.activation ? [source.activation] : []));
      const activation = createActivation(run, node, {
        attempt: nextAttempt(run, node.id, itemIndex),
        itemIndex,
        cohortId,
        subject: terminal[0]?.activation?.subject ?? defaultSubject(run),
        incomingEdgeFiringIds: successful.map((source) => edgeFiringId(source.edge, source.activation!)),
        now,
        aggregate,
      });
      if (impossible) {
        failActivation(run, activation, "join-failed", `join ${node.id} cannot satisfy ${policy.mode}`, false, now);
      }
      changed = true;
    }
  }
  return changed;
}

function createRetryAttempt(run: RunRecord, edge: CombEdge, source: ActivationRecord, firingId: string, now: string): boolean {
  const destination = nodeFor(run, edge.to);
  const itemIndex = source.address.itemIndex;
  const attempt = nextAttempt(run, destination.id, itemIndex);
  const limits = { ...run.policies, ...run.policies.nodeOverrides?.[destination.id] };
  if (attempt > limits.maxAttemptsPerActivation) {
    run.status = "failed";
    run.failure = {
      code: "attempts-exhausted",
      message: `node ${destination.id} exceeded ${limits.maxAttemptsPerActivation} attempts`,
      activation: source.address,
    };
    recordRunEvent(run, "comb.run.failed", source.address, { code: "attempts-exhausted", nodeId: destination.id });
    return true;
  }
  const downstream = forwardReachableNodes(run, destination.id);
  for (const activation of currentActivations(run)) {
    if (activation.address.itemIndex !== itemIndex || !downstream.has(activation.address.nodeId)) continue;
    activation.invalidatedAt = now;
    activation.invalidatedBy = source.address;
  }
  const generation = run.nextCohortGeneration;
  run.nextCohortGeneration += 1;
  const created = createActivation(run, destination, {
    attempt,
    itemIndex,
    cohortId: `${run.id}:g${generation}:i${itemIndex}`,
    subject: source.subject,
    incomingEdgeFiringIds: [firingId],
    now,
  });
  const backoff = Math.min(
    limits.retryBackoffMs * (2 ** Math.max(0, attempt - 2)),
    limits.retryBackoffMaxMs,
  );
  created.nextEligibleAt = new Date(Date.parse(now) + backoff).toISOString();
  return true;
}

function createActivation(
  run: RunRecord,
  node: CombNode,
  options: {
    attempt: number;
    itemIndex: number;
    cohortId: string;
    subject: ActivationRecord["subject"];
    incomingEdgeFiringIds: string[];
    now: string;
    aggregate?: JoinAggregateOutput;
  },
): ActivationRecord {
  const id = activationId(node.id, options.attempt, options.itemIndex);
  const taskId = `${run.id}/${node.id}/${options.itemIndex}`;
  const activation: ActivationRecord = {
    id,
    address: { runId: run.id, nodeId: node.id, attempt: options.attempt, itemIndex: options.itemIndex },
    taskId,
    cohortId: options.cohortId,
    nodeSnapshotRevision: run.snapshotRevision,
    status: "pending",
    subject: options.subject,
    claim: { taskId, attempt: options.attempt },
    createdAt: options.now,
    beeHandles: [],
    evidenceCount: 0,
    evidenceTail: [],
    deviationCount: 0,
    deviationTail: [],
    incomingEdgeFiringIds: options.incomingEdgeFiringIds,
    activeChildRunIds: [],
    childRunTail: [],
    effectKeys: [],
    ...(options.aggregate ? { aggregate: options.aggregate } : {}),
  };
  run.activations[id] = activation;
  recordRunEvent(run, "comb.activation.pending", activation.address);
  return activation;
}

function deriveTerminalRun(run: RunRecord, now: string): boolean {
  if (run.status !== "active") return false;
  const current = currentActivations(run);
  if (current.some((activation) => activation.status === "pending" || activation.status === "active" || activation.status === "waiting-event" || activation.status === "waiting-human")) {
    return false;
  }
  const unhandledFailure = current.find((activation) => activation.status === "failed" && !failureHandled(run, activation));
  if (unhandledFailure) {
    run.status = "failed";
    run.failure = {
      code: unhandledFailure.failure?.code ?? "activation-failed",
      message: unhandledFailure.failure?.message ?? `activation ${unhandledFailure.id} failed`,
      activation: unhandledFailure.address,
    };
    startTerminalCleanup(run, now);
    recordRunEvent(run, "comb.run.failed", unhandledFailure.address, { code: run.failure.code });
    return true;
  }
  const outputDeclaration = run.currentSnapshot.definition.output;
  if (outputDeclaration) {
    try {
      const terminals = current.filter((activation) => terminalNode(run, activation.address.nodeId));
      const selectedItem = terminals[0]?.address.itemIndex ?? 0;
      const output = resolveValueSource(outputDeclaration.value, {
        input: run.input,
        itemIndex: selectedItem,
        activations: current,
      });
      const validation = validateContract(outputDeclaration.contract, output);
      if (!validation.valid) {
        run.status = "failed";
        run.failure = { code: "invalid-output", message: `comb output is invalid: ${validation.errors.join("; ")}` };
        startTerminalCleanup(run, now);
        recordRunEvent(run, "comb.run.failed", undefined, { code: "invalid-output" });
        return true;
      }
      run.output = output;
    } catch (error) {
      run.status = "failed";
      run.failure = { code: "invalid-output", message: error instanceof Error ? error.message : String(error) };
      startTerminalCleanup(run, now);
      recordRunEvent(run, "comb.run.failed", undefined, { code: "invalid-output" });
      return true;
    }
  }
  run.status = "done";
  startTerminalCleanup(run, now);
  recordRunEvent(run, "comb.run.done", undefined, run.output === undefined ? undefined : { output: run.output });
  return true;
}

function startTerminalCleanup(run: RunRecord, now: string): void {
  const bees = currentActivations(run).flatMap((activation) => activation.beeHandles.map((handle) => handle.name));
  if (run.policies.retireAgentsOnTerminal && bees.length) {
    run.cleanup = emptyCleanup("pending");
    run.cleanup.startedAt = now;
    run.cleanup.pendingBeeNames = [...new Set(bees)];
  } else {
    run.cleanup = emptyCleanup("complete");
    run.cleanup.startedAt = now;
    run.cleanup.completedAt = now;
    run.endedAt = now;
  }
}

function failureHandled(run: RunRecord, activation: ActivationRecord): boolean {
  const outgoing = run.currentSnapshot.definition.edges.filter(
    (edge) => edge.from === activation.address.nodeId && edgeMatchesStatus(edge, activation.status),
  );
  if (outgoing.some((edge) => run.edgeFiringTail.some((firing) => firing.id === edgeFiringId(edge, activation)))) return true;
  return currentActivations(run).some(
    (candidate) =>
      candidate.cohortId === activation.cohortId &&
      candidate.aggregate?.items.some((item) => sameAddress(item.activation, activation.address)),
  );
}

function failActivation(run: RunRecord, activation: ActivationRecord, code: string, message: string, retryable: boolean, now: string): void {
  activation.status = "failed";
  activation.endedAt = now;
  activation.failure = { code, message, retryable };
  recordRunEvent(run, "comb.activation.failed", activation.address, { code, retryable });
}

function currentActivation(run: RunRecord, nodeId: string, itemIndex: number): ActivationRecord | undefined {
  return currentActivations(run)
    .filter((activation) => activation.address.nodeId === nodeId && activation.address.itemIndex === itemIndex)
    .sort((a, b) => b.address.attempt - a.address.attempt)[0];
}

function currentActivations(run: RunRecord): ActivationRecord[] {
  return Object.values(run.activations).filter((activation) => activation.invalidatedAt === undefined);
}

function nodeFor(run: RunRecord, nodeId: string): CombNode {
  const node = run.currentSnapshot.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`snapshot node ${nodeId} is missing`);
  return node;
}

function nextAttempt(run: RunRecord, nodeId: string, itemIndex: number): number {
  return Math.max(0, ...Object.values(run.activations)
    .filter((activation) => activation.address.nodeId === nodeId && activation.address.itemIndex === itemIndex)
    .map((activation) => activation.address.attempt)) + 1;
}

function edgeMatchesStatus(edge: CombEdge, status: ActivationRecord["status"]): boolean {
  return (edge.on === "done" && status === "done") || (edge.on === "failed" && status === "failed");
}

function edgeFiringId(edge: CombEdge, activation: ActivationRecord): string {
  return `${edge.id}:${activation.id}:${activation.cohortId}`;
}

function aggregateFromSources(activations: ActivationRecord[]): JoinAggregateOutput {
  const items = activations.map((activation) => ({
    activation: activation.address,
    status: activation.status === "done" ? "done" as const : activation.status === "skipped" ? "skipped" as const : "failed" as const,
    ...(activation.output !== undefined ? { output: activation.output } : {}),
  }));
  return {
    items,
    succeeded: items.filter((item) => item.status === "done").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
  };
}

function forwardReachableNodes(run: RunRecord, start: string): Set<string> {
  const reachable = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const from = queue.shift()!;
    for (const edge of run.currentSnapshot.definition.edges.filter((candidate) => candidate.kind === "forward" && candidate.from === from)) {
      if (reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      queue.push(edge.to);
    }
  }
  return reachable;
}

function terminalNode(run: RunRecord, nodeId: string): boolean {
  return !run.currentSnapshot.definition.edges.some((edge) => edge.kind !== "waiting" && edge.from === nodeId);
}

function isTerminalActivation(activation: ActivationRecord): boolean {
  return activation.status === "done" || activation.status === "failed" || activation.status === "skipped";
}

function cohortItemIndex(cohortId: string): number {
  const match = /:i([0-9]+)$/.exec(cohortId);
  return match ? Number(match[1]) : 0;
}

function defaultSubject(run: RunRecord) {
  return { kind: "run-input", key: run.id, revision: run.inputDigest };
}

function sameAddress(left: ActivationRecord["address"], right: ActivationRecord["address"]): boolean {
  return left.runId === right.runId && left.nodeId === right.nodeId && left.attempt === right.attempt && left.itemIndex === right.itemIndex;
}

export function effectBaseKey(activation: ActivationRecord): string {
  return activationKey(
    activation.address.runId,
    `${activation.address.nodeId}[${activation.address.itemIndex}]`,
    activation.address.attempt,
  );
}
