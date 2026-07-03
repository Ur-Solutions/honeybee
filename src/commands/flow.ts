// `hive flow` — manage and run flow definitions.
// Extracted from cli.ts (HIVE-15).
import { cancelRun, spawnDetachedRun } from "../flow/background.js";
import { defineFlowFromFile, listFlows, loadFlow, loadFlowSource, removeFlow } from "../flow/index.js";
import { executeFlow } from "../flow/run.js";
import { findRunById, generateRunId, listRuns, readLogFull, readMeta, readResult, runLogPath, type FlowRunMeta } from "../flow/runs.js";
import { actionLine, bold, cyan, dim, errorPrefix, formatTable, gray, green, isPretty, magenta, red, yellow } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { emitLog, logLinesFlag } from "../cli/shared.js";
import { resolveDefineArgs } from "../commands/frame.js";

export async function cmdFlow(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return flowList();
    case "run":
      return flowRun(parsed);
    case "define":
      return flowDefine(parsed);
    case "runs":
      return flowRunsList(parsed);
    case "inspect":
      return flowInspect(parsed);
    case "logs":
      return flowLogs(parsed);
    case "remove":
      return flowRemove(parsed);
    case "status":
      return flowStatus(parsed);
    case "cancel":
      return flowCancel(parsed);
    default:
      throw new Error(`Unknown flow subcommand: ${sub}\nUsage: hive flow <list|define|inspect|remove|run|runs|logs|status|cancel>`);
  }
}


