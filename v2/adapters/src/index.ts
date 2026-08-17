/**
 * Honeybee v2 harness adapters (WP3 of the reset).
 * Spec: docs/design/specs/reset-03-hsr-driver.md. Zero imports from old code.
 */
export * from "./types.ts";
export { claudeAdapter, parseClaudeLine, encodeClaudeMessage } from "./claude.ts";
export { codexAdapter, codexRateLimitSignals, type CodexAdapterOptions } from "./codex.ts";
export { stubAdapter, parseStubLine } from "./stub.ts";
