/**
 * Remote-HSR spawn path derivation (remote runner-host OWNS its filesystem).
 *
 * A remote bee's cwd and isolated home must be REMOTE paths derived ON the
 * remote — never local paths shipped from the client. Shipping a local
 * `/Users/…` cwd made Node's `spawn()` throw ENOENT on the node (the cwd does
 * not exist there); shipping a local isolated-home path pointed the harness at
 * the wrong home for delivered credentials. These tests pin the fix:
 *
 *  - resolveRemoteSpawnCwd / resolveRemoteSpawnHome (pure): a plain spawn needs
 *    NO client cwd/home — both are derived under this node's own storeRoot; a
 *    provisioned checkout cwd (a real remote path) is honored as-is; the harness
 *    home env (CODEX_HOME / CLAUDE_CONFIG_DIR) maps by kind.
 *  - end-to-end over a locally-run remote serve (the APIA-92 harness): a spawn
 *    with NO cwd/home derives `<storeRoot>/hsr/<bee>/{cwd,home}` (0700), delivers
 *    credentials into the DERIVED home (0600), and echoes the resolved cwd back;
 *    a provisioned checkout cwd is run as-is and the derived cwd dir is NOT made.
 *
 * Exercised with FAKE credentials and the stub harness only — no real binary,
 * no network.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { serve, resolveRemoteSpawnCwd, resolveRemoteSpawnHome } from "../src/hsr/remoteHost.js";
import { hsrRunDir } from "../src/hsr/runDir.js";
import { createRemoteHsrSubstrate } from "../src/substrates/remote-hsr.js";
import { clearSubstrateCache } from "../src/substrates/index.js";
import type { NodeRecord } from "../src/node.js";
import type { TunnelChild, TunnelSpawnHook, SshExecHook } from "../src/hsr/remoteTransport.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-rsp-");
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

async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

// ── pure derivation ─────────────────────────────────────────────────────────

test("resolveRemoteSpawnCwd: derives a per-bee cwd under storeRoot when the client sends none", async () => {
  await withTempStore(async () => {
    // No cwd (the plain remote-hsr spawn): DERIVE under this node's own store.
    const derived = resolveRemoteSpawnCwd("beeA", undefined);
    assert.equal(derived.derived, true);
    assert.equal(derived.cwd, join(hsrRunDir("beeA"), "cwd"));
    // Empty string is treated as "none" too.
    assert.deepEqual(resolveRemoteSpawnCwd("beeA", ""), { cwd: join(hsrRunDir("beeA"), "cwd"), derived: true });

    // A provisioned checkout (a real REMOTE path) is honored verbatim, not derived.
    const checkout = "/remote/store/worktrees/feature-x";
    assert.deepEqual(resolveRemoteSpawnCwd("beeA", checkout), { cwd: checkout, derived: false });
  });
});

test("resolveRemoteSpawnHome: derives the home under storeRoot and maps the harness home env by kind", async () => {
  await withTempStore(async () => {
    // No home shipped: DERIVE under the store; env maps by kind.
    const codex = resolveRemoteSpawnHome("beeB", "codex", undefined);
    assert.equal(codex.homeDir, join(hsrRunDir("beeB"), "home"));
    assert.equal(codex.homeEnv, "CODEX_HOME");

    const claude = resolveRemoteSpawnHome("beeB", "claude", undefined);
    assert.equal(claude.homeDir, join(hsrRunDir("beeB"), "home"));
    assert.equal(claude.homeEnv, "CLAUDE_CONFIG_DIR");

    // A harness with no home env (the test stub) still derives a home dir but has
    // no env to point at it — the handler simply skips the env when it is absent.
    const stub = resolveRemoteSpawnHome("beeB", "stub", undefined);
    assert.equal(stub.homeDir, join(hsrRunDir("beeB"), "home"));
    assert.equal(stub.homeEnv, undefined);

    // An explicit REMOTE home is honored as-is (tests inject one).
    const explicit = resolveRemoteSpawnHome("beeB", "codex", "/remote/store/hsr/beeB/home");
    assert.equal(explicit.homeDir, "/remote/store/hsr/beeB/home");
    assert.equal(explicit.homeEnv, "CODEX_HOME");
  });
});

// ── end-to-end over a locally-run remote serve (APIA-92 harness) ────────────

function makeNode(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "looppaths",
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

function connectSubstrate(dir: string, remoteSock: string): { sub: ReturnType<typeof createRemoteHsrSubstrate>; killAll: () => void } {
  const tunnel = makeRelayTunnel();
  const sub = createRemoteHsrSubstrate(makeNode(), {
    transport: {
      execHook: serveUpExecHook,
      spawnTunnel: tunnel.hook,
      remoteSocket: remoteSock,
      forward: { waitAttempts: 100, waitIntervalMs: 10 },
    },
  });
  return { sub, killAll: tunnel.killAll };
}

test("remote HSR spawn: with NO client cwd/home, the remote derives cwd + home under storeRoot and delivers creds into the DERIVED home", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const { sub, killAll } = connectSubstrate(dir, remoteSock);
    const bee = "derivedbee";
    const SECRET = "SECRET-derived-home-auth-bytes-1a2b3c";

    try {
      // No `cwd`, no `home` shipped — exactly what the fixed client sends for a
      // plain remote-hsr spawn. The remote must resolve both itself.
      const res = await sub.spawnRemote({
        bee,
        kind: "stub",
        creds: { files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(SECRET).toString("base64"), mode: 0o600 }] },
        spec: { command: process.execPath, args: [], env: {} },
      });

      // The remote echoes the resolved cwd — the DERIVED per-bee dir under store.
      const expectedCwd = join(hsrRunDir(bee), "cwd");
      assert.equal(res.cwd, expectedCwd, "spawn result echoes the derived remote cwd");
      await waitFor(() => fileExists(expectedCwd), "derived cwd dir created");
      assert.equal((await stat(expectedCwd)).mode & 0o777, 0o700, "derived cwd is 0700");

      // Credentials landed in the DERIVED home (under store), not any local path.
      const derivedCred = join(hsrRunDir(bee), "home", "auth.json");
      await waitFor(() => fileExists(derivedCred), "credential written into the derived home");
      assert.equal((await stat(join(hsrRunDir(bee), "home"))).mode & 0o777, 0o700, "derived home is 0700");
      assert.equal((await stat(derivedCred)).mode & 0o777, 0o600, "credential file is 0600");

      // kill shreds the delivered credential and reclaims the run dir (cwd + home).
      const kr = await sub.kill(bee);
      assert.equal(kr.ok, true);
      await waitFor(async () => !(await fileExists(derivedCred)), "credential GONE after kill");
    } finally {
      await sub.close();
      await server.close();
      killAll();
    }
  });
});

test("remote HSR spawn: a provisioned checkout cwd (a real remote path) is honored as-is; no per-bee cwd is derived", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const { sub, killAll } = connectSubstrate(dir, remoteSock);
    const bee = "checkoutbee";
    // Stand in for a provisioned checkout: an existing dir the client sends as a
    // real REMOTE path. (In production this is `<store>/worktrees/<name>`.)
    const checkout = await mkdtemp("/tmp/hb-rsp-checkout-");

    try {
      const res = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: checkout,
        spec: { command: process.execPath, args: [], env: {} },
      });
      assert.equal(res.cwd, checkout, "the checkout cwd is honored verbatim");
      // The bee ran in the checkout, so the derived per-bee cwd was NEVER created.
      assert.equal(await fileExists(join(hsrRunDir(bee), "cwd")), false, "no derived cwd dir when a checkout is supplied");
      await sub.kill(bee);
    } finally {
      await sub.close();
      await server.close();
      killAll();
      await rm(checkout, { recursive: true, force: true });
    }
  });
});

test("remote HSR spawn: a bare spawn (no creds) needs no client cwd/home and creates no isolated home", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const { sub, killAll } = connectSubstrate(dir, remoteSock);
    const bee = "barebee";

    try {
      // No cwd, no home, no creds — the remote must still spawn (deriving cwd),
      // and must NOT fabricate an isolated home (a bare bee uses the node's own
      // default harness home for auth).
      const res = await sub.spawnRemote({
        bee,
        kind: "stub",
        spec: { command: process.execPath, args: [], env: {} },
      });
      assert.equal(res.cwd, join(hsrRunDir(bee), "cwd"), "cwd derived even with no creds");
      await waitFor(() => fileExists(join(hsrRunDir(bee), "cwd")), "derived cwd created");
      assert.equal(await fileExists(join(hsrRunDir(bee), "home")), false, "no isolated home without delivered creds");
      await sub.kill(bee);
    } finally {
      await sub.close();
      await server.close();
      killAll();
    }
  });
});
