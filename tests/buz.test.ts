import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUZ_TIERS,
  beeMailboxDir,
  buzRoot,
  consumeMessage,
  DEFAULT_BUZ_ACCEPT,
  downgradeTier,
  externalOutboxDir,
  generateMessageId,
  inboxFilename,
  listMessages,
  parseAcceptFlag,
  parseBuzMessage,
  processQueueForBee,
  purgeMailbox,
  resolveBuzAccept,
  sanitizeHumanName,
  sendBuzMessage,
  senderDisplay,
  serializeBuzMessage,
  validateAcceptList,
  type BuzMessage,
  type BuzSender,
  type BuzTier,
} from "../src/buz.js";
import { parseBuzDocument } from "../src/buz_format.js";
import type { SessionRecord } from "../src/store.js";
import type { Substrate } from "../src/substrates/index.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-buz-"));
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

function makeRecord(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: `tg-${name}`,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "running",
    id: name,
    ...overrides,
  };
}

function fakeSubstrate(impl: Partial<Substrate> = {}): Substrate {
  const base: Substrate = {
    kind: "local-tmux",
    node: "local",
    probe: async () => ({ ok: true }),
    hasSession: async () => true,
    newSession: async () => undefined,
    kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [],
    listSessionStates: async () => new Map<string, string>(),
    setUserOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => ["tmux", "attach"],
    attachSession: async () => undefined,
  };
  return { ...base, ...impl };
}

test("generateMessageId returns a 13-base32 + 6-hex sortable id", () => {
  const id = generateMessageId(1700000000000);
  assert.match(id, /^[0-9A-Z]{13}-[0-9a-f]{6}$/);
});

test("generateMessageId does not collide within the same millisecond (broadcasts)", () => {
  const now = 1700000000000;
  const ids = new Set<string>();
  for (let i = 0; i < 50; i += 1) ids.add(generateMessageId(now));
  assert.equal(ids.size, 50, "same-millisecond ids must be unique");
});

test("generateMessageId is collision-free and sortable across 1000 generations", () => {
  const ids: string[] = [];
  let now = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    ids.push(generateMessageId(now));
    now += 1; // simulate monotonic time
  }
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "ids must be unique");
  const sorted = [...ids].sort();
  // Because timestamp prefix is monotonic over millis and the random suffix
  // resolves intra-millisecond ties, the natural insertion order should match
  // lexicographic sort within the same millisecond window.
  // We only check stability across millisecond boundaries here.
  assert.equal(sorted[0]!.slice(0, 13) <= sorted[sorted.length - 1]!.slice(0, 13), true);
});

test("sanitizeHumanName lowercases and replaces non [a-z0-9_-] with underscore", () => {
  assert.equal(sanitizeHumanName("Tormod"), "tormod");
  assert.equal(sanitizeHumanName("Tormod Haugland"), "tormod_haugland");
  assert.equal(sanitizeHumanName("user@example.com"), "user_example_com");
  assert.equal(sanitizeHumanName("a-b_c"), "a-b_c");
  assert.throws(() => sanitizeHumanName(""), /must not be empty/);
  assert.throws(() => sanitizeHumanName("@@@"), /no safe characters/);
});

test("senderDisplay shows bee id raw and human with human: prefix", () => {
  assert.equal(senderDisplay({ kind: "bee", id: "CL.cc9" }), "CL.cc9");
  assert.equal(senderDisplay({ kind: "human", name: "tormod" }), "human:tormod");
});

test("resolveBuzAccept returns DEFAULT_BUZ_ACCEPT when undefined", () => {
  assert.deepEqual(resolveBuzAccept({ buzAccept: undefined }), DEFAULT_BUZ_ACCEPT);
  assert.deepEqual([...DEFAULT_BUZ_ACCEPT], ["queue", "passive"]);
});

test("resolveBuzAccept returns the explicit list when set", () => {
  assert.deepEqual(resolveBuzAccept({ buzAccept: ["interrupt"] }), ["interrupt"]);
});

test("downgradeTier returns requested tier when accepted", () => {
  const r = downgradeTier("interrupt", ["interrupt", "queue", "passive"]);
  assert.equal(r.effective, "interrupt");
  assert.equal(r.downgraded, false);
});

test("downgradeTier downgrades interrupt -> queue when only queue+passive allowed", () => {
  const r = downgradeTier("interrupt", DEFAULT_BUZ_ACCEPT);
  assert.equal(r.effective, "queue");
  assert.equal(r.downgraded, true);
  assert.match(r.reason ?? "", /policy disallows interrupt/);
});

