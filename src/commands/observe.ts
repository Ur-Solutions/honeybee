// Observe/manage bees you can see: list/bees/tail/transcript/last/wait/kill/
// urls/view/attach/next.
// Extracted from cli.ts (HIVE-15).
import { tmuxOptionsForAgent } from "../agents.js";
import { attachBeeWithSidebar, readBeesGroupMode, resolveCurrentSidebarBeeName, showBeeBesideSidebar, syncBeesSidebarLayout, toggleBeesSidebar, writeBeesGroupMode } from "../beesSidebar.js";
import { beesTuiSearchText, runBeesTui, type BeesTuiItem } from "../beesTui.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, isPretty, note, tildify, truncate } from "../format.js";
import { effectiveHiveState, hiveStateFor } from "../hiveState.js";
import { highlightUniqueSessionReference } from "../ids.js";
import { extractUrls } from "../keybindings.js";
import { transactionalKill } from "../kill.js";
import { sessionDisplayName, shouldShowNodeColumn } from "../listView.js";
import { DEFAULT_ATTENTION_STATES, attentionCount, parseStateList, pickNextBee, type BeeStateEntry } from "../next.js";
import { LOCAL_NODE_NAME, listNodes, loadNode } from "../node.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { listProRepoEntries, resolveProSlotForCwd, type ProRepoEntry, type ProSlotKind } from "../proProjects.js";
import { repoTagFor } from "../repoTag.js";
import { listSeals, loadLatestSeal } from "../seal.js";
import { resolveSelector } from "../selectors.js";
import { persistSessionTranscriptMetadata, transcriptLookupForSession } from "../sessionMetadata.js";
import { deriveState, formatStateCell, isTerminalState, liveTargetKey, stateLabel, type DerivedState } from "../state.js";
import { listSessions, loadSession, type SessionRecord } from "../store.js";
import { localSubstrate, substrateFor } from "../substrates/index.js";
import { effectiveTags, normalizeTagArg } from "../tags.js";
import { appendedPaneText, parseTailOptions } from "../tail.js";
import { formatShellCommand } from "../tmux.js";
import { hasTranscriptProvider, lastAssistantText, latestTranscript, renderTranscript } from "../transcripts.js";
import { waitForIdle } from "../wait.js";
import { resolve } from "node:path";
import { arrayFlag, assertLocalFleetReadable, buildStateContext, currentTmuxSession, ensureLive, formatHiveStateCell, liveTargetsAcrossNodes, resolveBeeInCurrentPane, resolveSession, sleep, stringFlag, transcriptBanner } from "../cli/shared.js";
import { openBeePreviewPopup } from "../commands/clean.js";

export async function cmdTail(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive tail <session> [-n lines] [-f|--follow] [--poll-ms 1000]");
  const record = await resolveSession(target);
  await ensureLive(record);
  const options = parseTailOptions(parsed);
  if (options.follow) {
    await followTail(record, options.lines, options.pollMs);
    return;
  }
  console.log(await substrateFor(record).capture(record.tmuxTarget, options.lines, record.agentPaneId));
}


export async function followTail(record: SessionRecord, lines: number, pollMs: number): Promise<void> {
  let previous = "";
  while (true) {
    await ensureLive(record);
    const next = await substrateFor(record).capture(record.tmuxTarget, lines, record.agentPaneId);
    const delta = appendedPaneText(previous, next);
    if (delta) {
      if (previous && !next.startsWith(previous)) process.stdout.write("\n");
      process.stdout.write(delta.endsWith("\n") ? delta : `${delta}\n`);
    }
    previous = next;
    await sleep(Math.max(100, pollMs));
  }
}


