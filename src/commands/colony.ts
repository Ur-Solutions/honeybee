// `hive colony` — manage project-scoped namespaces.
// Extracted from cli.ts (HIVE-15).
import { archiveColony, createColony, listColonies, loadColony, renameColony, updateColony } from "../colony.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, gray, green, isPretty } from "../format.js";
import { flag, type Parsed } from "../parse.js";
import { listSessions, updateSession } from "../store.js";
import { listSwarms, saveSwarm } from "../swarm.js";

export async function cmdColony(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return colonyList();
    case "create":
      return colonyCreate(parsed);
    case "inspect":
      return colonyInspect(parsed);
    case "archive":
      return colonyArchive(parsed);
    case "update":
      return colonyUpdate(parsed);
    case "rename":
      return colonyRename(parsed);
    default:
      throw new Error(`Unknown colony subcommand: ${sub}\nUsage: hive colony <list|create|inspect|archive|update|rename>`);
  }
}


export async function colonyList() {
  const colonies = await listColonies();
  if (!isPretty()) {
    for (const c of colonies) console.log(`${c.archived ? "archived" : "active"}\t${c.name}\t${c.createdAt}`);
    return;
  }
  if (colonies.length === 0) {
    console.log(dim("No colonies. Create one with: hive colony create <name>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "NAME" },
      { header: "AGE", align: "right" },
      { header: "DESCRIPTION" },
    ],
    colonies.map((c) => [
      c.archived ? gray("archived") : green("active"),
      bold(c.name),
      dim(formatRelativeTime(c.createdAt)),
      dim(c.description ?? ""),
    ]),
  ));
}


export async function colonyCreate(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive colony create <name> [--description \"...\"]");
  const description = typeof flag(parsed, "description") === "string" ? String(flag(parsed, "description")) : undefined;
  const record = await createColony(name, description);
  if (isPretty()) console.log(actionLine("ok", "colony", [bold(record.name), dim("created")]));
  else console.log(`created\t${record.name}`);
}


export async function colonyInspect(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive colony inspect <name>");
  const record = await loadColony(name);
  if (!record) throw new Error(`Unknown colony: ${name}`);
  console.log(JSON.stringify(record, null, 2));
}


export async function colonyArchive(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive colony archive <name>");
  const record = await archiveColony(name);
  if (isPretty()) console.log(actionLine("ok", "colony", [bold(record.name), dim("archived")]));
  else console.log(`archived\t${record.name}`);
}


export async function colonyUpdate(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive colony update <name> [--description \"...\"] [--name <new>]");
  const descRaw = flag(parsed, "description");
  if (descRaw === true) throw new Error("--description requires a value (use --description \"\" to clear)");
  const description = typeof descRaw === "string" ? descRaw : undefined;
  const newName = typeof flag(parsed, "name") === "string" ? String(flag(parsed, "name")) : undefined;
  if (description === undefined && newName === undefined) {
    throw new Error("hive colony update needs --description \"...\" or --name <new>");
  }

  let current = await loadColony(name);
  if (!current) throw new Error(`Unknown colony: ${name}`);

  if (description !== undefined) current = await updateColony(name, { description });
  if (newName !== undefined && newName !== current.name) {
    const oldName = current.name;
    current = await renameColony(oldName, newName);
    await cascadeColonyRename(oldName, newName);
  }

  if (isPretty()) console.log(actionLine("ok", "colony", [bold(current.name), dim("updated")]));
  else console.log(`updated\t${current.name}`);
}


export async function colonyRename(parsed: Parsed) {
  const from = parsed.args[1];
  const to = parsed.args[2];
  if (!from || !to) throw new Error("Usage: hive colony rename <old> <new>");
  const record = await renameColony(from, to);
  await cascadeColonyRename(from, to);
  if (isPretty()) console.log(actionLine("ok", "colony", [bold(record.name), dim(`renamed from ${from}`)]));
  else console.log(`renamed\t${from}\t${to}`);
}


export async function cascadeColonyRename(from: string, to: string): Promise<void> {
  if (from === to) return;
  const sessions = await listSessions();
  for (const record of sessions) {
    if (record.colony !== from) continue;
    await updateSession(record.name, { colony: to, updatedAt: new Date().toISOString() });
  }
  const swarms = await listSwarms();
  for (const swarm of swarms) {
    if (swarm.colony !== from) continue;
    await saveSwarm({ ...swarm, colony: to });
  }
}
