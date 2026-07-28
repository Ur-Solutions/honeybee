import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { generateRunId } from "../flow/runs.js";
import { canonicalDigest, canonicalJson } from "./canonical.js";
import { CombError } from "./errors.js";
import { resolveValueSource, validateContract } from "./schema.js";
import {
  DEFAULT_RUN_POLICIES,
  type ActivationRecord,
  type CombSnapshot,
  type CombSpec,
  type EvidenceEnvelope,
  type EvidenceRef,
  type JsonObject,
  type JsonValue,
  type RunBoardView,
  type RunEvent,
  type RunOrigin,
  type RunPolicies,
  type RunRecord,
  type StoredCombVersion,
} from "./types.js";

export function combRunsRoot(): string {
  return join(storeRoot(), "combs", "runs");
}

export function combRunDir(runId: string): string {
  return join(combRunsRoot(), runId);
}

export function combRunPath(runId: string): string {
  return join(combRunDir(runId), "run.json");
}

export function combRunLockPath(runId: string): string {
  return join(combRunDir(runId), ".lock");
}

export function combRunEventsPath(runId: string): string {
  return join(combRunDir(runId), "events.jsonl");
}

export function combRunSnapshotPath(runId: string, revision: number): string {
  return join(combRunDir(runId), "snapshots", `${String(revision).padStart(6, "0")}.json`);
}

