// Shared helpers for the execution-protocol (H1) test suites. Not a test file
// itself (the runner globs tests/*.test.ts only).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "../src/comb/canonical.js";
import type { JsonValue } from "../src/comb/types.js";
import type { JsonObject } from "../src/execution/contract.js";
import { nativeIsolationManifest } from "../src/execution/describe.js";
import {
  installLocalAuthorityHostBinding,
  loadNodeIdentity,
  type ExecutionBindingRecord,
} from "../src/execution/nodeState.js";
import { beeNameForRun, runKey, type RunEnvironmentFacts } from "../src/execution/runStore.js";
import { createExecutionService, storeSessionEvidenceSource, type ExecutionService, type RunLauncher } from "../src/execution/service.js";
import { HarnessDispatchError, type HarnessControl, type HarnessStopResult } from "../src/execution/harnessControl.js";
import { generateExecutionKeyPair, signCanonical, type ExecutionKeyPair } from "../src/execution/signing.js";
import { saveSession } from "../src/store.js";

export const OWNER_SCOPE = "oscope-local-1";
export const WORKSPACE = "wsp-alpha";
export const SNAPSHOT_DIGEST = "sha256:1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f";
/**
 * The CANONICAL Apiary nodeId bound at install time (LocalAuthorityManifest
 * hostNodeId shape). Deliberately different from the Honeybee-minted internal
 * identity so tests prove the public protocol speaks the bound id.
 */
export const CANONICAL_NODE_ID = "node-0a1b2c3d-apiary-host";

/** Fresh HIVE_STORE_ROOT per test. */
export async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-execution-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

export type TestAuthority = { authority: ExecutionKeyPair; binding: ExecutionBindingRecord; nodeId: string };

/** Mint a LocalAuthority key pair, install its host binding, load node identity. */
export async function installTestAuthority(): Promise<TestAuthority> {
  const authority = generateExecutionKeyPair();
  const binding = await installLocalAuthorityHostBinding({
    ownerScopeId: OWNER_SCOPE,
    bindingId: "bind-0001",
    authorityId: "la-0001",
    authorityEpoch: 1,
    authorityPublicKey: authority.publicKey,
    nodeId: CANONICAL_NODE_ID,
  });
  // Minted for signing custody; the PUBLIC node identity is binding.nodeId.
  await loadNodeIdentity();
  return { authority, binding, nodeId: binding.nodeId };
}

export type EnvelopeOverrides = {
  runId?: string;
  jobId?: string;
  effectKey?: string;
  requestId?: string;
  brief?: string;
  /** Lease expiry (ISO). Defaults to the far future so retries stay valid. */
  expiresAt?: string;
  /** Mutate the intent BEFORE lease/envelope signing (semantic tamper, valid signatures). */
  mutateIntent?: (intent: JsonObject) => void;
  /** Mutate the lease BEFORE it is signed. */
  mutateLease?: (lease: JsonObject) => void;
  /** Mutate the envelope authority claims BEFORE the envelope is signed. */
  mutateAuthority?: (authority: JsonObject) => void;
  /** Mutate the fully signed envelope (signature/digest tampering). */
  mutateSigned?: (envelope: JsonObject) => void;
};

// Envelope timestamps are FIXED so two builds with the same overrides are
// byte-identical (identical retries must reproduce the same requestDigest).
const ISSUED_AT = "2026-08-05T10:00:00Z";
const NOT_BEFORE = "2026-08-01T00:00:00Z";
const FAR_FUTURE = "2036-01-01T00:00:00Z";

/**
 * Build a fully signed, corpus-shaped run.start envelope bound to the given
 * authority/binding/node. Path-free: placement is an explicit working-copy
 * reference by id. Deterministic: identical overrides produce identical bytes.
 */
