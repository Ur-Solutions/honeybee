import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { slotGlyph } from "../src/beesTui.js";
import { poolCapacityChip } from "../src/commands/observe.js";
import { CANONICAL_TMUX_CONF, CANONICAL_WEZTERM_BLOCK, RECOMMENDED_BINDS } from "../src/keybindings.js";
import { choosePoolLaunch, poolCapacityCell, type PoolLaunchRow } from "../src/poolLaunchTui.js";

// ── keybinding surface (§6.7) ────────────────────────────────────────────────

test("M-P pool launcher is bound in the canonical tmux block, RECOMMENDED_BINDS, and the WezTerm additions", () => {
  assert.match(CANONICAL_TMUX_CONF, /bind -n M-P display-popup .*"hive pool launch"/);
  const bind = RECOMMENDED_BINDS.find((b) => b.key === "M-P");
  assert.ok(bind, "RECOMMENDED_BINDS carries M-P");
  assert.equal(bind!.verb, "pool");
  assert.match(CANONICAL_WEZTERM_BLOCK, /key = 'p', mods = 'SUPER\|SHIFT', action = meta\('P'\)/);
  // Lowercase M-p stays free: the WezTerm Zellij ALT layer owns it (the same
  // collision that put fork on M-k). Guard against a well-meaning "fix".
  assert.ok(!CANONICAL_TMUX_CONF.includes("bind -n M-p "), "lowercase M-p must not be bound");
});

// ── capacity cells ───────────────────────────────────────────────────────────

test("poolCapacityCell/poolCapacityChip: zero-free pools read '(will extend)', never disabled", () => {
  assert.equal(poolCapacityCell({ free: 4, size: 6, busy: 2 }), "4/6 free · 2 busy");
  assert.equal(poolCapacityCell({ free: 0, size: 3, busy: 3 }), "0/3 free (will extend)");
  assert.equal(poolCapacityChip({ pool: "core", free: 4, size: 6, busy: 2 }), "core 4/6 · 2 busy");
  assert.equal(poolCapacityChip({ pool: "core", free: 0, size: 3, busy: 3 }), "core 0/3 (will extend)");
});

// ── slot glyphs (§6.7 TUI surfacing) ─────────────────────────────────────────

test("slotGlyph: pool members render '⎇ core-3'; plain slots keep their kind glyph", () => {
  assert.equal(slotGlyph({ poolMemberLabel: "core-3" }), "⎇ core-3");
  assert.equal(slotGlyph({ proSlotKind: "checkout" }), "⎇");
  assert.equal(slotGlyph({ proSlotKind: "worktree" }), "⧉");
  assert.equal(slotGlyph({}), "");
});

// ── choosePoolLaunch (driven through fake streams) ───────────────────────────

class FakeStdin extends EventEmitter {
  isRaw = false;
  setRawMode(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

class FakeStdout extends EventEmitter {
  writes: string[] = [];
  columns = 100;
  rows = 30;
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function fakeStreams() {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  return {
    stdin,
    stdout,
    streams: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream },
  };
}

const ROWS: PoolLaunchRow[] = [
  { key: "trmd-honeybee-honeybee-core", pool: "core", capacity: "4/6 free · 2 busy", context: "trmd/honeybee/honeybee @ main" },
  { key: "trmd-honeybee-honeybee-fleet", pool: "fleet", capacity: "0/3 free (will extend)", context: "trmd/honeybee/honeybee @ main" },
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("choosePoolLaunch: ↵ ↵ happy path picks the first pool and the first agent", async () => {
  const { stdin, streams } = fakeStreams();
  const promise = choosePoolLaunch({
    pools: ROWS,
    loadBeeOptions: async () => [
      { value: "claude-auto", label: "claude · auto" },
      { value: "codex", label: "codex · (no account)" },
    ],
    streams,
  });
  stdin.emit("keypress", "", { name: "return" });
  await tick(); // agent options load
  stdin.emit("keypress", "", { name: "return" });
  assert.deepEqual(await promise, { poolKey: "trmd-honeybee-honeybee-core", bee: "claude-auto" });
});

test("choosePoolLaunch: type-to-filter narrows pools (zero-free stays pickable); esc from agents goes back; esc cancels", async () => {
  const { stdin, streams } = fakeStreams();
  const promise = choosePoolLaunch({
    pools: ROWS,
    loadBeeOptions: async () => [{ value: "claude-auto", label: "claude · auto" }],
    streams,
  });
  for (const ch of "fleet") stdin.emit("keypress", ch, { name: ch, sequence: ch });
  stdin.emit("keypress", "", { name: "return" }); // pick the (will extend) pool
  await tick();
  stdin.emit("keypress", "", { name: "escape" }); // back to pools
  stdin.emit("keypress", "", { name: "escape" }); // cancel
  assert.equal(await promise, null);
});

test("choosePoolLaunch: ctrl-c cancels from any stage", async () => {
  const { stdin, streams } = fakeStreams();
  const promise = choosePoolLaunch({ pools: ROWS, loadBeeOptions: async () => [], streams });
  stdin.emit("keypress", "c", { name: "c", ctrl: true });
  assert.equal(await promise, null);
});
