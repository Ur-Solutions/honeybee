# Combs engine design

**Status:** implementation design for Combs phase 1  
**Owner:** Honeybee  
**Concept contract:** `apiary/docs/orchestration-graphs-concept.md`, concept v2 (2026-07-21)  
**Replaces:** Honeybee flow v1 as the reusable graph and durable-run engine

This document designs only the Honeybee-owned part of Combs: the registry, snapshots, runs, claims, reconciler, executors, checkout integration, and CLI. Pollinate remains the trigger and external-observation owner; Forum remains the packet and verdict owner; Apiary remains a read-model/UI consumer.

The design deliberately evolves existing Honeybee patterns:

- Registry import and TS loading follow `src/flow/index.ts`, but TS is compiled to canonical data at define time instead of storing an executable closure.
- Run persistence uses `storeRoot()`, `atomicWriteFile`, and file locks from `src/fsx.ts` and `src/lock.ts`.
- The daemon integration is one more bounded dispatcher in `src/daemon/tick.ts`, wired once in `src/daemon/wiring.ts`, like flights and checkout pools.
- Agent execution calls `spawnBee` in `src/commands/spawn.ts`; seal and session evidence comes from `src/seal.ts`, `src/store.ts`, and the already-derived `BeeState` map.
- Activation freshness and idempotency reuse `activationKey`, `ActivationClaim`, and `judgeActivationEvidence` from the in-progress `src/activation.ts`. The flight prepare/execute/confirm and deterministic-adoption pattern in `src/flight/controller.ts` is the reference implementation.
- Checkout acquisition evolves `src/pool.ts`; it does not create a second working-copy allocator.
- Human execution consumes the JSON-envelope CLI in Forum's `docs/APIARY_SURFACE.md`.

## 1. Non-negotiable invariants

1. A run's embedded snapshot, not the registry, is its execution truth.
2. A run reaches `done` only from current-attempt, subject-matching evidence. Idle without completion evidence is a stall.
3. Every side effect has a durable effect record before execution. An unconfirmed effect is verified or surfaced as ambiguous; it is never silently replayed.
4. Every run mutation, including agent reports and cancellation, is serialized by the run's file lock and written atomically.
5. Cancellation is a fence checked immediately before every effect. It does not erase evidence or history.
6. External service state enters graph evaluation only through Pollinate observations. Forum packets are the one exception because Forum is itself the executor and source of truth for human nodes.
7. Strict external actions complete only with a matching engine-execution record. Satisfying external state without that record is a violation and fails the run.
8. `deviation` is an activation-history event, never an activation status.
9. Child composition, fan-out, expansion, and ad-hoc graphs all instantiate the same `RunRecord` primitive.
10. The legacy `SessionRecord.combId` is unrelated to Combs and is never reused. `src/store.ts` explicitly marks that field as retired tmux grouping state.

## 2. Data model

All timestamps are UTC ISO-8601 strings. All persisted data is JSON. `JsonPointer` means RFC 6901; it is data selection, not an expression language. Unknown fields are preserved on read/write, while unknown enum variants make that individual record unloadable and visible as an error.

### 2.1 Common value, mapping, subject, and schema types

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonPointer = string; // "" or a valid RFC 6901 pointer beginning with "/"
export type NodeId = string;      // /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export type ValueSource =
  | { source: "literal"; value: JsonValue }
  | { source: "run-input"; pointer: JsonPointer }
  | { source: "item"; pointer?: JsonPointer }
  | { source: "node-output"; nodeId: NodeId; pointer: JsonPointer };

export type ObjectMapping = Record<string, ValueSource>;

export type DataContract =
  | { kind: "informal"; description: string }
  | { kind: "json-schema"; schema: JsonObject };

export type SubjectSpec = {
  kind: string;             // e.g. "git-ref", "pull-request", "issue", "run-input"
  key: ValueSource;         // stable subject identity
  revision: ValueSource;    // exact revision, e.g. head SHA
};

export type ResolvedSubject = {
  kind: string;
  key: string;
  revision: string;
};
```

JSON-schema contracts use draft 2020-12. `src/comb/schema.ts` owns one compiled validator cache and validates run input, seal `output`, human output, engine output, and final comb output. The implementation should add `ajv` as a runtime dependency rather than grow a partial local schema dialect. Informal contracts are displayed and snapshotted but are not machine validation gates.

When a node omits `subject`, instantiation resolves a default subject of `{ kind: "run-input", key: runId, revision: inputDigest }`. Evidence therefore always has a subject revision, even for non-git work.

### 2.2 Authored comb definition

The authored format is declarative and JSON-serializable. TS authoring is only a typed way to produce this object; runtime closures are forbidden.

```ts
export const COMB_DEFINITION_FORMAT = 2 as const;

export type BindingStrength = "strict" | "guided" | "open";

export type JoinPolicy = {
  mode: "all" | "any" | "quorum";
  quorum?: number;            // required only for mode="quorum", integer >= 1
  tolerateFailures?: number;  // default 0, integer >= 0
};

export type CheckoutNeed = {
  pool: string;               // full pool key or cwd-relative unique pool name
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
      | { type: "bee"; nodeId: NodeId }
      | { type: "new-agent" }
      | { type: "pr-comment" };
  };
};

export type PredicateSpec =
  | { kind: "seal-present"; nodeId: NodeId; statuses?: Array<"done" | "blocked" | "needs_input" | "failed">; sealType?: string }
  | { kind: "verdict"; nodeId: NodeId; equals: "approve" | "request_changes" }
  | { kind: "ci-status"; check?: string; equals: "success" | "failure" | "pending" | "error" }
  | { kind: "clock"; afterMs: number; from: "activation-start" | "blocking-since" };

export type ChildCombSource =
  | { kind: "registry"; name: string; version?: number }
  | { kind: "node-output"; nodeId: NodeId; graphPointer: JsonPointer };

export type ChildRunOperation = {
  kind: "child-run";
  comb: ChildCombSource;
  input: ObjectMapping;
  items?: ValueSource; // absent = one child; present value must be an array
  policyOverrides?: Partial<Pick<RunPolicies, "maxAttemptsPerActivation" | "stallMs" | "firstEvidenceMs" | "maxConcurrentActivations">>;
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
  on: "done" | "failed" | "waiting";
  when?: PredicateSpec;
};

export type ClaimDeclaration = {
  inputPointer: JsonPointer;
  collision: "refuse" | "join-existing"; // default "refuse"
};

export type SubscriptionDeclaration = {
  nodeId: NodeId;
  subject: ValueSource;
  eventKinds: string[];
  delivery: "coalesce-latest" | "queue"; // default "coalesce-latest"
};

export type CombSpec = {
  formatVersion: typeof COMB_DEFINITION_FORMAT;
  name: string;
  description?: string;
  input: DataContract;
  output?: DataContract;
  nodes: CombNode[];
  edges: CombEdge[];
  claim?: ClaimDeclaration;
  subscriptions?: SubscriptionDeclaration[];
};
```

Validation rules are part of the format:

- Names and IDs use the existing flow name grammar in `src/flow/index.ts`. Node and edge IDs are unique.
- Every edge endpoint exists. Entry nodes are derived as nodes with no incoming `on: "done" | "failed"` edge; there is no second entry-node list to drift.
- A multi-input node must declare `join`; `all` is filled only when a single-input node omits it. `quorum` requires `1 <= quorum <= incomingEdgeCount`.
- `guided` agent nodes require at least one enumerable expectation. An expectation is evidence heuristic/self-report metadata, not a graph predicate and not an LLM judge.
- Human nodes must be `strict`: Honeybee deterministically emits and waits on the packet even though the verdict itself is human judgment.
- Human nodes have fixed output contract `{ verdict: "approve" | "request_changes", comment: string | null, destination: ReviewFeedbackDestination }` and may not override it.
- Engine predicate and action nodes are `strict`. Child-run nodes are `strict`; expansion judgment lives in the upstream open agent node.
- An edge may carry at most one `when` predicate. More complicated logic is represented as predicate nodes plus joins; there is no expression or Boolean AST.
- `on: "waiting"` is legal only with a `clock` predicate. It fires once per source activation without completing the waiting source, allowing timeout notification/escalation to run in parallel.
- `items`, `ValueSource`, and `ObjectMapping` only select/copy values. They cannot call functions or evaluate code.
- Cycles are legal. Traversing a back-edge creates a new attempt. An acyclic graph is not required.

Brief templates reuse the deliberately small substitution pattern in `src/flow/json.ts`: `{{input.foo}}`, `{{item.foo}}`, and `{{nodes.<nodeId>.output.foo}}`. Missing values remain verbatim and cause activation validation to fail before an effect is prepared. No arbitrary JS or expression syntax is evaluated.

### 2.3 Registry versions and TS authoring

```ts
export type CombVersionProvenance =
  | { kind: "file"; sourcePath: string; sourceDigest: string }
  | { kind: "promoted-run"; runId: string; snapshotRevision: number };

