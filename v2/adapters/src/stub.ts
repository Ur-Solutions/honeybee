/**
 * Stub harness adapter (WP3 test tier 2/3) — normalizes the stub agent
 * executable's jsonl protocol (v2/driver-hsr/test-agent/agent.mjs).
 *
 * The stub agent is a real child process speaking a trivial NDJSON protocol
 * with controllable behavior (slow boot, hang, crash mid-turn, clean exit,
 * auth-failure and rate-limit emission), so driver integration tests and the
 * `v2:harness:real` invariant gate run against real OS processes without any
 * agent CLI, tokens or credentials.
 *
 * Protocol (agent stdout → us):
 *   {"event":"ready","sessionId":"..."}                  once, after boot
 *   {"event":"turn_started","messageId":n}
 *   {"event":"text","text":"..."}                        mid-turn output
 *   {"event":"error","message":"..."}                    provider-ish error
 *   {"event":"rate_limited","status":"rejected","resetsAt":<unix s>}
 *   {"event":"turn_ended","messageId":n,"ok":true|false}
 * (us → agent stdin):
 *   {"type":"message","id":n,"body":"..."}
 */
import {
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  isoFromEpochSeconds,
  parseJsonLine,
  successfulTurnClears,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
} from "./types.ts";

export function parseStubLine(line: string): AdapterSignal[] {
  const msg = parseJsonLine(line);
  if (!msg || typeof msg.event !== "string") return [];
  switch (msg.event) {
    case "ready": {
      const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
      return bootedToIdle(sessionId);
    }
    case "turn_started":
      return [{ kind: "turn_started" }];
    case "turn_ended":
      // ok:false marks a turn that hit a provider boundary — a turn end, but
      // not contrary evidence for the flags the same turn just set.
      if (msg.ok === false) return [{ kind: "turn_ended" }];
      return [...successfulTurnClears(), { kind: "turn_ended" }];
    case "error": {
      const message = String(msg.message ?? "stub error");
      if (isAuthNeededMessage(message)) {
        return [{ kind: "flag", flag: "auth_needed", action: "set", detail: message }];
      }
      if (isResourceBlockedMessage(message)) {
        return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: message }];
      }
      return [];
    }
    case "rate_limited": {
      const status = typeof msg.status === "string" ? msg.status : "rejected";
      if (status.startsWith("allowed")) {
        return [{ kind: "flag", flag: "resource_blocked", action: "clear", detail: `stub rate limit ${status}` }];
      }
      const reset = isoFromEpochSeconds(msg.resetsAt);
      return [{
        kind: "flag",
        flag: "resource_blocked",
        action: "set",
        detail: `stub rate limit ${status}${reset ? `, resets ${reset}` : ""}`,
      }];
    }
    case "text":
      return [];
    default:
      return [];
  }
}

export const stubAdapter: HarnessAdapter = {
  harness: "stub",
  acceptsMidTurn: true, // the agent queues stdin lines and works them FIFO
  bootLines(): string[] {
    return [];
  },
  parseLine: parseStubLine,
  encodeMessage(body: string, ctx: EncodeContext): string | null {
    return JSON.stringify({ type: "message", id: ctx.messageId, body });
  },
};
