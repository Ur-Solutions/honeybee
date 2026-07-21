import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { appendLedger } from "./store.js";

export const SEAL_STATUSES = ["done", "blocked", "needs_input", "failed"] as const;
export const SEAL_TYPES = ["implementation", "review", "risk", "test", "witness"] as const;
export const TEST_RUN_RESULTS = ["passed", "failed", "skipped"] as const;
export const SEAL_ARTIFACT_KINDS = ["branch", "diff", "url", "fixture"] as const;

export type SealStatus = (typeof SEAL_STATUSES)[number];
export type SealType = (typeof SEAL_TYPES)[number];
export type TestRunResult = (typeof TEST_RUN_RESULTS)[number];
export type SealArtifactKind = (typeof SEAL_ARTIFACT_KINDS)[number];

export type TestRun = {
  command: string;
  result: TestRunResult;
  notes?: string;
};

/** A machine-checkable output reference carried inside `evidence.artifacts`. */
export type SealEvidenceArtifact = {
  kind: SealArtifactKind;
  ref: string;
};

/**
 * Machine-checkable claims backing a seal (Seal v2). Deliberately additive:
 * the top-level filesChanged/testsRun stay valid; evidence groups the claims a
 * downstream validator (flight collection gate, review desk) can check.
 */
export type SealEvidence = {
  filesChanged?: string[];
  testsRun?: TestRun[];
  artifacts?: SealEvidenceArtifact[];
};

export type SealArtifact = {
  status: SealStatus;
  summary: string;
  type?: SealType;
  /**
   * Correlation key tying this seal to the unit of work that demanded it —
   * a flight slot ("FL.3k2/s3"), shard id, or comb activation. Completion
   * contracts match on it: a seal without the demanded taskId never satisfies
   * the contract, so a stale or unrelated seal can't be laundered into "done".
   */
  taskId?: string;
  /** Which lease attempt produced this seal (flight slots; 1-based). */
  attempt?: number;
  evidence?: SealEvidence;
  filesChanged?: string[];
  testsRun?: TestRun[];
  risks?: string[];
  nextActions?: string[];
  confidence?: number;
};

export type SealRecord = SealArtifact & {
  beeName: string;
  sealedAt: string;
};

export type LatestSealScan = {
  seal: SealRecord | null;
  /** Filename that contained `seal`, when a valid seal was found. */
  filename: string | null;
  /** Lexicographically newest seal filename observed during this scan. */
  highWaterFilename: string | null;
};

const SEAL_STATUS_SET = new Set<string>(SEAL_STATUSES);
const SEAL_TYPE_SET = new Set<string>(SEAL_TYPES);
const TEST_RUN_RESULT_SET = new Set<string>(TEST_RUN_RESULTS);
const SEAL_ARTIFACT_KIND_SET = new Set<string>(SEAL_ARTIFACT_KINDS);

/** Canonical representative input, shared by `hive seal --example` and help. */
export const SEAL_ARTIFACT_EXAMPLE = {
  status: "done",
  summary: "Implemented discoverable seal help and verified the CLI behavior.",
  type: "implementation",
  filesChanged: ["src/seal.ts", "src/commands/messaging.ts"],
  testsRun: [
    {
      command: "npm test",
      result: "passed",
      notes: "All tests passed.",
    },
  ],
  risks: ["None known."],
  nextActions: ["Review the diff."],
  confidence: 0.95,
} satisfies SealArtifact;

export function sealArtifactExampleJson(): string {
  return JSON.stringify(SEAL_ARTIFACT_EXAMPLE, null, 2);
}

/** Detailed command help kept beside the artifact validator to limit drift. */
export function sealHelpText(): string {
  return `hive seal — record a typed handoff artifact

Usage
  hive seal <selector> --from <path-to-seal.json>
  hive seal --example
  hive seal --help

Artifact contract
  status        required  string enum: ${SEAL_STATUSES.join(" | ")}
  summary       required  non-empty string
  type          optional  string enum: ${SEAL_TYPES.join(" | ")}
  taskId        optional  non-empty string — correlation key for completion
                          contracts (flight slot / shard id); copy it verbatim
                          from your brief's contract postscript when present
  attempt       optional  positive integer — the lease attempt that produced
                          this seal (from the contract postscript)
  evidence      optional  object with machine-checkable claims:
    filesChanged  optional  string[]
    testsRun      optional  object[] (same shape as top-level testsRun)
    artifacts     optional  object[] with:
      kind        required  string enum: ${SEAL_ARTIFACT_KINDS.join(" | ")}
      ref         required  non-empty string
  filesChanged  optional  string[]
  testsRun      optional  object[] with:
    command     required  non-empty string
    result      required  string enum: ${TEST_RUN_RESULTS.join(" | ")}
    notes       optional  string
  risks         optional  string[]
  nextActions   optional  string[]
  confidence    optional  finite number from 0 through 1 (inclusive)

Example artifact JSON
${sealArtifactExampleJson()}

Self-seal the current bee
  bee="$(hive here --id)"
  artifact="$(mktemp "\${TMPDIR:-/tmp}/hive-seal.XXXXXX")"
  hive seal --example > "$artifact"
  \${EDITOR:-vi} "$artifact"
  hive seal "$bee" --from "$artifact"
  rm -f "$artifact"`;
}

