// HSR runner host (APIA-76): the detached `hive __hsr-run <payload>` process
// and the spawn-side fork that launches it. Extracted from cli.ts (HIVE-15).
// This process holds the harness child pipes; the CLI/daemon observe it purely
// through the run dir.
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, open, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../cli/shared.js";
import { adapterFor } from "./adapters/index.js";
import { runHsrHost } from "./host.js";
import { ensureHsrRunDir, hsrRunDir } from "./runDir.js";
import { hsrSubstrate } from "./substrate.js";
import { type RunnerOpts } from "./types.js";

/** The JSON payload the spawn path hands the detached `hive __hsr-run` host. */
export type HsrRunPayload = {
  bee: string;
  kind: string;
  cwd: string;
  sessionId?: string;
  authKind?: "subscription" | "api-key";
  model?: string;
  /**
   * Resume an existing provider session instead of starting fresh (demote:
   * tmux→HSR). The adapter turns this into `claude --resume <sessionId>` /
   * codex `thread/resume({threadId})` so the headless run rejoins the SAME
   * native transcript the tmux session was writing (HSR_EXPLORATION.md §4).
   */
  resume?: boolean;
  /** Lineage for HIVE_COMB/HIVE_PARENT env stamping (APIA-82). */
  comb?: string;
  parent?: string;
  spec: { command: string; args: string[]; env: Record<string, string> };
};


/** process.execArgv minus flags that would change the child's execution mode. */
export function inheritableExecArgvForHsr(): string[] {
  return process.execArgv.filter(
    (arg) => arg !== "--test" && !arg.startsWith("--test=") && arg !== "--watch" && !arg.startsWith("--watch="),
  );
}


/** Resolve the CLI entry path (matches spawnDetachedRun's logic). */
export async function resolveHsrEntry(): Promise<string> {
  const raw = process.argv[1];
  if (!raw) throw new Error("hsr: could not resolve CLI entry path (process.argv[1] is empty)");
  try {
    return await realpath(raw);
  } catch {
    return raw;
  }
}


/**
 * The body of the hidden `hive __hsr-run <payloadPath>` subcommand: read the
 * payload, run the harness under its RunnerAdapter via runHsrHost, and live
 * exactly as long as the session (HSR_EXPLORATION.md §7). This process holds the
 * harness child's pipes; the CLI/daemon observe it purely through the run dir.
 */
export async function runHsrHostFromPayload(payloadPath: string | undefined): Promise<void> {
  if (!payloadPath) {
    process.stderr.write("hive __hsr-run: missing payload path\n");
    process.exit(1);
  }
  let payload: HsrRunPayload;
  try {
    payload = JSON.parse(await readFile(payloadPath, "utf8")) as HsrRunPayload;
  } catch (error) {
    process.stderr.write(`hive __hsr-run: unreadable payload ${payloadPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  const adapter = adapterFor(payload.kind);
  if (!adapter) {
    process.stderr.write(`hive __hsr-run: no HSR adapter for harness "${payload.kind}"\n`);
    process.exit(1);
    return;
  }
  // The harness child needs a complete env (PATH etc.), not just the spawn
  // overrides. The tmux path gets this by merging process.env in its launcher;
  // here the host inherited the CLI's full env, so overlay spec.env on top of
  // it. (The claude adapter still scrubs ANTHROPIC_API_KEY for subscriptions.)
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") childEnv[key] = value;
  }
  Object.assign(childEnv, payload.spec.env);
  // Stamp the bee's identity so in-agent affordances (`hive here`, `hive fork`,
  // self-seal, buz) resolve the current bee WITHOUT a $TMUX_PANE (APIA-82). HSR
  // children have no pane, so HIVE_BEE is the pane-less resolution anchor.
  childEnv.HIVE_BEE = payload.bee;
  childEnv.HIVE_COMB = payload.comb ?? payload.bee;
  if (payload.parent) childEnv.HIVE_PARENT = payload.parent;
  const opts: RunnerOpts = {
    bee: payload.bee,
    cwd: payload.cwd,
    env: childEnv,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.authKind ? { authKind: payload.authKind } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.resume ? { resume: true } : {}),
    command: payload.spec.command,
    args: payload.spec.args,
    runDir: hsrRunDir(payload.bee),
  };
  const handle = await runHsrHost({ bee: payload.bee, adapter, opts, queueStartup: true });
  const shutdown = async (): Promise<void> => {
    try {
      await handle.stop();
    } catch {
      // best-effort; we're exiting regardless
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await handle.done;
  process.exit(0);
}


/**
 * Fork the detached `hive __hsr-run` host for a bee and return its pid. Mirrors
 * spawnDetachedRun/createLauncher: an 0600 payload file under a temp dir, the
 * host's stdout/stderr to a log file under the run dir, detached + unref'd so it
 * survives the CLI process.
 */
export async function spawnHsrHost(payload: HsrRunPayload): Promise<number> {
  await ensureHsrRunDir(payload.bee);
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-payload-"));
  const payloadPath = join(dir, "payload.json");
  await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });

  const logHandle = await open(join(hsrRunDir(payload.bee), "host.log"), "a", 0o600);
  try {
    const entry = await resolveHsrEntry();
    const childArgv = [...inheritableExecArgvForHsr(), entry, "__hsr-run", payloadPath];
    const child = spawnChild(process.execPath, childArgv, {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...process.env },
    });
    // Async spawn failures surface via 'error' after spawn() returns; the
    // missing-pid check below converts them into a thrown error.
    child.once("error", () => undefined);
    if (!child.pid) throw new Error(`hive __hsr-run: spawn failed (no pid for ${payload.bee})`);
    const pid = child.pid;
    child.unref();
    return pid;
  } finally {
    await logHandle.close().catch(() => undefined);
  }
}


/** Poll until the runner host records a live session, or the timeout lapses. */
export async function waitForHsrHost(bee: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const substrate = hsrSubstrate();
  while (Date.now() < deadline) {
    if (await substrate.hasSession(bee).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
