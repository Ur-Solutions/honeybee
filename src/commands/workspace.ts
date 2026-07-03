// `hive workspace`/ws + `hive restore` — tmux workspace sessions grouping bees,
// with snapshot/restore and membership accounting.
// Extracted from cli.ts (HIVE-15).
import { loadColony } from "../colony.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, gray, green, isPretty, note, tildify } from "../format.js";
import { writeHiveTags } from "../hiveState.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { resolveSelector } from "../selectors.js";
import { listSessions, updateSession, type SessionRecord } from "../store.js";
import { localSubstrate } from "../substrates/index.js";
import { formatShellCommand, hasSession, newSession, tmux } from "../tmux.js";
import { createGroupedSession, ensureLinkSession, linkTargetsInto, linkWindowsInto, windowInventory, type EnsureLinkSessionResult } from "../tmuxLink.js";
import { WORKSPACE_PREFIX, archiveWorkspace, createWorkspace, listWorkspaces, loadWorkspace, renameWorkspace, updateWorkspace, workspaceSessionName, type WorkspaceLayoutEntry, type WorkspaceMember, type WorkspaceRecord } from "../workspace.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { currentTmuxSessionName, resolveBeeInCurrentPane, stringFlag } from "../cli/shared.js";
import { reviveRecord } from "../commands/migrate.js";

export async function cmdWorkspace(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return workspaceList(parsed);
    case "open":
      return workspaceOpen(parsed);
    case "add":
      return workspaceAdd(parsed);
    case "add-pane":
      return workspaceAddPane(parsed);
    case "snapshot":
      return workspaceSnapshot(parsed);
    case "restore":
      return workspaceRestore(parsed);
    case "close":
      return workspaceClose(parsed);
    case "rename":
      return workspaceRename(parsed);
    case "here":
      return workspaceHere(parsed);
    case "archive":
      return workspaceArchive(parsed);
    default:
      throw new Error(`Unknown workspace subcommand: ${sub}\nUsage: hive workspace <open|list|add|add-pane|snapshot|restore|close|rename|here|archive>`);
  }
}


/**
 * Resolve the current pane's OWNING workspace bare name (KEYBINDINGS_PRD §9.1 /
 * §10 — unblocks the M-R binding). If $TMUX's session is a ws-* session, print
 * its bare workspace name; else resolve the current bee → its workspaceId.
 * Errors to stderr + non-zero if not inside tmux or no owning workspace.
 */
export async function workspaceHere(_parsed: Parsed): Promise<void> {
  if (!process.env.TMUX) throw new Error("hive workspace here: not inside tmux");
  const sessionName = await currentTmuxSessionName();
  if (sessionName && sessionName.startsWith(WORKSPACE_PREFIX)) {
    const bare = sessionName.slice(WORKSPACE_PREFIX.length);
    // A grouped ws-* client carries a `-N` suffix (ws-fe-2). Disambiguate against
    // a workspace literally named `fe-2`: if a record with the exact bare name
    // exists, that is it; otherwise strip a trailing `-<digits>` grouping suffix
    // and re-check, so the M-R rename chord resolves `fe` from a `ws-fe-2` client.
    if (await loadWorkspace(bare)) {
      console.log(bare);
      return;
    }
    const ungrouped = bare.replace(/-\d+$/, "");
    if (ungrouped !== bare && (await loadWorkspace(ungrouped))) {
      console.log(ungrouped);
      return;
    }
    // No record either way (an ad-hoc ws- session with no record): the bare
    // prefix-stripped name is the best we can do and round-trips when un-grouped.
    console.log(bare);
    return;
  }
  const bee = await resolveBeeInCurrentPane();
  if (!bee || !bee.workspaceId) {
    throw new Error("hive workspace here: the current pane has no owning workspace");
  }
  console.log(bee.workspaceId);
}


/**
 * Resolve the workspace record for `name`, falling back to a same-named colony's
 * auto-workspace. Returns null when neither exists.
 */
