/**
 * TmuxDriver — the tmux substrate driver (WP5, spec 05).
 *
 * Implements the WP2 RuntimeDriver contract over detached tmux sessions on a
 * PRIVATE per-daemon socket (tmux.ts). The driver is not the runtime's
 * parent — tmux's server is — so every certainty the HSR driver gets from
 * parenthood is re-derived from exact identity + file truth:
 *
 *  - Spawn (point 1): a detached session runs the harness CLI directly (the
 *    pane process IS the CLI); pid + start-time are captured at spawn. Pane
 *    and session names are NEVER signal targets — signals go to the recorded
 *    pid only, after verifying its OS start time (the CO.a8d2 lesson).
 *  - Observation (point 2, A3): a per-runtime observer stack, in order of
 *    preference: (a) the driver-owned hook/notify events file, (b) transcript
 *    files whose records carry structured lifecycle evidence, (c) pane-content
 *    change detection (activity/quiescence only — no string parsing),
 *    expected to be needed by zero harnesses. Render-only mirrors, such as
 *    agy's SQLite DB projection, feed session logs but never runtime state.
 *    All lifecycle sources fold into one phase machine, so hooks-based,
 *    notify-based and transcript-only harnesses produce IDENTICAL automation
 *    outcomes (the spec05.eq matrix).
 *  - Deliver (point 3): VALIDATED injection, then Enter. Text goes in via
 *    paste-buffer (default) or literal typed chunks (`deliveryMode: "type"`,
 *    for TUIs that ignore the tmux paste buffer entirely — grok, verified
 *    live 2026-08-17). Before Enter is ever pressed the driver captures the
 *    pane and verifies the body's tail is actually visible (echo-verify);
 *    on mismatch it clears the input line and reinjects once by typing (which
 *    demonstrably lands where paste doesn't). Only verified input is
 *    submitted — a still-mismatched injection is never Entered and surfaces
 *    an IMMEDIATE `echo_mismatch` unconfirmed note. On top of that the
 *    observer validates the turn itself (turn start within grace); an
 *    unconfirmed delivery carries a visible retryable NOTE
 *    (observeDeliveryNotes) — never a fence, never a state.
 *  - Stop/adopt (point 1): exact-pid TERM→KILL; snapshotLive() from recorded
 *    identities; after a daemon restart adopt() re-binds the surviving
 *    session by verified pid and re-attaches observers at EOF — the runtime
 *    stays fully deliverable (tmux runtimes are never "degraded").
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  DeliverOutcome,
  DriverObservation,
  InterruptOutcome,
  LiveProcess,
  RuntimeDriver,
  StopCause,
} from "../../harness/src/driver.ts";
import { pidAlive, verifyProcessIdentity } from "../../driver-hsr/src/psutil.ts";
import { exactPaneTarget, exactSession, shQuote, TmuxServer } from "./tmux.ts";
import { AgySqliteTail } from "./agy-sqlite-tail.ts";
import { JsonlTail } from "./tail.ts";
import { parseEventsFileLine } from "./events-file.ts";
import {
  findTranscript,
  TRANSCRIPT_PARSERS,
  type TranscriptEvent,
  type TranscriptLocator,
  type TranscriptParser,
} from "./transcripts.ts";

export interface ObservationSpec {
  /** The mandatory transcript baseline: where this harness writes its file. */
  transcript?: { locator: TranscriptLocator; parser: TranscriptParser | string };
  /**
   * Optional render-only source. Lines from this source are copied into the
   * session log but never folded into runtime lifecycle state.
   */
  transcriptMirror?: { locator: TranscriptLocator };
  /** Driver-installed hook roots for harnesses whose lifecycle comes from HIVE_EVENTS_FILE. */
  hooks?: { kind: "agy" };
  /** Suppress quiescence end detection when hooks/notify provide explicit end events. */
  explicitTurnEnd?: boolean;
  /** Source (c): pane-content change detection. Only for file-less harnesses. */
  paneFallback?: boolean;
  /** Quiescence window for formats without an explicit turn-end record. Default 400ms. */
  quiesceMs?: number;
  /** Grace for observer validation of a delivery. Default 5000ms. */
  deliveryGraceMs?: number;
}

export interface TmuxSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /**
   * How message bodies are injected into the pane (spec 05 point 3):
   *  - "paste" (default): tmux load-buffer + paste-buffer — fast and
   *    multiline-safe.
   *  - "type": literal send-keys chunks with keystroke pacing, for TUIs that
   *    take NOTHING from the tmux paste buffer (grok, verified live
   *    2026-08-17). Single-line bodies only: a literal newline would submit
   *    mid-body, so multiline bodies are refused `not_ready` with detail
   *    "multiline_type_mode" — the daemon can route/paste them later.
   * Both modes echo-verify before submitting (see deliver()).
   */
  deliveryMode?: "paste" | "type";
  observation: ObservationSpec;
}

