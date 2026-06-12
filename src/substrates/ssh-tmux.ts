import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { buildAttachArgv } from "../attach.js";
import type { NodeRecord } from "../node.js";
import { formatShellCommand } from "./local-tmux.js";
import type { KillResult, LaunchSpec, ProbeResult, Substrate } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_OP_TIMEOUT_MS = 8_000;
const PROBE_CACHE_TTL_MS = 5_000;

export type SshTmuxExecHook = (argv: string[], input?: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type SshTmuxOptions = {
  node: NodeRecord;
  execHook?: SshTmuxExecHook;
  now?: () => number;
};

export function createSshTmuxSubstrate(options: SshTmuxOptions): Substrate {
  const node = options.node;
  if (node.kind !== "ssh-tmux") throw new Error(`createSshTmuxSubstrate requires kind=ssh-tmux, got ${node.kind}`);
  const exec = options.execHook ?? defaultExecHook;
  const now = options.now ?? (() => Date.now());

  let probeCache: { at: number; result: ProbeResult } | undefined;

  const sshBinary = node.sshCommand ?? "ssh";
  const userSshArgs = node.sshArgs && node.sshArgs.length > 0 ? [...node.sshArgs] : undefined;
  const sshBaseArgs: string[] = userSshArgs ?? [];
  // Connection multiplexing for the exec path: without it every remote op is a
  // fresh ssh handshake (a daemon tick is O(bees) connections; sendText alone
  // is three). ControlPersist keeps a master alive for 60s of idle; %C hashes
  // local host + remote host/port/user into a short, user-unique socket name
  // under ~/.ssh. Applied ONLY when the user supplied no sshArgs of their own —
  // user-provided args replace the defaults wholesale. With ControlMaster=auto
  // ssh degrades gracefully (plain connection) if the socket cannot be created.
  const sshExecArgs: string[] = userSshArgs ?? [
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=~/.ssh/hive-%C",
    "-o", "ControlPersist=60",
  ];

  function buildSshArgv(extra: string[]): string[] {
    // ssh joins the remote command words with spaces and hands the result to
    // the remote login shell, which re-splits (and comment-strips: a bare
    // `#{session_name}` degrades to nothing). Shell-quote every word destined
    // for the remote shell so tmux receives exactly these argv elements.
    return [sshBinary, ...sshExecArgs, node.endpoint, ...extra.map(shellQuote)];
  }

  function buildSshTmuxArgv(extra: string[]): string[] {
    return buildSshArgv(["tmux", ...extra]);
  }

  async function runSsh(extra: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const argv = buildSshArgv(extra);
    return exec(argv, opts.input);
  }

  async function runTmux(extra: string[], opts: { input?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return runSsh(["tmux", ...extra], opts);
  }

  async function probe(): Promise<ProbeResult> {
    const cached = probeCache;
    if (cached && now() - cached.at < PROBE_CACHE_TTL_MS) return cached.result;
    const argv = [sshBinary, "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.ceil(DEFAULT_PROBE_TIMEOUT_MS / 1000)}`, ...sshExecArgs, node.endpoint, "true"];
    try {
      const result = await exec(argv);
      const ok = result.exitCode === 0;
      const out: ProbeResult = ok ? { ok: true } : { ok: false, reason: result.stderr.trim() || `ssh exited ${result.exitCode}` };
      probeCache = { at: now(), result: out };
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const out: ProbeResult = { ok: false, reason: message };
      probeCache = { at: now(), result: out };
      return out;
    }
  }

  async function hasSession(target: string): Promise<boolean> {
    const result = await runTmux(["has-session", "-t", `=${target}`]);
    if (result.exitCode === 0) return true;
    // Only a clean remote "no such session" answer means the bee is gone.
    // ssh exits 255 on transport failures (unreachable host, auth, timeout);
    // treating that as "session gone" would let callers (transactionalKill,
    // clean --dead) delete records of live bees on unreachable nodes — throw
    // instead so their error handling engages.
    const noSession = result.exitCode === 1 || /can't find session|no server running/i.test(result.stderr);
    if (noSession) return false;
    throw new Error(`tmux has-session on ${node.name} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }

  async function newSession(target: string, cwd: string, spec: LaunchSpec): Promise<void> {
    // Build the remote command as discrete words. buildSshArgv shell-quotes
    // every word for the transit through the remote login shell, so tmux
    // receives them as separate argv elements. Env vars ride on an `env`
    // prefix: tmux >= 3.0 exec()s a multi-word command directly (no shell),
    // where a `K=v cmd` assignment prefix would be execvp'd as a binary
    // literally named "K=v" and the session would die instantly.
    const envEntries = Object.entries(spec.env ?? {});
    const commandWords = [
      ...(envEntries.length > 0 ? ["env", ...envEntries.map(([k, v]) => `${k}=${v}`)] : []),
      spec.command,
      ...spec.args,
    ];
    const argv = buildSshTmuxArgv(["new-session", "-d", "-s", target, "-c", cwd, ...commandWords]);
    const result = await exec(argv);
    if (result.exitCode !== 0) throw new Error(`Remote tmux new-session failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  async function kill(target: string): Promise<KillResult> {
    const result = await runTmux(["kill-session", "-t", `=${target}`]);
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  // Pane-target commands (capture-pane, paste-buffer, send-keys) only honor
  // tmux's "=" exact-match prefix in the session part of a "session:" target,
  // hence the `=name:` form (exact session, active pane).
  async function capture(target: string, lines = 80): Promise<string> {
    const start = Math.max(1, Math.floor(lines));
    const result = await runTmux(["capture-pane", "-pt", `=${target}:`, "-S", `-${start}`]);
    return result.stdout.trimEnd();
  }

  async function sendText(target: string, text: string): Promise<void> {
    const buffer = `hive-${target.replace(/[^A-Za-z0-9_.:-]/g, "-")}`;
    // Stream payload via stdin so we are not bound by argv ARG_MAX limits over SSH.
    const loadArgv = buildSshTmuxArgv(["load-buffer", "-b", buffer, "-"]);
    const loadResult = await exec(loadArgv, text);
    if (loadResult.exitCode !== 0) {
      throw new Error(`Remote tmux load-buffer failed: ${loadResult.stderr.trim() || loadResult.stdout.trim()}`);
    }
    const pasteArgv = buildSshTmuxArgv(["paste-buffer", "-p", "-b", buffer, "-t", `=${target}:`]);
    const pasteResult = await exec(pasteArgv);
    if (pasteResult.exitCode !== 0) {
      throw new Error(`Remote tmux paste-buffer failed: ${pasteResult.stderr.trim() || pasteResult.stdout.trim()}`);
    }
    await sendEnter(target);
  }

  async function sendEnter(target: string): Promise<void> {
    await sendKey(target, "Enter");
  }

  async function sendKey(target: string, key: string): Promise<void> {
    const result = await runTmux(["send-keys", "-t", `=${target}:`, key]);
    if (result.exitCode !== 0) {
      throw new Error(`Remote tmux send-keys failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async function listSessions(): Promise<string[]> {
    const result = await runTmux(["list-sessions", "-F", "#{session_name}"]);
    if (result.exitCode !== 0) return [];
    return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  function attachCommand(target: string): string[] {
    // No multiplexing defaults on the interactive path (printed by --print).
    // Inside tmux this becomes a new-window wrapping of the ssh attach.
    return buildAttachArgv({
      sessionName: target,
      insideTmux: Boolean(process.env.TMUX),
      remote: { endpoint: node.endpoint, sshBinary, sshArgs: sshBaseArgs },
    });
  }

  async function attachSession(target: string): Promise<void> {
    const [command, ...args] = attachCommand(target);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command!, args, { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`${command} exited with signal ${signal}`));
          return;
        }
        if (code && code !== 0) {
          reject(new Error(`${formatShellCommand([command!, ...args])} exited with code ${code}`));
          return;
        }
        resolve();
      });
    });
  }

  return {
    kind: "ssh-tmux",
    node: node.name,
    endpoint: node.endpoint,
    probe,
    hasSession,
    newSession,
    kill,
    capture,
    sendText,
    sendEnter,
    sendKey,
    listSessions,
    attachCommand,
    attachSession,
  };
}

async function defaultExecHook(argv: string[], input?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [command, ...args] = argv;
  if (!command) throw new Error("Empty argv");
  if (input === undefined) {
    try {
      const result = await execFileAsync(command, args, { maxBuffer: 20 * 1024 * 1024, timeout: DEFAULT_OP_TIMEOUT_MS });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string; code?: number | string };
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "",
        // execFile carries the exit code in err.code (err.status is spawnSync);
        // string codes like ENOENT fall back to 1.
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Mirror the argv path's timeout so a wedged ssh cannot hang callers.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle({ stdout, stderr: stderr || `timed out after ${DEFAULT_OP_TIMEOUT_MS}ms`, exitCode: 1 });
    }, DEFAULT_OP_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", () => settle({ stdout, stderr: stderr || "spawn error", exitCode: 1 }));
    child.on("exit", (code, signal) => {
      const exitCode = code ?? (signal ? 130 : 1);
      settle({ stdout, stderr, exitCode });
    });
    // If ssh exits before consuming stdin the pending write surfaces as EPIPE;
    // without a handler that becomes an uncaught exception that can take down
    // the daemon. The failure itself is reported via the exit handler.
    child.stdin.on("error", () => undefined);
    child.stdin.write(input);
    child.stdin.end();
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
