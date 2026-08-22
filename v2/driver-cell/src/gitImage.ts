/**
 * Honeybee-owned local Git images for fast Cell provisioning.
 *
 * A live checkout's `.git` is a poor cloning primitive: it contains thousands
 * of mutable refs, worktree records, logs, locks, and loose objects.  An image
 * is the opposite: an immutable bare object database containing only pack
 * files plus one anchor ref.  Completed generations are published through an
 * atomic `current.json` pointer and are never changed in place.
 *
 * Image refresh is deliberately synchronous because its caller is the Cell
 * provisioning worker (never the daemon/RPC lane). The provision worker may
 * extend a stale image before checkout; post-turn maintenance retries failures.
 * A missing, stale, busy, or corrupt image is only a cache miss; normal
 * provisioning remains the source of correctness.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cowCopy, cowPlatform, probeCow, type CowPlatform } from "./cow.ts";
import { git, gitEnv, hasCommit, tryGit } from "./git.ts";

export const CELL_GIT_IMAGE_VERSION = 1 as const;
const IMAGE_LOCK_STALE_MS = 30 * 60 * 1_000;
const GENERATION_GRACE_MS = 60 * 60 * 1_000;
const MAX_IMAGE_PACKS = 64;
const GENERATION_RE = /^g-[0-9]+-[0-9a-f-]+$/;

export interface GitImagePointer {
  version: typeof CELL_GIT_IMAGE_VERSION;
  repoKey: string;
  origin: string;
  objectFormat: "sha1" | "sha256";
  generation: string;
  anchorSha: string;
  createdAt: number;
}

export interface GitImagePlacement {
  repoKey: string;
  generation: string;
}

export type GitImageRefreshResult =
  | { status: "ready"; image: GitImagePointer }
  | { status: "refreshed"; image: GitImagePointer }
  | { status: "busy" };

export interface GitImageOptions {
  platform?: CowPlatform | null;
  now?: () => number;
}

/** Images are node-local acceleration state beside (not inside) Cells. */
export function gitImagesRootForCells(cellsRoot: string): string {
  return join(dirname(resolve(cellsRoot)), "cell-git-images", `v${CELL_GIT_IMAGE_VERSION}`);
}

function canonicalOrigin(originRepo: string): string {
  return realpathSync(originRepo);
}

function objectFormatOf(originRepo: string): "sha1" | "sha256" {
  const format = git(originRepo, ["rev-parse", "--show-object-format"]);
  if (format !== "sha1" && format !== "sha256") {
    throw new Error(`cell git image: unsupported object format ${format}`);
  }
  return format;
}

export function gitImageRepoKey(originRepo: string): string {
  const origin = canonicalOrigin(originRepo);
  const objectFormat = objectFormatOf(originRepo);
  return repoKeyOf(origin, objectFormat);
}

function repoKeyOf(origin: string, objectFormat: "sha1" | "sha256"): string {
  return createHash("sha256").update(`${origin}\0${objectFormat}`).digest("hex");
}

function repoImageRoot(imagesRoot: string, repoKey: string): string {
  return join(imagesRoot, repoKey);
}

function generationDir(imagesRoot: string, pointer: GitImagePointer): string {
  return join(repoImageRoot(imagesRoot, pointer.repoKey), "generations", pointer.generation);
}

function imageGitDir(imagesRoot: string, pointer: GitImagePointer): string {
  return join(generationDir(imagesRoot, pointer), "repo.git");
}

