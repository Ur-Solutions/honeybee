// `hive send`/answer/brief/seal/rename/tag/own/move — message bees and edit
// their metadata (title, tags, ownership, colony).
// Extracted from cli.ts (HIVE-15).
import { actionLine, bold, dim, isPretty, note } from "../format.js";
import { writeHiveState, writeHiveTags, writeHiveTitle } from "../hiveState.js";
import { pendingNeedsInput } from "../hsr/observe.js";
import { connectRpcClient } from "../hsr/rpc.js";
import { readHsrMeta } from "../hsr/runDir.js";
import { gatherTitleContext, generateTitle } from "../naming.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { recordSeal, validateSealArtifact } from "../seal.js";
import { resolveSelector } from "../selectors.js";
import { appendLedger, updateSession, type SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { dedupeTags, effectiveTags, isValidTagValue, rejectReservedNamespaceTag } from "../tags.js";
import { tmux } from "../tmux.js";
import { readFile } from "node:fs/promises";
import { arrayFlag, deliverBrief, resolveBeeInCurrentPane, resolveSession, stringFlag } from "../cli/shared.js";

export async function cmdSeal(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive seal <selector> --from <path-to-seal.json>");
  const fromPath = typeof flag(parsed, "from") === "string" ? String(flag(parsed, "from")) : undefined;
  if (!fromPath) throw new Error("hive seal requires --from <path-to-seal.json>");

  const raw = await readFile(fromPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid seal JSON in ${fromPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const artifact = validateSealArtifact(parsedJson);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  for (const record of records) {
    const stored = await recordSeal(record.name, artifact);
    await writeHiveState(record, "done");
    if (isPretty()) console.log(actionLine("ok", "seal", [bold(record.name), dim(stored.status), dim(stored.type ?? "")]));
    else console.log(`sealed\t${record.name}\t${stored.status}\t${stored.type ?? ""}\t${stored.sealedAt}`);
  }
}


export async function cmdBrief(parsed: Parsed) {
  const target = parsed.args[0];
  const briefText = stringFlag(parsed, ["brief", "b"]) ?? parsed.args.slice(1).join(" ");
  if (!target || !briefText) throw new Error("Usage: hive brief <selector> <text> OR hive brief <selector> --brief <text>");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  let briefedCount = 0;
  for (const record of records) {
    if (!(await substrateFor(record).hasSession(record.tmuxTarget))) {
      if (!isMulti) throw new Error(`tmux session is not running: ${record.tmuxTarget}`);
      if (isPretty()) console.error(note(`skip ${record.name} (dead)`));
      else console.error(`skip\t${record.name}\tdead`);
      continue;
    }
    await deliverBrief(parsed, record, briefText);
    briefedCount += 1;
  }

  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "brief", [bold(target), `${briefedCount}/${records.length} bees`]));
    else console.log(`briefed\t${target}\t${briefedCount}/${records.length}`);
  }
}


export async function cmdRename(parsed: Parsed) {
  const auto = truthy(flag(parsed, "auto"));
  const clear = truthy(flag(parsed, "clear"));
  const here = truthy(flag(parsed, "here"));
  const usage = "Usage: hive rename <selector> <title>  |  hive rename --here <title>  |  hive rename <selector> --auto  |  hive rename <selector> --clear";

  // `--here` reshapes argv to the selector-then-title contract: resolve the
  // current pane's bee and treat every positional as the title (no selector to
  // skip). Without it, args[0] is the selector and args.slice(1) the title.
  let target: string | undefined;
  let explicit: string;
  if (here) {
    const bee = await resolveBeeInCurrentPane();
    if (!bee) throw new Error("hive rename --here: no matching bee for the current pane/session");
    target = bee.name;
    explicit = parsed.args.join(" ").trim();
  } else {
    target = parsed.args[0];
    explicit = parsed.args.slice(1).join(" ").trim();
  }
  if (!target || (auto && clear) || ((auto || clear) === Boolean(explicit))) throw new Error(usage);

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);
  if (explicit && isMulti) {
    throw new Error("Refusing to set the same title on multiple bees; use --auto or --clear for swarm/colony selectors");
  }

  for (const record of records) {
    const now = new Date().toISOString();
    if (clear) {
      // Dropping autoTitleAt + the attempt counter makes the bee a fresh daemon
      // auto-title candidate again.
      await updateSession(record.name, { title: undefined, titleSource: undefined, autoTitleAt: undefined, autoTitleAttempts: undefined, updatedAt: now });
      await writeHiveTitle(record, "");
      if (isPretty()) console.log(actionLine("ok", "rename", [bold(record.name), dim("title cleared")]));
      else console.log(`renamed\t${record.name}\t`);
      continue;
    }

    let title = explicit;
    let source: SessionRecord["titleSource"] = "user";
    if (auto) {
      const context = await gatherTitleContext(record);
      if (!context) {
        const reason = "no brief and no transcript to derive a title from";
        if (!isMulti) throw new Error(`${record.name}: ${reason}`);
        console.error(note(`skip ${record.name} (${reason})`));
        continue;
      }
      title = await generateTitle(context);
      source = "auto";
    }
    await updateSession(record.name, {
      title,
      titleSource: source,
      updatedAt: now,
      // Stamp autoTitleAt so the daemon's backoff sees a recent attempt; the bee
      // is no longer a candidate once title+titleSource are set, so the attempt
      // counter is intentionally left unbumped (this is the manual override).
      ...(auto ? { autoTitleAt: now } : {}),
    });
    await writeHiveTitle(record, title);
    if (isPretty()) console.log(actionLine("ok", "rename", [bold(record.name), title, dim(source)]));
    else console.log(`renamed\t${record.name}\t${title}\t${source}`);
  }
}


