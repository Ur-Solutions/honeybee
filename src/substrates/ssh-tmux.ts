import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
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
  const sshBaseArgs: string[] = node.sshArgs && node.sshArgs.length > 0 ? [...node.sshArgs] : [];

  function buildSshArgv(extra: string[]): string[] {
    return [sshBinary, ...sshBaseArgs, node.endpoint, ...extra];
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
    const argv = [sshBinary, "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.ceil(DEFAULT_PROBE_TIMEOUT_MS / 1000)}`, ...sshBaseArgs, node.endpoint, "true"];
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
    const result = await runTmux(["has-session", "-t", target]);
    return result.exitCode === 0;
  }

  async function newSession(target: string, cwd: string, spec: LaunchSpec): Promise<void> {
    // Build the remote command. We do NOT use the local-tmux launcher trick because we
    // cannot reliably ship a runner script across SSH in Phase 2 — the remote shell
    // expands env variables and executes the command directly. Document that env
    // passthrough is limited (Phase 2.1 enhancement).
    const envPrefix = spec.env && Object.keys(spec.env).length > 0
      ? Object.entries(spec.env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ") + " "
      : "";
    const cmdline = envPrefix + [spec.command, ...spec.args].map(shellQuote).join(" ");
    // cwd flows through ssh as an argv element to the remote tmux, but the
    // remote login shell may see it through tmux's own argv parsing. Quote
    // defensively so spaces and shell metacharacters in cwd cannot break it.
    const argv = buildSshTmuxArgv(["new-session", "-d", "-s", target, "-c", shellQuote(cwd), cmdline]);
    const result = await exec(argv);
    if (result.exitCode !== 0) throw new Error(`Remote tmux new-session failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  async function kill(target: string): Promise<KillResult> {
    const result = await runTmux(["kill-session", "-t", target]);
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  async function capture(target: string, lines = 80): Promise<string> {
    const start = Math.max(1, Math.floor(lines));
    const result = await runTmux(["capture-pane", "-pt", target, "-S", `-${start}`]);
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
    const pasteArgv = buildSshTmuxArgv(["paste-buffer", "-p", "-b", buffer, "-t", target]);
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
    const result = await runTmux(["send-keys", "-t", target, key]);
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
    return [sshBinary, "-t", ...sshBaseArgs, node.endpoint, "tmux", "attach-session", "-t", target];
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
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "",
        exitCode: typeof err.status === "number" ? err.status : 1,
      };
    }
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", () => resolve({ stdout, stderr: stderr || "spawn error", exitCode: 1 }));
    child.on("exit", (code, signal) => {
      const exitCode = code ?? (signal ? 130 : 1);
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
