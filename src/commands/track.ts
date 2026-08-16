// `hive track` — reusable advisory work sequences attached to one live bee.
import { deliverPromptText, ensureLive, resolveBeeInCurrentPane, resolveSession, stringFlag } from "../cli/shared.js";
import { deliverSessionText, deliverSessionTextInAdmission, withRunnableSessionAdmission } from "../delivery.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, isPretty, note } from "../format.js";
import { writeHiveState } from "../hiveState.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { isRunnableSessionRecord } from "../stateMachine.js";
import type { SessionLifecycleTransaction } from "../lifecycle.js";
import type { SessionRecord } from "../store.js";
import {
  attachTrack,
  defineTrackFromFile,
  detachTrack,
  findTrackStateNode,
  flattenTrackNodes,
  flattenTrackStateNodes,
  listTracks,
  loadTrack,
  loadTrackAttachment,
  queueTrack,
  recordTrackException,
  updateTrackStep,
  updateTrackSubTask,
  type Track,
  type TrackAttachment,
  type TrackDelivery,
  type TrackNode,
  type TrackStepState,
  type TrackSubTaskStatus,
} from "../track.js";

const TRACK_USAGE = [
  "Usage:",
  "  hive track define <file.json|->",
  "  hive track list [--json]",
  "  hive track show <name> [--version <n>] [--json]",
  "  hive track attach <track> <bee> [--version <n>] [--start-at <stepId>]",
  "  hive track queue <track> <bee> [--version <n>] [--queued-by <who>]",
  "  hive track queue-list <bee> [--json]",
  "  hive track status [<bee>] [--json]",
  "  hive track detach <bee> [--exception <why>] [--step <id>]",
  "  hive track step <id> done|skip [--note <text>]",
  "  hive track subtask <name> queued|running|done [--step <id>]",
  '  hive track exception "<why>" [--step <id>]',
].join("\n");

export async function cmdTrack(parsed: Parsed): Promise<void> {
  const sub = parsed.args[0];
  switch (sub) {
    case "define":
      return trackDefine(parsed);
    case "list":
    case "ls":
      return trackList(parsed);
    case "show":
      return trackShow(parsed);
    case "attach":
      return trackAttach(parsed);
    case "queue":
      return trackQueue(parsed);
    case "queue-list":
      return trackQueueList(parsed);
    case "status":
      return trackStatus(parsed);
    case "detach":
      return trackDetach(parsed);
    case "step":
      return trackStep(parsed);
    case "subtask":
      return trackSubTask(parsed);
    case "exception":
      return trackException(parsed);
    default:
      throw new Error(`Unknown track subcommand: ${sub ?? ""}\n${TRACK_USAGE}`);
  }
}

async function trackDefine(parsed: Parsed): Promise<void> {
  const source = parsed.args[1];
  if (!source) throw new Error("Usage: hive track define <file.json|->");
  const track = await defineTrackFromFile(source);
  const count = flattenTrackNodes(track.items).length;
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(track, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "track", [bold(`${track.name}@${track.version}`), `${count} nodes`]));
  } else {
    console.log(`defined\t${track.name}\t${track.version}\t${count}`);
  }
}

async function trackList(parsed: Parsed): Promise<void> {
  const tracks = await listTracks();
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(tracks, null, 2));
    return;
  }
  if (tracks.length === 0) {
    console.log(isPretty() ? note("no tracks defined") : "no-tracks");
    return;
  }
  if (!isPretty()) {
    for (const track of tracks) {
      console.log(`${track.name}\t${track.version}\t${flattenTrackNodes(track.items).length}\t${track.description ?? ""}`);
    }
    return;
  }
  console.log(formatTable(
    [{ header: "NAME" }, { header: "VERSION", align: "right" }, { header: "NODES", align: "right" }, { header: "DESCRIPTION" }],
    tracks.map((track) => [
      bold(track.name),
      String(track.version),
      String(flattenTrackNodes(track.items).length),
      dim(track.description ?? ""),
    ]),
  ));
}

async function trackShow(parsed: Parsed): Promise<void> {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive track show <name> [--version <n>]");
  const version = versionFlag(parsed);
  const track = await loadTrack(name, version);
  if (!track) throw new Error(version ? `Unknown track: ${name}@${version}` : `Unknown track: ${name}`);
  if (truthy(flag(parsed, "json")) || !isPretty()) {
    console.log(JSON.stringify(track, null, 2));
    return;
  }
  console.log(`${bold(`${track.name}@${track.version}`)}${track.description ? `  ${dim(track.description)}` : ""}`);
  renderDefinition(track).forEach((line) => console.log(line));
}

