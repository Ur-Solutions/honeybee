import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listForumPackets } from "../src/comb/forum.js";

async function withFakeForum(
  body: string,
  fn: (binary: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-forum-boundary-"));
  const binary = join(dir, "forum");
  const previousBinary = process.env.HIVE_FORUM_BIN;
  const previousTimeout = process.env.HIVE_FORUM_POLL_TIMEOUT_MS;
  await writeFile(binary, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(binary, 0o755);
  process.env.HIVE_FORUM_BIN = binary;
  try {
    await fn(binary);
  } finally {
    if (previousBinary === undefined) delete process.env.HIVE_FORUM_BIN;
    else process.env.HIVE_FORUM_BIN = previousBinary;
    if (previousTimeout === undefined) delete process.env.HIVE_FORUM_POLL_TIMEOUT_MS;
    else process.env.HIVE_FORUM_POLL_TIMEOUT_MS = previousTimeout;
    await rm(dir, { recursive: true, force: true });
  }
}

function validPacket() {
  return {
    id: "PKT.valid",
    title: "Valid review",
    status: "approved",
    kind: "code",
    origin: "comb",
    cwd: "/tmp/project",
    summary: "valid",
    checklist: [],
    native_session_id: null,
    blocking_since: "2026-07-28T12:00:00.000Z",
    run_id: "RUN.valid",
    comb_name: "valid-comb",
    base_rev: null,
    proposed_rev: 0,
    graph_base: null,
    graph_proposed: null,
    definition_digest: "sha256:def",
    action_binding_digest: "sha256:actions",
    subject_revision: "subject-1",
    verdict: {
      packet_id: "PKT.valid",
      verdict: "approve",
      comment: "good",
      destination: { type: "new-agent" },
      actor: "reviewer",
      definition_digest: "sha256:def",
      action_binding_digest: "sha256:actions",
      subject_revision: "subject-1",
      recorded_at: "2026-07-28T12:00:01.000Z",
    },
  };
}

test("Forum packet polling quarantines a malformed row while returning valid packets", async () => {
  const response = JSON.stringify({
    ok: true,
    result: {
      packets: [
        validPacket(),
        {
          ...validPacket(),
          id: "PKT.malformed",
          verdict: "yes",
        },
      ],
    },
  });
  await withFakeForum(`printf '%s' '${response}'`, async () => {
    const result = await listForumPackets() as unknown as {
      packets: Array<{ id: string }>;
      quarantined: Array<{ packetId?: string; error: string }>;
    };
    assert.deepEqual(result.packets.map((packet) => packet.id), ["PKT.valid"]);
    assert.equal(result.quarantined.length, 1);
    assert.equal(result.quarantined[0]?.packetId, "PKT.malformed");
    assert.match(result.quarantined[0]?.error ?? "", /verdict/i);
  });
});

test("Forum packet polling has a bounded configurable timeout", async () => {
  await withFakeForum("exec sleep 1", async () => {
    process.env.HIVE_FORUM_POLL_TIMEOUT_MS = "100";
    const started = Date.now();
    await assert.rejects(listForumPackets(), /timed out|failed/i);
    assert.ok(Date.now() - started < 700, "poll should be killed well before the fixture exits");
  });
});
