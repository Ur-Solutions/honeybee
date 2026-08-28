/**
 * Native login worker (tmux-independent login, 2026-08-28): runs a vendor
 * CLI's own login command inside a Honeybee-owned pseudo-terminal, parses
 * its output into TYPED progress, and types operator input back — nothing
 * else. The terminal never leaves the daemon: clients see the flow row.
 *
 * Two process backends behind one interface:
 *  - `node-pty` (optional dependency; prebuilt for macOS/Linux) for CLIs that
 *    need a real TTY (Ink/TUI logins); loaded lazily, refused with a typed
 *    `pty_unavailable` when absent instead of degrading to tmux.
 *  - a pipe backend (child_process, own process group) for CLIs that run
 *    headless (`codex login`, `cursor-agent login`) and for tests.
 *
 * Output handling is bounded and secret-safe: ANSI/redraw noise is stripped,
 * a small rolling tail is kept in memory only, submitted secrets are masked
 * out of the echo before buffering, and NOTHING here is ever persisted. The
 * parser reports the FIRST authorization URL / user code it sees, a
 * reissued URL as a change, a prompt only when it is at the end of the
 * settled output (so a prompt that scrolled away never asks again), and
 * dedupes repeated prompt lines by state comparison.
 */
import { spawn as spawnChild } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { LoginCliCue, LoginCliSpec, LoginFieldDescriptor } from "../../core/src/index.ts";

// ---------------------------------------------------------------------------
// process backends
// ---------------------------------------------------------------------------

export interface PtyLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtyHandle {
  pid: number;
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  /** Signal the child's whole process group. */
  kill(signal: NodeJS.Signals): void;
}

export interface PtySpawner {
  readonly kind: "pty" | "pipe";
  spawn(launch: PtyLaunch): PtyHandle;
}

type NodePtyModule = {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): {
    pid: number;
    write(data: string): void;
    onData(cb: (data: string) => void): unknown;
    onExit(cb: (ev: { exitCode: number; signal?: number }) => void): unknown;
    kill(signal?: string): void;
  };
};

/**
 * npm strips the execute bit from node-pty's prebuilt macOS `spawn-helper`
 * on some installs (`posix_spawnp failed` at first spawn). Repair it once,
 * best-effort, before the backend is used; never throws.
 */
export function ensurePtySpawnHelperExecutable(resolveEntry: () => string = () => createRequire(import.meta.url).resolve("node-pty")): void {
  try {
    const entry = resolveEntry();
    const root = dirname(dirname(entry));
    const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    const mode = statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0) chmodSync(helper, 0o755);
  } catch {
    // no prebuild for this platform (node-gyp build) or unreadable: nothing to repair
  }
}

/** Load the optional node-pty backend; null when it is not installed or fails to load (typed refusal upstream). */
export async function loadNodePtySpawner(
  importer: (name: string) => Promise<unknown> = (name) => import(name),
): Promise<PtySpawner | null> {
  let mod: NodePtyModule;
  try {
    const loaded = (await importer("node-pty")) as NodePtyModule | { default: NodePtyModule };
    mod = "spawn" in loaded ? loaded : (loaded as { default: NodePtyModule }).default;
    if (typeof mod?.spawn !== "function") return null;
  } catch {
    return null;
  }
  ensurePtySpawnHelperExecutable();
  return {
    kind: "pty",
    spawn(launch) {
      const child = mod.spawn(launch.command, launch.args, {
        name: "xterm-256color",
        cols: launch.cols ?? 400,
        rows: launch.rows ?? 50,
        cwd: launch.cwd,
        env: launch.env,
      });
      return {
        pid: child.pid,
        write: (data) => child.write(data),
        onData: (cb) => {
          child.onData(cb);
        },
        onExit: (cb) => {
          child.onExit((ev) => cb(ev.exitCode, ev.signal ? String(ev.signal) : null));
        },
        kill: (signal) => signalGroup(child.pid, signal, () => child.kill(signal)),
      };
    },
  };
}

