/**
 * HSR shared session plumbing (HIVE-20).
 *
 * The harness-agnostic scaffolding every RunnerSession needs, extracted from
 * streamRunner.ts and the codex adapter (which had duplicated it wholesale):
 *
 *   - spawnSessionChild: detached spawn + the async spawn-error handshake
 *     (a bad command surfaces via the 'error' event, not the sync return).
 *   - attachSessionPlumbing: the structured event queue backing the session's
 *     AsyncIterable, the rendered-text ring buffer with debounced ring.txt
 *     writes, event ingest (ts-stamp → queue → events.jsonl append → ring),
 *     the child-exit handler (exit event, stream end, parent-side pipe
 *     teardown), and process-group stop (SIGTERM → grace → SIGKILL).
 *
 * A new runner wires its protocol (parse/encode/transport hooks) and delegates
 * everything else here — see streamRunner.ts (tier "stream") and
 * adapters/codex.ts (tier "server") for the two shapes.
 *
 * Persistence split (single source of truth): the RUNNER appends to
 * events.jsonl + writes ring.txt. The host (host.ts) only broadcasts events to
 * live socket observers — it never re-appends. This keeps the durable log
 * authored in exactly one place, close to where events are produced.
 *
 * Node builtins only. Process-group teardown mirrors src/flow/background.ts.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { RunnerEvent } from "./types.js";
import { appendHsrEvent, appendRingText, writeHsrRing } from "./runDir.js";

// Debounce ring.txt writes so a chatty turn does not thrash the disk.
const RING_DEBOUNCE_MS = 50;
// Process-group teardown grace (SIGTERM → SIGKILL), mirrors flow/background.ts.
const STOP_GRACE_MS = 2_000;
const STOP_POLL_MS = 25;
// Tool-use usually arrives just before the subprocess is created, so take one
// bounded delayed sample rather than an immediate miss plus a second scan.
const TOOL_OWNERSHIP_SAMPLE_MS = 250;
// A census normally completes in tens of milliseconds, but this cleanup is
// most important when the machine is already under severe scheduler pressure.
const PROCESS_CENSUS_TIMEOUT_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ProcessRow = {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: string;
};

type ProcessIdentity = { pgid: number; startedAt: string };

type ProcessInventory = {
  byPid: Map<number, ProcessRow>;
  byPpid: Map<number, ProcessRow[]>;
  byPgid: Map<number, ProcessRow[]>;
};

type OwnedProcessScope = {
  rootPid: number;
  /** Prevent an unseeded scope from accepting a recycled root pid after exit. */
  rootIsAlive(): boolean;
  /** Processes observed while they were descendants of this scope. */
  identities: Map<number, ProcessIdentity>;
  /** Groups which still contain at least one identity verified this sample. */
  livePgids: Set<number>;
  delayedSample?: NodeJS.Timeout;
  termination?: Promise<void>;
};

const ownershipScopes = new Set<OwnedProcessScope>();
const ownershipByChild = new WeakMap<ChildProcess, OwnedProcessScope>();
let ownershipRefresh: Promise<void> | undefined;

/** Parse one coherent topology + birth-identity process census. */
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) continue;
    rows.push({ pid, ppid, pgid, startedAt: match[4] });
  }
  return rows;
}

function execPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: PROCESS_CENSUS_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function listProcessRows(): Promise<ProcessRow[]> {
  if (process.platform === "win32") return Promise.resolve([]);
  return parseProcessRows(await execPs(["-A", "-o", "pid=,ppid=,pgid=,lstart="]));
}

/**
 * Grow a scope from identities that still match their recorded start time.
 * Matching start times prevent a recycled pid from seeding an unrelated tree.
 * Once one member is verified, every member of its process group is owned: a
 * detached harness starts a fresh POSIX session, so outsiders cannot join it.
 */
function indexProcessRows(rows: ProcessRow[]): ProcessInventory {
  const byPid = new Map<number, ProcessRow>();
  const byPpid = new Map<number, ProcessRow[]>();
  const byPgid = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const children = byPpid.get(row.ppid) ?? [];
    children.push(row);
    byPpid.set(row.ppid, children);
    const members = byPgid.get(row.pgid) ?? [];
    members.push(row);
    byPgid.set(row.pgid, members);
  }
  return { byPid, byPpid, byPgid };
}

