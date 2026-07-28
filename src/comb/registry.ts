import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { appendLedger } from "../store.js";
import { loadTsModule } from "../tsLoader.js";
import { withFileLock } from "../lock.js";
import { CombError } from "./errors.js";
import { lintComb } from "./schema.js";
import type {
  CombRegistryIndex,
  CombVersionProvenance,
  StoredCombVersion,
} from "./types.js";

export type DefineCombResult = { comb: StoredCombVersion; created: boolean };

export function combsRoot(): string {
  return join(storeRoot(), "combs");
}

export function combDefinitionsRoot(): string {
  return join(combsRoot(), "definitions");
}

export function combDefinitionDir(name: string): string {
  return join(combDefinitionsRoot(), name);
}

export function combVersionPath(name: string, version: number): string {
  return join(combDefinitionDir(name), "versions", `${String(version).padStart(6, "0")}.json`);
}

export function combIndexPath(name: string): string {
  return join(combDefinitionDir(name), "index.json");
}

function combDefinitionLockPath(name: string): string {
  return join(combDefinitionDir(name), ".lock");
}

function combSourcePath(name: string, version: number, extension: ".json" | ".ts"): string {
  return join(combDefinitionDir(name), "sources", `${String(version).padStart(6, "0")}${extension}`);
}

export async function loadCombIndex(name: string): Promise<CombRegistryIndex | null> {
  try {
    const value = JSON.parse(await readFile(combIndexPath(name), "utf8")) as CombRegistryIndex;
    if (value.schemaVersion !== 1 || value.name !== name || !Number.isSafeInteger(value.latestVersion)) {
      throw new CombError("corrupt_state", `comb index ${name} is invalid`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadCombVersion(name: string, version?: number): Promise<StoredCombVersion | null> {
  const index = await loadCombIndex(name);
  if (!index) return null;
  const selected = version ?? index.latestVersion;
  try {
    const value = JSON.parse(await readFile(combVersionPath(name, selected), "utf8")) as StoredCombVersion;
    if (value.schemaVersion !== 1 || value.name !== name || value.version !== selected) {
      throw new CombError("corrupt_state", `comb ${name}@${selected} is invalid`);
    }
    const linted = lintComb(value.definition, name);
    if (linted.definitionDigest !== value.digest) {
      throw new CombError("corrupt_state", `comb ${name}@${selected} digest mismatch`);
    }
    return { ...value, definition: linted.normalized };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listCombVersions(): Promise<Array<{ index: CombRegistryIndex; latest: StoredCombVersion }>> {
  const names = await readdir(combDefinitionsRoot()).catch(() => [] as string[]);
  const rows: Array<{ index: CombRegistryIndex; latest: StoredCombVersion }> = [];
  for (const name of names.sort()) {
    const index = await loadCombIndex(name);
    if (!index) continue;
    const latest = await loadCombVersion(name, index.latestVersion);
    if (!latest) throw new CombError("corrupt_state", `comb ${name} latest version is missing`);
    rows.push({ index, latest });
  }
  return rows;
}

export async function defineCombVersion(options: {
  definition: unknown;
  provenance: CombVersionProvenance;
  source?: { contents: string; extension: ".json" | ".ts" };
  nameOverride?: string;
  baseVersion?: number;
  createdAt?: string;
  createdBy?: string;
}): Promise<DefineCombResult> {
  const authored = options.nameOverride ? overrideName(options.definition, options.nameOverride) : options.definition;
  const linted = lintComb(authored);
  const definition = linted.normalized;
  const digest = linted.definitionDigest;
  await mkdir(combDefinitionDir(definition.name), { recursive: true });
  return withFileLock(combDefinitionLockPath(definition.name), async () => {
    const existing = await loadCombIndex(definition.name);
    const latestVersion = existing?.latestVersion ?? 0;
    if (options.baseVersion !== undefined && options.baseVersion !== latestVersion) {
      throw new CombError(
        "version_conflict",
        `comb ${definition.name} is at version ${latestVersion}, not base version ${options.baseVersion}`,
        { name: definition.name, expectedVersion: options.baseVersion, currentVersion: latestVersion },
      );
    }
    const duplicate = existing?.versions.find((row) => row.digest === digest);
    if (duplicate) {
      const comb = await loadCombVersion(definition.name, duplicate.version);
      if (!comb) throw new CombError("corrupt_state", `comb ${definition.name}@${duplicate.version} is missing`);
      return { comb, created: false };
    }
    const version = latestVersion + 1;
    const createdAt = options.createdAt ?? new Date().toISOString();
    const comb: StoredCombVersion = {
      schemaVersion: 1,
      name: definition.name,
      version,
      digest,
      definition,
      provenance: options.provenance,
      createdAt,
      createdBy: options.createdBy ?? process.env.HIVE_BEE ?? process.env.USER ?? "operator",
    };
    const index: CombRegistryIndex = {
      schemaVersion: 1,
      name: definition.name,
      latestVersion: version,
      versions: [
        ...(existing?.versions ?? []),
        { version, digest, createdAt, provenance: options.provenance },
      ],
      updatedAt: createdAt,
    };
    await atomicWriteFile(combVersionPath(definition.name, version), `${JSON.stringify(comb, null, 2)}\n`, { mode: 0o600 });
    if (options.source) {
      await atomicWriteFile(combSourcePath(definition.name, version, options.source.extension), options.source.contents, { mode: 0o600 });
    }
    await atomicWriteFile(combIndexPath(definition.name), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await appendLedger({ type: "comb.defined", comb: definition.name, version, digest, ts: createdAt });
    return { comb, created: true };
  });
}

export async function defineCombFromFile(
  sourcePath: string,
  options: { nameOverride?: string; baseVersion?: number } = {},
): Promise<DefineCombResult> {
  const absolute = resolve(sourcePath);
  const extension = extname(absolute);
  if (extension !== ".json" && extension !== ".ts") {
    throw new CombError("invalid_argument", `unsupported comb source extension ${extension}; use .json or .ts`);
  }
  let contents: string;
  try {
    contents = await readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CombError("not_found", `comb source not found: ${sourcePath}`);
    }
    throw error;
  }
  const definition = extension === ".ts"
    ? await loadTsModule(absolute, { kind: "comb" })
    : JSON.parse(contents) as unknown;
  return defineCombVersion({
    definition,
    provenance: { kind: "file", sourcePath: absolute, sourceDigest: `sha256:${createHash("sha256").update(contents).digest("hex")}` },
    source: { contents, extension },
    ...options,
  });
}

export async function lintCombFile(sourcePath: string): Promise<ReturnType<typeof lintComb>> {
  if (sourcePath === "-") throw new CombError("invalid_argument", "stdin loading belongs to the comb CLI");
  const absolute = resolve(sourcePath);
  const extension = extname(absolute);
  if (extension !== ".json" && extension !== ".ts") {
    throw new CombError("invalid_argument", `unsupported comb source extension ${extension}; use .json or .ts`);
  }
  const raw = await readFile(absolute, "utf8");
  const value = extension === ".ts" ? await loadTsModule(absolute, { kind: "comb" }) : JSON.parse(raw);
  return lintComb(value);
}

function overrideName(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CombError("invalid_argument", "comb definition must be an object");
  }
  return { ...(value as Record<string, unknown>), name };
}
