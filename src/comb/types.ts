import type { ActivationClaim } from "../activation.js";
import type { SealRecord } from "../seal.js";

export const COMB_DEFINITION_FORMAT = 2 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonPointer = string;
export type NodeId = string;

export type ValueSource =
  | { source: "literal"; value: JsonValue }
  | { source: "run-input"; pointer: JsonPointer }
  | { source: "item"; pointer?: JsonPointer }
  | {
      source: "node-output";
      nodeId: NodeId;
      pointer: JsonPointer;
      lineage: "current";
      item: "same" | "aggregate" | { index: number };
    };

export type ObjectMapping = Record<string, ValueSource>;

export type DataContract =
  | { kind: "informal"; description: string }
  | { kind: "json-schema"; schema: JsonObject };

export type SubjectSpec = {
  kind: string;
  key: ValueSource;
  revision: ValueSource;
};

export type ResolvedSubject = {
  kind: string;
  key: string;
  revision: string;
};

export type BindingStrength = "strict" | "guided" | "open";

export type JoinPolicy = {
  mode: "all" | "any" | "quorum";
  quorum?: number;
  tolerateFailures?: number;
};

export type CheckoutNeed = {
  pool: string;
  mode: "exclusive" | "shared";
};

export type GuidedExpectation = {
  id: string;
  description: string;
  evidence:
    | { kind: "agent-report" }
    | { kind: "seal-test"; commandIncludes?: string }
    | { kind: "seal-artifact"; artifactKind: "branch" | "diff" | "url" | "fixture" }
    | { kind: "seal-file"; glob: string };
};

export type NodeBase = {
  id: NodeId;
  label?: string;
  binding: BindingStrength;
  subject?: SubjectSpec;
  output?: DataContract;
  join?: JoinPolicy;
  checkout?: CheckoutNeed;
};

export type SpawnCapacity = {
  kind: "spawn";
  bee: string;
  account?: string;
  model?: string;
  substrate?: "hsr" | "local-tmux";
};

export type FlightCapacity = {
  kind: "flight";
  flightId: string;
  mixKey?: string;
};

export type AgentNode = NodeBase & {
  executor: "agent";
  agent: {
    capacity: SpawnCapacity | FlightCapacity;
    brief: string;
    expectations?: GuidedExpectation[];
  };
};

export type HumanNode = NodeBase & {
  executor: "human";
  human: {
    title: string;
    packetKind: "web" | "desktop" | "cli" | "code";
    summary?: string;
    checklist?: Array<{ text: string; done: boolean }>;
    feedbackDestination:
      | { type: "bee"; fromNodeId: NodeId }
      | { type: "new-agent" }
      | { type: "pr-comment" };
  };
};

export type PredicateSpec =
  | {
      kind: "seal-present";
      nodeId: NodeId;
      statuses?: Array<"done" | "blocked" | "needs_input" | "failed">;
      sealType?: string;
    }
  | { kind: "verdict"; nodeId: NodeId; equals: "approve" | "request_changes" }
  | { kind: "ci-status"; check?: string; equals: "success" | "failure" | "pending" | "error" }
  | { kind: "output-equals"; nodeId: NodeId; path: JsonPointer; equals: JsonValue }
  | { kind: "clock"; afterMs: number; from: "activation-start" | "blocking-since" };

export type ChildCombSource =
  | { kind: "registry"; name: string; version?: number }
  | {
      kind: "node-output";
      nodeId: NodeId;
      lineage: "current";
      item: "same" | { index: number };
      graphPointer: JsonPointer;
    };

export type ChildRunOperation = {
  kind: "child-run";
  comb: ChildCombSource;
  input: ObjectMapping;
  items?: ValueSource;
  policyOverrides?: Partial<
    Pick<RunPolicies, "maxAttemptsPerActivation" | "stallMs" | "firstEvidenceMs" | "maxConcurrentActivations">
  >;
};

export type EngineOperation =
  | { kind: "predicate"; predicate: PredicateSpec }
  | { kind: "action"; intent: "land" | "run"; input?: ObjectMapping }
  | ChildRunOperation;

export type EngineNode = NodeBase & {
  executor: "engine";
  engine: EngineOperation;
};

export type CombNode = AgentNode | HumanNode | EngineNode;

export type CombEdge = {
  id: string;
  from: NodeId;
  to: NodeId;
  kind: "forward" | "retry" | "waiting";
  on: "done" | "failed" | "waiting";
  when?: PredicateSpec;
};

export type ClaimDeclaration = {
  scope: "product-comb" | "product";
  inputPointer: JsonPointer;
  collision: "refuse" | "join-existing";
};

export type SubscriptionDeclaration = {
  nodeId: NodeId;
  triggerId: string;
  subject: ValueSource;
  eventKinds: string[];
  delivery: "coalesce-latest" | "queue";
};

