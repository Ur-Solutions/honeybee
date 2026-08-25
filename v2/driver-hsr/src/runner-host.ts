import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

/**
 * HSR runner host — the tiny process that makes daemon restarts invisible to
 * runtimes (contract §3.2 + invariant 1's spirit: a deploy must not kill the
 * fleet).
 *
 * Before this host, the daemon spawned agent CLIs directly and owned their
 * stdio pipes; a daemon restart closed the pipe ends and every harness that
 * waits on stdin (claude/codex stream modes) died on EOF/EPIPE — the
 * "deploys kill all hsr runtimes" incident class, mislabeled machine_restart
 * at the next boot. The host inverts the ownership:
 *
 *   daemon ──spawns──▶ host (detached, own pgroup, survives the daemon)
 *                       └──spawns──▶ agent CLI (host's child, SAME pgroup,
 *                                    pipes owned by the host)
 *
 * The host is deliberately dumb — it holds pipes and moves bytes; every
 * decision stays in the daemon:
 *  - agent stdout  → session log file, verbatim non-empty lines (byte-
 *    identical to what the driver wrote in-process before — the transcript
 *    cache's file-lifetime identity depends on it), AND an output-only,
 *    generation-scoped observation journal. The driver observes the latter:
 *    restart replay can never cross generations or mistake a daemon→agent
 *    command from the bidirectional transcript for runner evidence.
 *  - agent stderr  → the `<beeId>.stderr.log` sidecar.
 *  - unix socket   → write-only lane INTO agent stdin: `{op:"write", line}`
 *    per newline-framed JSON. deliver/interrupt/respond all ride it. A
 *    restarted daemon reconnects; the socket never carries state.
 *  - status file   → the host's only outbound facts, written atomically:
 *    agentPid once the OS confirms the spawn, spawnError if it never runs,
 *    exit {code, signal} when the agent dies. The driver polls it; no
 *    response protocol on the socket keeps deliver() fire-and-forget exactly
 *    as the in-process stdin.write was.
 *
 * Lifecycle: the host exits when the agent exits (after writing the exit
 * status) — host liveness IS runtime liveness, so the daemon's pid-identity
 * adoption (pid + start time) works unchanged with the host's pid on the
 * runtime row. SIGTERM to the shared pgroup reaches the agent directly (its
 * graceful stop); the host ignores SIGTERM/SIGINT/SIGHUP and simply outlives
 * the agent by the milliseconds needed to record the exit.
 */

export interface RunnerHostConfig {
  beeId: string;
  generation: number;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  sessionLogPath: string;
  /** Output-only structured evidence for exactly (beeId, generation). */
  observationLogPath: string;
  sidecarPath: string;
  socketPath: string;
  statusPath: string;
  /** Adapter boot lines, written to agent stdin immediately after spawn. */
  bootLines: string[];
}

export interface RunnerStatus {
  hostPid: number;
  /** Present on v15+ hosts; absence identifies a legacy non-replayable host. */
  beeId?: string;
  generation?: number;
  agentPid?: number;
  /** The stdin lane could not be established (e.g. socket path unusable). */
  socketError?: string;
  /** Output-only journal persistence failed; recovery must fail closed. */
  observationError?: string;
  spawnError?: string;
  exited?: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
  at: number;
}

/** Atomic-enough status write: tmp + rename races are overkill for a single
 * writer; a torn read simply retries on the driver's next poll. */
function writeStatus(path: string, status: RunnerStatus): void {
  try {
    writeFileSync(path, JSON.stringify(status));
  } catch {
    // The driver falls back to pid-liveness when status is unreadable.
  }
}

