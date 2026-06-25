// Coverage for the short, bee-id-style loop ids (src/loop/state.ts):
// generateLoopId mints `LP.<hex>` ids that stay unambiguously targetable, and
// resolveLoopId matches a loop by full id, bare suffix, or unambiguous prefix
// (and still matches legacy long-form run ids exactly). generateLoopId/
// resolveLoopId only read the loops dir's entry NAMES, so the tests just mkdir
// empty loop dirs to simulate existing loops.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateLoopId, LOOP_ID_PREFIX, resolveLoopId } from "../src/loop/state.js";

async function withStore(seedIds: string[], fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-loop-id-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    for (const id of seedIds) await mkdir(join(dir, "loops", id), { recursive: true });
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const uuid = (hex: string) => () => hex;

test("generateLoopId: LP.<3 hex> in an empty store", async () => {
  await withStore([], async () => {
    const id = await generateLoopId(uuid("a3f9c2b1d4e5000000000000000000ab"));
    assert.equal(id, `${LOOP_ID_PREFIX}a3f`);
    assert.match(id, /^LP\.[0-9a-f]{3,}$/);
  });
});

test("generateLoopId: grows the suffix when the 3-char form is already taken", async () => {
  await withStore(["LP.a3f"], async () => {
    // len-3 "LP.a3f" collides → grow to "LP.a3f9".
    const id = await generateLoopId(uuid("a3f9c2b1d4e5000000000000000000ab"));
    assert.equal(id, "LP.a3f9");
  });
});

test("generateLoopId: grows when the short form would PREFIX an existing longer id", async () => {
  await withStore(["LP.a3f9"], async () => {
    // len-3 "LP.a3f" prefixes existing "LP.a3f9" (ambiguous) → grow to "LP.a3f0".
    const id = await generateLoopId(uuid("a3f0112233445566778899aabbccddee"));
    assert.equal(id, "LP.a3f0");
  });
});

test("resolveLoopId: full id, bare suffix, and unambiguous prefix all match", async () => {
  await withStore(["LP.a3f", "LP.b71"], async () => {
    assert.equal(await resolveLoopId("LP.a3f"), "LP.a3f"); // full id
    assert.equal(await resolveLoopId("a3f"), "LP.a3f"); // bare suffix
    assert.equal(await resolveLoopId("b7"), "LP.b71"); // unambiguous prefix of the suffix
  });
});

test("resolveLoopId: legacy long-form run ids still match exactly", async () => {
  await withStore(["00001KVF54YNV-8ae9"], async () => {
    assert.equal(await resolveLoopId("00001KVF54YNV-8ae9"), "00001KVF54YNV-8ae9");
  });
});

test("resolveLoopId: throws on unknown and on ambiguous references", async () => {
  await withStore(["LP.a3f", "LP.a3b"], async () => {
    await assert.rejects(() => resolveLoopId("zzz"), /Unknown loop/);
    // "a3" prefixes both a3f and a3b → ambiguous.
    await assert.rejects(() => resolveLoopId("a3"), /Ambiguous loop ref/);
  });
});