export async function resolveWorkspaceRecord(name: string): Promise<WorkspaceRecord | null> {
  const direct = await loadWorkspace(name);
  if (direct) return direct;
  // Fall back to a colony of the same name whose auto-workspace wasn't
  // provisioned yet (or was created before this feature) — create it lazily.
  const colony = await loadColony(name);
  if (!colony) return null;
  try {
    return await createWorkspace({ name, rootDir: colony.rootDir ?? "", members: [], colony: name });
  } catch {
    // A concurrent create won the race; re-read.
    return loadWorkspace(name);
  }
}


/**
 * Resolve-or-create the workspace record for `name`. A bare `open <name>` for a
 * name that is neither a workspace nor a colony creates a stand-alone ad-hoc
 * workspace (the PRD allows these alongside colony auto-workspaces).
 */
export async function ensureWorkspaceRecord(name: string): Promise<WorkspaceRecord> {
  const resolved = await resolveWorkspaceRecord(name);
  if (resolved) return resolved;
  try {
    return await createWorkspace({ name, rootDir: "", members: [] });
  } catch {
    const reread = await loadWorkspace(name);
    if (reread) return reread;
    throw new Error(`Could not create workspace: ${name}`);
  }
}


/** Resolve a workspace's file root: --root › record.rootDir › colony.rootDir › cwd. */
export async function resolveWorkspaceRoot(rootFlag: string | undefined, record: WorkspaceRecord): Promise<string> {
  if (rootFlag) return realpath(resolve(rootFlag.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))).catch(() => resolve(rootFlag));
  if (record.rootDir && record.rootDir.length > 0) return record.rootDir;
  if (record.colony) {
    const colony = await loadColony(record.colony);
    if (colony?.rootDir) return colony.rootDir;
  }
  return process.cwd();
}


export async function workspaceList(parsed: Parsed) {
  const colonyFilter = stringFlag(parsed, ["colony"]);
  const showArchived = truthy(flag(parsed, "archived"));
  let workspaces = await listWorkspaces();
  if (!showArchived) workspaces = workspaces.filter((w) => !w.archived);
  if (colonyFilter) workspaces = workspaces.filter((w) => w.colony === colonyFilter);

  if (!isPretty()) {
    for (const w of workspaces) {
      console.log(`${w.archived ? "archived" : "active"}\t${w.name}\t${w.rootDir}\t${w.colony ?? ""}\t${w.members.length}`);
    }
    return;
  }
  if (workspaces.length === 0) {
    console.log(dim("No workspaces. Create one with: hive workspace open <name> --root <dir>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "NAME" },
      { header: "ROOT" },
      { header: "COLONY" },
      { header: "MEMBERS", align: "right" },
      { header: "AGE", align: "right" },
    ],
    workspaces.map((w) => [
      w.archived ? gray("archived") : green("active"),
      bold(w.name),
      dim(w.rootDir ? tildify(w.rootDir) : "(unset)"),
      dim(w.colony ?? ""),
      String(w.members.length),
      dim(formatRelativeTime(w.createdAt)),
    ]),
  ));
}


