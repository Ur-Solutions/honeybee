// `hive frame` — manage reusable swarm blueprints.
// Extracted from cli.ts (HIVE-15).
import { actionLine, bold, dim, formatTable, isPretty } from "../format.js";
import { defineFrameFromFile, frameDefinitionFile, frameExists, listFrames, loadFrame, loadFrameSource, removeFrame, validateFrame, writeFrameFromObject, writeFrameFromValidatedObject } from "../frame.js";
import { type Parsed } from "../parse.js";
import { resolve } from "node:path";

export async function cmdFrame(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return frameList();
    case "define":
      return frameDefine(parsed);
    case "update":
      return frameUpdate(parsed);
    case "reload":
      return frameReload(parsed);
    case "edit":
      return frameEdit(parsed);
    case "inspect":
      return frameInspect(parsed);
    case "remove":
      return frameRemove(parsed);
    default:
      throw new Error(`Unknown frame subcommand: ${sub}\nUsage: hive frame <list|define|update|reload|edit|inspect|remove>`);
  }
}


export async function frameList() {
  const frames = await listFrames();
  if (!isPretty()) {
    for (const frame of frames) {
      const total = frame.castes.reduce((sum, caste) => sum + caste.count, 0);
      console.log(`${frame.name}\t${frame.castes.length} castes\t${total} bees`);
    }
    return;
  }
  if (frames.length === 0) {
    console.log(dim("No frames defined. Register one with: hive frame define <name> <file>"));
    return;
  }
  console.log(formatTable(
    [
      { header: "NAME" },
      { header: "CASTES", align: "right" },
      { header: "BEES", align: "right" },
      { header: "DESCRIPTION" },
    ],
    frames.map((frame) => [
      bold(frame.name),
      String(frame.castes.length),
      String(frame.castes.reduce((sum, caste) => sum + caste.count, 0)),
      dim(frame.description ?? ""),
    ]),
  ));
}


export async function frameDefine(parsed: Parsed) {
  const first = parsed.args[1];
  const second = parsed.args[2];
  if (!first) throw new Error("Usage: hive frame define <path-to-frame.json|.ts> [<name>]");
  const { sourcePath, nameOverride } = resolveDefineArgs(first, second);
  const frame = await defineFrameFromFile(sourcePath, nameOverride);
  if (isPretty()) console.log(actionLine("ok", "frame", [bold(frame.name), `${frame.castes.length} castes`, dim(sourcePath)]));
  else console.log(`defined\t${frame.name}\t${frame.castes.length}\t${sourcePath}`);
}


/** A frame/flow define source: a path when it has a slash or a .json/.ts suffix. */
export function looksLikeDefinePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".json") || value.endsWith(".ts");
}


/**
 * `hive frame|flow define <a> [<b>]` accepts <path> [<name>] in either order;
 * on an ambiguous pair the first arg is taken as the path.
 */
export function resolveDefineArgs(first: string, second?: string): { sourcePath: string; nameOverride?: string } {
  if (!second) return { sourcePath: first };
  const firstIsPath = looksLikeDefinePath(first);
  const secondIsPath = looksLikeDefinePath(second);
  if (firstIsPath && !secondIsPath) return { sourcePath: first, nameOverride: second };
  if (!firstIsPath && secondIsPath) return { sourcePath: second, nameOverride: first };
  return { sourcePath: first, nameOverride: second };
}


