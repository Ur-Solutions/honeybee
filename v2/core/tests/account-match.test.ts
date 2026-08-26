import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAccount } from "../src/index.ts";

const accounts = [
  { id: "claude-personal", harness: "claude", label: "owner@gmail.com" },
  { id: "claude-work", harness: "claude", label: "owner@example.com" },
  { id: "codex-personal", harness: "codex", label: "coder@gmail.com" },
  { id: "codex-work", harness: "codex", label: "claude-personal" },
] as const;

test("account selector: exact id/label precede unique case-insensitive substring matches", () => {
  const id = matchAccount(accounts, "CLAUDE-PERSONAL");
  assert.equal(id.ok && id.account.id, "claude-personal", "an id outranks another account's equal label");

  const label = matchAccount(accounts, "OWNER@EXAMPLE.COM");
  assert.equal(label.ok && label.account.id, "claude-work");

  const partial = matchAccount(accounts, "example");
  assert.equal(partial.ok && partial.account.id, "claude-work");
  assert.equal(partial.ok && partial.kind, "substring");
});

test("account selector: `<harness>-<query>` scopes fuzzy matching and ambiguity never picks by order", () => {
  const scoped = matchAccount(accounts, "claude-gmail");
  assert.equal(scoped.ok && scoped.account.id, "claude-personal");
  assert.equal(scoped.ok && scoped.scopedHarness, "claude");

  const ambiguous = matchAccount(accounts, "gmail");
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.reason, "ambiguous");
    assert.deepEqual(ambiguous.matches.map((account) => account.id), ["claude-personal", "codex-personal"]);
  }

  const missing = matchAccount(accounts, "claude-nowhere");
  assert.deepEqual(missing, { ok: false, reason: "not_found", matches: [], scopedHarness: null });
});