export async function cmdList(parsed: Parsed) {
  const [allRecords, nodes] = await Promise.all([listSessions(), listNodes()]);

  const colonyFilter = typeof flag(parsed, "colony") === "string" ? String(flag(parsed, "colony")) : undefined;
  const swarmFilter = typeof flag(parsed, "swarm") === "string" ? String(flag(parsed, "swarm")).replace(/^@/, "") : undefined;
  const nodeFilter = typeof flag(parsed, "node") === "string" ? String(flag(parsed, "node")) : undefined;
  const stateFilter = stringFlag(parsed, ["state"]);
  const agentFilter = stringFlag(parsed, ["agent"]);
  const repoFilter = stringFlag(parsed, ["repo"]);
  const tagFilters = arrayFlag(parsed, "tag");
  const jsonOut = truthy(flag(parsed, "json"));
  const positionalSel = parsed.args[0];
  if (nodeFilter) {
    const node = await loadNode(nodeFilter);
    if (!node) throw new Error(`Unknown node: ${nodeFilter}. Register it with: hive node register ${nodeFilter} --kind ssh-tmux --endpoint user@host`);
  }
  const probe = await liveTargetsAcrossNodes(nodes, nodeFilter);
  let records = allRecords;
  // Filed (archived) bees are hidden from the default list — re-include them
  // with --archived, and auto-include when the user targets them explicitly
  // with `--state archived` so that query is never empty.
  const showArchived = truthy(flag(parsed, "archived")) || stateFilter === "archived";
  if (!showArchived) records = records.filter((r) => r.status !== "archived");
  if (colonyFilter) records = records.filter((r) => r.colony === colonyFilter);
  if (swarmFilter) records = records.filter((r) => r.swarmId === swarmFilter);
  if (nodeFilter) records = records.filter((r) => (r.node ?? LOCAL_NODE_NAME) === nodeFilter);
  if (agentFilter) records = records.filter((r) => r.agent === agentFilter);
  if (repoFilter) records = records.filter((r) => repoTagFor(r.cwd) === repoFilter);
  // --tag repeats conjunctively (AND): every filter (bare user tag or ns:val)
  // must be present in the bee's effective tag set (PRD §8.3, T4).
  if (tagFilters.length > 0) {
    records = records.filter((r) => {
      const tags = effectiveTags(r);
      return tagFilters.every((arg) => tags.has(normalizeTagArg(arg)));
    });
  }
  if (positionalSel) {
    // Let resolveSelector throw on a genuinely unknown colony/swarm, consistent
    // with the other commands; an empty colony/swarm just filters to nothing.
    const resolved = await resolveSelector(positionalSel);
    const names = new Set(resolved.kind === "bee" ? [resolved.record.name] : resolved.records.map((r) => r.name));
    records = records.filter((r) => names.has(r.name));
  }

  const context = await buildStateContext(records, probe);
  const states = new Map(records.map((record) => [record.name, deriveState(record, context)] as const));

  // Live @hive_state (set by hive itself and by agent hooks) wins over the
  // store-derived state — the tmux server is the source of truth for live bees.
  const liveHiveState = (record: SessionRecord): string | undefined => {
    const state = probe.states.get(liveTargetKey(record.node, record.tmuxTarget));
    return effectiveHiveState(state, states.get(record.name)?.state);
  };

  // --state matches the live @hive_state, the coarse hive mapping of the derived
  // BeeState, the BeeState itself, or its display label — so `--state waiting`,
  // `--state idle_with_output`, and `--state idle` all resolve.
  if (stateFilter) {
    records = records.filter((r) => {
      const beeState = states.get(r.name)!.state;
      return (
        (liveHiveState(r) ?? hiveStateFor(beeState)) === stateFilter ||
        beeState === stateFilter ||
        stateLabel(beeState) === stateFilter
      );
    });
  }

  if (jsonOut) {
    console.log(
      JSON.stringify(
        records.map((r) => ({
          ref: highlightUniqueSessionReference(records, r, { start: "", end: "" }),
          name: r.name,
          id: r.id,
          title: r.title,
          agent: r.agent,
          state: liveHiveState(r) ?? states.get(r.name)!.state,
          beeState: states.get(r.name)!.state,
          detail: states.get(r.name)!.detail,
          colony: r.colony,
          swarm: r.swarmId,
          comb: r.combId,
          node: r.node ?? LOCAL_NODE_NAME,
          repo: repoTagFor(r.cwd),
          cwd: r.cwd,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (!isPretty()) {
    const marker = { start: "", end: "" };
    for (const record of records) {
      const derived = states.get(record.name)!;
      const ref = highlightUniqueSessionReference(records, record, marker);
      console.log(`${liveHiveState(record) ?? derived.state}\t${ref}\t${sessionDisplayName(record, { collapseDefaultId: false })}\t${record.agent}\t${record.cwd}\t${record.command}`);
    }
    if (probe.unreachableNodes.size > 0) {
      console.error(`# ${probe.unreachableNodes.size} node(s) unreachable: ${[...probe.unreachableNodes].join(", ")}`);
    }
    return;
  }

  if (records.length === 0) {
    const filters = [
      positionalSel ? positionalSel : undefined,
      colonyFilter ? `colony:${colonyFilter}` : undefined,
      swarmFilter ? `@${swarmFilter}` : undefined,
      nodeFilter ? `node:${nodeFilter}` : undefined,
      stateFilter ? `state:${stateFilter}` : undefined,
      agentFilter ? `agent:${agentFilter}` : undefined,
      repoFilter ? `repo:${repoFilter}` : undefined,
      ...tagFilters.map((t) => `tag:${t}`),
    ].filter((part): part is string => part !== undefined);
    if (filters.length > 0) console.log(dim(`No bees match ${filters.join(" ")}`));
    else console.log(dim("No bees in the hive. Spawn one with: hive spawn <bee>"));
    return;
  }

  const terminalWidth = process.stdout.columns ?? 100;
  const showNodeColumn = shouldShowNodeColumn(nodes, truthy(flag(parsed, "wide")));
  const cwdMax = Math.max(20, Math.min(60, terminalWidth - (showNodeColumn ? 90 : 78)));
  const now = Date.now();

  const rows = records.map((record) => {
    const derived = states.get(record.name)!;
    const ref = truncate(highlightUniqueSessionReference(records, record), 16);
    const displayName = sessionDisplayName(record);
    const name = displayName === "=" ? dim("=") : truncate(displayName, 22);
    const ageSource = isTerminalState(derived.state) ? record.updatedAt : record.createdAt;
    const ageText = formatRelativeTime(ageSource, now);
    const age = isTerminalState(derived.state) ? dim(ageText) : ageText;
    const nodeName = record.node ?? LOCAL_NODE_NAME;
    const live = liveHiveState(record);
    const base = [
      live ? formatHiveStateCell(live) : formatStateCell(derived.state),
      ref,
      name,
      truncate(record.agent, 12),
      dim(truncate(derived.detail, 30)),
      age,
      dim(truncate(tildify(record.cwd), cwdMax)),
    ];
    return showNodeColumn ? [...base.slice(0, 4), dim(truncate(nodeName, 12)), ...base.slice(4)] : base;
  });

  const columns = showNodeColumn
    ? [
        { header: "STATE" },
        { header: "REF" },
        { header: "NAME" },
        { header: "BEE" },
        { header: "NODE" },
        { header: "DETAIL" },
        { header: "AGE", align: "right" as const },
        { header: "CWD" },
      ]
    : [
        { header: "STATE" },
        { header: "REF" },
        { header: "NAME" },
        { header: "BEE" },
        { header: "DETAIL" },
        { header: "AGE", align: "right" as const },
        { header: "CWD" },
      ];

  console.log(formatTable(columns, rows));

  if (probe.unreachableNodes.size > 0) {
    console.error(note(`${probe.unreachableNodes.size} node(s) unreachable: ${[...probe.unreachableNodes].join(", ")}`));
  }
}


export async function cmdBees(parsed: Parsed): Promise<void> {
  if (truthy(flag(parsed, "toggle-sidebar"))) {
    const widthRaw = stringFlag(parsed, ["width", "w"]);
    const width = widthRaw !== undefined ? Number(widthRaw) : undefined;
    await toggleBeesSidebar(Number.isFinite(width) ? width : undefined);
    return;
  }

  const { items, records } = await loadBeesTuiItems(parsed);
  const sidebar = truthy(flag(parsed, "sidebar"));
  const groupMode = (await readBeesGroupMode()) ?? undefined;
  // The sidebar lives beside one bee's window: start on that bee and mark it, so
  // each window's fresh strip lands on its bee instead of resetting to the top.
  const currentName = sidebar ? await resolveCurrentSidebarBeeName(records) : undefined;

  await runBeesTui({
    items,
    sidebar,
    groupMode,
    ...(currentName ? { currentName } : {}),
    onGroupChange: async (mode) => {
      // Persist globally so every sidebar (and the next launch) shares the facet.
      await writeBeesGroupMode(mode);
    },
    // Sidebars live-update each other: poll the shared facet so cycling in one
    // strip re-groups the rest. Skipped for the standalone full-screen TUI.
    ...(sidebar ? { syncGroupMode: () => readBeesGroupMode() } : {}),
    // Live-refresh the catalog so renames/spawns/kills/state changes appear
    // without reopening. Reuses the same filters this invocation was launched
    // with; the TUI diffs and only redraws on real change.
    refreshItems: async () => (await loadBeesTuiItems(parsed)).items,
    onPreview: async (item) => {
      const record = await resolveSession(item.name).catch(() => undefined);
      if (!record) return;
      await openBeePreviewPopup(record);
    },
    onKill: async (item) => {
      const record = await resolveSession(item.name).catch(() => undefined);
      if (!record) return { ok: false, detail: "no matching bee record" };
      const outcome = await transactionalKill(record);
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.lastError };
    },
    onSelect: async (item) => {
      const record = await resolveSession(item.name);
      await ensureLive(record);
      if (sidebar) {
        await showBeeBesideSidebar(record);
        return;
      }
      if (!process.env.TMUX) {
        // Launched from a bare terminal: attach the bee's session with the
        // sidebar already materialized, so you land in the cockpit.
        await attachBeeWithSidebar(record);
        return;
      }
      const substrate = substrateFor(record);
      await applyBeeWindowOptions(record);
      await substrate.attachSession(record.tmuxTarget);
      await syncBeesSidebarLayout({ pruneOthers: true });
    },
  });
}


export async function loadBeesTuiItems(parsed: Parsed): Promise<{ items: BeesTuiItem[]; records: SessionRecord[] }> {
  const colonyFilter = typeof flag(parsed, "colony") === "string" ? String(flag(parsed, "colony")) : undefined;
  const swarmFilter = typeof flag(parsed, "swarm") === "string" ? String(flag(parsed, "swarm")) : undefined;
  const nodeFilter = typeof flag(parsed, "node") === "string" ? String(flag(parsed, "node")) : undefined;

  const allRecords = await listSessions();
  const nodes = await listNodes();
  if (nodeFilter && !nodes.some((node) => node.name === nodeFilter)) {
    throw new Error(`Unknown node: ${nodeFilter}. Register it with: hive node register ${nodeFilter} --kind ssh-tmux --endpoint user@host`);
  }
  const probe = await liveTargetsAcrossNodes(nodes, nodeFilter);
  let records = allRecords;
  if (colonyFilter) records = records.filter((record) => record.colony === colonyFilter);
  if (swarmFilter) records = records.filter((record) => record.swarmId === swarmFilter);
  if (nodeFilter) records = records.filter((record) => (record.node ?? LOCAL_NODE_NAME) === nodeFilter);

  const context = await buildStateContext(records, probe);

  // Resolve each bee's cwd to its pro area/project/repo once, so the TUI can
  // group by pro facets without shelling out. Best-effort: no pro CLI → no
  // facets (those grouping modes just bucket everything under "no pro …").
  const proEntries = await listProRepoEntries().catch(() => [] as ProRepoEntry[]);

  const now = Date.now();
  const items = records.map((record) => {
    const derived = deriveState(record, context);
    const live = derived.state !== "dead" && derived.state !== "sealed" && derived.state !== "node_unreachable";
    const liveHive = effectiveHiveState(probe.states.get(liveTargetKey(record.node, record.tmuxTarget)), derived.state);
    const stateHeadline = liveHive ? liveHive : stateLabel(derived.state);
    const displayName = sessionDisplayName(record);
    const ref = highlightUniqueSessionReference(records, record);
    const ageSource = isTerminalState(derived.state) ? record.updatedAt : record.createdAt;
    const detail = beeTuiDescription(record, derived);
    const pro = resolveProSlotForCwd(proEntries, record.cwd);
    return {
      name: record.name,
      ref,
      displayName: displayName === "=" ? record.name : displayName,
      colony: record.colony ?? "",
      swarmId: record.swarmId ?? "",
      agent: record.agent,
      cwd: record.cwd,
      stateLabel: derived.state,
      stateHeadline,
      detail,
      age: formatRelativeTime(ageSource, now),
      tmuxTarget: record.tmuxTarget,
      node: record.node,
      live,
      ...(pro
        ? {
            proArea: pro.area,
            proProject: pro.project,
            proRepo: pro.repo,
            ...(pro.slot ? { proSlotKind: pro.kind as ProSlotKind, proSlotName: pro.slot } : {}),
          }
        : {}),
      searchText: beesTuiSearchText({
        name: record.name,
        displayName: displayName === "=" ? record.name : displayName,
        colony: record.colony,
        swarmId: record.swarmId,
        agent: record.agent,
        cwd: record.cwd,
        detail,
        ref,
        slot: pro?.slot,
      }),
    };
  });
  return { items, records };
}


export function beeTuiDescription(record: SessionRecord, derived: DerivedState): string {
  const candidates = [
    record.notes,
    record.brief,
    record.lastPrompt,
    derived.detail,
    record.cwd,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeBeeTuiDescription(candidate);
    if (normalized) return normalized;
  }
  return record.agent;
}


export function normalizeBeeTuiDescription(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 400 ? `${normalized.slice(0, 400)}...` : normalized;
}


export async function cmdTranscript(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive transcript <session> [-n rows] [--json]");
  let record = await resolveSession(target);
  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record));
  if (!tx) throw new Error(`No transcript provider/file found for ${record.agent} session ${record.name}`);
  record = await persistSessionTranscriptMetadata(record, tx);
  const limitRaw = flag(parsed, "n") ?? flag(parsed, "limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const json = truthy(flag(parsed, "json"));
  console.error(transcriptBanner(tx.provider, tx.path));
  console.log(renderTranscript(tx.rows, { limit: Number.isFinite(limit) ? limit : undefined, json }));
}


export async function cmdLast(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive last <session> [--seal]");
  let record = await resolveSession(target);

  if (truthy(flag(parsed, "seal"))) {
    const seal = await loadLatestSeal(record.name);
    if (!seal) throw new Error(`No seal recorded for ${record.name}`);
    console.log(JSON.stringify(seal, null, 2));
    return;
  }

  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record));
  if (!tx && !hasTranscriptProvider(record.agent)) {
    await ensureLive(record);
    console.error(isPretty() ? note(`no transcript provider for ${record.agent}; falling back to pane capture`) : `# no transcript provider for ${record.agent}; falling back to pane capture`);
    console.log(await substrateFor(record).capture(record.tmuxTarget, numberFlag(parsed, ["n", "lines"], 120), record.agentPaneId));
    return;
  }
  if (!tx) throw new Error(`No transcript provider/file found for ${record.agent} session ${record.name}`);
  record = await persistSessionTranscriptMetadata(record, tx);
  const text = lastAssistantText(tx.rows);
  if (!text) throw new Error(`No assistant text found in transcript: ${tx.path}`);
  console.error(transcriptBanner(tx.provider, tx.path));
  console.log(text);
}


export async function cmdWait(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive wait <session> [--idle-ms 3000] [--timeout-ms 600000] [--last|--transcript|--seal]");
  const record = await resolveSession(target);

  if (truthy(flag(parsed, "seal"))) {
    return waitForSeal(record, parsed);
  }

  await ensureLive(record);
  const outcome = await waitForIdle({
    record,
    idleMs: numberFlag(parsed, ["idle-ms", "idle"], 3_000),
    timeoutMs: numberFlag(parsed, ["timeout-ms", "timeout"], 600_000),
    pollMs: numberFlag(parsed, ["poll-ms", "poll"], 750),
    output: truthy(flag(parsed, "last")) ? "last" : truthy(flag(parsed, "transcript")) ? "transcript" : "pane",
    rows: numberFlag(parsed, ["n", "limit"], 0),
    json: truthy(flag(parsed, "json")),
  });
  // A blocked bee did not finish its turn; exit non-zero so `hive wait && hive kill`
  // chains do not kill a bee that is stalled on an approval prompt.
  if (outcome.state === "blocked") process.exitCode = 1;
}


export async function waitForSeal(record: SessionRecord, parsed: Parsed): Promise<void> {
  const timeoutMs = numberFlag(parsed, ["timeout-ms", "timeout"], 600_000);
  const pollMs = numberFlag(parsed, ["poll-ms", "poll"], 1_000);
  const baseline = (await listSeals(record.name))[0]?.sealedAt;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const latest = await loadLatestSeal(record.name);
    if (latest && latest.sealedAt !== baseline) {
      console.log(JSON.stringify(latest, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, pollMs)));
  }
  throw new Error(`Timed out waiting for seal on ${record.name} after ${timeoutMs}ms`);
}


export async function cmdKill(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive kill <session>");
  const record = await resolveSession(target);

  // Combs are retired (APIA-85): every bee is solo (its own session/runner host),
  // so a kill always tears down the whole session via the transactional path.
  // The pane-pinned `agentPaneId` is kept for I/O targeting, not comb membership.
  const outcome = await transactionalKill(record);
  if (!outcome.ok) {
    if (isPretty()) {
      console.log(actionLine("warn", "kill_failed", [bold(record.name), dim(outcome.lastError)]));
      console.error(note(`bee may still be running; retry: hive kill ${record.name}`));
    } else {
      console.log(`kill_failed\t${record.name}\t${outcome.lastError}`);
    }
    process.exitCode = 1;
    return;
  }
  if (isPretty()) {
    console.log(actionLine(outcome.alreadyGone ? "warn" : "ok", outcome.alreadyGone ? "gone" : "kill", [bold(record.name)]));
  } else {
    console.log(`${outcome.alreadyGone ? "gone" : "killed"}\t${record.name}`);
  }
}

// hive urls [<bee>] [--lines <n>] [--open] [--json]
// Lists website URLs printed in a bee's pane. Side-effect-free unless --open.
export async function cmdUrls(parsed: Parsed): Promise<void> {
  const selector = parsed.args[0];
  let record: SessionRecord | undefined;
  if (selector) {
    // Explicit selector → grab from another bee. These read the LOCAL store, so
    // they must hard-error under an ssh-tmux default substrate (§13).
    assertLocalFleetReadable("urls");
    const resolved = await resolveSelector(selector);
    if (resolved.kind !== "bee") {
      throw new Error(`hive urls: ${selector} selects multiple bees; pass a single bee`);
    }
    record = resolved.record;
  } else {
    if (!process.env.TMUX && !process.env.HIVE_BEE) throw new Error("hive urls: not inside tmux/an HSR bee and no bee selector given");
    record = await resolveBeeInCurrentPane();
    if (!record) throw new Error("hive urls: no matching bee for the current pane/session");
  }

  const lines = numberFlag(parsed, ["lines"], 2000);
  const text = await substrateFor(record).capture(record.tmuxTarget, lines, record.agentPaneId);
  const urls = extractUrls(text);

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(urls));
    return;
  }
  if (urls.length === 0) {
    // dim stderr note so the popup closes cleanly; exit 0 (no URLs is not an error).
    console.error(dim("no URLs"));
    return;
  }
  if (truthy(flag(parsed, "open"))) {
    await openUrl(urls[0]!);
    return;
  }
  for (const url of urls) console.log(url);
}


