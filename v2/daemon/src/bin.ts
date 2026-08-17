#!/usr/bin/env node
/** Direct daemon executable (used by tests; production goes through `hive v2 daemon run`). */
import { runDaemon } from "./main.ts";

process.exitCode = await runDaemon(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  return 1;
});
