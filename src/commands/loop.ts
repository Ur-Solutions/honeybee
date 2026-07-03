// `hive loop` — run a bee repeatedly until a stop condition; start/status/
// stop/logs/list + interactive launch and templates.
// Extracted from cli.ts (HIVE-15).
import { agentKinds } from "../drivers.js";
import { cancelRun, spawnDetachedRun } from "../flow/background.js";
import { readLogFull, runLogPath } from "../flow/runs.js";
import { actionLine, bold, cyan, dim, formatTable, green, isPretty, magenta, note, red, tildify, truncate, yellow } from "../format.js";
import { buildLoopConfig } from "../loop/context.js";
import { loopFlow } from "../loop/flow.js";
import { generateLoopId, listLoops, loopIterLogPath, loopProgressPath, readLoopConfig, reconcileLoopStatus, requestStop, resolveLoopId, updateLoopConfig, writeLoopConfig, type LoopConfig } from "../loop/state.js";
import { listLoopTemplates, loadLoopTemplate, removeLoopTemplate, saveLoopTemplate, type LoopTemplateInput } from "../loopTemplate.js";
import { chooseLoop, loopStartArgs, type LoopLaunchResult } from "../loopTui.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { listProRepos } from "../proProjects.js";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { emitLog, followFlag, logLinesFlag, resolveBeeInCurrentPane, resolveSpawnCwd, sleep } from "../cli/shared.js";
import { listNewBeeSubdirs, newBeeAccountRows } from "../commands/spawn.js";

export async function cmdLoop(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return loopListCmd();
    case "start":
      return loopStartCmd(parsed);
    case "launch":
      return cmdLoopLaunch(parsed);
    case "template":
      return cmdLoopTemplate(parsed);
    case "status":
      return loopStatusCmd(parsed);
    case "logs":
      return loopLogsCmd(parsed);
    case "stop":
      return loopStopCmd(parsed);
    default:
      throw new Error(`Unknown loop subcommand: ${sub}\nUsage: hive loop <launch|template|start|status|logs|stop|list> [id]`);
  }
}


export function loopArgsFromFlags(parsed: Parsed, prompt: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    bee: typeof flag(parsed, "bee") === "string" ? String(flag(parsed, "bee")) : "",
    cwd: typeof flag(parsed, "cwd") === "string" ? String(flag(parsed, "cwd")) : "",
    context: typeof flag(parsed, "context") === "string" ? String(flag(parsed, "context")) : "",
    prompt,
    until: typeof flag(parsed, "until") === "string" ? String(flag(parsed, "until")) : "",
    max: typeof flag(parsed, "max") === "string" ? String(flag(parsed, "max")) : undefined,
    maxDuration: typeof flag(parsed, "max-duration") === "string" ? String(flag(parsed, "max-duration")) : "",
    forever: truthy(flag(parsed, "forever")),
    stopOnSentinel: typeof flag(parsed, "stop-on-sentinel") === "string" ? String(flag(parsed, "stop-on-sentinel")) : "",
    judge: typeof flag(parsed, "judge") === "string" ? String(flag(parsed, "judge")) : "",
    summarizer: typeof flag(parsed, "summarizer") === "string" ? String(flag(parsed, "summarizer")) : "",
    yolo: truthy(flag(parsed, "yolo")),
  };
  const stopOnSeal = flag(parsed, "stop-on-seal");
  if (stopOnSeal !== undefined) args.stopOnSeal = Array.isArray(stopOnSeal) ? stopOnSeal.join(",") : stopOnSeal === true ? "" : String(stopOnSeal);
  return args;
}


/** Resolve a loop prompt from --prompt or --prompt-file (mutually exclusive; may be empty). */
export async function resolvePromptArg(parsed: Parsed): Promise<string> {
  const prompt = typeof flag(parsed, "prompt") === "string" ? String(flag(parsed, "prompt")) : "";
  const promptFile = typeof flag(parsed, "prompt-file") === "string" ? String(flag(parsed, "prompt-file")) : undefined;
  if (promptFile) {
    if (prompt) throw new Error("Provide either --prompt or --prompt-file, not both.");
    return (await readFile(resolve(promptFile), "utf8")).trim();
  }
  return prompt;
}


