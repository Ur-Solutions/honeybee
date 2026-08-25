/**
 * SubstrateRouter — one RuntimeDriver over the node's substrate drivers.
 *
 * DaemonCore drives exactly one driver; the node runs bees on more than one
 * substrate (contract §1: tmux | hsr | cell). The router is the seam: every
 * per-bee call is forwarded to the driver that owns that bee, decided by
 * the bee's recorded substrate (the store row is the truth; a process the
 * driver already holds wins over a row that has since been deleted, so a
 * `delete` still stops the right process). Drain-style calls (observe,
 * evidence, sessions, snapshotLive) concatenate both drivers' outputs.
 *
 * The cell driver composes its own inner HsrDriver (spec 05: pure
 * delegation), so process parenthood, exact-identity stops and re-adoption
 * are implemented once and reached through either path.
 */
import type {
  DeliverOutcome,
  DriverObservation,
  InterruptOutcome,
  LiveProcess,
  RuntimeDriver,
  StopCause,
} from "../../harness/src/driver.ts";
import type {
  HsrDriver,
  FlagEvidence,
  ObservationCursorEvidence,
  SessionEvidence,
} from "../../driver-hsr/src/index.ts";
import type { CellDriver } from "../../driver-cell/src/index.ts";
import type { TmuxDriver } from "../../driver-tmux/src/index.ts";

export type Substrate = "hsr" | "cell" | "tmux";

type SubstrateDriver = HsrDriver | CellDriver | TmuxDriver;

export interface SubstrateRouterConfig {
  hsr: HsrDriver;
  cell: CellDriver;
  tmux: TmuxDriver;
  /** The bee's recorded substrate; null when the bee row is gone. */
  substrateOf(beeId: string): string | null;
}

export class SubstrateRouter implements RuntimeDriver {
  readonly hsr: HsrDriver;
  readonly cell: CellDriver;
  readonly tmux: TmuxDriver;
  private readonly substrateOf: (beeId: string) => string | null;

  constructor(cfg: SubstrateRouterConfig) {
    this.hsr = cfg.hsr;
    this.cell = cfg.cell;
    this.tmux = cfg.tmux;
    this.substrateOf = cfg.substrateOf;
  }

  /** The driver that owns (bee, generation): whoever holds its process, else the recorded substrate. */
  driverFor(beeId: string, generation?: number): SubstrateDriver {
    if (generation != null) {
      if (this.tmux.hasProcess(beeId, generation)) return this.tmux;
      if (this.cell.hasProcess(beeId, generation)) return this.cell;
      if (this.hsr.hasProcess(beeId, generation)) return this.hsr;
    }
    const substrate = this.substrateOf(beeId);
    if (substrate === "tmux") return this.tmux;
    if (substrate === "cell") return this.cell;
    return this.hsr;
  }

  // -------------------------------------------------------------------------
  // RuntimeDriver
  // -------------------------------------------------------------------------

  start(beeId: string, generation: number): void {
    this.driverFor(beeId).start(beeId, generation);
  }

  deliver(beeId: string, generation: number, messageId: number, body: string): DeliverOutcome {
    return this.driverFor(beeId, generation).deliver(beeId, generation, messageId, body);
  }

  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    return this.driverFor(beeId, generation).stop(beeId, generation, cause);
  }

  interrupt(beeId: string, generation: number): InterruptOutcome {
    return this.driverFor(beeId, generation).interrupt(beeId, generation);
  }

  observe(): DriverObservation[] {
    return [...this.hsr.observe(), ...this.cell.observe(), ...this.tmux.observe()];
  }

  hasProcess(beeId: string, generation: number): boolean {
    return this.hsr.hasProcess(beeId, generation) || this.cell.hasProcess(beeId, generation) || this.tmux.hasProcess(beeId, generation);
  }

  snapshotLive(): LiveProcess[] {
    return [...this.hsr.snapshotLive(), ...this.cell.snapshotLive(), ...this.tmux.snapshotLive()];
  }

  // -------------------------------------------------------------------------
  // Extended surface (duck-typed by DaemonCore / used by the daemon)
  // -------------------------------------------------------------------------

  adopt(
    beeId: string,
    generation: number,
    pid: number,
    pidStartedAt: number,
    lastKnownState?: "booting" | "running" | "idle",
    lastAppliedObservationCursor?: number | null,
  ): boolean {
    return this.driverFor(beeId).adopt(
      beeId,
      generation,
      pid,
      pidStartedAt,
      lastKnownState,
      lastAppliedObservationCursor,
    );
  }

  isDegraded(beeId: string, generation: number): boolean {
    return this.driverFor(beeId, generation).isDegraded(beeId, generation);
  }

  procOf(
    beeId: string,
    generation: number,
  ): { pid: number; pidStartedAt: number; observationCursor?: number } | null {
    return this.driverFor(beeId, generation).procOf(beeId, generation);
  }

  observeEvidence(): FlagEvidence[] {
    return [...this.hsr.observeEvidence(), ...this.cell.observeEvidence(), ...this.tmux.observeEvidence()];
  }

  observeSessions(): SessionEvidence[] {
    return [...this.hsr.observeSessions(), ...this.cell.observeSessions(), ...this.tmux.observeSessions()];
  }

  observeRecoveryCursors(): ObservationCursorEvidence[] {
    return [...this.hsr.observeRecoveryCursors(), ...this.cell.observeRecoveryCursors()];
  }

  /** Session logs share one directory across substrates (one `<beeId>.jsonl` per bee). */
  sessionLogPath(beeId: string): string {
    return this.hsr.sessionLogPath(beeId);
  }

  liveProcesses(): LiveProcess[] {
    return this.snapshotLive();
  }

  detachAll(): void {
    this.hsr.detachAll();
    this.cell.detachAll();
    this.tmux.detachAll();
  }

  disposeAll(): void {
    this.hsr.disposeAll();
    this.cell.disposeAll();
    this.tmux.disposeAll();
  }
}
