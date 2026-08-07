import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function detachedRuntimeAvailable(): boolean {
  try {
    execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=", "-p", String(process.pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * End-to-end coverage for the session preamble (session-preamble epic): that it
 * reaches a real bee over the message channel, that it lands in argv for a
 * system-prompt harness, and that the kill switch works.
 *
 * The sibling delivery tests (cli-run, cli-fork) disable the preamble so they
 * can assert on exact text; this file is where the injection itself is proven.
 */
async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, NO_COLOR: "1" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

async function withStore(fn: (storeRoot: string, cwd: string) => Promise<void>): Promise<void> {
  const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-preamble-cli-"));
  const cwd = await mkdtemp(join(tmpdir(), "honeybee-preamble-cwd-"));
  try {
    await fn(storeRoot, cwd);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function readRecord(storeRoot: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(storeRoot, "sessions", `${name}.json`), "utf8")) as Record<string, unknown>;
}

async function writeDurableFakeClaude(storeRoot: string): Promise<string> {
  const path = join(storeRoot, "fake-claude");
  await writeFile(path, `#!${process.execPath}\nsetInterval(() => {}, 1_000);\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test("the message channel prepends the preamble to a stub bee's first prompt, once", { skip: !detachedRuntimeAvailable() }, async () => {
  await withStore(async (storeRoot, cwd) => {
    const name = `hive-test-preamble-msg-${process.pid}`;
    const env = { HIVE_STORE_ROOT: storeRoot, HIVE_STUB_CMD: process.execPath };
    try {
      const spawned = await runCli(
        ["x", "stub", "FIRST_PROMPT", "--name", name, "--cwd", cwd, "--substrate", "hsr", "--preamble", "HOST_LAYER_MARKER"],
        env,
      );
      assert.equal(spawned.code, 0, spawned.stderr);

      const record = await readRecord(storeRoot, name);
      const preamble = record.preamble as { text: string; channel: string; delivered?: boolean };
      // stub has no append-to-system-prompt flag, so it takes the message channel…
      assert.equal(preamble.channel, "message");
      assert.match(preamble.text, /HOST_LAYER_MARKER/);
      assert.match(preamble.text, /Honeybee bee/);
      // …consumed exactly once by the first delivery.
      assert.equal(preamble.delivered, true);
      // …and the record keeps the operator's own prompt, not the prefixed blob,
      // so transcript matching and the titler stay anchored on the real ask.
      assert.equal(record.lastPrompt, "FIRST_PROMPT");
      // Nothing rode argv on this channel.
      assert.ok(!JSON.stringify(record.launchArgv).includes("hive-session"));

      const tail = await runCli(["tail", name, "-n", "40"], env);
      assert.match(tail.stdout, /<hive-session>/);
      assert.match(tail.stdout, /HOST_LAYER_MARKER/);
      assert.match(tail.stdout, /FIRST_PROMPT/);

      // A SECOND prompt must not repeat it.
      const second = await runCli(["send", name, "-p", "SECOND_PROMPT"], env);
      assert.equal(second.code, 0, second.stderr);
      const after = await runCli(["tail", name, "-n", "80"], env);
      assert.equal(after.stdout.match(/<hive-session>/g)?.length, 1);
    } finally {
      await runCli(["kill", name], env);
    }
  });
});

test("--no-preamble and HIVE_PREAMBLE_DISABLE both inject nothing", { skip: !detachedRuntimeAvailable() }, async () => {
  await withStore(async (storeRoot, cwd) => {
    const base = { HIVE_STORE_ROOT: storeRoot, HIVE_STUB_CMD: process.execPath };
    const flagName = `hive-test-preamble-off-${process.pid}`;
    const envName = `hive-test-preamble-envoff-${process.pid}`;
    try {
      const viaFlag = await runCli(
        ["x", "stub", "P", "--name", flagName, "--cwd", cwd, "--substrate", "hsr", "--preamble", "HOST", "--no-preamble"],
        base,
      );
      assert.equal(viaFlag.code, 0, viaFlag.stderr);
      assert.equal((await readRecord(storeRoot, flagName)).preamble, undefined);

      const viaEnv = await runCli(["x", "stub", "P", "--name", envName, "--cwd", cwd, "--substrate", "hsr", "--preamble", "HOST"], {
        ...base,
        HIVE_PREAMBLE_DISABLE: "1",
      });
      assert.equal(viaEnv.code, 0, viaEnv.stderr);
      assert.equal((await readRecord(storeRoot, envName)).preamble, undefined);
    } finally {
      await runCli(["kill", flagName], base);
      await runCli(["kill", envName], base);
    }
  });
});

test("a claude spawn carries the preamble in argv, so revive re-applies it", { skip: !detachedRuntimeAvailable() }, async () => {
  await withStore(async (storeRoot, cwd) => {
    const name = `hive-test-preamble-argv-${process.pid}`;
    // Admission now requires a runnable child, so keep the fake harness alive
    // long enough to persist and inspect its exact argv. It must be a real
    // executable because the Claude adapter prepends provider flags; a `sh -c`
    // override would receive those flags before `-c` and exit during admission.
    const env = { HIVE_STORE_ROOT: storeRoot, HIVE_CLAUDE_CMD: await writeDurableFakeClaude(storeRoot) };
    try {
      const spawned = await runCli(
        ["spawn", "claude", "--name", name, "--cwd", cwd, "--substrate", "hsr", "--preamble", "HOST_LAYER_MARKER", "--no-wait"],
        env,
      );
      assert.equal(spawned.code, 0, spawned.stderr);

      const record = await readRecord(storeRoot, name);
      const preamble = record.preamble as { text: string; channel: string; delivered?: boolean };
      assert.equal(preamble.channel, "system-prompt");
      // Nothing to consume at delivery time — it is already in the invocation.
      assert.equal(preamble.delivered, undefined);

      const launchArgv = record.launchArgv as string[];
      const flagAt = launchArgv.indexOf("--append-system-prompt");
      assert.ok(flagAt >= 0, `--append-system-prompt missing from ${JSON.stringify(launchArgv)}`);
      assert.equal(launchArgv[flagAt + 1], preamble.text);
      assert.match(launchArgv[flagAt + 1]!, /HOST_LAYER_MARKER/);
    } finally {
      await runCli(["kill", name], env);
    }
  });
});

test("config preamble.text layers after the host layer for every spawn", { skip: !detachedRuntimeAvailable() }, async () => {
  await withStore(async (storeRoot, cwd) => {
    await writeFile(join(storeRoot, "config.json"), JSON.stringify({ preamble: { text: "CONFIG_LAYER_MARKER" } }));
    const name = `hive-test-preamble-config-${process.pid}`;
    const env = { HIVE_STORE_ROOT: storeRoot, HIVE_CLAUDE_CMD: await writeDurableFakeClaude(storeRoot) };
    try {
      const spawned = await runCli(
        ["spawn", "claude", "--name", name, "--cwd", cwd, "--substrate", "hsr", "--preamble", "HOST_LAYER_MARKER", "--no-wait"],
        env,
      );
      assert.equal(spawned.code, 0, spawned.stderr);
      const { text } = (await readRecord(storeRoot, name)).preamble as { text: string };
      assert.ok(text.indexOf("HOST_LAYER_MARKER") < text.indexOf("CONFIG_LAYER_MARKER"), text);
    } finally {
      await runCli(["kill", name], env);
    }
  });
});