export type StoredCombVersion = {
  schemaVersion: 1;
  name: string;
  version: number;            // monotonically increasing, starts at 1
  digest: string;             // sha256:<hex> of canonical CombSpec JSON
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

export type CombSpecInput = Omit<CombSpec, "formatVersion"> & { formatVersion?: 2 };

export function defineComb(spec: CombSpecInput): CombSpec;
```

`defineComb` is an identity/validation helper like `defineFlow`, but it recursively rejects functions, symbols, `undefined`, bigint, non-finite numbers, and cycles. `hive comb define` loads `.ts` with `src/tsLoader.ts`, takes the default export, validates it, canonicalizes it, and stores immutable JSON. The daemon never imports author TS. Relative-import fragility in flow v1 (`src/flow/index.ts`) therefore does not carry into run execution.

Canonical JSON recursively sorts object keys and preserves array order. The digest excludes registry version/provenance and covers exactly `CombSpec`. Defining an identical digest is a successful no-op returning the existing version. Defining a changed digest appends `version + 1`; `--base-version` provides registry CAS for editors.

### 2.4 Product configuration and snapshotted action bindings

Product identity is resolved by longest cwd-prefix against `ProRepoEntry` in `src/proProjects.ts`, yielding `<area>-<project>-<repo>`. A non-pro cwd must pass `--product <key>` and have a matching config.

```ts
export type BindingTemplate = string; // same {{input.*}}/node-output renderer

export type DeterministicBinding = {
  mechanism: "deterministic";
  execute:
    | { kind: "command"; command: string; args?: BindingTemplate[]; timeoutMs: number }
    | { kind: "builtin"; name: string; options?: JsonObject; timeoutMs: number };
};

export type AgenticBinding = {
  mechanism: "agentic";
  bee: string;
  account?: string;
  model?: string;
  instructions: string;
  timeoutMs: number;
};

export type ActionVerifier =
  | { kind: "process-result"; allowedExitCodes: number[] }
  | { kind: "pollinate-observation"; observationType: string; successValues: JsonValue[] };

export type ActionBinding = {
  intent: "land" | "run";
  version: string; // product-owned semantic version/revision label
  implementation: DeterministicBinding | AgenticBinding;
  verify: ActionVerifier;
};

export type ProductCombConfig = {
  schemaVersion: 1;
  revision: number;
  productKey: string;
  repoRoot?: string;
  actionBindings: Partial<Record<"land" | "run", ActionBinding>>;
  defaultComb?: string;
  defaultCombByTag?: Record<string, string>;
  defaultCombByKind?: Record<string, string>;
  trustedStrictGraphDigests?: string[];
  defaultPolicies?: Partial<RunPolicies>;
  updatedAt: string;
};

export type ResolvedActionBinding = {
  intent: "land" | "run";
  productKey: string;
  bindingVersion: string;
  digest: string; // sha256 of canonical ActionBinding
  binding: ActionBinding;
};
```

At run instantiation Honeybee resolves every action intent used by the definition. A missing binding refuses instantiation. Resolved bindings, including the executable mechanism and verifier, are embedded in snapshot revision 0. Later product-config edits never alter an existing run. An amendment that adds a new intent resolves and embeds that intent while applying the amendment; a patch cannot directly edit `/resolvedActionBindings`.

`hive comb product apply` validates the whole document, takes the product lock, compares `--base-revision` to the stored revision, increments `revision`, stamps `updatedAt`, and commits with atomic rename. A missing `--base-revision` is allowed only when creating revision 1. A mismatch returns `version_conflict`; there is no last-writer-wins path.

`land` bindings must use `pollinate-observation` verification, because process exit alone cannot prove who changed external state or detect an out-of-band landing. `run` may use either verifier. Default track selection precedence is explicit `--comb`, then the first matching `defaultCombByTag` entry in sorted tag order, then `defaultCombByKind`, then `defaultComb`.

### 2.5 Snapshot and policies

```ts
export type CombSnapshot = {
  schemaVersion: 1;
  revision: number; // 0 at instantiation, +1 per applied amendment
  definition: CombSpec;
  definitionDigest: string;
  registry?: { name: string; version: number; digest: string };
  resolvedActionBindings: ResolvedActionBinding[];
  actionBindingDigest: string; // digest of sorted {intent,digest} pairs
  createdAt: string;
  amendmentId?: string;
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
  maxDepth: number;                    // default 2; root depth is 0
  amendmentApproval: "auto" | "human";// default "human" for agent proposals
  retireAgentsOnTerminal: boolean;     // default true
  nodeOverrides?: Record<NodeId, Partial<ActivationPolicyLimits>>;
};
```

Policy defaults are `maxDepth=2`, `maxAttemptsPerActivation=3`, `retryBackoffMs=5_000`, `retryBackoffMaxMs=300_000`, `firstEvidenceMs=240_000`, `stallMs=600_000`, `maxConcurrentActivations=8`, `amendmentApproval="human"`, and `retireAgentsOnTerminal=true`. Policies are resolved product defaults plus explicit run overrides and snapshotted on the run. They are not graph nodes. Child runs inherit the parent policies, then apply the narrow `policyOverrides` whitelist. `maxDepth` cannot be increased by a child.

### 2.6 Activation identity, evidence, output, and deviations

```ts
export type ActivationAddress = {
  runId: string;
  nodeId: NodeId;
  attempt: number;   // 1-based
  itemIndex: number; // 0 for non-fan-out
};

export type ActivationId = string; // `${nodeId}@${attempt}#${itemIndex}`

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
  attachedAt: string;
};

export type EvidenceProducer = {
  kind: "bee" | "forum" | "pollinate" | "engine" | "operator";
  id: string;
};

export type EvidenceEnvelopeBase = {
  schemaVersion: 1;
  id: string;
  activation: ActivationAddress;
  taskId: string; // `${runId}/${nodeId}/${itemIndex}`
  subject: ResolvedSubject;
  producer: EvidenceProducer;
  recordedAt: string;
};

export type EvidenceEnvelope = EvidenceEnvelopeBase & (
  | {
      kind: "seal";
      payload: {
        filename: string;
        seal: import("../seal.js").SealRecord;
      };
    }
  | {
      kind: "session-state";
      payload: {
        beeName: string;
        state: import("../state.js").BeeState;
        sessionStatus: "running" | "dead" | "kill_failed" | "archived";
      };
    }
  | {
      kind: "forum-verdict";
      payload: {
        packetId: string;
        status: "needs_review" | "in_review" | "changes_requested" | "approved" | "resolved" | "superseded" | "blocked" | "archived";
        verdict?: "approve" | "request_changes";
        comment?: string | null;
        destination?: { type: "bee"; sessionId: string } | { type: "new-agent" } | { type: "pr-comment" };
        blockingSince: string;
      };
    }
  | { kind: "observation"; payload: ObservationPayload }
  | {
      kind: "clock";
      payload: {
        basis: "activation-start" | "blocking-since";
        thresholdMs: number;
        dueAt: string;
      };
    }
  | { kind: "agent-report"; payload: AgentReportInput }
  | { kind: "engine-result"; payload: { effectKey: string; result: JsonValue } }
);

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

export type DeviationEvent = {
  id: string;
  activation: ActivationAddress;
  kind: "self-reported" | "missing-expectation" | "unexpected-effect";
  message: string;
  expectationId?: string;
  evidenceIds: string[];
  recordedAt: string;
  recordedBy: EvidenceProducer;
};

export type ActivationStatus =
  | "pending"
  | "active"
  | "waiting-human"
  | "waiting-event"
  | "done"
  | "failed"
  | "skipped";

