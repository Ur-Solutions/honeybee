// `hive spawn`/new/launch — spawn orchestration: detached tmux + HSR bees,
// account/profile resolution, homogeneous swarms, and frame-driven cohorts.
// Extracted from cli.ts (HIVE-15).
import { AUTO_ACCOUNT_QUERY, RR_ACCOUNT_QUERY, accountHasCredentials, activateAccountIntoHome, autoAccountTool, defaultHomeForAccount, findAccount, listAccounts, resolveSpawnAgent, roundRobinAccountTool, type AccountRecord, type SpawnAgentSpec } from "../accounts.js";
import { agentDefaultsToYolo, assertAgentAuthFreshForSpawn, canonicalAgentKind, forcedSessionIdArgs, resolveAgent, shellCommand } from "../agents.js";
import { syncBeesSidebarLayout } from "../beesSidebar.js";
import { beeConfig } from "../config.js";
import { agentKinds, defaultsToSoleCredentialedAccount, sessionPinnedInArgs, sessionPinResumeExtrasForAgent } from "../drivers.js";
import { assertExecutableAvailable } from "../execCheck.js";
import { listFlows } from "../flow/index.js";
import { actionLine, bold, dim, formatRelativeTime, isPretty, note, tildify } from "../format.js";
import { listFrames, loadFrame, type Frame } from "../frame.js";
import { writeSpawnOptions } from "../hiveState.js";
import { adapterFor } from "../hsr/adapters/index.js";
import { mintEphemeralCredential, type EphemeralCredential } from "../hsr/remoteCreds.js";
import { allocateBeeIdentity } from "../ids.js";
import { chooseLaunch, type LaunchTemplate } from "../launchTui.js";
import { cachedAccountLimits, pickLeastLoadedAccount, windowRolledOver, type AccountLimits, type WindowUsage } from "../limits.js";
import { LOCAL_NODE_NAME, authPolicyOf, type NodeRecord } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { createProSlot, listProRepoEntries, listProRepos, prewarmProRepos, resolveProEntryForCwd, toProSlug } from "../proProjects.js";
import { pickRoundRobinAccount } from "../roundRobin.js";
import { startSpawnTimer, type SpawnTimer } from "../spawnTiming.js";
import { chooseNewBee, type SpawnTuiAccount } from "../spawnTui.js";
import { safeName, saveSession, type SessionRecord } from "../store.js";
import { localSubstrate, remoteHsrSubstrateForNode, substrateForRecord } from "../substrates/index.js";
import { createSwarm } from "../swarm.js";
import { tmux } from "../tmux.js";
import { linkHere } from "../view.js";
import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { confirmSpawnReady, confirmSpawnReadyAll, dangerousMode, deliverSpawnBrief, hasFlag, resolveBeeInCurrentPane, resolveSpawnColony, resolveSpawnCwd, resolveSpawnNode, resolveSpawnSubstrate, resolveSwarmIdHint, safeTmuxTarget, ttlFlagMs } from "../cli/shared.js";
import { flowRun } from "../commands/flow.js";
import { spawnHsrHost, waitForHsrHost } from "../hsr/runnerHost.js";

export async function cmdSpawn(parsed: Parsed): Promise<SessionRecord> {
  const frameName = typeof flag(parsed, "frame") === "string" ? String(flag(parsed, "frame")) : undefined;
  const count = resolveSpawnCount(parsed);
  let records: SessionRecord[];
  if (frameName) {
    records = await spawnFromFrame(parsed, frameName);
  } else if (count > 1) {
    records = await spawnHomogeneousSwarm(parsed, count);
  } else {
    records = [await spawnSingleBee(parsed)];
  }
  await maybeLinkHere(parsed, records);
  return records[0]!;
}


/**
 * `--here`: after the normal detached spawn (registration, readiness, briefs
 * all unchanged), link the bee's window into the caller's current session —
 * presentation only. A single bee gets selected; swarms link without focus.
 */
