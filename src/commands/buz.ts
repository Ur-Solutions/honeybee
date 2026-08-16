// `hive buz` — addressed bee-to-bee messaging (four-tier delivery + policy).
// Extracted from cli.ts (HIVE-15).
import { BUZ_TIERS, DEFAULT_BUZ_TIER, cancelQueuedBuzMessage, consumeMessage, countQuarantinedMessages, listMessages, parseAcceptFlag, purgeMailbox, readMessageById, requeueQuarantinedMessages, requestMessageRecoveryIfParked, resolveBuzAccept, sanitizeHumanName, sendBuzMessage, senderDisplay, type BuzMessage, type BuzSender, type BuzSendResult, type BuzTier } from "../buz.js";
import { parseAge } from "../clean.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, isPretty, note } from "../format.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { resolveSelector } from "../selectors.js";
import { appendLedger, listSessions, updateSession, type SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { resolveBeeInCurrentPane, resolveSession, stringFlag } from "../cli/shared.js";

export async function cmdBuz(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case "send":
      return buzSend(parsed);
    case "inbox":
      return buzList(parsed, "inbox");
    case "outbox":
      return buzList(parsed, "outbox");
    case "queue":
      return buzList(parsed, "queue");
    case "quarantine":
      return buzList(parsed, "quarantine");
    case "requeue":
      return buzRequeue(parsed);
    case "read":
      return buzRead(parsed);
    case "cancel":
      return buzCancel(parsed);
    case "purge":
      return buzPurge(parsed);
    case "config":
      return buzConfig(parsed);
    default:
      throw new Error(`Unknown buz subcommand: ${sub ?? ""}\nUsage: hive buz <send|inbox|outbox|queue|quarantine|requeue|read|cancel|purge|config>`);
  }
}


export async function resolveBuzSender(parsed: Parsed): Promise<BuzSender> {
  const beeFlag = flag(parsed, "sender");
  const humanFlag = flag(parsed, "sender-human");
  const hasBee = typeof beeFlag === "string" && beeFlag.length > 0;
  const hasHuman = typeof humanFlag === "string" && humanFlag.length > 0;
  if (hasBee && hasHuman) throw new Error("buz: --sender and --sender-human are mutually exclusive");
  if (!hasBee && !hasHuman) {
    // Same fallback as `hive task` (commands/tasks.ts): a bee calling from its
    // own session ($HIVE_BEE / current tmux pane) is its own sender.
    const self = await resolveBeeInCurrentPane();
    if (self) return { kind: "bee", id: self.id ?? self.name };
    throw new Error("buz: exactly one of --sender <bee> or --sender-human <name> is required (no bee identity found in this environment)");
  }
  if (hasBee) {
    // Must resolve to a registered bee.
    const record = await resolveSession(String(beeFlag));
    return { kind: "bee", id: record.id ?? record.name };
  }
  return { kind: "human", name: sanitizeHumanName(String(humanFlag)) };
}


export function parseBuzTier(value: unknown): BuzTier {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`buz: --tier must be one of ${BUZ_TIERS.join(", ")}`);
  }
  if (!(BUZ_TIERS as readonly string[]).includes(value)) {
    throw new Error(`buz: unknown tier "${value}". Use one of: ${BUZ_TIERS.join(", ")}`);
  }
  return value as BuzTier;
}


export async function buzSend(parsed: Parsed) {
  const target = parsed.args[1];
  if (!target) throw new Error(`Usage: hive buz send <selector> [--sender <bee>|--sender-human <name>] [--tier <${BUZ_TIERS.join("|")}>] -p <body> (default tier: ${DEFAULT_BUZ_TIER}; sender defaults to the bee owning the current session)`);
  const tier = parseBuzTier(flag(parsed, "tier") ?? DEFAULT_BUZ_TIER);
  const body = stringFlag(parsed, ["prompt", "p"]) ?? "";
  if (body.length === 0) throw new Error("buz: --prompt|-p body is required");
  const subject = typeof flag(parsed, "subject") === "string" ? String(flag(parsed, "subject")) : undefined;
  const sender = await resolveBuzSender(parsed);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    // Live tiers (interrupt, next-tool) need a transport to paste/hold through;
    // queue/passive are pure mailbox writes.
    const transport = tier === "interrupt" || tier === "next-tool"
      ? { substrate: substrateFor(record), tmuxTarget: record.tmuxTarget, agentPaneId: record.agentPaneId }
      : undefined;
    const result = await sendBuzMessage({
      recipient: record,
      sender,
      tier,
      body,
      ...(subject ? { subject } : {}),
      ...(transport ? { transport } : {}),
      ...(record.node ? { node: record.node } : {}),
    });
    if (result.message.deliveredAs === "queue" && !result.message.deliveredAt) {
      await requestMessageRecoveryIfParked(record, result.message.id);
    }
    printBuzSendResult(record.name, result);
  }
}


