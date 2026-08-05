// Execution-protocol methods on the daemon's aggregate control socket.
//
// Registers the corpus method names (protocol.hello, node.describe,
// run.start, run.get, run.events) beside the legacy HSR methods without
// touching legacy behavior: legacy callers never negotiate; protocol callers
// must hello first on every connection (RFC §6). The gate fails closed:
//   - any protocol method before hello  -> PROTOCOL_INCOMPATIBLE;
//   - the mutation method (run.start) after an incompatible hello ->
//     PROTOCOL_INCOMPATIBLE (reads stay available for honest discovery).
//
// Effect methods answer with the execution-response-envelope; non-effect
// methods answer with their response document, or `{ error }` carrying the
// typed corpus error.
import type { RpcConnectionCtx, RpcMethodHandler } from "../hsr/rpc.js";
import { ExecutionProtocolError, toWireError } from "./errors.js";
import type { ExecutionService } from "./service.js";

type ConnectionNegotiation = { compatibility: "ready" | "incompatible" | "degraded" };

export type ExecutionRpcMethods = {
  methods: Record<string, RpcMethodHandler>;
  /** Call from the transport's connection-close hook to drop negotiation state. */
  onDisconnect(ctx: RpcConnectionCtx): void;
};

export function createExecutionRpcMethods(service: () => ExecutionService | Promise<ExecutionService>): ExecutionRpcMethods {
  const negotiated = new Map<number, ConnectionNegotiation>();
  let servicePromise: Promise<ExecutionService> | undefined;
  const resolveService = (): Promise<ExecutionService> => (servicePromise ??= Promise.resolve(service()));

  const gate = (ctx: RpcConnectionCtx, mutation: boolean): void => {
    const state = negotiated.get(ctx.connectionId);
    if (!state) {
      throw new ExecutionProtocolError("PROTOCOL_INCOMPATIBLE", "protocol.hello is required before any other method on a connection");
    }
    if (mutation && state.compatibility === "incompatible") {
      throw new ExecutionProtocolError("PROTOCOL_INCOMPATIBLE", "mutation methods are refused on an incompatible connection");
    }
  };

  /**
   * Every method with effects shares one shape: the mutation gate refuses an
   * un-negotiated or incompatible connection with an envelope-shaped typed
   * error; a gated call otherwise answers with the service's response
   * envelope (receipt + result, or typed error).
   */
  const effectMethod =
    (select: (svc: ExecutionService) => (request: never) => Promise<unknown>): RpcMethodHandler =>
    async (params, ctx) => {
      const svc = await resolveService();
      try {
        gate(ctx, true);
      } catch (error) {
        const requestId = (params as { requestId?: unknown } | null)?.requestId;
        return { protocolVersion: svc.protocolVersion, requestId: String(requestId ?? ""), error: toWireError(error) };
      }
      return select(svc)(params as never);
    };

  const methods: Record<string, RpcMethodHandler> = {
    "protocol.hello": async (params, ctx) => {
      const svc = await resolveService();
      try {
        const result = svc.hello(params as never);
        negotiated.set(ctx.connectionId, { compatibility: result.compatibility });
        return result.response;
      } catch (error) {
        return { error: toWireError(error) };
      }
    },
    "node.describe": async (params, ctx) => {
      const svc = await resolveService();
      try {
        gate(ctx, false);
      } catch (error) {
        return { error: toWireError(error) };
      }
      const outcome = await svc.describe(params as never);
      return "error" in outcome ? outcome : outcome.result;
    },
    "run.start": effectMethod((svc) => svc.runStart),
    "run.command": effectMethod((svc) => svc.runCommand),
    "run.cancel": effectMethod((svc) => svc.runCancel),
    "run.collect": effectMethod((svc) => svc.runCollect),
    "run.retain": effectMethod((svc) => svc.runRetain),
    "run.release": effectMethod((svc) => svc.runRelease),
    "run.get": async (params, ctx) => {
      const svc = await resolveService();
      try {
        gate(ctx, false);
      } catch (error) {
        return { error: toWireError(error) };
      }
      const outcome = await svc.runGet(params as never);
      return "error" in outcome ? outcome : outcome.result;
    },
    "run.events": async (params, ctx) => {
      const svc = await resolveService();
      try {
        gate(ctx, false);
      } catch (error) {
        return { error: toWireError(error) };
      }
      const outcome = await svc.runEvents(params as never);
      return "error" in outcome ? outcome : outcome.result;
    },
  };

  return {
    methods,
    onDisconnect(ctx) {
      negotiated.delete(ctx.connectionId);
    },
  };
}
