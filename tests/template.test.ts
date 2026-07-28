import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertTemplateInvocation,
  buildTemplateSpawnPlan,
  interpolateTemplatePrompt,
  templateList,
} from "../src/commands/template.js";
import { parse, type Parsed } from "../src/parse.js";
import {
  defineTemplateFromFile,
  listTemplates,
  loadTemplate,
  loadTemplateSource,
  removeTemplate,
  saveTemplate,
  templatesDir,
  updateTemplateFromSource,
  validTemplateName,
  type AgentTemplate,
} from "../src/template.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-template-"));
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

const COMMIT_INPUT = {
  name: "commit",
  description: "Commit the current tree",
  bee: "codex-auto",
  prompt: "Commit the changes.",
  args: ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"'],
  yolo: false,
  preamble: false as const,
};

test("template names accept safe identifiers and reject dots/path traversal", () => {
  assert.equal(validTemplateName("commit"), true);
  assert.equal(validTemplateName("review-2026"), true);
  assert.equal(validTemplateName("ops_team"), true);
  assert.equal(validTemplateName("has.dot"), false);
  assert.equal(validTemplateName("../escape"), false);
  assert.equal(validTemplateName("-leading"), false);
  assert.equal(validTemplateName(""), false);
});

test("template store CRUD round-trips sanitized fields and timestamps", async () => {
  await withTempStore(async () => {
    const saved = await saveTemplate({
      ...COMMIT_INPUT,
      env: { CI: "1" },
    });
    assert.equal(saved.cwd, "caller");
    assert.equal(saved.yolo, false, "false is a meaningful profile override");
    assert.equal(saved.preamble, false);
    assert.ok(saved.createdAt);
    assert.ok(saved.updatedAt);
    assert.deepEqual(await loadTemplate("commit"), saved);
    assert.deepEqual((await listTemplates()).map((template) => template.name), ["commit"]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await saveTemplate({ ...COMMIT_INPUT, prompt: "Commit atomically." });
    assert.equal(updated.createdAt, saved.createdAt);
    assert.notEqual(updated.updatedAt, saved.updatedAt);
    assert.equal(updated.prompt, "Commit atomically.");

    assert.equal(await removeTemplate("commit"), true);
    assert.equal(await loadTemplate("commit"), null);
    assert.equal(await removeTemplate("commit"), false);
  });
});

test("define/update imports JSON via its remembered .source", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "incoming.json");
    await writeFile(source, JSON.stringify(COMMIT_INPUT));
    const defined = await defineTemplateFromFile(source);
    assert.equal(defined.name, "commit");
    assert.equal(await loadTemplateSource("commit"), source);

    await writeFile(source, JSON.stringify({ ...COMMIT_INPUT, prompt: "Updated prompt." }));
    const updated = await updateTemplateFromSource("commit");
    assert.equal(updated.prompt, "Updated prompt.");
    assert.equal(updated.createdAt, defined.createdAt);
  });
});

test("a renamed JSON template keeps its name override when updated from source", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "incoming.json");
    await writeFile(source, JSON.stringify(COMMIT_INPUT));
    const defined = await defineTemplateFromFile(source, "ship");
    assert.equal(defined.name, "ship");

    await writeFile(source, JSON.stringify({ ...COMMIT_INPUT, prompt: "Ship it." }));
    const updated = await updateTemplateFromSource("ship");
    assert.equal(updated.name, "ship");
    assert.equal(updated.prompt, "Ship it.");
    assert.equal(await loadTemplate("commit"), null);
  });
});

test("define imports TypeScript default exports and update re-imports them", async () => {
  await withTempStore(async (dir) => {
    const source = join(dir, "commit.ts");
    await writeFile(source, `export default ${JSON.stringify(COMMIT_INPUT)};\n`);
    const defined = await defineTemplateFromFile(source);
    assert.equal(defined.name, "commit");
    assert.equal((await loadTemplate("commit"))?.bee, "codex-auto");

    await writeFile(source, `export default ${JSON.stringify({ ...COMMIT_INPUT, bee: "claude-auto" })};\n`);
    const updated = await updateTemplateFromSource("commit");
    assert.equal(updated.bee, "claude-auto");
  });
});

test("store validation rejects invalid names, prompts, cwd, args, and env", async () => {
  await withTempStore(async () => {
    await assert.rejects(saveTemplate({ ...COMMIT_INPUT, name: "../escape" }), /invalid name/i);
    await assert.rejects(saveTemplate({ ...COMMIT_INPUT, prompt: " " }), /prompt must be a non-empty string/);
    await assert.rejects(saveTemplate({ ...COMMIT_INPUT, cwd: "relative/path" }), /cwd must be "caller" or an absolute path/);
    await assert.rejects(saveTemplate({ ...COMMIT_INPUT, args: ["ok", 3] as never }), /args must be an array of strings/);
    await assert.rejects(saveTemplate({ ...COMMIT_INPUT, env: { OK: 1 } as never }), /env must be an object of string values/);
  });
});

