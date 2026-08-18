/**
 * Honeybee v2 harness adapters (WP3 of the reset).
 * Spec: docs/design/specs/reset-03-hsr-driver.md. Zero imports from old code.
 */
export * from "./types.ts";
export { claudeAdapter, claudeResumeArgs, parseClaudeLine, encodeClaudeMessage } from "./claude.ts";
export { codexAdapter, codexRateLimitSignals, codexThreadRequest, type CodexAdapterOptions } from "./codex.ts";
export { stubAdapter, parseStubLine } from "./stub.ts";
export {
  composeArgv,
  parseArgUnits,
  dedupeUnits,
  claudeArgGrammar,
  codexArgGrammar,
  codexSpawnPlan,
  type ArgGrammar,
  type ArgUnit,
} from "./args.ts";
