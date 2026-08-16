// `hive send`/answer/brief/seal/rename/tag/own/move — message bees and edit
// their metadata (title, tags, ownership, colony).
// Extracted from cli.ts (HIVE-15).
import { actionLine, bold, dim, isPretty, note } from "../format.js";
import {
  assertNoUnresolvedHsrAnswerOwnership,
  HsrAnswerAmbiguousError,
  HsrAnswerConflictError,
  HsrAnswerDiscardedError,
  HsrAnswerInFlightError,
  canonicalHsrAnswerDigest,
  createHsrAnswerOperation,
  hsrAnswerOperationOwnsRecord,
  hsrAnswerReconciliationCandidates,
  hsrAnswerSource,
  markHsrAnswerOperationAmbiguous,
  markHsrAnswerOperationSending,
  offerHsrAnswerOperation,
  parseHsrAnswerHostCapabilities,
  parseHsrAnswerRpcResult,
  readHsrAnswerReceipt,
  readHsrAnswerReceipts,
  reconcileHsrAnswerOperation,
  sameHsrAnswerHostIdentity,
  type HsrAnswerOperation,
  type HsrAnswerRpcResult,
} from "../answerReceipt.js";
import { deliverSessionText, withRunnableSessionAdmission } from "../delivery.js";
import { writeHiveState, writeHiveTags, writeHiveTitle } from "../hiveState.js";
import { pendingNeedsInput, type PendingNeedsInput } from "../hsr/observe.js";
import { connectRpcClient } from "../hsr/rpc.js";
import { hsrAnswerHostFromMeta, persistHsrAnswerAmbiguity } from "../hsr/answer.js";
import { assertHsrSourceEventLogIntegrity } from "../hsr/eventIntegrity.js";
import type { RunnerInputAnswer } from "../hsr/types.js";
import { withSessionLifecycleLock } from "../lifecycle.js";
import { readHsrMeta } from "../hsr/runDir.js";
import { gatherTitleContext, generateTitle } from "../naming.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { answerAmbiguityRequestId, needsInputRequestId } from "../requests/keys.js";
import { openAndResolveRequest, openRequest, resolveRequest } from "../requests/store.js";
import { sealArtifactExampleJson, sealHelpText, validateSealArtifact, type SealRecord } from "../seal.js";
import { recordRunnableSessionSeal } from "../sealAdmission.js";
import { resolveSelector } from "../selectors.js";
import { appendLedger, loadSession, updateSession, type SessionRecord } from "../store.js";
import { ensureLiveRuntimeForSend } from "../recovery/wake.js";
import { substrateFor } from "../substrates/index.js";
import type { RemoteHsrSubstrate } from "../substrates/remote-hsr.js";
import { dedupeTags, effectiveTags, isValidTagValue, rejectReservedNamespaceTag } from "../tags.js";
import { tmux } from "../tmux.js";
import { readFile } from "node:fs/promises";
import { arrayFlag, deliverBrief, resolveBeeInCurrentPane, resolveSession, stringFlag } from "../cli/shared.js";

export async function cmdSeal(parsed: Parsed) {
  if (truthy(flag(parsed, "help")) || truthy(flag(parsed, "h"))) {
    console.log(sealHelpText());
    return;
  }
  if (truthy(flag(parsed, "example"))) {
    console.log(sealArtifactExampleJson());
    return;
  }

  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive seal <selector> --from <path-to-seal.json>");
  const fromPath = typeof flag(parsed, "from") === "string" ? String(flag(parsed, "from")) : undefined;
  if (!fromPath) throw new Error("hive seal requires --from <path-to-seal.json>");

  const raw = await readFile(fromPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid seal JSON in ${fromPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const artifact = validateSealArtifact(parsedJson);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const stored = await recordRunnableSessionSeal(record, artifact, { mirrorDone: true });
    printSealResult(record.name, stored);
  }
}


/** Shared direct/brokered CLI rendering for one stored seal. */
export function printSealResult(recordName: string, stored: SealRecord): void {
  if (isPretty()) console.log(actionLine("ok", "seal", [bold(recordName), dim(stored.status), dim(stored.type ?? "")]));
  else console.log(`sealed\t${recordName}\t${stored.status}\t${stored.type ?? ""}\t${stored.sealedAt}`);
}


export async function cmdBrief(parsed: Parsed) {
  const target = parsed.args[0];
  const briefText = stringFlag(parsed, ["brief", "b"]) ?? parsed.args.slice(1).join(" ");
  if (!target || !briefText) throw new Error("Usage: hive brief <selector> <text> OR hive brief <selector> --brief <text>");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  let briefedCount = 0;
  for (const record of records) {
    if (!(await substrateFor(record).hasSession(record.tmuxTarget))) {
      if (!isMulti) throw new Error(`tmux session is not running: ${record.tmuxTarget}`);
      if (isPretty()) console.error(note(`skip ${record.name} (dead)`));
      else console.error(`skip\t${record.name}\tdead`);
      continue;
    }
    await deliverBrief(parsed, record, briefText);
    briefedCount += 1;
  }

  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "brief", [bold(target), `${briefedCount}/${records.length} bees`]));
    else console.log(`briefed\t${target}\t${briefedCount}/${records.length}`);
  }
}


