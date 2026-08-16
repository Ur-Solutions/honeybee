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
  reconcileAmbiguousBuzDelivery,
  requeueQuarantinedMessages,
  resolveBuzAccept,
  sanitizeHumanName,
  sendBuzMessageInAdmission as sendBuzMessage,
  sendBuzMessage as sendBuzMessageWithAdmission,
  settleQueuedBuzMessageUndeliverable,
  senderDisplay,
  serializeBuzMessage,
  validateAcceptList,
  type BuzMessage,
  type BuzSender,
  type BuzTier,
} from "../src/buz.js";
import { readDeliveryDoubt } from "../src/deliveryDoubt.js";
import {
  acknowledgeHsrEventIntegrityLoss,
  persistHsrEventIntegrityFailure,
  readHsrEventIntegrityReceipt,
  recordHsrEventIntegrityStop,
} from "../src/hsr/eventIntegrity.js";
import { purgeSessionData } from "../src/kill.js";
import { reviveRecord } from "../src/commands/migrate.js";
import { parseBuzDocument } from "../src/buz_format.js";
import { loadSession, saveSession, transitionSession, updateSession, type SessionRecord } from "../src/store.js";
import type { Substrate } from "../src/substrates/index.js";
import { readBeeRequests } from "../src/requests/store.js";

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

test("readMessageById prefers recipient settlement over a self-send outbox audit", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.self-receipt");
    const delivered = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: recipient.name },
      tier: "passive",
      body: "delivered self message",
    });
    await consumeMessage(recipient.name, delivered.message.id);
    assert.equal(
      (await readMessageById(recipient.name, delivered.message.id, { strict: true }))?.mailbox,
      "read",
      "sender outbox must not mask the recipient's delivered/read receipt",
    );

    const queued = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: recipient.name },
      tier: "queue",
      body: "terminal self message",
    });
    const settled = await settleQueuedBuzMessageUndeliverable(
      recipient.name,
      queued.message.id,
      "test-terminal-verdict",
    );
    assert.equal(settled.outcome, "undeliverable");
    assert.equal(
      (await readMessageById(recipient.name, queued.message.id, { strict: true }))?.mailbox,
      "quarantine",
      "sender outbox must not mask the recipient's terminal receipt",
    );
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

test("post-provider interrupt mailbox failure retains one exact id and fences a fresh send", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.post-provider", { buzAccept: ["interrupt", "queue"] });
    await saveSession(recipient);
    let sends = 0;
    const substrate = fakeSubstrate({ sendText: async () => { sends += 1; } });

    let deliveryId: string | undefined;
    await assert.rejects(
      sendBuzMessage({
        recipient,
        sender: { kind: "bee", id: "CL.sender" },
        tier: "interrupt",
        body: "accepted exactly once",
        transport: { substrate, tmuxTarget: recipient.tmuxTarget },
      }, {
        finalizeQueuedDelivery: async () => {
          throw new Error("injected inbox publication failure");
        },
      }),
      (error: unknown) => {
        deliveryId = (error as { deliveryId?: string }).deliveryId;
        return (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS" && !!deliveryId;
      },
    );

    assert.equal(sends, 1);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).length, 1);
    assert.equal((await readDeliveryDoubt(recipient.name, deliveryId!))?.phase, "ambiguous");
    await assert.rejects(
      sendBuzMessageWithAdmission({
        recipient,
        sender: { kind: "bee", id: "CL.sender" },
        tier: "interrupt",
        body: "fresh retry must not pass",
        transport: { substrate, tmuxTarget: recipient.tmuxTarget },
      }),
      /unresolved delivery ownership/,
    );
    assert.equal(sends, 1, "fresh-id retry performs zero transport work");

    const staged = await readMessageById(recipient.name, deliveryId!, { strict: true });
    assert.equal(staged?.mailbox, "queue");
    staged!.message.deliveredAs = "queue";
    await writeFile(staged!.path, serializeBuzMessage(staged!.message));
    const reconciled = await reconcileAmbiguousBuzDelivery(recipient.name, deliveryId!, "delivered");
    assert.equal(reconciled.mailbox, "inbox");
    assert.equal((await readDeliveryDoubt(recipient.name, deliveryId!))?.phase, "delivered");
  });
});

