// `hive fork`/split — branch a bee into a fresh comb (or an adjacent pane),
// seeded from its state, with account-safety resolution.
// Extracted from cli.ts (HIVE-15).
import { activateAccountIntoHome, defaultHomeForAccount, type AccountRecord } from "../accounts.js";
import { assertAgentAuthFreshForSpawn, canonicalAgentKind, forcedSessionIdArgs, resolveAgent, shellCommand } from "../agents.js";
import { agentKinds, sessionPinnedInArgs } from "../drivers.js";
import { assertExecutableAvailable } from "../execCheck.js";
import { modelArgsFor, pickForkSeed, type ForkSeedInput, type SeedMode } from "../fork.js";
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
import { appendLedger, listSessions, safeName, saveSession, type SessionRecord } from "../store.js";
import { localSubstrate, substrateForRecord, type Substrate } from "../substrates/index.js";
import { formatShellCommand } from "../tmux.js";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { confirmSpawnReady, dangerousMode, deliverBrief, hasFlag, resolveBeeInCurrentPane, resolveSpawnCwd, resolveSpawnSubstrate, safeTmuxTarget, stringFlag, ttlFlagMs } from "../cli/shared.js";
import { cmdSend } from "../commands/messaging.js";
import { maybeLinkHere, newBeeAccountRows, resolveAccountFlag } from "../commands/spawn.js";
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
 * Account-safety gate for `hive fork` (fork-and-pane §7.1, the crux). Two live
 * processes must never share one account: Anthropic rotates OAuth refresh
 * tokens per-account, so two live bees on one account (even in separate homes)
 * log each other out. Returns the account (if any) the fork should use — for an
 * account-bound parent the fork's account is NEVER === source.accountId (which
 * also guarantees its defaultHomeForAccount home differs from the parent's).
 */
