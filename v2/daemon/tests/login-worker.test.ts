/**
 * The native login worker (tmux-independent login): the output parser over
 * fragmented chunks, ANSI redraws, URLs split across chunks, repeated and
 * withdrawn prompts, failure cues, bounded buffers and secret masking; and
 * the pipe backend end to end against the fake login CLI (URL → prompt →
 * typed input → credential → exit; kill terminates the whole group).
 * SAFETY: temp dirs only; never a real vendor CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_FIELD_CODE, type LoginCliSpec } from "../../core/src/index.ts";
import { LoginOutputParser, LoginWorker, cleanTerminalText, ensurePtySpawnHelperExecutable, loadNodePtySpawner, pipeSpawner, type LoginWorkerEvent } from "../src/loginWorker.ts";
import { waitFor } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(here, "..", "..", "driver-hsr", "test-agent", "fake-login-cli.mjs");

const CUES: LoginCliSpec["cues"] = {
  url: "(https?://[^\\s'\"<>)\\]]+)",
  userCode: "\\b(?:code|enter)[^\\n]{0,40}?\\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\\b",
  prompts: [
    { match: "(paste|enter)[^\\n]{0,60}\\b(code|token)\\b[^\\n]{0,40}[:>]\\s*$", field: LOGIN_FIELD_CODE },
    { match: "(paste|enter)[^\\n]{0,60}\\bapi[ -]?key\\b[^\\n]{0,40}[:>]\\s*$", field: { ...LOGIN_FIELD_CODE, id: "apiKey", label: "API key" } },
  ],
  failure: ["\\b(login|authentication) (failed|error)\\b"],
};

test("worker.clean: ANSI/OSC sequences are stripped and \\r redraws resolve to the last overwrite", () => {
  assert.equal(cleanTerminalText("\u001b[36m⠋ Starting\r\u001b[K⠙ Starting login\r\u001b[K⠹ Done\u001b[0m\nnext"), "⠹ Done\nnext");
  assert.equal(cleanTerminalText("\u001b]0;title\u0007plain\u001b[?25l"), "plain");
  assert.equal(cleanTerminalText("abc\rxy"), "xy");
});

test("worker.parser: a URL split across chunks is reported once, whole, and only once; a reissued URL is a change", () => {
  const p = new LoginOutputParser({ cues: CUES, settleMs: 50 });
  const url = "https://auth.example.com/oauth/authorize?client_id=abc&code_challenge=xyz&state=s1";
  p.feed(`Navigate to this URL:\n\n${url.slice(0, 40)}`, 1000);
  assert.equal(p.state().url, null, "a half-written URL is not reported");
  p.feed(`${url.slice(40)}\n`, 1010);
  assert.equal(p.state().url, url);
  p.feed(`${url}\n`, 1020);
  assert.equal(p.state().url, url, "the same URL again is not a change");
  p.feed("Open https://auth.example.com/oauth/authorize?state=s2 instead.\n", 1030);
  assert.equal(p.state().url, "https://auth.example.com/oauth/authorize?state=s2", "a different URL is a reissue");
});

test("worker.parser: a URL with no trailing newline is reported once the output settles", () => {
  const p = new LoginOutputParser({ cues: CUES, settleMs: 50 });
  p.feed("Open: https://example.com/login?x=1", 1000);
  assert.equal(p.state().url, null);
  assert.equal(p.settle(1020).url, null, "still inside the settle window");
  assert.equal(p.settle(1060).url, "https://example.com/login?x=1");
});

test("worker.parser: device codes, repeated prompt lines, prompts that scroll away, and failure cues", () => {
  const p = new LoginOutputParser({ cues: CUES, settleMs: 50 });
  p.feed("Enter this one-time code: ABCD-1234\nEnter this one-time code: ABCD-1234\n", 1000);
  assert.equal(p.state().userCode, "ABCD-1234");
  p.feed("Paste code here if prompted: ", 1010);
  assert.equal(p.state().prompt, null, "unfinished line waits for settle");
  assert.equal(p.settle(1100).prompt?.id, "code");
  assert.equal(p.settle(1200).prompt?.id, "code", "repeated evaluation of the same prompt is not a change");
  p.feed("\nAuthenticating…\n", 1300);
  assert.equal(p.state().prompt, null, "output after the prompt withdraws it");
  p.feed("Login failed: invalid code\nPaste code here if prompted: ", 1400);
  assert.equal(p.state().failure, 0);
  assert.equal(p.settle(1500).prompt?.id, "code", "the prompt is asked again");
});

test("worker.parser: buffers are bounded and a masked secret never survives in the tail", () => {
  const p = new LoginOutputParser({ cues: CUES, settleMs: 50, maxTailChars: 2000 });
  p.feed("x".repeat(100_000), 1000);
  assert.ok(p.tailChars <= 4096, `pending bounded: ${p.tailChars}`);
  let fed = 100_000;
  for (let i = 0; i < 200; i += 1) {
    const line = `line ${i} ${"y".repeat(100)}\n`;
    fed += line.length;
    p.feed(line, 1001 + i);
  }
  assert.ok(p.tailChars <= 2000 + 4096, `tail bounded: ${p.tailChars}`);
  assert.equal(p.bytesSeen, fed);
  const secret = "SENTINEL-SECRET-VALUE-0001";
  p.mask(secret);
  p.feed(`Paste your API key here: ${secret}\nAuthenticating ${secret}…\n`, 2000);
  // The parser exposes no text, by design; the only string-bearing surface
  // is the prompt descriptor, which is static recipe data.
  const exposed = JSON.stringify(p.state());
  assert.doesNotMatch(exposed, /SENTINEL/);
});

test("worker.node-pty: the prebuilt spawn-helper's execute bit is repaired when npm stripped it (posix_spawnp failed otherwise)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-pty-helper-"));
  try {
    const helper = join(dir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    mkdirSync(dirname(helper), { recursive: true });
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(helper, "#!/bin/sh\n");
    chmodSync(helper, 0o644);
    ensurePtySpawnHelperExecutable(() => join(dir, "lib", "index.js"));
    assert.equal(statSync(helper).mode & 0o111, 0o111);
    // absent helper / bad resolver: silent no-op
    ensurePtySpawnHelperExecutable(() => join(dir, "nope", "index.js"));
    ensurePtySpawnHelperExecutable(() => {
      throw new Error("not installed");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker.node-pty: a REAL pseudo-terminal drives the fake CLI end to end (ANSI redraw + URL + prompt + hidden input + credential + exit)", { skip: process.platform === "win32" }, async () => {
  const spawner = await loadNodePtySpawner();
  if (!spawner) {
    // node-pty is optional; the pipe backend covers the parser. Report, do not fail.
    console.log("node-pty not installed — real PTY path not exercised here");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-login-pty-"));
  const events: LoginWorkerEvent[] = [];
  try {
    const worker = new LoginWorker({
      spawner,
      launch: {
        command: process.execPath,
        args: [FAKE_CLI],
        cwd: dir,
        env: { ...(process.env as Record<string, string>), CODEX_HOME: join(dir, "home"), FAKE_LOGIN_HOME_ENV: "CODEX_HOME", FAKE_CLI_URL: "https://example.com/auth?x=1", FAKE_CLI_ANSI: "1", FAKE_CLI_PROMPT: "code", FAKE_CLI_EXPECT: "good-code", FAKE_CLI_ECHO: "1", FAKE_LOGIN_CONTENT: '{"tokens":"pty"}' },
      },
      cues: CUES,
      now: Date.now,
      onEvent: (e) => events.push(e),
      killGraceMs: 500,
      settleMs: 60,
    });
    worker.start();
    await waitFor(() => events.find((e) => e.kind === "url") ?? null, "url over pty", 8000);
    await waitFor(() => events.find((e) => e.kind === "prompt" && e.field?.id === "code") ?? null, "prompt over pty", 8000);
    worker.submit("good-code", true);
    await waitFor(() => events.find((e) => e.kind === "exit") ?? null, "exit over pty", 8000);
    assert.equal(readFileSync(join(dir, "home", "auth.json"), "utf8"), '{"tokens":"pty"}');
    assert.equal(worker.status().backend, "pty");
    assert.doesNotMatch(JSON.stringify(events), /good-code/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker.node-pty: the optional backend loads when installed, and its absence is a typed null (never tmux)", async () => {
  const missing = await loadNodePtySpawner(async () => {
    throw new Error("Cannot find module 'node-pty'");
  });
  assert.equal(missing, null);
  const bogus = await loadNodePtySpawner(async () => ({ notSpawn: true }));
  assert.equal(bogus, null);
  const real = await loadNodePtySpawner();
  if (real) assert.equal(real.kind, "pty");
});

function pipeWorker(dir: string, env: Record<string, string>, onEvent: (e: LoginWorkerEvent) => void, settleMs = 60): LoginWorker {
  return new LoginWorker({
    spawner: pipeSpawner(),
    launch: { command: process.execPath, args: [FAKE_CLI], cwd: dir, env: { ...(process.env as Record<string, string>), CODEX_HOME: join(dir, "home"), ...env } },
    cues: CUES,
    now: Date.now,
    onEvent,
    killGraceMs: 500,
    settleMs,
  });
}

test("worker.pipe: fake CLI → url (split, ANSI) → prompt → wrong input re-prompts → right input writes the credential → exit; events are typed only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-login-worker-"));
  const events: LoginWorkerEvent[] = [];
  try {
    const worker = pipeWorker(dir, {
      FAKE_CLI_URL: "https://auth.openai.com/oauth/authorize?client_id=app&state=abc",
      FAKE_CLI_SPLIT_URL: "1",
      FAKE_CLI_ANSI: "1",
      FAKE_CLI_PROMPT: "code",
      FAKE_CLI_EXPECT: "good-code",
      FAKE_CLI_ECHO: "1",
      FAKE_LOGIN_HOME_ENV: "CODEX_HOME",
      FAKE_LOGIN_FILE: "auth.json",
      FAKE_LOGIN_CONTENT: '{"tokens":"fresh"}',
    }, (e) => events.push(e));
    worker.start();
    assert.ok(worker.pid > 0);
    await waitFor(() => events.find((e) => e.kind === "url") ?? null, "url event", 5000);
    const urlEvent = events.find((e) => e.kind === "url") as Extract<LoginWorkerEvent, { kind: "url" }>;
    assert.equal(urlEvent.url, "https://auth.openai.com/oauth/authorize?client_id=app&state=abc", "chunk-split URL rejoined");
    await waitFor(() => events.find((e) => e.kind === "prompt" && e.field?.id === "code") ?? null, "prompt", 5000);
    worker.submit("wrong-code", true);
    await waitFor(() => events.find((e) => e.kind === "failure") ?? null, "failure cue", 5000);
    await waitFor(() => events.filter((e) => e.kind === "prompt" && e.field?.id === "code").length >= 2 ? true : null, "re-prompt", 5000);
    worker.submit("good-code", true);
    await waitFor(() => events.find((e) => e.kind === "exit") ?? null, "exit", 5000);
    assert.equal(readFileSync(join(dir, "home", "auth.json"), "utf8"), '{"tokens":"fresh"}');
    assert.equal(worker.isAlive, false);
    const status = worker.status();
    assert.equal(status.backend, "pipe");
    assert.ok(status.bytesSeen > 0);
    assert.deepEqual(Object.keys(status).sort(), ["alive", "backend", "bytesSeen", "exitedAt", "lastOutputAt", "pid", "recognized", "startedAt"]);
    assert.doesNotMatch(JSON.stringify(events), /wrong-code|good-code/, "typed events carry no input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker.pipe: kill() terminates a hanging CLI (whole group) and reports a signalled exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-login-worker-"));
  const events: LoginWorkerEvent[] = [];
  try {
    const worker = pipeWorker(dir, { FAKE_CLI_URL: "https://example.com/x", FAKE_CLI_HANG: "1", FAKE_LOGIN_HOME_ENV: "CODEX_HOME" }, (e) => events.push(e));
    worker.start();
    await waitFor(() => events.find((e) => e.kind === "url") ?? null, "url", 5000);
    const pid = worker.pid;
    await worker.kill();
    assert.equal(worker.isAlive, false);
    assert.throws(() => process.kill(pid, 0), "the process is gone");
    assert.ok(events.some((e) => e.kind === "exit"));
    assert.equal(existsSync(join(dir, "home", "auth.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker.pipe: a missing CLI is a typed spawn_error, not a hang", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-login-worker-"));
  const events: LoginWorkerEvent[] = [];
  try {
    const worker = new LoginWorker({
      spawner: pipeSpawner(),
      launch: { command: join(dir, "definitely-not-a-cli"), args: [], cwd: dir, env: {} },
      cues: CUES,
      now: Date.now,
      onEvent: (e) => events.push(e),
    });
    worker.start();
    await waitFor(() => events.find((e) => e.kind === "spawn_error") ?? null, "spawn error", 5000);
    assert.equal(worker.isAlive, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