test("crash after durable Buz offer but before provider call adopts the old UUID on retry", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.offer-crash", { buzAccept: ["interrupt", "queue"] });
    await saveSession(recipient);
    let sends = 0;
    const input = {
      recipient,
      sender: { kind: "bee" as const, id: "CL.sender" },
      tier: "interrupt" as const,
      body: "one logical operation",
      messageId: generateMessageId(1_760_000_000_000),
      transport: {
        substrate: fakeSubstrate({ sendText: async () => { sends += 1; } }),
        tmuxTarget: recipient.tmuxTarget,
      },
    };
    await assert.rejects(
      sendBuzMessage(input, {
        afterQueueBeforeTransport: async () => { throw new Error("injected coordinator crash"); },
      }),
      /injected coordinator crash/,
    );
    const offered = await listMessages(recipient.name, "queue");
    assert.equal(offered.length, 1);
    assert.equal(sends, 0);

    const retry = await sendBuzMessageWithAdmission(input);
    assert.equal(retry.message.id, offered[0]?.message.id);
    assert.equal(sends, 0, "retry adopts the durable offer instead of inline-delivering a fresh UUID");
    assert.equal((await listMessages(recipient.name, "queue")).length, 1);
  });
});

test("no-id retry after a durable offer fails closed on the named UUID; explicit new intent stays distinct", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.no-id-offer-crash", { buzAccept: ["interrupt", "queue"] });
    await saveSession(recipient);
    const sender = { kind: "bee" as const, id: "CL.sender" };
    let sends = 0;
    const input = {
      recipient,
      sender,
      tier: "interrupt" as const,
      body: "same text does not prove same intent",
      transport: {
        substrate: fakeSubstrate({ sendText: async () => { sends += 1; } }),
        tmuxTarget: recipient.tmuxTarget,
      },
    };

    await assert.rejects(
      sendBuzMessage(input, {
        afterQueueBeforeTransport: async () => { throw new Error("injected after-offer crash"); },
      }),
      /injected after-offer crash/,
    );
    const [offered] = await listMessages(recipient.name, "queue", { strict: true });
    assert.ok(offered);
    assert.equal(sends, 0);

    await assert.rejects(
      sendBuzMessageWithAdmission(input),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "HIVE_BUZ_UNRESOLVED_INTENT");
        assert.equal((error as { messageId?: unknown }).messageId, offered.message.id);
        assert.match((error as Error).message, new RegExp(offered.message.id));
        return true;
      },
    );
    assert.equal(sends, 0);
    assert.equal((await listMessages(recipient.name, "queue", { strict: true })).length, 1, "retry creates no second durable UUID");
    assert.equal((await listMessages(sender.id, "outbox", { strict: true })).length, 1, "retry creates no second audit UUID");

    const explicitNew = await sendBuzMessageWithAdmission({ ...input, forceNewIntent: true });
    assert.notEqual(explicitNew.message.id, offered.message.id);
    assert.equal(sends, 1, "only the explicit new intent crosses the provider boundary");
  });
});

test("outbox-only exact-id replay safely resumes recipient admission", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.outbox-resume");
    const input = {
      recipient,
      sender: { kind: "human" as const, name: "apiary" },
      tier: "queue" as const,
      body: "resume after sender audit",
      messageId: generateMessageId(1_760_000_000_005),
    };
    await assert.rejects(
      sendBuzMessage(input, {
        afterOutboxBeforeRecipient: async () => { throw new Error("injected outbox-only crash"); },
      }),
      /injected outbox-only crash/,
    );
    assert.equal((await listMessages(recipient.name, "queue")).length, 0);

    const resumed = await sendBuzMessage(input);
    assert.equal(resumed.message.id, input.messageId);
    assert.equal((await listMessages(recipient.name, "queue")).length, 1);
  });
});

