/**
 * Cell on-disk layout (WP5, spec 05 point 3).
 *
 *   <cells-root>/<wrapper>/<repo>-space-<id>/   the git checkout (the runtime cwd)
 *   <cells-root>/<wrapper>/box/                 driver-owned metadata: cell.json,
 *                                               sandbox profile, empty hooks dir,
 *                                               capture scratch
 *
 * The `-space-` shape and the wrapper/box split are the reaper/runner
 * compatibility surface (WP7 migrates the old kaia-allocated spaces in
 * place). Keeping cell.json and every other driver artifact inside box/
 * keeps the checkout byte-clean: `git status` inside a fresh cell is empty.
 */
import { basename, join, resolve } from "node:path";

/** Mirrors the old system's CELL_SPACE_DIRECTORY / Apiary's CELL_DIRECTORY_PATTERN. */
export const CELL_SPACE_DIRECTORY = /^[a-z0-9][a-z0-9-]*-space-[a-z0-9]+$/;

export interface CellPaths {
  /** `<cells-root>/<wrapper>` — the cell's root directory. */
  wrapperDir: string;
  /** `<wrapper>/<repo>-space-<id>` — the checkout, the runtime's cwd. */
  spaceDir: string;
  /** The space directory's name (`<repo>-space-<id>`). */
  spaceName: string;
  /** `<wrapper>/box` — driver-owned metadata. */
  boxDir: string;
  /** `<box>/cell.json` — the allocation ledger. */
  ledgerPath: string;
  /** `<box>/hooks-empty` — the empty hooksPath target (CoW hygiene). */
  emptyHooksDir: string;
  /** `<box>/sandbox.sb` — the generated Seatbelt profile (darwin). */
  sandboxProfilePath: string;
}

const SAFE_COMPONENT = /^[a-z0-9][a-z0-9-]*$/;

export function sanitizeComponent(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return cleaned.length > 0 ? cleaned : "cell";
}

export function cellPaths(cellsRoot: string, wrapper: string, repoName: string, cellId: string): CellPaths {
  const w = sanitizeComponent(wrapper);
  const repo = sanitizeComponent(repoName);
  const id = sanitizeComponent(cellId);
  const spaceName = `${repo}-space-${id}`;
  if (!CELL_SPACE_DIRECTORY.test(spaceName)) {
    throw new Error(`cell layout: space name '${spaceName}' violates the -space- shape`);
  }
  const wrapperDir = join(resolve(cellsRoot), w);
  const boxDir = join(wrapperDir, "box");
  return {
    wrapperDir,
    spaceDir: join(wrapperDir, spaceName),
    spaceName,
    boxDir,
    ledgerPath: join(boxDir, "cell.json"),
    emptyHooksDir: join(boxDir, "hooks-empty"),
    sandboxProfilePath: join(boxDir, "sandbox.sb"),
  };
}

/**
 * Inverse of the space-name composition: `<repo>-space-<id>` →
 * `{ repoName, cellId }`. The id half is dash-free by construction, so the
 * LAST `-space-` is the separator even when the repo name itself contains
 * one. Null when the name is not space-shaped.
 */
export function parseSpaceName(spaceName: string): { repoName: string; cellId: string } | null {
  if (!CELL_SPACE_DIRECTORY.test(spaceName)) return null;
  const idx = spaceName.lastIndexOf("-space-");
  if (idx <= 0) return null;
  return { repoName: spaceName.slice(0, idx), cellId: spaceName.slice(idx + "-space-".length) };
}

/**
 * Shape check for destructive operations (spec 05 point 6): a path is only
 * ever deleted when it demonstrably has the cell shape — a wrapper directory
 * containing a `-space-` checkout — so a mis-wired variable can never point
 * the reaper at a user directory.
 */
export function looksLikeCellWrapper(wrapperDir: string, entries: string[]): boolean {
  const name = basename(resolve(wrapperDir));
  if (!SAFE_COMPONENT.test(name)) return false;
  return entries.some((e) => CELL_SPACE_DIRECTORY.test(e));
}
