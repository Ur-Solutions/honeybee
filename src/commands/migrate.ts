// `hive promote`/demote/revive — substrate migration: move a bee between an
// interactive tmux pane and a pane-less HSR runner (resume), and revive dead bees.
// Extracted from cli.ts (HIVE-15).
import { activateAccountIntoHome, findAccount } from "../accounts.js";
import { agentDefaultsToYolo, assertAgentAuthFreshForSpawn, canonicalAgentKind, refreshIdentityEnv, resolveAgent, shellCommand, type AgentSpec } from "../agents.js";
import { assertExecutableAvailable } from "../execCheck.js";
import { actionLine, bold, dim, isPretty, note } from "../format.js";
import { writeSpawnOptions } from "../hiveState.js";
import { adapterFor } from "../hsr/adapters/index.js";
import { hsrObservations, type HsrObservation } from "../hsr/observe.js";
import { connectRpcClient } from "../hsr/rpc.js";
import { readHsrMeta } from "../hsr/runDir.js";
import { hsrSubstrate } from "../hsr/substrate.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { waitForAgentReady } from "../readiness.js";
import { appendLedger, listSessions, updateSession, type SessionRecord } from "../store.js";
import { localSubstrate, substrateFor } from "../substrates/index.js";
import { resumeArgs, sniffYolo } from "../swap.js";
import { formatShellCommand, hasSession } from "../tmux.js";
import { resolveSession, safeTmuxTarget, sleep, stringFlag } from "../cli/shared.js";
import { spawnHsrHost, waitForHsrHost } from "../hsr/runnerHost.js";

// Harnesses whose interactive↔headless resume genuinely carries history — the
// only ones promote/demote accept. claude is EXCLUDED: its interactive-TUI and
// headless (`-p`) session stores are disjoint, so `claude --resume <id>` cannot
// rejoin a headless HSR session (and vice-versa) — a resumed process errors and
// exits. codex has no such split (`codex resume <threadId>` rejoins an
// app-server thread). See docs/HSR_EXPLORATION.md §7 (2026-07-03). Re-add
// "claude" here the day a claude release unifies the two stores.
export const RESUME_GATED_HARNESSES = new Set(["codex"]);


/**
 * Gate a promote/demote: the harness must have a verified resume path and the
 * bee must carry a provider session id to resume. Returns the lowercased tool.
 */
export function assertResumable(record: SessionRecord, verb: "promote" | "demote"): string {
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  if (tool === "claude") {
    throw new Error(
      `hive ${verb} does not support claude: its interactive and headless (-p) session stores are disjoint, so a resumed session cannot carry history (docs/HSR_EXPLORATION.md §7). codex is supported.`,
    );
  }
  if (!RESUME_GATED_HARNESSES.has(tool)) {
    throw new Error(`hive ${verb} needs a resumable provider session; ${record.agent} is not resume-gated (only codex)`);
  }
  if (!record.providerSessionId) {
    throw new Error(`hive ${verb} needs a resumable provider session; ${record.name} has no recorded provider session id`);
  }
  return tool;
}


/**
 * Quiesce a running HSR bee before we detach its runner. `--now` interrupts the
 * in-flight turn over the control socket (hsrSubstrate has no interrupt verb, so
 * we connect the socket directly). Otherwise wait for the current turn to finish
 * (structured state leaves "active") up to 30s, then tell the user to use --now.
 */
export async function quiesceHsrBee(record: SessionRecord, now: boolean): Promise<void> {
  if (now) {
    const meta = await readHsrMeta(record.name);
    if (meta?.controlSocket) {
      const client = await connectRpcClient(meta.controlSocket).catch(() => undefined);
      if (client) {
        try {
          await client.call("interrupt").catch(() => undefined);
        } finally {
          client.close();
        }
      }
    }
    return;
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const obs = await hsrObservations().catch(() => new Map<string, HsrObservation>());
    const state = obs.get(record.name)?.state;
    if (state !== "active") return;
    await sleep(500);
  }
  throw new Error(`hive promote: ${record.name} is still mid-turn after 30s; retry with --now to interrupt`);
}


/**
 * Stop a bee's HSR runner host WITHOUT deleting its record (the record survives
 * the substrate switch). Asks the host to stop cleanly over the control socket,
 * then waits until it is no longer live; SIGTERMs the host pid as a fallback.
 */
