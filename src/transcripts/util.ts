import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { namingGeneratorCwd } from "../fsx.js";
import type { TranscriptLookupOptions } from "./types.js";

export function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return resolve(a) === resolve(b);
}

export function isPathInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** A transcript recorded in the title-generator's dedicated cwd is a title-gen
 * artifact, never a real bee session — see the codex adapter. */
export function isGeneratorTranscriptCwd(transcriptCwd: string): boolean {
  return samePath(transcriptCwd, namingGeneratorCwd());
}

export function sinceMillis(options: TranscriptLookupOptions): number {
  return options.sinceIso ? Date.parse(options.sinceIso) - 5_000 : 0;
}

export async function getMtime(path: string, knownMtimeMs?: number): Promise<number | null> {
  if (knownMtimeMs !== undefined) return knownMtimeMs;
  const info = await stat(path).catch(() => null);
  return info?.mtimeMs ?? null;
}

export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
