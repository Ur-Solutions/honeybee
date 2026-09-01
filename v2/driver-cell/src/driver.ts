/**
 * CellDriver — runtime encapsulation by PURE DELEGATION (WP5, spec 05).
 *
 * The cell driver is not a fork of the HSR driver; it composes one. Every
 * RuntimeDriver method delegates verbatim to the inner HsrDriver — process
 * parenthood, structured-event truth, exact-identity stops, re-adoption:
 * all of it is implemented exactly once (contract §2: "runtime state
 * extraction is implemented once, never per container").
 *
 * What the cell layer adds, and nothing more:
 *  - provisioning: on the first start of a (bee, generation) the cell is
 *    provisioned via the two-step primitive (provision.ts), keyed by an
 *    operation id derived from the start — replay-safe across crashes;
 *  - cwd: the runtime runs inside the cell's space checkout;
 *  - sandbox: when enabled (A4 node-kind default / per-cell override), the
 *    inner spawn command is wrapped in the platform confinement layer;
 *  - exit path: captureWork() (capture.ts) and deleteCell() (remove.ts) are
 *    exposed for the daemon/UI (WP6) — they never touch runtime driving.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type {
  DeliverOutcome,
  DriverObservation,
  InterruptOutcome,
  LiveProcess,
  RuntimeDriver,
  StopCause,
} from "../../harness/src/driver.ts";
import {
  HsrDriver,
  type FlagEvidence,
  type HsrDriverConfig,
  type ObservationCursorEvidence,
  type SessionEvidence,
  type SpawnSpec,
} from "../../driver-hsr/src/index.ts";
import { captureWork, type CaptureMode, type CaptureReport } from "./capture.ts";
import { cellPaths, looksLikeCellWrapper, type CellPaths } from "./layout.ts";
import { isProvisioned, readLedger, type CellLedger } from "./ledger.ts";
import { provisionCell, type ProvisionedCell, type ProvisionRequest } from "./provision.ts";
import { deleteCell, type DeleteResult } from "./remove.ts";
import {
  defaultWritablePaths,
  sandboxEnabled,
  wrapWithSandbox,
  type NodeKind,
} from "./sandbox.ts";

/** What the cell driver needs to know per bee, beyond the harness spawn. */
export interface CellSpec {
  /** The provisioning request (origin, sha, layout, warm artifacts). */
  provision: ProvisionRequest;
  /** Per-cell sandbox override; null/undefined = node-kind default (A4). */
  sandbox?: boolean | null;
}

export interface CellDriverConfig {
  cellsRoot: string;
  /** Node kind, from the daemon config — decides the sandbox default (A4). */
  nodeKind: NodeKind;
  /** Resolve the harness half of a spawn (adapter/command/args/env). cwd is cell-owned. */
  resolveHarness(beeId: string): SpawnSpec;
  /** Resolve the cell half (origin repo, sha, warm config, sandbox override). */
  resolveCell(beeId: string): CellSpec;
  /** Inner HSR driver settings (session logs, stop grace, …). */
  hsr: Omit<HsrDriverConfig, "resolve">;
  /** Extra sandbox-writable paths (defaults: harness homes + caches). */
  sandboxWritablePaths?: string[];
  /** Tests: force the clone fallback / cold cells. */
  disableCow?: boolean;
  /** Daemon mode: provision Cells off the RPC/event-loop hot lane. */
  backgroundProvisioning?: boolean;
  /** Tests: substitute the provisioning worker entrypoint. */
  provisionWorkerUrl?: URL;
  /** Override the Honeybee-owned Git-image root (tests). */
  gitImagesRoot?: string;
}

interface PendingProvision {
  beeId: string;
  generation: number;
  worker: Worker;
  settled: boolean;
}

interface ProvisionWorkerResult {
  ok: boolean;
  error?: string;
}

/** `removeCell` refusal: the bee still has a live runtime — stop it first. */
export class CellRuntimeLiveError extends Error {
  constructor(beeId: string) {
    super(`removeCell: bee ${beeId} still has a live runtime; stop it before removing its cell`);
    this.name = "CellRuntimeLiveError";
  }
}

export class CellDriver implements RuntimeDriver {
  private readonly cfg: CellDriverConfig;
  private readonly inner: HsrDriver;
  /** Provisioned cells by beeId — the driver-side allocation cache. */
  private readonly cells = new Map<string, ProvisionedCell>();
  private readonly pending = new Map<string, PendingProvision>();
  /** Workers may keep refreshing a cache image after reporting Cell-ready. */
  private readonly maintenanceWorkers = new Set<Worker>();
  /** Image maintenance waits until the first turn boundary (or worker fallback). */
  private readonly maintenanceByRuntime = new Map<string, Worker>();
  private readonly pendingObservations: DriverObservation[] = [];

