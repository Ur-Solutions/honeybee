export type AgentDriver = {
  kind: string;
  homeEnv?: string;
  hasTranscriptProvider?: boolean;
  isReady?: (pane: string) => boolean;
};

const AGENT_DRIVERS: Record<string, AgentDriver> = {
  claude: {
    kind: "claude",
    homeEnv: "CLAUDE_CONFIG_DIR",
    hasTranscriptProvider: true,
    isReady: (pane) => /(?:^|\n)❯\s/.test(pane) || /Try "fix lint errors"|Try "create a util/i.test(pane),
  },
  codex: {
    kind: "codex",
    homeEnv: "CODEX_HOME",
    hasTranscriptProvider: true,
    isReady: (pane) => /(?:^|\n)[›>]\s/.test(pane) || /What can I help with|Ask Codex/i.test(pane),
  },
  opencode: {
    kind: "opencode",
    hasTranscriptProvider: true,
    isReady: (pane) => /Ask anything/i.test(pane),
  },
  grok: {
    kind: "grok",
    hasTranscriptProvider: true,
    isReady: (pane) => /Grok Build|(?:^|\n)\s*❯\s/.test(pane),
  },
  pi: {
    kind: "pi",
    isReady: (pane) => /Pi can explain its own features|(?:^|\n)>\s/.test(pane),
  },
  droid: {
    kind: "droid",
    isReady: (pane) => /TIP: Use \/settings|Welcome to Factory CLI/i.test(pane),
  },
};

export function agentDriver(kind: string): AgentDriver | undefined {
  return AGENT_DRIVERS[kind];
}

export function hasAgentDriver(kind: string): boolean {
  return agentDriver(kind) !== undefined;
}

export function homeEnvForAgent(kind: string): string | undefined {
  return agentDriver(kind)?.homeEnv;
}

export function hasTranscriptProvider(kind: string): boolean {
  return agentDriver(kind)?.hasTranscriptProvider === true;
}

export function isDriverReady(kind: string, pane: string): boolean {
  return (agentDriver(kind)?.isReady ?? genericReadyCheck)(pane);
}

function genericReadyCheck(pane: string): boolean {
  return /(?:^|\n)[❯›>]\s/.test(pane);
}