export function buildRunStartEnvelope(ctx: TestAuthority, overrides: EnvelopeOverrides = {}): JsonObject {
  const runId = overrides.runId ?? "run-0001";
  const jobId = overrides.jobId ?? "job-0001";
  const actor: JsonValue = { initiator: { kind: "user", id: "user-ada", displayName: "Ada" } };
  const harness: JsonValue = {
    driverId: "claude",
    model: "claude-sonnet-5",
    config: { brief: overrides.brief ?? "Fix the failing parser unit test and run the suite." },
  };
  const capabilities: JsonValue = [{ capability: "harness/claude" }, { capability: "materializer/git-worktree" }];
  const mutationAuthority: JsonValue = [{ kind: "working-copy-write" }];
  const evidenceContract: JsonValue = {
    collect: ["logs", "diff", "environment-manifest", "transcript"],
    delivery: "local-manifest",
  };

  const intent: JsonObject = {
    jobId,
    runId,
    attemptOrdinal: 1,
    ownerScopeId: OWNER_SCOPE,
    workspaceId: WORKSPACE,
    target: {
      productId: "prod-honeycomb-app",
      source: {
        kind: "git",
        normalizedOrigin: "https://git.example.com/acme/honeycomb-app.git",
        revision: "3f9c2b7d1a6e4f0c9b8a7d6e5f4c3b2a1d0e9f8c",
      },
      digest: SNAPSHOT_DIGEST,
    },
    placement: { kind: "explicit", workingCopyId: "wc-0001", nodeId: ctx.nodeId },
    harness: structuredClone(harness),
    requiredCapabilities: structuredClone(capabilities),
    trustZone: "local-default",
    mutationAuthority: structuredClone(mutationAuthority),
    budget: { maxDurationSeconds: 3600 },
    evidenceContract: structuredClone(evidenceContract),
  };
  overrides.mutateIntent?.(intent);

  const lease: JsonObject = {
    leaseId: `lease-${runId}`,
    parentCapabilityLeaseId: "cap-lease-0001",
    runId,
    audience: { nodeId: ctx.nodeId, providerId: "native-host", binding: ctx.binding.binding as unknown as JsonValue },
    ownerScopeId: OWNER_SCOPE,
    workspaceId: WORKSPACE,
    actor: structuredClone(actor),
    allowedSnapshotDigest: SNAPSHOT_DIGEST,
    allowedHarness: structuredClone(harness),
    capabilities: structuredClone(capabilities),
    resourceLimits: {},
    networkPolicy: { mode: "inherit-node" },
    mutationAuthority: structuredClone(mutationAuthority),
    materializationCredentialLeaseIds: [],
    runtimeCredentialLeaseIds: [],
    evidenceContract: structuredClone(evidenceContract),
    issuedAt: ISSUED_AT,
    notBefore: NOT_BEFORE,
    expiresAt: overrides.expiresAt ?? FAR_FUTURE,
    authorityEpoch: 1,
    policyEpoch: 1,
  };
  overrides.mutateLease?.(lease);
  lease.signature = signCanonical(ctx.authority.privateKey, lease);

  const body: JsonObject = { intent, lease };
  const authority: JsonObject = {
    actor,
    ownerScopeId: OWNER_SCOPE,
    workspaceId: WORKSPACE,
    capabilityLeaseId: "cap-lease-0001",
    authorityEpoch: 1,
    policyEpoch: 1,
  };
  overrides.mutateAuthority?.(authority);

  const envelope: JsonObject = {
    protocolVersion: "0.1",
    requestId: overrides.requestId ?? "req-0001",
    effectKey: overrides.effectKey ?? `${jobId}/${runId}/start`,
    traceId: "trace-0001",
    issuedAt: ISSUED_AT,
    requestDigest: canonicalDigest(body as JsonValue),
    authority,
    body,
  };
  envelope.signature = signCanonical(ctx.authority.privateKey, envelope);
  overrides.mutateSigned?.(envelope);
  return envelope;
}

export function testEnvironmentFacts(runId: string): RunEnvironmentFacts {
  return {
    providerId: "native-host",
    environmentId: `env-${runKey(runId)}`,
    isolation: nativeIsolationManifest() as RunEnvironmentFacts["isolation"],
  };
}

export type CountingLauncher = { launcher: RunLauncher; calls: Array<{ runId: string; beeName: string }> };

/**
 * A launcher that behaves like the real HSR path's durable footprint: it
 * persists a session record stamped with executionRunId (atomically, like
 * spawnBee) and reports environment facts. `behavior` can delay or fail it.
 */
export function countingLauncher(behavior: { failWith?: Error; delayMs?: number; persistSession?: boolean } = {}): CountingLauncher {
  const calls: Array<{ runId: string; beeName: string }> = [];
  const launcher: RunLauncher = async ({ runId, beeName }) => {
    calls.push({ runId, beeName });
    if (behavior.delayMs) await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
    if (behavior.failWith) throw behavior.failWith;
    if (behavior.persistSession !== false) {
      const now = new Date().toISOString();
      await saveSession({
        name: beeName,
        agent: "claude",
        cwd: "/",
        command: "claude",
        tmuxTarget: beeName,
        substrate: "hsr",
        createdAt: now,
        updatedAt: now,
        status: "running",
        id: `BEE.${beeName}`,
        executionRunId: runId,
      });
    }
    return { sessionRef: `BEE.${beeName}`, environment: testEnvironmentFacts(runId) };
  };
  return { launcher, calls };
}