export async function maybeLinkHere(parsed: Parsed, records: SessionRecord[]): Promise<void> {
  if (!truthy(flag(parsed, "here"))) return;
  if (!process.env.TMUX) {
    console.error(note("--here ignored: not inside tmux (plain spawn done)"));
    return;
  }
  const local = records.filter((record) => record.substrate !== "hsr" && (!record.node || record.node === LOCAL_NODE_NAME));
  const paneLess = records.filter((record) => record.substrate === "hsr").length;
  const remote = records.filter((record) => record.substrate !== "hsr" && record.node && record.node !== LOCAL_NODE_NAME).length;
  if (paneLess > 0) {
    console.error(note(`--here skips ${paneLess} pane-less HSR bee(s) — no tmux window to link`));
  }
  if (remote > 0) {
    console.error(note(`--here skips ${remote} remote bee(s) — link-window cannot cross tmux servers`));
  }
  if (local.length === 0) return;
  try {
    const result = await linkHere(
      local.map((record) => record.tmuxTarget),
      { select: records.length === 1 },
    );
    if (isPretty()) console.log(actionLine("ok", "here", [bold(result.session), `${result.linked} window(s) linked`]));
    else console.log(`here\t${result.session}\t${result.linked}`);
    await syncBeesSidebarLayout({ pruneOthers: true });
  } catch (error) {
    // Presentation only: the spawn itself already succeeded and is recorded.
    console.error(note(`--here failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}


export function resolveSpawnCount(parsed: Parsed): number {
  const raw = flag(parsed, "count");
  if (raw === undefined) return 1;
  const value = typeof raw === "string" ? Number(raw) : NaN;
  if (Number.isInteger(value) && value >= 1) return value;
  throw new Error(`--count must be an integer >= 1 (got ${raw === true ? "no value" : String(raw)})`);
}


export type SpawnOptions = {
  agent: string;
  extraArgs: string[];
  cwd: string;
  yolo: boolean;
  home?: string | true | string[];
  name?: string;
  colony?: string;
  swarmId?: string;
  caste?: string;
  brief?: string;
  node?: NodeRecord;
  /**
   * Substrate override. HSR ("hsr") runs the bee pane-lessly under a detached
   * runner host (local-only); absent/"local-tmux" keeps the tmux path. Set only
   * for HSR spawns — `node` is left undefined in that case.
   */
  substrate?: "local-tmux" | "hsr";
  /** Vault account to activate into the home before launch (Phase 3). */
  account?: AccountRecord;
  /** Default model to embed as the CLI model selector (account/profile). */
  model?: string;
  /** Provider for the model selector (opencode `--model <provider>/<model>`). */
  provider?: string;
  /** Opt this bee into the daemon's autoswap flow. Requires account. */
  autoswap?: boolean;
  /**
   * APIA-95 working-copy provisioning (remote-hsr only). When `repo` is set, the
   * bee's cwd is a git checkout cloned/reused on the remote node (`branch`/`ref`
   * pin it, `checkout` names/reuses it). When only `checkout` is set, an existing
   * checkout of that name is resolved and used as cwd. Ignored/rejected off a
   * remote-hsr node.
   */
  repo?: string;
  branch?: string;
  ref?: string;
  checkout?: string;
  /**
   * Opt-in phase timer (HIVE_DEBUG_SPAWN). When passed, spawnBee marks its
   * internal phases on it and leaves reporting to the caller (so resolve/ready
   * phases measured outside spawnBee join the same line). When absent, spawnBee
   * owns a self-reporting timer covering just its internal phases.
   */
  timer?: SpawnTimer;
};

export async function spawnBee(opts: SpawnOptions): Promise<SessionRecord> {
  // When the caller threads a timer it also owns reporting (it has resolve/ready
  // phases to fold in); a bare spawnBee gets its own self-reporting timer so
  // swarm bees still emit their internal breakdown under HIVE_DEBUG_SPAWN.
  const timer = opts.timer ?? startSpawnTimer(opts.agent);
  const ownsTimer = !opts.timer;
  // An account-bound spawn gets a home (explicit or the account's dedicated
  // slot), the account's credentials activated into it, and the driver's
  // explicit identity env — never a blind HOME rewrite.
  const home = opts.account ? (opts.home ?? defaultHomeForAccount(opts.account)) : opts.home;
  const spec = resolveAgent(opts.agent, opts.extraArgs, {
    home,
    yolo: opts.yolo,
    identity: Boolean(opts.account),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  });
  // APIA-93: an account-bound spawn on a REMOTE node is gated by the node's
  // credential-delivery policy. local-only (the default, and every non-remote-hsr
  // remote kind) keeps the historical "vault never leaves this machine" rule; an
  // ephemeral-token remote-hsr node instead gets a SHORT-LIVED credential minted
  // + delivered to its isolated home (below), never the local vault.
  let remoteCreds: EphemeralCredential | undefined;
  if (opts.account) {
    const remoteAccountAllowed =
      opts.node?.kind === "remote-hsr" &&
      (authPolicyOf(opts.node) === "ephemeral-token" || authPolicyOf(opts.node) === "api-key");
    if (opts.node && opts.node.kind !== "local-tmux" && !remoteAccountAllowed) {
      if (opts.node.kind === "remote-hsr") {
        throw new Error(`node ${opts.node.name} is auth-policy local-only; set --auth-policy ephemeral-token to run account-bound bees there`);
      }
      throw new Error("--account spawns are local-only (the vault never leaves this machine)");
    }
    if (remoteAccountAllowed && opts.node) {
      // Do NOT activateAccountIntoHome here — that is the LOCAL vault path. The
      // remote gets ONLY the ephemeral material; the vault stays on this machine.
      if (authPolicyOf(opts.node) === "api-key") {
        throw new Error(`node ${opts.node.name} auth-policy api-key is not yet wired (APIA-93 delivers ephemeral-token); use --auth-policy ephemeral-token`);
      }
      try {
        remoteCreds = await mintEphemeralCredential(opts.account, spec.kind);
      } catch (error) {
        // Scrub: surface only the (secret-free) message, never token/cred bytes.
        throw new Error(`could not mint an ephemeral credential for ${opts.account.id} on ${opts.node.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      if (!spec.homePath) throw new Error(`Agent ${spec.kind} has no home env; cannot bind account ${opts.account.id}`);
      await activateAccountIntoHome(opts.account, spec.homePath, { onWarn: (message) => console.error(note(message)) });
    }
  }
  // "activate" folds in resolveAgent + account activation (the OAuth-refresh
  // network call and accounts-lock wait live here); near-zero without --account.
  timer.mark("activate");
  // Pin the bee to its own provider session id from birth so the transcript
  // matcher anchors on it (+1000) instead of cross-matching a sibling's file by
  // mtime — the auto-titler and resume/swap all key off providerSessionId. Skip
  // when the caller already supplied the driver's session-pin flag in extra args.
  let pinnedSessionId: string | undefined;
  if (!sessionPinnedInArgs(spec.kind, opts.extraArgs ?? [])) {
    const sid = randomUUID();
    const sessionArgs = forcedSessionIdArgs(spec.kind, sid);
    if (sessionArgs) {
      // A caller resuming a session (`-- --resume <id>`) needs the driver's
      // pin/resume bridge flags (claude: --fork-session) or the pin makes the
      // invocation invalid and the bee dies at boot.
      spec.args = [...spec.args, ...sessionArgs, ...sessionPinResumeExtrasForAgent(spec.kind, spec.args)];
      pinnedSessionId = sid;
    }
  }
  const isRemoteHsr = Boolean(opts.node && opts.node.kind === "remote-hsr");
  const isRemote = Boolean(opts.node && (opts.node.kind === "ssh-tmux" || opts.node.kind === "remote-hsr"));
  // APIA-95: working-copy provisioning is a remote-hsr affordance (the checkout
  // lives on the node). Reject the flags off a remote-hsr node rather than
  // silently ignoring them.
  if ((opts.repo || opts.checkout) && !isRemoteHsr) {
    throw new Error("--repo/--checkout provisioning requires a remote-hsr node (spawn with --node <remote-hsr>)");
  }
  // Executable validation only applies to local spawns; we cannot reach the remote
  // PATH cheaply and the remote runner host resolves the executable itself.
  if (!isRemote) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, opts.account?.id);
  }
  timer.mark("exec-check");
  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  timer.mark("allocate");
  const name = safeName(opts.name ?? identity.id);

  // Remote HSR (APIA-92): the runner host lives ON the remote node. Resolve the
  // AgentSpec LOCALLY (above), then hand the resolved spec to the remote `spawn`
  // RPC — no resolveAgent on the remote. The record carries `node` (routed by
  // node.kind to the remote substrate) and NO local `substrate:"hsr"`, so it is
  // observed via the node-probe path like an ssh-tmux bee. Credential delivery
  // to the remote home is APIA-93; for now the remote uses its own home's auth.
  if (isRemoteHsr && opts.node) {
    const substrate = remoteHsrSubstrateForNode(opts.node);
    const adapter = adapterFor(spec.kind);
    // APIA-95: if a working copy was requested, provision (or resolve) it on the
    // remote FIRST and run the bee inside that checkout — overriding opts.cwd.
    let spawnCwd = opts.cwd;
    if (opts.repo) {
      const prov = await substrate.provisionRemote({
        repo: opts.repo,
        ...(opts.branch ? { branch: opts.branch } : {}),
        ...(opts.ref ? { ref: opts.ref } : {}),
        ...(opts.checkout ? { name: opts.checkout } : {}),
      });
      spawnCwd = prov.path;
    } else if (opts.checkout) {
      const rows = await substrate.listCheckouts();
      const match = rows.find((r) => r.name === opts.checkout);
      if (!match) {
        throw new Error(`no checkout named "${opts.checkout}" on ${opts.node.name}; provision one with --repo <url>`);
      }
      spawnCwd = match.path;
    }
    const spawnResult = await substrate.spawnRemote({
      bee: name,
      kind: spec.kind,
      cwd: spawnCwd,
      comb: name, // solo comb
      ...(pinnedSessionId ? { sessionId: pinnedSessionId } : {}),
      authKind: "subscription",
      ...(opts.model ? { model: opts.model } : {}),
      // APIA-93: ephemeral credential material for an account-bound remote spawn.
      // Delivered to the remote isolated home at spawn, shredded on kill. Opaque.
      ...(remoteCreds ? { creds: { ...(remoteCreds.files.length ? { files: remoteCreds.files } : {}), ...(remoteCreds.env ? { env: remoteCreds.env } : {}) } } : {}),
      ...(remoteCreds && spec.homePath ? { home: spec.homePath } : {}),
      spec: { command: spec.command, args: spec.args, env: spec.env },
    });
    timer.mark("session-create");
    const runnerTier = adapter?.tier() ?? spawnResult.tier;
    const command = shellCommand(spec);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name,
      agent: spec.kind,
      cwd: spawnCwd,
      command,
      tmuxTarget: name, // logical id — remote HSR has no tmux target
      node: opts.node.name,
      ...(runnerTier ? { runnerTier } : {}),
      combId: name,
      createdAt: now,
      updatedAt: now,
      status: "running",
      id: identity.id,
      prefix: identity.prefix,
      uuid: identity.uuid,
      requestedAgent: spec.requestedKind,
      homePath: spec.homePath,
      ...(pinnedSessionId ? { providerSessionId: pinnedSessionId } : {}),
      ...(opts.colony ? { colony: opts.colony } : {}),
      ...(opts.swarmId ? { swarmId: opts.swarmId } : {}),
      ...(opts.caste ? { caste: opts.caste } : {}),
      ...(opts.brief ? { brief: opts.brief } : {}),
      ...(opts.account ? { accountId: opts.account.id } : {}),
    };
    await saveSession(record);
    timer.mark("persist");
    if (ownsTimer) timer.report(record.name);
    return record;
  }

  // HSR: fork a detached runner host instead of a tmux session. The bee is a
  // normal SessionRecord with substrate:"hsr", tmuxTarget=name (a logical id, no
  // tmux target), no pane. resolveAgent / account activation / session-id
  // pinning / exec-check above are reused verbatim (HSR_EXPLORATION.md §7).
  if (opts.substrate === "hsr") {
    const adapter = adapterFor(spec.kind);
    const runnerTier = adapter?.tier();
    const hostPid = await spawnHsrHost({
      bee: name,
      comb: name, // solo comb — a forked sub-bee will carry its parent's comb
      kind: spec.kind,
      cwd: opts.cwd,
      ...(pinnedSessionId ? { sessionId: pinnedSessionId } : {}),
      authKind: "subscription",
      ...(opts.model ? { model: opts.model } : {}),
      spec: { command: spec.command, args: spec.args, env: spec.env },
    });
    timer.mark("session-create");
    const command = shellCommand(spec);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name,
      agent: spec.kind,
      cwd: opts.cwd,
      command,
      tmuxTarget: name, // logical id — HSR has no tmux target
      substrate: "hsr",
      runnerPid: hostPid,
      ...(runnerTier ? { runnerTier } : {}),
      combId: name,
      createdAt: now,
      updatedAt: now,
      status: "running",
      id: identity.id,
      prefix: identity.prefix,
      uuid: identity.uuid,
      requestedAgent: spec.requestedKind,
      homePath: spec.homePath,
      ...(pinnedSessionId ? { providerSessionId: pinnedSessionId } : {}),
      ...(opts.colony ? { colony: opts.colony } : {}),
      ...(opts.swarmId ? { swarmId: opts.swarmId } : {}),
      ...(opts.caste ? { caste: opts.caste } : {}),
      ...(opts.brief ? { brief: opts.brief } : {}),
      ...(opts.account ? { accountId: opts.account.id } : {}),
      ...(opts.autoswap ? { autoswap: true } : {}),
    };
    await saveSession(record);
    await writeSpawnOptions(record);
    timer.mark("persist");
    // Wait briefly for the host to come up so the spawn returns a live bee. On
    // timeout still return the record — observe/deriveState will reconcile.
    if (!(await waitForHsrHost(name, 5000))) {
      console.error(note(`hsr host for ${name} did not report live within 5s; the daemon will reconcile`));
    }
    if (ownsTimer) timer.report(record.name);
    return record;
  }

  const tmuxTarget = safeTmuxTarget(name);
  const nodeName = opts.node?.name ?? LOCAL_NODE_NAME;
  const substrate = opts.node ? substrateForRecord(opts.node) : localSubstrate();
  const locationHint = isRemote && opts.node ? ` on ${opts.node.name}` : "";
  if (await substrate.hasSession(tmuxTarget)) throw new Error(`tmux session already exists${locationHint}: ${tmuxTarget}`);
  const launch = await substrate.newSession(tmuxTarget, opts.cwd, {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    tmuxOptions: spec.tmuxOptions,
  });
  timer.mark("session-create");
  const command = shellCommand(spec);

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    agent: spec.kind,
    cwd: opts.cwd,
    command,
    tmuxTarget,
    ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
    ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
    // Solo combs: every bee gets combId == tmuxTarget at spawn (§12 Q3).
    combId: tmuxTarget,
    createdAt: now,
    updatedAt: now,
    status: "running",
    id: identity.id,
    prefix: identity.prefix,
    uuid: identity.uuid,
    requestedAgent: spec.requestedKind,
    homePath: spec.homePath,
    ...(pinnedSessionId ? { providerSessionId: pinnedSessionId } : {}),
    ...(opts.colony ? { colony: opts.colony } : {}),
    ...(opts.swarmId ? { swarmId: opts.swarmId } : {}),
    ...(opts.caste ? { caste: opts.caste } : {}),
    ...(opts.brief ? { brief: opts.brief } : {}),
    ...(nodeName !== LOCAL_NODE_NAME ? { node: nodeName } : {}),
    ...(opts.account ? { accountId: opts.account.id } : {}),
    ...(opts.autoswap ? { autoswap: true } : {}),
  };
  await saveSession(record);
  await writeSpawnOptions(record);
  timer.mark("persist");
  // Owned timers (swarm/internal callers) report here; a caller-threaded timer
  // is reported by the caller once the readiness wait has also been measured.
  if (ownsTimer) timer.report(record.name);
  return record;
}