function renderDefinition(track: Track): string[] {
  const lines: string[] = [];
  let ordinal = 0;
  for (const item of track.items) {
    if ("branch" in item) {
      lines.push(`  ${bold("branch")} ${dim("parallel lanes · unordered")}`);
      item.branch.forEach((lane, laneIndex) => {
        lines.push(`    ${dim(`lane ${laneIndex + 1}${lane[0]?.when ? ` · when ${lane[0].when}` : ""}`)}`);
        lane.forEach((node) => lines.push(renderDefinitionNode(node, ++ordinal, "      ")));
      });
    } else {
      lines.push(renderDefinitionNode(item, ++ordinal, "  "));
    }
  }
  return lines;
}

function renderDefinitionNode(node: TrackNode, ordinal: number, indent: string): string {
  return `${indent}${dim(String(ordinal).padStart(2, " "))}. ${bold(node.id)}  ${dim(node.type)}  ${node.name}`;
}

async function trackAttach(parsed: Parsed): Promise<void> {
  const trackName = parsed.args[1];
  const beeRef = parsed.args[2];
  if (!trackName || !beeRef) {
    throw new Error("Usage: hive track attach <track> <bee> [--version <n>] [--start-at <stepId>]");
  }
  const bee = await resolveSession(beeRef);
  if (!isRunnableSessionRecord(bee)) throw new Error(`Bee ${bee.name} is terminal (${bee.status})`);
  await ensureLive(bee);

  const attachment = await withRunnableSessionAdmission(bee, (lifecycle, admitted) =>
    attachTrack(trackName, {
      bee: admitted.name,
      ...(admitted.id ? { beeId: admitted.id } : {}),
      ...(versionFlag(parsed) !== undefined ? { version: versionFlag(parsed) } : {}),
      ...(stringFlag(parsed, ["start-at"]) ? { startAt: stringFlag(parsed, ["start-at"]) } : {}),
      deliver: deliveryForBeeInAdmission(lifecycle, admitted),
    }), { operation: "hive track attach" });

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(attachment, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "track", [
      bold(`${attachment.track}@${attachment.version}`),
      `attached to ${bold(attachment.bee)}`,
      `${attachment.steps.length} nodes`,
    ]));
  } else {
    console.log(`attached\t${attachment.track}\t${attachment.version}\t${attachment.bee}\t${attachment.steps.length}`);
  }
}

async function trackQueue(parsed: Parsed): Promise<void> {
  const trackName = parsed.args[1];
  const beeRef = parsed.args[2];
  if (!trackName || !beeRef) {
    throw new Error("Usage: hive track queue <track> <bee> [--version <n>] [--queued-by <who>]");
  }
  const bee = await resolveSession(beeRef);
  const attachment = await queueTrackForBee(trackName, bee, {
    ...(versionFlag(parsed) !== undefined ? { version: versionFlag(parsed) } : {}),
    queuedBy: stringFlag(parsed, ["queued-by"]) ?? process.env.HIVE_BEE ?? "operator",
  });
  const entry = attachment.queue.at(-1)!;
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(entry, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "queue", [bold(entry.track), `for ${bold(attachment.bee)}`, `position ${attachment.queue.length}`]));
  } else {
    console.log(`queued\t${entry.track}\t${attachment.bee}\t${attachment.queue.length}`);
  }
}

/** Lifecycle-linearized future-work enqueue; attachment locking stays inner. */
export async function queueTrackForBee(
  trackName: string,
  bee: SessionRecord,
  options: { version?: number; queuedBy: string; now?: () => Date },
): Promise<TrackAttachment> {
  return withRunnableSessionAdmission(bee, (_lifecycle, admitted) =>
    queueTrack(trackName, admitted.name, options), { operation: "hive track queue" });
}

async function trackQueueList(parsed: Parsed): Promise<void> {
  const beeRef = parsed.args[1];
  if (!beeRef) throw new Error("Usage: hive track queue-list <bee>");
  const bee = await resolveSession(beeRef);
  const attachment = await loadTrackAttachment(bee.name);
  if (!attachment) throw new Error(`Bee ${bee.name} has no active track`);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(attachment.queue, null, 2));
    return;
  }
  if (attachment.queue.length === 0) {
    console.log(isPretty() ? note(`no queued tracks for ${bee.name}`) : "no-queued-tracks");
    return;
  }
  if (!isPretty()) {
    attachment.queue.forEach((entry, index) =>
      console.log(`${index + 1}\t${entry.track}\t${entry.version ?? ""}\t${entry.queuedAt}\t${entry.queuedBy}`)
    );
    return;
  }
  console.log(formatTable(
    [{ header: "#" }, { header: "TRACK" }, { header: "VERSION" }, { header: "QUEUED BY" }, { header: "WHEN" }],
    attachment.queue.map((entry, index) => [
      String(index + 1),
      bold(entry.track),
      entry.version === undefined ? dim("latest") : String(entry.version),
      entry.queuedBy,
      dim(entry.queuedAt),
    ]),
  ));
}

