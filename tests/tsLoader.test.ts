import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTsModule } from "../src/tsLoader.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-tsloader-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadTsModule imports a .ts file's default export", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "module.ts");
    await writeFile(
      target,
      `const payload = { name: "deep-review", castes: [] }; export default payload;\n`,
    );
    const loaded = await loadTsModule(target, { kind: "frame" });
    assert.deepEqual(loaded, { name: "deep-review", castes: [] });
  });
});

test("loadTsModule throws a helpful error when no default export", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "no-default.ts");
    await writeFile(target, `export const named = { x: 1 };\n`);
    await assert.rejects(
      () => loadTsModule(target, { kind: "frame" }),
      /no default export/,
    );
  });
});

test("loadTsModule labels errors with the supplied kind", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "no-default.ts");
    await writeFile(target, `export const named = 1;\n`);
    await assert.rejects(
      () => loadTsModule(target, { kind: "flow" }),
      /TS flow at .* has no default export/,
    );
  });
});

test("loadTsModule preserves the original error for a missing import INSIDE the module", async () => {
  await withTempDir(async (dir) => {
    // Regression: any "Cannot find module" used to be rewritten into
    // "TypeScript runtime not available", misdiagnosing a typo'd import in
    // the user's module as a broken tsx runtime.
    const target = join(dir, "typo-import.ts");
    await writeFile(
      target,
      `import { nope } from "./this-module-does-not-exist.js";\nexport default nope;\n`,
    );
    await assert.rejects(
      () => loadTsModule(target, { kind: "flow" }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Cannot find module/);
        assert.match(message, /this-module-does-not-exist/);
        assert.doesNotMatch(message, /TypeScript runtime not available/);
        return true;
      },
    );
  });
});

test("loadTsModule still maps unknown-extension failures to the runtime-unavailable message", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "module.xyz");
    await writeFile(target, `export default 1;\n`);
    await assert.rejects(
      () => loadTsModule(target, { kind: "flow" }),
      /TypeScript runtime not available/,
    );
  });
});