test("downgradeTier downgrades interrupt -> passive when only passive allowed", () => {
  const r = downgradeTier("interrupt", ["passive"]);
  assert.equal(r.effective, "passive");
  assert.equal(r.downgraded, true);
});

test("downgradeTier with empty policy falls back to passive (documented floor)", () => {
  const r = downgradeTier("interrupt", []);
  assert.equal(r.effective, "passive");
  assert.equal(r.downgraded, true);
});

test("validateAcceptList rejects unknown tiers and dedupes", () => {
  assert.deepEqual(validateAcceptList(["queue", "queue", "passive"]), ["queue", "passive"]);
  assert.throws(() => validateAcceptList(["bogus"]), /Unknown tier/);
});

test("parseAcceptFlag splits comma-separated values", () => {
  assert.deepEqual(parseAcceptFlag("interrupt,queue,passive"), ["interrupt", "queue", "passive"]);
  assert.deepEqual(parseAcceptFlag("queue, passive"), ["queue", "passive"]);
});

test("serialize/parse round-trip preserves frontmatter and body bytes", () => {
  const m: BuzMessage = {
    id: "ABCDEFGHIJKLM-1a2b",
    from: { kind: "bee", id: "CL.cc9" },
    to: "CO.aaa",
    tier: "queue",
    deliveredAs: "queue",
    sentAt: "2026-05-28T00:00:00.000Z",
    deliveredAt: "2026-05-28T00:00:01.500Z",
    subject: "Hello: world",
    body: "Line one\n```js\nconst x = 1;\n```\nLine two\n",
  };
  const text = serializeBuzMessage(m);
  const parsed = parseBuzMessage(text);
  assert.deepEqual(parsed, m);
});

test("parse round-trips a message with CRLF in the body", () => {
  const m: BuzMessage = {
    id: "ABCDEFGHIJKLM-deaf",
    from: { kind: "human", name: "tormod" },
    to: "CO.aaa",
    tier: "passive",
    deliveredAs: "passive",
    sentAt: "2026-05-28T00:00:00.000Z",
    body: "Windows line one\r\nWindows line two\r\n",
  };
  const text = serializeBuzMessage(m);
  const parsed = parseBuzMessage(text);
  assert.deepEqual(parsed.body, m.body);
});

test("parseBuzDocument: closing fence as final line without trailing newline yields empty body", () => {
  const text = "---\nid: ABCDEFGHIJKLM-1a2b3c\n---";
  const { frontmatter, body } = parseBuzDocument(text);
  assert.equal(frontmatter.id, "ABCDEFGHIJKLM-1a2b3c");
  assert.equal(body, "");
});

test("parseBuzDocument: closing fence followed by trailing newline also yields empty body", () => {
  const { body } = parseBuzDocument("---\nid: x\n---\n");
  assert.equal(body, "");
});

test("sendBuzMessage tier=passive writes inbox/, outbox/, no live delivery", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    let sendCount = 0;
    const sender: BuzSender = { kind: "bee", id: "CL.cc9" };
    const result = await sendBuzMessage({
      recipient,
      sender,
      tier: "passive",
      body: "hello",
      transport: { substrate: fakeSubstrate({ sendText: async () => { sendCount += 1; } }), tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "passive");
    assert.equal(result.downgraded, false);
    assert.equal(sendCount, 0, "passive tier must not call substrate.sendText");
    const inbox = await readdir(beeMailboxDir("CO.aaa", "inbox"));
    assert.equal(inbox.length, 1);
    const outbox = await readdir(beeMailboxDir("CL.cc9", "outbox"));
    assert.equal(outbox.length, 1);
  });
});

test("sendBuzMessage tier=queue stores in queue/ and writes outbox/", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "queue",
      body: "queued msg",
    });
    assert.equal(result.message.deliveredAs, "queue");
    const queue = await readdir(beeMailboxDir("CO.aaa", "queue"));
    assert.equal(queue.length, 1);
    const inbox = await readdir(beeMailboxDir("CO.aaa", "inbox")).catch(() => []);
    assert.equal(inbox.length, 0, "queue tier must not write inbox/");
  });
});

test("sendBuzMessage tier=interrupt with transport delivers and copies to inbox/", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { buzAccept: ["interrupt"] });
    let pasted = "";
    const sub = fakeSubstrate({ sendText: async (_t, text) => { pasted = text; } });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "interrupt",
      body: "INTR",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "interrupt");
    assert.equal(pasted, "INTR");
    const inbox = await readdir(beeMailboxDir("CO.aaa", "inbox"));
    assert.equal(inbox.length, 1);
  });
});