/** Shared direct/brokered CLI rendering for one buz-send result. */
export function printBuzSendResult(recordName: string, result: BuzSendResult): void {
  const message = result.message;
  if (isPretty()) {
    const downgradeNote = result.downgraded
      ? dim(`downgraded:${message.tier}->${message.deliveredAs}`)
      : dim(message.deliveredAs);
    console.log(actionLine("ok", "buz", [bold(recordName), message.id, downgradeNote]));
  } else {
    console.log(`buz.send\t${recordName}\t${message.id}\t${message.tier}\t${message.deliveredAs}\t${result.downgraded ? "downgraded" : "ok"}`);
  }
}


export async function buzList(parsed: Parsed, mailbox: "inbox" | "outbox" | "queue" | "quarantine") {
  const target = parsed.args[1];
  if (!target) throw new Error(`Usage: hive buz ${mailbox} <selector> [--limit N] [--from <ref>]`);
  const limit = numberFlag(parsed, ["limit"], 0) || undefined;
  const fromFilter = typeof flag(parsed, "from") === "string" ? String(flag(parsed, "from")) : undefined;

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const storageBee = mailbox === "outbox" ? (record.id || record.name) : record.name;
    const listing = await listMessages(storageBee, mailbox, {
      ...(limit !== undefined ? { limit } : {}),
      ...(fromFilter ? { fromFilter } : {}),
    });
    const quarantined = mailbox === "inbox" ? await countQuarantinedMessages(record.name) : 0;
    printBuzListing({
      recordName: record.name,
      mailbox,
      listing,
      quarantined,
      showRecordHeader: records.length > 1,
    });
  }
}


export type BuzListEntry = { message: BuzMessage; path: string };

/** Shared direct/brokered CLI rendering for one mailbox listing. */
export function printBuzListing(params: {
  recordName: string;
  mailbox: "inbox" | "outbox" | "queue" | "quarantine";
  listing: BuzListEntry[];
  quarantined?: number;
  showRecordHeader?: boolean;
}): void {
  const quarantined = params.quarantined ?? 0;
  // Quarantine must be discoverable: mail dead-letters silently (the sender
  // saw a successful enqueue), so the inbox view is where the operator learns
  // re-drive is needed.
  const quarantineNote = () => {
    if (quarantined === 0) return;
    if (isPretty()) {
      console.log(note(`${params.recordName}: ${quarantined} quarantined message(s) — inspect with \`hive buz quarantine ${params.recordName}\`, re-drive with \`hive buz requeue ${params.recordName} --all\``));
    } else {
      console.log(`buz.quarantine.count\t${params.recordName}\t${quarantined}`);
    }
  };
  if (params.listing.length === 0) {
    if (isPretty()) console.log(dim(`# ${params.recordName}: no ${params.mailbox} messages`));
    quarantineNote();
    return;
  }
  if (!isPretty()) {
    for (const { message, path } of params.listing) {
      console.log([
        `buz.${params.mailbox}`,
        params.recordName,
        message.id,
        senderDisplay(message.from),
        message.to,
        message.tier,
        message.deliveredAs,
        message.sentAt,
        path,
      ].join("\t"));
    }
    quarantineNote();
    return;
  }
  if (params.showRecordHeader) console.log(bold(params.recordName));
  console.log(formatTable(
    [
      { header: "ID" },
      { header: "FROM" },
      { header: "TIER" },
      { header: "DELIVERED" },
      { header: "AGE", align: "right" },
      { header: "SUBJECT" },
    ],
    params.listing.map(({ message }) => [
      message.id,
      senderDisplay(message.from),
      message.tier,
      message.deliveredAs,
      dim(formatRelativeTime(message.sentAt)),
      dim(message.subject ?? ""),
    ]),
  ));
  quarantineNote();
}


