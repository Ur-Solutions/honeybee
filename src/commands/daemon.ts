// `hive daemon` — manage the hive daemon LaunchAgent; sessions/sync maintenance.
// Extracted from cli.ts (HIVE-15).
import { readDaemonStatus } from "../daemon/index.js";
import { DEFAULT_LAUNCH_LABEL, installAgent, isAgentInstalled, isLaunchctlSupported, restartAgent, startAgent, stopAgent, uninstallAgent } from "../daemon/install.js";
import { tailDaemonLog } from "../daemon/logs.js";
import { renderSystemdUnit } from "../daemon/plist.js";
import { runDaemon } from "../daemon/run.js";
import { runSentinel } from "../daemon/sentinel.js";
import { actionLine, bold, dim, errorPrefix, green, isPretty, note, red, tildify } from "../format.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { reconcileSessions, sessionIndexPath, syncManifestPath, writeSyncManifest } from "../reconcile.js";
import { followFlag, logLinesFlag, stringFlag } from "../cli/shared.js";

export async function cmdDaemon(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "status":
      return daemonStatus(parsed);
    case "run":
      return daemonRun(parsed);
    case "install":
      return daemonInstall(parsed);
    case "uninstall":
      return daemonUninstall(parsed);
    case "start":
      return daemonStart(parsed);
    case "stop":
      return daemonStop(parsed);
    case "restart":
      return daemonRestart(parsed);
    case "logs":
      return daemonLogs(parsed);
    // Internal: the out-of-process heartbeat watcher spawned by `daemon run`.
    // Deliberately absent from the usage string.
    case "sentinel":
      return daemonSentinel(parsed);
    default:
      throw new Error(
        `Unknown daemon subcommand: ${sub}\nUsage: hive daemon <install|uninstall|start|stop|restart|status|logs|run>`,
      );
  }
}


export async function daemonSentinel(parsed: Parsed) {
  const parentPid = numberFlag(parsed, ["parent-pid"], 0);
  const statePath = stringFlag(parsed, ["state-path"]);
  const staleMs = numberFlag(parsed, ["stale-ms"], 0);
  const checkMs = numberFlag(parsed, ["check-ms"], 15_000);
  const logPath = stringFlag(parsed, ["log-path"]);
  if (!parentPid || !statePath || !staleMs) {
    throw new Error("Usage (internal): hive daemon sentinel --parent-pid <pid> --state-path <file> --stale-ms <ms> [--check-ms <ms>] [--log-path <file>]");
  }
  await runSentinel({ parentPid, statePath, staleMs, checkMs, ...(logPath ? { logPath } : {}) });
}


export function daemonLabel(parsed: Parsed): string {
  const raw = flag(parsed, "label");
  if (typeof raw === "string" && raw.length > 0) return raw;
  return DEFAULT_LAUNCH_LABEL;
}


export function ensureLaunchctlOrExit(action: string): void {
  if (isLaunchctlSupported()) return;
  console.error(`${errorPrefix()} hive daemon ${action} requires macOS launchctl (platform=${process.platform}).`);
  const snippet = renderSystemdUnit({
    programArguments: [process.execPath, process.argv[1] ?? "hive", "daemon", "run"],
  });
  console.error(`\nOn Linux you can run the daemon under systemd --user with a unit similar to:\n\n${snippet}`);
  process.exit(4);
}


export async function daemonInstall(parsed: Parsed) {
  ensureLaunchctlOrExit("install");
  const label = daemonLabel(parsed);
  const force = truthy(flag(parsed, "force"));
  const result = await installAgent({ label, force });
  if (!result.installed) {
    // Already installed; installAgent's message says whether the on-disk
    // plist is stale (CLI moved, options changed) and to re-run with --force.
    if (isPretty()) console.error(`${errorPrefix()} hive daemon ${result.message}. Use --force to overwrite or uninstall first.`);
    else console.error(result.message);
    process.exit(3);
  }
  if (isPretty()) {
    console.log(actionLine("ok", "daemon", [bold("install"), dim(result.message)]));
    console.log(dim(`  label: ${result.label}`));
    console.log(dim(`  plist: ${result.plistPath}`));
  } else {
    console.log(`install\t${result.label}\t${result.plistPath}\t${result.bootstrapped ? "bootstrapped" : "plist-only"}`);
  }
}


export async function daemonUninstall(parsed: Parsed) {
  ensureLaunchctlOrExit("uninstall");
  const label = daemonLabel(parsed);
  const result = await uninstallAgent({ label });
  if (isPretty()) {
    const verb = result.removed ? "uninstalled" : "noop";
    console.log(actionLine("ok", "daemon", [bold(verb), dim(result.message)]));
  } else {
    console.log(`uninstall\t${result.label}\t${result.removed ? "removed" : "absent"}\t${result.bootedOut ? "booted-out" : "no-bootout"}`);
  }
}