export type ActivationRecord = {
  id: ActivationId;
  address: ActivationAddress;
  taskId: string;
  nodeSnapshotRevision: number;
  status: ActivationStatus;
  subject: ResolvedSubject;
  claim: import("../activation.js").ActivationClaim;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  nextEligibleAt?: string;
  beeHandles: BeeHandleRef[];
  evidence: EvidenceEnvelope[];
  output?: JsonValue;
  aggregate?: JoinAggregateOutput;
  deviations: DeviationEvent[];
  incomingEdgeFiringIds: string[];
  childRunIds: string[];
  effectKeys: string[];
  checkoutLease?: CheckoutLease;
  packetThreadKey?: string;
  invalidatedAt?: string;
  invalidatedBy?: ActivationAddress;
  failure?: { code: string; message: string; retryable: boolean };
  quiesce?: {
    requestedAt: string;
    mode: "finish" | "retire";
    status: "requested" | "complete";
  };
};
```

The claimant passed to `activationKey` includes `itemIndex`: `claimantId = nodeId + "[" + itemIndex + "]"`. Thus the effect base key is `activationKey(runId, claimantId, attempt)`, for example `01...:review[3]:2`. This is the existing shared helper with a collision-free claimant ID, not a second key algorithm.

Evidence matching composes the shared rule with subject matching:

1. Call `judgeActivationEvidence(activation.claim, { recordedAt, taskId, attempt })`.
2. `none` stays none; `mismatch` records `comb.violation.evidence_mismatch` and fails the run.
3. On `match`, compare both `subject.key` and `subject.revision` with the activation. A mismatch is the same violation, never absence.
4. Only then may the executor-specific matcher inspect `payload`.

`src/activation.ts` currently contains the key/claim/freshness kernel but not subject comparison or a shared activation-record type. `src/comb/evidence.ts` initially provides the thin composition above. If CL.e5b lands an additive shared subject matcher, the comb module imports it and deletes only that wrapper; flight semantics and existing types remain unchanged. This is the required flight/comb coordination point, not a competing activation rule.

Agent completion requires a matching seal whose new optional `SealArtifact.output?: JsonValue` validates against the node output contract. A malformed current seal records evidence, fails that activation with `code: "invalid-output"`, and follows retry/fail-edge policy. It never becomes undefined behavior. A matching `blocked`, `needs_input`, or `failed` seal fails the attempt unless an explicit edge routes it.

### 2.7 Edge firings, subscriptions, human threads, and intent requests

```ts
export type EdgeFiring = {
  id: string;
  edgeId: string;
  from: ActivationAddress;
  toNodeId: NodeId;
  subject: ResolvedSubject;
  firedAt: string;
};

export type ObservationPayload = {
  eventId: string;
  observationType: string;
  subjectKey: string;
  subjectRevision: string;
  observedAt: string;
  value: JsonValue;
  metadata?: JsonObject;
};

export type RunSubscription = {
  id: string;
  nodeId: NodeId;
  subjectKey: string;
  eventKinds: string[];
  delivery: "coalesce-latest" | "queue";
  status: "active" | "cancelled";
  pending: ObservationPayload[];
  seenEventIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type HumanPacketThread = {
  key: string; // `${nodeId}#${itemIndex}`
  nodeId: NodeId;
  itemIndex: number;
  packetIds: string[]; // stale revision creates a successor/replacement
  currentPacketId: string;
  subject: ResolvedSubject;
  createdAt: string;
  updatedAt: string;
};

export type IntentRequestRecord = {
  id: string;
  activation: ActivationAddress;
  intent: "land" | "run";
  mode: "evaluate-once" | "standing";
  requestedAt: string;
  expiresAt?: string;
  status: "pending" | "satisfied" | "expired" | "rejected";
  evaluatedAt?: string;
  reason?: string;
};
```

Subscriptions are node-scoped. `coalesce-latest` keeps at most one pending event per `(subscription, subjectKey)` and supersedes an active activation when the subject revision changes: outstanding human packet becomes `superseded`, activation and downstream evidence are invalidated, and a new attempt is created. `queue` keeps arrival order. `seenEventIds` is bounded to the newest 1,024 IDs; Pollinate is at-least-once and Honeybee deduplicates by `eventId`.

Normal review iteration reuses one Forum packet for a stable subject revision. Revision staleness is the exception: the old packet becomes `superseded`, and Forum `packet successor` (or create if successor is unavailable) supplies a new `currentPacketId`. Comments become the human activation's `output.comment` and are available to downstream brief templates.

### 2.8 Effects, engine-execution records, violations, and cancellation

```ts
export type EffectKind =
  | "agent-spawn"
  | "flight-lease"
  | "agent-adopt"
  | "forum-create"
  | "forum-rerequest"
  | "forum-withdraw"
  | "action-execute"
  | "child-run-create"
  | "checkout-claim"
  | "checkout-release";

export type EffectStatus =
  | "prepared"
  | "executing"
  | "confirmed"
  | "not-executed"
  | "failed"
  | "ambiguous";

export type EffectRecord = {
  key: string; // `${activationBaseKey}:${kind}:${ordinal}`
  activation: ActivationAddress;
  kind: EffectKind;
  ordinal: number;
  fenceEpoch: number;
  bindingDigest?: string;
  status: EffectStatus;
  preparedAt: string;
  executeStartedAt?: string;
  confirmedAt?: string;
  externalRef?: string; // deterministic bee name, lease id, packet id, child run id
  requestDigest: string;
  result?: JsonValue;
  error?: string;
  verificationEvidenceIds: string[];
  resolution?: {
    outcome: "confirmed" | "not-executed" | "failed";
    by: string;
    at: string;
    evidence: JsonValue;
  };
};

export type EngineExecutionRecord = {
  effectKey: string;
  activation: ActivationAddress;
  intent: "land" | "run";
  subject: ResolvedSubject;
  bindingDigest: string;
  preparedAt: string;
  executedAt?: string;
  confirmedAt?: string;
  status: "prepared" | "confirmed" | "failed" | "ambiguous";
};

export type ViolationRecord = {
  id: string;
  activation?: ActivationAddress;
  code:
    | "evidence-mismatch"
    | "idle-without-completion"
    | "external-state-without-engine-record"
    | "strict-graph-unapproved"
    | "cancellation-fence-crossed";
  message: string;
  evidenceIds: string[];
  detectedAt: string;
};

export type CancellationFence = {
  epoch: number; // 0 until cancellation; incremented exactly once for phase 1
  requestedAt: string;
  requestedBy: string;
  reason?: string;
};
```

The controller prepares an effect while holding the run lock, captures `fenceEpoch`, writes the run, releases the lock, executes, then reacquires the lock to confirm. If cancellation advanced the fence meanwhile, the effect becomes `ambiguous` unless its verifier proves it was not executed. No next effect begins.

Recovery rules are executor-specific and deterministic:

- Spawn: derive the same bee name, find the matching session/contract, and adopt it; a different contract is a violation. Absence does not replay the attempt; the attempt is failed after its readiness deadline and retry creates a new attempt/name.
- Flight lease: query the capacity provider by idempotency key and adopt/release the returned lease.
- Forum create/successor/rerequest: use Forum idempotency keys. If Forum cannot replay that mutation, query the packet by source dedupe key before deciding ambiguous.
- Deterministic/agentic action: evaluate the snapshotted verifier. Confirm when matching state exists with this execution record; mark `not-executed` only when the verifier can prove absence. Otherwise require explicit resolution.
- Child run: locate the child by `(parentRunId, parentActivation, effectKey)` and adopt it.
- Checkout: locate the pool claim by owner/effect key.

Manual resolution is itself audited and never deletes the original ambiguity.

### 2.9 Checkout leases

The existing pool record currently understands pending claims tied to a bee. It is extended additively so engine actions and pre-spawn preparation can own a renewable lease:

```ts
export type PoolClaimOwner =
  | { kind: "bee"; beeName?: string }
  | { kind: "comb-activation"; runId: string; activationId: ActivationId; effectKey: string };

export type PoolClaim = {
  id: string;
  member: number;
  path: string;
  owner?: PoolClaimOwner; // absent reads as legacy bee claim
  beeName?: string;       // legacy/read compatibility; new writes also set owner
  claimedAt: string;
  pendingUntil: string;
};

export type CheckoutLease = {
  poolKey: string;
  member: number;
  path: string;
  claimId: string;
  mode: "exclusive" | "shared";
  acquiredAt: string;
  renewAfter: string;
  status: "claimed" | "released" | "ambiguous";
  releasedAt?: string;
};
```

`src/pool.ts` gains claim-by-owner, renew, and release-by-claim-id operations under `withPoolLock`. Agent-node claims bind to the spawned bee and then ordinary cwd-derived occupancy remains truth. Engine/child operations renew the owner claim on each tick until confirmation. Terminal, failed, skipped, quiesce-retired, and cancelled activations release the claim through an idempotent `checkout-release` effect. `exclusive` requires `maxOccupancy === 1`; `shared` respects the existing cap. Phase 1 stays local because `CHECKOUT_POOLS_PRD.md` explicitly leaves remote pools out of scope.

### 2.10 Amendments

```ts
export type JsonPatchOperation =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: JsonValue };