function refreshScope(scope: OwnedProcessScope, inventory: ProcessInventory, rootWasAlive: boolean): void {
  const { byPid, byPpid, byPgid } = inventory;
  const owned = new Map<number, ProcessRow>();
  for (const [pid, identity] of scope.identities) {
    const row = byPid.get(pid);
    if (row && identity.startedAt === row.startedAt && identity.pgid === row.pgid) owned.set(pid, row);
  }
  const root = byPid.get(scope.rootPid);
  if (rootWasAlive && scope.rootIsAlive() && root?.pgid === scope.rootPid) {
    owned.set(root.pid, root);
  }

  // Alternate group expansion and child expansion until neither finds more.
  // This discovers a child which called setsid()/created a new PGID while its
  // PPID still points into the bee, then remembers that identity after orphaning.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of [...owned.values()]) {
      for (const member of byPgid.get(row.pgid) ?? []) {
        if (owned.has(member.pid)) continue;
        owned.set(member.pid, member);
        changed = true;
      }
      for (const child of byPpid.get(row.pid) ?? []) {
        if (owned.has(child.pid)) continue;
        owned.set(child.pid, child);
        changed = true;
      }
    }
  }

  scope.livePgids = new Set([...owned.values()].map((row) => row.pgid).filter((pgid) => pgid > 0));
  for (const row of owned.values()) scope.identities.set(row.pid, { pgid: row.pgid, startedAt: row.startedAt });
}

async function refreshOwnershipScopes(): Promise<void> {
  if (ownershipRefresh) return ownershipRefresh;
  ownershipRefresh = (async () => {
    // Require liveness on both sides of the census. The post-census check in
    // refreshScope prevents an exited/recycled root PID from seeding ownership.
    const liveRoots = new Set([...ownershipScopes].filter((scope) => scope.rootIsAlive()));
    const rows = await listProcessRows();
    const inventory = indexProcessRows(rows);
    for (const scope of ownershipScopes) refreshScope(scope, inventory, liveRoots.has(scope));
  })().finally(() => {
    ownershipRefresh = undefined;
  });
  return ownershipRefresh;
}

/** Always trail an in-flight event sample with a new current inventory. */
async function refreshOwnershipScopesFresh(): Promise<void> {
  if (ownershipRefresh) await ownershipRefresh.catch(() => undefined);
  await refreshOwnershipScopes();
}

function releaseOwnershipScope(scope: OwnedProcessScope): void {
  ownershipScopes.delete(scope);
  if (scope.delayedSample) clearTimeout(scope.delayedSample);
}

function trackChildProcessTree(child: ChildProcess): void {
  if (!child.pid || process.platform === "win32") return;
  const scope: OwnedProcessScope = {
    rootPid: child.pid,
    rootIsAlive: () => child.exitCode === null && child.signalCode === null,
    identities: new Map(),
    livePgids: new Set(),
  };
  ownershipScopes.add(scope);
  ownershipByChild.set(child, scope);
}

/** @internal Test-only visibility into event-driven ownership sampling. */
export function __testOnlyOwnedProcessGroups(child: ChildProcess): number[] {
  return [...(ownershipByChild.get(child)?.livePgids ?? [])];
}

function scheduleToolOwnershipSample(scope: OwnedProcessScope, attemptsRemaining: number): void {
  if (scope.delayedSample) clearTimeout(scope.delayedSample);
  scope.delayedSample = setTimeout(() => {
    scope.delayedSample = undefined;
    void refreshOwnershipScopesFresh().catch(() => {
      // Process creation itself can transiently fail under machine pressure.
      // Two bounded retries preserve cleanup without becoming a polling loop.
      if (attemptsRemaining > 1 && !scope.termination && scope.rootIsAlive()) {
        scheduleToolOwnershipSample(scope, attemptsRemaining - 1);
      }
    });
  }, TOOL_OWNERSHIP_SAMPLE_MS);
  scope.delayedSample.unref();
}

/**
 * Retain descendants at structured lifecycle boundaries without continuously
 * scanning the machine once per bee. Tool-use is sampled shortly afterward
 * because providers commonly emit it just before spawning the tool.
 */
export function noteChildProcessEvent(child: ChildProcess, event: RunnerEvent): void {
  if (event.type !== "turn_end" && event.type !== "tool_use") return;
  const scope = ownershipByChild.get(child);
  if (!scope || scope.termination) return;
  if (event.type === "tool_use") {
    scheduleToolOwnershipSample(scope, 3);
  } else void refreshOwnershipScopesFresh().catch(() => undefined);
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group may have exited between inventory and signal.
  }
}

