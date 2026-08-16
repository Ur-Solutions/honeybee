import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { bootstrapRunnerHost, remoteBundlePath, type SshExecHook } from "../src/hsr/bootstrap.js";
import { loadNode } from "../src/node.js";

const execFileAsync = promisify(execFile);

/** Run `fn` with HIVE_STORE_ROOT pointed at a fresh temp dir. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-rh-bootstrap-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

type Recorded = { command: string; input?: string };

/**
 * A scripted ssh exec hook: classifies each remote command (the LAST argv word)
 * and returns canned output, recording an ordered trace for assertions. No real
 * host, no esbuild.
 */
function makeExecHook(opts: {
  nodeVersion?: string;
  remoteHasBundle?: boolean;
  remoteBundleHash?: string;
  handshakeVersion: string; // what `node <bundle> --version` prints
  liveServe?: "absent" | "current" | "stale-upgradeable" | "stale-active" | "legacy";
  trace: Recorded[];
}): SshExecHook {
  let socketUp = opts.liveServe !== undefined && opts.liveServe !== "absent";
  return async (argv, input) => {
    const command = argv[argv.length - 1] ?? "";
    opts.trace.push({ command, ...(input !== undefined ? { input } : {}) });
    if (command === "node --version") {
      return { stdout: `${opts.nodeVersion ?? "v20.11.0"}\n`, stderr: "", exitCode: 0 };
    }
    if (command.startsWith("mkdir -p")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.startsWith("[ -f")) {
      const output = opts.remoteHasBundle ? (opts.remoteBundleHash ?? "") : "__HIVE_RH_MISSING__";
      return { stdout: `${output}\n`, stderr: "", exitCode: 0 };
    }
    if (command.startsWith("cat >")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.endsWith("--version") && command.includes(".mjs")) {
      return { stdout: `${opts.handshakeVersion}\n`, stderr: "", exitCode: 0 };
    }
    if (command.startsWith("test -S")) {
      return { stdout: "", stderr: "", exitCode: socketUp ? 0 : 1 };
    }
    if (command.includes(" upgrade --socket ")) {
      if (opts.liveServe === "current") return { stdout: "already-current\n", stderr: "", exitCode: 0 };
      if (opts.liveServe === "stale-upgradeable") {
        socketUp = false;
        return { stdout: "upgraded\n", stderr: "", exitCode: 0 };
      }
      if (opts.liveServe === "stale-active") {
        return { stdout: "", stderr: "upgrade refused while remote HSR work is active: busy-bee", exitCode: 1 };
      }
      return { stdout: "", stderr: "Method not found: prepareUpgrade", exitCode: 1 };
    }
    if (command.startsWith("setsid node")) {
      socketUp = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.includes(" probe --socket ")) {
      return socketUp
        ? { stdout: `${opts.handshakeVersion}\n`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "no live socket", exitCode: 1 };
    }
    return { stdout: "", stderr: `unexpected command: ${command}`, exitCode: 1 };
  };
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertAtomicCopyCommand(command: string, version: string, expectedHash: string): void {
  const remotePath = remoteBundlePath(version);
  const tempPath = `${remotePath}.tmp.$$`;
  assert.ok(command.startsWith(`cat > ${tempPath} && [ "$(node -e `), "copy should write to a temp path and hash it");
  assert.ok(
    command.includes(` ${tempPath})" = ${expectedHash} ] && mv -f ${tempPath} ${remotePath}`),
    "copy should move the temp path into place only after the remote hash matches",
  );
}

const fakeBundle = (version: string) => ({
  ensureBundle: async () => ({ path: `/local/hive-runner-host-${version}.mjs`, version }),
  readBundle: async () => `// fake bundle ${version}\n`,
  content: `// fake bundle ${version}\n`,
});

test("bootstrap: registers remote-hsr node and runs node-check → mkdir → copy → handshake in order", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+deadbeef1234";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle, content } = fakeBundle(version);
    const result = await bootstrapRunnerHost(
      { name: "loopunit", endpoint: "me@localhost", capabilities: ["claude"] },
      { execHook: makeExecHook({ handshakeVersion: `runner-host ${version}`, trace }), ensureBundle, readBundle },
    );

    assert.equal(result.node.kind, "remote-hsr");
    assert.equal(result.node.endpoint, "me@localhost");
    assert.equal(result.node.runnerHostVersion, version);
    assert.equal(result.version, version);
    assert.equal(result.deployed, true);
    assert.equal(result.remotePath, remoteBundlePath(version));

    // Persisted record round-trips with the runner-host version.
    const loaded = await loadNode("loopunit");
    assert.ok(loaded);
    assert.equal(loaded.kind, "remote-hsr");
    assert.equal(loaded.runnerHostVersion, version);
    assert.deepEqual(loaded.capabilities, ["claude"]);

    // Command sequence includes exact live-authority start and digest probe
    // before the NodeRecord is published.
    const kinds = trace.map((t) => {
      if (t.command === "node --version") return "node-check";
      if (t.command.startsWith("mkdir")) return "mkdir";
      if (t.command.startsWith("[ -f")) return "hash";
      if (t.command.startsWith("cat >")) return "copy";
      if (t.command.endsWith("--version")) return "handshake";
      if (t.command.startsWith("test -S")) return "socket";
      if (t.command.startsWith("setsid node")) return "serve";
      if (t.command.includes(" probe --socket ")) return "live-handshake";
      return "other";
    });
    assert.deepEqual(kinds, [
      "node-check", "mkdir", "hash", "copy", "handshake",
      "socket", "socket", "serve", "socket", "live-handshake",
    ]);
    // The copy carried the bundle bytes on stdin.
    const copy = trace.find((t) => t.command.startsWith("cat >"))!;
    assertAtomicCopyCommand(copy.command, version, sha256Hex(content));
    assert.match(copy.input ?? "", /fake bundle/);
  });
});