export async function loopStartCmd(parsed: Parsed) {
  await startLoopDetached(loopArgsFromFlags(parsed, await resolvePromptArg(parsed)));
}


/**
 * Spawn a loop driver detached (so it survives the calling popup/shell). Shared
 * by `hive loop start` and `hive loop launch`: validate eagerly, write loop.json,
 * then hand off to the background runner. `rawArgs` is the loose flag record both
 * loopArgsFromFlags and loopStartArgs produce.
 */
export async function startLoopDetached(rawArgs: Record<string, unknown>) {
  // The bee token (codex-auto / claude-thto / account-id) is persisted verbatim
  // and resolved at each iteration's spawn (spawnLoopBee / facade.spawn), so a
  // fresh-carrier `auto` loop re-picks the least-loaded account per iteration.
  // Validate eagerly so errors surface BEFORE we spawn a detached process.
  const cfg = buildLoopConfig(rawArgs);

  if (process.platform === "win32") {
    throw new Error("hive loop start is not supported on Windows (POSIX process groups are required to stop).");
  }

  const loopId = await generateLoopId();
  cfg.loopId = loopId;
  await writeLoopConfig(cfg);
  const args = { ...rawArgs, loopId };
  let pid: number;
  let pgid: number;
  try {
    ({ pid, pgid } = await spawnDetachedRun(loopFlow, args, { runId: loopId }));
  } catch (error) {
    // loop.json was written status:"running" before the spawn; mark it errored
    // so a failed spawn does not strand a phantom running loop.
    const message = error instanceof Error ? error.message : String(error);
    await updateLoopConfig(loopId, {
      status: "errored",
      stopReason: `spawn failed: ${message}`,
      endedAt: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }

  if (isPretty()) {
    console.log(actionLine("ok", "loop", [bold("loop"), dim(`id ${loopId}`), dim(`pid:${pid}`)]));
    console.error(dim(`Loop started. Inspect: hive loop status ${loopId} / hive loop logs ${loopId} / hive loop stop ${loopId}`));
  } else {
    console.log(`loop.start\t${loopId}\t${pid}\t${pgid}`);
  }
  return loopId;
}

// ── hive loop launch — the interactive dialog (⌘⇧L) ──────────────────────────


export async function cmdLoopLaunch(parsed: Parsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive loop launch needs a TTY — bind it to a tmux popup: bind -n M-L display-popup -E "hive loop launch"');
  }
  const here = await resolveBeeInCurrentPane();
  const defaultCwd = here?.cwd ?? (await resolveSpawnCwd(parsed));

  const result = await chooseLoop({
    templates: await listLoopTemplates(),
    defaultCwd,
    defaultCwdLabel: tildify(defaultCwd),
    loadProjects: async () => (await listProRepos()).map((repo) => ({ label: repo.label, path: repo.path, project: repo.project })),
    validatePath: async (input) => {
      try {
        const abs = resolve(input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        const real = await realpath(abs);
        if (!(await stat(real)).isDirectory()) return { ok: false, error: "not a directory" };
        return { ok: true, path: real };
      } catch {
        return { ok: false, error: "path does not exist" };
      }
    },
    listSubdirs: (base) => listNewBeeSubdirs(base),
    loadBeeOptions: loadLoopBeeOptions,
  });

  if (!result) {
    if (isPretty()) console.error(note("loop launch: cancelled"));
    return;
  }

  if (result.action === "save-template") {
    await saveLoopTemplate(loopTemplateInputFromResult(result));
    if (isPretty()) console.log(actionLine("ok", "loop", [bold("template"), dim(result.templateName ?? "")]));
    else console.log(`loop.template.save\t${result.templateName ?? ""}`);
    return;
  }

  // Launch: run the loop detached so it survives the popup. The flag map mirrors
  // what `hive loop start` would build from CLI flags, plus the chosen cwd.
  await startLoopDetached({ ...loopStartArgs(result.values), cwd: result.cwd });
}


/** The account-aware agent shorthands the loop's bee picker offers. */
export async function loadLoopBeeOptions(): Promise<Array<{ value: string; label: string; detail?: string }>> {
  const out: Array<{ value: string; label: string; detail?: string }> = [];
  for (const kind of agentKinds()) {
    const accounts = await newBeeAccountRows(kind).catch(() => []);
    if (accounts.length >= 1) {
      out.push({ value: `${kind}-auto`, label: `${kind} · auto`, detail: "least-loaded account" });
      if (accounts.length >= 2) out.push({ value: `${kind}-rr`, label: `${kind} · rr`, detail: "round-robin next account" });
    }
    for (const acct of accounts) {
      out.push({ value: `${kind}-${acct.id}`, label: `${kind} · ${acct.label}`, ...(acct.usage ? { detail: acct.usage } : {}) });
    }
    if (accounts.length === 0) out.push({ value: kind, label: `${kind} · (no account)` });
  }
  return out;
}


/** Map a save-as-template dialog result into the loopTemplate input record. */
export function loopTemplateInputFromResult(result: LoopLaunchResult): LoopTemplateInput {
  const v = result.values;
  const input: LoopTemplateInput = { name: result.templateName ?? "", prompt: v.prompt };
  const put = (key: keyof LoopTemplateInput, value: string) => {
    if (value.trim().length > 0) (input as Record<string, unknown>)[key] = value.trim();
  };
  put("context", v.context);
  put("bee", v.bee);
  put("until", v.until);
  put("max", v.max);
  put("maxDuration", v.maxDuration);
  put("stopOnSeal", v.stopOnSeal);
  put("stopOnSentinel", v.stopOnSentinel);
  put("judge", v.judge);
  put("summarizer", v.summarizer);
  if (v.forever) input.forever = true;
  if (v.yolo) input.yolo = true;
  return input;
}

// ── hive loop template <list|save|remove> ────────────────────────────────────


export async function cmdLoopTemplate(parsed: Parsed): Promise<void> {
  const sub = parsed.args[1];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return loopTemplateListCmd(parsed);
    case "save":
      return loopTemplateSaveCmd(parsed);
    case "remove":
    case "rm":
      return loopTemplateRemoveCmd(parsed);
    default:
      throw new Error(`Unknown loop template subcommand: ${sub}\nUsage: hive loop template <list|save|remove>`);
  }
}


export async function loopTemplateListCmd(parsed: Parsed): Promise<void> {
  const templates = await listLoopTemplates();
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(templates, null, 2));
    return;
  }
  if (!isPretty()) {
    for (const t of templates) console.log(["loop.template", t.name, t.context ?? "", t.bee ?? "", t.prompt.replace(/\s+/g, " ")].join("\t"));
    return;
  }
  if (templates.length === 0) {
    console.log(dim('No loop templates yet. Save one with: hive loop template save --name <name> --prompt "..." [--context …]'));
    return;
  }
  console.log(formatTable(
    [{ header: "NAME" }, { header: "TYPE" }, { header: "BEE" }, { header: "PROMPT" }],
    templates.map((t) => [bold(t.name), t.context ?? dim("—"), t.bee ?? dim("—"), dim(truncate(t.prompt.replace(/\s+/g, " "), 60))]),
  ));
}


