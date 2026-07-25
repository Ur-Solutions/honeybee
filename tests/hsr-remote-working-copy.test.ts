import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRemoteCwd, type ExecHook, type ExecResult } from "../src/hsr/remoteWorkingCopy.js";
import type { NodeRecord } from "../src/node.js";

function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "metal",
    kind: "remote-hsr",
    endpoint: "trmd@metal",
    capabilities: ["*"],
    status: "unknown",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: "", code: 0 });
const fail = (stderr: string, code: number | string = 1): ExecResult => ({ ok: false, stdout: "", stderr, code });

type Call = { command: string; args: string[]; cwd?: string };

function scripted(script: (call: Call) => ExecResult): { exec: ExecHook; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecHook = async (command, args, opts) => {
    const call = { command, args, cwd: opts.cwd };
    calls.push(call);
    return script(call);
  };
  return { exec, calls };
}

function provisioner(path = "/home/trmd/.hive/worktrees/apiary") {
  const provisionCalls: Array<{ repo: string; branch?: string; name?: string }> = [];
  return {
    provisionCalls,
    provisionRemote: async (params: { repo: string; branch?: string; name?: string }) => {
      provisionCalls.push(params);
      return { path };
    },
  };
}

test("layer 1: pro sync ships the dirty tree → remote canonical checkout, no provisioning", async () => {
  const prov = provisioner();
  const { exec, calls } = scripted(({ command }) => {
    if (command === "pro") return ok("/home/trmd/Projects/trmd/apiary/repos/apiary\n");
    throw new Error("nothing else should run");
  });
  const res = await resolveRemoteCwd("/Users/me/Projects/trmd/apiary/repos/apiary", node(), prov, { exec });
  assert.equal(res?.via, "pro-sync");
  assert.equal(res?.cwd, "/home/trmd/Projects/trmd/apiary/repos/apiary");
  assert.equal(prov.provisionCalls.length, 0);
  assert.deepEqual(calls[0], {
    command: "pro",
    args: ["sync", "--dirty", "trmd@metal"],
    cwd: "/Users/me/Projects/trmd/apiary/repos/apiary",
  });
});

test("layer 1: pro too old for --dirty → retried clean, spawn survives, note says so", async () => {
  const prov = provisioner();
  const { exec, calls } = scripted(({ command, args }) => {
    if (command === "pro" && args.includes("--dirty")) return fail("pro: unknown sync flag: --dirty");
    if (command === "pro") return ok("/home/trmd/Projects/trmd/apiary/repos/apiary\n");
    throw new Error("must not fall through to layer 2");
  });
  const res = await resolveRemoteCwd("/Users/me/repo", node(), prov, { exec });
  assert.equal(res?.via, "pro-sync");
  assert.match(res!.note, /committed only/);
  assert.deepEqual(calls.map((c) => c.args), [["sync", "--dirty", "trmd@metal"], ["sync", "trmd@metal"]]);
  assert.equal(prov.provisionCalls.length, 0);
});

test("layer 1: foreign dirt on the node → fails loudly with the force remedy, never falls back", async () => {
  const prov = provisioner();
  const { exec } = scripted(({ command }) => {
    if (command === "pro") return fail("pro: refusing to sync into dirty remote tree: /home/trmd/Projects/x (use --force to overwrite it)");
    throw new Error("must not fall through");
  });
  await assert.rejects(
    resolveRemoteCwd("/Users/me/repo", node(), prov, { exec }),
    /dirty remote tree.*HIVE_REMOTE_SYNC=force/s,
  );
  assert.equal(prov.provisionCalls.length, 0);
});