function deliveryForBeeInAdmission(
  lifecycle: SessionLifecycleTransaction,
  bee: SessionRecord,
): TrackDelivery {
  let current = bee;
  return async (postscript) => {
    const delivered = await deliverSessionTextInAdmission(lifecycle, current, postscript, {
      deliver: deliverPromptText,
    });
    current = delivered.record;
    await writeHiveState(current, "working").catch(() => undefined);
  };
}

export type TrackFollowUpOptions = {
  deliver?: (bee: SessionRecord, postscript: string) => Promise<void>;
  writeState?: typeof writeHiveState;
  now?: () => Date;
};

/**
 * Deliver track standing instructions as a real next turn. Queued-track
 * follow-ups can target a warm runtime whose previous turn is sealed/done;
 * snapshot that boundary before delivery, then clear it only after delivery
 * succeeds so the record re-enters the operational active index.
 */
export async function deliverTrackFollowUp(
  bee: SessionRecord,
  postscript: string,
  options: TrackFollowUpOptions = {},
): Promise<void> {
  const delivered = await deliverSessionText(bee, postscript, {
    deliver: options.deliver ?? deliverPromptText,
    now: options.now,
  });
  await (options.writeState ?? writeHiveState)(delivered.record, "working").catch(() => undefined);
}

async function trackStatus(parsed: Parsed): Promise<void> {
  const bee = parsed.args[1] ? await resolveSession(parsed.args[1]!) : await requireSelf("track status");
  const attachment = await loadTrackAttachment(bee.name);
  if (!attachment) throw new Error(`Bee ${bee.name} has no active track`);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(attachment, null, 2));
    return;
  }
  console.log(renderTrackStatus(attachment));
}

async function trackDetach(parsed: Parsed): Promise<void> {
  const beeRef = parsed.args[1];
  if (!beeRef) throw new Error("Usage: hive track detach <bee> [--exception <why>] [--step <id>]");
  const bee = await resolveSession(beeRef);
  const attachment = await withRunnableSessionAdmission(bee, (lifecycle, admitted) =>
    detachTrack(admitted.name, {
      ...(stringFlag(parsed, ["exception"]) ? { exception: stringFlag(parsed, ["exception"]) } : {}),
      ...(stringFlag(parsed, ["step"]) ? { stepId: stringFlag(parsed, ["step"]) } : {}),
      deliver: deliveryForBeeInAdmission(lifecycle, admitted),
    }), { operation: "hive track detach" });
  const active = await loadTrackAttachment(bee.name);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(attachment, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "track", [
      bold(`${attachment.track}@${attachment.version}`),
      `detached from ${bold(attachment.bee)}`,
      ...(active ? [`next ${bold(`${active.track}@${active.version}`)}`] : []),
    ]));
  } else {
    console.log(`detached\t${attachment.track}\t${attachment.bee}${active ? `\tattached\t${active.track}\t${active.version}` : ""}`);
  }
}

async function trackStep(parsed: Parsed): Promise<void> {
  const stepId = parsed.args[1];
  const action = parsed.args[2];
  if (!stepId || (action !== "done" && action !== "skip")) {
    throw new Error("Usage: hive track step <id> done|skip [--note <text>]");
  }
  const noteText = stringFlag(parsed, ["note"]);
  const bee = await requireSelf("track step");
  const attachment = await withRunnableSessionAdmission(bee, (lifecycle, admitted) =>
    updateTrackStep(
      admitted.name,
      stepId,
      action === "done" ? "done" : "skipped",
      noteText,
      () => new Date(),
      { deliver: deliveryForBeeInAdmission(lifecycle, admitted) },
    ), { operation: "hive track step" });
  // Outcome-arm nodes intentionally do not appear in the legacy main-spine
  // `steps` projection, so fall back to their canonical v2 runtime node.
  const legacyStep = attachment.steps.find((candidate) => candidate.id === stepId);
  const node = findTrackStateNode(attachment.items, stepId);
  if (!node) throw new Error(`Track ${attachment.track} has no step "${stepId}"`);
  const output = legacyStep ?? node;
  const outputNote = legacyStep?.note ?? node.statusNote;
  const active = await loadTrackAttachment(bee.name);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(output, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "step", [
      bold(output.id),
      output.status,
      dim(outputNote ?? ""),
      ...(active && (active.track !== attachment.track || active.version !== attachment.version)
        ? [`next ${bold(`${active.track}@${active.version}`)}`]
        : []),
    ]));
  } else {
    console.log(`track.step\t${attachment.track}\t${output.id}\t${output.status}\t${output.updatedAt}`);
  }
}

