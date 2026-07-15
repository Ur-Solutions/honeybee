import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  kitAvailableVersion,
  kitMaterializeHome,
  readKitHomeStamp,
  resetKitProbeForTests,
} from "../src/kit.js";

async function makeStubKit(dir: string, body: string): Promise<string> {
  const bin = join(dir, "kit");
  await writeFile(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(bin, 0o755);
  return bin;
}

test("kit integration is a silent no-op without a binary; strict throws", async () => {
  resetKitProbeForTests();
  process.env.HIVE_KIT_BIN = "/nonexistent/kit-binary";
  delete process.env.HIVE_KIT_DISABLE;
  try {
    assert.equal(await kitAvailableVersion(), null);
    const warnings: string[] = [];
    await kitMaterializeHome("/tmp/nope", "claude", { warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 0, "missing binary is silent, not a warning per activation");
    await assert.rejects(
      kitMaterializeHome("/tmp/nope", "claude", { profile: "web-qa", strict: true }),
      /kit binary not found/,
    );
  } finally {
    delete process.env.HIVE_KIT_BIN;
    resetKitProbeForTests();
  }
});

test("kitMaterializeHome shells out with the right argv; failures warn or throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-kit-"));
  try {
    // Stub: `version --json` succeeds; `sync` logs its argv then exits per KIT_STUB_FAIL.
    await makeStubKit(
      dir,
      `if [ "$1" = "version" ]; then echo '{"name":"trmdy-kit","version":"9.9.9"}'; exit 0; fi
echo "$@" > "${dir}/argv.txt"
if [ -n "$KIT_STUB_FAIL" ]; then echo "boom: unknown profile" >&2; exit 1; fi
echo '[]'`,
    );
    process.env.HIVE_KIT_BIN = join(dir, "kit");
    resetKitProbeForTests();

    assert.equal(await kitAvailableVersion(), "9.9.9");
    await kitMaterializeHome("/some/home", "codex", { profile: "web-qa" });
    const { readFile } = await import("node:fs/promises");
    const argv = (await readFile(join(dir, "argv.txt"), "utf8")).trim();
    assert.equal(argv, "sync --home /some/home --harness codex --profile web-qa --json");

    process.env.KIT_STUB_FAIL = "1";
    const warnings: string[] = [];
    await kitMaterializeHome("/some/home", "codex", { warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /kit sync skipped .*boom: unknown profile/);
    await assert.rejects(
      kitMaterializeHome("/some/home", "codex", { profile: "bogus", strict: true }),
      /kit sync --profile bogus failed .*boom/,
    );
  } finally {
    delete process.env.KIT_STUB_FAIL;
    delete process.env.HIVE_KIT_BIN;
    resetKitProbeForTests();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HIVE_KIT_DISABLE forces the integration off", async () => {
  process.env.HIVE_KIT_DISABLE = "1";
  try {
    resetKitProbeForTests();
    assert.equal(await kitAvailableVersion(), null);
    await kitMaterializeHome("/x", "claude", {}); // no-op, no throw
    await assert.rejects(
      kitMaterializeHome("/x", "claude", { profile: "p", strict: true }),
      /disabled/,
    );
  } finally {
    delete process.env.HIVE_KIT_DISABLE;
    resetKitProbeForTests();
  }
});

test("readKitHomeStamp reads the ownership manifest, {} otherwise", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-kit-home-"));
  try {
    assert.deepEqual(await readKitHomeStamp(home), {});
    await mkdir(join(home, ".kit"), { recursive: true });
    await writeFile(
      join(home, ".kit", "manifest.json"),
      JSON.stringify({ schema: 1, kitVersion: "0.2.0", profile: "web-qa", entries: [] }),
    );
    assert.deepEqual(await readKitHomeStamp(home), { kitVersion: "0.2.0", kitProfile: "web-qa" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("materialize passes the standing profile through so activation never reverts it", async () => {
  // Regression for the review HIGH: a plain activation must converge toward the
  // home's existing (manifest-stamped) profile, not the machine default.
  const dir = await mkdtemp(join(tmpdir(), "hive-kit-"));
  try {
    await makeStubKit(
      dir,
      `if [ "$1" = "version" ]; then echo '{"version":"9.9.9"}'; exit 0; fi
echo "$@" > "${dir}/argv.txt"
echo '[]'`,
    );
    process.env.HIVE_KIT_BIN = join(dir, "kit");
    resetKitProbeForTests();
    // Simulate what activation.ts does: read stamp, pass its profile through.
    const home = await mkdtemp(join(tmpdir(), "hive-kit-home-"));
    await mkdir(join(home, ".kit"), { recursive: true });
    await writeFile(
      join(home, ".kit", "manifest.json"),
      JSON.stringify({ schema: 1, kitVersion: "0.1.0", profile: "web-qa", entries: [] }),
    );
    const stamp = await readKitHomeStamp(home);
    await kitMaterializeHome(home, "claude", { profile: stamp.kitProfile });
    const { readFile } = await import("node:fs/promises");
    const argv = (await readFile(join(dir, "argv.txt"), "utf8")).trim();
    assert.match(argv, /--profile web-qa/, "converges to the home's standing profile, not the default");
    await rm(home, { recursive: true, force: true });
  } finally {
    delete process.env.HIVE_KIT_BIN;
    resetKitProbeForTests();
    await rm(dir, { recursive: true, force: true });
  }
});
