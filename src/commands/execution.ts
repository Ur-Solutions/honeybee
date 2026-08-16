import { resolveSession } from "../cli/shared.js";
import { repairLegacyLeaseExpiryArchive } from "../execution/archiveRepair.js";
import { flag, truthy, type Parsed } from "../parse.js";

const REPAIR_USAGE =
  "Usage: hive execution repair-lease-archive <exact-bee> --run <exact-run-id> [--apply] [--json]";

/** Narrow operator-authorized correction for the historical lease archive bug. */
export async function cmdExecution(parsed: Parsed): Promise<void> {
  const subcommand = parsed.args[0];
  if (subcommand !== "repair-lease-archive") {
    throw new Error(`Unknown execution subcommand: ${subcommand ?? ""}\n${REPAIR_USAGE}`);
  }
  const beeRef = parsed.args[1];
  const runFlag = flag(parsed, "run");
  const runId = typeof runFlag === "string" ? runFlag : undefined;
  if (!beeRef || !runId || parsed.args.length !== 2) throw new Error(REPAIR_USAGE);
  // User-facing Bee ids (CO.*) and canonical lookup names (xr-*) are both
  // accepted through the normal ambiguity-refusing resolver. The proof engine
  // always receives the one canonical SessionRecord name it resolved.
  const beeName = (await resolveSession(beeRef)).name;

  const result = await repairLegacyLeaseExpiryArchive(beeName, runId, {
    apply: truthy(flag(parsed, "apply")),
  });
  if (truthy(flag(parsed, "json"))) {
    const { record: _record, ...projection } = result.status === "repaired" || result.status === "already-repaired"
      ? result
      : { ...result, record: undefined };
    console.log(JSON.stringify(projection));
  } else {
    const reason = result.status === "refused" ? result.reason : result.detail;
    console.log(["execution.repair-lease-archive", beeName, runId, result.status, reason].join("\t"));
  }
  if (result.status === "refused") {
    throw new Error(`execution repair refused (${result.reason}): ${result.detail}`);
  }
}
