import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import type { SessionRecord } from "../store.js";
import type { ActivationHomeOwner } from "./activation.js";

export type CredentialHarvestHomeIdentity = {
  /** Canonical, alias-free path captured while the activation-home lock is held. */
  path: string;
  /** Physical directory identity; strings avoid JSON precision loss. */
  device: string;
  inode: string;
};

export type CredentialHarvestEvidence =
  | {
    kind: "activation-owner";
    ownerGeneration: string;
    ownerState: "activating" | "ready";
    ownerUpdatedAt: string;
    sessionCreatedAt: string;
    sessionUpdatedAt: string;
    runtimeGeneration: number;
  }
  | {
    kind: "legacy-session";
    sessionCreatedAt: string;
    sessionUpdatedAt: string;
    runtimeGeneration: number;
  };

export type CredentialHarvestAttemptOutcome =
  | "attempting"
  | "content-rejected"
  | "home-rebound"
  | "home-replaced"
  | "no-credential-evidence"
  | "owner-incomplete"
  | "sync-failed"
  | "unknown-account";

/**
 * Durable, deliberately secret-free recovery handle for a purged SessionRecord.
 * Never add provider payloads, command/env fields, or arbitrary error strings.
 */
export type CredentialHarvestWorkItem = {
  version: 1;
  id: string;
  accountId: string;
  home: CredentialHarvestHomeIdentity;
  evidence: CredentialHarvestEvidence;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastOutcome?: CredentialHarvestAttemptOutcome;
};

export function credentialHarvestQueueRoot(): string {
  return join(storeRoot(), "credential-harvest-quarantine");
}

function itemPath(id: string): string {
  return join(credentialHarvestQueueRoot(), `${id}.json`);
}

function workItemId(accountId: string, home: CredentialHarvestHomeIdentity): string {
  return createHash("sha256")
    .update(`${accountId}\0${home.path}\0${home.device}\0${home.inode}`)
    .digest("hex");
}

export async function credentialHarvestHomeIdentity(canonicalHomePath: string): Promise<CredentialHarvestHomeIdentity> {
  const info = await stat(canonicalHomePath, { bigint: true });
  if (!info.isDirectory()) throw new Error(`credential harvest home is not a directory: ${canonicalHomePath}`);
  return {
    path: canonicalHomePath,
    device: info.dev.toString(),
    inode: info.ino.toString(),
  };
}

export async function credentialHarvestHomeIdentityMatches(home: CredentialHarvestHomeIdentity): Promise<boolean> {
  try {
    const current = await credentialHarvestHomeIdentity(home.path);
    return current.path === home.path && current.device === home.device && current.inode === home.inode;
  } catch {
    return false;
  }
}

function sessionEvidence(record: SessionRecord): Pick<CredentialHarvestEvidence, "sessionCreatedAt" | "sessionUpdatedAt" | "runtimeGeneration"> {
  return {
    sessionCreatedAt: record.createdAt,
    sessionUpdatedAt: record.updatedAt ?? record.createdAt,
    runtimeGeneration: record.runtimeGeneration ?? 0,
  };
}

function evidenceFor(record: SessionRecord, owner: ActivationHomeOwner | null): CredentialHarvestEvidence {
  const session = sessionEvidence(record);
  if (!owner) return { kind: "legacy-session", ...session };
  return {
    kind: "activation-owner",
    ownerGeneration: owner.generation,
    ownerState: owner.state,
    ownerUpdatedAt: owner.updatedAt,
    ...session,
  };
}

