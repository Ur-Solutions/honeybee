import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { appendLedger } from "./store.js";

export type SealStatus = "done" | "blocked" | "needs_input" | "failed";
export type SealType = "implementation" | "review" | "risk" | "test" | "witness";

export type TestRun = {
  command: string;
  result: "passed" | "failed" | "skipped";
  notes?: string;
};

export type SealArtifact = {
  status: SealStatus;
  summary: string;
  type?: SealType;
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

const SEAL_STATUSES = new Set<SealStatus>(["done", "blocked", "needs_input", "failed"]);
const SEAL_TYPES = new Set<SealType>(["implementation", "review", "risk", "test", "witness"]);

export function validateSealArtifact(value: unknown): SealArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid seal artifact: expected an object");
  }
  const object = value as Record<string, unknown>;
  const status = object.status;
  if (typeof status !== "string" || !SEAL_STATUSES.has(status as SealStatus)) {
    throw new Error(`Invalid seal status: ${String(status)}. Use one of: done, blocked, needs_input, failed.`);
  }
  const summary = object.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new Error("Invalid seal: summary must be a non-empty string");
  }
  const artifact: SealArtifact = { status: status as SealStatus, summary };

  if (object.type !== undefined) {
    if (typeof object.type !== "string" || !SEAL_TYPES.has(object.type as SealType)) {
      throw new Error(`Invalid seal type: ${String(object.type)}. Use one of: implementation, review, risk, test, witness.`);
    }
    artifact.type = object.type as SealType;
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

function validateTestRun(value: unknown, index: number): TestRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid testsRun[${index}]: expected an object`);
  }
  const object = value as Record<string, unknown>;
  if (typeof object.command !== "string" || object.command.trim().length === 0) {
    throw new Error(`Invalid testsRun[${index}]: command must be a non-empty string`);
  }
  const result = object.result;
  if (result !== "passed" && result !== "failed" && result !== "skipped") {
    throw new Error(`Invalid testsRun[${index}]: result must be passed, failed, or skipped`);
  }
  const run: TestRun = { command: object.command, result };
  if (typeof object.notes === "string") run.notes = object.notes;
  return run;
}

export async function recordSeal(beeName: string, artifact: SealArtifact): Promise<SealRecord> {
  const sealedAt = new Date().toISOString();
  const record: SealRecord = { ...artifact, beeName, sealedAt };
  await ensureBeeDir(beeName);
  const path = sealPath(beeName, sealedAt);
  await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await appendLedger({ type: "seal", session: beeName, sealStatus: artifact.status, sealKind: artifact.type, path });
  return record;
}

export async function listSeals(beeName: string): Promise<SealRecord[]> {
  const dir = beeSealDir(beeName);
  const files = await readdir(dir).catch(() => []);
  const seals: SealRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const seal = await readSeal(join(dir, file)).catch(() => null);
    if (seal) seals.push(seal);
  }
  return seals.sort((a, b) => b.sealedAt.localeCompare(a.sealedAt));
}

export async function loadLatestSeal(beeName: string): Promise<SealRecord | null> {
  const seals = await listSeals(beeName);
  return seals[0] ?? null;
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

function sealPath(beeName: string, sealedAt: string): string {
  const safeStamp = sealedAt.replace(/[:.]/g, "-");
  return join(beeSealDir(beeName), `${safeStamp}.json`);
}
