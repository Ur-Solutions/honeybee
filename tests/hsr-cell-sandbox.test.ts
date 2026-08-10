import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCellSandboxState,
  commandString,
  initializeCellSandbox,
  probeCellSandbox,
  resolveCellSandboxExtraWriteRoots,
  shutdownCellSandbox,
  withoutAmbientProviderState,
  wrapCellSandboxCommand,
  wrapCellSandboxCommandForState,
} from "../src/hsr/cellSandbox.js";

async function executable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

async function run(command: string, args: string[], options: {
  cwd: string;
  env: Record<string, string>;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

test("probeCellSandbox advertises both supported OS backends and fails closed on missing dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-cell-probe-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  try {
    for (const name of ["bash", "bwrap", "rg"]) await executable(join(bin, name));
    assert.deepEqual(probeCellSandbox("linux", { PATH: bin }), {
      status: "ready",
      backend: "linux-bubblewrap",
    });
    await rm(join(bin, "bwrap"));
    const missing = probeCellSandbox("linux", { PATH: bin });
    assert.match(missing.status === "absent" ? missing.installHint : "", /bubblewrap/);
    assert.equal(probeCellSandbox("darwin", { PATH: bin }).status, "ready");
    assert.equal(probeCellSandbox("freebsd", { PATH: bin }).status, "absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cell policy permits only the Cell, provider state, and per-run scratch outside device files", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-cell-policy-"));
  const bin = join(root, "bin");
  const cell = join(root, "cell");
  const runDir = join(root, "run");
  const provider = join(root, "provider");
  await Promise.all([mkdir(bin), mkdir(cell), mkdir(runDir), mkdir(provider)]);
  try {
    for (const name of ["bash", "bwrap", "rg"]) await executable(join(bin, name));
    const built = buildCellSandboxState({
      kind: "grok",
      cwd: cell,
      runDir,
      platform: "linux",
      env: { PATH: bin, HOME: join(root, "home"), GROK_HOME: provider },
    });
    assert.equal(built.state.backend, "linux-bubblewrap");
    assert.ok(built.state.allowWrite.includes(await realpath(cell)));
    assert.ok(built.state.allowWrite.includes(await realpath(provider)));
    assert.ok(built.state.allowWrite.includes(await realpath(join(runDir, "cell-sandbox"))));
    assert.ok(!built.state.allowWrite.includes(join(root, "home")));
    assert.equal(built.env.TMPDIR, join(built.state.scratchRoot, "tmp"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cell policy explicitly allows hive buz mailboxes, next-tool locks, and the ledger append", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-cell-buz-policy-"));
  const bin = join(root, "bin");
  const cell = join(root, "cell");
  const runDir = join(root, "run");
  const store = join(root, "store");
  await Promise.all([mkdir(bin), mkdir(cell), mkdir(runDir)]);
  try {
    for (const name of ["bash", "bwrap", "rg"]) await executable(join(bin, name));
    const built = buildCellSandboxState({
      kind: "codex",
      cwd: cell,
      runDir,
      platform: "linux",
      env: { PATH: bin, HOME: join(root, "home"), HIVE_STORE_ROOT: store, HIVE_LEDGER_MAX_BYTES: "12345" },
    });
    const canonicalStore = await realpath(store);
    assert.ok(built.state.allowWrite.includes(join(canonicalStore, "buz")), "buz mailbox subtree is writable");
    const nextToolLocks = join(canonicalStore, "locks", "hsr-turn-delivery");
    assert.ok(built.state.allowWrite.includes(nextToolLocks), "HSR next-tool delivery locks are writable");
    assert.ok(!built.state.allowWrite.includes(join(canonicalStore, "locks")), "the broader lock tree stays host-only");
    assert.ok(built.state.allowWrite.includes(join(canonicalStore, "ledger.jsonl")), "ledger append target is writable");
    // The Linux backend can only bind paths that exist at wrap time.
    assert.equal(await realpath(nextToolLocks), nextToolLocks);
    assert.equal(await readFile(join(store, "ledger.jsonl"), "utf8"), "");
    assert.equal(built.env.HIVE_LEDGER_MAX_BYTES, "0", "in-cell ledger rotation is pinned off");
    assert.ok(!built.state.allowWrite.includes(canonicalStore), "the store root itself stays read-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cell policy merges --sandbox-write grants; the Layout-v2 wrapper (the Cell's parent) is allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-cell-extra-roots-"));
  const bin = join(root, "bin");
  const wrapper = join(root, "cells", "wrapper");
  const cell = join(wrapper, "checkout");
  const box = join(wrapper, "box");
  const sibling = join(root, "shared-scratch");
  const runDir = join(root, "run");
  await Promise.all([
    mkdir(bin),
    mkdir(cell, { recursive: true }),
    mkdir(box, { recursive: true }),
    mkdir(sibling),
    mkdir(runDir),
  ]);
  try {
    for (const name of ["bash", "bwrap", "rg"]) await executable(join(bin, name));
    const built = buildCellSandboxState({
      kind: "codex",
      cwd: cell,
      runDir,
      platform: "linux",
      env: { PATH: bin, HOME: join(root, "home"), HIVE_STORE_ROOT: join(root, "store") },
      extraWriteRoots: [wrapper, sibling],
    });
    assert.ok(built.state.allowWrite.includes(await realpath(wrapper)), "the v2 wrapper (parent of the Cell) is writable");
    assert.ok(built.state.allowWrite.includes(await realpath(sibling)), "an unrelated named grant is writable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extra write root guards refuse broad, unreal, or store-containing grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-cell-extra-guards-"));
  const wrapper = join(root, "cells", "wrapper");
  const cell = join(wrapper, "checkout");
  const store = join(root, "home", ".hive");
  const filePath = join(root, "a-file");
  const linkPath = join(root, "a-link");
  await mkdir(cell, { recursive: true });
  await mkdir(store, { recursive: true });
  await writeFile(filePath, "not a directory\n");
  const { symlink } = await import("node:fs/promises");
  await symlink(join(root, "cells"), linkPath);
  const env = { HOME: join(root, "home") };
  const refuse = (roots: string[], pattern: RegExp) =>
    assert.throws(() => resolveCellSandboxExtraWriteRoots(roots, cell, env), pattern);
  try {
    // Happy paths: the immediate parent (v2 wrapper) and an unrelated dir.
    assert.deepEqual(
      resolveCellSandboxExtraWriteRoots([wrapper], cell, env),
      [await realpath(wrapper)],
    );
    refuse(["relative/path"], /must be absolute/);
    refuse([join(root, "missing")], /does not exist/);
    refuse([filePath], /must be a directory/);
    refuse([linkPath], /must not be a symlink/);
    refuse(["/"], /refuses broad extra write root/);
    refuse([join(root, "home")], /refuses broad extra write root|contains the hive store/);
    // An ancestor of the hive store root (here: HOME's parent) is refused.
    refuse([root], /contains the hive store|above the Cell/);
    // The store root itself is refused.
    refuse([store], /contains the hive store/);
    // An ancestor of the Cell ABOVE the wrapper (would fence in sibling
    // Cells / the whole cells root) is refused; only the immediate parent
    // may be granted.
    refuse([join(root, "cells")], /above the Cell/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cell policy refuses a buz root that contains the Cell", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-cell-buz-broad-"));
  const bin = join(root, "bin");
  const cell = join(root, "store", "buz", "cell");
  const runDir = join(root, "run");
  await Promise.all([mkdir(bin), mkdir(cell, { recursive: true }), mkdir(runDir)]);
  try {
    for (const name of ["bash", "bwrap", "rg"]) await executable(join(bin, name));
    assert.throws(() => buildCellSandboxState({
      kind: "codex",
      cwd: cell,
      runDir,
      platform: "linux",
      env: { PATH: bin, HOME: join(root, "home"), HIVE_STORE_ROOT: join(root, "store") },
    }), /refuses a buz root that contains the Cell/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cell policy refuses a provider home broad enough to reopen the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-cell-broad-home-"));
  const bin = join(root, "bin");
  const cell = join(root, "products", "cell");
  const runDir = join(root, "run");
  await Promise.all([mkdir(bin), mkdir(cell, { recursive: true }), mkdir(runDir)]);
  try {
    for (const name of ["bash", "bwrap", "rg"]) await executable(join(bin, name));
    assert.throws(() => buildCellSandboxState({
      kind: "codex",
      cwd: cell,
      runDir,
      platform: "linux",
      env: { PATH: bin, HOME: root, CODEX_HOME: root },
    }), /refuses broad provider state root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux wrapper keeps host networking, namespaces processes, and fences the filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-cell-linux-policy-"));
  const cell = join(root, "cell");
  await mkdir(cell);
  const wrapper = await wrapCellSandboxCommandForState({
    backend: "linux-bubblewrap",
    cwd: cell,
    scratchRoot: join(root, "scratch"),
    allowWrite: [cell],
    denyWrite: [],
    bashPath: "/bin/bash",
    bwrapPath: "/usr/bin/bwrap",
    rgPath: "/usr/bin/true",
  }, "/bin/echo", ["hello world"]);
  try {
    assert.equal(wrapper.command, "/bin/bash");
    const generated = wrapper.args[1]!;
    assert.match(generated, /--unshare-pid/);
    assert.doesNotMatch(generated, /--unshare-net/, "dev-server network remains host-shared");
    assert.match(generated, /--ro-bind/);
    assert.match(generated, /hello world/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commandString preserves arbitrary argv as data", () => {
  assert.equal(commandString("/tmp/a b", ["", "a'b", "$(touch nope)"]),
    "'/tmp/a b' '' 'a'\\''b' '$(touch nope)'");
});

test("protocol Cells discard ambient provider homes but keep the explicitly resolved account home", () => {
  const inherited = {
    PATH: "/usr/bin",
    CODEX_HOME: "/ambient/codex",
    CLAUDE_CONFIG_DIR: "/ambient/claude",
    XDG_DATA_HOME: "/ambient/xdg",
  };
  assert.deepEqual(withoutAmbientProviderState("codex", inherited, {}), { PATH: "/usr/bin", XDG_DATA_HOME: "/ambient/xdg" });
  assert.deepEqual(withoutAmbientProviderState("codex", inherited, { CODEX_HOME: "/account/codex" }), {
    PATH: "/usr/bin",
    CODEX_HOME: "/ambient/codex",
    XDG_DATA_HOME: "/ambient/xdg",
  });
  assert.deepEqual(withoutAmbientProviderState("opencode", inherited, {}), { PATH: "/usr/bin" });
});

test("the native macOS/Linux sandbox commits inside its Cell, blocks a canonical sibling, and serves locally", {
  skip: !["darwin", "linux"].includes(process.platform) ? "macOS/Linux integration probe" : false,
}, async (context) => {
  const support = probeCellSandbox();
  if (support.status !== "ready") {
    context.skip(support.installHint);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "hive-cell-seatbelt-"));
  const cell = join(root, "cell");
  const canonical = join(root, "canonical");
  const runDir = join(root, "run");
  const provider = join(root, "codex-home");
  const store = join(root, "store");
  await Promise.all([mkdir(cell), mkdir(canonical), mkdir(runDir), mkdir(provider), mkdir(store)]);
  await mkdir(join(store, "sessions"));
  await mkdir(join(store, "locks", "host-only"), { recursive: true });
  const originalCwd = process.cwd();
  try {
    const baseEnv = {
      ...process.env,
      HOME: process.env.HOME ?? root,
      CODEX_HOME: provider,
      HIVE_STORE_ROOT: store,
    } as Record<string, string>;
    assert.equal((await run("git", ["init", "-q"], { cwd: cell, env: baseEnv })).code, 0);
    await writeFile(join(cell, "base.txt"), "base\n");
    assert.equal((await run("git", ["add", "base.txt"], { cwd: cell, env: baseEnv })).code, 0);
    assert.equal((await run("git", ["-c", "user.name=Cell", "-c", "user.email=cell@example.test", "commit", "-qm", "base"], {
      cwd: cell,
      env: baseEnv,
    })).code, 0);

    process.chdir(cell);
    const initialized = initializeCellSandbox({ kind: "codex", cwd: cell, runDir, env: baseEnv });
    const script = [
      "printf inside > inside.txt",
      `printf escaped > ${JSON.stringify(join(canonical, "escaped.txt"))} 2>/dev/null || true`,
      "git add inside.txt",
      "git -c user.name=Cell -c user.email=cell@example.test commit -qm contained",
      // Hive buz is explicitly available inside the Cell: mailbox writes,
      // next-tool's HSR delivery lock, and the ledger append succeed while
      // the rest of the store stays read-only.
      `mkdir -p ${JSON.stringify(join(store, "buz", "cl.test", "outbox"))}`,
      `printf msg > ${JSON.stringify(join(store, "buz", "cl.test", "outbox", "note.md"))}`,
      `printf lock > ${JSON.stringify(join(store, "locks", "hsr-turn-delivery", "recipient.lock.init-cell-probe"))}`,
      `printf blocked > ${JSON.stringify(join(store, "locks", "host-only", "escaped.lock"))} 2>/dev/null || true`,
      `printf '{"type":"buz.send"}\\n' >> ${JSON.stringify(join(store, "ledger.jsonl"))}`,
      `printf stray > ${JSON.stringify(join(store, "sessions", "escaped.json"))} 2>/dev/null || true`,
    ].join("; ");
    const wrapped = await wrapCellSandboxCommand("/bin/bash", ["-c", script]);
    const outcome = await run(wrapped.command, wrapped.args, { cwd: cell, env: initialized.env });
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(await readFile(join(cell, "inside.txt"), "utf8"), "inside");
    await assert.rejects(readFile(join(canonical, "escaped.txt"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(store, "buz", "cl.test", "outbox", "note.md"), "utf8"), "msg");
    assert.equal(
      await readFile(join(store, "locks", "hsr-turn-delivery", "recipient.lock.init-cell-probe"), "utf8"),
      "lock",
    );
    await assert.rejects(readFile(join(store, "locks", "host-only", "escaped.lock"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(store, "ledger.jsonl"), "utf8"), '{"type":"buz.send"}\n');
    await assert.rejects(readFile(join(store, "sessions", "escaped.json"), "utf8"), /ENOENT/);
    assert.equal(initialized.env.HIVE_LEDGER_MAX_BYTES, "0");
    const count = await run("git", ["rev-list", "--count", "HEAD"], { cwd: cell, env: baseEnv });
    assert.equal(count.stdout.trim(), "2", count.stderr);

    const serverSource = [
      "const http = require('node:http')",
      "const server = http.createServer((_req, res) => res.end('cell-server'))",
      "server.listen(0, '127.0.0.1', () => console.log(server.address().port))",
    ].join(";");
    const serverWrapped = await wrapCellSandboxCommand(process.execPath, ["-e", serverSource]);
    const server = spawn(serverWrapped.command, serverWrapped.args, {
      cwd: cell,
      env: initialized.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        let buffer = "";
        const timer = setTimeout(() => rejectPort(new Error("sandboxed dev server did not bind")), 5_000);
        server.once("error", rejectPort);
        server.stdout?.on("data", (chunk) => {
          buffer += String(chunk);
          const line = buffer.split("\n")[0]?.trim();
          if (line && /^\d+$/.test(line)) {
            clearTimeout(timer);
            resolvePort(Number(line));
          }
        });
      });
      const response = await fetch(`http://127.0.0.1:${port}`);
      assert.equal(await response.text(), "cell-server", "host can reach a dev server inside the Cell");
    } finally {
      server.kill("SIGTERM");
      if (server.exitCode === null && server.signalCode === null) {
        await new Promise<void>((resolveExit) => server.once("exit", () => resolveExit()));
      }
    }
  } finally {
    shutdownCellSandbox();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});
