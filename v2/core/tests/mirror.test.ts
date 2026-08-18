/**
 * WP6a — mirror-shape stability (spec 06 §2.2 "the mirror consumes view()
 * verbatim"). These snapshots ARE the contract apiaryd's materializer codes
 * against: if a key is added, renamed, or removed anywhere in the mirror row
 * shapes, this file fails and the change must be treated as a protocol bump.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIRROR_BEE_RECORD_KEYS,
  MIRROR_BEE_ROW_KEYS,
  MIRROR_BEE_VIEW_KEYS,
  MIRROR_RUNTIME_KEYS,
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
    const snapshot: MirrorSnapshot = {
      seq: store.lastAuditSeq(),
      bees: [{ view: store.view(bee.id), bee: store.getBee(bee.id), runtime: store.currentRuntime(bee.id) }],
      templates: [template],
      tracks: [track],
    };
    // Neutralize the one nondeterministic value (bee uuid) then freeze.
    const text = JSON.stringify(snapshot, null, 2).replaceAll(bee.id, "BEE_ID");
    assert.equal(
      text,
      `{
  "seq": 4,
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
        "args": null
      },
      "runtime": {
        "beeId": "BEE_ID",
        "generation": 1,
        "state": "booting",
        "exitCause": null,
        "pid": null,
        "pidStartedAt": null,
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
  ]
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
    const [putA, putB, delA, putK, delK] = rows;
    assert.deepEqual(keysOf((putA?.payload ?? {}) as object), ["outcome", "template"]);
    assert.equal(putA?.payload.outcome, "created");
    assert.equal(putB?.payload.outcome, "updated");
    assert.deepEqual(keysOf((delA?.payload ?? {}) as object), ["deletedAt", "templateId"]);
    assert.deepEqual(keysOf((putK?.payload ?? {}) as object), ["outcome", "track"]);
    assert.deepEqual(keysOf((delK?.payload ?? {}) as object), ["deletedAt", "trackId"]);
    store.close();
  } finally {
    h.cleanup();
  }
});