export type CombOutputDeclaration = {
  contract: DataContract;
  value: ValueSource;
};

export type CombAnnotations = {
  title?: string;
  tags?: string[];
  notify?: { on: Array<"waiting-human" | "failed" | "violation" | "done"> };
  migrationTodos?: Array<{ sourceRef: string; summary: string }>;
};

export type CombSpec = {
  formatVersion: typeof COMB_DEFINITION_FORMAT;
  name: string;
  description?: string;
  annotations?: CombAnnotations;
  input: DataContract;
  output?: CombOutputDeclaration;
  nodes: CombNode[];
  edges: CombEdge[];
  claim?: ClaimDeclaration;
  subscriptions?: SubscriptionDeclaration[];
};

export type CombSpecInput = Omit<CombSpec, "formatVersion"> & { formatVersion?: 2 };

export type CombVersionProvenance =
  | { kind: "file"; sourcePath: string; sourceDigest: string }
  | { kind: "promoted-run"; runId: string; snapshotRevision: number };

export type StoredCombVersion = {
  schemaVersion: 1;
  name: string;
  version: number;
  digest: string;
  definition: CombSpec;
  provenance: CombVersionProvenance;
  createdAt: string;
  createdBy: string;
};

export type CombRegistryIndex = {
  schemaVersion: 1;
  name: string;
  latestVersion: number;
  versions: Array<{
    version: number;
    digest: string;
    createdAt: string;
    provenance: CombVersionProvenance;
  }>;
  updatedAt: string;
};

export type ActivationPolicyLimits = {
  maxAttemptsPerActivation: number;
  retryBackoffMs: number;
  retryBackoffMaxMs: number;
  firstEvidenceMs: number;
  stallMs: number;
  maxConcurrentActivations: number;
};

export type RunPolicies = ActivationPolicyLimits & {
  maxDepth: number;
  amendmentApproval: "auto" | "human";
  amendmentQuiesceMs: number;
  amendmentQuiesceTimeout: "reject-amendment" | "retire";
  attachedRetryOnDead: "spawn" | "fail";
  maxPendingEventsPerSubscription: number;
  retireAgentsOnTerminal: boolean;
  nodeOverrides?: Record<NodeId, Partial<ActivationPolicyLimits>>;
};

export const DEFAULT_RUN_POLICIES: RunPolicies = {
  maxDepth: 2,
  maxAttemptsPerActivation: 3,
  retryBackoffMs: 5_000,
  retryBackoffMaxMs: 300_000,
  firstEvidenceMs: 240_000,
  stallMs: 600_000,
  maxConcurrentActivations: 8,
  amendmentApproval: "human",
  amendmentQuiesceMs: 600_000,
  amendmentQuiesceTimeout: "reject-amendment",
  attachedRetryOnDead: "spawn",
  maxPendingEventsPerSubscription: 1_024,
  retireAgentsOnTerminal: true,
};

export type ResolvedActionBinding = {
  intent: "land" | "run";
  productKey: string;
  bindingVersion: string;
  digest: string;
  binding: JsonObject;
};

export type CombSnapshot = {
  schemaVersion: 1;
  revision: number;
  definition: CombSpec;
  definitionDigest: string;
  registry?: { name: string; version: number; digest: string };
  resolvedActionBindings: ResolvedActionBinding[];
  actionBindingDigest: string;
  createdAt: string;
  amendmentId?: string;
};

export type CombSnapshotRef = {
  revision: number;
  definitionDigest: string;
  actionBindingDigest: string;
  createdAt: string;
  amendmentId?: string;
  storageRef: string;
};

export type ActivationAddress = {
  runId: string;
  nodeId: NodeId;
  attempt: number;
  itemIndex: number;
};

export type ActivationId = string;

export type BeeHandleRef = {
  name: string;
  id?: string;
  source: "spawn" | "flight" | "adopted";
  flightLeaseId?: string;
};

export type CombActivationBinding = {
  runId: string;
  nodeId: NodeId;
  attempt: number;
  itemIndex: number;
  taskId: string;
  status: "current" | "historical";
  attachedAt: string;
  trackDigest?: string;
  deliveredAt?: string;
  endedAt?: string;
};

export type EvidenceProducer = {
  kind: "bee" | "forum" | "pollinate" | "engine" | "operator";
  id: string;
};

export type EvidenceEnvelopeBase = {
  schemaVersion: 1;
  id: string;
  activation: ActivationAddress;
  taskId: string;
  subject: ResolvedSubject;
  producer: EvidenceProducer;
  recordedAt: string;
};

