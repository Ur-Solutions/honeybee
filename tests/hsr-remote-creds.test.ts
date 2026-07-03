/**
 * Per-node ephemeral credential delivery for remote HSR (APIA-93).
 *
 * SECURITY-SENSITIVE. Exercised with FAKE credentials only — no real
 * `claude setup-token` is minted (the exec is injected) and no real auth.json is
 * shipped. Real token minting + real ssh delivery are covered at APIA-98.
 *
 * Covers:
 *  - mintEphemeralCredential: codex ships the vaulted auth.json; claude mints a
 *    token via the (injected) setup-token exec, and falls back to shipping
 *    .credentials.json when the exec is unavailable. Secrets never leak into the
 *    (secret-free) kindNote.
 *  - end-to-end delivery over a locally-run remote serve (the APIA-92 harness):
 *    spawnRemote with `creds` writes the fake credential into the remote isolated
 *    home at 0600; `kill` shreds it (the file is GONE). A write failure surfaces
 *    a generic, secret-free error.
 *  - authPolicy gating in `hive spawn`: a local-only remote-hsr account spawn
 *    throws; an ephemeral-token node gets PAST the gate (into minting).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "../src/hsr/remoteHost.js";
import { createRemoteHsrSubstrate } from "../src/substrates/remote-hsr.js";
import { clearSubstrateCache } from "../src/substrates/index.js";
import { mintEphemeralCredential } from "../src/hsr/remoteCreds.js";
import { accountDir, type AccountRecord } from "../src/accounts.js";
import type { NodeRecord } from "../src/node.js";
import type { TunnelChild, TunnelSpawnHook, SshExecHook } from "../src/hsr/remoteTransport.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-rc-");
  process.env.HIVE_STORE_ROOT = dir;
  clearSubstrateCache();
  try {
    await fn(dir);
  } finally {
    clearSubstrateCache();
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function fakeAccount(overrides: Partial<AccountRecord> & Pick<AccountRecord, "id" | "tool" | "label">): AccountRecord {
  return { provider: "openai", addedAt: "2026-07-03T00:00:00.000Z", ...overrides };
}

async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

// ── mint side (local) ──────────────────────────────────────────────────────

test("mintEphemeralCredential: codex ships the vaulted auth.json (0600), never leaking the secret", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "codex-fake", tool: "codex", label: "fake", provider: "openai" });
    const SECRET = "SECRET-codex-auth-DO-NOT-LOG-abc123";
    const raw = JSON.stringify({ tokens: { access_token: SECRET } });
    await mkdir(accountDir(account), { recursive: true, mode: 0o700 });
    await writeFile(join(accountDir(account), "auth.json"), raw, { mode: 0o600 });

    const cred = await mintEphemeralCredential(account, "codex");
    assert.equal(cred.files.length, 1);
    assert.equal(cred.files[0]!.homeRelPath, "auth.json");
    assert.equal(cred.files[0]!.mode, 0o600);
    assert.equal(cred.env, undefined);
    assert.equal(Buffer.from(cred.files[0]!.contentB64, "base64").toString("utf8"), raw);
    // Guardrail: the human note carries no secret bytes.
    assert.ok(!cred.kindNote.includes(SECRET), "kindNote must not leak the credential");
  });
});

test("mintEphemeralCredential: claude mints a setup-token (injected) delivered as env, no file, no leak", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "claude-fake", tool: "claude", label: "fake", provider: "anthropic" });
    const TOKEN = "sk-ant-oat01-FAKE-setup-token-never-real-xyz";
    let mintedFor: string | undefined;
    const cred = await mintEphemeralCredential(account, "claude", {
      runClaudeSetupToken: async (home) => {
        mintedFor = home;
        return TOKEN;
      },
    });
    assert.deepEqual(cred.files, []);
    assert.equal(cred.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.ok(mintedFor && mintedFor.includes("claude-fake"), "minted against the account's local home");
    assert.ok(!cred.kindNote.includes(TOKEN), "kindNote must not leak the token");
  });
});

test("mintEphemeralCredential: claude falls back to shipping .credentials.json when setup-token is unavailable", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "claude-fb", tool: "claude", label: "fb", provider: "anthropic" });
    const SECRET = "SECRET-claude-credentials-fallback-000";
    await mkdir(accountDir(account), { recursive: true, mode: 0o700 });
    await writeFile(join(accountDir(account), ".credentials.json"), SECRET, { mode: 0o600 });

    const cred = await mintEphemeralCredential(account, "claude", { runClaudeSetupToken: async () => null });
    assert.equal(cred.files.length, 1);
    assert.equal(cred.files[0]!.homeRelPath, ".credentials.json");
    assert.match(cred.kindNote, /weaker guarantee/);
    assert.ok(!cred.kindNote.includes(SECRET));
  });
});

test("mintEphemeralCredential: unsupported harness is refused", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "grok-x", tool: "grok", label: "x", provider: "xai" });
    await assert.rejects(() => mintEphemeralCredential(account, "grok"), /not wired for harness "grok"/);
  });
});

// ── delivery / shred over a locally-run remote serve (APIA-92 harness) ──────

function makeNode(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "loopcred",
    kind: "remote-hsr",
    endpoint: "me@remote-host",
    capabilities: ["*"],
    runnerHostVersion: "0.0.1+deadbeef1234",
    status: "unknown",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

function parseForward(argv: string[]): { local: string; remote: string } {
  const i = argv.indexOf("-L");
  assert.ok(i >= 0 && argv[i + 1], "forward argv must contain -L <local>:<remote>");
  const spec = argv[i + 1]!;
  const cut = spec.indexOf(":");
  return { local: spec.slice(0, cut), remote: spec.slice(cut + 1) };
}

function makeRelayTunnel(): { hook: TunnelSpawnHook; killAll: () => void } {
  const servers: Server[] = [];
  const hook: TunnelSpawnHook = (argv) => {
    const { local, remote } = parseForward(argv);
    const conns = new Set<Socket>();
    const relay: Server = createServer((down) => {
      conns.add(down);
      const up = createConnection(remote);
      conns.add(up);
      down.pipe(up);
      up.pipe(down);
      const bail = (): void => {
        down.destroy();
        up.destroy();
      };
      down.on("error", bail);
      up.on("error", bail);
      down.on("close", () => up.destroy());
      up.on("close", () => down.destroy());
    });
    servers.push(relay);
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    relay.listen(local);
    const child: TunnelChild = {
      argv,
      kill: () => {
        for (const c of conns) c.destroy();
        relay.close(() => resolveExit());
        resolveExit();
      },
      exited,
    };
    return child;
  };
  return { hook, killAll: () => servers.forEach((s) => s.close()) };
}

const serveUpExecHook: SshExecHook = async () => ({ stdout: "", stderr: "", exitCode: 0 });

test("remote HSR delivery: spawnRemote writes the fake credential into the isolated home (0600) and kill shreds it", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const tunnel = makeRelayTunnel();
    const sub = createRemoteHsrSubstrate(makeNode(), {
      transport: {
        execHook: serveUpExecHook,
        spawnTunnel: tunnel.hook,
        remoteSocket: remoteSock,
        forward: { waitAttempts: 100, waitIntervalMs: 10 },
      },
    });

    const SECRET = "SECRET-delivered-auth-bytes-9f8e7d";
    const home = join(dir, "iso-home");
    const credPath = join(home, "auth.json");

    try {
      const bee = "credbee";
      const res = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        home,
        creds: { files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(SECRET).toString("base64"), mode: 0o600 }] },
        spec: { command: process.execPath, args: [], env: {} },
      });
      assert.equal(res.bee, bee);

      // The credential landed in the freshly-created isolated home at 0600.
      await waitFor(() => fileExists(credPath), "credential file written into remote home");
      const info = await stat(credPath);
      assert.equal(info.mode & 0o777, 0o600, "credential file is mode 0600");
      assert.equal(await readFile(credPath, "utf8"), SECRET);

      // kill shreds the delivered credential — nothing persists remotely.
      const kr = await sub.kill(bee);
      assert.equal(kr.ok, true);
      await waitFor(async () => !(await fileExists(credPath)), "credential file GONE after kill");
    } finally {
      await sub.close();
      await server.close();
      tunnel.killAll();
    }
  });
});

test("remote HSR delivery: a write failure surfaces a generic, secret-free error", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const tunnel = makeRelayTunnel();
    const sub = createRemoteHsrSubstrate(makeNode(), {
      transport: {
        execHook: serveUpExecHook,
        spawnTunnel: tunnel.hook,
        remoteSocket: remoteSock,
        forward: { waitAttempts: 100, waitIntervalMs: 10 },
      },
    });

    const SECRET = "SECRET-must-not-appear-in-error-4b3c2a";
    // Home path is an existing FILE, so creating the isolated dir fails.
    const homeAsFile = join(dir, "home-is-a-file");
    await writeFile(homeAsFile, "x");

    try {
      await assert.rejects(
        () =>
          sub.spawnRemote({
            bee: "failbee",
            kind: "stub",
            cwd: process.cwd(),
            home: homeAsFile,
            creds: { files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(SECRET).toString("base64"), mode: 0o600 }] },
            spec: { command: process.execPath, args: [], env: {} },
          }),
        (error: Error) => {
          assert.ok(!error.message.includes(SECRET), "error must not leak the credential bytes");
          assert.match(error.message, /failed to write delivered credentials/);
          return true;
        },
      );
    } finally {
      await sub.close();
      await server.close();
      tunnel.killAll();
    }
  });
});

// ── authPolicy gating in `hive spawn` (subprocess, no network) ──────────────

const CLI_ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: CLI_ENV(dir) });
}

async function hiveExpectFail(dir: string, ...args: string[]): Promise<string> {
  try {
    await hive(dir, ...args);
    throw new Error("expected command to fail");
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    return err.stderr ?? "";
  }
}

test("hive spawn --account gating: local-only remote-hsr throws; ephemeral-token gets past the gate into minting", async () => {
  const dir = await mkdtemp("/tmp/hb-rc-cli-");
  try {
    // A codex account in the registry (no vaulted credential — so the ephemeral
    // path reaches minting and fails THERE, proving the gate let it through).
    await mkdir(join(dir, "vault"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, "vault", "accounts.json"),
      JSON.stringify([{ id: "codex-fake", tool: "codex", label: "fake", provider: "openai", addedAt: "2026-07-03T00:00:00.000Z" }], null, 2),
      { mode: 0o600 },
    );

    await hive(dir, "node", "register", "lonode", "--kind", "remote-hsr", "--endpoint", "me@x");
    await hive(dir, "node", "register", "epnode", "--kind", "remote-hsr", "--endpoint", "me@x", "--auth-policy", "ephemeral-token");

    // inspect surfaces the policy: default local-only vs the set ephemeral-token.
    const loInspect = await hive(dir, "node", "inspect", "lonode");
    assert.equal(JSON.parse(loInspect.stdout).authPolicy, undefined, "local-only stays lean (no field)");
    assert.match(loInspect.stderr, /auth-policy: local-only/);
    const epInspect = await hive(dir, "node", "inspect", "epnode");
    assert.equal(JSON.parse(epInspect.stdout).authPolicy, "ephemeral-token");
    assert.match(epInspect.stderr, /auth-policy: ephemeral-token/);

    // local-only: the gate refuses the account-bound remote spawn.
    const loFail = await hiveExpectFail(dir, "spawn", "codex-fake", "--node", "lonode");
    assert.match(loFail, /auth-policy local-only/);
    assert.match(loFail, /--auth-policy ephemeral-token/);

    // ephemeral-token: PAST the gate — fails at minting (no vaulted credential),
    // NOT at the policy gate. That difference is the proof the gate allowed it.
    const epFail = await hiveExpectFail(dir, "spawn", "codex-fake", "--node", "epnode");
    assert.doesNotMatch(epFail, /auth-policy local-only/);
    assert.match(epFail, /could not mint an ephemeral credential|no primary credential/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
