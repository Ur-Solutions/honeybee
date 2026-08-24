/**
 * Spec 04 behavior 6: service management behind one interface. CI never runs
 * launchctl/systemctl — every invocation goes through an injected recording
 * runner, and the rendered service files are pinned by full-string snapshots.
 * (Real service files are exercised only by the manual platform smokes.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LaunchdServiceManager,
  SystemdServiceManager,
  createServiceManager,
  renderLaunchdPlist,
  renderSystemdUnit,
  ServiceError,
  type ExecResult,
  type ServiceSpec,
} from "../src/service.ts";

const SPEC: ServiceSpec = {
  label: "dev.honeybee.hive.v2.test",
  execArgs: ["/usr/local/bin/node", "/opt/hive/dist/cli.js", "v2", "daemon", "run", "--data-dir", "/data/v2"],
  logPath: "/data/v2/hived.log",
  env: { HIVE_V2_DATA_DIR: "/data/v2" },
};

// ---------------------------------------------------------------------------
// rendered service files: exact snapshots
// ---------------------------------------------------------------------------

const PLIST_SNAPSHOT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.honeybee.hive.v2.test</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/hive/dist/cli.js</string>
    <string>v2</string>
    <string>daemon</string>
    <string>run</string>
    <string>--data-dir</string>
    <string>/data/v2</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HIVE_V2_DATA_DIR</key>
    <string>/data/v2</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/data/v2/hived.log</string>
  <key>StandardErrorPath</key>
  <string>/data/v2/hived.log</string>
</dict>
</plist>
`;

const UNIT_SNAPSHOT = `[Unit]
Description=Honeybee v2 hive daemon (dev.honeybee.hive.v2.test)

[Service]
Type=simple
ExecStart="/usr/local/bin/node" "/opt/hive/dist/cli.js" "v2" "daemon" "run" "--data-dir" "/data/v2"
Environment="HIVE_V2_DATA_DIR=/data/v2"
Restart=always
RestartSec=2
StandardOutput=append:/data/v2/hived.log
StandardError=append:/data/v2/hived.log

[Install]
WantedBy=default.target
`;

test("service.1: launchd plist snapshot", () => {
  assert.equal(renderLaunchdPlist(SPEC), PLIST_SNAPSHOT);
});

test("service.2: systemd user unit snapshot", () => {
  assert.equal(renderSystemdUnit(SPEC), UNIT_SNAPSHOT);
});

// ---------------------------------------------------------------------------
// injected-exec interface tests
// ---------------------------------------------------------------------------

function recordingExec(results: ExecResult[] = []): {
  calls: Array<{ cmd: string; args: string[] }>;
  exec: (cmd: string, args: string[]) => Promise<ExecResult>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    exec: (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(results.shift() ?? { code: 0, stdout: "", stderr: "" });
    },
  };
}

test("service.3: launchd manager — install writes the plist; start/stop/status drive launchctl", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-svc-"));
  try {
    const rec = recordingExec([
      { code: 0, stdout: "", stderr: "" }, // start → bootstrap ok
      { code: 0, stdout: "state = running\n", stderr: "" }, // status → print
      { code: 0, stdout: "", stderr: "" }, // stop → bootout
      { code: 3, stdout: "", stderr: "Could not find service" }, // stop → unloaded
    ]);
    const mgr = new LaunchdServiceManager(SPEC, { exec: rec.exec, agentsDir: dir, uid: 501 });
    await mgr.install();
    assert.equal(readFileSync(mgr.servicePath, "utf8"), PLIST_SNAPSHOT);
    assert.equal(rec.calls.length, 0, "install is a file write, no launchctl");

    await mgr.start();
    assert.deepEqual(rec.calls[0], { cmd: "launchctl", args: ["bootstrap", "gui/501", mgr.servicePath] });

    const status = await mgr.status();
    assert.deepEqual(rec.calls[1], { cmd: "launchctl", args: ["print", "gui/501/dev.honeybee.hive.v2.test"] });
    assert.deepEqual(status, { installed: true, running: true, detail: "launchd: state = running" });

    await mgr.stop();
    assert.deepEqual(rec.calls[2], { cmd: "launchctl", args: ["bootout", "gui/501/dev.honeybee.hive.v2.test"] });
    assert.deepEqual(rec.calls[3], { cmd: "launchctl", args: ["print", "gui/501/dev.honeybee.hive.v2.test"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service.4: launchd start falls back to kickstart when already bootstrapped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-svc-"));
  try {
    const rec = recordingExec([
      { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" },
      { code: 0, stdout: "", stderr: "" },
    ]);
    const mgr = new LaunchdServiceManager(SPEC, { exec: rec.exec, agentsDir: dir, uid: 501 });
    await mgr.start();
    assert.deepEqual(
      rec.calls.map((c) => c.args[0]),
      ["bootstrap", "kickstart"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service.4b: launchd stop waits through the asynchronous bootout window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-svc-"));
  try {
    const rec = recordingExec([
      { code: 0, stdout: "", stderr: "" }, // bootout accepted
      { code: 0, stdout: "state = running\n", stderr: "" }, // still unloading
      { code: 0, stdout: "state = exited\n", stderr: "" }, // still registered
      { code: 3, stdout: "", stderr: "Could not find service" }, // gone
    ]);
    const sleeps: number[] = [];
    const mgr = new LaunchdServiceManager(SPEC, {
      exec: rec.exec,
      agentsDir: dir,
      uid: 501,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await mgr.stop();
    assert.deepEqual(rec.calls.map((call) => call.args[0]), ["bootout", "print", "print", "print"]);
    assert.deepEqual(sleeps, [25, 25]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service.5: systemd manager — install writes unit + daemon-reload; start/stop/status; uninstall removes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-svc-"));
  try {
    const rec = recordingExec([
      { code: 0, stdout: "", stderr: "" }, // install → daemon-reload
      { code: 0, stdout: "", stderr: "" }, // start
      { code: 0, stdout: "active\n", stderr: "" }, // status running
      { code: 3, stdout: "inactive\n", stderr: "" }, // status stopped
      { code: 0, stdout: "", stderr: "" }, // stop
      { code: 0, stdout: "", stderr: "" }, // uninstall → disable --now
      { code: 0, stdout: "", stderr: "" }, // uninstall → daemon-reload
    ]);
    const mgr = new SystemdServiceManager(SPEC, { exec: rec.exec, unitDir: dir });
    await mgr.install();
    assert.equal(readFileSync(mgr.servicePath, "utf8"), UNIT_SNAPSHOT);
    assert.deepEqual(rec.calls[0], { cmd: "systemctl", args: ["--user", "daemon-reload"] });

    await mgr.start();
    assert.deepEqual(rec.calls[1], { cmd: "systemctl", args: ["--user", "start", "dev.honeybee.hive.v2.test.service"] });

    assert.deepEqual(await mgr.status(), { installed: true, running: true, detail: "systemd: active" });
    assert.deepEqual(await mgr.status(), { installed: true, running: false, detail: "systemd: inactive" });

    await mgr.stop();
    assert.deepEqual(rec.calls[4], { cmd: "systemctl", args: ["--user", "stop", "dev.honeybee.hive.v2.test.service"] });

    await mgr.uninstall();
    assert.equal(existsSync(mgr.servicePath), false);
    assert.deepEqual(rec.calls[5], { cmd: "systemctl", args: ["--user", "disable", "--now", "dev.honeybee.hive.v2.test.service"] });
    assert.deepEqual(rec.calls[6], { cmd: "systemctl", args: ["--user", "daemon-reload"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service.6: one factory per platform; anything else refuses", () => {
  const exec = recordingExec().exec;
  assert.equal(createServiceManager("darwin", SPEC, { exec, dir: "/tmp/x", uid: 1 }).platform, "launchd");
  assert.equal(createServiceManager("linux", SPEC, { exec, dir: "/tmp/x", uid: 1 }).platform, "systemd");
  assert.throws(() => createServiceManager("win32", SPEC, { exec, dir: "/tmp/x", uid: 1 }), ServiceError);
});

test("service.7: a failing systemctl surfaces as a typed ServiceError, never silence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-svc-"));
  try {
    const rec = recordingExec([{ code: 1, stdout: "", stderr: "Failed to connect to bus" }]);
    const mgr = new SystemdServiceManager(SPEC, { exec: rec.exec, unitDir: dir });
    await assert.rejects(() => mgr.start(), ServiceError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