export async function cmdRename(parsed: Parsed) {
  const auto = truthy(flag(parsed, "auto"));
  const clear = truthy(flag(parsed, "clear"));
  const here = truthy(flag(parsed, "here"));
  const usage = "Usage: hive rename <selector> <title>  |  hive rename --here <title>  |  hive rename <selector> --auto  |  hive rename <selector> --clear";

  // `--here` reshapes argv to the selector-then-title contract: resolve the
  // current pane's bee and treat every positional as the title (no selector to
  // skip). Without it, args[0] is the selector and args.slice(1) the title.
  let target: string | undefined;
  let explicit: string;
  if (here) {
    const bee = await resolveBeeInCurrentPane();
    if (!bee) throw new Error("hive rename --here: no matching bee for the current pane/session");
    target = bee.name;
    explicit = parsed.args.join(" ").trim();
  } else {
    target = parsed.args[0];
    explicit = parsed.args.slice(1).join(" ").trim();
  }
  if (!target || (auto && clear) || ((auto || clear) === Boolean(explicit))) throw new Error(usage);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);
  if (explicit && isMulti) {
    throw new Error("Refusing to set the same title on multiple bees; use --auto or --clear for swarm/colony selectors");
  }

  for (const record of records) {
    const now = new Date().toISOString();
    if (clear) {
      // Dropping autoTitleAt + the attempt counter makes the bee a fresh daemon
      // auto-title candidate again.
      await updateSession(record.name, {
        title: undefined,
        titleSource: undefined,
        providerTitleKind: undefined,
        autoTitleAt: undefined,
        autoTitleAttempts: undefined,
        updatedAt: now,
      });
      await writeHiveTitle(record, "");
      if (isPretty()) console.log(actionLine("ok", "rename", [bold(record.name), dim("title cleared")]));
      else console.log(`renamed\t${record.name}\t`);
      continue;
    }

    let title = explicit;
    let source: SessionRecord["titleSource"] = "user";
    if (auto) {
      const context = await gatherTitleContext(record);
      if (!context) {
        const reason = "no brief and no transcript to derive a title from";
        if (!isMulti) throw new Error(`${record.name}: ${reason}`);
        console.error(note(`skip ${record.name} (${reason})`));
        continue;
      }
      title = await generateTitle(context);
      source = "auto";
    }
    await updateSession(record.name, {
      title,
      titleSource: source,
      providerTitleKind: undefined,
      updatedAt: now,
      // Stamp autoTitleAt so the daemon's backoff sees a recent attempt; the bee
      // is no longer a candidate once title+titleSource are set, so the attempt
      // counter is intentionally left unbumped (this is the manual override).
      ...(auto ? { autoTitleAt: now } : {}),
    });
    await writeHiveTitle(record, title);
    if (isPretty()) console.log(actionLine("ok", "rename", [bold(record.name), title, dim(source)]));
    else console.log(`renamed\t${record.name}\t${title}\t${source}`);
  }
}


