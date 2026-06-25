// Pure-logic coverage for the `hive fork launch` dialog (src/forkTui.ts): how
// the form seeds its defaults, the launch gate (account-bound source + worktree
// name), the seed/agent/model/isolation → `hive fork` intent mapping, and the
// focusable-row model (slot row only for a worktree, account essential vs
// advanced). The interactive render loop needs a TTY and is not unit-tested;
// these are the load-bearing decisions cli.ts depends on.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SEED_OPTIONS,
  SEED_HELP,
  whereOptions,
  defaultForkForm,
  missingForFork,
  forkIntent,
  formRows,
  type ForkAccountOption,
  type ForkFormValues,
} from "../src/forkTui.js";

const ACCOUNTS: ForkAccountOption[] = [
  { value: "", label: "inherit (no account binding)" },
  { value: "auto", label: "auto", detail: "least-loaded account" },
  { value: "thto", label: "thto.no", detail: "5h 12%" },
];

const baseForm = (over: Partial<ForkFormValues> = {}): ForkFormValues => ({
  seed: "auto",
  agent: "claude",
  model: "",
  where: "same",
  slot: "",
  account: "",
  name: "",
  message: "",
  ...over,
});

test("whereOptions: worktree/checkout only when the source is in a pro repo", () => {
  assert.deepEqual(whereOptions(false), ["same"]);
  assert.deepEqual(whereOptions(true), ["same", "worktree", "checkout"]);
});

test("SEED_HELP has a gloss for every seed option", () => {
  for (const opt of SEED_OPTIONS) assert.ok((SEED_HELP[opt] ?? "").length > 0, `${opt} needs help text`);
});

test("defaultForkForm: a default-home source inherits (no account binding)", () => {
  const v = defaultForkForm({ sourceAgent: "codex", accountRequired: false, accountOptions: ACCOUNTS, suggestSlot: "fork-x" });
  assert.equal(v.seed, "auto");
  assert.equal(v.agent, "codex");
  assert.equal(v.where, "same");
  assert.equal(v.account, "", "default-home source leaves the account unbound");
  assert.equal(v.slot, "fork-x", "slot is pre-seeded so switching to worktree is one keystroke");
});

test("defaultForkForm: an account-bound source defaults to the first concrete account", () => {
  // cli.ts excludes the source's own account, so the first non-blank option is a
  // safe different account.
  const opts: ForkAccountOption[] = [{ value: "auto", label: "auto" }, { value: "other", label: "other.no" }];
  const v = defaultForkForm({ sourceAgent: "claude", accountRequired: true, accountOptions: opts, suggestSlot: "fork" });
  assert.equal(v.account, "auto", "first option wins when it is the only concrete choice");

  const v2 = defaultForkForm({ sourceAgent: "claude", accountRequired: true, accountOptions: [{ value: "other", label: "other.no" }], suggestSlot: "fork" });
  assert.equal(v2.account, "other");

  const v3 = defaultForkForm({ sourceAgent: "claude", accountRequired: true, accountOptions: [], suggestSlot: "fork" });
  assert.equal(v3.account, "auto", "falls back to auto when no concrete account is offered");
});

test("missingForFork: account-bound source needs an account; worktree needs a name", () => {
  assert.deepEqual(missingForFork(baseForm(), { accountRequired: false }), []);
  assert.deepEqual(missingForFork(baseForm({ account: "" }), { accountRequired: true }), ["account"]);
  assert.deepEqual(missingForFork(baseForm({ account: "thto" }), { accountRequired: true }), []);
  assert.deepEqual(missingForFork(baseForm({ where: "worktree", slot: "" }), { accountRequired: false }), ["name"]);
  assert.deepEqual(missingForFork(baseForm({ where: "worktree", slot: "  " }), { accountRequired: false }), ["name"], "whitespace-only name is blank");
  assert.deepEqual(missingForFork(baseForm({ where: "worktree", slot: "api" }), { accountRequired: false }), []);
  assert.deepEqual(
    missingForFork(baseForm({ where: "checkout", slot: "", account: "" }), { accountRequired: true }),
    ["account", "name"],
    "both gates can fail together",
  );
});

