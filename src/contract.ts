// Completion contracts (CL.701 §4.1): make "done" demandable at spawn time.
// A bee spawned with `--contract completion=seal[,...]` gets a deterministic,
// TEMPLATED postscript appended to its brief telling it that its final chat
// message is not its deliverable — a typed seal is — and carrying the
// correlation keys (taskId, attempt) consumers match completion on. Nothing
// here is LLM-generated; the contract is the same bytes every time so its
// enforcement (flight controller, `hive wait --seal`) can be mechanical.
import { SEAL_TYPES, type SealType } from "./seal.js";

export const CONTRACT_COMPLETIONS = ["seal", "exit"] as const;
export type ContractCompletion = (typeof CONTRACT_COMPLETIONS)[number];

export type BeeContract = {
  /**
   * How this bee signals task completion. "seal" (the default and the point):
   * only a recorded seal counts; idle-without-seal is a stall, never done.
   * "exit" is the weaker fallback for harnesses that cannot seal: process
   * exit / terminal state is the completion boundary.
   */
  completion: ContractCompletion;
  /** Demanded seal type (validated against SEAL_TYPES). */
  sealType?: SealType;
  /** Correlation key the seal must carry verbatim (flight slot / shard id). */
  taskId?: string;
  /** Lease attempt the seal must carry (flight replacements; 1-based). */
  attempt?: number;
};

const COMPLETION_SET = new Set<string>(CONTRACT_COMPLETIONS);

// Lazy: this module sits inside the seal ⇄ store import cycle (store needs
// normalizeContract, seal needs store's appendLedger). Reading SEAL_TYPES at
// module-eval time hits the TDZ when an entrypoint loads seal.ts first — so
// the set is built on first use, after every module has evaluated.
let sealTypeSet: Set<string> | null = null;
function sealTypes(): Set<string> {
  return (sealTypeSet ??= new Set<string>(SEAL_TYPES));
}

/**
 * Parse the `--contract` flag value: comma-separated key=value pairs, e.g.
 * `completion=seal,sealType=implementation,taskId=FL.3k2/s3,attempt=2`.
 * A bare `--contract seal` / `--contract exit` is shorthand for completion=….
 */
export function parseContractFlag(raw: string): BeeContract {
  const trimmed = raw.trim();
  if (COMPLETION_SET.has(trimmed)) return { completion: trimmed as ContractCompletion };
  const fields = new Map<string, string>();
  for (const part of trimmed.split(",")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error(`--contract expects key=value pairs (got: ${part.trim()}); e.g. completion=seal,sealType=implementation,taskId=X`);
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (fields.has(key)) throw new Error(`--contract repeats key: ${key}`);
    fields.set(key, value);
  }
  const completion = fields.get("completion") ?? "seal";
  if (!COMPLETION_SET.has(completion)) {
    throw new Error(`--contract completion must be one of: ${CONTRACT_COMPLETIONS.join(", ")} (got: ${completion})`);
  }
  const contract: BeeContract = { completion: completion as ContractCompletion };
  const sealType = fields.get("sealType");
  if (sealType !== undefined) {
    if (!sealTypes().has(sealType)) throw new Error(`--contract sealType must be one of: ${SEAL_TYPES.join(", ")} (got: ${sealType})`);
    contract.sealType = sealType as SealType;
  }
  const taskId = fields.get("taskId");
  if (taskId !== undefined) {
    if (taskId.length === 0) throw new Error("--contract taskId must be non-empty");
    contract.taskId = taskId;
  }
  const attempt = fields.get("attempt");
  if (attempt !== undefined) {
    const parsed = Number(attempt);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--contract attempt must be a positive integer (got: ${attempt})`);
    contract.attempt = parsed;
  }
  const known = new Set(["completion", "sealType", "taskId", "attempt"]);
  for (const key of fields.keys()) {
    if (!known.has(key)) throw new Error(`--contract has unknown key: ${key} (known: ${[...known].join(", ")})`);
  }
  return contract;
}

/** Deserialize a persisted contract; returns undefined for anything invalid. */
export function normalizeContract(value: unknown): BeeContract | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.completion !== "string" || !COMPLETION_SET.has(object.completion)) return undefined;
  const contract: BeeContract = { completion: object.completion as ContractCompletion };
  if (typeof object.sealType === "string" && sealTypes().has(object.sealType)) contract.sealType = object.sealType as SealType;
  if (typeof object.taskId === "string" && object.taskId.length > 0) contract.taskId = object.taskId;
  if (typeof object.attempt === "number" && Number.isSafeInteger(object.attempt) && object.attempt >= 1) contract.attempt = object.attempt;
  return contract;
}

/**
 * The deterministic contract postscript injected into the brief. Only seal
 * contracts get one — an exit contract needs no cooperation from the bee.
 */
export function contractPostscript(contract: BeeContract): string | undefined {
  if (contract.completion !== "seal") return undefined;
  const example = {
    status: "done",
    summary: "<one paragraph: what you did and how you verified it>",
    ...(contract.sealType ? { type: contract.sealType } : {}),
    ...(contract.taskId ? { taskId: contract.taskId } : {}),
    ...(contract.attempt !== undefined ? { attempt: contract.attempt } : {}),
  };
  const matchKeys = [
    ...(contract.taskId ? [`taskId "${contract.taskId}"`] : []),
    ...(contract.attempt !== undefined ? [`attempt ${contract.attempt}`] : []),
  ];
  // The snippet is emitted UNINDENTED: a heredoc terminator must sit at
  // column 0 or bash never closes the document and the `hive seal` line is
  // swallowed into the artifact (review CR-3, verified by execution).
  return [
    "--- COMPLETION CONTRACT (hive) ---",
    "Your final chat message is NOT your deliverable. When you finish this task",
    "(or are blocked/failed), record a typed seal for yourself:",
    "",
    'bee="$(hive here --id)"',
    'artifact="$(mktemp "${TMPDIR:-/tmp}/hive-seal.XXXXXX")"',
    "cat > \"$artifact\" <<'SEAL'",
    ...JSON.stringify(example, null, 2).split("\n"),
    "SEAL",
    'hive seal "$bee" --from "$artifact"',
    "",
    ...(matchKeys.length > 0
      ? [`Copy ${matchKeys.join(" and ")} into the seal VERBATIM — completion is matched on ${matchKeys.length > 1 ? "them" : "it"}; a seal without ${matchKeys.length > 1 ? "them" : "it"} does not count.`]
      : []),
    "Use status=blocked/failed instead of done when that is the truth. Going",
    "idle without a seal is treated as a stall, never as completion.",
  ].join("\n");
}

/** Append the contract postscript to a brief (or stand alone when no brief). */
export function withContractPostscript(brief: string | undefined, contract: BeeContract | undefined): string | undefined {
  if (!contract) return brief;
  const postscript = contractPostscript(contract);
  if (!postscript) return brief;
  return brief ? `${brief}\n\n${postscript}` : postscript;
}