export async function stopHsrRunner(record: SessionRecord): Promise<void> {
  // hsrSubstrate().kill connects the control socket, calls "stop", waits for the
  // host to finalize, and falls back to SIGTERM — and it never touches the record.
  await hsrSubstrate().kill(record.name).catch(() => undefined);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await hsrSubstrate().hasSession(record.name).catch(() => false))) return;
    await sleep(100);
  }
  if (record.runnerPid) {
    try {
      process.kill(record.runnerPid, "SIGTERM");
    } catch {
      // already gone / not signalable
    }
  }
}


// How long promote/demote watch the freshly-relaunched agent before trusting it.
// claude keeps its interactive-TUI and headless-`-p`/SDK session stores DISJOINT:
// an interactive `--resume` cannot find a `-p`-created session and vice-versa. A
// harness that rejects the resume prints its error and exits within ~1s (which
// collapses the tmux window, or flips the HSR meta to "exited"); a healthy agent
// keeps running indefinitely. 3s cleanly separates the two without stalling the
// happy path.
export const RESUME_LIVENESS_SETTLE_MS = 3_000;


/**
 * Watch a just-launched tmux session across the settle window. Returns false the
 * moment the session vanishes (its agent exited immediately — a bricked
 * relaunch), true if it survives the whole window.
 */
export async function tmuxSessionSurvives(
  substrate: { hasSession(target: string): Promise<boolean> },
  target: string,
  windowMs: number,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (!(await substrate.hasSession(target).catch(() => false))) return false;
    if (Date.now() >= deadline) return true;
    await sleep(pollMs);
  }
}


/**
 * Build the spec for re-launching a bee's recorded agent in place: same
 * yolo policy as spawn, re-activate the bound account for token freshness
 * (mirrors spawnBee), and assert the executable exists. The promote/demote/
 * revive paths all relaunch this way — headless callers pass [] (the HSR
 * adapter appends its own resume flags), interactive callers pass
 * resumeArgs(tool, id).
 */
export async function buildResumeSpec(record: SessionRecord, tool: string, extraArgs: string[]): Promise<AgentSpec> {
  const spec = resolveAgent(record.requestedAgent ?? record.agent, extraArgs, {
    home: record.homePath,
    yolo: agentDefaultsToYolo(tool),
    identity: Boolean(record.accountId),
    ...(record.model ? { model: record.model } : {}),
  });
  if (record.accountId && spec.homePath) {
    const account = await findAccount(record.accountId, tool).catch(() => undefined);
    if (account) {
      await activateAccountIntoHome(account, spec.homePath, { onWarn: (message) => console.error(note(message)) });
      refreshIdentityEnv(spec);
    }
  }
  await assertExecutableAvailable(spec.command);
  return spec;
}


/**
 * Re-fork the HSR runner host for a bee whose record still says substrate:"hsr",
 * and persist the fresh runnerPid. promote rollbacks use the default resume path
 * to rejoin the SAME provider session headlessly; revive can pass `fresh` to
 * start a new HSR session while preserving the record identity.
 */
export async function reviveHsrRunner(record: SessionRecord, tool: string, opts: { fresh?: boolean; sessionOverride?: string } = {}): Promise<SessionRecord> {
  const adapter = adapterFor(tool);
  const fresh = opts.fresh === true;
  const providerSessionId = fresh ? undefined : (opts.sessionOverride ?? record.providerSessionId);
  const spec = await buildResumeSpec(record, tool, []);
  const hostPid = await spawnHsrHost({
    bee: record.name,
    comb: record.combId ?? record.name,
    ...(record.parentId ? { parent: record.parentId } : {}),
    kind: tool,
    cwd: record.cwd,
    ...(providerSessionId ? { sessionId: providerSessionId } : {}),
    ...(fresh ? {} : { resume: true }),
    authKind: "subscription",
    ...(record.model ? { model: record.model } : {}),
    spec: { command: spec.command, args: spec.args, env: spec.env },
  });
  if (!(await waitForHsrHost(record.name, 5000))) {
    console.error(note(`hsr host for ${record.name} did not report live within 5s; the daemon will reconcile`));
  }
  const runnerTier = adapter?.tier();
  // Field-merge, not a full-record save, so daemon writes since `record`
  // loaded survive; null = record deleted concurrently, nothing to persist
  // (HIVE-49).
  const patch: Partial<SessionRecord> = {
    command: shellCommand(spec),
    substrate: "hsr",
    runnerPid: hostPid,
    ...(runnerTier ? { runnerTier } : {}),
    ...(opts.sessionOverride ? { providerSessionId: opts.sessionOverride } : {}),
    updatedAt: new Date().toISOString(),
    status: "running",
  };
  const restored = (await updateSession(record.name, patch)) ?? { ...record, ...patch };
  await writeSpawnOptions(restored);
  return restored;
}


