import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as library from "../src/index.js";
import type { BeeState, SealRecord, SessionRecord } from "../src/index.js";

test("library root exposes parseBeeState", () => {
  assert.equal(typeof library.parseBeeState, "function");
  assert.equal(library.parseBeeState("active"), "active");
  // Legacy observed-state spellings normalize to done.
  assert.equal(library.parseBeeState("sealed"), "done");
  assert.equal(library.parseBeeState("archived"), "done");
  // Unrecognized caches are absent, never trusted.
  assert.equal(library.parseBeeState("garbage"), undefined);
  assert.equal(library.parseBeeState(undefined), undefined);
});

test("library root re-exports the record/state types", () => {
  // Compile-time assertions: the type surface embedders bind against exists
  // at the root. A missing re-export fails `npm run check`, not just here.
  const state: BeeState = "ready";
  const record: Pick<SessionRecord, "name" | "status"> = { name: "b", status: "running" };
  const seal: Pick<SealRecord, "beeName" | "sealedAt" | "status"> = {
    beeName: "b",
    sealedAt: "2026-07-28T00:00:00.000Z",
    status: "done",
  };
  assert.ok(state && record && seal);
});

test("package.json exposes the dist library entry", async () => {
  const raw = await readFile(join(process.cwd(), "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { types?: string; exports?: Record<string, { types?: string; default?: string }> };
  assert.equal(pkg.types, "dist/index.d.ts");
  assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts");
  assert.equal(pkg.exports?.["."]?.default, "./dist/index.js");
});
