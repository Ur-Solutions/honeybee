// `hive fork`/split — branch a bee into a fresh comb (or an adjacent pane),
// seeded from its state, with account-safety resolution.
// Extracted from cli.ts (HIVE-15).
import { activateAccountIntoHome, defaultHomeForAccount, listAccounts, type AccountRecord } from "../accounts.js";
import { adoptInheritedHome, assertAgentAuthFreshForSpawn, canonicalAgentKind, forcedSessionIdArgs, refreshIdentityEnv, resolveAgent, shellCommand, stampBeeIdentityEnv } from "../agents.js";
import { agentKinds, forkCapabilityForAgent, sessionPinnedInArgs, sessionPinResumeExtrasForAgent } from "../drivers.js";
import { assertExecutableAvailable } from "../execCheck.js";
import { modelArgsFor, pickForkSeed, type ForkSeedDecision, type ForkSeedInput, type SeedMode } from "../fork.js";
import { copyThreadForFork, listTurnAnchors, locateThreadFile, parseAnchorFlag } from "../threadCopy.js";
import { chooseFork, defaultForkForm, forkIntent, type ForkAccountOption } from "../forkTui.js";
import { actionLine, bold, dim, isPretty, note, tildify } from "../format.js";
import { writeSpawnOptions } from "../hiveState.js";
import { adapterFor } from "../hsr/adapters/index.js";
import { hsrSubstrate } from "../hsr/substrate.js";
import { allocateBeeIdentity } from "../ids.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { acquireProSlot, deleteProSlot, listProRepoEntries, resolveProEntryForCwd, toProSlug, type ProSlotKind } from "../proProjects.js";
import { listSeals, loadLatestSeal } from "../seal.js";
import { resolveSelector } from "../selectors.js";
import { planSpawnPreamble } from "../spawnPreamble.js";
import { appendLedger, listSessions, safeName, saveSession, type SessionRecord } from "../store.js";
import { localSubstrate, substrateForRecord, type Substrate } from "../substrates/index.js";
import { formatShellCommand } from "../tmux.js";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { confirmPausedAccount, confirmSpawnReady, dangerousMode, deliverBrief, hasFlag, includePausedFlag, resolveBeeInCurrentPane, resolveSpawnCwd, resolveSpawnSubstrate, safeTmuxTarget, stringFlag, ttlFlagMs } from "../cli/shared.js";
import { cmdSend } from "../commands/messaging.js";
import { maybeLinkHere, newBeeAccountRows, resolveAccountFlag, resolvePreambleFlags } from "../commands/spawn.js";
import { spawnHsrHost, waitForHsrHost } from "../hsr/runnerHost.js";

/**
 * RETIRED (APIA-85). `hive split` was the comb splitter: it created an adjacent
 * pane in the parent bee's tmux session (`substrate.newPane`) so a sub-bee could
 * share the window. Combs are retired — Apiary lineage views + HSR subagents
 * replaced the "visible next to me" need — so this now errors and points at the
 * replacements. The dispatch case is kept so the message is discoverable.
 */
export async function cmdSplit(_parsed: Parsed): Promise<never> {
  throw new Error(
    "hive split is retired: combs (shared tmux panes) are gone. " +
      "Use `hive fork <bee>` to branch a bee pane-lessly on HSR (see `hive here` / `hive bees` " +
      "for lineage), or `hive x --substrate tmux` for a separate tmux bee.",
  );
}


export const FORK_SEED_MODES = new Set<SeedMode>(["resume", "seal", "summary", "log", "none"]);


/**
 * Account gate for `hive fork` (session-fork-and-handoff epic, relaxing
 * fork-and-pane §7.1). Ground truth: there is ONE home per account
 * (defaultHomeForAccount), and `--account auto` stacks multiple bees on the
 * least-loaded account's single home every day — a shared credential file is
 * the fleet's normal, safe configuration (rotations propagate through the
 * file). The dangerous configuration is one account's credentials COPIED into
 * two different homes, where rotation strands the stale copy; that only
 * happens via re-activation, which the caller therefore SKIPS for a fork that
 * joins the parent's account home (`joinsParentHome`).
 */
