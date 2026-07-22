import { createHash } from "node:crypto";
import { hasTranscriptProvider } from "./drivers.js";
import { cyan, dim, isPretty, tildify } from "./format.js";
import { writeHiveState } from "./hiveState.js";
import { isPermissionPromptPane } from "./readiness.js";
import { listSeals, loadLatestSeal, type SealRecord } from "./seal.js";
import { sessionLivenessFailure } from "./sessionLiveness.js";
import { persistSessionTranscriptMetadata, transcriptLookupForSession } from "./sessionMetadata.js";
import { appendLedger, loadSession, type SessionRecord } from "./store.js";
import { substrateFor, type Substrate } from "./substrates/index.js";
import { lastAssistantText, latestTranscript, renderTranscript } from "./transcripts.js";

export const WAIT_EXIT_CODES = {
  success: 0,
  terminal: 1,
  timeout: 2,
} as const;

export type WaitFailureKind = Exclude<keyof typeof WAIT_EXIT_CODES, "success">;

export class WaitError extends Error {
  readonly exitCode: number;

  constructor(readonly kind: WaitFailureKind, message: string) {
    super(message);
    this.name = "WaitError";
    this.exitCode = WAIT_EXIT_CODES[kind];
  }
}

type WaitSessionDeps = {
  load?: (name: string) => Promise<SessionRecord | null>;
  livenessFailure?: (record: SessionRecord) => Promise<string | null>;
};

export type WaitForIdleOptions = {
  record: SessionRecord;
  idleMs: number;
  timeoutMs: number;
  pollMs: number;
  output: "pane" | "last" | "transcript";
  rows: number;
  json: boolean;
  /** Substrate override (used by tests); defaults to substrateFor(record). */
  substrate?: Pick<Substrate, "capture" | "hasSession">;
  sessionDeps?: WaitSessionDeps;
};

export type WaitForIdleResult = {
  /**
   * "idle"    — the bee settled and the requested output was printed.
   * "blocked" — the pane settled on a permission/approval prompt; output was
   *             still printed, but the bee is stalled waiting for a human
   *             decision (do not treat the turn as completed, e.g. before
   *             killing the bee).
   */
  state: "idle" | "blocked";
};

export async function waitForIdle(options: WaitForIdleOptions): Promise<WaitForIdleResult> {
  let { record } = options;
  const { idleMs, timeoutMs, pollMs } = options;
  const started = Date.now();
  let lastFingerprint = "";
  let stableSince = Date.now();
  let lastPane = "";
  let lastTxPath: string | undefined;

  const substrate = options.substrate ?? substrateFor(record);
  const sessionDeps: WaitSessionDeps = {
    ...options.sessionDeps,
    livenessFailure: options.sessionDeps?.livenessFailure ?? ((candidate) => sessionLivenessFailure(candidate, { substrate })),
  };
  while (Date.now() - started < timeoutMs) {
    const refreshed = await refreshWaitSession(record, sessionDeps);
    if (!refreshed) {
      await sleep(Math.max(100, pollMs));
      continue;
    }
    record = refreshed;
    const captured = await substrate.capture(record.tmuxTarget, 200, record.agentPaneId).catch(() => null);
    const pane = captured ?? "";
    const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record)).catch(() => null);
    const assistant = tx ? lastAssistantText(tx.rows) : "";
    const fingerprint = hashParts([pane, tx?.path ?? "", String(tx?.mtimeMs ?? 0), assistant]);

    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      stableSince = Date.now();
      lastPane = pane;
      lastTxPath = tx?.path;
      if (tx) record = await persistSessionTranscriptMetadata(record, tx, { markRunning: true });
    } else if (Date.now() - stableSince >= idleMs) {
      // A stable pane that is sitting on a permission/approval prompt is not
      // "done" — the bee is blocked waiting for a human. Surface that clearly
      // instead of letting the caller read the stall as a completed turn.
      const blocked = isPermissionPromptPane(lastPane);
      if (!blocked && isWaitingForRequestedTranscript(record, options, tx, assistant)) {
        await sleep(Math.max(100, pollMs));
        continue;
      }
      if (blocked) {
        const hint = `${record.name} is waiting for permission — approve it with: hive attach ${record.name}`;
        console.error(isPretty(process.stderr) ? dim(`⚠ ${hint}`) : `warn\tpermission\t${record.name}`);
      }
      if (options.output === "last" && tx) {
        const text = lastAssistantText(tx.rows);
        if (text) console.log(text);
      } else if (options.output === "transcript" && tx) {
        console.error(transcriptBanner(tx.provider, tx.path));
        console.log(renderTranscript(tx.rows, { limit: options.rows || undefined, json: options.json }));
      } else {
        console.log(lastPane);
      }
      await appendLedger({ type: "session.wait", session: record.name, agent: record.agent, cwd: record.cwd, idleMs, timeoutMs, transcriptPath: lastTxPath });
      // blocked = stalled on a human decision (waiting); idle = turn finished (done).
      await writeHiveState(record, blocked ? "waiting" : "done");
      return { state: blocked ? "blocked" : "idle" };
    }

    await sleep(Math.max(100, pollMs));
  }

  throw waitTimeout(`Timed out waiting for idle session after ${timeoutMs}ms: ${record.name}`);
}