export async function workspaceOpen(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace open <name|colony> [--root <dir>] [--new-client] [--print]");
  // open create-or-reuses: a colony's auto-workspace, an existing record, or a
  // fresh stand-alone workspace for an unknown name.
  const record = await ensureWorkspaceRecord(name);

  const rootDir = await resolveWorkspaceRoot(stringFlag(parsed, ["root"]), record);
  // Persist the resolved root on first open (when it was empty or --root given).
  if (record.rootDir !== rootDir) {
    await updateWorkspace(record.name, { rootDir });
  }

  const session = workspaceSessionName(record.name);
  const ensured = await ensureWorkspaceSession(session);

  // Materialize bee members: resolve each bee's live session, link its window in.
  const index = await beeSessionIndex();
  const beeTargets: string[] = [];
  for (const member of record.members) {
    if (member.kind !== "bee") continue;
    const bee = resolveBeeMember(index, member.beeId);
    if (!bee) continue;
    if (bee.node && bee.node !== LOCAL_NODE_NAME) continue;
    if (!index.liveNames.has(bee.tmuxTarget)) continue;
    beeTargets.push(bee.tmuxTarget);
    // Converge with `add`: a member bee must carry workspaceId so ws:<name>
    // (derived from bee.workspaceId) and record.members never disagree.
    await stampWorkspaceMembership(bee, record.name);
  }
  const linkResult = await linkTargetsInto(session, beeTargets, ensured);

  // Materialize pane members: a window at rootDir running the member's command
  // (or a shell). Only when the session was freshly created this call — a
  // re-open of a live session keeps its existing panes (native persistence).
  if (ensured.created) {
    for (const member of record.members) {
      if (member.kind !== "pane") continue;
      await openWorkspacePane(session, rootDir, member.command);
    }
    // If we created bee links, the placeholder is already gone; otherwise it
    // remains as the single (shell) window — which is fine for an empty/pane-only
    // workspace.
  }

  if (isPretty()) {
    console.log(actionLine("ok", "workspace", [bold(session), dim(`root ${tildify(rootDir)}`), `${linkResult.linked.length} bee(s) linked`]));
  } else {
    console.log(`workspace\t${session}\t${rootDir}\t${linkResult.linked.length}`);
  }

  let enterTarget = session;
  if (truthy(flag(parsed, "new-client"))) {
    enterTarget = await createGroupedSession(session);
    if (isPretty()) console.error(note(`grouped session ${enterTarget} — independent focus on the same windows`));
  }

  const substrate = localSubstrate();
  if (truthy(flag(parsed, "print")) || !process.stdout.isTTY) {
    if (isPretty()) console.error(note("enter with:"));
    console.log(formatShellCommand(substrate.attachCommand(enterTarget)));
    return;
  }
  await substrate.attachSession(enterTarget);
}


/**
 * Make a workspace session persist across terminal close (PRD §6/§7.2): never
 * auto-destroyed when the last client detaches, and clients survive a window
 * close. tmux's `set-option` does NOT accept the `=name` exact-match prefix
 * (unlike has-session/kill-session/window targets), so the session is targeted
 * by its bare exact name (freshly created, no prefix-collision risk).
 */
export async function setWorkspaceOptions(session: string): Promise<void> {
  await tmux(["set-option", "-t", session, "destroy-unattached", "off"], { reject: false });
  await tmux(["set-option", "-t", session, "detach-on-destroy", "off"], { reject: false });
}


/**
 * Shared workspace/quest session bootstrap (open/restore/quest-start): ensure
 * the link session, make it persist across terminal close, and mark the
 * placeholder shell as the workspace's own window so `close` may reap it (it
 * survives as the anchor of an empty/pane-only workspace).
 */
export async function ensureWorkspaceSession(session: string): Promise<EnsureLinkSessionResult> {
  const ensured = await ensureLinkSession(session);
  await setWorkspaceOptions(session);
  if (ensured.placeholder) await markWorkspaceOwnWindow(session, ensured.placeholder);
  return ensured;
}


/**
 * Session records keyed by id ?? name plus the live local tmux session set —
 * the resolution workspaceOpen and restore share for materializing bee members.
 */
export type BeeSessionIndex = { records: SessionRecord[]; byId: Map<string, SessionRecord>; liveNames: Set<string> };


export async function beeSessionIndex(): Promise<BeeSessionIndex> {
  const records = await listSessions();
  const byId = new Map(records.map((r) => [r.id ?? r.name, r] as const));
  const liveNames = new Set(await localSubstrate().listSessions());
  return { records, byId, liveNames };
}


/** Resolve a workspace bee member to its record — member ids may be record ids or bare names. */
export function resolveBeeMember(index: BeeSessionIndex, beeId: string): SessionRecord | undefined {
  return index.byId.get(beeId) ?? index.records.find((r) => r.name === beeId);
}


/**
 * The members accumulator add/quest-start share: existing members (order
 * preserved) plus the bee-member id set for dedup.
 */
export type WorkspaceMembership = { members: WorkspaceMember[]; memberIds: Set<string> };


export function seedWorkspaceMembers(existing: WorkspaceMember[] | undefined): WorkspaceMembership {
  const members: WorkspaceMember[] = existing ? [...existing] : [];
  const memberIds = new Set(members.filter((m) => m.kind === "bee").map((m) => (m as { beeId: string }).beeId));
  return { members, memberIds };
}