/** Open a URL via the platform opener (open on darwin, xdg-open on linux). */
export async function openUrl(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolveOpen, rejectOpen) => {
    execFile(opener, [url], (error) => (error ? rejectOpen(error) : resolveOpen()));
  });
}


export async function cmdAttach(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive attach <session> [--print]");
  const record = await resolveSession(target);
  await ensureLive(record);
  const substrate = substrateFor(record);
  const command = formatShellCommand(substrate.attachCommand(record.tmuxTarget));
  if (truthy(flag(parsed, "print"))) {
    if (isPretty()) console.error(note(`attach with:`));
    console.log(command);
    return;
  }
  await applyBeeWindowOptions(record);
  await substrate.attachSession(record.tmuxTarget);
  await syncBeesSidebarLayout({ pruneOthers: true });
}


export async function applyBeeWindowOptions(record: SessionRecord): Promise<void> {
  const options = tmuxOptionsForAgent(record.agent);
  if (!options) return;
  await substrateFor(record).setWindowOptions(record.tmuxTarget, options, record.agentPaneId);
}


/**
 * Jump the attached client to the next bee that needs attention — `waiting`,
 * `done`, or `failed` by default (override with --state). Reads live @hive_state
 * straight off the local tmux server (no store), so it stays O(1) at any fleet
 * size. Repeated presses cycle through the attention set; --prev walks back.
 *
 * Local-only by design: switch-client cannot cross to a remote tmux server, so
 * remote bees are out of scope (use `hive attach <bee>` for those).
 */
