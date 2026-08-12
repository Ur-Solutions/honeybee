import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUZ_INJECTION_MARKER,
  BUZ_TIERS,
  BuzDeliveryRejectedError,
  beeMailboxDir,
  buzRoot,
  consumeMessage,
  countQuarantinedMessages,
  DEFAULT_BUZ_ACCEPT,
  DEFAULT_BUZ_TIER,
  downgradeTier,
  externalOutboxDir,
  formatBuzInjection,
  generateMessageId,
  inboxFilename,
  listMessages,
  parseAcceptFlag,
  parseBuzMessage,
  processQueueForBee,
  purgeMailbox,
  readMessageById,
  requeueQuarantinedMessages,
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
import { saveSession, transitionSession, type SessionRecord } from "../src/store.js";
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
    newSession: async () => ({ paneId: "%0" }),
    kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [],
    listPanes: async () => new Set<string>(),
    listSessionStates: async () => new Map<string, string>(),
    setUserOptions: async () => undefined,
    setWindowOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => ["tmux", "attach"],
    attachSession: async () => undefined,
  };
  return { ...base, ...impl };
}

test("generateMessageId returns an RFC 9562 UUIDv7 with the supplied timestamp", () => {
  const id = generateMessageId(1700000000000);
  assert.match(id, /^018bcfe5-6800-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
  assert.deepEqual([...ids].sort(), ids, "canonical UUIDv7 strings sort by timestamp");
});

test("generateMessageId rejects timestamps outside UUIDv7's 48-bit field", () => {
  assert.throws(() => generateMessageId(-1), /UUIDv7 timestamp out of range/);
  assert.throws(() => generateMessageId(0x1000000000000), /UUIDv7 timestamp out of range/);
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

test("dot-only bee names stay inside buz root", async () => {
  await withTempStore(async () => {
    assert.equal(beeMailboxDir("..", "inbox"), join(buzRoot(), "--", "inbox"));
    assert.equal(beeMailboxDir(".", "inbox"), join(buzRoot(), "-", "inbox"));

    await sendBuzMessage({
      recipient: makeRecord(".."),
      sender: { kind: "bee", id: ".." },
      tier: "passive",
      body: "hello",
    });

    assert.equal((await readdir(join(buzRoot(), "--", "inbox"))).length, 1);
    assert.equal((await readdir(join(buzRoot(), "--", "outbox"))).length, 1);
    assert.deepEqual(await readdir(join(process.env.HIVE_STORE_ROOT!, "inbox")).catch(() => []), []);
  });
});

test("resolveBuzAccept returns DEFAULT_BUZ_ACCEPT when undefined", () => {
  assert.deepEqual(resolveBuzAccept({ buzAccept: undefined }), DEFAULT_BUZ_ACCEPT);
  assert.deepEqual([...DEFAULT_BUZ_ACCEPT], ["next-tool", "queue", "passive"]);
  assert.equal(DEFAULT_BUZ_TIER, "next-tool");
});

test("resolveBuzAccept returns the explicit list when set", () => {
  assert.deepEqual(resolveBuzAccept({ buzAccept: ["interrupt"] }), ["interrupt"]);
});

test("downgradeTier returns requested tier when accepted", () => {
  const r = downgradeTier("interrupt", ["interrupt", "queue", "passive"]);
  assert.equal(r.effective, "interrupt");
  assert.equal(r.downgraded, false);
});

test("downgradeTier downgrades interrupt -> next-tool under the default policy", () => {
  const r = downgradeTier("interrupt", DEFAULT_BUZ_ACCEPT);
  assert.equal(r.effective, "next-tool");
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

test("downgradeTier walks the exported BUZ_TIERS order from the requested tier", () => {
  for (let index = 0; index < BUZ_TIERS.length; index += 1) {
    const requested = BUZ_TIERS[index]!;
    assert.equal(downgradeTier(requested, BUZ_TIERS.slice(index)).effective, requested);

    const nextTier = BUZ_TIERS[index + 1];
    if (nextTier) assert.equal(downgradeTier(requested, [nextTier]).effective, nextTier);
  }
});

test("validateAcceptList rejects unknown tiers and dedupes", () => {
  assert.deepEqual(validateAcceptList(["queue", "queue", "passive"]), ["queue", "passive"]);
  assert.throws(() => validateAcceptList(["bogus"]), /Unknown tier/);
});

test("parseAcceptFlag splits comma-separated values", () => {
  assert.deepEqual(parseAcceptFlag("interrupt,queue,passive"), ["interrupt", "queue", "passive"]);
  assert.deepEqual(parseAcceptFlag("queue, passive"), ["queue", "passive"]);
});

test("serialize/parse round-trip preserves legacy ids, frontmatter, and body bytes", () => {
  const m: BuzMessage = {
    id: "00001KZ5P6CKM-9ad70d",
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

test("sendBuzMessage preserves a client-supplied UUIDv7 message id", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const messageId = generateMessageId(1_700_000_000_000);
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "human", name: "apiary" },
      tier: "queue",
      body: "idempotent retry payload",
      messageId,
    });
    assert.equal(result.message.id, messageId);
    assert.equal((await readMessageById(recipient.name, messageId))?.message.id, messageId);
  });
});

test("sendBuzMessage rejects a malformed client-supplied message id", async () => {
  await withTempStore(async () => {
    await assert.rejects(
      sendBuzMessage({
        recipient: makeRecord("CO.aaa"),
        sender: { kind: "human", name: "apiary" },
        tier: "queue",
        body: "bad id",
        messageId: "not-a-uuid",
      }),
      /RFC 9562 UUIDv7/,
    );
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
    // Bee sends are pasted with the sender-attribution envelope, not verbatim.
    assert.equal(pasted, formatBuzInjection(result.message));
    assert.ok(pasted.startsWith(BUZ_INJECTION_MARKER));
    assert.ok(pasted.endsWith("\n\nINTR"));
    const inbox = await readdir(beeMailboxDir("CO.aaa", "inbox"));
    assert.equal(inbox.length, 1);
  });
});

test("default policy rejects true interrupt and safely falls back on tmux", async () => {
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
    assert.match(
      files[0]!,
      /-to-CO\.aaa-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/,
    );
  });
});

