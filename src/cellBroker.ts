import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BUZ_TIER, type BuzSendResult } from "./buz.js";
import { stringFlag } from "./cli/shared.js";
import { printBuzListing, printBuzSendResult, type BuzListEntry } from "./commands/buz.js";
import { printSealResult } from "./commands/messaging.js";
import { printStateExplanation, printStateList } from "./commands/state.js";
import { daemonRoot } from "./daemon/log.js";
import { connectRpcClient, type RpcClient } from "./hsr/rpc.js";
import { flag, numberFlag, truthy, type Parsed } from "./parse.js";
import { validateSealArtifact, type SealRecord } from "./seal.js";
import type { BeeViewListV1, BeeViewV1 } from "./view/types.js";

export const CELL_BROKER_DENIAL_PREFIX = "this hive verb is brokered inside a Cell; denied:";

type BrokerReply = { ok: boolean; error?: string } & Record<string, unknown>;

class CellBrokerDeniedError extends Error {
  constructor(reason: string) {
    super(`${CELL_BROKER_DENIAL_PREFIX} ${reason}`);
    this.name = "CellBrokerDeniedError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deny(reason: string): never {
  throw new CellBrokerDeniedError(reason);
}

function callingBee(): string {
  // HSR runner-entry stamps the pane-less identity anchor as HIVE_BEE;
  // HIVE_BEE_NAME remains the explicit override (and the pre-stamp contract).
  const bee = (process.env.HIVE_BEE_NAME ?? process.env.HIVE_BEE)?.trim();
  if (!bee) deny("HIVE_BEE_NAME (or the Cell-stamped HIVE_BEE) is required so the daemon can identify the calling bee");
  return bee;
}

function controlSocketPath(): string {
  return join(daemonRoot(), "hsr-control.sock");
}

function asBrokerReply(value: unknown): BrokerReply {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { ok?: unknown }).ok !== "boolean") {
    deny("daemon returned a malformed broker reply");
  }
  return value as BrokerReply;
}

async function callCellBroker(op: string, params: Record<string, unknown>): Promise<BrokerReply> {
  const callerBee = callingBee();
  let client: RpcClient | undefined;
  try {
    client = await connectRpcClient(controlSocketPath());
    const capabilities = await client.call("capabilities");
    if (!capabilities || typeof capabilities !== "object" || (capabilities as { broker?: unknown }).broker !== 1) {
      deny("the running daemon does not advertise broker:1; deploy a broker-capable daemon");
    }
    const reply = asBrokerReply(await client.call(op, { ...params, callerBee }));
    if (!reply.ok) deny(reply.error || `${op} was refused without a reason`);
    return reply;
  } catch (error) {
    if (error instanceof CellBrokerDeniedError) throw error;
    return deny(`daemon broker unavailable: ${messageOf(error)}`);
  } finally {
    client?.close();
  }
}

function usageState(): never {
  throw new Error(`Usage:
  hive state ls [self] [--state <display>] [--colony <c>] [--node <n>] [--done] [--json]
  hive state explain <self> [--json]`);
}

async function brokerBuzSend(parsed: Parsed): Promise<void> {
  const target = parsed.args[1];
  if (!target) {
    throw new Error(`Usage: hive buz send <selector> [--sender <bee>] [--tier <interrupt|next-tool|queue|passive>] -p <body> (default tier: ${DEFAULT_BUZ_TIER})`);
  }
  if (flag(parsed, "sender-human") !== undefined) {
    deny("a Cell bee cannot claim a human sender; buz-send must act as HIVE_BEE_NAME");
  }
  const senderFlag = flag(parsed, "sender");
  if (senderFlag === true) deny("--sender requires a bee name");
  const tier = flag(parsed, "tier") ?? DEFAULT_BUZ_TIER;
  const body = stringFlag(parsed, ["prompt", "p"]) ?? "";
  if (body.length === 0) throw new Error("buz: --prompt|-p body is required");
  const subject = typeof flag(parsed, "subject") === "string" ? String(flag(parsed, "subject")) : undefined;
  const reply = await callCellBroker("broker:buz-send", {
    target,
    tier,
    body,
    ...(typeof senderFlag === "string" ? { senderBee: senderFlag } : {}),
    ...(subject ? { subject } : {}),
  });
  const results = reply.results;
  if (!Array.isArray(results)) deny("daemon returned malformed buz-send results");
  for (const row of results as Array<{ recordName?: unknown; result?: unknown }>) {
    if (typeof row.recordName !== "string" || !row.result || typeof row.result !== "object") {
      deny("daemon returned a malformed buz-send result");
    }
    printBuzSendResult(row.recordName, row.result as BuzSendResult);
  }
}

