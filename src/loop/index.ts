// Public barrel for the loop feature. The built-in flow registry imports
// `loopFlow` from here (dynamically, to avoid the flow/index ↔ loop/flow static
// cycle), and the CLI + facade import the state/config helpers.

export { loopFlow } from "./flow.js";
export {
  buildLoopConfig,
  coerceDuration,
  parseContextMode,
  type ContextKnobs,
} from "./context.js";
export {
  appendIterLog,
  ensureLoopDir,
  isStopRequested,
  listLoops,
  loopConfigPath,
  loopDir,
  loopHistoryLogPath,
  loopHistoryMdPath,
  loopIterLogPath,
  loopProgressPath,
  loopSealPath,
  loopStopRequestPath,
  loopsRoot,
  readLoopConfig,
  requestStop,
  updateLoopConfig,
  writeIterSeal,
  writeLoopConfig,
  type LoopCarrier,
  type LoopConfig,
  type LoopContextMode,
  type LoopMemory,
  type LoopStatus,
  type LoopStopConfig,
} from "./state.js";
export {
  buildIterationPrompt,
  foldForward,
  HISTORY_DIGEST_THRESHOLD,
  rederiveHistory,
} from "./summarizer.js";
export { runStopPredicate } from "./until.js";