/** Record a bee as a workspace member once (keyed by id ?? name). */
export function addBeeMember(membership: WorkspaceMembership, bee: SessionRecord): void {
  const beeId = bee.id ?? bee.name;
  if (membership.memberIds.has(beeId)) return;
  membership.members.push({ kind: "bee", beeId });
  membership.memberIds.add(beeId);
}


/** Open a window at `rootDir` running `command` (or the user's shell). */
export const WS_OWN_OPTION = "@hive_ws_own";


// Mark a window the workspace itself created (the placeholder shell or an
// add-pane shell) so `close` may kill-window it. A linked BEE window is NEVER
// marked, so close can only ever safe-unlink (no -k) those — which is what makes
// closing a workspace provably incapable of killing a bee, even one orphaned by
// a prior `hive kill` (home session gone, window still linked here).
export async function markWorkspaceOwnWindow(session: string, windowId: string): Promise<void> {
  if (!windowId) return;
  await tmux(["set-option", "-w", "-t", `${session}:${windowId}`, WS_OWN_OPTION, "1"], { reject: false });
}


export async function openWorkspacePane(session: string, rootDir: string, command?: string): Promise<void> {
  const args = ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${session}:`, "-c", rootDir];
  if (command && command.length > 0) args.push(command);
  const result = await tmux(args, { reject: false });
  await markWorkspaceOwnWindow(session, result.stdout.trim());
}


export async function workspaceAdd(parsed: Parsed) {
  const name = parsed.args[1];
  const sel = parsed.args[2];
  if (!name || !sel) throw new Error("Usage: hive workspace add <name> <bee-selector>");
  const record = await ensureWorkspaceRecord(name);

  const session = workspaceSessionName(record.name);
  // Ensure the session exists so `add` works standalone (without a prior open).
  const ensured = await ensureLinkSession(session);
  if (ensured.created) {
    await setWorkspaceOptions(session);
  }

  const resolved = await resolveSelector(sel);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${sel}`);

  const local = records.filter((r) => !r.node || r.node === LOCAL_NODE_NAME);
  if (local.length < records.length) {
    console.error(note(`skip ${records.length - local.length} remote bee(s) — link-window cannot cross tmux servers`));
  }
  const liveNames = new Set(await localSubstrate().listSessions());
  const live = local.filter((r) => liveNames.has(r.tmuxTarget));
  if (live.length < local.length) console.error(note(`skip ${local.length - live.length} dead bee(s)`));
  if (live.length === 0) throw new Error(`No live local bees match selector: ${sel}`);

  const membership = seedWorkspaceMembers(record.members);
  const inventory = await windowInventory();
  const currentWindows = new Set(inventory.windows.get(session) ?? []);
  let linkedCount = 0;
  for (const bee of live) {
    const windowId = inventory.active.get(bee.tmuxTarget);
    if (!windowId) continue;
    const linked = await linkWindowsInto(session, currentWindows, [{ session: bee.tmuxTarget, windowId }], { select: false });
    linkedCount += linked;
    if (linked > 0) currentWindows.add(windowId);
    addBeeMember(membership, bee);
    // Stamp workspaceId on the live bee so the derived ws: tag refreshes
    // (cmdMove colony pattern).
    const now = new Date().toISOString();
    await updateSession(bee.name, { workspaceId: record.name, updatedAt: now });
    await writeHiveTags({ ...bee, workspaceId: record.name });
  }
  await updateWorkspace(record.name, { members: membership.members });

  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(session), `${linkedCount} bee(s) linked`]));
  else console.log(`workspace-add\t${session}\t${linkedCount}`);
}