test("broadcast: per-bee policy applied independently", async () => {
  await withTempStore(async () => {
    // Recipient A allows interrupt. B's default policy chooses next-tool,
    // which its tmux substrate safely downgrades to queue.
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
    assert.equal(aPasted, formatBuzInjection(ra.message));
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
    await sendBuzMessage({ recipient, sender: { kind: "human", name: "Alice" }, tier: "passive", body: "3" });

    const all = await listMessages("CO.aaa", "inbox");
    assert.equal(all.length, 3);

    const limited = await listMessages("CO.aaa", "inbox", { limit: 1 });
    assert.equal(limited.length, 1);

    const filtered = await listMessages("CO.aaa", "inbox", { fromFilter: "CL.y" });
    assert.equal(filtered.length, 1);
    assert.equal(senderDisplay(filtered[0]!.message.from), "CL.y");

    const humanBare = await listMessages("CO.aaa", "inbox", { fromFilter: "alice" });
    assert.equal(humanBare.length, 1);
    assert.equal(senderDisplay(humanBare[0]!.message.from), "human:alice");

    const humanPrefixed = await listMessages("CO.aaa", "inbox", { fromFilter: "human:alice" });
    assert.equal(humanPrefixed.length, 1);
    assert.equal(senderDisplay(humanPrefixed[0]!.message.from), "human:alice");

    const humanPrefixedRaw = await listMessages("CO.aaa", "inbox", { fromFilter: "human:Alice" });
    assert.equal(humanPrefixedRaw.length, 1);
    assert.equal(senderDisplay(humanPrefixedRaw[0]!.message.from), "human:alice");
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

test("readMessageById returns null for a malformed message file", async () => {
  await withTempStore(async () => {
    const id = generateMessageId(Date.now());
    const dir = beeMailboxDir("CO.aaa", "inbox");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `20260101T000000-${id}.md`), "not a valid buz message", "utf8");
    assert.equal(await readMessageById("CO.aaa", id), null);
  });
});

test("readMessageById returns null when the file vanishes between readdir and read", async () => {
  await withTempStore(async () => {
    const id = generateMessageId(Date.now());
    const dir = beeMailboxDir("CO.aaa", "inbox");
    await mkdir(dir, { recursive: true });
    // A dangling symlink shows up in readdir but ENOENTs on readFile,
    // mimicking a concurrent purge/drain removing the file.
    await symlink(join(dir, "gone.md"), join(dir, `20260101T000000-${id}.md`));
    assert.equal(await readMessageById("CO.aaa", id), null);
  });
});

test("consumeMessage returns null instead of throwing on a malformed inbox file", async () => {
  await withTempStore(async () => {
    const id = generateMessageId(Date.now());
    const dir = beeMailboxDir("CO.aaa", "inbox");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `20260101T000000-${id}.md`), "garbage", "utf8");
    assert.equal(await consumeMessage("CO.aaa", id), null);
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

    assert.deepEqual(calls, [formatBuzInjection(a.message), formatBuzInjection(b.message)]);
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

test("processQueueForBee quarantines a definite delivery rejection after 3 attempts", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "bad" });

    let attempts = 0;
    const sub = fakeSubstrate({
      sendText: async () => {
        attempts += 1;
        throw new BuzDeliveryRejectedError("recipient rejected payload");
      },
    });

    for (let i = 0; i < 3; i += 1) {
      await processQueueForBee(recipient, { transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget }, maxFailures: 3 });
    }

    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 0);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "quarantine"))).length, 1);
    assert.equal(attempts, 3);
  });
});