/**
 * Re-drive quarantined messages: move them back to queue/ so the daemon drain
 * retries delivery. Quarantine is reached via repeated definite delivery
 * rejections (or malformed files, which stay put) — requeue is the operator's
 * recovery path once the recipient is healthy again.
 */
export async function buzRequeue(parsed: Parsed) {
  const target = parsed.args[1];
  const id = parsed.args[2];
  const all = truthy(flag(parsed, "all"));
  if (!target || (!id && !all) || (id && all)) {
    throw new Error("Usage: hive buz requeue <bee> <message-id> | hive buz requeue <bee> --all");
  }

  const record = await resolveSession(target);
  const result = await requeueQuarantinedMessages(record.name, id ? { id } : {});

  if (id && result.requeued.length === 0) {
    const found = await readMessageById(record.name, id);
    if (found) throw new Error(`message ${id} is in ${found.mailbox}/; only quarantined messages can be requeued`);
    throw new Error(`No quarantined buz message with id ${id} for ${record.name}`);
  }

  for (const { file, reason } of result.skipped) {
    console.error(note(`left in quarantine: ${file} (${reason})`));
  }
  if (isPretty()) {
    console.log(actionLine("ok", "buz", [bold(record.name), `requeued:${result.requeued.length}`]));
  } else {
    console.log(`buz.requeue\t${record.name}\t${result.requeued.length}\t${result.requeued.join(",")}`);
  }
}


export async function buzRead(parsed: Parsed) {
  const id = parsed.args[1];
  const all = truthy(flag(parsed, "all"));
  const consume = truthy(flag(parsed, "consume"));
  const beeRef = typeof flag(parsed, "bee") === "string" ? String(flag(parsed, "bee")) : undefined;
  if (all) {
    if (id) throw new Error("buz read: a message id and --all are mutually exclusive");
    if (consume) throw new Error("buz read: --all already consumes every inbox message; omit --consume");
    if (!beeRef) throw new Error("Usage: hive buz read --all --bee <ref>");
    const record = await resolveSession(beeRef);
    const listing = await listMessages(record.name, "inbox");
    const consumedIds: string[] = [];
    for (const { message } of listing) {
      if (await consumeMessage(record.name, message.id)) consumedIds.push(message.id);
    }
    console.log(JSON.stringify({
      bee: record.name,
      consumed: consumedIds.length,
      ids: consumedIds,
    }, null, 2));
    return;
  }
  if (!id) throw new Error("Usage: hive buz read <message-id> [--consume] [--bee <ref>] | hive buz read --all --bee <ref>");
  const candidates = beeRef ? [await resolveSession(beeRef)] : await listSessions();
  const found = await findBuzMessage(candidates, id);
  if (!found) throw new Error(`No buz message found with id: ${id}`);

  let consumed = false;
  if (consume) {
    const moved = await consumeMessage(found.bee, id);
    consumed = moved !== null;
    if (!moved) {
      // Was not in inbox/, so we can't consume it. Just print it.
      console.error(note(`message ${id} is in ${found.mailbox}/; --consume only applies to inbox/`));
    }
  }

  console.log(JSON.stringify({
    id: found.message.id,
    bee: found.bee,
    mailbox: found.mailbox,
    from: senderDisplay(found.message.from),
    to: found.message.to,
    tier: found.message.tier,
    deliveredAs: found.message.deliveredAs,
    sentAt: found.message.sentAt,
    deliveredAt: found.message.deliveredAt,
    subject: found.message.subject,
    body: found.message.body,
    consumed,
  }, null, 2));
}


export type BuzReadMatch = { message: BuzMessage; bee: string; path: string; mailbox: string };

export const BUZ_READ_LOOKUP_CONCURRENCY = 16;


