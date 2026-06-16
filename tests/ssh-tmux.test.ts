import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NodeRecord } from "../src/node.js";
import { createSshTmuxSubstrate, type SshTmuxExecHook } from "../src/substrates/ssh-tmux.js";

// Default ssh args injected for the exec path when the node has no sshArgs.
const MUX = ["-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/hive-%C", "-o", "ControlPersist=60"];

function mini(node: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "mini01",
    kind: "ssh-tmux",
    endpoint: "trmd@mini01",
    capabilities: ["*"],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    ...node,
  } as NodeRecord;
}

function captureExec(): { calls: { argv: string[]; input?: string }[]; hook: SshTmuxExecHook; respondWith: (impl: (call: { argv: string[]; input?: string }) => { stdout?: string; stderr?: string; exitCode?: number }) => void } {
  const calls: { argv: string[]; input?: string }[] = [];
  let impl: ((call: { argv: string[]; input?: string }) => { stdout?: string; stderr?: string; exitCode?: number }) | undefined;
  const hook: SshTmuxExecHook = async (argv, input) => {
    calls.push({ argv, ...(input !== undefined ? { input } : {}) });
    const r = impl ? impl({ argv, input }) : {};
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
  return {
    calls,
    hook,
    respondWith: (fn) => { impl = fn; },
  };
}

test("createSshTmuxSubstrate exposes ssh-tmux kind, node name, and endpoint", () => {
  const cap = captureExec();
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  assert.equal(s.kind, "ssh-tmux");
  assert.equal(s.node, "mini01");
  assert.equal(s.endpoint, "trmd@mini01");
});

test("hasSession calls ssh <endpoint> tmux has-session -t =<target> (exact match)", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const ok = await s.hasSession("alpha");
  assert.equal(ok, true);
  assert.deepEqual(cap.calls[0]!.argv, ["ssh", ...MUX, "trmd@mini01", "tmux", "has-session", "-t", "=alpha"]);
});

test("hasSession returns false on a clean remote 'no session' (exit 1)", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 1, stderr: "can't find session" }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  assert.equal(await s.hasSession("missing"), false);
});

test("hasSession throws on ssh transport failure (exit 255) instead of reporting 'gone'", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 255, stderr: "ssh: connect to host mini01 port 22: Connection refused" }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  await assert.rejects(s.hasSession("alpha"), /exit 255.*Connection refused/s);
});

test("hasSession treats a 'no server running' stderr as session-gone even on odd exit codes", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 129, stderr: "no server running on /tmp/tmux-501/default" }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  assert.equal(await s.hasSession("alpha"), false);
});

test("newSession sends an env-prefixed argv with every word quoted for the remote shell", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  await s.newSession("alpha", "/remote/path", { command: "codex", args: ["--cwd", "/work/space"], env: { FOO: "bar baz" } });
  const argv = cap.calls[0]!.argv;
  // env vars must NOT ride on a `K=v cmd` single string: tmux >= 3.0 exec()s a
  // multi-word command directly and would execvp a binary named "K=v".
  assert.deepEqual(argv, [
    "ssh", ...MUX, "trmd@mini01",
    // -P -F '#{pane_id}' prints the new pane id; the format is shell-quoted for
    // the remote shell (the bare '#' would otherwise be a comment).
    "tmux", "new-session", "-d", "-P", "-F", "'#{pane_id}'", "-s", "alpha", "-c", "/remote/path",
    "env", "'FOO=bar baz'", "codex", "--cwd", "/work/space",
  ]);
});

test("newSession omits the env prefix when the spec has no env", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  await s.newSession("alpha", "/remote/path", { command: "codex", args: [] });
  const argv = cap.calls[0]!.argv;
  assert.ok(!argv.includes("env"), `expected no env prefix, got: ${argv.join(" ")}`);
  assert.equal(argv[argv.length - 1], "codex");
});

test("newSession shell-quotes cwd when it contains spaces or shell metacharacters", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  await s.newSession("alpha", "/tmp/path with spaces", { command: "codex", args: [] });
  const argv = cap.calls[0]!.argv;
  // The word after -c is the cwd; it must be quoted so the remote shell parses it as one token.
  assert.equal(argv[argv.indexOf("-c") + 1], "'/tmp/path with spaces'");
});

