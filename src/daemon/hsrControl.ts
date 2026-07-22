/**
 * HSR daemon-hosted aggregate control/observe endpoint (APIA-73).
 *
 * One unix socket under daemonRoot() that the CLI/Apiary use to steer and watch
 * EVERY HSR bee through a single plane (HSR_EXPLORATION.md §6, §7): spawn, send,
 * interrupt, answer, stop, snapshot, liveness, list, and a live event relay.
 *
 * This endpoint owns no runner and holds no harness pipes. The per-bee control
 * sockets (owned by each detached runner host — see src/hsr/host.ts) do the
 * actual steering; this server is a thin aggregate that:
 *   - reads run dirs for liveness/list (hsrObservations + readHsrMeta), and
 *   - PROXIES steering calls to a bee's control socket (connect → call → close), and
 *   - RELAYS each bee's `event` notifications out as `hsr.event` broadcasts.
 *
 * It reuses the APIA-73 JSON-RPC transport (src/hsr/rpc.ts) for both the
 * aggregate server and the per-bee client connections. No new deps.
 *
 * Resilience: every handler catches and returns `{ ok: false, error }` rather
 * than throwing, so one bad bee never wedges the shared plane. The daemon starts
 * this best-effort — a socket failure must NOT stop the daemon (see run.ts).
 */

import { join } from "node:path";
import {
  connectRpcClient,
  startRpcServer,
  type RpcClient,
  type RpcMethodHandler,
  type RpcServer,
} from "../hsr/rpc.js";
import { hsrObservations, pendingNeedsInput } from "../hsr/observe.js";
import { readHsrMeta } from "../hsr/runDir.js";
import { assertCallerEnvAllowed } from "../spawnEnv.js";
import { daemonRoot } from "./log.js";

export type HsrControlServer = {
  path: string;
  close(): Promise<void>;
};

/**
 * The aggregate control socket path: `<daemonRoot()>/hsr-control.sock`. A short
 * path, well under the AF_UNIX ~104-byte limit (unlike the per-bee run-dir
 * sockets, which is why those are hashed under /tmp — see runDir.ts).
 */
export function hsrControlSocketPath(): string {
  return join(daemonRoot(), "hsr-control.sock");
}