export async function daemonStart(parsed: Parsed) {
  ensureLaunchctlOrExit("start");
  const label = daemonLabel(parsed);
  if (!(await isAgentInstalled(label))) {
    console.error(`${errorPrefix()} hive daemon not installed (${label}). Run: hive daemon install`);
    process.exit(3);
  }
  const result = await startAgent(label);
  if (!result.ok) {
    console.error(`${errorPrefix()} launchctl kickstart failed: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`);
    process.exit(1);
  }
  if (isPretty()) console.log(actionLine("ok", "daemon", [bold("start"), dim(label)]));
  else console.log(`start\t${label}`);
}


export async function daemonStop(parsed: Parsed) {
  ensureLaunchctlOrExit("stop");
  const label = daemonLabel(parsed);
  if (!(await isAgentInstalled(label))) {
    console.error(`${errorPrefix()} hive daemon not installed (${label}). Run: hive daemon install`);
    process.exit(3);
  }
  const result = await stopAgent(label);
  if (!result.ok) {
    console.error(`${errorPrefix()} launchctl kill failed: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`);
    process.exit(1);
  }
  if (isPretty()) console.log(actionLine("ok", "daemon", [bold("stop"), dim(label)]));
  else console.log(`stop\t${label}`);
}


export async function daemonRestart(parsed: Parsed) {
  ensureLaunchctlOrExit("restart");
  const label = daemonLabel(parsed);
  if (!(await isAgentInstalled(label))) {
    console.error(`${errorPrefix()} hive daemon not installed (${label}). Run: hive daemon install`);
    process.exit(3);
  }
  const result = await restartAgent(label);
  if (!result.ok) {
    console.error(`${errorPrefix()} launchctl kickstart -k failed: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`);
    process.exit(1);
  }
  if (isPretty()) console.log(actionLine("ok", "daemon", [bold("restart"), dim(label)]));
  else console.log(`restart\t${label}`);
}


export async function daemonLogs(parsed: Parsed) {
  const follow = followFlag(parsed);
  const lines = logLinesFlag(parsed, 50);

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  if (follow) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    await tailDaemonLog({ lines, follow, signal: controller.signal });
  } finally {
    if (follow) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}


export async function daemonRun(parsed: Parsed) {
  const tickRaw = flag(parsed, "tick-ms");
  const config: { tickMs?: number } = {};
  if (typeof tickRaw === "string") {
    const ms = Number(tickRaw);
    if (Number.isFinite(ms) && ms > 0) config.tickMs = ms;
  }
  if (isPretty()) console.error(note(`hive daemon starting (pid ${process.pid})...`));
  try {
    // The production entrypoint runs with the out-of-process sentinel: the
    // only defense that still works when this process can no longer run JS
    // (sync-blocked loop, exit path deadlocked on a poisoned threadpool).
    await runDaemon({ config, sentinel: !process.env.HIVE_DAEMON_NO_SENTINEL });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY") {
      console.error(`${errorPrefix()} ${error instanceof Error ? error.message : String(error)}`);
      process.exit(3);
    }
    throw error;
  }
}