/** attachCommand branches on $TMUX at call time — pin it so the test suite
 * behaves identically inside and outside a tmux client. */
function withTmuxEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.TMUX;
  if (value === undefined) delete process.env.TMUX;
  else process.env.TMUX = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous;
  }
}

test("attachCommand returns ssh -t <endpoint> tmux attach-session -t <target>", () => {
  const cap = captureExec();
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  withTmuxEnv(undefined, () => {
    assert.deepEqual(s.attachCommand("alpha"), ["ssh", "-t", "trmd@mini01", "tmux", "attach-session", "-t", "=alpha"]);
  });
});

test("attachCommand inside tmux opens the ssh attach as a new window (never nests)", () => {
  const cap = captureExec();
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  withTmuxEnv("/tmp/tmux-501/default,1,0", () => {
    assert.deepEqual(s.attachCommand("alpha"), [
      "tmux",
      "new-window",
      "-n",
      "alpha",
      "ssh -t trmd@mini01 tmux attach-session -t =alpha",
    ]);
  });
});

test("attachCommand respects NodeRecord.sshCommand and sshArgs", () => {
  const cap = captureExec();
  const s = createSshTmuxSubstrate({
    node: mini({ sshCommand: "/usr/local/bin/ssh", sshArgs: ["-F", "/etc/ssh/config", "-p", "2222"] }),
    execHook: cap.hook,
  });
  withTmuxEnv(undefined, () => {
    assert.deepEqual(s.attachCommand("alpha"), [
      "/usr/local/bin/ssh",
      "-t",
      "-F",
      "/etc/ssh/config",
      "-p",
      "2222",
      "trmd@mini01",
      "tmux",
      "attach-session",
      "-t",
      "=alpha",
    ]);
  });
});

