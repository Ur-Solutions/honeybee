// `hive config` — view/edit ~/.hive/config.json defaults, plus shell completion.
// Extracted from cli.ts (HIVE-15).
import { shellScript } from "../completion.js";
import { NAMING_EFFORTS, configPath, loadConfig, resetConfigCache, type NamingEffort } from "../config.js";
import { actionLine, bold, dim, isPretty } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";

export async function cmdConfig(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "show": {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "path":
      console.log(configPath());
      return;
    case "set-bee":
      return configSetBee(parsed);
    case "set-naming":
      return configSetNaming(parsed);
    default:
      throw new Error(`Unknown config subcommand: ${sub}\nUsage: hive config <show|path|set-bee|set-naming>`);
  }
}


export async function configSetBee(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive config set-bee <bee> [--kind <agent>] [--yolo] [--no-yolo] [--home <value>] [--command \"...\"]");
  const yolo = truthy(flag(parsed, "yolo")) ? true : truthy(flag(parsed, "no-yolo")) ? false : undefined;
  const homeRaw = flag(parsed, "home");
  const home = typeof homeRaw === "string" ? homeRaw : undefined;
  const commandRaw = flag(parsed, "command");
  const command = typeof commandRaw === "string" ? commandRaw : undefined;
  const kindRaw = flag(parsed, "kind");
  const kind = typeof kindRaw === "string" ? kindRaw : undefined;
  if (yolo === undefined && home === undefined && command === undefined && kind === undefined) {
    throw new Error("hive config set-bee needs at least one of --kind, --yolo/--no-yolo, --home, --command");
  }
  const config = loadConfig();
  const next = { ...config, bees: { ...(config.bees ?? {}) } };
  const existing = next.bees[name] ?? {};
  const beeEntry: Record<string, unknown> = { ...existing };
  if (yolo !== undefined) beeEntry.yolo = yolo;
  if (home !== undefined) beeEntry.home = home;
  if (command !== undefined) beeEntry.command = command;
  if (kind !== undefined) beeEntry.kind = kind;
  next.bees[name] = beeEntry;
  await writeConfigFile(next);
  resetConfigCache();
  if (isPretty()) console.log(actionLine("ok", "config", [bold(name), dim("updated")]));
  else console.log(`config\t${name}\tupdated`);
}


export async function configSetNaming(parsed: Parsed) {
  const auto = truthy(flag(parsed, "auto")) ? true : truthy(flag(parsed, "no-auto")) ? false : undefined;
  const toolRaw = flag(parsed, "tool");
  if (toolRaw !== undefined && toolRaw !== "claude" && toolRaw !== "codex") throw new Error("--tool must be claude or codex");
  const tool = toolRaw as "claude" | "codex" | undefined;
  const modelRaw = flag(parsed, "model");
  const model = typeof modelRaw === "string" ? modelRaw : undefined;
  const commandRaw = flag(parsed, "command");
  const command = typeof commandRaw === "string" ? commandRaw : undefined;
  const effortRaw = flag(parsed, "effort");
  if (effortRaw !== undefined && !(NAMING_EFFORTS as readonly string[]).includes(String(effortRaw))) {
    throw new Error(`--effort must be one of: ${NAMING_EFFORTS.join(", ")}`);
  }
  const effort = typeof effortRaw === "string" ? (effortRaw as NamingEffort) : undefined;
  if (auto === undefined && tool === undefined && model === undefined && command === undefined && effort === undefined) {
    throw new Error('hive config set-naming needs at least one of --auto/--no-auto, --tool <claude|codex>, --model <m>, --effort <minimal|low|medium|high|xhigh>, --command "..."');
  }
  const config = loadConfig();
  const naming = { ...(config.naming ?? {}) };
  if (auto !== undefined) naming.auto = auto;
  if (tool !== undefined) naming.tool = tool;
  if (model !== undefined) naming.model = model;
  if (command !== undefined) naming.command = command;
  if (effort !== undefined) naming.effort = effort;
  await writeConfigFile({ ...config, naming });
  resetConfigCache();
  if (isPretty()) console.log(actionLine("ok", "config", [bold("naming"), dim("updated")]));
  else console.log("config\tnaming\tupdated");
}


export async function writeConfigFile(config: unknown): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const target = configPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}


export async function cmdCompletion(parsed: Parsed) {
  const shell = parsed.args[0];
  if (!shell) throw new Error("Usage: hive completion <bash|zsh|fish>");
  process.stdout.write(shellScript(shell));
}
