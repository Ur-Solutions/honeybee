import {
  acknowledgeHsrEventIntegrityLoss,
  readHsrEventIntegrityReceipt,
} from "../hsr/eventIntegrity.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { resolveSession } from "../cli/shared.js";
import { substrateFor } from "../substrates/index.js";
import type { RemoteHsrSubstrate } from "../substrates/remote-hsr.js";

/** Explicit manual settlement for an HSR source-event loss. */
export async function cmdHsrReconcile(parsed: Parsed): Promise<void> {
  const bee = parsed.args[0];
  const integrityId = parsed.args[1];
  const acknowledge = truthy(flag(parsed, "acknowledge-loss"));
  const discardConsumer = flag(parsed, "discard-consumer");
  if (bee && typeof discardConsumer === "string") {
    const record = await resolveSession(bee);
    const substrate = substrateFor(record);
    if (substrate.kind !== "remote-hsr" || !record.remoteLaunchId || !record.remoteIncarnation) {
      throw new Error(`HSR durable-consumer discard for ${record.name} requires exact remote launch/incarnation authority`);
    }
    const result = await (substrate as RemoteHsrSubstrate).discardEventConsumerRemote(
      record.name,
      discardConsumer,
      { remoteLaunchId: record.remoteLaunchId, remoteIncarnation: record.remoteIncarnation },
    );
    const range = result.lostFromSeq === undefined
      ? "caught-up"
      : `lost=${result.lostFromSeq}-${result.lostToSeq}`;
    console.log(`hsr.consumer-discard\t${record.name}\t${discardConsumer}\t${range}\treclaimed=${result.reclaimed}`);
    return;
  }
  if (!bee || !integrityId || !acknowledge) {
    throw new Error(
      "Usage: hive hsr-reconcile <bee> <integrity-id> --acknowledge-loss | hive hsr-reconcile <bee> --discard-consumer <consumer-id>",
    );
  }
  let record;
  try {
    record = await resolveSession(bee);
  } catch (error) {
    // A local prepublication failure may have no canonical row. Exact canonical
    // names remain repairable only when the named outside receipt itself proves
    // this exact id. Never reinterpret a remote RPC/auth/storage failure as a
    // local acknowledgement.
    const head = await readHsrEventIntegrityReceipt(bee).catch(() => null);
    if (!head || head.integrityId !== integrityId || head.remoteAuthority) throw error;
    const receipt = await acknowledgeHsrEventIntegrityLoss(bee, integrityId);
    console.log(`hsr.reconcile\t${bee}\t${integrityId}\t${receipt.phase}`);
    return;
  }

  const substrate = substrateFor(record);
  if (substrate.kind === "remote-hsr") {
    if (!record.remoteLaunchId || !record.remoteIncarnation) {
      throw new Error(`remote HSR event-integrity reconciliation for ${record.name} requires exact launch/incarnation authority`);
    }
    // Node authority first. Only its exact acknowledgement proves the remote
    // receipt settled; a lost/refused RPC must leave the controller fence intact.
    await (substrate as RemoteHsrSubstrate).reconcileEventIntegrityRemote(
      record.name,
      integrityId,
      { remoteLaunchId: record.remoteLaunchId, remoteIncarnation: record.remoteIncarnation },
    );
    const local = await readHsrEventIntegrityReceipt(record.name);
    if (local?.integrityId === integrityId) {
      await acknowledgeHsrEventIntegrityLoss(record.name, integrityId);
    }
  } else {
    await acknowledgeHsrEventIntegrityLoss(record.name, integrityId);
  }
  console.log(`hsr.reconcile\t${record.name}\t${integrityId}\tacknowledged`);
}