/** Pipe backend: the child runs detached in its own process group so the whole tree can be signalled. */
export function pipeSpawner(): PtySpawner {
  return {
    kind: "pipe",
    spawn(launch) {
      const child = spawnChild(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      const pid = child.pid ?? -1;
      return {
        pid,
        write: (data) => {
          try {
            child.stdin?.write(data);
          } catch {
            // the child may have closed stdin; the exit event settles the flow
          }
        },
        onData: (cb) => {
          child.stdout?.on("data", (c: string) => cb(c));
          child.stderr?.on("data", (c: string) => cb(c));
        },
        onExit: (cb) => {
          child.once("error", () => cb(null, "spawn_error"));
          child.once("exit", (code, signal) => cb(code, signal));
        },
        kill: (signal) => signalGroup(pid, signal, () => child.kill(signal)),
      };
    },
  };
}

function signalGroup(pid: number, signal: NodeJS.Signals, fallback: () => void): void {
  if (pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // not a group leader (or already gone): fall back to the pid itself
    }
  }
  try {
    fallback();
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// output cleaning
// ---------------------------------------------------------------------------

// CSI (incl. private modes), OSC (BEL or ST terminated), charset selectors,
// and single-character escapes.
const ANSI_RE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Cursor-movement CSI sequences (A-H, S, T, f, s, u) separate text that a
// TUI drew at different positions; erase sequences (J, K), colors and modes
// are dropped without a separator.
const CURSOR_MOVE_RE = /\u001b\[[0-?]*[ -/]*[A-HSTfsu]/g;

/** Strip terminal control sequences and resolve `\r` redraws within a line (the last overwrite wins). */
export function cleanTerminalText(raw: string): string {
  const stripped = raw.replace(CURSOR_MOVE_RE, " ").replace(ANSI_RE, "").replace(/\r\n/g, "\n");
  return stripped
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      // A redraw restarts the line (spinners write `\r<erase>…`); the last
      // non-empty segment is what the operator would see.
      const parts = line.split("\r").filter((part) => part.length > 0);
      return parts[parts.length - 1] ?? "";
    })
    .join("\n")
    .replace(CONTROL_RE, "");
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export interface ParsedLoginState {
  url: string | null;
  userCode: string | null;
  /** The field the CLI is waiting for right now (null = not asking). */
  prompt: LoginFieldDescriptor | null;
  /** Index into `cues.failure` that matched, or null. */
  failure: number | null;
}

export interface LoginOutputParserOptions {
  cues: LoginCliSpec["cues"];
  /** Rolling tail bound (cleaned text, characters). */
  maxTailChars?: number;
  /** A line is examined as a prompt once no output has arrived for this long. */
  settleMs?: number;
}

const DEFAULT_URL_CUE = "(https?://[^\\s'\"<>)\\]]+)";

function compile(source: string): RegExp {
  return new RegExp(source, "i");
}

/**
 * Turns a CLI's output into typed login state. Stateless with respect to
 * the process: feed chunks (with the daemon clock), then `settle(now)` to
 * evaluate the unfinished last line as a prompt. `state()` is a snapshot
 * of what was recognized; callers diff it to emit events.
 */
export class LoginOutputParser {
  private readonly urlRe: RegExp;
  private readonly codeRe: RegExp | null;
  private readonly prompts: Array<{ re: RegExp; cue: LoginCliCue }>;
  private readonly failures: RegExp[];
  private readonly maxTail: number;
  private readonly settleMs: number;
  private tail = "";
  private pending = "";
  private lastChunkAt = 0;
  private masks: string[] = [];
  private bytes = 0;
  private current: ParsedLoginState = { url: null, userCode: null, prompt: null, failure: null };

  constructor(opts: LoginOutputParserOptions) {
    this.urlRe = compile(opts.cues.url ?? DEFAULT_URL_CUE);
    this.codeRe = opts.cues.userCode ? compile(opts.cues.userCode) : null;
    this.prompts = opts.cues.prompts.map((cue) => ({ re: compile(cue.match), cue }));
    this.failures = (opts.cues.failure ?? []).map(compile);
    this.maxTail = opts.maxTailChars ?? 16_384;
    this.settleMs = opts.settleMs ?? 200;
  }

  /** Bytes of raw output seen (diagnostics only). */
  get bytesSeen(): number {
    return this.bytes;
  }

  /** Bounded in-memory tail length (diagnostics / bound tests only — the text itself never leaves the parser). */
  get tailChars(): number {
    return this.tail.length + this.pending.length;
  }

  /** Never let a submitted secret survive its echo in the tail. */
  mask(secret: string): void {
    if (secret.length >= 4) this.masks.push(secret);
  }

  feed(raw: string, now: number): ParsedLoginState {
    this.bytes += raw.length;
    this.lastChunkAt = now;
    // `pending` stays RAW so an escape sequence split across chunks is
    // cleaned whole once its tail arrives (cleaning a fragment would leave
    // `[32m`-style residue on the exact line the prompt regexes test).
    const text = this.pending + raw;
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) {
      this.pending = text.slice(-8192);
      return this.current;
    }
    const complete = this.clean(text.slice(0, lastNl + 1));
    this.pending = text.slice(lastNl + 1).slice(-8192);
    this.tail = (this.tail + complete).slice(-this.maxTail);
    this.scan(complete, false);
    return this.current;
  }

  /** Evaluate the unfinished last line once output has been quiet for settleMs. */
  settle(now: number): ParsedLoginState {
    if (this.pending.length > 0 && now - this.lastChunkAt >= this.settleMs) this.scan(this.clean(this.pending), true);
    return this.current;
  }

  /** A prompt was answered: the next prompt line is a NEW ask and a failure cue may fire again. */
  consumePrompt(): void {
    this.current = { ...this.current, prompt: null, failure: null };
  }

  private clean(raw: string): string {
    let text = cleanTerminalText(raw);
    for (const secret of this.masks) text = text.split(secret).join("••••••••");
    return text;
  }

  state(): ParsedLoginState {
    return { ...this.current };
  }

  private scan(text: string, isPending: boolean): void {
    // URL: the first one wins; a DIFFERENT later URL is a reissue. A URL that
    // is still being written (the pending line ends inside it) waits for the
    // line to settle.
    const urlMatch = this.urlRe.exec(text);
    if (urlMatch) {
      const url = (urlMatch[1] ?? urlMatch[0]).replace(/[.,;:]+$/, "");
      if (this.current.url !== url) this.current = { ...this.current, url };
    }
    if (this.codeRe) {
      // Never read a device code out of a URL path segment, and codes are
      // upper-case by convention (the cue regex itself is case-insensitive).
      const codeMatch = this.codeRe.exec(text.replace(/https?:\/\/[^\s'"<>)\]]+/g, " "));
      const code = codeMatch?.[1] ?? null;
      if (code && code === code.toUpperCase() && this.current.userCode !== code) this.current = { ...this.current, userCode: code };
    }
    for (let i = 0; i < this.failures.length; i += 1) {
      if ((this.failures[i] as RegExp).test(text) && this.current.failure === null) this.current = { ...this.current, failure: i };
    }
    // A prompt is only live when it is the LAST thing the CLI printed.
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1] ?? "";
    let prompt: LoginFieldDescriptor | null = null;
    for (const { re, cue } of this.prompts) {
      if (cue.field && re.test(last)) {
        prompt = cue.field;
        break;
      }
    }
    if (prompt) {
      if (this.current.prompt?.id !== prompt.id) this.current = { ...this.current, prompt };
    } else if (lines.length > 0 && this.current.prompt && !isPending) {
      // more complete output after the prompt line: the prompt scrolled away
      this.current = { ...this.current, prompt: null };
    }
  }
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

export type LoginWorkerEvent =
  | { kind: "url"; url: string }
  | { kind: "user_code"; code: string }
  | { kind: "prompt"; field: LoginFieldDescriptor | null }
  | { kind: "failure"; index: number }
  | { kind: "exit"; code: number | null; signal: string | null }
  | { kind: "spawn_error"; message: string };

export interface LoginWorkerOptions {
  spawner: PtySpawner;
  launch: PtyLaunch;
  cues: LoginCliSpec["cues"];
  now: () => number;
  onEvent: (event: LoginWorkerEvent) => void;
  /** Grace between SIGTERM and SIGKILL on kill(). */
  killGraceMs?: number;
  settleMs?: number;
}

/** Bounded, redacted status for diagnostics — never the terminal contents. */
export interface LoginWorkerStatus {
  pid: number;
  alive: boolean;
  backend: "pty" | "pipe";
  startedAt: number;
  exitedAt: number | null;
  bytesSeen: number;
  lastOutputAt: number | null;
  recognized: { url: boolean; userCode: boolean; prompt: string | null };
}

export class LoginWorker {
  private readonly opts: LoginWorkerOptions;
  private readonly parser: LoginOutputParser;
  private handle: PtyHandle | null = null;
  private alive = false;
  private readonly startedAt: number;
  private exitedAt: number | null = null;
  private lastOutputAt: number | null = null;
  private last: ParsedLoginState = { url: null, userCode: null, prompt: null, failure: null };
  private settleTimer: NodeJS.Timeout | null = null;
  private killing: Promise<void> | null = null;

  constructor(opts: LoginWorkerOptions) {
    this.opts = opts;
    this.startedAt = opts.now();
    this.parser = new LoginOutputParser({ cues: opts.cues, ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}) });
  }

  get pid(): number {
    return this.handle?.pid ?? -1;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  start(): void {
    let handle: PtyHandle;
    try {
      handle = this.opts.spawner.spawn(this.opts.launch);
    } catch (err) {
      this.opts.onEvent({ kind: "spawn_error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.handle = handle;
    this.alive = true;
    handle.onData((chunk) => this.onData(chunk));
    handle.onExit((code, signal) => {
      if (!this.alive) return;
      this.alive = false;
      this.exitedAt = this.opts.now();
      this.clearSettle();
      if (signal === "spawn_error") {
        this.opts.onEvent({ kind: "spawn_error", message: `could not start ${this.opts.launch.command}` });
        return;
      }
      this.opts.onEvent({ kind: "exit", code, signal });
    });
  }

  /** Type a value (+ Enter). Secrets are masked out of the echo before they can reach the tail buffer. */
  submit(value: string, secret: boolean): void {
    if (!this.handle || !this.alive) return;
    if (secret) this.parser.mask(value);
    this.handle.write(`${value}\r`);
    // The prompt is consumed; a repeated prompt line must be a NEW ask and a
    // repeated failure cue must fire again.
    this.parser.consumePrompt();
    this.last = { ...this.last, prompt: null, failure: null };
  }

  /** Terminate the whole process group: SIGTERM, then SIGKILL after the grace. Idempotent. */
  kill(): Promise<void> {
    if (this.killing) return this.killing;
    this.killing = (async () => {
      this.clearSettle();
      const handle = this.handle;
      if (!handle || !this.alive) return;
      handle.kill("SIGTERM");
      const grace = this.opts.killGraceMs ?? 1500;
      const deadline = Date.now() + grace;
      while (this.alive && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      if (this.alive) handle.kill("SIGKILL");
      const hard = Date.now() + grace;
      while (this.alive && Date.now() < hard) await new Promise((r) => setTimeout(r, 25));
    })();
    return this.killing;
  }

  status(): LoginWorkerStatus {
    return {
      pid: this.pid,
      alive: this.alive,
      backend: this.opts.spawner.kind,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      bytesSeen: this.parser.bytesSeen,
      lastOutputAt: this.lastOutputAt,
      recognized: { url: this.last.url !== null, userCode: this.last.userCode !== null, prompt: this.last.prompt?.id ?? null },
    };
  }

  /** Evaluate the pending line now (the settle window has elapsed in real time). */
  settle(): void {
    if (this.alive) this.diff(this.parser.settle(Number.MAX_SAFE_INTEGER));
  }

  private onData(chunk: string): void {
    const now = this.opts.now();
    this.lastOutputAt = now;
    this.diff(this.parser.feed(chunk, now));
    this.clearSettle();
    // The timer IS the settle clock (real elapsed time), independent of the
    // injectable daemon clock the parser stamps chunks with.
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settle();
    }, (this.opts.settleMs ?? 200) + 10);
    this.settleTimer.unref?.();
  }

  private diff(next: ParsedLoginState): void {
    const prev = this.last;
    this.last = { ...next };
    if (next.url && next.url !== prev.url) this.opts.onEvent({ kind: "url", url: next.url });
    if (next.userCode && next.userCode !== prev.userCode) this.opts.onEvent({ kind: "user_code", code: next.userCode });
    if (next.failure !== null && prev.failure === null) this.opts.onEvent({ kind: "failure", index: next.failure });
    if ((next.prompt?.id ?? null) !== (prev.prompt?.id ?? null)) this.opts.onEvent({ kind: "prompt", field: next.prompt });
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}