/**
 * Poll a freshly-forked HSR runner's child across the settle window. Returns
 * false the moment the child exits (meta status → "exited": the headless resume
 * was rejected — a bricked demote), true if it stays running the whole window.
 */
export async function hsrChildSurvives(bee: string, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const meta = await readHsrMeta(bee).catch(() => null);
    if (meta?.status === "exited") return false;
    if (Date.now() >= deadline) return true;
    await sleep(250);
  }
}


/**
 * Re-launch a bee's interactive tmux pane resuming its provider session, and
 * persist the fresh pane fields. Mirror of reviveHsrRunner for the demote
 * rollback: demote kills the tmux pane BEFORE forking the HSR runner; if that
 * runner's child exits immediately (the headless resume was rejected) this
 * restores the interactive bee where it started (interactive→interactive resume
 * works, so the recovery keeps continuity).
 */
export async function reviveTmuxPane(record: SessionRecord, tool: string): Promise<void> {
  const spec = await buildResumeSpec(record, tool, resumeArgs(tool, record.providerSessionId));
  const tmuxTarget = safeTmuxTarget(record.name);
  const substrate = localSubstrate();
  const launch = await substrate.newSession(tmuxTarget, record.cwd, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    tmuxOptions: spec.tmuxOptions,
  });
  // Field-merge, not a full-record save, so daemon writes since `record`
  // loaded survive; explicit undefined deletes the HSR fields; null = record
  // deleted concurrently, nothing to persist (HIVE-49).
  const restored = await updateSession(record.name, {
    command: shellCommand(spec),
    tmuxTarget,
    ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
    ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
    combId: tmuxTarget,
    updatedAt: new Date().toISOString(),
    status: "running",
    substrate: undefined,
    runnerPid: undefined,
    runnerTier: undefined,
  });
  if (restored) await writeSpawnOptions(restored);
}


/**
 * `hive promote <bee>` — move a pane-less HSR bee onto an interactive tmux pane
 * by resuming the SAME provider session. Quiesce → stop the runner (keep the
 * record) → relaunch on local-tmux with resume args → verify it stays up →
 * flip the record (rolling back to HSR if the relaunch dies immediately).
 */