  constructor(cfg: CellDriverConfig) {
    this.cfg = cfg;
    this.inner = new HsrDriver({
      ...cfg.hsr,
      resolve: (beeId: string) => this.resolveCellSpawn(beeId),
    });
  }

  // -------------------------------------------------------------------------
  // RuntimeDriver — pure delegation
  // -------------------------------------------------------------------------

  start(beeId: string, generation: number): void {
    // Provisioning is idempotent and ledger-keyed: a replayed spawn command
    // (crash mid-provision, executor replay) resumes instead of redoing.
    const opId = `start-${beeId}-g${generation}`;
    if (this.cfg.backgroundProvisioning !== true) {
      this.ensureCell(beeId, opId);
      this.inner.start(beeId, generation);
      return;
    }
    if (this.pending.has(beeId)) {
      throw new Error(`cell driver: bee ${beeId} already has provisioning in flight`);
    }
    const spec = this.cfg.resolveCell(beeId);
    const workerUrl = this.cfg.provisionWorkerUrl ?? (import.meta.url.endsWith(".ts")
      ? new URL("./provisionWorker.ts", import.meta.url)
      : new URL("./provision-worker.js", import.meta.url));
    const worker = new Worker(workerUrl, {
      execArgv: [],
      workerData: {
        cellsRoot: this.cfg.cellsRoot,
        request: spec.provision,
        opId,
        disableCow: this.cfg.disableCow ?? false,
        useGitImages: this.cfg.nodeKind === "workstation",
        gitImagesRoot: this.cfg.gitImagesRoot,
      },
    });
    const pending: PendingProvision = { beeId, generation, worker, settled: false };
    this.pending.set(beeId, pending);
    worker.once("message", (message: ProvisionWorkerResult) => {
      if (message.ok) {
        // provisionWorker reports Cell-ready before doing image maintenance.
        // Keep it cancellable on driver disposal but do not keep the daemon
        // process alive solely for an acceleration cache refresh.
        this.maintenanceWorkers.add(worker);
        this.maintenanceByRuntime.set(`${pending.beeId}:g${pending.generation}`, worker);
        worker.unref();
        this.finishProvision(pending);
      }
      else this.failProvision(pending, message.error ?? "cell provisioning failed");
    });
    worker.once("error", (error) => this.failProvision(
      pending,
      error instanceof Error ? error.message : String(error),
    ));
    worker.once("exit", (code) => {
      this.maintenanceWorkers.delete(worker);
      for (const [key, candidate] of this.maintenanceByRuntime) {
        if (candidate === worker) this.maintenanceByRuntime.delete(key);
      }
      if (!pending.settled) {
        this.failProvision(
          pending,
          `cell provisioning worker exited with code ${code} without a result`,
        );
      }
    });
  }

