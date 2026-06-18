import { hasAgentDriver, isDriverActive, isDriverReady } from "./drivers.js";
import type { SessionRecord } from "./store.js";
import { substrateFor, type Substrate } from "./substrates/index.js";

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
  /** Substrate override (used by tests); defaults to substrateFor(record). */
  substrate?: Pick<Substrate, "capture" | "sendEnter" | "sendKey">;
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
  const substrate = options.substrate ?? substrateFor(record);

  while (Date.now() < deadline) {
    const pane = await substrate.capture(record.tmuxTarget, 100, record.agentPaneId).catch(() => "");
    lastPane = pane;

    if (isMcpWarningPane(pane)) {
      throw new AgentReadinessError("blocked", `Agent startup is blocked by an MCP warning in ${record.name}`, pane);
    }

    const bypass = isBypassPermissionsPane(pane);
    const trust = !bypass && isTrustPromptPane(pane);
    if (bypass || trust) {
      if (!acceptTrust) {
        throw new AgentReadinessError("trust", `Agent startup is waiting for a trust/safety confirmation in ${record.name}; rerun without --no-accept-trust to acknowledge it`, pane);
      }
      if (trustAttempts < 3) {
        if (bypass) {
          // claude's bypass-permissions dialog defaults its selector to
          // "1. No, exit", so a bare Enter would KILL the bee. The digit key
          // jumps straight to and confirms "2. Yes, I accept".
          await substrate.sendKey(record.tmuxTarget, "2", record.agentPaneId);
        } else {
          // The directory-trust prompt pre-selects the affirmative option, so
          // Enter accepts it.
          await substrate.sendEnter(record.tmuxTarget, record.agentPaneId);
        }
        trustAttempts += 1;
        deadline = Math.max(deadline, Date.now() + grace);
        await sleep(1000);
        continue;
      }
      // Three attempts didn't clear it — keep polling but stop sending keys.
    }

    if (record.agent === "droid" && options.raiseDroidAutonomy && shouldRaiseDroidAutonomy(pane) && droidYoloCycles < 4) {
      await substrate.sendKey(record.tmuxTarget, "C-l", record.agentPaneId);
      droidYoloCycles += 1;
      await sleep(700);
      continue;
    }

    if (isAgentReadyPane(record.agent, pane)) return;

    await sleep(500);
  }

  // A startup confirmation (directory-trust or bypass-permissions) that
  // survived the attempts is not a generic timeout: callers honor --force-send
  // for "timeout" and would type the prompt text straight into the dialog.
  if (isStartupConfirmationPane(lastPane)) {
    throw new AgentReadinessError(
      "trust",
      `Startup confirmation in ${record.name} did not clear after ${trustAttempts} attempt(s); attach and resolve it manually: hive attach ${record.name}`,
      lastPane,
    );
  }

  throw new AgentReadinessError("timeout", `Timed out waiting for ${record.agent} to become ready in ${record.name}`, lastPane);
}

// Tail-scoped by construction (see recentPane): an answered trust prompt can
// linger in scrollback for the whole life of the pane and must not keep
// reporting the bee as blocked.
export function isTrustPromptPane(pane: string): boolean {
  return /Do you trust the contents of this directory|Quick safety check: Is this a project|trust .*directory|(?:trust|safety|directory)[\s\S]{0,120}Enter to confirm/i.test(recentPane(pane));
}

// claude launched with --dangerously-skip-permissions shows a one-time "Bypass
// Permissions mode" acceptance dialog ("❯ 2. Yes, I accept" pre-selected) when
// the config dir has not recorded acceptance. Activated account homes are
// re-stamped from the vault on every spawn, so the flag never persists and the
// dialog reappears each launch — without auto-accept the bee sits here until
// the boot-ms timeout. Required "Yes, I accept" keeps this off the steady-state
// "bypass permissions on" footer of an already-ready pane. Tail-scoped so a
// dismissed dialog in scrollback does not keep reporting the bee as blocked.
export function isBypassPermissionsPane(pane: string): boolean {
  const recent = recentPane(pane);
  return /Bypass Permissions mode/i.test(recent) && /\bYes, I accept\b/i.test(recent);
}

// Startup confirmations the readiness loop auto-accepts with Enter: the
// directory-trust prompt and claude's bypass-permissions warning.
export function isStartupConfirmationPane(pane: string): boolean {
  return isTrustPromptPane(pane) || isBypassPermissionsPane(pane);
}

export function isMcpWarningPane(pane: string): boolean {
  return /MCP server found/i.test(recentPane(pane));
}

export function shouldRaiseDroidAutonomy(pane: string): boolean {
  return /Auto \((?:Off|Low|Med)\)/i.test(pane);
}

// Detects an interactive permission/approval prompt that has halted the agent
// mid-task waiting for a human decision — distinct from the one-time startup
// trust prompt (isTrustPromptPane). The real approval UI always renders a
// numbered option list ("❯ 1. Yes" / "2. No..."), so that shape is required:
// question prose alone matches ordinary assistant questions sitting at the
// pane bottom and must not flag the bee as blocked. Scoped to the pane tail
// so a resolved-and-scrolled-away prompt does not keep a bee marked blocked.
export function isPermissionPromptPane(pane: string): boolean {
  const recent = recentPane(pane);
  if (!hasApprovalOptionList(recent)) return false;
  return (
    /tell Claude what to do differently/i.test(recent) ||
    /Do you want to (?:proceed|make this edit|create|run|apply|continue)\b/i.test(recent) ||
    /Would you like to proceed\?/i.test(recent)
  );
}

function hasApprovalOptionList(recent: string): boolean {
  // A selected numbered option ("❯ 1. Yes") is the strongest signal; fall
  // back to two numbered options for captures that lose the selector glyph.
  return /(?:^|\n)\s*[❯›>]\s*\d+\.\s+\S/.test(recent) || (/(?:^|\n)\s*1\.\s+\S/.test(recent) && /(?:^|\n)\s*2\.\s+\S/.test(recent));
}

export function isAgentReadyPane(agent: string, pane: string): boolean {
  if (isStartupConfirmationPane(pane) || isMcpWarningPane(pane) || isPermissionPromptPane(pane)) return false;
  return isDriverReady(agent, pane);
}

export function isAgentActivePane(agent: string, pane: string): boolean {
  if (isStartupConfirmationPane(pane) || isMcpWarningPane(pane) || isPermissionPromptPane(pane)) return false;
  return isDriverActive(agent, recentPane(pane));
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
