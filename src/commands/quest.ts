// `hive quest` — quest workflows: create/start/list/inspect/done over a
// colony + workspace, optionally frame- and flow-driven.
// Extracted from cli.ts (HIVE-15).
import { createColony, loadColony } from "../colony.js";
import { loadFlow } from "../flow/index.js";
import { executeFlow } from "../flow/run.js";
import { generateRunId } from "../flow/runs.js";
import { actionLine, bold, cyan, dim, formatRelativeTime, formatTable, gray, green, isPretty, note, red, truncate, yellow } from "../format.js";
import { writeHiveTags } from "../hiveState.js";
import { transactionalKill } from "../kill.js";
import { isLinearIdentifier, loadLinearAdapter } from "../linear.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { createQuest, generateQuestId, listQuests, loadQuest, questDir, updateQuest, validQuestId, type QuestRecord, type QuestStatus } from "../quest.js";
import { copyBeeSeals } from "../seal.js";
import { listSessions, loadSession, saveSession, updateSession, type SessionRecord } from "../store.js";
import { localSubstrate } from "../substrates/index.js";
import { hasSession, tmux } from "../tmux.js";
import { linkTargetsInto, linkWindowsInto, sessionWindowInventory, windowInventory } from "../tmuxLink.js";
import { archiveWorkspace, createWorkspace, loadWorkspace, updateWorkspace, workspaceSessionName, type WorkspaceLayoutEntry } from "../workspace.js";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hasFlag, stringFlag } from "../cli/shared.js";
import { parseFlowRunArgs } from "../commands/flow.js";
import { spawnFromFrame } from "../commands/spawn.js";
import { addBeeMember, closeWorkspaceSession, ensureWorkspaceSession, seedWorkspaceMembers } from "../commands/workspace.js";

export async function cmdQuest(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case "create":
      return questCreate(parsed);
    case "start":
      return questStart(parsed);
    case undefined:
    case "list":
    case "ls":
      return questList(parsed);
    case "inspect":
      return questInspect(parsed);
    case "done":
      return questDone(parsed);
    case "archive":
      return questArchive(parsed);
    default:
      throw new Error(`Unknown quest subcommand: ${sub}\nUsage: hive quest <create|start|list|inspect|done|archive>`);
  }
}


/**
 * Slugify a quest title into a colony name (COLONY_NAME_RE:
 * /^[A-Za-z0-9][A-Za-z0-9_-]*$/): lowercase, collapse runs of unsafe chars into
 * a single dash, trim leading/trailing dashes. Falls back to "quest" if nothing
 * usable survives (e.g. a title of only punctuation).
 */
export function colonySlugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "quest";
}


/** Ensure a colony exists by name, creating it if missing; return its name. */
export async function ensureColony(name: string): Promise<string> {
  const existing = await loadColony(name);
  if (existing) {
    if (existing.archived) throw new Error(`Colony is archived: ${name}`);
    return existing.name;
  }
  const created = await createColony(name);
  return created.name;
}


