/**
 * RuntimeDriver — the substrate driver interface.
 *
 * >>> THIS FILE IS THE DRAFT OF WP3'S REAL DRIVER INTERFACE. <<<
 *
 * Per spec 02 non-goals: "WP3 plugs its real driver into this harness later —
 * the SimDriver interface IS the draft of WP3's driver interface." Everything
 * the SimDaemon needs from a substrate is expressed here and nowhere else; the
 * daemon logic in daemon.ts is written against this interface only, so a real
 * tmux/hsr/cell driver can replace SimDriver without touching the daemon.
 *
 * Model (contract §4.1): the driver owns *processes*; the store owns *state*.
 * The driver never writes the store. It reports facts as observations, which
 * the daemon folds into the store's four-state model. Observations are the
 * normalization layer the contract calls "the most important machinery in the
 * system": heterogeneous harness events become exactly
 * booted / turn_started / turn_ended / exited.
 *
 * Crash semantics (contract §3.2): the daemon is the runtime's parent —
 * process death is a fact reported to it, never a hypothesis. In the sim this
 * means `observe()` retains undrained events across a daemon restart (the real
 * driver re-derives them from session files / child-exit records at boot);
 * a machine reboot kills every process and discards pending events, and boot
 * reconciliation takes over from `snapshotLive()`.
 */

/** Deliberate stops carry who asked; crashes and clean exits are observed, not requested. */
export type StopCause = "stopped_by_user" | "stopped_by_system";

export type ObservedExitCause = "clean" | "crashed" | StopCause;

export interface DriverObservation {
  beeId: string;
  generation: number;
  /**
   * booted       — boot finished; the runtime is live and working its initial turn
   *                (carries pid + pidStartedAt for boot re-adoption, B7).
   * turn_started — an idle runtime accepted input and began a turn.
   * turn_ended   — the turn finished; the runtime is idle (produced output).
   * exited       — the process is gone, with its exit cause.
   */
  kind: "booted" | "turn_started" | "turn_ended" | "exited";
  pid?: number;
  pidStartedAt?: number;
  exitCause?: ObservedExitCause;
  /**
   * True when the DRIVER minted this observation itself instead of deriving it
   * from the process's own output (the readyAtSpawn synthetic `booted`; the
   * `turn_started` the driver opens when it injects input into an idle
   * runtime). Synthetic observations drive the state model — delivery needs
   * the runtime out of `booting` — but they are NOT boot evidence: the
   * spawn-failure budget resets only on an observation the adapter parsed
   * from real process output (absent/false = real). A generation that dies
   * having produced nothing but synthetic observations counts against the
   * bee's spawn-failure budget exactly like an exit during `booting`.
   */
  synthetic?: boolean;
}

export interface DeliverOutcome {
  accepted: boolean;
  /** Why the runtime did not accept; the mailbox stays durable truth and the daemon retries. */
  reason?: "no_process" | "not_ready";
  /**
   * Optional machine-readable refinement of `reason` (e.g. the tmux driver's
   * "multiline_type_mode": a typed-delivery harness cannot take a multiline
   * body — the daemon may route it for paste delivery later).
   */
  detail?: string;
}

/**
 * Outcome of an interrupt request (v6 `bee.interrupt`): stop the CURRENT
 * TURN without ending the runtime. `interrupted: true` = an in-band interrupt
 * was handed to a live, mid-turn runtime; the `turn_ended` that follows is an
 * ordinary observation. Anything else is a no-op with a reason — never an
 * error: `idle` (nothing to interrupt), `no_process`, `not_ready` (booting /
 * dying / degraded: no channel), `unsupported` (the harness has no in-band
 * interrupt).
 */
export interface InterruptOutcome {
  interrupted: boolean;
  reason?: "idle" | "no_process" | "not_ready" | "unsupported";
}

/** A live runtime process, identified for boot re-adoption by pid + start time. */
export interface LiveProcess {
  beeId: string;
  generation: number;
  pid: number;
  pidStartedAt: number;
}

export interface RuntimeDriver {
  /**
   * Start a runtime process for (bee, generation). Returns immediately; boot
   * progress arrives as a `booted` observation. Throws if the bee already has
   * a live process — one live runtime per bee is a driver-level invariant.
   */
  start(beeId: string, generation: number): void;

  /**
   * Inject one delivered message into the runtime's input (the "fuzzy last
   * hop", B4a). Accepts only at a harness accept point (booted, idle or
   * mid-turn); never blocks. A refusal is not a failure — the mailbox record
   * is the durable truth and the daemon retries against it.
   */
  deliver(beeId: string, generation: number, messageId: number, body: string): DeliverOutcome;

  /**
   * Stop the runtime process. Parenthood makes this certain: if a process
   * existed it is now dying and an `exited` observation will follow. If none
   * existed, `hadProcess` is false and the caller may record the stop itself.
   */
  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean };

  /**
   * v6 — interrupt the CURRENT TURN of (bee, generation) without ending the
   * runtime (claude stream-json control_request interrupt, codex
   * turn/interrupt, tmux C-c). Never blocks, never throws for a missing or
   * idle runtime: the outcome says what happened. A successful interrupt is
   * confirmed by the ordinary `turn_ended` observation that follows.
   */
  interrupt(beeId: string, generation: number): InterruptOutcome;

  /** Drain observations accumulated since the last drain, in event order. */
  observe(): DriverObservation[];

  /** Whether a live process exists for exactly (bee, generation). */
  hasProcess(beeId: string, generation: number): boolean;

  /** Boot-time enumeration of live processes, for reconcileAtBoot (B7). */
  snapshotLive(): LiveProcess[];
}