export async function findBuzMessage(candidates: SessionRecord[], id: string): Promise<BuzReadMatch | null> {
  for (let i = 0; i < candidates.length; i += BUZ_READ_LOOKUP_CONCURRENCY) {
    const batch = candidates.slice(i, i + BUZ_READ_LOOKUP_CONCURRENCY);
    const matches = await Promise.all(batch.map(async (record): Promise<BuzReadMatch | null> => {
      const result = await readMessageById(record.name, id);
      return result ? { message: result.message, bee: record.name, path: result.path, mailbox: result.mailbox } : null;
    }));
    const found = matches.find((match): match is BuzReadMatch => match !== null);
    if (found) return found;
  }
  return null;
}


/**
 * Cancel a queued (not-yet-delivered) message: remove it from the recipient's
 * queue/ under the write lock so a concurrent daemon drain either delivers it
 * fully or never sees it. Only queue/ messages are cancellable — anything in
 * inbox/read/quarantine has already settled. Locking + ledger live in the
 * shared primitive (buz/cancel.ts), reused by the task store.
 */
export async function buzCancel(parsed: Parsed) {
  const target = parsed.args[1];
  const id = parsed.args[2];
  if (!target || !id) throw new Error("Usage: hive buz cancel <bee> <message-id>");

  const record = await resolveSession(target);
  const cancelled = await cancelQueuedBuzMessage(record.name, id);

  if (!cancelled) {
    const found = await readMessageById(record.name, id);
    if (found) throw new Error(`message ${id} is in ${found.mailbox}/; only queued messages can be cancelled`);
    throw new Error(`No queued buz message with id ${id} for ${record.name}`);
  }

  if (isPretty()) console.log(actionLine("ok", "buz", [bold(record.name), `cancelled:${id}`]));
  else console.log(`buz.cancel\t${record.name}\t${id}`);
}


export async function buzPurge(parsed: Parsed) {
  const target = parsed.args[1];
  if (!target) throw new Error("Usage: hive buz purge <selector> [--read|--older-than <age>|--all]");
  const all = truthy(flag(parsed, "all"));
  const readOnly = truthy(flag(parsed, "read"));
  const olderThanRaw = flag(parsed, "older-than");
  const olderThanMs = typeof olderThanRaw === "string" ? parseAge(olderThanRaw) : undefined;

  const flagsCount = [all, readOnly, olderThanMs !== undefined].filter(Boolean).length;
  if (flagsCount === 0) throw new Error("buz purge: pass --read, --older-than <age>, or --all");
  if (flagsCount > 1) throw new Error("buz purge: --read / --older-than / --all are mutually exclusive");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const scope = all ? "all" as const : readOnly ? "read" as const : "older-than" as const;
    const opts = scope === "older-than"
      ? { scope, olderThanMs: olderThanMs! }
      : { scope };
    const result = await purgeMailbox(record.name, opts);
    if (isPretty()) console.log(actionLine("ok", "buz", [bold(record.name), `purged:${scope}`, `${result.removed}`]));
    else console.log(`buz.purge\t${record.name}\t${scope}\t${result.removed}`);
  }
}


export async function buzConfig(parsed: Parsed) {
  const ref = parsed.args[1];
  if (!ref) throw new Error(`Usage: hive buz config <bee> [--accept ${BUZ_TIERS.join(",")}]`);
  const record = await resolveSession(ref);

  const acceptRaw = flag(parsed, "accept");
  if (typeof acceptRaw !== "string") {
    // Read-only inspect: print current resolved policy.
    const policy = resolveBuzAccept(record);
    if (!isPretty()) console.log(`buz.config\t${record.name}\t${policy.join(",")}`);
    else console.log(formatTable(
      [{ header: "BEE" }, { header: "ACCEPT" }, { header: "SOURCE" }],
      [[bold(record.name), policy.join(","), dim(record.buzAccept ? "explicit" : "default")]],
    ));
    return;
  }

  const tiers = parseAcceptFlag(acceptRaw);
  await updateSession(record.name, { buzAccept: tiers, updatedAt: new Date().toISOString() });
  await appendLedger({ type: "buz.config", bee: record.name, buzAccept: tiers });
  if (isPretty()) console.log(actionLine("ok", "buz", [bold(record.name), `accept:${tiers.join(",")}`]));
  else console.log(`buz.config\t${record.name}\t${tiers.join(",")}`);
}