export interface TmuxDriverConfig {
  /** The private per-daemon-instance socket (never the ambient server). */
  socketPath: string;
  /** Driver-owned dir for per-bee hook/notify events files. */
  eventsDir: string;
  /**
   * When set, transcript lines are mirrored into `<sessionLogDir>/<beeId>.jsonl`
   * so Apiary's session-log follower (and `hive transcript`) see TUI bees the
   * same way they see HSR bees.
   */
  sessionLogDir?: string;
  resolve(beeId: string): TmuxSpawnSpec;
  stopKillGraceMs?: number;
  adoptToleranceMs?: number;
  /** Test rigs only: allows killServer() teardown of the pinned socket. */
  allowKillServer?: boolean;
  now?: () => number;
}

/** A visible, retryable delivery annotation (spec 05 point 3) — NOT a state. */
export interface DeliveryNote {
  beeId: string;
  generation: number;
  messageId: number;
  kind: "unconfirmed";
  detail: string;
  at: number;
}

interface PendingConfirm {
  messageId: number;
  deadline: number;
}

interface TranscriptTail {
  readonly path: string;
  poll(): string[];
}

interface TmuxRuntime {
  beeId: string;
  generation: number;
  sessionName: string;
  paneId: string;
  deliveryMode: "paste" | "type";
  pid: number;
  pidStartedAt: number;
  spawnedAt: number;
  adopted: boolean;
  phase: "running" | "idle";
  stopCause: StopCause | null;
  killTimer: NodeJS.Timeout | null;
  exited: boolean;
  // observer stack
  eventsTail: JsonlTail;
  transcriptLocator: TranscriptLocator | null;
  transcriptParser: TranscriptParser | null;
  transcriptTail: TranscriptTail | null;
  mirrorLocator: TranscriptLocator | null;
  mirrorTail: TranscriptTail | null;
  lastBindScanAt: number;
  lastMirrorBindScanAt: number;
  paneFallback: boolean;
  paneHash: string | null;
  lastPanePollAt: number;
  explicitTurnEnd: boolean;
  quiesceMs: number;
  deliveryGraceMs: number;
  lastActivityAt: number;
  sawOutputThisTurn: boolean;
  pendingConfirms: PendingConfirm[];
}

const BIND_SCAN_INTERVAL_MS = 50;
const PANE_POLL_INTERVAL_MS = 150;

// Delivery injection tuning (spec 05 point 3, live-calibrated 2026-08-17):
// type mode pre-delays so a TUI's input handler is actually listening (grok
// ate the first ~2 chars of an immediate send-keys burst), then sends small
// literal chunks with keystroke pacing. Echo-verify polls the pane for the
// body's tail before Enter is ever pressed.
const TYPE_PRE_DELAY_MS = 300;
const TYPE_CHUNK_CHARS = 8;
const TYPE_CHUNK_GAP_MS = 50;
const ECHO_TAIL_CHARS = 24;
const ECHO_VERIFY_TIMEOUT_MS = 2_000;
const ECHO_VERIFY_POLL_MS = 100;

/** Synchronous sleep — the driver is fully synchronous (spawnSync tmux). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Normalize pane text for echo matching: drop all whitespace (TUI input
 * boxes wrap and trim) and common box-drawing glyphs (borders can interpose
 * where a wrapped line breaks). Applied to both haystack and needle.
 */
function normalizeEcho(s: string): string {
  return s.replace(/[\s─│╭╮╰╯┌┐└┘┃━]/g, "");
}