test("forkIntent: seed labels map to explicit --seed (auto is the default ladder)", () => {
  assert.equal(forkIntent(baseForm({ seed: "auto" }), { sourceName: "b", sourceAgent: "claude" }).seed, undefined);
  assert.equal(forkIntent(baseForm({ seed: "seal" }), { sourceName: "b", sourceAgent: "claude" }).seed, "seal");
  assert.equal(forkIntent(baseForm({ seed: "log" }), { sourceName: "b", sourceAgent: "claude" }).seed, "log");
  assert.equal(forkIntent(baseForm({ seed: "cold" }), { sourceName: "b", sourceAgent: "claude" }).seed, "none");
});

test("forkIntent: agent is only emitted when it differs from the source", () => {
  assert.equal(forkIntent(baseForm({ agent: "claude" }), { sourceName: "b", sourceAgent: "claude" }).agent, undefined);
  assert.equal(forkIntent(baseForm({ agent: "codex" }), { sourceName: "b", sourceAgent: "claude" }).agent, "codex");
});

test("forkIntent: trims overrides and omits empties; selector is the source name", () => {
  const intent = forkIntent(
    baseForm({ model: "  opus  ", name: " api ", account: " thto ", message: "  take the API half  " }),
    { sourceName: "honey-CL.a3f", sourceAgent: "claude" },
  );
  assert.equal(intent.selector, "honey-CL.a3f");
  assert.equal(intent.model, "opus");
  assert.equal(intent.name, "api");
  assert.equal(intent.account, "thto");
  assert.equal(intent.message, "take the API half");
  assert.equal(intent.isolation, undefined, "same dir → no isolation");

  const bare = forkIntent(baseForm(), { sourceName: "b", sourceAgent: "claude" });
  assert.deepEqual(bare, { selector: "b" }, "an all-defaults form is just the selector");
});

test("forkIntent: worktree/checkout becomes an isolation request", () => {
  const wt = forkIntent(baseForm({ where: "worktree", slot: " api " }), { sourceName: "b", sourceAgent: "claude" });
  assert.deepEqual(wt.isolation, { kind: "worktree", name: "api" });
  const co = forkIntent(baseForm({ where: "checkout", slot: "exp" }), { sourceName: "b", sourceAgent: "claude" });
  assert.deepEqual(co.isolation, { kind: "checkout", name: "exp" });
});

test("formRows: same dir + default-home — slot and account hidden until needed", () => {
  const collapsed = formRows(baseForm(), false, false);
  assert.deepEqual(
    collapsed.map((r) => (r.kind === "field" ? r.key : r.kind)),
    ["seed", "agent", "where", "toggle", "action"],
  );
  const expanded = formRows(baseForm(), true, false);
  assert.deepEqual(
    expanded.map((r) => (r.kind === "field" ? r.key : r.kind)),
    ["seed", "agent", "where", "toggle", "model", "name", "account", "message", "action"],
  );
  assert.equal(expanded.at(-1)?.kind, "action", "Fork is always last");
});

test("formRows: a worktree reveals the slot row right after where", () => {
  const rows = formRows(baseForm({ where: "worktree" }), false, false);
  assert.deepEqual(
    rows.map((r) => (r.kind === "field" ? r.key : r.kind)),
    ["seed", "agent", "where", "slot", "toggle", "action"],
  );
});

test("formRows: an account-bound source makes account essential and never duplicates it", () => {
  const collapsed = formRows(baseForm(), false, true);
  assert.deepEqual(
    collapsed.map((r) => (r.kind === "field" ? r.key : r.kind)),
    ["seed", "agent", "where", "account", "toggle", "action"],
  );
  const expanded = formRows(baseForm(), true, true);
  const accountRows = expanded.filter((r) => r.kind === "field" && r.key === "account");
  assert.equal(accountRows.length, 1, "account appears once (as an essential), not again under advanced");
});

test("formRows: every field row carries non-empty help text", () => {
  for (const row of formRows(baseForm({ where: "worktree" }), true, true)) {
    if (row.kind === "field" || row.kind === "toggle" || row.kind === "action") {
      assert.ok(row.description.length > 0, `${JSON.stringify(row)} should have help text`);
    }
  }
});
