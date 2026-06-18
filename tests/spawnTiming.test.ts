import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnTimingEnabled, startSpawnTimer } from "../src/spawnTiming.js";

test("spawnTimingEnabled honors the documented truthy values", () => {
  for (const value of ["1", "true", "yes", "on"]) {
    assert.equal(spawnTimingEnabled({ HIVE_DEBUG_SPAWN: value } as NodeJS.ProcessEnv), true, value);
  }
  for (const value of [undefined, "", "0", "false", "no", "off"]) {
    assert.equal(spawnTimingEnabled({ HIVE_DEBUG_SPAWN: value } as NodeJS.ProcessEnv), false, String(value));
  }
});

test("disabled timer is a silent no-op", () => {
  const env = {} as NodeJS.ProcessEnv;
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stderr.write;
  try {
    const timer = startSpawnTimer("CL-test", env);
    timer.mark("resolve");
    timer.mark("ready");
    timer.report();
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(writes, []);
});

test("enabled timer reports every marked phase under the final label", () => {
  const env = { HIVE_DEBUG_SPAWN: "1" } as NodeJS.ProcessEnv;
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stderr.write;
  try {
    const timer = startSpawnTimer("requested-token", env);
    timer.mark("resolve");
    timer.mark("activate");
    timer.mark("ready");
    timer.report("CL-final");
  } finally {
    process.stderr.write = original;
  }
  assert.equal(writes.length, 1);
  const line = writes[0]!;
  // Final label (from report) wins over the start label.
  assert.match(line, /^spawn-timing CL-final: total \d+ms/);
  assert.match(line, /resolve \d+ms · activate \d+ms · ready \d+ms/);
  assert.doesNotMatch(line, /requested-token/);
});
