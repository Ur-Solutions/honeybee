#!/usr/bin/env node
// Fast entrypoint for Apiary's hot path: `hive-x <bee> <prompt> ...`.
// It maps directly onto the authoritative `hive x` command implementation
// without importing the full top-level CLI command graph.
import { cmdX } from "./commands/run.js";
import { dim, errorPrefix } from "./format.js";
import { parse } from "./parse.js";
import { closeAllSubstrates } from "./substrates/index.js";

async function main(argv: string[]) {
  const parsed = parse(["x", ...argv]);
  try {
    await cmdX(parsed);
  } finally {
    // Keep one-shot remote substrate probes from holding the event loop open,
    // matching the full CLI's best-effort cleanup contract.
    await closeAllSubstrates();
  }
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const [first, ...rest] = message.split("\n");
  console.error(`${errorPrefix()} ${first}`);
  for (const line of rest) console.error(dim(line));
  process.exitCode = 1;
});
