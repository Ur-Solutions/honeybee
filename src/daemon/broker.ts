import {
  DEFAULT_BUZ_TIER,
  countQuarantinedMessages,
  isBuzTier,
  listMessages,
  sendBuzMessage,
  type BuzSendResult,
  type BuzTier,
} from "../buz.js";
import { resolveSession } from "../cli/shared.js";
import { writeHiveState } from "../hiveState.js";
import { inspectHsrHostProcess } from "../hsr/observe.js";
import type { RpcMethodHandler } from "../hsr/rpc.js";
import { readHsrMeta } from "../hsr/runDir.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { recordSeal, validateSealArtifact } from "../seal.js";
import { resolveSelector } from "../selectors.js";
import { substrateFor } from "../substrates/index.js";
import { getBeeView, listBeeViews } from "../view/index.js";
import {
  BROKER_OPS,
  decideBrokerPolicy,
  loadBrokerAcl,
  type BrokerAcl,
  type BrokerOp,
} from "./brokerPolicy.js";

export type BrokerHandlerOptions = {
  loadAcl?: () => Promise<BrokerAcl>;
  verifyCaller?: (callerBee: string) => Promise<void>;
};

type FlatBrokerReply = { ok: boolean; error?: string } & Record<string, unknown>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function paramsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} required`);
  return value;
}

/**
 * Verify the pragmatic v1 caller identity tier against the claimed bee's HSR
 * runner. Node's net.Socket exposes no peer-credential API, and macOS
 * LOCAL_PEERPID requires getsockopt on the accepted fd through native code.
 * Until the RPC transport has that native seam, this proves that the claimed
 * canonical bee has a currently running, birth-verified host. It does not yet
 * attribute this exact socket connection to the host's child process; full
 * socket-peer attribution is deliberately deferred.
 *
 * HIVE_BROKER_VERIFY=0 is a daemon-side emergency compatibility opt-out. Any
 * other value (including malformed values) keeps verification enabled.
 */
export async function verifyBrokerCallerClaim(callerBee: string): Promise<void> {
  if (process.env.HIVE_BROKER_VERIFY === "0") return;
  const meta = await readHsrMeta(callerBee);
  const live = !!meta &&
    meta.bee === callerBee &&
    meta.status === "running" &&
    !meta.mirrorOfNode &&
    await inspectHsrHostProcess(meta) === "match";
  if (!live) {
    throw new Error(
      `claimed bee ${callerBee} has no live birth-verified HSR runner (daemon emergency opt-out: HIVE_BROKER_VERIFY=0)`,
    );
  }
}

async function authorizeSubject(
  op: BrokerOp,
  callerRef: string,
  subjectRef: string,
  options: BrokerHandlerOptions,
) {
  const caller = await resolveSession(callerRef);
  const subject = callerRef === subjectRef ? caller : await resolveSession(subjectRef);
  const acl = await (options.loadAcl ?? loadBrokerAcl)();
  const decision = decideBrokerPolicy({
    op,
    callerBee: caller.name,
    subjectBee: subject.name,
  }, acl);
  if (!decision.allowed) throw new Error(decision.reason);
  return { caller, subject };
}

async function handleBuzSend(params: Record<string, unknown>, options: BrokerHandlerOptions): Promise<FlatBrokerReply> {
  const callerBee = requiredString(params, "callerBee");
  const senderBee = typeof params.senderBee === "string" && params.senderBee.length > 0
    ? params.senderBee
    : callerBee;
  const { subject: sender } = await authorizeSubject("broker:buz-send", callerBee, senderBee, options);
  const target = requiredString(params, "target");
  const body = requiredString(params, "body");
  const tierValue = params.tier ?? DEFAULT_BUZ_TIER;
  if (typeof tierValue !== "string" || !isBuzTier(tierValue)) {
    throw new Error(`buz: unknown tier "${String(tierValue)}"`);
  }
  const tier: BuzTier = tierValue;
  const subject = typeof params.subject === "string" ? params.subject : undefined;

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  const results: Array<{ recordName: string; result: BuzSendResult }> = [];
  for (const record of records) {
    const transport = tier === "interrupt" || tier === "next-tool"
      ? { substrate: substrateFor(record), tmuxTarget: record.tmuxTarget, agentPaneId: record.agentPaneId }
      : undefined;
    const result = await sendBuzMessage({
      recipient: record,
      sender: { kind: "bee", id: sender.id ?? sender.name },
      tier,
      body,
      ...(subject ? { subject } : {}),
      ...(transport ? { transport } : {}),
      ...(record.node ? { node: record.node } : {}),
    });
    results.push({ recordName: record.name, result });
  }
  return { ok: true, results };
}

async function handleBuzInbox(params: Record<string, unknown>, options: BrokerHandlerOptions): Promise<FlatBrokerReply> {
  const callerBee = requiredString(params, "callerBee");
  const target = typeof params.target === "string" && params.target.length > 0 ? params.target : callerBee;
  const { subject } = await authorizeSubject("broker:buz-inbox", callerBee, target, options);
  const limit = params.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error("buz inbox limit must be a non-negative integer");
  }
  const fromFilter = typeof params.fromFilter === "string" ? params.fromFilter : undefined;
  const listing = await listMessages(subject.name, "inbox", {
    ...(typeof limit === "number" ? { limit } : {}),
    ...(fromFilter ? { fromFilter } : {}),
  });
  const quarantined = await countQuarantinedMessages(subject.name);
  return { ok: true, recordName: subject.name, listing, quarantined };
}

async function handleState(params: Record<string, unknown>, options: BrokerHandlerOptions): Promise<FlatBrokerReply> {
  const callerBee = requiredString(params, "callerBee");
  const target = typeof params.target === "string" && params.target.length > 0 ? params.target : callerBee;
  const { subject } = await authorizeSubject("broker:state", callerBee, target, options);
  const mode = params.mode;
  if (mode === "explain") {
    return { ok: true, mode, view: await getBeeView(subject.name) };
  }
  if (mode === "ls" || mode === "list") {
    const list = await listBeeViews();
    const subjectNode = subject.node && subject.node.length > 0 ? subject.node : LOCAL_NODE_NAME;
    return {
      ok: true,
      mode: "ls",
      list: {
        ...list,
        unreachableNodes: list.unreachableNodes.filter((node) => node === subjectNode),
        bees: list.bees.filter((view) => view.bee.name === subject.name),
      },
    };
  }
  throw new Error("Usage: hive state ls [self] | hive state explain [self]");
}

async function handleSeal(params: Record<string, unknown>, options: BrokerHandlerOptions): Promise<FlatBrokerReply> {
  const callerBee = requiredString(params, "callerBee");
  const target = typeof params.target === "string" && params.target.length > 0 ? params.target : callerBee;
  const { subject } = await authorizeSubject("broker:seal", callerBee, target, options);
  const artifact = validateSealArtifact(params.artifact);
  const stored = await recordSeal(subject.name, artifact);
  await writeHiveState(subject, "done");
  return { ok: true, recordName: subject.name, stored };
}

/**
 * Dispatch one broker operation and always return the daemon's flat reply
 * convention. Exported so policy/handler behavior can be tested without a
 * socket; createBrokerMethods exposes the same handlers over JSON-RPC.
 */
export async function handleBrokerOperation(
  op: string,
  params: unknown,
  options: BrokerHandlerOptions = {},
): Promise<FlatBrokerReply> {
  if (!(BROKER_OPS as readonly string[]).includes(op)) {
    return { ok: false, error: `unknown broker operation: ${op}` };
  }
  try {
    const value = paramsObject(params);
    // Resolve first so an id/alias claim is verified against the canonical HSR
    // run-dir name, and arbitrary caller text never becomes a filesystem path.
    const caller = await resolveSession(requiredString(value, "callerBee"));
    await (options.verifyCaller ?? verifyBrokerCallerClaim)(caller.name);
    switch (op as BrokerOp) {
      case "broker:buz-send":
        return await handleBuzSend(value, options);
      case "broker:buz-inbox":
        return await handleBuzInbox(value, options);
      case "broker:state":
        return await handleState(value, options);
      case "broker:seal":
        return await handleSeal(value, options);
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

export function createBrokerMethods(options: BrokerHandlerOptions = {}): Record<BrokerOp, RpcMethodHandler> {
  const handler = (op: BrokerOp): RpcMethodHandler =>
    (params: unknown) => handleBrokerOperation(op, params, options);
  return {
    "broker:buz-send": handler("broker:buz-send"),
    "broker:buz-inbox": handler("broker:buz-inbox"),
    "broker:state": handler("broker:state"),
    "broker:seal": handler("broker:seal"),
  };
}
