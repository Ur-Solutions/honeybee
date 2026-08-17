// Spec 00 (reset WP0) — versioned deploys. Exercises the full deploy state
// machine (src/deployRuntime.ts) against a temp runtime root and a real
// fixture git repo, with the build and daemon-restart hooks injected so no
// test ever compiles the repo or restarts anything real.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  CURRENT_LINK_NAME,
  DEPLOY_HISTORY_FILENAME,
  currentDeployTarget,
  deployVersion,
  pruneRuntimeVersions,
  readDeployHistory,
  rollbackDeploy,
  type BuildArtifactContext,
  type DeployHooks,
  type RestartDaemonContext,
} from "../src/deployRuntime.js";

const execFileAsync = promisify(execFile);

async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args]);
  return stdout.trim();
}

/** Fixture repo with real commits; each commit's marker.txt names its build output. */
async function makeRepo(root: string): Promise<{ repoRoot: string; commit: (marker: string) => Promise<string> }> {
  const repoRoot = join(root, "repo");
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", repoRoot]);
  const commit = async (marker: string): Promise<string> => {
    await writeFile(join(repoRoot, "marker.txt"), `${marker}\n`);
    await git(repoRoot, "add", "-A");
    await git(
      repoRoot,
      "-c", "user.name=deploy-test",
      "-c", "user.email=deploy-test@hive",
      "commit", "-q", "-m", `marker ${marker}`,
    );
    return git(repoRoot, "rev-parse", "HEAD");
  };
  return { repoRoot, commit };
}

type HookLog = {
  builds: string[];
  restarts: Array<{ sha: string; currentAtRestart: string | null }>;
};

/**
 * Fake build: reads the committed marker for the requested sha (via git show,
 * so a dirty working tree can never leak in) and emits a runnable dist/cli.js
 * that prints it. Restart records what `current` pointed at when it ran.
 */
function fakeHooks(root: string): { hooks: DeployHooks; log: HookLog } {
  const log: HookLog = { builds: [], restarts: [] };
  const hooks: DeployHooks = {
    async buildArtifact({ repoRoot, sha, workDir }: BuildArtifactContext) {
      log.builds.push(sha);
      const marker = (await git(repoRoot, "show", `${sha}:marker.txt`)).trim();
      const stage = join(workDir, "stage");
      await mkdir(join(stage, "dist"), { recursive: true });
      await writeFile(join(stage, "dist", "cli.js"), `console.log(${JSON.stringify(marker)});\n`);
      await writeFile(join(stage, "package.json"), `${JSON.stringify({ name: "honeybee", version: "0.0.1" })}\n`);
      return { artifactDir: stage };
    },
    async restartDaemon({ sha }: RestartDaemonContext) {
      log.restarts.push({ sha, currentAtRestart: await currentDeployTarget(root) });
    },
  };
  return { hooks, log };
}

async function withDeployWorld(
  fn: (world: {
    root: string;
    repoRoot: string;
    commit: (marker: string) => Promise<string>;
    hooks: DeployHooks;
    log: HookLog;
  }) => Promise<void>,
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "hive-deploy-test-"));
  const root = join(temp, "runtime");
  try {
    const { repoRoot, commit } = await makeRepo(temp);
    const { hooks, log } = fakeHooks(root);
    await fn({ root, repoRoot, commit, hooks, log });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function runInstalledCli(root: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(root, CURRENT_LINK_NAME, "dist", "cli.js")],
  );
  return stdout.trim();
}

