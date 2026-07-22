# Combs engine design

**Status:** canonical composed implementation contract for Combs phase 1; E1/E2 rulings resolved
**Owner:** Honeybee  
**Concept contract:** `apiary/docs/orchestration-graphs-concept.md`, concept v2 (2026-07-21)  
**Replaces:** Honeybee flow v1 as the reusable graph and durable-run engine

This document is the canonical home of the composed phase-1 contracts: Honeybee's registry, snapshots, runs, claims, reconciler, executors, checkout integration, and CLI, plus the exact Pollinate, Forum, and Apiary seams those components consume. Pollinate remains the trigger and external-observation owner; Forum remains the packet and verdict owner; Apiary remains a read-model/UI consumer. If another phase-1 design disagrees on argv, JSON shape, exit code, ordering, idempotency, or teardown, this document wins and that design must align.

Concept v2 remains the product authority. Its 2026-07-21 E1/E2 rulings are incorporated here: the fixed predicate vocabulary includes one deterministic output-equality predicate, and a human node owns one logical thread whose physical successor packet chain spans subject revisions.

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
11. Run-targeted deliveries are at-least-once, revision-bearing, source-ordered, and idempotent. A transport success is not an acceptance claim; callers consume the machine-readable intake result.
12. A cancelled run retains its subject claim and remains sweepable until every owned effect, registration, packet, bee, child, flight lease, and checkout lease reaches a resolved cleanup state.
13. A strict action needs both an explicit unsatisfied preflight observation and a causally attributed satisfied postflight observation. The existence of an execution record alone proves nothing.

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
  | {
      source: "node-output";
      nodeId: NodeId;
      pointer: JsonPointer;
      lineage: "current"; // required; old/invalidated attempts are never selectable
      item: "same" | "aggregate" | { index: number };
    };

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
      | { type: "bee"; fromNodeId: NodeId }
      | { type: "new-agent" }
      | { type: "pr-comment" };
  };
};

export type PredicateSpec =
  | { kind: "seal-present"; nodeId: NodeId; statuses?: Array<"done" | "blocked" | "needs_input" | "failed">; sealType?: string }
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
  kind: "forward" | "retry" | "waiting";
  on: "done" | "failed" | "waiting";
  when?: PredicateSpec;
};

export type ClaimDeclaration = {
  scope: "product-comb" | "product"; // default and recommended: product-comb
  inputPointer: JsonPointer;
  collision: "refuse" | "join-existing"; // default "refuse"
};