export async function cmdTag(parsed: Parsed) {
  const target = parsed.args[0];
  const usage =
    "Usage: hive tag <selector> <tag>...  |  hive tag <selector> --remove <tag>...  |  hive tag <selector> --list";
  if (!target) throw new Error(usage);

  const listMode = truthy(flag(parsed, "list"));
  const removeArgs = arrayFlag(parsed, "remove");
  const removeMode = removeArgs.length > 0 || flag(parsed, "remove") === true;
  // Positional tags after the selector are the add set (unless we're in
  // list/remove mode, where positionals are ignored).
  const addArgs = !listMode && !removeMode ? parsed.args.slice(1) : [];

  if (!listMode && !removeMode && addArgs.length === 0) {
    throw new Error("hive tag: pass tag names to add, --remove <tag>... to remove, or --list to display");
  }

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);
  const isMulti = resolved.kind !== "bee";

  if (listMode) {
    for (const record of records) {
      const tags = Array.from(effectiveTags(record)).sort();
      const tagStr = tags.length > 0 ? tags.join(", ") : "(none)";
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim(tagStr)]));
      else console.log(`${record.name}\ttags\t${tagStr}`);
    }
    return;
  }

  if (removeMode) {
    if (removeArgs.length === 0) throw new Error("hive tag --remove: pass tag names to remove");
    let changed = 0;
    for (const record of records) {
      const before = record.tags ?? [];
      const after = before.filter((tag) => !removeArgs.includes(tag));
      if (before.length === after.length) {
        if (!isMulti) console.error(note(`${record.name}: no matching tags to remove`));
        continue;
      }
      changed += 1;
      const now = new Date().toISOString();
      await updateSession(record.name, { tags: after.length > 0 ? after : undefined, updatedAt: now });
      await writeHiveTags({ ...record, tags: after.length > 0 ? after : undefined });
      await appendLedger({ type: "tag.remove", bee: record.name, tags: removeArgs });
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim("removed"), removeArgs.join(", ")]));
      else console.log(`${record.name}\ttag.remove\t${removeArgs.join(", ")}`);
    }
    if (isMulti) {
      if (isPretty()) console.log(actionLine("ok", "tag", [bold(target), `removed from ${changed}/${records.length} bees`]));
      else console.log(`tag.remove\t${target}\t${changed}/${records.length} bees`);
    }
    return;
  }

  // ADD mode: validate every tag (reject reserved namespaces, enforce grammar)
  // BEFORE mutating any record, so a bad tag never half-applies.
  for (const tag of addArgs) {
    const rejection = rejectReservedNamespaceTag(tag);
    if (rejection) throw new Error(`hive tag ${tag}: ${rejection}`);
    if (!isValidTagValue(tag)) {
      throw new Error(`Invalid tag: ${tag} (forbid whitespace/comma/tab/newline, max 64 chars)`);
    }
  }

  let changed = 0;
  for (const record of records) {
    const before = record.tags ?? [];
    const after = dedupeTags([...before, ...addArgs]);
    if (before.length === after.length && before.every((t, i) => t === after[i])) {
      if (!isMulti) console.error(note(`${record.name}: already has those tags`));
      continue;
    }
    changed += 1;
    const now = new Date().toISOString();
    await updateSession(record.name, { tags: after, updatedAt: now });
    await writeHiveTags({ ...record, tags: after });
    await appendLedger({ type: "tag.add", bee: record.name, tags: addArgs });
    if (isPretty()) console.log(actionLine("ok", "tag", [bold(record.name), dim("added"), addArgs.join(", ")]));
    else console.log(`${record.name}\ttag.add\t${addArgs.join(", ")}`);
  }
  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "tag", [bold(target), `added to ${changed}/${records.length} bees`]));
    else console.log(`tag.add\t${target}\t${changed}/${records.length} bees`);
  }
}