export async function daemonStatus(parsed: Parsed) {
  const label = daemonLabel(parsed);
  const staleAfter = numberFlag(parsed, ["stale-after-ms"], 0);
  const status = await readDaemonStatus(undefined, { label, ...(staleAfter > 0 ? { staleAfterMs: staleAfter } : {}) });
  // Exit codes: 0 healthy, 3 down, 4 unhealthy/stale (process alive but not progressing).
  // Anything polling this command must treat nonzero as an outage.
  const exitCode = status.running ? (status.stale ? 4 : 0) : 3;
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    const installedTag = status.installed ? "installed" : "not-installed";
    if (!isPretty()) {
      const dot = status.running ? (status.stale ? "STALE" : "running") : "down";
      console.log(`${dot}\t${installedTag}\t${status.lock?.pid ?? ""}\t${status.state?.startedAt ?? ""}\t${status.state?.lastTickAt ?? ""}\t${status.state?.tickCount ?? 0}`);
    } else if (!status.running) {
      console.log(`${red("○")} ${bold("hive daemon")} ${dim("down")} ${dim(`(${installedTag})`)}`);
      if (status.installed && status.plistPath) {
        console.log(dim(`  plist: ${status.plistPath}`));
      } else if (!status.installed) {
        console.log(dim(`  hint: hive daemon install`));
      }
      if (status.lock) console.log(dim(`  stale lock: pid ${status.lock.pid} (${status.lock.startedAt})`));
      if (status.state) {
        console.log(dim(`  last state.json: pid ${status.state.pid} startedAt ${status.state.startedAt}`));
        console.log(dim(`  last tick: ${status.state.lastTickAt ?? "(none)"} ticks=${status.state.tickCount}`));
      }
    } else if (status.stale) {
      const reasonLabels: Record<string, string> = {
        "loop-stale": "loop heartbeat stale",
        "tick-progress-stale": "tick progress stale",
        "recent-errors-saturated": "recent errors saturated",
        "missing-state": "state missing",
      };
      const reasons = status.staleReasons.map((reason) => reasonLabels[reason] ?? reason).join(", ") || "unhealthy";
      console.log(`${red("●")} ${bold("hive daemon")} ${red(bold("UNHEALTHY"))} ${dim(`(${reasons}; threshold ${Math.round(status.staleAfterMs / 60_000)}m)`)}`);
      if (status.lock) console.log(`  pid ${status.lock.pid}  host ${status.lock.hostname || "<unknown>"}  startedAt ${status.lock.startedAt}`);
      if (status.state) {
        console.log(`  ticks ${status.state.tickCount}  lastTickAt ${status.state.lastTickAt ?? dim("(none)")}`);
        console.log(`  lastSuccessfulTickAt ${status.state.lastSuccessfulTickAt ?? dim("(none)")}`);
        if (status.state.recentErrors.length > 0) {
          console.log(dim(`  recent errors (${status.state.recentErrors.length}):`));
          for (const e of status.state.recentErrors.slice(-3)) console.log(dim(`    ${e.ts} ${e.msg}`));
        }
      }
      console.log(dim(`  hint: hive daemon restart`));
    } else {
      console.log(`${green("●")} ${bold("hive daemon")} ${dim("running")} ${dim(`(${installedTag})`)}`);
      if (status.installed && status.plistPath) {
        console.log(`  plist ${status.plistPath}`);
      }
      if (status.lock) {
        console.log(`  pid ${status.lock.pid}  host ${status.lock.hostname || "<unknown>"}  startedAt ${status.lock.startedAt}`);
      }
      if (status.state) {
        console.log(`  ticks ${status.state.tickCount}  lastTickAt ${status.state.lastTickAt ?? dim("(none)")}`);
        if (status.state.lastSuccessfulTickAt !== undefined) console.log(`  lastSuccessfulTickAt ${status.state.lastSuccessfulTickAt ?? dim("(none)")}`);
        if (status.state.recentErrors.length > 0) {
          console.log(dim(`  recent errors (${status.state.recentErrors.length}):`));
          for (const e of status.state.recentErrors.slice(-3)) console.log(dim(`    ${e.ts} ${e.msg}`));
        }
      }
    }
  }
  process.exit(exitCode);
}


export async function cmdSessions(parsed: Parsed) {
  const sub = parsed.args[0];
  if (sub !== "reconcile") throw new Error("Usage: hive sessions reconcile [--home <path>]... [--json]");
  const homeFlag = flag(parsed, "home");
  const extraHomes = Array.isArray(homeFlag) ? homeFlag : typeof homeFlag === "string" ? [homeFlag] : [];
  const index = await reconcileSessions({ extraHomes });
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(index, null, 2));
    return;
  }
  if (isPretty()) {
    console.log(actionLine("ok", "reconcile", [`${index.entries.length} sessions`, `${index.scannedHomes.length} homes`, dim(tildify(sessionIndexPath()))]));
  } else {
    console.log(`reconciled\t${index.entries.length}\t${index.scannedHomes.length}\t${sessionIndexPath()}`);
  }
  for (const duplicate of index.duplicates) {
    const locations = duplicate.locations.map((location) => tildify(location.home)).join(", ");
    console.log(note(`duplicate ${duplicate.sessionId} in: ${locations}`));
  }
  for (const conflict of index.conflicts) {
    console.log(note(`sync conflict: ${tildify(conflict)}`));
  }
  if (index.duplicates.length === 0 && index.conflicts.length === 0) {
    console.log(note("no cross-home duplicates or sync conflicts"));
  }
}


export async function cmdSync(parsed: Parsed) {
  const sub = parsed.args[0];
  if (sub !== "manifest") throw new Error("Usage: hive sync manifest [--json]");
  const manifest = await writeSyncManifest();
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (isPretty()) console.log(actionLine("ok", "manifest", [dim(tildify(syncManifestPath()))]));
  else console.log(`manifest\t${syncManifestPath()}`);
  for (const pattern of manifest.include) console.log(`  include ${pattern}`);
  for (const pattern of manifest.exclude) console.log(`  exclude ${pattern}`);
  console.log(note(manifest.note));
}