export async function questCreate(parsed: Parsed) {
  const positionalTitle = parsed.args[1];
  const linear = stringFlag(parsed, ["linear"]);
  let description = stringFlag(parsed, ["description"]);

  // LINEAR ENRICHMENT (PRD §8.2/§8.3, side-effect-gated READ): only when
  // `--linear` is given, and only via the adapter the gate hands us. With no
  // LINEAR_API_KEY the adapter is null and we stay fully OFFLINE — the id is
  // recorded verbatim and nothing is fetched. The fetch result seeds the title
  // (only when no positional title was given — an explicit positional ALWAYS
  // wins) and the description (only when --description did not override it).
  let title = positionalTitle;
  let linearSeededNote: string | undefined;
  if (linear) {
    if (!isLinearIdentifier(linear)) {
      throw new Error(`--linear expects an issue identifier like ENG-1234 (got: ${linear})`);
    }
    const adapter = loadLinearAdapter();
    if (adapter) {
      const issue = await adapter.fetchIssue(linear);
      if (issue) {
        // Track what we ACTUALLY seeded at the assignment site (don't infer it by
        // value-comparing afterward — an explicit --description that happens to
        // equal the issue's would otherwise be misreported as seeded).
        const seeded: string[] = [];
        if (!positionalTitle && issue.title) { title = issue.title; seeded.push("title"); }
        if (!description && issue.description) { description = issue.description; seeded.push("description"); }
        linearSeededNote = `seeded from ${linear}${seeded.length ? ` (${seeded.join(", ")})` : ""}`;
      } else {
        // A configured adapter that misses (not found / API error already warned
        // by the adapter): no enrichment, fall through to the title requirement.
        linearSeededNote = `${linear}: no issue fetched — recorded id, no enrichment`;
      }
    } else {
      // OFFLINE NO-OP: no LINEAR_API_KEY. Record the id verbatim, no network.
      linearSeededNote = `Linear not configured (set LINEAR_API_KEY) — recorded ${linear}, no enrichment`;
    }
  }

  // Title is required UNLESS Linear enrichment supplied one. A missing title with
  // no usable Linear title (no positional AND (no adapter OR a fetch miss)) is a
  // clean usage error — we never invent a title.
  if (!title) {
    if (linear) {
      throw new Error(
        `hive quest create --linear ${linear}: a title is required because Linear did not supply one ` +
          `(no LINEAR_API_KEY, or the issue was not found). Pass a positional title.`,
      );
    }
    throw new Error('Usage: hive quest create "<title>" [--colony <c>] [--root <dir>] [--linear <issue>]');
  }

  // A quest ALWAYS lives in a colony (PRD §8.2 / open-question #5 decided yes):
  // use/create the named one, else auto-create from the title slug.
  const colonyFlag = stringFlag(parsed, ["colony"]);
  const colony = colonyFlag ? await ensureColony(colonyFlag) : await ensureColony(colonySlugFromTitle(title));

  const id = generateQuestId();

  // The quest OWNS A DEDICATED workspace named after the quest id — NOT the
  // colony's shared workspace, so a later `quest done` that closes the quest's
  // workspace can never nuke a colony-shared one. Resolve the file root from
  // --root › colony.rootDir › cwd.
  const rootDir = await resolveQuestRoot(stringFlag(parsed, ["root"]), colony);
  await createWorkspace({ name: id, rootDir, colony });
  await updateWorkspace(id, { questId: id });

  const record = await createQuest({
    id,
    title,
    colony,
    workspace: id,
    status: "open",
    ...(linear ? { linearIssueId: linear } : {}),
    ...(description ? { description } : {}),
  });

  if (linearSeededNote) console.error(note(`linear ${linearSeededNote}`));

  const session = workspaceSessionName(record.workspace);
  if (isPretty()) {
    console.log(actionLine("ok", "quest", [bold(record.id), dim(`"${record.title}"`), dim(`colony:${record.colony}`), dim(session)]));
    console.error(note(`start work with: hive quest start ${record.id} --frame <frame>`));
  } else {
    console.log(`quest-created\t${record.id}\t${record.colony}\t${record.workspace}`);
  }
}


/** Resolve a quest workspace's file root: --root › colony.rootDir › cwd. */
export async function resolveQuestRoot(rootFlag: string | undefined, colony: string): Promise<string> {
  if (rootFlag) {
    return realpath(resolve(rootFlag.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))).catch(() => resolve(rootFlag));
  }
  const record = await loadColony(colony);
  if (record?.rootDir && record.rootDir.length > 0) return record.rootDir;
  return process.cwd();
}


/** Resolve a quest by exact id, then by unique prefix (the swarm/colony nicety). */
export async function resolveQuestRecord(idArg: string): Promise<QuestRecord | null> {
  const direct = await loadQuest(idArg);
  if (direct) return direct;
  if (!validQuestId(idArg)) return null;
  const quests = await listQuests();
  const matches = quests.filter((q) => q.id.startsWith(idArg));
  return matches.length === 1 ? matches[0]! : null;
}