async function brokerBuzInbox(parsed: Parsed): Promise<void> {
  const target = parsed.args[1];
  if (!target) throw new Error("Usage: hive buz inbox <self> [--limit N] [--from <ref>]");
  const limit = numberFlag(parsed, ["limit"], 0) || undefined;
  const fromFilter = typeof flag(parsed, "from") === "string" ? String(flag(parsed, "from")) : undefined;
  const reply = await callCellBroker("broker:buz-inbox", {
    target,
    ...(limit !== undefined ? { limit } : {}),
    ...(fromFilter ? { fromFilter } : {}),
  });
  if (typeof reply.recordName !== "string" || !Array.isArray(reply.listing) || typeof reply.quarantined !== "number") {
    deny("daemon returned malformed buz-inbox results");
  }
  printBuzListing({
    recordName: reply.recordName,
    mailbox: "inbox",
    listing: reply.listing as BuzListEntry[],
    quarantined: reply.quarantined,
  });
}

async function brokerState(parsed: Parsed): Promise<void> {
  const mode = parsed.args[0];
  if (mode !== "ls" && mode !== "list" && mode !== "explain") usageState();
  const target = parsed.args[1];
  if (mode === "explain" && !target) usageState();
  const reply = await callCellBroker("broker:state", {
    mode,
    ...(target ? { target } : {}),
  });
  if (mode === "explain") {
    if (!reply.view || typeof reply.view !== "object") deny("daemon returned a malformed state explanation");
    printStateExplanation(reply.view as BeeViewV1, parsed);
    return;
  }
  if (!reply.list || typeof reply.list !== "object") deny("daemon returned a malformed state list");
  const list = reply.list as BeeViewListV1;
  if (!Array.isArray(list.bees)) deny("daemon returned a malformed state list");
  printStateList(list, parsed, new Set(list.bees.map((view) => view.bee.name)));
}

async function brokerSeal(parsed: Parsed): Promise<void> {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive seal <self> --from <path-to-seal.json>");
  const fromPath = typeof flag(parsed, "from") === "string" ? String(flag(parsed, "from")) : undefined;
  if (!fromPath) throw new Error("hive seal requires --from <path-to-seal.json>");
  const raw = await readFile(fromPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid seal JSON in ${fromPath}: ${messageOf(error)}`);
  }
  const artifact = validateSealArtifact(parsedJson);
  const reply = await callCellBroker("broker:seal", { target, artifact });
  if (typeof reply.recordName !== "string" || !reply.stored || typeof reply.stored !== "object") {
    deny("daemon returned a malformed seal result");
  }
  printSealResult(reply.recordName, reply.stored as SealRecord);
}

/**
 * Route the v1 brokered verb set before normal CLI dispatch. Outside a Cell
 * this is an immediate no-op, preserving the existing direct FS/tmux paths.
 */
export async function dispatchCellBrokerVerb(parsed: Parsed): Promise<boolean> {
  if (process.env.HIVE_CELL !== "1") return false;
  if (parsed.command === "buz" && parsed.args[0] === "send") {
    await brokerBuzSend(parsed);
    return true;
  }
  if (parsed.command === "buz" && parsed.args[0] === "inbox") {
    await brokerBuzInbox(parsed);
    return true;
  }
  if (parsed.command === "state") {
    await brokerState(parsed);
    return true;
  }
  if (parsed.command === "seal") {
    // Static help/example modes do not touch Hive state and need no daemon.
    if (truthy(flag(parsed, "help")) || truthy(flag(parsed, "h")) || truthy(flag(parsed, "example"))) return false;
    await brokerSeal(parsed);
    return true;
  }
  return false;
}
