// `hive keys` — print, locate, and verify the recommended tmux keybinding set.
// Extracted from cli.ts (HIVE-15).
import { actionLine, bold, dim, isPretty, note, red, truncate, yellow } from "../format.js";
import { CANONICAL_TMUX_CONF, CANONICAL_WEZTERM_BLOCK, RECOMMENDED_BINDS } from "../keybindings.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { tmux } from "../tmux.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSubstrateIsSshTmux } from "../cli/shared.js";

// hive keys print [--tmux | --wezterm] | path | check [--against-recommended]
export async function cmdKeys(parsed: Parsed): Promise<void> {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "print":
      return keysPrint(parsed);
    case "path":
      return keysPath();
    case "check":
      return keysCheck(parsed);
    case "doctor":
      // OPTIONAL Phase 2 — the runtime popup-env probe. Not yet implemented.
      throw new Error("hive keys doctor: not yet implemented (Phase 2). Use `hive keys check` for static checks.");
    default:
      throw new Error(`Unknown keys subcommand: ${sub}\nUsage: hive keys <print|path|check>`);
  }
}


export function keysPrint(parsed: Parsed): void {
  // `--tmux` (default) prints the recommended tmux block VERBATIM (the same
  // source-of-truth string written to docs/honeybee.tmux.conf). `--wezterm`
  // prints the cmd→Meta additions.
  if (truthy(flag(parsed, "wezterm"))) {
    process.stdout.write(CANONICAL_WEZTERM_BLOCK);
    return;
  }
  process.stdout.write(CANONICAL_TMUX_CONF);
}


/**
 * The absolute path of the shipped docs/honeybee.tmux.conf, resolved relative to
 * this module (which lives at dist/cli.js when packaged, src/cli.ts under tsx).
 * Both are exactly one directory below the repo root, so `..` from the module dir
 * reaches the root and `docs/honeybee.tmux.conf` from there is the artifact.
 *
 * Path-stability caveat (KEYBINDINGS_PRD §16 Q2): this resolves relative to the
 * install location, so it is brittle across reinstall/relocation. The robust
 * `source-file` recipe is `source-file "$(hive keys path)"`, re-evaluated by the
 * shell; a bare paste (`hive keys print --tmux >> ~/.tmux.conf`) goes stale
 * silently. `hive keys check` audits presence either way.
 */
export function keybindingsConfPath(): string {
  // keys.ts lives in src/commands (dist/commands), one level below cli.ts, so
  // walk up two dirs to reach the package root where docs/ lives.
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  return resolve(moduleDir, "..", "..", "docs", "honeybee.tmux.conf");
}


export function keysPath(): void {
  console.log(keybindingsConfPath());
}