/**
 * resolveSpawnAgent plus the reserved `<tool>-auto` and `<tool>-rr` aliases.
 * `auto` picks the least-loaded account (live limits-aware); `rr` advances a
 * persistent cursor so spawns walk the credentialed accounts in order, ignoring
 * remaining quota.
 */
export async function resolveSpawnAgentWithAuto(requested: string, parsed: Parsed): Promise<SpawnAgentSpec> {
  const alias = spawnAccountAliasResolver(requested, parsed);
  if (alias) return { agent: alias.agent, account: await alias.account() };
  const resolved = await resolveSpawnAgent(requested);
  const defaultAccount = await defaultSoleCredentialedAccount(requested, parsed, resolved);
  return defaultAccount ? { agent: defaultAccount.tool, account: defaultAccount } : resolved;
}


export type SpawnAccountAliasResolver = {
  agent: string;
  account: () => Promise<AccountRecord>;
};


export function spawnAccountAliasResolver(requested: string, parsed: Parsed): SpawnAccountAliasResolver | undefined {
  const rr = roundRobinAccountTool(requested);
  if (rr) return { agent: rr, account: () => pickRoundRobinAccountForCli(rr) };
  const tool = autoAccountTool(requested);
  if (tool) return { agent: tool, account: () => pickAutoAccount(tool, ttlFlagMs(parsed)) };
  return undefined;
}


