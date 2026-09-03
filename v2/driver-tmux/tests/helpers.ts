/**
 * tmux-driver test helpers. Every rig runs its OWN tmux server on a private
 * socket inside a fresh mkdtemp dir — the ambient tmux server (live bees!)
 * is never touched; teardown kills only the pinned private server.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DriverObservation } from "../../harness/src/driver.ts";
import { sessionNameFor, TmuxDriver, type ObservationSpec, type TmuxSpawnSpec } from "../src/driver.ts";
import { exactPaneTarget, TmuxServer } from "../src/tmux.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_PATH = join(here, "..", "test-agent", "agent.mjs");

export type StubStyle = "hooks" | "notify" | "transcript" | "agy-hooks" | "agy-pane-fallback" | "silent";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The per-style observation spec — mirrors the harness each style models. */
export function observationFor(
  style: StubStyle,
  transcriptDir: string,
  cwd = transcriptDir,
  timing: { deliveryGraceMs?: number } = {},
): ObservationSpec {
  const quiesceMs = 80;
  const deliveryGraceMs = timing.deliveryGraceMs ?? 800;
  switch (style) {
    case "hooks": // claude-shaped: hook events + claude transcript baseline
      return {
        transcript: { locator: { dir: transcriptDir, match: /\.jsonl$/ }, parser: "claude" },
        quiesceMs,
        deliveryGraceMs,
      };
    case "notify": // codex-shaped: notify events + codex rollout baseline
      return {
        transcript: { locator: { dir: transcriptDir, match: /^rollout-.*\.jsonl$/ }, parser: "codex" },
        quiesceMs,
        deliveryGraceMs,
      };
    case "transcript": // grok/opencode-shaped: transcript file ONLY
      return {
        transcript: { locator: { dir: transcriptDir, match: /chat_history\.jsonl$/, depth: 2 }, parser: "grok" },
        quiesceMs,
        deliveryGraceMs,
      };
    case "agy-hooks": // agy TUI-shaped: generic hook events + SQLite render mirror
      return {
        hooks: { kind: "agy" },
        explicitTurnEnd: true,
        transcriptMirror: {
          locator: { dir: transcriptDir, match: /\.db$/, depth: 1, format: "agy-sqlite", containsAny: [cwd, `file://${cwd}`] },
        },
        quiesceMs,
        deliveryGraceMs,
      };
    case "agy-pane-fallback": // agy without hooks: pane activity + SQLite render mirror, no transcript lifecycle
      return {
        paneFallback: true,
        transcriptMirror: {
          locator: { dir: transcriptDir, match: /\.db$/, depth: 1, format: "agy-sqlite", containsAny: [cwd, `file://${cwd}`] },
        },
        quiesceMs,
        deliveryGraceMs,
      };
    case "silent": // no files at all: pane-content fallback
      return { paneFallback: true, quiesceMs, deliveryGraceMs };
  }
}

export interface TmuxRig {
  dir: string;
  socketPath: string;
  driver: TmuxDriver;
  /** Per-bee style + extra env + delivery mode (set before start()). */
  configure: (
    beeId: string,
    style: StubStyle,
    env?: Record<string, string>,
    deliveryMode?: "paste" | "type",
  ) => void;
  transcriptDirOf: (beeId: string) => string;
  makeSiblingDriver: () => TmuxDriver;
  cleanup: () => void;
}

export function makeRig(opts: { sessionLogDir?: boolean; deliveryGraceMs?: number } = {}): TmuxRig {
  const dir = mkdtempSync(join(tmpdir(), "hbtmx-"));
  const socketPath = join(dir, "tmux.sock");
  const sessionLogDir = opts.sessionLogDir ? join(dir, "logs") : undefined;
  const styles = new Map<
    string,
    { style: StubStyle; env: Record<string, string>; deliveryMode?: "paste" | "type" }
  >();
  const transcriptDirOf = (beeId: string): string => join(dir, "tx", beeId);
  const resolve = (beeId: string): TmuxSpawnSpec => {
    const cfg = styles.get(beeId) ?? { style: "transcript" as StubStyle, env: {} };
    return {
      command: process.execPath,
      args: [AGENT_PATH],
      cwd: dir,
      env: {
        TMUX_STUB_STYLE: cfg.style,
        TMUX_STUB_TRANSCRIPT_DIR: transcriptDirOf(beeId),
        TMUX_STUB_TURN_MS: "20",
        ...cfg.env,
      },
      ...(cfg.deliveryMode ? { deliveryMode: cfg.deliveryMode } : {}),
      observation: observationFor(cfg.style, transcriptDirOf(beeId), dir, { deliveryGraceMs: opts.deliveryGraceMs }),
    };
  };
  const makeDriver = (): TmuxDriver =>
    new TmuxDriver({
      socketPath,
      eventsDir: join(dir, "events"),
      ...(sessionLogDir ? { sessionLogDir } : {}),
      resolve,
      stopKillGraceMs: 400,
      allowKillServer: true,
    });
  const driver = makeDriver();
  return {
    dir,
    socketPath,
    driver,
    configure: (beeId, style, env = {}, deliveryMode) =>
      styles.set(beeId, { style, env, ...(deliveryMode ? { deliveryMode } : {}) }),
    transcriptDirOf,
    makeSiblingDriver: makeDriver,
    cleanup: () => {
      driver.disposeAll();
      try {
        new TmuxServer({ socketPath, allowKillServer: true }).killServer();
      } catch {
        // Server already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function drainUntil(
  driver: TmuxDriver,
  pred: (events: DriverObservation[]) => boolean,
  timeoutMs = 6000,
): Promise<DriverObservation[]> {
  const acc: DriverObservation[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    acc.push(...driver.observe());
    if (pred(acc)) return acc;
    if (Date.now() > deadline) throw new Error(`drainUntil timeout; saw: ${JSON.stringify(acc)}`);
    await sleep(8);
  }
}

export function kinds(events: DriverObservation[]): string[] {
  return events.map((e) => e.kind);
}

/**
 * Pump observe() for `ms`, collecting whatever drains. Models the daemon
 * ticking through a runtime's boot settling (transcript binding, boot
 * output) before the first delivery — the shape real delivery loops have.
 */
export async function settle(driver: TmuxDriver, ms: number): Promise<DriverObservation[]> {
  const acc: DriverObservation[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    acc.push(...driver.observe());
    await sleep(10);
  }
  return acc;
}

export async function waitForStubReady(rig: TmuxRig, beeId: string, generation = 1): Promise<void> {
  const server = new TmuxServer({ socketPath: rig.socketPath });
  const pane = exactPaneTarget(sessionNameFor(beeId, generation));
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const res = server.try(["capture-pane", "-p", "-t", pane]);
    if (res.status === 0 && res.stdout.includes("stub ready")) return;
    await sleep(25);
  }
  throw new Error(`${beeId}: stub TUI never reached ready line`);
}
