import { hasAgentDriver, isDriverReady } from "./drivers.js";
import type { SessionRecord } from "./store.js";
import { substrateFor } from "./substrates/index.js";

export type ReadinessFailureReason = "trust" | "blocked" | "timeout";

export class AgentReadinessError extends Error {
  constructor(
    readonly reason: ReadinessFailureReason,
    message: string,
    readonly pane: string,
  ) {
    super(pane.trim() ? `${message}\n${formatPaneExcerpt(pane)}` : message);
    this.name = "AgentReadinessError";
  }
}

export type WaitForAgentReadyOptions = {
  timeoutMs: number;
  acceptTrust?: boolean;
  raiseDroidAutonomy?: boolean;
  trustGraceMs?: number;
};

const DEFAULT_TRUST_GRACE_MS = 10_000;

export async function waitForAgentReady(record: SessionRecord, options: WaitForAgentReadyOptions): Promise<void> {
  if (!hasAgentDriver(record.agent)) return;

  const acceptTrust = options.acceptTrust !== false;
  const grace = options.trustGraceMs ?? DEFAULT_TRUST_GRACE_MS;
  const started = Date.now();
  let deadline = started + options.timeoutMs;
  let trustAttempts = 0;
  let droidYoloCycles = 0;
  let lastPane = "";
  const substrate = substrateFor(record);

  while (Date.now() < deadline) {
    const pane = await substrate.capture(record.tmuxTarget, 100).catch(() => "");
    lastPane = pane;

    if (isMcpWarningPane(pane)) {
      throw new AgentReadinessError("blocked", `Agent startup is blocked by an MCP warning in ${record.name}`, pane);
    }

    if (isTrustPromptPane(pane)) {
      if (!acceptTrust) {
        throw new AgentReadinessError("trust", `Agent startup is waiting for a trust/safety confirmation in ${record.name}; rerun without --no-accept-trust to acknowledge it`, pane);
      }
      if (trustAttempts < 3) {
        await substrate.sendEnter(record.tmuxTarget);
        trustAttempts += 1;
        deadline = Math.max(deadline, Date.now() + grace);
        await sleep(1000);
        continue;
      }
      // Three Enters didn't clear it — keep polling but don't loop sending Enter.
    }

    if (record.agent === "droid" && options.raiseDroidAutonomy && shouldRaiseDroidAutonomy(pane) && droidYoloCycles < 4) {
      await substrate.sendKey(record.tmuxTarget, "C-l");
      droidYoloCycles += 1;
      await sleep(700);
      continue;
    }

    if (isAgentReadyPane(record.agent, pane)) return;

    await sleep(500);
  }

  throw new AgentReadinessError("timeout", `Timed out waiting for ${record.agent} to become ready in ${record.name}`, lastPane);
}

export function isTrustPromptPane(pane: string): boolean {
  return /Do you trust the contents of this directory|Quick safety check: Is this a project|trust .*directory|(?:trust|safety|directory)[\s\S]{0,120}Enter to confirm/i.test(pane);
}

export function isMcpWarningPane(pane: string): boolean {
  return /MCP server found/i.test(pane);
}

export function shouldRaiseDroidAutonomy(pane: string): boolean {
  return /Auto \((?:Off|Low|Med)\)/i.test(pane);
}

export function isAgentReadyPane(agent: string, pane: string): boolean {
  if (isTrustPromptPane(pane) || isMcpWarningPane(pane)) return false;
  return isDriverReady(agent, pane);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPaneExcerpt(pane: string): string {
  return pane
    .trimEnd()
    .split("\n")
    .slice(-25)
    .map((line) => `pane: ${line}`)
    .join("\n");
}
