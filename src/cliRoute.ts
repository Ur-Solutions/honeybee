import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Legacy-only verbs that remain reachable after the v2 freeze flip. */
const V1_VERBS_KEPT_WHEN_FROZEN = new Set(["deploy", "__complete"]);

/**
 * Keep the freeze check in a dependency-light module: the installed CLI
 * bootstrap imports this before choosing either the v2 or legacy graph.
 */
export function v2IsDefault(argv0: string | undefined): boolean {
  if (argv0 !== undefined && V1_VERBS_KEPT_WHEN_FROZEN.has(argv0)) return false;
  const root = process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive");
  return existsSync(join(root, "FROZEN"));
}
