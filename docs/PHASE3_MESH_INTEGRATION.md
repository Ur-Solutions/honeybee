# Phase 3 — mesh integration (patch 3.8, external side)

The honeybee side of Phase 3 ships in this repo. This document is the handoff
for the **mesh** repo (not present in this workspace): what mesh provisions so
honeybee owns identity end-to-end and caam can be removed.

## 1. Replace the caam wrappers with hive-backed shims

In `mesh/profiles/zsh/.zsh_aliases`, replace the interim raw direct-home
aliases (`cc1-3` / `codex1-3`, restored as a stopgap when this plan was
drafted) with:

```zsh
# honeybee-owned auth-home aliases
for n in 1 2 3; do
  alias cc$n="hive spawn claude --home $n"
  alias codex$n="hive spawn codex --home $n"
done
```

Remove the caam codex plumbing (`codex-ursolutions` / `gmail` / `thto`
wrappers). Their accounts live in the hive vault after:

```sh
hive account import-caam
```

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
its own vault via `hive account login` or `import-caam`.

## 4. cron: periodic reconcile (req 8)

```cron
*/30 * * * * hive sessions reconcile >/dev/null
```

Surfaces cross-home duplicate session ids and syncthing conflict files;
the unified index lands in `~/.hive/sessions-index.json`.

## 5. caam deprecation checklist

- [ ] `hive account import-caam` run on every machine
- [ ] aliases swapped to the hive-backed shims (§1)
- [ ] tmux `prefix + L` bound (§2)
- [ ] syncthing folders configured from the manifest (§3)
- [ ] reconcile cron installed (§4)
- [ ] caam wrapper functions and vault removed from mesh profiles
