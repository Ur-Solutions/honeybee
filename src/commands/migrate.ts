// `hive promote`/demote/revive — substrate migration: move a bee between an
// interactive tmux pane and a pane-less HSR runner (resume), and revive dead bees.
// Extracted from cli.ts (HIVE-15).
import { accountEmail, activateAccountIntoHome, captureAccountFromHome, findAccount, homeClaudeEmail, listAccounts, type AccountRecord } from "../accounts.js";
import { adoptInheritedHome, agentDefaultsToYolo, assertAgentAuthFreshForSpawn, canonicalAgentKind, refreshIdentityEnv, resolveAgent, shellCommand, shellQuoteIfNeeded, splitShellWords, type AgentSpec } from "../agents.js";
import { assertExecutableAvailable } from "../execCheck.js";
import { actionLine, bold, dim, isPretty, note } from "../format.js";
import { writeSpawnOptions } from "../hiveState.js";
import { adapterFor } from "../hsr/adapters/index.js";
import { hsrObservations, type HsrObservation } from "../hsr/observe.js";
import { connectRpcClient } from "../hsr/rpc.js";
import { hsrEventsPath, readHsrMeta } from "../hsr/runDir.js";
import { hsrSubstrate } from "../hsr/substrate.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { waitForAgentReady } from "../readiness.js";
import { loadLatestSeal } from "../seal.js";
import { appendLedger, listSessions, storeRoot, updateSession, type SessionRecord } from "../store.js";
import { localSubstrate, substrateFor } from "../substrates/index.js";
import { resumeArgs, sniffYolo } from "../swap.js";
import { formatShellCommand, hasSession } from "../tmux.js";
import { identityRecipeForAgent, modelArgsForAgent } from "../drivers.js";
import { resolveSession, safeTmuxTarget, sleep, stringFlag } from "../cli/shared.js";
import { loginSeatLiveDigest } from "./account.js";
import { spawnHsrHost, waitForHsrHost } from "../hsr/runnerHost.js";
import { appendFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

// Harnesses whose interactive↔headless resume genuinely carries history — the
// only ones promote/demote accept. claude is EXCLUDED: its interactive-TUI and
// headless (`-p`) session stores are disjoint, so `claude --resume <id>` cannot
// rejoin a headless HSR session (and vice-versa) — a resumed process errors and
// exits. codex has no such split (`codex resume <threadId>` rejoins an
// app-server thread). Kimi's and Grok's interactive CLIs and ACP runners share
// their native session stores and accept the same session ids. OpenCode's TUI
// and REST server use the same SQLite-backed session id and directory ownership. See
// docs/HSR_EXPLORATION.md §7.
// Re-add
// "claude" here the day a claude release unifies the two stores.
export const RESUME_GATED_HARNESSES = new Set(["codex", "grok", "opencode", "kimi"]);


/**
 * Gate a promote/demote: the harness must have a verified resume path and the
 * bee must carry a provider session id to resume. Returns the lowercased tool.
 */
export function assertResumable(record: SessionRecord, verb: "promote" | "demote"): string {
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  if (tool === "claude") {
    throw new Error(
      `hive ${verb} does not support claude: its interactive and headless (-p) session stores are disjoint, so a resumed session cannot carry history (docs/HSR_EXPLORATION.md §7). codex, grok, opencode, and kimi are supported.`,
    );
  }
  if (!RESUME_GATED_HARNESSES.has(tool)) {
    throw new Error(`hive ${verb} needs a resumable provider session; ${record.agent} is not resume-gated (only codex, grok, opencode, and kimi)`);
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
export async function quiesceHsrBee(record: SessionRecord, now: boolean, verb = "promote"): Promise<void> {
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
  throw new Error(`hive ${verb}: ${record.name} is still mid-turn after 30s; retry with --now to interrupt`);
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
  const spec = resolveAgent(record.requestedAgent ?? record.agent, [...modelExtraArgsFor(record), ...extraArgs], {
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
  // Legacy records without homePath: a relaunch from inside another bee's
  // session would silently inherit its home env var — make it explicit so the
  // relaunched agent's home is deterministic and persistable (callers stamp
  // spec.homePath back onto the record).
  adoptInheritedHome(spec);
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
    ...(spec.homePath && !record.homePath ? { homePath: spec.homePath } : {}),
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
export async function reviveTmuxPane(record: SessionRecord, tool: string, opts: { fresh?: boolean } = {}): Promise<void> {
  const spec = await buildResumeSpec(record, tool, opts.fresh ? [] : resumeArgs(tool, record.providerSessionId));
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
    // A fresh relaunch abandons the old provider session — keeping its id
    // would make the next resume rejoin a conversation this bee left behind.
    ...(opts.fresh ? { providerSessionId: undefined } : {}),
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
    ...(spec.homePath && !record.homePath ? { homePath: spec.homePath } : {}),
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
        // failed (tmux server crash, external kill, harness exit). A bee with a
        // seal finished its work before exiting — deriveState reports it
        // "sealed", not "crashed" — so --crashed must not resurrect it.
        if (bulkCrashed && record.status !== "running") {
          continue;
        }
        if (bulkCrashed && (await loadLatestSeal(record.name))) {
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
 * hive auth-resume <bee>
 *
 * Human-login recovery for a live-but-stuck `auth-needed` bee:
 *   1. capture fresh credentials from the account's login seat,
 *   2. activate them into the bee's dedicated home,
 *   3. stop the stuck runtime,
 *   4. relaunch the same bee and resume the same provider session.
 *
 * Unlike `revive`, this intentionally accepts a LIVE runtime: `auth-needed`
 * runners are alive enough to hold a record but unable to make progress.
 */
export async function cmdAuthResume(parsed: Parsed): Promise<void> {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive auth-resume <bee>");
  const record = await resolveSession(target);
  if (record.node && record.node !== LOCAL_NODE_NAME) {
    throw new Error(`hive auth-resume: ${record.name} is on remote node ${record.node}; local login recovery only supports local bees`);
  }
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  if (!record.accountId) {
    throw new Error(`hive auth-resume: ${record.name} has no bound account; re-run with hive login <account> and revive manually`);
  }
  if (!record.homePath) {
    throw new Error(`hive auth-resume: ${record.name} has no dedicated home; refusing to overwrite the default ${tool} credentials`);
  }
  if (!record.providerSessionId) {
    throw new Error(`hive auth-resume: ${record.name} has no recorded provider session id; use hive revive ${record.name} --fresh if you want a fresh session`);
  }

  const account = await findAccount(record.accountId, tool);
  const seatHome = resolve(storeRoot(), "login-homes", account.id);
  await assertLoginSeatFreshForAuthResume(account, seatHome);
  const captured = await captureAccountFromHome(account, seatHome).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`hive auth-resume: no fresh login captured for ${account.id} (${message}); run hive login ${account.id} first`);
  });

  await activateAccountIntoHome(account, record.homePath, { onWarn: (message) => console.error(note(message)) });
  await stopRuntimeForAuthResume(record);
  const revived = await reviveRecord(record, { fresh: false });
  // Bound the auth-needed stickiness in the events tail: a resumed bee sits
  // idle, so without this marker structuredStateFromEvents keeps re-deriving
  // auth-needed from the stale login-required error turn (CL.8d7, 2026-07-16).
  // Best-effort — an HSR-less (tmux) bee has no events log and that's fine.
  await appendFile(
    hsrEventsPath(record.name),
    `${JSON.stringify({ type: "auth_resume", ts: Date.now() })}\n`,
  ).catch(() => {});
  const cleared =
    (await updateSession(record.name, {
      lastObservedState: undefined,
      lastObservedStateAt: undefined,
      updatedAt: new Date().toISOString(),
    })) ?? revived;
  await appendLedger({
    type: "bee.auth_resume",
    session: record.name,
    account: account.id,
    providerSessionId: record.providerSessionId,
  });

  if (isPretty()) {
    console.log(actionLine("ok", "auth-resume", [bold(record.name), account.id, dim(`${captured.length} credential file(s)`)]));
  } else {
    console.log(`auth-resumed\t${record.name}\t${account.id}\t${cleared.providerSessionId ?? ""}`);
  }
}

async function assertLoginSeatFreshForAuthResume(account: AccountRecord, seatHome: string): Promise<void> {
  const recipe = identityRecipeForAgent(account.tool);
  if (!recipe) throw new Error(`hive auth-resume: tool ${account.tool} has no identity recipe`);
  const markerPath = resolve(seatHome, ".login-seat-started");
  const marker = await stat(markerPath).catch(() => null);
  if (!marker) throw new Error(`hive auth-resume: run hive login ${account.id} first`);

  const primary = recipe.credentialFiles[0]!;
  const primaryInfo = await stat(resolve(seatHome, primary)).catch(() => null);
  if (primaryInfo?.isFile() && primaryInfo.mtimeMs >= marker.mtimeMs) return;

  const baselineDigest = await readLoginMarkerDigest(markerPath);
  const currentDigest = await loginSeatLiveDigest(account, seatHome);
  if (currentDigest !== null && currentDigest !== baselineDigest) return;

  throw new Error(`hive auth-resume: login for ${account.id} is not complete; finish the login seat first`);
}

async function readLoginMarkerDigest(markerPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { keychainDigest?: unknown };
    return typeof parsed.keychainDigest === "string" ? parsed.keychainDigest : null;
  } catch {
    return null;
  }
}

async function stopRuntimeForAuthResume(record: SessionRecord): Promise<void> {
  const substrate = substrateFor(record);
  const target = record.substrate === "hsr" ? record.name : record.tmuxTarget;
  if (!(await substrate.hasSession(target).catch(() => false))) return;
  const result = await substrate.kill(target, { launcherPgid: record.launcherPgid });
  if (!result.ok) {
    throw new Error(`hive auth-resume: could not stop ${record.name}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await substrate.hasSession(target).catch(() => true))) return;
    await sleep(100);
  }
  throw new Error(`hive auth-resume: ${record.name} did not stop within 5s; retry after the runtime exits`);
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
 * Waits for readiness, but fails fast when the bee's session disappears — a
 * resumed harness that exits immediately (e.g. `claude --resume` of a
 * never-persisted session) should fail the wait in seconds, not burn the full
 * timeout. The liveness poll stops as soon as the readiness wait settles, so
 * a finished revive never keeps the process alive on stray timers.
 */
async function waitReadyOrDead(record: SessionRecord, timeoutMs: number): Promise<void> {
  const substrate = substrateFor(record);
  let settled = false;
  const watcher = (async (): Promise<never> => {
    const deadline = Date.now() + timeoutMs;
    while (!settled && Date.now() < deadline) {
      await sleep(2000);
      if (settled) break;
      const alive = await substrate.hasSession(record.tmuxTarget).catch(() => true);
      if (!alive) {
        throw new Error(`${record.agent} exited right after relaunch (its resumed session may not exist on disk); try: hive revive ${record.name} --fresh`);
      }
    }
    // Ready (or timed out) without death: park until the race is decided by
    // waitForAgentReady. `settled` is already true or imminent, so this
    // pending promise is dropped with the race and holds no timers.
    return new Promise<never>(() => undefined);
  })();
  try {
    await Promise.race([waitForAgentReady(record, { timeoutMs }), watcher]);
  } finally {
    settled = true;
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
          await waitReadyOrDead(record, timeoutMs);
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
  // The first-class model + its persisted extra flags ride along — without
  // them a revived bee silently falls back to the harness default model
  // (the HSR path via buildResumeSpec always applied them; this path must too).
  const spec = resolveAgent(record.requestedAgent ?? record.agent, [...modelExtraArgsFor(record), ...(fresh ? [] : resumeArgs(tool, providerSessionId))], {
    home: record.homePath,
    yolo: sniffYolo(record.command),
    identity: true,
    ...(record.model ? { model: record.model } : {}),
  });
  // Refresh the bee's HOME credentials from the vault before relaunch. A bee
  // whose home token expired while it was dead otherwise boots logged-out: the
  // daemon's chain sync only pulls home→vault (keeping the vault fresh, which
  // is why `hive usage` still reports for a "logged out" account), and never
  // pushes vault→home, so nothing refreshes a dead bee's home. Only a running
  // claude or an activation does — and revive historically skipped activation
  // to dodge cross-account OAuth hazards. We dodge that hazard WITHOUT skipping
  // the refresh by resolving the account from the HOME's OWN login identity
  // (its .claude.json email), never record.accountId — which drifts from the
  // home after swap races (seen live 2026-07-08: 6 gmail-home bees whose
  // records pointed at ursolutions/arbeidsark). Activating the home's own
  // identity is the same safe refresh `hive activate` performs. (claude only;
  // grok/cursor keep their existing assert path.)
  let ownerId: string | undefined;
  if (!record.node) {
    await assertExecutableAvailable(spec.command);
    if (tool === "claude" && record.homePath) {
      const owner = await claudeAccountOwningHome(record.homePath);
      if (owner) {
        ownerId = owner.id;
        await activateAccountIntoHome(owner, record.homePath).catch((error) => {
          console.error(note(`revive: could not refresh ${record.name}'s home credentials (${owner.id}): ${error instanceof Error ? error.message : String(error)}`));
        });
      }
    } else {
      await assertAgentAuthFreshForSpawn(spec, record.accountId);
    }
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
      // Self-heal a drifted accountId: the home's true owner is authoritative,
      // so a record that pointed at the wrong account is corrected on revive.
      ...(ownerId && ownerId !== record.accountId ? { accountId: ownerId } : {}),
      // A fresh revive abandons the old provider session: keeping its id would
      // make the NEXT revive resume a session that no longer matches this bee
      // (or never existed), dying with "No conversation found". Explicit
      // undefined deletes the field.
      ...(fresh ? { providerSessionId: undefined } : {}),
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


/**
 * The claude account that TRULY owns a home, resolved from the home's own
 * recorded login identity (.claude.json oauthAccount email), not from any
 * session record's accountId — which can drift from the home after swap races.
 * Used to refresh a home from the right vault on revive without a cross-account
 * stamp. Returns undefined when the home has no recorded email or no matching
 * claude account exists.
 */
async function claudeAccountOwningHome(homePath: string): Promise<AccountRecord | undefined> {
  const email = await homeClaudeEmail(homePath).catch(() => null);
  if (!email) return undefined;
  return (await listAccounts()).find((account) => account.tool === "claude" && accountEmail(account) === email);
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


/** The persisted model extra flags as argv words, [] when none are recorded. */
function modelExtraArgsFor(record: SessionRecord): string[] {
  return record.modelExtraArgs ? splitShellWords(record.modelExtraArgs) : [];
}


/**
 * hive set-model <bee> <model> [--clear] [--fresh] [--now] [-- <harness flags>]
 *
 * Change an existing bee's model IN PLACE: same record identity, same
 * substrate, and (by default) the same provider conversation. The model lands
 * on the first-class record field; anything after `--` (reasoning/effort
 * switches like `--effort high`) is persisted as modelExtraArgs so every later
 * relaunch re-applies it. Each call REPLACES the whole selection — omitting
 * `--` clears previously recorded extra flags, and `--clear` (instead of a
 * model) returns the bee to its harness default.
 *
 * A live bee is quiesced (HSR waits for turn end, `--now` interrupts; tmux is
 * killed outright like swap-account), then relaunched resuming the same
 * provider session. Unlike promote/demote this never crosses the
 * interactive/headless store boundary — HSR resumes headlessly, tmux resumes
 * interactively — so every resumable harness keeps its history. If the
 * relaunched agent exits within the settle window (bad model name, rejected
 * resume) the previous selection is restored and relaunched.
 *
 * A dead bee just gets the fields recorded; the next revive applies them
 * (reviveRecord/buildResumeSpec both honor model + modelExtraArgs).
 */
export async function cmdSetModel(parsed: Parsed): Promise<void> {
  const usage = "Usage: hive set-model <bee> <model> [--clear] [--fresh] [--now] [-- <harness flags>]";
  const target = parsed.args[0];
  const clear = truthy(flag(parsed, "clear"));
  const model = parsed.args[1];
  if (!target || (!model && !clear)) throw new Error(usage);
  if (model && clear) throw new Error(`hive set-model: pass either <model> or --clear, not both\n${usage}`);
  const record = await resolveSession(target);
  if (record.node && record.node !== LOCAL_NODE_NAME) {
    throw new Error(`hive set-model: ${record.name} is on remote node ${record.node}; set-model only supports local bees`);
  }
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  // OpenCode multiplexes providers. Persist the qualified selector as the
  // first-class model so revive/promote/demote can rebuild it without a
  // separate provider field on SessionRecord.
  const modelSlash = model?.indexOf("/") ?? -1;
  if (!clear && tool === "opencode" && (modelSlash <= 0 || modelSlash === (model?.length ?? 0) - 1)) {
    throw new Error("hive set-model: opencode requires a qualified provider/model selector");
  }
  if (!clear && modelArgsForAgent(tool, model).length === 0) {
    throw new Error(`hive set-model: ${record.agent} has no model selector (no model flag known for ${tool})`);
  }
  const fresh = truthy(flag(parsed, "fresh"));
  const now = truthy(flag(parsed, "now"));
  const extraLine = parsed.rest.length > 0 ? parsed.rest.map(shellQuoteIfNeeded).join(" ") : undefined;

  // Server-tier harnesses mint their provider thread id at RUNTIME — backfill
  // it from the HSR meta (mirrors promote) so the resume gate below can see it.
  if (record.substrate === "hsr" && !record.providerSessionId) {
    const meta = await readHsrMeta(record.name).catch(() => null);
    if (meta?.sessionId) {
      record.providerSessionId = meta.sessionId;
      await updateSession(record.name, { providerSessionId: meta.sessionId });
    }
  }

  const substrate = substrateFor(record);
  const alive = await substrate.hasSession(record.tmuxTarget).catch(() => false);
  if (alive && !fresh && !record.providerSessionId) {
    throw new Error(
      `hive set-model: ${record.name} has no recorded provider session id to resume; retry with --fresh to relaunch on a new provider session`,
    );
  }

  const previous = { model: record.model, modelExtraArgs: record.modelExtraArgs };
  // Explicit undefined deletes the field (replace semantics; see updateSession).
  const applyFields: Partial<SessionRecord> = {
    model: clear ? undefined : model,
    modelExtraArgs: extraLine,
    ...(fresh ? { providerSessionId: undefined } : {}),
    updatedAt: new Date().toISOString(),
  };

  if (!alive) {
    const updated = (await updateSession(record.name, applyFields)) ?? { ...record, ...applyFields };
    await appendLedger({
      type: "bee.set_model",
      session: record.name,
      from: previous.model ?? null,
      to: updated.model ?? null,
      extraArgs: extraLine ?? null,
      relaunched: false,
    });
    if (isPretty()) console.log(actionLine("ok", "set-model", [bold(record.name), updated.model ?? "harness default", dim("recorded; applies on next revive")]));
    else console.log(`set-model\t${record.name}\t${updated.model ?? ""}\trecorded`);
    return;
  }

  // Stop the runtime BEFORE persisting the new selection — a failed quiesce/
  // kill must leave the record describing what is actually still running.
  if (record.substrate === "hsr") {
    await quiesceHsrBee(record, now, "set-model");
    await stopHsrRunner(record);
  } else {
    // tmux: a pane's mid-turn state is heuristic (mirrors demote) — interrupt
    // with --now, then kill the session outright like swap-account does.
    if (now) {
      await localSubstrate().sendKey(record.tmuxTarget, "C-c", record.agentPaneId).catch(() => undefined);
      await sleep(300);
    }
    await localSubstrate().kill(record.tmuxTarget, { launcherPgid: record.launcherPgid }).catch(() => undefined);
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (!(await substrate.hasSession(record.tmuxTarget).catch(() => true))) break;
      await sleep(250);
    }
    if (await substrate.hasSession(record.tmuxTarget).catch(() => false)) {
      throw new Error(`hive set-model: ${record.tmuxTarget} is still alive after kill; aborting before relaunch`);
    }
  }

  const updated = (await updateSession(record.name, applyFields)) ?? { ...record, ...applyFields };

  // Restore the previous selection and relaunch it — the recovery mirror of
  // promote/demote's rollback, so a bad model name never leaves a dead bee.
  const rollback = async (): Promise<void> => {
    const restoredFields: Partial<SessionRecord> = {
      model: previous.model,
      modelExtraArgs: previous.modelExtraArgs,
      updatedAt: new Date().toISOString(),
    };
    const restored = (await updateSession(record.name, restoredFields)) ?? { ...record, ...restoredFields };
    if (record.substrate === "hsr") await reviveHsrRunner(restored, tool, { fresh });
    else await reviveTmuxPane(restored, tool, { fresh });
  };

  if (record.substrate === "hsr") {
    await reviveHsrRunner(updated, tool, { fresh });
    if (!(await hsrChildSurvives(record.name, RESUME_LIVENESS_SETTLE_MS))) {
      await rollback().catch(() => undefined);
      throw new Error(
        `hive set-model: ${record.agent} exited immediately on model ${model ?? "(default)"} — bad model name or rejected resume; previous model restored`,
      );
    }
  } else {
    await reviveTmuxPane(updated, tool, { fresh });
    if (!(await tmuxSessionSurvives(substrate, record.tmuxTarget, RESUME_LIVENESS_SETTLE_MS))) {
      await rollback().catch(() => undefined);
      throw new Error(
        `hive set-model: ${record.agent} exited immediately on model ${model ?? "(default)"} — bad model name or rejected resume; previous model restored`,
      );
    }
  }

  await appendLedger({
    type: "bee.set_model",
    session: record.name,
    from: previous.model ?? null,
    to: updated.model ?? null,
    extraArgs: extraLine ?? null,
    relaunched: true,
    providerSessionId: fresh ? null : (record.providerSessionId ?? null),
  });
  const how = fresh ? "fresh session" : `resumed ${record.providerSessionId}`;
  if (isPretty()) {
    console.log(actionLine("ok", "set-model", [bold(record.name), `${previous.model ?? "default"} → ${updated.model ?? "default"}`, dim(how)]));
  } else {
    console.log(`set-model\t${record.name}\t${updated.model ?? ""}\t${how}`);
  }
}
