import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createColony, loadColony } from "../src/colony.js";
import {
  archiveWorkspace,
  createWorkspace,
  listWorkspaces,
  loadWorkspace,
  renameWorkspace,
  updateWorkspace,
  validWorkspaceName,
  WORKSPACE_PREFIX,
  workspaceSessionName,
} from "../src/workspace.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-workspace-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("validWorkspaceName accepts identifiers and rejects unsafe characters", () => {
  assert.equal(validWorkspaceName("frontend"), true);
  assert.equal(validWorkspaceName("review-2026"), true);
  assert.equal(validWorkspaceName("ops_team"), true);
  assert.equal(validWorkspaceName("../escape"), false);
  assert.equal(validWorkspaceName(""), false);
  assert.equal(validWorkspaceName("-leading-dash"), false);
});

test("workspaceSessionName prefixes, accepts already-prefixed, rejects bad", () => {
  assert.equal(workspaceSessionName("fe"), "ws-fe");
  assert.equal(workspaceSessionName("ws-fe"), "ws-fe");
  assert.equal(WORKSPACE_PREFIX, "ws-");
  assert.throws(() => workspaceSessionName("bad name"), /Invalid workspace name/);
});

test("createWorkspace writes a record and listWorkspaces returns it", async () => {
  await withTempStore(async () => {
    const record = await createWorkspace({ name: "fe", rootDir: "/tmp/fe", colony: "fe", description: "frontend" });
    assert.equal(record.name, "fe");
    assert.equal(record.rootDir, "/tmp/fe");
    assert.equal(record.colony, "fe");
    assert.equal(record.description, "frontend");
    assert.deepEqual(record.members, []);
    assert.ok(record.createdAt);
    assert.ok(record.updatedAt);

    const list = await listWorkspaces();
    assert.deepEqual(list.map((r) => r.name), ["fe"]);
  });
});

test("createWorkspace refuses duplicate names and invalid names", async () => {
  await withTempStore(async () => {
    await createWorkspace({ name: "dup", rootDir: "" });
    await assert.rejects(createWorkspace({ name: "dup", rootDir: "" }), /already exists/);
    await assert.rejects(createWorkspace({ name: "../escape", rootDir: "" }), /Invalid workspace name/);
  });
});

test("createWorkspace accepts an empty rootDir (resolved lazily on open)", async () => {
  await withTempStore(async () => {
    const record = await createWorkspace({ name: "lazy", rootDir: "", members: [], colony: "lazy" });
    assert.equal(record.rootDir, "");
    const reloaded = await loadWorkspace("lazy");
    assert.equal(reloaded?.rootDir, "");
  });
});

test("members round-trip: a bee and a pane survive load", async () => {
  await withTempStore(async () => {
    await createWorkspace({
      name: "mix",
      rootDir: "/tmp/mix",
      members: [
        { kind: "bee", beeId: "CL.a3f" },
        { kind: "pane", name: "git", command: "lazygit" },
      ],
    });
    const reloaded = await loadWorkspace("mix");
    assert.deepEqual(reloaded?.members, [
      { kind: "bee", beeId: "CL.a3f" },
      { kind: "pane", name: "git", command: "lazygit" },
    ]);
  });
});

test("readWorkspace drops malformed members", async () => {
  await withTempStore(async () => {
    const dir = process.env.HIVE_STORE_ROOT!;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "workspaces"), { recursive: true });
    await writeFile(
      join(dir, "workspaces", "bad.json"),
      JSON.stringify({
        name: "bad",
        rootDir: "/tmp/bad",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        members: [
          { kind: "bee", beeId: "OK" },
          { kind: "bee" }, // missing beeId → dropped
          { kind: "pane", name: "shell" },
          { kind: "weird", foo: 1 }, // unknown kind → dropped
          "not-an-object", // → dropped
        ],
      }),
    );
    const reloaded = await loadWorkspace("bad");
    assert.deepEqual(reloaded?.members, [
      { kind: "bee", beeId: "OK" },
      { kind: "pane", name: "shell" },
    ]);
  });
});