test("queue identity remains the fallback fence when post-provider doubt persistence itself fails", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.doubt-store-fail", { buzAccept: ["interrupt", "queue"] });
    await saveSession(recipient);
    let sends = 0;
    const input = {
      recipient,
      sender: { kind: "bee" as const, id: "CL.sender" },
      tier: "interrupt" as const,
      body: "accepted before every sidecar failed",
      messageId: generateMessageId(1_760_000_000_001),
      transport: {
        substrate: fakeSubstrate({ sendText: async () => { sends += 1; } }),
        tmuxTarget: recipient.tmuxTarget,
      },
    };
    await assert.rejects(
      sendBuzMessage(input, {
        finalizeQueuedDelivery: async () => { throw new Error("injected inbox failure"); },
        persistDeliveryDoubt: async () => { throw new Error("injected doubt-store failure"); },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    const retained = await listMessages(recipient.name, "queue");
    assert.equal(retained.length, 1);
    assert.equal(sends, 1);

    const retry = await sendBuzMessageWithAdmission(input);
    assert.equal(retry.message.id, retained[0]?.message.id);
    assert.equal(sends, 1, "same-intent retry performs zero second provider calls");
    await assert.rejects(
      sendBuzMessageWithAdmission({
        ...input,
        messageId: generateMessageId(1_760_000_000_101),
        body: "fresh id cannot bypass the manual ownership fence",
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.equal(sends, 1, "a different id is blocked by the durable manual request fallback");
  });
});

test("canonical lifecycle becomes non-runnable when every post-provider Buz fence sidecar fails", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.all-buz-fences-fail", { buzAccept: ["interrupt", "queue"] });
    await saveSession(recipient);
    let sends = 0;
    const input = {
      recipient,
      sender: { kind: "bee" as const, id: "CL.sender" },
      tier: "interrupt" as const,
      body: "provider accepted before all receipts failed",
      messageId: generateMessageId(1_760_000_000_102),
      transport: {
        substrate: fakeSubstrate({ sendText: async () => { sends += 1; } }),
        tmuxTarget: recipient.tmuxTarget,
      },
    };

    await assert.rejects(
      sendBuzMessageWithAdmission(input, {
        finalizeQueuedDelivery: async () => { throw new Error("injected inbox failure"); },
        persistDeliveryDoubt: async () => { throw new Error("injected doubt failure"); },
        openMessageDeliveryRequest: async () => { throw new Error("injected request failure"); },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.equal(sends, 1);
    const fenced = await loadSession(recipient.name);
    assert.equal(fenced?.status, "kill_failed");
    assert.match(fenced?.lastError ?? "", new RegExp(input.messageId));
    assert.equal(fenced?.deliveryStopDoubt?.deliveryId, input.messageId);
    assert.equal(fenced?.deliveryStopDoubt?.source.runtimeGeneration, recipient.runtimeGeneration ?? 0);

    // The structured marker is independently non-runnable: a stray scalar
    // repair cannot reopen work, and generic revive may not reinterpret it as
    // an ordinary failed stop.
    await updateSession(recipient.name, { status: "running" });
    const scalarReopened = (await loadSession(recipient.name))!;
    let launches = 0;
    await assert.rejects(
      reviveRecord(scalarReopened, {
        fresh: true,
        substrate: fakeSubstrate({ newSession: async () => { launches += 1; return { paneId: "%9" }; } }),
      }),
      new RegExp(input.messageId),
    );
    assert.equal(launches, 0);

    await assert.rejects(
      sendBuzMessageWithAdmission({
        ...input,
        messageId: generateMessageId(1_760_000_000_103),
        body: "fresh id must not bypass canonical doubt",
      }),
      /not runnable|kill_failed|stop/i,
    );
    assert.equal(sends, 1, "canonical fallback blocks every fresh provider call");

    const reconciled = await reconcileAmbiguousBuzDelivery(recipient.name, input.messageId, "delivered");
    assert.equal(reconciled.mailbox, "inbox");
    const repaired = await loadSession(recipient.name);
    assert.equal(repaired?.status, "running");
    assert.equal(repaired?.deliveryStopDoubt, undefined);
    assert.equal(repaired?.lastError, undefined);
  });
});

test("canonical delivery marker supports discard, survives archive, and never revives archived work", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.canonical-discard", { buzAccept: ["interrupt", "queue"] });
    await saveSession(recipient);
    const messageId = generateMessageId(1_760_000_000_104);
    const input = {
      recipient,
      sender: { kind: "human" as const, name: "apiary" },
      tier: "interrupt" as const,
      body: "discard this uncertain answer",
      messageId,
      transport: { substrate: fakeSubstrate(), tmuxTarget: recipient.tmuxTarget },
    };
    await assert.rejects(
      sendBuzMessageWithAdmission(input, {
        finalizeQueuedDelivery: async () => { throw new Error("inbox failed"); },
        persistDeliveryDoubt: async () => { throw new Error("doubt failed"); },
        openMessageDeliveryRequest: async () => { throw new Error("request failed"); },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    await updateSession(recipient.name, { status: "done" });

    const result = await reconcileAmbiguousBuzDelivery(recipient.name, messageId, "discard");
    assert.equal(result.mailbox, "quarantine");
    const archived = await loadSession(recipient.name);
    assert.equal(archived?.status, "done", "reconciliation never revives an archived lifecycle");
    assert.equal(archived?.deliveryStopDoubt, undefined);
    await assert.rejects(
      sendBuzMessageWithAdmission(input),
      /archived|not runnable|unresolved stop/i,
    );
  });
});

test("purge exports the only canonical delivery marker before deleting the SessionRecord", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.canonical-purge", { buzAccept: ["interrupt", "queue"] });
    await saveSession(recipient);
    const messageId = generateMessageId(1_760_000_000_105);
    const input = {
      recipient,
      sender: { kind: "human" as const, name: "apiary" },
      tier: "interrupt" as const,
      body: "preserve across destructive cleanup",
      messageId,
      transport: { substrate: fakeSubstrate(), tmuxTarget: recipient.tmuxTarget },
    };
    await assert.rejects(
      sendBuzMessageWithAdmission(input, {
        finalizeQueuedDelivery: async () => { throw new Error("inbox failed"); },
        persistDeliveryDoubt: async () => { throw new Error("doubt failed"); },
        openMessageDeliveryRequest: async () => { throw new Error("request failed"); },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    const fenced = (await loadSession(recipient.name))!;
    assert.ok(await purgeSessionData(fenced));
    assert.equal(await loadSession(recipient.name), null);
    assert.equal((await readDeliveryDoubt(recipient.name, messageId))?.phase, "ambiguous");
    assert.equal((await listMessages(recipient.name, "queue")).length, 1);

    const reconciled = await reconcileAmbiguousBuzDelivery(recipient.name, messageId, "delivered");
    assert.equal(reconciled.mailbox, "inbox");
    assert.equal((await readDeliveryDoubt(recipient.name, messageId))?.phase, "delivered");
  });
});

test("identical queued messages require an explicit new-intent override or a stable operation id", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.intent-identity");
    const input = {
      recipient,
      sender: { kind: "bee" as const, id: "CL.sender" },
      tier: "queue" as const,
      body: "intentional repeated payload",
    };
    const first = await sendBuzMessage(input);
    await assert.rejects(
      sendBuzMessage(input),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_BUZ_UNRESOLVED_INTENT",
    );
    const second = await sendBuzMessage({ ...input, forceNewIntent: true });
    assert.notEqual(first.message.id, second.message.id);
    assert.equal((await listMessages(recipient.name, "queue")).length, 2);

    const stableId = generateMessageId(1_760_000_000_002);
    const stableFirst = await sendBuzMessage({ ...input, messageId: stableId, body: "stable operation" });
    const stableRetry = await sendBuzMessage({ ...input, messageId: stableId, body: "stable operation" });
    assert.equal(stableFirst.message.id, stableRetry.message.id);
    assert.equal((await listMessages(recipient.name, "queue")).filter(({ message }) => message.id === stableId).length, 1);
  });
});

