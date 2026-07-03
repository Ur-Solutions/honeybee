// `hive swarm` — manage live or destroyed bee cohorts.
// Extracted from cli.ts (HIVE-15).
import { actionLine, bold, dim, formatRelativeTime, formatTable, gray, green, isPretty, note } from "../format.js";
import { transactionalKill } from "../kill.js";
import { type Parsed } from "../parse.js";
import { listSessions } from "../store.js";
import { destroySwarm, listSwarms, loadSwarm } from "../swarm.js";

export async function cmdSwarm(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return swarmList();
    case "inspect":
      return swarmInspect(parsed);
    case "destroy":
      return swarmDestroy(parsed);
    default:
      throw new Error(`Unknown swarm subcommand: ${sub}\nUsage: hive swarm <list|inspect|destroy>`);
  }
}


export async function swarmList() {
  const swarms = await listSwarms();
  if (!isPretty()) {
    for (const s of swarms) console.log(`${s.destroyed ? "destroyed" : "live"}\t@${s.id}\t${s.beeIds.length}\t${s.frame ?? "-"}\t${s.colony ?? "-"}\t${s.createdAt}`);
    return;
  }
  if (swarms.length === 0) {
    console.log(dim("No swarms. Spawn one with: hive spawn <bee> --count <n> or hive spawn --frame <name>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "SWARM" },
      { header: "BEES", align: "right" },
      { header: "FRAME" },
      { header: "COLONY" },
      { header: "AGE", align: "right" },
    ],
    swarms.map((s) => [
      s.destroyed ? gray("destroyed") : green("live"),
      bold(`@${s.id}`),
      String(s.beeIds.length),
      dim(s.frame ?? ""),
      dim(s.colony ?? ""),
      dim(formatRelativeTime(s.createdAt)),
    ]),
  ));
}


export async function swarmInspect(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive swarm inspect <id>");
  const cleaned = id.startsWith("@") ? id.slice(1) : id;
  const record = await loadSwarm(cleaned);
  if (!record) throw new Error(`Unknown swarm: ${id}`);
  console.log(JSON.stringify(record, null, 2));
}


export async function swarmDestroy(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive swarm destroy <id>");
  const cleaned = id.startsWith("@") ? id.slice(1) : id;
  const swarm = await loadSwarm(cleaned);
  if (!swarm) throw new Error(`Unknown swarm: ${id}`);

  const records = await listSessions();
  const members = records.filter((r) => r.swarmId === cleaned);
  let killFailed = 0;
  for (const member of members) {
    const outcome = await transactionalKill(member);
    if (!outcome.ok) {
      killFailed += 1;
      if (isPretty()) console.log(actionLine("warn", "kill_failed", [bold(member.name), dim(outcome.lastError)]));
      else console.log(`kill_failed\t${member.name}\t${outcome.lastError}`);
      continue;
    }
    if (isPretty()) console.log(actionLine(outcome.alreadyGone ? "warn" : "ok", outcome.alreadyGone ? "gone" : "kill", [bold(member.name)]));
    else console.log(`${outcome.alreadyGone ? "gone" : "killed"}\t${member.name}`);
  }

  if (killFailed > 0) {
    if (isPretty()) console.error(note(`${killFailed} bee(s) failed to die; swarm record retained. Retry: hive kill <bee> then hive swarm destroy ${cleaned}`));
    else console.error(`# ${killFailed} kill_failed; swarm record retained`);
    process.exitCode = 1;
    return;
  }

  await destroySwarm(cleaned);
  if (isPretty()) console.log(actionLine("ok", "swarm", [bold(`@${cleaned}`), dim("destroyed"), `${members.length} bees`]));
  else console.log(`destroyed\t@${cleaned}\t${members.length}`);
}
