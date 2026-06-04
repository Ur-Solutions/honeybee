import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LAUNCH_LABEL,
  launchAgentsDir,
  plistPathForLabel,
  renderPlist,
  renderSystemdUnit,
} from "../src/daemon/plist.js";

test("renderPlist produces a stable XML structure matching the golden shape", () => {
  const xml = renderPlist({
    label: DEFAULT_LAUNCH_LABEL,
    programArguments: ["/usr/local/bin/node", "/Users/test/.hive/bin/cli.js", "daemon", "run"],
    workingDirectory: "/Users/test/.hive",
    stdOutPath: "/Users/test/.hive/daemon/log.txt",
    stdErrPath: "/Users/test/.hive/daemon/log.err.txt",
    keepAlive: true,
    runAtLoad: true,
    environmentVariables: { HIVE_STORE_ROOT: "/Users/test/.hive" },
  });
  assert.ok(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`));
  assert.match(xml, /<key>Label<\/key>\s+<string>dev\.honeybee\.hive<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s+<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s+<true\/>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s+<string>\/Users\/test\/\.hive\/daemon\/log\.txt<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s+<string>\/Users\/test\/\.hive\/daemon\/log\.err\.txt<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key>\s+<array>/);
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>daemon<\/string>/);
  assert.match(xml, /<string>run<\/string>/);
  assert.match(xml, /<key>WorkingDirectory<\/key>\s+<string>\/Users\/test\/\.hive<\/string>/);
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
  assert.match(xml, /<key>HIVE_STORE_ROOT<\/key>\s+<string>\/Users\/test\/\.hive<\/string>/);
  assert.ok(xml.endsWith("</plist>\n"), `expected trailing newline, got tail=${JSON.stringify(xml.slice(-20))}`);
});

test("renderPlist supports KeepAlive=false and RunAtLoad=false", () => {
  const xml = renderPlist({
    label: "dev.honeybee.hive",
    programArguments: ["/usr/bin/node", "/abs/cli.js", "daemon", "run"],
    stdOutPath: "/tmp/out",
    stdErrPath: "/tmp/err",
    keepAlive: false,
    runAtLoad: false,
  });
  assert.match(xml, /<key>KeepAlive<\/key>\s+<false\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s+<false\/>/);
});

test("renderPlist refuses non-absolute paths", () => {
  assert.throws(
    () =>
      renderPlist({
        label: "x",
        programArguments: ["node", "cli.js"],
        stdOutPath: "/tmp/out",
        stdErrPath: "/tmp/err",
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      renderPlist({
        label: "x",
        programArguments: ["/usr/bin/node"],
        stdOutPath: "relative/out",
        stdErrPath: "/tmp/err",
      }),
    /stdOutPath/,
  );
  assert.throws(
    () =>
      renderPlist({
        label: "x",
        programArguments: ["/usr/bin/node"],
        stdOutPath: "/tmp/out",
        stdErrPath: "relative/err",
      }),
    /stdErrPath/,
  );
  assert.throws(
    () =>
      renderPlist({
        label: "x",
        programArguments: ["/usr/bin/node"],
        stdOutPath: "/tmp/out",
        stdErrPath: "/tmp/err",
        workingDirectory: "not-abs",
      }),
    /workingDirectory/,
  );
});

test("renderPlist refuses empty/invalid input", () => {
  assert.throws(() => renderPlist({ label: "", programArguments: ["/usr/bin/node"], stdOutPath: "/tmp/o", stdErrPath: "/tmp/e" }), /label/);
  assert.throws(() => renderPlist({ label: "x", programArguments: [], stdOutPath: "/tmp/o", stdErrPath: "/tmp/e" }), /non-empty/);
  assert.throws(() => renderPlist({ label: "x", programArguments: ["/n", ""], stdOutPath: "/tmp/o", stdErrPath: "/tmp/e" }), /non-empty/);
});

test("renderPlist escapes XML special characters in paths and labels", () => {
  const xml = renderPlist({
    label: "dev.honeybee.hive&test",
    programArguments: ["/usr/bin/node", "/abs/path with spaces/cli.js", "daemon", "run"],
    stdOutPath: "/tmp/out",
    stdErrPath: "/tmp/err",
    environmentVariables: { FOO: `<bar>&"baz"` },
  });
  assert.match(xml, /dev\.honeybee\.hive&amp;test/);
  assert.match(xml, /path with spaces/);
  assert.match(xml, /&lt;bar&gt;&amp;&quot;baz&quot;/);
});

test("plistPathForLabel returns an absolute path under ~/Library/LaunchAgents/", () => {
  const p = plistPathForLabel("dev.honeybee.hive");
  assert.ok(p.startsWith(launchAgentsDir()), `expected ${p} to start with ${launchAgentsDir()}`);
  assert.ok(p.endsWith("dev.honeybee.hive.plist"));
});

test("plistPathForLabel rejects path traversal in the label", () => {
  assert.throws(() => plistPathForLabel("../oops"), /invalid label/);
  assert.throws(() => plistPathForLabel("foo/bar"), /invalid label/);
  assert.throws(() => plistPathForLabel(".."), /invalid label/);
  assert.throws(() => plistPathForLabel(""), /invalid label/);
});

test("renderSystemdUnit emits a minimal but complete unit", () => {
  const unit = renderSystemdUnit({
    description: "Honeybee hive daemon",
    programArguments: ["/usr/bin/node", "/abs/cli.js", "daemon", "run"],
    workingDirectory: "/home/test/.hive",
    environmentVariables: { HIVE_STORE_ROOT: "/home/test/.hive" },
  });
  assert.match(unit, /^\[Unit\]/);
  assert.match(unit, /Description=Honeybee hive daemon/);
  assert.match(unit, /^\[Service\]/m);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/abs\/cli\.js daemon run/);
  assert.match(unit, /WorkingDirectory=\/home\/test\/\.hive/);
  assert.match(unit, /Environment=HIVE_STORE_ROOT=/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /^\[Install\]/m);
  assert.match(unit, /WantedBy=default\.target/);
});

test("renderSystemdUnit quotes arguments with shell metacharacters", () => {
  const unit = renderSystemdUnit({
    programArguments: ["/usr/bin/node", "/abs/path with spaces/cli.js", "daemon", "run"],
  });
  assert.match(unit, /'\/abs\/path with spaces\/cli\.js'/);
});

test("renderSystemdUnit throws on empty programArguments", () => {
  assert.throws(() => renderSystemdUnit({ programArguments: [] }), /non-empty/);
});
