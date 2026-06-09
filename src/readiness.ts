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

    if (isMcpWarningPane(recentPane(pane))) {
      throw new AgentReadinessError("blocked", `Agent startup is blocked by an MCP warning in ${record.name}`, pane);
    }

    if (isTrustPromptPane(recentPane(pane))) {
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

// Detects an interactive permission/approval prompt that has halted the agent
// mid-task waiting for a human decision — distinct from the one-time startup
// trust prompt (isTrustPromptPane). Anchored on Claude Code's approval UI
// ("Do you want to proceed?", edit/command confirmations, and the very stable
// "tell Claude what to do differently" reject option). Scoped to the pane tail
// so a resolved-and-scrolled-away prompt does not keep a bee marked blocked.
export function isPermissionPromptPane(pane: string): boolean {
  const recent = recentPane(pane);
  return (
    /tell Claude what to do differently/i.test(recent) ||
    /Do you want to (?:proceed|make this edit|create|run|apply|continue)\b/i.test(recent) ||
    /Would you like to proceed\?/i.test(recent)
  );
}

export function isAgentReadyPane(agent: string, pane: string): boolean {
  const recent = recentPane(pane);
  if (isTrustPromptPane(recent) || isMcpWarningPane(recent) || isPermissionPromptPane(recent)) return false;
  return isDriverReady(agent, pane);
}

// A trust/safety/MCP prompt only needs handling while it is the *current*
// interaction at the bottom of the pane. Some agents (notably codex) print the
// trust prompt in the normal screen buffer and then switch to an alternate
// screen for their main UI, stranding the prompt text up in scrollback. Scoping
// these checks to the tail keeps stale prompt text from masking a ready agent.
const RECENT_PROMPT_LINES = 15;

function recentPane(pane: string): string {
  return pane.trimEnd().split("\n").slice(-RECENT_PROMPT_LINES).join("\n");
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