/** The body's verification tail: last N chars of the normalized body. */
function echoTail(body: string): string | null {
  const norm = normalizeEcho(body);
  if (norm.length === 0) return null;
  return norm.slice(-ECHO_TAIL_CHARS);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

/** The driver's session-name convention — exported so `hive v2 attach` can address the recorded session. */
export function sessionNameFor(beeId: string, generation: number): string {
  return `hive-v2-${safePathSegment(beeId)}-g${generation}`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function agyEventHookCommand(event: "turn_started" | "turn_ended" | "output"): string {
  const payload = JSON.stringify({ event });
  return `if [ -n "$HIVE_EVENTS_FILE" ]; then printf '%s\\n' '${payload}' >> "$HIVE_EVENTS_FILE"; fi; printf '{}\\n'`;
}

export class TmuxDriver implements RuntimeDriver {
  private readonly cfg: TmuxDriverConfig;
  private readonly server: TmuxServer;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly adoptTolMs: number;
  private readonly procs = new Map<string, TmuxRuntime>();
  private readonly pendingStarts = new Map<string, { generation: number }>();
  private events: DriverObservation[] = [];
  private notes: DeliveryNote[] = [];
  private readonly consumed = new Map<number, number>();
  private deliverSeq = 0;

  constructor(cfg: TmuxDriverConfig) {
    this.cfg = cfg;
    this.server = new TmuxServer({
      socketPath: cfg.socketPath,
      allowKillServer: cfg.allowKillServer ?? false,
    });
    this.now = cfg.now ?? Date.now;
    this.graceMs = cfg.stopKillGraceMs ?? 5000;
    this.adoptTolMs = cfg.adoptToleranceMs ?? 5000;
    mkdirSync(cfg.eventsDir, { recursive: true });
    if (cfg.sessionLogDir) mkdirSync(cfg.sessionLogDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // RuntimeDriver
  // -------------------------------------------------------------------------

  start(beeId: string, generation: number): void {
    const existing = this.procs.get(beeId);
    if (existing && !existing.exited) {
      if (existing.stopCause != null || this.pendingStarts.has(beeId)) {
        this.pendingStarts.set(beeId, { generation });
        return;
      }
      throw new Error(
        `tmux driver: bee ${beeId} already has a live runtime (generation ${existing.generation}, pid ${existing.pid})`,
      );
    }
    const spec = this.cfg.resolve(beeId);
    const sessionName = sessionNameFor(beeId, generation);
    const eventsPath = this.eventsFilePath(beeId);
    const envFlags: string[] = [];
    const env = {
      ...(spec.env ?? {}),
      HIVE_EVENTS_FILE: eventsPath,
      HIVE_BEE_ID: beeId,
    };
    for (const [k, v] of Object.entries(env)) envFlags.push("-e", `${k}=${v}`);
    let args: string[];
    try {
      args = this.argsForSpawn(beeId, generation, spec);
    } catch {
      this.events.push({ beeId, generation, kind: "exited", exitCause: "crashed" });
      return;
    }
    const shellCommand = [spec.command, ...args].map(shQuote).join(" ");
    let paneId: string;
    let pid: number;
    const spawnedAt = this.now();
    try {
      this.server.run([
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        spec.cwd,
        "-x",
        "220",
        "-y",
        "50",
        ...envFlags,
        shellCommand,
      ]);
      // remain-on-exit keeps a dead pane around so #{pane_dead_status}
      // yields the CLI's exit code (clean vs crashed) — our only substitute
      // for a parent's child-exit fact.
      this.server.run(["set-option", "-t", exactPaneTarget(sessionName), "remain-on-exit", "on"]);
      const info = this.server.run([
        "display-message",
        "-p",
        "-t",
        exactPaneTarget(sessionName),
        "#{pane_id} #{pane_pid}",
      ]);
      const [rawPane, rawPid] = info.split(" ");
      paneId = rawPane ?? "";
      pid = Number(rawPid ?? "-1");
      if (paneId.length === 0 || !Number.isFinite(pid) || pid <= 0) {
        throw new Error(`tmux driver: could not resolve pane identity for ${sessionName} ('${info}')`);
      }
    } catch {
      // A failed spawn is a crash fact, not a driver throw — it flows
      // through the daemon's spawn-retry path exactly like HSR.
      this.tryKillSession(sessionName);
      this.events.push({ beeId, generation, kind: "exited", exitCause: "crashed" });
      return;
    }
    let runtime: TmuxRuntime;
    try {
      runtime = this.newRuntime({
        beeId,
        generation,
        sessionName,
        paneId,
        pid,
        pidStartedAt: spawnedAt,
        spawnedAt,
        adopted: false,
        spec,
      });
    } catch {
      this.tryKillSession(sessionName);
      this.events.push({ beeId, generation, kind: "exited", exitCause: "crashed" });
      return;
    }
    this.procs.set(beeId, runtime);
    // The pane exists and the CLI is launched: booted, straight to idle
    // (the bootedToIdle normalization — a tmux harness boots to its input
    // box; the initial turn is empty). Early keystrokes buffer in the pty.
    this.events.push({ beeId, generation, kind: "booted", pid, pidStartedAt: spawnedAt });
    this.events.push({ beeId, generation, kind: "turn_ended" });
  }

  deliver(beeId: string, generation: number, messageId: number, body: string): DeliverOutcome {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { accepted: false, reason: "no_process" };
    if (p.stopCause != null) return { accepted: false, reason: "not_ready" };
    if (p.deliveryMode === "type" && body.includes("\n")) {
      // Typed delivery cannot carry newlines — each would submit mid-body.
      // Typed refusal reason: the daemon can route this body for paste
      // delivery (or split it) later; the mailbox record stays durable truth.
      return { accepted: false, reason: "not_ready", detail: "multiline_type_mode" };
    }
    // Validated injection (spec point 3, hardened 2026-08-17): inject, then
    // PROVE the text reached the input line before Enter is ever pressed.
    // Live evidence this guards: grok takes nothing from the paste buffer
    // and eats the first keystrokes of an unpaced burst; codex silently
    // swallows a paste during its post-turn redraw.
    const tail = echoTail(body);
    const before = tail == null ? 0 : this.countTailInPane(p, tail);
    try {
      this.inject(p, body, p.deliveryMode);
    } catch {
      return { accepted: false, reason: "no_process" };
    }
    let verified = tail == null ? true : this.verifyEcho(p, tail, before);
    if (!verified && tail != null) {
      // One reinjection: clear the input line, re-send by TYPING (paced
      // literal chunks demonstrably land where paste doesn't), verify again.
      // Multiline bodies cannot be typed, so they re-paste.
      this.server.try(["send-keys", "-t", p.paneId, "C-u"]);
      const retryMode: "paste" | "type" = body.includes("\n") ? "paste" : "type";
      const beforeRetry = this.countTailInPane(p, tail);
      try {
        this.inject(p, body, retryMode);
        verified = this.verifyEcho(p, tail, beforeRetry);
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      // Honest failure: NEVER submit unverified input. Clear the residue and
      // surface the retryable unconfirmed note IMMEDIATELY (reason
      // echo_mismatch) — same contract as a grace-elapsed unconfirmed
      // delivery, without waiting for a grace the driver already knows
      // cannot be met. The mailbox record stays durable truth; the daemon's
      // note-driven re-deliver owns the retry.
      this.server.try(["send-keys", "-t", p.paneId, "C-u"]);
      this.consumed.set(messageId, generation);
      this.notes.push({
        beeId,
        generation,
        messageId,
        kind: "unconfirmed",
        detail: `echo_mismatch: injected text for message ${messageId} never appeared in the input line (mode ${p.deliveryMode}, one typed reinjection attempted) — not submitted; retry available`,
        at: this.now(),
      });
      return { accepted: true };
    }
    try {
      this.server.run(["send-keys", "-t", p.paneId, "Enter"]);
    } catch {
      return { accepted: false, reason: "no_process" };
    }
    // Echo-verify proved the INJECTION; the observer still proves the TURN.
    // The mailbox record is durable truth; an unconfirmed turn within grace
    // surfaces as a visible note.
    this.consumed.set(messageId, generation);
    if (p.phase === "idle") {
      p.pendingConfirms.push({ messageId, deadline: this.now() + p.deliveryGraceMs });
    }
    return { accepted: true };
  }

  /** Put `body` into the pane's input line (no submit). Throws on tmux failure. */
  private inject(p: TmuxRuntime, body: string, mode: "paste" | "type"): void {
    if (mode === "type") {
      // Let the TUI's input handler catch up before the first keystroke
      // (grok ate the first ~2 chars of an immediate burst, verified live).
      sleepSync(TYPE_PRE_DELAY_MS);
      for (let i = 0; i < body.length; i += TYPE_CHUNK_CHARS) {
        if (i > 0) sleepSync(TYPE_CHUNK_GAP_MS);
        const chunk = body.slice(i, i + TYPE_CHUNK_CHARS);
        // `--` ends option parsing (chunks may start with "-"); a bare ";"
        // would otherwise be tmux's command separator.
        this.server.run(["send-keys", "-l", "-t", p.paneId, "--", chunk === ";" ? "\\;" : chunk]);
      }
      return;
    }
    const buf = `hive-v2-deliver-${this.deliverSeq++}`;
    try {
      // load-buffer avoids send-keys key interpretation of the body.
      this.server.run(["load-buffer", "-b", buf, "-"], { input: body });
      this.server.run(["paste-buffer", "-d", "-b", buf, "-t", p.paneId]);
    } catch (err) {
      this.server.try(["delete-buffer", "-b", buf]);
      throw err;
    }
  }

  private countTailInPane(p: TmuxRuntime, tail: string): number {
    const res = this.server.try(["capture-pane", "-p", "-t", p.paneId]);
    if (res.status !== 0) return 0;
    return countOccurrences(normalizeEcho(res.stdout), tail);
  }

  /**
   * Echo verification: poll the pane until the tail's occurrence count rises
   * above the pre-injection count (count-based so re-delivering the SAME
   * body is not false-confirmed by scrollback). Wall-clock, not cfg.now —
   * this races a real terminal.
   */
  private verifyEcho(p: TmuxRuntime, tail: string, before: number): boolean {
    const deadline = Date.now() + ECHO_VERIFY_TIMEOUT_MS;
    for (;;) {
      if (this.countTailInPane(p, tail) > before) return true;
      if (Date.now() >= deadline) return false;
      sleepSync(ECHO_VERIFY_POLL_MS);
    }
  }

  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    const pending = this.pendingStarts.get(beeId);
    if (pending && pending.generation === generation) {
      this.pendingStarts.delete(beeId);
      this.events.push({ beeId, generation, kind: "exited", exitCause: cause });
      return { hadProcess: true };
    }
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { hadProcess: false };
    if (p.stopCause == null) p.stopCause = cause;
    this.signal(p, "SIGTERM");
    if (p.killTimer == null) {
      p.killTimer = setTimeout(() => {
        if (!p.exited) this.signal(p, "SIGKILL");
      }, this.graceMs);
      p.killTimer.unref();
    }
    return { hadProcess: true };
  }

  /**
   * v6 interrupt: `send-keys C-c` to the exact pane of a live, mid-turn
   * runtime (the operator-chosen interactive-TUI interrupt: claude, codex and
   * grok all cancel the in-flight turn on a single Ctrl-C and stay at their
   * input box). No echo-verify applies (a control key has no echo); the
   * observer stack confirms the outcome as the ordinary turn_ended. Idle /
   * dying / gone: a reasoned no-op, never an error.
   */
  interrupt(beeId: string, generation: number): InterruptOutcome {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { interrupted: false, reason: "no_process" };
    if (p.stopCause != null) return { interrupted: false, reason: "not_ready" };
    if (p.phase === "idle") return { interrupted: false, reason: "idle" };
    const res = this.server.try(["send-keys", "-t", p.paneId, "C-c"]);
    if (res.status !== 0) return { interrupted: false, reason: "no_process" };
    return { interrupted: true };
  }

  observe(): DriverObservation[] {
    for (const p of [...this.procs.values()]) this.harvest(p);
    const out = this.events;
    this.events = [];
    return out;
  }

  hasProcess(beeId: string, generation: number): boolean {
    const pending = this.pendingStarts.get(beeId);
    if (pending && pending.generation === generation) return true;
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation && !p.exited;
  }

  snapshotLive(): LiveProcess[] {
    return [...this.procs.values()]
      .filter((p) => !p.exited && p.pid > 0)
      .map((p) => ({ beeId: p.beeId, generation: p.generation, pid: p.pid, pidStartedAt: p.pidStartedAt }));
  }

  // -------------------------------------------------------------------------
  // Beyond the WP2 interface
  // -------------------------------------------------------------------------

  /**
   * Cross-restart re-adoption: re-bind a surviving tmux session by exact
   * identity (pid alive + OS start-time match + the session's pane still
   * hosting that exact pid). Unlike HSR, an adopted tmux runtime is FULLY
   * functional: send-keys delivery still works and the observer stack
   * re-attaches at EOF (no history replay) — deliverable after restart.
   */
  adopt(
    beeId: string,
    generation: number,
    pid: number,
    pidStartedAt: number,
    _lastKnownState?: "booting" | "running" | "idle",
    _lastAppliedObservationCursor?: number | null,
    _providerSessionId?: string | null,
  ): boolean {
    if (pid <= 0) return false;
    if (this.procs.has(beeId) || this.pendingStarts.has(beeId)) return false;
    if (!verifyProcessIdentity(pid, pidStartedAt, this.adoptTolMs)) return false;
    const sessionName = sessionNameFor(beeId, generation);
    let paneId: string;
    try {
      const info = this.server.run([
        "display-message",
        "-p",
        "-t",
        exactPaneTarget(sessionName),
        "#{pane_id} #{pane_pid}",
      ]);
      const [rawPane, rawPid] = info.split(" ");
      if (Number(rawPid ?? "-1") !== pid) return false; // name is not identity; the pid is
      paneId = rawPane ?? "";
      if (paneId.length === 0) return false;
    } catch {
      return false;
    }
    let spec: TmuxSpawnSpec;
    try {
      spec = this.cfg.resolve(beeId);
    } catch {
      return false;
    }
    let runtime: TmuxRuntime;
    try {
      runtime = this.newRuntime({
        beeId,
        generation,
        sessionName,
        paneId,
        pid,
        pidStartedAt,
        spawnedAt: pidStartedAt,
        adopted: true,
        spec,
      });
    } catch {
      return false;
    }
    // Safe claim: "running" — the event stream between daemons is gone. The
    // observers re-establish truth: fresh activity confirms running, and
    // quiescence (sawOutputThisTurn starts true for adopted runtimes)
    // settles it to idle without requiring a new turn.
    runtime.phase = "running";
    runtime.sawOutputThisTurn = true;
    this.procs.set(beeId, runtime);
    return true;
  }

  /** Drain delivery annotations (visible, retryable; never a state/fence). */
  /** Tmux adopted runtimes keep their pane pipes — never degraded. */
  isDegraded(_beeId: string, _generation: number): boolean {
    return false;
  }

  observeEvidence(): [] {
    return [];
  }

  observeSessions(): [] {
    return [];
  }

  sessionLogPath(beeId: string): string | null {
    return this.cfg.sessionLogDir ? join(this.cfg.sessionLogDir, `${beeId}.jsonl`) : null;
  }

  observeDeliveryNotes(): DeliveryNote[] {
    const out = this.notes;
    this.notes = [];
    return out;
  }

  procOf(beeId: string, generation: number): { pid: number; pidStartedAt: number } | null {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.pid <= 0) return null;
    return { pid: p.pid, pidStartedAt: p.pidStartedAt };
  }

  eventsFilePath(beeId: string): string {
    return join(this.cfg.eventsDir, `${safePathSegment(beeId)}.events.jsonl`);
  }

  private argsForSpawn(beeId: string, generation: number, spec: TmuxSpawnSpec): string[] {
    this.validateObservation(spec.observation);
    if (spec.observation.hooks?.kind !== "agy") return spec.args;
    const root = this.installAgyHooks(beeId, generation);
    return [...spec.args, "--add-dir", root];
  }

  private validateObservation(obs: ObservationSpec): void {
    if (obs.transcript?.locator.format === "agy-sqlite") {
      throw new Error("tmux driver: agy SQLite locators are render-only transcript mirrors, not lifecycle observers");
    }
  }

  private installAgyHooks(beeId: string, generation: number): string {
    const root = join(this.cfg.eventsDir, "agy-hooks", `${safePathSegment(beeId)}-g${generation}`);
    // agy only loads added-workspace hooks from `<workspace>/.agents/hooks.json`
    // (root-level hooks.json did not load in the 2026-09-03 probe). The added
    // workspace is per runtime and driver-owned; keep it empty except this one
    // hook config so `--add-dir` exposes no source tree, token, or helper script.
    rmSync(root, { recursive: true, force: true });
    const agentsDir = join(root, ".agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "hooks.json"),
      `${JSON.stringify(
        {
          "hive-v2-events": {
            PreInvocation: [{
              type: "command",
              command: agyEventHookCommand("turn_started"),
              timeout: 5,
            }],
            PostInvocation: [{
              type: "command",
              command: agyEventHookCommand("output"),
              timeout: 5,
            }],
            Stop: [{
              type: "command",
              command: agyEventHookCommand("turn_ended"),
              timeout: 5,
            }],
          },
        },
        null,
        2,
      )}\n`,
    );
    return root;
  }

  // --- delivery ground truth (invariant gate) ------------------------------

  consumedGeneration(messageId: number): number | undefined {
    return this.consumed.get(messageId);
  }

  consumedCount(): number {
    return this.consumed.size;
  }

  liveProcesses(): LiveProcess[] {
    return this.snapshotLive();
  }

  /** Daemon shutdown: nothing to release — tmux holds the runtimes. */
  detachAll(): void {
    for (const p of this.procs.values()) {
      if (p.killTimer) {
        clearTimeout(p.killTimer);
        p.killTimer = null;
      }
    }
  }

  /** Test/teardown only: SIGKILL every runtime and remove its session. */
  disposeAll(): void {
    this.pendingStarts.clear();
    for (const p of this.procs.values()) {
      if (p.killTimer) clearTimeout(p.killTimer);
      if (!p.exited) {
        if (p.stopCause == null) p.stopCause = "stopped_by_system";
        this.signal(p, "SIGKILL");
      }
      this.tryKillSession(p.sessionName);
    }
    this.events = [];
    this.notes = [];
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private newRuntime(init: {
    beeId: string;
    generation: number;
    sessionName: string;
    paneId: string;
    pid: number;
    pidStartedAt: number;
    spawnedAt: number;
    adopted: boolean;
    spec: TmuxSpawnSpec;
  }): TmuxRuntime {
    const obs = init.spec.observation;
    let parser: TranscriptParser | null = null;
    if (obs.transcript) {
      if (obs.transcript.locator.format === "agy-sqlite") {
        throw new Error("tmux driver: agy SQLite locators are render-only transcript mirrors, not lifecycle observers");
      }
      parser =
        typeof obs.transcript.parser === "string"
          ? TRANSCRIPT_PARSERS[obs.transcript.parser] ?? null
          : obs.transcript.parser;
      if (parser == null) {
        throw new Error(`tmux driver: unknown transcript parser '${String(obs.transcript.parser)}'`);
      }
    }
    return {
      beeId: init.beeId,
      generation: init.generation,
      sessionName: init.sessionName,
      paneId: init.paneId,
      deliveryMode: init.spec.deliveryMode ?? "paste",
      pid: init.pid,
      pidStartedAt: init.pidStartedAt,
      spawnedAt: init.spawnedAt,
      adopted: init.adopted,
      phase: "idle",
      stopCause: null,
      killTimer: null,
      exited: false,
      eventsTail: new JsonlTail(this.eventsFilePath(init.beeId), { skipExisting: init.adopted }),
      transcriptLocator: obs.transcript?.locator ?? null,
      transcriptParser: parser,
      transcriptTail: null,
      mirrorLocator: obs.transcriptMirror?.locator ?? null,
      mirrorTail: null,
      lastBindScanAt: 0,
      lastMirrorBindScanAt: 0,
      paneFallback: obs.paneFallback ?? false,
      paneHash: null,
      lastPanePollAt: 0,
      explicitTurnEnd: obs.explicitTurnEnd ?? parser?.explicitTurnEnd ?? false,
      quiesceMs: obs.quiesceMs ?? 400,
      deliveryGraceMs: obs.deliveryGraceMs ?? 5000,
      lastActivityAt: this.now(),
      sawOutputThisTurn: false,
      pendingConfirms: [],
    };
  }

  private harvest(p: TmuxRuntime): void {
    if (p.exited) return;
    if (!pidAlive(p.pid)) {
      this.onExit(p);
      return;
    }
    const now = this.now();
    // (b) transcript baseline FIRST — it is the slower source (binding
    // latency), so draining it before the events file keeps same-cycle
    // ordering right: a hook/notify completion never folds ahead of the
    // transcript's own turn start.
    if (p.transcriptLocator != null && p.transcriptParser != null) {
      if (p.transcriptTail == null && now - p.lastBindScanAt >= BIND_SCAN_INTERVAL_MS) {
        p.lastBindScanAt = now;
        const found = findTranscript(p.transcriptLocator, p.spawnedAt);
        if (found != null) {
          p.transcriptTail = new JsonlTail(found, { skipExisting: p.adopted });
        }
      }
      if (p.transcriptTail != null) {
        for (const line of p.transcriptTail.poll()) {
          p.lastActivityAt = now;
          this.mirrorSessionLog(p.beeId, line);
          for (const ev of p.transcriptParser.parseLine(line)) this.fold(p, ev);
        }
      }
    }
    // Render-only transcript mirror: evidence for `hive transcript`, never a
    // lifecycle input. This is where agy's SQLite projection belongs.
    if (p.mirrorLocator != null) {
      if (p.mirrorTail == null && now - p.lastMirrorBindScanAt >= BIND_SCAN_INTERVAL_MS) {
        p.lastMirrorBindScanAt = now;
        const found = findTranscript(p.mirrorLocator, p.spawnedAt);
        if (found != null) {
          p.mirrorTail = transcriptTailFor(p.mirrorLocator, found, { skipExisting: p.adopted });
        }
      }
      if (p.mirrorTail != null) {
        for (const line of p.mirrorTail.poll()) this.mirrorSessionLog(p.beeId, line);
      }
    }
    // (a) hook/notify events file — lowest latency, explicit semantics.
    for (const line of p.eventsTail.poll()) {
      p.lastActivityAt = now;
      for (const ev of parseEventsFileLine(line)) this.fold(p, ev);
    }
    // (c) pane-content change detection — only for file-less harnesses.
    if (p.paneFallback && p.transcriptTail == null && now - p.lastPanePollAt >= PANE_POLL_INTERVAL_MS) {
      p.lastPanePollAt = now;
      const content = this.server.try(["capture-pane", "-p", "-t", p.paneId]);
      if (content.status === 0) {
        const hash = createHash("sha256").update(content.stdout).digest("hex");
        if (p.paneHash != null && hash !== p.paneHash) {
          p.lastActivityAt = now;
          // Change detection only: activity while idle opens a turn, and a
          // change IS output by definition (one poll window can swallow a
          // whole short turn — input echo and result together), so output
          // recency is recorded either way. No string parsing.
          if (p.phase === "idle") this.fold(p, { kind: "turn_started" });
          this.fold(p, { kind: "output" });
        }
        p.paneHash = hash;
      }
    }
    // Quiescence-derived turn end, for sources without an explicit record.
    if (
      p.phase === "running" &&
      !p.explicitTurnEnd &&
      p.sawOutputThisTurn &&
      now - p.lastActivityAt >= p.quiesceMs
    ) {
      this.fold(p, { kind: "turn_ended" });
    }
    // Delivery validation: unconfirmed past grace → visible retryable note.
    if (p.pendingConfirms.length > 0) {
      const still: PendingConfirm[] = [];
      for (const c of p.pendingConfirms) {
        if (now < c.deadline) {
          still.push(c);
          continue;
        }
        this.notes.push({
          beeId: p.beeId,
          generation: p.generation,
          messageId: c.messageId,
          kind: "unconfirmed",
          detail: `delivery of message ${c.messageId} not confirmed by observer within ${p.deliveryGraceMs}ms — retry available`,
          at: now,
        });
      }
      p.pendingConfirms = still;
    }
  }

  private fold(p: TmuxRuntime, ev: TranscriptEvent): void {
    switch (ev.kind) {
      case "turn_started": {
        // A turn start — from any source — confirms every pending delivery:
        // the runtime demonstrably consumed input.
        p.pendingConfirms = [];
        if (p.phase !== "idle") return;
        p.phase = "running";
        p.sawOutputThisTurn = false;
        this.events.push({ beeId: p.beeId, generation: p.generation, kind: "turn_started" });
        return;
      }
      case "turn_ended": {
        if (p.phase !== "running") {
          // Explicit end evidence while idle WITH a delivery pending
          // confirmation: the turn demonstrably ran — a fast hook/notify
          // completion beat the (slower, still-binding) transcript source.
          // Synthesize the start so the boundary pair stays complete; the
          // transcript's later replay of the same turn folds away as
          // duplicates in this same phase machine.
          if (p.pendingConfirms.length === 0) return;
          this.fold(p, { kind: "turn_started" });
        }
        p.phase = "idle";
        this.events.push({ beeId: p.beeId, generation: p.generation, kind: "turn_ended" });
        return;
      }
      case "output": {
        p.sawOutputThisTurn = true;
        return;
      }
    }
  }

  private mirrorSessionLog(beeId: string, line: string): void {
    const dir = this.cfg.sessionLogDir;
    if (!dir) return;
    try {
      appendFileSync(join(dir, `${beeId}.jsonl`), `${line}\n`);
    } catch {
      // Diagnostics only — observation still folds the line.
    }
  }

  private onExit(p: TmuxRuntime): void {
    if (p.exited) return;
    p.exited = true;
    if (p.killTimer) {
      clearTimeout(p.killTimer);
      p.killTimer = null;
    }
    this.procs.delete(p.beeId);
    const cause = p.stopCause ?? this.deadPaneCause(p);
    this.tryKillSession(p.sessionName);
    this.events.push({ beeId: p.beeId, generation: p.generation, kind: "exited", exitCause: cause });
    const pending = this.pendingStarts.get(p.beeId);
    if (pending) {
      this.pendingStarts.delete(p.beeId);
      this.start(p.beeId, pending.generation);
    }
  }

  /** Exit cause from the dead pane's status (remain-on-exit), else crashed. */
  private deadPaneCause(p: TmuxRuntime): "clean" | "crashed" {
    const res = this.server.try([
      "list-panes",
      "-t",
      exactPaneTarget(p.sessionName),
      "-F",
      "#{pane_dead} #{pane_dead_status}",
    ]);
    if (res.status !== 0) return "crashed"; // session gone entirely
    const line = res.stdout.split("\n")[0]?.trim() ?? "";
    const [dead, status] = line.split(" ");
    if (dead === "1" && status === "0") return "clean";
    return "crashed";
  }

  private signal(p: TmuxRuntime, sig: "SIGTERM" | "SIGKILL"): void {
    if (p.pid <= 0) return;
    // No parenthood in tmux: the pid is only "ours" while its OS start time
    // still matches the recorded spawn stamp. Verify before EVERY signal —
    // a recycled pid is never signaled (exact identity; names never are).
    if (!verifyProcessIdentity(p.pid, p.pidStartedAt, this.adoptTolMs)) return;
    try {
      process.kill(-p.pid, sig);
    } catch {
      try {
        process.kill(p.pid, sig);
      } catch {
        // Already gone; the liveness poll in observe() owns the bookkeeping.
      }
    }
  }

  private tryKillSession(sessionName: string): void {
    this.server.try(["kill-session", "-t", exactSession(sessionName)]);
  }
}

function transcriptTailFor(
  locator: TranscriptLocator,
  path: string,
  opts: { skipExisting: boolean },
): TranscriptTail {
  return locator.format === "agy-sqlite" ? new AgySqliteTail(path, opts) : new JsonlTail(path, opts);
}