export async function keysCheck(parsed: Parsed): Promise<void> {
  // PURE READ. Reports recommended binds present/absent, flags tmux-layer
  // collisions, and runs the static PATH/substrate checks.
  //
  // LIMITATION (KEYBINDINGS_PRD §6/§13): `check` reads `tmux list-keys`, so it is
  // STRUCTURALLY BLIND to the WezTerm ALT/cmd layer in ~/.wezterm.lua — that must
  // be eyeballed. The collision report below is necessary but not sufficient.
  const pretty = isPretty();
  let hardFailures = 0;
  let warnings = 0;

  // The live root-table key bindings, as a key → command map.
  const liveBinds = await liveTmuxRootBinds();

  // Per-recommended-bind: present / absent / collision (bound to something else).
  for (const bind of RECOMMENDED_BINDS) {
    const live = liveBinds.get(bind.key);
    const wired = live !== undefined && live.includes(`hive ${bind.verb}`);
    const collision = live !== undefined && !wired;
    if (wired) {
      if (pretty) console.log(actionLine("ok", "keys", [bold(bind.key), dim(`→ hive ${bind.verb}`), dim(bind.note)]));
      else console.log(`bind\tpresent\t${bind.key}\t${bind.verb}`);
    } else if (collision) {
      warnings += 1;
      if (pretty) console.log(actionLine("warn", "keys", [bold(bind.key), yellow("collision"), dim(truncate(live!, 50))]));
      else console.log(`bind\tcollision\t${bind.key}\t${live!.replace(/\s+/g, " ").trim()}`);
    } else {
      // Absent. A delegated bind whose verb may not be shipped yet is only a
      // note; a non-delegated recommended bind absent is also just informational
      // (the operator may not have pasted the block) — not a hard failure.
      if (pretty) console.log(actionLine("info", "keys", [bold(bind.key), dim("absent"), dim(bind.delegated ? "(delegated)" : "")]));
      else console.log(`bind\tabsent\t${bind.key}\t${bind.delegated ? "delegated" : ""}`);
    }
  }

  // --against-recommended: report live binds on our recommended keys that differ
  // from the shipped set (drift after a stale paste + hive upgrade).
  if (truthy(flag(parsed, "against-recommended"))) {
    for (const bind of RECOMMENDED_BINDS) {
      const live = liveBinds.get(bind.key);
      if (live !== undefined && !live.includes(`hive ${bind.verb}`)) {
        if (pretty) console.log(actionLine("warn", "drift", [bold(bind.key), dim(truncate(live, 60))]));
        else console.log(`drift\t${bind.key}\t${live.replace(/\s+/g, " ").trim()}`);
        warnings += 1;
      }
    }
  }

  // Static checks: fzf, a browser opener, the substrate, and `hive` reachability.
  const fzf = await binaryOnPath("fzf");
  reportCheck(pretty, fzf, "fzf on PATH", "fzf missing — popups can't filter candidates");
  if (!fzf) warnings += 1;

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const openerOk = await binaryOnPath(opener);
  reportCheck(pretty, openerOk, `${opener} on PATH`, `${opener} missing — \`hive urls\` --open / the M-u binding can't open a browser`);
  if (!openerOk) warnings += 1;

  // Substrate: warn under ssh-tmux (the pickers/affordances target the wrong fleet, §13).
  const ssh = defaultSubstrateIsSshTmux();
  if (ssh) {
    warnings += 1;
    if (pretty) console.log(actionLine("warn", "check", [yellow("substrate is ssh-tmux"), dim("pickers/affordances read the LOCAL store (§13)")]));
    else console.log(`check\tsubstrate\tssh-tmux`);
  } else {
    if (pretty) console.log(actionLine("ok", "check", [dim("substrate is local-tmux")]));
    else console.log(`check\tsubstrate\tlocal-tmux`);
  }

  // `hive` itself reachable (recommended verbs are unreachable otherwise → HARD fail).
  const hiveOk = await binaryOnPath("hive");
  if (!hiveOk) {
    hardFailures += 1;
    if (pretty) console.log(actionLine("err", "check", [red("hive not on PATH"), dim("bindings invoke `hive` inside popups — they will all fail")]));
    else console.log(`check\thive\tunreachable`);
  } else {
    if (pretty) console.log(actionLine("ok", "check", [dim("hive on PATH")]));
    else console.log(`check\thive\treachable`);
  }

  // The list-keys blind-spot, surfaced every run so it is never forgotten.
  if (pretty) console.log(note("check covers the tmux layer only; the WezTerm ALT/cmd layer (~/.wezterm.lua) is list-keys-invisible and must be eyeballed (§6)."));
  else console.log(`check\tlimitation\twezterm-alt-cmd-layer-not-checked`);

  if (hardFailures > 0) process.exitCode = 1;
  else if (warnings > 0 && pretty) console.log(dim(`${warnings} warning(s) — see above`));
}


/** Live root-table (no-prefix) bindings: tmux key spec → bound command string. */
export async function liveTmuxRootBinds(): Promise<Map<string, string>> {
  const binds = new Map<string, string>();
  // `-T root` is the no-prefix table where `bind -n` binds land.
  const result = await tmux(["list-keys", "-T", "root"], { reject: false });
  if (!result.ok) return binds;
  for (const line of result.stdout.split("\n")) {
    // Format: `bind-key [-r] [-N note] -T root M-b <command...>`.
    // tmux may decorate binds before the table flag; keep the command tail intact.
    const match = line.match(/^bind-key\s+(?:(?:-[nr]\s+)|(?:-N\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)\s+))*-T\s+root\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const command = match[2]!.trim();
    binds.set(key, command);
  }
  return binds;
}


export function reportCheck(pretty: boolean, ok: boolean, label: string, failHint: string): void {
  if (ok) {
    if (pretty) console.log(actionLine("ok", "check", [dim(label)]));
    else console.log(`check\tok\t${label}`);
  } else {
    if (pretty) console.log(actionLine("warn", "check", [yellow(label), dim(failHint)]));
    else console.log(`check\twarn\t${label}`);
  }
}


/** Whether `name` resolves on PATH (via the platform `which`/`command -v`). */
export async function binaryOnPath(name: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise<boolean>((resolveCheck) => {
    const probe = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [name] : ["-v", name];
    // `command -v` needs a shell; `which` is also fine but less portable.
    if (process.platform === "win32") {
      execFile(probe, args, (error) => resolveCheck(!error));
    } else {
      execFile("sh", ["-c", `command -v ${JSON.stringify(name)}`], (error) => resolveCheck(!error));
    }
  });
}