test("processQueueForBee retries transport failures forever without incrementing quarantine state", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "offline" });
    const sub = fakeSubstrate({ sendText: async () => { throw new Error("socket unavailable"); } });

    for (let i = 0; i < 5; i += 1) {
      const result = await processQueueForBee(recipient, {
        transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
        maxFailures: 3,
      });
      assert.equal(result.errors[0]?.message, "socket unavailable");
    }

    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 1);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "quarantine")).catch(() => [])).length, 0);
    assert.equal(
      (await readdir(beeMailboxDir("CO.aaa", "queue"))).some((file) => file.endsWith(".retries")),
      false,
      "transport failures never consume the delivery-rejected retry budget",
    );
  });
});

test("processQueueForBee preserves the single transition audit for an illegal edge", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.illegal-drain", { substrate: "hsr" });
    await saveSession(recipient);
    const startedAt = "2026-08-12T07:00:00.000Z";
    await transitionSession(recipient.name, {
      type: "turn.started",
      eventId: "illegal-drain-started",
      at: startedAt,
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "illegal-drain-started", observedAt: startedAt, hook: "turn-start" },
    });
    const requestedAt = "2026-08-12T07:00:01.000Z";
    await transitionSession(recipient.name, {
      type: "request.opened",
      eventId: "illegal-drain-request",
      at: requestedAt,
      cause: "question",
      requestId: "illegal-drain-request",
      evidence: { kind: "request", requestId: "illegal-drain-request", observedAt: requestedAt, action: "opened" },
    });
    await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "retry me" });
    const sub = fakeSubstrate({
      sendText: async () => {
        await transitionSession(recipient.name, {
          type: "runtime.lost",
          eventId: "illegal-drain-lost",
          at: "2026-08-12T07:00:02.000Z",
          cause: "mid-turn-death",
          probe: {
            kind: "probe",
            probeId: "illegal-drain-dead",
            observerId: "buz-test",
            observedAt: "2026-08-12T07:00:02.000Z",
            outcome: "dead",
            target: { substrate: "hsr", runnerPid: 4242 },
          },
        });
      },
    });

    const result = await processQueueForBee(recipient, {
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
      stopOnFirstFailure: true,
    });
    assert.equal(result.errors[0]?.code, "ILLEGAL_BEE_TRANSITION");
    const ledger = (await readFile(join(buzRoot(), "..", "ledger.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(ledger.filter((row) => row.type === "state.transition.rejected").length, 1);
    assert.equal(ledger.filter((row) => row.type === "buz.deliver" && row.ok === false).length, 0);
  });
});

// ─── Quarantine re-drive (requeue) ─────────────────────────────────────────

test("requeueQuarantinedMessages moves quarantined mail back to queue/ and it delivers on the next drain", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const sent = await sendBuzMessage({ recipient, sender: { kind: "human", name: "apiary" }, tier: "queue", body: "steer" });

    // Drive the message into quarantine via repeated definite rejections.
    const rejecting = fakeSubstrate({ sendText: async () => { throw new BuzDeliveryRejectedError("rejected"); } });
    for (let i = 0; i < 3; i += 1) {
      await processQueueForBee(recipient, { transport: { substrate: rejecting, tmuxTarget: recipient.tmuxTarget }, maxFailures: 3 });
    }
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "quarantine"))).length, 1);
    assert.equal(await countQuarantinedMessages("CO.aaa"), 1);

    const result = await requeueQuarantinedMessages("CO.aaa");
    assert.deepEqual(result.requeued, [sent.message.id]);
    assert.deepEqual(result.skipped, []);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "quarantine"))).length, 0);
    assert.equal(await countQuarantinedMessages("CO.aaa"), 0);

    // Recipient healthy again: the requeued message drains to inbox/.
    const delivered: string[] = [];
    const healthy = fakeSubstrate({ sendText: async (_t, text) => { delivered.push(text); } });
    const drain = await processQueueForBee(recipient, { transport: { substrate: healthy, tmuxTarget: recipient.tmuxTarget } });
    assert.deepEqual(drain.delivered, [sent.message.id]);
    assert.deepEqual(delivered, [formatBuzInjection(sent.message)]);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 1);
  });
});