  deliver(beeId: string, generation: number, messageId: number, body: string): DeliverOutcome {
    return this.inner.deliver(beeId, generation, messageId, body);
  }

  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    const pending = this.pending.get(beeId);
    if (pending?.generation === generation) {
      pending.settled = true;
      this.pending.delete(beeId);
      void pending.worker.terminate();
      this.pendingObservations.push({ beeId, generation, kind: "exited", exitCause: cause });
      return { hadProcess: true };
    }
    return this.inner.stop(beeId, generation, cause);
  }

  interrupt(beeId: string, generation: number): InterruptOutcome {
    return this.inner.interrupt(beeId, generation);
  }

  observe(): DriverObservation[] {
    const pending = this.pendingObservations.splice(0);
    const inner = this.inner.observe();
    for (const event of inner) {
      // Let the first prompt reach a real accept/idle boundary before the
      // cache worker begins CPU/disk-heavy packing. An early runtime exit is
      // also a safe point. The worker has its own bounded fallback if neither
      // observation arrives.
      if (event.kind !== "turn_ended" && event.kind !== "exited") continue;
      const key = `${event.beeId}:g${event.generation}`;
      const worker = this.maintenanceByRuntime.get(key);
      if (worker == null) continue;
      this.maintenanceByRuntime.delete(key);
      worker.postMessage({ kind: "refresh_git_image" });
    }
    return [...pending, ...inner];
  }

  hasProcess(beeId: string, generation: number): boolean {
    return this.pending.get(beeId)?.generation === generation || this.inner.hasProcess(beeId, generation);
  }

  snapshotLive(): LiveProcess[] {
    return this.inner.snapshotLive();
  }

  // -------------------------------------------------------------------------
  // Extended driver surface (duck-typed by DaemonCore) — delegation
  // -------------------------------------------------------------------------

  adopt(
    beeId: string,
    generation: number,
    pid: number,
    pidStartedAt: number,
    lastKnownState?: "booting" | "running" | "idle",
    lastAppliedObservationCursor?: number | null,
    providerSessionId?: string | null,
  ): boolean {
    return this.inner.adopt(
      beeId,
      generation,
      pid,
      pidStartedAt,
      lastKnownState,
      lastAppliedObservationCursor,
      providerSessionId,
    );
  }

  isDegraded(beeId: string, generation: number): boolean {
    return this.inner.isDegraded(beeId, generation);
  }

  procOf(
    beeId: string,
    generation: number,
  ): { pid: number; pidStartedAt: number; observationCursor: number } | null {
    return this.inner.procOf(beeId, generation);
  }

  observeEvidence(): FlagEvidence[] {
    return this.inner.observeEvidence();
  }

  observeSessions(): SessionEvidence[] {
    return this.inner.observeSessions();
  }

  observeRecoveryCursors(): ObservationCursorEvidence[] {
    return this.inner.observeRecoveryCursors();
  }

  sessionLogPath(beeId: string): string {
    return this.inner.sessionLogPath(beeId);
  }

  consumedGeneration(messageId: number): number | undefined {
    return this.inner.consumedGeneration(messageId);
  }

  consumedCount(): number {
    return this.inner.consumedCount();
  }

  liveProcesses(): LiveProcess[] {
    return this.inner.liveProcesses();
  }

  detachAll(): void {
    this.cancelPending();
    this.inner.detachAll();
  }

  disposeAll(): void {
    this.cancelPending();
    this.inner.disposeAll();
  }

  // -------------------------------------------------------------------------
  // Cell surface (the daemon/UI-facing half; WP6 wires the UI)
  // -------------------------------------------------------------------------

  /** Provision (or replay) the bee's cell, keyed by an explicit operation id. */
  ensureCell(beeId: string, opId: string): ProvisionedCell {
    const cached = this.cells.get(beeId);
    if (cached) return cached;
    const spec = this.cfg.resolveCell(beeId);
    const cell = provisionCell(this.cfg.cellsRoot, spec.provision, opId, {
      disableCow: this.cfg.disableCow ?? false,
      useGitImages: this.cfg.nodeKind === "workstation",
      gitImagesRoot: this.cfg.gitImagesRoot,
    });
    this.cells.set(beeId, cell);
    return cell;
  }

  /**
   * The provisioned cell for a bee, if any. After a daemon restart the
   * in-memory cache is empty; the cell is re-hydrated from its on-disk
   * ledger (cell.json is the durable allocation truth).
   */
  cellOf(beeId: string): ProvisionedCell | null {
    const cached = this.cells.get(beeId);
    if (cached) return cached;
    let spec: CellSpec;
    try {
      spec = this.cfg.resolveCell(beeId);
    } catch {
      return null;
    }
    const p = spec.provision;
    const paths = cellPaths(this.cfg.cellsRoot, p.wrapper, p.repoName, p.cellId);
    const ledger = (() => {
      try {
        return readLedger(paths.ledgerPath);
      } catch {
        return null;
      }
    })();
    if (ledger == null || !isProvisioned(ledger) || ledger.beeId !== beeId) return null;
    const done = Object.values(ledger.operations).find((op) => op.completedAt != null);
    const cell: ProvisionedCell = {
      paths,
      copyMode: ledger.copy_mode ?? "clone",
      warm: done?.steps.warm ?? { mode: "cold", dirs: [], reason: "none_listed" },
      sha: ledger.sha,
      originRepo: ledger.origin,
      replayed: true,
    };
    this.cells.set(beeId, cell);
    return cell;
  }

  /** The native exit path (spec 05 point 4). */
  capture(beeId: string, opts: { targetBranch: string; mode: CaptureMode; opId: string }): CaptureReport {
    const cell = this.cellOf(beeId);
    if (!cell) throw new Error(`capture: bee ${beeId} has no provisioned cell`);
    return captureWork({
      originRepo: cell.originRepo,
      cellSpaceDir: cell.paths.spaceDir,
      targetBranch: opts.targetBranch,
      mode: opts.mode,
      opId: opts.opId,
    });
  }

  /**
   * Delete the bee's cell (A2 dirty guard applies). Archive is deliberately
   * NOT here: archiving keeps the cell (spec 05 point 7); retention reaping
   * is daemon policy. A cell that was only reserved (seed ledger, never
   * provisioned) has nothing to lose and is removed outright; a
   * half-provisioned one goes through the shape-checked dirty guard like
   * any other. Throws CellRuntimeLiveError while a runtime is live.
   */
  removeCell(beeId: string, opts: { force?: boolean } = {}): DeleteResult {
    if (this.pending.has(beeId) || this.snapshotLive().some((p) => p.beeId === beeId)) {
      throw new CellRuntimeLiveError(beeId);
    }
    const cell = this.cellOf(beeId);
    if (cell) {
      const result = deleteCell(cell.paths.wrapperDir, opts);
      this.cells.delete(beeId);
      return result;
    }
    const reserved = this.reservedOf(beeId);
    if (reserved == null || !existsSync(reserved.paths.wrapperDir)) {
      return { deleted: false, forced: false, report: null };
    }
    const entries = readdirSync(reserved.paths.wrapperDir);
    if (looksLikeCellWrapper(reserved.paths.wrapperDir, entries)) {
      // A space checkout exists (provisioning was interrupted): the A2
      // guard decides, on shape-checked paths only.
      return deleteCell(reserved.paths.wrapperDir, opts);
    }
    // Seed ledger + box only — no checkout was ever materialized.
    rmSync(reserved.paths.wrapperDir, { recursive: true, force: true });
    return { deleted: true, forced: false, report: null };
  }

  /** The reserved (seed) ledger + paths for a bee, provisioned or not; null when unresolvable. */
  private reservedOf(beeId: string): { paths: CellPaths; ledger: CellLedger } | null {
    let spec: CellSpec;
    try {
      spec = this.cfg.resolveCell(beeId);
    } catch {
      return null;
    }
    const p = spec.provision;
    const paths = cellPaths(this.cfg.cellsRoot, p.wrapper, p.repoName, p.cellId);
    let ledger: CellLedger | null;
    try {
      ledger = readLedger(paths.ledgerPath);
    } catch {
      return null;
    }
    if (ledger == null || ledger.beeId !== beeId) return null;
    return { paths, ledger };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private finishProvision(pending: PendingProvision): void {
    if (pending.settled || this.pending.get(pending.beeId) !== pending) return;
    pending.settled = true;
    this.pending.delete(pending.beeId);
    try {
      // The worker completed the ledger-keyed operation. This replay only
      // hydrates the parent driver's cache before the HSR process starts.
      this.ensureCell(pending.beeId, `start-${pending.beeId}-g${pending.generation}`);
      this.inner.start(pending.beeId, pending.generation);
    } catch (error) {
      this.pendingObservations.push({
        beeId: pending.beeId,
        generation: pending.generation,
        kind: "exited",
        exitCause: "crashed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private failProvision(pending: PendingProvision, detail: string): void {
    if (pending.settled || this.pending.get(pending.beeId) !== pending) return;
    pending.settled = true;
    this.pending.delete(pending.beeId);
    this.pendingObservations.push({
      beeId: pending.beeId,
      generation: pending.generation,
      kind: "exited",
      exitCause: "crashed",
      detail: `cell provisioning failed: ${detail}`,
    });
  }

  private cancelPending(): void {
    for (const pending of this.pending.values()) {
      pending.settled = true;
      void pending.worker.terminate();
    }
    this.pending.clear();
    for (const worker of this.maintenanceWorkers) void worker.terminate();
    this.maintenanceWorkers.clear();
    this.maintenanceByRuntime.clear();
  }

  private resolveCellSpawn(beeId: string): SpawnSpec {
    const cell = this.cells.get(beeId);
    if (!cell) throw new Error(`cell driver: bee ${beeId} has no provisioned cell (start() provisions first)`);
    const harness = this.cfg.resolveHarness(beeId);
    const spec = this.cfg.resolveCell(beeId);
    const env: Record<string, string> = {
      ...(harness.env ?? (process.env as Record<string, string>)),
      // The old runner discipline: in-cell tools detect containment and the
      // space identity through these stamps.
      HIVE_CELL: "1",
      HIVE_CELL_SPACE: cell.paths.spaceName,
    };
    if (!sandboxEnabled(this.cfg.nodeKind, spec.sandbox)) {
      return { ...harness, cwd: cell.paths.spaceDir, env };
    }
    const wrapped = wrapWithSandbox(
      {
        cellDir: cell.paths.wrapperDir,
        writablePaths: this.cfg.sandboxWritablePaths ?? defaultWritablePaths(),
      },
      harness.command,
      harness.args,
      cell.paths.sandboxProfilePath,
    );
    if (wrapped.profile != null) writeFileSync(cell.paths.sandboxProfilePath, wrapped.profile);
    return {
      adapter: harness.adapter,
      command: wrapped.command,
      args: wrapped.args,
      cwd: cell.paths.spaceDir,
      env,
    };
  }
}
