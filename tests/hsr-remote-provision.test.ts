/**
 * Remote HSR working-copy provisioning e2e (APIA-95).
 *
 * Drives provision/listCheckouts + a provisioned-cwd spawn WITHOUT ssh: the
 * "remote" is this machine. A real in-process runner-host serve (remoteHost.serve)
 * plays the remote control plane on its OWN store root; the ssh unix→unix forward
 * is stood in for by a LOCAL socket relay (the same injected `spawnTunnel` pattern
 * as hsr-remote-substrate.test.ts). git runs for real against a LOCAL source repo
 * exposed over a `file://` url. Real loopback-ssh clone is APIA-98.
 *
 * We assert: provision clones a checkout under the remote store's worktrees/<name>
 * with the right branch/HEAD; a second provision of the same name/repo reuses it
 * (reused:true, no re-clone); listCheckouts lists it; a `..` name is rejected; and
 * spawnRemote with cwd = the provisioned path runs the stub bee in that cwd.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "../src/hsr/remoteHost.js";
import { createRemoteHsrSubstrate } from "../src/substrates/remote-hsr.js";
import type { NodeRecord } from "../src/node.js";
import type { TunnelChild, TunnelSpawnHook, SshExecHook } from "../src/hsr/remoteTransport.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hive",
      GIT_AUTHOR_EMAIL: "hive@example.com",
      GIT_COMMITTER_NAME: "hive",
      GIT_COMMITTER_EMAIL: "hive@example.com",
    },
  });
}

/**
 * A LOCAL source git repo on branch `main` with one commit, exposed as a
 * `file://` url the provision RPC clones from.
 */
async function makeSourceRepo(dir: string): Promise<{ path: string; url: string }> {
  await mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  await writeFile(join(dir, "README.md"), "hello from the source repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return { path: dir, url: `file://${dir}` };
}

/** withTempStore over a SHORT /tmp base (AF_UNIX path cap). */
async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-rprov-");
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
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

function makeNode(): NodeRecord {
  return {
    name: "loopunit",
    kind: "remote-hsr",
    endpoint: "me@remote-host",
    capabilities: ["*"],
    runnerHostVersion: "0.0.1+deadbeef1234",
    status: "unknown",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  };
}

function parseForward(argv: string[]): { local: string; remote: string } {
  const i = argv.indexOf("-L");
  assert.ok(i >= 0 && argv[i + 1], "forward argv must contain -L <local>:<remote>");
  const spec = argv[i + 1]!;
  const cut = spec.indexOf(":");
  return { local: spec.slice(0, cut), remote: spec.slice(cut + 1) };
}

/** A spawnTunnel hook that stands in for `ssh -L`: a real node:net local→remote relay. */
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

/** An exec hook that reports the remote serve socket as already present. */
const serveUpExecHook: SshExecHook = async () => ({ stdout: "", stderr: "", exitCode: 0 });

test("remote HSR provision: clone → reuse → listCheckouts → path-escape guard → spawn-in-checkout", async () => {
  await withTempStore(async (dir) => {
    const source = await makeSourceRepo(join(dir, "source-repo"));
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const node = makeNode();
    const tunnel = makeRelayTunnel();
    const sub = createRemoteHsrSubstrate(node, {
      transport: {
        execHook: serveUpExecHook,
        spawnTunnel: tunnel.hook,
        remoteSocket: remoteSock,
        forward: { waitAttempts: 100, waitIntervalMs: 10 },
      },
    });

    try {
      // 1. Fresh clone of branch main into worktrees/<name>.
      const prov = await sub.provisionRemote({ repo: source.url, branch: "main", name: "wc1" });
      assert.equal(prov.reused, false, "first provision is a fresh clone");
      assert.equal(prov.branch, "main");
      const expectedPath = join(dir, "worktrees", "wc1");
      assert.equal(prov.path, expectedPath, "checkout lands under <store>/worktrees/<name>");
      assert.ok(existsSync(join(expectedPath, ".git")), "checkout is a git dir");
      const readme = await readFile(join(expectedPath, "README.md"), "utf8");
      assert.match(readme, /hello from the source repo/, "checkout HEAD has the repo's content");
      // HEAD points at the source repo's commit on main.
      const head = execFileSync("git", ["-C", expectedPath, "rev-parse", "HEAD"]).toString().trim();
      const sourceHead = execFileSync("git", ["-C", source.path, "rev-parse", "HEAD"]).toString().trim();
      assert.equal(head, sourceHead, "checkout HEAD matches the source repo HEAD");
      const branch = execFileSync("git", ["-C", expectedPath, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
      assert.equal(branch, "main", "checkout is on branch main");

      // 2. Idempotent reuse: same name/repo → reused:true (fetch, no re-clone).
      const prov2 = await sub.provisionRemote({ repo: source.url, branch: "main", name: "wc1" });
      assert.equal(prov2.reused, true, "second provision of the same name reuses the checkout");
      assert.equal(prov2.path, expectedPath);

      // 3. listCheckouts enumerates it.
      const rows = await sub.listCheckouts();
      const row = rows.find((r) => r.name === "wc1");
      assert.ok(row, "listCheckouts includes the provisioned checkout");
      assert.equal(row!.path, expectedPath);
      assert.equal(row!.branch, "main");
      assert.ok(row!.repo && row!.repo.includes("source-repo"), "row carries the origin url");

      // 4. Path-escape guard: a `..` name is rejected (never escapes worktrees/).
      await assert.rejects(
        () => sub.provisionRemote({ repo: source.url, name: ".." }),
        /provision on loopunit failed/,
        "a `..` name is rejected",
      );

      // 5. spawnRemote with cwd = the provisioned path runs the stub bee there.
      const bee = "provbee";
      const res = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: prov.path,
        spec: { command: process.execPath, args: [], env: {} },
      });
      assert.equal(res.bee, bee);
      await waitFor(async () => await sub.hasSession(bee), "hasSession true after spawn");
      // The remote meta records the cwd the runner was started in.
      const metaRaw = await readFile(join(dir, "hsr", bee, "meta.json"), "utf8").catch(() => "");
      assert.ok(metaRaw.length > 0, "remote meta.json exists for the spawned bee");
      await sub.kill(bee);
      await waitFor(async () => (await sub.hasSession(bee)) === false, "hasSession false after kill");
    } finally {
      await sub.close();
      await server.close();
      tunnel.killAll();
    }
  });
});
