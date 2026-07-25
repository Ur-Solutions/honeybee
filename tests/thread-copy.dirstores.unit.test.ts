// Unit tests for the directory-store thread copy (grok/kimi/cursor): the
// shared dir copier (text-file id rewrite, .lock skip, binary verbatim),
// per-harness dispatch through copyThreadForFork against fake homes, the kimi
// index append, and the tip-only anchor refusal.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copySessionDirRewritingIds, copyThreadForFork } from "../src/threadCopy.js";

const OLD = "019f95a6-233f-7b91-98af-ea6202048f70";
const NEW = "22222222-2222-2222-2222-222222222222";

async function makeSessionDir(dir: string, id: string): Promise<void> {
  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(join(dir, "summary.json"), JSON.stringify({ info: { id } }));
  await writeFile(join(dir, "chat_history.jsonl"), `{"type":"user","content":"hello ${id}"}\n`);
  await writeFile(join(dir, "chat_history.jsonl.lock"), "");
  await writeFile(join(dir, "store.db"), Buffer.from([0x53, 0x51, 0x4c, 0x00, 0xff, 0x01]));
  await writeFile(join(dir, "agents", "wire.jsonl"), `{"sessionId":"${id}"}\n`);
}

test("copySessionDirRewritingIds rewrites text files, skips locks, copies binaries verbatim, recurses", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-dircopy-"));
  try {
    const src = join(root, "src");
    const dest = join(root, "dest");
    await makeSessionDir(src, OLD);
    const files = await copySessionDirRewritingIds(src, dest, OLD, NEW);
    assert.equal(files, 4); // summary.json, chat_history.jsonl, store.db, agents/wire.jsonl — no .lock
    assert.ok((await readFile(join(dest, "summary.json"), "utf8")).includes(NEW));
    assert.ok(!(await readFile(join(dest, "agents", "wire.jsonl"), "utf8")).includes(OLD));
    assert.deepEqual(await readFile(join(dest, "store.db")), await readFile(join(src, "store.db")));
    assert.ok(!(await readdir(dest)).includes("chat_history.jsonl.lock"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok copyThreadForFork copies into the dest cwd's encoded session dir", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-grokhome-"));
  try {
    const cwd = "/tmp/some work dir";
    const srcDir = join(home, "sessions", encodeURIComponent(cwd), OLD);
    await makeSessionDir(srcDir, OLD);
    const result = await copyThreadForFork({
      kind: "grok",
      source: { cwd, providerSessionId: OLD, homePath: home },
      destCwd: cwd,
      destHome: home,
      newSessionId: NEW,
      anchor: { kind: "tip" },
    });
    assert.equal(result.path, join(home, "sessions", encodeURIComponent(cwd), NEW));
    assert.ok((await readFile(join(result.path, "summary.json"), "utf8")).includes(NEW));
    assert.equal(result.newProviderSessionId, undefined); // raw uuid IS the grok id
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("kimi copyThreadForFork prefixes session_, copies beside the source, and appends the index", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-kimihome-"));
  try {
    const oldId = `session_${OLD}`;
    const srcDir = join(home, "sessions", "wd_work_abc123", oldId);
    await makeSessionDir(srcDir, oldId);
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: oldId, sessionDir: srcDir, workDir: "/tmp/work" })}\n`);
    const result = await copyThreadForFork({
      kind: "kimi",
      source: { cwd: "/tmp/work", providerSessionId: oldId, homePath: home },
      destCwd: "/tmp/work",
      destHome: home,
      newSessionId: NEW,
      anchor: { kind: "tip" },
    });
    assert.equal(result.newProviderSessionId, `session_${NEW}`);
    assert.equal(result.path, join(home, "sessions", "wd_work_abc123", `session_${NEW}`));
    const index = await readFile(join(home, "session_index.jsonl"), "utf8");
    const lines = index.trim().split("\n");
    assert.equal(lines.length, 2);
    const entry = JSON.parse(lines[1]!) as { sessionId: string; sessionDir: string; workDir: string };
    assert.equal(entry.sessionId, `session_${NEW}`);
    assert.equal(entry.sessionDir, result.path);
    assert.ok(!(await readFile(join(result.path, "summary.json"), "utf8")).includes(oldId));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("tip-only harnesses refuse turn anchors with the capability message, before any store lookup", async () => {
  for (const kind of ["grok", "kimi", "cursor"]) {
    await assert.rejects(
      () => copyThreadForFork({
        kind,
        source: { cwd: "/nope", providerSessionId: OLD },
        destCwd: "/nope",
        newSessionId: NEW,
        anchor: { kind: "turn", ordinal: 1 },
      }),
      /turn-anchored forks are not supported/,
    );
  }
});