test("bootstrap: idempotent re-run skips re-copy when the remote already has the version", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+cafebabe5678";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle, content } = fakeBundle(version);
    const result = await bootstrapRunnerHost(
      { name: "loopunit2", endpoint: "me@localhost" },
      {
        execHook: makeExecHook({ handshakeVersion: `runner-host ${version}`, remoteHasBundle: true, remoteBundleHash: sha256Hex(content), liveServe: "current", trace }),
        ensureBundle,
        readBundle,
      },
    );
    assert.equal(result.deployed, false, "should skip copy when the version file exists");
    assert.ok(!trace.some((t) => t.command.startsWith("cat >")), "no copy command should be issued");
    // Still handshakes.
    assert.ok(trace.some((t) => t.command.endsWith("--version") && t.command.includes(".mjs")));
    assert.ok(trace.some((t) => t.command.includes(" upgrade --socket ")), "current serve is still digest-probed by the deployed client");
    assert.ok(!trace.some((t) => t.command.startsWith("setsid node")), "current exact serve is not restarted");
  });
});

test("bootstrap: re-deploys atomically when an existing remote bundle hash differs", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+badc0ffee123";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle, content } = fakeBundle(version);
    const result = await bootstrapRunnerHost(
      { name: "loopunit-corrupt", endpoint: "me@localhost" },
      {
        execHook: makeExecHook({
          handshakeVersion: `runner-host ${version}`,
          remoteHasBundle: true,
          remoteBundleHash: sha256Hex("// truncated\n"),
          trace,
        }),
        ensureBundle,
        readBundle,
      },
    );

    assert.equal(result.deployed, true, "hash mismatch should force a fresh deploy");
    const copy = trace.find((t) => t.command.startsWith("cat >"));
    assert.ok(copy, "copy command should be issued for a corrupt existing file");
    assertAtomicCopyCommand(copy.command, version, sha256Hex(content));
  });
});