async function terminateChildProcessTree(child: ChildProcess, hasChildExited: () => boolean): Promise<void> {
  const rootPgid = child.pid;
  if (!rootPgid || process.platform === "win32") {
    if (hasChildExited()) return;
    child.kill("SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (!hasChildExited() && Date.now() < deadline) await sleep(STOP_POLL_MS);
    if (!hasChildExited()) child.kill("SIGKILL");
    return;
  }

  const scope = ownershipByChild.get(child);
  if (scope?.termination) return scope.termination;
  const terminate = async (): Promise<void> => {
    if (scope?.delayedSample) {
      clearTimeout(scope.delayedSample);
      scope.delayedSample = undefined;
    }
    // Before an explicit stop, take a final ancestry sample while the root is
    // alive. After a natural exit, only previously birth-verified identities
    // are safe: an empty scope can no longer discover descendants by ancestry,
    // and launching a pointless full census would delay every ordinary exit.
    let finalInventorySucceeded = false;
    if (!hasChildExited() || (scope?.identities.size ?? 0) > 0) {
      try {
        await refreshOwnershipScopesFresh();
        finalInventorySucceeded = true;
      } catch {
        // Fail closed: stale PGIDs may since have been recycled by another tree.
      }
    }
    const targets = new Set(finalInventorySucceeded ? scope?.livePgids ?? [] : []);
    if (!hasChildExited()) targets.add(rootPgid);

    // Stop escaped groups first so killing the harness cannot erase ancestry
    // before they receive their signal. The root group is signalled last.
    const pgids = [...targets].filter((pgid) => pgid > 0 && pgid !== process.pid);
    pgids.sort((a, b) => (a === rootPgid ? 1 : b === rootPgid ? -1 : a - b));
    for (const pgid of pgids) signalProcessGroup(pgid, "SIGTERM");

    const deadline = Date.now() + STOP_GRACE_MS;
    while (pgids.some(isProcessGroupAlive) && Date.now() < deadline) await sleep(STOP_POLL_MS);
    if (pgids.some(isProcessGroupAlive)) {
      // PGIDs are numeric and can be recycled. Rebuild the owned set from
      // birth-validated identities immediately before escalation; if that
      // inventory fails, only the still-live ChildProcess root is safe.
      let escalationInventorySucceeded = false;
      try {
        await refreshOwnershipScopesFresh();
        escalationInventorySucceeded = true;
      } catch {
        // fail closed below
      }
      const escalationTargets = new Set(escalationInventorySucceeded ? scope?.livePgids ?? [] : []);
      if (!hasChildExited()) escalationTargets.add(rootPgid);
      for (const pgid of escalationTargets) {
        if (pgid > 0 && pgid !== process.pid && isProcessGroupAlive(pgid)) signalProcessGroup(pgid, "SIGKILL");
      }
    }
    if (scope) releaseOwnershipScope(scope);
  };
  const promise = terminate();
  if (scope) scope.termination = promise;
  return promise;
}

/**
 * Spawn the harness child detached (own process group ⇒ pgid === pid, so
 * stop() can group-kill it) and wait for the OS-level spawn to succeed or
 * fail. Post-spawn errors (rare: e.g. EPIPE) are swallowed — they must not
 * crash the host.
 */
export async function spawnSessionChild(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<ChildProcess> {
  const child: ChildProcess = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      resolve();
    });
  });
  child.on("error", () => undefined);
  trackChildProcessTree(child);
  return child;
}

/**
 * The child-agnostic core of the session plumbing: the event queue backing the
 * AsyncIterable, the ring buffer, ingest, and stream teardown. Extracted so
 * tier-"turn" runners (turnRunner.ts) — whose SESSION outlives many short
 * per-turn children — can own one plumbing across all of them, while the
 * one-child tiers keep the attachSessionPlumbing wrapper below.
 */
export type SessionPlumbingCore = {
  /** The structured event stream backing RunnerSession.events. */
  events: AsyncIterable<RunnerEvent>;
  /** Stamp ts (when 0/absent), queue, persist to events.jsonl, ring on text. */
  ingestEvent(event: RunnerEvent): void;
  /** Rendered text tail (RunnerSession.snapshot). */
  snapshot(lines?: number): string;
  /** Flush any debounced ring.txt write immediately. */
  flushRing(): void;
  /** End the event stream (idempotent); waiters see done immediately. */
  endStream(): void;
};

