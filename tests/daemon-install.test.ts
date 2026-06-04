import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDaemonStatus } from "../src/daemon/index.js";
import {
  DEFAULT_LAUNCH_LABEL,
  getAgentInstallStatus,
  installAgent,
  isAgentInstalled,
  setLaunchctlRunner,
  uninstallAgent,
  type LaunchctlResult,
} from "../src/daemon/install.js";
import { plistPathForLabel } from "../src/daemon/plist.js";

type RunnerCall = { args: string[] };

function captureRunner(returning: LaunchctlResult = { ok: true, stdout: "", stderr: "", exitCode: 0 }): { calls: RunnerCall[]; dispose: () => void } {
  const calls: RunnerCall[] = [];
  const dispose = setLaunchctlRunner(async (args) => {
    calls.push({ args });
    return returning;
  });
  return { calls, dispose };
}

async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "hive-daemon-install-home-"));
  const store = await mkdtemp(join(tmpdir(), "hive-daemon-install-store-"));
  const prevHome = process.env.HOME;
  const prevStore = process.env.HIVE_STORE_ROOT;
  process.env.HOME = home;
  process.env.HIVE_STORE_ROOT = store;
  // Pre-create LaunchAgents so atomic write doesn't race the mkdir.
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  try {
    await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevStore === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prevStore;
    await rm(home, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

test("installAgent writes the plist to ~/Library/LaunchAgents/ and bootstraps via launchctl", async () => {
  await withTempHome(async () => {
    const { calls, dispose } = captureRunner();
    try {
      const result = await installAgent({
        label: DEFAULT_LAUNCH_LABEL,
        cliEntry: "/usr/local/lib/honeybee/dist/cli.js",
        nodeBinary: "/usr/local/bin/node",
      });
      assert.equal(result.installed, true);
      assert.equal(result.label, DEFAULT_LAUNCH_LABEL);
      assert.ok(result.plistPath.endsWith("dev.honeybee.hive.plist"));
      const plistText = await readFile(result.plistPath, "utf8");
      assert.match(plistText, /<key>Label<\/key>\s+<string>dev\.honeybee\.hive<\/string>/);
      assert.match(plistText, /<string>\/usr\/local\/bin\/node<\/string>/);
      assert.match(plistText, /<string>\/usr\/local\/lib\/honeybee\/dist\/cli\.js<\/string>/);
      // We only need to assert that the bootstrap call shape is correct on macOS.
      if (process.platform === "darwin") {
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.args[0], "bootstrap");
        assert.match(calls[0]!.args[1] ?? "", /^gui\/\d+$/);
        assert.equal(calls[0]!.args[2], result.plistPath);
        assert.equal(result.bootstrapped, true);
      }
    } finally {
      dispose();
    }
  });
});

test("installAgent is idempotent: second install without --force is a noop", async () => {
  await withTempHome(async () => {
    const { dispose } = captureRunner();
    try {
      const first = await installAgent({
        cliEntry: "/abs/cli.js",
        nodeBinary: "/usr/bin/node",
      });
      assert.equal(first.installed, true);

      const second = await installAgent({
        cliEntry: "/abs/cli.js",
        nodeBinary: "/usr/bin/node",
      });
      assert.equal(second.installed, false);
      assert.match(second.message, /already installed/);
    } finally {
      dispose();
    }
  });
});

test("installAgent --force overwrites an existing plist", async () => {
  await withTempHome(async () => {
    const { calls, dispose } = captureRunner();
    try {
      await installAgent({ cliEntry: "/abs/cli.js", nodeBinary: "/usr/bin/node" });
      calls.length = 0;
      const second = await installAgent({
        cliEntry: "/abs/cli.js",
        nodeBinary: "/usr/bin/node",
        force: true,
      });
      assert.equal(second.installed, true);
      if (process.platform === "darwin") {
        assert.equal(calls.length, 1, "expected bootstrap to fire on force-install");
      }
    } finally {
      dispose();
    }
  });
});

test("installAgent --skipBootstrap writes the plist without invoking launchctl", async () => {
  await withTempHome(async () => {
    const { calls, dispose } = captureRunner();
    try {
      const result = await installAgent({
        cliEntry: "/abs/cli.js",
        nodeBinary: "/usr/bin/node",
        skipBootstrap: true,
      });
      assert.equal(result.installed, true);
      assert.equal(result.bootstrapped, false);
      assert.equal(calls.length, 0);
    } finally {
      dispose();
    }
  });
});

test("uninstallAgent removes the plist and runs launchctl bootout", async () => {
  await withTempHome(async () => {
    const { calls, dispose } = captureRunner();
    try {
      await installAgent({ cliEntry: "/abs/cli.js", nodeBinary: "/usr/bin/node" });
      calls.length = 0;
      const result = await uninstallAgent({});
      assert.equal(result.removed, true);
      const exists = await stat(result.plistPath).then(() => true).catch(() => false);
      assert.equal(exists, false, "expected plist file to be deleted");
      if (process.platform === "darwin") {
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.args[0], "bootout");
      }
    } finally {
      dispose();
    }
  });
});

