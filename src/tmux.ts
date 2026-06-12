// Backwards-compat shim. Phase 2 patch #2 moved every operation into
// src/substrates/local-tmux.ts as part of the Substrate abstraction. Existing
// imports from "./tmux.js" keep working; new code should prefer
// substrateFor(record) / localSubstrate() from "./substrates/index.js".
export {
  attachCommand,
  attachSession,
  capture,
  formatShellCommand,
  hasSession,
  kill,
  listSessionStates,
  listTmuxSessions,
  newSession,
  probe,
  renameWindow,
  sendEnter,
  sendKey,
  sendText,
  setUserOptions,
  tmux,
} from "./substrates/local-tmux.js";
export type { LaunchSpec } from "./substrates/local-tmux.js";
