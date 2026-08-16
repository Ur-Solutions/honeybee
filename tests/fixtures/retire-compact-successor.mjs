import { writeFile } from "node:fs/promises";

const built = process.env.HIVE_TEST_BUILT_CLI === "1";
if (!built) await import("tsx");

const lifecycleModule = await import(new URL(
  built ? "../../.test-dist/src/lifecycle.js" : "../../src/lifecycle.ts",
  import.meta.url,
).href);
const runDirModule = await import(new URL(
  built ? "../../.test-dist/src/hsr/runDir.js" : "../../src/hsr/runDir.ts",
  import.meta.url,
).href);
const storeModule = await import(new URL(
  built ? "../../.test-dist/src/store.js" : "../../src/store.ts",
  import.meta.url,
).href);

const bee = process.env.HIVE_TEST_COMPACT_BEE;
const attemptedPath = process.env.HIVE_TEST_COMPACT_ATTEMPTED;
const acquiredPath = process.env.HIVE_TEST_COMPACT_ACQUIRED;
if (!bee || !attemptedPath || !acquiredPath) {
  throw new Error("retire compact successor fixture requires bee and barrier paths");
}

const record = await storeModule.loadSession(bee);
if (!record) throw new Error(`missing compact successor fixture record ${bee}`);
await writeFile(attemptedPath, "attempted\n");

await lifecycleModule.withSessionLifecycleTransaction(record, async (lifecycle) => {
  await writeFile(acquiredPath, "acquired\n");
  const current = await lifecycle.refresh();
  await lifecycle.commit({
    runtimeGeneration: (current.runtimeGeneration ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  });
  await runDirModule.appendHsrEvent(bee, {
    type: "text",
    ts: Date.now(),
    text: "successor-first-event",
  });
});
