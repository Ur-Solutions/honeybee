import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Assert that `command` resolves to an executable — either an explicit path or
 * a name found on PATH. Catches typo'd agent commands before we create a tmux
 * session that would die instantly while leaving a "running" record behind.
 *
 * Shared by the flow spawn path (agents.ts); cli.ts carries its own copy for
 * now and will be converged onto this module later.
 */
export async function assertExecutableAvailable(command: string): Promise<void> {
  const candidates = command.includes("/") ? [command] : (process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => resolve(dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return;
    } catch {
      // keep looking
    }
  }
  throw new Error(`Executable not found on PATH: ${command}`);
}