export async function questStart(parsed: Parsed) {
  const idArg = parsed.args[1];
  if (!idArg) throw new Error("Usage: hive quest start <id> --frame <f>");

  // --flow and --frame are mutually exclusive; --flow wins its own branch.
  if (hasFlag(parsed, "flow")) return questStartFlow(parsed, idArg);
  const frameName = stringFlag(parsed, ["frame"]);
  if (!frameName) throw new Error("hive quest start requires --frame <f> or --flow <f>");

  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);
  if (quest.status === "archived" || quest.status === "done") {
    throw new Error(`Quest ${quest.id} is ${quest.status}; cannot start work on it`);
  }

  // Spawn the swarm with the quest's colony injected — the bees MUST carry the
  // quest's colony (PRD §8.2), not whatever --colony the user typed. We clone the
  // Parsed and overwrite the colony/frame flags, then call the existing
  // spawnFromFrame: this needs NO change to that hot path (it already reads
  // --colony via resolveSpawnColony and --frame), and keeps swarm-record
  // creation, readiness waiting, and the swarmId hint all in one place.
  const questFlags = new Map(parsed.flags);
  questFlags.set("colony", quest.colony);
  questFlags.set("frame", frameName);
  // A quest-level --brief override lands with the flow/Linear increment; for now
  // briefs come from the frame's castes, so drop any stray --brief rather than let
  // spawnFromFrame reject the whole spawn (it forbids --brief with --frame).
  questFlags.delete("brief");
  const questParsed: Parsed = { ...parsed, flags: questFlags };

  const records = await spawnFromFrame(questParsed, frameName);
  if (records.length === 0) throw new Error(`Frame ${frameName} spawned no bees`);

  // Stamp every spawned bee with the quest id (and re-stamp colony defensively)
  // so the derived quest:<id> tag lights up, and link each bee's window into the
  // quest's workspace — reusing the workspace link path, never reinventing it.
  const session = workspaceSessionName(quest.workspace);
  const ensured = await ensureWorkspaceSession(session);

  const inventory = await windowInventory();
  const liveNames = new Set(await localSubstrate().listSessions());
  const wsRecord = await loadWorkspace(quest.workspace);
  const membership = seedWorkspaceMembers(wsRecord?.members);
  const beeTargets: string[] = [];
  for (const bee of records) {
    await stampQuestMembership(bee, quest.id, quest.colony, quest.workspace);
    // Only local + live windows can be link-window'd (the workspaceAdd discipline).
    if (bee.node && bee.node !== LOCAL_NODE_NAME) continue;
    if (!liveNames.has(bee.tmuxTarget)) continue;
    const windowId = inventory.active.get(bee.tmuxTarget);
    if (!windowId) continue; // no live window to link — never record a phantom member
    beeTargets.push(bee.tmuxTarget);
    addBeeMember(membership, bee);
  }
  await linkTargetsInto(session, beeTargets, ensured);
  // Persist the bee membership on the workspace so a later restore brings them
  // back (converges with the workspace add/open invariant).
  await updateWorkspace(quest.workspace, { members: membership.members });

  // Flip the quest to active: stamp activatedAt (first activation only) and
  // append the swarm id. The swarm id is the frame's swarm hint (spawnFromFrame
  // created it); read it off the freshly spawned bees.
  const swarmId = records.find((r) => r.swarmId)?.swarmId;
  const swarmIds = swarmId && !quest.swarmIds.includes(swarmId) ? [...quest.swarmIds, swarmId] : quest.swarmIds;
  await updateQuest(quest.id, {
    status: "active",
    swarmIds,
    ...(quest.activatedAt ? {} : { activatedAt: new Date().toISOString() }),
  });

  if (isPretty()) {
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(swarmId ? `@${swarmId}` : ""), `${records.length} bee(s)`, dim(session)]));
  } else {
    console.log(`quest-started\t${quest.id}\t${swarmId ?? ""}\t${records.length}`);
  }
}


