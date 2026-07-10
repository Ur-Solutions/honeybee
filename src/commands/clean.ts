// `hive clean` — remove dead metadata, kill idle bees, or clean interactively.
// Extracted from cli.ts (HIVE-15).
import { deadSessionAge, deadSessionRecords, idleAgeSource, idleOlderThanMillis, idleSessionAge, olderThanMillis } from "../clean.js";
import { chooseCleanTargets, type CleanTuiCleanOutcome, type CleanTuiItem } from "../cleanTui.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, isPretty, note, tildify, truncate } from "../format.js";
import { highlightUniqueSessionReference } from "../ids.js";
import { transactionalKill } from "../kill.js";
import { LOCAL_NODE_NAME, listNodes } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { transcriptLookupForSession } from "../sessionMetadata.js";
import { cleanStatePriority, deriveState, isTerminalState, liveTargetKey, type BeeState, type DerivedState } from "../state.js";
import { deleteSession, listSessions, safeName, type SessionRecord } from "../store.js";
import { localSubstrate, substrateFor } from "../substrates/index.js";
import { tmux } from "../tmux.js";
import { latestTranscript, renderTranscript } from "../transcripts.js";
import { rm, writeFile } from "node:fs/promises";
import { ageFlag, buildStateContext, hasFlag, liveTargetsAcrossNodes, observeHsrLiveness } from "../cli/shared.js";

export async function cmdClean(parsed: Parsed) {
  const interactive = hasFlag(parsed, "interactive") || hasFlag(parsed, "i");
  const wantsDead = hasFlag(parsed, "dead");
  const wantsIdle = hasFlag(parsed, "idle");

  if (interactive) {
    if (wantsDead || wantsIdle) {
      throw new Error("hive clean -i/--interactive cannot be combined with --dead/--idle; pick targets in the TUI instead.");
    }
    if (hasFlag(parsed, "dry-run") || hasFlag(parsed, "n") || hasFlag(parsed, "older-than") || hasFlag(parsed, "older")) {
      throw new Error("hive clean -i/--interactive does not support --dry-run/--older-than; pick targets in the TUI instead.");
    }
    return cmdCleanInteractive(parsed);
  }
  if (wantsDead && wantsIdle) throw new Error("Choose either hive clean --dead or hive clean --idle, not both.");
  if (wantsIdle) return cmdCleanIdle(parsed);
  if (wantsDead) return cmdCleanDead(parsed);
  throw new Error("Usage: hive clean (--dead|--idle|-i|--interactive) [--older-than <age>] [--dry-run|-n]");
}


