// `hive promote`/demote/revive — substrate migration: move a bee between an
// interactive tmux pane and a pane-less HSR runner (resume), and revive dead bees.
// Extracted from cli.ts (HIVE-15).
import { accountEmail, activateAccountIntoHome, captureAccountFromHome, findAccount, homeClaudeEmail, listAccounts, type AccountRecord } from "../accounts.js";
import { mintCellBrokerCapability } from "../cellBrokerCapability.js";
import { planClaudeRecoveryCredentials } from "../accounts/credentialHealth.js";
import { adoptInheritedHome, agentDefaultsToYolo, assertAgentAuthFreshForSpawn, canonicalAgentKind, refreshIdentityEnv, resolveAgent, shellCommand, shellQuoteIfNeeded, splitShellWords, type AgentSpec, stampBeeIdentityEnv } from "../agents.js";
import { assertExecutableAvailable } from "../execCheck.js";
import { actionLine, bold, dim, isPretty, note } from "../format.js";
import { writeSpawnOptions } from "../hiveState.js";
import { adapterFor } from "../hsr/adapters/index.js";
import { hsrObservations, readCurrentHsrEventTail } from "../hsr/observe.js";
import { readPendingHsrTurns } from "../hsr/pendingTurns.js";
import { connectRpcClient } from "../hsr/rpc.js";
import { ensureHsrRunDir, hsrRunDir, readHsrMeta, readHsrMetaStrict } from "../hsr/runDir.js";
import { hsrSubstrate, stopHsrIncarnationByPid, stopKnownHsrExecution } from "../hsr/substrate.js";
import { withSessionLifecycleTransaction, type SessionLifecycleTransaction } from "../lifecycle.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { waitForAgentReady } from "../readiness.js";
import { authPromptLossRequestId } from "../requests/keys.js";
import { closeRequestsForNewIncarnation, openRequest, readBeeRequests, resolveRequest } from "../requests/store.js";
import { loadLatestSeal, nextRuntimeIncarnationPatch } from "../seal.js";
import { appendLedger, currentSessionRuntimeReplacement, listSessions, storeRoot, transitionSession, type SessionRecord } from "../store.js";
import { isArchivedSessionLifecycle, isRunnableSessionRecord, type ProbeEvidence } from "../stateMachine.js";
import { localSubstrate, substrateFor } from "../substrates/index.js";
import { stopRuntimeForReplacement } from "../substrates/stop.js";
import type { NewSessionResult, Substrate } from "../substrates/types.js";
import { resumeArgs, sniffYolo } from "../swap.js";
import { formatShellCommand, hasSession } from "../tmux.js";
import { identityRecipeForAgent, modelArgsForAgent } from "../drivers.js";
import { deliverPromptText, resolveSession, safeTmuxTarget, sleep, stringFlag } from "../cli/shared.js";
import { loginSeatLiveDigest } from "./account.js";
import { hsrCellPayloadFields, spawnHsrHost, waitForHsrHost, waitForHsrReadiness, type HsrRunPayload } from "../hsr/runnerHost.js";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunnerEvent } from "../hsr/types.js";
import { lastAuthNeededEvent } from "../view/requests.js";
import { atomicWriteFile } from "../fsx.js";
import { finalizeManualRuntimeRevive } from "../recovery/manual.js";
import { randomUUID } from "node:crypto";
import { mintEphemeralCredential } from "../hsr/remoteCreds.js";
import {
  RemoteSpawnNotAdmittedError,
  RemoteSpawnIndeterminateError,
  type RemoteHsrSubstrate,
  type RemoteSpawnResult,
} from "../substrates/remote-hsr.js";
import { cleanupLaunchedRemoteHsrIncarnation } from "../launchPublication.js";
import {
  beginBeeReplacementOperation,
  continueBeeReplacementLaunchAdmission,
  readBeeNameLaunchReservation,
  withBeeReplacementLaunchAdmission,
  type BeeNameLaunchReservation,
} from "../nameAdmission.js";

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

type LaunchReplaySource = "structured" | "legacy-command" | "resolved-fallback";

type LaunchReplay = {
  spec: AgentSpec;
  source: LaunchReplaySource;
};

function hasArchivedLifecycle(record: SessionRecord): boolean {
  return isArchivedSessionLifecycle(record);
}

async function persistExplicitRevive(
  record: SessionRecord,
  at: string,
  target: ProbeEvidence["target"],
  detail: string,
): Promise<SessionRecord> {
  const transitionKey = `revive:${record.name}:${record.runtimeGeneration ?? 0}:${at}`;
  const transitioned = await transitionSession(record.name, {
    eventId: transitionKey,
    at,
    type: "bee.revived",
    cause: "revive",
    resume: "done",
    evidence: { kind: "operator", actionId: transitionKey, observedAt: at, action: "revive" },
    probe: {
      kind: "probe",
      probeId: `${transitionKey}:probe`,
      observerId: "hive-revive",
      observedAt: at,
      outcome: "alive",
      target,
      detail,
    },
  });
  if (!transitioned) throw new Error(`Session ${record.name} vanished before its revive transition`);
  return transitioned.record;
}

/** True when `needle` occurs contiguously in `haystack`. */
function containsArgv(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return true;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    if (needle.every((part, offset) => haystack[i + offset] === part)) return true;
  }
  return false;
}

function withoutTrailingArgs(args: readonly string[], suffixes: readonly string[][]): string[] {
  for (const suffix of [...suffixes].sort((a, b) => b.length - a.length)) {
    if (suffix.length === 0 || suffix.length > args.length) continue;
    const offset = args.length - suffix.length;
    if (suffix.every((part, index) => args[offset + index] === part)) return args.slice(0, offset);
  }
  return [...args];
}

function withoutLegacyResumeArgs(args: readonly string[], tool: string, providerSessionId?: string): string[] {
  const stripped = withoutTrailingArgs(args, [resumeArgs(tool, providerSessionId), resumeArgs(tool, undefined)]);
  if (stripped.length !== args.length) return stripped;

  // The id can be missing from a damaged/partially rewritten old record even
  // though its rendered command still ends in a concrete resume invocation.
  // Match the driver's id-bearing shape with only the id word wildcarded.
  const marker = "__hive_recorded_session_id__";
  const template = resumeArgs(tool, marker);
  const markerIndex = template.indexOf(marker);
  if (markerIndex < 0 || template.length > args.length) return [...args];
  const offset = args.length - template.length;
  const matches = template.every((part, index) => index === markerIndex || args[offset + index] === part);
  return matches ? args.slice(0, offset) : [...args];
}

/**
 * Recover argv + non-secret env from an old rendered command. shellCommand()
 * emits env assignments first and shell-quotes every word, so splitShellWords
 * can reverse its own format. A redacted secret is never copied back into the
 * child environment; the freshly resolved identity env remains authoritative.
 */
function parseLegacyLaunch(command: string): { argv: string[]; env: Record<string, string> } | undefined {
  let words: string[];
  try {
    words = splitShellWords(command);
  } catch {
    return undefined;
  }
  const env: Record<string, string> = {};
  let firstArgv = 0;
  for (; firstArgv < words.length; firstArgv += 1) {
    const match = words[firstArgv]!.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (!match) break;
    if (match[2] !== "<redacted>") env[match[1]!] = match[2]!;
  }
  const argv = words.slice(firstArgv);
  return argv.length > 0 && argv[0]!.length > 0 ? { argv, env } : undefined;
}

/**
 * Overlay the immutable recorded launch onto a freshly resolved spec. The
 * resolver still supplies current home/identity env and tmux policy; executable
 * and argv come from spawn. Legacy rendered commands have a previous revive's
 * trailing resume suffix removed before the current lifecycle args are added.
 */
export function replayRecordedLaunch(
  record: SessionRecord,
  tool: string,
  resolved: AgentSpec,
  lifecycleArgs: string[],
): LaunchReplay {
  let argv: string[] | undefined;
  let env = resolved.env;
  let source: LaunchReplaySource = "resolved-fallback";

  if (record.launchArgv?.length) {
    argv = [...record.launchArgv];
    source = "structured";
  } else {
    const legacy = parseLegacyLaunch(record.command);
    if (legacy) {
      argv = legacy.argv;
      env = { ...resolved.env, ...legacy.env };
      source = "legacy-command";
    }
  }

  if (!argv) return { spec: resolved, source };
  const command = argv[0]!;
  let args = argv.slice(1);
  if (source === "legacy-command") {
    args = withoutLegacyResumeArgs(args, tool, record.providerSessionId);
  }

  // `hive set-model` is an explicit post-spawn override. Preserve it alongside
  // the recorded launch without duplicating selections already present there.
  const resolvedModelArgs = record.model ? modelArgsForAgent(tool, record.model) : [];
  const modelArgs = containsArgv(resolved.args, resolvedModelArgs) ? resolvedModelArgs : [];
  const modelExtras = modelExtraArgsFor(record);
  for (const selection of [modelArgs, modelExtras]) {
    if (selection.length > 0 && !containsArgv(args, selection)) args.push(...selection);
  }

  return {
    source,
    spec: {
      ...resolved,
      command,
      args: [...args, ...lifecycleArgs],
      env,
    },
  };
}

/**
 * Structured records fail closed when their recorded executable disappeared.
 * String-only records predate exact argv capture, so an unavailable parsed
 * executable falls back to today's resolver behavior (no worse than pre-fix).
 */
async function assertReplayExecutable(replay: LaunchReplay, resolved: AgentSpec): Promise<AgentSpec> {
  try {
    await assertExecutableAvailable(replay.spec.command);
    return replay.spec;
  } catch (error) {
    if (replay.source !== "legacy-command") throw error;
    await assertExecutableAvailable(resolved.command);
    return resolved;
  }
}


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
    const observation = (await hsrObservations({
      bees: [record.name],
      includeEvents: true,
    })).get(record.name);
    if (observation?.unavailable) {
      throw new Error(
        `hive ${verb}: cannot prove ${record.name} is quiescent (${observation.unavailable.kind}: ${observation.unavailable.detail}); retry after HSR event observation recovers or use --now to interrupt`,
      );
    }
    const state = observation?.state;
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
  // The strict substrate path validates persisted process-birth identities
  // before every fallback signal; never act on a recyclable numeric PID.
  const result = await stopKnownHsrExecution(record.name);
  if (!result.ok) throw new Error(result.stderr || `HSR stop unconfirmed for ${record.name}`);
}

