import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  handshakeVersion: string; // what `node <bundle> --version` prints
  trace: Recorded[];
}): SshExecHook {
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
      const marker = opts.remoteHasBundle ? "__HIVE_RH_EXISTS__" : "__HIVE_RH_MISSING__";
      return { stdout: `${marker}\n`, stderr: "", exitCode: 0 };
    }
    if (command.startsWith("cat >")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.endsWith("--version") && command.includes(".mjs")) {
      return { stdout: `${opts.handshakeVersion}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unexpected command: ${command}`, exitCode: 1 };
  };
}

const fakeBundle = (version: string) => ({
  ensureBundle: async () => ({ path: `/local/hive-runner-host-${version}.mjs`, version }),
  readBundle: async () => `// fake bundle ${version}\n`,
});

test("bootstrap: registers remote-hsr node and runs node-check → mkdir → copy → handshake in order", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+deadbeef1234";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle } = fakeBundle(version);
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

    // Command sequence: node --version → mkdir → exists-check → copy → handshake.
    const kinds = trace.map((t) => {
      if (t.command === "node --version") return "node-check";
      if (t.command.startsWith("mkdir")) return "mkdir";
      if (t.command.startsWith("[ -f")) return "exists";
      if (t.command.startsWith("cat >")) return "copy";
      if (t.command.endsWith("--version")) return "handshake";
      return "other";
    });
    assert.deepEqual(kinds, ["node-check", "mkdir", "exists", "copy", "handshake"]);
    // The copy carried the bundle bytes on stdin.
    const copy = trace.find((t) => t.command.startsWith("cat >"))!;
    assert.match(copy.input ?? "", /fake bundle/);
  });
});

test("bootstrap: idempotent re-run skips re-copy when the remote already has the version", async () => {
  await withTempStore(async () => {
    const version = "0.0.1+cafebabe5678";
    const trace: Recorded[] = [];
    const { ensureBundle, readBundle } = fakeBundle(version);
    const result = await bootstrapRunnerHost(
      { name: "loopunit2", endpoint: "me@localhost" },
      {
        execHook: makeExecHook({ handshakeVersion: `runner-host ${version}`, remoteHasBundle: true, trace }),
        ensureBundle,
        readBundle,
      },
    );
    assert.equal(result.deployed, false, "should skip copy when the version file exists");
    assert.ok(!trace.some((t) => t.command.startsWith("cat >")), "no copy command should be issued");
    // Still handshakes.
    assert.ok(trace.some((t) => t.command.endsWith("--version") && t.command.includes(".mjs")));
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

test("remoteHost.ts --version prints runner-host <version> and exits 0", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/hsr/remoteHost.ts", "--version"],
    { cwd: process.cwd() },
  );
  assert.match(stdout.trim(), /^runner-host 0\.0\.1\+[0-9a-f]{12}|^runner-host 0\.0\.1\+nogit$/);
});
