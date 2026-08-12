/**
 * Disposable-process credential sweep. Credential reads touch thousands of
 * historical records, macOS Keychain subprocesses, and per-account locks.
 * None of those awaits is reliably cancellable in-process. A timed-out request
 * therefore terminates the worker's dedicated process group (including
 * Keychain/security descendants), confirms the group is dead, then reaps only
 * account locks owned by the dead worker pid. Lock cleanup never races a helper
 * that may still mutate credential state.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { storeRoot } from "../fsx.js";
import {
  inspectProcessBirth,
  readProcessBirthFingerprint,
  type ProcessBirthFingerprint,
  type ProcessIdentityReader,
} from "../hsr/processIdentity.js";
import { readFileLockIdentity, removeFileLockIfOwner, type FileLockOwnerIdentity } from "../lock.js";
import { runCredentialPairSync, runCredentialSweep, type CredentialSweepProgress, type CredentialSweepTelemetry } from "./credentialSweep.js";
import { envMs } from "./timeouts.js";
import { daemonWorkerArgv } from "./workerLaunch.js";

type CredentialSweepRequest =
  | { id: number; root: string; mode?: "sweep" }
  | { id: number; root: string; mode: "pair"; accountId: string; homePath: string };
type CredentialSweepProgressResponse = { id: number; kind: "progress"; progress: CredentialSweepProgress };
type CredentialSweepFinalResponse = {
  id: number;
  kind: "result";
  ok: boolean;
  telemetry?: CredentialSweepTelemetry;
  error?: string;
};
type CredentialSweepResponse = CredentialSweepProgressResponse | CredentialSweepFinalResponse;

/** Child side: run one sweep at a time for the explicitly requested store. */
export async function runCredentialSweepWorker(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const lines = createInterface({ input, terminal: false });
  for await (const line of lines) {
    let request: CredentialSweepRequest | null = null;
    try {
      const parsed = JSON.parse(line) as Partial<CredentialSweepRequest>;
      if (typeof parsed.id === "number" && typeof parsed.root === "string" && parsed.root.length > 0) {
        if (parsed.mode === "pair") {
          const pair = parsed as Partial<Extract<CredentialSweepRequest, { mode: "pair" }>>;
          if (typeof pair.accountId === "string" && pair.accountId.length > 0 && typeof pair.homePath === "string" && pair.homePath.length > 0) {
            request = pair as Extract<CredentialSweepRequest, { mode: "pair" }>;
          }
        } else if (parsed.mode === undefined || parsed.mode === "sweep") {
          request = parsed as Extract<CredentialSweepRequest, { mode?: "sweep" }>;
        }
      }
    } catch {
      // Ignore malformed protocol input and keep serving later requests.
    }
    if (!request) continue;

    const previousRoot = process.env.HIVE_STORE_ROOT;
    try {
      process.env.HIVE_STORE_ROOT = request.root;
      const onProgress = (progress: CredentialSweepProgress) => {
        output.write(`${JSON.stringify({ id: request!.id, kind: "progress", progress } satisfies CredentialSweepProgressResponse)}\n`);
      };
      const telemetry = request.mode === "pair"
        ? await runCredentialPairSync(request.accountId, request.homePath, { onProgress })
        : await runCredentialSweep({ onProgress });
      output.write(`${JSON.stringify({ id: request.id, kind: "result", ok: true, telemetry } satisfies CredentialSweepFinalResponse)}\n`);
    } catch (error) {
      output.write(`${JSON.stringify({
        id: request.id,
        kind: "result",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CredentialSweepFinalResponse)}\n`);
    } finally {
      if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
      else process.env.HIVE_STORE_ROOT = previousRoot;
    }
  }
}

export type CredentialSweepChild = {
  stdin: Writable;
  stdout: Readable;
  kill: (signal?: NodeJS.Signals) => void;
  on: (event: "exit" | "error", listener: (...args: unknown[]) => void) => void;
  pid?: number;
};

export type IsolatedCredentialSweeperOptions = {
  /** Inner deadline. Keep below runDaemon's outer budget so cleanup wins. */
  timeoutMs?: number;
  killGraceMs?: number;
  spawnChild?: () => CredentialSweepChild;
  root?: () => string;
  cleanupLocks?: (root: string, pid: number) => Promise<number>;
  now?: () => number;
  request?: (id: number, root: string) => CredentialSweepRequest;
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  isProcessGroupAlive?: (pgid: number) => boolean;
  readProcessIdentity?: ProcessIdentityReader;
  sleep?: (ms: number) => Promise<void>;
};