export function readRunnerStatus(path: string): RunnerStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RunnerStatus;
    return typeof parsed?.hostPid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export function runRunnerHost(configPath: string): void {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as RunnerHostConfig;
  mkdirSync(dirname(cfg.sessionLogPath), { recursive: true });
  mkdirSync(dirname(cfg.observationLogPath), { recursive: true });
  // Exact generation journal exists before the status becomes adoptable.
  writeFileSync(cfg.observationLogPath, "", { flag: "a" });
  const status: RunnerStatus = {
    hostPid: process.pid,
    beeId: cfg.beeId,
    generation: cfg.generation,
    at: Date.now(),
  };
  writeStatus(cfg.statusPath, status);

  // The host must outlive the daemon AND the agent's graceful stop signals:
  // TERM/INT to the shared pgroup are for the AGENT; the host's own exit is
  // bound to the agent's, never to a signal.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => undefined);
  }

  // NOT detached: the agent joins the host's process group, so the daemon's
  // existing group signaling (TERM/KILL to -pid) reaches the whole tree.
  const child: ChildProcess = spawn(cfg.command, cfg.args, {
    cwd: cfg.cwd,
    env: cfg.env ?? { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let finished = false;
  const finish = (patch: Partial<RunnerStatus>): void => {
    if (finished) return;
    finished = true;
    Object.assign(status, patch, { at: Date.now() });
    writeStatus(cfg.statusPath, status);
    try {
      server.close();
    } catch {
      // Already closed.
    }
    try {
      rmSync(cfg.socketPath, { force: true });
    } catch {
      // Best effort; a stale socket path is re-unlinked on the next spawn.
    }
    // Status and log writes above are synchronous; nothing left to wait for.
    process.exit(0);
  };

  child.on("spawn", () => {
    status.agentPid = child.pid ?? -1;
    status.at = Date.now();
    writeStatus(cfg.statusPath, status);
  });
  child.on("error", (err) => {
    appendFileSync(cfg.sidecarPath, `spawn error: ${String(err?.message ?? err)}\n`);
    finish({ spawnError: String(err?.message ?? err), exited: true, exitCode: null, exitSignal: null });
  });
  // `close`, not `exit`: close fires after stdio drained, so the final
  // stdout lines are in the session log before the exit facts land.
  child.on("close", (code, signal) => {
    finish({ exited: true, exitCode: code, exitSignal: signal ?? null });
  });
  child.stdin?.on("error", () => undefined);

  // stdout → session log, replicating the in-process driver's exact line
  // rules (strip \r, skip blank lines, one trailing \n per line).
  let rest = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const data = rest + chunk;
    const lines = data.split("\n");
    rest = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) continue;
      try {
        // Recovery evidence first. If the daemon dies immediately after this
        // synchronous append, its successor can replay the line from the core
        // cursor even when the old daemon never observed it.
        appendFileSync(cfg.observationLogPath, `${line}\n`);
      } catch (error) {
        status.observationError = String((error as Error)?.message ?? error);
        status.at = Date.now();
        writeStatus(cfg.statusPath, status);
      }
      try {
        appendFileSync(cfg.sessionLogPath, `${line}\n`);
      } catch {
        // Transcript diagnostics are independent from lifecycle evidence.
        // Never crash the host or suppress the observation journal over it.
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    try {
      appendFileSync(cfg.sidecarPath, String(chunk));
    } catch {
      // Diagnostics only.
    }
  });

  // Write-only stdin lane. Multiple daemon generations connect sequentially;
  // concurrent connections are harmless (writes interleave at line level).
  rmSync(cfg.socketPath, { force: true });
  const server: Server = createServer((socket: Socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const frames = buffered.split("\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(frame) as { op?: string; line?: string };
          if (parsed.op === "write" && typeof parsed.line === "string") {
            writeAgentLine(parsed.line);
          }
        } catch {
          // Malformed frame: drop it; the daemon's delivery loop re-sends.
        }
      }
    });
    socket.on("error", () => undefined);
  });
  server.on("error", (err) => {
    // Without the socket the runtime still runs but can never hear the
    // daemon — record the fact so the driver can refuse-and-rotate instead
    // of queueing messages into a black hole.
    status.socketError = String((err as Error)?.message ?? err);
    status.at = Date.now();
    writeStatus(cfg.statusPath, status);
  });
  server.listen(cfg.socketPath);

  /**
   * One outbound line: session log FIRST (the host is the log's single
   * writer, both directions — the daemon's tail skips outbound lines by
   * exact match in send order), then agent stdin.
   */
  function writeAgentLine(line: string): void {
    try {
      appendFileSync(cfg.sessionLogPath, `${line}\n`);
    } catch {
      // Log append is observation plumbing; the delivery still happens.
    }
    if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write(`${line}\n`);
    }
  }

  for (const line of cfg.bootLines) writeAgentLine(line);
}
