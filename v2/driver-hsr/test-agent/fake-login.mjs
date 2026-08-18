#!/usr/bin/env node
/**
 * Fake harness LOGIN for the spec 08 login-seat tests: stands in for `claude`
 * (bare TUI → /login), `codex login`, … inside the detached tmux seat. After
 * FAKE_LOGIN_DELAY_MS (default 200) it writes the recipe's primary credential
 * file into the home named by the harness's home env var and exits 0 —
 * exactly the on-disk effect a completed real login has. Never a real agent
 * CLI, no tokens, no network.
 *
 * env FAKE_LOGIN_HOME_ENV   the env var naming the home (CLAUDE_CONFIG_DIR | CODEX_HOME | …)
 * env FAKE_LOGIN_FILE       home-relative credential file to write (auth.json | .credentials.json | …)
 * env FAKE_LOGIN_CONTENT    file content (default: a small json with a timestamp)
 * env FAKE_LOGIN_DELAY_MS   delay before writing (default 200)
 * env FAKE_LOGIN_LOG        append {home, file, at} per write
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const homeEnv = process.env.FAKE_LOGIN_HOME_ENV ?? "CLAUDE_CONFIG_DIR";
const home = process.env[homeEnv];
const file = process.env.FAKE_LOGIN_FILE ?? "auth.json";
const delay = Number(process.env.FAKE_LOGIN_DELAY_MS ?? "200");
if (!home) {
  process.stderr.write(`fake-login: ${homeEnv} is not set\n`);
  process.exit(2);
}
setTimeout(() => {
  const path = join(home, file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const content = process.env.FAKE_LOGIN_CONTENT ?? `${JSON.stringify({ fake: true, loggedInAt: Date.now() })}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  if (process.env.FAKE_LOGIN_LOG) appendFileSync(process.env.FAKE_LOGIN_LOG, `${JSON.stringify({ home, file, at: Date.now() })}\n`);
  process.exit(0);
}, delay);
