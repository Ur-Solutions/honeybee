/**
 * WP6a — mirror-shape stability (spec 06 §2.2 "the mirror consumes view()
 * verbatim"). These snapshots ARE the contract apiaryd's materializer codes
 * against: if a key is added, renamed, or removed anywhere in the mirror row
 * shapes, this file fails and the change must be treated as a protocol bump.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIRROR_ACCOUNT_AUDIT_KINDS,
  MIRROR_ACCOUNT_KEYS,
  MIRROR_ACCOUNT_LIMITS_AUDIT_KINDS,
  MIRROR_ACCOUNT_LIMITS_KEYS,
  MIRROR_BEE_RECORD_KEYS,
  MIRROR_BEE_ROW_KEYS,
  MIRROR_BEE_VIEW_KEYS,
  MIRROR_QUESTION_AUDIT_KINDS,
  MIRROR_QUESTION_KEYS,
  MIRROR_RUNTIME_KEYS,
  MIRROR_SEAL_AUDIT_KINDS,
  MIRROR_SEAL_KEYS,
  MIRROR_TASK_AUDIT_KINDS,
  MIRROR_TASK_KEYS,
  MIRROR_TASK_SUPPLY_AUDIT_KINDS,
  MIRROR_TASK_SUPPLY_KEYS,
  MIRROR_TEMPLATE_AUDIT_KINDS,
  MIRROR_TEMPLATE_KEYS,
  MIRROR_TRACK_AUDIT_KINDS,
  MIRROR_TRACK_KEYS,
  MIRROR_TRACK_STEP_KEYS,
  type MirrorBeeRow,
  type MirrorSnapshot,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

function keysOf(o: object): string[] {
  return Object.keys(o).sort();
}

test("mirror.1: live rows carry exactly the declared keys — bees (view/bee/runtime), templates, tracks", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    store.updateRuntimeState(bee.id, 1, "running", { pid: 4242, pidStartedAt: h.now() });
    store.recordOutput(bee.id);
    store.setFlag(bee.id, "auth_needed", "login expired");

    const row: MirrorBeeRow = {
      view: store.view(bee.id),
      bee: store.getBee(bee.id),
      runtime: store.currentRuntime(bee.id),
    };
    assert.deepEqual(keysOf(row), [...MIRROR_BEE_ROW_KEYS].sort());
    assert.deepEqual(keysOf(row.view), [...MIRROR_BEE_VIEW_KEYS].sort());
    assert.deepEqual(keysOf(row.bee as object), [...MIRROR_BEE_RECORD_KEYS].sort());
    assert.deepEqual(keysOf(row.runtime as object), [...MIRROR_RUNTIME_KEYS].sort());

    const template = store.putTemplate({
      fields: { name: "t", agent: "claude", prompt: "p", cwdPolicy: "fixed", cwd: "/tmp/x" },
    }).template;
    assert.deepEqual(keysOf(template), [...MIRROR_TEMPLATE_KEYS].sort());

    const track = store.putTrack({
      fields: { name: "k", steps: [{ id: "s1", name: "one", templateId: template.id }] },
    }).track;
    assert.deepEqual(keysOf(track), [...MIRROR_TRACK_KEYS].sort());
    assert.deepEqual(keysOf(track.steps[0] as object), [...MIRROR_TRACK_STEP_KEYS].sort());

    // v6: questions + seals mirror as store rows, verbatim.
    const question = store.askQuestion(bee.id, { text: "which branch?", options: ["main", "dev"] });
    assert.deepEqual(keysOf(question), [...MIRROR_QUESTION_KEYS].sort());
    const answered = store.answerQuestion(question.id, "main").question;
    assert.deepEqual(keysOf(answered), [...MIRROR_QUESTION_KEYS].sort());
    const seal = store.createSeal(bee.id, { title: "done", body: "all green", refs: ["abc123"] });
    assert.deepEqual(keysOf(seal), [...MIRROR_SEAL_KEYS].sort());
    // v7: accounts + limits mirror as store rows, verbatim.
    const account = store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/h", label: "a" });
    assert.deepEqual(keysOf(account), [...MIRROR_ACCOUNT_KEYS].sort());
    const limits = store.putAccountLimits("claude-a", { readable: true, weekly: { usedPercent: 10 } });
    assert.deepEqual(keysOf(limits), [...MIRROR_ACCOUNT_LIMITS_KEYS].sort());
    // v11: tasks + supply mirror as store rows, verbatim.
    const added = store.addTask({
      list: `bee:${bee.id}`,
      title: "paint it",
      originKind: "user",
      originSender: "operator",
    });
    assert.deepEqual(keysOf(added.task), [...MIRROR_TASK_KEYS].sort());
    const supply = store.setTaskSupply(bee.id, { on: true });
    assert.deepEqual(keysOf(supply), [...MIRROR_TASK_SUPPLY_KEYS].sort());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("mirror.2: value-level snapshot — a deterministic store serializes to the frozen mirror document", () => {
  const h = harness();
  try {
    const store = h.open();
    makeBee(store, "alpha");
    // Deterministic ids for the snapshot (createBee mints uuids otherwise).
    const bee = store.listBees()[0];
    assert.ok(bee);
    const template = store.putTemplate({
      id: "tpl-1",
      fields: { name: "commit", agent: "codex", prompt: "Commit.", scope: "team", tags: ["git"], env: { A: "1" } },
    }).template;
    const track = store.putTrack({
      id: "trk-1",
      fields: {
        name: "ship",
        description: "d",
        steps: [{ id: "s1", name: "Build", kind: "action", templateId: "tpl-1", instruction: "go", note: null, status: "pending" }],
      },
    }).track;
    const question = store.askQuestion(bee.id, { id: "q-1", text: "ship it?", options: ["yes", "no"] });
    store.answerQuestion(question.id, "yes", { answeredBy: "operator" });
    const seal = store.createSeal(bee.id, { id: "seal-1", title: "shipped", body: "landed on main", refs: ["main@abc"] });
    const account = store.createAccount({ id: "codex-work", harness: "codex", homePath: "/tmp/homes/codex-work", label: "work", penalty: 5 });
    const limits = store.putAccountLimits(account.id, {
      readable: true,
      plan: "pro",
      fiveHour: { usedPercent: 12, resetsAt: 2_000_000, windowMinutes: 300 },
      weekly: { usedPercent: 40, resetsAt: 3_000_000, windowMinutes: 10_080 },
    });
    const snapshot: MirrorSnapshot = {
      seq: store.lastAuditSeq(),
      bees: [{ view: store.view(bee.id), bee: store.getBee(bee.id), runtime: store.currentRuntime(bee.id) }],
      templates: [template],
      tracks: [track],
      questions: [store.getQuestion(question.id)!],
      seals: [seal],
      accounts: [account],
      accountLimits: [limits],
      tasks: [],
      taskSupply: [],
    };
    // Neutralize the nondeterministic values (bee uuid, minted handle) then freeze.
    const text = JSON.stringify(snapshot, null, 2)
      .replaceAll(bee.id, "BEE_ID")
      .replaceAll(bee.handle as string, "BEE_HANDLE");
    assert.equal(
      text,
      `{
  "seq": 10,
  "bees": [
    {
      "view": {
        "beeId": "BEE_ID",
        "exists": true,
        "lifecycle": "active",
        "generation": 1,
        "runtimeState": "booting",
        "exitCause": null,
        "working": true,
        "waitingForYou": false,
        "lastOutputAt": null,
        "reachable": true,
        "blocked": false,
        "flags": []
      },
      "bee": {
        "id": "BEE_ID",
        "name": "alpha",
        "agent": "claude",
        "substrate": "tmux",
        "cwd": "/tmp/w",
        "title": null,
        "tags": [],
        "sessionLogPath": null,
        "lifecycle": "active",
        "createdAt": 1002000,
        "archivedAt": null,
        "lastOutputAt": null,
        "providerSessionId": null,
        "env": {},
        "importedFrom": null,
        "spawnFailures": 0,
        "args": null,
        "parentId": null,
        "forkedFrom": null,
        "forkSeed": null,
        "account": null,
        "handle": "BEE_HANDLE"
      },
      "runtime": {
        "beeId": "BEE_ID",
        "generation": 1,
        "state": "booting",
        "exitCause": null,
        "pid": null,
        "pidStartedAt": null,
        "bootEvidence": null,
        "startedAt": 1002000,
        "updatedAt": 1002000
      }
    }
  ],
  "templates": [
    {
      "id": "tpl-1",
      "name": "commit",
      "scope": "team",
      "source": "api",
      "description": null,
      "agent": "codex",
      "substrate": null,
      "model": null,
      "effort": null,
      "args": [],
      "prompt": "Commit.",
      "preamble": null,
      "preambleEnabled": true,
      "cwdPolicy": "caller",
      "cwd": null,
      "env": {
        "A": "1"
      },
      "account": null,
      "yolo": false,
      "tags": [
        "git"
      ],
      "createdAt": 1005000,
      "updatedAt": 1005000
    }
  ],
  "tracks": [
    {
      "id": "trk-1",
      "name": "ship",
      "scope": "personal",
      "source": "api",
      "description": "d",
      "steps": [
        {
          "id": "s1",
          "name": "Build",
          "kind": "action",
          "templateId": "tpl-1",
          "instruction": "go",
          "note": null,
          "status": "pending"
        }
      ],
      "tags": [],
      "createdAt": 1007000,
      "updatedAt": 1007000
    }
  ],
  "questions": [
    {
      "id": "q-1",
      "beeId": "BEE_ID",
      "generation": 1,
      "text": "ship it?",
      "options": [
        "yes",
        "no"
      ],
      "status": "answered",
      "answer": "yes",
      "askedAt": 1009000,
      "answeredAt": 1013000,
      "answeredBy": "operator",
      "deliveryMessageId": 1
    }
  ],
  "seals": [
    {
      "id": "seal-1",
      "beeId": "BEE_ID",
      "generation": 1,
      "title": "shipped",
      "body": "landed on main",
      "refs": [
        "main@abc"
      ],
      "createdAt": 1015000
    }
  ],
  "accounts": [
    {
      "id": "codex-work",
      "harness": "codex",
      "homePath": "/tmp/homes/codex-work",
      "label": "work",
      "status": "ok",
      "penalty": 5,
      "lastLoginAt": null,
      "exhaustedAt": null,
      "addedAt": 1017000,
      "updatedAt": 1017000
    }
  ],
  "accountLimits": [
    {
      "account": "codex-work",
      "fetchedAt": 1019000,
      "readable": true,
      "error": null,
      "plan": "pro",
      "fiveHourPct": 12,
      "fiveHourResetsAt": 2000000,
      "fiveHourMinutes": 300,
      "weeklyPct": 40,
      "weeklyResetsAt": 3000000,
      "weeklyMinutes": 10080,
      "fableWeeklyPct": null,
      "fableResetsAt": null,
      "fableMinutes": null
    }
  ],
  "tasks": [],
  "taskSupply": []
}`,
    );
    store.close();
  } finally {
    h.cleanup();
  }
});

test("mirror.3: template/track audit kinds are exactly the declared mirror kinds with the declared payloads", () => {
  const h = harness();
  try {
    const store = h.open();
    const t = store.putTemplate({ fields: { name: "t", agent: "claude", prompt: "p" } }).template;
    store.putTemplate({ fields: { name: "t", agent: "claude", prompt: "p2" } });
    store.deleteTemplate(t.id);
    const k = store.putTrack({ fields: { name: "k" } }).track;
    store.deleteTrack(k.id);
    const rows = store.auditRows().filter((r) => r.kind.startsWith("template.") || r.kind.startsWith("track."));
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["template.put", "template.put", "template.deleted", "track.put", "track.deleted"],
    );
    for (const r of rows) {
      const known = [...MIRROR_TEMPLATE_AUDIT_KINDS, ...MIRROR_TRACK_AUDIT_KINDS] as string[];
      assert.ok(known.includes(r.kind));
    }
    // v6: question/seal audit kinds + payload shapes (the mirror's delta contract).
    const { bee } = makeBee(store, "asker");
    const q = store.askQuestion(bee.id, { text: "which?" });
    store.answerQuestion(q.id, "this");
    store.createSeal(bee.id, { title: "t", body: "b" });
    const v6 = store.auditRows().filter((r) => r.kind.startsWith("question.") || r.kind.startsWith("seal."));
    assert.deepEqual(v6.map((r) => r.kind), ["question.asked", "question.answered", "seal.created"]);
    for (const r of v6) assert.ok(([...MIRROR_QUESTION_AUDIT_KINDS, ...MIRROR_SEAL_AUDIT_KINDS] as string[]).includes(r.kind));
    assert.deepEqual(keysOf(v6[0]!.payload), ["question"]);
    assert.deepEqual(keysOf(v6[1]!.payload), ["answer", "answeredAt", "answeredBy", "beeId", "deliveryMessageId", "questionId"]);
    assert.deepEqual(keysOf(v6[2]!.payload), ["seal"]);
    const [putA, putB, delA, putK, delK] = rows;
    assert.deepEqual(keysOf((putA?.payload ?? {}) as object), ["outcome", "template"]);
    assert.equal(putA?.payload.outcome, "created");
    assert.equal(putB?.payload.outcome, "updated");
    assert.deepEqual(keysOf((delA?.payload ?? {}) as object), ["deletedAt", "templateId"]);
    assert.deepEqual(keysOf((putK?.payload ?? {}) as object), ["outcome", "track"]);
    assert.deepEqual(keysOf((delK?.payload ?? {}) as object), ["deletedAt", "trackId"]);
    // v7: account / limits audit kinds + payload shapes.
    store.createAccount({ id: "claude-x", harness: "claude", homePath: "/tmp/x", label: "x" });
    store.setAccountPenalty("claude-x", 10);
    store.putAccountLimits("claude-x", { readable: false, error: "boom" });
    store.removeAccount("claude-x");
    const v7 = store.auditRows().filter((r) => r.kind.startsWith("account"));
    assert.deepEqual(v7.map((r) => r.kind), ["account.put", "account.put", "account_limits.put", "account.removed"]);
    for (const r of v7) assert.ok(([...MIRROR_ACCOUNT_AUDIT_KINDS, ...MIRROR_ACCOUNT_LIMITS_AUDIT_KINDS] as string[]).includes(r.kind));
    assert.deepEqual(keysOf(v7[0]!.payload), ["account", "outcome"]);
    assert.deepEqual(keysOf(v7[1]!.payload), ["account", "changed", "outcome", "previous", "reason"]);
    assert.deepEqual(keysOf(v7[2]!.payload), ["limits"]);
    assert.deepEqual(keysOf(v7[3]!.payload), ["accountId", "cursorCleared", "harness", "removedAt"]);
    // v11: task / supply audit kinds + payload shapes.
    const added = store.addTask({
      list: `bee:${bee.id}`,
      title: "one",
      originKind: "user",
      originSender: "operator",
    });
    store.setTaskSupply(bee.id, { on: true });
    const v11 = store.auditRows().filter((r) => r.kind === "task.put" || r.kind === "task_supply.put");
    assert.equal(v11[0]?.kind, "task.put");
    assert.equal(v11[1]?.kind, "task_supply.put");
    for (const r of v11) assert.ok(([...MIRROR_TASK_AUDIT_KINDS, ...MIRROR_TASK_SUPPLY_AUDIT_KINDS] as string[]).includes(r.kind));
    assert.deepEqual(keysOf(v11[0]!.payload), ["outcome", "task"]);
    assert.equal(v11[0]?.payload.outcome, "created");
    assert.equal((v11[0]?.payload.task as { id: string }).id, added.task.id);
    assert.deepEqual(keysOf(v11[1]!.payload), ["supply"]);
    store.close();
  } finally {
    h.cleanup();
  }
});
