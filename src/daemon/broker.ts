import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_BUZ_TIER,
  countQuarantinedMessages,
  isBuzTier,
  listMessages,
  sendBuzMessageInAdmission,
  type BuzSendResult,
  type BuzTier,
} from "../buz.js";
import { matchesCellBrokerCapability } from "../cellBrokerCapability.js";
import { resolveSession } from "../cli/shared.js";
import { withRunnableSessionAdmission } from "../delivery.js";
import { storeRoot } from "../fsx.js";
import { writeHiveState } from "../hiveState.js";
import { inspectHsrHostProcess } from "../hsr/observe.js";
import type { RpcMethodHandler } from "../hsr/rpc.js";
import { readHsrMeta } from "../hsr/runDir.js";
import { LOCAL_NODE_NAME } from "../node.js";
import type { Parsed } from "../parse.js";
import { withFileLock } from "../lock.js";
import { recordSeal, validateSealArtifact } from "../seal.js";
import { resolveSelector } from "../selectors.js";
import { safeName, type SessionRecord } from "../store.js";
import { withSessionLifecycleTransaction, type SessionLifecycleTransaction } from "../lifecycle.js";
import { substrateFor } from "../substrates/index.js";
import { getBeeView, listBeeViews } from "../view/index.js";
import {
  BROKER_OPS,
  brokerAclPath,
  decideBrokerPolicy,
  decideBrokerSpawnPolicy,
  loadBrokerAcl,
  type BrokerAcl,
  type BrokerOp,
} from "./brokerPolicy.js";

export type BrokerHandlerOptions = {
  loadAcl?: () => Promise<BrokerAcl>;
  verifyCaller?: (caller: SessionRecord, capability: unknown) => Promise<void>;
  spawnFilesystem?: BrokerSpawnLauncher;
};

export type BrokerSpawnArgs = {
  harness: string;
  name?: string;
  cwd: string;
  model?: string;
  reasoning?: string;
  account?: string;
  prompt?: string;
};

export type BrokerSpawnLauncher = (
  args: BrokerSpawnArgs,
  context: { spawnedById: string },
) => Promise<Pick<SessionRecord, "name" | "id">>;

type FlatBrokerReply = { ok: boolean; error?: string } & Record<string, unknown>;

type BrokerMutationAdmission = {
  lifecycle: SessionLifecycleTransaction;
  caller: SessionRecord;
};

function brokerMutationLockPath(): string {
  return join(storeRoot(), "broker-mutation.lock");
}

/**
 * Broker mutations may hold the caller lifecycle lock while acquiring a
 * recipient/name lifecycle lock. One durable outer lock gives every broker
 * request the same order, preventing A -> B / B -> A cycles while a kill waits
 * on the caller lock. Read-only inbox/state calls deliberately bypass it.
 */
function withBrokerMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(brokerMutationLockPath(), fn, { timeoutMs: 120_000, staleMs: 180_000 });
}

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

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string when present`);
  return value;
}

function brokerSpawnArgs(value: unknown): BrokerSpawnArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("spawnArgs object required");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["harness", "name", "cwd", "model", "reasoning", "account", "prompt"]);
  const unknown = Object.keys(raw).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`spawnArgs.${unknown} is not supported`);
  const harness = requiredString(raw, "harness");
  const cwd = requiredString(raw, "cwd");
  if (!isAbsolute(cwd)) throw new Error("spawnArgs.cwd must be absolute");
  const name = optionalString(raw, "name");
  const model = optionalString(raw, "model");
  const reasoning = optionalString(raw, "reasoning");
  const account = optionalString(raw, "account");
  const prompt = optionalString(raw, "prompt");
  return {
    harness,
    cwd,
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(account ? { account } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function spawnDenial(reason: string): string {
  return `${reason}; grant file: ${brokerAclPath()}; child Cell agents can be spawned without a grant via the Apiary mcp agent_spawn tool`;
}

/** Translate the broker's normalized model/reasoning fields into real harness argv. */
function brokerSpawnHarnessArgs(args: BrokerSpawnArgs): string[] {
  const harness = args.harness.toLowerCase();
  const rest: string[] = [];
  if (args.model && args.model !== "default") {
    rest.push(harness === "codex" || harness === "kimi" ? "-m" : "--model", args.model);
  }
  if (!args.reasoning) return rest;
  if (harness === "codex") {
    rest.push("-c", `model_reasoning_effort="${args.reasoning.toLowerCase()}"`);
  } else if (harness === "claude" || harness === "grok" || harness === "opencode") {
    rest.push("--effort", args.reasoning.toLowerCase());
  } else {
    throw new Error(`spawnArgs.reasoning is not supported for harness ${args.harness}`);
  }
  return rest;
}

/** Exact Parsed request handed to the ordinary host-side spawn implementation. */
export function brokerFilesystemSpawnParsed(args: BrokerSpawnArgs): Parsed {
  // Use the exact spawnSingleBee machinery rather than executing the CLI in a
  // shell. Explicit tmux placement prevents the daemon's ambient environment
  // from ever turning this filesystem-agent grant into another Cell spawn.
  const flags = new Map<string, string | true | string[]>([
    ["cwd", args.cwd],
    ["substrate", "tmux"],
    ["yolo", true],
  ]);
  if (args.name) flags.set("name", args.name);
  if (args.account) flags.set("account", args.account);
  if (args.prompt) {
    // Positional prompts are not delivered to tmux spawns; the existing
    // briefed path waits for readiness and sends the prompt reliably.
    flags.set("brief", args.prompt);
    flags.set("briefed", true);
  }
  return {
    command: "spawn",
    args: [args.harness],
    flags,
    rest: brokerSpawnHarnessArgs(args),
  };
}

async function spawnFilesystemBee(
  args: BrokerSpawnArgs,
  context: { spawnedById: string },
): Promise<Pick<SessionRecord, "name" | "id">> {
  const { spawnSingleBee } = await import("../commands/spawn.js");
  return spawnSingleBee(brokerFilesystemSpawnParsed(args), context);
}

/**
 * Authenticate the caller as one exact canonical runtime generation. The
 * unguessable token attributes the request; the birth probe prevents a stale
 * but not-yet-rotated environment from acting after its host is gone.
 *
 * HIVE_BROKER_VERIFY=0 is only an emergency liveness-probe opt-out. Capability
 * verification remains mandatory so claimed names never become authority.
 */
async function verifyBrokerCallerAdmission(caller: SessionRecord, capability: unknown): Promise<void> {
  if (!matchesCellBrokerCapability(caller, capability)) {
    throw new Error(
      `broker capability for ${caller.name} is missing, stale, or invalid; revive this Cell with the current Honeybee runtime`,
    );
  }
  // The emergency flag may skip only the process-liveness probe. It must never
  // restore the old claimed-name authority model or bypass the capability.
  if (process.env.HIVE_BROKER_VERIFY === "0") return;
  const meta = await readHsrMeta(caller.name);
  const live = !!meta &&
    meta.bee === caller.name &&
    meta.status === "running" &&
    !meta.mirrorOfNode &&
    await inspectHsrHostProcess(meta) === "match";
  if (!live) {
    throw new Error(
      `claimed bee ${caller.name} has no live birth-verified HSR runner (daemon emergency liveness opt-out: HIVE_BROKER_VERIFY=0)`,
    );
  }
}

/** Test/operator seam for the exact default claimed-name + capability check. */
export async function verifyBrokerCallerClaim(callerBee: string, capability: unknown): Promise<void> {
  const caller = await resolveSession(callerBee);
  await verifyBrokerCallerAdmission(caller, capability);
}

async function authorizeSubject(
  op: BrokerOp,
  caller: SessionRecord,
  subjectRef: string,
  options: BrokerHandlerOptions,
) {
  const subject = caller.name === subjectRef || caller.id === subjectRef
    ? caller
    : await resolveSession(subjectRef);
  const acl = await (options.loadAcl ?? loadBrokerAcl)();
  const decision = decideBrokerPolicy({
    op,
    callerBee: caller.name,
    subjectBee: subject.name,
  }, acl);
  if (!decision.allowed) throw new Error(decision.reason);
  return { caller, subject };
}

async function handleBuzSend(
  params: Record<string, unknown>,
  options: BrokerHandlerOptions,
  admission: BrokerMutationAdmission,
): Promise<FlatBrokerReply> {
  const callerBee = admission.caller.name;
  const senderBee = typeof params.senderBee === "string" && params.senderBee.length > 0
    ? params.senderBee
    : callerBee;
  const { subject: sender } = await authorizeSubject("broker:buz-send", admission.caller, senderBee, options);
  const target = requiredString(params, "target");
  const body = requiredString(params, "body");
  const tierValue = params.tier ?? DEFAULT_BUZ_TIER;
  if (typeof tierValue !== "string" || !isBuzTier(tierValue)) {
    throw new Error(`buz: unknown tier "${String(tierValue)}"`);
  }
  const tier: BuzTier = tierValue;
  const subject = typeof params.subject === "string" ? params.subject : undefined;
  const messageId = typeof params.messageId === "string" ? params.messageId : undefined;
  const forceNewIntent = params.forceNewIntent === true;

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  const results: Array<{ recordName: string; result: BuzSendResult }> = [];
  for (const record of records) {
    const sendToAdmittedRecipient = async (
      current: SessionRecord,
      lifecycle: SessionLifecycleTransaction,
    ): Promise<BuzSendResult> => {
      const transport = tier === "interrupt" || tier === "next-tool"
        ? { substrate: substrateFor(current), tmuxTarget: current.tmuxTarget, agentPaneId: current.agentPaneId }
        : undefined;
      return sendBuzMessageInAdmission({
        recipient: current,
        sender: { kind: "bee", id: sender.id ?? sender.name },
        tier,
        body,
        ...(messageId ? { messageId } : {}),
        ...(forceNewIntent ? { forceNewIntent: true } : {}),
        ...(subject ? { subject } : {}),
        ...(transport ? { transport } : {}),
        ...(current.node ? { node: current.node } : {}),
      }, { lifecycle });
    };
    // The common self-send path already owns this lifecycle lock. Re-entering
    // the non-reentrant file lock would deadlock; refresh under the existing
    // transaction instead. Cross-target mutations acquire their recipient lock
    // beneath the single broker-mutation lock.
    const result = record.name === admission.caller.name
      ? await sendToAdmittedRecipient(await admission.lifecycle.refresh(), admission.lifecycle)
      : await withRunnableSessionAdmission(
          record,
          async (lifecycle, current) => sendToAdmittedRecipient(current, lifecycle),
          { operation: "broker buz send", ...(messageId ? { deliveryId: messageId } : {}) },
        );
    results.push({ recordName: record.name, result });
  }
  return { ok: true, results };
}

async function handleBuzInbox(params: Record<string, unknown>, options: BrokerHandlerOptions): Promise<FlatBrokerReply> {
  const callerBee = requiredString(params, "callerBee");
  const target = typeof params.target === "string" && params.target.length > 0 ? params.target : callerBee;
  const caller = await resolveSession(callerBee);
  const { subject } = await authorizeSubject("broker:buz-inbox", caller, target, options);
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
  const caller = await resolveSession(callerBee);
  const { subject } = await authorizeSubject("broker:state", caller, target, options);
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

async function handleSeal(
  params: Record<string, unknown>,
  options: BrokerHandlerOptions,
  admission: BrokerMutationAdmission,
): Promise<FlatBrokerReply> {
  const callerBee = admission.caller.name;
  const target = typeof params.target === "string" && params.target.length > 0 ? params.target : callerBee;
  const { subject } = await authorizeSubject("broker:seal", admission.caller, target, options);
  const artifact = validateSealArtifact(params.artifact);
  const sealAdmittedSubject = async (current: SessionRecord) => {
    const stored = await recordSeal(current.name, artifact);
    await writeHiveState(current, "done");
    return stored;
  };
  const stored = subject.name === admission.caller.name
    ? await sealAdmittedSubject(await admission.lifecycle.refresh())
    : await withRunnableSessionAdmission(subject, async (_lifecycle, current) => sealAdmittedSubject(current));
  return { ok: true, recordName: subject.name, stored };
}

async function handleSpawn(
  params: Record<string, unknown>,
  options: BrokerHandlerOptions,
  admission: BrokerMutationAdmission,
): Promise<FlatBrokerReply> {
  const requested = brokerSpawnArgs(params.spawnArgs);
  const caller = admission.caller;
  // The broker already holds the caller's non-reentrant lifecycle lock through
  // this launch. A same-name spawn would enter spawnSingleBee's name admission
  // and wait on that exact lock until timeout, wedging every broker mutation
  // behind the global outer lock. Reject the post-sanitization name before any
  // filesystem or launcher side effect.
  if (requested.name && safeName(requested.name) === caller.name) {
    throw new Error("broker:spawn cannot reuse the caller bee name");
  }
  const cwd = await realpath(requested.cwd);
  let acl: BrokerAcl;
  try {
    acl = await (options.loadAcl ?? loadBrokerAcl)();
    const configured = acl[caller.name]?.["broker:spawn"] ?? [];
    const prefixes = await Promise.all(configured.map((prefix) => realpath(prefix)));
    acl = {
      ...acl,
      [caller.name]: {
        ...acl[caller.name],
        "broker:spawn": prefixes,
      },
    };
  } catch (error) {
    throw new Error(spawnDenial(messageOf(error)));
  }
  const decision = decideBrokerSpawnPolicy({ callerBee: caller.name, cwd }, acl);
  if (!decision.allowed) throw new Error(spawnDenial(decision.reason));

  const launch = options.spawnFilesystem ?? spawnFilesystemBee;
  const record = await launch({ ...requested, cwd }, { spawnedById: caller.id ?? caller.name });
  return { ok: true, bee: record.id ?? record.name, name: record.name };
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
    const callerCapability = value.callerCapability;
    const verifyCaller = options.verifyCaller ?? verifyBrokerCallerAdmission;
    // Inbox/state are diagnostic reads and remain available to a live escaped
    // runner while its failed stop is being investigated. Every mutation is
    // serialized beneath one broker-wide outer lock, then holds the canonical
    // caller lifecycle admission through its last side effect. A failed/retired
    // caller therefore cannot create work after its explicit stop intent.
    if (op === "broker:buz-inbox" || op === "broker:state") {
      // State projection gathers exact HSR observations, which takes the same
      // non-reentrant per-Bee lifecycle lock used for caller authentication.
      // Authenticate the immutable caller generation first, release the lock
      // while performing the read-only projection, then re-enter and verify
      // that exact generation before returning any bytes. This preserves the
      // capability/lifecycle fence without deadlocking state ls/explain on its
      // own observation pass. Inbox does not re-enter lifecycle authority and
      // can retain the simpler single-lock read boundary.
      if (op === "broker:state") {
        await withSessionLifecycleTransaction(caller, async (lifecycle) => {
          await verifyCaller(await lifecycle.refresh(), callerCapability);
        });
        const reply = await handleState(value, options);
        return withSessionLifecycleTransaction(caller, async (lifecycle) => {
          await verifyCaller(await lifecycle.refresh(), callerCapability);
          return reply;
        });
      }
      return await withSessionLifecycleTransaction(caller, async (lifecycle) => {
        const admittedCaller = await lifecycle.refresh();
        await verifyCaller(admittedCaller, callerCapability);
        return handleBuzInbox(value, options);
      });
    }
    return await withBrokerMutationLock(() =>
      withRunnableSessionAdmission(caller, async (lifecycle, admittedCaller) => {
        await verifyCaller(admittedCaller, callerCapability);
        const admission = { lifecycle, caller: admittedCaller };
        switch (op as BrokerOp) {
          case "broker:buz-send":
            return handleBuzSend(value, options, admission);
          case "broker:seal":
            return handleSeal(value, options, admission);
          case "broker:spawn":
            return handleSpawn(value, options, admission);
          case "broker:buz-inbox":
          case "broker:state":
            throw new Error(`unreachable read-only broker operation: ${op}`);
        }
      }),
    );
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
    "broker:spawn": handler("broker:spawn"),
  };
}