test("bootstrap: a quiescent same-protocol stale serve hands off and restarts at the exact new digest", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+sha256.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle } = fakeBundle(version);
    const result = await bootstrapRunnerHost(
      { name: "upgrade-quiescent", endpoint: "me@localhost" },
      {
        execHook: makeExecHook({
          handshakeVersion: `runner-host ${version}`,
          liveServe: "stale-upgradeable",
          trace,
        }),
        ensureBundle,
        readBundle,
      },
    );
    assert.equal(result.node.runnerHostVersion, version);
    const upgradeIndex = trace.findIndex((item) => item.command.includes(" upgrade --socket "));
    const startIndex = trace.findIndex((item) => item.command.startsWith("setsid node"));
    const proofIndex = trace.findIndex((item) => item.command.includes(" probe --socket "));
    assert.ok(upgradeIndex >= 0 && startIndex > upgradeIndex && proofIndex > startIndex);
    assert.ok(trace[upgradeIndex]!.command.endsWith(`--target-version ${version}`));
  });
});

test("bootstrap: stale serve with active work refuses without starting or publishing a new NodeRecord", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+sha256.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle } = fakeBundle(version);
    await assert.rejects(
      bootstrapRunnerHost(
        { name: "upgrade-busy", endpoint: "me@localhost" },
        {
          execHook: makeExecHook({
            handshakeVersion: `runner-host ${version}`,
            liveServe: "stale-active",
            trace,
          }),
          ensureBundle,
          readBundle,
        },
      ),
      /live authority upgrade refused.*active.*busy-bee/s,
    );
    assert.equal(trace.some((item) => item.command.startsWith("setsid node")), false);
    assert.equal(await loadNode("upgrade-busy"), null);
  });
});

test("bootstrap: legacy live serve without quiescent handoff refuses rather than stealing its socket", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+sha256.cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle } = fakeBundle(version);
    await assert.rejects(
      bootstrapRunnerHost(
        { name: "upgrade-legacy", endpoint: "me@localhost" },
        {
          execHook: makeExecHook({ handshakeVersion: `runner-host ${version}`, liveServe: "legacy", trace }),
          ensureBundle,
          readBundle,
        },
      ),
      /live authority upgrade refused.*prepareUpgrade/s,
    );
    assert.equal(trace.some((item) => item.command.startsWith("setsid node")), false);
    assert.equal(await loadNode("upgrade-legacy"), null);
  });
});

test("bootstrap: a version-mismatch handshake fails", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+11112222";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle } = fakeBundle(version);
    await assert.rejects(
      bootstrapRunnerHost(
        { name: "loopunit3", endpoint: "me@localhost" },
        { execHook: makeExecHook({ handshakeVersion: "runner-host 0.0.1+WRONGSHA", trace }), ensureBundle, readBundle },
      ),
      /version handshake mismatch/,
    );
    // The node must NOT be registered on a failed handshake.
    const loaded = await loadNode("loopunit3");
    assert.equal(loaded, null);
  });
});

test("bootstrap: a missing remote node runtime is a clear error", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+33334444";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle } = fakeBundle(version);
    const noNode: SshExecHook = async (argv) => {
      const command = argv[argv.length - 1] ?? "";
      if (command === "node --version") return { stdout: "", stderr: "bash: node: command not found", exitCode: 127 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await assert.rejects(
      bootstrapRunnerHost({ name: "nonode", endpoint: "me@localhost" }, { execHook: noNode, ensureBundle, readBundle }),
      /no usable `node`/,
    );
    void trace;
  });
});

test("remoteHost.ts --version is explicit development or staged content identity and exits 0", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/hsr/remoteHost.ts", "--version"],
    { cwd: process.cwd() },
  );
  assert.match(stdout.trim(), /^runner-host 0\.0\.1\+(?:development|sha256\.[a-f0-9]{64})$/);
});
