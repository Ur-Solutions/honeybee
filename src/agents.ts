export type AgentKind = "claude" | "codex" | "opencode" | "pi" | "droid" | string;

export type AgentSpec = {
  kind: AgentKind;
  command: string;
  args: string[];
};

const DEFAULT_COMMANDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
  droid: "droid",
};

export function resolveAgent(kind: AgentKind, extraArgs: string[] = []): AgentSpec {
  const envKey = `AP_${kind.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CMD`;
  const configured = process.env[envKey] ?? DEFAULT_COMMANDS[kind] ?? kind;
  const parts = splitShellWords(configured);
  if (parts.length === 0) throw new Error(`Empty command for agent ${kind}`);
  return {
    kind,
    command: parts[0]!,
    args: [...parts.slice(1), ...extraArgs],
  };
}

export function shellCommand(spec: AgentSpec): string {
  return [spec.command, ...spec.args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Small shell-ish splitter for env command overrides. Not a full shell parser;
// enough for quoted binary paths/flags without executing arbitrary expansion.
function splitShellWords(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of input.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && quote === null) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(ch) && quote === null) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  if (quote) throw new Error(`Unclosed quote in command: ${input}`);
  if (escaping) current += "\\";
  if (current) out.push(current);
  return out;
}