test("layer 1: node is ahead → fails with the pull remedy", async () => {
  const prov = provisioner();
  const { exec } = scripted(({ command }) => {
    if (command === "pro") return fail("pro: remote branch 'main' is not an ancestor of local 'main'");
    throw new Error("must not fall through");
  });
  await assert.rejects(
    resolveRemoteCwd("/Users/me/repo", node(), prov, { exec }),
    /pro pull trmd@metal` first/,
  );
});

test("HIVE_REMOTE_SYNC=force adds --force; =clean drops --dirty", async (t) => {
  const prov = provisioner();
  const { exec, calls } = scripted(({ command }) => {
    if (command === "pro") return ok("/home/trmd/Projects/trmd/apiary/repos/apiary\n");
    throw new Error("nothing else should run");
  });
  t.after(() => delete process.env.HIVE_REMOTE_SYNC);

  process.env.HIVE_REMOTE_SYNC = "force";
  await resolveRemoteCwd("/Users/me/repo", node(), prov, { exec });
  assert.deepEqual(calls[0]!.args, ["sync", "--dirty", "--force", "trmd@metal"]);

  process.env.HIVE_REMOTE_SYNC = "clean";
  const clean = await resolveRemoteCwd("/Users/me/repo", node(), prov, { exec });
  assert.deepEqual(calls[1]!.args, ["sync", "trmd@metal"]);
  assert.equal(clean?.via, "pro-sync");
});

test("layer 2: not pro-managed → provisions from origin with the pushed local branch", async () => {
  const prov = provisioner();
  const { exec } = scripted(({ command, args }) => {
    if (command === "pro") return fail("pro: run inside a pro-managed primary repo, worktree, or checkout");
    if (command === "git" && args.includes("get-url")) return ok("git@github.com:trmdy/apiary.git\n");
    if (command === "git" && args.includes("symbolic-ref")) return ok("feature/x\n");
    if (command === "git" && args.includes("ls-remote")) return ok("abc123\trefs/heads/feature/x\n");
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  });
  const res = await resolveRemoteCwd("/Users/me/other", node(), prov, { exec });
  assert.equal(res?.via, "provisioned");
  assert.equal(res?.cwd, "/home/trmd/.hive/worktrees/apiary");
  assert.deepEqual(prov.provisionCalls, [{ repo: "git@github.com:trmdy/apiary.git", branch: "feature/x", name: "apiary" }]);
});

test("layer 2: pro missing entirely (ENOENT) → provisions; unpushed branch is dropped", async () => {
  const prov = provisioner();
  const { exec } = scripted(({ command, args }) => {
    if (command === "pro") return fail("", "ENOENT");
    if (command === "git" && args.includes("get-url")) return ok("https://github.com/trmdy/apiary.git\n");
    if (command === "git" && args.includes("symbolic-ref")) return ok("wip/local-only\n");
    if (command === "git" && args.includes("ls-remote")) return ok(""); // origin lacks the branch
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  });
  const res = await resolveRemoteCwd("/Users/me/other", node(), prov, { exec });
  assert.equal(res?.via, "provisioned");
  assert.deepEqual(prov.provisionCalls, [{ repo: "https://github.com/trmdy/apiary.git", name: "apiary" }]);
  assert.match(res!.note, /origin lacks wip\/local-only/);
});

test("wrong pro (Ubuntu Pro prints help, exits 0) → treated as not applicable, layer 2 runs", async () => {
  const prov = provisioner();
  const { exec } = scripted(({ command, args }) => {
    if (command === "pro") return ok("Usage: pro <command>\nTry pro --help\n");
    if (command === "git" && args.includes("get-url")) return ok("git@github.com:trmdy/apiary.git\n");
    if (command === "git" && args.includes("symbolic-ref")) return ok("main\n");
    if (command === "git" && args.includes("ls-remote")) return ok("abc\trefs/heads/main\n");
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  });
  const res = await resolveRemoteCwd("/Users/me/repo", node(), prov, { exec });
  assert.equal(res?.via, "provisioned");
});

test("HIVE_REMOTE_SYNC=origin skips pro; =off skips both layers", async (t) => {
  const prov = provisioner();
  const { exec, calls } = scripted(({ command, args }) => {
    if (command === "pro") throw new Error("pro must not run under =origin/=off");
    if (command === "git" && args.includes("get-url")) return ok("git@github.com:trmdy/apiary.git\n");
    if (command === "git" && args.includes("symbolic-ref")) return ok("main\n");
    if (command === "git" && args.includes("ls-remote")) return ok("abc\trefs/heads/main\n");
    throw new Error(`unexpected: ${command}`);
  });
  t.after(() => delete process.env.HIVE_REMOTE_SYNC);

  process.env.HIVE_REMOTE_SYNC = "origin";
  const viaOrigin = await resolveRemoteCwd("/Users/me/repo", node(), prov, { exec });
  assert.equal(viaOrigin?.via, "provisioned");

  process.env.HIVE_REMOTE_SYNC = "off";
  const off = await resolveRemoteCwd("/Users/me/repo", node(), prov, { exec });
  assert.equal(off, null);
  assert.equal(calls.filter((c) => c.command === "pro").length, 0);
});

test("neither layer applies (no origin) → null (remote derives its per-bee cwd)", async () => {
  const prov = provisioner();
  const { exec } = scripted(({ command, args }) => {
    if (command === "pro") return fail("pro: run inside a git repo");
    if (command === "git" && args.includes("get-url")) return fail("fatal: not a git repository");
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  });
  const res = await resolveRemoteCwd("/Users/me/scratch", node(), prov, { exec });
  assert.equal(res, null);
  assert.equal(prov.provisionCalls.length, 0);
});