export function validateSealArtifact(value: unknown): SealArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid seal artifact: expected an object");
  }
  const object = value as Record<string, unknown>;
  const status = object.status;
  if (typeof status !== "string" || !SEAL_STATUS_SET.has(status)) {
    throw new Error(`Invalid seal status: ${String(status)}. Use one of: ${SEAL_STATUSES.join(", ")}.`);
  }
  const summary = object.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new Error("Invalid seal: summary must be a non-empty string");
  }
  const artifact: SealArtifact = { status: status as SealStatus, summary };

  if (object.type !== undefined) {
    if (typeof object.type !== "string" || !SEAL_TYPE_SET.has(object.type)) {
      throw new Error(`Invalid seal type: ${String(object.type)}. Use one of: ${SEAL_TYPES.join(", ")}.`);
    }
    artifact.type = object.type as SealType;
  }

  if (object.taskId !== undefined) {
    if (typeof object.taskId !== "string" || object.taskId.trim().length === 0) {
      throw new Error("Invalid seal: taskId must be a non-empty string");
    }
    artifact.taskId = object.taskId;
  }

  if (object.attempt !== undefined) {
    if (typeof object.attempt !== "number" || !Number.isSafeInteger(object.attempt) || object.attempt < 1) {
      throw new Error("Invalid seal: attempt must be a positive integer");
    }
    artifact.attempt = object.attempt;
  }

  if (object.evidence !== undefined) {
    artifact.evidence = validateSealEvidence(object.evidence);
  }

  if (object.filesChanged !== undefined) {
    if (!Array.isArray(object.filesChanged) || object.filesChanged.some((v) => typeof v !== "string")) {
      throw new Error("Invalid seal: filesChanged must be an array of strings");
    }
    artifact.filesChanged = object.filesChanged as string[];
  }

  if (object.testsRun !== undefined) {
    if (!Array.isArray(object.testsRun)) throw new Error("Invalid seal: testsRun must be an array");
    artifact.testsRun = object.testsRun.map((entry, index) => validateTestRun(entry, index));
  }

  if (object.risks !== undefined) {
    if (!Array.isArray(object.risks) || object.risks.some((v) => typeof v !== "string")) {
      throw new Error("Invalid seal: risks must be an array of strings");
    }
    artifact.risks = object.risks as string[];
  }

  if (object.nextActions !== undefined) {
    if (!Array.isArray(object.nextActions) || object.nextActions.some((v) => typeof v !== "string")) {
      throw new Error("Invalid seal: nextActions must be an array of strings");
    }
    artifact.nextActions = object.nextActions as string[];
  }

  if (object.confidence !== undefined) {
    if (typeof object.confidence !== "number" || !Number.isFinite(object.confidence) || object.confidence < 0 || object.confidence > 1) {
      throw new Error("Invalid seal: confidence must be a number between 0 and 1");
    }
    artifact.confidence = object.confidence;
  }

  return artifact;
}

function validateSealEvidence(value: unknown): SealEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid seal: evidence must be an object");
  }
  const object = value as Record<string, unknown>;
  const evidence: SealEvidence = {};
  if (object.filesChanged !== undefined) {
    if (!Array.isArray(object.filesChanged) || object.filesChanged.some((v) => typeof v !== "string")) {
      throw new Error("Invalid seal: evidence.filesChanged must be an array of strings");
    }
    evidence.filesChanged = object.filesChanged as string[];
  }
  if (object.testsRun !== undefined) {
    if (!Array.isArray(object.testsRun)) throw new Error("Invalid seal: evidence.testsRun must be an array");
    evidence.testsRun = object.testsRun.map((entry, index) => validateTestRun(entry, index));
  }
  if (object.artifacts !== undefined) {
    if (!Array.isArray(object.artifacts)) throw new Error("Invalid seal: evidence.artifacts must be an array");
    evidence.artifacts = object.artifacts.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Invalid evidence.artifacts[${index}]: expected an object`);
      }
      const row = entry as Record<string, unknown>;
      if (typeof row.kind !== "string" || !SEAL_ARTIFACT_KIND_SET.has(row.kind)) {
        throw new Error(`Invalid evidence.artifacts[${index}]: kind must be ${SEAL_ARTIFACT_KINDS.join(", ")}`);
      }
      if (typeof row.ref !== "string" || row.ref.trim().length === 0) {
        throw new Error(`Invalid evidence.artifacts[${index}]: ref must be a non-empty string`);
      }
      return { kind: row.kind as SealArtifactKind, ref: row.ref };
    });
  }
  return evidence;
}

function validateTestRun(value: unknown, index: number): TestRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid testsRun[${index}]: expected an object`);
  }
  const object = value as Record<string, unknown>;
  if (typeof object.command !== "string" || object.command.trim().length === 0) {
    throw new Error(`Invalid testsRun[${index}]: command must be a non-empty string`);
  }
  const result = object.result;
  if (typeof result !== "string" || !TEST_RUN_RESULT_SET.has(result)) {
    throw new Error(`Invalid testsRun[${index}]: result must be ${TEST_RUN_RESULTS.slice(0, -1).join(", ")}, or ${TEST_RUN_RESULTS.at(-1)}`);
  }
  const run: TestRun = { command: object.command, result: result as TestRunResult };
  if (typeof object.notes === "string") run.notes = object.notes;
  return run;
}

