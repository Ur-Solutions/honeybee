/**
 * Foreground daemon entry: `hive v2 daemon run [--data-dir d] [--config p]
 * [--socket s]`. This is what the rendered launchd plist / systemd unit
 * executes; it runs until SIGTERM/SIGINT and then shuts down cleanly
 * (children survive — the next boot re-adopts them).
 */
import { defaultDataDir, loadNodeConfig, type ResolvedNodeConfig } from "./config.ts";
import { HiveDaemon } from "./daemon.ts";

export interface DaemonRunArgs {
  dataDir?: string;
  configPath?: string;
  socketPath?: string;
}

export function parseDaemonRunArgs(argv: string[]): DaemonRunArgs {
  const out: DaemonRunArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a === "--config") out.configPath = argv[++i];
    else if (a === "--socket") out.socketPath = argv[++i];
    else throw new Error(`daemon run: unknown argument '${a}'`);
  }
  return out;
}

export function resolveDaemonConfig(args: DaemonRunArgs): ResolvedNodeConfig {
  const dataDir = args.dataDir ?? defaultDataDir();
  const cfg = loadNodeConfig(dataDir, args.configPath);
  return args.socketPath ? { ...cfg, socketPath: args.socketPath } : cfg;
}

/** Run the daemon in the foreground until a termination signal. */
export async function runDaemon(argv: string[]): Promise<number> {
  const cfg = resolveDaemonConfig(parseDaemonRunArgs(argv));
  const daemon = new HiveDaemon(cfg);
  await daemon.start();
  process.stdout.write(`hived v2 listening on ${cfg.socketPath} (store ${cfg.storePath})\n`);
  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      void daemon.shutdown().then(resolve);
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  });
  return 0;
}
