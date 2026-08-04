import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resetConfigCache, preambleConfig } from "../src/config.js";
import { preambleChannelForAgent, systemPromptArgsForAgent } from "../src/drivers.js";
import {
  hasPreamble,
  identityLayer,
  prependPreamble,
  PREAMBLE_CLOSE_TAG,
  PREAMBLE_MAX_CHARS,
  PREAMBLE_OPEN_TAG,
  renderPreamble,
} from "../src/preamble.js";
import { planSpawnPreamble } from "../src/spawnPreamble.js";

async function withTempConfig(contents: object | null, fn: () => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-preamble-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  if (contents) await writeFile(join(dir, "config.json"), JSON.stringify(contents, null, 2));
  resetConfigCache();
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
}

const IDENTITY = { name: "scout-3", id: "CL.a1b", comb: "scout-3" };

// ── rendering ───────────────────────────────────────────────────────────────

test("identityLayer states the facts a bee cannot derive", () => {
  const text = identityLayer({ ...IDENTITY, parent: "CL.xyz" });
  assert.match(text, /CL\.a1b/);
  assert.match(text, /"scout-3"/);
  assert.match(text, /spawned by CL\.xyz/);
  // The buz invocation shape is not guessable, so it must be spelled out with
  // this bee's own name already substituted into --sender.
  assert.match(text, /hive buz send <bee> --sender scout-3 -p/);
  assert.doesNotMatch(text, /--tier/);
});

test("identityLayer omits the comb line when the comb is the bee's own name", () => {
  assert.doesNotMatch(identityLayer(IDENTITY), /in comb/);
  assert.match(identityLayer({ ...IDENTITY, comb: "swarm-7" }), /in comb "swarm-7"/);
});

test("identityLayer omits the parent line for an operator-spawned root", () => {
  assert.doesNotMatch(identityLayer(IDENTITY), /spawned by/);
});

test("renderPreamble wraps layers in the strippable tag, in fixed order", () => {
  const { text } = renderPreamble({ identity: IDENTITY, host: "HOST", custom: "CUSTOM" });
  assert.ok(text.startsWith(`${PREAMBLE_OPEN_TAG}\n`));
  assert.ok(text.endsWith(`\n${PREAMBLE_CLOSE_TAG}`));
  assert.ok(text.indexOf("CL.a1b") < text.indexOf("HOST"));
  assert.ok(text.indexOf("HOST") < text.indexOf("CUSTOM"));
});

test("renderPreamble drops empty layers and renders nothing when all are empty", () => {
  assert.equal(renderPreamble({}).text, "");
  assert.equal(renderPreamble({ host: "   ", custom: "" }).text, "");
  const hostOnly = renderPreamble({ host: "HOST" });
  assert.match(hostOnly.text, /HOST/);
  assert.doesNotMatch(hostOnly.text, /Honeybee bee/);
});

test("renderPreamble reports the budget but never truncates", () => {
  const custom = "x".repeat(PREAMBLE_MAX_CHARS * 2);
  const rendered = renderPreamble({ identity: IDENTITY, custom });
  assert.equal(rendered.overBudget, true);
  assert.equal(rendered.chars, rendered.text.length);
  // The whole custom layer survives: truncating mid-sentence is worse than long.
  assert.ok(rendered.text.includes(custom));
});

test("renderPreamble honors a maxChars override", () => {
  assert.equal(renderPreamble({ identity: IDENTITY }, { maxChars: 10 }).overBudget, true);
  assert.equal(renderPreamble({ identity: IDENTITY }, { maxChars: 100_000 }).overBudget, false);
});

/**
 * The budget backstop for the authoring rule. If this fails, someone added
 * explanation to a layer — move it to a kit skill instead of raising the cap.
 * The host layer stands in for Apiary's real one at a generous length.
 */
test("the default identity + host render stays within budget", () => {
  const host = [
    "You are running inside Apiary, a desktop workspace for hive agents.",
    "The `apiary` MCP server is connected: call `self` for your session's surfaces and `setup` for the workspace.",
    "Your sidecars: browser (browser_navigate), terminal shelf (terminal_spawn), whiteboard, rail cards (surface_open).",
    "Read the `apiary` skill before driving them in depth.",
  ].join("\n");
  const rendered = renderPreamble({ identity: { ...IDENTITY, parent: "CL.xyz" }, host });
  assert.equal(rendered.overBudget, false, `default preamble is ${rendered.chars} chars, over ${PREAMBLE_MAX_CHARS}`);
});

test("prependPreamble separates the block from the body, and stands alone", () => {
  assert.equal(prependPreamble("do the thing", "PRE"), "PRE\n\ndo the thing");
  assert.equal(prependPreamble("  ", "PRE"), "PRE");
  assert.equal(prependPreamble(undefined, "PRE"), "PRE");
  assert.equal(prependPreamble("body", ""), "body");
});