test("the defensive reader drops malformed optional fields", async () => {
  await withTempStore(async () => {
    await saveTemplate(COMMIT_INPUT);
    await writeFile(
      join(templatesDir(), "messy.json"),
      JSON.stringify({
        name: "messy",
        bee: "codex",
        prompt: "Do it.",
        cwd: "relative/is/invalid",
        args: ["ok", 42],
        env: { GOOD: "yes", BAD: 1 },
        yolo: "yes",
        bogus: "drop me",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const loaded = await loadTemplate("messy");
    assert.ok(loaded);
    assert.equal(loaded.cwd, "caller");
    assert.equal(loaded.args, undefined);
    assert.deepEqual(loaded.env, { GOOD: "yes" });
    assert.equal(loaded.yolo, undefined);
    assert.equal((loaded as Record<string, unknown>).bogus, undefined);
  });
});

test("template list --json exposes summary fields only", async () => {
  await withTempStore(async () => {
    await saveTemplate(COMMIT_INPUT);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
    try {
      await templateList({
        command: "template",
        args: ["list"],
        flags: new Map([["json", true]]),
        rest: [],
      });
    } finally {
      console.log = original;
    }
    const summaries = JSON.parse(lines.join("\n")) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(summaries[0]!).sort(), ["bee", "description", "name", "updatedAt"]);
    assert.equal(summaries[0]!.description, "Commit the current tree");
    assert.equal(summaries[0]!.prompt, undefined);
  });
});

test("prompt interpolation replaces {{input}}, collapses empty input, and otherwise appends", () => {
  assert.equal(interpolateTemplatePrompt("Review {{input}} now.", "the diff"), "Review the diff now.");
  assert.equal(interpolateTemplatePrompt("{{input}}", ""), "");
  assert.equal(interpolateTemplatePrompt("Review the diff.", "Mention tests."), "Review the diff.\n\nMention tests.");
  assert.equal(interpolateTemplatePrompt("Review the diff.", ""), "Review the diff.");
});

function record(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    ...COMMIT_INPUT,
    cwd: "/template/cwd",
    account: "codex-template",
    env: { SHARED: "template", TEMPLATE_ONLY: "yes" },
    preamble: "template preamble",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("delegated spawn argv is user args then template args and template defaults layer below flags", () => {
  const parsed: Parsed = {
    command: "x",
    args: ["extra input"],
    flags: new Map<string, string | true | string[]>([
      ["template", "commit"],
      ["cwd", "/flag/cwd"],
      ["account", "codex-flag"],
      ["env", ["SHARED=flag", "FLAG_ONLY=yes"]],
      ["yolo", true],
      ["preamble", "flag preamble"],
    ]),
    rest: ["--user-arg", "value"],
  };
  const plan = buildTemplateSpawnPlan(record(), parsed, "extra input", "/caller/cwd");

  assert.equal(plan.agent, "codex-auto");
  assert.deepEqual(plan.parsed.args, ["codex-auto"]);
  assert.deepEqual(plan.parsed.rest, [
    "--user-arg",
    "value",
    "-m",
    "gpt-5.6-sol",
    "-c",
    'model_reasoning_effort="medium"',
  ]);
  assert.equal(plan.parsed.flags.get("cwd"), "/flag/cwd");
  assert.equal(plan.parsed.flags.get("account"), "codex-flag");
  assert.deepEqual(plan.parsed.flags.get("env"), [
    "SHARED=template",
    "TEMPLATE_ONLY=yes",
    "SHARED=flag",
    "FLAG_ONLY=yes",
  ]);
  assert.equal(plan.parsed.flags.get("yolo"), true);
  assert.equal(plan.parsed.flags.get("preamble"), "flag preamble");
  assert.equal(plan.prompt, "Commit the changes.\n\nextra input");
});

test("template defaults become delegated flags above profile/account fallbacks", () => {
  const parsed: Parsed = {
    command: "spawn",
    args: [],
    flags: new Map([["template", "commit"]]),
    rest: [],
  };
  const plan = buildTemplateSpawnPlan(record({ yolo: false, preamble: false }), parsed, "", "/caller/cwd");
  assert.equal(plan.parsed.flags.get("cwd"), "/template/cwd");
  assert.equal(plan.parsed.flags.get("account"), "codex-template");
  assert.equal(plan.parsed.flags.get("no-yolo"), true);
  assert.equal(plan.parsed.flags.get("no-preamble"), true);
  assert.deepEqual(plan.parsed.flags.get("env"), ["SHARED=template", "TEMPLATE_ONLY=yes"]);
});

test("--template rejects frame, pool, and a positional bee before the flag but accepts input after it", () => {
  assert.throws(
    () => assertTemplateInvocation(parse(["x", "--template", "commit", "--frame", "review"]), "x"),
    /cannot be combined with --frame/,
  );
  assert.throws(
    () => assertTemplateInvocation(parse(["x", "--template", "commit", "--pool", "core"]), "x"),
    /cannot be combined with --pool/,
  );
  assert.throws(
    () => assertTemplateInvocation(parse(["x", "codex", "--template", "commit"]), "x"),
    /positional bee token/,
  );
  assert.doesNotThrow(
    () => assertTemplateInvocation(parse(["x", "--template", "commit", "mention", "tests"]), "x"),
  );
});
