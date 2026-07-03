import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defineFlow,
  defineFlowFromFile,
  flowExists,
  BUILTIN_FLOW_NAMES,
  listFlows,
  loadFlow,
  loadFlowSource,
  removeFlow,
  validFlowName,
  validateFlow,
  type BeeHandle,
  type Flow,
  type FlowContext,
  type FlowHive,
  type FlowSpawnInput,
} from "../src/flow/index.js";
import { parseJsonFlow, substituteString } from "../src/flow/json.js";

/* ------------------------------------------------------------------ */
/*  Test harness — temp HIVE_STORE_ROOT and mock FlowContext.         */
/* ------------------------------------------------------------------ */

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-flow-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

type Call = { op: string; args: unknown[] };

function makeMockHive(): { hive: FlowHive; calls: Call[]; nextId: () => string } {
  const calls: Call[] = [];
  let counter = 0;
  const nextId = () => `bee-${counter += 1}`;
  const hive: FlowHive = {
    spawn: async (spec: FlowSpawnInput) => {
      calls.push({ op: "spawn", args: [spec] });
      const handle: BeeHandle = {
        id: nextId(),
        name: spec.name ?? `${spec.bee}-test`,
        agent: spec.bee,
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        ...(spec.node !== undefined ? { node: spec.node } : {}),
      };
      return handle;
    },
    send: async (target, text) => { calls.push({ op: "send", args: [target, text] }); },
    brief: async (target, text) => { calls.push({ op: "brief", args: [target, text] }); },
    waitForSeal: async (target, opts) => { calls.push({ op: "waitForSeal", args: [target, opts] }); return null; },
    wait: async (target, opts) => { calls.push({ op: "wait", args: [target, opts] }); },
    kill: async (target) => { calls.push({ op: "kill", args: [target] }); },
    seal: async (target, from) => { calls.push({ op: "seal", args: [target, from] }); return null; },
    log: (msg) => { calls.push({ op: "log", args: [msg] }); },
  };
  return { hive, calls, nextId };
}