export async function loopTemplateSaveCmd(parsed: Parsed): Promise<void> {
  const name = typeof flag(parsed, "name") === "string" ? String(flag(parsed, "name")) : "";
  if (!name) throw new Error("Usage: hive loop template save --name <name> --prompt \"...\" [--context …]");
  const prompt = await resolvePromptArg(parsed);
  if (!prompt) throw new Error("hive loop template save needs --prompt or --prompt-file.");

  const input: LoopTemplateInput = { name, prompt };
  const putStr = (key: keyof LoopTemplateInput, flagName: string) => {
    const value = flag(parsed, flagName);
    if (typeof value === "string" && value.length > 0) (input as Record<string, unknown>)[key] = value;
  };
  putStr("bee", "bee");
  putStr("context", "context");
  putStr("until", "until");
  putStr("max", "max");
  putStr("maxDuration", "max-duration");
  putStr("stopOnSeal", "stop-on-seal");
  putStr("stopOnSentinel", "stop-on-sentinel");
  putStr("judge", "judge");
  putStr("summarizer", "summarizer");
  putStr("description", "description");
  if (truthy(flag(parsed, "forever"))) input.forever = true;
  if (truthy(flag(parsed, "yolo"))) input.yolo = true;

  const record = await saveLoopTemplate(input);
  if (isPretty()) console.log(actionLine("ok", "loop", [bold("template"), dim(record.name)]));
  else console.log(`loop.template.save\t${record.name}`);
}