test("requeueQuarantinedMessages with an id moves only that message and resets its retry budget", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const first = await sendBuzMessage({ recipient, sender: { kind: "human", name: "apiary" }, tier: "queue", body: "one" });
    const second = await sendBuzMessage({ recipient, sender: { kind: "human", name: "apiary" }, tier: "queue", body: "two" });

    // Hand-stage both in quarantine the way the drain leaves them (rename
    // preserves filenames), plus a stale retries sidecar for the target.
    const queueDir = beeMailboxDir("CO.aaa", "queue");
    const quarantineDir = beeMailboxDir("CO.aaa", "quarantine");
    await mkdir(quarantineDir, { recursive: true });
    for (const file of await readdir(queueDir)) {
      await rename(join(queueDir, file), join(quarantineDir, file));
    }
    const firstFile = (await readdir(quarantineDir)).find((f) => f.includes(first.message.id))!;
    await writeFile(join(queueDir, `${firstFile}.retries`), "2");

    const result = await requeueQuarantinedMessages("CO.aaa", { id: first.message.id });
    assert.deepEqual(result.requeued, [first.message.id]);
    const queued = await readdir(queueDir);
    assert.deepEqual(queued, [firstFile], "only the requested message returns to queue/, with no stale .retries sidecar");
    const remaining = await readdir(quarantineDir);
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0]!.includes(second.message.id));
  });
});

test("requeueQuarantinedMessages leaves malformed quarantine files in place", async () => {
  await withTempStore(async () => {
    const quarantineDir = beeMailboxDir("CO.aaa", "quarantine");
    await mkdir(quarantineDir, { recursive: true });
    await writeFile(join(quarantineDir, "2026-01-01T00-00-00-000Z-from-x-bad.md"), "not a buz message");

    const result = await requeueQuarantinedMessages("CO.aaa");
    assert.deepEqual(result.requeued, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.reason, /malformed/);
    assert.equal((await readdir(quarantineDir)).length, 1, "malformed file stays quarantined");
    assert.equal(await countQuarantinedMessages("CO.aaa"), 1, "malformed files still count as dead letters");
  });
});

// ─── HIVE-47: substrate I/O must not hold the recipient write lock ─────────

test("interrupt paste in flight does not block a concurrent send to the same recipient (HIVE-47)", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { buzAccept: ["interrupt", "queue"] });
    let releasePaste!: () => void;
    const pasteGate = new Promise<void>((r) => { releasePaste = r; });
    let pasteStarted!: () => void;
    const started = new Promise<void>((r) => { pasteStarted = r; });
    const sub = fakeSubstrate({ sendText: async () => { pasteStarted(); await pasteGate; } });

    const interrupt = sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.x" },
      tier: "interrupt",
      body: "slow paste",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    await started;

    // With the paste mid-flight, a queue-tier send must complete immediately:
    // before HIVE-47 it blocked on the recipient write lock (held across
    // sendText) and threw "Timed out waiting for lock" after 10s.
    const queued = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.y" }, tier: "queue", body: "quick" });
    assert.equal(queued.message.deliveredAs, "queue");
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 1);

    releasePaste();
    const delivered = await interrupt;
    assert.equal(delivered.message.deliveredAs, "interrupt");
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 1);
  });
});

test("drain paste in flight does not block a concurrent send to the same recipient (HIVE-47)", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "draining" });

    let releasePaste!: () => void;
    const pasteGate = new Promise<void>((r) => { releasePaste = r; });
    let pasteStarted!: () => void;
    const started = new Promise<void>((r) => { pasteStarted = r; });
    const sub = fakeSubstrate({ sendText: async () => { pasteStarted(); await pasteGate; } });

    const drain = processQueueForBee(recipient, { transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget } });
    await started;

    // The drain's paste is mid-flight; a sender writing to this bee's mailbox
    // must not wait behind it.
    const queued = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.y" }, tier: "queue", body: "quick" });
    assert.equal(queued.message.deliveredAs, "queue");

    releasePaste();
    const result = await drain;
    assert.equal(result.delivered.length, 1);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 1);
    // The message sent mid-drain stays queued for the next tick.
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 1);
  });
});