export async function cmdTag(parsed: Parsed) {
  const target = parsed.args[0];
  const usage =
    "Usage: hive tag <selector> <tag>...  |  hive tag <selector> --remove <tag>...  |  hive tag <selector> --list";
  if (!target) throw new Error(usage);

  const listMode = truthy(flag(parsed, "list"));
  const removeArgs = arrayFlag(parsed, "remove");
  const removeMode = removeArgs.length > 0 || flag(parsed, "remove") === true;
  // Positional tags after the selector are the add set (unless we're in
  // list/remove mode, where positionals are ignored).
  const addArgs = !listMode && !removeMode ? parsed.args.slice(1) : [];

  if (!listMode && !removeMode && addArgs.length === 0) {
    throw new Error("hive tag: pass tag names to add, --remove <tag>... to remove, or --list to display");
  }

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);
  const isMulti = resolved.kind !== "bee";

  if (listMode) {
    for (const record of records) {
      const tags = Array.from(effectiveTags(record)).sort();
      const tagStr = tags.length > 0 ? tags.join(", ") : "(none)";
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim(tagStr)]));
      else console.log(`${record.name}\ttags\t${tagStr}`);
    }
    return;
  }

  if (removeMode) {
    if (removeArgs.length === 0) throw new Error("hive tag --remove: pass tag names to remove");
    let changed = 0;
    for (const record of records) {
      const before = record.tags ?? [];
      const after = before.filter((tag) => !removeArgs.includes(tag));
      if (before.length === after.length) {
        if (!isMulti) console.error(note(`${record.name}: no matching tags to remove`));
        continue;
      }
      changed += 1;
      const now = new Date().toISOString();
      await updateSession(record.name, { tags: after.length > 0 ? after : undefined, updatedAt: now });
      await writeHiveTags({ ...record, tags: after.length > 0 ? after : undefined });
      await appendLedger({ type: "tag.remove", bee: record.name, tags: removeArgs });
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim("removed"), removeArgs.join(", ")]));
      else console.log(`${record.name}\ttag.remove\t${removeArgs.join(", ")}`);
    }
    if (isMulti) {
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(target), `removed from ${changed}/${records.length} bees`]));
      else console.log(`tag.remove\t${target}\t${changed}/${records.length} bees`);
    }
    return;
  }

  // ADD mode: validate every tag (reject reserved namespaces, enforce grammar)
  // BEFORE mutating any record, so a bad tag never half-applies.
  for (const tag of addArgs) {
    const rejection = rejectReservedNamespaceTag(tag);
    if (rejection) throw new Error(`hive tag ${tag}: ${rejection}`);
    if (!isValidTagValue(tag)) {
      throw new Error(`Invalid tag: ${tag} (forbid whitespace/comma/tab/newline, max 64 chars)`);
    }
  }

  let changed = 0;
  for (const record of records) {
    const before = record.tags ?? [];
    const after = dedupeTags([...before, ...addArgs]);
    if (before.length === after.length && before.every((t, i) => t === after[i])) {
      if (!isMulti) console.error(note(`${record.name}: already has those tags`));
      continue;
    }
    changed += 1;
    const now = new Date().toISOString();
    await updateSession(record.name, { tags: after, updatedAt: now });
    await writeHiveTags({ ...record, tags: after });
    await appendLedger({ type: "tag.add", bee: record.name, tags: addArgs });
    if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim("added"), addArgs.join(", ")]));
    else console.log(`${record.name}\ttag.add\t${addArgs.join(", ")}`);
  }
  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "tag", [bold(target), `added to ${changed}/${records.length} bees`]));
    else console.log(`tag.add\t${target}\t${changed}/${records.length} bees`);
  }
}


// Resolve the owner selector to EXACTLY ONE bee, then point every bee resolved
// from each beeSelector at it (reportsToId edge). Shared by cmdOwn's set path
// and cmdMove's --owner alias (Risk 5: avoids synthesizing a fake Parsed).
export async function setOwnership(ownerSel: string, beeSelectors: string[]): Promise<void> {
  const ownerResolved = await resolveSelector(ownerSel);
  const ownerRecords = ownerResolved.kind === "bee" ? [ownerResolved.record] : ownerResolved.records;
  if (ownerRecords.length === 0) throw new Error(`hive own: owner selector matched no bee: ${ownerSel}`);
  if (ownerRecords.length > 1) {
    throw new Error(`hive own: owner selector ${ownerSel} matched ${ownerRecords.length} bees; pick one`);
  }
  const owner = ownerRecords[0]!;
  const ownerId = owner.id ?? owner.name;

  let changed = 0;
  let total = 0;
  for (const sel of beeSelectors) {
    const resolved = await resolveSelector(sel);
    const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
    for (const record of records) {
      total += 1;
      const now = new Date().toISOString();
      await updateSession(record.name, { reportsToId: ownerId, updatedAt: now });
      await appendLedger({ type: "rel.set", bee: record.name, kind: "reports-to", to: ownerId });
      changed += 1;
      if (isPretty()) console.log(actionLine("ok", "own", [bold(record.name), dim("reports-to"), ownerId]));
      else console.log(`${record.name}\trel.set\treports-to\t${ownerId}`);
    }
  }
  if (isPretty()) console.log(actionLine("ok", "own", [bold(ownerId), `${changed}/${total} bees`]));
  else console.log(`own\t${ownerId}\t${changed}/${total} bees`);
}


