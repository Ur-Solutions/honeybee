const common = `You are one read-only reviewer in a 25-agent Honeybee codebase review swarm.

Repository: /Users/trmd/Projects/trmd/honeybee/repos/honeybee

Hard constraints:
- Do not edit, create, delete, move, format, patch, commit, or stage files.
- Do not use apply_patch, shell redirection, tee, cat >, perl -pi, sed -i, or scripts that write files.
- Do not run build, format, package install, or broad test commands that may write caches or generated output.
- Use inspection-only commands such as rg, sed -n, nl -ba, git diff, git status, git show, git log, wc, and read-only node snippets.
- Treat the existing dirty worktree as user work. Do not revert it. You may inspect diffs when useful.
- Prefer concrete, reproducible findings with file and line evidence. Avoid generic style advice.
- If you cannot complete because of sandbox/tooling limits, still return the output block with status "blocked" and explain.

Finish with exactly one machine-readable block:
HONEYBEE_REVIEW_JSON
{
  "shard_id": "<your shard id>",
  "status": "done|blocked",
  "summary": "<one paragraph>",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "correctness|security|performance|clean-code|best-practice|test-gap|docs",
      "title": "<short actionable title>",
      "files": [{"path": "relative/path", "line": 123}],
      "evidence": "<what you verified>",
      "impact": "<why it matters>",
      "recommendation": "<fix direction, no code diff>",
      "confidence": "high|medium|low"
    }
  ],
  "notes": ["<optional>"]
}
END_HONEYBEE_REVIEW_JSON

Return [] for findings if you found nothing concrete. Limit to the strongest 8 findings.`;

