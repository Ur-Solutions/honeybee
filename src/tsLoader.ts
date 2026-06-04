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
    if (/Unknown file extension/.test(message) || /Cannot find module/.test(message)) {
      throw new Error(
        `Cannot load TS ${options.kind ?? "module"} ${path}: TypeScript runtime not available. Run via 'tsx' (the development entry) or convert the source to .json.`,
      );
    }
    throw error;
  }
}
