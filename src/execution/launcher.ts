// Production RunLauncher: resolve the leased placement to a node-local
// working copy, then start the harness through the in-process HSR spawn path
// (the same code `hive spawn --substrate hsr` runs).
//
// Placement rules for this slice (honest subset of node.describe):
//   - `explicit` resolves through the node-private working-copy registry and
//     claims durable occupancy for the Run; the registry locator never crosses
//     the protocol boundary except as an opaque token;
//   - `fresh`/`inherit`/`canonical` are not yet materializable here and fail
//     typed (MATERIALIZATION_FAILED) — never a canonical-checkout fallback.
//     The fresh materializer/provider binding is the L2/M0 seam.
//
// The spawn is bound to the Run BEFORE the record exists by the deterministic
// bee name (derived from runId) and stamped atomically at record creation via
// executionRunId, so crash recovery can classify the outcome from durable
// state alone.
import type { JsonValue } from "../comb/types.js";
import type { JsonObject } from "./contract.js";
import { executionError } from "./errors.js";
import { nativeIsolationManifest, NATIVE_PROVIDER_ID } from "./describe.js";
import { claimWorkingCopy, readWorkingCopy, type WorkingCopyRecord } from "./workingCopies.js";
import type { RunLaunchRequest, RunLaunchResult, RunLauncher } from "./service.js";
import { runKey, type RunEnvironmentFacts } from "./runStore.js";

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

export type HsrHarnessLaunchConfig = {
  driverId: string;
  model?: string;
  brief?: string;
  account?: string;
  preamble?: string;
};

/**
 * Read the driver-normalized portion of a signed HarnessRequest. Keep this
 * strict at the execution boundary: these values become local spawn flags,
 * so malformed signed input must fail typed instead of being coerced.
 */