export async function workspaceAddPane(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace add-pane <name> [--cmd \"...\"] [--name <label>]");
  const record = await ensureWorkspaceRecord(name);

  const command = stringFlag(parsed, ["cmd"]);
  const label = stringFlag(parsed, ["name"]) ?? "pane";

  const session = workspaceSessionName(record.name);
  const ensured = await ensureLinkSession(session);
  if (ensured.created) {
    await setWorkspaceOptions(session);
  }
  const rootDir = await resolveWorkspaceRoot(stringFlag(parsed, ["root"]), record);
  await openWorkspacePane(session, rootDir, command);

  const members: WorkspaceMember[] = [...record.members, { kind: "pane", name: label, ...(command ? { command } : {}) }];
  await updateWorkspace(record.name, { members });

  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(session), dim(`pane ${label}`), command ? dim(command) : dim("shell")]));
  else console.log(`workspace-add-pane\t${session}\t${label}`);
}


/**
 * `hive workspace snapshot <name>` — refresh the record's geometry from the live
 * `ws-<name>` session so `restore` can rebuild it after a reboot (PRD §7.2/§11).
 * Captures each window's tmux `window_layout` string keyed by `window_name`.
 */
export async function workspaceSnapshot(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace snapshot <name>");
  const record = await ensureWorkspaceRecord(name);
  const session = workspaceSessionName(record.name);
  if (!(await hasSession(session))) throw new Error(`No such workspace session: ${session}`);

  // Capture per-window geometry. Tab-separate name from layout (layout strings
  // never contain a tab); skip blank rows defensively.
  const result = await tmux(["list-windows", "-t", `=${session}:`, "-F", "#{window_name}\t#{window_layout}"], { reject: false });
  const layout: WorkspaceLayoutEntry[] = [];
  for (const line of (result.ok ? result.stdout.split("\n") : []).filter(Boolean)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const windowName = line.slice(0, tab);
    const value = line.slice(tab + 1);
    if (!windowName || !value) continue;
    layout.push({ windowName, layout: value });
  }
  await updateWorkspace(record.name, { layout });

  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(session), dim(`snapshot · ${layout.length} window(s)`)]));
  else console.log(`workspace-snapshot\t${session}\t${layout.length}`);
}


/**
 * `hive workspace restore <name> [--resume]` — rebuild `ws-<name>` from the
 * record after a reboot (tmux server + bee processes gone, records persist),
 * PRD §7.3/§11. Idempotent: restoring a live workspace re-attaches/links without
 * double-spawning (PRD §13). Delegates to the shared restore core.
 */
export async function workspaceRestore(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace restore <name> [--resume]");
  const record = await resolveWorkspaceRecord(name);
  if (!record) throw new Error(`Unknown workspace: ${name}`);
  const result = await restoreWorkspaceRecord(record, { resume: truthy(flag(parsed, "resume")) });
  if (isPretty()) {
    console.log(actionLine("ok", "workspace", [bold(result.session), dim(`restored · ${result.beeCount} bee(s), ${result.paneCount} pane(s)`)]));
  } else {
    console.log(`workspace-restored\t${result.session}\t${result.beeCount}\t${result.paneCount}`);
  }
}


/**
 * Shared restore core for `workspace restore <name>` and `restore --all`. Rebuilds
 * `ws-<name>` from the record, reusing the same open/add helpers (no duplicated
 * link logic): ensure the session, recreate pane members at rootDir, re-spawn or
 * (idempotently) re-link bee members, then re-apply the saved layout geometry.
 *
 * Restore is purely additive — it NEVER kills a bee, and never double-spawns one
 * that is already alive (PRD §13). `reviveRecord` re-spawns each bee into ITS OWN
 * home with no account switch, so there is no cross-account hazard.
 */