export type AmendmentRecord = {
  id: string;
  baseRevision: number;
  patch: JsonPatchOperation[];
  proposedBy: { kind: "agent" | "human"; id: string };
  proposedAt: string;
  status: "proposed" | "awaiting-approval" | "quiescing" | "applied" | "rejected" | "conflict";
  approvalRequired: boolean;
  approvalPacketId?: string;
  affectedNodeIds: NodeId[];
  quiesceActivationIds: ActivationId[];
  resultingRevision?: number;
  resultingDigest?: string;
  resolvedAt?: string;
  reason?: string;
};
```

Only `add`, `remove`, and `replace` are accepted, and every path is rooted at `/definition`. Applying a patch to a node with any `done` activation is rejected. Affected `active`/waiting activations enter `quiesce`: the controller prepares no new effects for them; `finish` waits for current bees/effects, while `retire` cancels/retires them and records that decision. CAS is checked again after approval and quiescence. A mismatch sets `conflict` and returns the current revision/digest; the proposer must rebase.

Removing a human node, changing it away from `executor: "human"`, removing all paths through it, or adding a bypass from its predecessors to successors always requires an amendment packet. Agent proposals follow `RunPolicies.amendmentApproval`; human proposals may apply automatically except for the same gate-removal rule. Adding an untrusted strict action also requires an approval packet.

### 2.11 Subject claims and run record

```ts
export type SubjectClaimRecord = {
  schemaVersion: 1;
  id: string; // sha256 of comb name + inputPointer + canonical selected value
  combName: string;
  declarationPointer: JsonPointer;
  value: JsonValue;
  valueDigest: string;
  runId: string;
  status: "prepared" | "held" | "released";
  preparedAt: string;
  heldAt?: string;
  releasedAt?: string;
};

export type RunOrigin =
  | { kind: "manual"; actor: string }
  | { kind: "trigger"; triggerId: string; deliveryId: string }
  | { kind: "child"; parentRunId: string; parentActivation: ActivationAddress; effectKey: string }
  | { kind: "attached"; beeName: string; entryNodeId: NodeId }
  | { kind: "ad-hoc"; actor: string };

export type RunStatus = "active" | "failed" | "cancelled" | "done";

export type RunEvent = {
  id: string;       // `${runId}:${sequence}`
  sequence: number;
  type: string;     // `comb.*` vocabulary below
  at: string;
  activation?: ActivationAddress;
  data?: JsonObject;
};

export type RunRecord = {
  schemaVersion: 1;
  id: string;
  status: RunStatus;
  origin: RunOrigin;
  productKey: string;
  cwd: string;
  input: JsonValue;
  inputDigest: string;
  snapshots: CombSnapshot[]; // revision 0 and every applied revision, embedded
  snapshotRevision: number;
  policies: RunPolicies;
  depth: number;
  rootRunId: string;
  parentRunId?: string;
  childRunIds: string[];
  activations: Record<ActivationId, ActivationRecord>;
  edgeFirings: EdgeFiring[];
  subscriptions: RunSubscription[];
  packetThreads: HumanPacketThread[];
  effects: Record<string, EffectRecord>;
  engineExecutions: EngineExecutionRecord[];
  intentRequests: IntentRequestRecord[];
  amendments: AmendmentRecord[];
  violations: ViolationRecord[];
  subjectClaimId?: string;
  cancellation?: CancellationFence;
  output?: JsonValue;
  events: RunEvent[];
  nextEventSequence: number;
  ledgerPublishedThrough: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  failure?: { code: string; message: string; activation?: ActivationAddress };
};
```

Claim acquisition is prepare/confirm under the claim lock: allocate `runId`, persist a `prepared` claim, create the run, then mark the claim `held`. A crash repair treats a prepared claim with an existing matching run as held; a prepared claim without a run is releasable after the normal file-lock stale interval. `join-existing` returns the held run. If the incoming request contains a trigger/router event, it is delivered to a matching run subscription before returning. Claims release on every terminal run status.

### 2.12 Storage layout and format versioning

```text
~/.hive/combs/
  definitions/
    <comb-name>/
      index.json
      .lock
      versions/
        000001.json
        000002.json
      sources/
        000001.json | 000001.ts
  products/
    <product-key>.json
    .<product-key>.lock
  claims/
    <sha256>.json
    .<sha256>.lock
  runs/
    <run-id>/
      run.json
      .lock
  .runs-index.lock
