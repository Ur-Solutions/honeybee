/**
 * The single honest StateContext assembler (docs/BEEVIEW_READ_API.md §2).
 *
 * One place gathers EVERY input deriveState consumes — node-probe liveness,
 * pane captures, local pane ids, seal markers, and the pane-less HSR run-dir
 * observations — so the CLI, the view surface, and any embedder derive from
 * identical evidence. This closes the historical CLI/daemon asymmetry:
 *
 *   - mirrorOf rows thread into `hsrMirrors` (the CLI used to drop them, so a
 *     mirrored remote-hsr bee derived from the coarse node probe);
 *   - a FAILED observation batch marks `hsrUnavailable` (unknown is not an
 *     authoritative empty result — states are held, never fabricated dead);
 *   - `previousStates` seeds from parseBeeState(lastObservedState), graded
 *     legacy; a daemon-style caller can layer in-memory observations on top.
 *
 * The daemon's tick keeps its own inline assembly (src/daemon/tick.ts) with
 * in-memory previousStates layered over the same rules; src/cli/shared.ts
 * buildStateContext delegates here.
 *
 * Read-only: nothing here writes.
 */

import { mapWithConcurrency } from "../concurrency.js";
import { trustedHsrObservationSource } from "../flight/controller.js";
import { hsrObservations as hsrObservationsImpl, type HsrObservation } from "../hsr/observe.js";
import { listNodes as listNodesImpl, type NodeRecord } from "../node.js";
import { sealedBeeNames as sealedBeeNamesImpl } from "../seal.js";
import { liveTargetKey, parseBeeState, type BeeState, type PaneCaptureMap, type StateContext } from "../state.js";
import { isArchivedSessionLifecycle } from "../stateMachine.js";
import type { SessionRecord } from "../store.js";
import { localSubstrate, substrateFor } from "../substrates/index.js";

/** The subset of a multi-node probe the assembler consumes. */
export type LiveNodeProbe = {
  /** Live tmux sessions keyed by liveTargetKey(node, target). */
  liveTargets: Set<string>;
  unreachableNodes: Set<string>;
};

export type AssembledStateContext = StateContext & {
  hsrLive: Set<string>;
  hsrUnavailable: Set<string>;
  now: number;
  /**
   * Raw per-bee HSR observations from this pass (event snapshots, mirror
   * markers). The BeeView projection reads structured evidence from these;
   * plain deriveState callers can ignore the field.
   */
  hsrObservations: Map<string, HsrObservation>;
};

/** Injectable observation sources; every default reads the real substrate. */
export type StateContextAssemblyDeps = {
  capturePanes?: (records: SessionRecord[], liveTargets: Set<string>) => Promise<PaneCaptureMap>;
  listPanes?: () => Promise<Set<string>>;
  sealedBeeNames?: (records: readonly SessionRecord[]) => Promise<Set<string>>;
  hsrObservations?: (options: { includeEvents?: boolean; bees?: Iterable<string> }) => Promise<Map<string, HsrObservation>>;
  listNodes?: () => Promise<NodeRecord[]>;
  now?: () => number;
};

export type AssembleStateContextOptions = {
  /**
   * Override/widen the probe's unreachable set for callers that treat extra
   * nodes as unreachable (clean treats unregistered nodes so, never dead).
   */
  unreachableNodes?: Set<string>;
  /** Read event snapshots alongside the run-dir observation (BeeView needs them). */
  includeEvents?: boolean;
  /**
   * In-memory previous observations layered OVER the persisted legacy cache
   * (the daemon's live map). Absent for one-shot CLI callers — they fall back
   * to parseBeeState(lastObservedState), graded legacy.
   */
  previousStates?: ReadonlyMap<string, BeeState>;
  deps?: StateContextAssemblyDeps;
};

// Each capture forks a subprocess (tmux locally, an ssh round-trip remotely);
// uncapped fan-out over a large hive spawned dozens of concurrent ssh
// connections per pass (HIVE-62).
export const PANE_CAPTURE_CONCURRENCY = 8;

/** Default pane capture: the live subset, keyed by agentPaneId ?? tmuxTarget. */
export async function capturePanesForRecords(records: SessionRecord[], liveTargets: Set<string>): Promise<Map<string, string>> {
  const liveRecords = records.filter((record) => liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)));
  const entries = await mapWithConcurrency(
    liveRecords,
    PANE_CAPTURE_CONCURRENCY,
    // Key by the bee's own pane (agentPaneId) so sub-bees sharing one comb's
    // tmuxTarget keep distinct captures; legacy solo bees fall back to
    // tmuxTarget. deriveState reads with the same `agentPaneId ?? tmuxTarget`.
    async (record) => [record.agentPaneId ?? record.tmuxTarget, await substrateFor(record).capture(record.tmuxTarget, 80, record.agentPaneId).catch(() => "")] as const,
  );
  return new Map(entries);
}