export async function resolveForkAccountSafety(
  parsed: Parsed,
  source: SessionRecord,
  context: { targetTool: string; requestedSeed?: SeedMode; threadCopy?: boolean; model?: string },
): Promise<{ account?: AccountRecord; joinsParentHome: boolean }> {
  const accountQuery = stringFlag(parsed, ["account"]);
  const wantsResume = context.requestedSeed === "resume";

  if (accountQuery) {
    const account = await resolveAccountFlag(accountQuery, context.targetTool, ttlFlagMs(parsed), includePausedFlag(parsed), context.model);
    if (source.accountId && account.id === source.accountId) {
      // Same account → the fork JOINS the parent's account home (same shared
      // credential file — the auto-stacking risk profile). No re-activation.
      await confirmPausedAccount(account, parsed);
      return { account, joinsParentHome: true };
    }
    // A different account brings its own dedicated home. Native resume can't
    // see the parent's provider session there — but a thread-copy harness
    // copies the session INTO the destination home, so only copy-incapable
    // harnesses must refuse.
    if (wantsResume && !context.threadCopy) {
      throw new Error(
        `--seed resume needs ${source.name}'s home to see its provider session; ` +
          `account ${account.id} has its own home and ${context.targetTool} cannot copy threads — fork with a seal instead`,
      );
    }
    await confirmPausedAccount(account, parsed);
    return { account, joinsParentHome: false };
  }

  if (source.accountId) {
    // Account-bound parent with no --account: inherit the parent's account and
    // join its home (relaxed 2026-07-24; previously refused). Same risk profile
    // as `--account auto` stacking a second bee on that account.
    const account = (await listAccounts()).find((candidate) => candidate.id === source.accountId);
    if (!account) {
      throw new Error(
        `${source.name} is bound to account ${source.accountId}, which is not in the vault — pass --account <a> (or --account auto)`,
      );
    }
    console.error(note(`fork inherits ${source.name}'s account (${account.id}); pass --account to use a different one`));
    return { account, joinsParentHome: true };
  }

  // Default-home parent (no accountId): allow a plain spawn (own fresh tmux
  // session in the default home — same risk profile as a second default bee).
  if (wantsResume && !context.threadCopy) {
    console.error(
      note(
        `warn: --seed resume reuses ${source.name}'s provider session in a shared home; ` +
          `the two processes may fight over the OAuth chain. Prefer --seed seal, or --account.`,
      ),
    );
  }
  return { joinsParentHome: false };
}


/**
 * hive fork <bee> [checkpoint]
 *   [--agent <kind>] [--model <m>] [--node <n>] [--cwd <dir>]
 *   [--seed resume|seal|summary|log|none] [--read-log]
 *   [--name <n>] [--account <a>] [--here] [--print]
 *
 * Branch an existing bee into a FRESH comb (its own session) seeded from the
 * source's state. fork-and-pane Phase C: layered seeding (resume → seal →
 * summary(deferred) → log → refuse), cross-harness forcing non-resume, account
 * safety, and anti-cross-match. See docs/fork-and-pane.md §7.1.
 */
