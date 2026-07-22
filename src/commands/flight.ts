// `hive flight` — fixed-capacity worker flights (CL.701 §4.2). A flight is a
// maintained invariant: N slots, a declared model mix, a completion contract,
// and evidence-driven replacement. `start` records the desired state; the
// daemon's sweeper (or an explicit `hive flight sweep`) reconciles toward it.
// `status` is computed from disk and works with the daemon down.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { actionLine, bold, dim, formatRelativeTime, isPretty, note } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { stringFlag } from "../cli/shared.js";
import { SEAL_TYPES, type SealType } from "../seal.js";
import { resolveSpawningBeeId } from "../spawnParent.js";
import { appendLedger, listSessions, loadSession, type SessionRecord } from "../store.js";
import type { BeeState } from "../state.js";
import { createFlightSweeper } from "../daemon/flightSweep.js";
import { paneActivitySignal, type BeeActivitySignal } from "../flight/controller.js";
import { substrateFor } from "../substrates/index.js";
import {
  allocateFlightId,
  enqueueTask,
  finishTask,
  requeueTask,
  listFlights,
  listSlots,
  listTasks,
  loadFlight,
  saveFlight,
  saveSlot,
  taskCounts,
} from "../flight/store.js";
import {
  FLIGHT_CONTRACT_DEFAULTS,
  FLIGHT_REPLACEMENT_DEFAULTS,
  type FlightMixEntry,
  type FlightRecord,
  type SlotRecord,
} from "../flight/types.js";

const USAGE = `Usage:
  hive flight start --name <name> --cwd <dir> (--mix <key=agent[/model][@account]:count>... | --agent <a> --slots <n>)
                    [--brief <text> | --brief-file <path>] [--colony <c>] [--completion seal|exit] [--seal-type <${SEAL_TYPES.join("|")}>]
                    [--readiness-ms <n>] [--first-evidence-ms <n>] [--stall-ms <n>] [--max-attempts <n>] [--max-boots <n>]
  hive flight enqueue <id|name> (--task-id <id> (--brief <text> | --brief-file <path>) [--cwd <dir>] | --from-dir <dir>)
  hive flight queue <id|name> [--json]
  hive flight ls [--json]
  hive flight status <id|name> [--json]
  hive flight sweep [<id|name>]
  hive flight resolve <id|name> <slotId> (--retry | --abandon | --accept)
  hive flight requeue <id|name> <taskId>
  hive flight drain <id|name>
  hive flight close <id|name>`;

export async function cmdFlight(parsed: Parsed): Promise<void> {
  const sub = parsed.args[0];
  switch (sub) {
    case "start":
      return flightStart(parsed);
    case "ls":
    case "list":
      return flightLs(parsed);
    case "status":
      return flightStatus(parsed);
    case "sweep":
      return flightSweep(parsed);
    case "enqueue":
      return flightEnqueue(parsed);
    case "queue":
      return flightQueue(parsed);
    case "resolve":
      return flightResolve(parsed);
    case "requeue":
      return flightRequeue(parsed);
    case "drain":
      return flightSetStatus(parsed, "draining");
    case "close":
      return flightSetStatus(parsed, "closed");
    default:
      throw new Error(`Unknown flight subcommand: ${sub ?? "(none)"}\n${USAGE}`);
  }
}

/** `key=agent[/model][@account]:count` → FlightMixEntry. */
export function parseMixFlag(raw: string): FlightMixEntry {
  const match = /^([A-Za-z0-9_.-]+)=([A-Za-z0-9_.-]+)(?:\/([^@:]+))?(?:@([^:]+))?:(\d+)$/.exec(raw.trim());
  if (!match) throw new Error(`--mix expects key=agent[/model][@account]:count (got: ${raw})`);
  const count = Number(match[5]);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`--mix count must be a positive integer (got: ${raw})`);
  return {
    key: match[1]!,
    agent: match[2]!,
    ...(match[3] ? { model: match[3] } : {}),
    ...(match[4] ? { account: match[4] } : {}),
    count,
  };
}

