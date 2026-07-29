// `hive track` — reusable expected-step sequences attached to one live bee.
import { deliverPromptText, ensureLive, resolveBeeInCurrentPane, resolveSession, stringFlag } from "../cli/shared.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, isPretty, note } from "../format.js";
import { writeHiveState } from "../hiveState.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { updateSession, type SessionRecord } from "../store.js";
import {
  attachTrack,
  defineTrackFromFile,
  detachTrack,
  listTracks,
  loadTrack,
  loadTrackAttachment,
  recordTrackException,
  updateTrackStep,
  type TrackAttachment,
  type TrackStepState,
} from "../track.js";

const TRACK_USAGE = [
  "Usage:",
  "  hive track define <file.json|->",
  "  hive track list [--json]",
  "  hive track show <name> [--json]",
  "  hive track attach <track> <bee>",
  "  hive track status [<bee>] [--json]",
  "  hive track detach <bee>",
  "  hive track step <id> done|skip [--note <text>]",
  '  hive track exception "<why>"',
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
    case "status":
      return trackStatus(parsed);
    case "detach":
      return trackDetach(parsed);
    case "step":
      return trackStep(parsed);
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
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(track, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "track", [bold(track.name), `${track.steps.length} steps`]));
  } else {
    console.log(`defined\t${track.name}\t${track.steps.length}`);
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
      console.log(`${track.name}\t${track.steps.length}\t${track.description ?? ""}`);
    }
    return;
  }
  console.log(formatTable(
    [{ header: "NAME" }, { header: "STEPS", align: "right" }, { header: "DESCRIPTION" }],
    tracks.map((track) => [bold(track.name), String(track.steps.length), dim(track.description ?? "")]),
  ));
}

async function trackShow(parsed: Parsed): Promise<void> {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive track show <name>");
  const track = await loadTrack(name);
  if (!track) throw new Error(`Unknown track: ${name}`);
  if (truthy(flag(parsed, "json")) || !isPretty()) {
    console.log(JSON.stringify(track, null, 2));
    return;
  }
  console.log(`${bold(track.name)}${track.description ? `  ${dim(track.description)}` : ""}`);
  track.steps.forEach((step, index) => {
    console.log(`  ${dim(String(index + 1).padStart(2, " "))}. ${bold(step.id)}  ${step.title}`);
    if (step.description) console.log(`      ${dim(step.description)}`);
  });
}

async function trackAttach(parsed: Parsed): Promise<void> {
  const trackName = parsed.args[1];
  const beeRef = parsed.args[2];
  if (!trackName || !beeRef) throw new Error("Usage: hive track attach <track> <bee>");
  const bee = await resolveSession(beeRef);
  if (bee.status !== "running") throw new Error(`Bee ${bee.name} is terminal (${bee.status})`);
  await ensureLive(bee);

  let deliveredPostscript = "";
  const attachment = await attachTrack(trackName, {
    bee: bee.name,
    ...(bee.id ? { beeId: bee.id } : {}),
    deliver: async (postscript) => {
      deliveredPostscript = postscript;
      // Same delivery choke point as `hive send`/comb adoption: HSR turns
      // interject or queue through the runner host; tmux bees receive a
      // pane-pinned paste. No second transport or daemon path is introduced.
      await deliverPromptText(bee, postscript);
    },
  });
  await recordTrackPrompt(bee, deliveredPostscript);

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(attachment, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "track", [bold(attachment.track), `attached to ${bold(attachment.bee)}`, `${attachment.steps.length} steps`]));
  } else {
    console.log(`attached\t${attachment.track}\t${attachment.bee}\t${attachment.steps.length}`);
  }
}

async function recordTrackPrompt(bee: SessionRecord, postscript: string): Promise<void> {
  const at = new Date().toISOString();
  await updateSession(bee.name, {
    updatedAt: at,
    status: "running",
    lastPrompt: postscript,
    lastPromptAt: at,
  });
  await writeHiveState(bee, "working");
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
  if (!beeRef) throw new Error("Usage: hive track detach <bee>");
  const bee = await resolveSession(beeRef);
  const attachment = await detachTrack(bee.name);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(attachment, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "track", [bold(attachment.track), `detached from ${bold(attachment.bee)}`]));
  } else {
    console.log(`detached\t${attachment.track}\t${attachment.bee}`);
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
  const attachment = await updateTrackStep(bee.name, stepId, action === "done" ? "done" : "skipped", noteText);
  const step = attachment.steps.find((candidate) => candidate.id === stepId)!;
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(step, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "step", [bold(step.id), step.status, dim(step.note ?? "")]));
  } else {
    console.log(`track.step\t${attachment.track}\t${step.id}\t${step.status}\t${step.updatedAt}`);
  }
}

async function trackException(parsed: Parsed): Promise<void> {
  const why = parsed.args.slice(1).join(" ").trim();
  if (!why) throw new Error('Usage: hive track exception "<why>"');
  const bee = await requireSelf("track exception");
  const attachment = await recordTrackException(bee.name, why);
  const exception = attachment.exceptions.at(-1)!;
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(exception, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "except", [bold(attachment.track), why]));
  } else {
    console.log(`track.exception\t${attachment.track}\t${exception.at}\t${why}`);
  }
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
    `${bold("Track")} ${bold(attachment.track)} ${dim("·")} ${attachment.bee} ${dim(`· ${done} done${skipped ? `, ${skipped} skipped` : ""}/${attachment.steps.length}`)}`,
  ];
  for (const step of attachment.steps) {
    lines.push(renderStep(step, now));
    if (step.description) lines.push(`      ${dim(step.description)}`);
    if (step.note) lines.push(`      ${dim(`note: ${step.note}`)}`);
  }
  lines.push("");
  lines.push(bold(`Exceptions (${attachment.exceptions.length})`));
  if (attachment.exceptions.length === 0) {
    lines.push(`  ${dim("none")}`);
  } else {
    for (const exception of attachment.exceptions) {
      lines.push(`  ! ${exception.note} ${dim(`(${formatRelativeTime(exception.at, now)} ago)`)}`);
    }
  }
  return lines.join("\n");
}

function renderStep(step: TrackStepState, now: number): string {
  const mark = step.status === "done" ? "[✓]" : step.status === "skipped" ? "[-]" : "[ ]";
  const age = formatRelativeTime(step.updatedAt, now);
  return `  ${mark} ${bold(step.id)}  ${step.title}  ${dim(`${step.status} · ${age} ago`)}`;
}
