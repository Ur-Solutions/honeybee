/**
 * A frozen old-world store fixture for the WP7 importer tests: REAL record
 * shapes copied from a live ~/.hive/sessions (2026-08-18) and scrubbed —
 * paths, session ids, pids and account names replaced with fixture values,
 * every field the importer reads kept in its real spelling (SessionRecord,
 * ProcessBirthFingerprint's `ps lstart` startedAt text, hsr meta.json).
 *
 * SAFETY: written into a fresh mkdtemp dir; never touches ~/.hive.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLAUDE_HSR_SESSION_ID = "9aa1f08d-1446-4d78-981f-bbec462ba87b";
export const CODEX_HSR_THREAD_ID = "01a00e69-6ee4-7cd1-955c-befcbe8d9540";
export const CODEX_TMUX_THREAD_ID = "01a00e41-1009-7450-9831-137890213c02";

/** The old hive-session preamble the launcher appended (scrubbed, shortened). */
export const OLD_SYSTEM_PROMPT = '<hive-session>\nYou are a Honeybee bee: id CL.fe6f, name "apiary-waggle-msx67afb-1". Message another bee: `hive buz send <bee> …`.\n</hive-session>';

/** Real claude HSR launch argv shape (program first; harness flags + old plumbing). */
export const CLAUDE_HSR_LAUNCH_ARGV = ["claude", "--dangerously-skip-permissions", "--model", "fable", "--effort", "high", "--session-id", CLAUDE_HSR_SESSION_ID, "--append-system-prompt", OLD_SYSTEM_PROMPT];

