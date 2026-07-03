import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUZ_TIERS } from "../src/buz.js";
import { fileCandidates, getCompletionsFromState, shellScript } from "../src/completion.js";
import type { SessionRecord } from "../src/store.js";

function session(name: string, tmuxTarget: string, id?: string): SessionRecord {
  return {
    name,
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "running",
    id,
  };
}

const empty = { records: [], liveTargets: new Set<string>() };

test("completes commands when no command typed", () => {
  assert.ok(getCompletionsFromState(["hive", ""], empty).includes("spawn"));
  assert.ok(getCompletionsFromState(["hive", ""], empty).includes("send"));
  assert.ok(getCompletionsFromState(["hive", ""], empty).includes("completion"));
});

test("completes commands with no args at all", () => {
  assert.ok(getCompletionsFromState([], empty).includes("spawn"));
  assert.ok(getCompletionsFromState(["hive"], empty).includes("send"));
});

test("registers the Phase-1 keybinding verbs and their flags/subs", () => {
  const top = getCompletionsFromState(["hive", ""], empty);
  for (const cmd of ["spawn-picker", "urls", "keys"]) {
    assert.ok(top.includes(cmd), `top-level completion includes ${cmd}`);
  }
  // keys subcommands.
  assert.deepEqual(getCompletionsFromState(["hive", "keys", ""], empty), ["print", "path", "check"]);
  // spawn-picker flags.
  assert.deepEqual(getCompletionsFromState(["hive", "spawn-picker", "--"], empty), ["--frame", "--flow", "--here"]);
  // urls flags.
  assert.deepEqual(getCompletionsFromState(["hive", "urls", "--"], empty), ["--lines", "--open", "--json"]);
  // rename gains --here alongside --auto/--clear.
  assert.deepEqual(getCompletionsFromState(["hive", "rename", "--"], empty), ["--auto", "--clear", "--here"]);
  // workspace here subcommand.
  assert.ok(getCompletionsFromState(["hive", "workspace", ""], empty).includes("here"));
});

test("completes top-level flags when current word starts with dash", () => {
  assert.deepEqual(getCompletionsFromState(["hive", "--"], empty), ["--version", "--help"]);
});

test("completes bees as first arg of spawn and run", () => {
  const candidates = getCompletionsFromState(["hive", "spawn", ""], empty);
  assert.ok(candidates.includes("claude"));
  assert.ok(candidates.includes("codex"));
  assert.ok(candidates.includes("codex2"));
  assert.ok(candidates.includes("cc3"));

  const runCandidates = getCompletionsFromState(["hive", "run", ""], empty);
  assert.ok(runCandidates.includes("droid"));

  const xCandidates = getCompletionsFromState(["hive", "x", ""], empty);
  assert.ok(xCandidates.includes("claude"));
  assert.ok(xCandidates.includes("codex2"));
});

test("lists x in top-level commands and completes its flags", () => {
  assert.ok(getCompletionsFromState(["hive", ""], empty).includes("x"));
  const flags = getCompletionsFromState(["hive", "x", "claude", "--"], empty);
  assert.ok(flags.includes("--prompt"));
  assert.ok(flags.includes("--force-send"));
  assert.ok(flags.includes("--cwd"));
});

test("completes shells as first arg of completion", () => {
  assert.deepEqual(getCompletionsFromState(["hive", "completion", ""], empty), ["bash", "zsh", "fish"]);
});

test("completes only live sessions for send/tail/transcript/last/wait/attach", () => {
  const records = [
    session("brave-otter", "brave-otter-target", "CO.abc"),
    session("dead-bee", "dead-bee-target", "CO.def"),
  ];
  const state = { records, liveTargets: new Set(["brave-otter-target"]) };

  for (const cmd of ["send", "tail", "transcript", "wait", "attach"]) {
    const candidates = getCompletionsFromState(["hive", cmd, ""], state);
    assert.ok(candidates.includes("CO.abc"), `${cmd} should include live ref`);
    assert.ok(!candidates.includes("CO.def"), `${cmd} should exclude dead ref`);
  }
});

test("completes both live and dead sessions for last/seal (post-mortem allowed)", () => {
  const records = [
    session("brave-otter", "brave-otter-target", "CO.abc"),
    session("dead-bee", "dead-bee-target", "CO.def"),
  ];
  const state = { records, liveTargets: new Set(["brave-otter-target"]) };
  for (const cmd of ["last", "seal"]) {
    const candidates = getCompletionsFromState(["hive", cmd, ""], state);
    assert.ok(candidates.includes("CO.abc"), `${cmd} should include live ref`);
    assert.ok(candidates.includes("CO.def"), `${cmd} should include dead ref`);
  }
});