function makeCtx(overrides: Partial<FlowContext> = {}): FlowContext {
  const mock = makeMockHive();
  return {
    runId: "20990101-deadbeef",
    flowName: "test",
    args: {},
    bindings: {},
    hive: mock.hive,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  defineFlow                                                        */
/* ------------------------------------------------------------------ */

test("defineFlow returns a Flow with defaults applied", () => {
  const flow = defineFlow({
    name: "review",
    run: async () => "ok",
  });
  assert.equal(flow.name, "review");
  assert.equal(flow.cleanup, "keep");
  assert.equal(typeof flow.run, "function");
});

test("defineFlow rejects invalid names", () => {
  assert.throws(() => defineFlow({ name: "bad name!", run: async () => undefined }), /invalid name/i);
  assert.throws(() => defineFlow({ name: "", run: async () => undefined }), /invalid name/i);
});

test("defineFlow requires run to be a function", () => {
  assert.throws(
    () => defineFlow({ name: "x", run: undefined as unknown as Flow["run"] }),
    /must define run/,
  );
});

test("defineFlow accepts kill-on-end cleanup", () => {
  const flow = defineFlow({ name: "k", cleanup: "kill-on-end", run: async () => undefined });
  assert.equal(flow.cleanup, "kill-on-end");
});

test("defineFlow normalizes args", () => {
  const flow = defineFlow({
    name: "n",
    args: [{ name: "target", default: "src" }, { name: "model" }],
    run: async () => undefined,
  });
  assert.equal(flow.args?.length, 2);
  assert.equal(flow.args?.[0]?.name, "target");
  assert.equal(flow.args?.[0]?.default, "src");
  assert.equal(flow.args?.[1]?.default, undefined);
});

test("validFlowName allows dotted/dashed identifiers but rejects spaces", () => {
  assert.equal(validFlowName("review"), true);
  assert.equal(validFlowName("review.v2"), true);
  assert.equal(validFlowName("review-pipeline_1"), true);
  assert.equal(validFlowName(""), false);
  assert.equal(validFlowName("has space"), false);
  assert.equal(validFlowName("-leading"), false);
});

/* ------------------------------------------------------------------ */
/*  parseJsonFlow                                                     */
/* ------------------------------------------------------------------ */

test("parseJsonFlow compiles a simple sequential flow", async () => {
  const flow = parseJsonFlow({
    name: "review",
    description: "Single-bee review",
    steps: [
      { op: "spawn", as: "arch", bee: "claude" },
      { op: "brief", to: "{{arch.id}}", text: "Review the repo." },
      { op: "waitForSeal", of: "{{arch.id}}" },
    ],
  });
  assert.equal(flow.name, "review");
  assert.equal(flow.description, "Single-bee review");
  assert.equal(flow.cleanup, "keep");

  const mock = makeMockHive();
  const ctx = makeCtx({ hive: mock.hive });
  await flow.run(ctx);

  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls[0]?.op, "spawn");
  assert.equal(mock.calls[1]?.op, "brief");
  // The {{arch.id}} placeholder must have resolved to the BeeHandle.id.
  assert.equal(mock.calls[1]?.args[0], "bee-1");
  assert.equal(mock.calls[1]?.args[1], "Review the repo.");
  assert.equal(mock.calls[2]?.op, "waitForSeal");
  assert.equal(mock.calls[2]?.args[0], "bee-1");
});

test("parseJsonFlow rejects an empty steps array", () => {
  assert.throws(() => parseJsonFlow({ name: "x", steps: [] }), /non-empty array/);
});

test("parseJsonFlow rejects missing name", () => {
  assert.throws(() => parseJsonFlow({ steps: [{ op: "log", message: "hi" }] }), /missing or invalid name/);
});

test("parseJsonFlow rejects an unknown op", () => {
  assert.throws(
    () => parseJsonFlow({ name: "x", steps: [{ op: "teleport", to: "anywhere" }] }),
    /unknown op "teleport"/,
  );
});

test("parseJsonFlow rejects bad spawn shape", () => {
  assert.throws(
    () => parseJsonFlow({ name: "x", steps: [{ op: "spawn", as: "1bad name", bee: "claude" }] }),
    /'as' must be a valid binding name/,
  );
  assert.throws(
    () => parseJsonFlow({ name: "x", steps: [{ op: "spawn", as: "a", bee: "" }] }),
    /'bee' must be a non-empty string/,
  );
});

test("parseJsonFlow rejects bad send/brief shape", () => {
  assert.throws(
    () => parseJsonFlow({ name: "x", steps: [{ op: "send", to: "", text: "hi" }] }),
    /'to' must be a non-empty string/,
  );
  assert.throws(
    () => parseJsonFlow({ name: "x", steps: [{ op: "brief", to: "a", text: 5 }] }),
    /'text' must be a string/,
  );
});

test("parseJsonFlow rejects bad wait shape", () => {
  assert.throws(
    () => parseJsonFlow({ name: "x", steps: [{ op: "wait", of: "a", idleMs: -1 }] }),
    /'idleMs' must be a non-negative number/,
  );
});

test("parseJsonFlow rejects bad seal shape", () => {
  assert.throws(
    () => parseJsonFlow({ name: "x", steps: [{ op: "seal", of: "a", from: "" }] }),
    /'from' must be a non-empty string/,
  );
});

test("parseJsonFlow enforces expectedName when supplied", () => {
  assert.throws(
    () => parseJsonFlow({ name: "actual", steps: [{ op: "log", message: "hi" }] }, { expectedName: "expected" }),
    /Flow name mismatch/,
  );
});

test("parseJsonFlow honors return op short-circuit", async () => {
  const flow = parseJsonFlow({
    name: "r",
    steps: [
      { op: "log", message: "before" },
      { op: "return", value: 42 },
      { op: "log", message: "never" },
    ],
  });
  const mock = makeMockHive();
  const result = await flow.run(makeCtx({ hive: mock.hive }));
  assert.equal(result, 42);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]?.op, "log");
  assert.equal(mock.calls[0]?.args[0], "before");
});

test("parseJsonFlow passes timeoutMs through waitForSeal opts", async () => {
  const flow = parseJsonFlow({
    name: "t",
    steps: [
      { op: "spawn", as: "a", bee: "claude" },
      { op: "waitForSeal", of: "{{a.id}}", timeoutMs: 1234 },
    ],
  });
  const mock = makeMockHive();
  await flow.run(makeCtx({ hive: mock.hive }));
  assert.deepEqual(mock.calls[1]?.args[1], { timeoutMs: 1234 });
});