export async function restoreWorkspaceRecord(record: WorkspaceRecord, opts: { resume: boolean }): Promise<{ session: string; beeCount: number; paneCount: number }> {
  const rootDir = await resolveWorkspaceRoot(undefined, record);
  // Persist the resolved root on first restore (when it was empty and resolved
  // from the colony or cwd), exactly as workspaceOpen does — so the record and
  // the rebuilt session agree on the file root.
  if (record.rootDir !== rootDir) {
    await updateWorkspace(record.name, { rootDir });
  }
  const session = workspaceSessionName(record.name);

  // Same session bootstrap as workspaceOpen.
  const ensured = await ensureWorkspaceSession(session);

  // Pane members: recreate a window at rootDir per pane — only when the session
  // was freshly created this call. A re-restore of a LIVE ws keeps its existing
  // panes (idempotency; native persistence already holds them).
  let paneCount = 0;
  if (ensured.created) {
    for (const member of record.members) {
      if (member.kind !== "pane") continue;
      await openWorkspacePane(session, rootDir, member.command);
      paneCount += 1;
    }
  } else {
    paneCount = record.members.filter((m) => m.kind === "pane").length;
  }

  // Bee members: same resolution as workspaceOpen (records keyed by id ?? name).
  const index = await beeSessionIndex();
  const beeTargets: string[] = [];
  const seenBees = new Set<string>();
  let beeCount = 0;
  for (const member of record.members) {
    if (member.kind !== "bee") continue;
    // Defensive against a hand-edited record with a duplicate bee member: process
    // each beeId once so we never revive (or double-count) the same bee twice.
    if (seenBees.has(member.beeId)) continue;
    seenBees.add(member.beeId);
    const bee = resolveBeeMember(index, member.beeId);
    if (bee && bee.node && bee.node !== LOCAL_NODE_NAME) {
      // link-window cannot cross tmux servers; leave a remote bee for its node.
      console.error(note(`skip remote bee ${member.beeId} — restore links local windows only`));
      continue;
    }
    if (bee && index.liveNames.has(bee.tmuxTarget)) {
      // ALREADY live — never double-spawn (PRD §13). Just link it in + stamp.
      beeTargets.push(bee.tmuxTarget);
      beeCount += 1;
      await stampWorkspaceMembership(bee, record.name);
      continue;
    }
    if (bee) {
      // Dead bee with a record: re-spawn it into its own home. Default re-spawns
      // fresh; --resume continues from providerSessionId via resumeArgs.
      const revived = await reviveRecord(bee, { fresh: !opts.resume });
      // Re-read liveness: the freshly created session's window links in below.
      beeTargets.push(revived.tmuxTarget);
      beeCount += 1;
      await stampWorkspaceMembership(revived, record.name);
      continue;
    }
    // No record for beeId: a dead placeholder. Open a held shell window at the
    // root named after the bee so the user can re-spawn into it; mark it own so
    // `close` can reap it (it carries no live agent).
    await openWorkspacePlaceholder(session, rootDir, member.beeId);
    console.error(note(`could not revive bee ${member.beeId} — no record; left a placeholder window`));
  }
  // Link freshly-live bee windows into the session (the workspaceOpen path —
  // never reinvent link logic).
  await linkTargetsInto(session, beeTargets, ensured);

  // Phase 2 geometry: re-apply each window's saved window_layout by matching
  // window_name. Best-effort — a missing window is skipped; on a name collision
  // entries apply in order to whichever windows currently match.
  await applyWorkspaceLayout(session, record.layout ?? []);

  return { session, beeCount, paneCount };
}


/** Stamp a bee's workspaceId (and refresh its derived ws: tag) — workspaceOpen pattern. */
export async function stampWorkspaceMembership(bee: SessionRecord, workspaceName: string): Promise<void> {
  if (bee.workspaceId === workspaceName) return;
  await updateSession(bee.name, { workspaceId: workspaceName });
  await writeHiveTags({ ...bee, workspaceId: workspaceName });
}


/** A dead bee with no record: a window the user can re-spawn into (held shell, marked own). */
export async function openWorkspacePlaceholder(session: string, rootDir: string, label: string): Promise<void> {
  // A bare interactive shell holds the window open without a live agent.
  await openWorkspacePane(session, rootDir);
  // Best-effort label so the user recognizes which bee it stands in for.
  const result = await tmux(["list-windows", "-t", `=${session}:`, "-F", "#{window_id}"], { reject: false });
  const last = (result.ok ? result.stdout.split("\n").filter(Boolean) : []).at(-1);
  if (last) await tmux(["rename-window", "-t", `=${session}:${last}`, label], { reject: false });
}