export type EvidenceEnvelope = EvidenceEnvelopeBase & {
  kind: "seal" | "session-state" | "forum-verdict" | "clock" | "engine-result" | "agent-report";
  payload: JsonValue | { filename: string; seal: SealRecord };
};

export type EvidenceRef = {
  id: string;
  kind: EvidenceEnvelope["kind"];
  subject: ResolvedSubject;
  producer: EvidenceProducer;
  recordedAt: string;
  payloadDigest: string;
  storageRef: string;
  summary?: JsonObject;
};

export type JoinAggregateOutput = {
  items: Array<{
    activation: ActivationAddress;
    status: "done" | "failed" | "skipped";
    output?: JsonValue;
  }>;
  succeeded: number;
  failed: number;
  skipped: number;
};

export type ActivationStatus = "pending" | "active" | "waiting-human" | "waiting-event" | "done" | "failed" | "skipped";

export type ActivationRecord = {
  id: ActivationId;
  address: ActivationAddress;
  taskId: string;
  cohortId: string;
  nodeSnapshotRevision: number;
  status: ActivationStatus;
  subject: ResolvedSubject;
  claim: ActivationClaim;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  nextEligibleAt?: string;
  beeHandles: BeeHandleRef[];
  evidenceCount: number;
  evidenceTail: EvidenceRef[];
  output?: JsonValue;
  aggregate?: JoinAggregateOutput;
  deviationCount: number;
  deviationTail: JsonObject[];
  incomingEdgeFiringIds: string[];
  activeChildRunIds: string[];
  childRunTail: string[];
  effectKeys: string[];
  packetId?: string;
  packetDigest?: string;
  threadId?: string;
  blockingSince?: string;
  stallNotifiedAt?: string;
  retryContext?: {
    from: ActivationAddress;
    verdict?: "approve" | "request_changes";
    comment?: string | null;
  };
  invalidatedAt?: string;
  invalidatedBy?: ActivationAddress;
  failure?: { code: string; message: string; retryable: boolean };
};

export type EdgeFiring = {
  id: string;
  edgeId: string;
  from: ActivationAddress;
  toNodeId: NodeId;
  cohortId: string;
  subject: ResolvedSubject;
  firedAt: string;
};

export type EffectKind = "agent-spawn" | "agent-adopt" | "forum-create" | "forum-rerequest" | "forum-successor";
export type EffectStatus = "prepared" | "executing" | "confirmed" | "not-executed" | "failed" | "ambiguous";
export type EffectScope = { kind: "activation"; activation: ActivationAddress } | { kind: "run"; runId: string };

export type EffectRecord = {
  key: string;
  scope: EffectScope;
  kind: EffectKind;
  semanticId: string;
  semanticDigest: string;
  fenceEpoch: number;
  status: EffectStatus;
  preparedAt: string;
  executeStartedAt?: string;
  confirmedAt?: string;
  externalRef?: string;
  requestDigest: string;
  result?: JsonValue;
  error?: string;
  verificationEvidenceIds: string[];
};

export type EffectRef = {
  key: string;
  kind: EffectKind;
  status: EffectStatus;
  scope: EffectScope;
  requestDigest: string;
  storageRef: string;
  confirmedAt?: string;
};

export type CancellationFence = {
  epoch: number;
  requestedAt: string;
  requestedBy: string;
  reason?: string;
};

export type RunCleanupRecord = {
  status: "not-required" | "pending" | "blocked-ambiguous" | "complete";
  startedAt?: string;
  completedAt?: string;
  pendingEffectKeys: string[];
  pendingSubscriptionIds: string[];
  pendingObservationWatchIds: string[];
  pendingPacketIds: string[];
  pendingBeeNames: string[];
  pendingChildRunIds: string[];
};

export type RunOrigin =
  | { kind: "manual"; actor: string }
  | { kind: "trigger"; triggerId: string; deliveryId: string; eventId?: string }
  | { kind: "attached"; beeName: string; entryNodeId: NodeId }
  | { kind: "ad-hoc"; actor: string };

export type ReviewFeedbackDestination =
  | { type: "bee"; sessionId: string }
  | { type: "new-agent" }
  | { type: "pr-comment" };

export type ForumPacketVerdict = {
  packet_id: string;
  verdict: "approve" | "request_changes";
  comment: string | null;
  destination: ReviewFeedbackDestination;
  actor: string;
  definition_digest: string | null;
  action_binding_digest: string | null;
  subject_revision: string | null;
  recorded_at: string;
};

export type ForumPacket = {
  id: string;
  title: string;
  status: "needs_review" | "in_review" | "changes_requested" | "approved" | "resolved" | "superseded" | "archived";
  kind: string;
  origin: string;
  cwd: string | null;
  summary: string | null;
  checklist: JsonValue[];
  native_session_id: string | null;
  blocking_since: string | null;
  run_id: string | null;
  comb_name: string | null;
  base_rev: number | null;
  proposed_rev: number | null;
  graph_base: string | null;
  graph_proposed: string | null;
  definition_digest: string | null;
  action_binding_digest: string | null;
  subject_revision: string | null;
  verdict: ForumPacketVerdict | null;
  [key: string]: JsonValue | ForumPacketVerdict | undefined;
};

