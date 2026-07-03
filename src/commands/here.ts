// `hive here` / `hive spawn-picker` — resolve the bee owning the current pane
// and print frame/flow names for a display-popup spawn chord.
// Extracted from cli.ts (HIVE-15).
import { listFlows } from "../flow/index.js";
import { actionLine, bold, dim, isPretty, tildify } from "../format.js";
import { listFrames } from "../frame.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { assertLocalFleetReadable, hasFlag, resolveBeeInCurrentPane } from "../cli/shared.js";

export async function cmdHere(parsed: Parsed): Promise<void> {
  // Pane-less HSR bees resolve via HIVE_BEE (APIA-82); only error when neither
  // a tmux pane nor a HIVE_BEE stamp is available.
  if (!process.env.TMUX && !process.env.HIVE_BEE) throw new Error("hive here: not inside tmux or an HSR bee");
  const bee = await resolveBeeInCurrentPane();
  if (!bee) throw new Error("hive here: no matching bee for the current pane/session");

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({
      id: bee.id ?? bee.name,
      name: bee.name,
      agent: bee.agent,
      cwd: bee.cwd,
      combId: bee.combId ?? bee.tmuxTarget,
      parentId: bee.parentId ?? null,
      agentPaneId: bee.agentPaneId ?? null,
    }, null, 2));
    return;
  }
  if (truthy(flag(parsed, "id"))) {
    console.log(bee.id ?? bee.name);
    return;
  }
  if (isPretty()) console.log(actionLine("ok", "here", [bold(bee.name), bee.agent, dim(tildify(bee.cwd))]));
  else console.log(`here\t${bee.name}\t${bee.agent}\t${bee.cwd}`);
}


// hive spawn-picker [--frame | --flow] [--here]
// A PURE stdout list verb: prints candidate names one-per-line and does NOTHING
// else (no spawn/switch/store-write). The action lives in the binding (§8.2).
export async function cmdSpawnPicker(parsed: Parsed): Promise<void> {
  assertLocalFleetReadable("spawn-picker");
  // --here is a passthrough hint for the binding (it appends `--here` to the
  // spawn action unconditionally); it does NOT change the printed candidate set.
  // hasFlag (presence) not truthy(flag): `flow` is not a BOOLEAN_FLAG (it takes a
  // value on `spawn`), so a stray `--flow <x>` would otherwise parse the value and
  // mis-route; presence is the correct boolean intent for the picker.
  const useFlow = hasFlag(parsed, "flow");
  const names = useFlow
    ? (await listFlows()).map((flow) => flow.name)
    : (await listFrames()).map((frame) => frame.name);
  // The selectable machine token is the first whitespace/TAB field. Frame/flow
  // names have no spaces, so a bare name per line is the token. Empty candidate
  // set → exit 0 with empty stdout so the binding's `xargs -r` no-ops.
  for (const name of names) console.log(name);
}
