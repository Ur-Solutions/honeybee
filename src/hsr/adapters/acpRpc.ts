/** Bidirectional NDJSON JSON-RPC 2.0 transport used by ACP runners. */
import type { Readable, Writable } from "node:stream";
import { makeLineReader } from "../lineReader.js";

export type AcpRpcId = string | number;
export const ACP_RPC_METHOD_NOT_FOUND = -32601;
const ACP_RPC_INTERNAL_ERROR = -32603;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AcpRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  readonly method: string;

  constructor(method: string, message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export class AcpRpcRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`ACP request ${method} timed out after ${timeoutMs}ms`);
    this.name = "AcpRpcRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
  method: string;
};

export type AcpRpcPeer = {
  /** `timeoutMs: 0` disables the timeout for a long-running prompt request. */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  onNotificationCatchAll(handler: (method: string, params: unknown) => void): void;
  onServerRequest(handler: (method: string, id: AcpRpcId, params: unknown) => void): void;
  respond(id: AcpRpcId, result: unknown): void;
  respondError(id: AcpRpcId, code: number, message: string): void;
  dispose(error?: Error): void;
};

export function createAcpRpcPeer(stdin: Writable, stdout: Readable): AcpRpcPeer {
  const pending = new Map<number, Pending>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  let notificationCatchAll: ((method: string, params: unknown) => void) | undefined;
  let serverRequestHandler: ((method: string, id: AcpRpcId, params: unknown) => void) | undefined;
  let nextId = 1;
  let disposed = false;

  const write = (value: unknown): void => {
    if (disposed || !stdin.writable) return;
    try {
      stdin.write(`${JSON.stringify(value)}\n`);
    } catch {
      // Closing pipes can throw EPIPE synchronously. Child exit settles callers.
    }
  };

  function respondError(id: AcpRpcId, code: number, message: string): void {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  const dispose = (error = new Error("ACP peer disposed")): void => {
    if (disposed) return;
    disposed = true;
    for (const request of pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    const hasMethod = typeof message.method === "string";

    if (hasId && !hasMethod && ("result" in message || "error" in message)) {
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (request.timer) clearTimeout(request.timer);
      if (message.error) {
        const rpcError = message.error as { code?: unknown; message?: unknown; data?: unknown };
        request.reject(new AcpRpcError(
          request.method,
          typeof rpcError.message === "string" ? rpcError.message : `ACP request ${request.method} failed`,
          typeof rpcError.code === "number" ? rpcError.code : undefined,
          rpcError.data,
        ));
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (hasId && hasMethod) {
      if (!serverRequestHandler) {
        respondError(message.id as AcpRpcId, ACP_RPC_METHOD_NOT_FOUND, "no ACP server-request handler");
        return;
      }
      try {
        serverRequestHandler(message.method as string, message.id as AcpRpcId, message.params);
      } catch {
        respondError(message.id as AcpRpcId, ACP_RPC_INTERNAL_ERROR, "ACP server-request handler failed");
      }
      return;
    }

    if (hasMethod) {
      const method = message.method as string;
      const handler = notificationHandlers.get(method);
      if (handler) handler(message.params);
      else notificationCatchAll?.(method, message.params);
    }
  };

  stdout.on("data", makeLineReader(handleLine));
  stdin.on("error", (error) => dispose(error));
  stdout.on("error", (error) => dispose(error));
  stdout.on("end", () => dispose(new Error("ACP peer stdout ended")));

  return {
    request(method, params, opts): Promise<unknown> {
      if (disposed) return Promise.reject(new Error("ACP peer disposed"));
      if (!stdin.writable) return Promise.reject(new Error(`ACP request ${method} failed: child stdin is not writable`));
      const id = nextId++;
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const request: Pending = { resolve, reject, method };
        if (timeoutMs > 0) {
          request.timer = setTimeout(() => {
            pending.delete(id);
            reject(new AcpRpcRequestTimeoutError(method, timeoutMs));
          }, timeoutMs);
          request.timer.unref?.();
        }
        pending.set(id, request);
        write(params === undefined
          ? { jsonrpc: "2.0", id, method }
          : { jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params): void {
      write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
    },
    onNotification(method, handler): () => void {
      notificationHandlers.set(method, handler);
      return () => {
        if (notificationHandlers.get(method) === handler) notificationHandlers.delete(method);
      };
    },
    onNotificationCatchAll(handler): void {
      notificationCatchAll = handler;
    },
    onServerRequest(handler): void {
      serverRequestHandler = handler;
    },
    respond(id, result): void {
      write({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    },
    respondError,
    dispose,
  };
}