export async function createRun(options: {
  storedComb?: StoredCombVersion;
  definition?: CombSpec;
  input: JsonValue;
  cwd: string;
  productKey: string;
  origin: RunOrigin;
  policies?: Partial<RunPolicies>;
  subjectClaimId?: string;
  originDeliveryRequestDigest?: string;
  runId?: string;
  now?: string;
}): Promise<RunRecord> {
  const definition = options.storedComb?.definition ?? options.definition;
  if (!definition) throw new CombError("invalid_argument", "run creation requires a registry comb or ad-hoc definition");
  const inputValidation = validateContract(definition.input, options.input);
  if (!inputValidation.valid) {
    throw new CombError("invalid_argument", `run input does not match comb contract: ${inputValidation.errors.join("; ")}`);
  }
  const id = options.runId ?? generateRunId();
  const createdAt = options.now ?? new Date().toISOString();
  const inputDigest = canonicalDigest(options.input);
  const snapshot: CombSnapshot = {
    schemaVersion: 1,
    revision: 0,
    definition,
    definitionDigest: canonicalDigest(definition as unknown as JsonValue),
    ...(options.storedComb
      ? { registry: { name: options.storedComb.name, version: options.storedComb.version, digest: options.storedComb.digest } }
      : {}),
    resolvedActionBindings: [],
    actionBindingDigest: canonicalDigest([]),
    createdAt,
  };
  const policies: RunPolicies = {
    ...DEFAULT_RUN_POLICIES,
    ...options.policies,
    nodeOverrides: options.policies?.nodeOverrides,
  };
  const entryIds = entryNodeIds(definition);
  if (entryIds.length === 0) throw new CombError("invalid_argument", `comb ${definition.name} has no entry nodes`);
  const activations: Record<string, ActivationRecord> = {};
  for (const nodeId of entryIds) {
    const node = definition.nodes.find((candidate) => candidate.id === nodeId)!;
    const address = { runId: id, nodeId, attempt: 1, itemIndex: 0 };
    const taskId = `${id}/${nodeId}/0`;
    const subject = resolveActivationSubject(node.subject, { runId: id, input: options.input, inputDigest });
    const activation: ActivationRecord = {
      id: activationId(nodeId, 1, 0),
      address,
      taskId,
      cohortId: `${id}:g0:i0`,
      nodeSnapshotRevision: 0,
      status: "pending",
      subject,
      claim: { taskId, attempt: 1 },
      createdAt,
      beeHandles: [],
      evidenceCount: 0,
      evidenceTail: [],
      deviationCount: 0,
      deviationTail: [],
      incomingEdgeFiringIds: [],
      activeChildRunIds: [],
      childRunTail: [],
      effectKeys: [],
    };
    activations[activation.id] = activation;
  }
  const run: RunRecord = {
    schemaVersion: 1,
    id,
    status: "active",
    origin: options.origin,
    triggerAssociations:
      options.origin.kind === "trigger"
        ? [{
            triggerId: options.origin.triggerId,
            firstDeliveryId: options.origin.deliveryId,
            ...(options.origin.eventId ? { firstEventId: options.origin.eventId } : {}),
            relation: "creator",
            associatedAt: createdAt,
          }]
        : [],
    productKey: options.productKey,
    cwd: options.cwd,
    input: options.input,
    inputDigest,
    currentSnapshot: snapshot,
    snapshotHistoryTail: [{
      revision: 0,
      definitionDigest: snapshot.definitionDigest,
      actionBindingDigest: snapshot.actionBindingDigest,
      createdAt,
      storageRef: "snapshots/000000.json",
    }],
    snapshotRevision: 0,
    policies,
    depth: 0,
    rootRunId: id,
    activations,
    nextCohortGeneration: 1,
    edgeFiringTail: [],
    effects: {},
    effectTail: [],
    cleanup: emptyCleanup("not-required"),
    intakeReady: false,
    ...(options.subjectClaimId ? { subjectClaimId: options.subjectClaimId } : {}),
    ...(options.originDeliveryRequestDigest
      ? { originDeliveryRequestDigest: options.originDeliveryRequestDigest }
      : {}),
    eventTail: [],
    eventsRetainedFrom: 1,
    nextEventSequence: 1,
    violationCount: 0,
    ledgerPublishedThrough: 0,
    createdAt,
    updatedAt: createdAt,
  };
  recordRunEvent(run, "comb.run.started", undefined, {
    definitionDigest: snapshot.definitionDigest,
    comb: definition.name,
    ...(snapshot.registry ? { version: snapshot.registry.version } : {}),
  });
  for (const activation of Object.values(activations)) {
    recordRunEvent(run, "comb.activation.pending", activation.address);
  }
  await mkdir(combRunDir(id), { recursive: true });
  await withFileLock(combRunLockPath(id), async () => {
    if (await loadRun(id)) throw new CombError("version_conflict", `run ${id} already exists`);
    await atomicWriteFile(combRunSnapshotPath(id, 0), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await persistRun(run);
  });
  return run;
}

export async function loadRun(runId: string): Promise<RunRecord | null> {
  try {
    const value = JSON.parse(await readFile(combRunPath(runId), "utf8")) as RunRecord;
    if (value.schemaVersion !== 1 || value.id !== runId) {
      throw new CombError("corrupt_state", `comb run ${runId} is invalid`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function requireRun(runId: string): Promise<RunRecord> {
  const run = await loadRun(runId);
  if (!run) throw new CombError("not_found", `comb run not found: ${runId}`);
  return run;
}

export async function mutateRun<T>(
  runId: string,
  mutate: (run: RunRecord) => Promise<T> | T,
): Promise<{ run: RunRecord; result: T; changed: boolean }> {
  return withFileLock(combRunLockPath(runId), async () => {
    const run = await requireRun(runId);
    const before = canonicalJson(run as unknown as JsonValue);
    const result = await mutate(run);
    const after = canonicalJson(run as unknown as JsonValue);
    const changed = before !== after;
    if (changed) {
      run.updatedAt = new Date().toISOString();
      await persistRun(run);
    } else {
      await repairEventProjection(run);
    }
    return { run, result, changed };
  });
}

export async function listRuns(): Promise<RunRecord[]> {
  const ids = await readdir(combRunsRoot()).catch(() => [] as string[]);
  const runs: RunRecord[] = [];
  for (const id of ids) {
    const run = await loadRun(id);
    if (run) runs.push(run);
  }
  return runs;
}

export async function listSweepableRuns(): Promise<RunRecord[]> {
  return (await listRuns()).filter(
    (run) =>
      run.status === "active" ||
      run.cleanup.status !== "complete" ||
      Boolean(run.subjectClaimId && !run.subjectClaimReleasedAt),
  );
}

export async function cancelRun(runId: string, options: { reason?: string; requestedBy?: string; now?: string } = {}): Promise<RunRecord> {
  return (await cancelRunWithDisposition(runId, options)).run;
}

export async function cancelRunWithDisposition(
  runId: string,
  options: { reason?: string; requestedBy?: string; now?: string } = {},
): Promise<{ run: RunRecord; accepted: boolean }> {
  const { run, result: accepted } = await mutateRun(runId, (record) => {
    if (record.status !== "active" || record.cancellation) return false;
    const requestedAt = options.now ?? new Date().toISOString();
    record.cancellation = {
      epoch: 1,
      requestedAt,
      requestedBy: options.requestedBy ?? process.env.HIVE_BEE ?? process.env.USER ?? "operator",
      ...(options.reason ? { reason: options.reason } : {}),
    };
    record.status = "cancelled";
    initializeRunCleanup(record, requestedAt);
    recordRunEvent(record, "comb.run.cancelled", undefined, {
      requestedBy: record.cancellation.requestedBy,
      ...(record.cancellation.reason ? { reason: record.cancellation.reason } : {}),
    });
    return true;
  });
  return { run, accepted };
}

export async function saveEvidence(runId: string, envelope: EvidenceEnvelope): Promise<EvidenceRef> {
  const serialized = canonicalJson(envelope as unknown as JsonValue);
  const digest = canonicalDigest(envelope as unknown as JsonValue);
  const filename = digest.slice("sha256:".length);
  const storageRef = `evidence/${filename}.json`;
  await atomicWriteFile(join(combRunDir(runId), storageRef), `${serialized}\n`, { mode: 0o600 });
  return {
    id: envelope.id,
    kind: envelope.kind,
    subject: envelope.subject,
    producer: envelope.producer,
    recordedAt: envelope.recordedAt,
    payloadDigest: digest,
    storageRef,
    summary: evidenceSummary(envelope),
  };
}

export async function readEvidence(runId: string, ref: EvidenceRef): Promise<EvidenceEnvelope> {
  return JSON.parse(await readFile(join(combRunDir(runId), ref.storageRef), "utf8")) as EvidenceEnvelope;
}

export function recordRunEvent(run: RunRecord, type: string, activation?: ActivationRecord["address"], data?: JsonObject): RunEvent {
  if (type === "comb.violation" || type.startsWith("comb.violation.")) {
    run.violationCount = (
      run.violationCount ??
      run.eventTail.filter((event) =>
        event.type === "comb.violation" || event.type.startsWith("comb.violation.")
      ).length
    ) + 1;
  }
  const sequence = run.nextEventSequence;
  const event: RunEvent = {
    id: `${run.id}:${sequence}`,
    sequence,
    type,
    at: new Date().toISOString(),
    ...(activation ? { activation } : {}),
    ...(data ? { data } : {}),
  };
  run.nextEventSequence += 1;
  run.eventTail.push(event);
  if (run.eventTail.length > 256) {
    run.eventTail.splice(0, run.eventTail.length - 256);
    run.eventsRetainedFrom = run.eventTail[0]!.sequence;
  }
  return event;
}

export async function readRunEvents(
  runId: string,
  options: { after?: number; limit?: number } = {},
): Promise<{ runId: string; after: number; events: RunEvent[]; nextAfter: number; hasMore: boolean }> {
  const run = await requireRun(runId);
  const after = options.after ?? 0;
  const limit = options.limit ?? 256;
  const lines = (await readFile(combRunEventsPath(runId), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
  const bySequence = new Map<number, RunEvent>();
  for (const event of [...lines, ...run.eventTail]) {
    const existing = bySequence.get(event.sequence);
    if (existing && existing.id !== event.id) throw new CombError("corrupt_state", `run ${runId} event sequence ${event.sequence} conflicts`);
    bySequence.set(event.sequence, event);
  }
  const events = [...bySequence.values()]
    .filter((event) => event.sequence > after)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, limit);
  const nextAfter = events.at(-1)?.sequence ?? after;
  return { runId, after, events, nextAfter, hasMore: nextAfter < run.nextEventSequence - 1 };
}

export function boardView(run: RunRecord): RunBoardView {
  const activations = Object.values(run.activations)
    .sort((a, b) => a.address.nodeId.localeCompare(b.address.nodeId) || a.address.attempt - b.address.attempt || a.address.itemIndex - b.address.itemIndex)
    .map((activation) => ({
      id: activation.id,
      nodeId: activation.address.nodeId,
      attempt: activation.address.attempt,
      itemIndex: activation.address.itemIndex,
      cohortId: activation.cohortId,
      status: activation.status,
      subject: activation.subject,
      beeHandles: activation.beeHandles,
      deviationCount: activation.deviationCount,
      evidence: activation.evidenceTail.slice(-3).map(({ id, kind, producer, recordedAt, summary }) => ({
        id,
        kind,
        producer,
        recordedAt,
        ...(summary ? { summary } : {}),
      })),
      ...(activation.startedAt ? { startedAt: activation.startedAt } : {}),
      ...(activation.endedAt ? { endedAt: activation.endedAt } : {}),
    }));
  return {
    id: run.id,
    comb: {
      name: run.currentSnapshot.definition.name,
      ...(run.currentSnapshot.registry ? { version: run.currentSnapshot.registry.version } : {}),
      digest: run.currentSnapshot.definitionDigest,
    },
    status: run.status,
    origin: run.origin,
    triggerAssociations: run.triggerAssociations,
    productKey: run.productKey,
    depth: run.depth,
    snapshotRevision: run.snapshotRevision,
    definitionDigest: run.currentSnapshot.definitionDigest,
    actionBindingDigest: run.currentSnapshot.actionBindingDigest,
    intakeReady: run.intakeReady,
    cleanupStatus: run.cleanup.status,
    activations,
    activeChildRunIds: [],
    childRunTail: [],
    violationCount: run.violationCount ?? run.eventTail.filter((event) =>
      event.type === "comb.violation" || event.type.startsWith("comb.violation.")
    ).length,
    deviationCount: activations.reduce((sum, activation) => sum + activation.deviationCount, 0),
    lastEventSequence: run.nextEventSequence - 1,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  };
}

export function activationId(nodeId: string, attempt: number, itemIndex: number): string {
  return `${nodeId}@${attempt}#${itemIndex}`;
}

export function emptyCleanup(status: RunRecord["cleanup"]["status"]): RunRecord["cleanup"] {
  return {
    status,
    pendingEffectKeys: [],
    pendingSubscriptionIds: [],
    pendingObservationWatchIds: [],
    pendingPacketIds: [],
    pendingBeeNames: [],
    pendingChildRunIds: [],
  };
}

export function initializeRunCleanup(run: RunRecord, now: string): void {
  run.cleanup = emptyCleanup("pending");
  run.cleanup.startedAt = now;
  run.cleanup.pendingEffectKeys = Object.values(run.effects)
    .filter((effect) => effect.status === "prepared" || effect.status === "executing" || effect.status === "ambiguous")
    .map((effect) => effect.key);
  run.cleanup.pendingBeeNames = [...new Set(
    Object.values(run.activations).flatMap(
      (activation) => activation.beeHandles.map((handle) => handle.name),
    ),
  )];
  run.endedAt = now;
}

function entryNodeIds(definition: CombSpec): string[] {
  const hasIncomingForward = new Set(definition.edges.filter((edge) => edge.kind === "forward").map((edge) => edge.to));
  const waitingTargets = new Set(definition.edges.filter((edge) => edge.kind === "waiting").map((edge) => edge.to));
  return definition.nodes
    .filter((node) => !hasIncomingForward.has(node.id) && !waitingTargets.has(node.id))
    .map((node) => node.id);
}

function resolveActivationSubject(
  subject: CombSpec["nodes"][number]["subject"],
  context: { runId: string; input: JsonValue; inputDigest: string },
) {
  if (!subject) return { kind: "run-input", key: context.runId, revision: context.inputDigest };
  const key = resolveValueSource(subject.key, { input: context.input, itemIndex: 0, activations: [] });
  const revision = resolveValueSource(subject.revision, { input: context.input, itemIndex: 0, activations: [] });
  if (typeof key !== "string" || typeof revision !== "string") {
    throw new CombError("invalid_argument", "subject key and revision must resolve to strings");
  }
  return { kind: subject.kind, key, revision };
}

function evidenceSummary(envelope: EvidenceEnvelope): JsonObject | undefined {
  if (envelope.kind !== "seal") return undefined;
  const payload = envelope.payload as { filename: string; seal: { status: string; type?: string; summary: string } };
  return {
    filename: payload.filename,
    status: payload.seal.status,
    ...(payload.seal.type ? { type: payload.seal.type } : {}),
    summary: payload.seal.summary.slice(0, 500),
  };
}

async function persistRun(run: RunRecord): Promise<void> {
  await atomicWriteFile(combRunPath(run.id), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  await repairEventProjection(run);
}

async function repairEventProjection(run: RunRecord): Promise<void> {
  const existing = new Set(
    (await readFile(combRunEventsPath(run.id), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return (JSON.parse(line) as RunEvent).id;
        } catch {
          return "";
        }
      }),
  );
  const missing = run.eventTail.filter((event) => !existing.has(event.id));
  if (missing.length) {
    await mkdir(combRunDir(run.id), { recursive: true });
    await appendFile(combRunEventsPath(run.id), missing.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
  }
}
