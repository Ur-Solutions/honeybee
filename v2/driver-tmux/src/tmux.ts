/**
 * Private-socket tmux invocation (WP5, spec 05 tmux driver point 1).
 *
 * Every tmux call goes through ONE wrapper with a pinned private socket
 * (`-S <path>`, one per daemon instance) — the driver never talks to the
 * ambient tmux server. Disciplines carried over from the v1 wrapper
 * (src/substrates/local-tmux.ts, read-only reference):
 *
 *  - the kill-server guard: `kill-server` refuses to run unless the socket
 *    is explicitly pinned AND the caller opted in — the production safety
 *    net behind the "a bee nuked my tmux" incident;
 *  - exact targets: `=name` for session commands (prefix matching would
 *    kill `CL-abcd` when targeting `CL-abc`), raw `%N` pane ids elsewhere;
 *    names are NEVER signal targets — signals go to verified pids only;
 *  - UTF-8 LC_CTYPE forced onto every call (a non-UTF-8 server mangles -F
 *    output);
 *  - the inherited TMUX/TMUX_PANE env is scrubbed so running the daemon
 *    inside a tmux client can never alias the private server to the
 *    ambient one.
 */
import { spawnSync } from "node:child_process";

export class TmuxError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, stderr: string) {
    super(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "TmuxError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface TmuxResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface TmuxServerConfig {
  /** The private server socket. Required — there is no ambient-server mode. */
  socketPath: string;
  /**
   * Explicit opt-in for kill-server (test rigs tearing down their pinned
   * server). Without it, killServer() throws — always.
   */
  allowKillServer?: boolean;
}

export class TmuxServer {
  readonly socketPath: string;
  private readonly allowKill: boolean;

  constructor(cfg: TmuxServerConfig) {
    if (!cfg.socketPath || cfg.socketPath.length === 0) {
      throw new Error("tmux driver: a private socketPath is required (never the ambient server)");
    }
    this.socketPath = cfg.socketPath;
    this.allowKill = cfg.allowKillServer ?? false;
  }

  /** Run a tmux command against the private socket, without throwing. */
  try(args: string[], opts: { input?: string } = {}): TmuxResult {
    if (args[0] === "kill-server") {
      // Guard runs BEFORE anything else — no options escape it (the v1
      // tmux-killserver-guard lesson).
      throw new Error(
        "tmux driver: refusing `kill-server` through try/run — use killServer(), which " +
          "requires an explicitly pinned, opt-in socket",
      );
    }
    return this.raw(args, opts);
  }

  /** Run a tmux command; non-zero exit throws. Returns trimmed stdout. */
  run(args: string[], opts: { input?: string } = {}): string {
    const res = this.try(args, opts);
    if (res.status !== 0) throw new TmuxError(args, res.status, res.stderr);
    return res.stdout.replace(/\n$/, "");
  }

  /**
   * Kill the PRIVATE server. Refuses without the explicit opt-in — this
   * protects live bees when a socket path is ever mis-wired.
   */
  killServer(): void {
    if (!this.allowKill) {
      throw new Error(
        "tmux driver: refusing to run `tmux kill-server` without an explicitly pinned " +
          "opt-in socket — this guard protects live bees on a shared server",
      );
    }
    this.raw(["kill-server"]);
  }

  private raw(args: string[], opts: { input?: string } = {}): TmuxResult {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.TMUX; // never let "we are inside tmux" leak into the private server
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;
    env.LC_CTYPE = "en_US.UTF-8";
    const res = spawnSync("tmux", ["-S", this.socketPath, ...args], {
      encoding: "utf8",
      env,
      input: opts.input,
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (res.error) throw res.error;
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }
}

/** POSIX shell single-quote. */
export function shQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Exact-match session target (`=name`), the v1 exact-target discipline — for session commands (kill-session, has-session). */
export function exactSession(name: string): string {
  return `=${name}`;
}

/**
 * Exact-match window/pane target (`=name:`) — for commands whose -t is a
 * window/pane (set-option on remain-on-exit, display-message, list-panes,
 * capture-pane). Without the trailing colon tmux parses the token as a bare
 * window name and fails in detached use (the v1 discipline, re-learned).
 */
export function exactPaneTarget(name: string): string {
  return `=${name}:`;
}
