// Barrel for the transcripts package. The implementation lives in
// transcripts/: per-provider TranscriptAdapters ({claude,codex,opencode,grok}.ts)
// driven by one shared scan loop (index.ts), plus scoring.ts, cache.ts and
// text.ts. Kept so existing `./transcripts.js` imports work unchanged.
export * from "./transcripts/index.js";
export { hasTranscriptProvider } from "./drivers.js";
