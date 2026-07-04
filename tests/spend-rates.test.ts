import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureRatesFile, loadRates, saveRates, seedRateTable, validateRateTable } from "../src/spend/rates.js";
import { discoverConfigDirs, discoverHiveHomeSeats, ensureSeats, loadSeats } from "../src/spend/seats.js";
import type { RateRule } from "../src/spend/types.js";

function ruleFor(pattern: string): RateRule {
  const rule = seedRateTable().rules.find((entry) => entry.modelPattern === pattern);
  assert.ok(rule, `expected a seeded rule for ${pattern}`);
  return rule!;
}

test("seed prices a known Claude model with distinct 5m vs 1h cache-write rates", () => {
  const opus = ruleFor("claude-opus-4-8");
  assert.equal(opus.todo, undefined);
  assert.ok(opus.versions.length > 0);
  const version = opus.versions.at(-1)!;
  // Opus 4.8 list rate: $5 input / $25 output per MTok.
  assert.equal(version.inputPerMTok, 5);
  assert.equal(version.outputPerMTok, 25);
  // Cache reads are cheap; 1h writes are strictly pricier than 5m writes.
  assert.equal(version.cacheReadPerMTok, 0.5);
  assert.equal(version.cacheWrite5mPerMTok, 6.25);
  assert.equal(version.cacheWrite1hPerMTok, 10);
  assert.ok(
    version.cacheWrite1hPerMTok! > version.cacheWrite5mPerMTok!,
    "1h cache write must cost more than 5m cache write",
  );
});

test("seed versions Sonnet 5 so an in-window event prices at the intro rate", () => {
  const sonnet = ruleFor("claude-sonnet-5");
  assert.equal(sonnet.todo, undefined);
  const intro = sonnet.versions.find((version) => version.inputPerMTok === 2);
  const standard = sonnet.versions.find((version) => version.inputPerMTok === 3);
  assert.ok(intro, "expected an introductory $2 input version");
  assert.ok(standard, "expected a standard $3 input version");
  // Intro closes 2026-08-31; the standard version takes over on 2026-09-01.
  assert.equal(standard!.effectiveFrom, "2026-09-01");
});

test("seed marks an uncertain codex/gpt model as todo with empty versions", () => {
  const gpt = ruleFor("gpt-5");
  assert.equal(gpt.todo, true);
  assert.deepEqual(gpt.versions, []);
  assert.equal(gpt.provider, "openai");
});

test("validateRateTable rejects malformed input", () => {
  assert.throws(() => validateRateTable(null));
  assert.throws(() => validateRateTable({}));
  assert.throws(() => validateRateTable({ rules: [{ versions: [] }] }));
  assert.throws(() => validateRateTable({ rules: [{ modelPattern: "x", versions: [{ inputPerMTok: 1 }] }] }));
  // A well-formed seed round-trips cleanly.
  assert.doesNotThrow(() => validateRateTable(seedRateTable()));
});