export type ServiceOptions = {
  launcher?: RunLauncher;
  control?: HarnessControl;
  now?: () => Date;
  launchGraceMs?: number;
};

/** An execution service over the real store with a fake launcher + probe. */
export function makeService(opts: ServiceOptions = {}): ExecutionService {
  return createExecutionService({
    launcher: opts.launcher ?? countingLauncher().launcher,
    sessions: storeSessionEvidenceSource(),
    control: opts.control ?? fakeControl().control,
    harnessProbe: async (kind) => (kind === "claude" ? { status: "ready" } : { status: "absent" }),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.launchGraceMs !== undefined ? { launchGraceMs: opts.launchGraceMs } : {}),
  });
}

/* ---------------------------------------------------------------- */
/* Operation envelopes (run.command/cancel/collect/retain/release)   */
/* ---------------------------------------------------------------- */

export type OperationEnvelopeOverrides = {
  effectKey?: string;
  requestId?: string;
  mutateAuthority?: (authority: JsonObject) => void;
  mutateSigned?: (envelope: JsonObject) => void;
};

/** Build a fully signed, corpus-shaped per-run effect envelope. */
export function buildOperationEnvelope(
  ctx: TestAuthority,
  effectKey: string,
  body: JsonObject,
  overrides: OperationEnvelopeOverrides = {},
): JsonObject {
  const authority: JsonObject = {
    actor: { initiator: { kind: "user", id: "user-ada", displayName: "Ada" } },
    ownerScopeId: OWNER_SCOPE,
    workspaceId: WORKSPACE,
    capabilityLeaseId: "cap-lease-0001",
    authorityEpoch: 1,
    policyEpoch: 1,
  };
  overrides.mutateAuthority?.(authority);
  const envelope: JsonObject = {
    protocolVersion: "0.1",
    requestId: overrides.requestId ?? `req-${overrides.effectKey ?? effectKey}`.slice(0, 60),
    effectKey: overrides.effectKey ?? effectKey,
    traceId: "trace-op-0001",
    issuedAt: ISSUED_AT,
    requestDigest: canonicalDigest(body as JsonValue),
    authority,
    body,
  };
  envelope.signature = signCanonical(ctx.authority.privateKey, envelope);
  overrides.mutateSigned?.(envelope);
  return envelope;
}

/* ---------------------------------------------------------------- */
/* Fake harness control                                              */
/* ---------------------------------------------------------------- */

export type FakeControlBehavior = {
  /** Thrown by send/answer/interrupt when set. */
  dispatchError?: Error;
  /** send/answer/interrupt never resolve (simulates an in-flight window). */
  hang?: boolean;
  /** Open needs-input request id answered by pendingInputId. */
  pendingInput?: string | null;
  stopResult?: HarnessStopResult;
};

export type FakeControl = {
  control: HarnessControl;
  calls: Array<{ method: string; beeName: string; args: unknown[] }>;
  behavior: FakeControlBehavior;
};

export function fakeControl(behavior: FakeControlBehavior = {}): FakeControl {
  const calls: FakeControl["calls"] = [];
  const dispatch = async (method: string, beeName: string, ...args: unknown[]): Promise<void> => {
    calls.push({ method, beeName, args });
    if (behavior.hang) await new Promise(() => undefined);
    if (behavior.dispatchError) throw behavior.dispatchError;
  };
  return {
    calls,
    behavior,
    control: {
      send: (beeName, text, deliveryId) => dispatch("send", beeName, text, deliveryId),
      answer: (beeName, inputRequestId, answer) => dispatch("answer", beeName, inputRequestId, answer),
      interrupt: (beeName, reason) => dispatch("interrupt", beeName, reason),
      async pendingInputId(beeName) {
        calls.push({ method: "pendingInputId", beeName, args: [] });
        return behavior.pendingInput ?? null;
      },
      async stop(beeName) {
        calls.push({ method: "stop", beeName, args: [] });
        return behavior.stopResult ?? { stopped: true, detail: "clean stop confirmed" };
      },
    },
  };
}

export { beeNameForRun, HarnessDispatchError };