/**
 * `hive quest start <id> --flow <name>` — run a flow in the FOREGROUND and adopt
 * every bee it spawns into the quest, reaching the SAME end state as the --frame
 * path: each bee carries questId + the quest's colony + workspaceId, each live
 * local window is linked into ws-<id>, the workspace members are persisted, the
 * flow's swarm cohort is appended to quest.swarmIds, and the quest is flipped to
 * active (on success only).
 *
 * Foreground-only in this increment: the per-spawn stamp/link happens in-process
 * via the onSpawned hook, which closes over the ensured link session + members
 * accumulator. A --background child re-execs in a different process where that
 * closure does not exist (spawnDetachedRun cannot carry a JS callback across the
 * fork), so --flow --background is an explicit, guarded later-increment throw.
 */
export async function questStartFlow(parsed: Parsed, idArg: string): Promise<void> {
  if (hasFlag(parsed, "background")) {
    throw new Error("hive quest start --flow --background lands in a later increment");
  }
  const flowName = stringFlag(parsed, ["flow"]);
  if (!flowName) throw new Error("Usage: hive quest start <id> --flow <name> [--arg key=value]...");

  // Resolve + validate the quest BEFORE loading the flow so a bad id fails fast.
  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);
  if (quest.status === "archived" || quest.status === "done") {
    throw new Error(`Quest ${quest.id} is ${quest.status}; cannot start work on it`);
  }

  const flow = await loadFlow(flowName);
  if (!flow) throw new Error(`Unknown flow: ${flowName}`);
  const args = parseFlowRunArgs(parsed);

  // Prepare the quest's link session ONCE up front (mirror the --frame path) so
  // ws-<id> exists before the first bee spawns and has a host for the link.
  const session = workspaceSessionName(quest.workspace);
  const ensured = await ensureWorkspaceSession(session);

  // Seed the members accumulator from the existing workspace record. The
  // onSpawned hook appends to it as each bee spawns; we persist it once
  // after the flow returns (members are records, so they survive kill-on-end).
  const wsRecord = await loadWorkspace(quest.workspace);
  const membership = seedWorkspaceMembers(wsRecord?.members);
  const currentWindows = new Set((await sessionWindowInventory(session)).windows);
  let placeholderDropped = false;

  // Per-spawn hook: replicate the --frame loop body for ONE bee. The spawned
  // bee's windows must be read per spawn because bees appear over time, but a
  // single-session `list-windows -t =bee` is enough; avoid a global `-a` scan.
  const onSpawned = async (bee: SessionRecord): Promise<void> => {
    await stampQuestMembership(bee, quest.id, quest.colony, quest.workspace);
    // Only local + live windows can be link-window'd (the workspaceAdd discipline).
    if (bee.node && bee.node !== LOCAL_NODE_NAME) return;
    const beeWindows = await sessionWindowInventory(bee.tmuxTarget);
    const windowId = beeWindows.active;
    if (!windowId) return; // no live window to link — never record a phantom member
    const linked = await linkWindowsInto(session, currentWindows, [{ session: bee.tmuxTarget, windowId }], { select: false });
    if (linked > 0) {
      currentWindows.add(windowId);
      if (ensured.placeholder && !placeholderDropped) {
        await tmux(["kill-window", "-t", `=${session}:${ensured.placeholder}`], { reject: false });
        currentWindows.delete(ensured.placeholder);
        placeholderDropped = true;
      }
      if (ensured.created) {
        await tmux(["select-window", "-t", `=${session}:${windowId}`], { reject: false });
      }
    }
    addBeeMember(membership, bee);
  };

  // The flow's cohort swarmId is the facade default `flow:<name>:run:<runId>`.
  // Reconstruct it (don't read it off a bee) so a zero-spawn flow still records
  // the cohort and it never depends on a bee surviving cleanup.
  const runId = generateRunId();
  const swarmId = `flow:${flow.name}:run:${runId}`;
  if (isPretty()) {
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(`flow ${flow.name}`), dim(`run ${runId}`)]));
  } else {
    console.log(`quest-flow\t${quest.id}\t${flow.name}\t${runId}`);
  }

  let outcome: Awaited<ReturnType<typeof executeFlow>>;
  try {
    // cleanupOverride:"keep" defeats a flow's kill-on-end — the quest owns its
    // bees. Foreground (no installSignalHandlers override) so SIGINT aborts the
    // run exactly like `hive flow run`.
    outcome = await executeFlow(flow, { args, runId, onSpawned, cleanupOverride: "keep" });
  } finally {
    // Persist members REGARDLESS of outcome so the workspace reflects whatever
    // bees were spawned + linked, even on a failed/cancelled run (the safe
    // partial state — these bees are real quest members, not orphans).
    await updateWorkspace(quest.workspace, { members: membership.members });
  }

  // Flip the quest active ONLY on success: a crashed/aborted flow must never
  // leave a phantom-active quest. Append the cohort swarmId either way is wrong
  // — only record it when we actually activate.
  if (outcome.status === "ok") {
    const swarmIds = quest.swarmIds.includes(swarmId) ? quest.swarmIds : [...quest.swarmIds, swarmId];
    await updateQuest(quest.id, {
      status: "active",
      swarmIds,
      ...(quest.activatedAt ? {} : { activatedAt: new Date().toISOString() }),
    });
  }

  if (isPretty()) {
    const colored = outcome.status === "ok" ? green("ok")
      : outcome.status === "cancelled" ? yellow("cancelled")
      : outcome.status === "failed" ? red("failed")
      : dim(outcome.status);
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(`@${swarmId}`), dim(`${membership.members.length} bee(s)`), colored]));
    if (outcome.error?.message) console.error(dim(`error: ${outcome.error.message}`));
  } else {
    console.log(`quest-started\t${quest.id}\t${swarmId}\t${membership.members.length}\t${outcome.status}`);
  }
  if (outcome.status === "failed") process.exitCode = 1;
  if (outcome.status === "cancelled") process.exitCode = 130;
}