export type IsolatedCredentialSweeper = (() => Promise<CredentialSweepTelemetry>) & { close: () => Promise<void> };

export class CredentialSweepTimeoutError extends Error {
  readonly telemetry: CredentialSweepTelemetry;
  readonly terminationConfirmed: boolean;

  constructor(ms: number, telemetry: CredentialSweepTelemetry, terminationConfirmed = true) {
    super(
      terminationConfirmed
        ? `credential sweep timed out after ${ms}ms (worker process group terminated)`
        : `credential sweep timed out after ${ms}ms (worker process group termination unconfirmed)`,
    );
    this.name = "CredentialSweepTimeoutError";
    this.telemetry = telemetry;
    this.terminationConfirmed = terminationConfirmed;
  }
}

function defaultSpawnChild(): CredentialSweepChild {
  const child: ChildProcess = spawn(process.execPath, daemonWorkerArgv("credential-sweep-worker", import.meta.url), {
    stdio: ["pipe", "pipe", "inherit"],
    // pgid === pid: timeout can terminate every inherited helper/descendant,
    // not merely the Node worker that launched `security`/Keychain work.
    detached: true,
  });
  child.unref();
  return child as unknown as CredentialSweepChild;
}

function emptyTelemetry(): CredentialSweepTelemetry {
  return {
    durationMs: 0,
    attemptedAccounts: 0,
    completedAccounts: 0,
    failedAccounts: 0,
    attemptedPairs: 0,
    uniquePairs: 0,
    scheduledPairs: 0,
    skippedPairs: 0,
    duplicatePairs: 0,
    canonicalCoveredPairs: 0,
    unknownAccountPairs: 0,
    completedPairs: 0,
    failedPairs: 0,
    timedOutPairs: 0,
    vaultUpdates: 0,
    quarantinedItems: 0,
    completedQuarantinedItems: 0,
    retainedQuarantinedItems: 0,
  };
}

/**
 * Reap only ordinary per-account locks owned by a credential worker that has
 * been observed exiting. The vault is machine-local, and the lock JSON carries
 * the holder pid. Renaming before removal keeps deletion recoverable through a
 * narrow, explicit path and avoids broad lock-directory cleanup.
 */
export type CredentialWorkerLockReapOptions = {
  /** Deterministic race barrier for tests/diagnostics; no lock is held here. */
  beforeRevalidate?: (path: string, observed: FileLockOwnerIdentity) => Promise<void>;
};

export async function reapCredentialWorkerLocks(
  root: string,
  deadPid: number,
  options: CredentialWorkerLockReapOptions = {},
): Promise<number> {
  const lockDir = join(root, "locks", "accounts");
  const entries = await readdir(lockDir).catch(() => [] as string[]);
  let reaped = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const path = join(lockDir, entry);
    const observed = await readFileLockIdentity(path);
    if (observed?.owner.pid !== deadPid) continue;
    await options.beforeRevalidate?.(path, observed);
    const moved = await removeFileLockIfOwner(path, observed, {
      suffix: "reaped",
      validate: (current) => current.owner.pid === deadPid,
    });
    if (!moved) continue;
    reaped += 1;
  }
  return reaped;
}