test("parseJsonFlow honors abort signal between steps", async () => {
  const flow = parseJsonFlow({
    name: "abrt",
    steps: [
      { op: "log", message: "first" },
      { op: "log", message: "second" },
    ],
  });
  const controller = new AbortController();
  const mock = makeMockHive();
  // Wrap log to abort after the first call.
  const originalLog = mock.hive.log;
  mock.hive.log = (msg: string) => {
    const result = originalLog.call(mock.hive, msg);
    controller.abort();
    return result;
  };
  await assert.rejects(
    async () => { await flow.run(makeCtx({ hive: mock.hive, signal: controller.signal })); },
    /aborted at step #1/,
  );
  assert.equal(mock.calls.length, 1);
});

/* ------------------------------------------------------------------ */
/*  substituteString                                                  */
/* ------------------------------------------------------------------ */

test("substituteString resolves bindings via dotted paths", () => {
  const ctx = makeCtx({
    bindings: { arch: { id: "bee-9", name: "arch1", agent: "claude" } },
    args: {},
  });
  assert.equal(substituteString("hello {{arch.id}}", ctx), "hello bee-9");
  assert.equal(substituteString("name={{arch.name}}", ctx), "name=arch1");
});

test("substituteString resolves args ahead of bindings only when bindings miss", () => {
  const ctx = makeCtx({
    bindings: { x: { id: "from-binding", name: "x", agent: "claude" } },
    args: { x: "from-args", target: "src/" },
  });
  // Bindings win for the head identifier.
  assert.equal(substituteString("{{x.id}}", ctx), "from-binding");
  // Args resolve when bindings has no entry.
  assert.equal(substituteString("{{target}}", ctx), "src/");
});

test("substituteString leaves unknown placeholders verbatim", () => {
  const ctx = makeCtx();
  assert.equal(substituteString("hi {{nope.xyz}}", ctx), "hi {{nope.xyz}}");
});

test("substituteString stringifies numbers and booleans", () => {
  const ctx = makeCtx({ args: { count: 3, ok: true } });
  assert.equal(substituteString("n={{count}} ok={{ok}}", ctx), "n=3 ok=true");
});

test("substituteString rejects bracket/function syntax by treating it as literal text", () => {
  const ctx = makeCtx({ args: { items: ["a", "b"] } });
  // The regex only accepts [A-Za-z0-9_.-], so anything with '[' won't match —
  // the placeholder is left in place, making the bad path visible to the bee.
  assert.equal(substituteString("{{items[0]}}", ctx), "{{items[0]}}");
  assert.equal(substituteString("{{items.foo()}}", ctx), "{{items.foo()}}");
});

/* ------------------------------------------------------------------ */
/*  Registry CRUD                                                     */
/* ------------------------------------------------------------------ */

const REVIEW_JSON = {
  name: "review",
  description: "Single-bee review",
  args: [{ name: "target", default: "src" }],
  cleanup: "keep" as const,
  steps: [
    { op: "spawn", as: "arch", bee: "claude", cwd: "{{target}}" },
    { op: "brief", to: "{{arch.id}}", text: "Review {{target}}." },
    { op: "waitForSeal", of: "{{arch.id}}" },
  ],
};

test("defineFlowFromFile imports a JSON flow and listFlows returns it", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "incoming.json");
    await writeFile(source, JSON.stringify(REVIEW_JSON));
    const defined = await defineFlowFromFile(source);
    assert.equal(defined.name, "review");
    assert.equal(await flowExists("review"), true);

    const list = await listFlows();
    const builtins = new Set(BUILTIN_FLOW_NAMES);
    assert.deepEqual(list.map((f) => f.name).filter((n) => !builtins.has(n)), ["review"]);
  });
});

test("defineFlowFromFile records the absolute source path", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify(REVIEW_JSON));
    await defineFlowFromFile(source);
    const remembered = await loadFlowSource("review");
    assert.equal(remembered, source);
  });
});