export async function cmdPromote(parsed: Parsed): Promise<void> {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive promote <bee> [--now]");
  const record = await resolveSession(target);
  if (record.substrate !== "hsr") {
    throw new Error(`hive promote: ${record.name} is already on tmux (not an HSR bee)`);
  }
  // Server-tier harnesses (codex) mint their provider thread id at RUNTIME —
  // it lands in the HSR meta, never in the spawn record (which had no id to pin).
  // Backfill it from the meta so the resume gate can see it, and persist the
  // correction so later resume/swap paths see it too.
  if (!record.providerSessionId) {
    const meta = await readHsrMeta(record.name).catch(() => null);
    if (meta?.sessionId) {
      record.providerSessionId = meta.sessionId;
      // Field-merge, not a full-record save: a full save would revert daemon
      // writes (auto-title, observed state) since `record` loaded (HIVE-49).
      await updateSession(record.name, { providerSessionId: meta.sessionId });
    }
  }
  const tool = assertResumable(record, "promote");
  const now = truthy(flag(parsed, "now"));

  // 1. Quiesce the running turn (wait for turn end, or interrupt with --now).
  await quiesceHsrBee(record, now);

  // 2. Stop the HSR runner host — but keep the record.
  await stopHsrRunner(record);

  // 3. Build the interactive resume spec: claude `--resume <id>`, codex
  //    `resume <id>`.
  const spec = await buildResumeSpec(record, tool, resumeArgs(tool, record.providerSessionId));

  // 4. Launch the interactive tmux session (resuming the same provider session).
  const tmuxTarget = safeTmuxTarget(record.name);
  const substrate = localSubstrate();
  if (await substrate.hasSession(tmuxTarget)) throw new Error(`hive promote: a tmux session already exists: ${tmuxTarget}`);
  const launch = await substrate.newSession(tmuxTarget, record.cwd, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    tmuxOptions: spec.tmuxOptions,
  });

  // 4b. Verify the interactive agent actually stayed up. If it rejected the
  //     resume and exited immediately (the tmux window collapsed), we would
  //     otherwise flip the record and report success on a DEAD bee whose runner
  //     is already gone. Instead: tear down the dead remnant and re-fork the
  //     HSR runner so the bee is restored exactly where it was.
  if (!(await tmuxSessionSurvives(substrate, tmuxTarget, RESUME_LIVENESS_SETTLE_MS))) {
    await substrate.kill(tmuxTarget, { launcherPgid: launch.launcherPgid }).catch(() => undefined);
    await reviveHsrRunner(record, tool);
    throw new Error(
      `hive promote: ${record.name} exited immediately after the ${record.agent} resume — its provider session is not interactively resumable; left running on HSR`,
    );
  }

  // 5. Flip the record to local-tmux: delete substrate/runnerPid/runnerTier
  //    (explicit undefined = delete), set the pane fields; KEEP
  //    uuid/providerSessionId/id/lineage/account. Field-merge under the lock
  //    (updateSession) instead of a full-record save so daemon writes that
  //    landed since `record` was loaded (auto-title, observed state) survive
  //    the flip (HIVE-49). null = record deleted mid-promote (concurrent
  //    kill) — don't resurrect it.
  const command = shellCommand(spec);
  const promoted = await updateSession(record.name, {
    command,
    tmuxTarget,
    ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
    ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
    combId: tmuxTarget,
    updatedAt: new Date().toISOString(),
    status: "running",
    substrate: undefined,
    runnerPid: undefined,
    runnerTier: undefined,
  });
  if (promoted) await writeSpawnOptions(promoted);
  await appendLedger({ type: "session.promote", session: record.name, from: "hsr", to: "local-tmux", providerSessionId: record.providerSessionId });

  if (isPretty()) {
    console.log(actionLine("ok", "promote", [bold(record.name), record.agent, dim("→ local-tmux")]));
    console.error(note(`attach with: ${formatShellCommand(substrate.attachCommand(tmuxTarget))}`));
  } else {
    console.log(`promoted\t${record.name}\thsr\tlocal-tmux\t${command}`);
  }
}


/**
 * `hive demote <bee>` — the mirror: move a tmux bee back to a pane-less HSR
 * runner by resuming the SAME provider session headlessly. Quiesce → kill the
 * pane (keep the record) → fork the runner host with resume:true → flip record.
 */
