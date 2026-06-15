// The spec's smoke test, against a throwaway tmux server on a private socket
// dir: spawn 2 fake bees (sleep as the agent), build a view, assert window
// links, close the view, assert both bees alive, kill the test server.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { hasSession, tmux } from "../src/substrates/local-tmux.js";
import { buildView, closeView, createGroupedView } from "../src/view.js";

process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), "hive-view-itest-"));
delete process.env.TMUX;

after(async () => {
  await tmux(["kill-server"], { reject: false });
  rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
});

async function links(): Promise<string[]> {
  const result = await tmux(["list-windows", "-a", "-F", "#{window_id} #{session_name}"]);
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

test("view: link, dedupe on re-run, grouped client, close leaves bees alive", { timeout: 60_000 }, async () => {
  await tmux(["new-session", "-d", "-s", "CL-v1", "sleep 120"]);
  await tmux(["new-session", "-d", "-s", "CL-v2", "sleep 120"]);

  // Build: the cockpit contains exactly the two bees — no anchor/lobby window.
  const built = await buildView("t1", ["CL-v1", "CL-v2"]);
  assert.equal(built.session, "view-t1");
  assert.equal(built.created, true);
  assert.deepEqual(built.linked.sort(), ["CL-v1", "CL-v2"]);
  const after1 = await links();
  const v1Window = after1.find((l) => l.endsWith(" CL-v1"))!.split(" ")[0];
  const v2Window = after1.find((l) => l.endsWith(" CL-v2"))!.split(" ")[0];
  assert.ok(after1.includes(`${v1Window} view-t1`), "CL-v1 window linked into view");
  assert.ok(after1.includes(`${v2Window} view-t1`), "CL-v2 window linked into view");
  // The throwaway placeholder must be gone: view-t1 has exactly 2 windows,
  // both of them bees (no leftover "hive" shell occupying a slot).
  const viewWindows = (await tmux(["list-windows", "-t", "=view-t1", "-F", "#{window_id}"])).stdout
    .split("\n").map((s) => s.trim()).filter(Boolean);
  assert.equal(viewWindows.length, 2, "view holds only the 2 bees, no placeholder");
  assert.deepEqual(viewWindows.sort(), [v1Window, v2Window].sort(), "every view window is a bee");

  // Dedupe: re-running links nothing new.
  const again = await buildView("t1", ["CL-v1", "CL-v2"]);
  assert.equal(again.created, false);
  assert.deepEqual(again.linked, []);
  assert.equal(again.alreadyLinked, 2);
  assert.equal((await links()).length, after1.length, "no duplicate links on re-run");

  // Grown swarm: a third bee links incrementally.
  await tmux(["new-session", "-d", "-s", "CL-v3", "sleep 120"]);
  const grown = await buildView("t1", ["CL-v1", "CL-v2", "CL-v3"]);
  assert.deepEqual(grown.linked, ["CL-v3"]);

  // Grouped session shares the windows under an independent name.
  const grouped = await createGroupedView("t1");
  assert.equal(grouped, "view-t1-2");
  assert.equal(await hasSession("view-t1-2"), true);

  // Close: view (and its grouped client) gone, every bee alive.
  const closed = await closeView("t1");
  assert.equal(closed.unlinked, 3);
  assert.ok(closed.sessions.includes("view-t1"));
  assert.ok(closed.sessions.includes("view-t1-2"));
  assert.equal(await hasSession("view-t1"), false);
  assert.equal(await hasSession("view-t1-2"), false);
  assert.equal(await hasSession("CL-v1"), true, "bee CL-v1 must survive --close");
  assert.equal(await hasSession("CL-v2"), true, "bee CL-v2 must survive --close");
  assert.equal(await hasSession("CL-v3"), true, "bee CL-v3 must survive --close");
});

test("linkHere links into the current session and selects single bees", { timeout: 60_000 }, async () => {
  const { linkHere } = await import("../src/view.js");
  await tmux(["new-session", "-d", "-s", "driver", "sleep 120"]);
  await tmux(["new-session", "-d", "-s", "CL-h1", "sleep 120"]);
  const result = await linkHere(["CL-h1"], { select: true, currentSession: "driver" });
  assert.equal(result.session, "driver");
  assert.equal(result.linked, 1);
  const wid = (await tmux(["display-message", "-p", "-t", "=CL-h1:", "#{window_id}"])).stdout.trim();
  const driverWindows = (await tmux(["list-windows", "-t", "=driver", "-F", "#{window_id} #{window_active}"])).stdout;
  assert.ok(driverWindows.includes(wid), "bee window linked into driver session");
  assert.ok(driverWindows.includes(`${wid} 1`), "linked window selected");
  // Idempotent: re-linking is a no-op.
  const again = await linkHere(["CL-h1"], { select: true, currentSession: "driver" });
  assert.equal(again.linked, 0);
  // The bee's own session is untouched.
  assert.equal(await hasSession("CL-h1"), true);
});