test("explicit Buz id replays use inbox/read/quarantine terminal receipts without redelivery", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.terminal-receipts");
    const sender = { kind: "bee" as const, id: "CL.sender" };
    const deliveredId = generateMessageId(1_760_000_000_003);
    const deliveredInput = { recipient, sender, tier: "passive" as const, body: "delivered once", messageId: deliveredId };
    const first = await sendBuzMessage(deliveredInput);
    const inboxReplay = await sendBuzMessage(deliveredInput);
    assert.equal(inboxReplay.message.id, first.message.id);
    assert.equal((await listMessages(recipient.name, "inbox")).length, 1);

    await consumeMessage(recipient.name, deliveredId);
    const readReplay = await sendBuzMessage(deliveredInput);
    assert.equal(readReplay.message.id, deliveredId);
    assert.equal((await listMessages(recipient.name, "read")).length, 1);
    assert.equal((await listMessages(recipient.name, "inbox")).length, 0);

    const quarantinedId = generateMessageId(1_760_000_000_004);
    const quarantinedInput = { recipient, sender, tier: "queue" as const, body: "terminally refused", messageId: quarantinedId };
    const queued = await sendBuzMessage(quarantinedInput);
    const quarantineDir = beeMailboxDir(recipient.name, "quarantine");
    await mkdir(quarantineDir, { recursive: true });
    await rename(queued.queuePath!, join(quarantineDir, queued.queuePath!.split("/").at(-1)!));
    await assert.rejects(
      sendBuzMessage(quarantinedInput),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_BUZ_DELIVERY_REJECTED",
    );
    assert.equal((await listMessages(recipient.name, "quarantine")).length, 1);
    assert.equal((await listMessages(recipient.name, "queue")).filter(({ message }) => message.id === quarantinedId).length, 0);
  });
});

