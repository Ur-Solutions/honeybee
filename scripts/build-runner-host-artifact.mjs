#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageRunnerHostArtifact } from "./runner-host-artifact.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  throw new Error("package.json has no version for the runner-host artifact");
}
const entryPoint = join(root, "src", "hsr", "remoteHost.ts");
const outDir = join(root, "dist", "hsr", "artifacts");
const result = await stageRunnerHostArtifact({ root, outDir, entryPoint, packageVersion: pkg.version });
process.stdout.write(
  `runner-host artifact ${result.digest} (${result.bytes} bytes) staged under ${dirname(result.artifactPath)}\n`,
);