test("hasPreamble detects an already-prefixed blob", () => {
  const { text } = renderPreamble({ identity: IDENTITY });
  assert.equal(hasPreamble(prependPreamble("body", text)), true);
  assert.equal(hasPreamble("body"), false);
  assert.equal(hasPreamble(undefined), false);
});

// ── delivery channel ────────────────────────────────────────────────────────

test("harnesses with an append-to-system-prompt flag take the argv channel", () => {
  assert.equal(preambleChannelForAgent("claude"), "system-prompt");
  assert.deepEqual(systemPromptArgsForAgent("claude", "TEXT"), ["--append-system-prompt", "TEXT"]);
  // grok appends via --rules; --system-prompt-override would REPLACE the
  // harness's own prompt and must never be used here.
  assert.equal(preambleChannelForAgent("grok"), "system-prompt");
  assert.deepEqual(systemPromptArgsForAgent("grok", "TEXT"), ["--rules", "TEXT"]);
});

test("harnesses without one fall back to the message channel", () => {
  for (const kind of ["codex", "opencode", "kimi", "cursor", "pi", "droid", "unknown-harness"]) {
    assert.equal(preambleChannelForAgent(kind), "message", kind);
    assert.equal(systemPromptArgsForAgent(kind, "TEXT"), null, kind);
  }
});

test("systemPromptArgsForAgent refuses to emit an empty flag value", () => {
  assert.equal(systemPromptArgsForAgent("claude", ""), null);
});

// ── config + planning ───────────────────────────────────────────────────────

test("preambleConfig defaults to enabled with the identity layer", async () => {
  await withTempConfig(null, () => {
    assert.deepEqual(preambleConfig(), { enabled: true, identity: true });
  });
});

test("preambleConfig drops a nonsensical maxChars rather than warning on every spawn", async () => {
  await withTempConfig({ preamble: { maxChars: 0 } }, () => {
    assert.equal(preambleConfig().maxChars, undefined);
  });
  await withTempConfig({ preamble: { maxChars: -5 } }, () => {
    assert.equal(preambleConfig().maxChars, undefined);
  });
  await withTempConfig({ preamble: { maxChars: 400 } }, () => {
    assert.equal(preambleConfig().maxChars, 400);
  });
});

test("planSpawnPreamble puts claude's preamble in argv and records the channel", async () => {
  await withTempConfig(null, () => {
    const plan = planSpawnPreamble({ kind: "claude", identity: IDENTITY, host: "HOST" });
    assert.ok(plan);
    assert.equal(plan.record.channel, "system-prompt");
    assert.equal(plan.args[0], "--append-system-prompt");
    assert.equal(plan.args[1], plan.record.text);
    assert.match(plan.record.text, /CL\.a1b/);
    assert.match(plan.record.text, /HOST/);
  });
});

test("planSpawnPreamble leaves argv alone on the message channel", async () => {
  await withTempConfig(null, () => {
    const plan = planSpawnPreamble({ kind: "codex", identity: IDENTITY, host: "HOST" });
    assert.ok(plan);
    assert.equal(plan.record.channel, "message");
    assert.deepEqual(plan.args, []);
  });
});

test("planSpawnPreamble layers the operator's config text last", async () => {
  await withTempConfig({ preamble: { text: "CUSTOM" } }, () => {
    const plan = planSpawnPreamble({ kind: "claude", identity: IDENTITY, host: "HOST" });
    assert.ok(plan);
    assert.ok(plan.record.text.indexOf("HOST") < plan.record.text.indexOf("CUSTOM"));
  });
});

test("planSpawnPreamble returns null when disabled by flag or by config", async () => {
  await withTempConfig(null, () => {
    assert.equal(planSpawnPreamble({ kind: "claude", identity: IDENTITY, host: "HOST", disabled: true }), null);
  });
  await withTempConfig({ preamble: { enabled: false } }, () => {
    assert.equal(planSpawnPreamble({ kind: "claude", identity: IDENTITY, host: "HOST" }), null);
  });
});

test("planSpawnPreamble with the identity layer off and no other layer injects nothing", async () => {
  await withTempConfig({ preamble: { identity: false } }, () => {
    assert.equal(planSpawnPreamble({ kind: "claude", identity: IDENTITY }), null);
    // …but a host layer alone still ships.
    const plan = planSpawnPreamble({ kind: "claude", identity: IDENTITY, host: "HOST" });
    assert.ok(plan);
    assert.doesNotMatch(plan.record.text, /CL\.a1b/);
  });
});

test("planSpawnPreamble warns over budget but still injects", async () => {
  await withTempConfig({ preamble: { text: "x".repeat(4000) } }, () => {
    const warnings: string[] = [];
    const plan = planSpawnPreamble({ kind: "claude", identity: IDENTITY, warn: (m) => warnings.push(m) });
    assert.ok(plan);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /scout-3/);
    assert.ok(plan.args.length > 0);
  });
});