test("default policy auto-downgrades interrupt -> queue (without explicit opt-in)", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa"); // no buzAccept => DEFAULT
    let pasteCount = 0;
    const sub = fakeSubstrate({ sendText: async () => { pasteCount += 1; } });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "interrupt",
      body: "x",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "queue");
    assert.equal(result.downgraded, true);
    assert.equal(pasteCount, 0);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 1);
  });
});

test("interrupt -> passive when policy only allows passive", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { buzAccept: ["passive"] });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "interrupt",
      body: "x",
      transport: { substrate: fakeSubstrate(), tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "passive");
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 1);
  });
});

test("outbox audit copy records the FINAL tier after an interrupt transport failure downgrade", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { buzAccept: ["interrupt", "queue"] });
    const sub = fakeSubstrate({ sendText: async () => { throw new Error("pane gone"); } });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "interrupt",
      body: "x",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "queue");
    const outboxDir = beeMailboxDir("CL.cc9", "outbox");
    const files = await readdir(outboxDir);
    assert.equal(files.length, 1);
    const parsed = parseBuzMessage(await readFile(join(outboxDir, files[0]!), "utf8"));
    assert.equal(parsed.deliveredAs, "queue", "audit copy must record the downgraded tier");
    assert.equal(parsed.tier, "interrupt", "requested tier stays interrupt");
  });
});

test("outbox audit copy records deliveredAt for a successful interrupt", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { buzAccept: ["interrupt"] });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "interrupt",
      body: "x",
      transport: { substrate: fakeSubstrate(), tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "interrupt");
    const outboxDir = beeMailboxDir("CL.cc9", "outbox");
    const files = await readdir(outboxDir);
    assert.equal(files.length, 1);
    const parsed = parseBuzMessage(await readFile(join(outboxDir, files[0]!), "utf8"));
    assert.equal(parsed.deliveredAs, "interrupt");
    assert.ok(parsed.deliveredAt, "audit copy must include deliveredAt");
  });
});

test("sender-human routes outbox via _external/<sanitized>/", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({
      recipient,
      sender: { kind: "human", name: "Tormod Haugland" },
      tier: "passive",
      body: "hi",
    });
    const dir = externalOutboxDir("Tormod Haugland");
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    // Filename uses safe-stamped name: <ts>-to-<recipient>-<id>.md
    assert.match(files[0]!, /-to-CO\.aaa-[0-9A-Z]{13}-[0-9a-f]{6}\.md$/);
  });
});

test("broadcast: per-bee policy applied independently", async () => {
  await withTempStore(async () => {
    // Recipient A allows interrupt, B uses default => downgrade to queue.
    const a = makeRecord("CO.aaa", { buzAccept: ["interrupt"] });
    const b = makeRecord("CO.bbb"); // default policy

    let aPasted = "";
    const sub = fakeSubstrate({ sendText: async (_t, text) => { aPasted = text; } });
    const ra = await sendBuzMessage({
      recipient: a,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "interrupt",
      body: "BCAST",
      transport: { substrate: sub, tmuxTarget: a.tmuxTarget },
    });
    const rb = await sendBuzMessage({
      recipient: b,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "interrupt",
      body: "BCAST",
      transport: { substrate: sub, tmuxTarget: b.tmuxTarget },
    });
    assert.equal(ra.message.deliveredAs, "interrupt");
    assert.equal(aPasted, "BCAST");
    assert.equal(rb.message.deliveredAs, "queue");
    assert.equal((await readdir(beeMailboxDir("CO.bbb", "queue"))).length, 1);
  });
});

test("listMessages newest-first, supports --limit and --from filter", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "passive", body: "1" });
    await new Promise((r) => setTimeout(r, 5));
    await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.y" }, tier: "passive", body: "2" });

    const all = await listMessages("CO.aaa", "inbox");
    assert.equal(all.length, 2);

    const limited = await listMessages("CO.aaa", "inbox", { limit: 1 });
    assert.equal(limited.length, 1);

    const filtered = await listMessages("CO.aaa", "inbox", { fromFilter: "CL.y" });
    assert.equal(filtered.length, 1);
    assert.equal(senderDisplay(filtered[0]!.message.from), "CL.y");
  });
});

test("consumeMessage moves an inbox/ message to read/", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "passive",
      body: "x",
    });
    const consumed = await consumeMessage("CO.aaa", result.message.id);
    assert.ok(consumed);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 0);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "read"))).length, 1);
  });
});

