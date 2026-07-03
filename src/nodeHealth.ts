/**
 * Node health probe (APIA-96) — the model behind `hive node status`.
 *
 * For each node it times a live probe and returns a structured {@link NodeHealth}
 * row. For a `remote-hsr` node the probe is the runner-host `ping` (which also
 * reports the deployed runner-host version), and — when reachable — a `list`
 * gives the live bee count; the reported version is compared against the LOCAL
 * bundle version to flag drift. For local-tmux / ssh-tmux it is the substrate's
 * plain `probe()` (reachable + latency + node kind).
 *
 * A per-node timeout (default 3s) bounds every probe so one dead node can never
 * hang the caller: an unreachable node resolves to `reachable:false` with a
 * `reason`, never a throw.
 *
 * Node builtins + honeybee modules only; no new deps.
 */

import { runnerHostVersionCore } from "./hsr/buildRunnerHostBundle.js";
import type { NodeRecord } from "./node.js";
import { remoteHsrSubstrateForNode, substrateForRecord } from "./substrates/index.js";
import type { RemoteHsrSubstrate } from "./substrates/remote-hsr.js";
import type { Substrate } from "./substrates/types.js";

/** Default per-node probe budget — one dead node must not hang the command. */
export const DEFAULT_NODE_STATUS_TIMEOUT_MS = 3_000;

export type NodeHealth = {
  name: string;
  kind: NodeRecord["kind"];
  endpoint: string;
  /** True when the live probe succeeded within the budget. */
  reachable: boolean;
  /** Round-trip time of the probe in ms; null only if the timer never started. */
  latencyMs: number | null;
  /** Human reason when unreachable (transport error / timeout / not-ok). */
  reason?: string;
  // ── remote-hsr only ──────────────────────────────────────────────────────
  /** Runner-host version core: live-reported when reachable, else the recorded value. */
  runnerHostVersion?: string;
  /** The LOCAL runner-host bundle version core (drift baseline). */
  localVersion?: string;
  /** True when runnerHostVersion !== localVersion (deploy drift). */
  versionDrift?: boolean;
  /** Live bee count from the node's runner host (reachable remote-hsr only). */
  liveBees?: number;
};

export type NodeHealthOptions = {
  /** Per-node probe budget (default {@link DEFAULT_NODE_STATUS_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * Injected substrate (tests point this at an in-process serve). When provided
   * it is NOT torn down here — the caller owns its lifecycle. When absent the
   * substrate is resolved from the node and, for remote-hsr, closed afterward so
   * the forwarded tunnel does not keep a one-shot CLI process alive.
   */
  substrate?: Substrate | RemoteHsrSubstrate;
  /** Clock (tests). */
  now?: () => number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject after `ms` if the probe has not settled (the op itself is not cancelled). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** `runner-host 0.0.1+sha` → `0.0.1+sha`; a bare core passes through unchanged. */
function versionCore(reported: string): string {
  return reported.startsWith("runner-host ") ? reported.slice("runner-host ".length).trim() : reported.trim();
}

/**
 * Probe one node and return its health row. Never throws — an unreachable node
 * resolves to `{ reachable:false, reason }`.
 */
export async function nodeHealth(node: NodeRecord, options: NodeHealthOptions = {}): Promise<NodeHealth> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NODE_STATUS_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const base: NodeHealth = {
    name: node.name,
    kind: node.kind,
    endpoint: node.endpoint,
    reachable: false,
    latencyMs: null,
  };

  if (node.kind === "remote-hsr") {
    const sub = (options.substrate as RemoteHsrSubstrate | undefined) ?? remoteHsrSubstrateForNode(node);
    const owned = options.substrate === undefined;
    const localVersion = runnerHostVersionCore();
    try {
      const started = now();
      let ping: { ok: boolean; version?: string; reason?: string };
      try {
        ping = await withTimeout(sub.ping(), timeoutMs, `ping ${node.name}`);
      } catch (error) {
        ping = { ok: false, reason: messageOf(error) };
      }
      const latencyMs = Math.max(0, Math.round(now() - started));

      if (!ping.ok) {
        // Fall back to the recorded runner-host version when the live ping fails.
        const recorded = node.runnerHostVersion;
        return {
          ...base,
          reachable: false,
          latencyMs,
          reason: ping.reason ?? "unreachable",
          localVersion,
          ...(recorded ? { runnerHostVersion: recorded, versionDrift: recorded !== localVersion } : {}),
        };
      }

      const version = ping.version ? versionCore(ping.version) : node.runnerHostVersion;
      let liveBees: number | undefined;
      try {
        const states = await withTimeout(sub.listSessionStates(), timeoutMs, `list ${node.name}`);
        liveBees = states.size;
      } catch {
        liveBees = undefined; // reachable, but the live-count call raced a drop
      }
      return {
        ...base,
        reachable: true,
        latencyMs,
        localVersion,
        ...(version ? { runnerHostVersion: version, versionDrift: version !== localVersion } : {}),
        ...(liveBees !== undefined ? { liveBees } : {}),
      };
    } finally {
      if (owned) await sub.close().catch(() => undefined);
    }
  }

  // local-tmux / ssh-tmux: reachable + latency + kind (simple but useful).
  const sub = options.substrate ?? substrateForRecord(node);
  const started = now();
  let probe: { ok: boolean; reason?: string };
  try {
    probe = await withTimeout(sub.probe(), timeoutMs, `probe ${node.name}`);
  } catch (error) {
    probe = { ok: false, reason: messageOf(error) };
  }
  const latencyMs = Math.max(0, Math.round(now() - started));
  return {
    ...base,
    reachable: probe.ok,
    latencyMs,
    ...(probe.ok ? {} : { reason: probe.reason ?? "unreachable" }),
  };
}