export async function cmdCleanDead(parsed: Parsed) {
  const [allRecords, nodes] = await Promise.all([listSessions(), listNodes()]);
  // A filed (archived) bee is filed, not dead — `clean` must never reap it (PRD
  // §13); only an explicit `hive kill` deletes a filed bee. Exclude it at the
  // source so neither the dead-sweep nor the pane-dead loop below can touch it.
  const records = allRecords.filter((r) => r.status !== "archived");
  const probe = await liveTargetsAcrossNodes(nodes);
  // Records on an unreachable node are NOT dead — we genuinely don't know their state.
  // Treat them as live so we don't sweep their metadata while their node is down.
  // The same goes for records whose node is no longer registered: it was never
  // probed, so we cannot tell whether the remote session is still running.
  const knownNodes = new Set(nodes.map((node) => node.name));
  const unknownNodes = new Set<string>();
  const recordsConsideredAlive = new Set(probe.liveTargets);
  for (const record of records) {
    const nodeName = record.node ?? LOCAL_NODE_NAME;
    if (!knownNodes.has(nodeName)) {
      unknownNodes.add(nodeName);
      recordsConsideredAlive.add(liveTargetKey(record.node, record.tmuxTarget));
      continue;
    }
    if (probe.unreachableNodes.has(nodeName)) {
      recordsConsideredAlive.add(liveTargetKey(record.node, record.tmuxTarget));
    }
  }
  if (unknownNodes.size > 0) {
    const skipped = [...unknownNodes].join(", ");
    if (isPretty()) console.error(note(`skipping bees on unregistered node(s): ${skipped} (re-register or kill them explicitly)`));
    else console.error(`# skipping bees on unregistered node(s): ${skipped}`);
  }
  // HSR bees are pane-less: they have no live tmux target, and listNodes() always
  // includes the local node so they get no unreachable-node protection either.
  // Without this, deadSessionRecords reports every running HSR bee as dead and
  // reaps its record while the runner host keeps executing — data loss (HIVE-1).
  // Protect any bee the run-dir HSR observer reports live, keyed the same way as
  // the tmux liveTargets set (an HSR record's tmuxTarget is its unique bee name).
  const { hsrLive } = await observeHsrLiveness();
  for (const record of records) {
    if (hsrLive.has(record.name)) recordsConsideredAlive.add(liveTargetKey(record.node, record.tmuxTarget));
  }
  let dead = deadSessionRecords(records, recordsConsideredAlive);
  // Phase B: a local sub-bee whose pane died (agentPaneId ∉ live panes) is dead
  // even though its comb/session survives via a sibling pane. Mirror
  // deriveState's pane-pinned liveness so `hive clean --dead` sweeps it too.
  // Guard against a transient empty listPanes() (server hiccup): only sweep
  // panes when at least one pane responded — an empty set can't be trusted to
  // mean "all panes dead" while sessions are live.
  const livePanes = await localSubstrate().listPanes().catch(() => new Set<string>());
  if (livePanes.size > 0) {
    const deadNames = new Set(dead.map((record) => record.name));
    for (const record of records) {
      if (deadNames.has(record.name)) continue;
      const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
      // Only a bee whose comb is otherwise considered alive can be "pane-dead";
      // if its session is gone it is already in `dead`.
      const sessionLive = recordsConsideredAlive.has(liveTargetKey(record.node, record.tmuxTarget));
      if (isLocal && sessionLive && record.agentPaneId && !livePanes.has(record.agentPaneId)) {
        dead.push(record);
        deadNames.add(record.name);
      }
    }
  }
  const olderThan = ageFlag(parsed, ["older-than", "older"]);
  if (olderThan !== undefined) dead = olderThanMillis(dead, olderThan);
  const dryRun = truthy(flag(parsed, "dry-run")) || truthy(flag(parsed, "n"));

  if (dead.length === 0) {
    if (isPretty()) console.log(dim("No dead bees to clean."));
    else console.log("cleaned\t0");
    return;
  }

  if (dryRun) {
    if (!isPretty()) {
      for (const record of dead) console.log(`dead\t${record.id ?? record.name}\t${record.name}\t${record.agent}\t${deadSessionAge(record)}\t${record.cwd}`);
      return;
    }
    console.log(formatTable(
      [
        { header: "REF" },
        { header: "NAME" },
        { header: "BEE" },
        { header: "AGE", align: "right" },
        { header: "CWD" },
      ],
      dead.map((record) => [
        truncate(highlightUniqueSessionReference(records, record), 16),
        truncate(record.name, 22),
        truncate(record.agent, 12),
        dim(deadSessionAge(record)),
        dim(truncate(tildify(record.cwd), Math.max(20, Math.min(60, (process.stdout.columns ?? 100) - 68)))),
      ]),
    ));
    console.error(note("dry run; remove these with: hive clean --dead"));
    return;
  }

  for (const record of dead) {
    await deleteSession(record.name);
    if (isPretty()) console.log(actionLine("ok", "clean", [bold(record.name), record.agent, dim(tildify(record.cwd))]));
    else console.log(`cleaned\t${record.name}`);
  }
}