/**
 * Stamp a bee's questId (+ colony) so the derived quest:<id> / colony: tags
 * refresh (the stampWorkspaceMembership pattern). A quest never silently fails to
 * stamp a bee — that is the heart of acceptance Q1.
 */
export async function stampQuestMembership(bee: SessionRecord, questId: string, colony: string, workspaceName: string): Promise<void> {
  const patch: Partial<SessionRecord> = {};
  if (bee.questId !== questId) patch.questId = questId;
  if (bee.colony !== colony) patch.colony = colony;
  if (bee.workspaceId !== workspaceName) patch.workspaceId = workspaceName;
  if (Object.keys(patch).length === 0) return;
  await updateSession(bee.name, { ...patch, updatedAt: new Date().toISOString() });
  await writeHiveTags({ ...bee, ...patch });
}


export async function questList(parsed: Parsed) {
  const colonyFilter = stringFlag(parsed, ["colony"]);
  const statusFilter = stringFlag(parsed, ["status"]);
  let quests = await listQuests();
  // Archived quests are excluded from default listings (archive handling proper
  // is increment 9b); a `--status archived` request can still surface them.
  if (statusFilter !== "archived") quests = quests.filter((q) => q.status !== "archived");
  if (colonyFilter) quests = quests.filter((q) => q.colony === colonyFilter);
  if (statusFilter) quests = quests.filter((q) => q.status === statusFilter);

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(quests, null, 2));
    return;
  }
  if (!isPretty()) {
    for (const q of quests) {
      console.log(`${q.status}\t${q.id}\t${q.colony}\t${q.workspace}\t${q.swarmIds.length}\t${q.title}`);
    }
    return;
  }
  if (quests.length === 0) {
    console.log(dim('No quests. Create one with: hive quest create "<title>" [--colony <c>]'));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "ID" },
      { header: "COLONY" },
      { header: "WORKSPACE" },
      { header: "SWARMS", align: "right" },
      { header: "TITLE" },
      { header: "AGE", align: "right" },
    ],
    quests.map((q) => [
      questStatusColor(q.status),
      bold(q.id),
      dim(q.colony),
      dim(q.workspace),
      String(q.swarmIds.length),
      truncate(q.title, 40),
      dim(formatRelativeTime(q.createdAt)),
    ]),
  ));
}


export function questStatusColor(status: QuestStatus): string {
  switch (status) {
    case "active":
      return green("active");
    case "open":
      return cyan("open");
    case "done":
      return gray("done");
    case "archived":
      return gray("archived");
  }
}


