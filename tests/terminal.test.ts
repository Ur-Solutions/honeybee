import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTerminalName, terminalCandidates, terminalLaunchCommand } from "../src/terminal.js";

test("terminalCandidates orders explicit > env > TERM_PROGRAM > fallbacks", () => {
  const env = { HIVE_TERMINAL: "kitty", TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv;
  assert.deepEqual(terminalCandidates("iterm", env), ["iterm", "kitty", "ghostty", "wezterm", "alacritty", "terminal"]);
  assert.deepEqual(terminalCandidates(undefined, env), ["kitty", "ghostty", "wezterm", "alacritty", "terminal"]);
  // No signals at all: standalone terminals then Terminal.app.
  assert.deepEqual(terminalCandidates(undefined, {} as NodeJS.ProcessEnv), ["wezterm", "kitty", "alacritty", "terminal"]);
});

test("normalizeTerminalName maps TERM_PROGRAM spellings", () => {
  assert.equal(normalizeTerminalName("Apple_Terminal"), "terminal");
  assert.equal(normalizeTerminalName("iTerm.app"), "iterm");
  assert.equal(normalizeTerminalName("WezTerm"), "wezterm");
  assert.equal(normalizeTerminalName("xterm-kitty"), "kitty");
  assert.equal(normalizeTerminalName("ghostty"), "ghostty");
  assert.equal(normalizeTerminalName("cmux"), undefined);
});

test("launch invocations run the agent via a login shell in the right cwd", () => {
  const wezterm = terminalLaunchCommand("wezterm", "CLAUDE_CONFIG_DIR=/h claude", "/proj");
  assert.equal(wezterm.command, "wezterm");
  assert.deepEqual(wezterm.args.slice(0, 3), ["start", "--cwd", "/proj"]);
  assert.equal(wezterm.args.at(-1), "CLAUDE_CONFIG_DIR=/h claude");
  assert.equal(wezterm.args.at(-2), "-lc");

  const terminal = terminalLaunchCommand("terminal", "codex", "/proj");
  assert.equal(terminal.command, "osascript");
  assert.match(terminal.args[1]!, /cd \/proj && exec codex/);
  assert.match(terminal.args[3]!, /activate/);

  // AppleScript string quoting survives quotes in the command.
  const quoted = terminalLaunchCommand("terminal", `claude --label 'two words'`, "/p");
  assert.match(quoted.args[1]!, /'two words'/);

  const ghostty = terminalLaunchCommand("ghostty", "codex", "/proj");
  assert.equal(ghostty.command, "open");
  assert.deepEqual(ghostty.args.slice(0, 3), ["-na", "Ghostty", "--args"]);
});