/**
 * For tools with the registry's soleCredentialedAccountDefault capability
 * (grok today): a bare `<tool>` spawn with no account/home/profile flags
 * defaults to the only credentialed account for that tool.
 */
export async function defaultSoleCredentialedAccount(requested: string, parsed: Parsed, resolved: SpawnAgentSpec): Promise<AccountRecord | undefined> {
  const tool = resolved.agent;
  if (resolved.account || !defaultsToSoleCredentialedAccount(tool) || requested.trim().toLowerCase() !== tool) return undefined;
  if (hasFlag(parsed, "account") || hasFlag(parsed, "home") || hasFlag(parsed, "profile")) return undefined;
  const accounts = (await listAccounts()).filter((account) => account.tool === tool);
  const credentialed: AccountRecord[] = [];
  for (const account of accounts) {
    if (await accountHasCredentials(account)) credentialed.push(account);
  }
  if (credentialed.length !== 1) return undefined;
  const account = credentialed[0]!;
  console.error(note(`account default → ${account.id} — bare ${tool} uses the only ${tool} account with credentials`));
  return account;
}


/** `--account <query>` resolution; reserved queries: `auto` (least-loaded) and `rr` (round-robin). */
export async function resolveAccountFlag(query: string, tool: string, ttlMs: number | undefined): Promise<AccountRecord> {
  if (query === AUTO_ACCOUNT_QUERY) return pickAutoAccount(tool, ttlMs);
  if (query === RR_ACCOUNT_QUERY) return pickRoundRobinAccountForCli(tool);
  return findAccount(query, tool);
}


// TODO (adversarial review #6, S3/S4): `<tool>-auto` / `--account auto` picks
// the least-loaded account scoped by CLI only, never by provider. Once opencode
// hosts multiple providers (minimax + glm + kimi), an auto-pick for `opencode`
// is provider-blind and may select a different provider than the user meant.
// Account-first resolution (exact id) sidesteps this; left unchanged in S2.
export async function pickAutoAccount(tool: string, ttlMs: number | undefined): Promise<AccountRecord> {
  const choice = await pickLeastLoadedAccount(tool, ttlMs !== undefined ? { ttlMs } : {});
  const usage = autoPickUsage(choice.limits);
  const freshness = choice.limits?.cached && choice.limits.asOf ? `, cached ${formatRelativeTime(choice.limits.asOf)} ago` : "";
  console.error(note(`account auto → ${choice.account.id}${usage ? ` (${usage}${freshness})` : ""} — ${choice.reason}`));
  return choice.account;
}


export async function pickRoundRobinAccountForCli(tool: string): Promise<AccountRecord> {
  const choice = await pickRoundRobinAccount(tool);
  console.error(note(`account rr → ${choice.account.id} — ${choice.reason}`));
  return choice.account;
}


export function autoPickUsage(limits: AccountLimits | undefined): string {
  if (!limits?.ok) return "";
  const now = Date.now();
  const cell = (label: string, window?: WindowUsage) =>
    window ? `${label} ${Math.round(windowRolledOver(window, now) ? 0 : window.usedPercent)}%` : null;
  return [cell("weekly", limits.weekly), cell("5h", limits.fiveHour)].filter(Boolean).join(", ");
}


/**
 * A resolved thin profile (config `bees.<name>` with an `account` field): the
 * referenced vault account plus its model/args/cwd/yolo overrides. Precedence
 * is FLAG > PROFILE > ACCOUNT — the caller layers an explicit CLI flag over
 * what this returns, and falls back to the account default below it.
 */
export type ProfileOverlay = {
  account: AccountRecord;
  /** Profile model override; falls back to the account's default model. */
  model?: string;
  /** Extra args declared by the profile (appended to user `-- …` args). */
  args: string[];
  /** Profile cwd override (FLAG still wins above it). */
  cwd?: string;
  /** Profile yolo override (FLAG still wins above it). */
  yolo?: boolean;
};


/**
 * Resolve a requested spawn token that names a thin profile referencing an
 * account. Returns undefined when the token is not such a profile (no
 * `account` field) so callers fall through to today's path. A profile naming
 * a missing account fails loudly via findAccount.
 */
