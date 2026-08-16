import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  HSR_HOST_POLL_INTERVAL_MS,
  dedicatedHsrEntryCandidate,
  hsrCellPayloadFields,
  hsrEntryArgv,
  inheritableExecArgvForHsr,
  isRunnerHostBundleEntry,
  resolveHsrEntry,
  waitForHsrHost,
  waitForHsrReadiness,
} from "../src/hsr/runnerHost.js";
import type { HsrMeta } from "../src/hsr/runDir.js";
import { ensureRunnerHostBundle } from "../src/hsr/buildRunnerHostBundle.js";
import { localGithubSessionCredentialLeaseId } from "../src/execution/localCredentials.js";
import {
  EXECUTION_CELL_AMBIENT_ENV_KEYS,
  applyCellEnvironmentStamp,
  applyCellGithubCredential,
  assertExecutionCellProxyEnvironment,
  cellSpaceKeyForCwd,
  executionCellProviderEnvironment,
  hsrHarnessEnvironment,
  hsrHostEnvironment,
  hostGithubCredentialResolverEnvironment,
  hostGithubSessionToken,
  sanitizeExecutionCellPayload,
  type HsrRunPayload,
} from "../src/hsr/runner-entry.js";

const execFileAsync = promisify(execFile);

test("cellSpaceKeyForCwd names the space from either Cell layout and stays silent otherwise", () => {
  // Layout v1: the Cell cwd IS the kaia space directory.
  assert.equal(cellSpaceKeyForCwd("/cells/honeybee-space-y2y8meccja7t"), "honeybee-space-y2y8meccja7t");
  // Layout v2: `<wrapper>/<repo>-space-<id>` — the checkout is the space dir.
  assert.equal(
    cellSpaceKeyForCwd("/cells/honeybee-space-ab12cd34ef56/honeybee-space-y2y8meccja7t"),
    "honeybee-space-y2y8meccja7t",
  );
  // A cwd one level inside a space dir still resolves via the parent.
  assert.equal(cellSpaceKeyForCwd("/cells/apiary-space-77/checkout"), "apiary-space-77");
  assert.equal(cellSpaceKeyForCwd("/home/user/ordinary-checkout"), undefined);
  assert.equal(cellSpaceKeyForCwd("/tmp/space-station/repo"), undefined, "bare 'space-' prefix is not a Cell");
});

test("Cell spawns are stamped HIVE_CELL=1 + HIVE_CELL_SPACE; non-Cell spawns are scrubbed", () => {
  const cellEnv: Record<string, string> = { PATH: "/usr/bin" };
  applyCellEnvironmentStamp(cellEnv, {
    filesystemWriteScope: "cwd",
    cwd: "/cells/honeybee-space-y2y8meccja7t",
  });
  assert.equal(cellEnv.HIVE_CELL, "1");
  assert.equal(cellEnv.HIVE_CELL_SPACE, "honeybee-space-y2y8meccja7t");

  // Unknown space: the containment marker still lands, the space stamp does
  // not — and a stale inherited value never leaks through.
  const anonymous: Record<string, string> = { HIVE_CELL_SPACE: "stale-space-1" };
  applyCellEnvironmentStamp(anonymous, { filesystemWriteScope: "cwd", cwd: "/somewhere/plain" });
  assert.equal(anonymous.HIVE_CELL, "1");
  assert.equal("HIVE_CELL_SPACE" in anonymous, false);

  // Non-Cell spawn: ambient stamps from a Cell-hosted parent must be removed.
  const plain: Record<string, string> = { HIVE_CELL: "1", HIVE_CELL_SPACE: "honeybee-space-y2y8meccja7t" };
  applyCellEnvironmentStamp(plain, { cwd: "/home/user/repo" });
  assert.equal("HIVE_CELL" in plain, false);
  assert.equal("HIVE_CELL_SPACE" in plain, false);
});