/** Re-apply saved per-window geometry by matching window_name (best-effort). */
export async function applyWorkspaceLayout(session: string, layout: WorkspaceLayoutEntry[]): Promise<void> {
  if (layout.length === 0) return;
  const result = await tmux(["list-windows", "-t", `=${session}:`, "-F", "#{window_id}\t#{window_name}"], { reject: false });
  // window_name → ordered window_ids (a name may map to several windows).
  const byName = new Map<string, string[]>();
  for (const line of (result.ok ? result.stdout.split("\n") : []).filter(Boolean)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const windowId = line.slice(0, tab);
    const windowName = line.slice(tab + 1);
    const ids = byName.get(windowName);
    if (ids) ids.push(windowId);
    else byName.set(windowName, [windowId]);
  }
  for (const entry of layout) {
    const windowId = byName.get(entry.windowName)?.shift();
    if (!windowId) continue; // missing window — skip
    await tmux(["select-layout", "-t", `=${session}:${windowId}`, entry.layout], { reject: false });
  }
}


/**
 * `hive restore --all [--resume]` — sweep every NON-archived workspace and
 * rebuild it after a reboot (PRD §7.3/§11). Idempotent across the sweep (live
 * bees are skipped, never re-spawned). Without `--all`, prints usage.
 */
export async function cmdRestore(parsed: Parsed) {
  if (!truthy(flag(parsed, "all"))) {
    throw new Error("Usage: hive restore --all [--resume]   (or: hive workspace restore <name> [--resume])");
  }
  const resume = truthy(flag(parsed, "resume"));
  const workspaces = (await listWorkspaces()).filter((w) => !w.archived);
  let restored = 0;
  let bees = 0;
  let panes = 0;
  for (const record of workspaces) {
    const result = await restoreWorkspaceRecord(record, { resume });
    restored += 1;
    bees += result.beeCount;
    panes += result.paneCount;
    if (isPretty()) {
      console.log(actionLine("ok", "workspace", [bold(result.session), dim(`restored · ${result.beeCount} bee(s), ${result.paneCount} pane(s)`)]));
    } else {
      console.log(`workspace-restored\t${result.session}\t${result.beeCount}\t${result.paneCount}`);
    }
  }
  if (isPretty()) console.log(note(`restored ${restored} workspace(s) · ${bees} bee(s), ${panes} pane(s)`));
  else console.log(`restore\tall\t${restored}\t${bees}\t${panes}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QUESTS (WORKSPACES_AND_QUESTS_PRD §8, increment 9a — create/start/list/inspect)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


export async function workspaceClose(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace close <name>");
  const session = workspaceSessionName(name);
  if (!(await hasSession(session))) throw new Error(`No such workspace session: ${session}`);
  const result = await closeWorkspaceSession(session);
  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(session), dim(`closed, ${result.unlinked} bee window(s) unlinked`)]));
  else console.log(`workspace-closed\t${session}\t${result.unlinked}`);
}


/**
 * Tear down a workspace session WITHOUT ever killing a bee (the view invariant,
 * PRD §13), while still removing the workspace's OWN windows (the throwaway
 * placeholder and shell/command panes we created).
 *
 * The discriminator is PROVENANCE, not link topology: only a window WE created
 * carries the `@hive_ws_own` marker, so only those are kill-window'd. EVERY other
 * window is treated as a bee link and is only ever safe-unlinked WITHOUT -k — and
 * if that refuses (the ws is the window's last link, i.e. an orphaned bee whose
 * home session is gone) we ABORT the whole close, leaving the workspace intact and
 * the bee alive. An earlier "linked outside this group ⇒ bee" heuristic was unsound:
 * an orphaned bee has no outside link either, so it would have been kill-window'd.
 * view's uniform safe-unlink (a view holds only bees, no own windows) stays simpler;
 * this preserves the same guarantee — a bee never loses its home to a workspace close.
 */
export async function closeWorkspaceSession(session: string): Promise<{ sessions: string[]; unlinked: number }> {
  const groupSet = new Set(await tmuxGroupSessions(session));

  // Classify by PROVENANCE (the @hive_ws_own window marker), never by link
  // topology. A window the workspace created is marked and may be kill-window'd;
  // EVERY other window is a bee link and is only ever safe-unlinked WITHOUT -k,
  // aborting if it is the window's last link (an orphaned bee whose home session
  // is gone). The old "no link outside the group ⇒ ours" heuristic was unsound:
  // an orphaned bee also has no outside link, so it would have been killed.
  const listResult = await tmux(
    ["list-windows", "-t", `=${session}`, "-F", "#{window_id}\t#{@hive_ws_own}"],
    { reject: false },
  );
  const rows = listResult.ok ? listResult.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const ownWindows: string[] = [];
  const beeWindows: string[] = [];
  for (const row of rows) {
    const tab = row.indexOf("\t");
    const wid = tab >= 0 ? row.slice(0, tab) : row;
    const ownFlag = tab >= 0 ? row.slice(tab + 1).trim() : "";
    (ownFlag === "1" ? ownWindows : beeWindows).push(wid);
  }

  // First: safe-unlink every (potential) bee window, and ABORT before any
  // destruction if one refuses — so an aborted close leaves the workspace fully
  // intact and the orphaned bee alive.
  let unlinked = 0;
  for (const wid of beeWindows) {
    const result = await tmux(["unlink-window", "-t", `=${session}:${wid}`], { reject: false });
    if (!result.ok) {
      throw new Error(
        `Refusing to close ${session}: window ${wid} is a bee whose own session is gone ` +
          `(${result.stderr.trim() || "last link"}); re-home it first (hive workspace add <ws> <bee>) ` +
          `or attach to rescue it: tmux attach -t ${session}.`,
      );
    }
    unlinked += 1;
  }
  // Then: kill the windows the workspace owns, and the (now empty) group.
  for (const wid of ownWindows) {
    await tmux(["kill-window", "-t", `=${session}:${wid}`], { reject: false });
  }
  for (const s of groupSet) {
    await tmux(["kill-session", "-t", `=${s}`], { reject: false });
  }
  return { sessions: [...groupSet], unlinked };
}


/** The session group for `session` (itself + grouped `<session>-<n>` clients). */
export async function tmuxGroupSessions(session: string): Promise<string[]> {
  const groupResult = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_group}"], { reject: false });
  const pairs = (groupResult.ok ? groupResult.stdout.split("\n").filter(Boolean) : []).map((line) => {
    const tab = line.indexOf("\t");
    return [tab >= 0 ? line.slice(0, tab) : line, tab >= 0 ? line.slice(tab + 1) : ""] as const;
  });
  const group = pairs.find(([s]) => s === session)?.[1] ?? "";
  const sessions = pairs
    .filter(([s, g]) => s === session || (group.length > 0 && g === group && s.startsWith(`${session}-`)))
    .map(([s]) => s);
  if (!sessions.includes(session)) sessions.unshift(session);
  return sessions;
}


export async function workspaceRename(parsed: Parsed) {
  const from = parsed.args[1];
  const to = parsed.args[2];
  if (!from || !to) throw new Error("Usage: hive workspace rename <old> <new>");
  const record = await renameWorkspace(from, to);
  // Rename the live ws- session if present.
  const oldSession = workspaceSessionName(from);
  const newSession = workspaceSessionName(to);
  if (await hasSession(oldSession)) {
    // rename-session does not accept the `=name` exact prefix; target the bare
    // session name (it exists and is ws- prefixed, so no collision risk).
    await tmux(["rename-session", "-t", oldSession, newSession], { reject: false });
  }
  // Cascade workspaceId on member bees (cascadeColonyRename pattern).
  const sessions = await listSessions();
  for (const bee of sessions) {
    if (bee.workspaceId !== from) continue;
    await updateSession(bee.name, { workspaceId: to, updatedAt: new Date().toISOString() });
    await writeHiveTags({ ...bee, workspaceId: to });
  }
  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(record.name), dim(`renamed from ${from}`)]));
  else console.log(`workspace-renamed\t${from}\t${to}`);
}


export async function workspaceArchive(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive workspace archive <name>");
  const record = await archiveWorkspace(name);
  if (isPretty()) console.log(actionLine("ok", "workspace", [bold(record.name), dim("archived")]));
  else console.log(`workspace-archived\t${record.name}`);
}