async function persistReplacementStopDoubt(
  lifecycle: SessionLifecycleTransaction,
  operation: string,
  cause: unknown,
): Promise<void> {
  const message = cause instanceof Error ? cause.message : String(cause);
  const current = await lifecycle.refresh();
  const replacement = currentSessionRuntimeReplacement(current);
  const updatedAt = new Date().toISOString();
  await lifecycle.commit({
    status: "kill_failed",
    lastError: `${operation}: ${message}`,
    ...(replacement ? {
      runtimeReplacement: {
        ...replacement,
        state: "stop-failed" as const,
        updatedAt,
        detail: `${operation}: ${message}`,
      },
    } : {}),
    updatedAt,
  });
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
export async function buildResumeSpec(
  record: SessionRecord,
  tool: string,
  extraArgs: string[],
  options: { replayLaunch?: boolean; activateCredentials?: boolean } = {},
): Promise<AgentSpec> {
  const resolved = resolveAgent(record.requestedAgent ?? record.agent, [...modelExtraArgsFor(record), ...extraArgs], {
    home: record.homePath,
    yolo: agentDefaultsToYolo(tool),
    identity: Boolean(record.accountId),
    ...(record.model ? { model: record.model } : {}),
  });
  if (options.activateCredentials !== false && record.accountId && resolved.homePath) {
    const account = await findAccount(record.accountId, tool).catch(() => undefined);
    if (account) {
      await activateAccountIntoHome(account, resolved.homePath, { onWarn: (message) => console.error(note(message)) });
      refreshIdentityEnv(resolved);
    }
  }
  // Legacy records without homePath: a relaunch from inside another bee's
  // session would silently inherit its home env var — make it explicit so the
  // relaunched agent's home is deterministic and persistable (callers stamp
  // spec.homePath back onto the record).
  adoptInheritedHome(resolved);
  // A relaunch is still the same bee: re-stamp honeybee identity so revived
  // bees keep their gateway-adoption anchors (H1 applies to every launch).
  const stampIdentity = (spec: AgentSpec): AgentSpec => {
    stampBeeIdentityEnv(spec.env, {
      name: record.name,
      id: record.id ?? record.name,
      comb: record.name,
      ...(record.spawnedById ? { parent: record.spawnedById } : {}),
    });
    return spec;
  };
  if (!options.replayLaunch) {
    await assertExecutableAvailable(resolved.command);
    return stampIdentity(resolved);
  }
  return stampIdentity(await assertReplayExecutable(replayRecordedLaunch(record, tool, resolved, extraArgs), resolved));
}

/** Fail before credential activation or process launch when a revive cwd is gone. */
export async function assertReviveWorkingDirectory(
  record: Pick<SessionRecord, "name" | "cwd">,
  inspect: typeof stat = stat,
): Promise<void> {
  let cwdStat: Awaited<ReturnType<typeof stat>>;
  try {
    cwdStat = await inspect(record.cwd);
  } catch (error) {
    const detail = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "no longer exists"
      : `is not accessible (${error instanceof Error ? error.message : String(error)})`;
    throw new Error(
      `hive revive: working directory for ${record.name} ${detail}: ${record.cwd}; ` +
      "restore or recreate the working copy before reviving",
    );
  }
  if (!cwdStat.isDirectory()) {
    throw new Error(
      `hive revive: working directory for ${record.name} is not a directory: ${record.cwd}; ` +
      "restore or recreate the working copy before reviving",
    );
  }
}

/**
 * Re-fork the HSR runner host for a bee whose record still says substrate:"hsr",
 * and persist the fresh runnerPid. promote rollbacks use the default resume path
 * to rejoin the SAME provider session headlessly; revive can pass `fresh` to
 * start a new HSR session while preserving the record identity.
 */
export async function reviveHsrRunner(
  record: SessionRecord,
  tool: string,
  opts: {
    fresh?: boolean;
    sessionOverride?: string;
    replayLaunch?: boolean;
    activateCredentials?: boolean;
    deferRequestClosure?: boolean;
    replacementOperation?: string;
    replacementReservation?: BeeNameLaunchReservation;
    afterLaunch?: (launch: { kind: "hsr"; hostPid: number }) => Promise<void>;
    spawnHsrHost?: (payload: HsrRunPayload) => Promise<number>;
    waitForHsrHost?: (bee: string, timeoutMs: number) => Promise<boolean>;
    stopHsrIncarnation?: typeof stopHsrIncarnationByPid;
  } = {},
): Promise<SessionRecord> {
  return withSessionLifecycleTransaction(record, (lifecycle) =>
    reviveHsrRunnerInTransaction(lifecycle, tool, opts));
}

async function reviveHsrRunnerInTransaction(
  lifecycle: SessionLifecycleTransaction,
  tool: string,
  opts: {
    fresh?: boolean;
    sessionOverride?: string;
    replayLaunch?: boolean;
    activateCredentials?: boolean;
    deferRequestClosure?: boolean;
    replacementOperation?: string;
    replacementReservation?: BeeNameLaunchReservation;
    afterLaunch?: (launch: { kind: "hsr"; hostPid: number }) => Promise<void>;
    spawnHsrHost?: (payload: HsrRunPayload) => Promise<number>;
    waitForHsrHost?: (bee: string, timeoutMs: number) => Promise<boolean>;
    stopHsrIncarnation?: typeof stopHsrIncarnationByPid;
  } = {},
): Promise<SessionRecord> {
  const record = await lifecycle.refresh();
  if (record.deliveryStopDoubt) {
    throw new Error(
      `hive revive: ${record.name} has unresolved delivery ownership ${record.deliveryStopDoubt.deliveryId}; `
      + `run hive buz reconcile ${record.name} ${record.deliveryStopDoubt.deliveryId} --delivered|--discard first`,
    );
  }
  const explicitArchivedRevive = hasArchivedLifecycle(record);
  const adapter = adapterFor(tool);
  const fresh = opts.fresh === true;
  const providerSessionId = fresh ? undefined : (opts.sessionOverride ?? record.providerSessionId);
  await assertReviveWorkingDirectory(record);
  const spec = await buildResumeSpec(record, tool, [], {
    replayLaunch: opts.replayLaunch,
    activateCredentials: opts.activateCredentials,
  });
  const incarnation = await nextRuntimeIncarnationPatch(record);
  const brokerCapability = record.executionRunId
    ? mintCellBrokerCapability(record.name, incarnation.runtimeGeneration as number)
    : undefined;
  const launchAndPublish = async (reservation: BeeNameLaunchReservation) => {
      await reservation.markLaunchDispatch();
      const hostPid = await (opts.spawnHsrHost ?? spawnHsrHost)({
        bee: record.name,
        comb: record.combId ?? record.name,
        ...(record.parentId ? { parent: record.parentId } : {}),
        kind: tool,
        cwd: record.cwd,
        ...(providerSessionId ? { sessionId: providerSessionId } : {}),
        ...(fresh ? {} : { resume: true }),
        authKind: "subscription",
        ...(record.accountId ? { accountId: record.accountId } : {}),
        ...(record.model ? { model: record.model } : {}),
        // An execution Cell keeps its OS write boundary + grants across revive.
        ...hsrCellPayloadFields(record),
        ...(brokerCapability ? { cellBrokerCapability: brokerCapability.token } : {}),
        spec: { command: spec.command, args: spec.args, env: spec.env },
      });
      let runnerFingerprint: SessionRecord["runnerFingerprint"];
      const ownership = () => ({
        ...incarnation,
        substrate: "hsr" as const,
        runnerPid: hostPid,
        ...(runnerFingerprint ? { runnerFingerprint } : {}),
        agentPaneId: undefined,
        launcherPgid: undefined,
        launcherFingerprint: undefined,
        ...(brokerCapability ? { cellBrokerCapabilityHash: brokerCapability.hash } : {}),
      });
      const persistLaunchedStopDoubt = (detail: string) =>
        retainReplacementLaunchStopDoubt(
          reservation,
          lifecycle,
          ownership(),
          "HSR revive launch cleanup unconfirmed",
          detail,
        );
      let published: SessionRecord;
      try {
        // Record the returned host before reading run-dir metadata: a crash or
        // metadata fault must never erase the only exact pid locator.
        await reservation.recordHsrLaunch({ hostPid, childAdmission: "pending" });
        const admittedMeta = await readHsrMetaStrict(record.name);
        runnerFingerprint = admittedMeta?.hostPid === hostPid ? admittedMeta.hostFingerprint : undefined;
        if (!runnerFingerprint || (admittedMeta?.childAdmission !== "admitted" && admittedMeta?.childAdmission !== "none")) {
          throw new Error("HSR revive returned without complete process birth admission");
        }
        await reservation.recordHsrLaunch({
          hostPid,
          hostFingerprint: runnerFingerprint,
          childAdmission: admittedMeta.childAdmission,
        });

        // `hasSession` becomes true as soon as the detached host publishes
        // queued birth evidence. Wait for runningAt proof by default.
        const controlReady = await (opts.waitForHsrHost ?? waitForHsrReadiness)(record.name, 5000);
        if (!controlReady) {
          console.error(note(`hsr host for ${record.name} did not report live within 5s; the daemon will reconcile`));
        }
        await opts.afterLaunch?.({ kind: "hsr", hostPid });
        const runnerTier = adapter?.tier();
        const renderedCommand = shellCommand(spec);
        const revivedAt = new Date().toISOString();
        published = await lifecycle.commit({
          ...incarnation,
          ...(opts.replayLaunch ? { lastReviveCommand: renderedCommand } : { command: renderedCommand }),
          substrate: "hsr",
          runnerPid: hostPid,
          runnerFingerprint: runnerFingerprint!,
          ...(runnerTier ? { runnerTier } : {}),
          ...(opts.sessionOverride ? { providerSessionId: opts.sessionOverride } : {}),
          ...(fresh ? { providerSessionId: undefined, transcriptPath: undefined } : {}),
          ...(spec.homePath && !record.homePath ? { homePath: spec.homePath } : {}),
          updatedAt: revivedAt,
          ...(explicitArchivedRevive ? {} : { status: "running" as const }),
          lastError: undefined,
        });
        if (explicitArchivedRevive) {
          published = await persistExplicitRevive(
            published,
            revivedAt,
            { substrate: "hsr", ...(record.node ? { node: record.node } : {}), runnerPid: hostPid },
            controlReady
              ? "HSR birth admission and control probe both verified the revived runtime"
              : "HSR birth admission verified the revived host; control readiness will reconcile asynchronously",
          );
        }
      } catch (error) {
        await confirmLaunchedHsrStopped(
          record.name,
          hostPid,
          error,
          opts.stopHsrIncarnation,
          persistLaunchedStopDoubt,
        );
        await reservation.clearAfterConfirmedStop();
        throw error;
      }
      // Once the canonical generation carries this exact admitted birth, a
      // journal-write fault is reconciled on replay; do not tear down a runtime
      // the SessionRecord already owns.
      await reservation.promotePublished(published);
      return published;
    };
  const restored = opts.replacementReservation
    ? await continueBeeReplacementLaunchAdmission(opts.replacementReservation, launchAndPublish)
    : await withBeeReplacementLaunchAdmission(
        lifecycle,
        opts.replacementOperation ?? "revive-hsr",
        launchAndPublish,
      );
  await writeSpawnOptions(restored);
  if (!opts.deferRequestClosure) await closeSupersededRequests(record, incarnation);
  return restored;
}

async function confirmLaunchedHsrStopped(
  bee: string,
  hostPid: number,
  cause: unknown,
  stop: typeof stopHsrIncarnationByPid = stopHsrIncarnationByPid,
  onStopUnconfirmed?: (detail: string) => Promise<void>,
): Promise<void> {
  const stopped = await stop(bee, hostPid);
  if (stopped.ok) return;
  const original = cause instanceof Error ? cause.message : String(cause);
  const detail = stopped.stderr || stopped.stdout || `exit ${stopped.exitCode}`;
  await onStopUnconfirmed?.(detail);
  throw new Error(`${original}; exact launched HSR incarnation cleanup failed: ${detail}`);
}

async function confirmLaunchedTmuxStopped(
  substrate: Substrate,
  target: string,
  launch: NewSessionResult,
  cause: unknown,
  onStopUnconfirmed?: (detail: string) => Promise<void>,
): Promise<void> {
  if (!substrate.killIncarnation) {
    const original = cause instanceof Error ? cause.message : String(cause);
    const detail = `substrate ${substrate.kind} cannot tear down exact launched incarnation ${launch.paneId}`;
    await onStopUnconfirmed?.(detail);
    throw new Error(`${original}; ${detail}`);
  }
  const result = await substrate.killIncarnation(target, launch).catch((error) => ({
    ok: false,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: 1,
  }));
  if (result.ok) return;
  const original = cause instanceof Error ? cause.message : String(cause);
  const detail = result.stderr || result.stdout || launch.paneId;
  await onStopUnconfirmed?.(detail);
  throw new Error(`${original}; exact launched tmux incarnation cleanup failed: ${detail}`);
}

/**
 * Publication/rollback can fail after a replacement process exists. If exact
 * teardown is not proved, repoint the durable record at that NEW incarnation
 * before releasing the lifecycle lock; retaining the old locator would make a
 * later cleanup signal the wrong process while the escaped replacement stays
 * runnable.
 */
async function persistLaunchedReplacementStopDoubt(
  lifecycle: SessionLifecycleTransaction,
  ownership: Partial<SessionRecord>,
  operation: string,
  detail: string,
): Promise<void> {
  const current = await lifecycle.refresh();
  const replacement = currentSessionRuntimeReplacement(current);
  const updatedAt = new Date().toISOString();
  await lifecycle.commit({
    ...ownership,
    status: "kill_failed",
    lastError: `${operation}: ${detail}`,
    ...(replacement ? {
      runtimeReplacement: {
        ...replacement,
        state: "stop-failed" as const,
        updatedAt,
        detail: `${operation}: ${detail}`,
      },
    } : {}),
    updatedAt,
  });
}

async function retainReplacementLaunchStopDoubt(
  reservation: BeeNameLaunchReservation,
  lifecycle: SessionLifecycleTransaction,
  ownership: Partial<SessionRecord>,
  operation: string,
  detail: string,
): Promise<void> {
  // The already-durable launched locator remains a fence even if upgrading its
  // phase fails. Persist the canonical kill_failed locator independently so a
  // later exact teardown has two mutually checking sources of ownership.
  await reservation.retainStopDoubt(detail).catch(() => undefined);
  // A concurrent generation change may make the canonical CAS fail. The
  // generation-bound journal is still the authoritative fence; never mask the
  // original exact-cleanup failure or overwrite the newer canonical row.
  await persistLaunchedReplacementStopDoubt(lifecycle, ownership, operation, detail).catch(() => undefined);
}

/**
 * New-incarnation request closure, applied NEXT TO every
 * nextRuntimeIncarnationPatch application: requests opened against earlier
 * generations are superseded by the relaunch (the daemon reconciler backstops
 * a missed call via the same generation comparison). Best-effort — a request-
 * store hiccup must never fail a revive/promote/demote/swap.
 */
async function closeSupersededRequests(record: SessionRecord, incarnation: Partial<SessionRecord>): Promise<void> {
  const newGeneration = incarnation.runtimeGeneration ?? (record.runtimeGeneration ?? 0) + 1;
  await closeRequestsForNewIncarnation(record.name, newGeneration).catch(() => undefined);
}

/**
 * Resolve every open auth request for the bee by "auth-resume" — the CLI-side
 * locked write that makes `hive auth-resume` daemon-down functional. The new
 * host's durable `host_epoch` is the event-history boundary; this direct
 * request-store resolution preserves the more specific operator outcome.
 */
export async function resolveAuthRequestsAfterResume(bee: string): Promise<void> {
  const openAuth = (await readBeeRequests(bee)).filter((request) => request.status === "open" && request.kind === "auth");
  for (const request of openAuth) {
    await resolveRequest(bee, request.id, { by: "auth-resume" });
  }
}

export type AuthPromptRecovery = {
  prompts: string[];
  source: "journal" | "legacy-last-prompt" | "unrecoverable";
  authEventTs: number;
};

type StagedAuthReplay = AuthPromptRecovery & { version: 1; stagedAt: string };

function stagedAuthReplayPath(bee: string): string {
  return resolve(hsrRunDir(bee), "auth-replay.json");
}

async function readStagedAuthReplay(bee: string): Promise<AuthPromptRecovery | null> {
  try {
    const parsed = JSON.parse(await readFile(stagedAuthReplayPath(bee), "utf8")) as Partial<StagedAuthReplay>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.prompts) ||
      !parsed.prompts.every((prompt) => typeof prompt === "string") ||
      !["journal", "legacy-last-prompt", "unrecoverable"].includes(String(parsed.source)) ||
      typeof parsed.authEventTs !== "number"
    ) return null;
    return {
      prompts: parsed.prompts,
      source: parsed.source as AuthPromptRecovery["source"],
      authEventTs: parsed.authEventTs,
    };
  } catch {
    return null;
  }
}