export async function resolveForkAccountSafety(
  parsed: Parsed,
  source: SessionRecord,
  context: { targetTool: string; requestedSeed?: SeedMode },
): Promise<{ account?: AccountRecord }> {
  const accountQuery = stringFlag(parsed, ["account"]);
  const wantsResume = context.requestedSeed === "resume";

  if (accountQuery) {
    const account = await resolveAccountFlag(accountQuery, context.targetTool, ttlFlagMs(parsed));
    // The fork's account must DIFFER from a live account-bound parent's. The
    // OAuth refresh token rotates per-ACCOUNT (not per-home), so two live bees
    // on one account log each other out even in separate homes — and when the
    // account's home IS the parent's (the common `defaultHomeForAccount`
    // layout), this also reuses the parent's exact live home. `--account auto`
    // can silently land on the parent's own account, so this guard covers it too.
    if (source.accountId && account.id === source.accountId) {
      throw new Error(
        `fork would run on ${source.name}'s own account (${account.id}); two live bees on one ` +
          `account rotate the shared OAuth chain and log each other out. Pass a different ` +
          `--account (fork-and-pane §7.1).`,
      );
    }
    // The (different) account brings its own dedicated home
    // (defaultHomeForAccount), so the fork never touches the parent's home.
    // Native resume needs the parent's provider session, which lives in the
    // parent's home — a different account/home can't see it.
    if (wantsResume) {
      throw new Error(
        `--seed resume needs ${source.name}'s home to see its provider session; ` +
          `account ${account.id} has its own home — fork with a seal instead`,
      );
    }
    return { account };
  }

  if (source.accountId) {
    // Account-bound parent with no --account: refuse. A fork must get its own
    // account/home; sharing the parent's live home rotates the OAuth chain and
    // logs both bees out.
    throw new Error(
      `${source.name} is account-bound (${source.accountId}); a fork must get its own account — ` +
        `pass --account <a> (or --account auto). Sharing a live home rotates the OAuth chain and ` +
        `logs both bees out (fork-and-pane §7.1).`,
    );
  }

  // Default-home parent (no accountId): allow a plain spawn (own fresh tmux
  // session in the default home — same risk profile as a second default bee).
  if (wantsResume) {
    console.error(
      note(
        `warn: --seed resume reuses ${source.name}'s provider session in a shared home; ` +
          `the two processes may fight over the OAuth chain. Prefer --seed seal, or --account.`,
      ),
    );
  }
  return {};
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
      "Usage: hive fork <bee> [checkpoint] [--agent <kind>] [--model <m>] [--node <n>] " +
        "[--cwd <dir>] [--seed resume|seal|summary|log|none] [--read-log] [--name <n>] [--account <a>] [--here] [--print]",
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

  // 5. Account safety (the crux). Yields the account whose dedicated home the
  //    fork will use; for a default-home parent it returns no account.
  const { account } = await resolveForkAccountSafety(parsed, source, { targetTool, requestedSeed });

  // 6. Pick the seed mode (pure decision).
  const seedInput: ForkSeedInput = {
    source,
    seal,
    requestedSeed,
    readLog,
    targetTool,
    sourceTool,
    forkName: source.name,
  };
  const decision = pickForkSeed(seedInput);
  if (decision.mode === "refuse") throw new Error(`hive fork: ${decision.reason}`);
  // Tell the operator when a bare `hive fork` fell back to a cold boot because the
  // source had nothing to seed from (vs an explicit `--seed none`).
  if (decision.mode === "none" && seedInput.requestedSeed === undefined) {
    console.error(note(`${source.name} had no session/seal/transcript to seed from — forking cold`));
  }

  // 7. Build the spawn spec and create the new comb. Resume args are baked into
  //    the spawn command (§7.1); seal/log/none seed via a brief after spawn.
  const modelArgs = modelArgsFor(targetTool, model);
  const resumeArgsList = decision.mode === "resume" ? decision.resumeArgs : [];
  const extraArgs = [...resumeArgsList, ...modelArgs, ...parsed.rest];

  const yolo = dangerousMode(parsed, targetTool, requestedAgent);
  // Substrate policy (APIA-85): a fork from inside a bee lands on HSR by default,
  // exactly like spawn (resolveSpawnSubstrate) — combs are retired, so the fork
  // is a pane-less runner-host bee unless `--substrate tmux`/`--node` forces a
  // tmux bee. `node` is undefined in the HSR case.
  const { useHsr, node } = await resolveSpawnSubstrate(parsed, targetTool);
  const isRemote = node?.kind === "ssh-tmux";
  if (account && isRemote) throw new Error("--account forks are local-only (the vault never leaves this machine)");

  // The account brings its own dedicated home; otherwise the fork boots in the
  // default home (never the parent's exact home for an account-bound parent —
  // resolveForkAccountSafety already enforced that).
  const home = account ? defaultHomeForAccount(account) : undefined;
  const spec = resolveAgent(requestedAgent, extraArgs, { home, yolo, identity: Boolean(account) });
  if (account) {
    if (!spec.homePath) throw new Error(`Agent ${spec.kind} has no home env; cannot bind account ${account.id}`);
    await activateAccountIntoHome(account, spec.homePath, { onWarn: (message) => console.error(note(message)) });
  }
  if (!isRemote) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, account?.id);
  }

  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  const name = safeName(stringFlag(parsed, ["name"]) ?? identity.id);
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
        spec.args = [...spec.args, ...sessionArgs];
        pinnedSessionId = sid;
      }
    }
    const adapter = adapterFor(spec.kind);
    const runnerTier = adapter?.tier();
    const hostPid = await spawnHsrHost({
      bee: name,
      comb: name, // fork is its own comb (a fresh lineage root)
      kind: spec.kind,
      cwd,
      ...(pinnedSessionId ? { sessionId: pinnedSessionId } : {}),
      authKind: "subscription",
      ...(model ? { model } : {}),
      spec: { command: spec.command, args: spec.args, env: spec.env },
    });
    const command = shellCommand(spec);
    record = {
      name,
      agent: spec.kind,
      cwd,
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
      ...(pinnedSessionId ? { providerSessionId: pinnedSessionId } : {}),
      ...(account ? { accountId: account.id } : {}),
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
      ...(source.colony ? { colony: source.colony } : {}),
    };
    await saveSession(record);
    await writeSpawnOptions(record);
  }

  // 9. Ledger.
  await appendLedger({
    type: "fork.create",
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
  if (isPretty()) {
    console.log(actionLine("ok", "fork", [bold(name), spec.kind, dim(`from ${source.name}`), dim(decision.mode)]));
  } else {
    console.log(`fork\t${name}\t${spec.kind}\t${source.name}\t${decision.mode}\t${record.command}`);
  }

  // 10. Seed: resume/none carry the seed in the spawn command (or boot cold);
  //     seal/log deliver a brief once ready.
  let finalRecord = record;
  if (decision.mode === "seal" || decision.mode === "log") {
    finalRecord = await deliverBrief(parsed, record, decision.brief);
  } else {
    await confirmSpawnReady(parsed, record);
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

  // Account options. An account-bound source MUST fork onto a DIFFERENT account
  // (a shared OAuth chain rotates and logs both bees out), so its own account is
  // excluded and the "inherit" row withheld; a default-home source may inherit.
  const accountRequired = Boolean(source.accountId);
  const accounts = await newBeeAccountRows(sourceKind).catch(() => []);
  const accountOptions: ForkAccountOption[] = [];
  if (!accountRequired) accountOptions.push({ value: "", label: "inherit (no account binding)" });
  accountOptions.push({ value: "auto", label: "auto", detail: "least-loaded account" });
  for (const acct of accounts) {
    if (accountRequired && acct.id === source.accountId) continue;
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