export async function cmdCleanIdle(parsed: Parsed) {
  const { candidates } = await collectCleanCandidates();
  let idle = candidates.filter((candidate) => candidate.state === "idle_with_output" && candidate.mode === "kill");
  const olderThan = ageFlag(parsed, ["older-than", "older"]);
  if (olderThan !== undefined) {
    const oldEnough = new Set(idleOlderThanMillis(idle.map((candidate) => candidate.record), olderThan).map((record) => record.name));
    idle = idle.filter((candidate) => oldEnough.has(candidate.record.name));
  }
  const dryRun = truthy(flag(parsed, "dry-run")) || truthy(flag(parsed, "n"));

  if (idle.length === 0) {
    if (isPretty()) console.log(dim("No idle bees to clean."));
    else console.log("cleaned\t0");
    return;
  }

  if (dryRun) {
    printIdleDryRun(idle);
    return;
  }

  await cleanCandidates(idle);
}


export async function cmdCleanInteractive(_parsed: Parsed) {
  const { candidates } = await collectCleanCandidates();
  if (candidates.length === 0) {
    console.log(dim("No bees in the hive. Nothing to clean."));
    return;
  }
  const candidateByName = new Map(candidates.map((candidate) => [candidate.record.name, candidate] as const));
  const result = await chooseCleanTargets(candidates.map(cleanTuiItem), {
    loadPreview: async (item) => {
      const candidate = candidateByName.get(item.name);
      if (!candidate) return "No matching bee record found.";
      return cleanPreview(candidate.record);
    },
    clean: async (items) => {
      const targets = items.flatMap((item) => {
        const candidate = candidateByName.get(item.name);
        return candidate && candidate.mode !== "disabled" ? [candidate] : [];
      });
      const outcomes = await cleanCandidatesForTui(targets);
      for (const outcome of outcomes) {
        if (!outcome.ok) continue;
        candidateByName.delete(outcome.name);
      }
      return outcomes;
    },
  });
  if (result.failed > 0) process.exitCode = 1;
}


export async function cleanPreview(
  record: SessionRecord,
  opts: { transcriptRows?: number; paneLines?: number } = {},
): Promise<string> {
  const transcriptRows = opts.transcriptRows ?? 8;
  const paneLines = opts.paneLines ?? 80;
  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record)).catch(() => null);
  if (tx) {
    const rendered = renderTranscript(tx.rows, { limit: transcriptRows }).trim();
    if (rendered) return [`transcript ${tx.provider} ${tildify(tx.path)}`, "", rendered].join("\n");
  }

  try {
    if (await substrateFor(record).hasSession(record.tmuxTarget)) {
      const pane = await substrateFor(record).capture(record.tmuxTarget, paneLines, record.agentPaneId);
      if (pane.trim()) return [`pane tail ${record.tmuxTarget}`, "", pane.trimEnd()].join("\n");
    }
  } catch {
    // Fall through to the metadata fallback; preview should not make selection brittle.
  }

  if (record.lastPrompt) return ["last prompt", "", record.lastPrompt].join("\n");
  if (record.brief) return ["brief", "", record.brief].join("\n");
  return "No transcript or pane tail available.";
}


/**
 * Preview text for the popup: prefer the bee's actual *rendered* pane (colors
 * intact) so the operator sees the live agent UI — not just the transcript log.
 * Falls back to the transcript / pane tail for dead or remote bees.
 */
export async function renderedBeeView(record: SessionRecord): Promise<string> {
  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  if (isLocal && process.env.TMUX) {
    try {
      if (await localSubstrate().hasSession(record.tmuxTarget)) {
        // -e keeps SGR colors; capturing the visible screen reproduces the
        // agent's current rendered frame (its TUI), not the scrollback log.
        const paneTarget = record.agentPaneId ?? `=${record.tmuxTarget}`;
        const captured = await tmux(["capture-pane", "-e", "-p", "-t", paneTarget], { reject: false });
        const view = captured.ok ? captured.stdout.replace(/\s+$/, "") : "";
        if (view.trim()) return view;
      }
    } catch {
      // fall through to the transcript preview
    }
  }
  return cleanPreview(record, { transcriptRows: 80, paneLines: 200 });
}