test("concurrent interrupt pastes to the same recipient never overlap (delivery lock)", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { buzAccept: ["interrupt"] });
    let active = 0;
    let maxConcurrent = 0;
    const sub = fakeSubstrate({
      sendText: async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 40));
        active -= 1;
      },
    });

    const send = (body: string) =>
      sendBuzMessage({
        recipient,
        sender: { kind: "bee", id: "CL.x" },
        tier: "interrupt",
        body,
        transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
      });
    const results = await Promise.all([send("a"), send("b"), send("c")]);

    // sendText loads a per-target tmux buffer, so overlapping pastes to the
    // same bee would clobber each other; the delivery lock serializes them.
    assert.equal(maxConcurrent, 1);
    for (const result of results) assert.equal(result.message.deliveredAs, "interrupt");
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 3);
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

// ─── Queued steering (docs/queued-steering.md): next-tool tier, human bypass,
//     one-delivery-per-drain ──────────────────────────────────────────────────

test("BUZ_TIERS places next-tool between interrupt and queue (downgrade chain order)", () => {
  assert.deepEqual([...BUZ_TIERS], ["interrupt", "next-tool", "queue", "passive"]);
  assert.deepEqual(downgradeTier("next-tool", ["queue", "passive"]), {
    effective: "queue",
    downgraded: true,
    reason: "policy disallows next-tool",
  });
});

test("tier=next-tool on a supportsNextTool substrate delivers with mode and copies to inbox/", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    let pasted = "";
    let mode: string | undefined;
    let stagedAtHandoff = false;
    const sub = fakeSubstrate({
      supportsNextTool: true,
      sendText: async (_t, text, _p, options) => {
        pasted = text;
        mode = options?.mode;
        stagedAtHandoff = (await readdir(beeMailboxDir("CO.aaa", "queue"))).length === 1;
      },
    });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "human", name: "tormod" },
      tier: "next-tool",
      body: "NT",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "next-tool");
    assert.equal(result.downgraded, false);
    assert.equal(pasted, "NT");
    assert.equal(mode, "next-tool");
    assert.equal(stagedAtHandoff, true, "message is durable before provider hand-off");
    assert.equal(result.queuePath, undefined);
    assert.ok(result.inboxPath);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 1);
    // The durable stage moves atomically to inbox after provider acceptance.
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue")).catch(() => [])).length, 0);
  });
});

test("default policy accepts next-tool from a bee sender", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    let mode: string | undefined;
    const sub = fakeSubstrate({
      supportsNextTool: true,
      sendText: async (_target, _text, _pane, options) => { mode = options?.mode; },
    });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: DEFAULT_BUZ_TIER,
      body: "NT",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "next-tool");
    assert.equal(result.downgraded, false);
    assert.equal(mode, "next-tool");
  });
});

test("tier=next-tool downgrades to queue when the substrate cannot hold it", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { buzAccept: ["interrupt", "next-tool", "queue"] });
    let pasteCount = 0;
    // Default fakeSubstrate is local-tmux with NO supportsNextTool.
    const sub = fakeSubstrate({ sendText: async () => { pasteCount += 1; } });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.cc9" },
      tier: "next-tool",
      body: "NT",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "queue");
    assert.equal(result.downgraded, true);
    assert.match(result.reason ?? "", /cannot hold next-tool/);
    assert.equal(pasteCount, 0);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 1);
  });
});

