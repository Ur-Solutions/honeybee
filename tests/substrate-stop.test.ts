import assert from "node:assert/strict";
import { test } from "node:test";
import { stopRuntimeStrict } from "../src/substrates/stop.js";
import type { Substrate } from "../src/substrates/types.js";

function substrate(overrides: Partial<Substrate> = {}): Substrate {
  return {
    kind: "local-tmux",
    node: "local",
    probe: async () => ({ ok: true }),
    hasSession: async () => false,
    newSession: async () => ({ paneId: "%1" }),
    kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [],
    listPanes: async () => new Set(),
    listSessionStates: async () => new Map(),
    setUserOptions: async () => undefined,
    setWindowOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => [],
    attachSession: async () => undefined,
    ...overrides,
  };
}

test("strict replacement stop aborts on the initial probe error without signalling or launching", async () => {
  let kills = 0;
  const runtime = substrate({
    hasSession: async () => { throw new Error("probe transport failed"); },
    kill: async () => {
      kills += 1;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await assert.rejects(
    stopRuntimeStrict(runtime, "CO.probe", { context: "replacement blocked" }),
    /initial liveness observation failed.*probe transport failed/,
  );
  assert.equal(kills, 0, "an observation error never authorizes a signal");
});

test("strict replacement stop rejects a kill error even when tmux removed the pane", async () => {
  let alive = true;
  const runtime = substrate({
    hasSession: async () => alive,
    kill: async () => {
      alive = false;
      return { ok: false, stdout: "", stderr: "old launcher group survived", exitCode: 1 };
    },
  });

  await assert.rejects(
    stopRuntimeStrict(runtime, "CO.group", {
      launcherPgid: 4242,
      launcherFingerprint: { pgid: 4242, startedAt: "Fri Aug  7 10:00:00 2026" },
    }),
    /exact cleanup unconfirmed.*old launcher group survived/,
  );
});

test("strict replacement stop aborts when the final absence probe errors", async () => {
  let probes = 0;
  const runtime = substrate({
    hasSession: async () => {
      probes += 1;
      if (probes === 1) return true;
      throw new Error("final probe failed");
    },
  });

  await assert.rejects(
    stopRuntimeStrict(runtime, "CO.final-probe"),
    /final liveness observation failed.*final probe failed/,
  );
});

test("strict replacement stop succeeds only after kill and positive target absence", async () => {
  let alive = true;
  const runtime = substrate({
    hasSession: async () => alive,
    kill: async () => {
      alive = false;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });

  assert.deepEqual(await stopRuntimeStrict(runtime, "CO.gone"), { alreadyGone: false, attempts: 1 });
});

test("legacy ssh-tmux absence without remote group evidence stays unconfirmed", async () => {
  let kills = 0;
  const runtime = substrate({
    kind: "ssh-tmux",
    node: "mini01",
    hasSession: async () => false,
    kill: async () => {
      kills += 1;
      return { ok: false, stdout: "", stderr: "remote launcher process-group identity was not recorded", exitCode: 1 };
    },
  });

  await assert.rejects(
    stopRuntimeStrict(runtime, "CO.remote-legacy"),
    /remote launcher process-group identity was not recorded/,
  );
  assert.equal(kills, 1, "remote pane absence is never accepted as process absence");
});
