/**
 * The one executable-resolution rule (cohort-0 F8): PATH beats fallbacks,
 * both in fixed order; a configured path is never rewritten; nothing found
 * keeps the bare command so the OS ENOENT stays the honest diagnostic.
 * Everything is injected (fake PATH, fake fallback list, fake executability)
 * — no real filesystem probing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter, join, sep } from "node:path";
import {
  executableFallbackDirs,
  executableNotFoundDetail,
  resolveExecutable,
  resolveSpawnCommand,
} from "../src/index.ts";

const FALLBACKS = ["/fb/one", "/fb/two"] as const;

function executableAt(...paths: string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

test("executables: PATH dirs win over fallback dirs, each in order", () => {
  const env = { PATH: ["/p/one", "/p/two"].join(delimiter) };
  // Present in the second PATH dir AND the first fallback dir: PATH wins.
  const viaPath = resolveExecutable("codex", {
    env,
    fallbackDirs: FALLBACKS,
    isExecutable: executableAt(join("/p/two", "codex"), join("/fb/one", "codex")),
  });
  assert.deepEqual(viaPath, { path: join("/p/two", "codex"), source: "PATH" });

  // Present in both PATH dirs: the earlier dir wins.
  const pathOrder = resolveExecutable("codex", {
    env,
    fallbackDirs: FALLBACKS,
    isExecutable: executableAt(join("/p/one", "codex"), join("/p/two", "codex")),
  });
  assert.deepEqual(pathOrder, { path: join("/p/one", "codex"), source: "PATH" });

  // Absent from PATH, present in both fallback dirs: the earlier fallback wins.
  const fallbackOrder = resolveExecutable("codex", {
    env,
    fallbackDirs: FALLBACKS,
    isExecutable: executableAt(join("/fb/one", "codex"), join("/fb/two", "codex")),
  });
  assert.deepEqual(fallbackOrder, { path: join("/fb/one", "codex"), source: "fallback" });

  // Nowhere: null (the caller decides what that means).
  assert.equal(resolveExecutable("codex", { env, fallbackDirs: FALLBACKS, isExecutable: () => false }), null);
});

test("executables: the fixed fallback list matches the Apiary resolver (order included)", () => {
  const home = "/Users/op";
  assert.deepEqual(executableFallbackDirs(home), [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".kimi-code", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".local", "share", "mise", "shims"),
  ]);
});

test("executables: an empty/absent PATH resolves straight from the fallbacks", () => {
  const found = resolveExecutable("grok", {
    env: {},
    fallbackDirs: FALLBACKS,
    isExecutable: executableAt(join("/fb/two", "grok")),
  });
  assert.deepEqual(found, { path: join("/fb/two", "grok"), source: "fallback" });
});

test("resolveSpawnCommand: a bare name resolves to the absolute path and records the source", () => {
  const env = { PATH: "/p/one" };
  const hit = resolveSpawnCommand("codex", {
    env,
    fallbackDirs: FALLBACKS,
    isExecutable: executableAt(join("/fb/one", "codex")),
  });
  assert.equal(hit.command, join("/fb/one", "codex"));
  assert.deepEqual(hit.resolution, { executable: "codex", path: join("/fb/one", "codex"), source: "fallback" });
});

test("resolveSpawnCommand: nothing found keeps the bare command (honest ENOENT) with source not_found", () => {
  const miss = resolveSpawnCommand("codex", { env: { PATH: "/p/one" }, fallbackDirs: FALLBACKS, isExecutable: () => false });
  assert.equal(miss.command, "codex");
  assert.deepEqual(miss.resolution, { executable: "codex", path: null, source: "not_found" });
  // The operator-facing detail names the executable and the node-local cause.
  assert.match(executableNotFoundDetail("codex"), /'codex' was not found on this node/);
});

test("resolveSpawnCommand: a configured path is never rewritten, found or not", () => {
  const configured = ["", "opt", "hive", "bin", "codex"].join(sep);
  const kept = resolveSpawnCommand(configured, { env: { PATH: "/p/one" }, fallbackDirs: FALLBACKS, isExecutable: () => false });
  assert.equal(kept.command, configured);
  assert.deepEqual(kept.resolution, { executable: configured, path: configured, source: "configured_path" });
});
