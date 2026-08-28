#!/usr/bin/env node
/**
 * Fake vendor LOGIN CLI for the tmux-independent login-flow tests: stands
 * in for `codex login --device-auth`, `grok`, `kimi`, `cursor-agent login`
 * inside the Honeybee login worker. Scripted by env, no network, no real
 * tokens. It can print a sign-in URL (optionally split across two writes),
 * a device code, ANSI-decorated redraws, prompt for a code / API key on
 * stdin, accept or reject it, write the recipe's primary credential file
 * into the home named by the harness's home env var, and exit — or hang
 * until killed.
 *
 * env FAKE_LOGIN_HOME_ENV      env var naming the home (CODEX_HOME | GROK_HOME | …)
 * env FAKE_LOGIN_FILE          home-relative credential file to write (auth.json | …)
 * env FAKE_LOGIN_CONTENT       file content (default: a small json)
 * env FAKE_CLI_URL             sign-in URL to print (default: none)
 * env FAKE_CLI_SPLIT_URL=1     print the URL in two chunks 30 ms apart (chunk-boundary test)
 * env FAKE_CLI_CODE            device/user code to print ("Enter this one-time code: XXXX-YYYY")
 * env FAKE_CLI_ANSI=1          wrap output in colors + a spinner redraw (\r) before the URL
 * env FAKE_CLI_PROMPT          code | apikey — ask on stdin; FAKE_CLI_EXPECT is the accepted value
 * env FAKE_CLI_EXPECT          accepted input (default "good")
 * env FAKE_CLI_REJECT_EXITS=1  exit 1 after the first rejected input (default: re-prompt)
 * env FAKE_CLI_WRITE_AFTER_MS  write the credential after this delay without any prompt (browser-style)
 * env FAKE_CLI_EXIT_NO_CRED_MS exit 0 after this delay WITHOUT writing (process-exit-without-credential)
 * env FAKE_CLI_HANG=1          never exit on its own (kill test)
 * env FAKE_CLI_ECHO=1          echo stdin lines back to stdout (terminal echo simulation)
 * env FAKE_CLI_LOG             append {event, at} lines
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const homeEnv = process.env.FAKE_LOGIN_HOME_ENV ?? "CODEX_HOME";
const home = process.env[homeEnv];
const file = process.env.FAKE_LOGIN_FILE ?? "auth.json";
const content = process.env.FAKE_LOGIN_CONTENT ?? `${JSON.stringify({ fake: true, loggedInAt: Date.now() })}\n`;
const log = (event) => {
  if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ event, at: Date.now() })}\n`);
};
const out = (text) => process.stdout.write(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!home) {
  process.stderr.write(`fake-login-cli: ${homeEnv} is not set\n`);
  process.exit(2);
}

function writeCredential() {
  const path = join(home, file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  log("credential_written");
}

async function main() {
  const ansi = process.env.FAKE_CLI_ANSI === "1";
  if (ansi) {
    out("\u001b[?25l\u001b[36m⠋ Starting login…\r\u001b[K⠙ Starting login…\r\u001b[K⠹ Contacting provider…\u001b[0m\n");
    out("\u001b]0;fake login\u0007");
  }
  if (process.env.FAKE_CLI_URL) {
    const url = process.env.FAKE_CLI_URL;
    if (process.env.FAKE_CLI_SPLIT_URL === "1") {
      const cut = Math.floor(url.length / 2);
      out(`If your browser did not open, navigate to this URL to authenticate:\n\n${url.slice(0, cut)}`);
      await sleep(30);
      out(`${url.slice(cut)}\n\n`);
    } else {
      out(`${ansi ? "\u001b[1m" : ""}Open this URL to sign in: ${url}${ansi ? "\u001b[0m" : ""}\n`);
    }
  }
  if (process.env.FAKE_CLI_CODE) {
    out(`Enter this one-time code: ${process.env.FAKE_CLI_CODE}\n`);
    // A repeated prompt line (the real CLIs re-print while polling).
    out(`Enter this one-time code: ${process.env.FAKE_CLI_CODE}\n`);
  }
  if (process.env.FAKE_CLI_PROMPT) {
    const prompt = process.env.FAKE_CLI_PROMPT === "apikey" ? "Paste your API key here: " : "Paste code here if prompted: ";
    const expected = process.env.FAKE_CLI_EXPECT ?? "good";
    const rl = createInterface({ input: process.stdin, terminal: false });
    out(prompt);
    for await (const line of rl) {
      const value = line.replace(/\r$/, "");
      if (process.env.FAKE_CLI_ECHO === "1") out(`${value}\n`);
      log("input_received");
      if (value === expected) {
        out("\nAuthenticating…\n");
        await sleep(20);
        writeCredential();
        out("Login successful\n");
        await sleep(20);
        process.exit(0);
      }
      out("\nLogin failed: invalid code\n");
      if (process.env.FAKE_CLI_REJECT_EXITS === "1") process.exit(1);
      out(prompt);
    }
    process.exit(1);
  }
  if (process.env.FAKE_CLI_WRITE_AFTER_MS) {
    await sleep(Number(process.env.FAKE_CLI_WRITE_AFTER_MS));
    writeCredential();
    out("Login successful\n");
    await sleep(20);
    process.exit(0);
  }
  if (process.env.FAKE_CLI_EXIT_NO_CRED_MS) {
    await sleep(Number(process.env.FAKE_CLI_EXIT_NO_CRED_MS));
    out("Goodbye\n");
    process.exit(0);
  }
  if (process.env.FAKE_CLI_HANG === "1") {
    setInterval(() => out(""), 1000);
    return;
  }
  process.exit(0);
}

void main();