export async function loopTemplateRemoveCmd(parsed: Parsed): Promise<void> {
  const name = parsed.args[2];
  if (!name) throw new Error("Usage: hive loop template remove <name>");
  const existing = await loadLoopTemplate(name);
  if (!existing) throw new Error(`Unknown loop template: ${name}`);
  await removeLoopTemplate(name);
  if (isPretty()) console.log(actionLine("ok", "loop", [bold("template"), dim(name), red("removed")]));
  else console.log(`loop.template.remove\t${name}`);
}


export async function loopStatusCmd(parsed: Parsed) {
  const loopRef = parsed.args[1];
  if (!loopRef) return loopListCmd();
  const loopId = await resolveLoopId(loopRef);
  const cfg = await readLoopConfig(loopId);
  if (!cfg) throw new Error(`Unknown loop: ${loopId}`);
  const status = loopDisplayStatus(cfg);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ ...cfg, status }, null, 2));
    return;
  }
  if (!isPretty()) {
    console.log(
      [
        cfg.loopId,
        cfg.context,
        status,
        cfg.iteration,
        cfg.lastSealStatus ?? "",
        cfg.startedAt,
        cfg.endedAt ?? "",
      ].join("\t"),
    );
    return;
  }
  console.log(`${bold("loop")} ${dim(cfg.loopId)} ${colorLoopStatus(status)}`);
  console.log(`  context    ${cfg.context} ${dim(`(carrier=${cfg.carrier} memory=${cfg.memory})`)}`);
  console.log(`  bee        ${cfg.bee}`);
  console.log(`  iteration  ${cfg.iteration}${cfg.stop.max != null ? dim(` / ${cfg.stop.max}`) : ""}`);
  if (cfg.lastSealStatus) console.log(`  lastSeal   ${cfg.lastSealStatus}`);
  if (cfg.lastStopCheck) {
    console.log(`  stopCheck  ${cfg.lastStopCheck.condition}=${cfg.lastStopCheck.result} ${dim(cfg.lastStopCheck.at)}`);
  }
  if (cfg.stopReason) console.log(`  stopReason ${cfg.stopReason}`);
  console.log(`  elapsed    ${formatLoopElapsed(cfg)}`);
  if (cfg.pid !== undefined) console.log(`  pid        ${cfg.pid}`);
  const progress = await readFile(loopProgressPath(loopId), "utf8").catch(() => "");
  if (progress.trim()) {
    const head = progress.split("\n").slice(0, 8).join("\n");
    console.log(`\n${dim("progress.md (head):")}\n${head}`);
  }
}


