#!/usr/bin/env node
/** Standalone v2 CLI executable (tests; production goes through `hive v2 …`). */
import { runV2Cli } from "./main.ts";

process.exitCode = await runV2Cli(process.argv.slice(2));