// Clear the reportsToId edge on every bee resolved from beeSel. NEVER kills a
// bee — relationships are reference-only (§9.4 / R3).
export async function clearOwnership(beeSel: string): Promise<void> {
  const resolved = await resolveSelector(beeSel);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${beeSel}`);
  for (const record of records) {
    const now = new Date().toISOString();
    await updateSession(record.name, { reportsToId: undefined, updatedAt: now });
    await appendLedger({ type: "rel.clear", bee: record.name, kind: "reports-to" });
    if (isPretty()) console.log(actionLine("ok", "own", [bold(record.name), dim("cleared")]));
    else console.log(`${record.name}\trel.clear\treports-to`);
  }
}


// `hive own <owner-selector> <bee-selector>...` sets the owned-by/reports-to
// edge; `hive own <bee-selector> --clear` unsets it. No @hive_tags refresh:
// relationships have no tmux mirror in v1 (§9.4).
export async function cmdOwn(parsed: Parsed) {
  const ownerSel = parsed.args[0];
  const usage =
    "Usage: hive own <owner-selector> <bee-selector>...  |  hive own <bee-selector> --clear";
  if (!ownerSel) throw new Error(usage);

  if (truthy(flag(parsed, "clear"))) {
    if (parsed.args.length > 1) throw new Error("hive own --clear takes exactly one <bee-selector>");
    await clearOwnership(ownerSel);
    return;
  }

  const beeSelectors = parsed.args.slice(1);
  if (beeSelectors.length === 0) throw new Error(usage);
  await setOwnership(ownerSel, beeSelectors);
}


// `hive move <bee> --colony <c>` reassigns a bee's colony (the derived colony:
// tag follows on read); `hive move <bee> --owner <o>` is an alias for hive own
// on one bee, and `--owner ''` clears ownership.
export async function cmdMove(parsed: Parsed) {
  const beeSel = parsed.args[0];
  const usage =
    "Usage: hive move <bee> --colony <c>  |  hive move <bee> --owner <o>  (--owner '' clears)";
  if (!beeSel) throw new Error(usage);

  const colonyRaw = flag(parsed, "colony");
  const ownerRaw = flag(parsed, "owner");
  if (colonyRaw === undefined && ownerRaw === undefined) throw new Error(usage);
  if (colonyRaw !== undefined && ownerRaw !== undefined) {
    throw new Error("hive move: pass either --colony or --owner, not both");
  }

  // --owner: alias for hive own on a single bee; --owner '' clears ownership.
  if (ownerRaw !== undefined) {
    const owner = typeof ownerRaw === "string" ? ownerRaw.trim() : "";
    if (owner === "") {
      await clearOwnership(beeSel);
      return;
    }
    await setOwnership(owner, [beeSel]);
    return;
  }

  // --colony: rewrite record.colony on each resolved bee (derived colony: tag
  // follows). Refresh @hive_tags because colony: is a derived reserved tag.
  if (colonyRaw === true) throw new Error("--colony requires a value");
  const colony = String(colonyRaw);
  const resolved = await resolveSelector(beeSel);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${beeSel}`);
  for (const record of records) {
    const now = new Date().toISOString();
    const next = colony.trim() === "" ? undefined : colony;
    await updateSession(record.name, { colony: next, updatedAt: now });
    await writeHiveTags({ ...record, colony: next });
    if (isPretty()) console.log(actionLine("ok", "move", [bold(record.name), dim("colony"), next ?? "(none)"]));
    else console.log(`${record.name}\tmove\tcolony\t${next ?? ""}`);
  }
}