export type SubscriptionDeclaration = {
  nodeId: NodeId;
  triggerId: string; // Pollinate trigger that can observe/deliver this subject
  subject: ValueSource;
  eventKinds: string[];
  delivery: "coalesce-latest" | "queue"; // default "coalesce-latest"
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
```

Validation rules are part of the format:

- Names and IDs use the existing flow name grammar in `src/flow/index.ts`. Node and edge IDs are unique.
- Every edge endpoint exists. `kind="waiting"` requires `on="waiting"`; `kind="retry"` requires `on="done"|"failed"` and always starts a new attempt cohort. Removing retry and waiting edges must leave a DAG. Entry nodes are nodes with no incoming forward edge and which are not the target of a waiting edge. Retry edges never remove an entry, and waiting-only targets are dormant until their clock firing; there is no second entry-node list to drift.
- A node with multiple incoming forward edges must declare `join`; `all` is filled only when a zero/single-forward-input node omits it. Retry and waiting edges are not join inputs. `quorum` requires `1 <= quorum <= incomingForwardEdgeCount`.
- `guided` agent nodes require at least one enumerable expectation. An expectation is evidence heuristic/self-report metadata, not a graph predicate and not an LLM judge.
- Human nodes must be `strict`: Honeybee deterministically emits and waits on the packet even though the verdict itself is human judgment.
- Human nodes have fixed output contract `{ verdict: "approve" | "request_changes", comment: string | null, destination: ReviewFeedbackDestination }` and may not override it. Authored `fromNodeId` is resolved at packet creation to the current activation's exact `{type:"bee",sessionId}`; missing/multiple current bees block packet creation rather than emitting a node ID across the Forum seam.
- Engine predicate and action nodes are `strict`. Child-run nodes are `strict`; expansion judgment lives in the upstream open agent node.
- An edge may carry at most one `when` predicate. More complicated logic is represented as predicate nodes plus joins; there is no expression or Boolean AST.
- `output-equals` may reference only a node with a `json-schema` output contract. It reads that node's schema-validated current-lineage output for the same item/cohort, resolves `path` as RFC 6901, and compares to the literal `equals` value using canonical JSON deep equality with no coercion. Before the referenced output is terminal it is waiting; a missing path after terminal validation is false. Fan-out branches must first produce a declared aggregate node output rather than adding selectors to the predicate.
- `on: "waiting"` is legal only on `kind="waiting"` with a `clock` predicate. It fires once per source activation without completing the waiting source, allowing timeout notification/escalation to run in parallel.
- `items`, `ValueSource`, and `ObjectMapping` only select/copy values. They cannot call functions or evaluate code.
- Cycles are legal only through explicit `kind="retry"` edges. Traversing one creates a new attempt cohort. This makes the forward condensation acyclic and validation/entry derivation deterministic.
- A node-output source must say `lineage="current"`. `item="same"` selects the same item index (item 0 for non-fan-out); `{index}` selects that exact current-cohort item; `aggregate` selects the source activation's `JoinAggregateOutput`. Missing, ambiguous, archived-without-summary, or invalidated values fail mapping before any effect is prepared.
- A comb with output declares both its contract and one deterministic value source. On terminal derivation the engine resolves it against the sole current terminal cohort and validates it. Multiple terminal nodes are legal only when this mapping selects one unambiguous value or a declared aggregate; there is no “last node to finish” rule.
- Claim scope is explicit. `product-comb` hashes product, comb name (not version), pointer, and selected value so a version bump cannot overlap an older run; `product` omits comb name for intentional cross-comb exclusion. Definition lint warns on a bare scalar pointer unless the comb also resolves a repository-qualified product identity.
- Nonempty `annotations.migrationTodos` makes lint/define invalid. The field exists only so `migrate-flow` can emit an honest re-authoring skeleton.

Brief templates reuse the deliberately small substitution pattern in `src/flow/json.ts`: `{{input.foo}}`, `{{item.foo}}`, and `{{nodes.<nodeId>.output.foo}}`. A node placeholder always means the current lineage and same item; aggregate/index selection requires an explicit `ValueSource` mapping rather than template syntax. Missing values remain verbatim and cause activation validation to fail before an effect is prepared. No arbitrary JS or expression syntax is evaluated.

The predicate vocabulary is closed for phase 1: `seal-present`, `verdict`, `ci-status`, `clock`, and `output-equals`. `output-equals` is sufficient for output-conditional examples such as weekly metrics while remaining data-only. Arbitrary expressions, JavaScript, user-defined predicates, comparison operators other than equality, and Boolean ASTs remain forbidden.

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

Canonical JSON recursively sorts object keys and preserves array order. The digest excludes registry version/provenance and covers exactly `CombSpec`, including `annotations`; Apiary may not add mirror-only aliases and recommit them. Defining an identical digest is a successful no-op returning the existing version. Defining a changed digest appends `version + 1`; `--base-version` provides registry CAS for editors.

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
  | {
      kind: "pollinate-observation";
      triggerId: string;
      observationType: string;
      unsatisfiedValues: JsonValue[];
      successValues: JsonValue[];
      attribution: "effect-key" | "operation-id";
    };

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
  defaultComb?: { name: string; version: number };
  defaultCombByTag?: Record<string, { name: string; version: number }>;
  defaultCombByKind?: Record<string, { name: string; version: number }>;
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

`land` bindings must use `pollinate-observation` verification, because process exit alone cannot prove who changed external state or detect an out-of-band landing. Its configured unsatisfied and success sets must be disjoint, and its executable must propagate the engine effect key or return an operation ID that Pollinate can expose in the causal observation. `run` may use either verifier. Default track selection precedence is explicit `--comb` plus version, then the first matching `defaultCombByTag` entry in sorted tag order, then `defaultCombByKind`, then `defaultComb`. Defaults are immutable `{name,version}` references; changing a default is a product-config revision, never an implicit retarget of an existing trigger or run.

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

export type CombSnapshotRef = {
  revision: number;
  definitionDigest: string;
  actionBindingDigest: string;
  createdAt: string;
  amendmentId?: string;
  storageRef: string; // run-relative `snapshots/<revision>.json`
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
  amendmentQuiesceMs: number;          // default 600_000
  amendmentQuiesceTimeout: "reject-amendment" | "retire"; // default reject-amendment
  attachedRetryOnDead: "spawn" | "fail"; // default spawn
  maxPendingEventsPerSubscription: number; // default 1_024; overflow pauses/fails, never drops
  retireAgentsOnTerminal: boolean;     // default true
  nodeOverrides?: Record<NodeId, Partial<ActivationPolicyLimits>>;
};
```

Policy defaults are `maxDepth=2`, `maxAttemptsPerActivation=3`, `retryBackoffMs=5_000`, `retryBackoffMaxMs=300_000`, `firstEvidenceMs=240_000`, `stallMs=600_000`, `maxConcurrentActivations=8`, `amendmentApproval="human"`, `amendmentQuiesceMs=600_000`, `amendmentQuiesceTimeout="reject-amendment"`, `attachedRetryOnDead="spawn"`, `maxPendingEventsPerSubscription=1_024`, and `retireAgentsOnTerminal=true`. A full queue pauses the subscription and fails visibly; it never silently evicts an event. Policies are resolved product defaults plus explicit run overrides and snapshotted on the run. They are not graph nodes. Child runs inherit the parent policies, then apply the narrow `policyOverrides` whitelist. `maxDepth` cannot be increased by a child.

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
  status: "current" | "historical";
  attachedAt: string;
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
        actor?: { id: string; name?: string };
        snapshotRevision: number;
        definitionDigest: string;
        actionBindingDigest: string;
        subject: ResolvedSubject;
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

export type EvidenceRef = {
  id: string;
  kind: EvidenceEnvelope["kind"];
  subject: ResolvedSubject;
  producer: EvidenceProducer;
  recordedAt: string;
  payloadDigest: string;
  storageRef: string; // run-relative `evidence/<sha256>.json`
  summary?: JsonObject; // bounded board-safe summary; never a diff/transcript
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
  cohortId: string; // `${runId}:g<generation>:i<itemIndex>`
  nodeSnapshotRevision: number;
  status: ActivationStatus;
  subject: ResolvedSubject;
  claim: import("../activation.js").ActivationClaim;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  nextEligibleAt?: string;
  beeHandles: BeeHandleRef[];
  evidenceCount: number;
  evidenceTail: EvidenceRef[]; // newest 128; full evidence files/events are the archive
  output?: JsonValue;
  aggregate?: JoinAggregateOutput;
  deviationCount: number;
  deviationTail: DeviationEvent[]; // newest 64; full history is events
  incomingEdgeFiringIds: string[];
  activeChildRunIds: string[];
  childRunTail: string[]; // newest 256 terminal children
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

export type CompactedActivationRef = {
  id: ActivationId;
  address: ActivationAddress;
  cohortId: string;
  nodeSnapshotRevision: number;
  status: Extract<ActivationStatus, "done" | "failed" | "skipped">;
  subject: ResolvedSubject;
  outputDigest?: string;
  evidenceCount: number;
  deviationCount: number;
  startedAt?: string;
  endedAt: string;
  archiveRef: string; // run-relative `attempts/<activation-id>.json`
};
```

The claimant passed to `activationKey` includes `itemIndex`: `claimantId = nodeId + "[" + itemIndex + "]"`. Thus the effect base key is `activationKey(runId, claimantId, attempt)`, for example `01...:review[3]:2`. This is the existing shared helper with a collision-free claimant ID, not a second key algorithm.

Evidence envelopes are written once to their content-addressed `storageRef`; `run.json` retains only `EvidenceRef`. Evidence matching composes the shared rule with subject matching:

1. Call `judgeActivationEvidence(activation.claim, { recordedAt, taskId, attempt })`.
2. `none` stays none; `mismatch` records `comb.violation.evidence_mismatch` and fails the run.
3. On `match`, compare both `subject.key` and `subject.revision` with the activation. A mismatch is the same violation, never absence.
4. Only then may the executor-specific matcher inspect `payload`.

Two expected races are classified before step 1 and are not mismatches: evidence addressed to an activation already marked invalidated/cancelled is stored as late/inert, and a Forum verdict whose packet pins an older snapshot/digest is stored as `stale_verdict` on that packet's historical activation. Neither is compared against the current activation or allowed to fire an edge.

`src/activation.ts` currently contains the key/claim/freshness kernel but not subject comparison or a shared activation-record type. `src/comb/evidence.ts` initially provides the thin composition above. If CL.e5b lands an additive shared subject matcher, the comb module imports it and deletes only that wrapper; flight semantics and existing types remain unchanged. This is the required flight/comb coordination point, not a competing activation rule.

Agent completion requires a matching seal whose new optional `SealArtifact.output?: JsonValue` validates against the node output contract. A malformed current seal records evidence, fails that activation with `code: "invalid-output"`, and follows retry/fail-edge policy. It never becomes undefined behavior. A matching `blocked`, `needs_input`, or `failed` seal fails the attempt unless an explicit edge routes it.

### 2.7 Edge firings, ordered intake, subscriptions, and human threads

```ts
export type EdgeFiring = {
  id: string;
  edgeId: string;
  from: ActivationAddress;
  toNodeId: NodeId;
  cohortId: string;
  subject: ResolvedSubject;
  firedAt: string;
};

export type SourceOrder = {
  sourceId: string;       // stable Pollinate source/trigger stream id
  subjectSequence: number;// monotonically increasing safe integer per (sourceId, subject kind/key)
};

export type ObservationCausation = {
  effectKey?: string;
  operationId?: string;
};

export type ObservationPayload = {
  eventId: string;
  observationType: string;
  subjectKind: string;
  subjectKey: string;
  subjectRevision: string;
  observedAt: string;
  order: SourceOrder;
  value: JsonValue;
  causation?: ObservationCausation;
  metadata?: JsonObject;
};

export type RoutedRunEvent = {
  eventId: string;
  triggerId: string;
  deliveryId: string;
  eventKind: string;
  subject: ResolvedSubject;
  occurredAt: string;
  order: SourceOrder;
  payload: JsonValue;
};

export type SubscriptionWatermark = SourceOrder & {
  eventId: string;
  subjectRevision: string;
};

export type RunSubscription = {
  id: string;
  nodeId: NodeId;
  triggerId: string;
  ownerKey: string; // `${runId}:${subscriptionId}`; Pollinate coverage ref owner
  subjectKind: string;
  subjectKey: string;
  eventKinds: string[];
  delivery: "coalesce-latest" | "queue";
  status: "registering" | "active" | "paused" | "tearing-down" | "released" | "failed";
  bindingId?: string;
  coverageRequestId?: string;
  pending: RoutedRunEvent[];
  watermark?: SubscriptionWatermark;
  seenEventIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ActionObservationWatch = {
  id: string;
  nodeId: NodeId;
  triggerId: string;
  ownerKey: string;
  observationType: string;
  subject: ResolvedSubject;
  status: "registering" | "active" | "tearing-down" | "released" | "failed";
  coverageRequestId?: string;
  watermark?: SubscriptionWatermark;
  createdAt: string;
  updatedAt: string;
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
  key: string; // one logical thread: `${nodeId}#${itemIndex}`
  nodeId: NodeId;
  itemIndex: number;
  packetCount: number;
  packetTail: HumanPacketRef[]; // newest 64 members of the successor chain
  currentPacketId: string;
  subject: ResolvedSubject;
  createdAt: string;
  updatedAt: string;
};
```

Subscriptions are node-scoped and transport-backed. A declaration creates one persisted `RunSubscription`, one idempotent Pollinate run binding, and one owner-scoped coverage request. A resolvable Pollinate action verifier creates an `ActionObservationWatch` and owner-scoped coverage request but no run binding, because `comb observe` fans out by subject. `coalesce-latest` keeps at most one pending event per subscription. `queue` keeps source order. `seenEventIds` is a newest-1,024 cache; a miss is checked against the per-run event log/delivery index before acceptance, so retention bounds never weaken idempotency.

`queue` starts one event cohort at a time in watermark order; the next event remains pending until the prior cohort and its activation-scoped cleanup are terminal. It never merges revisions or counts firings across cohorts. `coalesce-latest` may replace a pending event immediately and may supersede an in-flight cohort only through the cleanup sequence below.

Intake compares `(sourceId, subjectSequence)` with the subscription watermark before revision comparison. A lower sequence is `stale` and is logged/acknowledged without state change. The same sequence with a different event ID is `ordering-conflict`, records a transport violation, and is not applied. A higher sequence advances the watermark. Arrival time is never used for ordering.

For `coalesce-latest`, a higher-order event with a new subject revision supersedes the current cohort. Before a replacement attempt can plan effects, the engine performs an activation-scoped cancellation subset: mark the old activation invalidated, retire its owned bees, withdraw/supersede its packet, release checkout/flight leases, and resolve any prepared/executing effect as failed or ambiguous. Evidence explicitly addressed to the invalidated activation is recorded as `late_invalidated` and ignored; it is not an evidence-mismatch violation. Invalidated activations never fire edges. Only after that cleanup reaches a resolved state does the new cohort activate.

Every Forum packet is pinned to the snapshot revision, definition digest, action-binding digest, and subject revision in `HumanPacketRef`. Normal review iteration may rerequest the current packet only while all four pins remain equal. A verdict with stale pins is logged as `comb.evidence.stale_verdict` and ignored, not treated as a violation. Comments become the human activation's `output.comment` and are available to downstream brief templates. For `origin=comb`, Honeybee is the sole downstream feedback router; Forum/Apiary records the verdict and destination but suppresses legacy queue/spawn/comment side effects.

Each `(nodeId,itemIndex)` owns one logical `HumanPacketThread`. A changed subject revision supersedes the current digest/revision-pinned packet and creates a successor linked in both directions; the packet chain is the thread. Stable-revision attempts may rerequest the current physical packet. Forum persists the chain, Honeybee preserves the stable `thread.key` and current packet, and the review desk renders the chain as one thread rather than separate review items.

Intent requests are cut from phase 1. Eligible engine action nodes execute only when graph preconditions hold; an agent cannot accelerate or authorize one with a request. `hive comb request` and `IntentRequestRecord` are reserved for a later design with explicit node mapping and TTL semantics and must not be implemented from concept prose alone.

### 2.8 Effects, engine-execution records, violations, and cancellation

```ts
export type EffectKind =
  | "agent-spawn"
  | "flight-lease"
  | "agent-adopt"
  | "forum-create"
  | "forum-rerequest"
  | "forum-withdraw"
  | "pollinate-register"
  | "pollinate-unregister"
  | "pollinate-coverage-request"
  | "pollinate-coverage-release"
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

export type EffectScope =
  | { kind: "activation"; activation: ActivationAddress }
  | { kind: "subscription"; runId: string; subscriptionId: string }
  | { kind: "run"; runId: string };

export type EffectRecord = {
  key: string; // `${scopeKey}:${kind}:${semanticDigest}`
  scope: EffectScope;
  kind: EffectKind;
  semanticId: string;
  semanticDigest: string; // sha256 of canonical semanticId; not planner position
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

export type EffectRef = {
  key: string;
  kind: EffectKind;
  status: EffectStatus;
  scope: EffectScope;
  requestDigest: string;
  storageRef: string; // run-relative `effects/<sha256-of-key>.json`
  confirmedAt?: string;
};

export type EngineExecutionRecord = {
  effectKey: string;
  activation: ActivationAddress;
  intent: "land" | "run";
  subject: ResolvedSubject;
  bindingDigest: string;
  preflightEvidenceId?: string; // required for pollinate-observation verifier
  preflightValueDigest?: string;
  preparedAt: string;
  executedAt?: string;
  operationId?: string;
  postflightEvidenceId?: string;
  confirmedAt?: string;
  status: "prepared" | "confirmed" | "failed" | "ambiguous";
};

export type ArchivedEffectRecord = {
  schemaVersion: 1;
  effect: EffectRecord;
  engineExecution?: EngineExecutionRecord;
};

export type ViolationRecord = {
  id: string;
  activation?: ActivationAddress;
  code:
    | "evidence-mismatch"
    | "idle-without-completion"
    | "external-state-without-engine-record"
    | "strict-state-preexisted"
    | "strict-attribution-mismatch"
    | "observation-ordering-conflict"
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
```

The controller prepares an effect while holding the run lock, captures `fenceEpoch`, writes the run, releases the lock, executes, then reacquires the lock to confirm. If cancellation advanced the fence meanwhile, the effect becomes `ambiguous` unless its verifier proves it was not executed. No next effect begins.

Effect keys never use array order or a planner counter. `scopeKey` is the activation base key, `runId:subscription:<id>`, or `runId:run`. `semanticId` is canonical and stable across replanning: `primary` for one spawn/adopt/flight per activation; `packet:<packet-thread-key>:<subject-revision>:<snapshot-digest>` for create; `rerequest:<packet-id>:a<attempt>`; `withdraw:<packet-id>`; `subscription:<subscription-id>` for register/unregister; `coverage:<subscription-owner-key>` for request/release; `action:<intent>:<binding-digest>`; `child:<item-index>:<comb-digest>:<input-digest>`; and `checkout:<pool-key>:<mode>` for claim/release. Two proposed effects with the same key must have the same request digest or reconciliation halts with a violation. Planner ordering therefore cannot duplicate or alias effects.

Recovery rules are executor-specific and deterministic:

- Spawn: derive the same bee name, find the matching session/contract, and adopt it; a different contract is a violation. Absence does not replay the attempt; the attempt is failed after its readiness deadline and retry creates a new attempt/name.
- Flight lease: query the capacity provider by idempotency key and adopt/release the returned lease.
- Forum create/successor/rerequest: use Forum idempotency keys. If Forum cannot replay that mutation, query the packet by source dedupe key before deciding ambiguous.
- Pollinate registration/coverage: replay the idempotency key, or query by `ownerKey`; persist returned binding/request IDs before graph effects become eligible. Teardown uses those exact IDs.
- Deterministic/agentic action: evaluate the snapshotted verifier's explicit unsatisfied preflight and causally attributed postflight rules. Mark `not-executed` only when a fresh observation proves the unsatisfied state. Otherwise require explicit resolution.
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
  status: "proposed" | "awaiting-approval" | "quiescing" | "quiesce-stalled" | "applying" | "applied" | "rejected" | "conflict";
  approvalRequired: boolean;
  approvalPacketId?: string;
  affectedNodeIds: NodeId[];
  quiesceActivationIds: ActivationId[];
  packetIdsToSupersede: string[];
  quiesceDeadline?: string;
  resultingRevision?: number;
  resultingDigest?: string;
  resolvedAt?: string;
  reason?: string;
};
```

Only `add`, `remove`, and `replace` are accepted, and every path is rooted at `/definition`. Applying a patch to a node with any `done` activation is rejected. Affected `active`/waiting activations enter `quiesce`: the controller prepares no new effects for them; `finish` waits for current bees/effects, while `retire` cancels/retires them and records that decision. Every current packet for an affected node is added to `packetIdsToSupersede`; its idempotent Forum withdraw/supersede effect must confirm before status can become `applying`. A packet that is merely awaiting a human verdict cannot hold a graph revision open indefinitely.

The quiesce deadline is `proposedAt + amendmentQuiesceMs`. At expiry, `reject-amendment` sets `quiesce-stalled` then rejects without changing the snapshot; `retire` performs the activation-scoped cancellation subset and continues only after effects/packets resolve. CAS is checked again after approval, packet supersession, and quiescence. A mismatch sets `conflict` and returns the current revision/digest; the proposer must rebase. Verdicts arriving with the old snapshot/digest are logged and ignored even if they arrive between final CAS and the new snapshot write.

Removing a human node, changing it away from `executor: "human"`, removing all paths through it, or adding a bypass from its predecessors to successors always requires an amendment packet. Agent proposals follow `RunPolicies.amendmentApproval`; human proposals may apply automatically except for the same gate-removal rule. Adding an untrusted strict action also requires an approval packet.

### 2.11 Subject claims and run record

```ts
export type SubjectClaimRecord = {
  schemaVersion: 1;
  id: string; // sha256 of scope + product + optional comb name (never version) + pointer + selected value
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

export type RunOrigin =
  | { kind: "manual"; actor: string }
  | { kind: "trigger"; triggerId: string; deliveryId: string; eventId?: string }
  | { kind: "child"; parentRunId: string; parentActivation: ActivationAddress; effectKey: string }
  | { kind: "attached"; beeName: string; entryNodeId: NodeId }
  | { kind: "ad-hoc"; actor: string };

export type TriggerAssociation = {
  triggerId: string;
  firstDeliveryId: string;
  firstEventId?: string;
  relation: "creator" | "joined-claim";
  associatedAt: string;
};

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
  triggerAssociations: TriggerAssociation[];
  productKey: string;
  cwd: string;
  input: JsonValue;
  inputDigest: string;
  currentSnapshot: CombSnapshot; // bounded execution truth for snapshotRevision
  snapshotHistoryTail: CombSnapshotRef[]; // newest 64; full immutable files remain under snapshots/
  snapshotRevision: number;
  policies: RunPolicies;
  depth: number;
  rootRunId: string;
  parentRunId?: string;
  activeChildRunIds: string[];
  childRunTail: string[]; // newest 256 terminal children
  activations: Record<ActivationId, ActivationRecord | CompactedActivationRef>;
  nextCohortGeneration: number;
  edgeFiringTail: EdgeFiring[]; // newest 256; older firings live with archived attempts/events
  subscriptions: RunSubscription[];
  actionObservationWatches: ActionObservationWatch[];
  verifierObservationCache: Record<string, ObservationPayload>; // latest ordered value per resolvable action verifier subject
  packetThreads: HumanPacketThread[];
  effects: Record<string, EffectRecord>; // unresolved/current only
  effectTail: EffectRef[]; // newest 128 resolved effects; full records live under effects/
  engineExecutions: Record<string, EngineExecutionRecord>; // unresolved/current strict effects only
  amendmentTail: AmendmentRecord[]; // newest 64; full history is snapshot files/events
  violationTail: ViolationRecord[]; // newest 128; full history is events
  subjectClaimId?: string;
  cancellation?: CancellationFence;
  cleanup: RunCleanupRecord;
  intakeReady: boolean; // true only when every required registration/coverage effect confirmed
  output?: JsonValue;
  eventTail: RunEvent[]; // newest 256 only; per-run JSONL is the archive
  eventsRetainedFrom: number;
  nextEventSequence: number;
  ledgerPublishedThrough: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  failure?: { code: string; message: string; activation?: ActivationAddress };
};
```

Claim acquisition is prepare/confirm under the claim lock: allocate `runId`, persist a `prepared` claim, create the run, then mark the claim `held`. A crash repair treats a prepared claim with an existing matching run as held; a prepared claim without a run is releasable after the normal file-lock stale interval. A trigger creator writes a `creator` association. `join-existing` returns the held run only after an optional origin event is atomically accepted by exactly one matching subscription and a deduped `joined-claim` association is written, even when the holder's immutable `origin` is manual/another trigger. The match is `(triggerId, eventKind, subject.kind, subject.key)`; revision may advance because synchronize/push events intentionally supersede a prior revision. No match returns `claim_conflict` with `holdingRunId` rather than pretending the event joined. A request without an event may join for inspection only and creates no trigger association.

Claims do not release merely because `status` became terminal. They release only after `cleanup.status="complete"`, including resolution of ambiguous strict effects and Pollinate teardown. Until then a new run receives `claim_conflict` with the same holding run.

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
      events.jsonl
      snapshots/
        000000.json
        000001.json
      evidence/
        <sha256>.json
      effects/
        <sha256-of-effect-key>.json
      attempts/
        <activation-id>.json
  deliveries/
    <sha256-of-delivery-id>.json
    .<sha256-of-delivery-id>.lock
  .runs-index.lock
```

The canonical watch roots are `${storeRoot()}/combs/definitions`, `${storeRoot()}/combs/products`, and `${storeRoot()}/combs/runs`; there is no `~/.hive/comb-runs` alias. Watchers invalidate only the changed run ID and refresh through CLI projections rather than parsing private files.

`run.json` is the bounded mutable aggregate: the current snapshot, newest 64 immutable snapshot refs, active/current activation records, compacted activation refs, unresolved effects, newest 128 effect refs, subscriptions, cleanup state, and a 256-event tail. Every full snapshot revision is written once under `snapshots/`; older definitions/refs are discovered by revision filename and are not duplicated in the aggregate. Resolved `ArchivedEffectRecord` values move atomically to `effects/`; semantic-key lookup checks that store before planning. Full evidence envelopes live once under content-addressed `evidence/`; diffs, transcripts, and large command output remain external artifacts referenced by digest/URL/path. After a terminal or invalidated activation has no live packet/effect/resource, the store retains the newest eight attempts per `(nodeId,itemIndex)` inline and atomically moves older activation records to `attempts/`, leaving a `CompactedActivationRef`. Status can hydrate one archived attempt on request; the board never does.

Mutations dirty-check the normalized aggregate and do not rewrite `run.json` when derived state is unchanged. Session-state evidence IDs are stable hashes of `(beeName,state,sessionStatus,stateChangedAt)`, so polling the same state produces neither a new evidence file nor a write. These bounds make write/read cost proportional to current work and graph size, not run age.

Run IDs reuse the sortable allocator in `src/flow/runs.ts`: 13 Crockford-base32 timestamp characters, `-`, then four random hex characters. Comb lookup is global under `combs/runs`, so the same ID never needs a definition-name qualifier.

The registry mirrors flow v1's file-backed authoring and provenance, but immutable version files replace mutable `<name>.json|.ts`. Sources are inspection aids only. Runs live under one global runs root so lookup never scans every definition as `src/flow/runs.ts` currently does.

Every persisted top-level type has an independent `schemaVersion`. Readers normalize older supported versions and preserve unknown fields. A newer unsupported version is listed as `unreadable` by inventory commands and is never silently skipped. Format migrations write a sibling temp file, validate it, then use `atomicWriteFile`/rename; original version files are immutable.

`RunEvent` history is authoritative in `events.jsonl`. Under the run lock a mutation assigns deterministic sequences/IDs, writes the new aggregate with those events in `eventTail`, appends missing events to the per-run log, then projects after `ledgerPublishedThrough` through `appendLedger`. Crashes may duplicate a JSONL or global-ledger line; readers deduplicate by `(runId,sequence,eventId)` and reject a same-sequence/different-ID corruption. The run record advances `ledgerPublishedThrough` only after global append succeeds. `hive comb events --after` reads the bounded tail when possible and the per-run log otherwise.

The delivery index makes `originDelivery` an instantiation idempotency key. It stores delivery ID, request digest, resulting run ID, and whether the request created or joined. Replaying the same digest returns the same result; a different digest for the same delivery ID returns `version_conflict` and never mutates either run.

## 3. Engine behavior

### 3.1 Instantiation

`instantiateRun` performs these steps in order:

1. If trigger provenance is present, require `originTrigger`, `originDelivery`, and the version-pinned registry reference; take the delivery lock and return its stored result on an identical replay.
2. Load that immutable registry version (or validate a manual ad-hoc graph). Compute/verify its digest.
3. Validate input and optional origin event; resolve product identity, policies, subject claim value, every used action binding, subscription trigger, subject, and coverage request. Missing subject revisions fail before mutation.
4. Enforce parent depth before any claim/effect. Child depth is `parent.depth + 1`; default maximum is 2.
5. For agent-authored ad-hoc/expansion graphs containing strict action nodes, compare the definition digest with `trustedStrictGraphDigests`. If untrusted, create the run but block strict execution behind an approval packet.
6. Acquire the engine-owned subject claim with the prepared/held protocol. On `join-existing`, atomically ingest the matching optional origin event and write the delivery-index result; do not create a second run.
7. Write snapshot revision 0 and the initial `RunRecord`. Create generation 0, attempt 1/item 0 `pending` records only for derived entry nodes. Store the optional origin event in a matching subscription in the same aggregate write. Fan-out item activations are created when their item list resolves.
8. Prepare one `pollinate-register` plus owner-scoped `pollinate-coverage-request` per routed subscription, and one coverage request per resolvable action observation watch. `intakeReady` stays false, and no graph executor effect is eligible, until all required effects confirm. A later-resolving action subject creates/activates its watch before that action can execute. The daemon executes registration; a run can be observed as `active/registering` immediately without being fail-open.
9. For `origin.kind === "attached"`, validate the entry node and bee before accepting any work prompt, then prepare the durable association. The combined user brief and attempt contract is delivered only after run creation, session binding, and required registration confirmation.
10. Write the trigger delivery index and return after durable creation. `hive comb run` does not host a foreground engine process.

For Pollinate invocation the caller sequence is fixed: render one JSON input; invoke the version-pinned `hive comb run` contract in §5; parse the one envelope; on `created=true` emit `run_started` and create any trigger-level Flightboard association; on `joinedExisting=true` emit neither and create no new association because the origin event is already durable on the holder. Transport failure/nonzero uses the durable delivery outbox retry policy in §5.4.

### 3.2 One level-triggered daemon sweep

`createCombSweeper()` follows the injected dependency structure of `src/flight/controller.ts`. One `sweepCombs(records, observed)` call:

1. Lists runs where `status="active"` **or** `cleanup.status!="complete"`; cancelled/failed/done cleanup-pending runs remain sweepable.
2. Gathers shared evidence in batches: current session records/states, latest seals for bound bees, one `forum packet list --json` result for all live packet IDs, queued Pollinate observations already stored on runs, and current clock.
3. Under each run lock, ingests new evidence envelopes and deduplicates by evidence/event ID.
4. Recomputes each activation from the snapshot and evidence:
   - stale evidence is ignored;
   - correlation or subject mismatch records a violation and fails the run;
   - current valid evidence derives status/output;
   - idle without a seal after `stallMs` records a stall violation/failure, never `done`;
   - invalid output follows retry/fail-edge rules;
   - deviation checks append history without changing status by themselves.
5. Applies source-order watermarks, then resolves any activation-scoped supersession cleanup. Stale/invalidated late evidence is logged and inert.
6. Evaluates waiting clock edges, terminal edges, current-cohort join readiness, aggregate output, and skipped branches. Each edge firing is stored once by `(edgeId, source ActivationAddress, cohortId)`.
7. Creates a new cohort and attempts for retry edges. The new cohort invalidates prior downstream activations/evidence for that subject lineage, but preserves their records/history.
8. Reconciles amendments and cancellation before planning effects. Registration/coverage effects are the only effects eligible while `intakeReady=false`; teardown effects are the only new external effects eligible after a cancellation fence.
9. Plans eligible effects, respecting `maxConcurrentActivations`, checkout availability, retry `nextEligibleAt`, approval gates, semantic effect identity, and the cancellation fence. It persists all prepares, releases the lock, and executes through injected executors.
10. Reacquires the lock per result to confirm/fail/mark ambiguous, then recomputes terminal run status and the declared run-output mapping.
11. Drives cleanup to completion in the ordered sequence in §3.5, compacts eligible attempts/evidence refs, publishes run events, and only then releases the subject claim.

The dispatcher is bounded by the existing `dispatchMs` timeout and returns `CombSweepOutcome[]`. Like flights, an error for one run becomes an outcome; it does not abort the whole tick. The daemon remains strictly serialized as documented in `src/daemon/run.ts`.

### 3.3 Join and attempt semantics

- Validation removes `retry` and `waiting` edges and topologically sorts the remaining forward DAG. That DAG defines entry nodes and forward join membership. A retry edge is an explicit attempt-generation boundary, never a member of the destination's forward join.
- Generation 0 entry activations receive cohort `${runId}:g0:i<itemIndex>`. Forward edge firings preserve that cohort. A retry firing allocates `nextCohortGeneration`, creates `${runId}:gN:i<itemIndex>`, and increments the destination's node-local attempt. Attempt numbers remain part of activation identity; `cohortId` is the join membership key.
- A join consumes only forward firings with the same `cohortId`. A firing from attempt/generation 1 can never satisfy a generation-2 join. Required members are the statically reachable incoming forward edges for that cohort; waiting edges are side branches and do not count.
- `all`: activate when every required forward branch in the cohort has produced a successful firing, unless failures exceed `tolerateFailures`.
- `any`: activate on the first successful firing; unresolved sibling paths become `skipped` for that cohort.
- `quorum(n)`: activate at `n` successes in the cohort. Fail when remaining possible successes cannot reach `n` or failures exceed tolerance.
- Every joining activation receives `JoinAggregateOutput`, even if the node also produces its own executor output; its executor output is stored in `output`, aggregate in `aggregate`.
- A retry-edge traversal increments the destination node's attempt relative to its greatest existing attempt for that item. A forward `on="failed"` edge does not increment a cohort; it routes failure within the current forward DAG. No activation is overwritten.
- Fan-out creates item indices in source-array order. Each item gets its own activation and child run. Reordering in a later subject revision invalidates the old cohort and creates a new attempt; indices are not reused within an attempt.

The mandatory validation fixture is the human-last track: `work -> review -> verification -> land`, with review/verification request-changes retry edges back to `work`. Removing retry/waiting edges yields the forward DAG with `work` as its single entry. Rejection allocates a new cohort; no attempt-1 review/verification firing can satisfy attempt 2. The fixture must also include a waiting-only timeout target and prove it is not instantiated at run start.

A run becomes `done` only when its current cohort has no active/waiting activation, every reachable non-skipped terminal branch required by its joins succeeded, no cleanup/violation blocks completion, and `CombSpec.output.value` (when declared) resolves and validates. Failed terminal branches without a forward failure route fail the run. Output resolution never scans an older cohort or chooses by completion timestamp.

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

On retry of an attached entry node, destination `bee` rebinds the same nonterminal bee. The engine prepares a new `agent-adopt` semantic effect, marks the previous session binding historical, stores the new activation binding, and sends one new-attempt postscript containing the new taskId/attempt plus the human comment before accepting a new seal. The attempt-1 contract never authorizes attempt-2 evidence. Destination `new-agent` always cold-spawns from node capacity. If destination is `bee` but the original bee is terminal, `attachedRetryOnDead="spawn"` cold-spawns a successor and records the substitution; `"fail"` fails the activation visibly. No retry silently waits on a dead pane.

#### Human

The first stable-revision attempt prepares `forum-create`, calls `forum packet create` with a deterministic source dedupe key `comb:<runId>:<nodeId>:<itemIndex>:<subjectRevision>:<definitionDigest>`, and includes snapshot revision, definition/action-binding digests, subject, and inline graph payloads. It confirms the returned packet ID. The activation derives `waiting-human` from the confirmed packet and current Forum status.

For a stable subject/snapshot/digest tuple, a later attempt updates review fields as needed, transitions `changes_requested -> needs_review`, and calls idempotent `rerequest`. Feedback is read, not written, by Honeybee. `approve` produces `{ verdict: "approve", comment, destination }`; `request_changes` produces the corresponding output and retry-edge context. Subject or graph movement supersedes the old packet and creates an idempotent Forum successor. Unknown `amendment`/`approval` kinds are unreviewable and cannot degrade to `code`; a verdict without actor and exact pins is ignored.

#### Engine predicate

Predicate execution has no external effect:

- `seal-present` examines only a referenced current activation's matching seal evidence.
- `verdict` examines only a referenced human activation's current output.
- `ci-status` examines only a Pollinate observation matching subject key/revision and optional check name.
- `output-equals` examines only the referenced current-lineage, same-item output after its JSON schema validated, resolves the RFC 6901 path, and performs canonical JSON equality against the snapshotted literal.
- `clock` is derived from `activation-start` or Forum `blocking_since`; the engine writes one clock evidence envelope when the threshold is reached.

Absent evidence leaves the activation `waiting-event`. A mismatch is a violation.

#### Engine action

The action executor loads the binding by snapshotted digest and claims any checkout. For a `pollinate-observation` verifier, before preparing an action effect it requires a fresh observation for the exact subject revision whose value is in `unsatisfiedValues`. A success value already present records `strict-state-preexisted`, halts the run, and prepares no action. Missing preflight evidence leaves `waiting-event`; absence of an observation is never treated as proof of an unsatisfied state. A `process-result` verifier is legal only for `intent="run"`; it has no external-state claim, needs no observation preflight, and confirms only its own allowed exit code.

With the required preflight evidence pinned (or explicitly not applicable for process-result), the engine writes `EffectRecord` and `EngineExecutionRecord`, injects `HIVE_COMB_EFFECT_KEY` into an argv-safe deterministic/agentic binding, then executes. Builtins receive the same field structurally. An observation-verified binding must either propagate that key into the external mutation or return a stable `operationId`; the record persists it. Deterministic commands use `execFile`-style argv execution, not shell interpolation. Agentic mechanisms spawn a single-purpose HSR bee with the same activation contract; they remain an engine-owned strict action.

Observation verification requires a later, higher-source-order Pollinate observation whose value is in `successValues` and whose `causation.effectKey` or `causation.operationId` equals the prepared execution record. A record without causal match cannot confirm and becomes ambiguous. Every sweep also scans success observations for strict subjects: a success with no matching executing/confirmed causally attributed effect records `external-state-without-engine-record`; a success with a different attribution records `strict-attribution-mismatch`. Both halt and alarm. Thus an out-of-band landing that precedes activation, races preparation, or makes the engine operation a no-op is never laundered into completion merely because a record exists. Process-result verification confirms only the executed process and cannot consume an external observation as completion.

#### Child run

The executor resolves a registry definition or validates the upstream agent-authored graph, maps input, enforces depth/approval/claim rules, and calls the normal instantiator with `origin.kind = "child"`. The parent activation waits on child terminal output. Fan-out repeats exactly this primitive per item index and aggregates through its declared join.

### 3.5 Cancellation and ambiguity

`cancelRun` sets the fence, sets `status="cancelled"`, and initializes `cleanup.status="pending"` under the run lock. Terminal status is user-visible immediately, but terminal does not mean cleanup-complete: the sweep selector includes cleanup-pending runs, the claim stays held, and `endedAt` is written only when cleanup completes.

The normal teardown order is exact and idempotent:

1. Fence child runs and activation executors; prepare no new graph effects. Classify prepared/executing actions with their verifier as `not-executed`, `failed`, or `ambiguous`.
2. Retire owned activation bees and release flight leases; a `kill_failed`/unreachable owner remains pending.
3. Withdraw/supersede outstanding Forum packets and wait for confirmation.
4. For each routed subscription, set `tearing-down`; call `pol bindings unregister --binding-id ...` and confirm, then call owner-scoped `pol observe release --request-id ... --owner ...` and confirm. For each action observation watch, release its owner-scoped coverage request (there is no binding). Terminal deliveries racing teardown receive an exit-0 terminal acknowledgement (§5.4).
5. Release checkout leases after their owning executors stop.
6. Wait for every child cleanup to complete and every non-strict ambiguity to be manually resolved. A strict out-of-band violation can never be resolved to success.
7. Set `cleanup.status="complete"`, release the subject claim, stamp `endedAt`, and compact eligible history.

If any action remains ambiguous, cleanup becomes `blocked-ambiguous`; the run stays sweepable and keeps its claim. `hive comb effect resolve` is audited and resumes cleanup, but cannot turn an external strict action without causal attribution into success. Late evidence for a cancelled run is stored as `comb.evidence.late_cancelled`, returns a terminal acknowledgement, and has no state effect.

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
| `src/comb/store.ts` | Bounded run aggregate, content-addressed evidence, activation archives, delivery index, run locks, dirty-check mutation, inventory, event projection. |
| `src/comb/claims.ts` | Atomic subject claim prepare/confirm/release/join-existing repair. |
| `src/comb/evidence.ts` | Shared activation-rule adapter, subject matching, batched seal/session/Forum/observation ingestion. |
| `src/comb/intake.ts` | Run-event and subject-observation validation, idempotency, ordering watermarks, fan-out, and terminal acknowledgements. |
| `src/comb/pollinate.ts` | Strict `pol` JSON adapter for binding register/unregister and owner-scoped coverage request/release. |
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
| `tests/comb-*.test.ts` | Focused unit/integration tests listed in section 8. |

### 4.2 Changed files

| File | Change |
|---|---|
| `src/activation.ts` | Prefer no breaking change. Import existing helpers. Add only a shared subject matcher if CL.e5b lands the agreed additive boundary. |
| `src/daemon/tick.ts` | Add `sweepCombs?: CombSweeper`, `combSweeps: CombSweepOutcome[]`, and one dispatcher before flights/pools so comb cancellation/leases settle before pool refresh. |
| `src/daemon/wiring.ts` | Build `createCombSweeper()` once. |
| `src/daemon/timeouts.ts` | Add a separately configurable `combMs` only if `dispatchMs` proves insufficient in integration tests; phase-1 default uses `dispatchMs`. |
| `src/cli.ts` | Dispatch `comb`, add help, preserve one-shot `run` unchanged. |
| `src/completion/tables.ts` | Complete comb subcommands, names, run IDs, node IDs, and flags. |
| `src/commands/spawn.ts` | Parse pinned `--comb`/`--comb-version`, prevalidate track/input before launch, withhold the work prompt until durable attachment, and quarantine/retire on attachment failure. |
| `src/store.ts` | Add `combActivations?: CombActivationBinding[]` to `SessionRecord` and its allow-list/normalizer. Do not touch legacy `combId`. |
| `src/seal.ts` | Add/validate optional JSON `output`; keep Seal v2 fields additive. |
| `src/pool.ts` | Add claim owner, renew, lookup-by-owner, and idempotent release while preserving legacy claim reads. |
| `src/commands/flow.ts` | Legacy labeling and read support for `comb migrate-flow`; no aliasing to comb execution. |
| `src/flow/*` | Retained for legacy registered flows during transition, then narrowed to migration-report/compatibility support. |
| `src/loop/control.ts`, `src/loop/flow.ts`, `src/loop/spawn.ts` | Extract loop's detached driver dependency from flow v1 before any flow runtime removal; keep loop behavior unchanged. |
| `package.json` | Export the comb SDK and add the JSON-schema validator dependency. |
| `docs/HIVE_CLI_REFERENCE.md` | Document comb commands/envelopes and mark flow v1 legacy. |

No pane grouping or new tmux surface is introduced. HSR control continues through existing spawn/send/observe machinery. Apiary consumes CLI JSON and ledger/run files; it does not get a Honeybee workflow-state IPC channel.

## 5. Surfaces

### 5.1 CLI namespace

The existing one-shot `hive run`/`hive x` behavior remains untouched. All graph-run operations live under `hive comb`.

```text
hive comb list [--json]
hive comb lint <file.json|file.ts|-> [--json]
hive comb define <file.json|file.ts|-> [<name>] [--base-version <n>] [--json]
hive comb inspect <name> [--version <n>] [--json]
hive comb promote <run-id> --name <name> [--base-version <n>] [--json]
hive comb product show <product-key> [--json]
hive comb product apply <config.json> [--base-revision <n>] [--json]
hive comb defaults [--product <key>] [--json]
hive comb default set --product <key> --comb <name> --version <n>
                      [--tag <tag> | --kind <kind>] --base-revision <n> [--json]

hive comb run <name> [--version <n>] --input <file|-> [--cwd <path>]
              [--product <key>] [--collision refuse|join-existing]
              [--bee <selector>] [--entry <node-id>]
              [--origin-trigger <id> --origin-delivery <id>] [--event-json <json>]
              [--json]
hive comb run --graph <file|-> --input <file|-> [--cwd <path>]
              [--product <key>] [--json]
hive comb runs [--board] [--comb <name>] [--status active|failed|cancelled|done]
               [--active] [--last <1..1000>] [--since <iso8601>] [--json]
hive comb status [<run-id>] [--activation <activation-id>] [--json]
hive comb events <run-id> [--after <sequence>] [--limit <1..1000>] [--json]
hive comb cancel <run-id> [--reason <text>] [--json]

hive spawn <bee> --comb <name> --comb-version <n>
                 [--comb-input <file|->] [normal spawn flags...]

hive comb report [--run <id>] [--node <id>] [--attempt <n>] [--item-index <n>]
                 [--from <report.json>] [--deviation <text>] [--json]
hive comb propose-amendment <run-id> --from <patch.json> --base-rev <n> [--json]

hive comb event <run-id> --event <file|inline-json|-> [--json]
hive comb observe --subject-kind <kind> --subject <key> --subject-rev <revision>
                  --event-id <id> --type <observation-type> --observed-at <iso8601>
                  --source-id <id> --subject-sequence <n> --value <file|->
                  [--causation <file>] [--metadata <file>] [--json]
hive comb effect resolve <run-id> <effect-key>
                  --outcome confirmed|not-executed|failed --from <evidence.json> [--json]

hive comb migrate-flow <flow-name> --out <comb.json> [--json]
```

`--input` is always one JSON value, never repeated `key=value`; Pollinate invokes `--input -` and writes the mapped JSON value to stdin. `-` reads stdin. `--graph -`, `--input -`, `--event -`, or `--value -` cannot share one invocation's stdin. Trigger invocation therefore carries the optional canonical event as one argv-safe `--event-json` value. Human/manual callers should prefer a file for large events.

`--origin-trigger` and `--origin-delivery` are an all-or-none provenance pair. `--event-json` is optional but legal only with that pair. Trigger calls must also pass `--version`; an unversioned trigger run is `invalid_argument`. `originDelivery` is the durable instantiation idempotency key. When present, event JSON must be a `RoutedRunEvent` whose `triggerId`/`deliveryId` equal the flags. `--collision` may only make the definition's claim policy stricter, never weaker.

`hive comb run ... --bee` is the canonical adoption form; the earlier `hive comb adopt` sketch is removed. `--bee` requires a named registry comb, input, and optional entry. Ad-hoc graphs cannot adopt in phase 1.

`hive comb default set` verifies the immutable comb version exists, selects the default slot when neither tag nor kind is supplied, and performs the same product-config lock/CAS/increment as `product apply`. Exactly one of tag/kind may be supplied. `defaults` is a derived read across configs, sorted by product and selector; it never exposes an unversioned name.

When `hive spawn --comb` omits `--comb-input`, Honeybee proposes `{ "bee": { "name": <name>, "id": <id-or-null>, "cwd": <cwd> } }` during preflight; no process/work prompt starts until it validates. `hive comb run --bee` requires explicit input because an already-running bee may need domain context beyond its session record.

`hive comb status` without an ID resolves only `status="current"` entries in `SessionRecord.combActivations`. Zero matches is an error; one is selected; multiple produce `ambiguous_activation` and list candidates. The same rule applies to agent `report`. Explicit flags always win. Historical entries exist only to route late old-attempt evidence inertly. Capability-bound environment variables may supply an exact activation to engine-spawned bees, but are not trusted without matching the session binding.

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

Every `hive comb ... --json` invocation writes exactly one envelope plus one trailing newline to stdout. Human diagnostics go to stderr. Commands never mix JSONL with this envelope; `comb events` returns an array inside it. Exit codes are canonical: `0` valid success/acknowledgement (including `accepted:false`), `2` invalid argument/schema, `3` not found, `4` version/claim/idempotency conflict, `5` ambiguous activation or approval required, `6` unresolved effect ambiguity, `7` external dependency/transient transport failure, and `70` internal/corrupt-state failure. Pollinate retries only exit `7`/transport failure; it never infers acceptance from exit 0 alone.

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
      | "external_dependency"
      | "corrupt_state";
    message: string;
    details?: JsonValue;
  };
};
```

Exact principal results:

```ts
// comb.define / comb.promote
{ comb: StoredCombVersion; created: boolean }

// comb.lint
{ valid: true; definitionDigest: string; normalized: CombSpec; warnings: string[] }

// comb.inspect
{ comb: StoredCombVersion }

// comb.product.show / comb.product.apply
{ config: ProductCombConfig; updated: boolean }

// comb.defaults
{ defaults: CombDefaultView[] }

// comb.default.set
{ config: ProductCombConfig; selected: CombDefaultView; updated: boolean }

// comb.run
{
  run: RunBoardView;
  created: boolean;
  joinedExisting: boolean;
  replayedDelivery: boolean;
  intakeReady: boolean;
}

// comb.list
{ combs: Array<{ index: CombRegistryIndex; latest: StoredCombVersion }> }

// comb.runs (default and --board are the same bounded projection)
{ runs: RunBoardView[]; nextSince?: string }

// comb.status
{ run: RunView; hydratedActivation?: ActivationRecord }

// comb.cancel
{ runId: string; status: "cancelled"; fence: CancellationFence; cleanup: RunCleanupRecord }

// comb.events
{ runId: string; after: number; events: RunEvent[]; nextAfter: number; hasMore: boolean }

// comb.report
{ runId: string; activation: ActivationAddress; evidenceIds: string[]; deviationIds: string[] }

// comb.event
{ runId: string; subscriptionIds: string[]; ack: IntakeAck }

// comb.observe
{ observationId: string; deliveries: ObservationDelivery[]; ack: IntakeAck }

// comb.propose-amendment
{ amendment: AmendmentRecord; currentRevision: number; currentDigest: string }

// comb.effect.resolve
{ runId: string; effect: EffectRecord }

// comb.migrate-flow
{ sourceFlow: string; outputPath: string; report: FlowMigrationReport; skeleton: CombSpec; warnings: string[] }
```

Canonical result types:

```ts
export type IntakeAck = {
  accepted: boolean;
  reason: "accepted" | "duplicate" | "stale" | "terminal" | "no-matching-subscription" | "no-active-consumer" | "ordering-conflict";
  eventId: string;
};

export type ObservationDelivery = {
  runId: string;
  subscriptionId?: string;
  verifierEffectKey?: string;
  accepted: boolean;
  reason: IntakeAck["reason"];
};

export type CombDefaultView = {
  productKey: string;
  selector: { kind: "default" } | { kind: "tag"; value: string } | { kind: "bee-kind"; value: string };
  comb: { name: string; version: number };
  configRevision: number;
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
  deviationCount: number;
  evidence: Array<Pick<EvidenceRef, "id" | "kind" | "producer" | "recordedAt" | "summary">>; // newest 3
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

export type RunView = RunRecord;
```

`--last` defaults to 200 and sorts by `(updatedAt,id)` descending. `--active` is exact shorthand for `--status active` plus cleanup-pending terminal runs. `--since` filters `updatedAt` strictly greater than the supplied timestamp. Board results inline all non-archived activation summaries but never raw evidence payloads or archived attempt bodies, preventing N+1 status reads without making board cost unbounded.

`comb events` defaults `after=0` and `limit=256`; `after` is exclusive. Events are returned in increasing sequence. `nextAfter` is the last returned sequence (or the input cursor for an empty page), and `hasMore` is computed from `nextEventSequence`, so clients resume without timestamp races.

A refused claim exits `4`, writes the failure envelope, and sets `error.details` exactly to `{claimId, holdingRunId, holdingRunStatus, cleanupStatus}`. Pretty stderr includes the stable line `claim conflict: held by <holdingRunId>`; consumers use JSON, never scrape it.

`comb.event` and `comb.observe` exit 0 for every schema-valid, durably classified intake result. `accepted:false, reason="terminal"` is the canonical leak-guard acknowledgement: Pollinate closes/drops that binding and does not count a delivery error. `duplicate`, `stale`, and `no-*` also do not retry. `ordering-conflict` records a violation and stops retry because replay cannot repair a reused source sequence. Invalid envelopes exit 2; lock/I/O/transient adapter failures exit 7 and remain in Pollinate's outbox.

For `comb.observe`, the top-level ack is `accepted=true,reason="accepted"` when at least one delivery accepted. It is `accepted=false` with `duplicate`, `stale`, or `ordering-conflict` only when every matched consumer has that classification; otherwise no match is `no-active-consumer`. Per-consumer truth remains in `deliveries`. A mixed accepted/duplicate retry therefore succeeds without duplicating state.

`comb event` addresses one run and fans the event only into its matching `RunSubscription` records. `comb observe` has no run/node address: under the runs-index read it finds every active subscription **and every resolvable current-snapshot action verifier** matching observation type plus exact subject kind/key/revision, then locks/delivers to runs in sorted run-ID order. Verifier observations replace the ordered value in `verifierObservationCache`; its cardinality is bounded by resolvable action-verifier subjects, not event count. The result lists each consumer; failure of one run is exit 7 and the same event ID is retried/idempotent for all, including consumers that already accepted it. This gives a strict verifier an intake path even when no graph subscription exists. A verifier subject that cannot yet resolve requests coverage only when it resolves; strict/terminal sources are poll-backed, so current state is re-emitted rather than depending on an early webhook.

`hive comb events` is the canonical bounded per-run feed; the existing `hive events --json` JSONL surface remains the global ledger stream. Both project these event types:

```text
comb.defined
comb.promoted
comb.run.started|done|failed|cancelled|cleanup_complete
comb.activation.pending|active|waiting_human|waiting_event|done|failed|skipped
comb.edge.fired
comb.deviation
comb.evidence.recorded|late_cancelled|late_invalidated|stale_verdict
comb.effect.prepared|confirmed|failed|ambiguous|resolved
comb.claim.prepared|held|joined|released
comb.subscription.registering|active|coalesced|queued|stale|tearing_down|released|failed
comb.amendment.proposed|awaiting_approval|quiescing|quiesce_stalled|applied|rejected|conflict
comb.violation
```

Every projected event includes `eventId`, `run`, `sequence`, `ts`, and optional activation fields.

### 5.3 Spawn-time track pane/brief contract

`hive spawn --comb` is fail-closed. Before launching a harness it resolves the pinned definition/product/defaults, preallocates the session name/ID used by default input, constructs and validates input, derives the entry, checks the claim, and reserves a run ID. It then launches the session in bootstrap-hold with no user work prompt, durably creates the run/session activation binding, confirms required registration effects, and finally sends one combined original brief plus track contract. If any step before prompt delivery fails, Honeybee retires the held bee; if retirement fails, it marks the session `track_attach_failed`/NeedsMe and never delivers the work prompt. The command exits nonzero with the original error and quarantine details. A working bee never gets a fail-open window.

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

### 5.4 Canonical Pollinate transport contract

Pollinate's run action uses this exact argv shape and stdin division; `<event-json>` is canonical compact JSON with no shell evaluation because Pollinate calls `execFile`/argv directly:

```text
hive comb run <comb> --version <n> --input - --cwd <cwd> --product <key>
  --origin-trigger <trigger-id> --origin-delivery <delivery-id>
  --event-json <event-json> --json
```

It writes exactly the mapped JSON input to stdin, requires exit 0, validates `command="comb.run"`, and reads `result.run.id`, `created`, `joinedExisting`, and `replayedDelivery`. It does not parse a stdout token. A fresh result emits one `run_started`; joined/replayed results do not. Trigger action definitions must contain literal `comb` and integer `version`; templated comb names and unversioned refs fail Pollinate normalization. Composer ordering is: define/idempotently recover immutable comb version, then save the trigger pinned to that version. A failed trigger save leaves only an unreferenced comb version; existing triggers continue using their old version.

Run-targeted events and subject-addressed observations are durable at-least-once. Pollinate writes an outbox record before the first `comb event`/`comb observe`, keeps stable event/delivery IDs across attempts, retries transport failures and exit 7 with bounded exponential backoff, and removes the record only after parsing an exit-0 `IntakeAck`. Poll-cursor advancement occurs only after the outbox write, never after best-effort delivery. Retention is at least seven days and 100,000 records per installation; exhaustion pauses the affected trigger and alarms rather than dropping the oldest undelivered terminal event. Strict/terminal observations additionally require a poll-backed source so a missed webhook is eventually re-observed with a new higher subject sequence.

Honeybee's `src/comb/pollinate.ts` consumes this exact `pol` adapter surface. Every command emits one `{ok,command,result|error}` envelope; exit codes use 0/2/3/4/7 with the same meanings as above.

```text
pol bindings register --trigger <trigger-id> --target-kind comb-run --target-id <run-id>
  --subject-kind <kind> --subject <key> --event-kinds <comma-list>
  --owner <run-id>:<subscription-id> --idempotency-key <effect-key> --json

pol bindings unregister --binding-id <binding-id>
  --owner <run-id>:<subscription-id> --idempotency-key <effect-key> --json

pol observe request --trigger <trigger-id> --subject-kind <kind> --subject <key>
  --event-kinds <comma-list> --owner <run-id>:<subscription-id>
  --idempotency-key <effect-key> --json

pol observe release --request-id <request-id> [--binding-id <binding-id>]
  --owner <run-id>:<subscription-id> --idempotency-key <effect-key> --json
```

```ts
// pol.bindings.register
{ bindingId: string; created: boolean; owner: string }
// pol.bindings.unregister
{ bindingId: string; removed: boolean; owner: string }
// pol.observe.request (owner-scoped/ref-counted; never keyed only by trigger+subject)
{ requestId: string; created: boolean; owner: string; refCount: number }
// pol.observe.release
{ requestId: string; released: boolean; owner: string; refCount: number }
```

Routed-subscription registration order is binding register, persist `bindingId`, coverage request, persist `coverageRequestId`; action watches perform only the coverage step. `intakeReady=true` follows confirmation of every initially resolvable requirement. A duplicate effect returns the same IDs. Teardown order is the cancellation sequence in §3.5: unregister the exact routed binding, then release every exact owner-scoped coverage ref. `pol` must accept the persisted IDs; lookup-by-pattern and three-strikes GC are repair safety nets, not the normal protocol.

Exit 7 registration/coverage failures retry with run policy backoff and stable effect keys. While retrying, the run is `active` with `intakeReady=false` and no graph executor effect. Exhaustion fails the run with `external_dependency` and enters the same teardown/claim-retention path; it never degrades to an unregistered long-lived run.

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
3. `hive comb migrate-flow` is a lint/report and re-authoring aid, not an op-by-op converter. It writes a deliberately incomplete comb skeleton with source comments/warnings and never auto-defines it. Operators author, lint, and define the result explicitly.
4. JSON and TS flows cannot be certified as semantically equivalent combs: closures/placeholders may branch, call external modules, or perform undeclared effects, and even declarative op order does not encode binding/subject/claim semantics. The report calls these out rather than manufacturing a runnable graph.
5. Once all stored v1 definitions/triggers are migrated, `hive flow` disappears from top-level help but handlers remain for historical inspection/execution until a separately announced removal. It is never aliased to `hive comb`, because their execution and safety semantics differ.

### 6.2 Re-authoring report

```ts
export type FlowMigrationReport = {
  schemaVersion: 1;
  sourceFlow: string;
  sourceKind: "json" | "typescript";
  args: Array<{ name: string; required: boolean; defaultValue?: JsonValue }>;
  findings: Array<{
    code: "external-call" | "runtime-branch" | "placeholder" | "wait" | "spawn" | "kill" | "seal" | "return" | "cleanup-policy" | "unknown";
    sourceRef: string;
    summary: string;
    requiresHumanDesign: true;
  }>;
};
```

`FlowMigrationReport` inventories flow args, ops/closure source, placeholder names, cleanup policy, waits, returns, and external calls. The skeleton contains input/output contract TODOs and one disabled annotation per likely work step; it contains no action binding, claim, subscription, edge, binding strength, or executable node unless the operator authors it. The command exits 0 because producing a report succeeded, with `warnings` explaining that behavior is not converted. `hive comb lint` rejects the incomplete skeleton until TODO/disabled annotations are resolved. This implements concept v2's settled re-authoring decision without claiming mechanical equivalence.

### 6.3 Pollinate transition

Pollinate currently has `HoneybeeAction { run: "flow" }` and shells to `hive flow run` in its `src/types.ts`/`src/actions.ts`. It adds `run: "comb"` with a literal name and required immutable version, renders one JSON input to stdin, supplies provenance plus the canonical event, invokes the exact §5.4 argv, and stores `result.run.id`. Existing `run: "flow"` triggers continue unchanged until re-authored. Router targets distinguish run IDs from bee names. Pollinate implements the durable outbox/at-least-once guarantee before any event-only or strict-observation comb is enabled.

### 6.4 Loop facade

The existing `hive loop` is a built-in TS flow whose stop surface includes command predicates, pane sentinels, and judge agents (`src/loop/control.ts`, `src/loop/stopConditions.ts`). Those cannot be represented honestly with the fixed phase-1 predicate vocabulary.

Therefore phase 1 does not pretend to convert it. Before flow-v1 runtime removal, its detached process host, `BeeHandle`, and minimal facade are extracted into loop-owned/shared modules so `hive loop` behavior remains unchanged. It is a compatibility facade, is not a Comb registry entry, and does not appear on the Flightboard as a run. A future loop-to-comb change requires either removing unsupported stop modes or an explicit concept decision expanding predicate vocabulary; this design does neither.

## 7. Staged build plan

Each slice is independently mergeable, testable, and disabled from effects until its final step.

1. **Formats, SDK, and immutable registry.** Add types, canonicalization, schemas, JSON/TS `define`, list/inspect, product config, binding resolution, and promote-from-synthetic-snapshot tests. No daemon change.
2. **Durable run/claim store and read surfaces.** Add run IDs, atomic run mutation, subject claim prepare/confirm/join/release, snapshot revision 0, run/runs/status/cancel JSON surfaces. Runs can be instantiated but a feature flag keeps execution disabled.
3. **Pure reconciler.** Implement activation evidence matching, attempts, edge firing, waiting clock edges, joins, aggregate output, retries, terminal derivation, event projection, and property tests. Add daemon dispatcher with fake/no-op effect executors.
4. **Agent and attached-track execution.** Add deterministic cold spawn/adoption, completion contracts, seal `output`, SessionRecord activation bindings, fail-closed `spawn --comb`, `comb run --bee`, `report`, retry re-brief, and cancellation retirement. Enable agent-only combs.
5. **Checkout and flight capacity.** Extend pool claim ownership/renewal/release; wire per-node checkout needs. Integrate the flight capacity-provider interface when available. Cold spawn remains the supported fallback only when the definition explicitly asked for spawn; a failed flight lease is not silently converted.
6. **Engine predicates and action bindings.** Add the five fixed predicates (including deterministic `output-equals`), deterministic/agentic binding executors, preflight/postflight attribution records, verifiers, strict external-state violation detection, cancellation ambiguity, and manual effect resolution. Enable trusted registry combs with actions. Intent requests remain out of phase 1.
7. **Forum human nodes and strict-graph approvals.** Land the Forum/review-desk prerequisites, add packet lifecycle adapter, human output/context, stale successor behavior, approval packets, and gate-removal enforcement.
8. **Amendments and child runs.** Add JSON patch CAS/quiesce, one child primitive, fan-out/item activations, depth/cancellation inheritance, and promote-from-live-run.
9. **Pollinate observations/subscriptions.** Add `comb observe`, coalesce/queue behavior, CI evidence, subject supersession, Pollinate run targets, and router cancellation handling.
10. **Flow migration and documentation.** Ship the migration report/skeleton aid, extract loop's legacy runtime dependency, label `hive flow` legacy, update CLI reference/completions, and re-author first-party Pollinate flow actions.

The execution feature flag is removed only after slices 1–9 pass full test/build and at least one manual attached track verifies packet rejection/iteration/approval/land in a disposable repo.

## 8. Test plan

The repository's existing `node:test` style and dependency injection are retained. Every logic branch below receives unit or integration coverage.

### 8.1 Unit tests

- Comb grammar: IDs, endpoints, joins, cycles, guided expectations, engine strictness, all five fixed predicates, waiting clock edges, child sources, input/output schemas, and function rejection in TS exports.
- Canonicalization/digests: object-order independence, array-order significance, duplicate define no-op, registry CAS, immutable prior versions, source provenance.
- Value mapping/templates: every source root, JSON Pointer escaping, current-lineage retry selection, same/index/aggregate item selection, deterministic multi-terminal run output, `output-equals` scalar/object/array/null equality, no coercion, missing-path false, pre-output waiting, and no expression evaluation.
- Product resolution/bindings: pro cwd match, explicit product fallback, missing intent, stable binding digest, snapshot isolation from config edits.
- Activation rule: reuse every case in `tests/activation.test.ts`, then add subject-key/revision mismatch, item-index key uniqueness, and stale downstream invalidation.
- Machine: forward-condensation entry activation, explicit retry cohorts, waiting-only non-entry targets, every activation status, invalid seal output, retry/backoff, timeout edges, fail edges, skipped branches, all/any/quorum/tolerance joins, aggregate counts, and terminal output. The human-last track is a required fixture.
- Property tests modelled on `tests/flight-machine.test.ts`: across generated evidence/edge sequences, no activation reaches done without matching evidence; no effect is planned twice; cancelled runs plan no new effects; attempts never overwrite history.
- Claims: canonical value hashing, refuse/join-existing, prepared-claim repair, terminal release, simultaneous allocator races under the actual file lock.
- Subscriptions: register/coverage ordering, at-least-once dedupe, 1,024-ID bound, queue order, lower-after-higher source order, same-sequence conflict, coalesce cleanup, bee retirement, inert invalidated evidence, subject revision supersession, and cancelled terminal acknowledgement.
- Amendments: patch grammar, done-node rejection, active quiesce deadline, packet supersession before apply, stale-digest verdict ignore, successor linkage within one stable thread, CAS race, approval policy, human-gate bypass detection, and new-intent binding resolution.
- Effect identity: planner reordering, insertion, restart, and fan-out never change a semantic key; same key/different request digest halts.
- Retention: evidence content addressing, stable session evidence IDs, event-tail rollover, attempt compaction/hydration, dirty-check no-op tick, and board payload budget.
- Guided conformance: each evidence heuristic, self-reported deviation, deviated-then-done representation.
- Pool extensions: legacy claim normalization, comb owner renew/release, exclusive/shared capacity, crash expiry, no oversubscription race.

### 8.2 Controller/executor integration tests

Use a temporary `HIVE_STORE_ROOT`, injected clock, fake session/seal/Forum/Pollinate/flight/action dependencies, and real atomic files/locks.

- Run creation through registry/ad-hoc/attached/child modes; depth and claim collision.
- Full agent node: prepare persisted before fake spawn, deterministic confirm, crash after spawn then adoption, wrong-contract collision violation, schema-valid/invalid seals, idle stall.
- Fault injection at every prepare/execute/confirm boundary for spawn, Forum, action, child, and checkout. Assert no duplicate irreversible call.
- Cancellation before prepare, after prepare, during execute, before confirm, and after confirm; cancelled cleanup-pending discovery; claim retention; exact unregister/release order; cascade to children; packet withdrawal; terminal ack; late evidence ignored; blocked ambiguity resumes after resolution.
- Human lifecycle: create, needs-review, approve, request changes, same-revision rerequest, comment in downstream brief, stale revision successor, blocking-since clock edge.
- Strict actions: unsatisfied preflight, already-satisfied violation, out-of-band race between preflight/execute, operation/effect attribution success and mismatch, no-op landing, sweep detection before node activation, agentic binding, verifier wait, untrusted graph approval, and amendment that changes digest.
- Child composition/fan-out: ordered item indices, partial failures/tolerance, aggregate output, parent output, root cancellation.
- Checkout use in agent and deterministic action nodes; claim renewal while long-running; release on every terminal path.
- Flight lease adapter: unavailable, acquired, crash adoption, release, node-unreachable clock hold. The provider is faked until the flight-side contract lands.
- Daemon dispatcher isolation: one corrupt/erroring run does not block another run or later flight/pool stages; timeout returns an error outcome.
- Run event projection retry and duplicate `eventId` behavior after simulated append/write crashes.

### 8.3 CLI and migration tests

- Every command's pretty form, success envelope, error envelope/code/exit table, stdin handling, and stdout purity; schema-valid duplicate/stale/terminal intake is exit 0 with `accepted:false`.
- Agent activation inference: zero/one/multiple bindings and explicit addressing.
- `spawn --comb` preflight refusal before launch, bootstrap-hold success, prompt withheld through registration, retirement on attach failure, and visible quarantine when retirement fails; no unconstrained bee receives work.
- JSON/TS flow migration-report fixtures; skeleton remains lint-invalid until manually authored; no source or historical run mutation.
- A versioned shared golden corpus under the reconciliation workstream covers argv, stdin, envelopes, and exit codes for run creation/replay/join/refusal, event, observe, registration/coverage, terminal ack, defaults, board reads, and events. Honeybee consumes the corpus verbatim rather than copying fixtures.
- Cross-repo fault injection covers engine-down redelivery, cursor/outbox crash boundaries, manual-claim join, racing push supersession, cancel during delivery, register/coverage partial failure, strict execute/confirm crash, and active amendment with a late old-digest verdict.
- Forum fixture parsing success, replay, and failure envelopes; invalid command/result shapes fail closed.

### 8.4 Repository gates and manual verification

Each slice runs targeted tests, `npm run check`, `npm test`, and `npm run build`. Complex cross-application UI is not automated in Honeybee. Manually verify in Apiary after its implementation: Flightboard live graph, attempt history, child drill-in, deviation feed, attached-track bee affiliation, review-desk graph diff for amendment/approval, successor packets rendered as one thread, and violation alarm visibility.

## 9. Canonical cross-system contracts

These are normative composed contracts, not assumptions. Current code gaps are rollout blockers. Pollinate, Forum, and Apiary phase-1 designs and shared fixtures align to these shapes and sequences.

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

2. **Forum command and mutation contract.** `forum packet create|update|list|show|status|feedback|rerequest|successor|supersede` emits exactly one `{ok,command,result|error}` envelope. Create, update, successor, rerequest, and supersede require/replay `--idempotency-key`; lookup by `source_dedupe_key` recovers a crash after execute. Exit 0 is a validated result, 2 invalid input/unsupported kind, 3 not found, 4 stale revision/idempotency conflict, and 7 dependency failure. Honeybee does not enable a human executor until rerequest/supersede implement this contract.

3. **Forum review lifecycle.** Statuses/transitions remain `needs_review -> in_review -> changes_requested|approved`, `changes_requested -> needs_review`, `approved -> resolved`, any nonterminal -> `superseded|archived`. Rerequest follows `changes_requested -> needs_review` idempotently. Honeybee polls packet state in batches and never writes a verdict. For `origin=comb`, Forum/Apiary suppresses legacy downstream queue/spawn/PR-comment behavior; Honeybee alone consumes the destination and routes the graph retry exactly once.

4. **Forum packet and verdict pins.** Forum accepts `origin="comb"`; ordinary node kinds remain `web|desktop|cli|code`, while `amendment|approval` are first-class and never coerced to `code`. Every comb packet stores `{runId,nodeId,itemIndex,snapshotRevision,definitionDigest,actionBindingDigest,subject,graphBase?,graphProposed?}`; amendment/approval graphs are inline in phase 1. The queryable verdict is exactly `{verdictId,packetId,verdict:"approve"|"request_changes",message:string|null,destination:ReviewFeedbackDestination,actor:{id:string,name?:string},snapshotRevision,definitionDigest,actionBindingDigest,subject,decidedAt}`. Missing/mismatched pins or actor make it unusable evidence; unknown packet kinds are unreviewable, not fail-open.

5. **Forum feedback destination.** The canonical union is `{type:"bee",sessionId:string}|{type:"new-agent"}|{type:"pr-comment"}`. Forum owns the deterministic mapping from legacy `routability`/`session_id` and returns only this union to new consumers. `bee` must identify a Honeybee session, not a comb node ID; Honeybee maps that session to the new attempt binding.

6. **Forum packet interaction with amendments/supersession.** Stable source dedupe and bidirectional successor links are required. Before applying an amendment, Honeybee supersedes every affected active packet and waits for confirmation; after apply, old-digest verdicts are logged/ignored. Subject-revision movement creates a successor in the same `HumanPacketThread`, and Forum/Apiary renders that chain as one review thread per §2.7.

7. **Pollinate comb action.** Pollinate adds `{kind:"honeybee",run:"comb",comb:string,version:number,input:JsonValue,collision?:"refuse"|"join-existing"}`. `comb` is literal and `version` required. It uses the exact §5.4 JSON-stdin/provenance argv, validates the envelope, and reads `result.run.id`; `run:"flow"` remains unchanged during re-authoring. Composer commits define an immutable version before saving the version-pinned trigger, so a partial save cannot retarget old triggers.

8. **Pollinate trigger delivery.** Every instantiation supplies `triggerId`, globally unique `deliveryId`, one `RoutedRunEvent`, and JSON input. Delivery ID is Honeybee's run-instantiation idempotency key. Pollinate's durable outbox makes run events at-least-once; cursors advance only after outbox persistence. Honeybee's subject claim, not Pollinate dedupe, is authoritative for cross-trigger/manual exclusion. Join-existing succeeds only with the §2.11 subscription match and atomically stores the event; Pollinate creates no second binding/row and emits no `run_started`.

9. **Pollinate observations.** All non-Forum external facts use `ObservationPayload` and the subject-addressed `hive comb observe` signature in §5.1; Pollinate never targets a run/node for an observation. The required logical shape is:

   ```ts
   {
     eventId: string;
     observationType: string; // "ci-status" for the phase-1 predicate
     subjectKind: string;
     subjectKey: string;
     subjectRevision: string;
     observedAt: string;
     order: { sourceId: string; subjectSequence: number };
     value: JsonValue;
     causation?: { effectKey?: string; operationId?: string };
     metadata?: JsonObject;
   }
   ```

   Pollinate observation specs have an explicit revision JSONPath and normalizers emit stable event IDs, subject sequences, and head revisions (for GitHub PR/checks, the PR/check head SHA). Revision-sensitive/strict combs stay disabled until the chosen plugin provides them. Delivery is at-least-once; Honeybee fans out to matching active subscriptions and action verifiers and applies watermarks. Pollinate never sends credentials or asks Honeybee to fetch external state directly.

10. **Pollinate router/registration target.** Router bindings distinguish `{kind:"run",runId}` from bees. Honeybee owns node-subscription registration through the exact `pol` adapter commands/effects in §5.4 and persists IDs. `onActivity` calls `comb event`; `onClose` calls cancel according to trigger config. Terminal acknowledgement closes/drops the binding. Pollinate owns binding/coverage substrates; Honeybee owns run subscription truth and teardown ordering.

11. **Delivery/ordering policy ownership.** Pollinate assigns monotonic per-subject sequences and preserves stable event IDs across retry; Honeybee applies node-local queue/coalesce and activation cleanup. Pollinate does not independently coalesce after outbox persistence. Lower-after-higher events receive a stale acknowledgement; a sequence collision is a violation. Webhook loss is repaired by the poll-backed source required for terminal/strict state.

12. **Apiary ownership/read contract.** Apiary creates/edits Yjs drafts but commits only through `hive comb lint/define`; it never writes or treats private Honeybee files as API. It watches the canonical roots only to invalidate per-ID cache, then consumes `comb list`, `runs --board --last`, `status`, `events --after`, and `defaults`. It caches by `(runId,updatedAt,lastEventSequence)`, refreshes only changed runs, and broadcasts diffs rather than the full mirror.

13. **Apiary normative shapes/Flightboard.** Engine-owned `CombSpec`, `RunBoardView`, `RunView`, and envelopes in §§2/5 are the wire types; Apiary derives presentation fields and must not recommit aliases such as `rev`, `when.verdict`, or string origins. Bee affiliation indexes every `beeHandle` to every activation reference. Events dedupe by `(run,sequence,eventId)`. NeedsMe is unchanged. There is no phase-1 violation-ack state or command; the UI must not invent one.

14. **Architecture ownership update.** The Apiary repo's `docs/architecture.md` is updated to make Honeybee authoritative for comb registry/runs and Apiary authoritative only for drafts/read models. Honeybee currently has no `docs/architecture.md`; no local file should be invented for this migration.

15. **Seal extension.** Honeybee Seal v2 remains additive and agents can include `output: JsonValue` alongside current `taskId`, `attempt`, and evidence fields. Existing seals without output remain valid generally but cannot complete a comb node whose output contract requires data.

16. **Session/agent delivery.** `spawnBee` persists a normal held `SessionRecord`, but attached-track user work is delivered only after §5.3 validation/attachment/registration. HSR prompts use existing control delivery, and `scanLatestSeal`/daemon-derived `BeeState` remain available. `combActivations` preserves current and historical attempt bindings; late old-attempt seals are routed to their invalidated address and ignored rather than compared with the new attempt.

17. **Checkout pools.** `pro pool ls --porcelain` and existing Honeybee pool resolution remain authoritative for config/members. Phase 1 pool checkouts are local. Pool file locks serialize claim/renew/release, and a comb-owner claim counts against occupancy until released/expired.

18. **Product identity.** Product keys resolve from pro area/project/repo facets by cwd, or are explicitly supplied. Apiary and Pollinate pass the same cwd/product key. There is no implicit global `land` binding.

19. **Action verification.** Product owners configure explicit unsatisfied/success values and effect-key/operation-ID attribution for every strict `land`/`run` binding. Pollinate delivers preflight/postflight observations and causation; a binding may not make Honeybee fetch external APIs. Bindings without causal observability cannot be enabled as strict phase-1 actions.

20. **Filesystem/single-writer behavior.** One Honeybee daemon reconciles a given `HIVE_STORE_ROOT`. CLI mutations may race it but use the same per-run/claim/pool locks. Multiple computers with separate store roots exchange events through Pollinate/Apiary; the design does not assume a safe distributed filesystem lock.

21. **Approval identity/staleness.** Forum verdict envelopes identify the human actor and pin snapshot revision, graph/binding digests, and subject. Missing pins are unusable evidence and alarm as an integration error. Well-formed verdicts for an older subject or snapshot are expected race artifacts: Honeybee logs `stale_verdict` and ignores them, never violates or releases the amended path.

22. **No hidden compensation.** Cross-repo partial action success is terminal/ambiguous and surfaces for human resolution. No other system assumes Honeybee will automatically compensate a landed target in phase 1.

## 10. Repair-round closure map

| Finding | Canonical resolution |
|---|---|
| C1 | JSON-stdin, version-pinned run argv and `result.run.id` envelope: §§5.1, 5.2, 5.4. |
| C2 | Targeted `comb event` plus subject-addressed/fan-out `comb observe`, exact acks: §§2.7, 5.1, 5.2. |
| C3 | Durable at-least-once outbox, cursor ordering, poll fallback, retry classification: §§5.2, 5.4, 9.8–9.11. |
| C4 | Persisted binding/coverage identity, semantic effects, register/teardown ordering: §§2.7, 2.8, 3.1, 3.5, 5.4. |
| C5 | Trigger/delivery/event provenance, delivery-id replay, join match and caller behavior: §§2.7, 2.11, 3.1, 5.1. |
| C6 | Explicit forward/retry/waiting edges, forward DAG, cohort joins, track fixture: §§2.2, 3.3. |
| C7 | Board/events/default commands, flags, watch roots, holder details, envelopes: §§2.12, 5.1, 5.2. |
| C8 | Bounded aggregate/tails, evidence/effect/snapshot archives, dirty checking and board budget: §§2.6–2.8, 2.11, 2.12, 5.2. |
| C9 | Intent requests removed from phase 1: §2.7 and CLI/build-plan deletions. |
| C12 | Unsatisfied preflight, causal postflight, and sweep attribution alarms: §§2.4, 2.8, 3.4. |
| C13 | Required subject revision/source order and Pollinate normalizer gate: §§2.7, 5.1, 9.9. |
| C14 | Packet graph/snapshot pins, pre-apply supersession, stale-verdict ignore, quiesce deadline: §§2.7, 2.10, 3.4, 9.4–9.6. |
| C15 | Same-bee attempt rebind/re-brief plus explicit dead-bee policy: §§2.5, 3.4. |
| C16 | Monotonic watermark, activation cleanup, inert late evidence and edge prohibition: §2.7. |
| S1 | Cleanup-pending sweep selection, ordered teardown, claim retention: §§2.8, 2.11, 3.2, 3.5. |
| S2 | Track prevalidation/bootstrap hold/quarantine; prompt delivered last: §§3.1, 5.3. |
| S4 | Current-lineage/item output selection and deterministic run output mapping: §§2.1, 2.2. |
| S5 | Immutable trigger version and safe define-then-save retry: §§5.4, 9.7. |
| S6 | Durable actor/digest-pinned Forum approvals; unknown kinds unreviewable: §§3.4, 9.2–9.4. |
| S8 | Honeybee sole feedback router for `origin=comb`: §§2.7, 9.3. |
| S9 | Semantic effect keys independent of planner order: §2.8. |
| S10 | Exit-0 `{accepted:false,reason:"terminal"}` and field-driven GC: §5.2. |
| E1 | Resolved: fifth fixed predicate `output-equals` compares an RFC 6901 field path on schema-validated current-lineage output with a literal; no expression language: §§2.2, 3.4. |
| E2 | Resolved: one logical thread per human node/item; revision supersession creates a linked successor packet and the desk renders the chain as one thread: §§2.7, 9.6. |

## 11. Seal summary

Implementation target: `docs/COMBS_ENGINE_DESIGN.md`.

This repair resolves the engine-owned review clusters and makes the document canonical for composed CLI, JSON, delivery, registration, ordering, attribution, packet, projection, persistence, and teardown contracts. The E1/E2 rulings are final here: `output-equals` is the sole output predicate, and successor packet chains are one logical human-node thread. The design replaces flow v1 with immutable comb versions and daemon-reconciled, snapshot-isolated runs; reuses the flight activation/idempotency rule; and specifies agent, human, engine, child, claim, cancellation, checkout, amendment, and enforcement behavior down to persisted field and CLI-envelope shapes.

Top three open risks:

1. Pollinate must implement and prove the durable at-least-once outbox plus revision-, ordering-, and causation-bearing observations before event-only or strict-action combs are enabled.
2. Forum/review-desk must implement idempotent successor/supersession, digest-pinned verdicts, and one-thread rendering across packet chains before human/amendment executors are enabled.
3. The in-progress flight controller still needs the atomic capacity lease/adoption interface before flight-backed agent nodes are enabled.