// 1. deploy from clean HEAD installs, switches `current` atomically, restarts daemon
test("deploy from clean HEAD installs the version, retargets current, records history, restarts daemon", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    const sha = await commit("v1");
    const outcome = await deployVersion({ repoRoot, root, hooks, by: "tester" });

    assert.equal(outcome.sha, sha);
    assert.equal(outcome.previousSha, null);
    assert.ok(existsSync(join(root, sha, "dist", "cli.js")));
    // `current` is a relative symlink naming exactly the sha.
    assert.equal(await readlink(join(root, CURRENT_LINK_NAME)), sha);
    // History carries the spec'd record shape.
    const entries = await readDeployHistory(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.sha, sha);
    assert.equal(entries[0]!.by, "tester");
    assert.equal(entries[0]!.artifactHash, outcome.artifactHash);
    assert.ok(entries[0]!.artifactHash.length === 64);
    assert.ok(Number.isFinite(Date.parse(entries[0]!.at)));
    // The daemon restart is the separate final step and already saw the new target.
    assert.equal(log.restarts.length, 1);
    assert.deepEqual(log.restarts[0], { sha, currentAtRestart: sha });
    // No temp debris: only the version dir, the link, and the history file remain.
    const leftovers = (await readdir(root)).filter((name) => name.startsWith("."));
    assert.deepEqual(leftovers, []);
  });
});

test("deploy accepts an explicit sha that is not HEAD", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const first = await commit("v1");
    await commit("v2");
    const outcome = await deployVersion({ repoRoot, root, ref: first, hooks });
    assert.equal(outcome.sha, first);
    assert.equal(await currentDeployTarget(root), first);
    assert.equal(await runInstalledCli(root), "v1");
  });
});

// 2. dirty tree refuses before building
test("a dirty working tree refuses before building", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("v1");
    await writeFile(join(repoRoot, "marker.txt"), "uncommitted edit\n");
    await assert.rejects(
      deployVersion({ repoRoot, root, hooks }),
      /working tree is dirty/,
    );
    assert.deepEqual(log.builds, []);
    assert.deepEqual(log.restarts, []);
    assert.equal(existsSync(root), false);
  });
});

test("an untracked file also counts as dirty", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("v1");
    await writeFile(join(repoRoot, "scratch.txt"), "untracked\n");
    await assert.rejects(deployVersion({ repoRoot, root, hooks }), /working tree is dirty/);
    assert.deepEqual(log.builds, []);
  });
});

// 3. failing tests/build refuse before touching ~/.hive/runtime
test("a failing build never touches the runtime root, current, or history", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    const good = await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    await commit("v2");
    const failing: DeployHooks = {
      buildArtifact: async () => {
        throw new Error("check suite failed: 3 tests red");
      },
      restartDaemon: hooks.restartDaemon,
    };
    await assert.rejects(
      deployVersion({ repoRoot, root, hooks: failing }),
      /check suite failed/,
    );
    // current still names the good deploy; nothing new installed or recorded.
    assert.equal(await currentDeployTarget(root), good);
    const versionDirs = (await readdir(root)).filter((name) => /^[0-9a-f]{40}$/.test(name));
    assert.deepEqual(versionDirs, [good]);
    assert.equal((await readDeployHistory(root)).length, 1);
    assert.equal(log.restarts.length, 1);
    // No staging debris left behind either.
    const leftovers = (await readdir(root)).filter((name) => name.startsWith(".staging"));
    assert.deepEqual(leftovers, []);
  });
});

test("an artifact without dist/cli.js is refused before install", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("v1");
    const empty: DeployHooks = {
      buildArtifact: async ({ workDir }) => {
        const stage = join(workDir, "stage");
        await mkdir(stage, { recursive: true });
        return { artifactDir: stage };
      },
      restartDaemon: hooks.restartDaemon,
    };
    await assert.rejects(deployVersion({ repoRoot, root, hooks: empty }), /no dist\/cli\.js/);
    assert.equal(await currentDeployTarget(root), null);
    assert.deepEqual(log.restarts, []);
  });
});

// 4. rollback restores the previous target and daemon
test("rollback retargets current to the previous deploy and restarts the daemon", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    const first = await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    const second = await commit("v2");
    await deployVersion({ repoRoot, root, hooks });
    assert.equal(await runInstalledCli(root), "v2");

    const outcome = await rollbackDeploy({ root, hooks, by: "tester" });
    assert.equal(outcome.from, second);
    assert.equal(outcome.sha, first);
    assert.equal(await currentDeployTarget(root), first);
    assert.equal(await runInstalledCli(root), "v1");
    // Rollback appends to history (current always corresponds to the last entry).
    const entries = await readDeployHistory(root);
    assert.deepEqual(entries.map((entry) => entry.sha), [first, second, first]);
    assert.equal(entries[2]!.artifactHash, entries[0]!.artifactHash);
    assert.equal(log.restarts.length, 3);
    assert.deepEqual(log.restarts[2], { sha: first, currentAtRestart: first });
  });
});

