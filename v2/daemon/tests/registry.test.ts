/**
 * WP6a integration tier — template/track/package RPC verbs over the real
 * socket, and the watch stream carrying registry audit rows so apiaryd can
 * materialize templates/tracks exactly like bees (spec 06 §1.4.1, §2).
 * SAFETY: temp dirs only; no agents are spawned in this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SnapshotResult,
  TemplateExportResult,
  TemplateGetResult,
  TemplateImportResult,
  TemplateListResult,
  TemplatePutResult,
  TrackImportResult,
  TrackListResult,
  TrackPutResult,
  ImportLocalConfigResult,
  WatchFrame,
} from "../src/protocol.ts";
import { RpcError } from "../src/protocol.ts";
import type { AuditRow } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const templateFields = {
  name: "commit",
  agent: "codex",
  prompt: "Commit the tree.",
  model: "gpt-5.6-sol",
  tags: ["git"],
};

test("reg.1: template/track verb round-trips — put/get/list/export/import/delete, typed refusals", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const c = await daemon.client();

    const put = await c.request<TemplatePutResult>("template.put", { fields: templateFields });
    assert.equal(put.outcome, "created");
    assert.equal(put.template.source, "api");
    const again = await c.request<TemplatePutResult>("template.put", { fields: templateFields });
    assert.equal(again.outcome, "unchanged");
    assert.equal(again.template.id, put.template.id);

    const got = await c.request<TemplateGetResult>("template.get", { id: put.template.id });
    assert.deepEqual(got.template, put.template);
    const list = await c.request<TemplateListResult>("template.list", { scope: "personal" });
    assert.deepEqual(list.templates.map((t) => t.id), [put.template.id]);

    // export → import round-trip through the wire.
    const exported = await c.request<TemplateExportResult>("template.export", { id: put.template.id });
    assert.equal(exported.package.kind, "hive.template");
    assert.equal(exported.package.formatVersion, 1);
    assert.equal(exported.text, `${JSON.stringify(exported.package, null, 2)}\n`);
    const imported = await c.request<TemplateImportResult>("template.import", {
      package: exported.package,
      source: "/repo/.hive/commit.json",
    });
    assert.equal(imported.template.id, put.template.id);
    assert.equal(imported.outcome, "updated", "source api → package:… is a recorded change");
    assert.equal(imported.template.source, "package:/repo/.hive/commit.json");
    const reimported = await c.request<TemplateImportResult>("template.import", {
      package: exported.package,
      source: "/repo/.hive/commit.json",
    });
    assert.equal(reimported.outcome, "unchanged", "same package twice = one row");

    // Tracks: same surface.
    const tput = await c.request<TrackPutResult>("track.put", {
      fields: { name: "ship", steps: [{ id: "s1", name: "Build", templateId: put.template.id }] },
    });
    assert.equal(tput.outcome, "created");
    const tlist = await c.request<TrackListResult>("track.list");
    assert.equal(tlist.tracks.length, 1);
    const timp = await c.request<TrackImportResult>("track.import", {
      package: { kind: "hive.track", formatVersion: 1, name: "ship-2", steps: [] },
      source: "x.json",
      scope: "repo",
    });
    assert.equal(timp.track.scope, "repo");
    assert.equal(timp.track.source, "package:x.json");

    // Typed refusals from the closed list.
    await assert.rejects(c.request("template.get", { id: "nope" }), (err: unknown) => err instanceof RpcError && err.code === "template_not_found");
    await assert.rejects(c.request("track.delete", { id: "nope" }), (err: unknown) => err instanceof RpcError && err.code === "track_not_found");
    await assert.rejects(
      c.request("template.put", { id: "other-id", fields: templateFields }),
      (err: unknown) => err instanceof RpcError && err.code === "name_conflict",
    );
    await assert.rejects(
      c.request("template.import", { package: { kind: "hive.template", formatVersion: 99 } }),
      (err: unknown) => err instanceof RpcError && err.code === "invalid_package",
    );
    await assert.rejects(
      c.request("template.put", { fields: { name: "x", agent: "claude", prompt: "p", scope: "cosmic" } }),
      (err: unknown) => err instanceof RpcError && err.code === "invalid_package",
    );

    // delete settles the registry.
    await c.request("template.delete", { id: put.template.id });
    const after = await c.request<TemplateListResult>("template.list");
    assert.equal(after.templates.length, 0);
    c.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("reg.2: snapshot carries mirror-shaped template/track rows; watch deltas stream registry audit rows seq-ordered", async () => {
  const { dir, cleanup } = makeDaemonDir({ tickMs: 40 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const writer = await daemon.client();
    await writer.request<TemplatePutResult>("template.put", { fields: templateFields });

    const watcher = await daemon.client();
    const events: AuditRow[] = [];
    let cursor = -1;
    let chainBroken = false;
    watcher.onEvent = (frame: WatchFrame) => {
      if (frame.type === "gap") return;
      if (frame.baseSeq !== cursor) chainBroken = true;
      cursor = frame.seq;
      events.push(...frame.events);
    };
    const snap = await watcher.request<SnapshotResult>("watch");
    cursor = snap.seq;
    // The snapshot IS the mirror: bees + templates + tracks at one seq.
    assert.equal(snap.templates.length, 1);
    assert.equal(snap.templates[0]?.name, "commit");
    assert.deepEqual(snap.tracks, []);
    assert.ok(Object.keys(snap.templates[0] as object).includes("source"));

    // Mutations after the snapshot arrive as audit-row deltas.
    const put2 = await writer.request<TemplatePutResult>("template.put", { fields: { ...templateFields, effort: "high" } });
    const tput = await writer.request<TrackPutResult>("track.put", { fields: { name: "ship" } });
    await writer.request("track.delete", { id: tput.track.id });
    await waitFor(() => events.filter((e) => e.kind.startsWith("template.") || e.kind.startsWith("track.")).length >= 3, "registry deltas", 8000);
    assert.equal(chainBroken, false, "seq chain stays contiguous");
    const regEvents = events.filter((e) => e.kind.startsWith("template.") || e.kind.startsWith("track."));
    assert.deepEqual(regEvents.map((e) => e.kind), ["template.put", "track.put", "track.deleted"]);
    const puttedTemplate = regEvents[0]?.payload.template as { id: string; effort: string };
    assert.equal(puttedTemplate.id, put2.template.id);
    assert.equal(puttedTemplate.effort, "high", "delta payload carries the full mirror row");
    // Deltas are strictly seq-ascending from the snapshot.
    let last = snap.seq;
    for (const e of events) {
      assert.ok(e.seq > last, `seq ${e.seq} after ${last}`);
      last = e.seq;
    }
    watcher.close();
    writer.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("reg.3: packages.importLocalConfig over RPC — explicit dir, idempotent, reports skips", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    // A fake ~/.hive layout inside the temp daemon dir.
    const hiveDir = join(dir, "fake-hive");
    mkdirSync(join(hiveDir, "templates"), { recursive: true });
    mkdirSync(join(hiveDir, "tracks", "definitions"), { recursive: true });
    writeFileSync(
      join(hiveDir, "templates", "commit.json"),
      JSON.stringify({ name: "commit", bee: "codex-auto", prompt: "Commit.", cwd: "caller" }),
    );
    writeFileSync(join(hiveDir, "templates", "bad.json"), "{broken");
    writeFileSync(
      join(hiveDir, "tracks", "definitions", "demo.json"),
      JSON.stringify({ schemaVersion: 2, name: "demo", version: 1, items: [{ id: "n1", name: "One", type: "action" }] }),
    );

    daemon = await startDaemon(dir);
    const c = await daemon.client();
    const r1 = await c.request<ImportLocalConfigResult>("packages.importLocalConfig", { dir: hiveDir });
    assert.deepEqual(r1.templates.map((t) => [t.name, t.outcome]), [["commit", "created"]]);
    assert.deepEqual(r1.tracks.map((t) => [t.name, t.outcome]), [["demo", "created"]]);
    assert.equal(r1.skipped.length, 1);
    const r2 = await c.request<ImportLocalConfigResult>("packages.importLocalConfig", { dir: hiveDir });
    assert.ok(r2.templates.every((t) => t.outcome === "unchanged"));
    assert.ok(r2.tracks.every((t) => t.outcome === "unchanged"));
    const list = await c.request<TemplateListResult>("template.list");
    assert.equal(list.templates[0]?.source, "local-config");
    c.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
