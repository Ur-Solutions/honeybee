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
import { dirname } from "node:path";
import type { JsonValue } from "../comb/types.js";
import type { JsonObject } from "./contract.js";
import { executionError, indeterminateExecutionError } from "./errors.js";
import { nativeIsolationManifest, NATIVE_PROVIDER_ID } from "./describe.js";
import { claimWorkingCopy, readWorkingCopy, type WorkingCopyRecord } from "./workingCopies.js";
import type { RunLaunchRequest, RunLaunchResult, RunLauncher } from "./service.js";
import { runKey, type RunEnvironmentFacts } from "./runStore.js";
import { SpawnAfterForkError, type SpawnedRuntimeHandle } from "../spawnRuntime.js";
import { executionReasoningArgs } from "./harnessPolicy.js";
import { stopAndSettleExecutionRuntime } from "./runtimeSettlement.js";
import { isHsrDeliveryAmbiguous } from "../hsr/pendingTurns.js";

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

export type HsrHarnessLaunchConfig = {
  driverId: string;
  model?: string;
  reasoning?: string;
  brief?: string;
  account?: string;
  preamble?: string;
  /**
   * Signed Kit capability profile. The production launcher translates this
   * to spawn's strict --kit-profile path, which converges the dedicated home
   * before the HSR host is forked and stamps the resulting manifest facts on
   * the SessionRecord.
   */
  kitProfile?: string;
  /**
   * Path-free Cell layout marker from the signed envelope (Apiary Cell Layout
   * v2). The envelope never carries machine paths, so for "v2" the launcher
   * itself derives the wrapper (the working copy's parent directory) and
   * grants it as a Cell-sandbox write root so the harness can write `box/`.
   */
  cellLayout?: "v1" | "v2";
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
  const reasoning = config?.reasoning;
  // Admission has already checked the same table. Re-run the pure translator
  // here so direct launcher callers cannot silently discard signed semantics.
  executionReasoningArgs(driverId, model, reasoning);
  const account = config?.account;
  if (account !== undefined && (typeof account !== "string" || account.length === 0)) {
    throw executionError("HARNESS_UNAVAILABLE", "harness config.account must be a non-empty account query string");
  }
  const preamble = config?.preamble;
  if (preamble !== undefined && (typeof preamble !== "string" || preamble.trim().length === 0)) {
    throw executionError("HARNESS_UNAVAILABLE", "harness config.preamble must be a non-empty string");
  }
  const kitProfile = config?.kitProfile;
  if (kitProfile !== undefined && (typeof kitProfile !== "string" || kitProfile.trim().length === 0)) {
    throw executionError("HARNESS_UNAVAILABLE", "harness config.kitProfile must be a non-empty string");
  }
  const cellLayout = config?.cellLayout;
  if (cellLayout !== undefined && cellLayout !== "v1" && cellLayout !== "v2") {
    throw executionError("HARNESS_UNAVAILABLE", "harness config.cellLayout must be \"v1\" or \"v2\" when present");
  }
  return {
    driverId,
    ...(model !== undefined ? { model } : {}),
    ...(brief !== undefined ? { brief } : {}),
    ...(typeof reasoning === "string" ? { reasoning: reasoning.toLowerCase() } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(preamble !== undefined ? { preamble } : {}),
    ...(kitProfile !== undefined ? { kitProfile } : {}),
    ...(cellLayout !== undefined ? { cellLayout } : {}),
  };
}

export function buildHsrSpawnFlags(
  beeName: string,
  cwd: string,
  config: Pick<HsrHarnessLaunchConfig, "account" | "preamble" | "kitProfile" | "cellLayout">,
): Map<string, string | true | string[]> {
  const flags = new Map<string, string | true | string[]>([
    ["substrate", "hsr"],
    ["name", beeName],
    ["cwd", cwd],
  ]);
  if (config.account) flags.set("account", config.account);
  if (config.preamble) flags.set("preamble", config.preamble);
  if (config.kitProfile) flags.set("kit-profile", config.kitProfile);
  // Layout v2: the wrapper one level above the checkout owns `box/` — grant it
  // as an extra Cell-sandbox write root (repeatable --sandbox-write shape).
  if (config.cellLayout === "v2") flags.set("sandbox-write", [dirname(cwd)]);
  return flags;
}

/** Exact model/reasoning argv selected by the signed HarnessRequest. */
export function buildHsrHarnessArgs(config: HsrHarnessLaunchConfig): string[] {
  return [
    ...(config.model ? ["--model", config.model] : []),
    ...executionReasoningArgs(config.driverId, config.model, config.reasoning),
  ];
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

/** Path-free environment facts shared by the normal receipt and crash repair. */
export function environmentFactsForWorkingCopy(
  nodeId: string,
  runId: string,
  copy: WorkingCopyRecord,
): RunEnvironmentFacts {
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
  return {
    providerId: NATIVE_PROVIDER_ID,
    environmentId: `env-${runKey(runId)}`,
    isolation: nativeIsolationManifest(),
    workingCopy,
  };
}

/**
 * Rebuild the exact path-free environment receipt after a crash between HSR
 * readiness and reservation persistence. The occupancy claim is the durable
 * proof that materialization completed for this Run; never recover from an
 * unclaimed or differently-owned locator.
 */
export async function recoverExplicitPlacementEnvironment(
  nodeId: string,
  reservation: Pick<RunLaunchRequest, "runId" | "intent">,
): Promise<RunEnvironmentFacts | undefined> {
  const explicit = asObject(reservation.intent.placement as JsonValue);
  if (!explicit || explicit.kind !== "explicit" || explicit.nodeId !== nodeId || typeof explicit.workingCopyId !== "string") {
    return undefined;
  }
  const copy = await readWorkingCopy(explicit.workingCopyId);
  if (!copy || copy.occupancy?.claimedByRunId !== reservation.runId) return undefined;
  const target = asObject(reservation.intent.target as JsonValue);
  const source = asObject(target?.source);
  if (!target || target.productId !== copy.productId || target.digest !== copy.snapshotDigest) return undefined;
  if (copy.origin !== undefined && copy.origin !== source?.normalizedOrigin) return undefined;
  if (copy.revision !== undefined && copy.revision !== source?.revision) return undefined;
  return environmentFactsForWorkingCopy(nodeId, reservation.runId, copy);
}

type SpawnedExecutionBee = { name: string; id?: string; runtime?: SpawnedRuntimeHandle };

export type HsrRunLauncherDependencies = {
  nodeId: () => Promise<string>;
  /** Test seam; production imports the ordinary spawn path lazily. */
  spawn?: (
    request: RunLaunchRequest,
    config: HsrHarnessLaunchConfig,
    cwd: string,
    onRuntimeLaunched?: (runtime: SpawnedRuntimeHandle) => void | Promise<void>,
  ) => Promise<SpawnedExecutionBee>;
  waitForReadiness?: (beeName: string, timeoutMs: number) => Promise<boolean>;
  stop?: (beeName: string) => Promise<{ stopped: boolean; detail: string }>;
  readinessTimeoutMs?: number;
  /** Deterministic crash seam after stop dispatch, before canonical purge. */
  afterRuntimeStopDispatch?: () => void | Promise<void>;
};

/**
 * `nodeId` resolves the CANONICAL bound node identity (binding.nodeId) lazily:
 * the daemon builds the launcher before any binding exists, and runs can only
 * arrive after run.start validated the lease against that same binding.
 */
export function createHsrRunLauncher(deps: HsrRunLauncherDependencies): RunLauncher {
  return async (request: RunLaunchRequest): Promise<RunLaunchResult> => {
    const { runId, beeName, intent } = request;
    const nodeId = await deps.nodeId();
    const copy = await materializeExplicitPlacement(nodeId, request);

    // Account and preamble selection come ONLY from the signed intent's
    // harness config — never from daemon profiles or ambient configuration.
    // Keeping the preamble separate from brief lets spawn preserve host-owned
    // session envelopes beside Honeybee's identity before the operator prompt.
    const { driverId, model, reasoning, brief, account, preamble, kitProfile, cellLayout } = resolveHsrHarnessLaunchConfig(intent);

    let record: SpawnedExecutionBee;
    // `spawnSingleBee` can still fail after spawnBee has durably published the
    // SessionRecord: positional/brief delivery happens afterward. Retain the
    // exact birth-qualified runtime handle outside the spawn await so that
    // this post-publication error cannot be flattened into a definite
    // no-runtime failure while the Bee keeps running.
    let launchedRuntime: SpawnedRuntimeHandle | undefined;
    try {
      if (deps.spawn) {
        record = await deps.spawn(
          request,
          { driverId, ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}), ...(brief ? { brief } : {}), ...(account ? { account } : {}), ...(preamble ? { preamble } : {}), ...(kitProfile ? { kitProfile } : {}), ...(cellLayout ? { cellLayout } : {}) },
          copy.path,
          (runtime) => { launchedRuntime = runtime; },
        );
      } else {
        const { spawnSingleBee } = await import("../commands/spawn.js");
        // The registry locator is the node-private path; it is used here to run
        // the process and never echoed back through the protocol.
        const flags = buildHsrSpawnFlags(beeName, copy.path, {
          ...(account ? { account } : {}),
          ...(preamble ? { preamble } : {}),
          ...(kitProfile ? { kitProfile } : {}),
          ...(cellLayout ? { cellLayout } : {}),
        });
        const runtimeCredentialLeaseIds = Array.isArray(request.lease.runtimeCredentialLeaseIds)
          ? request.lease.runtimeCredentialLeaseIds.filter((value): value is string => typeof value === "string")
          : [];
        const spawned = await spawnSingleBee(
          {
            command: "spawn",
            args: brief ? [driverId, brief] : [driverId],
            flags,
            rest: buildHsrHarnessArgs({ driverId, ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) }),
          },
          // executionRunId also pins lineage: the parent edge is exactly the
          // coordinator-resolved spawnedById (or none) — ambient never applies.
          // protocolLaunch pins the SIGNED harness intent: spawn's local
          // overlays (thin profiles, account aliases, sole-account defaults,
          // config yolo) are bypassed so bees.<driver> config cannot change
          // harness, account, args, or yolo underneath the lease.
          {
            executionRunId: runId,
            ...(runtimeCredentialLeaseIds.length > 0
              ? { executionRuntimeCredentialLeaseIds: [...runtimeCredentialLeaseIds] }
              : {}),
            protocolLaunch: true,
            ...(request.spawnedById ? { spawnedById: request.spawnedById } : {}),
            onRuntimeLaunched: (launched) => { launchedRuntime = launched; },
          },
        );
        record = {
          name: spawned.name,
          ...(spawned.id ? { id: spawned.id } : {}),
          ...(launchedRuntime ? { runtime: launchedRuntime } : {}),
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const runtime = error instanceof SpawnAfterForkError ? error.runtime : launchedRuntime;
      if (runtime) {
        const initialDeliveryAmbiguous = isHsrDeliveryAmbiguous(error);
        // Fresh-name publication owns the lifecycle lock and may already have
        // exact-stopped the forked incarnation, purged its canonical row/run
        // state, and settled the launch journal before surfacing this error.
        // Re-running pid-scoped teardown after that proof was removed cannot
        // confirm the same absence and would incorrectly turn a definite
        // rollback into a lost Run. Trust only the complete carried proof;
        // every partial or unconfirmed rollback still enters settlement below.
        if (
          error instanceof SpawnAfterForkError
          && error.cleanup.stopped
          && error.canonicalSettlement?.settled === true
        ) {
          throw executionError(
            "HARNESS_UNAVAILABLE",
            `harness ${driverId} failed after runtime launch; fresh publication rollback already confirmed exact cleanup: ${message}`,
          );
        }
        const settlement = await stopAndSettleExecutionRuntime(
          request,
          runtime,
          `execution launch failed after runtime publication: ${message}`,
          {
            ...(deps.afterRuntimeStopDispatch ? { afterStopDispatch: deps.afterRuntimeStopDispatch } : {}),
            ...(initialDeliveryAmbiguous
              ? {
                  retainCanonicalAfterConfirmedStop:
                    "initial delivery crossed provider dispatch; preserving its receipt and working-copy authority for manual reconciliation",
                }
              : {}),
          },
        );
        if (initialDeliveryAmbiguous) {
          throw indeterminateExecutionError(
            "HARNESS_UNAVAILABLE",
            `harness ${driverId} initial delivery outcome is ambiguous: ${message}`,
            "initial_delivery_ambiguous",
            {
              phase: "initial-delivery",
              runtime: runtime.identity,
              detail: settlement.detail,
              runtimeStopped: settlement.cleanup.stopped,
              stopDoubtPersisted: !settlement.settled && settlement.stopDoubtPersisted,
            },
          );
        }
        if (!settlement.settled) {
          throw indeterminateExecutionError(
            "HARNESS_UNAVAILABLE",
            `harness ${driverId} failed after runtime launch and exact canonical cleanup was unconfirmed: ${message}`,
            "spawn_cleanup_unconfirmed",
            {
              phase: error instanceof SpawnAfterForkError ? error.phase : "post-publication",
              runtime: runtime.identity,
              detail: settlement.detail,
              stopDoubtPersisted: settlement.stopDoubtPersisted,
            },
          );
        }
        throw executionError(
          "HARNESS_UNAVAILABLE",
          `harness ${driverId} failed after runtime launch; exact cleanup and canonical SessionRecord purge confirmed: ${message}`,
        );
      }
      throw executionError("HARNESS_UNAVAILABLE", `harness ${driverId} failed to start: ${message}`);
    }

    // spawnSingleBee durably publishes queued/booting before the detached host
    // is ready. Execution must not turn that early record into harness.running:
    // wait for the HSR control socket + adapter handshake (`runningAt`). On a
    // bounded failure, stop the exact newly-owned bee before reporting failure
    // so a late-ready zombie cannot outlive a terminal Run.
    const readinessTimeout = Number(process.env.HIVE_EXECUTION_HSR_READY_TIMEOUT_MS);
    const timeoutMs = deps.readinessTimeoutMs ?? (Number.isFinite(readinessTimeout) && readinessTimeout > 0 ? readinessTimeout : 120_000);
    const waitForReadiness = deps.waitForReadiness ?? (await import("../hsr/runnerHost.js")).waitForHsrReadiness;
    if (!(await waitForReadiness(record.name, timeoutMs))) {
      const settlement = record.runtime
        ? await stopAndSettleExecutionRuntime(
            request,
            record.runtime,
            `execution harness readiness timed out after ${timeoutMs}ms`,
            ...(deps.afterRuntimeStopDispatch
              ? [{ afterStopDispatch: deps.afterRuntimeStopDispatch }]
              : []),
          )
        : {
            settled: false as const,
            detail: "launcher returned no exact runtime handle; no unfenced stop was dispatched",
            cleanup: { stopped: false, detail: "stop was not dispatched" },
            stopDoubtPersisted: false,
          };
      if (!settlement.settled) {
        throw indeterminateExecutionError(
          "HARNESS_UNAVAILABLE",
          `harness ${driverId} did not reach HSR readiness within ${timeoutMs}ms and exact canonical cleanup was unconfirmed`,
          "readiness_stop_unconfirmed",
          {
            detail: settlement.detail,
            ...(record.runtime ? { runtime: record.runtime.identity } : {}),
            stopDoubtPersisted: settlement.stopDoubtPersisted,
          },
        );
      }
      throw executionError(
        "HARNESS_UNAVAILABLE",
        `harness ${driverId} did not reach HSR readiness within ${timeoutMs}ms; exact runtime and canonical generation cleanup confirmed`,
      );
    }

    const environment = environmentFactsForWorkingCopy(nodeId, runId, copy);
    if (!record.id) {
      const settlement = record.runtime
        ? await stopAndSettleExecutionRuntime(
            request,
            record.runtime,
            "execution harness reached readiness without a canonical SessionRecord id",
            ...(deps.afterRuntimeStopDispatch
              ? [{ afterStopDispatch: deps.afterRuntimeStopDispatch }]
              : []),
          )
        : {
            settled: false as const,
            detail: "launcher returned no exact runtime handle; no unfenced stop was dispatched",
            cleanup: { stopped: false, detail: "stop was not dispatched" },
            stopDoubtPersisted: false,
          };
      if (!settlement.settled) {
        throw indeterminateExecutionError(
          "HARNESS_UNAVAILABLE",
          `harness ${driverId} reached readiness without a canonical SessionRecord.id and exact cleanup was unconfirmed`,
          "session_ref_missing",
          {
            detail: settlement.detail,
            ...(record.runtime ? { runtime: record.runtime.identity } : {}),
            stopDoubtPersisted: settlement.stopDoubtPersisted,
          },
        );
      }
      throw executionError(
        "HARNESS_UNAVAILABLE",
        `harness ${driverId} reached readiness without a canonical SessionRecord.id; exact runtime and canonical generation cleanup confirmed`,
      );
    }
    return { sessionRef: record.id, environment, ...(record.runtime ? { runtime: record.runtime } : {}) };
  };
}
