// `hive buz` — addressed bee-to-bee messaging (three-tier delivery + policy).
// Extracted from cli.ts (HIVE-15).
import { BUZ_TIERS, consumeMessage, listMessages, parseAcceptFlag, purgeMailbox, readMessageById, resolveBuzAccept, sanitizeHumanName, sendBuzMessage, senderDisplay, type BuzMessage, type BuzSender, type BuzTier } from "../buz.js";
import { parseAge } from "../clean.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, isPretty, note } from "../format.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { resolveSelector } from "../selectors.js";
import { appendLedger, listSessions, updateSession, type SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { resolveSession, stringFlag } from "../cli/shared.js";

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
    case "read":
      return buzRead(parsed);
    case "purge":
      return buzPurge(parsed);
    case "config":
      return buzConfig(parsed);
    default:
      throw new Error(`Unknown buz subcommand: ${sub ?? ""}\nUsage: hive buz <send|inbox|outbox|queue|read|purge|config>`);
  }
}


export async function resolveBuzSender(parsed: Parsed): Promise<BuzSender> {
  const beeFlag = flag(parsed, "sender");
  const humanFlag = flag(parsed, "sender-human");
  const hasBee = typeof beeFlag === "string" && beeFlag.length > 0;
  const hasHuman = typeof humanFlag === "string" && humanFlag.length > 0;
  if (hasBee && hasHuman) throw new Error("buz: --sender and --sender-human are mutually exclusive");
  if (!hasBee && !hasHuman) throw new Error("buz: exactly one of --sender <bee> or --sender-human <name> is required");
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
  if (!target) throw new Error("Usage: hive buz send <selector> --sender <bee>|--sender-human <name> --tier <interrupt|queue|passive> -p <body>");
  const tier = parseBuzTier(flag(parsed, "tier") ?? "queue");
  const body = stringFlag(parsed, ["prompt", "p"]) ?? "";
  if (body.length === 0) throw new Error("buz: --prompt|-p body is required");
  const subject = typeof flag(parsed, "subject") === "string" ? String(flag(parsed, "subject")) : undefined;
  const sender = await resolveBuzSender(parsed);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const transport = tier === "interrupt"
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
    const m = result.message;
    if (isPretty()) {
      const downgradeNote = result.downgraded ? dim(`downgraded:${m.tier}->${m.deliveredAs}`) : dim(m.deliveredAs);
      console.log(actionLine("ok", "buz", [bold(record.name), m.id, downgradeNote]));
    } else {
      console.log(`buz.send\t${record.name}\t${m.id}\t${m.tier}\t${m.deliveredAs}\t${result.downgraded ? "downgraded" : "ok"}`);
    }
  }
}


export async function buzList(parsed: Parsed, mailbox: "inbox" | "outbox" | "queue") {
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
    if (listing.length === 0) {
      if (isPretty()) console.log(dim(`# ${record.name}: no ${mailbox} messages`));
      continue;
    }
    if (!isPretty()) {
      for (const { message, path } of listing) {
        console.log([
          `buz.${mailbox}`,
          record.name,
          message.id,
          senderDisplay(message.from),
          message.to,
          message.tier,
          message.deliveredAs,
          message.sentAt,
          path,
        ].join("\t"));
      }
      continue;
    }
    if (records.length > 1) console.log(bold(record.name));
    console.log(formatTable(
      [
        { header: "ID" },
        { header: "FROM" },
        { header: "TIER" },
        { header: "DELIVERED" },
        { header: "AGE", align: "right" },
        { header: "SUBJECT" },
      ],
      listing.map(({ message }) => [
        message.id,
        senderDisplay(message.from),
        message.tier,
        message.deliveredAs,
        dim(formatRelativeTime(message.sentAt)),
        dim(message.subject ?? ""),
      ]),
    ));
  }
}


export async function buzRead(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive buz read <message-id> [--consume] [--bee <ref>]");
  const consume = truthy(flag(parsed, "consume"));
  const beeRef = typeof flag(parsed, "bee") === "string" ? String(flag(parsed, "bee")) : undefined;
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
  if (!ref) throw new Error("Usage: hive buz config <bee> [--accept interrupt,queue,passive]");
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
