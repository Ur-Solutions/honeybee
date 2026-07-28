/**
 * BeeView V1 — the versioned Honeybee read model (docs/BEEVIEW_READ_API.md).
 *
 * This module is the supported library surface, re-exported through the
 * package root (src/index.ts): projectBeeViewFromSources (pure, for tests and
 * embedders with their own gathering), and getBeeView/listBeeViews, which run
 * one full observation pass (same cost as `hive ls` — design decision 1) and
 * project every record through the same pure projection the CLI mirror
 * serializes verbatim.
 *
 * Invariant: nothing under src/view/ ever writes — no touchSession, no
 * @hive_state mirroring, no ledger appends. Reads only; staleness is
 * surfaced, never hidden.
 */

import { liveTargetsAcrossNodes, resolveSession, type MultiNodeLiveProbe } from "../cli/shared.js";
import { mapWithConcurrency } from "../concurrency.js";
import { listNodes, LOCAL_NODE_NAME } from "../node.js";
import { scanLatestSeal } from "../seal.js";
import { liveTargetKey } from "../state.js";
import { listSessions, type SessionRecord } from "../store.js";
import { assembleStateContext, type AssembledStateContext } from "./context.js";
import { projectBeeView, type BeeViewProjectionSources } from "./project.js";
import { BEE_VIEW_SCHEMA_VERSION, type BeeViewListV1, type BeeViewV1 } from "./types.js";

export * from "./types.js";
export { projectBeeView, type BeeViewProjectionSources } from "./project.js";
export { deriveOpenRequests, paneFingerprint, type OpenRequestSources } from "./requests.js";
export {
  assembleStateContext,
  capturePanesForRecords,
  PANE_CAPTURE_CONCURRENCY,
  type AssembledStateContext,
  type AssembleStateContextOptions,
  type LiveNodeProbe,
  type StateContextAssemblyDeps,
} from "./context.js";

/**
 * Pure projection over caller-gathered sources — the seam fixture tests and
 * embedders with their own observation pass use. Identical to projectBeeView.
 */
export const projectBeeViewFromSources = projectBeeView;

const SEAL_SCAN_CONCURRENCY = 16;

/** Project one record against an assembled context + probe (seal scan included). */
async function projectRecord(
  record: SessionRecord,
  context: AssembledStateContext,
  probe: MultiNodeLiveProbe,
): Promise<BeeViewV1> {
  // Only names the current-incarnation seal index flagged get a scan; the
  // high-water gate keeps earlier incarnations' seals out of the result.
  const scan = context.seals?.has(record.name)
    ? await scanLatestSeal(record.name, { afterFilename: record.sealHighWaterFilename ?? null }).catch(() => null)
    : null;
  const hiveStateOption = probe.states.get(liveTargetKey(record.node, record.tmuxTarget)) ?? probe.states.get(record.tmuxTarget);
  const observation = context.hsrObservations.get(record.name);
  const sources: BeeViewProjectionSources = {
    record,
    context,
    ...(scan?.seal ? { latestSeal: scan.seal, latestSealFilename: scan.filename } : {}),
    ...(observation?.eventSnapshot ? { eventSnapshot: observation.eventSnapshot } : {}),
    ...(hiveStateOption !== undefined && hiveStateOption.length > 0 ? { hiveStateOption } : {}),
    now: context.now,
  };
  return projectBeeView(sources);
}

/**
 * One full observation pass over the whole store: every record (retired ones
 * included — hiding them is a presentation choice), projected as BeeViewV1.
 */
export async function listBeeViews(): Promise<BeeViewListV1> {
  const [records, nodes] = await Promise.all([listSessions(), listNodes()]);
  const probe = await liveTargetsAcrossNodes(nodes);
  const context = await assembleStateContext(records, probe, { includeEvents: true });
  const bees = await mapWithConcurrency(records, SEAL_SCAN_CONCURRENCY, (record) => projectRecord(record, context, probe));
  return {
    schemaVersion: BEE_VIEW_SCHEMA_VERSION,
    generatedAt: new Date(context.now).toISOString(),
    node: LOCAL_NODE_NAME,
    unreachableNodes: [...probe.unreachableNodes].sort(),
    bees,
  };
}

/**
 * One bee's view by name/id/ref (retired bees resolvable — explain works on a
 * filed record). Probes only the bee's own node.
 */
export async function getBeeView(selector: string): Promise<BeeViewV1> {
  const record = await resolveSession(selector);
  const nodes = await listNodes();
  const nodeName = record.node && record.node.length > 0 ? record.node : LOCAL_NODE_NAME;
  const probe = await liveTargetsAcrossNodes(nodes, nodeName);
  const context = await assembleStateContext([record], probe, { includeEvents: true });
  return projectRecord(record, context, probe);
}
