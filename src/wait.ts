import { createHash } from "node:crypto";
import { cyan, dim, isPretty, tildify } from "./format.js";
import { isPermissionPromptPane } from "./readiness.js";
import { persistSessionTranscriptMetadata, transcriptLookupForSession } from "./sessionMetadata.js";
import { appendLedger, type SessionRecord } from "./store.js";
import { substrateFor, type Substrate } from "./substrates/index.js";
import { lastAssistantText, latestTranscript, renderTranscript } from "./transcripts.js";

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
  while (Date.now() - started < timeoutMs) {
    const captured = await substrate.capture(record.tmuxTarget, 200).catch(() => null);
    if (captured === null || captured === "") {
      // A failed/empty capture is indistinguishable from a dead session: an
      // empty pane plus an unchanged transcript would read as "stable" and
      // the wait would succeed with empty output. Verify the session lives.
      const alive = await substrate.hasSession(record.tmuxTarget).catch(() => false);
      if (!alive) throw new Error(`Session died while waiting for idle: ${record.name}`);
    }
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
      return { state: blocked ? "blocked" : "idle" };
    }

    await sleep(Math.max(100, pollMs));
  }

  throw new Error(`Timed out waiting for idle session after ${timeoutMs}ms: ${record.name}`);
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
