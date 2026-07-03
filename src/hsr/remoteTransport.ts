/**
 * Remote HSR transport (APIA-91, Phase A).
 *
 * Drives a `remote-hsr` node's runner-host control plane FROM THE LOCAL machine
 * over ssh. Three layers, each independently injectable/testable:
 *
 *   1. ensureRemoteServe    — over ssh (exec hook), make sure the remote
 *                             `node <bundle> serve --socket <remoteSock>` control
 *                             socket exists; start it detached (setsid) and poll
 *                             `test -S` until it appears. Idempotent.
 *   2. openSshSocketForward — spawn a long-lived `ssh -N -L <local>:<remote>`
 *                             UNIX→UNIX LocalForward (ControlMaster reuse) so the
 *                             remote control socket surfaces as a LOCAL socket.
 *   3. connectRemoteRunnerHost → RemoteRunnerClient — points honeybee's RPC
 *                             client (connectRpcClient) at the forwarded local
 *                             socket and wraps it with RESILIENCE: per-call
 *                             timeouts, tunnel-down rejection, capped-backoff
 *                             reconnect with SUBSCRIPTION RE-ADOPTION, and
 *                             BOUNDED inbound-notification backpressure.
 *
 * Every ssh interaction goes through an injectable exec/spawn hook, so the whole
 * module is unit-testable with a local socket relay standing in for the tunnel
 * (see tests/hsr-remote-transport.test.ts). Real ssh wire (loopback key-auth)
 * e2e is deferred to APIA-98. No new deps — node builtins only.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { storeRoot } from "../fsx.js";
import type { NodeRecord } from "../node.js";
import { remoteBundlePath } from "./bootstrap.js";
import { connectRpcClient, type RpcClient } from "./rpc.js";

// --- shared defaults ----------------------------------------------------------

/** Default runner-host control socket path on the remote (tilde-expanded remote-side). */
export const DEFAULT_REMOTE_SOCKET = "~/.hive/runner-host/control.sock";

const DEFAULT_SSH_EXEC_TIMEOUT_MS = 8_000;
const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = Math.ceil(DEFAULT_SSH_EXEC_TIMEOUT_MS / 1000);

// Connection-multiplexing options plus a connect timeout for bounded remote-hsr
// ssh phases. The ControlMaster options match ssh-tmux / bootstrap so all three
// share one ControlMaster (a single ssh handshake amortized across ops).
const CONTROL_MASTER_ARGS: string[] = [
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=~/.ssh/hive-%C",
  "-o", "ControlPersist=60",
  "-o", `ConnectTimeout=${DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS}`,
];
// Forward-specific hardening: fail the tunnel immediately if the LocalForward
// cannot bind (don't silently hand back a dead socket), and remove any stale
// bound unix socket on the remote side before binding.
const FORWARD_ARGS: string[] = [
  "-o", "ExitOnForwardFailure=yes",
  "-o", "StreamLocalBindUnlink=yes",
];

/** Per-call timeout default. Mirrors rpc.ts's per-call discipline and stays well
 *  under the daemon's 60s dispatch budget (HIVE_DAEMON_DISPATCH_TIMEOUT_MS). */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

// ensureRemoteServe polling: how long to wait for the detached serve socket.
const DEFAULT_SERVE_POLL_ATTEMPTS = 30;
const DEFAULT_SERVE_POLL_INTERVAL_MS = 200;
// openSshSocketForward: how long to wait for the local forwarded socket to appear.
const DEFAULT_FORWARD_WAIT_ATTEMPTS = 50;
const DEFAULT_FORWARD_WAIT_INTERVAL_MS = 100;

// Reconnect backoff (capped exponential).
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 5_000;

// Backpressure: max buffered inbound notifications PER subscribed method.
const DEFAULT_MAX_QUEUE = 256;

// --- injectable hooks ---------------------------------------------------------

