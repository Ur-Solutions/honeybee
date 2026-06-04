import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeRecord } from "../src/node.js";
import { createSshTmuxSubstrate, type SshTmuxExecHook } from "../src/substrates/ssh-tmux.js";

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

test("hasSession calls ssh <endpoint> tmux has-session -t <target>", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const ok = await s.hasSession("alpha");
  assert.equal(ok, true);
  assert.deepEqual(cap.calls[0]!.argv, ["ssh", "trmd@mini01", "tmux", "has-session", "-t", "alpha"]);
});

test("hasSession returns false on non-zero exit", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 1, stderr: "can't find session" }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  assert.equal(await s.hasSession("missing"), false);
});

test("newSession quotes env and shell-safe command tokens", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  await s.newSession("alpha", "/remote/path", { command: "codex", args: ["--cwd", "/work/space"], env: { FOO: "bar baz" } });
  const argv = cap.calls[0]!.argv;
  assert.equal(argv[0], "ssh");
  assert.equal(argv[1], "trmd@mini01");
  assert.equal(argv[2], "tmux");
  assert.equal(argv[3], "new-session");
  assert.equal(argv[4], "-d");
  assert.equal(argv[5], "-s");
  assert.equal(argv[6], "alpha");
  assert.equal(argv[7], "-c");
  assert.equal(argv[8], "/remote/path");
  // env-prefixed command — single positional string the remote shell evaluates
  assert.match(argv[9]!, /^FOO='bar baz' codex --cwd \/work\/space$/);
});

test("newSession shell-quotes cwd when it contains spaces or shell metacharacters", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  await s.newSession("alpha", "/tmp/path with spaces", { command: "codex", args: [] });
  const argv = cap.calls[0]!.argv;
  // index 8 is the cwd; must be quoted so the remote shell parses it as one token.
  assert.equal(argv[8], "'/tmp/path with spaces'");
});

test("attachCommand returns ssh -t <endpoint> tmux attach-session -t <target>", () => {
  const cap = captureExec();
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  assert.deepEqual(s.attachCommand("alpha"), ["ssh", "-t", "trmd@mini01", "tmux", "attach-session", "-t", "alpha"]);
});

test("attachCommand respects NodeRecord.sshCommand and sshArgs", () => {
  const cap = captureExec();
  const s = createSshTmuxSubstrate({
    node: mini({ sshCommand: "/usr/local/bin/ssh", sshArgs: ["-F", "/etc/ssh/config", "-p", "2222"] }),
    execHook: cap.hook,
  });
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
    "alpha",
  ]);
});

test("sendText streams the prompt over stdin via load-buffer + paste-buffer + Enter", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const prompt = "Refactor src/auth.ts\nadd tests".repeat(2000); // long input — must NOT be passed as argv
  await s.sendText("alpha", prompt);

  assert.equal(cap.calls.length, 3); // load-buffer, paste-buffer, send-keys Enter
  const load = cap.calls[0]!;
  assert.deepEqual(load.argv, ["ssh", "trmd@mini01", "tmux", "load-buffer", "-b", "hive-alpha", "-"]);
  assert.equal(load.input, prompt, "long prompt should be streamed via stdin, not argv");

  const paste = cap.calls[1]!;
  assert.deepEqual(paste.argv, ["ssh", "trmd@mini01", "tmux", "paste-buffer", "-p", "-b", "hive-alpha", "-t", "alpha"]);

  const sendKey = cap.calls[2]!;
  assert.deepEqual(sendKey.argv, ["ssh", "trmd@mini01", "tmux", "send-keys", "-t", "alpha", "Enter"]);
});

test("capture calls tmux capture-pane -pt with negative line offset", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ stdout: "pane contents\n", exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const text = await s.capture("alpha", 120);
  assert.equal(text, "pane contents");
  assert.deepEqual(cap.calls[0]!.argv, ["ssh", "trmd@mini01", "tmux", "capture-pane", "-pt", "alpha", "-S", "-120"]);
});

test("listSessions returns names from list-sessions and returns [] on failure", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ stdout: "alpha\nbeta\n", exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  assert.deepEqual(await s.listSessions(), ["alpha", "beta"]);

  const cap2 = captureExec();
  cap2.respondWith(() => ({ exitCode: 1, stderr: "no server" }));
  const s2 = createSshTmuxSubstrate({ node: mini(), execHook: cap2.hook });
  assert.deepEqual(await s2.listSessions(), []);
});

test("kill returns the underlying exit code, not 'reject:true'", async () => {
  const cap = captureExec();
  cap.respondWith(() => ({ exitCode: 0 }));
  const s = createSshTmuxSubstrate({ node: mini(), execHook: cap.hook });
  const r = await s.kill("alpha");
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);

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
