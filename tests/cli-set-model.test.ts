import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { reviveRecord } from "../src/commands/migrate.js";
import { captureProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import { hasSession, setTmuxSocket, terminateProcessGroup, tmux } from "../src/substrates/local-tmux.js";
import { ensureHsrRunDir, hsrControlSocketPath, writeHsrMeta } from "../src/hsr/runDir.js";
import type { ProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import type { SessionRecord } from "../src/store.js";

const execFileAsync = promisify(execFile);

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=", "-p", String(process.pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detachedRuntimeAvailable(): boolean {
  try {
    execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=", "-p", String(process.pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function seedBee(store: string, name: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const sessionsDir = join(store, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const now = "2026-06-25T00:00:00.000Z";
  const record = {
    name,
    agent: "codex",
    requestedAgent: "codex",
    cwd: store,
    launchArgv: ["sh", "-c", "sleep 120", "--"],
    command: `CODEX_HOME=${join(store, "codex-home")} codex --dangerously-bypass-approvals-and-sandbox`,
    tmuxTarget: name.replaceAll(".", "-"),
    homePath: join(store, "codex-home"),
    id: name,
    createdAt: now,
    updatedAt: now,
    status: "dead" as const,
    ...overrides,
  };
  await writeFile(join(sessionsDir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function readBee(store: string, name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(store, "sessions", `${name}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function hive(
  store: string,
  socket: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const cliArgs = process.env.HIVE_TEST_BUILT_CLI === "1"
    ? ["tests/cli-entry.mjs", ...args]
    : ["--import", "tsx", "tests/cli-entry.mjs", ...args];
  return execFileAsync(process.execPath, cliArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: store,
      HIVE_TMUX_SOCKET: socket,
      HIVE_CODEX_CMD: "sh -c 'sleep 120' --",
      HIVE_STUB_CMD: process.execPath,
      HIVE_NO_KEYCHAIN: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      ...envOverrides,
    },
  });
}

async function killHsrBee(store: string, bee: string): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    const { hsrSubstrate } = await import("../src/hsr/substrate.js");
    const stopped = await hsrSubstrate().kill(bee);
    assert.equal(stopped.ok, true, stopped.stderr);
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
  }
}

async function reviveHsrBee(store: string, bee: string): Promise<SessionRecord> {
  const prev = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    const record = await readBee(store, bee) as unknown as SessionRecord;
    return await reviveRecord(record, {
      fresh: false,
      skipCredentialActivation: true,
    });
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
  }
}

async function cleanupExactTmuxRuntime(
  target: string,
  launcherPgid: number,
  launcherFingerprint: ProcessBirthFingerprint,
): Promise<void> {
  const cleanup = await Promise.allSettled([
    terminateProcessGroup(launcherPgid, launcherFingerprint),
    tmux(["kill-session", "-t", `=${target}`], { reject: false }),
  ]);
  assert.equal(cleanup[0].status, "fulfilled", "exact fixture process-group cleanup completes");
  if (cleanup[0].status === "fulfilled") {
    assert.equal(cleanup[0].value.status, "confirmed", cleanup[0].value.reason);
  }
}

async function seedStoppedHsrRuntime(store: string, bee: string): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    const deadPid = 2 ** 31 - 1;
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "codex",
      tier: "server",
      hostPid: deadPid,
      hostFingerprint: { pgid: deadPid, startedAt: "Fri Aug  7 00:00:00 2026" },
      childAdmission: "none",
      startupFailure: {
        stage: "adapter-start",
        message: "fixture provider was durably never started",
      },
      startedAt: "2026-08-07T00:00:00.000Z",
      controlSocket: hsrControlSocketPath(bee),
      status: "exited",
      exitCode: 0,
      endedAt: "2026-08-07T00:00:01.000Z",
    });
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
  }
}

async function installCodexAppServerStub(store: string): Promise<string> {
  const target = join(store, "fake-codex-app-server");
  await copyFile(join(process.cwd(), "tests", "fixtures", "codex-app-server-stub.mjs"), target);
  await chmod(target, 0o700);
  return target;
}

async function withRig(fn: (ctx: { store: string; socket: string }) => Promise<void>): Promise<void> {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-set-model-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-set-model-store-"));
  setTmuxSocket(socket);
  try {
    await fn({ store, socket });
  } finally {
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

test("set-model on a dead bee records model + extra flags without relaunching", async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.dead-set";
    await seedBee(store, bee);

    const result = await hive(store, socket, ["set-model", bee, "gpt-5.5", "--", "-c", "model_reasoning_effort=high"]);
    assert.match(result.stdout, /set-model\tCO\.dead-set\tgpt-5\.5\trecorded/);

    const record = await readBee(store, bee);
    assert.equal(record.model, "gpt-5.5");
    assert.equal(record.modelExtraArgs, "-c model_reasoning_effort=high");
    assert.equal(record.status, "dead", "a dead bee stays dead; the model applies on the next revive");
    assert.equal(await hasSession("CO-dead-set"), false, "set-model on a dead bee must not launch anything");
  });
});

test("set-model replaces the whole selection each call; --clear returns to harness default", async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.replace";
    await seedBee(store, bee, { model: "gpt-5-codex", modelExtraArgs: "-c model_reasoning_effort=low" });

    await hive(store, socket, ["set-model", bee, "gpt-5.5"]);
    let record = await readBee(store, bee);
    assert.equal(record.model, "gpt-5.5");
    assert.equal(record.modelExtraArgs, undefined, "omitting -- clears previously recorded extra flags");

    await hive(store, socket, ["set-model", bee, "--clear"]);
    record = await readBee(store, bee);
    assert.equal(record.model, undefined, "--clear removes the first-class model");
  });
});

test("set-model validates its inputs before touching anything", async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.validate";
    await seedBee(store, bee, { model: "gpt-5-codex" });

    await assert.rejects(() => hive(store, socket, ["set-model", bee]), /Usage: hive set-model/);
    await assert.rejects(() => hive(store, socket, ["set-model", bee, "gpt-5.5", "--clear"]), /either <model> or --clear/);

    const pi = "PI.no-selector";
    await seedBee(store, pi, { agent: "pi", requestedAgent: "pi", command: "pi" });
    await assert.rejects(() => hive(store, socket, ["set-model", pi, "some-model"]), /no model selector/);

    const oc = "OC.no-provider";
    await seedBee(store, oc, { agent: "opencode", requestedAgent: "opencode", command: "opencode" });
    await assert.rejects(() => hive(store, socket, ["set-model", oc, "kimi-k2"]), /qualified provider\/model/);

    const qualified = await hive(store, socket, ["set-model", oc, "zai-coding-plan/glm-5"]);
    assert.match(qualified.stdout, /set-model\tOC\.no-provider\tzai-coding-plan\/glm-5\trecorded/);
    assert.equal((await readBee(store, oc)).model, "zai-coding-plan/glm-5");

    const record = await readBee(store, bee);
    assert.equal(record.model, "gpt-5-codex", "failed validations leave the record untouched");
  });
});

test("set-model refuses remote HSR before any stop fence or launch", async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.remote-model";
    await seedBee(store, bee, {
      status: "running",
      node: "remote-one",
      remoteLaunchId: "launch-old",
      remoteIncarnation: "inc-old",
      providerSessionId: "thread-old",
    });
    await assert.rejects(
      hive(store, socket, ["set-model", bee, "gpt-5.5"]),
      /remote node remote-one; set-model only supports local bees/,
    );
    assert.equal((await readBee(store, bee)).status, "running");
    assert.equal((await readdir(join(store, "launch-reservations")).catch(() => [])).length, 0);
  });
});

test("set-model refuses a live bee with no resumable session id unless --fresh", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.live-no-session";
    const target = "CO-live-no-session";
    await seedBee(store, bee, { status: "running" });
    await tmux(["new-session", "-d", "-s", target, "sleep 120"]);

    await assert.rejects(() => hive(store, socket, ["set-model", bee, "gpt-5.5"]), /no recorded provider session id.*--fresh/);
    assert.equal(await hasSession(target), true, "the running bee must be left alone");

    const record = await readBee(store, bee);
    assert.equal(record.model, undefined, "nothing is persisted when the resume gate refuses");
  });
});

test("set-model aborts on a liveness probe error without changing or launching the model", async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.probe-error";
    await seedBee(store, bee, { status: "running", providerSessionId: "sess-probe" });

    await assert.rejects(
      hive(store, socket, ["set-model", bee, "gpt-5.5"], { PATH: "/definitely-missing" }),
      /could not observe CO-probe-error.*(?:ENOENT|tmux has-session exited 1)/,
    );
    assert.equal((await readBee(store, bee)).model, undefined);
  });
});

test("set-model refuses relaunch when pane teardown cannot prove the old process group stopped", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.unconfirmed-group";
    const target = "CO-unconfirmed-group";
    let launcherPgid = 0;
    let cleanupFingerprint: ProcessBirthFingerprint | undefined;
    try {
      await tmux(["new-session", "-d", "-s", target, "sleep 120"]);
      const pane = await tmux(["display-message", "-p", "-t", `=${target}:`, "#{pane_pid}"]);
      launcherPgid = Number(pane.stdout.trim());
      assert.ok(Number.isSafeInteger(launcherPgid) && launcherPgid > 0);
      cleanupFingerprint = await captureProcessBirthFingerprint(launcherPgid);
      assert.ok(cleanupFingerprint);
      assert.equal(cleanupFingerprint.pgid, launcherPgid);
      await seedBee(store, bee, {
        status: "running",
        providerSessionId: "sess-group",
        launcherPgid,
        // Deliberately missing launcherFingerprint: signalling must fail closed.
      });

      await assert.rejects(
        hive(store, socket, ["set-model", bee, "gpt-5.5"]),
        /exact cleanup unconfirmed.*(?:missing|mismatched) birth fingerprint/,
      );

      const fenced = await readBee(store, bee);
      assert.equal(fenced.model, undefined, "selection stays aligned with the old runtime");
      assert.equal(fenced.status, "kill_failed", "work is fenced before teardown starts");
      const journalFiles = await readdir(join(store, "launch-reservations"));
      assert.equal(journalFiles.length, 1);
      const journal = JSON.parse(await readFile(join(store, "launch-reservations", journalFiles[0]!), "utf8")) as {
        operation?: string;
        phase?: string;
      };
      assert.equal(journal.operation, "set-model");
      assert.equal(journal.phase, "stopping");
      assert.equal(await hasSession(target), false, "tmux removed the pane, but that alone did not authorize relaunch");
    } finally {
      if (launcherPgid > 0 && cleanupFingerprint) {
        await cleanupExactTmuxRuntime(target, launcherPgid, cleanupFingerprint);
      }
    }
  });
});

test("set-model relaunches a live tmux bee resuming its session with the new selection", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.live-switch";
    const target = "CO-live-switch";
    await seedBee(store, bee, { status: "running", providerSessionId: "sess-live" });
    await tmux(["new-session", "-d", "-s", target, "sleep 120"]);

    const result = await hive(store, socket, ["set-model", bee, "gpt-5.5", "--", "-c", "model_reasoning_effort=high"]);
    assert.match(result.stdout, /set-model\tCO\.live-switch\tgpt-5\.5\tresumed sess-live/);

    assert.equal(await hasSession(target), true, "the bee is relaunched after the switch");
    const record = await readBee(store, bee);
    assert.equal(record.model, "gpt-5.5");
    assert.equal(record.modelExtraArgs, "-c model_reasoning_effort=high");
    assert.equal(record.status, "running");
    assert.equal(record.providerSessionId, "sess-live");
    // HIVE_CODEX_CMD overrides the base command (which suppresses the driver's
    // --model injection by design), but the persisted extra flags and the
    // resume args must both land in the rebuilt command.
    assert.match(String(record.command), /-c model_reasoning_effort=high/);
    assert.match(String(record.command), /resume sess-live/);
  });
});

test("set-model rolls the record back when the relaunched harness dies immediately", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.rollback"
    const target = "CO-rollback"
    await seedBee(store, bee, {
      status: "running",
      providerSessionId: "sess-rb",
      model: "gpt-5-codex",
      modelExtraArgs: "-c model_reasoning_effort=low",
    })
    await tmux(["new-session", "-d", "-s", target, "sleep 120"])

    // The relaunch command exits immediately → the settle window fails → the
    // previous selection must be restored on the record.
    await assert.rejects(
      () => hive(store, socket, ["set-model", bee, "gpt-5.5"], { HIVE_CODEX_CMD: "sh -c 'exit 7' --" }),
      /previous model restored/,
    )

    const record = await readBee(store, bee)
    assert.equal(record.model, "gpt-5-codex", "the pre-switch model is restored");
    assert.equal(record.modelExtraArgs, "-c model_reasoning_effort=low", "the pre-switch extra flags are restored")
    assert.equal(record.providerSessionId, "sess-rb")
  })
})

// A LIVE in-rig HSR switch is not honestly testable: the runner host only
// reports live for real harnesses (the "stub" HSR adapter has no driver, so it
// has no model selector). This covers the halves the rig can verify — record
// the selection on a downed HSR bee, then prove the HSR revive path rebuilds
// the runner spec WITH it. The live HSR switch is exercised against a real
// codex bee (quiesce → stop runner → re-fork resuming the same thread).
test("set-model on a downed HSR bee records the selection and revive applies it", { skip: !detachedRuntimeAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "HSR.switch"
    const fakeCodex = await installCodexAppServerStub(store)
    await seedBee(store, bee, {
      agent: "codex",
      requestedAgent: "codex",
      launchArgv: [fakeCodex],
      command: fakeCodex,
      tmuxTarget: bee,
      substrate: "hsr",
      runnerPid: 2 ** 31 - 1,
      providerSessionId: "sess-hsr-switch",
    })
    await seedStoppedHsrRuntime(store, bee)

    try {
      const result = await hive(store, socket, [
        "set-model", bee, "gpt-5.5", "--", "-c", "model_reasoning_effort=high",
      ])
      assert.match(result.stdout, /set-model\tHSR\.switch\tgpt-5\.5\trecorded/)

      await reviveHsrBee(store, bee)
      const record = await readBee(store, bee)
      assert.equal(record.model, "gpt-5.5")
      assert.equal(record.modelExtraArgs, "-c model_reasoning_effort=high")
      assert.equal(record.substrate, "hsr", "the bee stays pane-less")
      assert.equal(record.providerSessionId, "sess-hsr-switch")
      assert.match(
        String(record.lastReviveCommand),
        /-c model_reasoning_effort=high/,
        "reviveHsrRunner's rebuilt spec must carry the persisted extra flags",
      )
      assert.equal(typeof record.runnerPid, "number")
    } finally {
      const cleanup = await Promise.allSettled([killHsrBee(store, bee)])
      assert.equal(cleanup[0].status, "fulfilled", "exact HSR fixture cleanup completes")
    }
  })
})

test("revive applies the recorded model extra flags on the tmux path", { skip: !tmuxAvailable() }, async () => {
  await withRig(async ({ store, socket }) => {
    const bee = "CO.revive-extras";
    await seedBee(store, bee, {
      model: "gpt-5.5",
      modelExtraArgs: "-c model_reasoning_effort=high",
      providerSessionId: "sess-extras",
    });

    await hive(store, socket, ["revive", bee, "--no-wait"]);
    const record = await readBee(store, bee);
    assert.equal(record.status, "running");
    assert.match(String(record.lastReviveCommand), /-c model_reasoning_effort=high/, "reviveRecord must re-apply modelExtraArgs");
    assert.match(String(record.lastReviveCommand), /resume sess-extras/);
  });
});
