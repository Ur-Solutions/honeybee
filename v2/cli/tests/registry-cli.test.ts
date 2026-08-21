/**
 * WP6a CLI tier — `hive v2 template|track|packages …`: RPC against a live
 * daemon, read-only fallback labeled stale when it is down, file-based
 * export/import round-trip. Temp dirs only; no agents spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import type { MailboxResult, ViewResult } from "../../daemon/src/protocol.ts";
import { interpolateTemplatePrompt, runV2Cli, type CliIo } from "../src/main.ts";
import { stripAnsi } from "../src/style.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(stripAnsi(l)), err: (l) => err.push(stripAnsi(l)) }, out, err };
}

test("regcli.1: template/track/packages against a live daemon — put, list, export → import, import-local", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const scratch = mkdtempSync(join(tmpdir(), "hb-v2-regcli-"));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const base = ["--data-dir", dir];

    // put from a fields file
    const fieldsPath = join(scratch, "fields.json");
    writeFileSync(fieldsPath, JSON.stringify({ name: "commit", agent: "codex", prompt: "Commit the tree." }));
    const p = capture();
    assert.equal(await runV2Cli(["template", "put", "--file", fieldsPath, ...base], p.io), 0);
    assert.ok(p.out[0]?.includes("created") && p.out[0]?.includes("template "), p.out[0]);

    // list (json) — not stale
    const l = capture();
    assert.equal(await runV2Cli(["template", "list", "--json", ...base], l.io), 0);
    const listed = JSON.parse(l.out[0] ?? "{}") as { stale?: boolean; templates: Array<{ id: string; name: string; source: string }> };
    assert.notEqual(listed.stale, true);
    assert.equal(listed.templates[0]?.name, "commit");
    assert.equal(listed.templates[0]?.source, "api");
    const id = listed.templates[0]?.id as string;

    // v1 compatibility: inspect emits the row itself (the commit() shell
    // helper reads `.prompt` directly), while get keeps the v2 wrapper.
    const inspect = capture();
    assert.equal(await runV2Cli(["template", "inspect", "commit", "--data-dir", dir], inspect.io), 0);
    assert.equal((JSON.parse(inspect.out[0] ?? "{}") as { prompt?: string }).prompt, "Commit the tree.");

    // export by name to a file; the file is a v1 package
    const pkgPath = join(scratch, "commit.pkg.json");
    const e = capture();
    assert.equal(await runV2Cli(["template", "export", "commit", "--out", pkgPath, ...base], e.io), 0);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { kind: string; formatVersion: number; id: string };
    assert.equal(pkg.kind, "hive.template");
    assert.equal(pkg.formatVersion, 1);
    assert.equal(pkg.id, id);

    // import the exported file: source becomes package:<path> (updated), then unchanged
    const i1 = capture();
    assert.equal(await runV2Cli(["template", "import", pkgPath, "--json", ...base], i1.io), 0);
    const imp1 = JSON.parse(i1.out[0] ?? "{}") as { outcome: string; template: { source: string } };
    assert.equal(imp1.outcome, "updated");
    assert.equal(imp1.template.source, `package:${pkgPath}`);
    const i2 = capture();
    assert.equal(await runV2Cli(["template", "import", pkgPath, "--json", ...base], i2.io), 0);
    assert.equal((JSON.parse(i2.out[0] ?? "{}") as { outcome: string }).outcome, "unchanged");

    // track put + get by name
    const trackFields = join(scratch, "track.json");
    writeFileSync(trackFields, JSON.stringify({ name: "ship", steps: [{ id: "s1", name: "Build", templateId: id }] }));
    const tp = capture();
    assert.equal(await runV2Cli(["track", "put", "--file", trackFields, ...base], tp.io), 0);
    const tg = capture();
    assert.equal(await runV2Cli(["track", "get", "ship", "--json", ...base], tg.io), 0);
    const track = JSON.parse(tg.out[0] ?? "{}") as { track: { steps: Array<{ templateId: string }> } };
    assert.equal(track.track.steps[0]?.templateId, id);

    // packages import-local from an explicit dir
    const hiveDir = join(scratch, "fake-hive");
    mkdirSync(join(hiveDir, "templates"), { recursive: true });
    writeFileSync(join(hiveDir, "templates", "local.json"), JSON.stringify({ name: "local", bee: "claude", prompt: "hi" }));
    const pl = capture();
    assert.equal(await runV2Cli(["packages", "import-local", "--dir", hiveDir, ...base], pl.io), 0);
    assert.ok(pl.out.some((line) => line.includes("template local: created")), pl.out.join("\n"));

    // delete
    const d = capture();
    assert.equal(await runV2Cli(["template", "delete", "local", ...base], d.io), 0);
    assert.ok(d.out[0]?.includes("deleted") && d.out[0]?.includes("template "));
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("regcli.3: template run and --template execute migrated presets through v2 spawn/send RPC", async () => {
  const { dir, cleanup } = makeDaemonDir({ tickMs: 25 });
  const scratch = mkdtempSync(join(tmpdir(), "hb-v2-template-run-"));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const fields = join(scratch, "worker.json");
    writeFileSync(fields, JSON.stringify({
      name: "worker",
      agent: "stub-auto",
      prompt: "Do {{input}}",
      env: { TEMPLATE_ENV: "from-template" },
      tags: ["preset"],
    }));
    assert.equal(
      await runV2Cli(["template", "put", "--file", fields, "--data-dir", dir], capture().io),
      0,
    );

    const launched = capture();
    assert.equal(
      await runV2Cli([
        "template", "run", "worker", "the commit", "--name", "committer", "--cwd", scratch,
        "--env", "EXPLICIT_ENV=wins", "--data-dir", dir, "--json",
      ], launched.io),
      0,
    );
    const launch = JSON.parse(launched.out[0] ?? "{}") as { beeId: string; messageId: number; agent: string };
    assert.equal(launch.agent, "stub", "legacy <agent>-auto token collapses to v2 agent + auto account");

    const client = await daemon.client();
    const view = await client.request<ViewResult>("view", { beeId: launch.beeId });
    assert.equal(view.bee?.name, "committer");
    assert.equal(view.bee?.cwd, scratch);
    assert.deepEqual(view.bee?.tags, ["preset"]);
    assert.equal(view.bee?.env.TEMPLATE_ENV, "from-template");
    assert.equal(view.bee?.env.EXPLICIT_ENV, "wins");
    await waitFor(async () => {
      const mailbox = await client.request<MailboxResult>("mailbox", { beeId: launch.beeId });
      return mailbox.messages.some((m) => m.id === launch.messageId && m.body === "Do the commit" && m.deliveredAt != null);
    }, "template prompt delivered", 8_000, 25);

    const shorthand = capture();
    assert.equal(
      await runV2Cli(["x", "more guidance", "--template", "worker", "--name", "committer-2", "--cwd", scratch, "--data-dir", dir, "--json"], shorthand.io),
      0,
    );
    assert.ok((JSON.parse(shorthand.out[0] ?? "{}") as { beeId?: string }).beeId);
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("regcli.template-prompt: interpolation replaces placeholders and otherwise appends input", () => {
  assert.equal(interpolateTemplatePrompt("Do {{input}} / {{input}}", "it"), "Do it / it");
  assert.equal(interpolateTemplatePrompt("Do it", "carefully"), "Do it\n\ncarefully");
  assert.equal(interpolateTemplatePrompt("Do it", ""), "Do it");
});

test("regcli.2: template/track reads fall back to the read-only store labeled stale; mutations refuse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-regcli-"));
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.putTemplate({ id: "tpl-1", fields: { name: "offline", agent: "claude", prompt: "p" } });
    store.putTrack({ id: "trk-1", fields: { name: "route", steps: [{ id: "s1", name: "One" }] } });
    store.close();

    const l = capture();
    assert.equal(await runV2Cli(["template", "list", "--data-dir", dir, "--json"], l.io), 0);
    const listed = JSON.parse(l.out[0] ?? "{}") as { stale?: boolean; templates: Array<{ id: string }> };
    assert.equal(listed.stale, true);
    assert.equal(listed.templates[0]?.id, "tpl-1");

    const h = capture();
    assert.equal(await runV2Cli(["track", "list", "--data-dir", dir], h.io), 0);
    assert.ok(h.err[0]?.startsWith("STALE"));
    assert.ok(h.out[0]?.startsWith("stale: trk-1"));

    const g = capture();
    assert.equal(await runV2Cli(["template", "get", "offline", "--data-dir", dir, "--json"], g.io), 0);
    assert.equal((JSON.parse(g.out[0] ?? "{}") as { template: { id: string } }).template.id, "tpl-1");

    // Mutations never fall back.
    const m = capture();
    assert.equal(await runV2Cli(["template", "delete", "offline", "--data-dir", dir], m.io), 1);
    assert.ok(m.err[0]?.includes("daemon not reachable"));
    const pl = capture();
    assert.equal(await runV2Cli(["packages", "import-local", "--dir", dir, "--data-dir", dir], pl.io), 1);
    assert.ok(pl.err[0]?.includes("daemon not reachable"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