export async function resolveProfileOverlay(requested: string): Promise<ProfileOverlay | undefined> {
  const profile = beeConfig(requested);
  if (!profile.account) return undefined;
  const account = await findAccount(profile.account);
  return {
    account,
    // Precedence: profile model wins over the account default (the CLI flag is
    // layered on top by the caller).
    ...(profile.model ?? account.model ? { model: profile.model ?? account.model } : {}),
    args: profile.args ?? [],
    ...(profile.cwd ? { cwd: profile.cwd } : {}),
    ...(profile.yolo !== undefined ? { yolo: profile.yolo } : {}),
  };
}


export async function spawnSingleBee(parsed: Parsed): Promise<SessionRecord> {
  const requested = parsed.args[0];
  if (!requested) throw new Error("Usage: hive spawn <bee> [--name name] [--cwd dir] [--account <name|auto>] [--yolo] [-- <bee-args...>]  (e.g. --account auto -- -m gpt-5.5)");
  // Opt-in spawn timing (HIVE_DEBUG_SPAWN). No-op object when disabled.
  const timer = startSpawnTimer(requested);
  // <tool>-<account> spawn shorthand: hive spawn codex-ur / claude-thto / claude-auto.
  const { agent: resolvedAgent, account: aliasAccount } = await resolveSpawnAgentWithAuto(requested, parsed);
  // Thin profile: a config bee referencing an account supplies the CLI from the
  // account, plus model/args/cwd/yolo overrides (precedence FLAG > PROFILE >
  // ACCOUNT).
  const profile = await resolveProfileOverlay(requested);
  const agent = profile ? profile.account.tool : resolvedAgent;
  const extraArgs = profile ? [...parsed.rest, ...profile.args] : parsed.rest;
  const cwd = await resolveSpawnCwd(parsed, profile?.cwd);
  const yolo = dangerousMode(parsed, agent, requested, profile?.yolo);
  const home = flag(parsed, "home") ?? flag(parsed, "profile");
  const colony = await resolveSpawnColony(parsed);
  const spec = resolveAgent(agent, extraArgs, { home, yolo });
  // HSR is a substrate, not a node: `--substrate hsr` skips node resolution and
  // runs the bee pane-lessly on the local runner host (HSR_EXPLORATION.md §7).
  // Origin-based default (agents → HSR, humans → local-tmux) with explicit
  // `--substrate`/`--node` override — see resolveSpawnSubstrate (§5).
  const { useHsr, node } = await resolveSpawnSubstrate(parsed, spec.kind);
  const name = typeof flag(parsed, "name") === "string" ? String(flag(parsed, "name")) : undefined;
  const briefText = typeof flag(parsed, "brief") === "string" ? String(flag(parsed, "brief")) : undefined;
  const accountQuery = typeof flag(parsed, "account") === "string" ? String(flag(parsed, "account")) : undefined;
  // Account binding precedence: explicit --account flag > profile account >
  // <tool>-<account> shorthand / account-id resolution.
  const account = accountQuery ? await resolveAccountFlag(accountQuery, spec.kind, ttlFlagMs(parsed)) : (profile?.account ?? aliasAccount);
  // Model selector precedence: profile model override > the account's default
  // model. Only meaningful when an account is bound.
  const model = account ? (profile?.model ?? account.model) : undefined;
  const provider = account?.provider;
  const autoswap = truthy(flag(parsed, "autoswap"));
  if (autoswap && !account) throw new Error("--autoswap requires an account (--account or a <tool>-<account> bee spec)");
  // APIA-95 working-copy provisioning (remote-hsr only): clone/reuse a checkout on
  // the node and run the bee inside it. spawnBee rejects these off a remote-hsr node.
  const repo = typeof flag(parsed, "repo") === "string" ? String(flag(parsed, "repo")) : undefined;
  const branch = typeof flag(parsed, "branch") === "string" ? String(flag(parsed, "branch")) : undefined;
  const ref = typeof flag(parsed, "ref") === "string" ? String(flag(parsed, "ref")) : undefined;
  const checkout = typeof flag(parsed, "checkout") === "string" ? String(flag(parsed, "checkout")) : undefined;
  // "resolve" folds in account/profile/node resolution above (remote node probe
  // lives here); spawnBee marks its own internal phases on the same timer.
  timer.mark("resolve");
  let record = await spawnBee({ agent, extraArgs, cwd, yolo, home, name, colony, brief: briefText, node, account, model, provider, autoswap, timer, ...(repo ? { repo } : {}), ...(branch ? { branch } : {}), ...(ref ? { ref } : {}), ...(checkout ? { checkout } : {}), ...(useHsr ? { substrate: "hsr" } : {}) });
  const nodeSuffix = useHsr ? [dim("substrate:hsr")] : node && node.name !== LOCAL_NODE_NAME ? [dim(`node:${node.name}`)] : [];
  if (isPretty()) console.log(actionLine("ok", "spawn", [bold(record.name), record.agent, dim(tildify(cwd)), ...nodeSuffix]));
  else console.log(`${record.name}\t${agent}\t${cwd}\t${useHsr ? "hsr" : node?.name ?? LOCAL_NODE_NAME}`);
  if (truthy(flag(parsed, "briefed")) && briefText) {
    const delivered = await deliverSpawnBrief(parsed, record, briefText);
    record = delivered.record;
    timer.mark(delivered.sent ? "brief" : "ready");
  } else {
    await confirmSpawnReady(parsed, record);
    timer.mark("ready");
  }
  timer.report(record.name);
  return record;
}


/**
 * `hive new`: interactive, column-by-column spawn picker (type → account →
 * config → project). Designed to be bound to a tmux popup (M-n). It only
 * gathers choices, then funnels them through the normal spawn path so account
 * activation, yolo resolution, swarms, and `--here` window linking all behave
 * exactly as the flag-driven `hive spawn`. A single bee gets selected in the
 * caller's tmux client via `--here`; a swarm links without stealing focus.
 */