test("rollback refuses when there is no previous installed version", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    await assert.rejects(rollbackDeploy({ root, hooks }), /nothing deployed yet/);
    await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    await assert.rejects(rollbackDeploy({ root, hooks }), /no previous installed version/);
  });
});

// 5. prune keeps current + rollback target + last N
test("prune keeps current, the rollback target, and the last N versions", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const shas: string[] = [];
    for (const marker of ["v1", "v2", "v3", "v4"]) {
      shas.push(await commit(marker));
      await deployVersion({ repoRoot, root, hooks, keep: 1 });
    }
    const [s1, s2, s3, s4] = shas as [string, string, string, string];
    const versionDirs = (await readdir(root)).filter((name) => /^[0-9a-f]{40}$/.test(name)).sort();
    // keep=1 protects only s4; s3 survives as the rollback target.
    assert.deepEqual(versionDirs, [s3, s4].sort());
    assert.equal(existsSync(join(root, s1)), false);
    assert.equal(existsSync(join(root, s2)), false);
    // Idempotent: pruning again removes nothing further.
    assert.deepEqual(await pruneRuntimeVersions(root, { keep: 1 }), []);
    // History remains complete even for pruned versions.
    assert.deepEqual((await readDeployHistory(root)).map((entry) => entry.sha), shas);
  });
});

test("prune never removes the rollback target even after rolling back", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const first = await commit("v1");
    await deployVersion({ repoRoot, root, hooks, keep: 1 });
    const second = await commit("v2");
    await deployVersion({ repoRoot, root, hooks, keep: 1 });
    await rollbackDeploy({ root, hooks });
    // current=first; rollback target=second (the entry we rolled away from).
    assert.deepEqual(await pruneRuntimeVersions(root, { keep: 1 }), []);
    assert.ok(existsSync(join(root, first)));
    assert.ok(existsSync(join(root, second)));
  });
});

// 6. `hive` resolves through `current`; working-tree edits are inert until the next deploy
test("the installed CLI resolves through current and ignores working-tree edits until the next deploy", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    assert.equal(await runInstalledCli(root), "v1");

    // Edit the working tree: the installed runtime must not change at all.
    await writeFile(join(repoRoot, "marker.txt"), "v2-uncommitted\n");
    assert.equal(await runInstalledCli(root), "v1");
    // And a deploy over that dirty tree refuses outright.
    await assert.rejects(deployVersion({ repoRoot, root, hooks }), /working tree is dirty/);
    assert.equal(await runInstalledCli(root), "v1");

    // Only committing + deploying moves the resolved version.
    await commit("v2");
    await deployVersion({ repoRoot, root, hooks });
    assert.equal(await runInstalledCli(root), "v2");
  });
});

test("redeploying the same sha replaces the install without breaking current", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const sha = await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    const before = await readFile(join(root, sha, "dist", "cli.js"), "utf8");
    await deployVersion({ repoRoot, root, hooks });
    const after = await readFile(join(root, sha, "dist", "cli.js"), "utf8");
    assert.equal(before, after);
    assert.equal(await currentDeployTarget(root), sha);
    assert.equal((await readDeployHistory(root)).length, 2);
    assert.equal(await runInstalledCli(root), "v1");
  });
});

test("deploy history tolerates a missing or foreign deploys.json", async () => {
  const temp = await mkdtemp(join(tmpdir(), "hive-deploy-history-"));
  try {
    assert.deepEqual(await readDeployHistory(join(temp, "nope")), []);
    await writeFile(join(temp, DEPLOY_HISTORY_FILENAME), "not json at all");
    assert.deepEqual(await readDeployHistory(temp), []);
    await writeFile(join(temp, DEPLOY_HISTORY_FILENAME), JSON.stringify({ entries: [{ sha: "short" }, 42] }));
    assert.deepEqual(await readDeployHistory(temp), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