/**
 * Open a bee's preview in a large, scrollable tmux popup — far more readable
 * than an inline strip in the narrow sidebar. Blocks until the operator quits
 * the pager; falls back to a plain print outside tmux.
 */
export async function openBeePreviewPopup(record: SessionRecord): Promise<void> {
  const text = await renderedBeeView(record);
  if (!process.env.TMUX) {
    console.log(text);
    return;
  }
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(os.tmpdir(), `hive-preview-${safeName(record.name)}.txt`);
  const header = `${record.name}  ${record.agent}  ${tildify(record.cwd)}`;
  await writeFile(file, `${header}\n\n${text}\n`, "utf8");
  const quoted = `'${file.replaceAll("'", `'\\''`)}'`;
  try {
    // -R keeps the transcript's ANSI colors; q in less closes the popup.
    await tmux(["display-popup", "-E", "-w", "85%", "-h", "85%", `less -R -- ${quoted}`], { reject: false });
  } finally {
    await rm(file, { force: true });
  }
}


export type CleanMode = "delete" | "kill" | "disabled";


export type CleanCandidate = CleanTuiItem & {
  record: SessionRecord;
  mode: CleanMode;
  ageMs: number;
};


export async function collectCleanCandidates(): Promise<{ records: SessionRecord[]; candidates: CleanCandidate[] }> {
  const [allRecords, nodes] = await Promise.all([listSessions(), listNodes()]);
  // A filed (archived) bee derives to the "archived" terminal state but must NOT
  // be offered as an idle/dead clean candidate (PRD §13) — exclude it up front so
  // `clean --idle`/interactive never lists it.
  const records = allRecords.filter((r) => r.status !== "archived");
  const probe = await liveTargetsAcrossNodes(nodes);
  // A record whose node is no longer registered was never probed; treat it as
  // unreachable (not dead) so clean paths refuse to sweep a possibly-live bee.
  const knownNodes = new Set(nodes.map((node) => node.name));
  const unreachableNodes = new Set(probe.unreachableNodes);
  for (const record of records) {
    const nodeName = record.node ?? LOCAL_NODE_NAME;
    if (!knownNodes.has(nodeName)) unreachableNodes.add(nodeName);
  }
  const context = await buildStateContext(records, probe, { unreachableNodes });
  const candidates = records.map((record) => cleanCandidateFor(record, records, deriveState(record, context), probe.liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)) || context.hsrLive.has(record.name), context.now));
  candidates.sort(compareCleanCandidates);
  return { records, candidates };
}


export function cleanCandidateFor(record: SessionRecord, records: SessionRecord[], derived: DerivedState, live: boolean, now: number): CleanCandidate {
  const disabledReason = cleanDisabledReason(derived.state);
  const mode: CleanMode = disabledReason ? "disabled" : live ? "kill" : "delete";
  const ageSource = cleanCandidateAgeSource(record, derived.state);
  const ageTs = Date.parse(ageSource);
  const ageMs = Number.isFinite(ageTs) ? Math.max(0, now - ageTs) : 0;
  return {
    record,
    mode,
    ageMs,
    name: record.name,
    ref: highlightUniqueSessionReference(records, record),
    agent: record.agent,
    state: derived.state,
    detail: derived.detail,
    age: cleanCandidateAge(record, derived.state, now),
    cwd: record.cwd,
    ...(disabledReason ? { disabledReason } : {}),
  };
}


export function cleanDisabledReason(state: BeeState): string | undefined {
  switch (state) {
    case "active":
      return "active";
    case "queued":
      return "queued";
    case "booting":
      return "booting";
    case "node_unreachable":
      return "offline";
    default:
      return undefined;
  }
}


export function cleanCandidateAge(record: SessionRecord, state: BeeState, now: number): string {
  return formatRelativeTime(cleanCandidateAgeSource(record, state), now);
}


export function cleanCandidateAgeSource(record: SessionRecord, state: BeeState): string {
  if (state === "idle_with_output") return idleAgeSource(record);
  if (isTerminalState(state)) return record.updatedAt;
  return record.createdAt;
}


export function cleanTuiItem(candidate: CleanCandidate): CleanTuiItem {
  const { name, ref, agent, state, detail, age, cwd, disabledReason } = candidate;
  return { name, ref, agent, state, detail, age, cwd, ...(disabledReason ? { disabledReason } : {}) };
}


export function printIdleDryRun(idle: CleanCandidate[]) {
  if (!isPretty()) {
    for (const candidate of idle) {
      const record = candidate.record;
      console.log(`idle\t${record.id ?? record.name}\t${record.name}\t${record.agent}\t${idleSessionAge(record)}\t${record.cwd}`);
    }
    return;
  }
  console.log(formatTable(
    [
      { header: "REF" },
      { header: "NAME" },
      { header: "BEE" },
      { header: "IDLE", align: "right" },
      { header: "CWD" },
      { header: "LAST PROMPT" },
    ],
    idle.map((candidate) => {
      const record = candidate.record;
      return [
        truncate(candidate.ref, 16),
        truncate(record.name, 22),
        truncate(record.agent, 12),
        dim(idleSessionAge(record)),
        dim(truncate(tildify(record.cwd), Math.max(20, Math.min(50, (process.stdout.columns ?? 100) - 86)))),
        dim(truncate(record.lastPrompt?.split("\n")[0] ?? "", Math.max(20, Math.min(60, (process.stdout.columns ?? 100) - 90)))),
      ];
    }),
  ));
  console.error(note("dry run; remove these with: hive clean --idle"));
}


export async function cleanCandidates(candidates: CleanCandidate[]): Promise<void> {
  let failed = 0;
  for (const candidate of candidates) {
    if (candidate.mode === "disabled") continue;
    const outcome = await cleanCandidate(candidate);
    if (!outcome.ok) {
      failed += 1;
      if (isPretty()) {
        console.log(actionLine("warn", "clean", [bold(candidate.record.name), dim(outcome.detail)]));
        console.error(note(`bee may still be running; retry: hive kill ${candidate.record.name}`));
      } else {
        console.log(`clean_failed\t${candidate.record.name}\t${outcome.detail}`);
      }
      continue;
    }
    printCleanSuccess(candidate.record, outcome.detail);
  }
  if (failed > 0) process.exitCode = 1;
}


export async function cleanCandidatesForTui(candidates: CleanCandidate[]): Promise<CleanTuiCleanOutcome[]> {
  const outcomes: CleanTuiCleanOutcome[] = [];
  for (const candidate of candidates) {
    try {
      outcomes.push(await cleanCandidate(candidate));
    } catch (error) {
      outcomes.push({
        name: candidate.record.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}


export async function cleanCandidate(candidate: CleanCandidate): Promise<CleanTuiCleanOutcome> {
  const record = candidate.record;
  if (candidate.mode === "delete") {
    await deleteSession(record.name);
    return { name: record.name, ok: true, detail: "removed stale" };
  }
  const outcome = await transactionalKill(record);
  if (!outcome.ok) return { name: record.name, ok: false, detail: outcome.lastError };
  return { name: record.name, ok: true, detail: outcome.alreadyGone ? "gone" : "killed" };
}


export function printCleanSuccess(record: SessionRecord, detail: string) {
  if (isPretty()) console.log(actionLine("ok", "clean", [bold(record.name), record.agent, dim(detail), dim(tildify(record.cwd))]));
  else console.log(`cleaned\t${record.name}`);
}


export function compareCleanCandidates(a: CleanCandidate, b: CleanCandidate): number {
  const age = b.ageMs - a.ageMs;
  if (age !== 0) return age;
  const priority = cleanStatePriority(a.state) - cleanStatePriority(b.state);
  if (priority !== 0) return priority;
  return a.record.name.localeCompare(b.record.name);
}