function evidenceTime(evidence: CredentialHarvestEvidence): number {
  const value = evidence.kind === "activation-owner" ? evidence.ownerUpdatedAt : evidence.sessionUpdatedAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function preferEvidence(candidate: CredentialHarvestEvidence, current: CredentialHarvestEvidence): CredentialHarvestEvidence {
  if (candidate.kind !== current.kind) {
    return candidate.kind === "activation-owner" ? candidate : current;
  }
  return evidenceTime(candidate) >= evidenceTime(current) ? candidate : current;
}

/** Caller must hold the canonical activation-home lock. */
export async function enqueueCredentialHarvestWorkItem(
  record: SessionRecord,
  canonicalHomePath: string,
  owner: ActivationHomeOwner | null,
  now: () => number = Date.now,
): Promise<CredentialHarvestWorkItem> {
  const accountId = record.accountId?.trim();
  if (!accountId) throw new Error("cannot quarantine a credential harvest without accountId");
  if (owner && owner.accountId !== accountId) throw new Error("cannot quarantine a credential harvest for a foreign home owner");
  const home = await credentialHarvestHomeIdentity(canonicalHomePath);
  const id = workItemId(accountId, home);
  const existing = await readCredentialHarvestWorkItem(itemPath(id));
  const timestamp = new Date(now()).toISOString();
  const candidateEvidence = evidenceFor(record, owner);
  const item: CredentialHarvestWorkItem = {
    version: 1,
    id,
    accountId,
    home,
    evidence: existing ? preferEvidence(candidateEvidence, existing.evidence) : candidateEvidence,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    attempts: existing?.attempts ?? 0,
    ...(existing?.lastAttemptAt ? { lastAttemptAt: existing.lastAttemptAt } : {}),
    ...(existing?.lastOutcome ? { lastOutcome: existing.lastOutcome } : {}),
  };
  await writeCredentialHarvestWorkItem(item);
  return item;
}

/** Caller must hold the canonical activation-home lock. */
export async function recordCredentialHarvestAttempt(
  observed: CredentialHarvestWorkItem,
  outcome: CredentialHarvestAttemptOutcome,
  now: () => number = Date.now,
): Promise<CredentialHarvestWorkItem | null> {
  return updateCredentialHarvestAttempt(observed, outcome, false, now);
}

/** Caller must hold the canonical activation-home lock. */
export async function beginCredentialHarvestAttempt(
  observed: CredentialHarvestWorkItem,
  now: () => number = Date.now,
): Promise<CredentialHarvestWorkItem | null> {
  return updateCredentialHarvestAttempt(observed, "attempting", true, now);
}

async function updateCredentialHarvestAttempt(
  observed: CredentialHarvestWorkItem,
  outcome: CredentialHarvestAttemptOutcome,
  increment: boolean,
  now: () => number,
): Promise<CredentialHarvestWorkItem | null> {
  const current = await readCredentialHarvestWorkItem(itemPath(observed.id));
  if (!current || !sameRecoveryGeneration(current, observed)) return null;
  const timestamp = new Date(now()).toISOString();
  const updated: CredentialHarvestWorkItem = {
    ...current,
    updatedAt: timestamp,
    attempts: current.attempts + (increment ? 1 : 0),
    lastAttemptAt: timestamp,
    lastOutcome: outcome,
  };
  await writeCredentialHarvestWorkItem(updated);
  return updated;
}

/** Caller must hold the canonical activation-home lock. */
export async function removeCredentialHarvestWorkItem(observed: CredentialHarvestWorkItem): Promise<boolean> {
  const current = await readCredentialHarvestWorkItem(itemPath(observed.id));
  if (!current || !sameRecoveryGeneration(current, observed)) return false;
  await rm(itemPath(observed.id), { force: true });
  return true;
}

/** Caller must hold the canonical activation-home lock. */
export async function removeCredentialHarvestWorkItemForHome(
  accountId: string,
  canonicalHomePath: string,
): Promise<boolean> {
  const candidates = (await listCredentialHarvestWorkItems()).filter(
    (item) => item.accountId === accountId && item.home.path === canonicalHomePath,
  );
  if (candidates.length === 0) return false;
  const home = await credentialHarvestHomeIdentity(canonicalHomePath);
  const id = workItemId(accountId, home);
  const current = candidates.find((item) => item.id === id)
    ?? await readCredentialHarvestWorkItem(itemPath(id));
  if (!current) return false;
  await rm(itemPath(id), { force: true });
  return true;
}

export async function listCredentialHarvestWorkItems(): Promise<CredentialHarvestWorkItem[]> {
  const entries = await readdir(credentialHarvestQueueRoot()).catch(() => [] as string[]);
  const items: CredentialHarvestWorkItem[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const item = await readCredentialHarvestWorkItem(join(credentialHarvestQueueRoot(), entry));
    if (item && entry === `${item.id}.json`) items.push(item);
  }
  return items;
}

function sameRecoveryGeneration(a: CredentialHarvestWorkItem, b: CredentialHarvestWorkItem): boolean {
  if (a.id !== b.id || a.accountId !== b.accountId) return false;
  if (a.home.path !== b.home.path || a.home.device !== b.home.device || a.home.inode !== b.home.inode) return false;
  if (a.evidence.kind !== b.evidence.kind) return false;
  return a.evidence.kind === "activation-owner" && b.evidence.kind === "activation-owner"
    ? a.evidence.ownerGeneration === b.evidence.ownerGeneration
    : true;
}

async function writeCredentialHarvestWorkItem(item: CredentialHarvestWorkItem): Promise<void> {
  await atomicWriteFile(itemPath(item.id), `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600 });
}

async function readCredentialHarvestWorkItem(path: string): Promise<CredentialHarvestWorkItem | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return normalizeCredentialHarvestWorkItem(parsed);
  } catch {
    return null;
  }
}

function normalizeCredentialHarvestWorkItem(value: unknown): CredentialHarvestWorkItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!hasOnlyKeys(value, [
    "version", "id", "accountId", "home", "evidence", "createdAt", "updatedAt",
    "attempts", "lastAttemptAt", "lastOutcome",
  ])) return null;
  const item = value as Partial<CredentialHarvestWorkItem>;
  const home = item.home as Partial<CredentialHarvestHomeIdentity> | undefined;
  const evidence = item.evidence as Partial<CredentialHarvestEvidence> | undefined;
  if (
    item.version !== 1 ||
    typeof item.id !== "string" || !/^[a-f0-9]{64}$/.test(item.id) ||
    typeof item.accountId !== "string" || !item.accountId ||
    !home || typeof home.path !== "string" || !home.path || !isAbsolute(home.path) || resolve(home.path) !== home.path ||
    typeof home.device !== "string" || !/^[0-9]+$/.test(home.device) ||
    typeof home.inode !== "string" || !/^[0-9]+$/.test(home.inode) ||
    !evidence || (evidence.kind !== "activation-owner" && evidence.kind !== "legacy-session") ||
    typeof evidence.sessionCreatedAt !== "string" || !Number.isFinite(Date.parse(evidence.sessionCreatedAt)) ||
    typeof evidence.sessionUpdatedAt !== "string" || !Number.isFinite(Date.parse(evidence.sessionUpdatedAt)) ||
    !Number.isSafeInteger(evidence.runtimeGeneration) || (evidence.runtimeGeneration ?? -1) < 0 ||
    typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) ||
    typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt)) ||
    !Number.isSafeInteger(item.attempts) || (item.attempts ?? -1) < 0 ||
    (item.lastAttemptAt !== undefined && (typeof item.lastAttemptAt !== "string" || !Number.isFinite(Date.parse(item.lastAttemptAt)))) ||
    (item.lastOutcome !== undefined && !ATTEMPT_OUTCOMES.has(item.lastOutcome))
  ) return null;
  if (!hasOnlyKeys(home, ["path", "device", "inode"])) return null;
  if (evidence.kind === "activation-owner" && (
    !hasOnlyKeys(evidence, [
      "kind", "ownerGeneration", "ownerState", "ownerUpdatedAt",
      "sessionCreatedAt", "sessionUpdatedAt", "runtimeGeneration",
    ]) ||
    typeof evidence.ownerGeneration !== "string" || !evidence.ownerGeneration ||
    (evidence.ownerState !== "activating" && evidence.ownerState !== "ready") ||
    typeof evidence.ownerUpdatedAt !== "string" || !Number.isFinite(Date.parse(evidence.ownerUpdatedAt))
  )) return null;
  if (evidence.kind === "legacy-session" && !hasOnlyKeys(evidence, [
    "kind", "sessionCreatedAt", "sessionUpdatedAt", "runtimeGeneration",
  ])) return null;
  const normalized: CredentialHarvestWorkItem = {
    version: 1,
    id: item.id,
    accountId: item.accountId,
    home: {
      path: home.path,
      device: home.device,
      inode: home.inode,
    },
    evidence: evidence.kind === "activation-owner"
      ? {
        kind: "activation-owner",
        ownerGeneration: evidence.ownerGeneration!,
        ownerState: evidence.ownerState!,
        ownerUpdatedAt: evidence.ownerUpdatedAt!,
        sessionCreatedAt: evidence.sessionCreatedAt,
        sessionUpdatedAt: evidence.sessionUpdatedAt,
        runtimeGeneration: evidence.runtimeGeneration!,
      }
      : {
        kind: "legacy-session",
        sessionCreatedAt: evidence.sessionCreatedAt,
        sessionUpdatedAt: evidence.sessionUpdatedAt,
        runtimeGeneration: evidence.runtimeGeneration!,
      },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    attempts: item.attempts!,
    ...(item.lastAttemptAt === undefined ? {} : { lastAttemptAt: item.lastAttemptAt }),
    ...(item.lastOutcome === undefined ? {} : { lastOutcome: item.lastOutcome }),
  };
  return workItemId(normalized.accountId, normalized.home) === normalized.id ? normalized : null;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

const ATTEMPT_OUTCOMES = new Set<CredentialHarvestAttemptOutcome>([
  "attempting",
  "content-rejected",
  "home-rebound",
  "home-replaced",
  "no-credential-evidence",
  "owner-incomplete",
  "sync-failed",
  "unknown-account",
]);