```

`run.json` is the complete run truth, including all snapshot revisions and effect claims. This makes cancellation, amendment CAS, edge firing, and effect preparation one atomic aggregate update. Run sizes for the 40–60-agent target remain comfortably within the existing JSON-file model; evidence payloads must contain references/digests rather than raw diffs or transcripts.

Run IDs reuse the sortable allocator in `src/flow/runs.ts`: 13 Crockford-base32 timestamp characters, `-`, then four random hex characters. Comb lookup is global under `combs/runs`, so the same ID never needs a definition-name qualifier.

The registry mirrors flow v1's file-backed authoring and provenance, but immutable version files replace mutable `<name>.json|.ts`. Sources are inspection aids only. Runs live under one global runs root so lookup never scans every definition as `src/flow/runs.ts` currently does.

Every persisted top-level type has an independent `schemaVersion`. Readers normalize older supported versions and preserve unknown fields. A newer unsupported version is listed as `unreadable` by inventory commands and is never silently skipped. Format migrations write a sibling temp file, validate it, then use `atomicWriteFile`/rename; original version files are immutable.

`RunEvent` history is authoritative. After each successful run write, the store publishes any event after `ledgerPublishedThrough` through `appendLedger`. A crash may duplicate a global ledger projection; every projection includes deterministic `eventId`, `run`, and `sequence`, so Pollinate/Apiary deduplicate. The run record advances `ledgerPublishedThrough` only after append succeeds.

## 3. Engine behavior

### 3.1 Instantiation

`instantiateRun` performs these steps in order:

1. Load a requested immutable registry version or validate an ad-hoc graph. Compute/verify its digest.
2. Validate input and resolve product identity, policies, subject claim value, and every used action binding.
3. Enforce parent depth before any claim/effect. Child depth is `parent.depth + 1`; default maximum is 2.
4. For agent-authored ad-hoc/expansion graphs containing strict action nodes, compare the definition digest with `trustedStrictGraphDigests`. If untrusted, create the run but block strict execution behind an approval packet.
5. Acquire the engine-owned subject claim with the prepared/held protocol.
6. Write snapshot revision 0 and the initial `RunRecord`. Create attempt 1/item 0 `pending` records for entry nodes. Fan-out item activations are created when their item list resolves.
7. For `origin.kind === "attached"`, validate the entry node is an agent node, bind the existing live bee to its first activation, append the track/contract postscript, and do not create a spawn effect.
8. Return after durable creation. The daemon drives all effects; `hive comb run` does not host a foreground engine process.

### 3.2 One level-triggered daemon sweep

`createCombSweeper()` follows the injected dependency structure of `src/flight/controller.ts`. One `sweepCombs(records, observed)` call:

1. Lists `active` runs and loads each under a short read.
2. Gathers shared evidence in batches: current session records/states, latest seals for bound bees, one `forum packet list --json` result for all live packet IDs, queued Pollinate observations already stored on runs, and current clock.
3. Under each run lock, ingests new evidence envelopes and deduplicates by evidence/event ID.
4. Recomputes each activation from the snapshot and evidence:
   - stale evidence is ignored;
   - correlation or subject mismatch records a violation and fails the run;
   - current valid evidence derives status/output;
   - idle without a seal after `stallMs` records a stall violation/failure, never `done`;
   - invalid output follows retry/fail-edge rules;
   - deviation checks append history without changing status by themselves.
5. Evaluates waiting clock edges, terminal edges, join readiness, aggregate output, and skipped branches. Each edge firing is stored once by `(edgeId, source ActivationAddress)`.
6. Creates new attempts for back-edges/retries. A new attempt invalidates prior downstream activations/evidence for that subject lineage, but preserves their records/history.
7. Reconciles amendments and cancellation before planning effects.
8. Plans effects for eligible activations, respecting `maxConcurrentActivations`, checkout availability, retry `nextEligibleAt`, approval gates, and the cancellation fence. It persists all prepares, releases the lock, and executes through injected executors.
9. Reacquires the lock per result to confirm/fail/mark ambiguous, then recomputes terminal run status and output.
10. Cascades terminal cancellation/failure policy to child runs, releases claims/checkouts/flight leases, retires owned bees when configured, withdraws packets, and publishes run events.

The dispatcher is bounded by the existing `dispatchMs` timeout and returns `CombSweepOutcome[]`. Like flights, an error for one run becomes an outcome; it does not abort the whole tick. The daemon remains strictly serialized as documented in `src/daemon/run.ts`.

### 3.3 Join and attempt semantics

- `all`: activate when every required incoming branch for the current subject lineage has produced a successful firing, unless failures exceed `tolerateFailures`.
- `any`: activate on the first successful firing; unresolved sibling paths become `skipped` for that join cohort.
- `quorum(n)`: activate at `n` successes. Fail when remaining possible successes cannot reach `n` or failures exceed tolerance.
- Every joining activation receives `JoinAggregateOutput`, even if the node also produces its own executor output; its executor output is stored in `output`, aggregate in `aggregate`.
- A fail-edge traversal increments the destination node's attempt relative to its greatest existing attempt for that item. It never overwrites attempt 1.
- Fan-out creates item indices in source-array order. Each item gets its own activation and child run. Reordering in a later subject revision invalidates the old cohort and creates a new attempt; indices are not reused within an attempt.

### 3.4 Executors

#### Agent

Cold spawn derives name `comb-<run-id-suffix>-<safe-node>-i<item>-a<attempt>`, prepares `agent-spawn`, and calls `spawnBee` with:

- HSR by default, unless snapshot capacity says local tmux;
- node checkout path as `cwd` when claimed;
- `contract: { completion: "seal", taskId, attempt }`;
- `spawnedById` from the attaching/origin bee when there is one;
- a brief containing rendered work, guided expectations, downstream constraints, and the deterministic completion contract from `src/contract.ts`.

After a crash, the deterministic name plus contract identifies the exact bee for adoption. A name collision with different run/activation metadata is a violation.

Flight capacity uses the same activation/effect record but delegates acquisition to the flight capacity-provider interface in cross-system assumption 1. Honeybee never edits slot files from the comb controller.

Attached/adopted execution validates the bee is nonterminal, creates an `agent-adopt` record (a durable association, not a spawn), appends the track postscript, and stores an activation reference on `SessionRecord.combActivations`. One bee may have multiple references; agent commands must resolve exactly one or require explicit addressing.

#### Human

The first stable-revision attempt prepares `forum-create`, calls `forum packet create` with a deterministic source dedupe key `comb:<runId>:<nodeId>:<itemIndex>:<subjectRevision>`, and confirms the returned packet ID. The activation derives `waiting-human` from the confirmed packet and current Forum status.

For a stable subject revision, a later attempt updates review fields as needed, transitions `changes_requested -> needs_review`, and calls idempotent `rerequest`. Feedback is read, not written, by Honeybee. `approve` produces `{ verdict: "approve", comment, destination }`; `request_changes` produces the corresponding output and fail-edge context. Subject movement supersedes the old packet and creates an idempotent Forum successor.

#### Engine predicate

Predicate execution has no external effect:

- `seal-present` examines only a referenced current activation's matching seal evidence.
- `verdict` examines only a referenced human activation's current output.
- `ci-status` examines only a Pollinate observation matching subject key/revision and optional check name.
- `clock` is derived from `activation-start` or Forum `blocking_since`; the engine writes one clock evidence envelope when the threshold is reached.

Absent evidence leaves the activation `waiting-event`. A mismatch is a violation.

#### Engine action

The action executor loads the binding by snapshotted digest, claims any checkout, writes both `EffectRecord` and `EngineExecutionRecord`, and only then executes. Deterministic commands use `execFile`-style argv execution, not a shell interpolation. Builtins are registered by name in code. Agentic mechanisms spawn a single-purpose HSR bee with the same activation contract; they remain an engine-owned strict action.

Confirmation applies the snapshotted verifier. For `pollinate-observation`, matching current external state plus this prepared engine record confirms. Matching external state without the record triggers `external-state-without-engine-record`, fails the run, and alarms through `comb.violation`. It is never converted to normal completion.

#### Child run

The executor resolves a registry definition or validates the upstream agent-authored graph, maps input, enforces depth/approval/claim rules, and calls the normal instantiator with `origin.kind = "child"`. The parent activation waits on child terminal output. Fan-out repeats exactly this primitive per item index and aggregates through its declared join.

### 3.5 Cancellation and ambiguity

`cancelRun` sets the fence and run status `cancelled` under the run lock before attempting cleanup. Subsequent ticks:

- retire owned activation bees through the existing kill path;
- release flight leases and checkout claims;
- mark subscriptions cancelled so later observations are logged/ignored;
- archive outstanding Forum packets;
- recursively fence nonterminal child runs;
- classify prepared/executing, unconfirmed actions as `ambiguous` and invoke their verifier;
- record late evidence as `comb.evidence.late_cancelled`, without state effect.

An ambiguous effect blocks the relevant activation and makes the run `failed` unless verification resolves it. `hive comb effect resolve` can provide a human decision, but cannot turn an external strict action without an engine record into a success; that case remains a violation.

### 3.6 Enforcement and guided conformance

Strict execution in phase 1 is detection-and-alarm. The engine records that it prepared and performed strict work; Pollinate supplies external facts. If facts show a working bee landed code before the strict `land` record, the run fails with a violation. Capability isolation/scoped credentials are a future destination and are not claimed here.

Agent-authored ad-hoc/expansion graphs with strict actions remain active but blocked before the strict node until an approval packet approves the exact definition digest plus action-binding digest. A product may pre-authorize exact definition digests. An amended digest is a new shape and must be approved again unless separately trusted.

Guided nodes compare their enumerable expectations with self-reports and structured seal evidence only. Missing expectations create `missing-expectation` deviations. There is no LLM route judge in phase 1.

## 4. Module layout

### 4.1 New files

| File | Responsibility |
|---|---|
| `src/comb/types.ts` | All persisted/public types and constants above. |
| `src/comb/schema.ts` | Comb normalization/validation, JSON-schema validation, JSON Pointer/value mapping, template validation. |
| `src/comb/canonical.ts` | Stable JSON canonicalization and SHA-256 digests. |
| `src/comb/sdk.ts` | Public `defineComb` identity helper and type exports; no runtime effects. |
| `src/comb/registry.ts` | Immutable version/index CRUD, TS/JSON import, define CAS, promote-from-snapshot. Evolves `src/flow/index.ts`. |
| `src/comb/productConfig.ts` | Product resolution through `src/proProjects.ts`, binding/default policy loading, binding digest resolution. |
| `src/comb/store.ts` | Run/claim paths, run locks, normalization, atomic mutation, inventory, event projection. |
| `src/comb/claims.ts` | Atomic subject claim prepare/confirm/release/join-existing repair. |
| `src/comb/evidence.ts` | Shared activation-rule adapter, subject matching, batched seal/session/Forum/observation ingestion. |
| `src/comb/machine.ts` | Pure activation/edge/join/attempt/terminal planner. No I/O. |
| `src/comb/controller.ts` | Level-triggered run sweep and prepare/execute/confirm orchestration with injected dependencies. |
| `src/comb/amendments.ts` | Patch validation, affected-node analysis, gate-removal detection, CAS/quiesce/apply. |
| `src/comb/checkout.ts` | Pool claim/renew/release adapter returning `CheckoutLease`. |
| `src/comb/forum.ts` | `forum` CLI adapter and strict JSON-envelope validation. |
| `src/comb/flightCapacity.ts` | Adapter to the flight capacity-provider interface; no direct slot-store writes. |
| `src/comb/executors/agent.ts` | Cold spawn, deterministic adoption, attached bee association, flight lease. |
| `src/comb/executors/human.ts` | Packet create/update/rerequest/supersede/withdraw. |
| `src/comb/executors/engine.ts` | Fixed predicates, action-binding execution/verification, enforcement records. |
| `src/comb/executors/child.ts` | One child-run primitive for composition/fan-out/expansion. |
| `src/commands/comb.ts` | Entire `hive comb ...` command family and JSON envelopes. |
| `src/daemon/combSweep.ts` | Production dependency wiring, parallel to `src/daemon/flightSweep.ts`. |
| `tests/comb-*.test.ts` | Focused unit/integration tests listed in section 7. |

### 4.2 Changed files

| File | Change |
|---|---|
| `src/activation.ts` | Prefer no breaking change. Import existing helpers. Add only a shared subject matcher if CL.e5b lands the agreed additive boundary. |
| `src/daemon/tick.ts` | Add `sweepCombs?: CombSweeper`, `combSweeps: CombSweepOutcome[]`, and one dispatcher before flights/pools so comb cancellation/leases settle before pool refresh. |
| `src/daemon/wiring.ts` | Build `createCombSweeper()` once. |
| `src/daemon/timeouts.ts` | Add a separately configurable `combMs` only if `dispatchMs` proves insufficient in integration tests; phase-1 default uses `dispatchMs`. |
| `src/cli.ts` | Dispatch `comb`, add help, preserve one-shot `run` unchanged. |
| `src/completion/tables.ts` | Complete comb subcommands, names, run IDs, node IDs, and flags. |
| `src/commands/spawn.ts` | Parse `--comb`, instantiate/attach after the bee record exists, roll back the bee association on failure; accept comb activation metadata in programmatic spawn. |
| `src/store.ts` | Add `combActivations?: CombActivationBinding[]` to `SessionRecord` and its allow-list/normalizer. Do not touch legacy `combId`. |
| `src/seal.ts` | Add/validate optional JSON `output`; keep Seal v2 fields additive. |
| `src/pool.ts` | Add claim owner, renew, lookup-by-owner, and idempotent release while preserving legacy claim reads. |
| `src/commands/flow.ts` | Legacy labeling and `hive flow migrate` entry; no aliasing to comb execution. |
| `src/flow/*` | Retained for legacy registered flows during transition, then narrowed to converter/compatibility support. |
| `src/loop/control.ts`, `src/loop/flow.ts`, `src/loop/spawn.ts` | Extract loop's detached driver dependency from flow v1 before any flow runtime removal; keep loop behavior unchanged. |
| `package.json` | Export the comb SDK and add the JSON-schema validator dependency. |
| `docs/HIVE_CLI_REFERENCE.md` | Document comb commands/envelopes and mark flow v1 legacy. |

No pane grouping or new tmux surface is introduced. HSR control continues through existing spawn/send/observe machinery. Apiary consumes CLI JSON and ledger/run files; it does not get a Honeybee workflow-state IPC channel.

## 5. Surfaces

### 5.1 CLI namespace

The existing one-shot `hive run`/`hive x` behavior remains untouched. All graph-run operations live under `hive comb`.

```text
hive comb list [--json]
hive comb define <file.json|file.ts> [<name>] [--base-version <n>] [--json]
hive comb inspect <name> [--version <n>] [--json]
hive comb promote <run-id> --name <name> [--base-version <n>] [--json]
hive comb product show <product-key> [--json]
hive comb product apply <config.json> [--base-revision <n>] [--json]

hive comb run <name> [--version <n>] --input <file|-> [--cwd <path>]
              [--product <key>] [--collision refuse|join-existing] [--json]
hive comb run --graph <file|-> --input <file|-> [--cwd <path>]
              [--product <key>] [--json]
hive comb runs [--comb <name>] [--status active|failed|cancelled|done] [--json]
hive comb status [<run-id>] [--json]
hive comb cancel <run-id> [--reason <text>] [--json]

hive comb adopt <bee> --comb <name> [--version <n>] --input <file|->
                [--entry <node-id>] [--json]
hive spawn <bee> --comb <name> [--comb-input <file|->] [normal spawn flags...]

hive comb report [--run <id>] [--node <id>] [--attempt <n>] [--item-index <n>]
                 [--from <report.json>] [--deviation <text>] [--json]
hive comb request --intent land|run [--run <id>] [--node <id>]
                  [--ttl <duration>] [--json]
hive comb propose-amendment <run-id> --from <patch.json> --base-rev <n> [--json]

hive comb observe <run-id> --node <node-id> --from <observation.json> [--json]
hive comb effect resolve <run-id> <effect-key>
                  --outcome confirmed|not-executed|failed --from <evidence.json> [--json]

hive comb migrate-flow <flow-name> --out <comb.json> [--json]
```

`--input` is always a single JSON value, not repeated `key=value`. `-` reads stdin. `--graph -` and `--input -` cannot both read the same stdin; one of them must be a file. `--collision` may only override a definition that declared a claim, and may make behavior stricter (`join-existing -> refuse`) but never weaker (`refuse -> join-existing`) without editing/versioning the comb.

When `hive spawn --comb` omits `--comb-input`, Honeybee supplies `{ "bee": { "name": <name>, "id": <id-or-null>, "cwd": <cwd> } }`. Instantiation fails visibly if that value does not satisfy the comb's input contract. `hive comb adopt` requires explicit `--input` because an already-running bee may need domain context beyond its session record.

`hive comb status` without an ID resolves `SessionRecord.combActivations`. Zero matches is an error; one is selected; multiple produce `ambiguous_activation` and list candidates. The same rule applies to agent `report` and `request`. Explicit flags always win. Capability-bound environment variables may supply an exact activation to engine-spawned bees, but are not trusted without matching the session binding.

`report` accepts this file shape and rejects a `status` field:

```ts
export type AgentReportInput = {
  claims?: Array<{ kind: string; ref: string; summary?: string }>;
  expectationIds?: string[];
  deviation?: string;
};
```

Completion still comes from a matching typed seal, never from `report`.

### 5.2 JSON envelopes

Every `hive comb ... --json` invocation writes exactly one envelope to stdout. Human diagnostics go to stderr. Success exits 0; error exits nonzero.

```ts
export type CombCliSuccess<T> = {
  ok: true;
  command: string; // e.g. "comb.run"
  result: T;
};

export type CombCliFailure = {
  ok: false;
  command: string;
  error: {
    code:
      | "invalid_argument"
      | "not_found"
      | "version_conflict"
      | "claim_conflict"
      | "ambiguous_activation"
      | "cancelled"
      | "approval_required"
      | "effect_ambiguous"
      | "external_dependency";
    message: string;
    details?: JsonValue;
  };
};
```

Exact principal results:

```ts
// comb.define / comb.promote
{ comb: StoredCombVersion; created: boolean }

// comb.inspect
{ comb: StoredCombVersion }

// comb.product.show / comb.product.apply
{ config: ProductCombConfig; updated: boolean }

// comb.run / comb.adopt
{ run: RunView; joinedExisting: boolean }

// comb.list
{ combs: CombRegistryIndex[] }

// comb.runs
{ runs: RunSummary[] }

// comb.status
{ run: RunView }

// comb.cancel
{ runId: string; status: "cancelled"; fence: CancellationFence }

// comb.report
{ runId: string; activation: ActivationAddress; evidenceIds: string[]; deviationIds: string[] }

// comb.request
{ request: IntentRequestRecord }

// comb.observe
{ runId: string; subscriptionId: string; accepted: boolean; coalescedEventId?: string }

// comb.propose-amendment
{ amendment: AmendmentRecord; currentRevision: number; currentDigest: string }

// comb.effect.resolve
{ runId: string; effect: EffectRecord }

// comb.migrate-flow
{ sourceFlow: string; outputPath: string; comb: CombSpec; warnings: string[] }
```

`RunSummary` is a stable projection, not the on-disk header:

```ts
export type RunSummary = {
  id: string;
  comb?: { name: string; version?: number; digest: string };
  status: RunStatus;
  origin: RunOrigin;
  productKey: string;
  depth: number;
  activeActivations: number;
  waitingHuman: number;
  violations: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export type RunView = RunRecord & {
  currentSnapshot: CombSnapshot;
};
```

Large event streams use the existing `hive events --json` JSONL surface. New event types are:

```text
comb.defined
comb.promoted
comb.run.started|done|failed|cancelled
comb.activation.pending|active|waiting_human|waiting_event|done|failed|skipped
comb.edge.fired
comb.deviation
comb.evidence.recorded|late_cancelled
comb.effect.prepared|confirmed|failed|ambiguous|resolved
comb.claim.prepared|held|joined|released
comb.subscription.coalesced|queued|cancelled
comb.amendment.proposed|awaiting_approval|quiescing|applied|rejected|conflict
comb.violation
```

Every projected event includes `eventId`, `run`, `sequence`, `ts`, and optional activation fields.

### 5.3 Spawn-time track pane/brief contract

`hive spawn --comb` first performs the ordinary spawn and durable `SessionRecord` write, then creates an attached run and binds its entry activation to that bee. If attachment fails, the bee remains a normal visible bee and the command exits nonzero with the run error; it is not silently killed.

The bee receives this deterministic postscript after the user's brief and completion-contract text:

```text
--- TRACK (hive comb) ---
Run: <runId>
Activation: <nodeId> attempt <attempt> item <itemIndex>
Expected route: <guided expectations, or destination for open>
Do not execute strict downstream intents (<comma-separated intents>).
When your work is complete, seal with taskId "<taskId>" and attempt <attempt>.
Review, human verification, and landing are driven by the track after your seal.
Inspect position: hive comb status <runId>
```

Adoption sends the same postscript over existing delivery machinery. There is no pane control protocol; the bee experiences context, not graph control.

## 6. Migration

### 6.1 Flow v1 registry and run records

Flow v1 currently stores mutable definitions at `~/.hive/flows/<name>.json|.ts`, source provenance beside them, and per-definition runs below `~/.hive/flows/<name>/runs` (`src/flow/index.ts`, `src/flow/runs.ts`). Combs replaces all three concepts:

| Flow v1 | Comb replacement |
|---|---|
| Mutable name file | Immutable `StoredCombVersion` + registry index |
| Executable TS `run(ctx)` | Declarative TS/JSON `CombSpec`, canonicalized to JSON at define time |
| Sequential JSON op closure | Typed nodes/edges executed by daemon reconciliation |
| Foreground/background child process | Durable daemon-driven `RunRecord` |
| PID/PGID cancellation | Run cancellation fence + executor cleanup |
| Flow-local BeeHandle bindings | Activation-scoped `beeHandles` |
| Process return value | Typed terminal node/run output |
| `running|ok|failed|cancelled|orphaned` | `active|done|failed|cancelled`; daemon death does not orphan runs |

Existing v1 definitions and run directories are never rewritten. During migration:

1. `hive flow` remains operational and is labelled `legacy flow v1` in help/output. Existing automations do not break.
2. New docs, Pollinate actions, and Apiary authoring target `hive comb` only.
3. `hive comb migrate-flow` reads declarative JSON flows and writes a proposed comb file; it never auto-defines. Operators inspect and define it explicitly.
4. Arbitrary TS flows cannot be safely translated because their closures may branch, call external modules, or perform undeclared effects. The command returns `unsupported_ts_flow` with a re-authoring skeleton.
5. Once all stored v1 definitions/triggers are migrated, `hive flow` disappears from top-level help but handlers remain for historical inspection/execution until a separately announced removal. It is never aliased to `hive comb`, because their execution and safety semantics differ.

### 6.2 Declarative op conversion

The converter handles only semantics it can preserve:

- `spawn` + subsequent `brief`/`send` + `waitForSeal` for the same binding becomes one strict agent node with a seal output boundary.
- Independent sequential spawn groups become sequential strict agent nodes. The converter does not infer parallelism.
- `return` becomes the terminal output mapping.
- `cleanup: kill-on-end` becomes `retireAgentsOnTerminal: true`; `keep` becomes false.
- `log` becomes a migration note; run state transitions already ledger themselves.
- `wait` is rejected unless it has an explicit timeout that can become a `clock` edge. Idle can no longer mean completion.
- `kill` and `seal` are rejected for manual redesign: cancellation/resource cleanup belongs to engine policy, and agent output must originate in that activation's own matching seal.
- Placeholder substitutions are converted only when they resolve to run input or a prior node's output/bee handle. Unresolved placeholders reject conversion.

All converted nodes are strict, preserving the deterministic-flow interpretation from the concept.

### 6.3 Pollinate transition

Pollinate currently has `HoneybeeAction { run: "flow" }` and shells to `hive flow run` in its `src/types.ts`/`src/actions.ts`. It adds `run: "comb"`, invokes `hive comb run ... --json`, and stores the returned run ID as its binding target. Existing `run: "flow"` triggers continue unchanged until their definitions migrate. Router targets become run IDs for comb actions, not bee names.

### 6.4 Loop facade

The existing `hive loop` is a built-in TS flow whose stop surface includes command predicates, pane sentinels, and judge agents (`src/loop/control.ts`, `src/loop/stopConditions.ts`). Those cannot be represented honestly with the fixed phase-1 predicate vocabulary.

Therefore phase 1 does not pretend to convert it. Before flow-v1 runtime removal, its detached process host, `BeeHandle`, and minimal facade are extracted into loop-owned/shared modules so `hive loop` behavior remains unchanged. It is a compatibility facade, is not a Comb registry entry, and does not appear on the Flightboard as a run. A future loop-to-comb change requires either removing unsupported stop modes or an explicit concept decision expanding predicate vocabulary; this design does neither.

## 7. Staged build plan

Each slice is independently mergeable, testable, and disabled from effects until its final step.

1. **Formats, SDK, and immutable registry.** Add types, canonicalization, schemas, JSON/TS `define`, list/inspect, product config, binding resolution, and promote-from-synthetic-snapshot tests. No daemon change.
2. **Durable run/claim store and read surfaces.** Add run IDs, atomic run mutation, subject claim prepare/confirm/join/release, snapshot revision 0, run/runs/status/cancel JSON surfaces. Runs can be instantiated but a feature flag keeps execution disabled.
3. **Pure reconciler.** Implement activation evidence matching, attempts, edge firing, waiting clock edges, joins, aggregate output, retries, terminal derivation, event projection, and property tests. Add daemon dispatcher with fake/no-op effect executors.
4. **Agent and attached-track execution.** Add deterministic cold spawn/adoption, completion contracts, seal `output`, SessionRecord activation bindings, `spawn --comb`, `comb adopt`, `report`, and cancellation retirement. Enable agent-only combs.
5. **Checkout and flight capacity.** Extend pool claim ownership/renewal/release; wire per-node checkout needs. Integrate the flight capacity-provider interface when available. Cold spawn remains the supported fallback only when the definition explicitly asked for spawn; a failed flight lease is not silently converted.
6. **Engine predicates and action bindings.** Add fixed predicates, intent requests, deterministic/agentic binding executors, engine-execution records, verifiers, strict external-state violation detection, cancellation ambiguity, and manual effect resolution. Enable trusted registry combs with actions.
7. **Forum human nodes and strict-graph approvals.** Land the Forum/review-desk prerequisites, add packet lifecycle adapter, human output/context, stale successor behavior, approval packets, and gate-removal enforcement.
8. **Amendments and child runs.** Add JSON patch CAS/quiesce, one child primitive, fan-out/item activations, depth/cancellation inheritance, and promote-from-live-run.
9. **Pollinate observations/subscriptions.** Add `comb observe`, coalesce/queue behavior, CI evidence, subject supersession, Pollinate run targets, and router cancellation handling.
10. **Flow migration and documentation.** Ship JSON converter, extract loop's legacy runtime dependency, label `hive flow` legacy, update CLI reference/completions, and migrate first-party Pollinate flow actions.

The execution feature flag is removed only after slices 1–9 pass full test/build and at least one manual attached track verifies packet rejection/iteration/approval/land in a disposable repo.

## 8. Test plan

The repository's existing `node:test` style and dependency injection are retained. Every logic branch below receives unit or integration coverage.

### 8.1 Unit tests

- Comb grammar: IDs, endpoints, joins, cycles, guided expectations, engine strictness, waiting clock edges, child sources, input/output schemas, and function rejection in TS exports.
- Canonicalization/digests: object-order independence, array-order significance, duplicate define no-op, registry CAS, immutable prior versions, source provenance.
- Value mapping/templates: every source root, JSON Pointer escaping, missing values, item mapping, no expression evaluation.
- Product resolution/bindings: pro cwd match, explicit product fallback, missing intent, stable binding digest, snapshot isolation from config edits.
- Activation rule: reuse every case in `tests/activation.test.ts`, then add subject-key/revision mismatch, item-index key uniqueness, and stale downstream invalidation.
- Machine: entry activation, every activation status, invalid seal output, retry/backoff, back-edges/new attempts, timeout edges, fail edges, skipped branches, all/any/quorum/tolerance joins, aggregate counts, and terminal status.
- Property tests modelled on `tests/flight-machine.test.ts`: across generated evidence/edge sequences, no activation reaches done without matching evidence; no effect is planned twice; cancelled runs plan no new effects; attempts never overwrite history.
- Claims: canonical value hashing, refuse/join-existing, prepared-claim repair, terminal release, simultaneous allocator races under the actual file lock.
- Subscriptions: at-least-once dedupe, 1,024-ID bound, queue order, coalesce replacement, subject revision supersession, cancelled late event.
- Amendments: patch grammar, done-node rejection, active quiesce, CAS race, approval policy, human-gate bypass detection, new-intent binding resolution.
- Guided conformance: each evidence heuristic, self-reported deviation, deviated-then-done representation.
- Pool extensions: legacy claim normalization, comb owner renew/release, exclusive/shared capacity, crash expiry, no oversubscription race.

### 8.2 Controller/executor integration tests

Use a temporary `HIVE_STORE_ROOT`, injected clock, fake session/seal/Forum/Pollinate/flight/action dependencies, and real atomic files/locks.

- Run creation through registry/ad-hoc/attached/child modes; depth and claim collision.
- Full agent node: prepare persisted before fake spawn, deterministic confirm, crash after spawn then adoption, wrong-contract collision violation, schema-valid/invalid seals, idle stall.
- Fault injection at every prepare/execute/confirm boundary for spawn, Forum, action, child, and checkout. Assert no duplicate irreversible call.
- Cancellation before prepare, after prepare, during execute, before confirm, and after confirm; cascade to children; packet withdrawal; late evidence ignored.
- Human lifecycle: create, needs-review, approve, request changes, same-revision rerequest, comment in downstream brief, stale revision successor, blocking-since clock edge.
- Strict actions: normal confirm, agentic binding, verifier wait, external state without execution record, untrusted graph approval, amendment that changes digest.
- Child composition/fan-out: ordered item indices, partial failures/tolerance, aggregate output, parent output, root cancellation.
- Checkout use in agent and deterministic action nodes; claim renewal while long-running; release on every terminal path.
- Flight lease adapter: unavailable, acquired, crash adoption, release, node-unreachable clock hold. The provider is faked until the flight-side contract lands.
- Daemon dispatcher isolation: one corrupt/erroring run does not block another run or later flight/pool stages; timeout returns an error outcome.
- Run event projection retry and duplicate `eventId` behavior after simulated append/write crashes.

### 8.3 CLI and migration tests

- Every command's pretty form, success envelope, error envelope/code, exit status, stdin handling, and stdout purity.
- Agent activation inference: zero/one/multiple bindings and explicit addressing.
- `spawn --comb` success and attach failure with bee preserved.
- JSON flow conversion fixture for every supported/rejected op; TS refusal; no source or historical run mutation.
- Pollinate contract fixture invoking `hive comb run/observe/cancel --json` and parsing exact envelopes.
- Forum fixture parsing success, replay, and failure envelopes; invalid command/result shapes fail closed.

### 8.4 Repository gates and manual verification

Each slice runs targeted tests, `npm run check`, `npm test`, and `npm run build`. Complex cross-application UI is not automated in Honeybee. Manually verify in Apiary after its implementation: Flightboard live graph, attempt history, child drill-in, deviation feed, attached-track bee affiliation, review-desk graph diff for amendment/approval, stale packet replacement, and violation alarm visibility.

## 9. Cross-system contract assumptions

These are reconciliation inputs for the other design authors. They are explicit even where current code does not yet satisfy them.

1. **Shared activation/flight boundary.** `src/activation.ts` continues to export `ActivationClaim`, `ActivationEvidence`, `activationKey`, and `judgeActivationEvidence` with current semantics. The flight controller exposes a capacity provider, either directly or through an additive `src/flight/capacity.ts`:

   ```ts
   export type FlightCapacityProvider = {
     acquire(request: {
       flightId: string;
       mixKey?: string;
       activation: ActivationAddress;
       taskId: string;
       attempt: number;
       subject: ResolvedSubject;
       brief: string;
       idempotencyKey: string;
     }): Promise<
       | { kind: "acquired"; leaseId: string; beeName: string; beeId?: string }
       | { kind: "unavailable"; retryAfterMs: number }
     >;
     lookup(idempotencyKey: string): Promise<{ leaseId: string; beeName: string; beeId?: string } | null>;
     release(leaseId: string, reason: "done" | "failed" | "cancelled"): Promise<void>;
   };
   ```

   Acquisition is atomic/idempotent, a leased bee accepts the supplied task/contract, `node_unreachable` holds clocks, and the comb engine does not edit `FlightRecord`/`SlotRecord` files. Current flight code does not yet expose this interface; this is the principal Honeybee-internal coordination point.

2. **Forum command availability.** `forum packet create|update|list|show|status|feedback|rerequest|successor` emits exactly one `{ok,command,result|error}` envelope and nonzero on failure, matching Forum `docs/APIARY_SURFACE.md` and current `src/forum/cli.ts`. `create`, `update`, `successor`, and `rerequest` accept `--idempotency-key`; current rerequest lacks that flag and must add it before being used as an engine effect.

3. **Forum review lifecycle.** Current statuses and transitions remain: `needs_review -> in_review -> changes_requested|approved`, `changes_requested -> needs_review`, `approved -> resolved`, any -> `superseded|archived`. Rerequest either performs or follows the `changes_requested -> needs_review` transition idempotently. Honeybee polls packet state in batches and does not write verdicts.

4. **Forum packet extensions.** Forum accepts `origin=comb` and packet kinds `amendment` and `approval` in addition to current review kinds, or provides a separate non-conflicting field carrying those concepts. Amendment/approval packets display a graph diff and return a verdict pinned to `definitionDigest`, `actionBindingDigest`, and subject revision. Ordinary human verification retains `kind=web|desktop|cli|code` from the comb node.

5. **Forum feedback routing.** Feedback output includes verdict, comment/message, and a destination equivalent to Apiary `ReviewFeedbackDestination` in `packages/core/src/review.ts`: `{type:"bee",sessionId}`, `{type:"new-agent"}`, or `{type:"pr-comment"}`. Current Forum feedback returns `routability` and `session_id`, so the reconciled contract must define their deterministic mapping to this union.

6. **Forum source dedupe.** Packet create/upsert by `source_dedupe_key` is stable. Successor creation is idempotent and links the predecessor. Honeybee can recover a crash after create/successor by querying that key or replaying the idempotency key.

7. **Pollinate comb action.** Pollinate adds a Honeybee action `{ kind:"honeybee", run:"comb", comb:string, version?:number, input:JsonValue, collision?:"refuse"|"join-existing" }`. It invokes `hive comb run ... --json`, treats `result.run.id` as the binding handle, and leaves existing `run:"flow"` unchanged during migration.

8. **Pollinate trigger delivery.** Every trigger instantiation supplies `triggerId`, a globally unique `deliveryId`, source kind, `receivedAt`, and JSON input. Delivery is at least once. Honeybee's subject claim, not Pollinate dedupe, is authoritative for cross-trigger/manual exclusion.

9. **Pollinate observations.** All non-Forum external facts use this logical shape and call `hive comb observe` (or an equivalent direct adapter preserving it):

   ```ts
   {
     eventId: string;
     observationType: string; // "ci-status" for the phase-1 predicate
     subjectKey: string;
     subjectRevision: string;
     observedAt: string;
     value: JsonValue;
     metadata?: JsonObject;
   }
   ```

   Events are at least once and may arrive out of order. Pollinate never sends credentials or asks Honeybee to fetch GitHub/tracker state directly.

10. **Pollinate router target.** Router bindings generalize `{kind:"hive",handle:<bee>}` to distinguish `{kind:"run",runId}`. `onActivity` delivers to a run subscription; `onClose` cancels the subscription or run according to trigger configuration. A cancelled run returns a terminal acknowledgement so Pollinate closes/drops the binding. Subject-to-run bindings remain Pollinate truth; node subscriptions remain Honeybee truth.

11. **Delivery policy ownership.** Pollinate preserves source ordering and event IDs. Honeybee applies node-local `queue` versus `coalesce-latest`, because the consequence includes activation invalidation and packet supersession. Pollinate does not independently coalesce after routing to a run unless it reports the dropped event IDs.

12. **Apiary ownership.** Apiary creates/edits Yjs drafts but commits definitions only through `hive comb define`. It never writes Honeybee registry/run JSON. It consumes `hive comb ... --json`, `hive events --json`, and/or file watches as read models, keyed by run/activation IDs rather than bee-name prefixes.

13. **Apiary Flightboard.** Apiary can render `RunView` nodes, attempts, item indices, deviations, violations, children, packet IDs, and bee handles. It deduplicates ledger projections by `eventId`. NeedsMe is unchanged. Human nodes open Forum packets in the review desk.

14. **Architecture ownership update.** The Apiary repo's `docs/architecture.md` is updated to make Honeybee authoritative for comb registry/runs and Apiary authoritative only for drafts/read models. Honeybee currently has no `docs/architecture.md`; no local file should be invented for this migration.

15. **Seal extension.** Honeybee Seal v2 remains additive and agents can include `output: JsonValue` alongside current `taskId`, `attempt`, and evidence fields. Existing seals without output remain valid generally but cannot complete a comb node whose output contract requires data.

16. **Session/agent delivery.** `spawnBee` continues to persist a normal `SessionRecord` before returning. HSR prompts use existing control delivery, and `scanLatestSeal`/daemon-derived `BeeState` remain available. A session's new `combActivations` array is preserved by older readers through `src/store.ts` unknown-key behavior.

17. **Checkout pools.** `pro pool ls --porcelain` and existing Honeybee pool resolution remain authoritative for config/members. Phase 1 pool checkouts are local. Pool file locks serialize claim/renew/release, and a comb-owner claim counts against occupancy until released/expired.

18. **Product identity.** Product keys resolve from pro area/project/repo facets by cwd, or are explicitly supplied. Apiary and Pollinate pass the same cwd/product key. There is no implicit global `land` binding.

19. **Action verification.** Product owners configure a verifier for every `land`/`run` binding. Remote external verification is delivered by Pollinate; a binding may not make the comb engine fetch GitHub, CI, tracker, or deployment APIs directly.

20. **Filesystem/single-writer behavior.** One Honeybee daemon reconciles a given `HIVE_STORE_ROOT`. CLI mutations may race it but use the same per-run/claim/pool locks. Multiple computers with separate store roots exchange events through Pollinate/Apiary; the design does not assume a safe distributed filesystem lock.

21. **Approval identity.** Forum verdict envelopes identify the human actor and pin the approved graph/binding digests. A generic packet approval with missing/mismatched digests is evidence mismatch, not approval.

22. **No hidden compensation.** Cross-repo partial action success is terminal/ambiguous and surfaces for human resolution. No other system assumes Honeybee will automatically compensate a landed target in phase 1.

## 10. Seal summary

Implementation target: `docs/COMBS_ENGINE_DESIGN.md`.

The design replaces flow v1 with immutable comb versions and daemon-reconciled, snapshot-isolated runs; reuses the flight activation/idempotency rule; and specifies agent, human, engine, child, claim, cancellation, checkout, amendment, and enforcement behavior down to persisted field and CLI-envelope shapes.

Top three open risks:

1. The in-progress flight controller has the shared activation kernel but no capacity-leasing API; the exact atomic lease/adoption boundary must land before flight-backed agent nodes.
2. Forum's current review-desk surface lacks idempotent rerequest and a digest-pinned amendment/approval/feedback-destination contract; human and approval executors must stay gated until those are reconciled.
3. Strict-action verification depends on complete, revision-pinned Pollinate observations. Missing or lossy external observations will correctly halt/leave effects ambiguous, but could make automatic landing operationally noisy until delivery is proven.
