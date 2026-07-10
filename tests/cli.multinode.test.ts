import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { sessionDisplayName, shouldShowNodeColumn, substrateLabelFor } from "../src/listView.js";
import type { NodeKind } from "../src/node.js";
import type { SessionRecord } from "../src/store.js";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({
  ...process.env,
  HIVE_STORE_ROOT: dir,
  NO_COLOR: "1",
  TERM: "dumb",
  // Speed the test up — failing ssh is expensive and we want a tight bound.
  HIVE_NODE_PROBE_MS: "1500",
});

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: ENV(dir),
  });
}

function seed(record: Partial<SessionRecord> & { name: string; tmuxTarget: string }): SessionRecord {
  return {
    name: record.name,
    agent: record.agent ?? "codex",
    cwd: record.cwd ?? "/tmp",
    command: record.command ?? "codex",
    tmuxTarget: record.tmuxTarget,
    createdAt: record.createdAt ?? "2026-05-28T11:00:00.000Z",
    updatedAt: record.updatedAt ?? "2026-05-28T11:00:00.000Z",
    status: record.status ?? "running",
    ...(record.id ? { id: record.id } : {}),
    ...(record.node ? { node: record.node } : {}),
    ...(record.colony ? { colony: record.colony } : {}),
    ...(record.swarmId ? { swarmId: record.swarmId } : {}),
  };
}

async function writeRecord(dir: string, record: SessionRecord): Promise<void> {
  const sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `${record.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

test("hive list reports unreachable nodes on stderr and tags their bees node_unreachable", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-multinode-"));
  try {
    await hive(dir, "node", "register", "ghost-host", "--kind", "ssh-tmux", "--endpoint", "nonexistent.invalid");
    await writeRecord(dir, seed({ name: "ghost-bee", tmuxTarget: "ghost-bee", node: "ghost-host", id: "CO.gho" }));

    const { stdout, stderr } = await hive(dir, "list");
    const lines = stdout.split("\n").filter(Boolean);
    const ghostLine = lines.find((l) => l.includes("ghost-bee"));
    assert.ok(ghostLine, `expected ghost-bee in list output, got: ${lines.join("\\n")}`);
    assert.equal(ghostLine!.split("\t")[0], "node_unreachable");
    assert.match(stderr, /node\(s\) unreachable.*ghost-host/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive list --node <name> filters to a single node's bees", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-multinode-"));
  try {
    await writeRecord(dir, seed({ name: "alpha", tmuxTarget: "alpha", id: "CO.aaa" }));
    await writeRecord(dir, seed({ name: "beta", tmuxTarget: "beta", id: "CO.bbb", node: "ghost-host" }));
    await hive(dir, "node", "register", "ghost-host", "--kind", "ssh-tmux", "--endpoint", "nonexistent.invalid");

    const onLocal = await hive(dir, "list", "--node", "local");
    assert.ok(onLocal.stdout.includes("alpha"));
    assert.ok(!onLocal.stdout.includes("beta"));

    const onGhost = await hive(dir, "list", "--node", "ghost-host");
    assert.ok(onGhost.stdout.includes("beta"));
    assert.ok(!onGhost.stdout.includes("alpha"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shouldShowNodeColumn hides the node column on a single-node hive", () => {
  assert.equal(shouldShowNodeColumn([{ name: "local" }], false), false);
});

test("shouldShowNodeColumn shows the node column when multiple nodes are registered", () => {
  assert.equal(shouldShowNodeColumn([{ name: "local" }, { name: "mini01" }], false), true);
});

test("shouldShowNodeColumn shows the node column when --wide is forced, even on a single node", () => {
  assert.equal(shouldShowNodeColumn([{ name: "local" }], true), true);
});

test("shouldShowNodeColumn handles an empty node list gracefully", () => {
  assert.equal(shouldShowNodeColumn([], false), false);
  assert.equal(shouldShowNodeColumn([], true), true);
});

test("substrateLabelFor routes a record-level hsr bee to hsr, regardless of node", () => {
  const none = (): NodeKind | undefined => undefined;
  assert.equal(substrateLabelFor({ substrate: "hsr" }, none), "hsr");
  assert.equal(substrateLabelFor({ substrate: "hsr", node: "mini01" }, () => "ssh-tmux"), "hsr");
});

test("substrateLabelFor falls back to local-tmux for a bare local bee", () => {
  const none = (): NodeKind | undefined => undefined;
  assert.equal(substrateLabelFor({}, none), "local-tmux");
  assert.equal(substrateLabelFor({ substrate: "local-tmux" }, none), "local-tmux");
});

test("substrateLabelFor reports the node kind for a remote bee", () => {
  const kinds: Record<string, NodeKind> = { mini01: "ssh-tmux", box: "remote-hsr" };
  const lookup = (name: string): NodeKind | undefined => kinds[name];
  assert.equal(substrateLabelFor({ node: "mini01" }, lookup), "ssh-tmux");
  assert.equal(substrateLabelFor({ node: "box" }, lookup), "remote-hsr");
  // An unknown node name degrades to the local-tmux default rather than throwing.
  assert.equal(substrateLabelFor({ node: "ghost" }, lookup), "local-tmux");
});

test("sessionDisplayName prefers inherited title without changing identity", () => {
  const record = seed({ name: "CO.aaa", tmuxTarget: "CO-aaa", id: "CO.aaa" });
  assert.equal(sessionDisplayName(record), "=");
  assert.equal(sessionDisplayName(record, { collapseDefaultId: false }), "CO.aaa");
  assert.equal(sessionDisplayName({ ...record, title: "Repair Title Inheritance" }), "Repair Title Inheritance");
  assert.equal(sessionDisplayName({ ...record, name: "custom-reviewer", title: "" }), "custom-reviewer");
});

test("hive clean --dead does NOT sweep records whose node is unreachable", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-multinode-"));
  try {
    await hive(dir, "node", "register", "ghost-host", "--kind", "ssh-tmux", "--endpoint", "nonexistent.invalid");
    await writeRecord(dir, seed({ name: "ghost-bee", tmuxTarget: "ghost-bee", node: "ghost-host", id: "CO.gho" }));

    // hive clean --dead --dry-run should NOT mark ghost-bee as dead since its node
    // is unreachable — we don't actually know whether its session is alive.
    const { stdout } = await hive(dir, "clean", "--dead", "--dry-run");
    assert.ok(!stdout.includes("ghost-bee"), `ghost-bee should be preserved; got: ${stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