export function parseFlowRunArgs(parsed: Parsed): Record<string, unknown> {
  const raw = parsed.flags.get("arg");
  if (raw === undefined) return {};
  const entries: string[] = [];
  if (typeof raw === "string") entries.push(raw);
  else if (Array.isArray(raw)) entries.push(...raw);
  else if (raw === true) throw new Error("--arg requires a key=value pair");
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --arg: ${entry} (expected key=value)`);
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    const numberValue = Number(value);
    if (value !== "" && Number.isFinite(numberValue) && String(numberValue) === value) out[key] = numberValue;
    else out[key] = value;
  }
  return out;
}


export async function flowRun(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive flow run <name> [--arg key=value]... [--foreground|--background]");
  const flow = await loadFlow(name);
  if (!flow) throw new Error(`Unknown flow: ${name}`);
  const args = parseFlowRunArgs(parsed);
  const foreground = truthy(flag(parsed, "foreground"));
  const background = truthy(flag(parsed, "background"));
  if (foreground && background) throw new Error("--foreground and --background are mutually exclusive");
  if (background) {
    if (process.platform === "win32") {
      throw new Error("hive flow run --background is not supported on Windows.");
    }
    const { runId, pid, pgid } = await spawnDetachedRun(flow, args);
    if (isPretty()) {
      console.log(actionLine("ok", "flow", [bold(flow.name), dim(`run ${runId}`), dim(`pid:${pid}`), dim(`pgid:${pgid}`)]));
      console.error(dim(`Background run started. Inspect: hive flow status ${runId} / hive flow logs ${runId} / hive flow cancel ${runId}`));
    } else {
      console.log(`flow.run\t${flow.name}\t${runId}\t${pid}\t${pgid}\tbackground`);
    }
    return;
  }
  const runId = generateRunId();
  if (isPretty()) {
    console.log(actionLine("ok", "flow", [bold(flow.name), dim(`run ${runId}`)]));
  } else {
    console.log(`flow.run\t${flow.name}\t${runId}`);
  }
  const outcome = await executeFlow(flow, { args, runId });
  if (isPretty()) {
    const colored = outcome.status === "ok" ? green("ok")
      : outcome.status === "cancelled" ? yellow("cancelled")
      : outcome.status === "failed" ? red("failed")
      : dim(outcome.status);
    console.log(actionLine("ok", "flow", [bold(flow.name), dim(runId), colored]));
    if (outcome.error?.message) {
      console.error(dim(`error: ${outcome.error.message}`));
    }
  } else {
    console.log(`flow.end\t${flow.name}\t${runId}\t${outcome.status}`);
  }
  if (outcome.status === "failed") process.exitCode = 1;
  if (outcome.status === "cancelled") process.exitCode = 130;
}


export async function flowCancel(parsed: Parsed) {
  const runId = parsed.args[1];
  if (!runId) throw new Error("Usage: hive flow cancel <runId>");
  const summary = await findRunById(runId);
  if (!summary) throw new Error(`Unknown run: ${runId}`);
  if (summary.status !== "running") {
    if (isPretty()) {
      console.log(actionLine("ok", "flow", [bold(summary.flowName), dim(runId), dim(`already ${summary.status}`)]));
    } else {
      console.log(`flow.cancel\t${summary.flowName}\t${runId}\talready-${summary.status}`);
    }
    return;
  }
  const outcome = await cancelRun(summary.flowName, runId);
  if (isPretty()) {
    const tag = outcome.signalled === "already-dead" ? dim(outcome.signalled) : yellow(outcome.signalled);
    console.log(actionLine("ok", "flow", [bold(outcome.flowName), dim(runId), tag]));
  } else {
    console.log(`flow.cancel\t${outcome.flowName}\t${runId}\t${outcome.signalled}`);
  }
}


/**
 * Hidden entrypoint for the detached background child. Invoked as
 *   <node> <cli> __flow-exec <runId> --flow <name>
 *
 * Reads meta.json (pre-written by spawnDetachedRun), loads the registered
 * flow, and runs it through executeFlow. Exits with a status-derived code so
 * any waiting parent (test or future supervisor) sees the outcome.
 */
export async function runFlowExec(rest: string[]) {
  const runId = rest[0];
  if (!runId) {
    console.error(`${errorPrefix()} __flow-exec: missing runId`);
    process.exitCode = 2;
    return;
  }
  // Parse optional --flow <name>. The parent always passes this; we still
  // fall back to findRunById to be resilient if the flag is missing.
  let flowName: string | undefined;
  for (let i = 1; i < rest.length; i += 1) {
    if (rest[i] === "--flow" && typeof rest[i + 1] === "string") {
      flowName = rest[i + 1];
      i += 1;
    }
  }
  if (!flowName) {
    const summary = await findRunById(runId);
    if (!summary) {
      console.error(`${errorPrefix()} __flow-exec: cannot resolve flow for runId ${runId}`);
      process.exitCode = 2;
      return;
    }
    flowName = summary.flowName;
  }
  const meta = await readMeta(flowName, runId);
  if (!meta) {
    console.error(`${errorPrefix()} __flow-exec: missing meta.json for ${flowName}/${runId}`);
    process.exitCode = 2;
    return;
  }
  const flow = await loadFlow(flowName);
  if (!flow) {
    console.error(`${errorPrefix()} __flow-exec: unknown flow ${flowName}`);
    process.exitCode = 2;
    return;
  }
  const outcome = await executeFlow(flow, {
    runId,
    args: meta.args,
    installSignalHandlers: true,
    background: true,
  });
  if (outcome.status === "failed") process.exitCode = 1;
  else if (outcome.status === "cancelled") process.exitCode = 130;
}


export async function flowRunsList(parsed: Parsed) {
  // Optional --flow <name> filter scopes the inventory.
  const flowName = typeof flag(parsed, "flow") === "string" ? String(flag(parsed, "flow")) : undefined;
  const runs = await listRuns(flowName ? { flowName } : {});
  if (!isPretty()) {
    for (const r of runs) {
      console.log([
        "flow.run",
        r.flowName,
        r.runId,
        r.status,
        r.startedAt,
        r.endedAt ?? "",
        r.pid ?? "",
      ].join("\t"));
    }
    return;
  }
  if (runs.length === 0) {
    console.log(dim("No flow runs yet. Start one with: hive flow run <name> [--arg k=v]..."));
    return;
  }
  console.log(formatTable(
    [
      { header: "FLOW" },
      { header: "RUN" },
      { header: "STATUS" },
      { header: "STARTED" },
      { header: "ENDED" },
      { header: "PID", align: "right" },
    ],
    runs.map((r) => [
      bold(r.flowName),
      r.runId,
      colorRunStatus(r.status),
      dim(r.startedAt),
      dim(r.endedAt ?? ""),
      r.pid !== undefined ? String(r.pid) : dim(""),
    ]),
  ));
}


export function colorRunStatus(status: FlowRunMeta["status"]): string {
  if (status === "ok") return green(status);
  if (status === "running") return cyan(status);
  if (status === "cancelled") return yellow(status);
  if (status === "failed") return red(status);
  if (status === "orphaned") return magenta(status);
  return dim(status);
}


export async function flowLogs(parsed: Parsed) {
  const runId = parsed.args[1];
  if (!runId) throw new Error("Usage: hive flow logs <runId> [-n <lines>]");
  const summary = await findRunById(runId);
  if (!summary) throw new Error(`Unknown run: ${runId}`);
  await emitLog({
    text: await readLogFull(summary.flowName, runId),
    path: runLogPath(summary.flowName, runId),
    lines: logLinesFlag(parsed, 0),
  });
}


export async function flowStatus(parsed: Parsed) {
  const runId = parsed.args[1];
  if (!runId) throw new Error("Usage: hive flow status <runId>");
  const summary = await findRunById(runId);
  if (!summary) throw new Error(`Unknown run: ${runId}`);
  const meta = await readMeta(summary.flowName, runId);
  const result = await readResult(summary.flowName, runId);
  if (truthy(flag(parsed, "json"))) {
    // summary.status is reconciled (running + dead pid → orphaned); the raw
    // meta on disk may still say "running", so emit the reconciled view.
    console.log(JSON.stringify({ meta: meta ? { ...meta, status: summary.status } : meta, result }, null, 2));
    return;
  }
  if (!isPretty()) {
    console.log(`${summary.flowName}\t${runId}\t${summary.status}\t${summary.startedAt}\t${summary.endedAt ?? ""}`);
    return;
  }
  console.log(`${bold(summary.flowName)} ${dim(runId)} ${colorRunStatus(summary.status)}`);
  console.log(`  startedAt ${summary.startedAt}`);
  if (summary.endedAt) console.log(`  endedAt   ${summary.endedAt}`);
  if (summary.pid !== undefined) console.log(`  pid       ${summary.pid}`);
  if (summary.cleanup) console.log(`  cleanup   ${summary.cleanup}`);
  if (result?.value !== undefined) {
    console.log(`  value     ${JSON.stringify(result.value)}`);
  }
  if (result?.error) {
    console.log(`  ${red("error")}     ${result.error.message}`);
    if (result.error.cancelled) console.log(dim("  (cancelled by SIGINT)"));
  }
  if (meta && Object.keys(meta.args).length > 0) {
    console.log(`  args      ${JSON.stringify(meta.args)}`);
  }
}


export async function flowList() {
  const flows = await listFlows();
  if (!isPretty()) {
    for (const f of flows) {
      const args = f.args?.length ?? 0;
      const cleanup = f.cleanup ?? "keep";
      console.log(`${f.name}\t${args} args\t${cleanup}`);
    }
    return;
  }
  if (flows.length === 0) {
    console.log(dim("No flows defined. Register one with: hive flow define <path-to-flow.json|.ts>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "NAME" },
      { header: "ARGS", align: "right" },
      { header: "CLEANUP" },
      { header: "DESCRIPTION" },
    ],
    flows.map((f) => [
      bold(f.name),
      String(f.args?.length ?? 0),
      f.cleanup === "kill-on-end" ? yellow("kill-on-end") : gray("keep"),
      dim(f.description ?? ""),
    ]),
  ));
}


export async function flowDefine(parsed: Parsed) {
  const first = parsed.args[1];
  const second = parsed.args[2];
  if (!first) throw new Error("Usage: hive flow define <path-to-flow.json|.ts> [<name>]");
  const { sourcePath, nameOverride } = resolveDefineArgs(first, second);
  const flow = await defineFlowFromFile(sourcePath, nameOverride);
  if (isPretty()) {
    console.log(actionLine("ok", "flow", [bold(flow.name), `${flow.args?.length ?? 0} args`, dim(sourcePath)]));
  } else {
    console.log(`defined\t${flow.name}\t${flow.args?.length ?? 0}\t${sourcePath}`);
  }
}


export async function flowInspect(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive flow inspect <name>");
  const flow = await loadFlow(name);
  if (!flow) throw new Error(`Unknown flow: ${name}`);
  const source = await loadFlowSource(name).catch(() => null);
  // Re-read the raw source if it still exists — for JSON flows this shows the
  // declarative steps without trying to serialize the compiled closure.
  if (source) {
    try {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(source, "utf8");
      if (source.endsWith(".json")) {
        // Validate that it's still parseable JSON; if so emit it verbatim.
        JSON.parse(raw);
        console.log(raw.endsWith("\n") ? raw.slice(0, -1) : raw);
        return;
      }
    } catch {
      // fall through to summary
    }
  }
  // TS flow (or missing source): print a JSON summary of the compiled shape.
  const summary: Record<string, unknown> = { name: flow.name };
  if (flow.description !== undefined) summary.description = flow.description;
  if (flow.args !== undefined) summary.args = flow.args;
  if (flow.cleanup !== undefined) summary.cleanup = flow.cleanup;
  summary.source = source;
  console.log(JSON.stringify(summary, null, 2));
}


export async function flowRemove(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive flow remove <name>");
  const removed = await removeFlow(name);
  if (!removed) throw new Error(`Unknown flow: ${name}`);
  if (isPretty()) console.log(actionLine("ok", "flow", [bold(name), dim("removed")]));
  else console.log(`removed\t${name}`);
}
