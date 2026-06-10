import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isLocalNode,
  listNodes,
  loadNode,
  loadNodeSync,
  LOCAL_NODE_NAME,
  nodeExists,
  registerNode,
  supportsCapability,
  unregisterNode,
  updateNode,
  validNodeName,
} from "../src/node.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-node-"));
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

test("validNodeName accepts identifiers and rejects unsafe characters", () => {
  assert.equal(validNodeName("mini01"), true);
  assert.equal(validNodeName("eu.west.1"), true);
  assert.equal(validNodeName("dev_server-2"), true);
  assert.equal(validNodeName("../escape"), false);
  assert.equal(validNodeName(""), false);
  assert.equal(validNodeName("-leading-dash"), false);
});

test("listNodes synthesizes the implicit local node when none registered", async () => {
  await withTempStore(async () => {
    const nodes = await listNodes();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.name, LOCAL_NODE_NAME);
    assert.equal(nodes[0]!.kind, "local-tmux");
    assert.deepEqual(nodes[0]!.capabilities, ["*"]);
  });
});

test("loadNode returns the implicit local when not on disk", async () => {
  await withTempStore(async () => {
    const local = await loadNode(LOCAL_NODE_NAME);
    assert.ok(local);
    assert.equal(local!.kind, "local-tmux");
    assert.equal(local!.endpoint, "localhost");
  });
});

test("loadNodeSync mirrors loadNode for both implicit and explicit nodes", async () => {
  await withTempStore(async () => {
    const implicit = loadNodeSync(LOCAL_NODE_NAME);
    assert.equal(implicit?.name, LOCAL_NODE_NAME);
    await registerNode({ name: "mini01", kind: "ssh-tmux", endpoint: "trmd@mini01", capabilities: ["claude", "codex"] });
    const explicit = loadNodeSync("mini01");
    assert.equal(explicit?.endpoint, "trmd@mini01");
    assert.equal(loadNodeSync("nope"), null);
  });
});

test("registerNode writes a NodeRecord and listNodes returns it", async () => {
  await withTempStore(async () => {
    const record = await registerNode({
      name: "mini01",
      kind: "ssh-tmux",
      endpoint: "trmd@mini01",
      capabilities: ["claude", "codex"],
      description: "M1 mini",
    });
    assert.equal(record.kind, "ssh-tmux");
    assert.equal(record.status, "unknown");
    assert.equal(record.endpoint, "trmd@mini01");
    assert.deepEqual(record.capabilities, ["claude", "codex"]);
    assert.equal(record.description, "M1 mini");

    const all = await listNodes();
    assert.deepEqual(all.map((n) => n.name).sort(), [LOCAL_NODE_NAME, "mini01"]);
  });
});

test("registerNode refuses duplicate names", async () => {
  await withTempStore(async () => {
    await registerNode({ name: "mini01", kind: "ssh-tmux", endpoint: "x" });
    await assert.rejects(registerNode({ name: "mini01", kind: "ssh-tmux", endpoint: "y" }), /already exists/);
  });
});

test("registerNode validates kind and endpoint", async () => {
  await withTempStore(async () => {
    await assert.rejects(registerNode({ name: "bad", kind: "modal" as unknown as "ssh-tmux", endpoint: "x" }), /Invalid node kind/);
    await assert.rejects(registerNode({ name: "bad", kind: "ssh-tmux", endpoint: "" }), /endpoint is required/);
    await assert.rejects(registerNode({ name: "../escape", kind: "ssh-tmux", endpoint: "x" }), /Invalid node name/);
  });
});

test("updateNode patches description/capabilities/endpoint", async () => {
  await withTempStore(async () => {
    await registerNode({ name: "mini01", kind: "ssh-tmux", endpoint: "old", capabilities: ["claude"] });
    const updated = await updateNode("mini01", { description: "M1 mini", capabilities: ["claude", "codex"], endpoint: "trmd@mini01" });
    assert.equal(updated.description, "M1 mini");
    assert.deepEqual(updated.capabilities, ["claude", "codex"]);
    assert.equal(updated.endpoint, "trmd@mini01");
  });
});

test("updateNode rejects modifying the implicit local node", async () => {
  await withTempStore(async () => {
    await assert.rejects(updateNode(LOCAL_NODE_NAME, { description: "nope" }), /Cannot modify implicit local node/);
  });
});

test("unregisterNode removes a real node and refuses the implicit local", async () => {
  await withTempStore(async () => {
    await registerNode({ name: "mini01", kind: "ssh-tmux", endpoint: "trmd@mini01" });
    assert.equal(await nodeExists("mini01"), true);
    await unregisterNode("mini01");
    assert.equal(await nodeExists("mini01"), false);
    await assert.rejects(unregisterNode(LOCAL_NODE_NAME), /Cannot unregister implicit local node/);
  });
});

test("supportsCapability wildcards match anything; explicit capabilities are checked literally", () => {
  const wildcard = { capabilities: ["*"] } as Parameters<typeof supportsCapability>[0];
  const restricted = { capabilities: ["claude", "codex"] } as Parameters<typeof supportsCapability>[0];
  assert.equal(supportsCapability(wildcard, "anything"), true);
  assert.equal(supportsCapability(restricted, "claude"), true);
  assert.equal(supportsCapability(restricted, "grok"), false);
});

test("isLocalNode distinguishes local-tmux from ssh-tmux", () => {
  assert.equal(isLocalNode({ kind: "local-tmux" }), true);
  assert.equal(isLocalNode({ kind: "ssh-tmux" }), false);
});

test("registering 'local' as ssh-tmux overrides the implicit local node", async () => {
  await withTempStore(async () => {
    const override = await registerNode({ name: LOCAL_NODE_NAME, kind: "ssh-tmux", endpoint: "tunnel@bastion" });
    assert.equal(override.kind, "ssh-tmux");
    const loaded = await loadNode(LOCAL_NODE_NAME);
    assert.equal(loaded?.kind, "ssh-tmux");
    assert.equal(loaded?.endpoint, "tunnel@bastion");
    const fromSync = loadNodeSync(LOCAL_NODE_NAME);
    assert.equal(fromSync?.kind, "ssh-tmux");
    // Now that 'local' is real, updates and unregister should work.
    const updated = await updateNode(LOCAL_NODE_NAME, { description: "via bastion" });
    assert.equal(updated.description, "via bastion");
    await unregisterNode(LOCAL_NODE_NAME);
    const back = await loadNode(LOCAL_NODE_NAME);
    assert.equal(back?.kind, "local-tmux");
    assert.equal(back?.endpoint, "localhost");
  });
});

test("registerNode rejects an ssh-command containing whitespace and hints the --ssh-args= form", async () => {
  await withTempStore(async () => {
    // The hint must use the `=` form: the flag parser turns `--ssh-args "-F …"`
    // into a boolean because the value starts with `-`.
    await assert.rejects(
      registerNode({ name: "weird", kind: "ssh-tmux", endpoint: "x", sshCommand: "ssh -F /etc/config" }),
      /must be a single binary path.*--ssh-args="-F \/path\/to\/config"/,
    );
  });
});

test("updateNode rejects an ssh-command containing whitespace and hints the --ssh-args= form", async () => {
  await withTempStore(async () => {
    await registerNode({ name: "mini01", kind: "ssh-tmux", endpoint: "x" });
    await assert.rejects(
      updateNode("mini01", { sshCommand: "ssh -F /etc/config" }),
      /must be a single binary path.*--ssh-args="-F \/path\/to\/config"/,
    );
  });
});
