// `hive template` — manage and run reusable single-bee spawn presets.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionLine, bold, dim, formatRelativeTime, formatTable, isPretty, note } from "../format.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { substrateFor } from "../substrates/index.js";
import {
  defineTemplateFromFile,
  listTemplates,
  loadTemplate,
  removeTemplate,
  templateDefinitionFile,
  updateTemplateFromSource,
  validateTemplate,
  writeTemplateFromObject,
  type AgentTemplate,
} from "../template.js";
import { formatShellCommand } from "../tmux.js";
import { waitForIdle } from "../wait.js";
import { hasFlag, hsrSubstrateRequested, stringFlag } from "../cli/shared.js";
import { resolveDefineArgs } from "./frame.js";
import { deliverPromptToBee, spawnDelegated, waitForPromptReady } from "./run.js";

export async function cmdTemplate(parsed: Parsed): Promise<void> {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return templateList(parsed);
    case "define":
      return templateDefine(parsed);
    case "update":
      return templateUpdate(parsed);
    case "edit":
      return templateEdit(parsed);
    case "inspect":
      return templateInspect(parsed);
    case "remove":
    case "rm":
      return templateRemove(parsed);
    case "run":
      return templateRun(parsed);
    default:
      throw new Error(
        `Unknown template subcommand: ${sub}\nUsage: hive template <list|define|update|edit|inspect|remove|run>`,
      );
  }
}

export async function templateList(parsed: Parsed): Promise<void> {
  const templates = await listTemplates();
  if (truthy(flag(parsed, "json"))) {
    // This is the Apiary read surface: intentionally omit prompt and every
    // spawn-default detail. `inspect` is the full-record endpoint.
    console.log(JSON.stringify(templates.map(({ name, description, bee, updatedAt }) => ({
      name,
      description: description ?? null,
      bee,
      updatedAt,
    })), null, 2));
    return;
  }
  if (!isPretty()) {
    for (const template of templates) {
      console.log(`${template.name}\t${template.description ?? ""}\t${template.bee}\t${template.updatedAt}`);
    }
    return;
  }
  if (templates.length === 0) {
    console.log(dim("No agent templates defined. Register one with: hive template define <file.json|.ts>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "NAME" },
      { header: "BEE" },
      { header: "UPDATED" },
      { header: "DESCRIPTION" },
    ],
    templates.map((template) => [
      bold(template.name),
      template.bee,
      dim(`${formatRelativeTime(template.updatedAt)} ago`),
      dim(template.description ?? ""),
    ]),
  ));
}

export async function templateDefine(parsed: Parsed): Promise<void> {
  const first = parsed.args[1];
  const second = parsed.args[2];
  if (!first) throw new Error("Usage: hive template define <file.json|.ts> [<name>]");
  const { sourcePath, nameOverride } = resolveDefineArgs(first, second);
  const template = await defineTemplateFromFile(sourcePath, nameOverride);
  if (isPretty()) console.log(actionLine("ok", "template", [bold(template.name), template.bee, dim(sourcePath)]));
  else console.log(`defined\t${template.name}\t${template.bee}\t${sourcePath}`);
}

export async function templateUpdate(parsed: Parsed): Promise<void> {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive template update <name>");
  const template = await updateTemplateFromSource(name);
  if (isPretty()) console.log(actionLine("ok", "template", [bold(template.name), dim("updated")]));
  else console.log(`updated\t${template.name}`);
}