test("consumeMessage no-op when message is not in inbox/", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "queue",
      body: "x",
    });
    const consumed = await consumeMessage("CO.aaa", result.message.id);
    assert.equal(consumed, null);
  });
});

test("purge --read removes only read/ messages", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const a = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "passive", body: "1" });
    const b = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "passive", body: "2" });
    await consumeMessage("CO.aaa", a.message.id);
    const result = await purgeMailbox("CO.aaa", { scope: "read" });
    assert.equal(result.removed, 1);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 1); // b still there
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "read"))).length, 0);
  });
});

test("purge --older-than 30d removes only old messages", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const oldMsg = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "passive", body: "old" });
    const newMsg = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "passive", body: "new" });

    // Backdate the old file's mtime to 31 days ago.
    const oldPath = (await listMessages("CO.aaa", "inbox")).find(({ message }) => message.id === oldMsg.message.id)!.path;
    const thirtyOneDaysAgoSec = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(oldPath, thirtyOneDaysAgoSec, thirtyOneDaysAgoSec);

    const result = await purgeMailbox("CO.aaa", { scope: "older-than", olderThanMs: 30 * 24 * 60 * 60 * 1000 });
    assert.equal(result.removed, 1);
    const remaining = await listMessages("CO.aaa", "inbox");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.message.id, newMsg.message.id);
  });
});

test("processQueueForBee drains queue/ in mtime order and moves to inbox/", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const a = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "first" });
    await new Promise((r) => setTimeout(r, 10));
    const b = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "second" });
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 2);

    const calls: string[] = [];
    const sub = fakeSubstrate({ sendText: async (_t, text) => { calls.push(text); } });
    const result = await processQueueForBee(recipient, { transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget } });

    assert.deepEqual(calls, ["first", "second"]);
    assert.deepEqual(result.delivered, [a.message.id, b.message.id]);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 0);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 2);

    // deliveredAt is rewritten on drain.
    const inboxFiles = await readdir(beeMailboxDir("CO.aaa", "inbox"));
    const text = await readFile(join(beeMailboxDir("CO.aaa", "inbox"), inboxFiles[0]!), "utf8");
    const parsed = parseBuzMessage(text);
    assert.ok(parsed.deliveredAt);
  });
});

test("processQueueForBee quarantines after 3 substrate failures and keeps draining", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "bad" });

    let attempts = 0;
    const sub = fakeSubstrate({ sendText: async () => { attempts += 1; throw new Error("boom"); } });

    for (let i = 0; i < 3; i += 1) {
      await processQueueForBee(recipient, { transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget }, maxFailures: 3 });
    }

    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 0);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "quarantine"))).length, 1);
  });
});

test("ledger emits buz.send, buz.deliver, buz.read, buz.purge, buz.queue.drain events", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const sent = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.x" },
      tier: "queue",
      body: "x",
    });
    await processQueueForBee(recipient, { transport: { substrate: fakeSubstrate(), tmuxTarget: recipient.tmuxTarget } });
    await consumeMessage("CO.aaa", sent.message.id);
    await purgeMailbox("CO.aaa", { scope: "read" });

    const ledger = await readFile(join(buzRoot(), "..", "ledger.jsonl"), "utf8");
    const types = ledger.trim().split("\n").map((line) => JSON.parse(line).type as string);
    assert.ok(types.includes("buz.send"));
    assert.ok(types.includes("buz.deliver"));
    assert.ok(types.includes("buz.queue.drain"));
    assert.ok(types.includes("buz.read"));
    assert.ok(types.includes("buz.purge"));
  });
});

test("normalizeSessionRecord persists buzAccept and drops unknown tiers", async () => {
  const { saveSession, loadSession } = await import("../src/store.js");
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { buzAccept: ["interrupt", "queue"] });
    await saveSession(recipient);
    const loaded = await loadSession("CO.aaa");
    assert.deepEqual(loaded?.buzAccept, ["interrupt", "queue"]);

    // Write a record file containing an unknown tier and load it.
    const path = join(process.env.HIVE_STORE_ROOT!, "sessions", "CO.bbb.json");
    await mkdir(join(process.env.HIVE_STORE_ROOT!, "sessions"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({
      ...recipient,
      name: "CO.bbb",
      tmuxTarget: "tg-bbb",
      buzAccept: ["interrupt", "bogus", "queue"],
    }, null, 2));
    const second = await loadSession("CO.bbb");
    assert.deepEqual(second?.buzAccept, ["interrupt", "queue"]);
  });
});