export async function frameUpdate(parsed: Parsed) {
  const first = parsed.args[1];
  const second = parsed.args[2];
  if (!first) throw new Error("Usage: hive frame update <name> [path] OR hive frame update <path>");

  // hive frame update <name>  → reload from remembered source
  if (!second && !looksLikeDefinePath(first)) {
    return reloadFrame(first);
  }

  let sourcePath: string;
  let targetName: string | undefined;
  if (second) {
    const { sourcePath: s, nameOverride } = resolveDefineArgs(first, second);
    sourcePath = s;
    targetName = nameOverride;
  } else {
    sourcePath = first;
  }

  if (targetName !== undefined) {
    if (!(await frameExists(targetName))) {
      throw new Error(`Unknown frame: ${targetName}. Use 'hive frame define' to create a new one.`);
    }
    const frame = await defineFrameFromFile(sourcePath, targetName);
    if (isPretty()) console.log(actionLine("ok", "frame", [bold(frame.name), dim("updated"), dim(sourcePath)]));
    else console.log(`updated\t${frame.name}\t${sourcePath}`);
    return;
  }

  // No explicit target: read source, use its declared name, require it to exist.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const absolute = path.resolve(sourcePath);
  try {
    await fs.access(absolute);
  } catch {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  const ext = path.extname(absolute);
  if (ext !== ".json") throw new Error(`hive frame update reads JSON only (got ${ext}). For .ts frames, pass an explicit <name>.`);
  const raw = JSON.parse(await fs.readFile(absolute, "utf8"));
  const draft = validateFrame(raw);
  if (!(await frameExists(draft.name))) {
    throw new Error(`Unknown frame: ${draft.name}. Use 'hive frame define' to create a new one.`);
  }
  const frame = await writeFrameFromValidatedObject(draft, { sourcePath: absolute, ledger: true });
  if (isPretty()) console.log(actionLine("ok", "frame", [bold(frame.name), dim("updated"), dim(sourcePath)]));
  else console.log(`updated\t${frame.name}\t${sourcePath}`);
}


export async function frameReload(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive frame reload <name>");
  return reloadFrame(name);
}


export async function reloadFrame(name: string) {
  if (!(await frameExists(name))) throw new Error(`Unknown frame: ${name}`);
  const source = await loadFrameSource(name);
  if (!source) {
    throw new Error(`No source path recorded for frame ${name}. Re-import once with: hive frame define <path>`);
  }
  const fs = await import("node:fs/promises");
  try {
    await fs.access(source);
  } catch {
    throw new Error(`Source file no longer exists: ${source}\nRe-import with: hive frame define <new-path> ${name}`);
  }
  const frame = await defineFrameFromFile(source, name);
  if (isPretty()) console.log(actionLine("ok", "frame", [bold(frame.name), dim("reloaded"), dim(source)]));
  else console.log(`reloaded\t${frame.name}\t${source}`);
}


export async function frameEdit(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive frame edit <name>");
  const existing = await loadFrame(name);
  if (!existing) throw new Error(`Unknown frame: ${name}`);
  const backing = await frameDefinitionFile(name);
  if (backing?.ext === ".ts") {
    throw new Error(`Frame ${name} is backed by a TypeScript source (${backing.path}); edit that file, then run: hive frame reload ${name}`);
  }

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { spawn } = await import("node:child_process");

  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `hive-frame-${name}-`));
  const tmpFile = path.join(tmpDir, `${name}.json`);
  await fs.writeFile(tmpFile, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });

  try {
    const [editorCmd, ...editorArgs] = editor.split(/\s+/);
    if (!editorCmd) throw new Error("Empty $EDITOR/$VISUAL");
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(editorCmd, [...editorArgs, tmpFile], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`Editor exited with code ${code}; frame unchanged`);

    const raw = JSON.parse(await fs.readFile(tmpFile, "utf8"));
    const validated = validateFrame(raw);
    if (validated.name !== name) {
      throw new Error(`Frame name changed in editor (${name} → ${validated.name}); use 'hive frame define' to rename`);
    }
    await writeFrameFromObject(validated);
    if (isPretty()) console.log(actionLine("ok", "frame", [bold(name), dim("edited")]));
    else console.log(`edited\t${name}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}


export async function frameInspect(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive frame inspect <name>");
  const frame = await loadFrame(name);
  if (!frame) throw new Error(`Unknown frame: ${name}`);
  console.log(JSON.stringify(frame, null, 2));
}


export async function frameRemove(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive frame remove <name>");
  const removed = await removeFrame(name);
  if (!removed) throw new Error(`Unknown frame: ${name}`);
  if (isPretty()) console.log(actionLine("ok", "frame", [bold(name), dim("removed")]));
  else console.log(`removed\t${name}`);
}