export async function cmdFork(parsed: Parsed): Promise<SessionRecord> {
  const selector = parsed.args[0];
  if (!selector) {
    throw new Error(
      "Usage: hive fork <bee> [checkpoint] [--at <event-id|turn:N>] [--list-anchors] [--agent <kind>] [--model <m>] [--node <n>] " +
        "[--cwd <dir>] [--seed resume|seal|summary|log|none] [--read-log] [--name <n>] [--account <a>] [--here] [--print] [--json]",
    );
  }

  // Combs are retired (APIA-85): `--pane`/`--window` meant "split into the
  // parent's tmux session so I can see the fork next to me". Forks now run
  // pane-lessly on HSR; Apiary lineage views + `hive here`/`hive bees` provide
  // the visibility the split panes used to.
  if (hasFlag(parsed, "pane") || hasFlag(parsed, "window")) {
    throw new Error(
      "--pane/--window are retired; forks now run pane-lessly on HSR " +
        "(see hive here / hive bees for lineage), or use --substrate tmux for a separate tmux bee",
    );
  }

  // 1. Resolve source (single bee only — never fork a set).
  const resolved = await resolveSelector(selector);
  if (resolved.kind !== "bee") {
    throw new Error(`hive fork: ${selector} matched multiple bees; pick one`);
  }
  const source = resolved.record;

  // 2. Resolve the checkpoint seal.
  const checkpointArg = parsed.args[1];
  const seal = await resolveForkCheckpoint(source.name, checkpointArg);

  // 3. Resolve fork agent / model / node / cwd.
  const requestedAgent = stringFlag(parsed, ["agent"]) ?? source.requestedAgent ?? source.agent;
  const targetTool = canonicalAgentKind(requestedAgent);
  const sourceTool = canonicalAgentKind(source.agent);
  const model = stringFlag(parsed, ["model"]);
  const cwd = hasFlag(parsed, "cwd") ? await resolveSpawnCwd(parsed) : source.cwd;

  // 4. Validate the --seed value (if any).
  const seedFlag = stringFlag(parsed, ["seed"]);
  if (seedFlag !== undefined && !FORK_SEED_MODES.has(seedFlag as SeedMode)) {
    throw new Error(`hive fork: invalid --seed ${seedFlag} (use resume|seal|summary|log|none)`);
  }
  const requestedSeed = seedFlag as SeedMode | undefined;
  const readLog = truthy(flag(parsed, "read-log"));

  // 4b. Turn anchor + anchor enumeration (session-fork-and-handoff epic).
  const capability = forkCapabilityForAgent(targetTool);
  const anchor = parseAnchorFlag(stringFlag(parsed, ["at"]));
  if (hasFlag(parsed, "list-anchors")) {
    await printForkAnchors(parsed, source, sourceTool);
    return source;
  }
  if (anchor.kind === "turn") {
    if (targetTool !== sourceTool) {
      throw new Error(`hive fork: --at is same-harness only (${sourceTool}→${targetTool} cannot carry the thread) — use hive handoff`);
    }
    if (!capability.threadCopy) {
      throw new Error(`hive fork: --at needs thread-copy support and ${targetTool} has none — use hive handoff`);
    }
    if (requestedSeed !== undefined && requestedSeed !== "resume") {
      throw new Error(`hive fork: --at is a thread-preserving fork; it conflicts with --seed ${requestedSeed}`);
    }
    if (!source.providerSessionId) {
      throw new Error(`hive fork: ${source.name} has no recorded provider session id to copy from`);
    }
  }

  // 5. Account gate. Yields the account (if any) the fork will use, and
  //    whether it joins the parent's live account home (same account → no
  //    re-activation; see resolveForkAccountSafety).
  const { account, joinsParentHome } = await resolveForkAccountSafety(parsed, source, {
    targetTool,
    requestedSeed,
    threadCopy: capability.threadCopy,
    ...(model ? { model } : {}),
  });

  // 6. Pick the seed mode (pure decision). `hive handoff` rides this same
  //    pipeline with --seed summary plus a marker flag and the instruction.
  const isHandoff = hasFlag(parsed, "handoff");
  const handoffInstruction = stringFlag(parsed, ["handoff-instruction"]);
  const seedInput: ForkSeedInput = {
    source,
    seal,
    requestedSeed,
    readLog,
    targetTool,
    sourceTool,
    forkName: source.name,
    ...(handoffInstruction !== undefined ? { handoffInstruction } : {}),
  };
  let decision: ForkSeedDecision = pickForkSeed(seedInput);
  if (decision.mode === "refuse") throw new Error(`hive fork: ${decision.reason}`);
  // Tell the operator when a bare `hive fork` fell back to a cold boot because the
  // source had nothing to seed from (vs an explicit `--seed none`).
  if (decision.mode === "none" && seedInput.requestedSeed === undefined) {
    console.error(note(`${source.name} had no session/seal/transcript to seed from — forking cold`));
  }

  const yolo = dangerousMode(parsed, targetTool, requestedAgent);
  // Substrate policy (APIA-85 + session-fork-and-handoff): a fork is a sibling
  // of its source, so an HSR source forks pane-lessly even from a user shell —
  // which is also the only substrate where the thread copy is verified. An
  // explicit `--substrate`/`--node` still wins; otherwise spawn's origin
  // policy applies (agent-context → HSR).
  if (!hasFlag(parsed, "substrate") && !hasFlag(parsed, "node") && source.substrate === "hsr") {
    parsed.flags.set("substrate", "hsr");
  }
  const { useHsr, node } = await resolveSpawnSubstrate(parsed, targetTool);
  const isRemote = node?.kind === "ssh-tmux";
  if (account && isRemote) throw new Error("--account forks are local-only (the vault never leaves this machine)");

  // The account brings its own dedicated home; otherwise the fork boots in the
  // default home. A same-account fork's home IS the parent's account home
  // (joinsParentHome — resolveForkAccountSafety allowed it).
  const home = account ? defaultHomeForAccount(account) : undefined;

  // 6b. Thread copy. A thread-preserving fork of a copy-capable harness
  //     (claude, codex) never resumes the parent's session id directly: the
  //     provider transcript is copied — truncated at the anchor when one is
  //     given — under a FRESH session id in the DESTINATION store, and the
  //     fork resumes the copy (delivered via the HSR payload's resume opts,
  //     which both adapters speak). This carries full history across cwds,
  //     accounts, and claude's interactive↔headless store split (both
  //     verified live 2026-07-24), and doubles as anti-cross-match (the fork
  //     owns its id from birth). Interactive (tmux/remote) resume of a copied
  //     file is unverified, so the copy path is HSR-local only; tmux forks
  //     keep the old native-resume args.
  let copiedSessionId: string | undefined;
  if (decision.mode === "resume" && capability.threadCopy && source.providerSessionId) {
    if (useHsr && !isRemote) {
      const newSessionId = randomUUID();
      const copied = await copyThreadForFork({
        kind: targetTool,
        source: {
          cwd: source.cwd,
          providerSessionId: source.providerSessionId,
          ...(source.homePath ? { homePath: source.homePath } : {}),
        },
        destCwd: cwd,
        ...(home ? { destHome: home } : {}),
        newSessionId,
        anchor,
      });
      // The provider-facing id may differ from the minted uuid (kimi prefixes).
      copiedSessionId = copied.newProviderSessionId ?? newSessionId;
      decision = {
        mode: "resume",
        // The resume rides the HSR payload (sessionId + resume), not CLI args.
        resumeArgs: [],
        checkpoint: anchor.kind === "turn" ? `turn:${copied.boundaryOrdinal ?? "?"}:${copiedSessionId}` : `copy:${copiedSessionId}`,
      };
    } else if (anchor.kind === "turn") {
      throw new Error("hive fork: --at forks are HSR-local only for now (interactive resume of a copied thread is unverified)");
    }
  } else if (anchor.kind === "turn") {
    throw new Error(`hive fork: --at needs a thread-preserving fork of ${source.name} (no resumable session found)`);
  }

  // 7. Build the spawn spec and create the new comb. Resume args are baked into
  //    the spawn command (§7.1); seal/summary/log seed via a brief after spawn.
  const modelArgs = modelArgsFor(targetTool, model);
  const resumeArgsList = decision.mode === "resume" ? decision.resumeArgs : [];
  const extraArgs = [...resumeArgsList, ...modelArgs, ...parsed.rest];

  const spec = resolveAgent(requestedAgent, extraArgs, { home, yolo, identity: Boolean(account) });
  if (account) {
    if (!spec.homePath) throw new Error(`Agent ${spec.kind} has no home env; cannot bind account ${account.id}`);
    if (joinsParentHome) {
      // Joining the parent's live account home: credentials are already active
      // there, and a vault→home re-activation could overwrite freshly rotated
      // credentials with a stale vault snapshot — skip it.
    } else {
      await activateAccountIntoHome(account, spec.homePath, { onWarn: (message) => console.error(note(message)) });
      refreshIdentityEnv(spec);
    }
  }
  if (!isRemote) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, account?.id);
  }
  // Freeze the resolved fork launch before the HSR branch adds Hive's own
  // provider-session pin. Revive owns provider lifecycle args independently.
  const launchArgv = [spec.command, ...spec.args];

  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  const name = safeName(stringFlag(parsed, ["name"]) ?? identity.id);
  stampBeeIdentityEnv(spec.env, {
    name,
    id: identity.id,
    comb: name,
    parent: source.id ?? source.name,
  });
  // Session preamble: RE-rendered for the fork, never inherited. A fork is a
  // new bee with a new id, so copying the source's preamble would tell it it is
  // its own parent. The host layer (`--preamble`) can be re-supplied by the
  // forking caller; absent one, the fork keeps only identity + config layers.
  const preamblePlan = planSpawnPreamble({
    kind: spec.kind,
    identity: { name, id: identity.id, comb: name, parent: source.id ?? source.name },
    ...resolvePreambleFlags(parsed),
    warn: (message) => console.error(note(message)),
  });
  if (preamblePlan?.args.length) {
    spec.args = [...spec.args, ...preamblePlan.args];
    launchArgv.push(...preamblePlan.args);
  }
  const now = new Date().toISOString();

  // 8. Launch the fork on the chosen substrate and build the record with fork
  //    lineage + anti-cross-match fields. ANTI-CROSS-MATCH (§7.1): lastPromptAt
  //    set at creation; the fork gets its OWN provider session (a fresh pinned id
  //    under HSR, or a new tmux session), never the parent's transcript.
  let record: SessionRecord;
  let substrate: Substrate;
  if (useHsr) {
    // Pane-less fork: fork a detached runner host (mirrors spawnBee's HSR
    // branch). Pin a fresh provider session id when NOT resuming (resume already
    // carries continuity via its baked-in args).
    let pinnedSessionId: string | undefined;
    if (decision.mode !== "resume" && !sessionPinnedInArgs(spec.kind, spec.args)) {
      const sid = randomUUID();
      const sessionArgs = forcedSessionIdArgs(spec.kind, sid);
      if (sessionArgs) {
        // Caller args may still carry --resume even outside hive's own resume
        // mode; the pin then needs the driver's bridge flags (--fork-session).
        spec.args = [...spec.args, ...sessionArgs, ...sessionPinResumeExtrasForAgent(spec.kind, spec.args)];
        pinnedSessionId = sid;
      }
    }
    // The runner host inherits this process's env — record the effective home
    // (see adoptInheritedHome) before spec.env is shipped and command rendered.
    adoptInheritedHome(spec);
    const adapter = adapterFor(spec.kind);
    const runnerTier = adapter?.tier();
    const hostPid = await spawnHsrHost({
      bee: name,
      comb: name, // fork is its own comb (a fresh lineage root)
      kind: spec.kind,
      cwd,
      ...(copiedSessionId ? { sessionId: copiedSessionId, resume: true } : pinnedSessionId ? { sessionId: pinnedSessionId } : {}),
      authKind: "subscription",
      ...(account ? { accountId: account.id } : {}),
      ...(model ? { model } : {}),
      spec: { command: spec.command, args: spec.args, env: spec.env },
    });
    const command = shellCommand(spec);
    record = {
      name,
      agent: spec.kind,
      cwd,
      launchArgv,
      command,
      tmuxTarget: name, // logical id — HSR has no tmux target
      substrate: "hsr",
      runnerPid: hostPid,
      ...(runnerTier ? { runnerTier } : {}),
      combId: name, // fork is its own comb
      forkedFromId: source.id ?? source.name,
      forkedAt: now,
      seedMode: decision.mode,
      forkCheckpoint: decision.checkpoint,
      ...(model ? { model } : {}),
      createdAt: now,
      updatedAt: now,
      lastPromptAt: now, // anti-cross-match anchor
      status: "running",
      id: identity.id,
      prefix: identity.prefix,
      uuid: identity.uuid,
      requestedAgent: spec.requestedKind,
      homePath: spec.homePath,
      ...(copiedSessionId ? { providerSessionId: copiedSessionId } : pinnedSessionId ? { providerSessionId: pinnedSessionId } : {}),
      ...(account ? { accountId: account.id } : {}),
      ...(preamblePlan ? { preamble: preamblePlan.record } : {}),
      ...(source.colony ? { colony: source.colony } : {}),
    };
    substrate = hsrSubstrate();
    await saveSession(record);
    await writeSpawnOptions(record);
    if (!(await waitForHsrHost(name, 5000))) {
      console.error(note(`hsr host for ${name} did not report live within 5s; the daemon will reconcile`));
    }
  } else {
    const tmuxTarget = safeTmuxTarget(name);
    const nodeName = node?.name ?? LOCAL_NODE_NAME;
    substrate = node && nodeName !== LOCAL_NODE_NAME ? substrateForRecord(node) : localSubstrate();
    const locationHint = isRemote && node ? ` on ${node.name}` : "";
    if (await substrate.hasSession(tmuxTarget)) throw new Error(`tmux session already exists${locationHint}: ${tmuxTarget}`);

    const launch = await substrate.newSession(tmuxTarget, cwd, {
      command: spec.command,
      args: spec.args,
      env: spec.env,
      tmuxOptions: spec.tmuxOptions,
    });
    const command = shellCommand(spec);
    record = {
      name,
      agent: spec.kind,
      cwd,
      launchArgv,
      command,
      tmuxTarget,
      ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
      ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
      combId: tmuxTarget, // fork is its own comb (new session)
      forkedFromId: source.id ?? source.name,
      forkedAt: now,
      seedMode: decision.mode,
      forkCheckpoint: decision.checkpoint,
      ...(model ? { model } : {}),
      createdAt: now,
      updatedAt: now,
      lastPromptAt: now, // anti-cross-match anchor
      status: "running",
      id: identity.id,
      prefix: identity.prefix,
      uuid: identity.uuid,
      requestedAgent: spec.requestedKind,
      homePath: spec.homePath,
      ...(account ? { accountId: account.id } : {}),
      ...(nodeName !== LOCAL_NODE_NAME ? { node: nodeName } : {}),
      ...(preamblePlan ? { preamble: preamblePlan.record } : {}),
      ...(source.colony ? { colony: source.colony } : {}),
    };
    await saveSession(record);
    await writeSpawnOptions(record);
  }

  // 9. Ledger.
  await appendLedger({
    type: isHandoff ? "handoff.create" : "fork.create",
    name,
    forkedFromId: record.forkedFromId,
    seedMode: record.seedMode,
    forkCheckpoint: record.forkCheckpoint,
    ...(model ? { model } : {}),
    ...(record.substrate === "hsr" ? { substrate: "hsr" } : {}),
    ...(record.node ? { node: record.node } : {}),
  });

  // Print the success line. The trailing `command` field on the tab form makes
  // the resume-args / model-args assertion trivial in the non-TTY test harness.
  const verb = isHandoff ? "handoff" : "fork";
  if (isPretty()) {
    console.log(actionLine("ok", verb, [bold(name), spec.kind, dim(`from ${source.name}`), dim(decision.mode)]));
  } else {
    console.log(`${verb}\t${name}\t${spec.kind}\t${source.name}\t${decision.mode}\t${record.command}`);
  }

  // 10. Seed: resume/none carry the seed in the spawn command (or boot cold);
  //     seal/summary/log deliver a brief once ready.
  let finalRecord = record;
  if (decision.mode === "seal" || decision.mode === "summary" || decision.mode === "log") {
    finalRecord = await deliverBrief(parsed, record, decision.brief);
  } else {
    await confirmSpawnReady(parsed, record);
  }

  // Machine-readable success (Apiary parses the last JSON stdout line).
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({
      name: finalRecord.name,
      ...(finalRecord.id ? { id: finalRecord.id } : {}),
      agent: finalRecord.agent,
      forkedFrom: source.name,
      seedMode: record.seedMode,
      ...(record.forkCheckpoint ? { checkpoint: record.forkCheckpoint } : {}),
      ...(copiedSessionId ? { providerSessionId: copiedSessionId } : {}),
    }));
  }

  // 11. --print / --here behave like spawn's interactive affordances. An HSR bee
  //     has no tmux target to attach — point at the pane-less read paths instead.
  if (truthy(flag(parsed, "print"))) {
    if (record.substrate === "hsr") {
      console.error(note(`${record.name} runs pane-lessly on HSR; read it with: hive tail ${record.name} / hive transcript ${record.name}`));
    } else {
      if (isPretty()) console.error(note("attach with:"));
      console.log(formatShellCommand(substrate.attachCommand(record.tmuxTarget)));
    }
  }
  await maybeLinkHere(parsed, [finalRecord]);
  return finalRecord;
}