// Resolve the owner selector to EXACTLY ONE bee, then point every bee resolved
// from each beeSelector at it (reportsToId edge). Shared by cmdOwn's set path
// and cmdMove's --owner alias (Risk 5: avoids synthesizing a fake Parsed).
export async function setOwnership(ownerSel: string, beeSelectors: string[]): Promise<void> {
  const ownerResolved = await resolveSelector(ownerSel);
  const ownerRecords = ownerResolved.kind === "bee" ? [ownerResolved.record] : ownerResolved.records;
  if (ownerRecords.length === 0) throw new Error(`hive own: owner selector matched no bee: ${ownerSel}`);
  if (ownerRecords.length > 1) {
    throw new Error(`hive own: owner selector ${ownerSel} matched ${ownerRecords.length} bees; pick one`);
  }
  const owner = ownerRecords[0]!;
  const ownerId = owner.id ?? owner.name;

  let changed = 0;
  let total = 0;
  for (const sel of beeSelectors) {
    const resolved = await resolveSelector(sel);
    const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
    for (const record of records) {
      total += 1;
      const now = new Date().toISOString();
      await updateSession(record.name, { reportsToId: ownerId, updatedAt: now });
      await appendLedger({ type: "rel.set", bee: record.name, kind: "reports-to", to: ownerId });
      changed += 1;
      if (isPretty()) console.log(actionLine("ok", "own", [bold(record.name), dim("reports-to"), ownerId]));
      else console.log(`${record.name}\trel.set\treports-to\t${ownerId}`);
    }
  }
  if (isPretty()) console.log(actionLine("ok", "own", [bold(ownerId), `${changed}/${total} bees`]));
  else console.log(`own\t${ownerId}\t${changed}/${total} bees`);
}