test("execution Cell relaunch fields preserve the exact Run and credential lease", () => {
  const runId = "run-relaunch-gh-1";
  const credentialLeaseId = localGithubSessionCredentialLeaseId(runId);
  assert.deepEqual(hsrCellPayloadFields({
    executionRunId: runId,
    executionRuntimeCredentialLeaseIds: [credentialLeaseId],
    sandboxWriteRoots: ["/cell-wrapper"],
  }), {
    filesystemWriteScope: "cwd",
    executionRunId: runId,
    runtimeCredentialLeaseIds: [credentialLeaseId],
    extraWriteRoots: ["/cell-wrapper"],
  });
  assert.deepEqual(hsrCellPayloadFields({}), {});
});

test("Cell gh injection requires the exact signed Run-bound runtime credential lease", async () => {
  const runId = "run-cell-gh-1";
  const cell = (): Parameters<typeof applyCellGithubCredential>[1] => ({
    filesystemWriteScope: "cwd",
    executionRunId: runId,
    runtimeCredentialLeaseIds: [localGithubSessionCredentialLeaseId(runId)],
  });

  const stamped: Record<string, string> = {};
  let authorizedResolverCalls = 0;
  await applyCellGithubCredential(stamped, cell(), async () => {
    authorizedResolverCalls += 1;
    return "gho_host_session_token\n";
  });
  assert.equal(stamped.GH_TOKEN, "gho_host_session_token");
  assert.equal(authorizedResolverCalls, 1, "the exact signed lease resolves host gh once");

  // Non-Cell spawns are never stamped — ordinary HSR remains unchanged.
  const plain: Record<string, string> = {};
  await applyCellGithubCredential(plain, {}, async () => "gho_host_session_token");
  assert.equal("GH_TOKEN" in plain, false);

  let unauthorizedResolverCalls = 0;
  for (const denied of [
    { filesystemWriteScope: "cwd" as const, executionRunId: runId },
    {
      filesystemWriteScope: "cwd" as const,
      executionRunId: runId,
      runtimeCredentialLeaseIds: [localGithubSessionCredentialLeaseId("run-other")],
    },
  ]) {
    const env: Record<string, string> = {};
    await applyCellGithubCredential(env, denied, async () => {
      unauthorizedResolverCalls += 1;
      return "gho_must_not_cross";
    });
    assert.equal("GH_TOKEN" in env, false);
  }
  assert.equal(unauthorizedResolverCalls, 0, "an absent/mismatched lease never touches the host gh session");

  // Not-a-token shapes (gh error prose, empties) and resolver failures are
  // soft: the Cell simply stays unauthenticated.
  const prose: Record<string, string> = {};
  await applyCellGithubCredential(prose, cell(), async () => "no oauth token found\n");
  assert.equal("GH_TOKEN" in prose, false);
  const empty: Record<string, string> = {};
  await applyCellGithubCredential(empty, cell(), async () => "  \n");
  assert.equal("GH_TOKEN" in empty, false);
  const failing: Record<string, string> = {};
  await applyCellGithubCredential(failing, cell(), async () => { throw new Error("gh missing"); });
  assert.equal("GH_TOKEN" in failing, false);
});