export async function cmdSend(parsed: Parsed) {
  const target = parsed.args[0];
  const prompt = stringFlag(parsed, ["prompt", "p"]) ?? parsed.args.slice(1).join(" ");
  if (!target || !prompt) throw new Error("Usage: hive send <selector> <prompt> OR hive send <selector> -p <prompt>");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  let sent = 0;
  for (const record of records) {
    let deliveryRecord: SessionRecord;
    try {
      deliveryRecord = (await ensureLiveRuntimeForSend(record)).record;
    } catch (error) {
      if (!isMulti) throw error;
      if (isPretty()) console.error(note(`skip ${record.name} (${error instanceof Error ? error.message : String(error)})`));
      else console.error(`skip\t${record.name}\tdead`);
      continue;
    }
    const delivered = await deliverSessionText(deliveryRecord, prompt);
    await writeHiveState(delivered.record, "working").catch(() => undefined);
    await appendLedger({ type: "prompt.send", session: deliveryRecord.name, agent: deliveryRecord.agent, node: deliveryRecord.node ?? LOCAL_NODE_NAME, cwd: deliveryRecord.cwd, chars: prompt.length }).catch(() => undefined);
    if (isPretty()) console.log(actionLine("ok", "send", [bold(deliveryRecord.name), `${prompt.length} chars`]));
    else console.log(`sent\t${deliveryRecord.name}\t${prompt.length} chars`);
    sent += 1;
  }

  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "send", [bold(target), `${sent}/${records.length} bees`]));
    else console.log(`sent\t${target}\t${sent}/${records.length}`);
  }
}


/**
 * Answer the pending needs_input of a blocked HSR bee through its local or
 * remote control authority.
 * The daemon routes an HSR bee's needs_input to its parent as a buz; the parent
 * (or a human) replies with `hive answer <bee> <text>`. Defaults to "yes" when
 * no text is supplied (the common permission-approve case).
 */
function parseAnswerValue(answer: string): RunnerInputAnswer {
  if (answer.trim().startsWith("[")) {
    try {
      const value = JSON.parse(answer) as unknown;
      if (
        Array.isArray(value) &&
        value.every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))
      ) return value as string[][];
    } catch {
      // Preserve the legacy behavior: malformed/non-matrix JSON is plain text.
    }
  }
  return answer;
}

function requestInputForPending(record: SessionRecord, pending: PendingNeedsInput) {
  const openedAt = Number.isFinite(pending.ts) && pending.ts > 0 ? new Date(pending.ts).toISOString() : undefined;
  return {
    id: needsInputRequestId(record.name, pending),
    kind: pending.kind,
    scope: "turn" as const,
    grade: "structured" as const,
    generation: record.runtimeGeneration ?? 0,
    ...(openedAt !== undefined ? { openedAt } : {}),
    question: pending.question,
    ...(pending.tool !== undefined ? { tool: pending.tool } : {}),
    ...(pending.options !== undefined ? { options: pending.options } : {}),
    ...(pending.optionDetails !== undefined ? { optionDetails: pending.optionDetails } : {}),
    ...(pending.questions !== undefined ? { questions: pending.questions } : {}),
    ...(pending.multiSelect !== undefined ? { multiSelect: pending.multiSelect } : {}),
    ...(pending.input !== undefined ? { input: pending.input } : {}),
    evidence: {
      grade: "structured" as const,
      source: "hsr-events",
      ...(openedAt !== undefined ? { observedAt: openedAt } : {}),
      detail: "needs_input",
    },
  };
}

function receiptResult(phase: Awaited<ReturnType<typeof readHsrAnswerReceipt>>): HsrAnswerRpcResult | null {
  if (!phase) return null;
  if (phase.phase === "settled") return { status: "settled", replayed: true, ...(phase.host ? { host: phase.host } : {}) };
  if (phase.phase === "ambiguous") return { status: "ambiguous", reason: phase.reason!, ...(phase.host ? { host: phase.host } : {}) };
  if (phase.phase === "discarded") return { status: "discarded" };
  if (phase.phase === "dispatching") return { status: "in-flight" };
  return null;
}