const shards = [
  {
    id: "s01-cli-command-surface",
    lens: "Correctness and UX review of CLI command dispatch, parse behavior, flag precedence, and usage errors.",
    files: "src/cli.ts, src/parse.ts, src/completion.ts, docs/HIVE_CLI_REFERENCE.md",
  },
  {
    id: "s02-spawn-agent-resolution",
    lens: "Correctness, security, and best-practice review of agent resolution, yolo/no-yolo behavior, account/profile overlays, and sandbox command construction.",
    files: "src/agents.ts, src/spawnResolve.ts, src/drivers.ts, src/accounts.ts, tests/agents.test.ts, tests/spawnResolve.unit.test.ts",
  },
  {
    id: "s03-session-store-atomicity",
    lens: "Correctness and concurrency review of session metadata persistence, atomic writes, derived fields, and dirty/corrupt record handling.",
    files: "src/store.ts, src/sessionMetadata.ts, src/hiveState.ts, src/fsx.ts, tests/state.test.ts, tests/fsx.test.ts",
  },
  {
    id: "s04-selectors-tags-colonies",
    lens: "Correctness review of selector resolution, reserved tags, colony/swarm filtering, ownership edges, and ambiguity handling.",
    files: "src/selectors.ts, src/tags.ts, src/colony.ts, src/swarm.ts, tests/tags*.test.ts, tests/cli-own-move.test.ts",
  },
  {
    id: "s05-tmux-substrate-terminal",
    lens: "Reliability and security review of tmux command construction, local/remote substrate behavior, terminal launching, pane targeting, and injection risks.",
    files: "src/tmux.ts, src/substrates/local-tmux.ts, src/substrates/ssh-tmux.ts, src/terminal.ts, src/attach.ts, tests/attach.test.ts",
  },
  {
    id: "s06-readiness-wait-tail-transcripts",
    lens: "Correctness review of readiness detection, wait semantics, transcript matching, tail output, and last-message extraction.",
    files: "src/readiness.ts, src/wait.ts, src/tail.ts, src/transcripts.ts, tests/wait.test.ts, tests/tail.test.ts",
  },
  {
    id: "s07-daemon-buz-autoswap",
    lens: "Correctness, concurrency, and recovery review of daemon ticks, buz dispatch, autoswap, daemon lock/log behavior, and background failure handling.",
    files: "src/daemon/*.ts, src/buz.ts, src/buz_format.ts, tests/daemon*.test.ts",
  },
  {
    id: "s08-flow-engine",
    lens: "Correctness, security, and cleanup review of flow definition/loading, background runs, Hive facade APIs, run metadata, and cancellation.",
    files: "src/flow/*.ts, tests/flow.test.ts, docs/HIVE_CLI_REFERENCE.md",
  },
  {
    id: "s09-loop-engine",
    lens: "Correctness and clean-code review of loop configuration, state transitions, stop conditions, summarizers, context persistence, and generated loop IDs.",
    files: "src/loop/*.ts, src/loopTemplate.ts, tests/loop.test.ts, tests/loopId.unit.test.ts, tests/loopTui.unit.test.ts",
  },
  {
    id: "s10-keychain-account-security",
    lens: "Security review of credential handling, keychain access, account activation, identity env propagation, and accidental secret exposure.",
    files: "src/keychain.ts, src/accounts.ts, src/providers.ts, src/limits.ts, tests/keychain.test.ts, tests/cli-account-spawn.test.ts",
  },
  {
    id: "s11-command-injection-quoting",
    lens: "Adversarial security review for shell quoting, argv splitting, tmux send-text boundaries, path escaping, and user-controlled command fragments.",
    files: "src/agents.ts, src/tmux.ts, src/terminal.ts, src/cli.ts, src/substrates/*.ts",
  },
  {
    id: "s12-concurrency-races-locks",
    lens: "Concurrency and correctness review of locks, ledger writes, simultaneous spawns, daemon loops, swarm/session races, and stale state recovery.",
    files: "src/lock.ts, src/store.ts, src/swarm.ts, src/daemon/*.ts, src/flow/background.ts, src/clean.ts",
  },
  {
    id: "s13-test-coverage-gaps",
    lens: "Testing review: identify high-risk behavior with missing or weak tests. Focus on concrete gaps tied to specific files and regressions.",
    files: "tests/**/*.test.ts, src/**/*.ts, docs/*TEST_CHECKLIST*.md",
  },
  {
    id: "s14-tui-sidebar-navigation",
    lens: "Correctness, UX, and clean-code review of the bees TUI/sidebar/list/next/view navigation behavior and state synchronization.",
    files: "src/beesTui.ts, src/beesSidebar.ts, src/listView.ts, src/next.ts, src/view.ts, tests/bees*.test.ts, tests/view.test.ts",
  },
  {
    id: "s15-workspaces-quests-pro",
    lens: "Correctness and best-practice review of workspace, quest, and pro-project features, including lifecycle safety and path handling.",
    files: "src/workspace.ts, src/quest.ts, src/proProjects.ts, src/cli.ts, docs/workspaces-and-quests.md, tests/proProjects.test.ts",
  },
  {
    id: "s16-packaging-config-completion",
    lens: "Best-practices review of packaging, config model, shell completion, docs/tmux config, and install/runtime assumptions.",
    files: "package.json, src/config.ts, src/completion.ts, docs/honeybee.tmux.conf, docs/README.md, tests/config.test.ts",
  },
  {
    id: "s17-performance-scalability",
    lens: "Performance and scalability review for large fleets: list/search complexity, file-system scans, tmux calls, swarm operations, and provider usage sampling.",
    files: "src/listView.ts, src/search.ts, src/usage.ts, src/limits.ts, src/swarm.ts, src/daemon/usageSampler.ts, src/clean.ts",
  },
  {
    id: "s18-cleanup-revive-reconcile",
    lens: "Correctness and recovery review of kill, clean, revive, swap, reconcile, restore, dead metadata handling, and destructive command safeguards.",
    files: "src/kill.ts, src/clean.ts, src/reconcile.ts, src/swap.ts, src/fork.ts, src/cli.ts, tests/clean.test.ts, tests/reconcile.test.ts",
  },
  {
    id: "s19-docs-implementation-consistency",
    lens: "Documentation correctness review: find mismatches between documented CLI/PRD behavior and implementation/tests.",
    files: "docs/*.md, src/cli.ts, src/**/*.ts, tests/**/*.test.ts",
  },
  {
    id: "s20-cli-god-file-clean-code",
    lens: "Clean-code and maintainability review of module boundaries, src/cli.ts size/structure, duplicated helpers, and extraction opportunities with real risk reduction.",
    files: "src/cli.ts, src/*.ts, docs/GOD_FILE_REFACTOR_PRD.md",
  },
  {
    id: "s21-typescript-error-handling",
    lens: "Type-safety and error-handling review: unchecked casts, thrown string/unknown handling, partial records, runtime validation, and misleading errors.",
    files: "src/**/*.ts, tests/**/*.test.ts",
  },
  {
    id: "s22-observability-ledger-seals-search",
    lens: "Correctness and best-practice review of ledger events, seals, search filters, observability commands, and structured handoff artifacts.",
    files: "src/seal.ts, src/search.ts, src/store.ts, src/format.ts, src/cli.ts, tests/seal.test.ts",
  },
  {
    id: "s23-provider-limits-autopick",
    lens: "Correctness and reliability review of provider limit fetching, account auto-pick, exhaustion handling, model/provider selection, and autoswap assumptions.",
    files: "src/limits.ts, src/providers.ts, src/accounts.ts, src/swap.ts, tests/limits.test.ts, tests/providers.fetchLimits.test.ts, tests/swap.test.ts",
  },
  {
    id: "s24-test-reliability-live-tests",
    lens: "Test reliability review: flaky live tmux tests, environment assumptions, timeouts, global state pollution, and missing isolation.",
    files: "tests/**/*.test.ts, package.json, src/**/*.ts",
  },
  {
    id: "s25-broad-high-impact-correctness",
    lens: "Broad high-impact correctness/security sweep across the repo. Look for severe issues other shard owners may miss, not minor style.",
    files: "src/**/*.ts, docs/**/*.md, tests/**/*.test.ts",
  },
];

export default {
  name: "honeybee-code-review-20260619",
  description: "25-agent read-only optimization, correctness, security, clean-code, and best-practices review of Honeybee.",
  castes: shards.map((shard) => ({
    name: shard.id,
    bee: "codex",
    count: 1,
    brief: `${common}

Shard: ${shard.id}
Lens: ${shard.lens}
Primary focus files: ${shard.files}

Work only this shard. You may inspect related files if needed for evidence, but do not drift into unrelated review areas.`,
  })),
};
