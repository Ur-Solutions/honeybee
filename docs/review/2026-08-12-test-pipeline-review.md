# Test-pipeline review — 2026-08-12

Target: pipeline/runtime content merged in `3aef79bed24e395f4b988d5a05e10039427ec55f` (originally CO.289).

## Verdict

Approved with one high-priority follow-up fixed in this Cell.

The recursive daemon-worker self-spawn is fixed by `daemonWorkerArgv`. Source modules resolve `src/cli.ts`; production and global-symlink execution resolve the imported module's real `dist/cli.js`; compiled tests resolve `.test-dist/src/cli.js`. No path uses the embedding `process.argv[1]`, which is the test file under `node --test` and remains the invoked symlink when a global-style CLI symlink is executed.

The live post-merge runaway is therefore not a remaining recursive-entrypoint defect in `3aef79be`. The shipped runner did have a separate interruption defect: it forwarded signals only to the immediate `node --test` process. Test-worker descendants could survive Ctrl-C, continue consuming CPU, and write into closed output pipes. The follow-up runs each group in a dedicated POSIX process group and terminates the full group with bounded escalation.

Scope: a test subprocess that deliberately detaches into a new process group is outside that group fence and must retain its own teardown contract. One such HSR-style child from the restricted aggregate run required exact-PID cleanup; the follow-up is specifically for the observed recursive `node --test` worker tree.

## Review evidence

- Repo-local build: observer, session-list, active-index reconcile, credential sweep, and sentinel workers all spawned and completed against isolated stores.
- Global-style symlink: Node preserved the symlink in `process.argv[1]`; all five internal worker commands still completed because module-relative resolution selected `dist/cli.js`.
- EPIPE fix is causal, not diagnostic suppression: the runtime diff adds no stdout/stderr error swallowing. It removes recursive re-execution of the embedding test entry.
- Test coverage: the old `tests/*.test.ts` glob contained 277 files and the generated manifest contained the exact same 277 paths. `flow.test` and `tsLoader.test` were present in the manifest and isolated into the tsx-loaded group.
- Sampled more than ten edited tests. Assertions were unchanged except for `events.test.ts`, which added cleanup for its follower race; the rest mechanically route CLI subprocesses through `tests/cli-entry.mjs` or select the compiled flow SDK path.
- Metadata: `.test-dist/` is deliberately ignored; `esbuild@0.27.7` is a direct dev dependency and dedupes the existing `tsx` dependency; the lockfile changed only at the root dependency declaration.
- Static/targeted validation passed before and after the follow-up: `npm run check`, `npm run build`, daemon-worker regression tests, event tests, process-control unit tests, and an actual Ctrl-C run.
- Actual Ctrl-C proof: exit code 130, no EPIPE output in the direct runner, and the Cell's Node PID set was identical before/after (zero orphaned test workers).

The aggregate suite could not produce a meaningful green/known-eight comparison inside the restricted Apiary Cell: OS/substrate integration tests failed across broker sockets, tmux, fork/spawn, process groups, and HSR control. No manifest/import/path failure or spontaneous EPIPE appeared. Deployed-main full-suite verification was handed to the operator's unrestricted run.
