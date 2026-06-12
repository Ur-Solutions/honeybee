/**
 * Centralized, nesting-safe attach argv construction.
 *
 * Every path that points a terminal at a bee's tmux session (attach, xa,
 * --print) builds its command here. The cardinal rule: a `tmux attach-session`
 * executed inside an existing tmux client is always a bug — inside tmux the
 * current client is repointed with `switch-client` (local bees) or the remote
 * attach is opened as a new window in the current session (remote bees).
 */

export type AttachTransport = {
  endpoint: string;
  /** ssh binary override (NodeRecord.sshCommand); defaults to "ssh". */
  sshBinary?: string;
  /** User-supplied ssh args (NodeRecord.sshArgs); no multiplexing defaults here. */
  sshArgs?: string[];
};

export type AttachContext = {
  sessionName: string;
  /** Whether the calling process runs inside a tmux client ($TMUX set). */
  insideTmux: boolean;
  /** Remote transport for ssh-tmux bees; absent for the local server. */
  remote?: AttachTransport;
};

/**
 * Session names and endpoints come from the store/node registry (already
 * sanitized at spawn/register time), but the remote-inside-tmux branch embeds
 * them in a tmux window command string — validate them again at the boundary.
 */
const SAFE_TOKEN = /^[\w.@:-]+$/;

export function buildAttachArgv(context: AttachContext): string[] {
  const { sessionName, insideTmux, remote } = context;
  // "=" pins tmux to an exact session name; without it tmux prefix-matching
  // could attach a different session (e.g. CL-abcd when CL-abc is gone).
  const exact = `=${sessionName}`;

  if (!remote) {
    return insideTmux
      ? ["tmux", "switch-client", "-t", exact]
      : ["tmux", "attach-session", "-t", exact];
  }

  const sshArgv = [
    remote.sshBinary ?? "ssh",
    "-t",
    ...(remote.sshArgs ?? []),
    remote.endpoint,
    ...["tmux", "attach-session", "-t", exact].map(shellQuote),
  ];

  if (!insideTmux) return sshArgv;

  // Inside tmux a remote bee cannot be switch-client'ed to (different server);
  // open the ssh attach as a new window in the caller's current session. The
  // window command is one shell string, so the embedded tokens must be inert.
  if (!SAFE_TOKEN.test(sessionName)) {
    throw new Error(`Refusing to embed unsafe session name in a tmux window command: ${sessionName}`);
  }
  if (!SAFE_TOKEN.test(remote.endpoint)) {
    throw new Error(`Refusing to embed unsafe endpoint in a tmux window command: ${remote.endpoint}`);
  }
  return ["tmux", "new-window", "-n", sessionName, sshArgv.map(shellQuote).join(" ")];
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
