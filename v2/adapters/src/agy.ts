/**
 * agy print-mode adapter. agy emits NDJSON on stdout and accepts one NDJSON
 * user envelope per turn on stdin. The protocol was captured from agy 1.1.24
 * on 2026-09-02; unknown events remain replayable log noise.
 */
import {
  asObject,
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  parseJsonLine,
  successfulTurnClears,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
} from "./types.ts";

function resultSignals(resultValue: unknown): AdapterSignal[] {
  const result = asObject(resultValue);
  if (!result || typeof result.status !== "string") return [];

  if (result.status === "SUCCESS") {
    return [...successfulTurnClears(), { kind: "turn_ended" }];
  }

  if (result.status === "ERROR") {
    const message = typeof result.error === "string"
      ? result.error
      : typeof result.response === "string" && result.response.length > 0
        ? result.response
        : "agy result error";
    const hasConversation = typeof result.conversation_id === "string" && result.conversation_id.length > 0;
    const signals: AdapterSignal[] = hasConversation
      ? []
      : [
          { kind: "booted" },
          { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
        ];
    if (isAuthNeededMessage(message)) {
      signals.push({ kind: "flag", flag: "auth_needed", action: "set", detail: message.slice(0, 500) });
    } else if (isResourceBlockedMessage(message)) {
      signals.push({ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) });
    }
    signals.push({ kind: "turn_ended" });
    return signals;
  }

  // CANCELED is a normal terminal result. In request-review mode, a queued
  // next message can cancel a tool approval without crashing the process.
  return [{ kind: "turn_ended" }];
}

export function parseAgyLine(line: string): AdapterSignal[] {
  const message = parseJsonLine(line);
  if (!message || typeof message.event !== "string") return [];

  switch (message.event) {
    case "init": {
      const sessionId = typeof message.conversation_id === "string" && message.conversation_id.length > 0
        ? message.conversation_id
        : undefined;
      return bootedToIdle(sessionId);
    }
    case "step_update": {
      const update = asObject(message.step_update);
      return update?.step_type === "agent_response" ? [{ kind: "turn_started" }] : [];
    }
    case "result":
      return resultSignals(message.result);
    default:
      return [];
  }
}

/** One stream-json input line in the shape accepted by agy 1.1.24. */
export function encodeAgyMessage(body: string): string {
  return JSON.stringify({
    event: "user",
    message: { content: [{ type: "text", text: body }] },
  });
}

export function agyResumeArgs(providerSessionId: string): string[] {
  return ["--conversation", providerSessionId];
}

export const agyAdapter: HarnessAdapter = {
  harness: "agy",
  acceptsMidTurn: false,
  confirmsDelivery: false,
  readyAtSpawn: false,
  bootLines(): string[] {
    return [];
  },
  parseLine: parseAgyLine,
  encodeMessage(body: string, _ctx: EncodeContext): string | null {
    return encodeAgyMessage(body);
  },
  resumeArgs: agyResumeArgs,
};
