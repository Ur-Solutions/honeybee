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
 * The keybinding-layer AFFORDANCES this PRD owns (KEYBINDINGS_PRD §11), as a
 * copy-pasteable tmux block. These ADD to the shipped bindings already in
 * docs/honeybee.tmux.conf — bees (M-b), hive new (M-n), the attention queue
 * next/prev (M-./M-,), rename (M-r), and the needs-me switcher (M-S) live there;
 * this block adds the spawn/fork/split/urls/workspace-rename affordances on
 * collision-free keys (M-b is hive bees, so spawn-from-frame rides M-B):
 *
 *   M-B  spawn-picker --frame  → hive spawn --frame {} --here  (M-b is hive bees)
 *   M-F  spawn-picker --flow   → hive flow run {}  (most flows need --arg values)
 *   M-k  fork current bee      (M-f avoided: WezTerm ALT layer)
 *   M-x  split / decompose
 *   M-u  urls
 *   M-R  workspace rename
 *
 * `hive keys print --tmux` emits this block VERBATIM; docs/honeybee.tmux.conf
 * ends with it (a test asserts the doc CONTAINS the block so they never drift).
 */
export const CANONICAL_TMUX_CONF = `# honeybee keybinding-layer affordances — UNMANAGED, operator-owned.
#
# These ADD to the bindings already in this file (bees M-b, hive new M-n, the
# attention queue M-./M-,, rename M-r, needs-me switcher M-S). Paste them, or
# source-file via  source-file "$(hive keys path)"  from your ~/.tmux.conf. You
# own every binding here and every collision against your M-*/prefix set.
#
# Collision ledger (KEYBINDINGS_PRD §6):
#   1. mesh tmux layer: C-a prefix; M-s/M-j/M-d/M-D/M-t/M-w/M-Enter/M-1..5.
#   2. WezTerm cmd→Meta block (~/.wezterm.lua >>> hive >>>): cmd→M-*.
#   3. WezTerm Zellij ALT layer: takes lowercase M-f/M-n/M-i/M-o/M-p (so fork
#      rides M-k, not M-f).
#   4. Shipped hive binds: M-b hive bees, M-n hive new, M-./M-, next/prev,
#      M-r rename, M-S needs-me — so spawn-from-frame rides M-B, not M-b.
# \`hive keys check\` verifies (1)(2)(4) via \`tmux list-keys\`; (3) is
# list-keys-invisible and must be eyeballed against ~/.wezterm.lua.
#
${TMUX_BLOCK_START}

# Spawn / decompose / fork (verbs: fork-and-pane Phase B/C/D; pickers: KEYBINDINGS_PRD)
bind -n M-B display-popup -E -w 60% -h 50% \\
  "hive spawn-picker --frame | fzf --prompt='frame> ' | xargs -r -I{} hive spawn --frame {} --here"   # cmd+shift+b spawn from frame, here (M-b is hive bees)
bind -n M-F display-popup -E -w 60% -h 50% \\
  "hive spawn-picker --flow  | fzf --prompt='flow> '  | xargs -r -I{} hive flow run {}"                 # cmd+shift+f run a flow (note: most flows need --arg values)
bind -n M-k display-popup -E \\
  "hive fork \\"\$(hive here --id)\\" --here"                                                              # cmd+k fork current bee, here (M-f taken by WezTerm ALT layer)
bind -n M-x display-popup -E \\
  "hive split --here"                                                                                   # cmd+x decompose / add sub-bee (split → fork-and-pane B)

# Standalone affordances (owned here)
bind -n M-u display-popup -E -w 70% -h 60% \\
  "hive urls | fzf --prompt='url> ' --no-sort | xargs -r open"                                          # cmd+u list+open URL (xdg-open on Linux)
bind -n M-R display-popup -E -w 60% -h 20% \\
  "read -p 'rename workspace> ' n && [ -n \\"\\$n\\" ] && hive workspace rename \\"\$(hive workspace here)\\" \\"\\$n\\""  # cmd+shift+r rename workspace (both verbs → WORKSPACES)

${TMUX_BLOCK_END}
`;

/**
 * The WezTerm cmd→Meta additions (KEYBINDINGS_PRD §11). Appended to the existing
 * `hive_keys` table under the `-- >>> hive >>>` block; last-match-wins by table
 * order overrides native CMD assignments for these keys.
 */
export const CANONICAL_WEZTERM_BLOCK = `-- honeybee cmd→Meta additions — append to the existing hive_keys table in
-- ~/.wezterm.lua under the \`-- >>> hive >>>\` block (last-match-wins by order).
{ key = 'b', mods = 'SUPER|SHIFT', action = meta('B') },   -- cmd+shift+b spawn-from-frame (cmd+b is hive bees)
{ key = 'k', mods = 'SUPER',       action = meta('k') },   -- cmd+k  fork (M-f avoided: ALT layer)
{ key = 'f', mods = 'SUPER|SHIFT', action = meta('F') },   -- cmd+shift+f spawn-from-flow
{ key = 'x', mods = 'SUPER',       action = meta('x') },   -- cmd+x  split/decompose
{ key = 'u', mods = 'SUPER',       action = meta('u') },   -- cmd+u  urls
{ key = 'r', mods = 'SUPER|SHIFT', action = meta('R') },   -- cmd+shift+r rename workspace
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
  { key: "M-B", verb: "spawn-picker", note: "spawn from frame, here (M-b is hive bees)" },
  { key: "M-F", verb: "spawn-picker", delegated: true, note: "spawn swarm from flow (quest start → WORKSPACES)" },
  { key: "M-k", verb: "fork", note: "fork current bee, here" },
  { key: "M-x", verb: "split", note: "decompose / add sub-bee" },
  { key: "M-u", verb: "urls", note: "list + open URL" },
  { key: "M-R", verb: "workspace", delegated: true, note: "rename workspace (→ WORKSPACES)" },
];

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