function isPointer(value: unknown): value is GitImagePointer {
  if (value == null || typeof value !== "object") return false;
  const p = value as Partial<GitImagePointer>;
  return p.version === CELL_GIT_IMAGE_VERSION
    && typeof p.repoKey === "string"
    && /^[0-9a-f]{64}$/.test(p.repoKey)
    && typeof p.origin === "string"
    && (p.objectFormat === "sha1" || p.objectFormat === "sha256")
    && typeof p.generation === "string"
    && GENERATION_RE.test(p.generation)
    && typeof p.anchorSha === "string"
    && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(p.anchorSha)
    && typeof p.createdAt === "number"
    && Number.isFinite(p.createdAt);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function samePointer(a: GitImagePointer, b: GitImagePointer): boolean {
  return a.version === b.version
    && a.repoKey === b.repoKey
    && a.origin === b.origin
    && a.objectFormat === b.objectFormat
    && a.generation === b.generation
    && a.anchorSha === b.anchorSha
    && a.createdAt === b.createdAt;
}

/** Read only a fully-published, internally-consistent image generation. */
export function readCurrentGitImage(imagesRoot: string, originRepo: string): GitImagePointer | null {
  let origin: string;
  let objectFormat: "sha1" | "sha256";
  let repoKey: string;
  try {
    origin = canonicalOrigin(originRepo);
    objectFormat = objectFormatOf(originRepo);
    repoKey = repoKeyOf(origin, objectFormat);
  } catch {
    return null;
  }
  const pointer = readJson(join(repoImageRoot(imagesRoot, repoKey), "current.json"));
  if (!isPointer(pointer)) return null;
  if (pointer.repoKey !== repoKey || pointer.origin !== origin || pointer.objectFormat !== objectFormat) return null;
  const manifest = readJson(join(generationDir(imagesRoot, pointer), "image.json"));
  if (!isPointer(manifest) || !samePointer(pointer, manifest)) return null;
  const repoGit = imageGitDir(imagesRoot, pointer);
  if (!existsSync(join(repoGit, "HEAD")) || !existsSync(join(repoGit, "objects", "pack"))) return null;
  try {
    if (readFileSync(join(repoGit, "refs", "hive", "image", "anchor"), "utf8").trim() !== pointer.anchorSha) return null;
  } catch {
    return null;
  }
  return pointer;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function configureFreshCellGit(spaceDir: string, originRepo: string, emptyHooksDir: string): void {
  mkdirSync(emptyHooksDir, { recursive: true });
  git(spaceDir, ["config", "core.hooksPath", emptyHooksDir]);
  git(spaceDir, ["config", "core.fsmonitor", "false"]);
  const remote = tryGit(originRepo, ["remote", "get-url", "origin"]);
  if (remote.status === 0 && remote.stdout.trim().length > 0) {
    git(spaceDir, ["remote", "add", "origin", remote.stdout.trim()]);
    const push = tryGit(originRepo, ["remote", "get-url", "--push", "origin"]);
    if (push.status === 0 && push.stdout.trim().length > 0 && push.stdout.trim() !== remote.stdout.trim()) {
      git(spaceDir, ["remote", "set-url", "--push", "origin", push.stdout.trim()]);
    }
  }
}

/**
 * Materialize a fresh `.git` from the current image.  This copies only the
 * image's small pack directory, never the origin's mutable Git metadata.
 * Any validation/copy failure is a cache miss and leaves no partial space.
 */
export function tryMaterializeGitImage(
  imagesRoot: string,
  originRepo: string,
  sha: string,
  spaceDir: string,
  boxDir: string,
  emptyHooksDir: string,
  opts: GitImageOptions = {},
): GitImagePlacement | null {
  const platform = opts.platform === undefined ? cowPlatform() : opts.platform;
  if (platform == null) return null;
  const image = readCurrentGitImage(imagesRoot, originRepo);
  if (image == null) return null;
  const imageRepo = imageGitDir(imagesRoot, image);
  if (!hasCommit(imageRepo, sha) || !probeCow(imageRepo, boxDir, platform)) return null;

  try {
    rmSync(spaceDir, { recursive: true, force: true });
    const initArgs = ["init"];
    if (image.objectFormat === "sha256") initArgs.push("--object-format=sha256");
    initArgs.push(spaceDir);
    git(boxDir, initArgs);
    const destPack = join(spaceDir, ".git", "objects", "pack");
    rmSync(destPack, { recursive: true, force: true });
    if (!cowCopy(platform, join(imageRepo, "objects", "pack"), destPack, { recursive: true })) {
      rmSync(spaceDir, { recursive: true, force: true });
      return null;
    }
    configureFreshCellGit(spaceDir, originRepo, emptyHooksDir);
    if (!hasCommit(spaceDir, sha)) {
      rmSync(spaceDir, { recursive: true, force: true });
      return null;
    }
    return { repoKey: image.repoKey, generation: image.generation };
  } catch {
    rmSync(spaceDir, { recursive: true, force: true });
    return null;
  }
}

function acquireBuildLock(repoRoot: string, now: number): string | null {
  const lockDir = join(repoRoot, "build.lock");
  mkdirSync(repoRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({ token, pid: process.pid, startedAt: now })}\n`);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = readJson(join(lockDir, "owner.json")) as { startedAt?: unknown } | null;
        const startedAt = typeof owner?.startedAt === "number" ? owner.startedAt : statSync(lockDir).mtimeMs;
        stale = now - startedAt > IMAGE_LOCK_STALE_MS;
      } catch {
        stale = now - statSync(lockDir).mtimeMs > IMAGE_LOCK_STALE_MS;
      }
      if (!stale) return null;
      const staleDir = join(repoRoot, `.stale-lock-${randomUUID()}`);
      try {
        renameSync(lockDir, staleDir);
        rmSync(staleDir, { recursive: true, force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

function releaseBuildLock(repoRoot: string, token: string): void {
  const lockDir = join(repoRoot, "build.lock");
  const owner = readJson(join(lockDir, "owner.json")) as { token?: unknown } | null;
  if (owner?.token !== token) return;
  const releasedDir = join(repoRoot, `.released-lock-${token}`);
  try {
    renameSync(lockDir, releasedDir);
    rmSync(releasedDir, { recursive: true, force: true });
  } catch {
    // A concurrent stale-lock recovery owns cleanup now.
  }
}

function cleanupAbandonedStaging(repoRoot: string): void {
  let entries: string[];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/^\.staging-g-[0-9]+-[0-9a-f-]+$/.test(name)) continue;
    rmSync(join(repoRoot, name), { recursive: true, force: true });
  }
}

function packRevision(
  originRepo: string,
  destGitDir: string,
  sha: string,
  opts: { excludeSha?: string; incremental?: boolean } = {},
): void {
  mkdirSync(join(destGitDir, "objects", "pack"), { recursive: true });
  const base = join(destGitDir, "objects", "pack", "hive");
  const revisions = opts.excludeSha == null ? `${sha}\n` : `${sha}\n^${opts.excludeSha}\n`;
  const args = ["-C", originRepo, "pack-objects", "--quiet", "--revs", "--delta-base-offset"];
  if (opts.incremental === true) args.push("--incremental");
  args.push(base);
  const result = spawnSync(
    "git",
    args,
    { encoding: "utf8", env: gitEnv(), input: revisions },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cell git image: pack-objects failed (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
}

function commonGitDir(originRepo: string): string {
  const result = tryGit(originRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const raw = result.status === 0
    ? result.stdout.trim()
    : git(originRepo, ["rev-parse", "--git-common-dir"]);
  return realpathSync(isAbsolute(raw) ? raw : resolve(originRepo, raw));
}

/**
 * Seed the first generation from the origin's immutable pack files by CoW.
 * This shares the large existing packs physically; packRevision then writes
 * only reachable loose objects into a new image-owned pack.
 */
function seedOriginPacks(
  originRepo: string,
  destGitDir: string,
  platform: CowPlatform | null,
): boolean {
  if (platform == null) return false;
  let src: string;
  try {
    src = join(commonGitDir(originRepo), "objects", "pack");
    if (!existsSync(src)) return false;
  } catch {
    return false;
  }
  const dest = join(destGitDir, "objects", "pack");
  rmSync(dest, { recursive: true, force: true });
  if (!cowCopy(platform, src, dest, { recursive: true })) {
    mkdirSync(dest, { recursive: true });
    return false;
  }

  // A concurrent origin repack can expose temporary/MIDX state. Images need
  // only complete immutable pack families, so discard everything else.
  const familyRe = /^(pack-[0-9a-f]{40,64})\.(pack|idx|rev|bitmap|promisor|keep)$/;
  const families = new Map<string, Set<string>>();
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    const match = entry.isFile() ? familyRe.exec(entry.name) : null;
    if (match == null) {
      rmSync(join(dest, entry.name), { recursive: true, force: true });
      continue;
    }
    const base = match[1] as string;
    const extension = match[2] as string;
    const extensions = families.get(base) ?? new Set<string>();
    extensions.add(extension);
    families.set(base, extensions);
  }
  for (const [base, extensions] of families) {
    if (extensions.has("pack") && extensions.has("idx")) continue;
    for (const extension of extensions) rmSync(join(dest, `${base}.${extension}`), { force: true });
    families.delete(base);
  }
  return families.size > 0;
}

function initBare(repoRoot: string, destGitDir: string, objectFormat: "sha1" | "sha256"): void {
  const args = ["init", "--bare"];
  if (objectFormat === "sha256") args.push("--object-format=sha256");
  args.push(destGitDir);
  git(repoRoot, args);
}

function copyPreviousPacks(
  imagesRoot: string,
  current: GitImagePointer,
  destGitDir: string,
  platform: CowPlatform | null,
): boolean {
  const src = join(imageGitDir(imagesRoot, current), "objects", "pack");
  const dest = join(destGitDir, "objects", "pack");
  rmSync(dest, { recursive: true, force: true });
  if (platform != null && cowCopy(platform, src, dest, { recursive: true })) return true;
  try {
    cpSync(src, dest, { recursive: true, preserveTimestamps: true });
    return true;
  } catch {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    return false;
  }
}

function validatePackedImage(repoGit: string, sha: string): void {
  if (!hasCommit(repoGit, sha)) throw new Error(`cell git image: packed image is missing ${sha}`);
  git(repoGit, ["fsck", "--connectivity-only", "--no-dangling", sha]);
  const objectsDir = join(repoGit, "objects");
  for (const entry of readdirSync(objectsDir, { withFileTypes: true })) {
    if (entry.name !== "pack" && entry.name !== "info") {
      throw new Error(`cell git image: loose object fanout ${entry.name} is not publishable`);
    }
  }
}

function packCount(repoGit: string): number {
  return readdirSync(join(repoGit, "objects", "pack")).filter((name) => name.endsWith(".pack")).length;
}

function cleanupOldGenerations(repoRoot: string, current: GitImagePointer, now: number): void {
  const generationsDir = join(repoRoot, "generations");
  let entries: string[];
  try {
    entries = readdirSync(generationsDir).filter((name) => GENERATION_RE.test(name));
  } catch {
    return;
  }
  const newest = entries
    .map((name) => ({ name, mtime: statSync(join(generationsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const retained = new Set(newest.slice(0, 2).map((entry) => entry.name));
  retained.add(current.generation);
  for (const entry of newest) {
    if (retained.has(entry.name) || now - entry.mtime < GENERATION_GRACE_MS) continue;
    rmSync(join(generationsDir, entry.name), { recursive: true, force: true });
  }
}

/**
 * Build or extend the immutable image for `sha`, publishing it atomically.
 * Call only from the dedicated Cell worker, either while resolving a
 * provisioning miss or during post-turn maintenance.
 */
export function refreshGitImage(
  imagesRoot: string,
  originRepo: string,
  sha: string,
  opts: GitImageOptions = {},
): GitImageRefreshResult {
  if (!hasCommit(originRepo, sha)) throw new Error(`cell git image: origin does not contain commit ${sha}`);
  const now = (opts.now ?? Date.now)();
  const platform = opts.platform === undefined ? cowPlatform() : opts.platform;
  const origin = canonicalOrigin(originRepo);
  const objectFormat = objectFormatOf(originRepo);
  const repoKey = repoKeyOf(origin, objectFormat);
  const repoRoot = repoImageRoot(imagesRoot, repoKey);

  const alreadyReady = readCurrentGitImage(imagesRoot, originRepo);
  if (alreadyReady != null && hasCommit(imageGitDir(imagesRoot, alreadyReady), sha)) {
    return { status: "ready", image: alreadyReady };
  }
  const lockToken = acquireBuildLock(repoRoot, now);
  if (lockToken == null) return { status: "busy" };

  const generation = `g-${now}-${randomUUID()}`;
  const stageDir = join(repoRoot, `.staging-${generation}`);
  const stageGit = join(stageDir, "repo.git");
  try {
    cleanupAbandonedStaging(repoRoot);
    // Re-read under the lock: another worker may have published while this
    // worker waited to acquire it.
    const current = readCurrentGitImage(imagesRoot, originRepo);
    if (current != null && hasCommit(imageGitDir(imagesRoot, current), sha)) {
      return { status: "ready", image: current };
    }

    mkdirSync(stageDir, { recursive: true });
    initBare(repoRoot, stageGit, objectFormat);
    let reusedPacks = false;
    if (current != null && current.objectFormat === objectFormat) {
      reusedPacks = copyPreviousPacks(imagesRoot, current, stageGit, platform);
      if (reusedPacks) {
        try {
          packRevision(originRepo, stageGit, sha, { excludeSha: current.anchorSha });
          if (packCount(stageGit) > MAX_IMAGE_PACKS) {
            // Keep hot placement bounded by pack-file count over the lifetime
            // of a busy repository. Compaction is a fresh pack-only rebuild
            // and remains entirely on this maintenance worker.
            rmSync(stageDir, { recursive: true, force: true });
            mkdirSync(stageDir, { recursive: true });
            initBare(repoRoot, stageGit, objectFormat);
            reusedPacks = false;
          }
        } catch {
          // The prior anchor may have disappeared from the origin after GC,
          // or the source may have changed shape. Rebuild cleanly instead of
          // publishing a questionable incremental generation.
          rmSync(stageDir, { recursive: true, force: true });
          mkdirSync(stageDir, { recursive: true });
          initBare(repoRoot, stageGit, objectFormat);
          reusedPacks = false;
        }
      }
    } else {
      reusedPacks = seedOriginPacks(originRepo, stageGit, platform);
      if (reusedPacks) {
        try {
          packRevision(originRepo, stageGit, sha, { incremental: true });
          if (packCount(stageGit) > MAX_IMAGE_PACKS) {
            rmSync(stageDir, { recursive: true, force: true });
            mkdirSync(stageDir, { recursive: true });
            initBare(repoRoot, stageGit, objectFormat);
            reusedPacks = false;
          }
        } catch {
          rmSync(stageDir, { recursive: true, force: true });
          mkdirSync(stageDir, { recursive: true });
          initBare(repoRoot, stageGit, objectFormat);
          reusedPacks = false;
        }
      }
    }
    if (!reusedPacks) packRevision(originRepo, stageGit, sha);
    git(stageGit, ["update-ref", "refs/hive/image/anchor", sha]);
    try {
      validatePackedImage(stageGit, sha);
    } catch (error) {
      if (!reusedPacks) throw error;
      // A source repack or alternate-object layout can make a CoW seed
      // incomplete. Rebuild a self-contained generation before publishing.
      rmSync(stageDir, { recursive: true, force: true });
      mkdirSync(stageDir, { recursive: true });
      initBare(repoRoot, stageGit, objectFormat);
      packRevision(originRepo, stageGit, sha);
      git(stageGit, ["update-ref", "refs/hive/image/anchor", sha]);
      validatePackedImage(stageGit, sha);
    }

    const pointer: GitImagePointer = {
      version: CELL_GIT_IMAGE_VERSION,
      repoKey,
      origin,
      objectFormat,
      generation,
      anchorSha: sha,
      createdAt: now,
    };
    writeJsonAtomic(join(stageDir, "image.json"), pointer);
    const finalDir = join(repoRoot, "generations", generation);
    mkdirSync(dirname(finalDir), { recursive: true });
    renameSync(stageDir, finalDir);
    writeJsonAtomic(join(repoRoot, "current.json"), pointer);
    cleanupOldGenerations(repoRoot, pointer, now);
    return { status: "refreshed", image: pointer };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    releaseBuildLock(repoRoot, lockToken);
  }
}