test("post-accept Buz ledger failures are repair-only and never request a second delivery", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.ledger", { buzAccept: ["interrupt"] });
    let sends = 0;
    let ledgerAttempts = 0;
    const result = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.sender" },
      tier: "interrupt",
      body: "provider accepted",
      transport: {
        substrate: fakeSubstrate({ sendText: async () => { sends += 1; } }),
        tmuxTarget: recipient.tmuxTarget,
      },
    }, {
      appendLedger: async () => {
        ledgerAttempts += 1;
        throw new Error("injected ledger failure");
      },
    });

    assert.equal(result.message.deliveredAs, "interrupt");
    assert.equal(sends, 1);
    assert.equal(ledgerAttempts, 2);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 1);
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

test("readMessageById strict mode fails closed for a malformed matching id", async () => {
  await withTempStore(async () => {
    const id = generateMessageId(Date.now());
    const dir = beeMailboxDir("CO.aaa", "queue");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `20260101T000000-${id}.md`), "not a valid buz message", "utf8");
    await assert.rejects(
      () => readMessageById("CO.aaa", id, { strict: true }),
      /is malformed/,
    );
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

test("processQueueForBee carries remote authority tokens into queued delivery", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.remote-drain", {
      node: "cell-one",
      remoteLaunchId: "33333333-3333-4333-8333-333333333333",
      remoteIncarnation: "44444444-4444-4444-8444-444444444444",
    });
    const queued = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.sender" },
      tier: "queue",
      body: "remote queued turn",
    });
    let options: Parameters<Substrate["sendText"]>[3];
    const sub = fakeSubstrate({
      kind: "remote-hsr",
      node: "cell-one",
      sendText: async (_target, _text, _pane, supplied) => { options = supplied; },
    });
    const result = await processQueueForBee(recipient, {
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.deepEqual(result.delivered, [queued.message.id]);
    assert.deepEqual(options, {
      deliveryId: queued.message.id,
      completionRequired: true,
      remoteLaunchId: recipient.remoteLaunchId,
      remoteIncarnation: recipient.remoteIncarnation,
    });
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

test("processQueueForBee parks old-host delivery ambiguity for manual action without blind retry", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.ambiguous-drain", { substrate: "hsr" });
    await saveSession(recipient);
    const queued = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.sender" },
      tier: "queue",
      body: "do not replay across host death",
    });
    let attempts = 0;
    let suppliedDeliveryId: string | undefined;
    const sub = fakeSubstrate({
      kind: "hsr",
      sendText: async (_target, _text, _pane, options) => {
        attempts += 1;
        suppliedDeliveryId = options?.deliveryId;
        throw Object.assign(new Error("provider acceptance on prior host is unknown"), {
          code: "HIVE_HSR_DELIVERY_AMBIGUOUS",
        });
      },
    });

    const first = await processQueueForBee(recipient, {
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(suppliedDeliveryId, queued.message.id);
    assert.equal(first.delivered.length, 0);
    assert.equal(first.errors[0]?.code, "HIVE_HSR_DELIVERY_AMBIGUOUS");
    assert.equal((await listMessages(recipient.name, "queue")).length, 1);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "quarantine")).catch(() => [])).length, 0);
    const requests = await readBeeRequests(recipient.name);
    assert.ok(requests.some((request) =>
      request.status === "open" && request.evidence.detail === "delivery-ambiguous"));

    // Another automatic drain encounters the same durable/manual fence. It
    // never consumes quarantine budget or moves later mail ahead of it.
    await processQueueForBee(recipient, {
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });
    assert.equal(attempts, 1, "an open ambiguity request prevents another transport call");
    assert.equal((await listMessages(recipient.name, "queue")).length, 1);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).some((file) => file.endsWith(".retries")), false);
  });
});

