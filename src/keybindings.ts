// The keybinding LAYER as a first-class hive concern (KEYBINDINGS_PRD §7, §11).
//
// This module is the SINGLE SOURCE OF TRUTH for the recommended tmux binding
// block and the WezTerm cmd→Meta additions. `hive keys print --tmux` emits
// CANONICAL_TMUX_CONF verbatim, and docs/honeybee.tmux.conf is the same string
// written to disk — a test asserts they are byte-identical so the doc and the
// command can never drift (§7.2).
//
// It also hosts the pure `extractUrls` helper backing `hive urls` (§9.3), kept
// here (not in cli.ts) so it is trivially unit-testable.

/** Sentinel markers delimiting the recommended block (the marked-block shape, §6). */
export const TMUX_BLOCK_START = "# >>> honeybee keybindings (recommended; you own this block) >>>";
export const TMUX_BLOCK_END = "# <<< honeybee keybindings <<<";

/**
 * The canonical, copy-pasteable tmux binding block (KEYBINDINGS_PRD §11). This
 * is the EXACT recommended no-prefix set, collision-checked against the live
 * mesh tmux layer + the WezTerm ALT/cmd layers (§6 three-source ledger):
 *
 *   M-b  spawn-picker --frame  → hive spawn --frame {} --here
 *   M-F  spawn-picker --flow   → hive quest start --flow {}
 *   M-k  fork current bee      (M-f avoided: WezTerm ALT layer)
 *   M-x  split / decompose
 *   M-r  rename --here
 *   M-R  workspace rename
 *   M-u  urls
 *   M-g  next                  (M-n avoided: WezTerm ALT layer)
 *   M-N  next --prev
 *
 * The string is emitted VERBATIM by `hive keys print --tmux` and written to
 * docs/honeybee.tmux.conf; both must stay byte-identical (enforced by test).
 */
export const CANONICAL_TMUX_CONF = `# honeybee recommended tmux keybindings — UNMANAGED, operator-owned.
#
# hive never writes this into your config. Paste it, or source-file it via
#   source-file "$(hive keys path)"
# from your own ~/.tmux.conf so updates flow without re-paste. You own every
# binding here and every collision against your existing M-*/prefix set.
#
# Collision ledger (KEYBINDINGS_PRD §6 — THREE independent sources):
#   1. mesh tmux layer  (~/mesh/profiles/tmux/.tmux.conf): C-a prefix; M-s/M-j/
#      M-d/M-D/M-t/M-w/M-Enter/M-1..5, M-arrows.
#   2. WezTerm cmd→Meta block (~/.wezterm.lua >>> hive >>>): cmd→M-*.
#   3. WezTerm leftover Zellij ALT→ESC layer (~/.wezterm.lua): takes lowercase
#      M-f/M-n/M-i/M-o/M-p — so fork rides M-k and next rides M-g, not M-f/M-n.
# \`hive keys check\` verifies sources (1)+(2) via \`tmux list-keys\`; source (3)
# is list-keys-invisible and must be eyeballed against ~/.wezterm.lua.
#
${TMUX_BLOCK_START}

# Spawn / decompose / fork (verbs: fork-and-pane Phase B/C/D; pickers: KEYBINDINGS_PRD)
bind -n M-b display-popup -E -w 60% -h 50% \\
  "hive spawn-picker --frame | fzf --prompt='frame> ' | xargs -r -I{} hive spawn --frame {} --here"   # cmd+b spawn from frame, here
bind -n M-F display-popup -E -w 60% -h 50% \\
  "hive spawn-picker --flow  | fzf --prompt='flow> '  | xargs -r -I{} hive quest start --flow {}"      # cmd+shift+f spawn swarm from flow (start → WORKSPACES)
bind -n M-k display-popup -E \\
  "hive fork \\"\$(hive here --id)\\" --here"                                                              # cmd+k fork current bee, here (M-f taken by WezTerm ALT layer)
bind -n M-x display-popup -E \\
  "hive split --here"                                                                                   # cmd+x decompose / add sub-bee (split → fork-and-pane B)

# Standalone affordances (owned here)
bind -n M-r display-popup -E -w 60% -h 20% \\
  "read -p 'rename bee> ' n && [ -n \\"\$n\\" ] && hive rename --here \\"\$n\\""                              # cmd+r rename current bee
bind -n M-R display-popup -E -w 60% -h 20% \\
  "read -p 'rename workspace> ' n && [ -n \\"\$n\\" ] && hive workspace rename \\"\$(hive workspace here)\\" \\"\$n\\""  # cmd+shift+r rename workspace (both verbs → WORKSPACES)
bind -n M-u display-popup -E -w 70% -h 60% \\
  "hive urls | fzf --prompt='url> ' --no-sort | xargs -r open"                                          # cmd+u list+open URL (xdg-open on Linux)

# Navigation (bindings owned here; engine → NAVIGATION_PRD)
bind -n M-g run-shell "hive next"                                                                       # cmd+g next attention bee (M-n taken by WezTerm ALT layer; NAVIGATION Tier 1)
bind -n M-N run-shell "hive next --prev"                                                                # cmd+shift+n prev attention bee
# M-s switcher is already shipped; to adopt grouped UX, swap its inline \`tmux ls -F ...\`
# for NAVIGATION's longer \`tmux ls -F\` format string carrying @hive_colony/@hive_swarm
# facets (binding here, format string there — no new CLI verb).

${TMUX_BLOCK_END}
`;