test("completes all sessions (live and dead) for kill", () => {
  const records = [
    session("alive", "alive-target", "CO.abc"),
    session("departed", "departed-target", "CO.def"),
  ];
  const state = { records, liveTargets: new Set(["alive-target"]) };

  const candidates = getCompletionsFromState(["hive", "kill", ""], state);
  assert.ok(candidates.includes("CO.abc"));
  assert.ok(candidates.includes("CO.def"));
});

test("completes flags when current word starts with dash", () => {
  const candidates = getCompletionsFromState(["hive", "spawn", "--"], empty);
  assert.ok(candidates.includes("--name"));
  assert.ok(candidates.includes("--cwd"));
  assert.ok(candidates.includes("--yolo"));

  const cleanFlags = getCompletionsFromState(["hive", "clean", "--"], empty);
  assert.ok(cleanFlags.includes("--dead"));
  assert.ok(cleanFlags.includes("--dry-run"));
});

test("returns empty for second positional arg of send (prompt is freeform)", () => {
  const records = [session("brave-otter", "brave-otter-target", "CO.abc")];
  const state = { records, liveTargets: new Set(["brave-otter-target"]) };
  assert.deepEqual(getCompletionsFromState(["hive", "send", "brave-otter", ""], state), []);
});

test("skips a flag and its value when counting positional index", () => {
  const candidates = getCompletionsFromState(["hive", "run", "--cwd", "/tmp", ""], empty);
  assert.ok(candidates.includes("claude"), "should still suggest bees as first positional");
});

test("boolean flags do not swallow the following positional", () => {
  // --yolo is boolean: "claude" is the first positional, so the next slot
  // is the freeform prompt — not another bee suggestion.
  assert.deepEqual(getCompletionsFromState(["hive", "run", "--yolo", "claude", ""], empty), []);
  // And before the first positional, bees are still suggested.
  assert.ok(getCompletionsFromState(["hive", "run", "--yolo", ""], empty).includes("claude"));

  // Same accounting for noun subcommands: --json must not eat "run".
  const state = {
    records: [],
    liveTargets: new Set<string>(),
    flows: [{ name: "deploy", run: () => undefined }],
  };
  assert.deepEqual(getCompletionsFromState(["hive", "flow", "--json", "run", ""], state), ["deploy"]);
});

test("returns empty for unknown command", () => {
  assert.deepEqual(getCompletionsFromState(["hive", "nope", ""], empty), []);
});

test("strips absolute paths to hive binary", () => {
  const candidates = getCompletionsFromState(["/usr/local/bin/hive", "spawn", ""], empty);
  assert.ok(candidates.includes("claude"));
});