export async function cmdDemote(parsed: Parsed): Promise<void> {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive demote <bee> [--now]");
  const record = await resolveSession(target);
  if (record.substrate === "hsr") {
    throw new Error(`hive demote: ${record.name} is already on HSR (not a tmux bee)`);
  }
  const tool = assertResumable(record, "demote");
  const adapter = adapterFor(tool);
  if (!adapter) throw new Error(`hive demote: no HSR adapter for ${record.agent}`);
  const now = truthy(flag(parsed, "now"));

  // 1. Quiesce. A tmux bee's mid-turn state is heuristic, so absent --now we
  //    proceed best-effort; --now sends Ctrl-C to the agent pane first.
  if (now) {
    await localSubstrate().sendKey(record.tmuxTarget, "C-c", record.agentPaneId).catch(() => undefined);
    await sleep(300);
  } else {
    console.error(note(`${record.name}: a tmux bee's mid-turn state is heuristic — demoting without waiting (use --now to interrupt first)`));
  }

  // 2. Kill the tmux session/pane — but keep the record.
  await localSubstrate().kill(record.tmuxTarget, { launcherPgid: record.launcherPgid }).catch(() => undefined);

  // 3. Build the headless spec (the adapter appends the resume + stream flags)
  //    and fork the runner host with resume:true against the same session id.
  const spec = await buildResumeSpec(record, tool, []);
  const runnerTier = adapter.tier();
  const hostPid = await spawnHsrHost({
    bee: record.name,
    comb: record.combId ?? record.name,
    ...(record.parentId ? { parent: record.parentId } : {}),
    kind: tool,
    cwd: record.cwd,
    sessionId: record.providerSessionId,
    resume: true,
    authKind: "subscription",
    ...(record.model ? { model: record.model } : {}),
    spec: { command: spec.command, args: spec.args, env: spec.env },
  });

  // 4. Wait briefly for the host to report live (as spawnBee's HSR path does).
  if (!(await waitForHsrHost(record.name, 5000))) {
    console.error(note(`hsr host for ${record.name} did not report live within 5s; the daemon will reconcile`));
  }

  // 4b. Verify the headless child actually stayed up. If the resume was rejected
  //     (e.g. claude cannot headlessly resume an interactive TUI session — the
  //     stores are disjoint) the child exits immediately; flipping now would
  //     report a dead bee whose tmux pane is already gone. Roll back: stop the
  //     dead runner and re-launch the interactive pane where the bee started.
  if (!(await hsrChildSurvives(record.name, RESUME_LIVENESS_SETTLE_MS))) {
    await stopHsrRunner({ ...record, substrate: "hsr", runnerPid: hostPid });
    await reviveTmuxPane(record, tool);
    throw new Error(
      `hive demote: ${record.name} exited immediately after the ${record.agent} headless resume — its provider session is not headlessly resumable; left running on tmux`,
    );
  }

  // 5. Flip the record to HSR: set substrate/runnerPid/runnerTier, make
  //    tmuxTarget the logical id, delete the pane fields (explicit undefined
  //    = delete); keep the rest. Field-merge under the lock (updateSession)
  //    instead of a full-record save so daemon writes that landed since
  //    `record` was loaded survive the flip (HIVE-49). null = record deleted
  //    mid-demote (concurrent kill) — don't resurrect it.
  const command = shellCommand(spec);
  const demoted = await updateSession(record.name, {
    command,
    substrate: "hsr",
    runnerPid: hostPid,
    ...(runnerTier ? { runnerTier } : {}),
    tmuxTarget: record.name,
    combId: record.name,
    updatedAt: new Date().toISOString(),
    status: "running",
    agentPaneId: undefined,
    launcherPgid: undefined,
  });
  if (demoted) await writeSpawnOptions(demoted);
  await appendLedger({ type: "session.demote", session: record.name, from: "local-tmux", to: "hsr", providerSessionId: record.providerSessionId });

  if (isPretty()) {
    console.log(actionLine("ok", "demote", [bold(record.name), record.agent, dim("→ hsr")]));
  } else {
    console.log(`demoted\t${record.name}\tlocal-tmux\thsr\t${command}`);
  }
}


/**
 * hive revive <bee> [--all] [--fresh]
 *
 * Bring a dead bee back: re-create its tmux session in the same cwd/home and
 * resume the same provider session (claude --resume / codex resume / opencode
 * --session) so it picks up where it left off. The record is reused in place —
 * same id, name, colony, account binding. This is the swap-account relaunch
 * recipe minus the account switch.
 *
 *   --all      revive every dead local bee that has a precise providerSessionId
 *   --crashed  revive only bees that died WITHOUT a retire/kill (substrate
 *              crash, external kill) — the recovery verb after a tmux crash
 *   --fresh    start a new session instead of resuming the old transcript
 *   --no-wait  skip the post-relaunch readiness wait (startup dialogs are
 *              auto-driven during that wait; see waitForRevivedReady)
 */