test("loadFlow round-trips JSON content and re-compiles run()", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify(REVIEW_JSON));
    await defineFlowFromFile(source);

    const loaded = await loadFlow("review");
    assert.ok(loaded);
    assert.equal(loaded.name, "review");
    assert.equal(loaded.args?.[0]?.default, "src");

    const mock = makeMockHive();
    const ctx = makeCtx({
      hive: mock.hive,
      args: { target: "src/cli.ts" },
    });
    await loaded.run(ctx);
    assert.equal(mock.calls[0]?.op, "spawn");
    assert.deepEqual(mock.calls[0]?.args[0], { bee: "claude", cwd: "src/cli.ts" });
    assert.equal(mock.calls[1]?.args[1], "Review src/cli.ts.");
  });
});

test("defineFlowFromFile rewrites name when nameOverride is supplied", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify(REVIEW_JSON));
    await defineFlowFromFile(source, "house-review");
    assert.equal(await flowExists("house-review"), true);
    assert.equal(await flowExists("review"), false);
    // The stored JSON should declare the renamed identity.
    const root = process.env.HIVE_STORE_ROOT!;
    const stored = JSON.parse(await readFile(join(root, "flows", "house-review.json"), "utf8")) as { name: string };
    assert.equal(stored.name, "house-review");
  });
});

test("defineFlowFromFile rejects missing name field", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "bad.json");
    await writeFile(source, JSON.stringify({ steps: [{ op: "log", message: "hi" }] }));
    await assert.rejects(defineFlowFromFile(source), /missing or invalid name/);
  });
});

test("defineFlowFromFile rejects missing steps field", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "bad.json");
    await writeFile(source, JSON.stringify({ name: "x" }));
    await assert.rejects(defineFlowFromFile(source), /steps must be a non-empty array/);
  });
});

test("defineFlowFromFile rejects unsupported extension", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "flow.yaml");
    await writeFile(source, "name: x\nsteps: []\n");
    await assert.rejects(defineFlowFromFile(source), /Unsupported flow source extension/);
  });
});

test("defineFlowFromFile rejects an unknown op", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "bad.json");
    await writeFile(source, JSON.stringify({ name: "x", steps: [{ op: "explode" }] }));
    await assert.rejects(defineFlowFromFile(source), /unknown op "explode"/);
  });
});

test("removeFlow deletes both .ts and .json siblings + source pointer", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify(REVIEW_JSON));
    await defineFlowFromFile(source);
    assert.equal(await removeFlow("review"), true);
    assert.equal(await loadFlow("review"), null);
    assert.equal(await loadFlowSource("review"), null);
    assert.equal(await removeFlow("review"), false);
  });
});

test("loadFlow returns null when no source exists", async () => {
  await withTempStore(async () => {
    assert.equal(await loadFlow("nonexistent"), null);
    assert.equal(await flowExists("nonexistent"), false);
  });
});

test("loadFlow rejects path-traversal names instead of executing files outside the store", async () => {
  await withTempStore(async (dir) => {
    // Plant a fully valid .ts flow OUTSIDE the flows dir. "../evil" would
    // resolve to <dir>/flows/../evil.ts = this file; loading it would mean
    // arbitrary TS execution.
    await writeFile(
      join(dir, "evil.ts"),
      `export default { name: "evil", run: async () => "pwned" };\n`,
    );
    assert.equal(await loadFlow("../evil"), null);
    assert.equal(await flowExists("../evil"), false);
    assert.equal(await loadFlowSource("../evil"), null);
  });
});

test("removeFlow rejects path-traversal names instead of deleting files outside the store", async () => {
  await withTempStore(async (dir) => {
    await writeFile(join(dir, "victim.json"), "{}");
    assert.equal(await removeFlow("../victim"), false);
    // The out-of-store file must survive.
    assert.equal(await readFile(join(dir, "victim.json"), "utf8"), "{}");
  });
});

test("validateFlow auto-compiles a JSON shape arriving via TS default export", () => {
  // Simulates the case where a TS file ends up exporting a JSON-shaped object
  // (rare but legal) — validateFlow should route it through parseJsonFlow.
  const compiled = validateFlow({
    name: "auto",
    steps: [{ op: "log", message: "hi" }],
  });
  assert.equal(compiled.name, "auto");
  assert.equal(typeof compiled.run, "function");
});