export type HumanPacketRef = {
  packetId: string;
  predecessorPacketId?: string;
  successorPacketId?: string;
  snapshotRevision: number;
  definitionDigest: string;
  actionBindingDigest: string;
  subject: ResolvedSubject;
  status: "current" | "superseded" | "withdrawn";
  createdAt: string;
  supersededAt?: string;
};

export type HumanPacketThread = {
  key: string;
  nodeId: NodeId;
  itemIndex: number;
  packetCount: number;
  packetTail: HumanPacketRef[];
  currentPacketId: string;
  subject: ResolvedSubject;
  createdAt: string;
  updatedAt: string;
};

export type TriggerAssociation = {
  triggerId: string;
  firstDeliveryId: string;
  firstEventId?: string;
  relation: "creator" | "joined-claim";
  associatedAt: string;
};

export type RunStatus = "active" | "failed" | "cancelled" | "done";

export type RunEvent = {
  id: string;
  sequence: number;
  type: string;
  at: string;
  activation?: ActivationAddress;
  data?: JsonObject;
};

export type SubjectClaimRecord = {
  schemaVersion: 1;
  id: string;
  scope: "product-comb" | "product";
  productKey: string;
  combName: string;
  combVersion?: number;
  definitionDigest: string;
  declarationPointer: JsonPointer;
  value: JsonValue;
  valueDigest: string;
  runId: string;
  status: "prepared" | "held" | "released";
  preparedAt: string;
  heldAt?: string;
  releasedAt?: string;
};

export type RunRecord = {
  schemaVersion: 1;
  id: string;
  status: RunStatus;
  origin: RunOrigin;
  triggerAssociations: TriggerAssociation[];
  productKey: string;
  cwd: string;
  input: JsonValue;
  inputDigest: string;
  currentSnapshot: CombSnapshot;
  snapshotHistoryTail: CombSnapshotRef[];
  snapshotRevision: number;
  policies: RunPolicies;
  depth: number;
  rootRunId: string;
  activations: Record<ActivationId, ActivationRecord>;
  nextCohortGeneration: number;
  edgeFiringTail: EdgeFiring[];
  packetThreads: HumanPacketThread[];
  effects: Record<string, EffectRecord>;
  effectTail: EffectRef[];
  cancellation?: CancellationFence;
  cleanup: RunCleanupRecord;
  intakeReady: boolean;
  subjectClaimId?: string;
  subjectClaimReleasedAt?: string;
  originDeliveryRequestDigest?: string;
  output?: JsonValue;
  eventTail: RunEvent[];
  eventsRetainedFrom: number;
  nextEventSequence: number;
  violationCount: number;
  ledgerPublishedThrough: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  failure?: { code: string; message: string; activation?: ActivationAddress };
};

export type RunBoardActivation = {
  id: ActivationId;
  nodeId: NodeId;
  attempt: number;
  itemIndex: number;
  cohortId: string;
  status: ActivationStatus;
  subject: ResolvedSubject;
  beeHandles: BeeHandleRef[];
  packetId?: string;
  packetDigest?: string;
  threadId?: string;
  deviationCount: number;
  evidence: Array<Pick<EvidenceRef, "id" | "kind" | "producer" | "recordedAt" | "summary">>;
  startedAt?: string;
  endedAt?: string;
};

export type RunBoardView = {
  id: string;
  comb?: { name: string; version?: number; digest: string };
  status: RunStatus;
  origin: RunOrigin;
  triggerAssociations: TriggerAssociation[];
  productKey: string;
  depth: number;
  snapshotRevision: number;
  definitionDigest: string;
  actionBindingDigest: string;
  intakeReady: boolean;
  cleanupStatus: RunCleanupRecord["status"];
  activations: RunBoardActivation[];
  activeChildRunIds: string[];
  childRunTail: string[];
  violationCount: number;
  deviationCount: number;
  lastEventSequence: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export type CombCliSuccess<T> = { ok: true; command: string; result: T };
export type CombCliErrorCode =
  | "invalid_argument"
  | "not_found"
  | "version_conflict"
  | "claim_conflict"
  | "ambiguous_activation"
  | "cancelled"
  | "approval_required"
  | "effect_ambiguous"
  | "external_dependency"
  | "corrupt_state";

export type CombCliFailure = {
  ok: false;
  command: string;
  error: { code: CombCliErrorCode; message: string; details?: JsonValue };
};