test("emits shell scripts for bash, zsh, fish", () => {
  assert.match(shellScript("bash"), /complete -F _hive_complete hive/);
  assert.match(shellScript("zsh"), /#compdef hive/);
  assert.match(shellScript("fish"), /complete -c hive/);
});

test("rejects unsupported shells", () => {
  assert.throws(() => shellScript("pwsh"), /Unsupported shell: pwsh/);
});

test("completes colony names after --colony", () => {
  const state = {
    records: [],
    liveTargets: new Set<string>(),
    colonies: [
      { name: "marketing", createdAt: "2026-05-28T00:00:00Z" },
      { name: "ops", createdAt: "2026-05-28T00:00:00Z" },
      { name: "legacy", createdAt: "2026-05-28T00:00:00Z", archived: true },
    ],
  };
  const candidates = getCompletionsFromState(["hive", "spawn", "claude", "--colony", ""], state);
  assert.deepEqual(candidates.sort(), ["marketing", "ops"]);
});

test("completes swarm ids after --swarm and --swarm-id", () => {
  const state = {
    records: [],
    liveTargets: new Set<string>(),
    swarms: [
      { id: "deep-review-7a3f2c", beeIds: [], createdAt: "2026-05-28T00:00:00Z" },
      { id: "swarm-1a2b3c", beeIds: [], createdAt: "2026-05-28T00:00:00Z" },
      { id: "gone-aabbcc", beeIds: [], createdAt: "2026-05-28T00:00:00Z", destroyed: true },
    ],
  };
  assert.deepEqual(
    getCompletionsFromState(["hive", "list", "--swarm", ""], state).sort(),
    ["deep-review-7a3f2c", "swarm-1a2b3c"],
  );
  assert.deepEqual(
    getCompletionsFromState(["hive", "spawn", "claude", "--swarm-id", ""], state).sort(),
    ["deep-review-7a3f2c", "swarm-1a2b3c"],
  );
});

test("completes frame names after --frame", () => {
  const state = {
    records: [],
    liveTargets: new Set<string>(),
    frames: [
      { name: "deep-review", castes: [{ name: "x", bee: "claude", count: 1 }] },
      { name: "frontend-redesign", castes: [{ name: "x", bee: "codex", count: 1 }] },
    ],
  };
  assert.deepEqual(
    getCompletionsFromState(["hive", "spawn", "--frame", ""], state).sort(),
    ["deep-review", "frontend-redesign"],
  );
});

test("completes buz tier and accept values from BUZ_TIERS", () => {
  assert.deepEqual(getCompletionsFromState(["hive", "buz", "send", "CO.abc", "--tier", ""], empty), [...BUZ_TIERS]);

  const accept = getCompletionsFromState(["hive", "buz", "config", "CO.abc", "--accept", ""], empty);
  for (const tier of BUZ_TIERS) assert.ok(accept.includes(tier), `accept completion includes ${tier}`);
  assert.ok(accept.includes(BUZ_TIERS.join(",")), "accept completion includes the full tier chain");
});

test("completes subcommands for noun commands", () => {
  const empty = { records: [], liveTargets: new Set<string>() };
  assert.deepEqual(getCompletionsFromState(["hive", "colony", ""], empty).sort(), ["archive", "create", "inspect", "list", "ls", "rename", "update"]);
  assert.deepEqual(getCompletionsFromState(["hive", "frame", ""], empty).sort(), ["define", "edit", "inspect", "list", "ls", "reload", "remove", "update"]);
  assert.deepEqual(getCompletionsFromState(["hive", "swarm", ""], empty).sort(), ["destroy", "inspect", "list", "ls"]);
});

test("completes colony names as the second arg of colony archive/inspect", () => {
  const state = {
    records: [],
    liveTargets: new Set<string>(),
    colonies: [
      { name: "marketing", createdAt: "2026-05-28T00:00:00Z" },
      { name: "ops", createdAt: "2026-05-28T00:00:00Z" },
    ],
  };
  assert.deepEqual(getCompletionsFromState(["hive", "colony", "archive", ""], state).sort(), ["marketing", "ops"]);
  assert.deepEqual(getCompletionsFromState(["hive", "colony", "inspect", ""], state).sort(), ["marketing", "ops"]);
});

test("completes prefixed swarm refs as the second arg of swarm inspect/destroy", () => {
  const state = {
    records: [],
    liveTargets: new Set<string>(),
    swarms: [
      { id: "deep-review-7a3f2c", beeIds: [], createdAt: "2026-05-28T00:00:00Z" },
      { id: "swarm-1a2b3c", beeIds: [], createdAt: "2026-05-28T00:00:00Z" },
    ],
  };
  assert.deepEqual(
    getCompletionsFromState(["hive", "swarm", "inspect", ""], state).sort(),
    ["@deep-review-7a3f2c", "@swarm-1a2b3c"],
  );
  assert.deepEqual(
    getCompletionsFromState(["hive", "swarm", "destroy", ""], state).sort(),
    ["@deep-review-7a3f2c", "@swarm-1a2b3c"],
  );
});

test("frame define autocompletes files (json/ts) and directories from cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-fcomp-"));
  try {
    await writeFile(join(dir, "deep-review.json"), "{}");
    await writeFile(join(dir, "house.ts"), "");
    await writeFile(join(dir, "ignore.md"), "");
    await mkdir(join(dir, "sub"));

    const state = { records: [], liveTargets: new Set<string>(), cwd: dir };
    const empty = getCompletionsFromState(["hive", "frame", "define", ""], state).sort();
    assert.deepEqual(empty, ["deep-review.json", "house.ts", "sub/"]);

    const prefixed = getCompletionsFromState(["hive", "frame", "define", "deep"], state);
    assert.deepEqual(prefixed, ["deep-review.json"]);

    const absoluteState = { records: [], liveTargets: new Set<string>(), cwd: "/" };
    const inDir = getCompletionsFromState(["hive", "frame", "define", `${dir}/`], absoluteState).sort();
    assert.deepEqual(inDir, [`${dir}/deep-review.json`, `${dir}/house.ts`, `${dir}/sub/`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fileCandidates filters by extension and returns directories with trailing slash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-fc-"));
  try {
    await writeFile(join(dir, "a.json"), "");
    await writeFile(join(dir, "b.ts"), "");
    await writeFile(join(dir, "c.yaml"), "");
    await mkdir(join(dir, "nested"));
    const candidates = fileCandidates("", [".json", ".ts"], dir).sort();
    assert.deepEqual(candidates, ["a.json", "b.ts", "nested/"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completes frame names as the second arg of frame inspect/remove", () => {
  const state = {
    records: [],
    liveTargets: new Set<string>(),
    frames: [
      { name: "deep-review", castes: [{ name: "x", bee: "claude", count: 1 }] },
    ],
  };
  assert.deepEqual(getCompletionsFromState(["hive", "frame", "inspect", ""], state), ["deep-review"]);
  assert.deepEqual(getCompletionsFromState(["hive", "frame", "remove", ""], state), ["deep-review"]);
});

const NODE_STATE_BASE = {
  records: [],
  liveTargets: new Set<string>(),
  nodes: [
    { name: "local", kind: "local-tmux" as const, endpoint: "localhost", capabilities: ["*"], createdAt: "0", updatedAt: "0" },
    { name: "mini01", kind: "ssh-tmux" as const, endpoint: "trmd@mini01", capabilities: ["claude", "codex"], createdAt: "0", updatedAt: "0" },
    { name: "modal", kind: "ssh-tmux" as const, endpoint: "trmd@modal", capabilities: ["*"], createdAt: "0", updatedAt: "0" },
  ],
};

test("completes node names after --node on spawn and run", () => {
  const candidates = getCompletionsFromState(["hive", "spawn", "claude", "--node", ""], NODE_STATE_BASE);
  assert.deepEqual(candidates.sort(), ["local", "mini01", "modal"]);
  const runCandidates = getCompletionsFromState(["hive", "run", "codex", "--node", ""], NODE_STATE_BASE);
  assert.deepEqual(runCandidates.sort(), ["local", "mini01", "modal"]);
});

test("completes kinds after --kind on node register", () => {
  const candidates = getCompletionsFromState(["hive", "node", "register", "mini01", "--kind", ""], NODE_STATE_BASE);
  assert.deepEqual(candidates.sort(), ["local-tmux", "ssh-tmux"]);
});

test("completes subcommands for node and substrate", () => {
  const empty = { records: [], liveTargets: new Set<string>() };
  assert.deepEqual(
    getCompletionsFromState(["hive", "node", ""], empty).sort(),
    ["inspect", "list", "ls", "register", "unregister", "update"],
  );
  assert.deepEqual(getCompletionsFromState(["hive", "substrate", ""], empty), ["list", "ls"]);
});

test("completes node names as the second arg of node inspect/update/unregister", () => {
  for (const sub of ["inspect", "update", "unregister"]) {
    const candidates = getCompletionsFromState(["hive", "node", sub, ""], NODE_STATE_BASE);
    assert.deepEqual(candidates.sort(), ["local", "mini01", "modal"]);
  }
});

test("--node and --kind are listed in spawn / node flag completion", () => {
  const spawnFlags = getCompletionsFromState(["hive", "spawn", "claude", "--"], NODE_STATE_BASE);
  assert.ok(spawnFlags.includes("--node"), "spawn flags include --node");
  const nodeFlags = getCompletionsFromState(["hive", "node", "register", "mini01", "--"], NODE_STATE_BASE);
  assert.ok(nodeFlags.includes("--kind"), "node flags include --kind");
  assert.ok(nodeFlags.includes("--endpoint"), "node flags include --endpoint");
  assert.ok(nodeFlags.includes("--capabilities"), "node flags include --capabilities");
});

test("completes quest statuses separately from seal statuses", () => {
  assert.deepEqual(getCompletionsFromState(["hive", "quest", "--status", ""], empty), ["open", "active", "done", "archived"]);
  assert.deepEqual(getCompletionsFromState(["hive", "search", "--status", ""], empty), ["done", "blocked", "needs_input", "failed"]);
  assert.deepEqual(getCompletionsFromState(["hive", "seals", "--status", ""], empty), ["done", "blocked", "needs_input", "failed"]);
});