export async function cmdNext(parsed: Parsed) {
  const stateFlag = stringFlag(parsed, ["state"]);
  const states = stateFlag ? parseStateList(stateFlag) : DEFAULT_ATTENTION_STATES;
  const prev = truthy(flag(parsed, "prev"));

  const substrate = localSubstrate();
  const stateMap = await substrate.listSessionStates();
  const sessions: BeeStateEntry[] = [...stateMap].map(([name, state]) => ({ name, state }));

  const current = process.env.TMUX ? await currentTmuxSession() : undefined;
  const target = pickNextBee(sessions, current, { states, prev });

  if (!target) {
    if (isPretty()) console.error(note(`No bees ${states.join("/")} — nothing needs you right now`));
    return;
  }

  if (truthy(flag(parsed, "print"))) {
    console.log(target);
    return;
  }

  const record = await loadSession(target).catch(() => null);
  if (record) await applyBeeWindowOptions(record);
  await substrate.attachSession(target);
  await syncBeesSidebarLayout({ pruneOthers: true });

  if (isPretty()) {
    const remaining = attentionCount(sessions, states) - 1;
    const tail = target === current ? "" : remaining > 0 ? `  ${dim(`· ${remaining} more need you`)}` : "";
    console.error(note(`→ ${target}  ${dim(stateMap.get(target) ?? "")}${tail}`));
  }
}