/**
 * Which records this pass observes from HSR run dirs: every non-filed record
 * that is pane-less (substrate "hsr") or lives on a remote-hsr node (its
 * events may be locally mirrored). Filed records short-circuit in deriveState
 * and their run dirs are historical.
 */
function hsrCandidateNames(records: readonly SessionRecord[], remoteHsrNodes: ReadonlySet<string>): string[] {
  return records
    .filter((record) => !isArchivedSessionLifecycle(record) && (
      record.substrate === "hsr" || (record.node !== undefined && remoteHsrNodes.has(record.node))
    ))
    .map((record) => record.name);
}

/**
 * Assemble the full StateContext for deriveState from one node-probe pass.
 * Never throws: every source degrades to its honest empty/held form.
 */
export async function assembleStateContext(
  records: SessionRecord[],
  probe: LiveNodeProbe,
  options: AssembleStateContextOptions = {},
): Promise<AssembledStateContext> {
  const deps = options.deps ?? {};
  const now = deps.now ? deps.now() : Date.now();

  const capturePanes = deps.capturePanes ?? capturePanesForRecords;
  const listPanes = deps.listPanes ?? (() => localSubstrate().listPanes());
  const sealedBees = deps.sealedBeeNames ?? sealedBeeNamesImpl;
  const observeHsr = deps.hsrObservations ?? hsrObservationsImpl;
  const listNodes = deps.listNodes ?? listNodesImpl;

  const [panes, seals, livePanes, nodes] = await Promise.all([
    capturePanes(records, probe.liveTargets),
    sealedBees(records).catch(() => new Set<string>()),
    listPanes().catch(() => new Set<string>()),
    listNodes().catch(() => [] as NodeRecord[]),
  ]);

  const remoteHsrNodes = new Set(nodes.filter((node) => node.kind === "remote-hsr").map((node) => node.name));
  const candidates = hsrCandidateNames(records, remoteHsrNodes);

  // A failed observation batch is UNKNOWN, not an authoritative empty result:
  // mark every candidate held instead of letting absence read as death. A
  // successful empty map really does mean the requested run dirs are gone.
  let hsrObs = new Map<string, HsrObservation>();
  const hsrUnavailable = new Set<string>();
  if (candidates.length > 0) {
    try {
      hsrObs = await observeHsr({ includeEvents: options.includeEvents === true, bees: candidates });
    } catch {
      for (const bee of candidates) hsrUnavailable.add(bee);
    }
  }

  const hsrLive = new Set<string>();
  const hsrStates = new Map<string, BeeState>();
  const hsrSnapshots = new Map<string, string>();
  const hsrMirrors = new Set<string>();
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  for (const [bee, observation] of hsrObs) {
    const record = recordsByName.get(bee);
    if (!record) continue;
    // The same trust rule the daemon applies: a local-hsr record never trusts
    // a mirror row, and a mirror row only speaks for the record whose node it
    // mirrors (APIA-94).
    const trustSource = trustedHsrObservationSource(record, observation, remoteHsrNodes);
    if (!trustSource) continue;
    if (observation.live) hsrLive.add(bee);
    if (observation.state) hsrStates.set(bee, observation.state);
    hsrSnapshots.set(bee, observation.snapshot);
    if (trustSource === "remote-hsr-mirror") hsrMirrors.add(bee);
  }

  // Previous states: the persisted legacy cache first (parseBeeState drops
  // unrecognized strings and normalizes sealed/archived → done), then any
  // caller-supplied in-memory observations layered on top.
  const previousStates = new Map<string, BeeState>();
  for (const record of records) {
    const cached = parseBeeState(record.lastObservedState);
    if (cached) previousStates.set(record.name, cached);
  }
  for (const [name, state] of options.previousStates ?? []) previousStates.set(name, state);

  return {
    liveTargets: probe.liveTargets,
    livePanes,
    panes,
    previousStates,
    seals,
    unreachableNodes: options.unreachableNodes ?? probe.unreachableNodes,
    hsrLive,
    hsrStates,
    hsrSnapshots,
    hsrMirrors,
    hsrUnavailable,
    now,
    hsrObservations: hsrObs,
  };
}