export async function recordSeal(beeName: string, artifact: SealArtifact): Promise<SealRecord> {
  const sealedAt = new Date().toISOString();
  const record: SealRecord = { ...artifact, beeName, sealedAt };
  await ensureBeeDir(beeName);
  const path = sealPath(beeName, sealedAt);
  await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await appendLedger({
    type: "seal",
    session: beeName,
    sealStatus: artifact.status,
    sealKind: artifact.type,
    ...(artifact.taskId ? { taskId: artifact.taskId } : {}),
    ...(artifact.attempt !== undefined ? { attempt: artifact.attempt } : {}),
    path,
  });
  return record;
}

export async function listSeals(beeName: string): Promise<SealRecord[]> {
  const dir = beeSealDir(beeName);
  const files = await readdir(dir).catch(() => []);
  const seals: Array<{ file: string; seal: SealRecord }> = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const seal = await readSeal(join(dir, file)).catch(() => null);
    if (seal) seals.push({ file, seal });
  }
  return seals
    .sort((a, b) => b.seal.sealedAt.localeCompare(a.seal.sealedAt) || b.file.localeCompare(a.file))
    .map((entry) => entry.seal);
}

/**
 * Efficient latest-seal lookup. Seal filenames start with sealedAt (with `:`/`.`
 * mapped to `-`), so lexicographic filename order matches chronological order.
 * `scanLatestSeal` can start after a previously observed filename, letting
 * long-running loop boundary polling avoid re-sorting the full seal history.
 * Corrupt files are skipped, walking backwards, mirroring listSeals' skip
 * semantics.
 */
export async function loadLatestSeal(beeName: string): Promise<SealRecord | null> {
  return (await scanLatestSeal(beeName)).seal;
}

export async function scanLatestSeal(beeName: string, options: { afterFilename?: string | null } = {}): Promise<LatestSealScan> {
  const dir = beeSealDir(beeName);
  const afterFilename = options.afterFilename ?? null;
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json") && (afterFilename === null || f > afterFilename))
    .sort();
  const highWaterFilename = files.length > 0 ? files[files.length - 1]! : afterFilename;
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const seal = await readSeal(join(dir, files[i]!)).catch(() => null);
    if (seal) return { seal, filename: files[i]!, highWaterFilename };
  }
  return { seal: null, filename: null, highWaterFilename };
}

/**
 * COPY every seal file for `beeName` into `destDir/<beeName>/`, preserving the
 * stamp filename scheme — the filing step of `quest done` (PRD §8.4). This is a
 * pure copy: the live sealsRoot stays intact (the seal index is never moved), so
 * a crash after filing but before kill leaves seals duplicated (benign), never
 * lost. Keeping the path scheme inside this module means cli.ts never reaches
 * into seal internals. Returns the number of seal files copied.
 */
export async function copyBeeSeals(beeName: string, destDir: string): Promise<number> {
  const srcDir = beeSealDir(beeName);
  const files = (await readdir(srcDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return 0;
  const target = join(destDir, beeName);
  await mkdir(target, { recursive: true });
  let copied = 0;
  for (const file of files) {
    await copyFile(join(srcDir, file), join(target, file));
    copied += 1;
  }
  return copied;
}

export async function sealedBeeNames(): Promise<Set<string>> {
  const root = sealsRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) names.add(entry.name);
  }
  return names;
}

async function readSeal(path: string): Promise<SealRecord> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid seal file at ${path}`);
  }
  const object = parsed as Record<string, unknown>;
  const artifact = validateSealArtifact(object);
  if (typeof object.beeName !== "string" || typeof object.sealedAt !== "string") {
    throw new Error(`Invalid seal file at ${path}: missing beeName or sealedAt`);
  }
  return { ...artifact, beeName: object.beeName, sealedAt: object.sealedAt };
}

async function ensureBeeDir(beeName: string): Promise<void> {
  await mkdir(beeSealDir(beeName), { recursive: true });
}

export function sealsRoot(): string {
  return join(storeRoot(), "seals");
}

function beeSealDir(beeName: string): string {
  return join(sealsRoot(), beeName);
}

let lastSealStamp = "";
let sameStampCounter = 0;

function sealPath(beeName: string, sealedAt: string): string {
  const safeStamp = sealedAt.replace(/[:.]/g, "-");
  return join(beeSealDir(beeName), `${safeStamp}-${nextSealSuffix(safeStamp)}.json`);
}

function nextSealSuffix(safeStamp: string): string {
  if (safeStamp === lastSealStamp) {
    sameStampCounter += 1;
  } else {
    lastSealStamp = safeStamp;
    sameStampCounter = 0;
  }
  const counter = sameStampCounter.toString(36).padStart(4, "0");
  return `${counter}-${randomBytes(3).toString("hex")}`;
}
