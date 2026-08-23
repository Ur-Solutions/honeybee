#!/usr/bin/env node
/**
 * Dependency-light installed entrypoint.
 *
 * A frozen node runs v2 for almost every command. Loading the complete legacy
 * command graph before making that decision adds seconds to every `hive ls`,
 * `hive --version`, and RPC command, so choose the graph first and import only
 * the selected implementation.
 */
import { v2IsDefault } from "./cliRoute.js";

type V2Module = {
  runV2Cli(argv: string[]): Promise<number>;
};

type LegacyModule = {
  legacyCliCompletion: Promise<void>;
};

async function loadV2(): Promise<V2Module> {
  const specifier = new URL("./v2/cli.js", import.meta.url).href;
  return (await import(specifier)) as V2Module;
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "v2") {
    process.exitCode = await (await loadV2()).runV2Cli(argv.slice(1));
    return;
  }
  if (v2IsDefault(argv[0])) {
    process.exitCode = await (await loadV2()).runV2Cli(argv);
    return;
  }

  // build-cli-entry.mjs preserves tsc's full dispatcher under this name.
  const specifier = new URL("./cli-legacy.js", import.meta.url).href;
  const legacy = (await import(specifier)) as LegacyModule;
  await legacy.legacyCliCompletion;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`hive: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