// Clear the reportsToId edge on every bee resolved from beeSel. NEVER kills a
// bee — relationships are reference-only (§9.4 / R3).
export async function clearOwnership(beeSel: string): Promise<void> {
  const resolved = await resolveSelector(beeSel);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${beeSel}`);
  for (const record of records) {
    const now = new Date().toISOString();
    await updateSession(record.name, { reportsToId: undefined, updatedAt: now });
    await appendLedger({ type: "rel.clear", bee: record.name, kind: "reports-to" });
    if (isPretty()) console.log(actionLine("ok", "own", [bold(record.name), dim("cleared")]));
    else console.log(`${record.name}\trel.clear\treports-to`);
  }
}


// `hive own <owner-selector> <bee-selector>...` sets the owned-by/reports-to
// edge; `hive own <bee-selector> --clear` unsets it. No @hive_tags refresh:
// relationships have no tmux mirror in v1 (§9.4).
export async function cmdOwn(parsed: Parsed) {
  const ownerSel = parsed.args[0];
  const usage =
    "Usage: hive own <owner-selector> <bee-selector>...  |  hive own <bee-selector> --clear";
  if (!ownerSel) throw new Error(usage);

  if (truthy(flag(parsed, "clear"))) {
    if (parsed.args.length > 1) throw new Error("hive own --clear takes exactly one <bee-selector>");
    await clearOwnership(ownerSel);
    return;
  }

  const beeSelectors = parsed.args.slice(1);
  if (beeSelectors.length === 0) throw new Error(usage);
  await setOwnership(ownerSel, beeSelectors);
}


// `hive move <bee> --colony <c>` reassigns a bee's colony (the derived colony:
// tag follows on read); `hive move <bee> --owner <o>` is an alias for hive own
// on one bee, and `--owner ''` clears ownership.
export async function cmdMove(parsed: Parsed) {
  const beeSel = parsed.args[0];
  const usage =
    "Usage: hive move <bee> --colony <c>  |  hive move <bee> --owner <o>  (--owner '' clears)";
  if (!beeSel) throw new Error(usage);

  const colonyRaw = flag(parsed, "colony");
  const ownerRaw = flag(parsed, "owner");
  if (colonyRaw === undefined && ownerRaw === undefined) throw new Error(usage);
  if (colonyRaw !== undefined && ownerRaw !== undefined) {
    throw new Error("hive move: pass either --colony or --owner, not both");
  }

  // --owner: alias for hive own on a single bee; --owner '' clears ownership.
  if (ownerRaw !== undefined) {
    const owner = typeof ownerRaw === "string" ? ownerRaw.trim() : "";
    if (owner === "") {
      await clearOwnership(beeSel);
      return;
    }
    await setOwnership(owner, [beeSel]);
    return;
  }

  // --colony: rewrite record.colony on each resolved bee (derived colony: tag
  // follows). Refresh @hive_tags because colony: is a derived reserved tag.
  if (colonyRaw === true) throw new Error("--colony requires a value");
  const colony = String(colonyRaw);
  const resolved = await resolveSelector(beeSel);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  if (records.length === 0) throw new Error(`No bees match selector: ${beeSel}`);
  for (const record of records) {
    const now = new Date().toISOString();
    const next = colony.trim() === "" ? undefined : colony;
    await updateSession(record.name, { colony: next, updatedAt: now });
    await writeHiveTags({ ...record, colony: next });
    if (isPretty()) console.log(actionLine("ok", "move", [bold(record.name), dim("colony"), next ?? "(none)"]));
    else console.log(`${record.name}\tmove\tcolony\t${next ?? ""}`);
  }
}


export async function cmdSend(parsed: Parsed) {
  const target = parsed.args[0];
  const prompt = stringFlag(parsed, ["prompt", "p"]) ?? parsed.args.slice(1).join(" ");
  if (!target || !prompt) throw new Error("Usage: hive send <selector> <prompt> OR hive send <selector> -p <prompt>");

  const resolved = await resolveSelector(target);
  const records = resolved.kind === "bee" ? [resolved.record] : resolved.records;
  const isMulti = resolved.kind !== "bee";
  if (records.length === 0) throw new Error(`No bees match selector: ${target}`);

  let sent = 0;
  for (const record of records) {
    if (!(await substrateFor(record).hasSession(record.tmuxTarget))) {
      if (!isMulti) throw new Error(`tmux session is not running: ${record.tmuxTarget}`);
      if (isPretty()) console.error(note(`skip ${record.name} (dead)`));
      else console.error(`skip\t${record.name}\tdead`);
      continue;
    }
    await substrateFor(record).sendText(record.tmuxTarget, prompt, record.agentPaneId);
    const now = new Date().toISOString();
    await updateSession(record.name, { updatedAt: now, status: "running", lastPrompt: prompt, lastPromptAt: now });
    await writeHiveState(record, "working");
    await appendLedger({ type: "prompt.send", session: record.name, agent: record.agent, node: record.node ?? LOCAL_NODE_NAME, cwd: record.cwd, chars: prompt.length });
    if (isPretty()) console.log(actionLine("ok", "send", [bold(record.name), `${prompt.length} chars`]));
    else console.log(`sent\t${record.name}\t${prompt.length} chars`);
    sent += 1;
  }

  if (isMulti) {
    if (isPretty()) console.log(actionLine("ok", "send", [bold(target), `${sent}/${records.length} bees`]));
    else console.log(`sent\t${target}\t${sent}/${records.length}`);
  }
}


/**
 * Answer the pending needs_input of a blocked HSR bee over its control socket.
 * The daemon routes an HSR bee's needs_input to its parent as a buz; the parent
 * (or a human) replies with `hive answer <bee> <text>`. Defaults to "yes" when
 * no text is supplied (the common permission-approve case).
 */
export async function cmdAnswer(parsed: Parsed) {
  const target = parsed.args[0];
  if (!target) throw new Error("Usage: hive answer <bee> [text]");
  const text = stringFlag(parsed, ["answer", "a"]) ?? parsed.args.slice(1).join(" ");
  const answer = text.length > 0 ? text : "yes";

  const record = await resolveSession(target);
  if (record.substrate !== "hsr") {
    throw new Error(`hive answer applies to HSR bees only; ${record.name} is ${record.substrate ?? "local-tmux"}`);
  }
  const pending = await pendingNeedsInput(record.name);
  if (!pending) throw new Error(`No pending needs-input for ${record.name}`);
  const meta = await readHsrMeta(record.name);
  if (!meta?.controlSocket) throw new Error(`No control socket for ${record.name}`);

  const client = await connectRpcClient(meta.controlSocket);
  try {
    await client.call("answer", { requestId: pending.requestId, answer });
  } finally {
    client.close();
  }

  if (isPretty()) console.log(actionLine("ok", "answer", [bold(record.name), dim(pending.requestId)]));
  else console.log(`answered\t${record.name}\t${pending.requestId}`);
}