async function reconcileAnswerFromCli(parsed: Parsed): Promise<void> {
  const target = parsed.args[1];
  const requestId = parsed.args[2];
  const digest = stringFlag(parsed, ["digest"]);
  const generationRaw = stringFlag(parsed, ["generation"]);
  const delivered = truthy(flag(parsed, "delivered"));
  const discard = truthy(flag(parsed, "discard"));
  if (!target || !requestId || !digest || generationRaw === undefined || delivered === discard) {
    throw new Error(
      "Usage: hive answer reconcile <bee> <request-id> --generation <n> --digest <sha256> --delivered|--discard",
    );
  }
  const generation = Number(generationRaw);
  if (!Number.isSafeInteger(generation) || generation < 0 || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("answer reconciliation requires an exact non-negative generation and lowercase sha256 digest");
  }
  const resolved = await resolveSession(target).catch(() => null);
  const bee = resolved?.name ?? target;
  const reconciled = await withSessionLifecycleLock(bee, async () => {
    const current = await loadSession(bee);
    const matches = hsrAnswerReconciliationCandidates({
      receipts: await readHsrAnswerReceipts(bee),
      requestId,
      runtimeGeneration: generation,
      answerDigest: digest,
      current,
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `no exact answer receipt matches ${bee}/${generation}/${requestId}/${digest}`
          : `multiple answer receipts match ${bee}/${generation}/${requestId}/${digest}`,
      );
    }
    const operation = matches[0]!.operation;
    if (!current && operation.source.remoteLaunchId) {
      throw new Error(
        `remote answer reconciliation for ${bee} requires its preserved canonical node/launch/incarnation locator`,
      );
    }
    const currentOwnsOperation = !!current && hsrAnswerOperationOwnsRecord(operation, current);
    if (current && !currentOwnsOperation && (current.runtimeGeneration ?? 0) === generation) {
      throw new Error(`answer reconciliation source does not own ${bee}'s current generation`);
    }

    // A remote provider receipt is the first authority. Mirror it locally only
    // after the node confirms the exact terminal verdict; an unconfirmed remote
    // call leaves the controller receipt unresolved and retryable.
    if (currentOwnsOperation && substrateFor(current!).kind === "remote-hsr") {
      const remote = substrateFor(current!) as RemoteHsrSubstrate;
      const remoteResult = await remote.reconcileAnswerRemote(
        bee,
        operation,
        delivered ? "delivered" : "discard",
        {
          ...(current!.remoteLaunchId ? { remoteLaunchId: current!.remoteLaunchId } : {}),
          ...(current!.remoteIncarnation ? { remoteIncarnation: current!.remoteIncarnation } : {}),
        },
      );
      if ((delivered && remoteResult.status !== "settled") || (!delivered && remoteResult.status !== "discarded")) {
        throw new Error(
          remoteResult.status === "ambiguous" || remoteResult.status === "conflict"
            ? remoteResult.reason
            : `remote answer reconciliation remains ${remoteResult.status}`,
        );
      }
    }

    const receipt = await reconcileHsrAnswerOperation(bee, operation, delivered ? "delivered" : "discard");
    // Reconciliation never revives or dispatches. Only a delivered verdict is
    // strong enough to close the original provider request.
    if (delivered && currentOwnsOperation) {
      await resolveRequest(
        bee,
        needsInputRequestId(bee, { requestId, ts: 0, host: operation.host }),
        { by: "hive-answer-reconcile", resolution: "delivered" },
      );
    }
    await resolveRequest(
      bee,
      answerAmbiguityRequestId(bee, generation, requestId, digest, operation.host),
      { by: "hive-answer-reconcile", resolution: delivered ? "delivered" : "discarded" },
    );
    return receipt;
  });
  if (isPretty()) console.log(actionLine("ok", "answer reconcile", [bold(bee), dim(reconciled.phase)]));
  else console.log(`answer-reconciled\t${bee}\t${requestId}\t${reconciled.phase}`);
}

