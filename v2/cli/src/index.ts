/**
 * Honeybee v2 CLI (WP4 of the reset) — thin RPC client over the daemon.
 * Spec: docs/design/specs/reset-04-daemon.md. Zero imports from old code
 * (the old CLI routes `hive v2 …` here; never the other way).
 */
export { runV2Cli, serviceExecArgs, serviceLabel, type CliIo } from "./main.ts";
export { DaemonDownError, RpcClient } from "./client.ts";
export { ReadOnlyStore, type StaleViewResult } from "./readonly.ts";