export async function cmdRevive(parsed: Parsed): Promise<void> {
  const bulkCrashed = truthy(flag(parsed, "crashed"));
  const bulkAll = truthy(flag(parsed, "all"));
  if (bulkCrashed || bulkAll) {
    const which = bulkCrashed ? "--crashed" : "--all";
    if (stringFlag(parsed, ["session"])) throw new Error(`hive revive ${which} cannot take --session (one id can't apply to many bees)`);
    const records = await listSessions();
    // Retired (archived) bees are settled on purpose — bulk revive must never
    // resurrect them. Reviving a retired bee stays possible one at a time.
    const local = records.filter((r) => (!r.node || r.node === LOCAL_NODE_NAME) && r.status !== "archived");
    let revived = 0;
    let alive = 0;
    const skipped: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const relaunched: SessionRecord[] = [];
    for (const record of local) {
      try {
        if (await substrateFor(record).hasSession(record.tmuxTarget)) {
          alive += 1;
          continue;
        }
        // --crashed revives only un-commanded deaths: a record still 'running'
        // whose session is gone was never retired/killed, so something under it
        // failed (tmux server crash, external kill, harness exit).
        if (bulkCrashed && record.status !== "running") {
          continue;
        }
        // Bulk revive only auto-revives bees we can resume precisely; resuming
        // "the latest session in the home" would grab a sibling's when homes are shared.
        if (!record.providerSessionId && !truthy(flag(parsed, "fresh"))) {
          skipped.push(record.name);
          continue;
        }
        relaunched.push(await reviveOne(record, parsed, { skipReadyWait: true }));
        revived += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ name: record.name, error: message });
        if (isPretty()) console.log(actionLine("warn", "revive", [bold(record.name), dim(message)]));
        else console.log(`revive_failed\t${record.name}\t${message}`);
      }
    }
    if (bulkCrashed && (revived > 0 || failed.length > 0)) {
      const diagnosis = await diagnoseSubstrateCrash().catch(() => undefined);
      if (diagnosis) console.error(note(diagnosis));
    }
    await waitForRevivedReady(relaunched, parsed);
    if (isPretty()) {
      const parts = [`revived ${revived}`, `${alive} already alive`];
      if (skipped.length > 0) parts.push(`${skipped.length} skipped (no resumable session id: ${skipped.join(", ")})`);
      if (failed.length > 0) parts.push(`${failed.length} failed (${failed.map((failure) => failure.name).join(", ")})`);
      console.log(note(parts.join(" · ")));
    } else {
      console.log(`revive\t${bulkCrashed ? "crashed" : "all"}\t${revived}\t${alive}\t${skipped.length}`);
    }
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive revive <bee> [--all] [--crashed] [--fresh] [--session <id>] [--no-wait]");
  const record = await resolveSession(target);
  await reviveOne(record, parsed);
}

/**
 * Best-effort explanation of WHY a fleet crashed: when the local tmux server's
 * process started after the crashed bees last breathed, the server itself went
 * down (crash or restart) and took every pane-bee with it — that is worth
 * telling the operator, since it means the bees did nothing wrong.
 */
async function diagnoseSubstrateCrash(): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const pid = (await run("tmux", ["display-message", "-p", "#{pid}"])).stdout.trim();
    if (!/^\d+$/.test(pid)) return undefined;
    const lstart = (await run("ps", ["-o", "lstart=", "-p", pid])).stdout.trim();
    if (!lstart) return undefined;
    return `tmux server (pid ${pid}) has been running since ${lstart} — bees that crashed before that died with the previous server`;
  } catch {
    return "no tmux server is responding — it likely crashed or was stopped; reviving starts a fresh one";
  }
}

/**
 * Post-relaunch smoothing: wait for each revived tmux bee to become ready,
 * auto-driving claude's startup dialogs (trust, bypass-permissions, the
 * resume-mode chooser, the renderer tour) so a revived bee lands at its
 * composer instead of stranded on a prompt. Bounded concurrency keeps a
 * fleet-sized revive from hammering the tmux server with capture polls.
 */
async function waitForRevivedReady(records: SessionRecord[], parsed: Parsed): Promise<void> {
  if (truthy(flag(parsed, "no-wait"))) return;
  const waitable = records.filter((r) => r.substrate !== "hsr" && (!r.node || r.node === LOCAL_NODE_NAME));
  if (waitable.length === 0) return;
  const timeoutMs = 90_000;
  const chunkSize = 8;
  for (let i = 0; i < waitable.length; i += chunkSize) {
    const chunk = waitable.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (record) => {
        try {
          await waitForAgentReady(record, { timeoutMs });
        } catch (error) {
          const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
          if (isPretty()) console.error(note(`${record.name}: not ready after revive — ${message}`));
          else console.log(`revive_not_ready\t${record.name}\t${message}`);
        }
      }),
    );
  }
}