export async function templateEdit(parsed: Parsed): Promise<void> {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive template edit <name>");
  const existing = await loadTemplate(name);
  if (!existing) throw new Error(`Unknown template: ${name}`);
  const backing = await templateDefinitionFile(name);
  if (backing?.ext === ".ts") {
    throw new Error(
      `Template ${name} is backed by a TypeScript source; edit the recorded source, then run: hive template update ${name}`,
    );
  }

  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  const tempDir = await mkdtemp(join(tmpdir(), `hive-template-${name}-`));
  const tempFile = join(tempDir, `${name}.json`);
  await writeFile(tempFile, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  try {
    const [editorCommand, ...editorArgs] = editor.split(/\s+/);
    if (!editorCommand) throw new Error("Empty $EDITOR/$VISUAL");
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(editorCommand, [...editorArgs, tempFile], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (value) => resolve(value ?? 1));
    });
    if (code !== 0) throw new Error(`Editor exited with code ${code}; template unchanged`);
    const edited = validateTemplate(JSON.parse(await readFile(tempFile, "utf8")));
    if (edited.name !== name) {
      throw new Error(
        `Template name changed in editor (${name} → ${edited.name}); use 'hive template define' to rename`,
      );
    }
    await writeTemplateFromObject(edited);
    if (isPretty()) console.log(actionLine("ok", "template", [bold(name), dim("edited")]));
    else console.log(`edited\t${name}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function templateInspect(parsed: Parsed): Promise<void> {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive template inspect <name>");
  const template = await loadTemplate(name);
  if (!template) throw new Error(`Unknown template: ${name}`);
  console.log(JSON.stringify(template, null, 2));
}

export async function templateRemove(parsed: Parsed): Promise<void> {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive template remove <name>");
  if (!(await removeTemplate(name))) throw new Error(`Unknown template: ${name}`);
  if (isPretty()) console.log(actionLine("ok", "template", [bold(name), dim("removed")]));
  else console.log(`removed\t${name}`);
}

export function interpolateTemplatePrompt(prompt: string, input: string): string {
  if (prompt.includes("{{input}}")) return prompt.replaceAll("{{input}}", input);
  return input.length > 0 ? `${prompt}\n\n${input}` : prompt;
}

export type TemplateSpawnPlan = {
  template: AgentTemplate;
  agent: string;
  prompt: string;
  parsed: Parsed;
};

/**
 * Layer a template into a delegated spawn. Values materialized as flags sit
 * above the profile/account overlays resolved by spawnSingleBee, while the
 * caller's existing flags remain above template values.
 *
 * Harness argv order is user rest → template args; spawnSingleBee appends a
 * thin profile's args after that, preserving FLAG > TEMPLATE > PROFILE.
 */
export function buildTemplateSpawnPlan(
  template: AgentTemplate,
  parsed: Parsed,
  input: string,
  callerCwd = process.cwd(),
): TemplateSpawnPlan {
  const flags = new Map(parsed.flags);
  for (const control of ["template", "attach", "wait", "prompt", "p", "raw", "window", "app"]) {
    flags.delete(control);
  }

  if (!hasFlag(parsed, "cwd")) flags.set("cwd", template.cwd === "caller" ? callerCwd : template.cwd);
  if (!hasFlag(parsed, "account") && template.account) flags.set("account", template.account);

  const callerEnv = flag(parsed, "env");
  if (callerEnv === true) throw new Error("--env requires KEY=VALUE (repeat --env for multiple values)");
  const templateEnv = Object.entries(template.env ?? {}).map(([key, value]) => `${key}=${value}`);
  const explicitEnv = callerEnv === undefined ? [] : Array.isArray(callerEnv) ? callerEnv : [callerEnv];
  const mergedEnv = [...templateEnv, ...explicitEnv];
  if (mergedEnv.length === 1) flags.set("env", mergedEnv[0]!);
  else if (mergedEnv.length > 1) flags.set("env", mergedEnv);

  const explicitYolo = hasFlag(parsed, "yolo") || hasFlag(parsed, "dangerous") || hasFlag(parsed, "no-yolo");
  if (!explicitYolo && template.yolo !== undefined) {
    flags.set(template.yolo ? "yolo" : "no-yolo", true);
  }

  const explicitPreamble = hasFlag(parsed, "preamble") || hasFlag(parsed, "no-preamble");
  if (!explicitPreamble && template.preamble !== undefined) {
    if (template.preamble === false) flags.set("no-preamble", true);
    else flags.set("preamble", template.preamble);
  }

  // The template runner owns the one readiness gate immediately before prompt
  // delivery, so cmdSpawn must not perform its own gate first.
  flags.set("no-wait", true);
  const delegated: Parsed = {
    command: "spawn",
    args: [template.bee],
    flags,
    rest: [...parsed.rest, ...(template.args ?? [])],
  };
  return {
    template,
    agent: template.bee,
    prompt: interpolateTemplatePrompt(template.prompt, input),
    parsed: delegated,
  };
}

export type TemplateRunMode = "spawn" | "x" | "run" | "xa" | "open" | "template";

/**
 * Spawn-family --template entry point. Kept here so every verb gets identical
 * conflict checks, interpolation, defaults, and delegated argv.
 */
export async function runTemplateFlag(parsed: Parsed, mode: TemplateRunMode): Promise<import("../store.js").SessionRecord> {
  const name = stringFlag(parsed, ["template"]);
  if (!name) throw new Error("--template requires a template name");
  assertTemplateInvocation(parsed, mode);
  const template = await loadTemplate(name);
  if (!template) throw new Error(`Unknown template: ${name}. Define one with: hive template define <file>`);
  const input = templateInput(parsed, mode);
  return executeTemplate(template, parsed, input, mode);
}

export async function templateRun(parsed: Parsed): Promise<void> {
  const name = parsed.args[1];
  if (!name) {
    throw new Error(
      "Usage: hive template run <name> [extra input] [--wait] [--attach] [--cwd <dir>] [--account <a>] [--name <id>] [-- <bee-args...>]",
    );
  }
  const template = await loadTemplate(name);
  if (!template) throw new Error(`Unknown template: ${name}`);
  await executeTemplate(template, parsed, parsed.args.slice(2).join(" "), "template");
}

async function executeTemplate(
  template: AgentTemplate,
  parsed: Parsed,
  input: string,
  mode: TemplateRunMode,
): Promise<import("../store.js").SessionRecord> {
  if (truthy(flag(parsed, "wait")) && truthy(flag(parsed, "attach"))) {
    throw new Error("--wait and --attach are mutually exclusive for template runs");
  }
  const shouldAttach = mode === "xa" || mode === "open" || truthy(flag(parsed, "attach"));
  if (shouldAttach && hsrSubstrateRequested(parsed)) {
    throw new Error(
      "template attach needs an interactive tmux bee; remove --substrate hsr or run without --attach",
    );
  }

  const adjusted: Parsed = { ...parsed, flags: new Map(parsed.flags) };
  if (shouldAttach && !hasFlag(adjusted, "node") && !hasFlag(adjusted, "substrate")) {
    adjusted.flags.set("substrate", "tmux");
  }
  if (mode === "open" && process.env.TMUX) adjusted.flags.set("here", true);

  const plan = buildTemplateSpawnPlan(template, adjusted, input);
  const record = await spawnDelegated(plan.parsed, plan.agent, { rest: plan.parsed.rest });
  await waitForPromptReady(record, plan.parsed);
  const sentAt = await deliverPromptToBee(record, plan.prompt);
  const updated = {
    ...record,
    status: "running" as const,
    updatedAt: sentAt,
    lastPrompt: plan.prompt,
    lastPromptAt: sentAt,
  };

  if (truthy(flag(parsed, "wait"))) {
    await waitForIdle({
      record: updated,
      idleMs: numberFlag(parsed, ["idle-ms", "idle"], 3_000),
      timeoutMs: numberFlag(parsed, ["timeout-ms", "timeout"], 600_000),
      pollMs: numberFlag(parsed, ["poll-ms", "poll"], 750),
      output: truthy(flag(parsed, "last")) ? "last" : truthy(flag(parsed, "transcript")) ? "transcript" : "pane",
      rows: numberFlag(parsed, ["n", "limit"], 0),
      json: truthy(flag(parsed, "json")),
    });
    return updated;
  }

  if (shouldAttach) {
    const substrate = substrateFor(record);
    if (mode === "open" && process.env.TMUX) return updated;
    if (truthy(flag(parsed, "print")) || !process.stdout.isTTY) {
      if (isPretty()) console.error(note("attach with:"));
      console.log(formatShellCommand(substrate.attachCommand(record.tmuxTarget)));
      return updated;
    }
    await substrate.attachSession(record.tmuxTarget);
    return updated;
  }

  // Machine-friendly success token for fire-and-forget template invocation.
  if (isPretty()) console.log(actionLine("ok", "template", [bold(record.name), dim(`template:${template.name}`)]));
  else console.log(record.name);
  return updated;
}

function templateInput(parsed: Parsed, mode: TemplateRunMode): string {
  const promptFlag = stringFlag(parsed, ["prompt", "p"]);
  if (promptFlag !== undefined) return promptFlag;
  return mode === "x" || mode === "run" ? parsed.args.join(" ") : "";
}

export function assertTemplateInvocation(parsed: Parsed, mode: TemplateRunMode): void {
  if (hasFlag(parsed, "frame")) {
    throw new Error("--template cannot be combined with --frame; use hive spawn --template <name>");
  }
  if (hasFlag(parsed, "pool")) {
    throw new Error("--template cannot be combined with --pool; put the desired cwd in the template or pass --cwd");
  }
  if ((parsed.argsBeforeTemplate ?? 0) > 0) {
    throw new Error("--template cannot be combined with a positional bee token; use --template <name> instead of <bee>");
  }
  if (numberFlag(parsed, ["count"], 1) > 1) {
    throw new Error("--template spawns one bee and cannot be combined with --count > 1; use a frame for cohorts");
  }
  if ((mode === "spawn" || mode === "xa" || mode === "open") && parsed.args.length > 0) {
    throw new Error("--template cannot be combined with a positional bee token; use --template <name> instead of <bee>");
  }
}