export function resolveHsrHarnessLaunchConfig(intent: JsonObject): HsrHarnessLaunchConfig {
  const harness = asObject(intent.harness);
  const driverId = String(harness?.driverId ?? "");
  const model = typeof harness?.model === "string" ? harness.model : undefined;
  const config = asObject(harness?.config);
  const brief = typeof config?.brief === "string" ? config.brief : undefined;
  const account = config?.account;
  if (account !== undefined && (typeof account !== "string" || account.length === 0)) {
    throw executionError("HARNESS_UNAVAILABLE", "harness config.account must be a non-empty account query string");
  }
  const preamble = config?.preamble;
  if (preamble !== undefined && (typeof preamble !== "string" || preamble.trim().length === 0)) {
    throw executionError("HARNESS_UNAVAILABLE", "harness config.preamble must be a non-empty string");
  }
  return {
    driverId,
    ...(model !== undefined ? { model } : {}),
    ...(brief !== undefined ? { brief } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(preamble !== undefined ? { preamble } : {}),
  };
}

export function buildHsrSpawnFlags(
  beeName: string,
  cwd: string,
  config: Pick<HsrHarnessLaunchConfig, "account" | "preamble">,
): Map<string, string | true | string[]> {
  const flags = new Map<string, string | true | string[]>([
    ["substrate", "hsr"],
    ["name", beeName],
    ["cwd", cwd],
  ]);
  if (config.account) flags.set("account", config.account);
  if (config.preamble) flags.set("preamble", config.preamble);
  return flags;
}

/**
 * Resolve and durably claim the explicit placement for a Run, proving that
 * the registered working copy actually materializes the LEASED snapshot:
 * productId and snapshotDigest must match the intent's target exactly, and a
 * registered origin/revision must match the target source when present. A
 * copy of product B can never satisfy a lease for snapshot A. Registration
 * content is immutable (register conflicts on change), so verify-then-claim
 * cannot race a redirection.
 */
export async function materializeExplicitPlacement(
  nodeId: string,
  request: Pick<RunLaunchRequest, "runId" | "intent">,
): Promise<WorkingCopyRecord> {
  const { runId, intent } = request;
  const placement = intent.placement;
  const explicit = asObject(placement as JsonValue);
  if (typeof placement === "string") {
    throw executionError(
      "MATERIALIZATION_FAILED",
      `placement "${placement}" is not materializable on this node yet; register a working copy and place explicitly`,
      { placement },
    );
  }
  if (!explicit || explicit.kind !== "explicit" || typeof explicit.workingCopyId !== "string") {
    throw executionError("MATERIALIZATION_FAILED", "unsupported placement shape", { placement: placement as JsonValue });
  }
  if (explicit.nodeId !== nodeId) {
    throw executionError("MATERIALIZATION_FAILED", `explicit working copy is on node ${String(explicit.nodeId)}, not this node`);
  }
  const copy = await readWorkingCopy(explicit.workingCopyId);
  if (!copy) {
    throw executionError("MATERIALIZATION_FAILED", `working copy ${explicit.workingCopyId} is not registered on this node`);
  }
  const target = asObject(intent.target);
  const source = asObject(target?.source);
  if (!target || target.productId !== copy.productId) {
    throw executionError(
      "SNAPSHOT_UNAVAILABLE",
      `working copy ${copy.workingCopyId} materializes product ${copy.productId}, not ${String(target?.productId)}`,
    );
  }
  if (target.digest !== copy.snapshotDigest) {
    throw executionError(
      "SNAPSHOT_UNAVAILABLE",
      `working copy ${copy.workingCopyId} does not materialize the leased snapshot digest`,
      { workingCopyId: copy.workingCopyId },
    );
  }
  if (copy.origin !== undefined && copy.origin !== source?.normalizedOrigin) {
    throw executionError("SNAPSHOT_UNAVAILABLE", `working copy ${copy.workingCopyId} origin does not match the snapshot source`);
  }
  if (copy.revision !== undefined && copy.revision !== source?.revision) {
    throw executionError("SNAPSHOT_UNAVAILABLE", `working copy ${copy.workingCopyId} revision does not match the snapshot source`);
  }
  return claimWorkingCopy(explicit.workingCopyId, runId);
}

/**
 * `nodeId` resolves the CANONICAL bound node identity (binding.nodeId) lazily:
 * the daemon builds the launcher before any binding exists, and runs can only
 * arrive after run.start validated the lease against that same binding.
 */
export function createHsrRunLauncher(deps: { nodeId: () => Promise<string> }): RunLauncher {
  return async (request: RunLaunchRequest): Promise<RunLaunchResult> => {
    const { runId, beeName, intent } = request;
    const nodeId = await deps.nodeId();
    const copy = await materializeExplicitPlacement(nodeId, request);

    // Account and preamble selection come ONLY from the signed intent's
    // harness config — never from daemon profiles or ambient configuration.
    // Keeping the preamble separate from brief lets spawn preserve host-owned
    // session envelopes beside Honeybee's identity before the operator prompt.
    const { driverId, model, brief, account, preamble } = resolveHsrHarnessLaunchConfig(intent);

    const { spawnSingleBee } = await import("../commands/spawn.js");
    // The registry locator is the node-private path; it is used here to run
    // the process and never echoed back through the protocol.
    const flags = buildHsrSpawnFlags(beeName, copy.path, {
      ...(account ? { account } : {}),
      ...(preamble ? { preamble } : {}),
    });
    let record;
    try {
      record = await spawnSingleBee(
        {
          command: "spawn",
          args: brief ? [driverId, brief] : [driverId],
          flags,
          rest: model ? ["--model", model] : [],
        },
        // executionRunId also pins lineage: the parent edge is exactly the
        // coordinator-resolved spawnedById (or none) — ambient never applies.
        // protocolLaunch pins the SIGNED harness intent: spawn's local
        // overlays (thin profiles, account aliases, sole-account defaults,
        // config yolo) are bypassed so bees.<driver> config cannot change
        // harness, account, args, or yolo underneath the lease.
        { executionRunId: runId, protocolLaunch: true, ...(request.spawnedById ? { spawnedById: request.spawnedById } : {}) },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw executionError("HARNESS_UNAVAILABLE", `harness ${driverId} failed to start: ${message}`);
    }

    const workingCopy: JsonObject = {
      workingCopyId: copy.workingCopyId,
      nodeId,
      providerId: NATIVE_PROVIDER_ID,
      productId: copy.productId,
      ...(copy.origin ? { origin: copy.origin } : {}),
      ...(copy.revision ? { revision: copy.revision } : {}),
      ...(copy.branch ? { branch: copy.branch } : {}),
      occupancy: { claimedByRunId: runId, claimedAt: copy.occupancy?.claimedAt ?? new Date().toISOString() },
      locator: { kind: "node-private", token: copy.workingCopyId },
    };
    const environment: RunEnvironmentFacts = {
      providerId: NATIVE_PROVIDER_ID,
      environmentId: `env-${runKey(runId)}`,
      isolation: nativeIsolationManifest(),
      workingCopy,
    };
    return { ...(record.id ? { sessionRef: record.id } : {}), environment };
  };
}