/**
 * `hive fork --list-anchors <bee>` — enumerate the source's turn boundaries so
 * external callers (Apiary's per-turn actions) can anchor a fork/handoff
 * without parsing provider transcripts. Tab form: ordinal, completed, user
 * event id, timestamp, preview; `--json` emits the TurnAnchor array.
 */
async function printForkAnchors(parsed: Parsed, source: SessionRecord, sourceTool: string): Promise<void> {
  const capability = forkCapabilityForAgent(sourceTool);
  if (!capability.threadCopy) throw new Error(`hive fork --list-anchors: ${sourceTool} has no thread-copy support; anchors are unavailable`);
  if (!source.providerSessionId) throw new Error(`hive fork --list-anchors: ${source.name} has no recorded provider session id`);
  const path = await locateThreadFile(sourceTool, {
    cwd: source.cwd,
    providerSessionId: source.providerSessionId,
    ...(source.homePath ? { homePath: source.homePath } : {}),
  });
  const raw = await readFile(path, "utf8").catch(() => {
    throw new Error(`hive fork --list-anchors: no provider session file at ${path}`);
  });
  const anchors = listTurnAnchors(sourceTool, raw.split("\n").filter((line) => line.trim().length > 0));
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(anchors));
    return;
  }
  for (const entry of anchors) {
    console.log(`turn:${entry.ordinal}\t${entry.completed ? "done" : "open"}\t${entry.userEventId ?? entry.endEventId ?? ""}\t${entry.ts ?? ""}\t${entry.preview}`);
  }
}


