# Phase 3 — mesh integration (patch 3.8, external side)

The honeybee side of Phase 3 ships in this repo. This document is the handoff
for the **mesh** repo (not present in this workspace): what mesh provisions so
honeybee owns identity end-to-end.

## 1. hive-backed auth-home aliases

In `mesh/profiles/zsh/.zsh_aliases`, replace any raw direct-home aliases with:

```zsh
# honeybee-owned auth-home aliases
for n in 1 2 3; do
  alias cc$n="hive spawn claude --home $n"
  alias codex$n="hive spawn codex --home $n"
done
```

Accounts are vaulted per machine with `hive account add <tool> <label>` +
`hive login <account>` (or `hive account capture <account> --home <path>` from
an already-logged-in home). Account-bound shorthands then work everywhere:
`hive xa codex-ur`, `hive open claude-thto`.

## 2. tmux login hotkey (req 3)

`prefix + L` opens an fzf account picker in a popup and runs the interactive
login seat:

```tmux
bind-key L display-popup -E -w 80% -h 70% \
  'hive account list | tail -n +2 | fzf --header="re-login which account?" | awk "{print \$1}" | xargs -r -I{} hive login {}'
```

(`hive login <account> --popup` prints the canonical popup invocation if you
want to generate this binding.)

## 3. syncthing folder config (req 9)

Generate the manifest and mirror it into the syncthing folder ignore rules:

```sh
hive sync manifest --json
```

Include/exclude semantics: all of `~/.hive/` **minus** `vault/`, `homes/` and
lock files; per-tool transcript trees (`~/.claude*/projects/`,
`~/.codex*/sessions/`); never `.credentials.json` / `auth.json` / caches /
`*.sync-conflict*`. Credentials never leave a machine — each machine builds
its own vault via `hive account login` / `hive account capture`.

## 4. cron: periodic reconcile (req 8)

```cron
*/30 * * * * hive sessions reconcile >/dev/null
```

Surfaces cross-home duplicate session ids and syncthing conflict files;
the unified index lands in `~/.hive/sessions-index.json`.

## 5. provisioning checklist

- [ ] vault built on every machine (`hive account add` + `hive login` / `capture`)
- [ ] aliases swapped to the hive-backed shims (§1)
- [ ] tmux `prefix + L` bound (§2)
- [ ] syncthing folders configured from the manifest (§3)
- [ ] reconcile cron installed (§4)
