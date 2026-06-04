import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { spawnDetachedRun } from "./src/flow/background.js";
import { defineFlow } from "./src/flow/index.js";
import { readMeta, runDir as runDirF, runLogPath } from "./src/flow/runs.js";

const storeDir = await mkdtemp(join(tmpdir(), "honeybee-debug-"));
process.env.HIVE_STORE_ROOT = storeDir;
console.log("storeDir:", storeDir);

const fixtureDir = await mkdtemp(join(tmpdir(), "honeybee-fix-"));
const fixture = join(fixtureDir, "fixture.cjs");
await writeFile(fixture, `
const { mkdir, writeFile, readFile, stat } = require('node:fs/promises');
const { join } = require('node:path');
async function main() {
  const runId = process.argv[2];
  let flowName;
  for (let i = 3; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--flow') flowName = process.argv[i + 1];
  }
  if (!runId || !flowName) { console.error('missing args', process.argv); process.exit(2); }
  const root = process.env.HIVE_STORE_ROOT;
  const runDir = join(root, 'flows', flowName, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const metaPath = join(runDir, 'meta.json');
  const raw = await readFile(metaPath, 'utf8');
  const meta = JSON.parse(raw);
  const endedAt = new Date().toISOString();
  const finalMeta = { ...meta, status: 'ok', endedAt };
  await writeFile(metaPath, JSON.stringify(finalMeta, null, 2) + '\\n');
  const result = {
    runId, flowName, status: 'ok',
    startedAt: meta.startedAt, endedAt, value: 'fixture-ok',
  };
  await writeFile(join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\\n');
}
main().catch((error) => { console.error(error); process.exit(1); });
`);

const flow = defineFlow({ name: "bg-meta", run: async () => "noop" });
const result = await spawnDetachedRun(flow, { x: 1 }, { entryOverride: fixture });
console.log("result:", result);
const logPath = runLogPath("bg-meta", result.runId);
console.log("log path:", logPath);
// wait
await new Promise(r => setTimeout(r, 1500));
console.log("log contents:");
try { console.log(await readFile(logPath, "utf8")); } catch(e) { console.log("(no log)", e.message); }
const meta = await readMeta("bg-meta", result.runId);
console.log("final meta:", meta);
await rm(storeDir, { recursive: true, force: true });
await rm(fixtureDir, { recursive: true, force: true });
