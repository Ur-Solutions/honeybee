# Agent Notes

## Mandatory core architecture skill

Before any work in this repository, read
`.agents/skills/honeybee-core-work/SKILL.md` completely. It is the current Honeybee v2
architecture and reliability contract and applies to every task.

## Working rules

- Inspect `git status` before editing; live bees frequently share this checkout.
- Change the deployed runtime only through `hive deploy`. Never point the live runtime
  at a mutable working tree or hand-copy build output into it.
- Typecheck, test, and build every change. Add tests for logic and state-machine behavior.
- Preserve unrelated user/agent changes in a dirty worktree.