test("listFlows mixes .ts and .json registry entries", async () => {
  await withTempStore(async (dir) => {
    // Register a JSON flow.
    const jsonSource = join(dir, "json-flow.json");
    await writeFile(jsonSource, JSON.stringify({ ...REVIEW_JSON, name: "a-json" }));
    await defineFlowFromFile(jsonSource);

    // Register a TS flow.
    const tsSource = join(dir, "ts-flow.ts");
    await writeFile(
      tsSource,
      `import { defineFlow } from "${join(process.cwd(), "src/flow/index.ts")}";\n` +
      `const flow = defineFlow({ name: "b-ts", run: async () => "ok" });\n` +
      `export default flow;\n`,
    );
    await defineFlowFromFile(tsSource);

    const flows = await listFlows();
    // listFlows() also surfaces built-in flows (e.g. `loop`); filter them out
    // to assert the on-disk .ts/.json mixing behavior this test covers.
    const builtins = new Set(BUILTIN_FLOW_NAMES);
    assert.deepEqual(flows.map((f) => f.name).filter((n) => !builtins.has(n)), ["a-json", "b-ts"]);
    // The built-in loop flow is always present.
    assert.ok(flows.some((f) => f.name === "loop"));
  });
});

test("loadFlow falls back to the recorded .source path when the registry TS copy cannot import (relative imports)", async () => {
  await withTempStore(async (dir) => {
    // A TS flow with a RELATIVE import: defineFlowFromFile copies only the
    // single .ts into the registry, so the registry copy's `./helper.js`
    // cannot resolve — loadFlow must fall back to the recorded source path.
    const helper = join(dir, "helper.ts");
    await writeFile(helper, `export const PAYLOAD = "from-helper";\n`);
    const source = join(dir, "with-import.ts");
    await writeFile(
      source,
      `import { defineFlow } from "${join(process.cwd(), "src/flow/index.ts")}";\n` +
      `import { PAYLOAD } from "./helper.js";\n` +
      `export default defineFlow({ name: "with-import", run: async () => PAYLOAD });\n`,
    );
    await defineFlowFromFile(source);

    const loaded = await loadFlow("with-import");
    assert.ok(loaded, "flow must load via the source fallback");
    assert.equal(loaded?.name, "with-import");
    const result = await loaded!.run(makeCtx());
    assert.equal(result, "from-helper");

    // And it must not silently vanish from the flow list either.
    const flows = await listFlows();
    const entry = flows.find((f) => f.name === "with-import");
    assert.ok(entry);
    assert.equal(entry?.loadError, undefined);
  });
});

test("listFlows surfaces an unloadable flow with a loadError marker instead of hiding it", async () => {
  await withTempStore(async (dir) => {
    // Write a broken TS flow straight into the registry (no .source recorded):
    // its import can never resolve, so loadFlow throws.
    const flowsDir = join(dir, "flows");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(flowsDir, "broken.ts"),
      `import { nope } from "./this-module-does-not-exist.js";\nexport default nope;\n`,
    );

    await assert.rejects(() => loadFlow("broken"));

    const flows = await listFlows();
    const broken = flows.find((f) => f.name === "broken");
    assert.ok(broken, "the broken flow must still appear in the list");
    assert.ok(broken?.loadError, "loadError marks the entry as unloadable");
    assert.match(broken?.description ?? "", /unloadable/);
    await assert.rejects(async () => {
      await broken!.run(makeCtx());
    }, /failed to load/);
  });
});

test("loadFlow loads a TS flow via tsLoader (dynamic import)", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "ts-flow.ts");
    await writeFile(
      source,
      `import { defineFlow } from "${join(process.cwd(), "src/flow/index.ts")}";\n` +
      `export default defineFlow({\n` +
      `  name: "ts-flow",\n` +
      `  description: "TS authored",\n` +
      `  args: [{ name: "n", default: 1 }],\n` +
      `  run: async () => "result",\n` +
      `});\n`,
    );
    await defineFlowFromFile(source);
    const loaded = await loadFlow("ts-flow");
    assert.ok(loaded);
    assert.equal(loaded.name, "ts-flow");
    assert.equal(loaded.description, "TS authored");
    assert.equal(loaded.args?.[0]?.default, 1);
    // The TS run() should be callable and return its sentinel value.
    const result = await loaded.run(makeCtx());
    assert.equal(result, "result");
  });
});
