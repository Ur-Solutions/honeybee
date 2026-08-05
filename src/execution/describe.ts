// Owner-scoped node.describe (RFC §8, §10.2): a signed, short-lived capability
// snapshot for the installed LocalAuthorityHostBinding. Honesty rules:
//   - a harness the node cannot execute is reported `absent` with an install
//     hint, never omitted or pretended;
//   - materializer placements list ONLY what run.start can actually satisfy in
//     this slice (explicit node-registered working copies);
//   - a request for a different owner scope or binding is BINDING_DENIED, not
//     an empty descriptor.
import { cpus, totalmem, arch as osArch, platform as osPlatform, release as osRelease } from "node:os";
import type { JsonValue } from "../comb/types.js";
import { assertExecutableAvailable } from "../execCheck.js";
import { resolveAgent } from "../agents.js";
import type { JsonObject } from "./contract.js";
import { executionError } from "./errors.js";
import { signCanonical } from "./signing.js";
import type { ExecutionBindingRecord, ExecutionNodeIdentity } from "./nodeState.js";

/** Provider identity of the local native host in this slice. */
export const NATIVE_PROVIDER_ID = "native-host";
export const GIT_WORKTREE_MATERIALIZER_ID = "git-worktree";
/** How long a capability snapshot stays fresh (scheduler input, not a promise). */
export const DESCRIPTOR_TTL_MS = 5 * 60_000;

/** Harness drivers this slice advertises (the Phase 0-1 checkpoint pair). */
export const ADVERTISED_HARNESSES = ["claude", "codex"] as const;

/**
 * run.command variants the HSR control socket actually delivers (H3).
 * `answer` is NOT here: needs_input.opened is not bridged into the protocol
 * event stream yet, so an open input request is unobservable from protocol
 * data and an advertised answer command could never be driven honestly. The
 * legacy session/UI answer path is unaffected.
 */
export const SUPPORTED_COMMANDS = ["send", "interrupt"] as const;

/**
 * Event families the local-core-v1 runtime durably emits today — the honesty
 * baseline behind profile.json's REQUIRED eventTypes (everything else in the
 * schema vocabulary lives in optionalEventTypes until its emitter exists).
 * Emit sites: run lifecycle + environment + harness in service.ts,
 * command/cancel/collect lifecycles in operations.ts.
 */
export const PRODUCED_EVENT_TYPES = [
  "run.accepted",
  "environment.materializing",
  "environment.ready",
  "harness.starting",
  "harness.running",
  "harness.exited",
  "command.accepted",
  "command.dispatching",
  "command.completed",
  "command.failed",
  "command.indeterminate",
  "collection.completed",
  "cancel.requested",
  "run.cancelled",
  "run.failed",
  "run.completed",
  "run.lost",
  "environment.sealed",
  "environment.released",
] as const;

export type HarnessProbe = (kind: string) => Promise<{ status: "ready" | "absent"; command?: string }>;

/** Default probe: the driver's resolved executable is runnable on this node. */
export async function probeHarness(kind: string): Promise<{ status: "ready" | "absent"; command?: string }> {
  try {
    const spec = resolveAgent(kind);
    await assertExecutableAvailable(spec.command);
    return { status: "ready", command: spec.command };
  } catch {
    return { status: "absent" };
  }
}

export type NodeDescriptorDeps = {
  identity: ExecutionNodeIdentity;
  binding: ExecutionBindingRecord;
  protocolVersion: string;
  features: string[];
  harnessProbe?: HarnessProbe;
  now?: () => Date;
};

/** Validate the (already schema-checked) request scope against the installed binding. */
export function assertDescribeScope(request: JsonObject, binding: ExecutionBindingRecord): void {
  if (request.ownerScopeId !== binding.ownerScopeId) {
    throw executionError("BINDING_DENIED", `owner scope ${String(request.ownerScopeId)} is not bound on this node`);
  }
  if (request.bindingId !== undefined && request.bindingId !== binding.binding.bindingId) {
    throw executionError("BINDING_DENIED", `binding ${String(request.bindingId)} is not the installed host binding`);
  }
}

export async function buildNodeDescriptor(deps: NodeDescriptorDeps): Promise<JsonObject> {
  const probe = deps.harnessProbe ?? probeHarness;
  const now = (deps.now ?? (() => new Date()))();
  const harnesses: JsonValue[] = [];
  for (const kind of ADVERTISED_HARNESSES) {
    const result = await probe(kind);
    harnesses.push({
      driverId: kind,
      driverVersion: "0.1.0",
      runnerTier: "hsr",
      // H3: exactly the effect-keyed commands the HSR control socket truly
      // delivers. checkpoint is NOT advertised (no driver support), answer is
      // NOT advertised (needs_input.opened is not bridged), and delivery is
      // honestly at-most-once: crash windows become durable `indeterminate`
      // command results and are never blindly redelivered.
      commands: [...SUPPORTED_COMMANDS],
      commandDelivery: "at-most-once",
      resume: false,
      checkpoint: false,
      accountResidency: "node-resident",
      status: result.status,
      ...(result.status === "absent"
        ? { installHint: `install the ${kind} CLI on this node's PATH and re-run node discovery` }
        : {}),
    });
  }
  const descriptor: JsonObject = {
    // The CANONICAL public node identity is the Apiary nodeId bound at
    // install time; the Honeybee-minted identity only signs (key custody).
    nodeId: deps.binding.nodeId,
    ownerScopeId: deps.binding.ownerScopeId,
    binding: deps.binding.binding as unknown as JsonValue,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DESCRIPTOR_TTL_MS).toISOString(),
    protocol: { version: deps.protocolVersion, features: deps.features },
    platform: { os: osPlatform(), arch: osArch(), version: osRelease() },
    providers: [
      {
        providerId: NATIVE_PROVIDER_ID,
        isolation: nativeIsolationManifest(),
        materializerForms: [GIT_WORKTREE_MATERIALIZER_ID],
        // H3: run.retain extends the debug-retention window on this provider;
        // checkpointing still does not exist and is not claimed.
        persistence: { checkpoint: false, retainSupported: true },
        secretInjection: "env-allowlist",
        status: "ready",
      },
    ],
    harnesses,
    materializers: [
      {
        materializerId: GIT_WORKTREE_MATERIALIZER_ID,
        sourceKinds: ["git"],
        // H1 supports only node-registered explicit working copies; fresh
        // allocation arrives with the materializer slice and is not claimed.
        placements: ["explicit"],
        status: "ready",
      },
    ],
    resources: {
      cpuCores: cpus().length,
      memoryMb: Math.round(totalmem() / (1024 * 1024)),
      maxConcurrentRuns: Math.max(1, cpus().length - 2),
    },
    trustZones: ["local-default"],
    health: "ready",
  };
  descriptor.signature = signCanonical(deps.identity.privateKey, descriptor);
  return descriptor;
}

/** Honest native-host isolation: dedicated files per working copy, shared everything else. */
export function nativeIsolationManifest(): JsonObject {
  return {
    filesystem: "dedicated",
    processes: "shared",
    network: "shared",
    browserProfile: "none",
    deviations: ["native host: process and network isolation are advisory"],
  };
}
