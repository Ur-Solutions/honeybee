/**
 * Honeybee v2 daemon (WP4 of the reset).
 * Spec: docs/design/specs/reset-04-daemon.md. Zero imports from old code.
 */
export {
  DaemonCore,
  ExecutorCrashError,
  type BootReport,
  type DaemonCoreOptions,
  type DaemonPolicy,
  type ExecutorCrashPoint,
  type FaultHooks,
  type FlagEvidenceLike,
  type I1ViolationEvent,
} from "./loops.ts";
export {
  BUILTIN_AGENTS,
  ConfigError,
  DEFAULTS,
  defaultDataDir,
  loadNodeConfig,
  type AgentSpecConfig,
  type NodeConfigFile,
  type ResolvedNodeConfig,
} from "./config.ts";
export { TelemetryStore, formatI1Violation, type I1ViolationRow } from "./telemetry.ts";
export { HiveDaemon } from "./daemon.ts";
export { runDaemon, parseDaemonRunArgs, resolveDaemonConfig, type DaemonRunArgs } from "./main.ts";
export { RpcServer, toRpcError, type RpcConn, type RpcDispatch, type RpcServerOptions } from "./rpc.ts";
export * from "./protocol.ts";
export {
  LaunchdServiceManager,
  ServiceError,
  SystemdServiceManager,
  createServiceManager,
  renderLaunchdPlist,
  renderSystemdUnit,
  type ExecResult,
  type ExecRunner,
  type LaunchdDeps,
  type ServiceManager,
  type ServiceSpec,
  type ServiceStatus,
  type SystemdDeps,
} from "./service.ts";
