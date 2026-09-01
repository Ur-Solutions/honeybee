#!/usr/bin/env node
/**
 * Capture a REAL vendor login CLI's output as a redacted parser fixture.
 *
 *   node scripts/capture-login-fixture.ts <harness> <methodId> [--ms 12000] [--out <file>] [--command "grok login"]
 *
 * Runs the recipe's CLI login command exactly as the daemon's CliRunner
 * would (isolated account home via the harness home env var, BROWSER=true,
 * a minimal env, a PTY through script(1) when the method needs a tty), records
 * the raw output chunks with timestamps, kills the CLI after `--ms`, and
 * writes v2/daemon/tests/fixtures/login/<harness>-<methodId>.json with
 * every secret-shaped thing redacted IN PLACE (same length, same shape).
 * `--command` overrides the recipe's command, for probing a vendor's newer
 * login subcommand before the recipe is updated. Redacted:
 *
 *  - URL query values for state / code / challenge / nonce / device / user /
 *    session / token keys → `x`-filled
 *  - device / user codes (`ABCD-1234`) → `XXXX-0000`-shaped
 *  - the temporary home, $HOME, hostname, user name, e-mail addresses
 *
 * The login is never completed: no credential is entered, no browser opens,
 * and the isolated home is deleted afterwards. The fixture is replayed by
 * v2/daemon/tests/login-cues.test.ts through the real LoginOutputParser with
 * the recipe's cues, so the generic regexes are validated against what the
 * vendor CLI actually prints (chunk boundaries, ANSI, redraws included).
 *
 * macOS only (script(1) syntax); the pipe backend works anywhere.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loginMethodFor, recipeFor, homeEnvFor } from "../v2/core/src/index.ts";
import { LoginOutputParser, cleanTerminalText } from "../v2/daemon/src/loginWorker.ts";
import { workerBaseEnv } from "../v2/daemon/src/login/cliRunner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const harness = args[0];
const methodId = args[1];
if (!harness || !methodId) {
  process.stderr.write("usage: capture-login-fixture.ts <harness> <methodId> [--ms 12000] [--out file] [--command \"grok login\"]\n");
  process.exit(2);
}
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : fallback;
};
const captureMs = Number(flag("--ms", "12000"));
const commandOverride = flag("--command", "");
const out = flag("--out", join(here, "..", "v2", "daemon", "tests", "fixtures", "login", `${harness}-${methodId}.json`));

const recipe = recipeFor(harness);
const method = loginMethodFor(harness, methodId);
if (!recipe || !method) throw new Error(`no recipe method ${harness}/${methodId}`);
if (method.run.mode !== "cli") throw new Error(`${methodId} is a direct method; nothing to capture`);
const spec = method.run.cli;
const homeEnv = homeEnvFor(harness);
if (!homeEnv) throw new Error(`no home env for ${harness}`);

const home = mkdtemp(`hive-login-fixture-${harness}-`);
mkdirSync(home, { recursive: true, mode: 0o700 });
const launch = commandOverride
  ? { command: commandOverride.split(/\s+/)[0] as string, args: commandOverride.split(/\s+/).slice(1) }
  : (spec.command ?? recipe.login);
const env: Record<string, string> = {
  ...workerBaseEnv(process.env),
  [homeEnv]: home,
  ...(harness === "opencode" ? { XDG_DATA_HOME: join(home, "xdg-data") } : {}),
  ...(spec.env ?? {}),
  TERM: "xterm-256color",
  COLUMNS: "400",
  LINES: "50",
};

const startedAt = Date.now();
const chunks: Array<{ t: number; data: string }> = [];
const backend = spec.tty ? "pty" : "pipe";
// script(1) gives the CLI a real pty and forwards its output to our pipe.
// Its stdin must be a real pipe that stays open (a socket is refused, an
// EOF would be typed into the CLI as ^D), so it reads from a sleeping
// writer for the whole capture.
const child = spec.tty
  ? spawn("sh", ["-c", `sleep ${Math.ceil(captureMs / 1000) + 5} | exec script -q /dev/null "$@"`, "sh", launch.command, ...launch.args], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  : spawn(launch.command, launch.args, { cwd: home, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
const record = (data: Buffer): void => {
  chunks.push({ t: Date.now() - startedAt, data: data.toString("utf8") });
};
child.stdout?.on("data", record);
child.stderr?.on("data", record);
let exit: { code: number | null; signal: string | null } | null = null;
child.on("exit", (code, signal) => {
  exit = { code, signal };
});

await new Promise((resolve) => setTimeout(resolve, captureMs));
if (exit === null) {
  try {
    process.kill(-(child.pid as number), "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (exit === null) {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
await new Promise((resolve) => setTimeout(resolve, 200));
rmSync(home, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// redaction — same length, same shape, so PTY wrapping and cue regexes see
// exactly what they would see in production
// ---------------------------------------------------------------------------

const SENSITIVE_QUERY = /^(state|code|code_challenge|challenge|nonce|device_code|user_code|session|session_id|token|access_token|id_token|verifier|client_secret|hd|login_hint)$/i;
const fill = (value: string, ch = "x"): string => value.replace(/[A-Za-z0-9]/g, ch);
const codeShape = (code: string): string => code.replace(/[A-Z]/g, "X").replace(/[a-z]/g, "x").replace(/[0-9]/g, "0");

function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const base = url.slice(0, q);
  const query = url.slice(q + 1);
  const redacted = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      return SENSITIVE_QUERY.test(key) ? `${key}=${fill(value)}` : pair;
    })
    .join("&");
  return `${base}?${redacted}`;
}

const user = userInfo().username;
const host = hostname();
const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Device / user codes are found on the ANSI-stripped text (a color reset
// right before the code defeats `\b` on the raw bytes) and replaced in the
// raw chunk wherever they occur.
const CODE_RE = /(?<![A-Za-z0-9])([A-Z0-9]{4,6}-[A-Z0-9]{4,6})(?![A-Za-z0-9])/g;
const codes = new Set<string>();
for (const c of chunks) for (const m of cleanTerminalText(c.data).matchAll(CODE_RE)) if (/[A-Z]/.test(m[1] as string)) codes.add(m[1] as string);
function redact(text: string): string {
  let t = text.replace(/https?:\/\/[^\s'"<>)\]]+/g, (m) => redactUrl(m));
  for (const code of codes) t = t.split(code).join(codeShape(code));
  t = t.split(home).join("/HOME/fixture");
  if (process.env.HOME) t = t.split(process.env.HOME).join("/HOME");
  t = t.split(host).join("HOST");
  t = t.replace(email, "user@example.com");
  if (user.length >= 3) t = t.split(user).join("user");
  return t;
}
const redactedChunks = chunks.map((c) => ({ t: c.t, data: redact(c.data) }));

// What the daemon's parser makes of it (recorded for the reader; the test
// asserts the hand-checked `expect` block, not this).
const parser = new LoginOutputParser({ cues: spec.cues, settleMs: 0 });
for (const c of redactedChunks) parser.feed(c.data, c.t);
const parsed = parser.settle(Number.MAX_SAFE_INTEGER);

let version = "unknown";
try {
  const v = spawn(launch.command, ["--version"], { env });
  let buf = "";
  v.stdout?.on("data", (d: Buffer) => (buf += d.toString()));
  await new Promise((resolve) => v.on("exit", resolve));
  version = buf.trim().split("\n")[0] ?? "unknown";
} catch {
  // version is informational only
}

const fixture = {
  harness,
  methodId,
  command: [launch.command, ...launch.args],
  backend,
  cliVersion: version,
  capturedAt: new Date(startedAt).toISOString().slice(0, 10),
  captureMs,
  exit,
  parsed: { url: parsed.url, userCode: parsed.userCode, prompt: parsed.prompt?.id ?? null, failure: parsed.failure },
  expect: { url: parsed.url, userCode: parsed.userCode, prompt: parsed.prompt?.id ?? null },
  chunks: redactedChunks,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`${out}\n${JSON.stringify(fixture.parsed)}\nchunks=${chunks.length} bytes=${chunks.reduce((n, c) => n + c.data.length, 0)} exit=${JSON.stringify(exit)}\n`);

function mkdtemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
