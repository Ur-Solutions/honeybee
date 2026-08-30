/**
 * The runner contract behind every login method. A runner owns exactly one
 * method's execution for one flow revision: it moves the flow through its
 * waiting phases, consumes typed input, watches for the credential landing,
 * and can always be stopped. It never reads or writes the flow row directly
 * — every transition goes through the host, which keeps the service the
 * only writer and lets it drop a superseded runner's late events.
 *
 * Three implementations (one per `LoginMethodRun` shape):
 *  - `ClaudeOauthRunner`  direct PKCE + pasted code       (login/claudeOauth.ts)
 *  - `DirectKeyRunner`    Codex / OpenCode API keys       (login/directKey.ts)
 *  - `CliRunner`          the vendor CLI in a native worker (login/cliRunner.ts)
 */
import type {
  AccountRow,
  CoreStore,
  LoginFieldDescriptor,
  LoginFlowError,
  LoginFlowPatch,
  LoginFlowRow,
  LoginMethodDescriptor,
  LoginMethodRun,
} from "../../../core/src/index.ts";
import type { AccountsService } from "../accountsService.ts";
import type { ResolvedNodeConfig } from "../config.ts";
import type { LoginWorkerStatus, PtySpawner } from "../loginWorker.ts";
import type { LoginTransports } from "./transports.ts";

export type LoginRunnerKind = "claude_oauth" | "direct_key" | "cli";

export interface LoginRunner {
  readonly kind: LoginRunnerKind;
  /** Begin the method: leave the flow in its first waiting phase, or failed with a typed error. */
  start(): Promise<LoginFlowRow>;
  /**
   * Deliver the operator's typed values for `fields` (the fields the flow
   * asked for, validated by the service). The flow is already `validating`.
   */
  submit(values: Record<string, string>, fields: readonly LoginFieldDescriptor[]): Promise<LoginFlowRow>;
  /** Periodic work while the flow is active (landing checks); throttling is the runner's business. */
  tick(now: number): void;
  /** Terminate anything the runner started. Idempotent; resolves once nothing outlives the runner. */
  stop(): Promise<void>;
  /** Bounded, redacted worker diagnostics; null for runners without a process. */
  workerStatus(): LoginWorkerStatus | null;
}

/** What a runner may do to its flow — the service's write path, scoped to one flow. */
export interface LoginRunnerHost {
  readonly flowId: string;
  readonly account: AccountRow;
  readonly method: LoginMethodDescriptor & { run: LoginMethodRun };
  readonly store: CoreStore;
  readonly accounts: AccountsService;
  readonly cfg: ResolvedNodeConfig;
  readonly transports: LoginTransports;
  readonly log: (op: string) => void;
  readonly now: () => number;
  readonly workerKillGraceMs: number;
  readonly workerSettleMs: number | undefined;
  /** The flow row as it is now (null once removed). */
  flow(): LoginFlowRow | null;
  /** The flow exists and is not terminal. */
  stillActive(): boolean;
  /** `runner` is still the flow's registered runner — a superseded runner (cancel → retry, method switch) must drop its late events. */
  isCurrent(runner: LoginRunner): boolean;
  /** Unregister `runner` without stopping it (its process already ended). No-op for a superseded runner. */
  release(runner: LoginRunner): void;
  /** The PTY backend, resolved lazily (null = pipe-only node). */
  resolveSpawner(): Promise<PtySpawner | null>;
  patch(patch: LoginFlowPatch, reason: string): LoginFlowRow;
  /** Terminal failure: stops and unregisters the flow's runner. */
  fail(error: LoginFlowError, retryable: boolean): LoginFlowRow;
  /** Validation failed: back to `waiting_input` with a typed error; the runner stays. */
  reask(error: LoginFlowError): LoginFlowRow;
  /** Credential validated + captured: `succeeded`, runner stopped, account marked ok. */
  succeed(detail?: string): LoginFlowRow;
}