async function stageAuthReplay(bee: string, recovery: AuthPromptRecovery): Promise<void> {
  const staged: StagedAuthReplay = { version: 1, ...recovery, stagedAt: new Date().toISOString() };
  await ensureHsrRunDir(bee);
  await atomicWriteFile(stagedAuthReplayPath(bee), `${JSON.stringify(staged, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Prove that the record's legacy lastPrompt belongs to the auth-failed turn.
 * New sends use the durable pending-turn journal; this is only the migration
 * bridge for prompts accepted before that journal shipped.
 */
export function legacyPromptForAuthFailure(
  record: Pick<SessionRecord, "lastPrompt" | "lastPromptAt">,
  events: RunnerEvent[],
): string | undefined {
  if (!record.lastPrompt || !record.lastPromptAt) return undefined;
  const promptAt = Date.parse(record.lastPromptAt);
  if (!Number.isFinite(promptAt)) return undefined;
  const authEvent = lastAuthNeededEvent(events);
  if (!authEvent) return undefined;
  const authIndex = events.lastIndexOf(authEvent);
  let startIndex = -1;
  let endIndex = -1;
  for (let index = authIndex; index >= 0; index -= 1) {
    if (events[index]!.type === "turn_start") {
      startIndex = index;
      break;
    }
  }
  for (let index = authIndex; index < events.length; index += 1) {
    if (events[index]!.type === "turn_end") {
      endIndex = index;
      break;
    }
  }
  if (startIndex < 0) return undefined;
  const startedAt = events[startIndex]!.ts;
  const endedAt = endIndex >= 0 ? events[endIndex]!.ts : authEvent.ts;
  // send() stamps lastPrompt just after stdin/RPC acceptance. Allow a small
  // scheduling margin around the structured frame, but never guess across
  // turns — uncertain text is surfaced as prompt loss instead.
  if (promptAt < startedAt - 1_000 || promptAt > endedAt + 5_000) return undefined;
  return record.lastPrompt;
}

/** Exact prompts to replay after auth resume, preferring the durable journal. */
export async function collectAuthRecoveryPrompts(
  record: SessionRecord,
  events: RunnerEvent[] = [],
): Promise<AuthPromptRecovery> {
  const staged = await readStagedAuthReplay(record.name);
  if (staged) return staged;
  const effectiveEvents = events.length > 0 ? events : await readCurrentHsrEventTail(record.name);
  const authEvent = lastAuthNeededEvent(effectiveEvents);
  const journaled = await readPendingHsrTurns(record.name);
  if (journaled.length > 0) {
    return {
      prompts: journaled.map((turn) => turn.text),
      source: "journal",
      authEventTs: authEvent?.ts ?? Date.now(),
    };
  }
  const legacy = legacyPromptForAuthFailure(record, effectiveEvents);
  return {
    prompts: legacy === undefined ? [] : [legacy],
    source: legacy === undefined ? "unrecoverable" : "legacy-last-prompt",
    authEventTs: authEvent?.ts ?? Date.now(),
  };
}

export type AuthResumeSource = "human-login" | "valid-disk-credentials" | "valid-vault-credentials" | "auto";

/**
 * Mechanical stop → same-session revive → exact prompt replay. The successor
 * host durably appends `host_epoch` before starting its adapter, so predecessor
 * auth failures are bounded before the new child can emit anything. Do not add
 * a coordinator-side post-start marker: it would race the detached event writer
 * and could incorrectly outrank a genuine successor boot auth failure.
 */
export async function recoverAuthNeededBee(
  record: SessionRecord,
  account: AccountRecord,
  options: {
    source: AuthResumeSource;
    attempt?: number;
    events?: RunnerEvent[];
    activateCredentials?: boolean;
  },
): Promise<{ record: SessionRecord; replayedPrompts: number; promptSource: AuthPromptRecovery["source"] }> {
  return withSessionLifecycleTransaction(record, (lifecycle) =>
    recoverAuthNeededBeeInTransaction(lifecycle, account, options));
}

async function recoverAuthNeededBeeInTransaction(
  lifecycle: SessionLifecycleTransaction,
  account: AccountRecord,
  options: {
    source: AuthResumeSource;
    attempt?: number;
    events?: RunnerEvent[];
    activateCredentials?: boolean;
  },
): Promise<{ record: SessionRecord; replayedPrompts: number; promptSource: AuthPromptRecovery["source"] }> {
  const record = await lifecycle.refresh();
  if (isArchivedSessionLifecycle(record)) {
    throw new Error(`hive auth-resume: ${record.name} is archived`);
  }
  if (!isRunnableSessionRecord(record)) {
    let replayingOwnAutomaticStop = false;
    if (record.status === "kill_failed" && options.source === "auto") {
      const reservation = await readBeeNameLaunchReservation(record.name);
      const source = reservation?.replacementOf;
      replayingOwnAutomaticStop = reservation?.phase === "stopping"
        && reservation.operation === "auth-resume"
        && source?.createdAt === record.createdAt
        && source.runtimeGeneration === (record.runtimeGeneration ?? 0)
        && (source.id === undefined || source.id === record.id)
        && (source.uuid === undefined || source.uuid === record.uuid);
    }
    // A daemon tick is only authorized to resume the runnable auth-needed
    // generation it observed.  The sole non-runnable exception is replay of
    // that exact generation's own pre-dispatch auth-resume journal.  An
    // unrelated kill/retire may have won after the tick snapshot; rejecting
    // it here keeps credential staging, activation, stop, and launch at zero.
    if (record.status !== "kill_failed" || (options.source === "auto" && !replayingOwnAutomaticStop)) {
      throw new Error(
        `hive auth-resume: ${record.name} is archived or has unresolved stop ownership`,
      );
    }
  }
  if (!record.homePath) throw new Error(`hive auth-resume: ${record.name} has no dedicated home`);
  const promptRecovery = await collectAuthRecoveryPrompts(record, options.events);
  // The ordinary HSR stop intentionally clears pending turns. Stage an
  // owner-only replay bundle first so a failed activation/revive/marker write
  // cannot destroy the last durable copy. It is removed only after every
  // replay has itself entered the new host's pending-turn journal.
  await stageAuthReplay(record.name, promptRecovery);
  const activateCredentials = options.activateCredentials ?? (
    options.source === "human-login" || options.source === "valid-vault-credentials"
  );
  if (activateCredentials) {
    await activateAccountIntoHome(account, record.homePath, { onWarn: (message) => console.error(note(message)) });
  }
  const replacement = await beginBeeReplacementOperation(lifecycle, "auth-resume");
  await stopRuntimeForAuthResume(record, substrateFor(record), (message) =>
    replacement.noteFailure(`hive auth-resume stop unconfirmed: ${message}`)
      .catch(() => undefined)
      .then(() => persistReplacementStopDoubt(lifecycle, "hive auth-resume stop unconfirmed", message)));
  // Credential selection already chose and, when needed, activated the best
  // persisted chain. Skip revive's generic second activation so the decision
  // cannot be changed between the stop and the new child boot.
  const revived = await reviveRecordInTransaction(lifecycle, {
    fresh: false,
    skipCredentialActivation: true,
    deferRequestClosure: true,
    replacementOperation: "auth-resume",
    replacementReservation: replacement,
    predecessorStopConfirmed: true,
  });
  await resolveAuthRequestsAfterResume(record.name).catch(() => undefined);
  // Auth is a successful recovery fact, not merely a superseded request. Close
  // it as auth-resume first; then supersede any unrelated old-generation opens.
  await closeRequestsForNewIncarnation(
    record.name,
    revived.runtimeGeneration ?? (record.runtimeGeneration ?? 0) + 1,
  ).catch(() => undefined);
  const cleared = await lifecycle.commit({
      lastObservedState: undefined,
      lastObservedStateAt: undefined,
      updatedAt: new Date().toISOString(),
    });

  for (const prompt of promptRecovery.prompts) {
    await deliverPromptText(cleared, prompt);
  }
  await rm(stagedAuthReplayPath(record.name), { force: true });

  if (promptRecovery.source === "unrecoverable") {
    await openRequest(record.name, {
      id: authPromptLossRequestId(record.name, cleared.runtimeGeneration ?? 0, promptRecovery.authEventTs),
      kind: "manual-action",
      scope: "runtime-generation",
      grade: "structured",
      generation: cleared.runtimeGeneration ?? 0,
      question: "Authentication recovery restarted the bee, but the failed operator prompt could not be recovered exactly. Resend that prompt.",
      evidence: {
        grade: "structured",
        source: "hsr-prompt-journal",
        observedAt: new Date(promptRecovery.authEventTs).toISOString(),
        detail: "auth-prompt-unrecoverable",
      },
    });
  }

  await appendLedger({
    type: "bee.auth_resume",
    session: record.name,
    account: account.id,
    providerSessionId: record.providerSessionId,
    source: options.source,
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    replayedPrompts: promptRecovery.prompts.length,
    promptSource: promptRecovery.source,
  });
  return { record: cleared, replayedPrompts: promptRecovery.prompts.length, promptSource: promptRecovery.source };
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
export async function reviveTmuxPane(
  record: SessionRecord,
  tool: string,
  opts: {
    fresh?: boolean;
    substrate?: Substrate;
    replacementOperation?: string;
    replacementReservation?: BeeNameLaunchReservation;
    afterLaunch?: (launch: { kind: "tmux"; result: NewSessionResult }) => Promise<void>;
  } = {},
): Promise<void> {
  await withSessionLifecycleTransaction(record, (lifecycle) =>
    reviveTmuxPaneInTransaction(lifecycle, tool, opts));
}

async function reviveTmuxPaneInTransaction(
  lifecycle: SessionLifecycleTransaction,
  tool: string,
  opts: {
    fresh?: boolean;
    substrate?: Substrate;
    replacementOperation?: string;
    replacementReservation?: BeeNameLaunchReservation;
    afterLaunch?: (launch: { kind: "tmux"; result: NewSessionResult }) => Promise<void>;
  } = {},
): Promise<SessionRecord> {
  const record = await lifecycle.refresh();
  const explicitArchivedRevive = hasArchivedLifecycle(record);
  const spec = await buildResumeSpec(record, tool, opts.fresh ? [] : resumeArgs(tool, record.providerSessionId));
  const incarnation = await nextRuntimeIncarnationPatch(record);
  const tmuxTarget = safeTmuxTarget(record.name);
  const substrate = opts.substrate ?? localSubstrate();
  const launchAndPublish = async (reservation: BeeNameLaunchReservation) => {
      await reservation.markLaunchDispatch();
      const launch = await substrate.newSession(tmuxTarget, record.cwd, {
        command: spec.command,
        args: spec.args,
        env: spec.env,
        tmuxOptions: spec.tmuxOptions,
      });
      const ownership = {
        ...incarnation,
        substrate: undefined,
        runnerPid: undefined,
        runnerFingerprint: undefined,
        runnerTier: undefined,
        tmuxTarget,
        ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
        ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
        ...(launch.launcherFingerprint ? { launcherFingerprint: launch.launcherFingerprint } : {}),
      };
      let published: SessionRecord;
      try {
        await reservation.recordTmuxLaunch({
          substrate: substrate.kind === "ssh-tmux" ? "ssh-tmux" : "local-tmux",
          target: tmuxTarget,
          ...(substrate.kind === "ssh-tmux" ? { node: substrate.node } : {}),
          launch,
        });
        await opts.afterLaunch?.({ kind: "tmux", result: launch });
        const revivedAt = new Date().toISOString();
        published = await lifecycle.commit({
          ...ownership,
          command: shellCommand(spec),
          combId: tmuxTarget,
          updatedAt: revivedAt,
          ...(explicitArchivedRevive ? {} : { status: "running" as const }),
          lastError: undefined,
          ...(opts.fresh ? { providerSessionId: undefined, transcriptPath: undefined } : {}),
        });
        if (explicitArchivedRevive) {
          published = await persistExplicitRevive(
            published,
            revivedAt,
            {
              substrate: "local-tmux",
              tmuxTarget,
              ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
            },
            "tmux new-session admission verified the revived runtime",
          );
        }
      } catch (error) {
        await confirmLaunchedTmuxStopped(
          substrate,
          tmuxTarget,
          launch,
          error,
          (detail) => retainReplacementLaunchStopDoubt(
            reservation,
            lifecycle,
            ownership,
            "tmux revive launch cleanup unconfirmed",
            detail,
          ),
        );
        await reservation.clearAfterConfirmedStop();
        throw error;
      }
      await reservation.promotePublished(published);
      return published;
    };
  const restored = opts.replacementReservation
    ? await continueBeeReplacementLaunchAdmission(opts.replacementReservation, launchAndPublish)
    : await withBeeReplacementLaunchAdmission(
        lifecycle,
        opts.replacementOperation ?? "revive-tmux",
        launchAndPublish,
      );
  await writeSpawnOptions(restored);
  await closeSupersededRequests(record, incarnation);
  return restored;
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
  const initialRecord = await resolveSession(target);
  await withSessionLifecycleTransaction(initialRecord, (lifecycle) => promoteInTransaction(lifecycle, parsed));
}

async function promoteInTransaction(lifecycle: SessionLifecycleTransaction, parsed: Parsed): Promise<void> {
  let record = await lifecycle.refresh();
  if (isArchivedSessionLifecycle(record)) {
    throw new Error(`hive promote: ${record.name} is archived; revive it explicitly before migration`);
  }
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
      record = await lifecycle.commit({ providerSessionId: meta.sessionId });
    }
  }
  const tool = assertResumable(record, "promote");
  const now = truthy(flag(parsed, "now"));

  // Resolve every launch precondition before fencing/stopping the predecessor.
  const spec = await buildResumeSpec(record, tool, resumeArgs(tool, record.providerSessionId));
  const incarnation = await nextRuntimeIncarnationPatch(record);
  const tmuxTarget = safeTmuxTarget(record.name);
  const substrate = localSubstrate();
  if (await substrate.hasSession(tmuxTarget)) throw new Error(`hive promote: a tmux session already exists: ${tmuxTarget}`);
  const command = shellCommand(spec);
  // A passive wait has no runtime side effect, so do it before creating the
  // durable stop fence. `--now` sends an interrupt and therefore must be fenced
  // first just like the subsequent teardown.
  let replacement: BeeNameLaunchReservation;
  if (now) {
    replacement = await beginBeeReplacementOperation(lifecycle, "promote");
    try {
      await quiesceHsrBee(record, true);
    } catch (error) {
      await replacement.noteFailure(`hive promote quiesce failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
      throw error;
    }
  } else {
    await quiesceHsrBee(record, false);
    replacement = await beginBeeReplacementOperation(lifecycle, "promote");
  }

  // 2. Stop the HSR runner host — but keep the record.
  try {
    await stopHsrRunner(record);
  } catch (error) {
    await replacement.noteFailure(`hive promote stop unconfirmed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    await persistReplacementStopDoubt(lifecycle, "hive promote stop unconfirmed", error);
    throw error;
  }

  // 3. Launch the interactive tmux session using the same durable attempt that
  // fenced work before predecessor teardown.
  const promoted = await continueBeeReplacementLaunchAdmission(replacement, async (reservation) => {
    await reservation.markLaunchDispatch();
    const launch = await substrate.newSession(tmuxTarget, record.cwd, {
      command: spec.command,
      args: spec.args,
      env: spec.env,
      tmuxOptions: spec.tmuxOptions,
    });
    const ownership = {
      ...incarnation,
      substrate: undefined,
      runnerPid: undefined,
      runnerFingerprint: undefined,
      runnerTier: undefined,
      tmuxTarget,
      ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
      ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
      ...(launch.launcherFingerprint ? { launcherFingerprint: launch.launcherFingerprint } : {}),
    };
    const cleanup = async (cause: unknown): Promise<void> => {
      await confirmLaunchedTmuxStopped(
        substrate,
        tmuxTarget,
        launch,
        cause,
        (detail) => retainReplacementLaunchStopDoubt(
          reservation,
          lifecycle,
          ownership,
          "promote launch cleanup unconfirmed",
          detail,
        ),
      );
      await reservation.clearAfterConfirmedStop();
    };
    try {
      await reservation.recordTmuxLaunch({ substrate: "local-tmux", target: tmuxTarget, launch });
    } catch (error) {
      await cleanup(error);
      throw error;
    }

    // A rejected interactive resume is cleaned exactly before the separately
    // journaled HSR rollback launch begins.
    if (!(await tmuxSessionSurvives(substrate, tmuxTarget, RESUME_LIVENESS_SETTLE_MS))) {
      await cleanup(new Error("promote resume exited"));
      await reviveHsrRunnerInTransaction(lifecycle, tool, { replacementOperation: "promote-rollback" });
      throw new Error(
        `hive promote: ${record.name} exited immediately after the ${record.agent} resume — its provider session is not interactively resumable; left running on HSR`,
      );
    }

    let published: SessionRecord;
    try {
      published = await lifecycle.commit({
        ...ownership,
        command,
        combId: tmuxTarget,
        updatedAt: new Date().toISOString(),
        status: "running",
        lastError: undefined,
      });
    } catch (error) {
      await cleanup(error);
      throw error;
    }
    await reservation.promotePublished(published);
    return published;
  });
  await writeSpawnOptions(promoted);
  await closeSupersededRequests(record, incarnation);
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
  const initialRecord = await resolveSession(target);
  await withSessionLifecycleTransaction(initialRecord, (lifecycle) => demoteInTransaction(lifecycle, parsed));
}

async function demoteInTransaction(lifecycle: SessionLifecycleTransaction, parsed: Parsed): Promise<void> {
  const record = await lifecycle.refresh();
  if (isArchivedSessionLifecycle(record)) {
    throw new Error(`hive demote: ${record.name} is archived; revive it explicitly before migration`);
  }
  if (record.substrate === "hsr") {
    throw new Error(`hive demote: ${record.name} is already on HSR (not a tmux bee)`);
  }
  if (record.node && record.node !== LOCAL_NODE_NAME) {
    throw new Error(`hive demote: ${record.name} is on remote node ${record.node}; demote only supports local tmux bees`);
  }
  const tool = assertResumable(record, "demote");
  const adapter = adapterFor(tool);
  if (!adapter) throw new Error(`hive demote: no HSR adapter for ${record.agent}`);
  const now = truthy(flag(parsed, "now"));
  const tmuxSubstrate = localSubstrate();
  const spec = await buildResumeSpec(record, tool, []);
  const incarnation = await nextRuntimeIncarnationPatch(record);
  const brokerCapability = record.executionRunId
    ? mintCellBrokerCapability(record.name, incarnation.runtimeGeneration as number)
    : undefined;
  const runnerTier = adapter.tier();
  const command = shellCommand(spec);
  const replacement = await beginBeeReplacementOperation(lifecycle, "demote");

  // 1. Quiesce. A tmux bee's mid-turn state is heuristic, so absent --now we
  //    proceed best-effort; --now sends Ctrl-C to the agent pane first.
  if (now) {
    await tmuxSubstrate.sendKey(record.tmuxTarget, "C-c", record.agentPaneId).catch(() => undefined);
    await sleep(300);
  } else {
    console.error(note(`${record.name}: a tmux bee's mid-turn state is heuristic — demoting without waiting (use --now to interrupt first)`));
  }

  // 2. Kill the tmux session/pane — but keep the record.
  await stopRuntimeForReplacement(record, tmuxSubstrate, record.tmuxTarget, {
    context: `hive demote: could not stop ${record.name}`,
    onStopUnconfirmed: async (message) => {
      await replacement.noteFailure(`hive demote stop unconfirmed: ${message}`).catch(() => undefined);
      await persistReplacementStopDoubt(lifecycle, "hive demote stop unconfirmed", message);
    },
  });

  // 3. Fork the runner host with the already-fenced attempt.
  const demoted = await continueBeeReplacementLaunchAdmission(replacement, async (reservation) => {
    await reservation.markLaunchDispatch();
    const hostPid = await spawnHsrHost({
      bee: record.name,
      comb: record.combId ?? record.name,
      ...(record.parentId ? { parent: record.parentId } : {}),
      kind: tool,
      cwd: record.cwd,
      sessionId: record.providerSessionId,
      resume: true,
      authKind: "subscription",
      ...(record.accountId ? { accountId: record.accountId } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...hsrCellPayloadFields(record),
      ...(brokerCapability ? { cellBrokerCapability: brokerCapability.token } : {}),
      spec: { command: spec.command, args: spec.args, env: spec.env },
    });
    let runnerFingerprint: SessionRecord["runnerFingerprint"];
    const ownership = () => ({
      ...incarnation,
      command,
      substrate: "hsr" as const,
      runnerPid: hostPid,
      ...(runnerFingerprint ? { runnerFingerprint } : {}),
      ...(runnerTier ? { runnerTier } : {}),
      ...(spec.homePath && !record.homePath ? { homePath: spec.homePath } : {}),
      tmuxTarget: record.name,
      combId: record.name,
      agentPaneId: undefined,
      launcherPgid: undefined,
      launcherFingerprint: undefined,
      ...(brokerCapability ? { cellBrokerCapabilityHash: brokerCapability.hash } : {}),
    });
    const cleanup = async (cause: unknown): Promise<void> => {
      await confirmLaunchedHsrStopped(
        record.name,
        hostPid,
        cause,
        stopHsrIncarnationByPid,
        (detail) => retainReplacementLaunchStopDoubt(
          reservation,
          lifecycle,
          ownership(),
          "demote launch cleanup unconfirmed",
          detail,
        ),
      );
      await reservation.clearAfterConfirmedStop();
    };
    try {
      await reservation.recordHsrLaunch({ hostPid, childAdmission: "pending" });
      const admittedMeta = await readHsrMetaStrict(record.name);
      runnerFingerprint = admittedMeta?.hostPid === hostPid ? admittedMeta.hostFingerprint : undefined;
      if (!runnerFingerprint || (admittedMeta?.childAdmission !== "admitted" && admittedMeta?.childAdmission !== "none")) {
        throw new Error("HSR demote returned without complete process birth admission");
      }
      await reservation.recordHsrLaunch({
        hostPid,
        hostFingerprint: runnerFingerprint,
        childAdmission: admittedMeta.childAdmission,
      });
    } catch (error) {
      await cleanup(error);
      throw error;
    }

    if (!(await waitForHsrReadiness(record.name, 5000))) {
      console.error(note(`hsr host for ${record.name} did not report live within 5s; the daemon will reconcile`));
    }
    if (!(await hsrChildSurvives(record.name, RESUME_LIVENESS_SETTLE_MS))) {
      await cleanup(new Error("demote resume exited"));
      await reviveTmuxPaneInTransaction(lifecycle, tool, { replacementOperation: "demote-rollback" });
      throw new Error(
        `hive demote: ${record.name} exited immediately after the ${record.agent} headless resume — its provider session is not headlessly resumable; left running on tmux`,
      );
    }

    let published: SessionRecord;
    try {
      published = await lifecycle.commit({
        ...ownership(),
        updatedAt: new Date().toISOString(),
        status: "running",
        lastError: undefined,
      });
    } catch (error) {
      await cleanup(error);
      throw error;
    }
    await reservation.promotePublished(published);
    return published;
  });
  await writeSpawnOptions(demoted);
  await closeSupersededRequests(record, incarnation);
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
    // Retired (done) bees are settled on purpose — bulk revive must never
    // resurrect them. Reviving a retired bee stays possible one at a time.
    const local = records.filter((record) =>
      (!record.node || record.node === LOCAL_NODE_NAME) && !isArchivedSessionLifecycle(record));
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
        // "done" (sealed), not "crashed" — so --crashed must not resurrect it.
        if (bulkCrashed && !isRunnableSessionRecord(record)) {
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
 * Credential-aware recovery for a live-but-stuck `auth-needed` bee:
 *   1. compare Claude's effective home chain with the account vault,
 *   2. preserve a newer home chain, activate a newer vaulted login, or require
 *      a fresh login when neither persisted chain is usable,
 *   3. stop the stuck runtime,
 *   4. relaunch the same provider session and replay the failed prompt.
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
  let source: AuthResumeSource = "human-login";
  let credentialDetail = "fresh interactive login";
  const credentialPlan = tool === "claude"
    ? await planClaudeRecoveryCredentials(account, record.homePath)
    : { ready: false as const, reason: "unsupported-tool" };
  let diskIdentityMatches = true;
  if (credentialPlan.ready && credentialPlan.source === "home") {
    const expectedEmail = accountEmail(account)?.toLowerCase();
    const actualEmail = (await homeClaudeEmail(record.homePath).catch(() => null))?.toLowerCase();
    diskIdentityMatches = !(expectedEmail && actualEmail && expectedEmail !== actualEmail);
  }
  if (credentialPlan.ready && credentialPlan.source === "home" && diskIdentityMatches) {
    source = "valid-disk-credentials";
    credentialDetail = "current home credentials";
  } else if (credentialPlan.ready && credentialPlan.source === "vault") {
    source = "valid-vault-credentials";
    credentialDetail = credentialPlan.reason === "vault-newer"
      ? "newer credentials from vault"
      : "valid credentials from vault";
  } else {
    // This is the unchanged real-logout gate: an absent, malformed, expired,
    // or non-refreshable credential still requires a human to complete login.
    const seatHome = resolve(storeRoot(), "login-homes", account.id);
    await assertLoginSeatFreshForAuthResume(account, seatHome);
    const captured = await captureAccountFromHome(account, seatHome).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`hive auth-resume: no fresh login captured for ${account.id} (${message}); run hive login ${account.id} first`);
    });
    credentialDetail = `${captured.length} credential file(s)`;
  }

  const recovered = await recoverAuthNeededBee(record, account, { source });

  if (isPretty()) {
    const promptDetail = recovered.promptSource === "unrecoverable"
      ? "prompt missing — resend required"
      : `${recovered.replayedPrompts} prompt(s) replayed`;
    console.log(actionLine("ok", "auth-resume", [bold(record.name), account.id, dim(credentialDetail), dim(promptDetail)]));
  } else {
    console.log(`auth-resumed\t${record.name}\t${account.id}\t${recovered.record.providerSessionId ?? ""}\t${source}\t${recovered.promptSource}`);
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

export async function stopRuntimeForAuthResume(
  record: SessionRecord,
  substrate: Substrate = substrateFor(record),
  onStopUnconfirmed?: (message: string) => Promise<void>,
): Promise<void> {
  const target = record.substrate === "hsr" ? record.name : record.tmuxTarget;
  await stopRuntimeForReplacement(record, substrate, target, {
    pollAttempts: 50,
    pollIntervalMs: 100,
    context: `hive auth-resume: could not stop ${record.name}`,
    ...(onStopUnconfirmed ? { onStopUnconfirmed } : {}),
  });
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
  if (substrate.kind === "remote-hsr") {
    // The CLI rejects remote set-model before entering the transaction. Keep
    // the invariant here too so no internal/stale caller can stop a remote HSR
    // and then fall through to the tmux-only newSession verb.
    throw new Error(`hive set-model: ${record.name} is on remote node ${record.node}; set-model only supports local bees`);
  }
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
 * output — it does only the resolveAgent/newSession-or-HSR/lifecycle-CAS/
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
export async function reviveRecord(
  record: SessionRecord,
  opts: {
    fresh: boolean;
    sessionOverride?: string;
    skipCredentialActivation?: boolean;
    deferRequestClosure?: boolean;
    replacementOperation?: string;
    replacementReservation?: BeeNameLaunchReservation;
    predecessorStopConfirmed?: boolean;
    substrate?: Substrate;
    afterLaunch?: (
      launch:
        | { kind: "tmux"; result: NewSessionResult }
        | { kind: "hsr"; hostPid: number }
        | { kind: "remote-hsr"; result: RemoteSpawnResult },
    ) => Promise<void>;
    spawnHsrHost?: (payload: HsrRunPayload) => Promise<number>;
    waitForHsrHost?: (bee: string, timeoutMs: number) => Promise<boolean>;
    stopHsrIncarnation?: typeof stopHsrIncarnationByPid;
  },
): Promise<SessionRecord> {
  return withSessionLifecycleTransaction(record, (lifecycle) => reviveRecordInTransaction(lifecycle, opts));
}

export async function reviveRecordInTransaction(
  lifecycle: SessionLifecycleTransaction,
  opts: {
    fresh: boolean;
    sessionOverride?: string;
    skipCredentialActivation?: boolean;
    deferRequestClosure?: boolean;
    replacementOperation?: string;
    replacementReservation?: BeeNameLaunchReservation;
    predecessorStopConfirmed?: boolean;
    substrate?: Substrate;
    afterLaunch?: (
      launch:
        | { kind: "tmux"; result: NewSessionResult }
        | { kind: "hsr"; hostPid: number }
        | { kind: "remote-hsr"; result: RemoteSpawnResult },
    ) => Promise<void>;
    spawnHsrHost?: (payload: HsrRunPayload) => Promise<number>;
    waitForHsrHost?: (bee: string, timeoutMs: number) => Promise<boolean>;
    stopHsrIncarnation?: typeof stopHsrIncarnationByPid;
  },
): Promise<SessionRecord> {
  const record = await lifecycle.refresh();
  if (record.deliveryStopDoubt) {
    throw new Error(
      `hive revive: ${record.name} has unresolved delivery ownership ${record.deliveryStopDoubt.deliveryId}; `
      + `run hive buz reconcile ${record.name} ${record.deliveryStopDoubt.deliveryId} --delivered|--discard first`,
    );
  }
  const explicitArchivedRevive = hasArchivedLifecycle(record);
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
    if (await hsrSubstrate().hasSession(record.name) && record.status !== "kill_failed") {
      throw new Error(`hive revive: ${record.name} is already running (${record.name})`);
    }
    const replacement = opts.replacementReservation
      ?? await beginBeeReplacementOperation(lifecycle, opts.replacementOperation ?? "revive");
    // A dead host is not proof that its detached harness group is gone. Reuse
    // the strict incarnation teardown before replacing meta.json; otherwise a
    // revive could erase the only locator for a crashed host's live child.
    if (!opts.predecessorStopConfirmed) {
      try {
        await stopHsrRunner(record);
      } catch (error) {
        await replacement.noteFailure(
          `hive revive stop unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
        ).catch(() => undefined);
        await persistReplacementStopDoubt(lifecycle, "hive revive stop unconfirmed", error);
        throw error;
      }
    }
    const updated = await reviveHsrRunnerInTransaction(lifecycle, tool, {
      fresh,
      sessionOverride,
      replayLaunch: true,
      activateCredentials: opts.skipCredentialActivation !== true,
      deferRequestClosure: opts.deferRequestClosure,
      replacementOperation: opts.replacementOperation ?? "revive",
      replacementReservation: replacement,
      afterLaunch: opts.afterLaunch,
      spawnHsrHost: opts.spawnHsrHost,
      waitForHsrHost: opts.waitForHsrHost,
      stopHsrIncarnation: opts.stopHsrIncarnation,
    });
    await appendLedger({
      type: "bee.revive",
      session: record.name,
      providerSessionId: providerSessionId ?? null,
      fresh,
    });
    return updated;
  }
  const substrate = opts.substrate ?? substrateFor(record);
  const targetLive = await substrate.hasSession(record.tmuxTarget);
  if (targetLive && record.status !== "kill_failed") {
    throw new Error(`hive revive: ${record.name} is already running (${record.tmuxTarget})`);
  }

  // Mirror the swap relaunch: rebuild the agent command from the configured
  // kind (preserving the original permission mode) and append the resume args.
  // The first-class model + its persisted extra flags ride along — without
  // them a revived bee silently falls back to the harness default model
  // (the HSR path via buildResumeSpec always applied them; this path must too).
  const lifecycleArgs = fresh ? [] : resumeArgs(tool, providerSessionId);
  const resolved = resolveAgent(record.requestedAgent ?? record.agent, [...modelExtraArgsFor(record), ...lifecycleArgs], {
    home: record.homePath,
    yolo: sniffYolo(record.command),
    identity: true,
    ...(record.model ? { model: record.model } : {}),
  });
  const replay = replayRecordedLaunch(record, tool, resolved, lifecycleArgs);
  let spec = replay.spec;
  // Same-bee relaunch: re-stamp honeybee identity (H1 covers revives too).
  stampBeeIdentityEnv(spec.env, {
    name: record.name,
    id: record.id ?? record.name,
    comb: record.name,
    ...(record.spawnedById ? { parent: record.spawnedById } : {}),
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
    spec = await assertReplayExecutable(replay, resolved);
    if (tool === "claude" && record.homePath && opts.skipCredentialActivation !== true) {
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

  const replacement = opts.replacementReservation
    ?? await beginBeeReplacementOperation(lifecycle, opts.replacementOperation ?? "revive");

  if (!opts.predecessorStopConfirmed) {
    // Explicit revive grants permission for future work only after the prior
    // runtime's ownership is positively resolved. A missing tmux target is
    // insufficient: an escaped launcher group is exactly why kill_failed was
    // persisted. Remote authority enforces the equivalent token proof.
    await stopRuntimeForReplacement(record, substrate, record.tmuxTarget, {
      context: `hive revive: could not resolve prior stop for ${record.name}`,
      onStopUnconfirmed: async (message) => {
        await replacement.noteFailure(`hive revive stop unconfirmed: ${message}`).catch(() => undefined);
        await persistReplacementStopDoubt(lifecycle, "hive revive stop unconfirmed", message);
      },
    });
  }

  const incarnation = await nextRuntimeIncarnationPatch(record);
  if (substrate.kind === "remote-hsr") {
    const remote = substrate as RemoteHsrSubstrate;
    const remoteLaunchId = randomUUID();
    const account = record.accountId ? await findAccount(record.accountId, tool) : undefined;
    const ephemeral = account ? await mintEphemeralCredential(account, tool) : undefined;
    const delivered = ephemeral
      ? {
          ...(ephemeral.files.length > 0 ? { files: ephemeral.files } : {}),
          ...(ephemeral.env ? { env: ephemeral.env } : {}),
        }
      : undefined;
    const updated = await continueBeeReplacementLaunchAdmission(
      replacement,
      async (reservation) => {
        await reservation.markRemoteLaunchDispatch({
          node: record.node!,
          remoteLaunchId,
        });
        let spawnResult: RemoteSpawnResult | undefined;
        const persistRemoteStopDoubt = async (
          locator: { launchId: string; incarnation?: string },
          detail: string,
        ): Promise<void> => {
          await reservation.retainRemoteStopDoubt({
            node: record.node!,
            remoteLaunchId: locator.launchId,
            ...(locator.incarnation ? { remoteIncarnation: locator.incarnation } : {}),
          }, detail).catch(() => undefined);
          const current = await lifecycle.refresh();
          const replacement = currentSessionRuntimeReplacement(current);
          const updatedAt = new Date().toISOString();
          await lifecycle.commit({
            ...incarnation,
            node: record.node,
            remoteLaunchId: locator.launchId,
            ...(locator.incarnation ? { remoteIncarnation: locator.incarnation } : {}),
            cwd: spawnResult?.cwd ?? record.cwd,
            status: "kill_failed",
            lastError: `remote HSR revive launch cleanup unconfirmed: ${detail}`,
            ...(replacement ? {
              runtimeReplacement: {
                ...replacement,
                state: "stop-failed" as const,
                updatedAt,
                detail: `remote HSR revive launch cleanup unconfirmed: ${detail}`,
              },
            } : {}),
            updatedAt,
          }).catch(() => undefined);
        };
        const cleanup = async (cause: unknown, locator: { launchId: string; incarnation?: string }): Promise<never> => {
          const proof = await cleanupLaunchedRemoteHsrIncarnation(remote, record.name, locator);
          if (proof.stopped) {
            await reservation.clearAfterConfirmedStop();
          } else {
            await persistRemoteStopDoubt(locator, proof.detail);
          }
          const original = cause instanceof Error ? cause.message : String(cause);
          throw new Error(
            `${original}; exact remote replacement cleanup ${proof.stopped ? "confirmed" : `unconfirmed: ${proof.detail}`}`,
            { cause },
          );
        };
        try {
          spawnResult = await remote.spawnRemote({
            bee: record.name,
            launchId: remoteLaunchId,
            ...(record.remoteLaunchId ? { previousLaunchId: record.remoteLaunchId } : {}),
            kind: spec.kind,
            cwd: record.cwd,
            comb: record.combId ?? record.name,
            ...(record.parentId ? { parent: record.parentId } : {}),
            ...(providerSessionId ? { sessionId: providerSessionId } : {}),
            ...(fresh ? {} : { resume: true }),
            authKind: "subscription",
            ...(record.model ? { model: record.model } : {}),
            ...(delivered ? { creds: delivered } : {}),
            spec: { command: spec.command, args: spec.args, env: spec.env },
          });
          await reservation.recordRemoteLaunch({
            node: record.node!,
            remoteLaunchId,
            remoteIncarnation: spawnResult.incarnation,
          });
          await opts.afterLaunch?.({ kind: "remote-hsr", result: spawnResult });
        } catch (error) {
          if (error instanceof RemoteSpawnNotAdmittedError) {
            await reservation.clearAfterConfirmedStop();
            throw error;
          }
          const incarnationToken = spawnResult?.incarnation
            ?? (error instanceof RemoteSpawnIndeterminateError ? error.incarnation : undefined);
          return cleanup(error, {
            launchId: remoteLaunchId,
            ...(incarnationToken ? { incarnation: incarnationToken } : {}),
          });
        }

        let published: SessionRecord;
        try {
          const revivedAt = new Date().toISOString();
          published = await lifecycle.commit({
            ...incarnation,
            ...(explicitArchivedRevive ? {} : { status: "running" as const }),
            lastError: undefined,
            lastReviveCommand: shellCommand(spec),
            cwd: spawnResult.cwd,
            node: record.node,
            remoteLaunchId: spawnResult.launchId,
            remoteIncarnation: spawnResult.incarnation,
            ...(spawnResult.tier ? { runnerTier: spawnResult.tier } : {}),
            ...(sessionOverride ? { providerSessionId: sessionOverride } : {}),
            ...(ephemeral?.expiresAt ? { remoteTokenExpiresAt: ephemeral.expiresAt } : {}),
            ...(fresh ? { providerSessionId: undefined, transcriptPath: undefined } : {}),
            updatedAt: revivedAt,
          });
          if (explicitArchivedRevive) {
            published = await persistExplicitRevive(
              published,
              revivedAt,
              {
                substrate: "remote-hsr",
                node: record.node,
                remoteLaunchId: spawnResult.launchId,
                remoteIncarnation: spawnResult.incarnation,
              },
              "remote authority admitted the revived launch generation",
            );
          }
        } catch (error) {
          return cleanup(error, {
            launchId: spawnResult.launchId,
            incarnation: spawnResult.incarnation,
          });
        }
        await reservation.promoteExternallyPublished(published);
        return published;
      },
    );
    await writeSpawnOptions(updated);
    if (!opts.deferRequestClosure) await closeSupersededRequests(record, incarnation);
    await appendLedger({
      type: "bee.revive",
      session: record.name,
      providerSessionId: providerSessionId ?? null,
      fresh,
      node: record.node,
      remoteLaunchId: updated.remoteLaunchId,
    });
    return updated;
  }
  const updated = await continueBeeReplacementLaunchAdmission(
    replacement,
    async (reservation) => {
      await reservation.markLaunchDispatch();
      const launch = await substrate.newSession(record.tmuxTarget, record.cwd, {
        command: spec.command,
        args: spec.args,
        env: spec.env,
        tmuxOptions: spec.tmuxOptions,
      });
      const ownership = {
        ...incarnation,
        substrate: undefined,
        runnerPid: undefined,
        runnerFingerprint: undefined,
        runnerTier: undefined,
        ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
        ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
        ...(launch.launcherFingerprint ? { launcherFingerprint: launch.launcherFingerprint } : {}),
      };
      let published: SessionRecord;
      try {
        await reservation.recordTmuxLaunch({
          substrate: substrate.kind === "ssh-tmux" ? "ssh-tmux" : "local-tmux",
          target: record.tmuxTarget,
          ...(substrate.kind === "ssh-tmux" ? { node: substrate.node } : {}),
          launch,
        });
        await opts.afterLaunch?.({ kind: "tmux", result: launch });
        const revivedAt = new Date().toISOString();
        published = await lifecycle.commit({
          ...ownership,
          ...(explicitArchivedRevive ? {} : { status: "running" as const }),
          lastError: undefined,
          lastReviveCommand: shellCommand(spec),
          combId: record.combId ?? record.tmuxTarget,
          ...(sessionOverride ? { providerSessionId: sessionOverride } : {}),
          ...(ownerId && ownerId !== record.accountId ? { accountId: ownerId } : {}),
          ...(fresh ? { providerSessionId: undefined, transcriptPath: undefined } : {}),
          updatedAt: revivedAt,
        });
        if (explicitArchivedRevive) {
          published = await persistExplicitRevive(
            published,
            revivedAt,
            {
              substrate: "local-tmux",
              tmuxTarget: record.tmuxTarget,
              ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
            },
            "tmux new-session admission verified the revived runtime",
          );
        }
      } catch (error) {
        await confirmLaunchedTmuxStopped(
          substrate,
          record.tmuxTarget,
          launch,
          error,
          (detail) => retainReplacementLaunchStopDoubt(
            reservation,
            lifecycle,
            ownership,
            "tmux revive launch cleanup unconfirmed",
            detail,
          ),
        );
        await reservation.clearAfterConfirmedStop();
        throw error;
      }
      await reservation.promotePublished(published);
      return published;
    },
  );
  await writeSpawnOptions(updated);
  if (!opts.deferRequestClosure) await closeSupersededRequests(record, incarnation);
  await appendLedger({
    type: "bee.revive",
    session: record.name,
    providerSessionId: providerSessionId ?? null,
    agentPaneId: updated.agentPaneId,
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
  const alreadyLive = await substrate.hasSession(record.tmuxTarget);
  const headlessRuntime = record.substrate === "hsr" || substrate.kind === "remote-hsr";
  // A prior manual revive may have launched and committed the replacement,
  // then died before resolving the recovery request/resetting the budget.
  // Treat that exact bounded state as a finalization retry, not "already
  // running"; all ordinary live revives retain the existing rejection.
  const finalizeExistingRecovery = alreadyLive && headlessRuntime &&
    (record.stateMachine?.runtime === "lost" || record.stateMachine?.runtime === "recovering");
  if (alreadyLive && !finalizeExistingRecovery) {
    throw new Error(`hive revive: ${record.name} is already running (${record.tmuxTarget})`);
  }
  const tool = canonicalAgentKind(record.agent).toLowerCase();
  const fresh = truthy(flag(parsed, "fresh"));
  // --session <id> resumes (and persists) a specific provider session — used to
  // recover bees whose providerSessionId was never recorded but whose session
  // still exists on disk (claude/codex keep sessions keyed by project dir).
  const sessionOverride = stringFlag(parsed, ["session"]);
  const providerSessionId = fresh ? undefined : (sessionOverride ?? record.providerSessionId);
  if (!finalizeExistingRecovery && !fresh && !providerSessionId) {
    throw new Error(
      `hive revive: ${record.name} has no recorded provider session id; pass --session <id> to resume an exact ${tool} session, or --fresh to start anew`,
    );
  }

  const preserveRecoveryRequest = headlessRuntime &&
    (record.stateMachine?.runtime === "lost" || record.stateMachine?.runtime === "recovering");
  const launched = finalizeExistingRecovery
    ? record
    : await reviveRecord(record, {
        fresh,
        sessionOverride,
        deferRequestClosure: preserveRecoveryRequest,
      });
  const updated = await finalizeManualRuntimeRevive(launched);

  const how = finalizeExistingRecovery
    ? "verified existing replacement"
    : providerSessionId ? `resumed ${providerSessionId}` : "fresh session";
  const relaunchedCommand = updated.lastReviveCommand ?? updated.command;
  if (isPretty()) {
    console.log(actionLine("ok", "revive", [bold(record.name), record.agent, dim(how)]));
    console.error(note(relaunchedCommand));
  } else {
    console.log(`revived\t${record.name}\t${record.agent}\t${how}\t${relaunchedCommand}`);
  }
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
  const initialRecord = await resolveSession(target);
  if (initialRecord.node && initialRecord.node !== LOCAL_NODE_NAME) {
    throw new Error(`hive set-model: ${initialRecord.name} is on remote node ${initialRecord.node}; set-model only supports local bees`);
  }
  const tool = canonicalAgentKind(initialRecord.agent).toLowerCase();
  // OpenCode multiplexes providers. Persist the qualified selector as the
  // first-class model so revive/promote/demote can rebuild it without a
  // separate provider field on SessionRecord.
  const modelSlash = model?.indexOf("/") ?? -1;
  if (!clear && tool === "opencode" && (modelSlash <= 0 || modelSlash === (model?.length ?? 0) - 1)) {
    throw new Error("hive set-model: opencode requires a qualified provider/model selector");
  }
  if (!clear && modelArgsForAgent(tool, model).length === 0) {
    throw new Error(`hive set-model: ${initialRecord.agent} has no model selector (no model flag known for ${tool})`);
  }
  const fresh = truthy(flag(parsed, "fresh"));
  const now = truthy(flag(parsed, "now"));
  const extraLine = parsed.rest.length > 0 ? parsed.rest.map(shellQuoteIfNeeded).join(" ") : undefined;

  await withSessionLifecycleTransaction(initialRecord, (lifecycle) => setModelInTransaction(lifecycle, {
    tool,
    clear,
    model,
    fresh,
    now,
    extraLine,
  }));
}

async function setModelInTransaction(
  lifecycle: SessionLifecycleTransaction,
  options: {
    tool: string;
    clear: boolean;
    model?: string;
    fresh: boolean;
    now: boolean;
    extraLine?: string;
  },
): Promise<void> {
  const { tool, clear, model, fresh, now, extraLine } = options;
  let record = await lifecycle.refresh();

  // Server-tier harnesses mint their provider thread id at RUNTIME — backfill
  // it from the HSR meta (mirrors promote) so the resume gate below can see it.
  if (record.substrate === "hsr" && !record.providerSessionId) {
    const meta = await readHsrMeta(record.name).catch(() => null);
    if (meta?.sessionId) {
      record.providerSessionId = meta.sessionId;
      record = await lifecycle.commit({ providerSessionId: meta.sessionId });
    }
  }

  const substrate = substrateFor(record);
  let alive: boolean;
  try {
    alive = await substrate.hasSession(record.tmuxTarget);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`hive set-model: could not observe ${record.tmuxTarget} before changing runtime: ${detail}`);
  }
  if (isArchivedSessionLifecycle(record) && alive) {
    throw new Error(
      `hive set-model: ${record.name} is archived but still has a live runtime; resolve cleanup before changing it`,
    );
  }
  if (alive && !fresh && !record.providerSessionId) {
    throw new Error(
      `hive set-model: ${record.name} has no recorded provider session id to resume; retry with --fresh to relaunch on a new provider session`,
    );
  }

  const previous = { model: record.model, modelExtraArgs: record.modelExtraArgs };
  // Explicit undefined deletes the field (record merge semantics).
  const applyFields: Partial<SessionRecord> = {
    model: clear ? undefined : model,
    modelExtraArgs: extraLine,
    ...(fresh ? { providerSessionId: undefined, transcriptPath: undefined } : {}),
    updatedAt: new Date().toISOString(),
  };

  if (!alive && record.status !== "kill_failed") {
    const updated = await lifecycle.commit(applyFields);
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

  // One attempt fences work before the first interrupt/stop and is reused by
  // the successor publication. Passive HSR quiescence happens before the fence
  // because it has no runtime side effect and may time out harmlessly.
  let replacement: BeeNameLaunchReservation;
  if (record.substrate === "hsr") {
    if (alive && !now) {
      await quiesceHsrBee(record, false, "set-model");
      replacement = await beginBeeReplacementOperation(lifecycle, "set-model");
    } else {
      replacement = await beginBeeReplacementOperation(lifecycle, "set-model");
      if (alive) await quiesceHsrBee(record, true, "set-model");
    }
    try {
      await stopHsrRunner(record);
    } catch (error) {
      await replacement.noteFailure(
        `hive set-model stop unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => undefined);
      await persistReplacementStopDoubt(lifecycle, "hive set-model stop unconfirmed", error);
      throw error;
    }
  } else {
    replacement = await beginBeeReplacementOperation(lifecycle, "set-model");
    // tmux: a pane's mid-turn state is heuristic (mirrors demote) — interrupt
    // with --now, then kill the session outright like swap-account does.
    if (now) {
      await localSubstrate().sendKey(record.tmuxTarget, "C-c", record.agentPaneId).catch(() => undefined);
      await sleep(300);
    }
    await stopRuntimeForReplacement(record, substrate, record.tmuxTarget, {
      pollAttempts: 16,
      pollIntervalMs: 250,
      context: `hive set-model: could not stop ${record.tmuxTarget} before relaunch`,
      onStopUnconfirmed: async (message) => {
        await replacement.noteFailure(`hive set-model stop unconfirmed: ${message}`).catch(() => undefined);
        await persistReplacementStopDoubt(lifecycle, "hive set-model stop unconfirmed", message);
      },
    });
  }

  const updated = await lifecycle.commit(applyFields);

  // Restore the previous selection and relaunch it — the recovery mirror of
  // promote/demote's rollback, so a bad model name never leaves a dead bee.
  const rollback = async (rollbackReservation: BeeNameLaunchReservation): Promise<void> => {
    const restoredFields: Partial<SessionRecord> = {
      model: previous.model,
      modelExtraArgs: previous.modelExtraArgs,
      updatedAt: new Date().toISOString(),
    };
    await lifecycle.commit(restoredFields);
    if (record.substrate === "hsr") {
      await reviveHsrRunnerInTransaction(lifecycle, tool, {
        fresh,
        replacementOperation: "set-model-rollback",
        replacementReservation: rollbackReservation,
      });
    } else {
      await reviveTmuxPaneInTransaction(lifecycle, tool, {
        fresh,
        replacementOperation: "set-model-rollback",
        replacementReservation: rollbackReservation,
      });
    }
  };

  const cleanupFailedReplacement = async (replacement: SessionRecord): Promise<void> => {
    if (replacement.substrate === "hsr") {
      try {
        await stopHsrRunner(replacement);
      } catch (error) {
        await persistReplacementStopDoubt(lifecycle, "hive set-model failed replacement stop unconfirmed", error);
        throw error;
      }
      return;
    }
    await stopRuntimeForReplacement(replacement, substrate, replacement.tmuxTarget, {
      context: `hive set-model: could not stop failed replacement ${replacement.name}`,
      onStopUnconfirmed: (message) =>
        persistReplacementStopDoubt(lifecycle, "hive set-model failed replacement stop unconfirmed", message),
    });
  };

  const restoreAfterRejectedReplacement = async (replacement: SessionRecord): Promise<void> => {
    // Pane/meta disappearance is not process-group death. Stop the exact
    // just-published incarnation before launching the previous model; otherwise
    // a provider that escaped its pane/control host can execute beside rollback.
    const rollbackReservation = await beginBeeReplacementOperation(lifecycle, "set-model-rollback");
    await cleanupFailedReplacement(replacement);
    await rollback(rollbackReservation);
  };

  if (record.substrate === "hsr") {
    const launchedReplacement = await reviveHsrRunnerInTransaction(lifecycle, tool, {
      fresh,
      replacementOperation: "set-model",
      replacementReservation: replacement,
    });
    if (!(await hsrChildSurvives(record.name, RESUME_LIVENESS_SETTLE_MS))) {
      await restoreAfterRejectedReplacement(launchedReplacement);
      throw new Error(
        `hive set-model: ${record.agent} exited immediately on model ${model ?? "(default)"} — bad model name or rejected resume; previous model restored`,
      );
    }
  } else {
    const launchedReplacement = await reviveTmuxPaneInTransaction(lifecycle, tool, {
      fresh,
      substrate,
      replacementOperation: "set-model",
      replacementReservation: replacement,
    });
    if (!(await tmuxSessionSurvives(substrate, record.tmuxTarget, RESUME_LIVENESS_SETTLE_MS))) {
      await restoreAfterRejectedReplacement(launchedReplacement);
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