/** Real codex HSR launch argv shape. */
export const CODEX_HSR_LAUNCH_ARGV = ["codex", "-c", "service_tier=default", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"', "-c", "features.fast_mode=false"];

/** Real claude HSR record shape (CL.fe6f, scrubbed). */
export function claudeHsrRecord(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const home = join(root, "homes", "claude-fixture-account");
  return {
    id: "CL.fe6f",
    name: "apiary-waggle-msx67afb-1",
    agent: "claude",
    cwd: join(root, "cwd-apiary"),
    tags: ["apiary:workspace=ws-a33e3761-4c6d-4f37-a8f5-b0562e07662e"],
    title: "Optimize Apiary core performance",
    command: `CLAUDE_CONFIG_DIR=${home} claude --dangerously-skip-permissions --model fable --effort high --session-id ${CLAUDE_HSR_SESSION_ID} --append-system-prompt '<hive-session>…</hive-session>'`,
    launchArgv: CLAUDE_HSR_LAUNCH_ARGV,
    providerSessionId: CLAUDE_HSR_SESSION_ID,
    transcriptPath: join(home, "projects", "-tmp-fixture-apiary", `${CLAUDE_HSR_SESSION_ID}.jsonl`),
    homePath: home,
    accountId: "claude-fixture-account",
    substrate: "hsr",
    status: "running",
    lastObservedState: "idle_with_output",
    lastObservedStateAt: "2026-08-18T07:19:33.665Z",
    createdAt: "2026-08-17T11:48:37.633Z",
    updatedAt: "2026-08-18T06:13:48.521Z",
    runnerPid: 24394,
    runnerTier: "stream",
    runnerFingerprint: { pgid: 24394, startedAt: "Tue Aug 18 07:42:57 2026" },
    tmuxTarget: "apiary-waggle-msx67afb-1",
    runtimeGeneration: 9,
    uuid: "fe6fbad7ac6b4e78af623fac0caa3e67",
    prefix: "CL.",
    requestedAgent: "claude",
    titleSource: "provider",
    combId: "apiary-waggle-msx67afb-1",
    stateMachine: { lifecycle: "active", runtime: "parked", work: "done", revision: 41, transitionedAt: "2026-08-18T06:13:48.521Z" },
    ...overrides,
  };
}

/** Real codex HSR (Apiary cell) record shape (CO.3ae1, scrubbed). */
export function codexHsrRecord(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const home = join(root, "homes", "codex-fixture-account");
  return {
    id: "CO.3ae1",
    name: "xr-dfc1452083e3",
    agent: "codex",
    cwd: join(root, "cwd-cells", "digitech-next-space"),
    tags: ["apiary:workspace=ws-cc64dd8f-c81a-4fc4-a449-e146d3ad24a5", "apiary:workspace=ws-d80b1dc7-b656-4ce7-9898-8ff46a2719bd"],
    title: "Order Module Cleanup",
    command: `CODEX_HOME=${home} HIVE_BEE=CO.3ae1 codex -c service_tier=default --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-sol -c 'model_reasoning_effort="ultra"' -c features.fast_mode=false`,
    launchArgv: CODEX_HSR_LAUNCH_ARGV,
    providerSessionId: CODEX_HSR_THREAD_ID,
    transcriptPath: join(home, "sessions", "2026", "08", "17", `rollout-2026-08-17T08-29-45-${CODEX_HSR_THREAD_ID}.jsonl`),
    homePath: home,
    accountId: "codex-fixture-account",
    substrate: "hsr",
    status: "running",
    lastObservedState: "idle_with_output",
    createdAt: "2026-08-17T06:29:45.656Z",
    updatedAt: "2026-08-18T07:12:27.523Z",
    runnerPid: 27325,
    runnerTier: "server",
    runnerFingerprint: { pgid: 27325, startedAt: "Tue Aug 18 08:54:30 2026" },
    tmuxTarget: "xr-dfc1452083e3",
    runtimeGeneration: 7,
    uuid: "3ae1e79f4a20440db3c414d3f7fd1a7a",
    prefix: "CO.",
    requestedAgent: "codex",
    titleSource: "user",
    combId: "xr-dfc1452083e3",
    stateMachine: { lifecycle: "active", runtime: "parked", work: "done", revision: 29, transitionedAt: "2026-08-18T07:12:27.523Z" },
    ...overrides,
  };
}

/** Real codex local-tmux record shape (CO.2232, scrubbed) — no `substrate` field, launcher pgid. */
export function codexTmuxRecord(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const home = join(root, "homes", "codex-fixture-account-2");
  return {
    id: "CO.2232",
    name: "CO.2232",
    agent: "codex",
    cwd: join(root, "cwd-honeybee"),
    title: "Clean Up Stale Worktrees",
    command: `CODEX_HOME=${home} codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol -c 'model_reasoning_effort="medium"'`,
    launchArgv: ["codex", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"'],
    providerSessionId: CODEX_TMUX_THREAD_ID,
    transcriptPath: join(home, "sessions", "2026", "08", "17", `rollout-2026-08-17T07-45-40-${CODEX_TMUX_THREAD_ID}.jsonl`),
    homePath: home,
    accountId: "codex-fixture-account-2",
    status: "running",
    lastObservedState: "idle_with_output",
    createdAt: "2026-08-17T05:45:39.801Z",
    updatedAt: "2026-08-17T05:47:08.026Z",
    tmuxTarget: "CO-2232",
    agentPaneId: "%122",
    launcherPgid: 95736,
    launcherFingerprint: { pgid: 95736, startedAt: "Mon Aug 17 07:45:39 2026" },
    uuid: "22326d8c7ab842278804529734f8e231",
    prefix: "CO.",
    requestedAgent: "codex",
    titleSource: "auto",
    combId: "CO-2232",
    ...overrides,
  };
}

/** Real hsr/<name>/meta.json shape (scrubbed). */
export function hsrMeta(name: string, harness: string, sessionId: string | null, hostPid = 7530): Record<string, unknown> {
  return {
    bee: name,
    harness,
    tier: harness === "codex" ? "server" : "stream",
    hostPid,
    hostFingerprint: { pgid: hostPid, startedAt: "Tue Aug 18 08:52:41 2026" },
    childAdmission: "admitted",
    startedAt: "2026-08-18T06:52:41.351Z",
    startupPhase: "harness",
    status: "running",
    childPid: hostPid + 40,
    childPgid: hostPid + 40,
    childFingerprint: { pgid: hostPid + 40, startedAt: "Tue Aug 18 08:52:41 2026" },
    ...(sessionId ? { sessionId } : {}),
    runningAt: "2026-08-18T06:52:41.367Z",
  };
}

export interface FrozenFixture {
  root: string;
  writeRecord(fileName: string, record: Record<string, unknown>): string;
  writeRaw(fileName: string, text: string): string;
  writeHsrMeta(name: string, meta: Record<string, unknown>): void;
  writeDaemonLock(lock: { pid: number; startedAt: string }): void;
  writeMarker(): void;
  cleanup(): void;
}

export function makeFrozenFixture(): FrozenFixture {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-frozen-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  // The fixture bees' cwds exist (a missing cwd is its own skip reason).
  for (const d of ["cwd-apiary", join("cwd-cells", "digitech-next-space"), "cwd-honeybee"]) mkdirSync(join(root, d), { recursive: true });
  return {
    root,
    writeRecord(fileName, record) {
      const path = join(root, "sessions", fileName);
      writeFileSync(path, JSON.stringify(record, null, 2));
      return path;
    },
    writeRaw(fileName, text) {
      const path = join(root, "sessions", fileName);
      writeFileSync(path, text);
      return path;
    },
    writeHsrMeta(name, meta) {
      mkdirSync(join(root, "hsr", name), { recursive: true });
      writeFileSync(join(root, "hsr", name, "meta.json"), JSON.stringify(meta, null, 2));
    },
    writeDaemonLock(lock) {
      mkdirSync(join(root, "daemon"), { recursive: true });
      writeFileSync(
        join(root, "daemon", "daemon.lock"),
        JSON.stringify({ ...lock, hostname: "fixture", machineId: "m", token: `${lock.pid}-x`, label: "hive daemon" }, null, 2),
      );
    },
    writeMarker() {
      writeFileSync(join(root, "FROZEN"), JSON.stringify({ frozenAt: "2026-08-18T00:00:00.000Z", by: "fixture" }));
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A "no old runtimes anywhere" probe set. */
export const deadProbes = { pidLive: () => false, tmuxSessionLive: () => false };