export type WaitForSealOptions = {
  record: SessionRecord;
  timeoutMs: number;
  pollMs: number;
  sessionDeps?: WaitSessionDeps;
  list?: (session: string) => Promise<SealRecord[]>;
  latest?: (session: string) => Promise<SealRecord | null>;
};

export async function waitForSeal(options: WaitForSealOptions): Promise<void> {
  let { record } = options;
  const { timeoutMs, pollMs } = options;
  const list = options.list ?? listSeals;
  const latestSeal = options.latest ?? loadLatestSeal;
  const baseline = (await list(record.name))[0]?.sealedAt;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const latest = await latestSeal(record.name);
    if (latest && latest.sealedAt !== baseline) {
      console.log(JSON.stringify(latest, null, 2));
      return;
    }
    const refreshed = await refreshWaitSession(record, options.sessionDeps);
    if (refreshed) record = refreshed;
    await sleep(Math.max(100, pollMs));
  }
  throw waitTimeout(`Timed out waiting for seal on ${record.name} after ${timeoutMs}ms`);
}

export function waitHelpText(): string {
  return `Usage
  hive wait <session> [--idle-ms 3000] [--timeout-ms 600000] [--poll-ms 750]
    [--last|--transcript|--seal] [--json] [-n <rows-or-lines>]

  --poll-ms defaults to 1000 with --seal.

Exit codes
  0  Success: requested idle output or a new seal was printed
  1  Terminal/hopeless session state (also used for a blocked permission prompt)
  2  Timeout elapsed before success`;
}

async function refreshWaitSession(record: SessionRecord, deps: WaitSessionDeps = {}): Promise<SessionRecord | null> {
  const fresh = await (deps.load ?? loadSession)(record.name);
  if (!fresh) throw waitTerminal(record.name, "deleted");

  const terminal = recordedWaitTerminalState(fresh);
  if (terminal) throw waitTerminal(record.name, terminal);

  let failure: string | null;
  try {
    failure = await (deps.livenessFailure ?? sessionLivenessFailure)(fresh);
  } catch {
    // Transport failure is not proof that a remote runtime died. Do not let an
    // unknown probe produce false idle; retry until liveness returns or timeout.
    return null;
  }
  if (failure) throw waitTerminal(record.name, "crashed", failure);
  return fresh;
}

function recordedWaitTerminalState(record: SessionRecord): string | null {
  if (record.status === "archived") return "archived";
  if (record.status === "dead") return "killed";
  if (record.status === "kill_failed") return "kill_failed";
  switch (record.lastObservedState) {
    case "crashed":
    case "error":
    case "kill_failed":
      return record.lastObservedState;
    case "dead":
    case "killed":
      return "killed";
    case "archived":
    case "retired":
      return "archived";
    default:
      return null;
  }
}

function waitTerminal(session: string, state: string, detail?: string): WaitError {
  return new WaitError("terminal", `Wait failed for ${session}: terminal state ${state}${detail ? ` (${detail})` : ""}`);
}

function waitTimeout(message: string): WaitError {
  return new WaitError("timeout", message);
}

function isWaitingForRequestedTranscript(
  record: SessionRecord,
  options: WaitForIdleOptions,
  tx: Awaited<ReturnType<typeof latestTranscript>>,
  assistant: string,
): boolean {
  if (options.output === "pane" || !hasTranscriptProvider(record.agent)) return false;
  // Preserve historical pane fallback for unprompted/manual waits that have no
  // transcript anchor. Prompted runs should not report a stable ready screen as
  // success while the provider is still writing its transcript.
  if (!record.lastPrompt && !record.transcriptPath && !record.providerSessionId) return false;
  if (!tx) return true;
  return options.output === "last" && assistant.trim().length === 0;
}

function hashParts(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transcriptBanner(provider: string, path: string): string {
  if (!isPretty(process.stderr)) return `# ${provider} transcript: ${path}`;
  return `${dim("─")} ${cyan(provider)} ${dim(tildify(path))}`;
}
