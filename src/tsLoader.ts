import { pathToFileURL } from "node:url";

export async function loadTsModule(path: string, options: { kind?: string } = {}): Promise<unknown> {
  try {
    const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
    if (module.default === undefined) {
      throw new Error(`TS ${options.kind ?? "module"} at ${path} has no default export`);
    }
    return module.default;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRuntimeUnavailable(error, message, path)) {
      throw new Error(
        `Cannot load TS ${options.kind ?? "module"} ${path}: TypeScript runtime not available. Run via 'tsx' (the development entry) or convert the source to .json.`,
      );
    }
    throw error;
  }
}

/**
 * Only map an import failure to "TypeScript runtime not available" when the
 * module ITSELF could not be loaded: a `.ts` extension plain node refuses
 * (ERR_UNKNOWN_FILE_EXTENSION), or a "Cannot find module" whose unresolved
 * specifier is the loaded path. A missing import INSIDE the user's module
 * (e.g. a typo'd relative import) is the author's bug, not a broken runtime —
 * its original error must be preserved.
 */
function isRuntimeUnavailable(error: unknown, message: string, path: string): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ERR_UNKNOWN_FILE_EXTENSION" || /Unknown file extension/.test(message)) return true;
  const match = /Cannot find module '([^']+)'/.exec(message);
  if (!match) return false;
  const specifier = match[1]!;
  return specifier === path || specifier === pathToFileURL(path).href;
}
