import { spawn } from "node:child_process";
import { launchEnv } from "./env.js";

// ──────────────────────────────────────────────────────────────────────────
// Local terminal launching for `hive open` — the identity-launcher escape
// hatch. Deliberately off-brand: no tmux session, no SessionRecord, just the
// agent process (with its activated identity env) in a native terminal
// window or the current one. hive's management surface does not apply.
// ──────────────────────────────────────────────────────────────────────────

export type TerminalApp = "wezterm" | "ghostty" | "kitty" | "alacritty" | "iterm" | "terminal";

export type TerminalLaunch = {
  app: TerminalApp;
  command: string;
  args: string[];
};

const SUPPORTED: TerminalApp[] = ["wezterm", "ghostty", "kitty", "alacritty", "iterm", "terminal"];

export function isTerminalApp(value: string): value is TerminalApp {
  return (SUPPORTED as string[]).includes(value);
}

function loginShell(): string {
  return process.env.SHELL ?? "/bin/zsh";
}

/**
 * Build the launcher invocation for a terminal app. `shellCommand` is run via
 * the user's login shell (-lc) so PATH managers (mise, brew) resolve the
 * agent binary in the fresh window.
 */
export function terminalLaunchCommand(app: TerminalApp, shellCommand: string, cwd: string): TerminalLaunch {
  const shell = loginShell();
  const wrapped = `cd ${shellQuote(cwd)} && exec ${shellCommand}`;
  switch (app) {
    case "wezterm":
      return { app, command: "wezterm", args: ["start", "--cwd", cwd, "--", shell, "-lc", shellCommand] };
    case "ghostty":
      return { app, command: "open", args: ["-na", "Ghostty", "--args", "-e", `${shell} -lc ${shellQuote(wrapped)}`] };
    case "kitty":
      return { app, command: "open", args: ["-na", "kitty", "--args", "--directory", cwd, shell, "-lc", shellCommand] };
    case "alacritty":
      return { app, command: "alacritty", args: ["--working-directory", cwd, "-e", shell, "-lc", shellCommand] };
    case "iterm":
      return {
        app,
        command: "osascript",
        args: [
          "-e",
          `tell application "iTerm" to create window with default profile command ${appleScriptQuote(`${shell} -lc ${shellQuote(wrapped)}`)}`,
        ],
      };
    case "terminal":
      return {
        app,
        command: "osascript",
        args: [
          "-e",
          `tell application "Terminal" to do script ${appleScriptQuote(wrapped)}`,
          "-e",
          `tell application "Terminal" to activate`,
        ],
      };
  }
}

/**
 * Preference order for the window launcher: explicit choice, then
 * HIVE_TERMINAL, then the terminal we are running inside (TERM_PROGRAM),
 * then common standalone terminals, then Terminal.app (always present on
 * macOS). Launch failures fall through to the next candidate — e.g. a
 * TERM_PROGRAM of "ghostty" with no standalone Ghostty.app (cmux embeds it).
 */
export function terminalCandidates(explicit?: string, env: NodeJS.ProcessEnv = process.env): TerminalApp[] {
  const ordered: TerminalApp[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    const normalized = normalizeTerminalName(value);
    if (normalized && !ordered.includes(normalized)) ordered.push(normalized);
  };
  push(explicit);
  push(env.HIVE_TERMINAL);
  push(env.TERM_PROGRAM);
  push("wezterm");
  push("kitty");
  push("alacritty");
  push("terminal");
  return ordered;
}

export function normalizeTerminalName(value: string): TerminalApp | undefined {
  const normalized = value.trim().toLowerCase().replace(/\.app$/, "");
  if (normalized === "wezterm") return "wezterm";
  if (normalized === "ghostty") return "ghostty";
  if (normalized === "kitty" || normalized === "xterm-kitty") return "kitty";
  if (normalized === "alacritty") return "alacritty";
  if (normalized === "iterm" || normalized === "iterm2" || normalized === "iterm.app") return "iterm";
  if (normalized === "terminal" || normalized === "apple_terminal") return "terminal";
  return undefined;
}

/**
 * Open the command in a new terminal window, trying each candidate until one
 * launches. Returns the app that worked.
 */
export async function openInNewTerminal(shellCommand: string, cwd: string, explicitApp?: string): Promise<TerminalApp> {
  const candidates = terminalCandidates(explicitApp);
  const failures: string[] = [];
  for (const app of candidates) {
    const launch = terminalLaunchCommand(app, shellCommand, cwd);
    const result = await runLauncher(launch);
    if (result.ok) return app;
    failures.push(`${app}: ${result.error}`);
    // An explicit choice should fail loudly instead of silently launching
    // a different terminal.
    if (explicitApp) break;
  }
  throw new Error(`Could not open a terminal window.\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
}

function runLauncher(launch: TerminalLaunch): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `exit ${code}` });
    });
  });
}

/** Run the command in the CURRENT terminal, inheriting stdio. Resolves to the exit code. */
export function runInCurrentTerminal(command: string, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd,
      env: launchEnv(env),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function appleScriptQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`)}"`;
}