export async function cmdNew(parsed: Parsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive new needs a TTY — bind it to a tmux popup: bind -n M-n display-popup -E "hive new"');
  }
  const here = await resolveBeeInCurrentPane();
  const defaultCwd = here?.cwd ?? (await resolveSpawnCwd(parsed));
  const defaultKind = here ? canonicalAgentKind(here.agent) : undefined;

  // Warm the `pro ls repos` inventory while the operator picks an agent /
  // account / cwd, so the per-cwd "checking pro repo…" step resolves from cache
  // instead of blocking the spawn on a cold shell-out.
  prewarmProRepos();

  const plan = await chooseNewBee({
    types: agentKinds().map((kind) => ({ kind })),
    defaultKind,
    defaultCwd,
    defaultCwdLabel: tildify(defaultCwd),
    defaultYolo: (kind) => agentDefaultsToYolo(kind),
    loadAccounts: (kind) => newBeeAccountRows(kind),
    loadProjects: async () =>
      (await listProRepos()).map((repo) => ({ label: repo.label, path: repo.path, project: repo.project })),
    validatePath: async (input) => {
      try {
        const abs = resolve(input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        const real = await realpath(abs);
        if (!(await stat(real)).isDirectory()) return { ok: false, error: "not a directory" };
        return { ok: true, path: real };
      } catch {
        return { ok: false, error: "path does not exist" };
      }
    },
    listSubdirs: (base) => listNewBeeSubdirs(base),
    proRepoForCwd: async (cwd) => {
      try {
        const entry = resolveProEntryForCwd(await listProRepoEntries(), cwd);
        if (!entry) return null;
        const label = [entry.area, entry.project, entry.repo].filter((part) => part.length > 0).join("/") || entry.path;
        return { label, path: entry.path };
      } catch {
        return null;
      }
    },
    suggestDirName: (kind) => toProSlug(`${kind}-${basename(defaultCwd)}`) || toProSlug(kind) || "bee",
    createProDir: async (kind, repoPath, name) => {
      const slug = toProSlug(name);
      if (!slug) return { ok: false, error: "use letters, digits, and dashes" };
      try {
        return { ok: true, path: await createProSlot(kind, repoPath, slug) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  if (!plan) {
    if (isPretty()) console.error(note("new: cancelled"));
    return;
  }

  const flags = new Map<string, string | true | string[]>();
  if (plan.account) flags.set("account", plan.account);
  flags.set("cwd", plan.cwd);
  flags.set(plan.yolo ? "yolo" : "no-yolo", true);
  if (plan.autoswap) flags.set("autoswap", true);
  if (plan.count > 1) flags.set("count", String(plan.count));
  // Like `hive xa`, `hive new` is an attach workflow — its endgame is
  // switch-client into the bee's tmux session, which a pane-less HSR bee
  // doesn't have (and nothing would ever send it a prompt: stuck "booting").
  // The picker offers no substrate choice, so force local tmux; without this,
  // running from a popup over a bee's session can classify as an agent-origin
  // spawn and follow the HSR default.
  flags.set("substrate", "tmux");

  const record = await cmdSpawn({ command: "spawn", args: [plan.kind], flags, rest: [] });

  // Land in the new bee. Each bee is its own tmux session, so switch the client
  // to it — the same primitive the M-s switcher uses, which (unlike --here's
  // link-window/select-window) reliably repoints the underlying client from
  // inside a display-popup. Local single-bee only: a remote bee lives on another
  // tmux server, and a swarm shouldn't yank focus to an arbitrary member.
  if (process.env.TMUX && plan.count <= 1 && !record.node) {
    await tmux(["switch-client", "-t", `=${record.tmuxTarget}`], { reject: false });
    await syncBeesSidebarLayout({ pruneOthers: true });
  }
}


/**
 * `hive launch` — the interactive frame/flow launcher (KEYBINDINGS: the ⌘⇧B/⌘⇧F
 * target). Pick a frame or flow, pick the repo (defaults to the current one),
 * fill a flow's args in editable boxes, and launch DETACHED: a frame spawns its
 * swarm, a flow runs in the background. The repo picker reuses cmdNew's hooks.
 */
export async function cmdLaunch(parsed: Parsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('hive launch needs a TTY — bind it to a tmux popup: bind -n M-B display-popup -E "hive launch"');
  }
  const here = await resolveBeeInCurrentPane();
  const defaultCwd = here?.cwd ?? (await resolveSpawnCwd(parsed));
  // Warm `pro ls repos` while the operator picks a frame/flow and repo.
  prewarmProRepos();

  const [frames, flows] = await Promise.all([listFrames(), listFlows()]);
  const templates: LaunchTemplate[] = [
    ...frames.map((f): LaunchTemplate => ({
      kind: "frame",
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      beeCount: f.castes.reduce((sum, c) => sum + (c.count ?? 1), 0),
      // One slot per spawned bee, in spawn order (caste order, then index) so
      // the message form lines up with spawnFromFrame's expansion.
      beeSlots: f.castes.flatMap((c) =>
        Array.from({ length: c.count ?? 1 }, (_, i) => ({
          caste: c.name,
          bee: c.bee,
          index: i + 1,
          count: c.count ?? 1,
          ...(c.brief ? { brief: c.brief } : {}),
        })),
      ),
    })),
    ...flows
      .filter((f) => !f.loadError) // a broken flow can't run; hide it from the picker
      .map((f): LaunchTemplate => ({
        kind: "flow",
        name: f.name,
        ...(f.description ? { description: f.description } : {}),
        args: (f.args ?? []).map((a) => ({
          name: a.name,
          ...(a.default !== undefined ? { default: String(a.default) } : {}),
          ...(a.description ? { description: a.description } : {}),
          ...(a.name === "bee" ? { picker: "bee" as const } : {}),
        })),
      })),
  ];

  const plan = await chooseLaunch({
    templates,
    defaultCwd,
    defaultCwdLabel: tildify(defaultCwd),
    loadProjects: async () => (await listProRepos()).map((repo) => ({ label: repo.label, path: repo.path, project: repo.project })),
    validatePath: async (input) => {
      try {
        const abs = resolve(input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        const real = await realpath(abs);
        if (!(await stat(real)).isDirectory()) return { ok: false, error: "not a directory" };
        return { ok: true, path: real };
      } catch {
        return { ok: false, error: "path does not exist" };
      }
    },
    listSubdirs: (base) => listNewBeeSubdirs(base),
    loadBeeOptions: async () => {
      // Account-aware agent shorthands the bee picker offers: <kind>-auto and
      // <kind>-rr (when ≥1 account), <kind>-<account-id> per account, or plain
      // <kind> with none.
      const out: Array<{ value: string; label: string; detail?: string }> = [];
      for (const kind of agentKinds()) {
        const accounts = await newBeeAccountRows(kind).catch(() => []);
        if (accounts.length >= 1) {
          out.push({ value: `${kind}-auto`, label: `${kind} · auto`, detail: "least-loaded account" });
          if (accounts.length >= 2) out.push({ value: `${kind}-rr`, label: `${kind} · rr`, detail: "round-robin next account" });
        }
        for (const acct of accounts) {
          out.push({ value: `${kind}-${acct.id}`, label: `${kind} · ${acct.label}`, ...(acct.usage ? { detail: acct.usage } : {}) });
        }
        if (accounts.length === 0) out.push({ value: kind, label: `${kind} · (no account)` });
      }
      return out;
    },
  });

  if (!plan) {
    if (isPretty()) console.error(note("launch: cancelled"));
    return;
  }

  if (plan.kind === "frame") {
    // Spawn the frame's swarm detached at the chosen repo (no switch-client — a
    // swarm shouldn't yank focus to an arbitrary member). Per-bee messages from
    // the composer (if any) are delivered after readiness, in spawn order.
    const flags = new Map<string, string | true | string[]>([["frame", plan.name], ["cwd", plan.cwd]]);
    // "start now" delivery (the composer default) suppresses the wait-footer so
    // the message is acted on; "brief only" keeps it so bees wait for a follow-up.
    if (plan.waitForGo === false) flags.set("no-wait-footer", true);
    await spawnFromFrame({ command: "spawn", args: ["spawn"], flags, rest: [] }, plan.name, plan.messages);
    return;
  }

  // Flow: run in the background so it survives the popup. Args go through --arg;
  // the cwd arg (if any) was seeded with the chosen repo in the TUI.
  const argEntries = Object.entries(plan.args)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}=${value}`);
  const flowFlags = new Map<string, string | true | string[]>([["background", true]]);
  if (argEntries.length > 0) flowFlags.set("arg", argEntries);
  await flowRun({ command: "flow", args: ["run", plan.name], flags: flowFlags, rest: [] });
}


/** Accounts for one tool, enriched with a cached-usage cell for the picker. */
export async function newBeeAccountRows(kind: string): Promise<SpawnTuiAccount[]> {
  const mine = (await listAccounts()).filter((account) => account.tool === kind);
  if (mine.length === 0) return [];
  let limits: AccountLimits[] = [];
  try {
    limits = await cachedAccountLimits(mine, { ttlMs: 3_600_000 });
  } catch {
    limits = [];
  }
  const byId = new Map(limits.map((entry) => [entry.account, entry]));
  const now = Date.now();
  return mine.map((account) => {
    const entry = byId.get(account.id);
    const usage = newBeeUsageCell(entry, now);
    const saturated = Boolean(
      entry?.ok && entry.fiveHour && !windowRolledOver(entry.fiveHour, now) && entry.fiveHour.usedPercent >= 90,
    );
    return { id: account.id, label: account.label, usage, saturated };
  });
}


export function newBeeUsageCell(limits: AccountLimits | undefined, now: number): string | undefined {
  if (!limits) return undefined;
  if (!limits.ok) return "limits n/a";
  const cell = (label: string, window?: WindowUsage) =>
    window ? `${label} ${Math.round(windowRolledOver(window, now) ? 0 : window.usedPercent)}%` : null;
  const parts = [cell("5h", limits.fiveHour), cell("wk", limits.weekly)].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}


/** Junk dir names never worth offering as a spawn cwd. */
export const NEW_BEE_SUBDIR_IGNORE = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  ".git", ".next", ".turbo", ".cache", ".venv", "__pycache__", ".idea", ".vscode",
]);

export const NEW_BEE_SUBDIR_CAP = 800;


/**
 * Directories up to two levels deep under `base`, for the `hive new` path
 * completer. Junk (node_modules/dist/.git/…) and dotdirs are skipped; the list
 * is capped so a huge tree can't stall the picker. Errors come back as
 * `{ ok: false }` rather than throwing, so the TUI degrades to literal-path entry.
 */
export async function listNewBeeSubdirs(
  base: string,
): Promise<{ ok: boolean; base: string; dirs: string[]; error?: string }> {
  const keep = (name: string) => !name.startsWith(".") && !NEW_BEE_SUBDIR_IGNORE.has(name);
  try {
    const abs = await realpath(resolve(base.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
    const dirs: string[] = [];
    const level1: string[] = [];
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && keep(entry.name)) level1.push(`${abs}/${entry.name}`);
    }
    level1.sort();
    dirs.push(...level1);
    for (const dir of level1) {
      if (dirs.length >= NEW_BEE_SUBDIR_CAP) break;
      let children: import("node:fs").Dirent[] = [];
      try {
        children = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable subdir (perms) — skip its children
      }
      const grand = children
        .filter((entry) => entry.isDirectory() && keep(entry.name))
        .map((entry) => `${dir}/${entry.name}`)
        .sort();
      dirs.push(...grand);
    }
    return { ok: true, base: abs, dirs: dirs.slice(0, NEW_BEE_SUBDIR_CAP) };
  } catch {
    return { ok: false, base, dirs: [], error: "cannot read directory" };
  }
}


export async function spawnHomogeneousSwarm(parsed: Parsed, count: number): Promise<SessionRecord[]> {
  const requested = parsed.args[0];
  if (!requested) throw new Error("Usage: hive spawn <bee> --count <n> [--colony name]");
  if (!Number.isInteger(count) || count < 2) throw new Error(`--count must be an integer >= 2 (got ${count})`);
  if (hasFlag(parsed, "name")) throw new Error("--name cannot be combined with --count > 1; swarm bees are auto-named");
  if (hasFlag(parsed, "brief") || hasFlag(parsed, "briefed")) {
    throw new Error("--brief/--briefed cannot be combined with --count > 1; spawn first, then: hive brief @<swarm-id> <text>");
  }
  const perBeeAccountAlias = spawnAccountAliasResolver(requested, parsed);
  const { agent: resolvedAgent, account: aliasAccount } = perBeeAccountAlias
    ? { agent: perBeeAccountAlias.agent, account: undefined }
    : await resolveSpawnAgentWithAuto(requested, parsed);
  // Thin profile → account (same overlay as spawnSingleBee).
  const profile = await resolveProfileOverlay(requested);
  const agent = profile ? profile.account.tool : resolvedAgent;
  const extraArgs = profile ? [...parsed.rest, ...profile.args] : parsed.rest;
  const account = profile?.account ?? aliasAccount;
  // Model selector precedence: profile model override > the account default.
  const cwd = await resolveSpawnCwd(parsed, profile?.cwd);
  const yolo = dangerousMode(parsed, agent, requested, profile?.yolo);
  const home = flag(parsed, "home") ?? flag(parsed, "profile");
  const colony = await resolveSpawnColony(parsed);
  const spec = resolveAgent(agent, extraArgs, { home, yolo });
  const node = await resolveSpawnNode(parsed, spec.kind);
  const swarmId = resolveSwarmIdHint(parsed, agent);

  // PRESERVE (adversarial review fix #11): an account-first swarm behaves
  // exactly like an `--account` swarm does today — all N bees share ONE
  // accountId and ONE isolated home (spawnBee derives it from
  // defaultHomeForAccount(account) since no per-bee --home is given). This is
  // the existing shared-home reality; S2 deliberately adds no per-bee homes
  // and no new --count restriction.
  const records: SessionRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const beeAccount = perBeeAccountAlias && !profile ? await perBeeAccountAlias.account() : account;
    const beeModel = beeAccount ? (profile?.model ?? beeAccount.model) : undefined;
    const beeProvider = beeAccount?.provider;
    const record = await spawnBee({ agent, extraArgs, cwd, yolo, home, colony, swarmId, node, account: beeAccount, model: beeModel, provider: beeProvider });
    records.push(record);
    const nodeSuffix = node.name !== LOCAL_NODE_NAME ? [dim(`node:${node.name}`)] : [];
    if (isPretty()) console.log(actionLine("ok", "spawn", [bold(record.name), record.agent, dim(`@${swarmId}`), ...nodeSuffix]));
    else console.log(`${record.name}\t${agent}\t${cwd}\t@${swarmId}\t${node.name}`);
  }

  await confirmSpawnReadyAll(parsed, records);

  await createSwarm({
    id: swarmId,
    beeIds: records.map((r) => r.id ?? r.name),
    ...(colony ? { colony } : {}),
  });
  if (isPretty()) console.log(actionLine("ok", "swarm", [bold(`@${swarmId}`), `${records.length} bees`]));
  else console.log(`swarm\t@${swarmId}\t${records.length}`);
  return records;
}


/**
 * Spawn every bee of a frame's castes (caste order, then index within a caste).
 *
 * `perBeeMessages`, when given, holds one initial message per spawned bee in
 * that exact order (from the `hive launch` composer). A non-empty entry is
 * delivered to its bee after readiness, overriding the caste's default brief; an
 * empty entry sends nothing. When omitted, the legacy `--briefed` behavior
 * applies (deliver each caste's own brief).
 */
export async function spawnFromFrame(parsed: Parsed, frameName: string, perBeeMessages?: string[]): Promise<SessionRecord[]> {
  if (hasFlag(parsed, "name")) throw new Error("--name cannot be combined with --frame; frame bees are auto-named");
  if (hasFlag(parsed, "brief")) throw new Error("--brief cannot be combined with --frame; briefs come from the frame's castes");
  const frame: Frame | null = await loadFrame(frameName);
  if (!frame) throw new Error(`Unknown frame: ${frameName}. Define one with: hive frame define <file>`);
  const cwd = await resolveSpawnCwd(parsed);
  const colony = await resolveSpawnColony(parsed);
  const swarmId = resolveSwarmIdHint(parsed, frame.name);

  const briefed = truthy(flag(parsed, "briefed"));
  const flagHome = flag(parsed, "home") ?? flag(parsed, "profile");
  const records: SessionRecord[] = [];
  // deliverBrief already waits for readiness, so just-briefed bees are excluded
  // from the post-spawn confirmation (mirrors spawnSingleBee's exclusivity).
  const unbriefed: SessionRecord[] = [];
  const hasComposerMessages = perBeeMessages !== undefined;
  let slot = 0; // running bee index across all castes, aligned with perBeeMessages
  for (const caste of frame.castes) {
    const perBeeAccountAlias = spawnAccountAliasResolver(caste.bee, parsed);
    const { agent: resolvedAgent, account: aliasAccount } = perBeeAccountAlias
      ? { agent: perBeeAccountAlias.agent, account: undefined }
      : await resolveSpawnAgentWithAuto(caste.bee, parsed);
    const profile = await resolveProfileOverlay(caste.bee);
    const agent = profile ? profile.account.tool : resolvedAgent;
    const extraArgs = profile ? [...parsed.rest, ...profile.args] : parsed.rest;
    const account = profile?.account ?? aliasAccount;
    const yolo = dangerousMode(parsed, agent, caste.bee, profile?.yolo);
    const home = caste.home ?? flagHome;
    const casteSpec = resolveAgent(agent, extraArgs, { home, yolo });
    const casteNode = await resolveSpawnNode(parsed, casteSpec.kind);
    for (let i = 0; i < caste.count; i += 1) {
      // A composer message (if non-blank) overrides this bee's caste brief.
      const custom = hasComposerMessages ? perBeeMessages?.[slot] ?? "" : undefined;
      slot += 1;
      const hasCustom = typeof custom === "string" && custom.trim().length > 0;
      const recordBrief = hasComposerMessages ? (hasCustom ? custom : undefined) : caste.brief;
      // With composer messages present, a blank slot explicitly means no brief;
      // otherwise fall back to the legacy "--briefed delivers caste brief" path.
      const toDeliver = hasComposerMessages ? (hasCustom ? custom : undefined) : briefed && caste.brief ? caste.brief : undefined;
      const beeAccount = perBeeAccountAlias && !profile ? await perBeeAccountAlias.account() : account;
      const beeModel = beeAccount ? (profile?.model ?? beeAccount.model) : undefined;
      const beeProvider = beeAccount?.provider;
      let record = await spawnBee({
        agent,
        extraArgs,
        cwd,
        yolo,
        ...(home !== undefined ? { home } : {}),
        colony,
        swarmId,
        caste: caste.name,
        node: casteNode,
        account: beeAccount,
        model: beeModel,
        provider: beeProvider,
        ...(recordBrief ? { brief: recordBrief } : {}),
      });
      if (toDeliver) {
        const delivered = await deliverSpawnBrief(parsed, record, toDeliver);
        record = delivered.record;
      } else {
        unbriefed.push(record);
      }
      records.push(record);
      if (isPretty()) console.log(actionLine("ok", "spawn", [bold(record.name), record.agent, dim(`caste:${caste.name}`), dim(`@${swarmId}`)]));
      else console.log(`${record.name}\t${record.agent}\t${cwd}\t${caste.name}\t@${swarmId}`);
    }
  }

  await confirmSpawnReadyAll(parsed, unbriefed);

  await createSwarm({
    id: swarmId,
    frame: frame.name,
    beeIds: records.map((r) => r.id ?? r.name),
    ...(colony ? { colony } : {}),
  });
  if (isPretty()) console.log(actionLine("ok", "swarm", [bold(`@${swarmId}`), `${records.length} bees`, dim(`frame:${frame.name}`)]));
  else console.log(`swarm\t@${swarmId}\t${records.length}\t${frame.name}`);
  return records;
}