function numberFlagOr(parsed: Parsed, name: string, fallback: number): number {
  const raw = stringFlag(parsed, [name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number (got: ${raw})`);
  return value;
}

async function flightStart(parsed: Parsed): Promise<void> {
  const name = stringFlag(parsed, ["name"]);
  const cwd = stringFlag(parsed, ["cwd"]) ?? process.cwd();
  if (!name) throw new Error(`--name is required\n${USAGE}`);

  const mixRaw = flag(parsed, "mix");
  const mixValues = mixRaw === undefined ? [] : (Array.isArray(mixRaw) ? mixRaw : [mixRaw]).map((v) => String(v));
  let mix: FlightMixEntry[];
  if (mixValues.length > 0) {
    mix = mixValues.map(parseMixFlag);
    const keys = new Set(mix.map((entry) => entry.key));
    if (keys.size !== mix.length) throw new Error("--mix keys must be unique");
  } else {
    const agent = stringFlag(parsed, ["agent"]);
    const slots = numberFlagOr(parsed, "slots", 0);
    if (!agent || slots < 1) throw new Error(`pass --mix, or --agent with --slots\n${USAGE}`);
    const account = stringFlag(parsed, ["account"]);
    const model = stringFlag(parsed, ["model"]);
    mix = [{ key: agent, agent, count: Math.floor(slots), ...(model ? { model } : {}), ...(account ? { account } : {}) }];
  }
  const totalSlots = mix.reduce((sum, entry) => sum + entry.count, 0);

  const briefFile = stringFlag(parsed, ["brief-file"]);
  const briefText = stringFlag(parsed, ["brief"]);
  if (briefFile && briefText) throw new Error("--brief and --brief-file are mutually exclusive");
  const brief = briefFile ? await readFile(briefFile, "utf8") : briefText;

  const completionRaw = stringFlag(parsed, ["completion"]) ?? "seal";
  if (completionRaw !== "seal" && completionRaw !== "exit") throw new Error("--completion must be seal or exit");
  const sealType = stringFlag(parsed, ["seal-type"]);
  if (sealType !== undefined && !(SEAL_TYPES as readonly string[]).includes(sealType)) {
    throw new Error(`--seal-type must be one of: ${SEAL_TYPES.join(", ")}`);
  }

  const now = new Date().toISOString();
  const flight: FlightRecord = {
    id: allocateFlightId(),
    name,
    ...(stringFlag(parsed, ["colony"]) ? { colony: stringFlag(parsed, ["colony"])! } : {}),
    ...((await resolveSpawningBeeId()) ? { createdBy: (await resolveSpawningBeeId())! } : {}),
    cwd,
    ...(brief ? { brief } : {}),
    target: { slots: totalSlots, mix },
    contract: {
      completion: completionRaw,
      ...(sealType ? { sealType: sealType as SealType } : {}),
      readinessDeadlineMs: numberFlagOr(parsed, "readiness-ms", FLIGHT_CONTRACT_DEFAULTS.readinessDeadlineMs),
      firstEvidenceDeadlineMs: numberFlagOr(parsed, "first-evidence-ms", FLIGHT_CONTRACT_DEFAULTS.firstEvidenceDeadlineMs),
      stallMs: numberFlagOr(parsed, "stall-ms", FLIGHT_CONTRACT_DEFAULTS.stallMs),
      maxAttemptsPerSlot: numberFlagOr(parsed, "max-attempts", FLIGHT_CONTRACT_DEFAULTS.maxAttemptsPerSlot),
    },
    replacement: {
      policy: "replace-before-collect",
      maxConcurrentBoots: numberFlagOr(parsed, "max-boots", FLIGHT_REPLACEMENT_DEFAULTS.maxConcurrentBoots),
    },
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await saveFlight(flight);

  // Slot files: s1..sN, assigned to mixes in declaration order, all vacant —
  // the sweeper fills them under backpressure.
  let slotIndex = 0;
  for (const entry of mix) {
    for (let i = 0; i < entry.count; i += 1) {
      slotIndex += 1;
      const slot: SlotRecord = {
        flightId: flight.id,
        slotId: `s${slotIndex}`,
        mixKey: entry.key,
        generation: 0,
        attempt: 0,
        state: "vacant",
        since: now,
        evidence: {},
        history: [],
      };
      await saveSlot(slot);
    }
  }

  await appendLedger({ type: "flight.created", flight: flight.id, name: flight.name, slots: totalSlots, mix: mix.map((m) => `${m.key}×${m.count}`).join(",") });

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ flight, slots: totalSlots }, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "flight", [bold(flight.id), name, `${totalSlots} slots`, dim(mix.map((m) => `${m.key}×${m.count}`).join(" "))]));
    console.log(note("slots are vacant; the daemon's sweeper fills them (or run: hive flight sweep " + flight.id + ")"));
  } else {
    console.log(`${flight.id}\t${name}\t${totalSlots}`);
  }
}

async function resolveFlight(ref: string | undefined): Promise<FlightRecord> {
  if (!ref) throw new Error(`flight id or name required\n${USAGE}`);
  const direct = await loadFlight(ref);
  if (direct) return direct;
  const flights = await listFlights();
  const matches = flights.filter((flight) => flight.id === ref || flight.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`flight name ${ref} is ambiguous: ${matches.map((f) => f.id).join(", ")}`);
  throw new Error(`no flight matches ${ref}`);
}

async function flightLs(parsed: Parsed): Promise<void> {
  const flights = await listFlights();
  const rows = [] as Array<Record<string, unknown>>;
  for (const flight of flights) {
    const slots = await listSlots(flight.id);
    rows.push({
      id: flight.id,
      name: flight.name,
      status: flight.status,
      slots: flight.target.slots,
      done: slots.filter((slot) => slot.state === "done").length,
      working: slots.filter((slot) => slot.state === "working").length,
      attention: slots.filter((slot) => slot.state === "stalled" || slot.state === "blocked" || slot.state === "escalated" || slot.state === "abandoned").length,
    });
  }
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(isPretty() ? note("no flights") : "no-flights");
    return;
  }
  for (const row of rows) {
    if (isPretty()) {
      console.log(`${bold(String(row.id))} ${row.name} ${dim(String(row.status))} done ${row.done}/${row.slots} working ${row.working}${Number(row.attention) > 0 ? ` attention ${row.attention}` : ""}`);
    } else {
      console.log(`${row.id}\t${row.name}\t${row.status}\t${row.done}/${row.slots}\t${row.working}\t${row.attention}`);
    }
  }
}

export type FlightStatusReport = {
  flight: FlightRecord;
  slots: Array<SlotRecord & { beeState?: string }>;
  summary: {
    total: number;
    done: number;
    /** working WITH first evidence — never derived from idle (CL.701 G3). */
    productive: number;
    booting: number;
    vacant: number;
    drained: number;
    attention: number;
    abandoned: number;
  };
  /** Queue bucket counts (v1.1); absent for fixed-batch flights. */
  queue?: { pending: number; leased: number; done: number; failed: number };
};

export async function buildFlightStatus(flight: FlightRecord, sessions: SessionRecord[]): Promise<FlightStatusReport> {
  const slots = await listSlots(flight.id);
  const byName = new Map(sessions.map((record) => [record.name, record]));
  const rows = slots.map((slot) => ({
    ...slot,
    ...(slot.beeName && byName.get(slot.beeName)?.lastObservedState ? { beeState: byName.get(slot.beeName)!.lastObservedState! } : {}),
  }));
  const counts = await taskCounts(flight.id);
  const queueBacked = counts.pending + counts.leased + counts.done + counts.failed > 0;
  return {
    flight,
    slots: rows,
    summary: {
      total: slots.length,
      done: slots.filter((slot) => slot.state === "done").length,
      productive: slots.filter((slot) => slot.state === "working" && slot.evidence.firstEvidenceAt).length,
      booting: slots.filter((slot) => slot.state === "provisioning" || slot.state === "booting").length,
      vacant: slots.filter((slot) => slot.state === "vacant").length,
      drained: slots.filter((slot) => slot.state === "drained").length,
      attention: slots.filter((slot) => slot.state === "stalled" || slot.state === "blocked" || slot.state === "escalated").length,
      abandoned: slots.filter((slot) => slot.state === "abandoned").length,
    },
    ...(queueBacked ? { queue: counts } : {}),
  };
}

async function flightStatus(parsed: Parsed): Promise<void> {
  const flight = await resolveFlight(parsed.args[1]);
  const report = await buildFlightStatus(flight, await listSessions());
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const s = report.summary;
  const queueLine = report.queue
    ? `  queue: pending ${report.queue.pending} leased ${report.queue.leased} done ${report.queue.done} failed ${report.queue.failed}`
    : "";
  if (isPretty()) {
    console.log(`${bold(flight.id)} ${flight.name} ${dim(flight.status)}  done ${s.done}/${s.total}  productive ${s.productive}  booting ${s.booting}  vacant ${s.vacant}${s.drained > 0 ? `  drained ${s.drained}` : ""}${s.attention > 0 ? `  ${bold("attention " + s.attention)}` : ""}${s.abandoned > 0 ? `  abandoned ${s.abandoned}` : ""}`);
    if (queueLine) console.log(dim(queueLine));
    for (const slot of report.slots) {
      const age = formatRelativeTime(slot.since);
      console.log(
        `  ${slot.slotId.padEnd(4)} ${slot.state.padEnd(12)} ${dim(`g${slot.generation} a${slot.attempt}`)} ${slot.taskId ? `${slot.taskId} ` : ""}${slot.beeName ?? dim("(no bee)")}${slot.beeState ? dim(` [${slot.beeState}]`) : ""} ${dim(`${age} ago`)}${slot.evidence.sealFilename ? dim(" sealed") : ""}`,
      );
    }
  } else {
    console.log(`${flight.id}\t${flight.name}\t${flight.status}\t${s.done}/${s.total}\t${s.productive}\t${s.attention}${report.queue ? `\tq:${report.queue.pending}/${report.queue.leased}/${report.queue.done}/${report.queue.failed}` : ""}`);
    for (const slot of report.slots) {
      console.log(`${slot.slotId}\t${slot.state}\tg${slot.generation}a${slot.attempt}\t${slot.taskId ?? ""}\t${slot.beeName ?? ""}\t${slot.beeState ?? ""}\t${slot.since}`);
    }
  }
}

/** One inline reconcile pass — useful without the daemon, and after `start`. */
async function flightSweep(parsed: Parsed): Promise<void> {
  const ref = parsed.args[1];
  const sessions = await listSessions();
  const sessionsByName = new Map(sessions.map((record) => [record.name, record]));
  const observed = new Map<string, BeeState>();
  const activity = new Map<string, BeeActivitySignal>();
  for (const record of sessions) {
    if (record.lastObservedState) observed.set(record.name, record.lastObservedState as BeeState);
  }
  // Persisted lastObservedState lags whenever the daemon is down — exactly
  // when an inline sweep is most needed. Overlay a LIVE run-dir observation
  // for the slot bees (they are HSR) so deadlines fire on evidence, not on
  // however stale the last daemon tick happens to be (review CR-8).
  const flights = ref ? [await resolveFlight(ref)] : await listFlights();
  const slotBees: string[] = [];
  for (const flight of flights) {
    for (const slot of await listSlots(flight.id)) {
      if (slot.beeName) slotBees.push(slot.beeName);
    }
  }
  if (slotBees.length > 0) {
    const { hsrObservations } = await import("../hsr/observe.js");
    const live = await hsrObservations({ includeEvents: true, bees: slotBees });
    for (const bee of slotBees) {
      const observation = live.get(bee);
      if (!observation) continue;
      if (observation.state) observed.set(bee, observation.state);
      else if (!observation.live) observed.set(bee, "dead");
      if (observation.activity) {
        activity.set(bee, { at: new Date(observation.activity.at).toISOString(), fingerprint: observation.activity.fingerprint });
      }
    }
  }
  const sweepNow = Date.now();
  await Promise.all(slotBees.map(async (bee) => {
    if (activity.has(bee)) return;
    const record = sessionsByName.get(bee);
    if (!record || record.substrate === "hsr") return;
    let pane = "";
    try {
      pane = await substrateFor(record).capture(record.tmuxTarget, 80, record.agentPaneId);
    } catch {
      pane = "";
    }
    if (pane) activity.set(bee, paneActivitySignal(record, pane, sweepNow));
  }));
  const sweeper = createFlightSweeper({ listFlights: async () => flights, now: () => sweepNow });
  const outcomes = await sweeper(sessions, observed, activity);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(outcomes, null, 2));
    return;
  }
  if (outcomes.length === 0) {
    console.log(isPretty() ? note("nothing to reconcile") : "noop");
    return;
  }
  for (const outcome of outcomes) {
    const parts = [outcome.flight, outcome.slot ?? "", outcome.action, outcome.detail ?? outcome.error ?? ""].filter(Boolean);
    if (isPretty()) console.log(actionLine(outcome.action === "error" ? "warn" : "ok", "flight", parts.map((part) => String(part))));
    else console.log(parts.join("\t"));
  }
}

/**
 * `hive flight enqueue` — author queue packets (flight v1.1). Enqueueing is
 * the manager/orchestrator API boundary: packet CONTENT (one-screen brief,
 * worktree cwd, ports/fixtures in the text) stays project-authored; the
 * controller only feeds packets to lanes. Enqueue never takes the sweep lock
 * (it only creates files in pending/), so it is safe to call anytime the
 * flight is active — including while lanes are drained; they revive on the
 * next sweep.
 */
async function flightEnqueue(parsed: Parsed): Promise<void> {
  const flight = await resolveFlight(parsed.args[1]);
  if (flight.status !== "active") {
    throw new Error(`flight ${flight.id} is ${flight.status}; enqueue requires an active flight`);
  }
  const fromDir = stringFlag(parsed, ["from-dir"]);
  const enqueued: string[] = [];
  if (fromDir) {
    const { readdir: readDir } = await import("node:fs/promises");
    const files = (await readDir(fromDir)).filter((file) => !file.startsWith(".")).sort();
    if (files.length === 0) throw new Error(`--from-dir ${fromDir} contains no packet files`);
    for (const file of files) {
      const brief = await readFile(join(fromDir, file), "utf8");
      const taskId = file.replace(/\.[^.]+$/, "");
      await enqueueTask(flight.id, { taskId, brief });
      await appendLedger({ type: "flight.task.enqueued", flight: flight.id, task: taskId });
      enqueued.push(taskId);
    }
  } else {
    const taskId = stringFlag(parsed, ["task-id"]);
    if (!taskId) throw new Error(`--task-id (or --from-dir) is required\n${USAGE}`);
    const briefFile = stringFlag(parsed, ["brief-file"]);
    const briefText = stringFlag(parsed, ["brief"]);
    if (briefFile && briefText) throw new Error("--brief and --brief-file are mutually exclusive");
    const brief = briefFile ? await readFile(briefFile, "utf8") : briefText;
    if (!brief) throw new Error("a packet needs --brief or --brief-file");
    const cwd = stringFlag(parsed, ["cwd"]);
    await enqueueTask(flight.id, { taskId, brief, ...(cwd ? { cwd } : {}) });
    await appendLedger({ type: "flight.task.enqueued", flight: flight.id, task: taskId });
    enqueued.push(taskId);
  }
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ flight: flight.id, enqueued }, null, 2));
  } else if (isPretty()) {
    console.log(actionLine("ok", "flight", [bold(flight.id), `enqueued ${enqueued.length} task${enqueued.length === 1 ? "" : "s"}`, dim(enqueued.join(", "))]));
  } else {
    console.log(`enqueued\t${flight.id}\t${enqueued.join(",")}`);
  }
}

/** `hive flight queue` — bucket counts + per-task rows, straight off disk. */
async function flightQueue(parsed: Parsed): Promise<void> {
  const flight = await resolveFlight(parsed.args[1]);
  const buckets = {
    pending: await listTasks(flight.id, "pending"),
    leased: await listTasks(flight.id, "leased"),
    done: await listTasks(flight.id, "done"),
    failed: await listTasks(flight.id, "failed"),
  };
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ flight: flight.id, ...buckets }, null, 2));
    return;
  }
  const counts = Object.entries(buckets).map(([bucket, tasks]) => `${bucket} ${tasks.length}`).join("  ");
  if (isPretty()) console.log(`${bold(flight.id)} ${flight.name} ${dim("queue:")} ${counts}`);
  else console.log(`${flight.id}\t${counts}`);
  for (const [bucket, tasks] of Object.entries(buckets)) {
    for (const task of tasks) {
      const extra =
        bucket === "leased" && task.lease
          ? `→ ${task.lease.slotId} g${task.lease.generation}`
          : bucket !== "pending" && task.outcome
            ? task.outcome.sealFilename ?? task.outcome.reason ?? ""
            : "";
      if (isPretty()) console.log(`  ${bucket.padEnd(8)} ${bold(task.taskId)} ${dim(extra)}`);
      else console.log(`${bucket}\t${task.taskId}\t${extra}`);
    }
  }
}

/**
 * `hive flight resolve <flight> <slot> --retry|--abandon|--accept` — the
 * operator verdict on a slot the controller escalated (review CR-7b). The
 * controller never judges; this is where judgment lands. Escalated slots are
 * otherwise immortal and block flight completion. On a queue lane the verdict
 * lands on the TASK — accept/abandon file the packet as done/failed and
 * recycle the lane onto the next packet; retry re-runs the same packet.
 */
async function flightResolve(parsed: Parsed): Promise<void> {
  const flight = await resolveFlight(parsed.args[1]);
  const slotId = parsed.args[2];
  if (!slotId) throw new Error(`slot id required\n${USAGE}`);
  const slot = (await listSlots(flight.id)).find((entry) => entry.slotId === slotId);
  if (!slot) throw new Error(`no slot ${slotId} in ${flight.id}`);
  const resolutions = (["retry", "abandon", "accept"] as const).filter((name) => truthy(flag(parsed, name)));
  if (resolutions.length !== 1) throw new Error("pass exactly one of --retry, --abandon, --accept");
  const resolution = resolutions[0]!;
  const resolvable = ["escalated", "stalled", "blocked", "abandoned"];
  if (!resolvable.includes(slot.state)) {
    throw new Error(`slot ${slotId} is ${slot.state}; resolve applies to: ${resolvable.join(", ")}`);
  }

  const now = new Date().toISOString();
  const history = [
    ...slot.history,
    { attempt: slot.attempt, generation: slot.generation, ...(slot.taskId ? { taskId: slot.taskId } : {}), ...(slot.beeName ? { beeName: slot.beeName } : {}), outcome: `operator-${resolution}`, at: now },
  ];
  let next: SlotRecord;
  if (resolution === "retry") {
    // Retry keeps the lease: same generation, same taskId (if any) — the next
    // sweep re-attempts the SAME packet.
    next = { ...slot, state: "vacant", since: now, evidence: {}, history };
    delete next.beeName;
    delete next.beeId;
    delete next.nudgedAt;
    delete next.attemptStartedAt;
  } else if (slot.taskId) {
    // Queue lane: the verdict lands on the TASK — file the packet and recycle
    // the lane onto the next one instead of killing lane capacity.
    await finishTask(flight.id, slot.taskId, resolution === "accept" ? "done" : "failed", { reason: `operator-${resolution}` });
    await appendLedger({ type: `flight.task.${resolution === "accept" ? "done" : "failed"}`, flight: flight.id, slot: slotId, task: slot.taskId, generation: slot.generation, reason: `operator-${resolution}` });
    next = { ...slot, generation: slot.generation + 1, attempt: 0, state: "vacant", since: now, evidence: {}, history };
    delete next.taskId;
    delete next.beeName;
    delete next.beeId;
    delete next.nudgedAt;
    delete next.attemptStartedAt;
    delete next.idempotencyKey;
  } else if (resolution === "abandon") {
    next = { ...slot, state: "abandoned", since: now, history };
  } else {
    next = { ...slot, state: "done", since: now, history };
  }
  await saveSlot(next);
  await appendLedger({ type: "flight.slot.resolved", flight: flight.id, slot: slotId, resolution, ...(slot.taskId ? { task: slot.taskId } : {}), ...(slot.beeName ? { bee: slot.beeName } : {}) });

  // Retry/abandon write the current bee off — retire it (best effort) so the
  // verdict doesn't leak a live runner host.
  if (resolution !== "accept" && slot.beeName) {
    const record = await loadSession(slot.beeName);
    if (record && record.status === "running") {
      const { transactionalRetire } = await import("../kill.js");
      await transactionalRetire(record).catch((error: unknown) => {
        console.error(note(`warn: could not retire ${slot.beeName}: ${error instanceof Error ? error.message : String(error)}`));
      });
    }
  }

  if (isPretty()) console.log(actionLine("ok", "flight", [bold(flight.id), slotId, `resolved: ${resolution}`]));
  else console.log(`resolved\t${flight.id}\t${slotId}\t${resolution}`);
}

/** `hive flight requeue <flight> <taskId>` — return a failed/done packet to pending. */
async function flightRequeue(parsed: Parsed): Promise<void> {
  const flight = await resolveFlight(parsed.args[1]);
  const taskId = parsed.args[2];
  if (!taskId) throw new Error(`task id required\n${USAGE}`);
  const fresh = await requeueTask(flight.id, taskId);
  await appendLedger({ type: "flight.task.requeued", flight: flight.id, task: fresh.taskId });
  if (isPretty()) console.log(actionLine("ok", "flight", [bold(flight.id), fresh.taskId, "requeued"]));
  else console.log(`requeued\t${flight.id}\t${fresh.taskId}`);
}

async function flightSetStatus(parsed: Parsed, status: "draining" | "closed"): Promise<void> {
  const flight = await resolveFlight(parsed.args[1]);
  if (flight.status === status) {
    console.log(isPretty() ? note(`${flight.id} already ${status}`) : `noop\t${flight.id}\t${status}`);
    return;
  }
  if (flight.status === "closed") {
    throw new Error(`flight ${flight.id} is closed; closed flights cannot transition to ${status}`);
  }
  await saveFlight({ ...flight, status, updatedAt: new Date().toISOString() });
  await appendLedger({ type: `flight.${status}`, flight: flight.id, name: flight.name });
  if (isPretty()) console.log(actionLine("ok", "flight", [bold(flight.id), status]));
  else console.log(`${status}\t${flight.id}`);
}

export function flightUsageHint(): string {
  return USAGE;
}
