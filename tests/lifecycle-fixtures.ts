import type { BeeLifecycleState, BeeStateMachineCursor } from "../src/stateMachine.js";

/** A schema-valid cursor for mixed-version lifecycle-reader regressions. */
export function lifecycleCursor(
  name: string,
  lifecycle: BeeLifecycleState,
  at: string,
): BeeStateMachineCursor {
  const eventId = `lifecycle-${name}`;
  if (lifecycle === "active") {
    return {
      lifecycle,
      runtime: "live",
      work: "working",
      revision: 1,
      transitionedAt: at,
      lastEventId: eventId,
      lastTransition: {
        eventId,
        type: "turn.started",
        cause: "first-turn",
        at,
        evidence: [{ kind: "hook", hookId: eventId, observedAt: at, hook: "turn-start" }],
      },
    };
  }
  return {
    lifecycle,
    runtime: "parked",
    work: "done",
    revision: 1,
    transitionedAt: at,
    lastEventId: eventId,
    lastTransition: {
      eventId,
      type: "bee.archived",
      cause: "retire",
      at,
      evidence: [
        { kind: "operator", actionId: eventId, observedAt: at, action: "retire" },
        {
          kind: "probe",
          probeId: eventId,
          observerId: "lifecycle-fixture",
          observedAt: at,
          outcome: "dead",
          target: { substrate: "hsr", tmuxTarget: name },
        },
      ],
    },
  };
}