test("the real gh resolver keeps host discovery roots while the harness receives none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-gh-resolver-"));
  const executable = join(dir, "gh");
  await writeFile(executable, `#!/bin/sh\n[ "$HOME" = "/host/home" ] || exit 41\n[ "$GH_CONFIG_DIR" = "/host/gh" ] || exit 42\n[ "$XDG_CONFIG_HOME" = "/host/xdg" ] || exit 43\nprintf 'gho_from_host_config\\n'\n`);
  await chmod(executable, 0o700);
  try {
    const inherited = {
      PATH: dir,
      HOME: "/host/home",
      GH_CONFIG_DIR: "/host/gh",
      XDG_CONFIG_HOME: "/host/xdg",
      GH_TOKEN: "ambient-must-not-enter-resolver",
      AWS_SECRET_ACCESS_KEY: "ambient-must-not-enter-resolver",
    };
    assert.deepEqual(hostGithubCredentialResolverEnvironment(inherited), {
      PATH: dir,
      HOME: "/host/home",
      GH_CONFIG_DIR: "/host/gh",
      XDG_CONFIG_HOME: "/host/xdg",
    });
    assert.equal((await hostGithubSessionToken(inherited)).trim(), "gho_from_host_config");

    const harness = hsrHarnessEnvironment(envPayload(), {
      ...inherited,
      HIVE_STORE_ROOT: "/canonical/hive",
    });
    for (const key of ["HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
      assert.equal(key in harness, false, `${key} is resolver-only`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function envPayload(overrides: Partial<HsrRunPayload> = {}): HsrRunPayload {
  return {
    bee: "env-cell",
    kind: "claude",
    cwd: "/cell",
    filesystemWriteScope: "cwd",
    executionRunId: "run-env-1",
    cellBrokerCapability: "a".repeat(43),
    spec: { command: "claude", args: [], env: {} },
    ...overrides,
  };
}

test("execution Cell host environment is an exact allowlist; ordinary HSR remains byte-compatible", () => {
  const inherited = {
    PATH: "/reviewed/bin",
    HOME: "/host/home",
    GH_CONFIG_DIR: "/host/gh",
    XDG_CONFIG_HOME: "/host/xdg",
    LANG: "en_US.UTF-8",
    HTTPS_PROXY: "http://node-proxy.example:8080",
    HIVE_STORE_ROOT: "/canonical/hive",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GH_TOKEN: "ambient-gh",
    GITHUB_TOKEN: "ambient-github",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    NODE_OPTIONS: "--require=/tmp/ambient-hook.cjs",
    CLAUDE_CONFIG_DIR: "/ambient/claude",
    RANDOM_GATEWAY_SECRET: "gateway-secret",
  };
  const host = hsrHostEnvironment(envPayload(), inherited);
  assert.deepEqual(host, {
    PATH: "/reviewed/bin",
    HOME: "/host/home",
    GH_CONFIG_DIR: "/host/gh",
    XDG_CONFIG_HOME: "/host/xdg",
    LANG: "en_US.UTF-8",
    HTTPS_PROXY: "http://node-proxy.example:8080",
    HIVE_STORE_ROOT: "/canonical/hive",
  });
  assert.ok(EXECUTION_CELL_AMBIENT_ENV_KEYS.includes("HTTPS_PROXY"));
  for (const forbidden of [
    "AWS_SECRET_ACCESS_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "NODE_OPTIONS",
    "CLAUDE_CONFIG_DIR",
    "RANDOM_GATEWAY_SECRET",
  ]) assert.equal(forbidden in host, false, forbidden);

  const ordinary = envPayload({ filesystemWriteScope: undefined });
  assert.deepEqual(hsrHostEnvironment(ordinary, inherited), inherited);
});

test("execution Cells refuse credential-bearing proxy URLs while preserving public node routing", () => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    const inherited = { PATH: "/usr/bin", [key]: "http://proxy-user:proxy-secret@node-proxy.example:8080" };
    assert.throws(
      () => assertExecutionCellProxyEnvironment(inherited),
      new RegExp(`credential-bearing ${key}`),
    );
    assert.throws(
      () => hsrHostEnvironment(envPayload(), inherited),
      new RegExp(`credential-bearing ${key}`),
    );
    const ordinary = envPayload({ filesystemWriteScope: undefined });
    assert.deepEqual(
      hsrHostEnvironment(ordinary, inherited),
      inherited,
      "ordinary HSR environment inheritance remains byte-compatible",
    );
    assert.throws(
      () => assertExecutionCellProxyEnvironment({ PATH: "/usr/bin", [key]: "proxy-user:proxy-secret@node-proxy.example:8080" }),
      new RegExp(`credential-bearing ${key}`),
      "scheme-less proxy userinfo must not parse as a credential-free custom URL scheme",
    );
  }

  const publicProxy = { PATH: "/usr/bin", HTTPS_PROXY: "http://node-proxy.example:8080", NO_PROXY: "localhost" };
  assert.doesNotThrow(() => assertExecutionCellProxyEnvironment(publicProxy));
  assert.deepEqual(hsrHarnessEnvironment(envPayload(), publicProxy), publicProxy);
});

test("execution Cell payload accepts only the signed account's exact provider identity env", () => {
  const specEnv = {
    CLAUDE_CONFIG_DIR: "/accounts/claude-1",
    CODEX_HOME: "/accounts/codex-ambient",
    ANTHROPIC_API_KEY: "gateway-api-key",
    RANDOM_GATEWAY_SECRET: "gateway-secret",
  };
  const accountCell = envPayload({ accountId: "acct-claude-1", spec: { command: "claude", args: [], env: specEnv } });
  assert.deepEqual(executionCellProviderEnvironment(accountCell), {
    CLAUDE_CONFIG_DIR: "/accounts/claude-1",
  });
  const sanitized = sanitizeExecutionCellPayload(accountCell);
  assert.deepEqual(sanitized.spec.env, { CLAUDE_CONFIG_DIR: "/accounts/claude-1" });
  assert.equal(JSON.stringify(sanitized).includes("gateway-api-key"), false);
  assert.equal(JSON.stringify(sanitized).includes("gateway-secret"), false);

  const accountless = envPayload({ spec: { command: "claude", args: [], env: specEnv } });
  assert.deepEqual(executionCellProviderEnvironment(accountless), {});
  assert.deepEqual(sanitizeExecutionCellPayload(accountless).spec.env, {});

  const ordinary = envPayload({ filesystemWriteScope: undefined, spec: { command: "claude", args: [], env: specEnv } });
  assert.equal(sanitizeExecutionCellPayload(ordinary), ordinary, "ordinary HSR payload is not rewritten");
});

test("execution harness sees the broker socket but not the canonical store or ambient credentials", () => {
  const cell = envPayload({
    accountId: "acct-claude-1",
    spec: {
      command: "claude",
      args: [],
      env: { CLAUDE_CONFIG_DIR: "/accounts/claude-1", GH_TOKEN: "unleased-explicit-gh" },
    },
  });
  const env = hsrHarnessEnvironment(cell, {
    PATH: "/reviewed/bin",
    HIVE_STORE_ROOT: "/canonical/hive",
    AWS_ACCESS_KEY_ID: "ambient-aws",
  });
  assert.deepEqual(env, {
    PATH: "/reviewed/bin",
    CLAUDE_CONFIG_DIR: "/accounts/claude-1",
    HIVE_CELL_BROKER_SOCKET: "/canonical/hive/daemon/hsr-control.sock",
    HIVE_CELL_BROKER_TOKEN: "a".repeat(43),
  });
  assert.equal("HIVE_STORE_ROOT" in env, false);
  assert.equal("GH_TOKEN" in env, false, "GH_TOKEN exists only after the signed lease resolver runs");
});

test("ordinary HSR never inherits a Cell broker capability from its parent", () => {
  const ordinary = envPayload({
    filesystemWriteScope: undefined,
    executionRunId: undefined,
    cellBrokerCapability: undefined,
  });
  const env = hsrHarnessEnvironment(ordinary, {
    PATH: "/bin",
    HIVE_CELL_BROKER_SOCKET: "/forged/broker.sock",
    HIVE_CELL_BROKER_TOKEN: "z".repeat(43),
  });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("resolveHsrEntry derives source and built entries from the runnerHost module", async () => {
  const sourcePaths = new Map([
    ["/linked/runnerHost", "/pkg/src/hsr/runnerHost.ts"],
    ["/pkg/src/hsr/runner-entry.ts", "/pkg/src/hsr/runner-entry.ts"],
  ]);
  const source = await resolveHsrEntry("/linked/runnerHost", async (path) => {
    const resolved = sourcePaths.get(path);
    if (!resolved) throw new Error("ENOENT");
    return resolved;
  });
  assert.deepEqual(source, { path: "/pkg/src/hsr/runner-entry.ts", mode: "dedicated" });
  assert.deepEqual(hsrEntryArgv(source, "/tmp/payload.json"), [
    "/pkg/src/hsr/runner-entry.ts",
    "/tmp/payload.json",
  ]);

  const built = await resolveHsrEntry("/pkg/dist/hsr/runnerHost.js", async (path) => path);
  assert.deepEqual(built, { path: "/pkg/dist/hsr/runner-entry.js", mode: "dedicated" });
});

test("resolveHsrEntry fails closed instead of relaunching an embedding test file", async () => {
  await assert.rejects(
    () => resolveHsrEntry("/pkg/tests/hsr-child-admission.test.ts", async (path) => {
      if (path.endsWith("hsr-child-admission.test.ts")) return path;
      throw new Error("ENOENT");
    }),
    /dedicated runner entry unavailable.*tests\/runner-entry\.ts/,
  );
  await assert.rejects(() => resolveHsrEntry(""), /runnerHost module entry path/);
});

test("resolveHsrEntry re-execs a self-contained bundle when the dedicated sibling is absent", async () => {
  const bundle = "/opt/hive/hive-runner-host-0.0.1+abc123def456.mjs";

  // Cloud Cell: the bundle IS the whole runner-host; no runner-entry.mjs sibling
  // exists on disk, so entry resolution falls back to re-execing the bundle
  // itself with the `__hsr-run` marker (cli-fallback mode against the bundle).
  const inCell = await resolveHsrEntry(bundle, async (path) => {
    if (path === bundle) return bundle;
    throw new Error("ENOENT");
  });
  assert.deepEqual(inCell, { path: bundle, mode: "cli-fallback" });
  assert.deepEqual(hsrEntryArgv(inCell, "/tmp/hive-hsr-payload-x/payload.json"), [
    bundle,
    "__hsr-run",
    "/tmp/hive-hsr-payload-x/payload.json",
  ]);

  // When the dedicated sibling IS present, it still wins over the self re-exec.
  const withSibling = await resolveHsrEntry(bundle, async (path) => path);
  assert.deepEqual(withSibling, { path: "/opt/hive/runner-entry.mjs", mode: "dedicated" });

  // A non-bundle module with no sibling still fails closed — never self re-execs.
  await assert.rejects(
    () => resolveHsrEntry("/pkg/dist/hsr/runnerHost.js", async (path) => {
      if (path.endsWith("runnerHost.js")) return path;
      throw new Error("ENOENT");
    }),
    /dedicated runner entry unavailable.*runner-entry\.js/,
  );

  // The bundle-self predicate only matches the emitted `hive-runner-host-*.mjs`.
  assert.equal(isRunnerHostBundleEntry("/opt/hive/hive-runner-host-0.0.1+abc.mjs"), true);
  assert.equal(isRunnerHostBundleEntry("/opt/hive/runner-entry.mjs"), false);
  assert.equal(isRunnerHostBundleEntry("/opt/hive/hive-runner-host-0.0.1+abc.js"), false);
});

test("hsrEntryArgv retains an explicit __hsr-run compatibility entry", () => {
  const fallback = { path: "/pkg/dist/cli.js", mode: "cli-fallback" } as const;
  assert.deepEqual(fallback, { path: "/pkg/dist/cli.js", mode: "cli-fallback" });
  assert.deepEqual(hsrEntryArgv(fallback, "/tmp/payload.json"), [
    "/pkg/dist/cli.js",
    "__hsr-run",
    "/tmp/payload.json",
  ]);
  assert.equal(dedicatedHsrEntryCandidate("/usr/local/bin/hive"), undefined);
});

test("inheritableExecArgvForHsr preserves only source loaders, never embedding execution modes", () => {
  const original = process.execArgv;
  try {
    process.execArgv = [
      "--input-type=module",
      "-e",
      "spawnHsrHost()",
      "--require",
      "/pkg/preflight.cjs",
      "--import",
      "tsx",
      "--test",
      "--test-reporter",
      "spec",
      "--test-concurrency=1",
      "--watch",
      "--watch-path",
      "src",
      "--inspect=0",
      "--loader=file:///pkg/loader.mjs",
      "-r/pkg/register.cjs",
    ];
    assert.deepEqual(inheritableExecArgvForHsr(), [
      "--require",
      "/pkg/preflight.cjs",
      "--import",
      "tsx",
      "--loader=file:///pkg/loader.mjs",
      "-r/pkg/register.cjs",
    ]);
  } finally {
    process.execArgv = original;
  }
});

test("waitForHsrHost observes newly published meta on the 10ms cadence", async () => {
  let now = 0;
  let probes = 0;
  const delays: number[] = [];
  const ready = await waitForHsrHost("bee", 100, {
    now: () => now,
    hasSession: async () => ++probes === 2,
    sleep: async (ms) => {
      delays.push(ms);
      now += ms;
    },
  });

  assert.equal(ready, true);
  assert.equal(HSR_HOST_POLL_INTERVAL_MS, 10);
  assert.equal(now, 10);
  assert.deepEqual(delays, [10]);
});

test("waitForHsrHost caps its final sleep at the unchanged timeout deadline", async () => {
  let now = 0;
  let probes = 0;
  const delays: number[] = [];
  const ready = await waitForHsrHost("bee", 25, {
    now: () => now,
    hasSession: async () => {
      probes += 1;
      return false;
    },
    sleep: async (ms) => {
      delays.push(ms);
      now += ms;
    },
  });

  assert.equal(ready, false);
  assert.equal(now, 25);
  assert.equal(probes, 3);
  assert.deepEqual(delays, [10, 10, 5]);
});

test("waitForHsrReadiness does not confuse a birth-admitted queued host with a controllable runtime", async () => {
  let now = 0;
  let reads = 0;
  const base: HsrMeta = {
    bee: "bee",
    harness: "codex",
    tier: "server",
    hostPid: 42,
    hostFingerprint: { pgid: 42, startedAt: "Fri Aug 15 00:00:00 2026" },
    childAdmission: "admitted",
    childPid: 43,
    childPgid: 43,
    childFingerprint: { pgid: 43, startedAt: "Fri Aug 15 00:00:01 2026" },
    startedAt: "2026-08-15T00:00:00.000Z",
    controlSocket: "/tmp/bee.sock",
    status: "queued",
  };
  const ready = await waitForHsrReadiness("bee", 100, {
    now: () => now,
    readMeta: async () => {
      reads += 1;
      return reads < 3
        ? base
        : { ...base, status: "running", runningAt: "2026-08-15T00:00:02.000Z" };
    },
    sleep: async (ms) => { now += ms; },
  });

  assert.equal(ready, true);
  assert.equal(reads, 3);
  assert.equal(now, 20);
});

test("the dedicated source entry and __hsr-run fallback both remain executable under tsx", async () => {
  for (const argv of [
    ["src/hsr/runner-entry.ts"],
    ["src/cli.ts", "__hsr-run"],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", ...argv], { cwd: process.cwd() }),
      (error: Error & { code?: number | string; stderr?: string }) => {
        assert.equal(error.code, 1, argv.join(" "));
        assert.match(error.stderr ?? "", /hive __hsr-run: missing payload path/);
        return true;
      },
    );
  }
});

test("the built runner-host bundle prints only its version — no runner-entry guard collision", async () => {
  // Regression for the two-entrypoint bundle: remoteHost.ts and runner-entry.ts
  // share import.meta.url in the bundle, so both standalone guards used to fire.
  // `--version` must now emit ONLY the version, never runner-entry's handoff
  // error from a spuriously-fired second guard.
  const { path: bundlePath, version } = await ensureRunnerHostBundle({ force: true });
  const { stdout, stderr } = await execFileAsync(process.execPath, [bundlePath, "--version"]);
  assert.equal(stdout.trim(), `runner-host ${version}`);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout + stderr, /invalid HSR payload handoff path/);
});

test("the built runner-host bundle routes __hsr-run into the bee host, not 'unknown command'", async () => {
  // In-cell self-spawn: `node <bundle> __hsr-run <payload>` must reach
  // runHsrHostFromPayload (remoteHost.main owns the marker). Proven by a payload
  // CONTENT error — invalid JSON in an otherwise-valid handoff dir — rather than
  // the "unknown command" dispatch miss or the handoff-path validation error.
  const { path: bundlePath } = await ensureRunnerHostBundle({ force: true });
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-payload-"));
  const payloadPath = join(dir, "payload.json");
  try {
    await writeFile(payloadPath, "this is not valid json\n", { mode: 0o600 });
    await assert.rejects(
      execFileAsync(process.execPath, [bundlePath, "__hsr-run", payloadPath]),
      (error: Error & { code?: number | string; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /hive __hsr-run: invalid payload JSON/);
        assert.doesNotMatch(error.stderr ?? "", /unknown command/);
        assert.doesNotMatch(error.stderr ?? "", /invalid HSR payload handoff path/);
        return true;
      },
    );
  } finally {
    // consumeHsrRunPayload removes the handoff on success; force covers that.
    await rm(dir, { recursive: true, force: true });
  }
});