export async function questInspect(parsed: Parsed) {
  const idArg = parsed.args[1];
  if (!idArg) throw new Error("Usage: hive quest inspect <id>");
  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);

  // Roll up the quest's bees by filtering the store for questId===id (the same
  // set the quest:<id> selector resolves, but read directly so inspect stays a
  // cheap store-only read with no live tmux probe).
  const bees = (await listSessions()).filter((b) => b.questId === quest.id);
  const beeSummary = bees.map((b) => ({
    name: b.name,
    agent: b.agent,
    caste: b.caste,
    status: b.status,
    state: b.lastObservedState,
  }));

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ ...quest, bees: beeSummary }, null, 2));
    return;
  }

  if (isPretty()) {
    console.log(actionLine("ok", "quest", [bold(quest.id), dim(`"${quest.title}"`), questStatusColor(quest.status)]));
    console.log(`  ${dim("colony")}    ${quest.colony}`);
    console.log(`  ${dim("workspace")} ${workspaceSessionName(quest.workspace)}`);
    console.log(`  ${dim("swarms")}    ${quest.swarmIds.length > 0 ? quest.swarmIds.map((s) => `@${s}`).join(" ") : dim("none")}`);
    if (quest.linearIssueId) console.log(`  ${dim("linear")}    ${quest.linearIssueId}`);
    console.log(`  ${dim("bees")}      ${bees.length}`);
    for (const b of beeSummary) {
      // A filed bee shows `archived` (it stays in the live store by questId, so
      // inspect surfaces it even though the default selector path excludes it).
      const state = b.status === "archived" ? gray("archived") : b.status === "running" ? green(b.state ?? "running") : gray(b.status);
      console.log(`    ${bold(b.name)} ${dim(b.caste ? `caste:${b.caste}` : b.agent)} ${state}`);
    }
  } else {
    console.log(`quest\t${quest.id}\t${quest.status}\t${quest.colony}\t${quest.workspace}\t${quest.swarmIds.join(",")}\t${quest.linearIssueId ?? ""}`);
    for (const b of beeSummary) {
      console.log(`bee\t${b.name}\t${b.caste ?? b.agent}\t${b.status}\t${b.state ?? ""}`);
    }
  }
}


/**
 * `hive quest done <id> [--keep-bees] [--close-linear]` — file the quest's work
 * and complete it (PRD §8.4, acceptance Q2). The strict ordering is the safety
 * spine: FILE (copy seals + the final workspace snapshot) BEFORE any destructive
 * step, so a crash never loses a seal or the geometry; SNAPSHOT the workspace
 * BEFORE closing it; KILL transactionally; mark archived ONLY the bees we
 * confirmed killed (a kill_failed or a kept-alive bee is NEVER marked archived —
 * the cardinal invariant: never hide a live bee from `list`); then CLOSE the
 * workspace with the safe close (which never kills a bee, and aborts rather than
 * orphan one); finally flip the quest to done. The whole flow is restartable.
 */