export async function loopLogsCmd(parsed: Parsed) {
  const loopRef = parsed.args[1];
  if (!loopRef) throw new Error("Usage: hive loop logs <loopId> [--iter <n>] [-n <lines>] [-f|--follow]");
  const loopId = await resolveLoopId(loopRef);
  const cfg = await readLoopConfig(loopId);
  if (!cfg) throw new Error(`Unknown loop: ${loopId}`);

  const follow = followFlag(parsed);
  const iterRaw = flag(parsed, "iter");
  if (iterRaw !== undefined) {
    if (typeof iterRaw !== "string") throw new Error("--iter requires an iteration number (e.g. --iter 3)");
    if (follow) throw new Error("--iter cannot be combined with -f/--follow; iteration logs are complete files");
    const n = Number(iterRaw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid --iter "${iterRaw}": expected a positive integer.`);
    const path = loopIterLogPath(loopId, n);
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`No log for iteration ${n} of loop ${loopId}`);
      throw error;
    });
    await emitLog({ text, path });
    return;
  }

  if (follow) {
    await followLoopLog(loopId);
    return;
  }
  await emitLog({
    text: await readLogFull("loop", loopId),
    path: runLogPath("loop", loopId),
    lines: logLinesFlag(parsed, 0),
  });
}


export async function followLoopLog(loopId: string): Promise<void> {
  const path = runLogPath("loop", loopId);
  let offset = 0;
  const printAppended = async () => {
    const result = await readLogSince(path, offset);
    offset = result.offset;
    if (result.text.length > 0) process.stdout.write(result.text);
  };
  while (true) {
    await printAppended();
    const cfg = await readLoopConfig(loopId).catch(() => null);
    if (cfg && cfg.status !== "running") break;
    if (cfg && cfg.status === "running" && typeof cfg.pid === "number" && !processAlive(cfg.pid)) {
      console.error(note(`loop driver (pid ${cfg.pid}) is gone but loop.json still says running; log will not grow`));
      break;
    }
    await sleep(1_000);
  }
  // One final read: catch lines appended between the last read and the status flip.
  await printAppended();
}


export async function readLogSince(path: string, offset: number): Promise<{ text: string; offset: number }> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile()) return { text: "", offset: 0 };
  const start = info.size < offset ? 0 : offset;
  const length = info.size - start;
  if (length <= 0) return { text: "", offset: info.size };

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), offset: start + bytesRead };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", offset: 0 };
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}


export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


export async function loopStopCmd(parsed: Parsed) {
  const loopRef = parsed.args[1];
  if (!loopRef) throw new Error("Usage: hive loop stop <loopId> [--now]");
  const loopId = await resolveLoopId(loopRef);
  const cfg = await readLoopConfig(loopId);
  if (!cfg) throw new Error(`Unknown loop: ${loopId}`);
  const now = truthy(flag(parsed, "now"));
  if (now) {
    const outcome = await cancelRun("loop", loopId);
    // cancelRun SIGKILLs the driver's process group, so the driver's own
    // finalize() may never run and loop.json would be stuck at "running".
    // Reconcile it here so `hive loop status/list` reports a terminal state.
    const latestCfg = await readLoopConfig(loopId).catch(() => null);
    if (latestCfg?.status === "running") {
      await updateLoopConfig(loopId, { status: "stopped", stopReason: "stopped:now", endedAt: new Date().toISOString() }).catch(
        () => undefined,
      );
    }
    if (isPretty()) {
      const tag = outcome.signalled === "already-dead" ? dim(outcome.signalled) : yellow(outcome.signalled);
      console.log(actionLine("ok", "loop", [bold(loopId), dim("now"), tag]));
    } else {
      console.log(`loop.stop\t${loopId}\tnow\t${outcome.signalled}`);
    }
    return;
  }
  await requestStop(loopId);
  if (isPretty()) {
    console.log(actionLine("ok", "loop", [bold(loopId), dim("queued"), dim("stops after current iteration")]));
  } else {
    console.log(`loop.stop\t${loopId}\tqueued`);
  }
}


export async function loopListCmd() {
  const loops = await listLoops();
  if (!isPretty()) {
    for (const l of loops) {
      console.log(["loop.run", l.loopId, l.context, loopDisplayStatus(l), l.iteration, l.startedAt].join("\t"));
    }
    return;
  }
  if (loops.length === 0) {
    console.log(dim("No loops yet. Start one with: hive loop start --bee <kind> --cwd <dir> --context <mode> --prompt \"...\""));
    return;
  }
  console.log(formatTable(
    [
      { header: "LOOP" },
      { header: "CONTEXT" },
      { header: "STATUS" },
      { header: "ITER", align: "right" },
      { header: "STARTED" },
    ],
    loops.map((l) => [
      bold(l.loopId),
      l.context,
      colorLoopStatus(loopDisplayStatus(l)),
      String(l.iteration),
      dim(l.startedAt),
    ]),
  ));
}


// Display-level only: a "running" loop whose driver pid is gone (e.g. SIGKILL)
// can never finalize loop.json, so surface it as orphaned instead of running
// forever. Delegates to the same reconciliation listLoops applies.
export function loopDisplayStatus(cfg: LoopConfig): LoopConfig["status"] {
  return reconcileLoopStatus(cfg).status;
}


export function colorLoopStatus(status: LoopConfig["status"] | "orphaned"): string {
  if (status === "running") return cyan(status);
  if (status === "done") return green(status);
  if (status === "paused") return yellow(status);
  if (status === "stopped") return yellow(status);
  if (status === "errored") return red(status);
  if (status === "orphaned") return magenta(status);
  return dim(status);
}


export function formatLoopElapsed(cfg: LoopConfig): string {
  const start = Date.parse(cfg.startedAt);
  const end = cfg.endedAt ? Date.parse(cfg.endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "?";
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