/**
 * Resolve the fork's checkpoint seal: absent/`latest` → the latest seal;
 * `seal:<ISO>` → that specific seal; `msg:N` → deferred.
 */
export async function resolveForkCheckpoint(beeName: string, checkpointArg: string | undefined): Promise<import("../seal.js").SealRecord | null> {
  if (!checkpointArg || checkpointArg === "latest") return loadLatestSeal(beeName);
  if (checkpointArg.startsWith("msg:")) {
    throw new Error("hive fork: message-offset checkpoints are deferred (§9/§11); use a seal");
  }
  if (checkpointArg.startsWith("seal:")) {
    const wanted = checkpointArg.slice("seal:".length);
    const normalized = wanted.replace(/[:.]/g, "-");
    const seals = await listSeals(beeName);
    const match = seals.find((s) => s.sealedAt === wanted || s.sealedAt.replace(/[:.]/g, "-") === normalized);
    if (!match) throw new Error(`hive fork: no seal ${wanted} for ${beeName}`);
    return match;
  }
  throw new Error(`hive fork: unrecognized checkpoint "${checkpointArg}" (use latest or seal:<ISO>)`);
}

// ── hive fork launch — the interactive dialog (⌘K) ───────────────────────────


export async function hasRecordedForkUsingCwd(source: SessionRecord, cwd: string): Promise<boolean> {
  const sourceIds = new Set([source.name, ...(source.id ? [source.id] : [])]);
  const records = await listSessions();
  return records.some((record) => record.cwd === cwd && record.forkedFromId !== undefined && sourceIds.has(record.forkedFromId));
}