test("Buz delivered verdict remains acknowledgeable after its completed HSR receipt is cleared", async () => {
  await withTempStore(async () => {
    const bee = "CO.event-loss-delivered";
    const host = {
      hostPid: 8123,
      startedAt: "2026-08-15T18:00:00.000Z",
      hostFingerprint: { pgid: 8123, startedAt: "birth-event-loss" },
    };
    const recipient = makeRecord(bee, {
      substrate: "hsr",
      runnerPid: host.hostPid,
      runnerFingerprint: host.hostFingerprint,
      buzAccept: ["queue"],
    });
    await saveSession(recipient);
    const queued = await sendBuzMessage({
      recipient,
      sender: { kind: "bee", id: "CL.sender" },
      tier: "queue",
      body: "provider effect lost from source event history",
    });
    const sub = fakeSubstrate({
      kind: "hsr",
      sendText: async () => {
        throw Object.assign(new Error("accepted provider outcome unknown"), {
          code: "HIVE_HSR_DELIVERY_AMBIGUOUS",
          deliveryId: queued.message.id,
        });
      },
    });
    await processQueueForBee(recipient, {
      transport: { substrate: sub, tmuxTarget: recipient.tmuxTarget },
    });

    const integrity = await persistHsrEventIntegrityFailure({
      bee,
      host,
      deliveryIds: [queued.message.id],
      reason: "injected source append failure",
    });
    await recordHsrEventIntegrityStop(bee, integrity.integrityId, host, "confirmed", "test exact stop");

    assert.deepEqual(await reconcileAmbiguousBuzDelivery(bee, queued.message.id, "delivered"), {
      verdict: "delivered",
      mailbox: "inbox",
    });
    assert.equal(
      (await readHsrEventIntegrityReceipt(bee))?.deliveryVerdicts?.[queued.message.id],
      "delivered",
      "terminal mailbox verdict is copied before Buz clears its own tombstone",
    );
    const acknowledged = await acknowledgeHsrEventIntegrityLoss(bee, integrity.integrityId);
    assert.equal(acknowledged.phase, "acknowledged");
  });
});

test("an imported event-integrity delivery id is sufficient authority for mailbox-free reconciliation", async () => {
  await withTempStore(async () => {
    const host = {
      hostPid: 8124,
      startedAt: "2026-08-15T18:10:00.000Z",
      hostFingerprint: { pgid: 8124, startedAt: "birth-remote-event-loss" },
    };
    for (const [suffix, verdict, terminal] of [
      ["delivered", "delivered", "delivered"],
      ["discarded", "discard", "discarded"],
    ] as const) {
      const bee = `CO.remote-event-loss-${suffix}`;
      const deliveryId = `remote-direct-${suffix}`;
      await saveSession(makeRecord(bee, {
        substrate: "hsr",
        node: "remote-node",
        remoteLaunchId: "00000000-0000-4000-8000-000000000801",
        remoteIncarnation: `00000000-0000-4000-8000-0000000008${suffix === "delivered" ? "02" : "03"}`,
      }));
      const integrity = await persistHsrEventIntegrityFailure({
        bee,
        host,
        remoteAuthority: {
          launchId: "00000000-0000-4000-8000-000000000801",
          incarnation: `00000000-0000-4000-8000-0000000008${suffix === "delivered" ? "02" : "03"}`,
        },
        deliveryIds: [deliveryId],
        reason: "remote source append failure after direct provider dispatch",
      });
      await recordHsrEventIntegrityStop(bee, integrity.integrityId, host, "confirmed", "remote exact stop proof");

      assert.deepEqual(await reconcileAmbiguousBuzDelivery(bee, deliveryId, verdict), {
        verdict,
        mailbox: "absent",
      });
      assert.equal((await readHsrEventIntegrityReceipt(bee))?.deliveryVerdicts?.[deliveryId], terminal);
      assert.equal((await acknowledgeHsrEventIntegrityLoss(bee, integrity.integrityId)).phase, "acknowledged");
    }
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
    assert.equal(
      (await readdir(beeMailboxDir("CO.aaa", "queue"))).length,
      2,
      "the slow interrupt keeps its exact pre-provider queue identity while the concurrent message is admitted",
    );

    releasePaste();
    const delivered = await interrupt;
    assert.equal(delivered.message.deliveredAs, "interrupt");
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "inbox"))).length, 1);
    assert.equal((await readdir(beeMailboxDir("CO.aaa", "queue"))).length, 1);
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