test("tier=next-tool transport failure falls back to queue without losing the message", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    let stagedMtimeMs = 0;
    const sub = fakeSubstrate({
      supportsNextTool: true,
      sendText: async () => {
        const [staged] = await readdir(beeMailboxDir("CO.aaa", "queue"));
        stagedMtimeMs = (await stat(join(beeMailboxDir("CO.aaa", "queue"), staged!))).mtimeMs;
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("socket gone");
      },
    });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "human", name: "tormod" },
      tier: "next-tool",
      body: "NT",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "queue");
    assert.equal(result.downgraded, true);
    assert.match(result.reason ?? "", /next-tool transport failed/);
    const files = await readdir(beeMailboxDir("CO.aaa", "queue"));
    assert.equal(files.length, 1);
    const queuedPath = join(beeMailboxDir("CO.aaa", "queue"), files[0]!);
    assert.equal(parseBuzMessage(await readFile(queuedPath, "utf8")).deliveredAs, "queue");
    assert.ok(
      Math.abs((await stat(queuedPath)).mtimeMs - stagedMtimeMs) < 2,
      "downgrade metadata rewrite preserves the original FIFO timestamp",
    );
    const ledger = (await readFile(join(buzRoot(), "..", "ledger.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const sendEvent = ledger.find((event) =>
      event.type === "buz.send" && event.messageId === result.message.id
    );
    assert.equal(sendEvent?.deliveredAs, "queue");
    assert.equal(sendEvent?.downgraded, true);
    assert.match(String(sendEvent?.reason), /next-tool transport failed/);
  });
});

test("human sender bypasses the accept-list downgrade (interrupt with default policy)", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa"); // no buzAccept => DEFAULT (next-tool+queue+passive)
    let pasted = "";
    const sub = fakeSubstrate({ sendText: async (_t, text) => { pasted = text; } });
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "human", name: "tormod" },
      tier: "interrupt",
      body: "NOW",
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(result.message.deliveredAs, "interrupt");
    assert.equal(result.downgraded, false);
    assert.equal(pasted, "NOW");
  });
});

test("bee sender is still policy-downgraded (human bypass does not leak)", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa"); // DEFAULT policy
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
    assert.equal(pasteCount, 0);
  });
});

test("processQueueForBee deliverLimit=1 delivers exactly one message per drain", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const a = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "first" });
    await new Promise((r) => setTimeout(r, 10));
    const b = await sendBuzMessage({ recipient, sender: { kind: "bee", id: "CL.x" }, tier: "queue", body: "second" });

    const calls: string[] = [];
    const sub = fakeSubstrate({ sendText: async (_t, text) => { calls.push(text); } });
    const transport = { substrate: sub, tmuxTarget: recipient.tmuxTarget };

    const first = await processQueueForBee(recipient, { transport, deliverLimit: 1 });
    assert.deepEqual(first.delivered, [a.message.id]);
    assert.deepEqual(calls, [formatBuzInjection(a.message)]);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 1);

    // The NEXT idle observation delivers the next message.
    const second = await processQueueForBee(recipient, { transport, deliverLimit: 1 });
    assert.deepEqual(second.delivered, [b.message.id]);
    assert.deepEqual(calls, [formatBuzInjection(a.message), formatBuzInjection(b.message)]);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Injection envelope (buz/inject.ts).
// ──────────────────────────────────────────────────────────────────────────

test("formatBuzInjection wraps a bee send in marker + one JSON metadata line + body", () => {
  const message: BuzMessage = {
    id: "msg123",
    from: { kind: "bee", id: "CL.cc9" },
    to: "CO.aaa",
    tier: "queue",
    deliveredAs: "queue",
    sentAt: "2026-05-28T00:00:00.000Z",
    subject: "hello",
    body: "line one\nline two",
  };
  const text = formatBuzInjection(message);
  const [marker, metaLine, blank, ...rest] = text.split("\n");
  assert.equal(marker, BUZ_INJECTION_MARKER);
  assert.deepEqual(JSON.parse(metaLine!), {
    version: 1,
    from: "CL.cc9",
    tier: "queue",
    id: "msg123",
    sentAt: "2026-05-28T00:00:00.000Z",
    subject: "hello",
  });
  assert.equal(blank, "");
  assert.equal(rest.join("\n"), "line one\nline two");
});

test("formatBuzInjection leaves human sends verbatim (no envelope)", () => {
  const message: BuzMessage = {
    id: "msg123",
    from: { kind: "human", name: "tormod" },
    to: "CO.aaa",
    tier: "interrupt",
    deliveredAs: "interrupt",
    sentAt: "2026-05-28T00:00:00.000Z",
    body: "NOW",
  };
  assert.equal(formatBuzInjection(message), "NOW");
});

test("formatBuzInjection omits subject from metadata when absent", () => {
  const message: BuzMessage = {
    id: "msg123",
    from: { kind: "bee", id: "CL.cc9" },
    to: "CO.aaa",
    tier: "queue",
    deliveredAs: "queue",
    sentAt: "2026-05-28T00:00:00.000Z",
    body: "x",
  };
  const metaLine = formatBuzInjection(message).split("\n")[1]!;
  assert.equal("subject" in JSON.parse(metaLine), false);
});
