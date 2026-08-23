#!/usr/bin/env node
/**
 * Stage the dependency-light CLI bootstrap at dist/cli.js while preserving
 * tsc's full legacy dispatcher as dist/cli-legacy.js.
 */
import { copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
await copyFile(join(dist, "cli.js"), join(dist, "cli-legacy.js"));
await copyFile(join(dist, "cli-bootstrap.js"), join(dist, "cli.js"));
process.stdout.write("dependency-light cli entry staged at dist/cli.js\n");