export function createSessionPlumbing(bee: string): SessionPlumbingCore {
  // --- structured event queue (backs the AsyncIterable) ----------------------
  const queue: RunnerEvent[] = [];
  const waiters: Array<(r: IteratorResult<RunnerEvent>) => void> = [];
  let ended = false;

  const pushEvent = (event: RunnerEvent): void => {
    if (ended) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  };
  const endStream = (): void => {
    if (ended) return;
    ended = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined as never, done: true });
  };

  const events: AsyncIterable<RunnerEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RunnerEvent> {
      return {
        next(): Promise<IteratorResult<RunnerEvent>> {
          const buffered = queue.shift();
          if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
          if (ended) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  // --- ring buffer (rendered text tail) --------------------------------------
  let ringText = "";
  let ringTimer: NodeJS.Timeout | null = null;

  const scheduleRingWrite = (): void => {
    if (ringTimer) return;
    ringTimer = setTimeout(() => {
      ringTimer = null;
      void writeHsrRing(bee, ringText).catch(() => undefined);
    }, RING_DEBOUNCE_MS);
  };
  const flushRing = (): void => {
    if (ringTimer) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
    void writeHsrRing(bee, ringText).catch(() => undefined);
  };

  // --- ingest one produced event: stamp, persist, queue, ring ----------------
  const ingestEvent = (event: RunnerEvent): void => {
    if (typeof (event as { ts?: unknown }).ts !== "number" || (event as { ts: number }).ts === 0) {
      (event as { ts: number }).ts = Date.now();
    }
    pushEvent(event);
    // The runner is the single writer of the durable event log (see file docs).
    void appendHsrEvent(bee, event).catch(() => undefined);
    if (event.type === "text") {
      ringText = appendRingText(ringText, event.text);
      scheduleRingWrite();
    }
  };

  function snapshot(lines?: number): string {
    if (lines === undefined) return ringText;
    const all = ringText.split("\n");
    // Drop a trailing empty produced by the terminal newline before slicing.
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  }

  return { events, ingestEvent, snapshot, flushRing, endStream };
}

/**
 * SIGTERM a detached child's process group, SIGKILL after a short grace, and
 * wait for its exit. Shared by the one-child stop below and the turn runner's
 * per-turn/stop teardown.
 */
export async function stopChildGroup(child: ChildProcess, hasExited: () => boolean, exitedPromise: Promise<void>): Promise<void> {
  await Promise.all([terminateChildProcessTree(child, hasExited), exitedPromise]);
}

/** The shared per-session plumbing a one-child runner builds its RunnerSession from. */
export type SessionPlumbing = {
  /** The structured event stream backing RunnerSession.events. */
  events: AsyncIterable<RunnerEvent>;
  /** Stamp ts (when 0/absent), queue, persist to events.jsonl, ring on text. */
  ingestEvent(event: RunnerEvent): void;
  /** Rendered text tail (RunnerSession.snapshot). */
  snapshot(lines?: number): string;
  /** True once the child has exited. */
  hasExited(): boolean;
  /** Resolves when the child has exited and the plumbing is torn down. */
  exitedPromise: Promise<void>;
  /** SIGTERM the child's process group, SIGKILL after a grace; awaits exit. */
  stop(): Promise<void>;
};

/**
 * Install the shared plumbing on a freshly spawned session child: event queue,
 * ring buffer, ingest, exit teardown, and group stop. `onChildExit` runs FIRST
 * in the exit handler, before the exit event is ingested — a runner disposes
 * its transport there (e.g. the codex RPC peer). For tiers whose session spans
 * MANY children (turn), use createSessionPlumbing + stopChildGroup directly.
 */
export function attachSessionPlumbing(
  bee: string,
  child: ChildProcess,
  hooks: { onChildExit?: () => void } = {},
): SessionPlumbing {
  const core = createSessionPlumbing(bee);
  const ingestEvent = (event: RunnerEvent): void => {
    noteChildProcessEvent(child, event);
    core.ingestEvent(event);
  };

  // --- child exit -------------------------------------------------------------
  let exited = false;
  let resolveExited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  child.once("exit", (code, signal) => {
    exited = true;
    hooks.onChildExit?.();
    void (async () => {
      // A natural/crash exit must also reap groups which escaped the harness
      // PGID. Event-driven snapshots retain their identity after reparenting.
      await terminateChildProcessTree(child, () => true).catch(() => undefined);
      ingestEvent({ type: "exit", ts: Date.now(), code: code ?? null, signal: signal ?? undefined });
      core.flushRing();
      core.endStream();
      // Node does NOT auto-close the parent-side stdio pipes on child exit — the
      // stdin write pipe in particular stays an open handle and would keep the
      // host's event loop alive forever (a zombie __hsr-run process that never
      // exits after its session ends). Destroy them so the host exits cleanly.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveExited();
    })();
  });

  return {
    events: core.events,
    ingestEvent,
    snapshot: core.snapshot,
    hasExited: () => exited,
    exitedPromise,
    stop: () => stopChildGroup(child, () => exited, exitedPromise),
  };
}
