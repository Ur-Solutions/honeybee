import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { stageRunnerHostArtifact } from "./runner-host-artifact.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = join(root, ".test-dist");

async function typescriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat();
}

const sourceFiles = await typescriptFiles(join(root, "src"));
const testFiles = await typescriptFiles(join(root, "tests"));

// Transpile the whole graph once instead of starting a tsx/esbuild service in
// every Node test worker. Each file remains a separate ESM module, preserving
// the same process and module boundaries as the source-mode suite.
await build({
  absWorkingDir: root,
  entryPoints: [...sourceFiles, ...testFiles].map((path) => relative(root, path)),
  outbase: ".",
  outdir: outDir,
  bundle: false,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node20",
  logLevel: "warning",
});

// A handful of tests and source modules resolve fixtures/contracts relative to
// import.meta.url. Mirror those non-TypeScript assets beside the transpiled
// modules so that path behavior stays identical.
await Promise.all([
  cp(join(root, "tests", "fixtures"), join(outDir, "tests", "fixtures"), { recursive: true }),
  cp(join(root, "docs"), join(outDir, "docs"), { recursive: true }),
  cp(join(root, "contracts"), join(outDir, "contracts"), { recursive: true }),
]);
await mkdir(join(outDir, "src", "flow"), { recursive: true });
await cp(join(root, "src", "flow", "background.ts"), join(outDir, "src", "flow", "background.ts"));

// Tests execute the same prebuilt artifact contract as a production install.
// Stage once under dist for npm-pack assertions, then mirror the exact bytes
// beside the transpiled module graph used by this test run.
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const stagedArtifacts = join(root, "dist", "hsr", "artifacts");
await stageRunnerHostArtifact({
  root,
  outDir: stagedArtifacts,
  entryPoint: join(root, "src", "hsr", "remoteHost.ts"),
  packageVersion: pkg.version,
});
await cp(stagedArtifacts, join(outDir, "src", "hsr", "artifacts"), { recursive: true, force: true });

const compiledTests = testFiles
  .filter((path) => path.endsWith(".test.ts"))
  .map((path) => relative(root, path).replace(/\.ts$/, ".js"))
  .map((path) => join(".test-dist", path))
  .sort();

await writeFile(
  join(outDir, "test-files.json"),
  `${JSON.stringify(compiledTests, null, 2)}\n`,
);
