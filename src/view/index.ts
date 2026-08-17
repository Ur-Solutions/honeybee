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
import { readHsrEventIntegrityReceipt, type HsrEventIntegrityReceipt } from "../hsr/eventIntegrity.js";
import { listNodes, LOCAL_NODE_NAME } from "../node.js";
import { listBeesWithRequests, readBeeRequests } from "../requests/store.js";
import { scanLatestSeal } from "../seal.js";
import { liveTargetKey } from "../state.js";
import { listSessions, safeName, type SessionRecord } from "../store.js";
import { assembleStateContext, type AssembledStateContext } from "./context.js";
import { projectBeeView, type BeeViewProjectionSources } from "./project.js";
import { BEE_VIEW_SCHEMA_VERSION, type BeeViewListV1, type BeeViewV1 } from "./types.js";

export * from "./types.js";
export { projectBeeView, type BeeViewProjectionSources } from "./project.js";
export { deriveOpenRequests, paneFingerprint, storedRequestView, type OpenRequestSources } from "./requests.js";
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
  options: { hasStoredRequests?: boolean } = {},
): Promise<BeeViewV1> {
  // Only names the current-incarnation seal index flagged get a scan; the
  // high-water gate keeps earlier incarnations' seals out of the result.
  const scan = context.seals?.has(record.name)
    ? await scanLatestSeal(record.name, { afterFilename: record.sealHighWaterFilename ?? null }).catch(() => null)
    : null;
  const hiveStateOption = probe.states.get(liveTargetKey(record.node, record.tmuxTarget)) ?? probe.states.get(record.tmuxTarget);
  const observation = context.hsrObservations.get(record.name);
  let eventIntegrityReceipt: HsrEventIntegrityReceipt | null | undefined;
  let eventIntegrityReceiptError: string | undefined;
  if (record.eventIntegrityDoubt) {
    try {
      eventIntegrityReceipt = await readHsrEventIntegrityReceipt(record.name);
    } catch (error) {
      eventIntegrityReceipt = null;
      eventIntegrityReceiptError = error instanceof Error ? error.message : String(error);
    }
  }
  // Durable request records: reads only (view/* never writes the store). The
  // list path gates the per-bee read behind one requests-dir readdir.
  const storedRequests = options.hasStoredRequests === false ? [] : await readBeeRequests(record.name).catch(() => []);
  const sources: BeeViewProjectionSources = {
    record,
    context,
    ...(scan?.seal ? { latestSeal: scan.seal, latestSealFilename: scan.filename } : {}),
    ...(observation?.eventSnapshot ? { eventSnapshot: observation.eventSnapshot } : {}),
    ...(hiveStateOption !== undefined && hiveStateOption.length > 0 ? { hiveStateOption } : {}),
    ...(storedRequests.length > 0 ? { storedRequests } : {}),
    ...(eventIntegrityReceipt !== undefined ? { eventIntegrityReceipt } : {}),
    ...(eventIntegrityReceiptError !== undefined ? { eventIntegrityReceiptError } : {}),
    now: context.now,
  };
  return projectBeeView(sources);
}

/**
 * One full observation pass over the whole store: every record (retired ones
 * included — hiding them is a presentation choice), projected as BeeViewV1.
 */
export async function listBeeViews(): Promise<BeeViewListV1> {
  const [records, nodes, requestStems] = await Promise.all([listSessions(), listNodes(), listBeesWithRequests().catch(() => [] as string[])]);
  const probe = await liveTargetsAcrossNodes(nodes);
  const context = await assembleStateContext(records, probe, { includeEvents: true });
  const stems = new Set(requestStems);
  const bees = await mapWithConcurrency(records, SEAL_SCAN_CONCURRENCY, (record) =>
    projectRecord(record, context, probe, { hasStoredRequests: stems.has(safeName(record.name)) }));
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
