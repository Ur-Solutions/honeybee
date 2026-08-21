// Direct entry for tests and the `hive v2 runner-host` CLI verb:
//   node --experimental-strip-types runner-host-main.ts <configPath>
import { runRunnerHost } from "./runner-host.ts";

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("usage: runner-host <configPath>\n");
  process.exit(2);
}
runRunnerHost(configPath);
