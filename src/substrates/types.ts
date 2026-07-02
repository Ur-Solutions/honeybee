export type SubstrateKind = "local-tmux" | "ssh-tmux" | "hsr";

export const LOCAL_NODE = "local";

export type TmuxWindowOptions = Partial<Record<"allow-passthrough", "on" | "off" | "all">>;

export type LaunchSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  tmuxOptions?: TmuxWindowOptions;
};

export type ProbeResult = { ok: true } | { ok: false; reason: string };

/** newSession returns the pane id so spawn can pin the bee, plus local launcher metadata when available. */
export type NewSessionResult = { paneId: string; launcherPgid?: number };

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
  newSession(target: string, cwd: string, spec: LaunchSpec): Promise<NewSessionResult>;
  /**
   * Create an adjacent pane in an existing comb and launch `spec` in it.
   * Returns the newly created pane id, so the sub-bee can be pinned to it.
   * - dir:"h"|"v" (default "v") => `split-window` in the comb's active window
   * - dir:"window" => `new-window` instead
   * (fork-and-pane Phase B — see §6.3)
   */
  newPane(target: string, cwd: string, spec: LaunchSpec, opts?: { dir?: "h" | "v" | "window" }): Promise<NewSessionResult>;
  kill(target: string, options?: { launcherPgid?: number }): Promise<KillResult>;
  /**
   * Kill just one bee's pane without taking down the whole comb/session.
   * `tmux kill-pane -t %id`. (Phase B — see §6.3)
   */
  killPane(paneId: string, options?: { launcherPgid?: number }): Promise<KillResult>;
  // Pane-scoped I/O: when paneId (e.g. "%7") is given, target that exact pane;
  // otherwise fall back to "=name:" (the session's active pane) for legacy
  // bees that were never pinned. This is the fix for I/O following the wrong
  // pane after a window is split.
  capture(target: string, lines?: number, paneId?: string): Promise<string>;
  sendText(target: string, text: string, paneId?: string): Promise<void>;
  sendEnter(target: string, paneId?: string): Promise<void>;
  sendKey(target: string, key: string, paneId?: string): Promise<void>;
  listSessions(): Promise<string[]>;
  /** Server-wide set of live pane ids (e.g. "%7") — pane-pinned liveness. */
  listPanes(): Promise<Set<string>>;
  /**
   * One list-sessions call: live session name → its @hive_state user option
   * (empty string when unset). Returns an empty map when the server is down.
   */
  listSessionStates(): Promise<Map<string, string>>;
  /**
   * Best-effort write of tmux session user options (@key value). A missing
   * session or server must never break the caller — failures are swallowed.
   */
  setUserOptions(target: string, options: Record<string, string>): Promise<void>;
  setWindowOptions(target: string, options: TmuxWindowOptions | undefined, paneId?: string): Promise<void>;
  /**
   * Best-effort rename of the session's active window (what choose-tree,
   * window strips, and views display). Never throws.
   */
  renameWindow(target: string, name: string): Promise<void>;
  attachCommand(target: string): string[];
  attachSession(target: string): Promise<void>;
};