type PendingRequest = {
  id: number;
  target: CredentialSweepChild;
  fingerprint?: ProcessBirthFingerprint;
  startedAt: number;
  telemetry: CredentialSweepTelemetry;
  activeWork: Map<number, number[]>;
  resolve: (value: CredentialSweepTelemetry) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export function createIsolatedCredentialSweeper(options: IsolatedCredentialSweeperOptions = {}): IsolatedCredentialSweeper {
  const timeoutMs = options.timeoutMs ?? envMs("HIVE_DAEMON_CHAIN_SYNC_WORKER_TIMEOUT_MS", 119_000);
  const killGraceMs = options.killGraceMs ?? 250;
  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  const root = options.root ?? storeRoot;
  const cleanupLocks = options.cleanupLocks ?? reapCredentialWorkerLocks;
  const now = options.now ?? Date.now;
  const makeRequest = options.request ?? ((id: number, requestRoot: string): CredentialSweepRequest => ({ id, root: requestRoot, mode: "sweep" }));
  const processGroupsSupported = process.platform !== "win32" || Boolean(options.signalProcessGroup && options.isProcessGroupAlive);
  const signalProcessGroup = options.signalProcessGroup ?? ((pgid: number, signal: NodeJS.Signals): void => {
    process.kill(process.platform === "win32" ? pgid : -pgid, signal);
  });
  const isProcessGroupAlive = options.isProcessGroupAlive ?? ((pgid: number): boolean => {
    if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
    try {
      process.kill(process.platform === "win32" ? pgid : -pgid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
  const readProcessIdentity = options.readProcessIdentity ?? readProcessBirthFingerprint;
  const pause = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let child: CredentialSweepChild | null = null;
  let childFingerprint: Promise<ProcessBirthFingerprint | undefined> | null = null;
  let nextId = 1;
  let pending: PendingRequest | null = null;
  type WorkerTermination = { confirmed: boolean; identityCompromised: boolean };
  let terminating: Promise<WorkerTermination> | null = null;
  let unconfirmedGroup: {
    pgid: number;
    workerPid: number;
    root: string;
    fingerprint?: ProcessBirthFingerprint;
    unconfirmable?: boolean;
  } | null = null;

  const waitForGroupExit = async (pgid: number, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (isProcessGroupAlive(pgid) && Date.now() < deadline) await pause(Math.min(25, Math.max(1, deadline - Date.now())));
    return !isProcessGroupAlive(pgid);
  };

  const captureWorkerFingerprint = async (pid: number | undefined): Promise<ProcessBirthFingerprint | undefined> => {
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    try {
      return (await readProcessIdentity(pid)) ?? undefined;
    } catch {
      return undefined;
    }
  };

  type ExactGroupStopProof = "confirmed" | "still-owned" | "identity-compromised";

  const exactGroupStopProof = async (
    pid: number,
    fingerprint: ProcessBirthFingerprint | undefined,
  ): Promise<ExactGroupStopProof> => {
    const identity = await inspectProcessBirth(pid, fingerprint, readProcessIdentity);
    // A mismatch is a live replacement, not proof that it is safe to reap a
    // lock carrying the same recycled numeric pid. Missing identity likewise
    // fails closed. Only absence plus absence of the whole group confirms stop.
    if (identity === "gone" && !isProcessGroupAlive(pid)) return "confirmed";
    if (identity === "match" && isProcessGroupAlive(pid)) return "still-owned";
    return "identity-compromised";
  };

  /** Birth-fenced TERM -> bounded grace -> birth-fenced KILL -> confirmation. */
  const terminateWorkerGroup = async (
    target: CredentialSweepChild,
    fingerprint: ProcessBirthFingerprint | undefined,
    requestRoot: string,
    reapLocks: boolean,
  ): Promise<WorkerTermination> => {
    const failed = (identityCompromised: boolean): WorkerTermination => ({ confirmed: false, identityCompromised });
    const confirmed: WorkerTermination = { confirmed: true, identityCompromised: false };
    const pid = target.pid;
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
      if (!processGroupsSupported) {
        try {
          target.kill("SIGKILL");
        } catch {
          // No portable descendant-tree confirmation exists on this platform.
        }
      }
      return failed(true);
    }
    if (!processGroupsSupported) {
      // Node has no descendant-tree termination primitive on Windows. Kill the
      // worker itself, but fail closed: do not claim descendants are gone and
      // do not reap its lock underneath a possibly-live helper.
      try {
        target.kill("SIGKILL");
      } catch {
        // already gone
      }
      await pause(killGraceMs);
      return failed(true);
    }
    const beforeTerm = await inspectProcessBirth(pid, fingerprint, readProcessIdentity);
    if (beforeTerm === "gone" && !isProcessGroupAlive(pid)) {
      if (reapLocks) await cleanupLocks(requestRoot, pid).catch(() => undefined);
      return confirmed;
    }
    if (beforeTerm !== "match" || !isProcessGroupAlive(pid)) return failed(true);
    try {
      signalProcessGroup(pid, "SIGTERM");
    } catch {
      // Re-probe below: ESRCH can be success; EPERM stays unconfirmed.
    }
    if (await waitForGroupExit(pid, killGraceMs)) {
      const proof = await exactGroupStopProof(pid, fingerprint);
      if (proof === "confirmed" && reapLocks) await cleanupLocks(requestRoot, pid).catch(() => undefined);
      return proof === "confirmed" ? confirmed : failed(true);
    }
    // PID/PGID reuse during the TERM grace must never escalate against the
    // replacement. Re-read the exact worker birth immediately before KILL.
    if ((await inspectProcessBirth(pid, fingerprint, readProcessIdentity)) !== "match") return failed(true);
    try {
      signalProcessGroup(pid, "SIGKILL");
    } catch {
      // Re-probe below.
    }
    await waitForGroupExit(pid, killGraceMs);
    const proof = await exactGroupStopProof(pid, fingerprint);
    if (proof !== "confirmed") return failed(proof === "identity-compromised");
    if (reapLocks) await cleanupLocks(requestRoot, pid).catch(() => undefined);
    return confirmed;
  };

  const rejectPending = (reason: string): void => {
    const current = pending;
    pending = null;
    if (!current) return;
    clearTimeout(current.timer);
    current.reject(new Error(reason));
  };

  const ingestProgress = (current: PendingRequest, progress: CredentialSweepProgress): void => {
    if (progress.type === "plan") current.telemetry = { ...progress.telemetry };
    else if (progress.type === "work-start") current.activeWork.set(progress.workId, [...progress.pairIds]);
    else if (progress.type === "work-end") current.activeWork.delete(progress.workId);
    else current.telemetry = { ...progress.telemetry };
  };

  type ChildWireState = { buffer: string; scanOffset: number; decoder: StringDecoder };

  const ingestResponseText = (target: CredentialSweepChild, wire: ChildWireState, text: string): void => {
    // stdout can arrive after timeout detached this generation and even after
    // its replacement started. Never let stale bytes touch the replacement's
    // decoder/buffer or settle its request.
    if (child !== target || !text) return;
    wire.buffer += text;
    for (;;) {
      const newline = wire.buffer.indexOf("\n", wire.scanOffset);
      if (newline < 0) break;
      const line = wire.buffer.slice(0, newline);
      wire.buffer = wire.buffer.slice(newline + 1);
      wire.scanOffset = 0;
      let response: CredentialSweepResponse | null = null;
      try {
        response = JSON.parse(line) as CredentialSweepResponse;
      } catch {
        continue;
      }
      const current = pending;
      if (!current || current.target !== target || response.id !== current.id) continue;
      if (response.kind === "progress") {
        ingestProgress(current, response.progress);
        continue;
      }
      pending = null;
      clearTimeout(current.timer);
      if (!response.ok) current.reject(new Error(response.error ?? "credential sweep child failed"));
      else current.resolve(response.telemetry ?? current.telemetry);
    }
    wire.scanOffset = wire.buffer.length;
  };

  const ensureChild = async (): Promise<{ target: CredentialSweepChild; fingerprint?: ProcessBirthFingerprint }> => {
    if (child) {
      const target = child;
      const fingerprint = await childFingerprint;
      if (child !== target) throw new Error("credential sweep child exited during identity capture");
      return { target, ...(fingerprint ? { fingerprint } : {}) };
    }
    const spawned = spawnChild();
    const wire: ChildWireState = { buffer: "", scanOffset: 0, decoder: new StringDecoder("utf8") };
    spawned.on("exit", () => {
      if (child !== spawned) return;
      child = null;
      childFingerprint = null;
      rejectPending("credential sweep child exited");
    });
    spawned.on("error", (error: unknown) => {
      if (child !== spawned) return;
      child = null;
      childFingerprint = null;
      rejectPending(`credential sweep child error: ${error instanceof Error ? error.message : String(error)}`);
    });
    spawned.stdin.on("error", () => {
      if (child !== spawned) return;
      child = null;
      childFingerprint = null;
      rejectPending("credential sweep child stdin error");
    });
    spawned.stdout.on("error", () => {
      if (child !== spawned) return;
      child = null;
      childFingerprint = null;
      rejectPending("credential sweep child stdout error");
    });
    spawned.stdout.on("data", (chunk: Buffer | string) => {
      if (child !== spawned) return;
      ingestResponseText(spawned, wire, typeof chunk === "string" ? chunk : wire.decoder.write(chunk));
    });
    child = spawned;
    childFingerprint = captureWorkerFingerprint(spawned.pid);
    const fingerprint = childFingerprint ? await childFingerprint : undefined;
    if (child !== spawned) throw new Error("credential sweep child exited during identity capture");
    return { target: spawned, ...(fingerprint ? { fingerprint } : {}) };
  };

  const sweep = async (): Promise<CredentialSweepTelemetry> => {
    if (terminating) await terminating;
    if (unconfirmedGroup) {
      const proof = unconfirmedGroup.unconfirmable
        ? "identity-compromised"
        : await exactGroupStopProof(unconfirmedGroup.workerPid, unconfirmedGroup.fingerprint);
      if (proof !== "confirmed") {
        throw new Error(`credential sweep disabled: previous worker process group ${unconfirmedGroup.pgid} has not been confirmed stopped`);
      }
      await cleanupLocks(unconfirmedGroup.root, unconfirmedGroup.workerPid).catch(() => undefined);
      unconfirmedGroup = null;
    }
    if (pending) throw new Error("credential sweep already in flight");
    const { target, fingerprint } = await ensureChild();
    if (pending) throw new Error("credential sweep already in flight");
    const id = nextId++;
    return new Promise<CredentialSweepTelemetry>((resolveRequest, rejectRequest) => {
      const startedAt = now();
      const timer = setTimeout(() => {
        const current = pending;
        if (!current || current.id !== id) return;
        // Detach before kill so the ordinary exit listener cannot replace the
        // structured timeout with a generic child-exited error.
        clearTimeout(current.timer);
        pending = null;
        if (child === target) {
          child = null;
          childFingerprint = null;
        }
        const activePairIds = new Set([...current.activeWork.values()].flat());
        const telemetry: CredentialSweepTelemetry = {
          ...current.telemetry,
          durationMs: Math.max(0, now() - current.startedAt),
          timedOutPairs: activePairIds.size,
        };
        const requestRoot = root();
        const termination = terminateWorkerGroup(target, current.fingerprint, requestRoot, true);
        terminating = termination;
        void termination.then((result) => {
          if (!result.confirmed && target.pid !== undefined) {
            unconfirmedGroup = {
              pgid: target.pid,
              workerPid: target.pid,
              root: requestRoot,
              ...(current.fingerprint ? { fingerprint: current.fingerprint } : {}),
              ...(!processGroupsSupported || result.identityCompromised ? { unconfirmable: true } : {}),
            };
          }
          current.reject(new CredentialSweepTimeoutError(timeoutMs, telemetry, result.confirmed));
        }).finally(() => {
          if (terminating === termination) terminating = null;
        });
      }, timeoutMs);
      pending = {
        id,
        target,
        ...(fingerprint ? { fingerprint } : {}),
        startedAt,
        telemetry: emptyTelemetry(),
        activeWork: new Map(),
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      };
      try {
        target.stdin.write(`${JSON.stringify(makeRequest(id, root()))}\n`);
      } catch (error) {
        const current = pending;
        pending = null;
        clearTimeout(timer);
        current?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const close = async (): Promise<void> => {
    if (terminating) await terminating;
    const current = child;
    const fingerprint = childFingerprint ? await childFingerprint : undefined;
    const hadPending = pending !== null;
    child = null;
    childFingerprint = null;
    rejectPending("credential sweep child closed");
    if (!current) return;
    await terminateWorkerGroup(current, fingerprint, root(), hadPending);
  };

  return Object.assign(sweep, { close });
}

/**
 * Run one post-exit account/home harvest in a disposable worker. Its inner
 * deadline is deliberately shorter than transactional retire/kill's outer
 * budget, leaving time to observe SIGKILL and reap the dead worker's lock.
 */
export async function syncCredentialPairIsolated(
  accountId: string,
  homePath: string,
  options: Omit<IsolatedCredentialSweeperOptions, "request"> = {},
): Promise<CredentialSweepTelemetry> {
  const timeoutMs = options.timeoutMs ?? envMs("HIVE_FINAL_CREDENTIAL_SYNC_WORKER_TIMEOUT_MS", 9_000);
  const sweep = createIsolatedCredentialSweeper({
    ...options,
    timeoutMs,
    request: (id, root) => ({ id, root, mode: "pair", accountId, homePath }),
  });
  try {
    return await sweep();
  } finally {
    await sweep.close().catch(() => undefined);
  }
}
