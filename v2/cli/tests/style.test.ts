import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionLine,
  formatTable,
  stalePrefix,
  stripAnsi,
  truncate,
  visibleLength,
} from "../src/style.ts";
import { derivedLabel, runtimeLabel, viewLine } from "../src/render.ts";
import { helpText } from "../src/help.ts";
import type { ViewResult } from "../../daemon/src/protocol.ts";

test("style.stripAnsi / visibleLength ignore SGR and count cells", () => {
  const painted = `\x1b[1;33mCL.a3f2\x1b[0m`;
  assert.equal(stripAnsi(painted), "CL.a3f2");
  assert.equal(visibleLength(painted), 7);
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});

test("style.actionLine: live mutations get an icon; deduped keeps the one-key prefix", () => {
  const live = stripAnsi(actionLine("ok", "spawned", "CL.a3f2 (bee-1)"));
  assert.match(live, /^✓ {2}spawned CL\.a3f2 \(bee-1\)$/);
  const dedup = stripAnsi(actionLine("ok", "already sent message", "12 to bee-1", true));
  assert.equal(dedup, "deduped: already sent message 12 to bee-1");
});

test("style.formatTable aligns headers and a rule to the body", () => {
  const lines = formatTable(
    [{ header: "HANDLE" }, { header: "NAME" }],
    [["CL.a3f2", "prettybee"], ["CO.bb", "x"]],
  ).map(stripAnsi);
  assert.match(lines[0] ?? "", /HANDLE\s+NAME/);
  assert.match(lines[1] ?? "", /─+\s+─+/);
  assert.ok((lines[2] ?? "").startsWith("CL.a3f2"));
  assert.ok((lines[2] ?? "").includes("prettybee"));
});

test("render.viewLine keeps the greppable tokens operators and tests rely on", () => {
  const v = {
    view: {
      beeId: "aaaa1111-0000-0000-0000-000000000001",
      exists: true,
      lifecycle: "active",
      generation: 2,
      runtimeState: "stopped",
      exitCause: "crashed",
      working: false,
      waitingForYou: false,
      lastOutputAt: null,
      reachable: true,
      blocked: true,
      flags: ["spawn_failed"],
    },
    bee: {
      id: "aaaa1111-0000-0000-0000-000000000001",
      handle: "ST.ab12",
      name: "prettybee",
      agent: "stub",
      substrate: "hsr",
      args: ["--model", "fable"],
      spawnFailures: 2,
      tags: ["apiary:workspace=ops"],
      parentId: "parent-1",
    },
    runtime: null,
  } as unknown as ViewResult;
  assert.equal(runtimeLabel(v), "stopped(crashed)");
  assert.equal(derivedLabel(v), "quiet");
  const line = stripAnsi(viewLine(v, true));
  assert.ok(line.startsWith("stale: "));
  assert.ok(line.includes("ST.ab12"));
  assert.ok(line.includes("prettybee"));
  assert.ok(line.includes("agent=stub"));
  assert.ok(line.includes("gen=2"));
  assert.ok(line.includes("stopped(crashed)"));
  assert.ok(line.includes("quiet"));
  assert.ok(line.includes("active"));
  assert.ok(line.includes("flags=spawn_failed"));
  assert.ok(line.includes("bootFailures=2"));
  assert.ok(line.includes('args=["--model","fable"]'));
  assert.ok(line.includes("parent=parent-1"));
  assert.ok(line.includes("tags=apiary:workspace=ops"));
  assert.ok(line.includes("id=aaaa1111-0000-0000-0000-000000000001"));
  assert.equal(stalePrefix(false), "");
});

test("helpText keeps the grouped v1-style overview tokens", () => {
  const text = stripAnsi(helpText("0.0.1"));
  assert.ok(text.includes("hive <command>"));
  assert.ok(text.includes("hive spawn"));
  assert.ok(text.includes("hive v2"), "compatibility alias still documented");
  for (const section of ["Spawn & run:", "Message:", "Observe:", "Manage bees:", "Accounts:", "Daemon:"]) {
    assert.ok(text.includes(section), `help has section ${section}`);
  }
  for (const verb of [
    "x <name>",
    "run <name> -p",
    "transcript <bee>",
    "tail <bee>",
    "last <bee>",
    "wait <bee>",
    "events [",
    "here [",
    "usage [",
    "set-model <bee>",
    "attach <bee>",
    "swap-account <bee>",
  ]) {
    assert.ok(text.includes(verb), `help mentions ${verb}`);
  }
  assert.match(text, /daemon install\|uninstall\|start\|stop\|restart\|status/);
});
