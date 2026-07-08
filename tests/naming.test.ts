import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildTitlePrompt,
  canWriteTitle,
  describeExecError,
  failureDetail,
  gatherTitleContext,
  generateTitle,
  normalizeGeneratedTitle,
  sanitizeContextField,
  titleRank,
} from "../src/naming.js";
import { persistSessionTranscriptMetadata } from "../src/sessionMetadata.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { TranscriptFile } from "../src/transcripts.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-naming-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function bee(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CL.a3f",
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: "hive:CL-a3f",
    createdAt: "2026-06-10T11:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

/* ------------------------------ precedence ------------------------------ */

test("titleRank orders user > auto > provider > none", () => {
  assert.ok(titleRank("user") > titleRank("auto"));
  assert.ok(titleRank("auto") > titleRank("provider"));
  assert.ok(titleRank("provider") > titleRank(undefined));
});

test("canWriteTitle: provider cannot stomp user or auto titles", () => {
  assert.equal(canWriteTitle({ title: "x", titleSource: "user" }, "provider"), false);
  assert.equal(canWriteTitle({ title: "x", titleSource: "auto" }, "provider"), false);
  assert.equal(canWriteTitle({ title: "x", titleSource: "provider" }, "provider"), true);
  assert.equal(canWriteTitle({}, "provider"), true);
});

test("canWriteTitle: legacy titled records (no source) count as provider", () => {
  assert.equal(canWriteTitle({ title: "old transcript title" }, "provider"), true);
  assert.equal(canWriteTitle({ title: "old transcript title" }, "auto"), true);
});

test("canWriteTitle: auto cannot stomp user, user stomps everything", () => {
  assert.equal(canWriteTitle({ title: "x", titleSource: "user" }, "auto"), false);
  assert.equal(canWriteTitle({ title: "x", titleSource: "auto" }, "user"), true);
  assert.equal(canWriteTitle({ title: "x", titleSource: "auto" }, "auto"), true);
});

/* ---------------------------- normalization ----------------------------- */

test("normalizeGeneratedTitle passes a plain title through", () => {
  assert.equal(normalizeGeneratedTitle("Fix OAuth refresh race"), "Fix OAuth refresh race");
});

test("normalizeGeneratedTitle strips label prefixes, quotes, and markdown", () => {
  assert.equal(normalizeGeneratedTitle('Title: "Fix OAuth refresh race"'), "Fix OAuth refresh race");
  assert.equal(normalizeGeneratedTitle("# Fix OAuth refresh race."), "Fix OAuth refresh race");
  assert.equal(normalizeGeneratedTitle("**Fix OAuth refresh race**"), "Fix OAuth refresh race");
  assert.equal(normalizeGeneratedTitle("`Fix OAuth refresh race`"), "Fix OAuth refresh race");
});

test("normalizeGeneratedTitle takes the first non-empty line and collapses whitespace", () => {
  assert.equal(normalizeGeneratedTitle("\n\n  Fix   OAuth\trace  \nSecond line"), "Fix OAuth race");
});

test("normalizeGeneratedTitle clamps runaway output and rejects empties", () => {
  const long = "word ".repeat(60);
  const clamped = normalizeGeneratedTitle(long)!;
  assert.ok(clamped.length <= 72);
  assert.ok(clamped.endsWith("…"));
  assert.equal(normalizeGeneratedTitle(""), undefined);
  assert.equal(normalizeGeneratedTitle('""'), undefined);
  assert.equal(normalizeGeneratedTitle("   \n  \n"), undefined);
});

/* ------------------------------- prompt --------------------------------- */

test("buildTitlePrompt includes only the sections present and fences the content", () => {
  const prompt = buildTitlePrompt({ brief: "Fix the bug", lastAssistant: "Done, the bug was X" });
  assert.match(prompt, /Output ONLY a 3-8 word title/);
  assert.match(prompt, /BEGIN SESSION CONTENT/);
  assert.match(prompt, /END SESSION CONTENT/);
  assert.match(prompt, /Task brief:\nFix the bug/);
  assert.match(prompt, /Latest assistant reply:\nDone, the bug was X/);
  assert.doesNotMatch(prompt, /First user message:/);
});

test("buildTitlePrompt defangs @-mentions inside the embedded content", () => {
  const prompt = buildTitlePrompt({ firstUser: "read @hive-tmux-ux-prompt.md and @./src/foo.ts" });
  assert.doesNotMatch(prompt, /@hive-tmux/);
  assert.doesNotMatch(prompt, /@\.\/src/);
  assert.match(prompt, /read hive-tmux-ux-prompt\.md and \.\/src\/foo\.ts/);
});

test("sanitizeContextField strips @ only from mentions, leaving emails/text intact", () => {
  assert.equal(sanitizeContextField("ping @alice and @bob/team"), "ping alice and bob/team");
  // A mid-token @ (email) is not a mention sigil — left alone.
  assert.equal(sanitizeContextField("mail me at user@example.com"), "mail me at user@example.com");
});

test("failureDetail prefers the real error and drops the benign stdin warning", () => {
  const stdout = "Claude usage limit reached. Resets at 5pm.";
  const stderr = "Warning: no stdin data received in 3s, proceeding without it.";
  assert.match(failureDetail(stdout, stderr), /usage limit reached/);
  assert.doesNotMatch(failureDetail(stdout, stderr), /no stdin data/);
});

test("failureDetail falls back to an auth/quota hint when there is no output", () => {
  assert.match(failureDetail("", "Warning: no stdin data received in 3s, proceeding without it."), /auth\/quota/);
});

test("describeExecError names a missing binary instead of blaming auth/quota", () => {
  const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const msg = describeExecError(err, "", "");
  assert.match(msg, /not found on PATH/);
  assert.doesNotMatch(msg, /auth\/quota/);
});

test("describeExecError reports a timeout kill, not '(exit null)'", () => {
  const err = Object.assign(new Error("killed"), { code: null, killed: true, signal: "SIGKILL" as const });
  const msg = describeExecError(err, "", "");
  assert.match(msg, /timed out after \d+ms \(killed SIGKILL\)/);
  assert.doesNotMatch(msg, /exit null/);
});

test("describeExecError surfaces a real exit code + stdout error, and appends the node message when output is empty", () => {
  const withOutput = describeExecError(Object.assign(new Error("Command failed"), { code: 1 }), "Credit balance too low", "");
  assert.match(withOutput, /\(exit 1\): Credit balance too low/);
  const empty = describeExecError(Object.assign(new Error("Command failed: claude -p"), { code: 2 }), "", "");
  assert.match(empty, /\(exit 2\): no output.*— Command failed/);
});

/* ------------------------------- context -------------------------------- */

test("gatherTitleContext: brief alone is enough unless an exchange is required", async () => {
  await withTempStore(async () => {
    const record = bee({ agent: "shell", brief: "  Refactor   the parser  " });
    assert.deepEqual(await gatherTitleContext(record), { brief: "Refactor the parser" });
    assert.equal(await gatherTitleContext(record, { requireExchange: true }), null);
  });
});

test("gatherTitleContext: nothing to derive from yields null and clamps long briefs", async () => {
  await withTempStore(async () => {
    assert.equal(await gatherTitleContext(bee({ agent: "shell" })), null);
    const long = bee({ agent: "shell", brief: "x".repeat(2000) });
    const context = await gatherTitleContext(long);
    assert.ok(context && context.brief!.length <= 701);
  });
});

test("gatherTitleContext: a brief is a task signal even without a transcript first-user message", async () => {
  await withTempStore(async () => {
    // agent "shell" has no transcript provider, so firstUser/lastAssistant are
    // empty; the brief alone must still satisfy the non-strict path.
    const record = bee({ agent: "shell", brief: "Wire up the webhook retry" });
    const ctx = await gatherTitleContext(record);
    assert.deepEqual(ctx, { brief: "Wire up the webhook retry" });
    // …but requireExchange still needs an assistant reply, which "shell" can't provide.
    assert.equal(await gatherTitleContext(record, { requireExchange: true }), null);
  });
});

test("gatherTitleContext: requireExchange ignores cwd-only transcript matches", async () => {
  await withTempStore(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-naming-codex-"));
    try {
      const cwd = join(home, "workspace");
      const sessionDir = join(home, "sessions", "2026", "06", "18");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "rollout-2026-06-18T12-10-00-sibling.jsonl"),
        [
          JSON.stringify({ type: "session_meta", payload: { id: "sibling", cwd, timestamp: "2026-06-18T12:10:00.000Z" } }),
          JSON.stringify({ type: "event_msg", timestamp: "2026-06-18T12:10:01.000Z", payload: { type: "user_message", message: "fix the wrong thread" } }),
          JSON.stringify({ type: "event_msg", timestamp: "2026-06-18T12:10:05.000Z", payload: { type: "agent_message", message: "done" } }),
        ].join("\n") + "\n",
      );

      const record = bee({
        agent: "codex",
        cwd,
        command: "codex",
        homePath: home,
        createdAt: "2026-06-18T12:00:00.000Z",
        updatedAt: "2026-06-18T12:00:00.000Z",
      });

      assert.equal(await gatherTitleContext(record, { requireExchange: true }), null);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

/* ------------------------------ generation ------------------------------ */

test("generateTitle normalizes runner output and threads the prompt through", async () => {
  const prompts: string[] = [];
  const title = await generateTitle(
    { brief: "Fix the parser" },
    {
      config: { auto: true, tool: "claude", model: "haiku", effort: "low" },
      runner: async (prompt) => {
        prompts.push(prompt);
        return '"Fix parser tokenizer bug"\n';
      },
    },
  );
  assert.equal(title, "Fix parser tokenizer bug");
  assert.match(prompts[0]!, /Fix the parser/);
});

test("generateTitle throws when the runner yields nothing usable", async () => {
  await assert.rejects(
    generateTitle({ brief: "x" }, { config: { auto: true, tool: "codex", effort: "low" }, runner: async () => "\n\n" }),
    /no usable title/,
  );
});

/* ------------------- provider title precedence on sync ------------------ */

function tx(title: string, matchedBy: string[] = ["session-id"]): TranscriptFile {
  return { provider: "claude", path: "/tmp/t.jsonl", sessionId: "s1", mtimeMs: 1, rows: [], score: 0, matchedBy, title };
}

test("persistSessionTranscriptMetadata: provider titles untitled records and stamps the source", async () => {
  await withTempStore(async () => {
    const record = bee();
    await saveSession(record);
    await persistSessionTranscriptMetadata(record, tx("Provider title"));
    const stored = await loadSession(record.name);
    assert.equal(stored?.title, "Provider title");
    assert.equal(stored?.titleSource, "provider");
  });
});

test("persistSessionTranscriptMetadata: provider keeps refreshing provider/legacy titles", async () => {
  await withTempStore(async () => {
    const record = bee({ title: "Legacy title" });
    await saveSession(record);
    await persistSessionTranscriptMetadata(record, tx("Newer provider title"));
    const stored = await loadSession(record.name);
    assert.equal(stored?.title, "Newer provider title");
    assert.equal(stored?.titleSource, "provider");
  });
});

test("persistSessionTranscriptMetadata: provider never stomps user or auto titles", async () => {
  await withTempStore(async () => {
    for (const source of ["user", "auto"] as const) {
      const record = bee({ name: `CL.${source}`, title: "Kept title", titleSource: source });
      await saveSession(record);
      await persistSessionTranscriptMetadata(record, tx("Provider title"));
      const stored = await loadSession(record.name);
      assert.equal(stored?.title, "Kept title");
      assert.equal(stored?.titleSource, source);
    }
  });
});

test("persistSessionTranscriptMetadata: a weakly matched transcript never overwrites identity or title", async () => {
  await withTempStore(async () => {
    // The mass-mis-title incident: a sibling's fresh transcript in the shared
    // cwd folder matches on mtime/cwd/since alone and must not be adopted.
    const record = bee({
      title: "Original title",
      titleSource: "provider",
      providerSessionId: "own-session",
      transcriptPath: "/tmp/own.jsonl",
    });
    await saveSession(record);
    const sibling: TranscriptFile = {
      provider: "claude",
      path: "/tmp/sibling.jsonl",
      sessionId: "sibling-session",
      mtimeMs: 2,
      rows: [],
      score: 210,
      matchedBy: ["mtime", "cwd", "since"],
      title: "Sibling's title",
    };
    await persistSessionTranscriptMetadata(record, sibling);
    const stored = await loadSession(record.name);
    assert.equal(stored?.title, "Original title");
    assert.equal(stored?.providerSessionId, "own-session");
    assert.equal(stored?.transcriptPath, "/tmp/own.jsonl");
  });
});

test("persistSessionTranscriptMetadata: a weak match still honors markRunning", async () => {
  await withTempStore(async () => {
    const record = bee({ status: "dead" });
    await saveSession(record);
    await persistSessionTranscriptMetadata(record, tx("Ignored title", ["mtime", "cwd"]), { markRunning: true });
    const stored = await loadSession(record.name);
    assert.equal(stored?.status, "running");
    assert.equal(stored?.title, undefined);
    assert.equal(stored?.transcriptPath, undefined);
  });
});

test("persistSessionTranscriptMetadata: prompt and spawn-proximity matches adopt identity", async () => {
  await withTempStore(async () => {
    for (const anchor of ["prompt", "spawn-proximity"] as const) {
      const record = bee({ name: `CL.${anchor}` });
      await saveSession(record);
      await persistSessionTranscriptMetadata(record, tx("Anchored title", ["mtime", anchor]));
      const stored = await loadSession(record.name);
      assert.equal(stored?.title, "Anchored title");
      assert.equal(stored?.providerSessionId, "s1");
      assert.equal(stored?.transcriptPath, "/tmp/t.jsonl");
    }
  });
});