export async function questDone(parsed: Parsed) {
  const idArg = parsed.args[1];
  if (!idArg) throw new Error("Usage: hive quest done <id> [--keep-bees] [--close-linear]");
  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);
  // Idempotency guard (mirrors questStart): a quest that is already done/archived
  // has already been filed; don't re-run the destructive flow.
  if (quest.status === "done" || quest.status === "archived") {
    throw new Error(`Quest ${quest.id} is already ${quest.status}`);
  }

  const keepBees = truthy(flag(parsed, "keep-bees"));

  // 1. Gather members directly from the store by questId (NOT resolveSelector —
  //    some may already be archived from a prior partial run, and the selector
  //    path excludes archived).
  const bees = (await listSessions()).filter((b) => b.questId === quest.id);

  // 3. SNAPSHOT the quest workspace geometry (before close) so the filed
  //    workspace.json carries live window layouts.
  const wsSession = workspaceSessionName(quest.workspace);
  if (await hasSession(wsSession)) {
    const result = await tmux(["list-windows", "-t", `=${wsSession}:`, "-F", "#{window_name}\t#{window_layout}"], { reject: false });
    const layout: WorkspaceLayoutEntry[] = [];
    for (const line of (result.ok ? result.stdout.split("\n") : []).filter(Boolean)) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const windowName = line.slice(0, tab);
      const value = line.slice(tab + 1);
      if (!windowName || !value) continue;
      layout.push({ windowName, layout: value });
    }
    await updateWorkspace(quest.workspace, { layout });
  }
  const wsRecord = await loadWorkspace(quest.workspace);

  // 4. FILE ARCHIVE under quests/<id>/ — a COPY, BEFORE any destructive step.
  const dir = questDir(quest.id);
  await mkdir(dir, { recursive: true });
  // 4a. Seals: copy every member's seals (read-only collection — bees seal
  //     themselves; absence of a seal is not an error). The live sealsRoot is
  //     never moved, so a crash here leaves seals duplicated (benign), not lost.
  let filedSealBees = 0;
  for (const bee of bees) {
    const copied = await copyBeeSeals(bee.name, join(dir, "seals"));
    if (copied > 0) filedSealBees += 1;
  }
  // 4b. Final workspace snapshot (geometry + members) for reconstruction.
  if (wsRecord) {
    await writeFile(join(dir, "workspace.json"), `${JSON.stringify(wsRecord, null, 2)}\n`, { mode: 0o600 });
  }
  // 4c. Manifest: each member's final SessionRecord so a filed bee is
  //     reconstructable even after its live record is later kill-deleted.
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify({ questId: quest.id, filedAt: new Date().toISOString(), bees }, null, 2)}\n`,
    { mode: 0o600 },
  );

  // 5./6. KILL (unless --keep-bees) + mark ONLY confirmed-killed bees archived.
  // A quest bee's window is LINKED into ws-<id> (quest start link-window'd it):
  // killing the bee's own session leaves that window orphaned in the ws (its only
  // remaining link), which the safe close would then refuse as a "last link". So
  // for each CONFIRMED-killed bee we reap its now-dead orphan window from the ws
  // with `unlink-window -k` — killing a confirmed-dead window is debris cleanup,
  // never killing a live bee. A kept/kill_failed (live) bee's window is left for
  // the safe close to safe-unlink (it survives via the bee's own session).
  const inventory = (await hasSession(wsSession)) ? await windowInventory() : undefined;
  const outcomes: Array<{ name: string; result: "archived" | "kept" | "kill_failed" }> = [];
  if (!keepBees) {
    for (const bee of bees) {
      if (bee.status === "archived") {
        // Already filed by a prior partial run — leave it archived.
        outcomes.push({ name: bee.name, result: "archived" });
        continue;
      }
      // Capture the record + ws window id BEFORE the kill: transactionalKill
      // deletes the record on confirmed death, and the window id is needed to
      // reap the orphan afterwards. Re-read from disk (not the quest listing's
      // possibly-stale `bee`) so daemon merges since then — auto-title,
      // providerSessionId — survive into the archived record (HIVE-49).
      const snapshot = (await loadSession(bee.name)) ?? { ...bee };
      const wsWindowId = inventory?.active.get(bee.tmuxTarget);
      const outcome = await transactionalKill(bee);
      if (outcome.ok) {
        // Re-create the index record with status:"archived" — the live store
        // stays the index (PRD §16 #4), the bee is filed not deleted.
        await saveSession({ ...snapshot, status: "archived", updatedAt: new Date().toISOString() });
        // Reap the now-dead orphan window from the ws (the bee is confirmed gone).
        if (wsWindowId) await tmux(["unlink-window", "-k", "-t", wsWindowId], { reject: false });
        outcomes.push({ name: bee.name, result: "archived" });
      } else {
        // A kill_failed bee may still be running — leave it kill_failed, do NOT
        // archive it (never hide a possibly-live bee), and leave its window for
        // the safe close to safe-unlink.
        outcomes.push({ name: bee.name, result: "kill_failed" });
      }
    }
  } else {
    // --keep-bees: bees stay alive → NEVER mark them archived (that would hide a
    // live bee from `list`, the cardinal invariant). They keep status:"running".
    for (const bee of bees) outcomes.push({ name: bee.name, result: "kept" });
  }

  // 7. CLOSE the quest workspace with the safe close (never kills a bee; aborts
  //    rather than orphan a still-live --keep-bees window). If it throws, the
  //    quest is left NOT-done and surfaces the error — no silent bee loss. The
  //    confirmed-dead orphan windows were already reaped above, so the safe close
  //    sees only our own windows + any live (kept/kill_failed) bee windows.
  if (await hasSession(wsSession)) {
    await closeWorkspaceSession(wsSession);
  }
  await archiveWorkspace(quest.workspace).catch(() => undefined);

  // 8. Flip the quest to done (emits the quest.done ledger event).
  const updated = await updateQuest(quest.id, { status: "done", completedAt: new Date().toISOString() });

  // 9. --close-linear (side-effect-gated WRITE, best-effort): transition the
  //    quest's Linear issue to Done. The quest is ALREADY done by this point, so
  //    a Linear failure is a side effect that NEVER fails `quest done`.
  if (truthy(flag(parsed, "close-linear"))) {
    if (!updated.linearIssueId) {
      console.error(note("--close-linear: this quest has no Linear issue — nothing to close"));
    } else {
      const adapter = loadLinearAdapter();
      if (!adapter) {
        // OFFLINE NO-OP: no LINEAR_API_KEY.
        console.error(note(`--close-linear: Linear not configured (set LINEAR_API_KEY) — left ${updated.linearIssueId} untouched`));
      } else {
        const closed = await adapter.closeIssue(updated.linearIssueId);
        if (closed) console.error(note(`--close-linear: transitioned ${updated.linearIssueId} to Done`));
        else console.error(note(`--close-linear: could not close ${updated.linearIssueId} (best-effort; quest is still done)`));
      }
    }
  }

  const killFailed = outcomes.filter((o) => o.result === "kill_failed").map((o) => o.name);
  if (killFailed.length > 0) {
    console.error(note(`${killFailed.length} bee(s) failed to die and stay visible (kill_failed): ${killFailed.join(", ")}`));
  }
  if (isPretty()) {
    const beeNote = keepBees ? `${bees.length} bee(s) kept` : `${outcomes.filter((o) => o.result === "archived").length} bee(s) filed`;
    console.log(actionLine("ok", "quest", [bold(updated.id), dim("done"), dim(beeNote), dim(`${filedSealBees} sealed`)]));
  } else {
    console.log(`quest-done\t${updated.id}\t${outcomes.filter((o) => o.result === "archived").length}\t${killFailed.length}`);
  }
}


/**
 * `hive quest archive <id>` — the post-done filing flip (done → archived, PRD
 * §8.4). A pure quest-record state flip: it does NOT re-touch bees or the
 * workspace (already handled by `done`). Idempotent: archiving an archived quest
 * is a no-op. Surfaces in `quest list --status archived`.
 */
export async function questArchive(parsed: Parsed) {
  const idArg = parsed.args[1];
  if (!idArg) throw new Error("Usage: hive quest archive <id>");
  const quest = await resolveQuestRecord(idArg);
  if (!quest) throw new Error(`Unknown quest: ${idArg}`);
  if (quest.status === "archived") {
    if (isPretty()) console.log(actionLine("ok", "quest", [bold(quest.id), dim("already archived")]));
    else console.log(`quest-archived\t${quest.id}`);
    return;
  }
  // Archive is the lifecycle flip after done; require done first so the work was
  // filed (quest done copies seals + snapshot before archiving is meaningful).
  if (quest.status !== "done") {
    throw new Error(`Quest ${quest.id} is ${quest.status}; run 'hive quest done ${quest.id}' before archiving`);
  }
  const updated = await updateQuest(quest.id, { status: "archived", archivedAt: new Date().toISOString() });
  if (isPretty()) console.log(actionLine("ok", "quest", [bold(updated.id), dim("archived")]));
  else console.log(`quest-archived\t${updated.id}`);
}