async function trackSubTask(parsed: Parsed): Promise<void> {
  const name = parsed.args[1];
  const status = parsed.args[2];
  if (!name || !status || !["queued", "running", "done"].includes(status)) {
    throw new Error("Usage: hive track subtask <name> queued|running|done [--step <id>]");
  }
  const bee = await requireSelf("track subtask");
  const attachment = await updateTrackSubTask(bee.name, name, status as TrackSubTaskStatus, {
    ...(stringFlag(parsed, ["step"]) ? { stepId: stringFlag(parsed, ["step"]) } : {}),
  });
  const subTask = flattenTrackStateNodes(attachment.items)
    .flatMap((node) => node.subTasks.map((entry) => ({ ...entry, stepId: node.id })))
    .find((entry) => entry.name === name)!;
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(subTask, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "subtask", [bold(name), status, dim(`step ${subTask.stepId}`)]));
  } else {
    console.log(`track.subtask\t${attachment.track}\t${subTask.stepId}\t${name}\t${status}`);
  }
}

async function trackException(parsed: Parsed): Promise<void> {
  const why = parsed.args.slice(1).join(" ").trim();
  if (!why) throw new Error('Usage: hive track exception "<why>" [--step <id>]');
  const bee = await requireSelf("track exception");
  const stepId = stringFlag(parsed, ["step"]);
  const attachment = await recordTrackException(bee.name, why, { ...(stepId ? { stepId } : {}) });
  const exception = attachment.exceptions.at(-1)!;
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(exception, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "except", [bold(attachment.track), ...(stepId ? [dim(`step ${stepId}`)] : []), why]));
  } else {
    console.log(`track.exception\t${attachment.track}\t${exception.at}\t${stepId ?? ""}\t${why}`);
  }
}

function versionFlag(parsed: Parsed): number | undefined {
  const raw = flag(parsed, "version");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error("--version must be an integer >= 1");
  }
  return Number(raw);
}

async function requireSelf(command: string): Promise<SessionRecord> {
  const bee = await resolveBeeInCurrentPane();
  if (bee) return bee;
  throw new Error(`hive ${command}: no current bee resolved from HIVE_BEE or the current pane`);
}

export function renderTrackStatus(attachment: TrackAttachment, now: number = Date.now()): string {
  const done = attachment.steps.filter((step) => step.status === "done").length;
  const skipped = attachment.steps.filter((step) => step.status === "skipped").length;
  const lines = [
    `${bold("Track")} ${bold(`${attachment.track}@${attachment.version}`)} ${dim("·")} ${attachment.bee} ${dim(`· ${done} done${skipped ? `, ${skipped} skipped` : ""}/${attachment.steps.length}`)}`,
  ];
  for (const step of attachment.steps) {
    lines.push(renderStep(step, now));
    if (step.description) lines.push(`      ${dim(step.description)}`);
    if (step.note) lines.push(`      ${dim(`note: ${step.note}`)}`);
    for (const subTask of step.subTasks ?? []) {
      lines.push(`      ${dim(`└ ${subTask.name} · ${subTask.status}`)}`);
    }
  }
  lines.push("");
  lines.push(bold(`Exceptions (${attachment.exceptions.length})`));
  if (attachment.exceptions.length === 0) {
    lines.push(`  ${dim("none")}`);
  } else {
    for (const exception of attachment.exceptions) {
      lines.push(`  ! ${exception.stepId ? `[${exception.stepId}] ` : ""}${exception.note} ${dim(`(${formatRelativeTime(exception.at, now)} ago)`)}`);
    }
  }
  if (attachment.queue.length > 0) {
    lines.push("");
    lines.push(bold(`Up next (${attachment.queue.length})`));
    attachment.queue.forEach((entry, index) => {
      lines.push(`  ${index + 1}. ${entry.track}${entry.version ? `@${entry.version}` : ""} ${dim(`· ${entry.queuedBy}`)}`);
    });
  }
  return lines.join("\n");
}

function renderStep(step: TrackStepState, now: number): string {
  const mark = step.status === "done" ? "[✓]" : step.status === "skipped" ? "[-]" : "[ ]";
  const age = formatRelativeTime(step.updatedAt, now);
  return `  ${mark} ${bold(step.id)}  ${step.title}  ${dim(`${step.status} · ${age} ago`)}`;
}
