export type SubstrateKind = "local-tmux" | "ssh-tmux";

export const LOCAL_NODE = "local";

export type LaunchSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type ProbeResult = { ok: true } | { ok: false; reason: string };

export type KillResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type Substrate = {
  readonly kind: SubstrateKind;
  readonly node: string;
  readonly endpoint?: string;
  probe(): Promise<ProbeResult>;
  hasSession(target: string): Promise<boolean>;
  newSession(target: string, cwd: string, spec: LaunchSpec): Promise<void>;
  kill(target: string): Promise<KillResult>;
  capture(target: string, lines?: number): Promise<string>;
  sendText(target: string, text: string): Promise<void>;
  sendEnter(target: string): Promise<void>;
  sendKey(target: string, key: string): Promise<void>;
  listSessions(): Promise<string[]>;
  attachCommand(target: string): string[];
  attachSession(target: string): Promise<void>;
};
