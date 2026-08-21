#!/usr/bin/env node
/**
 * Bundle the v2 CLI (which transitively contains the v2 daemon, RPC surface
 * and core store) into dist/v2/cli.js so the OLD compiled `hive` binary can
 * route `hive v2 …` without a TypeScript loader at runtime. The bundle is
 * plain ESM; only node builtins stay external.
 */
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = join(root, "dist", "v2");
await mkdir(outDir, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "cli", "src", "main.ts")],
  outfile: join(outDir, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
});
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "driver-cell", "src", "provisionWorker.ts")],
  outfile: join(outDir, "provision-worker.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
});
process.stdout.write("v2 cli artifacts staged at dist/v2/cli.js and dist/v2/provision-worker.js\n");