/**
 * Pure relaunch core: re-create a bee's runtime in its OWN cwd/home and resume
 * (or, with `fresh`, start anew) its provider session. No `parsed`, no console
 * output — it does only the resolveAgent/newSession-or-HSR/updateSession/
 * appendLedger work and returns the updated record. It does NOT guard liveness
 * (the caller does, so `restore` can decide per-bee whether to skip a live one).
 * Non-fresh revive requires an exact provider session id; falling back to a
 * provider's "latest" session can resume a sibling bee in a shared home.
 *
 * ACCOUNT SAFETY: this re-spawns into `record.homePath` with NO account switch.
 * The tmux path does not activate credentials; the HSR path may refresh the same
 * bound account into the same home. In both cases there is no cross-account
 * OAuth-logout hazard. `reviveOne`/`restore` both rely on this invariant.
 */
export async function reviveRecord(record: SessionRecord, opts: { fresh: boolean; sessionOverride?: string }): Promise<SessionRecord> {
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  const fresh = opts.fresh;
  // sessionOverride resumes (and persists) a specific provider session — used to
  // recover bees whose providerSessionId was never recorded but whose session
  // still exists on disk (claude/codex keep sessions keyed by project dir).
  const sessionOverride = opts.sessionOverride;
  const providerSessionId = fresh ? undefined : (sessionOverride ?? record.providerSessionId);
  if (!fresh && !providerSessionId) {
    throw new Error(
      `hive revive: ${record.name} has no recorded provider session id; pass --session <id> to resume an exact session, or --fresh to start anew`,
    );
  }
  if (record.substrate === "hsr") {
    const updated = await reviveHsrRunner(record, tool, { fresh, sessionOverride });
    await appendLedger({
      type: "bee.revive",
      session: record.name,
      providerSessionId: providerSessionId ?? null,
      fresh,
    });
    return updated;
  }
  const substrate = substrateFor(record);

  // Mirror the swap relaunch: rebuild the agent command from the configured
  // kind (preserving the original permission mode) and append the resume args.
  const spec = resolveAgent(record.requestedAgent ?? record.agent, fresh ? [] : resumeArgs(tool, providerSessionId), {
    home: record.homePath,
    yolo: sniffYolo(record.command),
    identity: true,
  });
  if (!record.node) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, record.accountId);
  }

  const launch = await substrate.newSession(record.tmuxTarget, record.cwd, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    tmuxOptions: spec.tmuxOptions,
  });

  const updated =
    (await updateSession(record.name, {
      status: "running",
      command: shellCommand(spec),
      combId: record.combId ?? record.tmuxTarget,
      ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
      ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
      ...(sessionOverride ? { providerSessionId: sessionOverride } : {}),
      updatedAt: new Date().toISOString(),
    })) ?? record;
  await writeSpawnOptions(updated);
  await appendLedger({
    type: "bee.revive",
    session: record.name,
    providerSessionId: providerSessionId ?? null,
    agentPaneId: launch.paneId,
    fresh,
  });
  return updated;
}


/** Relaunch one dead bee and resume (or, with --fresh, start anew) its session. */
export async function reviveOne(record: SessionRecord, parsed: Parsed, opts: { skipReadyWait?: boolean } = {}): Promise<SessionRecord> {
  const substrate = substrateFor(record);
  if (await substrate.hasSession(record.tmuxTarget)) {
    throw new Error(`hive revive: ${record.name} is already running (${record.tmuxTarget})`);
  }
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  const fresh = truthy(flag(parsed, "fresh"));
  // --session <id> resumes (and persists) a specific provider session — used to
  // recover bees whose providerSessionId was never recorded but whose session
  // still exists on disk (claude/codex keep sessions keyed by project dir).
  const sessionOverride = stringFlag(parsed, ["session"]);
  const providerSessionId = fresh ? undefined : (sessionOverride ?? record.providerSessionId);
  if (!fresh && !providerSessionId) {
    throw new Error(
      `hive revive: ${record.name} has no recorded provider session id; pass --session <id> to resume an exact ${tool} session, or --fresh to start anew`,
    );
  }

  const updated = await reviveRecord(record, { fresh, sessionOverride });

  const how = providerSessionId ? `resumed ${providerSessionId}` : "fresh session";
  if (isPretty()) console.log(actionLine("ok", "revive", [bold(record.name), record.agent, dim(how)]));
  else console.log(`revived\t${record.name}\t${record.agent}\t${how}`);
  if (!opts.skipReadyWait) await waitForRevivedReady([updated], parsed);
  return updated;
}