test("updateWorkspace patches members/rootDir/description and bumps updatedAt", async () => {
  await withTempStore(async () => {
    const created = await createWorkspace({ name: "u", rootDir: "" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateWorkspace("u", {
      rootDir: "/tmp/u",
      description: "desc",
      members: [{ kind: "bee", beeId: "CL.x" }],
    });
    assert.equal(updated.rootDir, "/tmp/u");
    assert.equal(updated.description, "desc");
    assert.deepEqual(updated.members, [{ kind: "bee", beeId: "CL.x" }]);
    assert.notEqual(updated.updatedAt, created.updatedAt);

    const cleared = await updateWorkspace("u", { description: "" });
    assert.equal(cleared.description, undefined);

    await assert.rejects(updateWorkspace("ghost", { rootDir: "/x" }), /Unknown workspace/);
  });
});

test("renameWorkspace moves the record and refuses collisions", async () => {
  await withTempStore(async () => {
    await createWorkspace({ name: "old", rootDir: "/tmp/old", description: "d" });
    const renamed = await renameWorkspace("old", "new");
    assert.equal(renamed.name, "new");
    assert.equal(renamed.rootDir, "/tmp/old");
    assert.equal(renamed.description, "d");
    assert.equal(await loadWorkspace("old"), null);
    assert.ok(await loadWorkspace("new"));

    await createWorkspace({ name: "blocker", rootDir: "" });
    await assert.rejects(renameWorkspace("new", "blocker"), /already exists/);
    await assert.rejects(renameWorkspace("new", "../bad"), /Invalid workspace name/);
    await assert.rejects(renameWorkspace("ghost", "x"), /Unknown workspace/);
  });
});

test("archiveWorkspace flips the flag and is idempotent", async () => {
  await withTempStore(async () => {
    await createWorkspace({ name: "arch", rootDir: "" });
    const first = await archiveWorkspace("arch");
    assert.equal(first.archived, true);
    assert.ok(first.archivedAt);
    const again = await archiveWorkspace("arch");
    assert.equal(first.archivedAt, again.archivedAt);

    const reloaded = await loadWorkspace("arch");
    assert.equal(reloaded?.archived, true);

    await assert.rejects(archiveWorkspace("ghost"), /Unknown workspace/);
  });
});

test("loadWorkspace rejects path-traversal names without touching the filesystem", async () => {
  await withTempStore(async () => {
    assert.equal(await loadWorkspace("../escape"), null);
    assert.equal(await loadWorkspace("nested/path"), null);
  });
});

test("listWorkspaces skips records whose embedded name disagrees with the file stem", async () => {
  await withTempStore(async () => {
    await createWorkspace({ name: "real", rootDir: "" });
    const dir = process.env.HIVE_STORE_ROOT!;
    await writeFile(
      join(dir, "workspaces", "imposter.json"),
      JSON.stringify({ name: "real", rootDir: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", members: [] }),
    );
    const list = await listWorkspaces();
    assert.deepEqual(list.map((r) => r.name), ["real"]);
  });
});

test("colony auto-provisions a same-named workspace with empty rootDir", async () => {
  await withTempStore(async () => {
    await createColony("fe");
    const ws = await loadWorkspace("fe");
    assert.ok(ws, "colony auto-workspace should exist");
    assert.deepEqual(ws!.members, []);
    assert.equal(ws!.colony, "fe");
    assert.equal(ws!.rootDir, "");

    const colony = await loadColony("fe");
    assert.equal(colony?.workspace, "fe");
  });
});

test("creating a colony does not throw even though it provisions a workspace", async () => {
  await withTempStore(async () => {
    // colony.test.ts-style: createColony must stay green with auto-provisioning.
    const record = await createColony("ops", "ops team");
    assert.equal(record.name, "ops");
    assert.equal(record.description, "ops team");
  });
});