/** Validate a spawn RPC env object and render it as repeated --env argv. */
export function hsrSpawnEnvArgv(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("spawn env must be an object of string values");
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`spawn env value for ${key} must be a string`);
    env[key] = item;
  }
  assertCallerEnvAllowed(env);
  return Object.entries(env).flatMap(([key, item]) => ["--env", `${key}=${item}`]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startHsrControlServer(opts?: { socketPath?: string }): Promise<HsrControlServer> {
  const socketPath = opts?.socketPath ?? hsrControlSocketPath();

  // Live event relays, one cached client per observed bee. Ref-counted across
  // subscribers so N `observe(bee)` calls share ONE connection to the bee's
  // control socket; dropped when the bee dies (its control socket closes) or on
  // server.close().
  type Relay = { client: RpcClient; refCount: number; unsubscribe: () => void };
  const relays = new Map<string, Relay>();

  // Assigned once startRpcServer resolves; handlers/relays run strictly after,
  // so the closure read is always defined.
  let server: RpcServer;

  /**
   * Connect a bee's control socket, invoke one method, and close. Returns
   * `{ ok:true, result }` or `{ ok:false, error }`; never throws. A bee whose
   * meta is missing / not "running" / lacks a control socket has no live host.
   */
  async function proxyCall(bee: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!bee) return { ok: false, error: "bee required" };
    const meta = await readHsrMeta(bee);
    if (!meta || meta.status !== "running" || !meta.controlSocket) {
      return { ok: false, error: `no live host for ${bee}` };
    }
    let client: RpcClient;
    try {
      client = await connectRpcClient(meta.controlSocket);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    try {
      const result = await client.call(method, params);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    } finally {
      client.close();
    }
  }

  /** Wrap a handler so it can never throw out to the transport. */
  function guarded(fn: (params: unknown) => Promise<unknown>): RpcMethodHandler {
    return async (params) => {
      try {
        return await fn(params);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    };
  }

  const methods: Record<string, RpcMethodHandler> = {
    // Feature handshake for clients that must not guess across daemon versions:
    // spawn:2 = in-process spawnSingleBee with prompt/flags/rest support;
    // spawnEnv:1 = the optional env object accepted by spawn (validated, then
    // forwarded as repeated --env). An older daemon rejects this method
    // outright, which reads as "CLI fallback".
    capabilities: guarded(async () => ({ ok: true, spawn: 2, spawnEnv: 1 })),

    liveness: guarded(async () => {
      const out: Record<string, boolean> = {};
      for (const [bee, observation] of await hsrObservations()) out[bee] = observation.live;
      return out;
    }),

    list: guarded(async () => {
      const observations = await hsrObservations();
      const rows: Array<Record<string, unknown>> = [];
      for (const [bee, observation] of observations) {
        const meta = await readHsrMeta(bee);
        rows.push({
          bee,
          live: observation.live,
          state: observation.state ?? null,
          tier: meta?.tier ?? null,
          sessionId: meta?.sessionId ?? null,
          status: meta?.status ?? null,
          controlSocket: meta?.controlSocket ?? null,
        });
      }
      return rows;
    }),

    send: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; text?: unknown; mode?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "send", {
        text: String(p.text ?? ""),
        ...(p.mode === "next-tool" ? { mode: "next-tool" } : {}),
      });
      return result.ok ? { ok: true } : result;
    }),

    interrupt: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "interrupt");
      return result.ok ? { ok: true, result: result.result } : result;
    }),

    answer: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; requestId?: unknown; answer?: unknown };
      const bee = String(p.bee ?? "");
      let requestId = typeof p.requestId === "string" && p.requestId ? p.requestId : undefined;
      if (!requestId) {
        // No explicit id — resolve the request the bee is currently blocked on.
        const pending = await pendingNeedsInput(bee).catch(() => null);
        requestId = pending?.requestId;
      }
      const result = await proxyCall(bee, "answer", { requestId: requestId ?? "", answer: String(p.answer ?? "") });
      return result.ok ? { ok: true } : result;
    }),

    pendingInput: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      return pendingNeedsInput(String(p.bee ?? ""));
    }),

    stop: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const result = await proxyCall(String(p.bee ?? ""), "stop");
      return result.ok ? { ok: true, result: result.result } : result;
    }),

    snapshot: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown; lines?: unknown };
      const args = typeof p.lines === "number" ? { lines: p.lines } : {};
      return await proxyCall(String(p.bee ?? ""), "snapshot", args);
    }),

    // Establish (or ref-count into) a relay of the bee's live event stream. Each
    // `event` notification the bee's control socket pushes is re-broadcast to
    // ALL aggregate clients as `hsr.event` { bee, event }.
    observe: guarded(async (params) => {
      const p = (params ?? {}) as { bee?: unknown };
      const bee = String(p.bee ?? "");
      if (!bee) return { ok: false, error: "bee required" };
      const existing = relays.get(bee);
      if (existing) {
        existing.refCount += 1;
        return { ok: true };
      }
      const meta = await readHsrMeta(bee);
      if (!meta || meta.status !== "running" || !meta.controlSocket) {
        return { ok: false, error: `no live host for ${bee}` };
      }
      let client: RpcClient;
      try {
        client = await connectRpcClient(meta.controlSocket);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const unsubscribe = client.on("event", (event) => {
        try {
          server.broadcast("hsr.event", { bee, event });
        } catch {
          // A closing aggregate socket must not wedge the relay pump.
        }
      });
      relays.set(bee, { client, refCount: 1, unsubscribe });
      // Drop the cached relay when the bee's control socket closes (bee died).
      void client.closed.then(() => {
        const relay = relays.get(bee);
        if (relay && relay.client === client) relays.delete(bee);
      });
      return { ok: true };
    }),

    // spawn runs IN-PROCESS in the warm daemon: the whole CLI Node cold-start
    // (~100ms+) is off the critical path, and the spawn itself is resolve +
    // persist + fork (spawnBee no longer waits for the runner host either).
    // spawnSingleBee is the exact code path `hive spawn` runs, so account
    // aliases, profiles, yolo, and prompt delivery behave identically; the
    // command graph is imported lazily so daemon boot stays lean and no static
    // daemon↔commands cycle forms.
    spawn: guarded(async (params) => {
      const p = (params ?? {}) as {
        kind?: unknown;
        cwd?: unknown;
        model?: unknown;
        name?: unknown;
        yolo?: unknown;
        prompt?: unknown;
        flags?: unknown;
        rest?: unknown;
        env?: unknown;
      };
      const kind = String(p.kind ?? "");
      if (!kind) return { ok: false, error: "kind required" };
      const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
      const name = typeof p.name === "string" ? p.name : undefined;
      const model = typeof p.model === "string" ? p.model : undefined;
      const prompt = typeof p.prompt === "string" && p.prompt.trim().length > 0 ? p.prompt : undefined;
      const yolo = p.yolo === true;
      const { spawnSingleBee } = await import("../commands/spawn.js");
      // Generic passthrough for callers (Apiary) that speak full spawn flags —
      // `--account auto`, `--pool`, etc. — plus a harness-flag rest group. The
      // named params stay for simple callers and win over the passthrough.
      const flags = new Map<string, string | true | string[]>();
      if (p.flags && typeof p.flags === "object") {
        for (const [key, value] of Object.entries(p.flags as Record<string, unknown>)) {
          if (value === true) flags.set(key, true);
          else if (typeof value === "string") flags.set(key, value);
          else if (Array.isArray(value) && value.every((item) => typeof item === "string")) flags.set(key, value as string[]);
        }
      }
      flags.set("substrate", "hsr");
      if (name) flags.set("name", name);
      if (cwd) flags.set("cwd", cwd);
      if (yolo) flags.set("yolo", true);
      // H2 caller env: validate daemon-side (clear refusal), then ride the same
      // repeated --env flag the CLI accepts; spawn-side merge order re-applies
      // the denylist and identity stamps last.
      const envPairs = hsrSpawnEnvArgv(p.env).filter((word) => word !== "--env");
      if (envPairs.length > 0) flags.set("env", envPairs);
      const rest = Array.isArray(p.rest) && (p.rest as unknown[]).every((item) => typeof item === "string")
        ? [...(p.rest as string[])]
        : [];
      if (model) rest.push("--model", model);
      const record = await spawnSingleBee({
        command: "spawn",
        // A positional prompt rides the pending-turn queue (deliverHsrPrompt),
        // exactly like `hive spawn <kind> "<prompt>" --substrate hsr`.
        args: prompt ? [kind, prompt] : [kind],
        flags,
        rest,
      });
      return { ok: true, bee: record.name, ...(record.id ? { id: record.id } : {}) };
    }),
  };

  server = await startRpcServer({ socketPath, methods });

  return {
    path: server.path,
    async close(): Promise<void> {
      for (const relay of relays.values()) {
        try {
          relay.unsubscribe();
          relay.client.close();
        } catch {
          // best-effort teardown
        }
      }
      relays.clear();
      await server.close();
    },
  };
}