/**
 * The WezTerm cmd→Meta additions (KEYBINDINGS_PRD §11). Appended to the existing
 * `hive_keys` table under the `-- >>> hive >>>` block; last-match-wins by table
 * order overrides native CMD assignments for these keys.
 */
export const CANONICAL_WEZTERM_BLOCK = `-- honeybee cmd→Meta additions — append to the existing hive_keys table in
-- ~/.wezterm.lua under the \`-- >>> hive >>>\` block (last-match-wins by order).
{ key = 'b', mods = 'SUPER',       action = meta('b') },   -- cmd+b  spawn-from-frame
{ key = 'k', mods = 'SUPER',       action = meta('k') },   -- cmd+k  fork (M-f avoided: ALT layer)
{ key = 'f', mods = 'SUPER|SHIFT', action = meta('F') },   -- cmd+shift+f spawn-from-flow
{ key = 'x', mods = 'SUPER',       action = meta('x') },   -- cmd+x  split/decompose
{ key = 'r', mods = 'SUPER',       action = meta('r') },   -- cmd+r  rename bee
{ key = 'r', mods = 'SUPER|SHIFT', action = meta('R') },   -- cmd+shift+r rename workspace
{ key = 'u', mods = 'SUPER',       action = meta('u') },   -- cmd+u  urls
{ key = 'g', mods = 'SUPER',       action = meta('g') },   -- cmd+g  next  (M-n avoided: ALT layer)
{ key = 'n', mods = 'SUPER|SHIFT', action = meta('N') },   -- cmd+shift+n prev
`;

/**
 * The recommended no-prefix binds this PRD ships, as {key, verb} pairs. Drives
 * `hive keys check` present/absent/collision reporting against `tmux list-keys`.
 * `key` is the tmux key spec (root table, no-prefix); `verb` is the first hive
 * verb the binding dispatches (for reachability checks). `delegated` marks binds
 * whose backing verb is owned by a sibling PRD and may not be shipped yet.
 */
export type RecommendedBind = { key: string; verb: string; delegated?: boolean; note: string };

export const RECOMMENDED_BINDS: RecommendedBind[] = [
  { key: "M-b", verb: "spawn-picker", note: "spawn from frame, here" },
  { key: "M-F", verb: "spawn-picker", delegated: true, note: "spawn swarm from flow (quest start → WORKSPACES)" },
  { key: "M-k", verb: "fork", note: "fork current bee, here" },
  { key: "M-x", verb: "split", note: "decompose / add sub-bee" },
  { key: "M-r", verb: "rename", note: "rename current bee" },
  { key: "M-R", verb: "workspace", delegated: true, note: "rename workspace (→ WORKSPACES)" },
  { key: "M-u", verb: "urls", note: "list + open URL" },
  { key: "M-g", verb: "next", delegated: true, note: "next attention bee (→ NAVIGATION)" },
  { key: "M-N", verb: "next", delegated: true, note: "prev attention bee (→ NAVIGATION)" },
];

/**
 * The pure argv reshape for `hive rename --here <title>` (KEYBINDINGS_PRD §9.2).
 *
 * `cmdRename` reads args[0] as the SELECTOR and args.slice(1) as the TITLE. With
 * `--here`, the bare positionals are the title and the current bee's id is the
 * selector. This injects `beeId` as args[0] and shifts the title to args[1..] so
 * the title is never mistaken for a selector. With --auto/--clear there is no
 * explicit title; the bare positionals are dropped (cmdRename ignores them on
 * those paths) and only the selector is injected.
 *
 * Kept pure + exported (separate from the bee-resolution I/O in cli.ts) so the
 * load-bearing reshape is unit-testable without running the CLI.
 */
export function reshapeRenameHereArgs(
  beeId: string,
  args: string[],
  opts: { auto: boolean; clear: boolean },
): string[] {
  if (opts.auto || opts.clear) return [beeId];
  const titleParts = args.filter((arg) => arg.length > 0);
  return [beeId, ...titleParts];
}

/**
 * Extract website URLs from arbitrary captured text. PURE + exported for unit
 * testing (KEYBINDINGS_PRD §9.3).
 *
 * - Matches http(s) URLs, stopping at whitespace and shell/markup delimiters.
 * - Strips trailing sentence punctuation that almost never belongs to a URL.
 * - Dedupes via a Set, preserving first-seen order (recency in scrollback).
 */
export function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"{}\\|^`[\]]+/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(re)) {
    const url = stripTrailingPunctuation(match[0]);
    if (url.length === 0) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Trailing `.,;:)]}'"` rarely belongs to a URL — strip it (greedily). */
function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:)\]}'"]+$/, "");
}