test("uninstallAgent on a not-installed label is a noop with a clear message", async () => {
  await withTempHome(async () => {
    const { dispose } = captureRunner();
    try {
      const result = await uninstallAgent({});
      assert.equal(result.removed, false);
      // On macOS we still attempt bootout (harmless), on Linux we skip.
      if (process.platform !== "darwin") {
        assert.match(result.message, /not installed/);
      }
    } finally {
      dispose();
    }
  });
});

test("isAgentInstalled returns true after install, false after uninstall", async () => {
  await withTempHome(async () => {
    const { dispose } = captureRunner();
    try {
      assert.equal(await isAgentInstalled(), false);
      await installAgent({ cliEntry: "/abs/cli.js", nodeBinary: "/usr/bin/node" });
      assert.equal(await isAgentInstalled(), true);
      await uninstallAgent({});
      assert.equal(await isAgentInstalled(), false);
    } finally {
      dispose();
    }
  });
});

test("getAgentInstallStatus reports plist presence and a stable checksum", async () => {
  await withTempHome(async () => {
    const { dispose } = captureRunner();
    try {
      const before = await getAgentInstallStatus();
      assert.equal(before.plistExists, false);
      assert.equal(before.plistChecksum, undefined);
      await installAgent({ cliEntry: "/abs/cli.js", nodeBinary: "/usr/bin/node" });
      const after = await getAgentInstallStatus();
      assert.equal(after.plistExists, true);
      assert.ok(after.plistChecksum && /^[0-9a-f]{8}$/.test(after.plistChecksum));
    } finally {
      dispose();
    }
  });
});

test("readDaemonStatus surfaces installed=true when a plist exists", async () => {
  await withTempHome(async () => {
    const { dispose } = captureRunner();
    try {
      await installAgent({ cliEntry: "/abs/cli.js", nodeBinary: "/usr/bin/node" });
      const status = await readDaemonStatus();
      assert.equal(status.installed, true);
      assert.ok(status.plistPath);
      assert.ok(status.plistPath!.endsWith("dev.honeybee.hive.plist"));
    } finally {
      dispose();
    }
  });
});

test("readDaemonStatus surfaces installed=false when no plist exists", async () => {
  await withTempHome(async () => {
    const status = await readDaemonStatus();
    assert.equal(status.installed, false);
    assert.equal(status.plistPath, null);
  });
});

test("plistPathForLabel resolves under the active HOME", async () => {
  await withTempHome(async () => {
    const expected = join(process.env.HOME!, "Library", "LaunchAgents", "dev.honeybee.hive.plist");
    assert.equal(plistPathForLabel("dev.honeybee.hive"), expected);
  });
});