/**
 * `hive fork launch` — the interactive fork window (the ⌘K target). The SOURCE
 * is the bee owning the current pane, so the dialog opens straight on a form for
 * composing the fork (seed, agent, model, worktree isolation, account, name).
 * The chosen values are turned into a `hive fork` invocation and run through
 * cmdFork, so account-safety, anti-cross-match, the ledger, and --here linking
 * are all reused unchanged.
 */
export async function cmdForkLaunch(parsed: Parsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive fork launch needs a TTY — bind it to a tmux popup: bind -n M-k display-popup -E "hive fork launch"');
  }
  const source = await resolveBeeInCurrentPane();
  if (!source) {
    throw new Error("hive fork launch: no bee owns the current pane — run it from inside a bee, or use `hive fork <bee>`.");
  }
  const sourceKind = canonicalAgentKind(source.agent);

  // Worktree isolation is offered only when the source lives inside a pro repo.
  const proRepo = await (async (): Promise<{ label: string; path: string } | null> => {
    try {
      const entry = resolveProEntryForCwd(await listProRepoEntries(), source.cwd);
      if (!entry) return null;
      const label = [entry.area, entry.project, entry.repo].filter((part) => part.length > 0).join("/") || entry.path;
      return { label, path: entry.path };
    } catch {
      return null;
    }
  })();

  // Account options. An account-bound source now INHERITS its account by
  // default (relaxed 2026-07-24): the fork joins the parent's account home —
  // the same shared-credential-file configuration `--account auto` stacking
  // produces every day. Other accounts remain selectable to spread quota.
  const accountRequired = false;
  const accounts = await newBeeAccountRows(sourceKind).catch(() => []);
  const accountOptions: ForkAccountOption[] = [];
  accountOptions.push({ value: "", label: source.accountId ? `inherit (${source.accountId})` : "inherit (no account binding)" });
  accountOptions.push({ value: "auto", label: "auto", detail: "least-loaded account" });
  for (const acct of accounts) {
    accountOptions.push({ value: acct.id, label: acct.label, ...(acct.usage ? { detail: acct.usage } : {}) });
  }

  const suggestSlot = toProSlug(`fork-${source.name}`) || toProSlug(sourceKind) || "fork";
  const defaults = defaultForkForm({ sourceAgent: sourceKind, accountRequired, accountOptions, suggestSlot });

  const result = await chooseFork({
    source: {
      name: source.name,
      id: source.id ?? source.name,
      agent: sourceKind,
      cwd: source.cwd,
      ...(source.accountId ? { accountId: source.accountId } : {}),
    },
    cwdLabel: tildify(source.cwd),
    agentKinds: agentKinds(),
    proRepo,
    accountRequired,
    accountOptions,
    defaults,
  });

  if (!result) {
    if (isPretty()) console.error(note("fork launch: cancelled"));
    return;
  }

  const intent = forkIntent(result.values, { sourceName: source.name, sourceAgent: sourceKind });

  // Create the worktree/checkout up front — its path becomes the fork's --cwd.
  let cwd: string | undefined;
  let createdSlot: { kind: ProSlotKind; repoPath: string; name: string; path: string } | undefined;
  if (intent.isolation) {
    if (!proRepo) throw new Error("hive fork launch: not a pro repo — cannot create a worktree");
    const slug = toProSlug(intent.isolation.name);
    if (!slug) throw new Error("hive fork launch: worktree name must contain letters, digits, or dashes");
    if (isPretty()) console.error(note(`creating ${intent.isolation.kind} ${slug}…`));
    const slot = await acquireProSlot(intent.isolation.kind, proRepo.path, slug);
    const slotPath = await realpath(slot.path).catch(() => slot.path);
    cwd = slotPath;
    if (slot.created) createdSlot = { kind: intent.isolation.kind, repoPath: proRepo.path, name: slug, path: slotPath };
  }

  // Build a `hive fork` invocation and reuse cmdFork wholesale.
  const flags = new Map<string, string | true | string[]>();
  if (intent.seed) flags.set("seed", intent.seed);
  if (intent.agent) flags.set("agent", intent.agent);
  if (intent.model) flags.set("model", intent.model);
  if (intent.name) flags.set("name", intent.name);
  if (intent.account) flags.set("account", intent.account);
  if (cwd) flags.set("cwd", cwd);
  flags.set("here", true);

  let record: SessionRecord;
  try {
    record = await cmdFork({ command: "fork", args: [source.name], flags, rest: [] });
  } catch (error) {
    if (createdSlot) {
      const launched = await hasRecordedForkUsingCwd(source, createdSlot.path).catch((checkError) => {
        const message = checkError instanceof Error ? checkError.message : String(checkError);
        console.error(note(`warn: keeping ${createdSlot.kind} ${createdSlot.name}; could not verify fork records: ${message}`));
        return true;
      });
      if (!launched) {
        if (isPretty()) console.error(note(`removing ${createdSlot.kind} ${createdSlot.name} after failed fork...`));
        try {
          await deleteProSlot(createdSlot.kind, createdSlot.repoPath, createdSlot.name);
        } catch (cleanupError) {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          console.error(note(`warn: failed to remove ${createdSlot.kind} ${createdSlot.name} at ${tildify(createdSlot.path)}: ${message}`));
        }
      }
    }
    throw error;
  }

  if (intent.message) {
    await cmdSend({ command: "send", args: [record.name, intent.message], flags: new Map(), rest: [] });
  }
}