test("attachSession spawns ssh with an exact-match (=) target", async () => {
  const stubDir = await mkdtemp(join(tmpdir(), "hive-ssh-attach-stub-"));
  try {
    const argvLog = join(stubDir, "argv.txt");
    const stubPath = join(stubDir, "fake-ssh");
    await writeFile(stubPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\nexit 0\n`, "utf8");
    await chmod(stubPath, 0o755);
    const cap = captureExec();
    const s = createSshTmuxSubstrate({ node: mini({ sshCommand: stubPath }), execHook: cap.hook });
    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      await s.attachSession("alpha");
    } finally {
      if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    }
    const argv = (await readFile(argvLog, "utf8")).trim().split("\n");
    assert.deepEqual(argv, ["-t", "trmd@mini01", "tmux", "attach-session", "-t", "=alpha"]);
  } finally {
    await rm(stubDir, { recursive: true, force: true });
  }
});

test("user-supplied sshArgs replace the multiplexing defaults on the exec path", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini({ sshArgs: ["-F", "/etc/ssh/config"] }), execHook: cap.hook });
  await s.hasSession("alpha");
  assert.deepEqual(cap.calls[0]!.argv, ["ssh", "-F", "/etc/ssh/config", "trmd@mini01", "tmux", "has-session", "-t", "=alpha"]);
  assert.ok(!cap.calls[0]!.argv.some((a) => a.startsWith("ControlMaster")), "no mux defaults when sshArgs are set");
});

test("sendText streams the prompt over stdin via load-buffer + paste-buffer + Enter", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const prompt = "Refactor src/auth.ts\nadd tests".repeat(2000); // long input — must NOT be passed as argv
  await s.sendText("alpha", prompt);

  assert.equal(cap.calls.length, 3); // load-buffer, paste-buffer, send-keys Enter
  const load = cap.calls[0]!;
  assert.deepEqual(load.argv, ["ssh", ...MUX, "trmd@mini01", "tmux", "load-buffer", "-b", "hive-alpha", "-"]);
  assert.equal(load.input, prompt, "long prompt should be streamed via stdin, not argv");

  // Pane-target commands need the `=name:` form — bare `=name` is rejected
  // ("can't find pane") because the exact-match prefix only applies to the
  // session part of a target.
  const paste = cap.calls[1]!;
  assert.deepEqual(paste.argv, ["ssh", ...MUX, "trmd@mini01", "tmux", "paste-buffer", "-p", "-b", "hive-alpha", "-t", "=alpha:"]);

  const sendKey = cap.calls[2]!;
  assert.deepEqual(sendKey.argv, ["ssh", ...MUX, "trmd@mini01", "tmux", "send-keys", "-t", "=alpha:", "Enter"]);
});

test("sendText with the default exec hook survives ssh exiting before consuming stdin (EPIPE)", { timeout: 30_000 }, async () => {
  const stubDir = await mkdtemp(join(tmpdir(), "hive-ssh-epipe-stub-"));
  try {
    // Exits instantly without reading stdin: the pending multi-MB write gets
    // EPIPE, which must be swallowed (settled into a failure), not crash.
    const stubPath = join(stubDir, "fake-ssh");
    await writeFile(stubPath, "#!/bin/sh\nexit 7\n", "utf8");
    await chmod(stubPath, 0o755);
    const s = createSshTmuxSubstrate({ node: mini({ sshCommand: stubPath }) });
    await assert.rejects(s.sendText("alpha", "x".repeat(4 * 1024 * 1024)), /Remote tmux load-buffer failed/);
  } finally {
    await rm(stubDir, { recursive: true, force: true });
  }
});

test("capture calls tmux capture-pane -pt =<target>: with negative line offset", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ stdout: "pane contents\n", exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const text = await s.capture("alpha", 120);
  assert.equal(text, "pane contents");
  assert.deepEqual(cap.calls[0]!.argv, ["ssh", ...MUX, "trmd@mini01", "tmux", "capture-pane", "-pt", "=alpha:", "-S", "-120"]);
});

test("listSessions quotes the #{session_name} format for the remote shell", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ stdout: "alpha\nbeta\n", exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  assert.deepEqual(await s.listSessions(), ["alpha", "beta"]);
  // Unquoted, the remote shell treats `#` as a comment start and the command
  // degrades to `tmux list-sessions -F` (usage error → [] for every node).
  assert.deepEqual(cap.calls[0]!.argv, ["ssh", ...MUX, "trmd@mini01", "tmux", "list-sessions", "-F", "'#{session_name}'"]);

  const cap2 = captureExec();
  cap2.respondWith(() => ({ exitCode: 1, stderr: "no server" }));
  const s2 = createSshTmuxSubstrate({ node: mini(), execHook: cap2.hook });
  assert.deepEqual(await s2.listSessions(), []);
});

test("kill targets the exact session name and returns the underlying exit code", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const r = await s.kill("alpha");
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(cap.calls[0]!.argv, ["ssh", ...MUX, "trmd@mini01", "tmux", "kill-session", "-t", "=alpha"]);

  const cap2 = captureExec();
  cap2.respondWith(() => ({ exitCode: 1, stderr: "no such session" }));
  const s2 = createSshTmuxSubstrate({ node: mini(), execHook: cap2.hook });
  const r2 = await s2.kill("alpha");
  assert.equal(r2.ok, false);
  assert.equal(r2.exitCode, 1);
});

test("probe caches ProbeResult within the TTL window", async () => {
  let calls = 0;
  const cap: { hook: SshTmuxExecHook } = {
    hook: async () => { calls += 1; return { stdout: "", stderr: "", exitCode: 0 }; },
  };
  let now = 0;
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook, now: () => now });
  await s.probe();
  await s.probe();
  await s.probe();
  assert.equal(calls, 1, "should be cached");
  now += 10_000;
  await s.probe();
  assert.equal(calls, 2, "should refresh after TTL");
});

test("probe reports an error reason on non-zero exit", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 255, stderr: "Host key verification failed.\n" }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const r = await s.probe();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /Host key verification failed/);
});

test("probe argv uses BatchMode=yes and ConnectTimeout for fast failure", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook, now: () => 0 });
  await s.probe();
  const argv = cap.calls[0]!.argv;
  assert.equal(argv[0], "ssh");
  assert.ok(argv.includes("BatchMode=yes"));
  assert.ok(argv.some((a) => a.startsWith("ConnectTimeout=")));
  assert.equal(argv[argv.length - 2], "trmd@mini01");
  assert.equal(argv[argv.length - 1], "true");
});

test("constructor refuses local-tmux nodes", () => {
  assert.throws(
    () => createSshTmuxSubstrate({ node: { ...mini(), kind: "local-tmux" } as NodeRecord }),
    /requires kind=ssh-tmux/,
  );
});