export async function cmdAnswer(parsed: Parsed) {
  if (parsed.args[0] === "reconcile") return reconcileAnswerFromCli(parsed);
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive answer <bee> [text]");
  const text = stringFlag(parsed, ["answer", "a"]) ?? parsed.args.slice(1).join(" ");
  const answer = text.length > 0 ? text : "yes";
  const wireAnswer = parseAnswerValue(answer);

  const record = await resolveSession(target);
  const initialSubstrate = substrateFor(record);
  if (record.substrate !== "hsr" && initialSubstrate.kind !== "remote-hsr") {
    throw new Error(`hive answer applies to HSR bees only; ${record.name} is ${record.substrate ?? "local-tmux"}`);
  }
  let answeredRequestId: string | undefined;

  await withRunnableSessionAdmission(record, async (_lifecycle, current) => {
    const currentSubstrate = substrateFor(current);
    if (current.substrate !== "hsr" && currentSubstrate.kind !== "remote-hsr") {
      throw new Error(`hive answer applies to HSR bees only; ${current.name} is ${current.substrate ?? "local-tmux"}`);
    }
    const authority = {
      ...(current.remoteLaunchId ? { remoteLaunchId: current.remoteLaunchId } : {}),
      ...(current.remoteIncarnation ? { remoteIncarnation: current.remoteIncarnation } : {}),
    };
    // Read the pending request only after lifecycle admission. A replacement
    // must not turn a pre-lock requestId into an answer for the next runtime.
    // Remote reads are also token-qualified at the remote authority.
    const pendingState = currentSubstrate.kind === "remote-hsr"
      ? await (currentSubstrate as RemoteHsrSubstrate).pendingInputRemote(current.name, authority)
      : await (async () => {
          const meta = await readHsrMeta(current.name);
          if (!meta) throw new Error(`No HSR host metadata for ${current.name}`);
          await assertHsrSourceEventLogIntegrity({
            bee: current.name,
            meta,
            operation: "hive answer",
          });
          return { pending: await pendingNeedsInput(current.name), host: hsrAnswerHostFromMeta(meta) };
        })();
    const { pending, host } = pendingState;
    let operation: HsrAnswerOperation;
    if (pending) {
      operation = createHsrAnswerOperation(current, pending.requestId, wireAnswer, host);
    } else {
      // A provider may have accepted and closed the prompt while the outer RPC
      // reply was lost. Recover the one exact generation+digest receipt instead
      // of requiring the now-absent pending event or issuing a second response.
      const digest = canonicalHsrAnswerDigest(wireAnswer);
      const candidates = (await readHsrAnswerReceipts(current.name)).filter((receipt) =>
        receipt.phase !== "discarded" && receipt.operation.answerDigest === digest &&
        hsrAnswerOperationOwnsRecord(receipt.operation, current) &&
        sameHsrAnswerHostIdentity(receipt.operation.host, host));
      if (candidates.length !== 1) {
        throw new Error(
          candidates.length === 0
            ? `No pending needs-input or matching answer receipt for ${current.name}`
            : `Multiple answer receipts match ${current.name}; retry with the exact provider request after reconciliation`,
        );
      }
      operation = candidates[0]!.operation;
    }

    // Answer admission may bypass the general lifecycle fence only for an
    // exact retry of this operation. An unresolved answer for any other
    // provider request must keep all new provider effects fenced.
    await assertNoUnresolvedHsrAnswerOwnership(current, "hive answer", operation);
    if (pending && currentSubstrate.kind === "remote-hsr") {
      await offerHsrAnswerOperation(current.name, operation);
    }

    const offered = await readHsrAnswerReceipt(current.name, operation);
    let result = receiptResult(offered);
    // A terminal local receipt is sufficient proof; otherwise the exact same
    // operation crosses the local/remote host authority boundary.
    if (!result || result.status === "in-flight") {
      if (currentSubstrate.kind === "remote-hsr") {
        result = await (currentSubstrate as RemoteHsrSubstrate).answerRemote(
          current.name,
          operation,
          wireAnswer,
          authority,
        );
      } else {
        const meta = await readHsrMeta(current.name);
        if (!meta?.controlSocket) throw new Error(`No control socket for ${current.name}`);
        const client = await connectRpcClient(meta.controlSocket);
        try {
          parseHsrAnswerHostCapabilities(await client.call("answerCapabilities"));
          if (pending) {
            result = receiptResult(await offerHsrAnswerOperation(current.name, operation));
          }
          if (!result || result.status === "in-flight") {
            await markHsrAnswerOperationSending(current.name, operation);
            try {
              result = parseHsrAnswerRpcResult(await client.call("answer", { operation, answer: wireAnswer }));
            } catch (error) {
              // The host receipt is in this store. It can prove a lost outer RPC
              // reply without another provider write; offered still means the
              // host never claimed and the original transport error is retryable.
              let receipt = await readHsrAnswerReceipt(current.name, operation);
              if (receipt?.phase === "sending") {
                const reason = `host answer RPC outcome was lost after request transport: ${error instanceof Error ? error.message : String(error)}`;
                try {
                  receipt = await markHsrAnswerOperationAmbiguous(current.name, operation, reason);
                } catch {
                  receipt = await readHsrAnswerReceipt(current.name, operation);
                }
              }
              const after = receiptResult(receipt);
              if (!after) throw error;
              result = after;
            }
          }
        } finally {
          client.close();
        }
      }
    }

    if (result.status === "conflict") {
      // A remote conflict may name a different digest that already owns this
      // exact provider request. Publish a conservative local fence even though
      // the remote protocol intentionally does not disclose that answer digest.
      if (currentSubstrate.kind === "remote-hsr") {
        await persistHsrAnswerAmbiguity(current, operation, result.reason);
      }
      throw new HsrAnswerConflictError(operation, result.reason);
    }
    if (result.status === "discarded") {
      await reconcileHsrAnswerOperation(current.name, operation, "discard");
      throw new HsrAnswerDiscardedError(operation, `HSR answer ${operation.requestId} was explicitly discarded`);
    }
    if (result.status === "in-flight") {
      throw new HsrAnswerInFlightError(operation, `HSR answer ${operation.requestId} is still dispatching`);
    }
    if (result.status === "ambiguous") {
      const generation = current.runtimeGeneration ?? 0;
      const errors: unknown[] = [];
      try {
        await persistHsrAnswerAmbiguity(current, operation, result.reason, result.host);
      } catch (error) {
        errors.push(error);
      }
      if (pending) {
        await openRequest(current.name, requestInputForPending(current, { ...pending, host })).catch((error) => errors.push(error));
      }
      await openRequest(current.name, {
        id: answerAmbiguityRequestId(
          current.name,
          generation,
          operation.requestId,
          operation.answerDigest,
          operation.host,
        ),
        kind: "manual-action",
        scope: "runtime-generation",
        grade: "structured",
        generation,
        question: "An answer crossed provider dispatch, but local handoff or HTTP acceptance cannot be proven. Inspect the provider request before reconciling delivered or discard.",
        input: { operation },
        evidence: { grade: "structured", source: "hsr-answer-receipt", detail: "answer-ambiguous" },
      }).catch((error) => errors.push(error));
      throw new HsrAnswerAmbiguousError(
        operation,
        result.reason,
        errors.length > 0 ? { cause: new AggregateError(errors, "could not preserve answer ambiguity requests") } : undefined,
      );
    }

    await reconcileHsrAnswerOperation(current.name, operation, "delivered");
    if (currentSubstrate.kind === "remote-hsr") {
      // The remote host receipt is authoritative for provider handoff; mirror
      // its settled proof into this caller-side receipt before metadata closes.
    }
    answeredRequestId = operation.requestId;

    // Durable resolution AFTER the RPC succeeded, under the SAME lifecycle
    // admission and id the live view derives. Stop cannot win between provider
    // acceptance and this request settlement.
    const callerBee = process.env.HIVE_BEE;
    if (pending) {
      await openAndResolveRequest(
        current.name,
        requestInputForPending(current, { ...pending, host }),
        { by: callerBee ? `hive-answer:${callerBee}` : "hive-answer", resolution: answer },
      );
    } else {
      await resolveRequest(current.name, needsInputRequestId(current.name, {
        requestId: operation.requestId,
        ts: 0,
        host: operation.host,
      }), {
        by: callerBee ? `hive-answer:${callerBee}` : "hive-answer",
        resolution: answer,
      });
    }
  }, { operation: "hive answer", deferAnswerOwnershipToExactOperation: true });

  if (!answeredRequestId) throw new Error(`No pending needs-input for ${record.name}`);
  if (isPretty()) console.log(actionLine("ok", "answer", [bold(record.name), dim(answeredRequestId)]));
  else console.log(`answered\t${record.name}\t${answeredRequestId}`);
}
