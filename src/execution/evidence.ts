// Digest-addressed, node-local evidence for run.collect (local-core-v1,
// RFC §10.8, §16). Bytes live content-addressed under the Run's directory:
//
//   runs/<runKey(runId)>/evidence/<sha256hex>
//
// and are referenced through the collection manifest ONLY as opaque
// `node-local` tokens (`evidence/<runKey>/<sha256hex>`). The token is the
// provider-owned durable resolution path: resolveEvidenceToken/readEvidence
// map a token back to verified bytes without the caller ever knowing (or
// guessing) Honeybee's file layout, and they survive daemon restart because
// both the bytes and the manifest are plain durable files. No machine path,
// upload state, or credential bytes ever enter the manifest.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicWriteFile } from "../fsx.js";
import type { JsonValue } from "../comb/types.js";
import type { JsonObject } from "./contract.js";
import { executionError } from "./errors.js";
import { executionRoot } from "./nodeState.js";
import { runDir, runKey } from "./runStore.js";
import type { WorkingCopyRecord } from "./workingCopies.js";

const execFileAsync = promisify(execFile);

const EVIDENCE_TOKEN_PATTERN = /^evidence\/([A-Za-z0-9._-]+)\/([0-9a-f]{64})$/;

export type StoredEvidence = {
  /** `sha256:<hex>` content digest of the stored bytes. */
  digest: string;
  sizeBytes: number;
  /** Opaque node-local token: `evidence/<runKey>/<hex>`. */
  token: string;
};

function evidenceDir(runId: string): string {
  return join(runDir(runId), "evidence");
}

/** Store evidence bytes content-addressed; idempotent for identical bytes. */
export async function putEvidence(runId: string, bytes: Buffer | string): Promise<StoredEvidence> {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const hex = createHash("sha256").update(buffer).digest("hex");
  await mkdir(evidenceDir(runId), { recursive: true, mode: 0o700 });
  await atomicWriteFile(join(evidenceDir(runId), hex), buffer, { mode: 0o600 });
  return { digest: `sha256:${hex}`, sizeBytes: buffer.length, token: `evidence/${runKey(runId)}/${hex}` };
}

/**
 * Resolve a manifest token minted by putEvidence back to its durable on-disk
 * location. This is the provider-owned resolution path an authorized
 * same-node caller uses (via readEvidence) instead of guessing file layouts.
 */
export function resolveEvidenceToken(token: string): { runKey: string; sha256hex: string; path: string } {
  const match = EVIDENCE_TOKEN_PATTERN.exec(token);
  if (!match) throw executionError("SCHEMA_UNSUPPORTED", "evidence token is not a node-local evidence reference");
  const key = match[1]!;
  const hex = match[2]!;
  return { runKey: key, sha256hex: hex, path: join(executionRoot(), "runs", key, "evidence", hex) };
}

/** Read + digest-verify evidence bytes for a token; corruption fails closed. */
export async function readEvidence(token: string): Promise<Buffer> {
  const resolved = resolveEvidenceToken(token);
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved.path);
  } catch (error) {
    throw executionError("AUTHORITY_UNAVAILABLE", `evidence ${token} is not readable on this node: ${String(error)}`);
  }
  const hex = createHash("sha256").update(bytes).digest("hex");
  if (hex !== resolved.sha256hex) {
    throw executionError("AUTHORITY_UNAVAILABLE", `evidence ${token} bytes do not match their digest; refusing to serve`);
  }
  return bytes;
}

/* ---------------------------------------------------------------- */
/* Git diff metadata for the registered working copy                 */
/* ---------------------------------------------------------------- */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/**
 * Diff METADATA (not a patch) of the working copy against the registered base
 * revision: head/branch identity, porcelain status, and numstat totals. File
 * paths are repository-relative; no absolute node paths, no file contents.
 * The caller must have verified this Run still owns the copy's occupancy.
 */
export async function collectGitDiffMetadata(copy: WorkingCopyRecord, generatedAt: string): Promise<JsonObject> {
  const head = (await git(copy.path, ["rev-parse", "HEAD"])).trim();
  const branch = (await git(copy.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  let base = copy.revision ?? head;
  try {
    if (copy.revision) await git(copy.path, ["rev-parse", "--verify", `${copy.revision}^{commit}`]);
  } catch {
    base = head;
  }
  const statusRaw = await git(copy.path, ["status", "--porcelain"]);
  const status = statusRaw
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
  const numstatRaw = await git(copy.path, ["diff", "--numstat", base]);
  let insertions = 0;
  let deletions = 0;
  const files = numstatRaw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [ins, del, ...rest] = line.split("\t");
      const added = Number(ins);
      const removed = Number(del);
      if (Number.isFinite(added)) insertions += added;
      if (Number.isFinite(removed)) deletions += removed;
      return {
        path: rest.join("\t"),
        insertions: Number.isFinite(added) ? added : null,
        deletions: Number.isFinite(removed) ? removed : null,
      };
    });
  return {
    workingCopyId: copy.workingCopyId,
    productId: copy.productId,
    baseRevision: base,
    head,
    branch,
    ...(copy.origin ? { origin: copy.origin } : {}),
    status: status as unknown as JsonValue,
    diff: { filesChanged: files.length, insertions, deletions, files: files as unknown as JsonValue },
    generatedAt,
  };
}

/** Raw bytes of the Run's durable normalized control-event log, or null. */
export async function readRunLogBytes(runId: string): Promise<Buffer | null> {
  try {
    return await readFile(join(runDir(runId), "events.jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw executionError("AUTHORITY_UNAVAILABLE", `run ${runId} event log is unreadable: ${String(error)}`);
  }
}

/** Raw bytes of the bound harness session's structured event transcript, or null. */
export async function readTranscriptBytes(beeName: string): Promise<Buffer | null> {
  const { hsrEventsPath } = await import("../hsr/runDir.js");
  try {
    return await readFile(hsrEventsPath(beeName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw executionError("AUTHORITY_UNAVAILABLE", `harness transcript for ${beeName} is unreadable: ${String(error)}`);
  }
}
