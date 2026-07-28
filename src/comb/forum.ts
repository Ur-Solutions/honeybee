import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalDigest } from "./canonical.js";
import { CombError } from "./errors.js";
import type {
  ForumPacket,
  HumanNode,
  JsonValue,
  ResolvedSubject,
  ReviewFeedbackDestination,
  RunRecord,
} from "./types.js";

const execFileAsync = promisify(execFile);

export type ForumPacketEffectRequest = {
  operation: "create" | "rerequest" | "successor" | "withdraw";
  idempotencyKey: string;
  runId: string;
  nodeId: string;
  itemIndex: number;
  snapshotRevision: number;
  definitionDigest: string;
  actionBindingDigest: string;
  subject: ResolvedSubject;
  combName: string;
  cwd: string;
  definition: RunRecord["currentSnapshot"]["definition"];
  human: HumanNode["human"];
  destination: ReviewFeedbackDestination;
  predecessorPacketId?: string;
};

type ForumEnvelope = {
  ok: boolean;
  command?: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

export type ForumPacketQuarantine = {
  index: number;
  packetId?: string;
  runId?: string;
  error: string;
};

export type ForumPacketListResult = {
  packets: ForumPacket[];
  quarantined: ForumPacketQuarantine[];
};

export async function listForumPackets(): Promise<ForumPacketListResult> {
  const envelope = await callForum(
    ["packet", "list", "--json"],
    {
      timeoutMs: forumPollTimeoutMs(),
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const result = unwrapResult(envelope);
  const packets = result.packets;
  if (!Array.isArray(packets)) throw invalidEnvelope("packet.list", "result.packets is not an array");
  const valid: ForumPacket[] = [];
  const quarantined: ForumPacketQuarantine[] = [];
  for (const [index, packet] of packets.entries()) {
    try {
      valid.push(parseForumPacket(packet, `packet.list[${index}]`));
    } catch (error) {
      const partial = isRecord(packet) ? packet : {};
      quarantined.push({
        index,
        ...(typeof partial.id === "string" ? { packetId: partial.id } : {}),
        ...(typeof partial.run_id === "string" ? { runId: partial.run_id } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { packets: valid, quarantined };
}

export async function executeForumPacketEffect(request: ForumPacketEffectRequest): Promise<ForumPacket> {
  if (request.operation === "create") return createPacket(request);
  if (request.operation === "rerequest") return rerequestPacket(request);
  if (request.operation === "withdraw") return withdrawPacket(request);
  return createSuccessor(request);
}

export function forumPacketDigest(packet: ForumPacket): string {
  return canonicalDigest(packet as unknown as JsonValue);
}

async function createPacket(request: ForumPacketEffectRequest): Promise<ForumPacket> {
  const envelope = await callForum([
    "packet",
    "create",
    ...packetCreateArgs(request),
    "--idempotency-key",
    request.idempotencyKey,
  ]);
  let packet = packetFromEnvelope(envelope, "packet.create");
  packet = await reconcileDestinationAndFields(packet, request, `${request.idempotencyKey}:fields`);
  return packet;
}

async function rerequestPacket(request: ForumPacketEffectRequest): Promise<ForumPacket> {
  if (!request.predecessorPacketId) {
    throw new CombError("corrupt_state", "forum rerequest effect is missing its packet ID");
  }
  let packet = await reconcileDestinationAndFields(
    { id: request.predecessorPacketId } as ForumPacket,
    request,
    `${request.idempotencyKey}:fields`,
  );
  if (packet.status === "changes_requested") {
    packet = packetFromEnvelope(
      await callForum(["packet", "status", packet.id, "needs_review", "--actor", "hive-comb", "--json"]),
      "packet.status",
    );
  }
  if (packet.status !== "needs_review" && packet.status !== "in_review") {
    throw new CombError(
      "external_dependency",
      `forum packet ${packet.id} cannot be rerequested from status ${packet.status}`,
    );
  }
  return packetFromEnvelope(
    await callForum([
      "packet",
      "rerequest",
      packet.id,
      "--idempotency-key",
      request.idempotencyKey,
      "--actor",
      "hive-comb",
      "--json",
    ]),
    "packet.rerequest",
  );
}

async function createSuccessor(request: ForumPacketEffectRequest): Promise<ForumPacket> {
  if (!request.predecessorPacketId) {
    throw new CombError("corrupt_state", "forum successor effect is missing its predecessor packet ID");
  }
  const packet = packetFromEnvelope(
    await callForum([
      "packet",
      "successor",
      request.predecessorPacketId,
      "--title",
      request.human.title,
      "--summary",
      packetSummary(request),
      "--idempotency-key",
      request.idempotencyKey,
      "--actor",
      "hive-comb",
    ]),
    "packet.successor",
  );
  return reconcileDestinationAndFields(packet, request, `${request.idempotencyKey}:fields`);
}

async function withdrawPacket(request: ForumPacketEffectRequest): Promise<ForumPacket> {
  if (!request.predecessorPacketId) {
    throw new CombError("corrupt_state", "forum withdrawal effect is missing its packet ID");
  }
  const current = packetFromEnvelope(
    await callForum(["packet", "show", request.predecessorPacketId, "--json"]),
    "packet.show",
  );
  if (current.status === "superseded" || current.status === "archived") return current;
  return packetFromEnvelope(
    await callForum([
      "packet",
      "status",
      current.id,
      "superseded",
      "--message",
      `comb terminal withdrawal ${request.idempotencyKey}`,
      "--actor",
      "hive-comb",
      "--json",
    ]),
    "packet.status",
  );
}

async function reconcileDestinationAndFields(
  packet: ForumPacket,
  request: ForumPacketEffectRequest,
  idempotencyKey: string,
): Promise<ForumPacket> {
  const args = [
    "packet",
    "update",
    packet.id,
    "--kind",
    request.human.packetKind,
    "--origin",
    "comb",
    "--summary",
    packetSummary(request),
    "--checklist",
    JSON.stringify(request.human.checklist ?? []),
    "--routability",
    destinationRoutability(request.destination),
    ...(
      request.destination.type === "bee"
        ? ["--native-session-id", request.destination.sessionId]
        : []
    ),
    "--idempotency-key",
    idempotencyKey,
    "--actor",
    "hive-comb",
  ];
  return packetFromEnvelope(await callForum(args), "packet.update");
}

function packetCreateArgs(request: ForumPacketEffectRequest): string[] {
  const sourceId = `${request.runId}:${request.nodeId}:${request.itemIndex}`;
  return [
    "--title",
    request.human.title,
    "--source-kind",
    "comb",
    "--source-id",
    sourceId,
    "--source-dedupe-key",
    `comb:${request.runId}:${request.nodeId}:${request.itemIndex}:${request.subject.revision}:${request.definitionDigest}`,
    "--cwd",
    request.cwd,
    "--kind",
    request.human.packetKind,
    "--origin",
    "comb",
    "--summary",
    packetSummary(request),
    "--checklist",
    JSON.stringify(request.human.checklist ?? []),
    ...(request.destination.type === "bee" ? ["--native-session-id", request.destination.sessionId] : []),
    "--actor",
    "hive-comb",
  ];
}

function packetSummary(request: ForumPacketEffectRequest): string {
  const authored = request.human.summary?.trim();
  const metadata = [
    `Comb ${request.combName}`,
    `run ${request.runId}`,
    `node ${request.nodeId}[${request.itemIndex}]`,
    `subject ${request.subject.kind}:${request.subject.key}@${request.subject.revision}`,
  ].join("; ");
  return authored ? `${authored}\n\n${metadata}` : metadata;
}

function destinationRoutability(destination: ReviewFeedbackDestination): string {
  if (destination.type === "bee") return "route_back";
  if (destination.type === "pr-comment") return "continue_elsewhere";
  return "human_only";
}

async function callForum(
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<ForumEnvelope> {
  const executable = process.env.HIVE_FORUM_BIN ?? "forum";
  try {
    const { stdout } = await execFileAsync(executable, args, {
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      env: process.env,
    });
    return parseEnvelope(stdout, args.join(" "));
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    if (failure.stdout) {
      const envelope = parseEnvelope(failure.stdout, args.join(" "));
      throw new CombError(
        "external_dependency",
        `forum ${envelope.error?.code ?? "error"}: ${envelope.error?.message ?? "command failed"}`,
      );
    }
    throw new CombError(
      "external_dependency",
      `forum command failed: ${failure.stderr?.trim() || failure.message}`,
    );
  }
}

function forumPollTimeoutMs(): number {
  const authored = Number(process.env.HIVE_FORUM_POLL_TIMEOUT_MS);
  if (!Number.isFinite(authored)) return 3_000;
  return Math.max(50, Math.min(10_000, Math.trunc(authored)));
}

function parseEnvelope(stdout: string, command: string): ForumEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw invalidEnvelope(command, "stdout is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidEnvelope(command, "stdout is not an object");
  }
  const envelope = value as ForumEnvelope;
  if (envelope.ok !== true) {
    throw new CombError(
      "external_dependency",
      `forum ${envelope.error?.code ?? "error"}: ${envelope.error?.message ?? "command failed"}`,
    );
  }
  return envelope;
}

function unwrapResult(envelope: ForumEnvelope): Record<string, unknown> {
  const outer = envelope.result;
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) {
    throw invalidEnvelope(envelope.command ?? "forum", "result is missing");
  }
  const nested = outer.result;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : outer;
}

function packetFromEnvelope(envelope: ForumEnvelope, command: string): ForumPacket {
  const packet = unwrapResult(envelope).packet;
  return parseForumPacketReference(packet, command);
}

function parseForumPacketReference(value: unknown, label: string): ForumPacket {
  if (!isRecord(value)) throw invalidEnvelope(label, "packet is missing");
  requireNonEmptyString(value.id, label, "id");
  if (
    typeof value.status !== "string" ||
    ![
      "needs_review",
      "in_review",
      "changes_requested",
      "approved",
      "resolved",
      "superseded",
      "archived",
    ].includes(value.status)
  ) {
    throw invalidEnvelope(label, "packet status is invalid");
  }
  return value as unknown as ForumPacket;
}

function parseForumPacket(value: unknown, label: string): ForumPacket {
  if (!isRecord(value)) {
    throw invalidEnvelope(label, "packet is missing");
  }
  const packet = value;
  requireNonEmptyString(packet.id, label, "id");
  requireNonEmptyString(packet.title, label, "title");
  if (
    typeof packet.status !== "string" ||
    ![
      "needs_review",
      "in_review",
      "changes_requested",
      "approved",
      "resolved",
      "superseded",
      "archived",
    ].includes(packet.status)
  ) {
    throw invalidEnvelope(label, "packet status is invalid");
  }
  requireNonEmptyString(packet.kind, label, "kind");
  requireNonEmptyString(packet.origin, label, "origin");
  requireNullableString(packet.cwd, label, "cwd");
  requireNullableString(packet.summary, label, "summary");
  if (packet.checklist !== null && !Array.isArray(packet.checklist)) {
    throw invalidEnvelope(label, "packet checklist is not an array");
  }
  requireNullableString(packet.native_session_id, label, "native_session_id");
  requireNullableString(packet.blocking_since, label, "blocking_since");
  requireNullableString(packet.run_id, label, "run_id");
  requireNullableString(packet.comb_name, label, "comb_name");
  requireNullableNumber(packet.base_rev, label, "base_rev");
  requireNullableNumber(packet.proposed_rev, label, "proposed_rev");
  requireNullableString(packet.graph_base, label, "graph_base");
  requireNullableString(packet.graph_proposed, label, "graph_proposed");
  requireNullableString(packet.definition_digest, label, "definition_digest");
  requireNullableString(packet.action_binding_digest, label, "action_binding_digest");
  requireNullableString(packet.subject_revision, label, "subject_revision");
  if (packet.verdict !== null) parseForumVerdict(packet.verdict, label);
  return {
    ...packet,
    checklist: packet.checklist ?? [],
  } as unknown as ForumPacket;
}

function parseForumVerdict(value: unknown, label: string): void {
  if (!isRecord(value)) throw invalidEnvelope(label, "packet verdict is invalid");
  requireNonEmptyString(value.packet_id, label, "verdict.packet_id");
  if (value.verdict !== "approve" && value.verdict !== "request_changes") {
    throw invalidEnvelope(label, "packet verdict choice is invalid");
  }
  requireNullableString(value.comment, label, "verdict.comment");
  if (!isRecord(value.destination)) {
    throw invalidEnvelope(label, "packet verdict destination is invalid");
  }
  if (value.destination.type === "bee") {
    requireNonEmptyString(value.destination.sessionId, label, "verdict.destination.sessionId");
  } else if (
    value.destination.type !== "new-agent" &&
    value.destination.type !== "pr-comment"
  ) {
    throw invalidEnvelope(label, "packet verdict destination type is invalid");
  }
  requireNonEmptyString(value.actor, label, "verdict.actor");
  requireNullableString(value.definition_digest, label, "verdict.definition_digest");
  requireNullableString(value.action_binding_digest, label, "verdict.action_binding_digest");
  requireNullableString(value.subject_revision, label, "verdict.subject_revision");
  requireNonEmptyString(value.recorded_at, label, "verdict.recorded_at");
}

function requireNonEmptyString(
  value: unknown,
  label: string,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidEnvelope(label, `packet ${field} is invalid`);
  }
}

function requireNullableString(value: unknown, label: string, field: string): void {
  if (value !== null && typeof value !== "string") {
    throw invalidEnvelope(label, `packet ${field} is invalid`);
  }
}

function requireNullableNumber(value: unknown, label: string, field: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw invalidEnvelope(label, `packet ${field} is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidEnvelope(command: string, detail: string): CombError {
  return new CombError("external_dependency", `forum ${command} returned an invalid JSON envelope: ${detail}`);
}
