import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  kitAvailableVersion,
  kitMaterializeHome,
  readKitHomeStamp,
  resetKitProbeForTests,
} from "../src/kit.js";
import { resolveKitProfileFlag, spawnBee, type SpawnRuntimeDependencies } from "../src/commands/spawn.js";
import { parse } from "../src/parse.js";
import { loadSession } from "../src/store.js";

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

test("resolveKitProfileFlag: value ok, absent → undefined, bare → throws", () => {
  assert.equal(resolveKitProfileFlag(parse(["spawn", "claude", "--kit-profile", "web-qa"])), "web-qa");
  assert.equal(resolveKitProfileFlag(parse(["spawn", "claude"])), undefined);
  assert.throws(
    () => resolveKitProfileFlag(parse(["spawn", "claude", "--kit-profile"])),
    /requires a profile name/,
  );
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

test("execution spawn converges Kit before HSR boot and stamps the exact profile/version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-kit-execution-"));
  const home = join(dir, "codex-home");
  const previousStore = process.env.HIVE_STORE_ROOT;
  const calls = join(dir, "calls.txt");
  const hostPid = 58431;
  try {
    await mkdir(home, { recursive: true });
    await makeStubKit(
      dir,
      `if [ "$1" = "version" ]; then echo '{"version":"9.9.9"}'; exit 0; fi
echo "$@" > "${calls}"
mkdir -p "${home}/.kit"
echo '{"schema":1,"kitVersion":"9.9.9","profile":"web-qa","entries":[]}' > "${home}/.kit/manifest.json"
echo '[]'`,
    );
    process.env.HIVE_KIT_BIN = join(dir, "kit");
    process.env.HIVE_STORE_ROOT = join(dir, "store");
    resetKitProbeForTests();
    let forkObserved = false;
    const runtimeDeps: SpawnRuntimeDependencies = {
      spawnHsrHost: async () => {
        forkObserved = true;
        assert.deepEqual(
          await readKitHomeStamp(home),
          { kitVersion: "9.9.9", kitProfile: "web-qa" },
          "strict convergence finishes before the harness host is forked",
        );
        return hostPid;
      },
      readHsrMetaStrict: async (bee) => ({
        bee,
        harness: "codex",
        tier: "stream",
        hostPid,
        hostFingerprint: { pgid: hostPid, startedAt: "kit-profile-test-birth" },
        childAdmission: "none",
        startedAt: "2026-08-13T00:00:00.000Z",
        controlSocket: join(dir, "control.sock"),
        status: "queued",
      }),
      stopHsrIncarnationByPid: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    };

    const record = await spawnBee({
      agent: "codex",
      extraArgs: [],
      cwd: dir,
      home,
      yolo: false,
      name: "execution-kit-profile",
      substrate: "hsr",
      executionRunId: "run-kit-profile",
      kitProfile: "web-qa",
    }, runtimeDeps);

    assert.equal(forkObserved, true);
    assert.equal(record.kitProfile, "web-qa");
    assert.equal(record.kitVersion, "9.9.9");
    const persisted = await loadSession(record.name);
    assert.deepEqual(
      { kitProfile: persisted?.kitProfile, kitVersion: persisted?.kitVersion },
      { kitProfile: "web-qa", kitVersion: "9.9.9" },
    );
    assert.match((await readFile(calls, "utf8")).trim(), /--profile web-qa --json$/);
  } finally {
    delete process.env.HIVE_KIT_BIN;
    if (previousStore === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousStore;
    resetKitProbeForTests();
    await rm(dir, { recursive: true, force: true });
  }
});

test("execution spawn refuses to boot when Kit exits successfully without proving convergence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-kit-unproven-"));
  const home = join(dir, "codex-home");
  const previousStore = process.env.HIVE_STORE_ROOT;
  try {
    await mkdir(home, { recursive: true });
    await makeStubKit(
      dir,
      `if [ "$1" = "version" ]; then echo '{"version":"9.9.9"}'; exit 0; fi
echo '[]'`,
    );
    process.env.HIVE_KIT_BIN = join(dir, "kit");
    process.env.HIVE_STORE_ROOT = join(dir, "store");
    resetKitProbeForTests();
    let forked = false;

    await assert.rejects(
      spawnBee({
        agent: "codex",
        extraArgs: [],
        cwd: dir,
        home,
        yolo: false,
        name: "execution-kit-unproven",
        substrate: "hsr",
        executionRunId: "run-kit-unproven",
        kitProfile: "web-qa",
      }, {
        spawnHsrHost: async () => {
          forked = true;
          return 58432;
        },
      }),
      /kit profile web-qa did not converge .*profile \(missing\), version \(missing\)/,
    );
    assert.equal(forked, false, "the harness host is never forked without a matching Kit manifest");
  } finally {
    delete process.env.HIVE_KIT_BIN;
    if (previousStore === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousStore;
    resetKitProbeForTests();
    await rm(dir, { recursive: true, force: true });
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

test("recent best-effort materialization skips Kit subprocesses but strict requests do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-kit-fresh-"));
  const home = join(dir, "home");
  const calls = join(dir, "calls.txt");
  const now = Date.parse("2026-07-20T08:00:00.000Z");
  try {
    await makeStubKit(
      dir,
      `echo "$@" >> "${calls}"
if [ "$1" = "version" ]; then echo '{"version":"9.9.9"}'; exit 0; fi
echo '[]'`,
    );
    await mkdir(join(home, ".kit"), { recursive: true });
    await writeFile(
      join(home, ".kit", "manifest.json"),
      JSON.stringify({
        schema: 1,
        kitVersion: "9.9.9",
        profile: "base",
        materializedAt: new Date(now - 5_000).toISOString(),
        entries: [],
      }),
    );
    process.env.HIVE_KIT_BIN = join(dir, "kit");
    resetKitProbeForTests();

    await kitMaterializeHome(home, "codex", {
      profile: "base",
      freshnessTtlMs: 60_000,
      now: () => now,
    });
    const { readFile } = await import("node:fs/promises");
    await assert.rejects(readFile(calls, "utf8"), /ENOENT/, "fresh fast path never probes or syncs Kit");

    await kitMaterializeHome(home, "codex", {
      profile: "base",
      strict: true,
      freshnessTtlMs: 60_000,
      now: () => now,
    });
    const invoked = await readFile(calls, "utf8");
    assert.match(invoked, /^version --json/m);
    assert.match(invoked, /sync --home .* --harness codex --profile base --json/);
  } finally {
    delete process.env.HIVE_KIT_BIN;
    resetKitProbeForTests();
    await rm(dir, { recursive: true, force: true });
  }
});