test("ensureRatesFile writes the seed once and never clobbers user edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-rates-"));
  try {
    const path = join(dir, "nested", "rates.json");
    const returned = await ensureRatesFile(path);
    assert.equal(returned, path);
    const first = await loadRates(path);
    assert.ok(first.rules.length > 0);

    // Simulate a user edit, then re-ensure: the edit must survive.
    const edited = { rules: [{ modelPattern: "claude-opus-4-8", versions: [] }] };
    await saveRates(edited, path);
    await ensureRatesFile(path);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.rules.length, 1);
    assert.equal(after.rules[0].modelPattern, "claude-opus-4-8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadRates falls back to the seed when the file is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-rates-"));
  try {
    const table = await loadRates(join(dir, "does-not-exist.json"));
    assert.deepEqual(table, seedRateTable());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverConfigDirs finds claude/codex dirs and excludes backups", async () => {
  const home = await mkdtemp(join(tmpdir(), "honeybee-home-"));
  try {
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".claude-2"));
    await mkdir(join(home, ".codex"));
    await mkdir(join(home, ".codex-backups"));
    // A stray file and an unrelated dir must be ignored.
    await writeFile(join(home, ".claude.json"), "{}");
    await mkdir(join(home, ".config"));

    const seats = await discoverConfigDirs(home);
    const ids = seats.map((seat) => seat.id);
    // Bare config dirs of any harness map to ":default" (SPEC: "default for
    // the bare dir"), so ~/.codex -> codex:default like ~/.claude -> claude:default.
    assert.deepEqual(ids, ["claude:claude-2", "claude:default", "codex:default"]);

    const bare = seats.find((seat) => seat.id === "claude:default")!;
    assert.equal(bare.harness, "claude");
    assert.equal(bare.configDir, join(home, ".claude"));
    assert.equal(bare.label, ".claude");
    assert.equal(bare.monthlyUsd, undefined);
    // The backups dir must never become a seat.
    assert.ok(!ids.some((id) => id.includes("backup")), "backups dir must be excluded");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discoverHiveHomeSeats: finds honeybee account homes that hold transcripts", async () => {
  const store = await mkdtemp(join(tmpdir(), "honeybee-store-"));
  try {
    // A claude bee home with transcripts, a codex bee home with sessions,
    // a login-home variant, a grok home (unpriced → skipped), and an empty
    // claude home (no projects/ → skipped).
    await mkdir(join(store, "homes", "claude-tormod-thto.no", "projects"), { recursive: true });
    await mkdir(join(store, "homes", "codex-tormod-thto.no", "sessions"), { recursive: true });
    await mkdir(join(store, "login-homes", "claude-tormod-thto.no", "projects"), { recursive: true });
    await mkdir(join(store, "homes", "grok-tormod-thto.no", "projects"), { recursive: true });
    await mkdir(join(store, "homes", "claude-empty-acct"), { recursive: true }); // no projects/

    const seats = await discoverHiveHomeSeats(store);
    const ids = seats.map((s) => s.id).sort();
    assert.deepEqual(ids, [
      "claude:tormod-thto.no",
      "claude:tormod-thto.no@login",
      "codex:tormod-thto.no",
    ]);
    const primary = seats.find((s) => s.id === "claude:tormod-thto.no")!;
    assert.equal(primary.harness, "claude");
    assert.equal(primary.accountId, "claude-tormod-thto.no");
    assert.ok(primary.configDir.endsWith("homes/claude-tormod-thto.no"));
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("discoverHiveHomeSeats: absent store yields no seats", async () => {
  assert.deepEqual(await discoverHiveHomeSeats(join(tmpdir(), "honeybee-nonexistent-xyz")), []);
});

test("ensureSeats merge preserves a user-set monthlyUsd and adds new seats", async () => {
  const home = await mkdtemp(join(tmpdir(), "honeybee-home-"));
  const store = await mkdtemp(join(tmpdir(), "honeybee-seats-"));
  try {
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".claude-2"));
    const seatsFile = join(store, "seats.json");
    // Pre-existing seats.json where the user filled in cost/provider/plan.
    await writeFile(
      seatsFile,
      JSON.stringify({
        seats: [
          {
            id: "claude:default",
            harness: "claude",
            configDir: join(home, ".claude"),
            provider: "anthropic",
            plan: "max",
            monthlyUsd: 200,
            label: "primary",
          },
        ],
      }),
    );

    const merged = await ensureSeats(home, seatsFile, store); // store has no homes/ → deterministic
    const byId = new Map(merged.seats.map((seat) => [seat.id, seat]));

    const primary = byId.get("claude:default")!;
    assert.equal(primary.monthlyUsd, 200, "user-set monthlyUsd must survive merge");
    assert.equal(primary.provider, "anthropic");
    assert.equal(primary.plan, "max");
    assert.equal(primary.label, "primary");

    // The newly discovered dir is scaffolded with cost fields left blank.
    const added = byId.get("claude:claude-2")!;
    assert.ok(added, "newly discovered seat must be added");
    assert.equal(added.monthlyUsd, undefined);

    // The merge was persisted to disk.
    const persisted = await loadSeats(seatsFile);
    assert.equal(persisted.seats.find((seat) => seat.id === "claude:default")?.monthlyUsd, 200);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});
