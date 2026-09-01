/**
 * Recipe cues × REAL vendor CLI output. Each fixture under
 * fixtures/login/ is a redacted capture of the actual login command
 * (scripts/capture-login-fixture.ts) — raw chunks, ANSI, redraws and all.
 * The test replays it through the daemon's LoginOutputParser with the
 * recipe's own cues and asserts the hand-checked `expect` block, once as
 * captured and once re-chunked into 16-byte writes (a PTY splits wherever
 * it likes). A cue change that silently stops recognizing a vendor's URL,
 * code or prompt fails here, not on a user's first sign-in.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loginMethodFor, recipeFor } from "../../core/src/index.ts";
import { LoginOutputParser, type ParsedLoginState } from "../src/loginWorker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "fixtures", "login");

interface LoginFixture {
  harness: string;
  methodId: string;
  command: string[];
  backend: "pty" | "pipe";
  chunks: Array<{ t: number; data: string }>;
  expect: { url: string | null; userCode: string | null; prompt: string | null };
}

const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, fixture: JSON.parse(readFileSync(join(dir, f), "utf8")) as LoginFixture }));

function replay(fixture: LoginFixture, chunkBytes: number | null): ParsedLoginState {
  const method = loginMethodFor(fixture.harness, fixture.methodId);
  assert.ok(method && method.run.mode === "cli", `${fixture.harness}/${fixture.methodId} is a CLI method`);
  const parser = new LoginOutputParser({ cues: method.run.cli.cues, settleMs: 0 });
  let t = 0;
  for (const chunk of fixture.chunks) {
    if (chunkBytes === null) parser.feed(chunk.data, chunk.t);
    else for (let i = 0; i < chunk.data.length; i += chunkBytes) parser.feed(chunk.data.slice(i, i + chunkBytes), t++);
  }
  return parser.settle(Number.MAX_SAFE_INTEGER);
}

test("every CLI login method has a captured fixture", () => {
  const covered = new Set(fixtures.map(({ fixture }) => `${fixture.harness}/${fixture.methodId}`));
  const missing: string[] = [];
  for (const harness of ["claude", "codex", "opencode", "grok", "kimi", "cursor"]) {
    for (const method of recipeFor(harness)?.loginFlow.methods ?? []) {
      if (method.run.mode === "cli" && !covered.has(`${harness}/${method.id}`)) missing.push(`${harness}/${method.id}`);
    }
  }
  // cursor-agent needs the Cursor IDE + an unlocked keychain to even print
  // its URL; its fixture is still owed (captured by hand on a Cursor box).
  assert.deepEqual(missing, ["cursor/cursor-browser"]);
});

for (const { file, fixture } of fixtures) {
  test(`${file}: the recipe cues recognize the real ${fixture.command.join(" ")} output`, () => {
    assert.equal(fixture.command[0], recipeFor(fixture.harness)?.login.command, "fixture was captured with the recipe's CLI");
    const seen = replay(fixture, null);
    assert.deepEqual({ url: seen.url, userCode: seen.userCode, prompt: seen.prompt?.id ?? null }, fixture.expect);
    assert.equal(seen.failure, null, "no failure cue on a healthy start");
  });

  test(`${file}: the same under 16-byte PTY writes`, () => {
    const seen = replay(fixture, 16);
    assert.deepEqual({ url: seen.url, userCode: seen.userCode, prompt: seen.prompt?.id ?? null }, fixture.expect);
  });

  test(`${file}: no secret survives redaction`, () => {
    const text = fixture.chunks.map((c) => c.data).join("");
    for (const key of ["state", "code_challenge", "nonce", "user_code"]) {
      for (const m of text.matchAll(new RegExp(`[?&]${key}=([^&\\s]+)`, "g"))) assert.match(m[1] as string, /^[x%._-]+$/, `${key} is x-filled`);
    }
    for (const m of text.matchAll(/(?<![A-Za-z0-9])([A-Z0-9]{4,6}-[A-Z0-9]{4,6})(?![A-Za-z0-9])/g)) {
      if (/[A-Z]/.test(m[1] as string)) assert.match(m[1] as string, /^[X0-]+$/, "device codes are shape-only");
    }
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "no e-mail address");
  });
}