export type SshExecHook = (
  argv: string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** A spawned long-lived tunnel child. `exited` resolves when the child dies. */
export type TunnelChild = {
  readonly argv: string[];
  kill(): void;
  readonly exited: Promise<void>;
};

export type TunnelSpawnHook = (argv: string[]) => TunnelChild;

/** Connect the RPC client to a (forwarded) local socket. Injected for tests. */
export type RpcConnectHook = (
  socketPath: string,
  opts?: { connectTimeoutMs?: number },
) => Promise<RpcClient>;

export type RemoteTransportDeps = {
  execHook?: SshExecHook;
  spawnTunnel?: TunnelSpawnHook;
  connect?: RpcConnectHook;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- ssh argv builders (exported so tests can assert the real wire) -----------

function sshBinaryFor(node: NodeRecord): string {
  return node.sshCommand ?? "ssh";
}

function controlArgsFor(node: NodeRecord): string[] {
  // User-supplied sshArgs replace the multiplexing defaults wholesale (same rule
  // as ssh-tmux and bootstrap).
  return node.sshArgs && node.sshArgs.length > 0 ? [...node.sshArgs] : CONTROL_MASTER_ARGS;
}

/** The `ssh <endpoint> <remoteCommand>` argv used by ensureRemoteServe. */
export function buildServeExecArgv(node: NodeRecord, remoteCommand: string): string[] {
  return [sshBinaryFor(node), ...controlArgsFor(node), node.endpoint, remoteCommand];
}

/** The long-lived `ssh -N -L <local>:<remote> <endpoint>` unix-forward argv. */
export function buildSshForwardArgv(node: NodeRecord, localSocket: string, remoteSocket: string): string[] {
  return [
    sshBinaryFor(node),
    "-N",
    ...controlArgsFor(node),
    ...FORWARD_ARGS,
    "-L", `${localSocket}:${remoteSocket}`,
    node.endpoint,
  ];
}

/** Local socket path a node's forwarded control plane surfaces at. */
export function localForwardSocket(node: NodeRecord): string {
  return join(storeRoot(), "remote", node.name, "control.sock");
}

function requireVersion(node: NodeRecord): string {
  if (node.kind !== "remote-hsr") {
    throw new Error(`remoteTransport: node ${node.name} is kind ${node.kind}, expected remote-hsr`);
  }
  if (!node.runnerHostVersion) {
    throw new Error(`remoteTransport: node ${node.name} has no runnerHostVersion — run \`hive node bootstrap\` first`);
  }
  return node.runnerHostVersion;
}

// --- 1. ensureRemoteServe -----------------------------------------------------

export type EnsureServeOptions = RemoteTransportDeps & {
  remoteSocket?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
};

/**
 * Ensure the remote runner-host serve socket exists. Idempotent: if
 * `test -S <remoteSock>` already succeeds, returns immediately; otherwise starts
 * the bundle detached (`setsid node <bundle> serve --socket <sock> &`) and polls
 * `test -S` until the socket appears (bounded) or throws.
 */
export async function ensureRemoteServe(
  node: NodeRecord,
  opts: EnsureServeOptions = {},
): Promise<{ remoteSocket: string }> {
  const version = requireVersion(node);
  const exec = opts.execHook ?? defaultSshExecHook;
  const sleep = opts.sleep ?? defaultSleep;
  const remoteSocket = opts.remoteSocket ?? DEFAULT_REMOTE_SOCKET;
  const bundle = remoteBundlePath(version);
  const attempts = opts.pollAttempts ?? DEFAULT_SERVE_POLL_ATTEMPTS;
  const intervalMs = opts.pollIntervalMs ?? DEFAULT_SERVE_POLL_INTERVAL_MS;

  const runRemote = (cmd: string) => exec(buildServeExecArgv(node, cmd));

  // Already up?
  const probe = await runRemote(`test -S ${remoteSocket}`);
  if (probe.exitCode === 0) return { remoteSocket };

  // Start detached so it outlives this ssh connection. setsid detaches from the
  // controlling terminal; redirect all fds and background so ssh returns at once.
  const start = await runRemote(
    `setsid node ${bundle} serve --socket ${remoteSocket} >/dev/null 2>&1 < /dev/null &`,
  );
  if (start.exitCode !== 0) {
    throw new Error(
      `remoteTransport: failed to start remote serve on ${node.endpoint} (exit ${start.exitCode}): ${start.stderr.trim() || start.stdout.trim() || "no output"}`,
    );
  }

  // Poll until the socket materializes.
  for (let i = 0; i < attempts; i++) {
    const check = await runRemote(`test -S ${remoteSocket}`);
    if (check.exitCode === 0) return { remoteSocket };
    await sleep(intervalMs);
  }
  throw new Error(
    `remoteTransport: remote serve socket ${remoteSocket} did not appear on ${node.endpoint} after ${attempts} attempts`,
  );
}

// --- 2. openSshSocketForward --------------------------------------------------

export type TunnelHandle = {
  readonly localSocket: string;
  close(): Promise<void>;
  /** Resolves when the tunnel goes down (ssh child exits). */
  readonly closed: Promise<void>;
};

export type ForwardOptions = RemoteTransportDeps & {
  remoteSocket?: string;
  localSocket?: string;
  waitAttempts?: number;
  waitIntervalMs?: number;
};

/**
 * Spawn the ssh unix→unix LocalForward and wait until the local socket appears.
 * The returned handle's `closed` resolves when the ssh child exits.
 */
export async function openSshSocketForward(
  node: NodeRecord,
  opts: ForwardOptions = {},
): Promise<TunnelHandle> {
  requireVersion(node);
  const spawnTunnel = opts.spawnTunnel ?? defaultSpawnTunnel;
  const sleep = opts.sleep ?? defaultSleep;
  const remoteSocket = opts.remoteSocket ?? DEFAULT_REMOTE_SOCKET;
  const localSocket = opts.localSocket ?? localForwardSocket(node);
  const attempts = opts.waitAttempts ?? DEFAULT_FORWARD_WAIT_ATTEMPTS;
  const intervalMs = opts.waitIntervalMs ?? DEFAULT_FORWARD_WAIT_INTERVAL_MS;

  await mkdir(dirname(localSocket), { recursive: true, mode: 0o700 });
  // Remove any stale local socket left by a crashed forward before ssh binds it.
  await unlink(localSocket).catch(() => {});

  const argv = buildSshForwardArgv(node, localSocket, remoteSocket);
  const child = spawnTunnel(argv);

  let childExited = false;
  void child.exited.then(() => {
    childExited = true;
  });

  // Wait for the forwarded socket to appear (or the child to die first).
  let appeared = false;
  for (let i = 0; i < attempts; i++) {
    if (existsSync(localSocket)) {
      appeared = true;
      break;
    }
    if (childExited) break;
    await sleep(intervalMs);
  }
  if (!appeared) {
    child.kill();
    await child.exited.catch(() => {});
    throw new Error(
      `remoteTransport: ssh forward to ${node.endpoint} never produced local socket ${localSocket}` +
        (childExited ? " (ssh child exited early)" : ` after ${attempts} attempts`),
    );
  }

  const handle: TunnelHandle = {
    localSocket,
    async close(): Promise<void> {
      child.kill();
      await child.exited.catch(() => {});
      await unlink(localSocket).catch(() => {});
    },
    // Resolves on ssh child exit regardless of who triggered it.
    closed: child.exited,
  };
  return handle;
}

// --- 3. connectRemoteRunnerHost → RemoteRunnerClient --------------------------

export type RemoteRunnerStatusEvent = "reconnect" | "down" | "up";

export type RemoteRunnerClient = {
  readonly node: string;
  /** Current forwarded local socket (undefined while down). */
  readonly localSocket: string | undefined;
  /** True while a live rpc client + tunnel are established. */
  connected(): boolean;
  /**
   * Invoke a remote method. Per-call timeout (default {@link DEFAULT_CALL_TIMEOUT_MS}).
   * Rejects immediately (does not hang) when the tunnel is down.
   */
  call(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /**
   * Subscribe to a server-push notification method (e.g. `hsr.event`) OR a
   * transport status event (`reconnect` | `down` | `up`). Push subscriptions are
   * TRACKED and RE-ADOPTED across reconnects. Returns an unsubscribe fn.
   */
  on(method: string, handler: (params: unknown) => void): () => void;
  /** Per-subscription dropped-notification count (backpressure telemetry). */
  droppedCount(method: string): number;
  /** Tear down the rpc client + tunnel and stop reconnecting. */
  close(): Promise<void>;
};

export type ConnectRemoteOptions = RemoteTransportDeps & {
  remoteSocket?: string;
  callTimeoutMs?: number;
  /** Max buffered inbound notifications per subscribed method (backpressure). */
  maxQueue?: number;
  reconnect?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  serve?: { pollAttempts?: number; pollIntervalMs?: number };
  forward?: { waitAttempts?: number; waitIntervalMs?: number };
};

const RESERVED_STATUS: ReadonlySet<string> = new Set<RemoteRunnerStatusEvent>(["reconnect", "down", "up"]);

type Subscription = {
  queue: unknown[];
  dropped: number;
  draining: boolean;
  detach?: () => void;
};

/**
 * Establish the remote serve + ssh forward + rpc client and wrap them in a
 * resilient session. Backpressure & reconnect policy documented inline below.
 */
export async function connectRemoteRunnerHost(
  node: NodeRecord,
  opts: ConnectRemoteOptions = {},
): Promise<RemoteRunnerClient> {
  requireVersion(node);
  const connect = opts.connect ?? connectRpcClient;
  const sleep = opts.sleep ?? defaultSleep;
  const remoteSocket = opts.remoteSocket ?? DEFAULT_REMOTE_SOCKET;
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxQueue = Math.max(1, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
  const reconnectMax = opts.reconnect?.maxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS;
  const reconnectBase = opts.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectCap = opts.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS;

  const serveOpts: EnsureServeOptions = {
    ...pickDeps(opts),
    remoteSocket,
    ...(opts.serve?.pollAttempts !== undefined ? { pollAttempts: opts.serve.pollAttempts } : {}),
    ...(opts.serve?.pollIntervalMs !== undefined ? { pollIntervalMs: opts.serve.pollIntervalMs } : {}),
  };
  const forwardOpts: ForwardOptions = {
    ...pickDeps(opts),
    remoteSocket,
    ...(opts.forward?.waitAttempts !== undefined ? { waitAttempts: opts.forward.waitAttempts } : {}),
    ...(opts.forward?.waitIntervalMs !== undefined ? { waitIntervalMs: opts.forward.waitIntervalMs } : {}),
  };

  // --- session state ---
  let current: { client: RpcClient; tunnel: TunnelHandle } | null = null;
  let closedByUser = false;
  let reconnecting = false;

  // Push subscriptions: handlers + a bounded inbound queue per method. Status
  // handlers ('reconnect'|'down'|'up') are local-only, never bridged to the wire.
  const pushHandlers = new Map<string, Set<(params: unknown) => void>>();
  const statusHandlers = new Map<string, Set<(params: unknown) => void>>();
  const subs = new Map<string, Subscription>();

  function emitStatus(name: RemoteRunnerStatusEvent, payload: unknown): void {
    const set = statusHandlers.get(name);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(payload);
      } catch {
        // A status handler must never break the transport.
      }
    }
  }

  // BACKPRESSURE POLICY: each subscribed method has a bounded queue (maxQueue).
  // Inbound notifications enqueue; when the queue is full we DROP-OLDEST and bump
  // a per-subscription dropped counter, so a chatty remote bee cannot OOM the
  // local process. A single async drain loop per subscription delivers events to
  // handlers one at a time (awaiting async handlers), decoupling socket reads
  // from handler execution.
  function enqueue(method: string, params: unknown): void {
    const sub = subs.get(method);
    if (!sub) return;
    if (sub.queue.length >= maxQueue) {
      sub.queue.shift();
      sub.dropped++;
    }
    sub.queue.push(params);
    void drain(method);
  }

  async function drain(method: string): Promise<void> {
    const sub = subs.get(method);
    if (!sub || sub.draining) return;
    sub.draining = true;
    try {
      while (sub.queue.length > 0) {
        const params = sub.queue.shift();
        const handlers = pushHandlers.get(method);
        if (handlers) {
          for (const h of [...handlers]) {
            try {
              await h(params);
            } catch {
              // Handler errors are isolated — keep draining.
            }
          }
        }
      }
    } finally {
      sub.draining = false;
    }
  }

  // (Re)attach a subscription's bridge onto the given rpc client.
  function bridge(method: string, client: RpcClient): void {
    const sub = subs.get(method);
    if (!sub) return;
    sub.detach?.();
    sub.detach = client.on(method, (params) => enqueue(method, params));
  }

  async function establish(): Promise<void> {
    await ensureRemoteServe(node, serveOpts);
    const tunnel = await openSshSocketForward(node, forwardOpts);
    let client: RpcClient;
    try {
      client = await connect(tunnel.localSocket);
    } catch (error) {
      await tunnel.close().catch(() => {});
      throw error;
    }
    current = { client, tunnel };
    // RE-ADOPT all tracked push subscriptions on the fresh client.
    for (const method of subs.keys()) bridge(method, client);
    watchDrop(client, tunnel);
  }

  // Watch the live client/tunnel; on an unexpected drop, kick off reconnect.
  function watchDrop(client: RpcClient, tunnel: TunnelHandle): void {
    void Promise.race([client.closed, tunnel.closed]).then(() => {
      if (closedByUser) return;
      if (current?.client !== client) return; // superseded by a newer session
      void reconnect();
    });
  }

  // RECONNECT POLICY: capped exponential backoff (base 250ms → cap 5s), a few
  // attempts (default 5). Each attempt re-runs ensureRemoteServe → forward →
  // connect and RE-ADOPTS subscriptions (via establish). On success we emit
  // 'reconnect'; giving up after N attempts emits 'down' (calls then reject).
  async function reconnect(): Promise<void> {
    if (reconnecting || closedByUser) return;
    reconnecting = true;
    // Drop the dead session so call() rejects cleanly while we retry.
    const dead = current;
    current = null;
    if (dead) {
      dead.client.close();
      await dead.tunnel.close().catch(() => {});
    }
    let delay = reconnectBase;
    for (let attempt = 1; attempt <= reconnectMax; attempt++) {
      if (closedByUser) {
        reconnecting = false;
        return;
      }
      await sleep(delay);
      if (closedByUser) {
        reconnecting = false;
        return;
      }
      try {
        await establish();
        reconnecting = false;
        emitStatus("reconnect", { attempt });
        emitStatus("up", { attempt });
        return;
      } catch {
        delay = Math.min(delay * 2, reconnectCap);
      }
    }
    reconnecting = false;
    if (!closedByUser) emitStatus("down", { attempts: reconnectMax });
  }

  // Initial connect: a failure here rejects the caller (no reconnect loop yet).
  await establish();
  emitStatus("up", { attempt: 0 });

  return {
    node: node.name,
    get localSocket(): string | undefined {
      return current?.tunnel.localSocket;
    },
    connected(): boolean {
      return current !== null;
    },
    call(method: string, params?: unknown, callOpts?: { timeoutMs?: number }): Promise<unknown> {
      const c = current?.client;
      if (!c) {
        return Promise.reject(new Error(`remoteTransport: ${node.name} tunnel is down`));
      }
      return c.call(method, params, { timeoutMs: callOpts?.timeoutMs ?? callTimeoutMs });
    },
    on(method: string, handler: (params: unknown) => void): () => void {
      if (RESERVED_STATUS.has(method)) {
        let set = statusHandlers.get(method);
        if (!set) {
          set = new Set();
          statusHandlers.set(method, set);
        }
        set.add(handler);
        return () => set.delete(handler);
      }
      let set = pushHandlers.get(method);
      if (!set) {
        set = new Set();
        pushHandlers.set(method, set);
      }
      set.add(handler);
      if (!subs.has(method)) {
        subs.set(method, { queue: [], dropped: 0, draining: false });
        if (current) bridge(method, current.client);
      }
      return () => {
        set.delete(handler);
      };
    },
    droppedCount(method: string): number {
      return subs.get(method)?.dropped ?? 0;
    },
    async close(): Promise<void> {
      closedByUser = true;
      const cur = current;
      current = null;
      if (cur) {
        cur.client.close();
        await cur.tunnel.close().catch(() => {});
      }
    },
  };
}

/** Extract just the injectable deps from a wider options object. */
function pickDeps(opts: RemoteTransportDeps): RemoteTransportDeps {
  const out: RemoteTransportDeps = {};
  if (opts.execHook) out.execHook = opts.execHook;
  if (opts.spawnTunnel) out.spawnTunnel = opts.spawnTunnel;
  if (opts.connect) out.connect = opts.connect;
  if (opts.now) out.now = opts.now;
  if (opts.sleep) out.sleep = opts.sleep;
  return out;
}

// --- default hooks ------------------------------------------------------------

/** Default ssh exec hook: spawn ssh, collect stdout/stderr, and bound wall-clock time. */
export function defaultSshExecHook(
  argv: string[],
  input?: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [command, ...args] = argv;
  if (!command) return Promise.reject(new Error("Empty argv"));
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_SSH_EXEC_TIMEOUT_MS);
    const settle = (result: { stdout: string; stderr: string; exitCode: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const timeoutMessage = `timed out after ${timeoutMs}ms`;
      const timeoutStderr = stderr ? `${stderr}${stderr.endsWith("\n") ? "" : "\n"}${timeoutMessage}` : timeoutMessage;
      settle({ stdout, stderr: timeoutStderr, exitCode: 1 });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => settle({ stdout, stderr: stderr || error.message, exitCode: 1 }));
    child.on("close", (code, signal) => settle({ stdout, stderr, exitCode: code ?? (signal ? 130 : 1) }));
    child.stdin.on("error", () => undefined);
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Default tunnel spawn: a long-lived detached `ssh -N -L ...` child. */
export function defaultSpawnTunnel(argv: string[]): TunnelChild {
  const [command, ...args] = argv;
  if (!command) throw new Error("Empty argv");
  const child = spawn(command, args, { stdio: "ignore" });
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  child.on("exit", () => resolveExit());
  child.on("error", () => resolveExit());
  return {
    argv,
    kill: () => {
      child.kill("SIGTERM");
    },
    exited,
  };
}
