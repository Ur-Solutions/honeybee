/**
 * The v2 RPC surface (spec 04 "RPC surface") — shared by the daemon's server
 * (rpc.ts) and the thin CLI client (v2/cli/src/client.ts).
 *
 * Transport: unix domain socket, jsonl frames (one json object per line).
 * Versioned hello, negotiated once: the server writes `{"protocol":"v2/1"}`
 * on connect; the client's FIRST frame must be `{"protocol":"v2/1"}`. A
 * mismatch is answered with a `protocol_mismatch` error and the connection is
 * closed. No capability sniffing.
 *
 * Requests:  {id, verb, params?}
 * Responses: {id, ok:true, result} | {id, ok:false, error:{code, message}}
 * Watch push frames (no id):
 *   {type:"delta", baseSeq, seq, events:[AuditRow…]}  — contiguous: baseSeq
 *     always equals the seq the client last held; anything else IS a gap.
 *   {type:"gap", seq} — the server bounded the batch (or restarted) and the
 *     client must refetch the snapshot (fail-closed cursor).
 */
import type {
  AccountStatus,
  AuditRow,
  BeeRow,
  CredentialHealth,
  ExecutableResolutionSource,
  LoginFlowRow,
  MirrorAccountLimitsRow,
  MirrorAccountRow,
  MirrorLoginFlowRow,
  BeeView,
  CommandRow,
  CommandStatus,
  FrozenImportReport,
  LocalConfigImportReport,
  MessageRow,
  NamingUsageSummary,
  MirrorQuestionRow,
  MirrorSealRow,
  MirrorTaskRow,
  MirrorTaskSupplyRow,
  MirrorTemplateRow,
  MirrorTrackRow,
  TaskTransitionAction,
  RuntimeRow,
  TemplatePackage,
  TrackPackage,
} from "../../core/src/index.ts";
import type { BootReport } from "./loops.ts";

export const PROTOCOL = "v2/1";
export const DAEMON_VERSION = "2.0.0-wp4";

/**
 * Additive capability tags (2026-08-28). The protocol stays `v2/1`; a client
 * that needs a feature newer than the hello gates on these instead of
 * sniffing verbs. The server hello is `{protocol, capabilities}` (an older
 * client ignores the extra key) and `deployInfo` repeats the list.
 */
export const DAEMON_CAPABILITIES = [
  /** Typed, tmux-independent account login flows: account.login.* verbs + the login_flows snapshot table. */
  "account.login.flow.v1",
  /** Per-harness executable facts (`node.harnesses`), resolved with the same rule the spawn path uses. */
  "node.harnesses.v1",
  /**
   * v18 (2026-09-02): honest credentials — mirror account rows (snapshot +
   * `account.put` deltas) carry the derived `credentialHealth`; `account.add
   * {importExisting}` imports from the machine's vendor home or refuses with
   * `no_credentials_to_import`; `status` is never `ok` with `absent`
   * credentials; the `account.verify` verb runs the harness's real probe.
   */
  "account.credential_health.v1",
  /**
   * v18 (2026-09-02): the idle-timeout reaper — `idle_timeout` exit cause,
   * `bee.setIdleTimeout` (+ `spawn {idleTimeoutMs}`), `health.idleTimeoutMs`.
   */
  "bee.idle_timeout.v1",
] as const;
export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

/** The server's first frame on a connection. */
export interface HelloFrame {
  protocol: string;
  capabilities: readonly DaemonCapability[];
}

/** Closed-list, typed errors — never fuzzy (spec 04). */
export const RPC_ERROR_CODES = [
  "bee_not_found",
  "node_stopped",
  "protocol_mismatch",
  "invalid_request",
  /** Verb-specific refusal: the lifecycle graph forbids the transition. */
  "lifecycle_refused",
  /** Verb-specific refusal: the runtime state forbids the operation. */
  "runtime_refused",
  /** Registry refusals (WP6a): missing rows and per-scope name collisions. */
  "template_not_found",
  "track_not_found",
  "name_conflict",
  /** A package document failed header/field validation. */
  "invalid_package",
  /** v6 (additive): question / seal lookups. */
  "question_not_found",
  "seal_not_found",
  /** v7 (spec 08, additive): account verbs. */
  "account_not_found",
  /** v11: agent task lists. */
  "task_not_found",
  /** The account is paused (explicit spawn / swap onto it refused). */
  "account_paused",
  /** The account's harness differs from the bee's agent (spawn / swap). */
  "harness_mismatch",
  /** `account.remove` while bees still reference the account. */
  "account_referenced",
  /** `auto` found no usable account (none registered/credentialed, all paused, or none untried). */
  "account_unavailable",
  /** v16 (account login flows): the flow id is unknown (or belongs to a removed account). */
  "login_flow_not_found",
  /** v16: the verb does not apply in the flow's current phase / the field is not being requested. */
  "login_flow_refused",
  /** v16: the harness has no login recipe or the requested method is not offered (or not remote-capable). */
  "login_method_unsupported",
  /**
   * F2: `account.add` without `importExisting:true` found pre-existing
   * harness credentials at the account's home (or a leftover vault entry) —
   * a fresh account must start logged out; adopting a machine's existing
   * login is an explicit choice, never a default.
   */
  "account_home_populated",
  /**
   * v18: `account.add {importExisting:true}` found nothing to adopt — no
   * primary credential in the account home, the vault entry, or the
   * machine's vendor home (the message lists every path checked). A
   * logged-out account is never created "by import".
   */
  "no_credentials_to_import",
  /**
   * `bee.swapAccount` (claude): the conversation transcript the destination
   * home must hold for `--resume <seed> --fork-session` was not found in the
   * source home — refused up front rather than crash-looping every wake on
   * "No conversation found with session ID".
   */
  "transcript_unavailable",
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export const RPC_VERBS = [
  // the seven mutations — thin wrappers over store + queue
  "spawn",
  "send",
  "mail.cancel",
  "mail.expedite",
  "stop",
  "revive",
  "archive",
  "unarchive",
  "delete",
  // reads
  "view",
  "list",
  "mailbox",
  "commands",
  "deployInfo",
  "health",
  // F8 (additive read): per-harness executable facts — present/path/source/
  // version — resolved with the SAME rule the spawn path uses, so probe
  // truth equals spawn truth.
  "node.harnesses",
  // CLI-alignment (additive read): tail of the audit log for `hive v2 events`
  "audit.tail",
  // watch
  "watch",
  "snapshot",
  // templates + tracks + packages (WP6a, spec 06 §1.4.1)
  "template.list",
  "template.get",
  "template.put",
  "template.delete",
  "template.export",
  "template.import",
  "track.list",
  "track.get",
  "track.put",
  "track.delete",
  "track.export",
  "track.import",
  "packages.importLocalConfig",
  // WP7 (spec 07 B4): import the operator's active old-world bees from a frozen store
  "import.fromFrozen",
  // schema v5: replace a bee's per-bee spawn args (takes effect on the next runtime)
  "bee.setArgs",
  // schema v18: per-bee idle-timeout override for the daemon's idle reaper
  "bee.setIdleTimeout",
  // WP6 §5 cell exit path (spec 05 points 4 + 6): the WP5 driver primitives as verbs
  "cell.capture",
  "cell.remove",
  // v6 pre-flip verb set (additive to v2/1): rename, tag, interrupt, fork,
  // parenting read, questions, seals. `spawn` also takes `parentId?`.
  "bee.rename",
  "bee.tag",
  "bee.interrupt",
  "bee.fork",
  "bee.children",
  "question.ask",
  "question.answer",
  "question.list",
  "seal.create",
  "seal.list",
  "seal.get",
  // v7 (spec 08 CORE, additive to v2/1): accounts + auth. `spawn` also takes
  // `account?` ('auto' default → the calibrated selector; 'rr' → registration-
  // order round robin; explicit id; null = unbound).
  "account.list",
  "account.get",
  "account.add",
  "account.remove",
  "account.pause",
  "account.unpause",
  "account.setPenalty",
  "account.login",
  // v16 (2026-08-28, additive): typed, tmux-independent login flows. `account.login`
  // stays as the alias of `account.login.start` for the CLI edge.
  "account.login.start",
  "account.login.get",
  "account.login.selectMethod",
  "account.login.submit",
  "account.login.retry",
  "account.login.cancel",
  "account.capture",
  // v18 (additive): run the harness's real credential probe on demand.
  "account.verify",
  "account.limits",
  "account.importRegistry",
  "account.backfill",
  "bee.swapAccount",
  // Auto-titler node config (additive): `config.get` is a read; `config.patch`
  // writes `naming` in the node's config.json.
  "config.get",
  "config.patch",
  // v14 operational telemetry (read-only): all-time automatic-naming spend.
  "naming.usage",
  // v11: agent task lists (mailbox is the delivery path).
  "task.add",
  "task.list",
  "task.get",
  "task.transition",
  "task.claim",
  "task.move",
  "task.edit",
  "task.lists",
  "task.supply.get",
  "task.supply.set",
] as const;
export type RpcVerb = (typeof RPC_VERBS)[number];

export interface RpcRequest {
  id: number;
  verb: RpcVerb;
  params?: Record<string, unknown>;
}

export interface RpcErrorShape {
  code: RpcErrorCode;
  message: string;
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: RpcErrorShape };

export type WatchFrame =
  | { type: "delta"; baseSeq: number; seq: number; events: AuditRow[] }
  | { type: "gap"; seq: number };

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * One-key idempotency (spec 06 §4.2): every mutation verb accepts an optional
 * caller-supplied `idempotencyKey` param. A key already seen answers with the
 * ORIGINAL recorded result plus these replay markers instead of executing
 * again — `deduped: true`, and (for command-backed mutations) `status` = the
 * original command's CURRENT status, so a replay after settle returns the
 * settled outcome, not a new command. Fresh executions omit both fields.
 */
export interface DedupMarkers {
  deduped?: boolean;
  status?: CommandStatus;
}

export interface SpawnResult extends DedupMarkers {
  beeId: string;
  /** The concrete configured agent after resolving an embedded account selector. */
  agent?: string;
  /** v10 — the minted display handle (`CL.a3f2`); what humans use from here on. */
  handle?: string | null;
  commandId: number;
  /** First mailbox message admitted atomically with the bee, when supplied. */
  messageId?: number | null;
  /**
   * v7: the account the bee was bound to (null = unbound: no accounts for the
   * harness, or `account: null` requested) and, for an `auto`/`rr` pick, the
   * selector's reason line.
   */
  account?: string | null;
  accountReason?: string;
}

// ---------------------------------------------------------------------------
// v7 (spec 08) — accounts + auth. All mutations take the optional idempotencyKey.
// ---------------------------------------------------------------------------

/** `account.list {harness?}` — rows verbatim + their latest limits snapshots (mirror shapes). */
export interface AccountListResult {
  accounts: MirrorAccountRow[];
  limits: MirrorAccountLimitsRow[];
  /** F2: derived credential-validation evidence per account id (see CredentialHealth). */
  credentialHealth: Record<string, CredentialHealth>;
}

/** `account.get {id}` — id accepts an exact/unique fuzzy selector; `account_not_found` when absent. */
export interface AccountGetResult {
  account: MirrorAccountRow;
  limits: MirrorAccountLimitsRow | null;
  /** Bee ids bound to the account. */
  bees: string[];
  /** Whether the vault / home hold the harness's primary credential. */
  credentialed: boolean;
  /** F2: a file existing is not health — the derived validation evidence. */
  credentialHealth: CredentialHealth;
  /** v16: the account's current login flow (active or its latest outcome), if any. */
  loginFlow: MirrorLoginFlowRow | null;
}

/** v18: where `account.add {importExisting:true}` took the credential from. */
export interface ImportedCredentials {
  /**
   * `home`: the account's own home already held it (captured into the vault);
   * `vault`: a leftover vault entry for the id; `vendor_home`: the machine's
   * real harness home (its home env var, else the recipe default under $HOME);
   * `external`: the provider's out-of-home store (Claude Keychain, Cursor's
   * global store) for the vendor home.
   */
  source: "home" | "vault" | "vendor_home" | "external";
  /** The directory / store the files came from. */
  from: string;
  /** Recipe-relative files now in the vault. */
  files: string[];
}

/**
 * `account.add {harness, label, id?, homePath?, penalty?, importExisting?}` —
 * id defaults to `<harness>-<safe(label)>`, homePath to `<homesDir>/<id>`.
 * Audit account.put.
 *
 * F2: a fresh account starts LOGGED OUT (empty vault; credentials arrive
 * through the typed `account.login.*` flows) with `status:"auth_needed"` —
 * v18: `ok` is never claimed while `credentialHealth` is `absent`. When the
 * home (or a leftover vault entry for the id) already holds the harness's
 * primary credential, the add is refused with `account_home_populated`
 * unless `importExisting:true` explicitly opts into adopting it.
 *
 * v18: `importExisting:true` means "import the machine's existing sign-in":
 * the account home / vault entry when populated, else the harness's
 * primary credential file(s) copied from the machine's VENDOR home
 * (`CODEX_HOME` / `CLAUDE_CONFIG_DIR` … when set, else `~/.codex`,
 * `~/.claude`, …; Claude on macOS: the Keychain item) into the account's
 * vault. Nothing importable anywhere → `no_credentials_to_import` (the
 * message lists the paths checked) and NO account row. An adopted
 * credential is `unverified`; when the harness has a real probe the daemon
 * schedules one (`verification:"scheduled"`) so the mirror row promptly
 * shows `verified` or `status:"auth_needed"`. Import can sign the machine's
 * regular CLI out of that provider (refresh tokens rotate on use).
 */
export interface AccountAddResult extends DedupMarkers {
  account: MirrorAccountRow;
  /** `unverified` after an importExisting adoption; `absent` for a fresh logged-out account. */
  credentialHealth: CredentialHealth;
  /** v18: provenance of an imported credential; null for a fresh logged-out add. */
  imported: ImportedCredentials | null;
  /**
   * v18: `scheduled` — the harness's real probe runs in the background lane
   * and lands on the mirror row; `unsupported` — a credential exists but the
   * harness has no probe (stays `unverified`); `none` — nothing to verify.
   */
  verification: "scheduled" | "unsupported" | "none";
}

/** `account.remove {id}` — id is a selector; `account_referenced` while bees carry it. */
export interface AccountRemoveResult extends DedupMarkers {
  account: MirrorAccountRow;
}

/** Account edits accept selectors in `id`; `applied:false` = already in the requested state. */
export interface AccountUpdateResult extends DedupMarkers {
  account: MirrorAccountRow;
  applied: boolean;
}

// ---------------------------------------------------------------------------
// v16 (2026-08-28) — typed, tmux-independent account login flows. The flow
// row (core `LoginFlowRow`) is the ONLY progress channel: it rides the
// snapshot (`loginFlows`) and the watch stream (`login_flow.put/removed`).
// No verb ever returns raw worker output; no param is echoed back.
// ---------------------------------------------------------------------------

/**
 * `account.login.start {id, methodId?, remote?, idempotencyKey?}` — resolve
 * the account selector, then start OR REJOIN its login flow: an active flow
 * for the account is returned (`rejoined: true`) without spawning another
 * worker. `remote: true` declares that the operator's browser cannot reach
 * this node's loopback (Apiary on another machine): non-remote-capable
 * methods are filtered out; a harness with none refuses inside the flow row
 * (`remote_loopback_unsupported`). An already-authenticated account still
 * gets a flow (re-login is legitimate). `account.login {id}` is an alias.
 */
export interface AccountLoginStartResult extends DedupMarkers {
  accountId: string;
  flow: MirrorLoginFlowRow;
  rejoined: boolean;
}

/** `account.login.get {flowId}` | `{id}` (account selector → its latest flow). `login_flow_not_found` when absent. */
export interface AccountLoginGetResult {
  flow: MirrorLoginFlowRow;
}

/**
 * `account.login.selectMethod {flowId, methodId, idempotencyKey?}` — switch
 * an active flow to another advertised method (the current worker is
 * stopped; a new revision starts). `login_method_unsupported` for an
 * unknown / non-remote-capable method; `login_flow_refused` on a terminal flow.
 */
export interface AccountLoginSelectMethodResult extends DedupMarkers {
  flow: MirrorLoginFlowRow;
}

/**
 * `account.login.submit {flowId, values: Record<fieldId, string>, idempotencyKey?}`
 * — deliver the input the flow is currently requesting (`inputFields`).
 * SENSITIVE: `values` may carry secrets; the daemon consumes them in
 * memory, never audits/logs/stores them, and the recorded idempotent result
 * is the safe flow row only. Refused (`login_flow_refused`) when the flow is
 * not `waiting_input` or a field is not being requested; `invalid_request`
 * for a missing required field. Validation failures are NOT errors: the
 * flow row returns to `waiting_input` with a typed `invalid_credential` /
 * `invalid_input` error so the client re-asks.
 */
export interface AccountLoginSubmitResult extends DedupMarkers {
  flow: MirrorLoginFlowRow;
}

/** `account.login.retry {flowId, idempotencyKey?}` — a failed/expired/interrupted (or cancelled) flow restarts as a new revision. */
export interface AccountLoginRetryResult extends DedupMarkers {
  flow: MirrorLoginFlowRow;
}

/** `account.login.cancel {flowId, idempotencyKey?}` — stop the worker and mark the flow cancelled; a terminal flow is a no-op (`applied:false`). */
export interface AccountLoginCancelResult extends DedupMarkers {
  flow: MirrorLoginFlowRow;
  applied: boolean;
}

export type { LoginFlowRow };

/**
 * `account.capture {id}` — recovery path for an already-authenticated account:
 * validate the current home / external provider credential, snapshot the
 * recipe files into the vault, mark the login complete, and close any owned
 * login seat. Unlike `account.login`, this does not require freshness drift.
 */
export interface AccountCaptureResult extends DedupMarkers {
  account: MirrorAccountRow;
  captured: string[];
  source: "external" | "home";
  at: number;
}

/**
 * v18: `account.verify {id, idempotencyKey?}` — run the cheapest REAL
 * validation the harness supports (the limits probe: Claude usage endpoint,
 * `codex app-server`, the secondary providers' windows) and report what it
 * proved. `verified`: the probe read (the limits row is fresh); `auth_needed`:
 * a typed auth failure (status flipped, log in); `unverified`: the harness
 * has no probe (`probe:"none"`) or the probe failed transiently (see
 * `limits.unreadableReason`); `absent`: no credential anywhere to verify.
 * Never spawns a bee; a Codex account's EMPTY home is activated from the
 * vault first (exactly what the first spawn would do).
 */
export interface AccountVerifyResult extends DedupMarkers {
  account: MirrorAccountRow;
  outcome: "verified" | "auth_needed" | "unverified" | "absent";
  probe: "limits" | "none";
  /** The limits row after the probe; null when no probe ran. */
  limits: MirrorAccountLimitsRow | null;
}

/** `account.limits {id?}` — resolve id as a selector, or refresh all accounts when omitted. */
export interface AccountLimitsResult extends DedupMarkers {
  limits: MirrorAccountLimitsRow[];
}

/** `account.importRegistry {root?, dryRun?}` — the old ~/.hive/vault/accounts.json → rows (read-only on the old tree). */
export interface AccountImportRegistryResult extends DedupMarkers {
  root: string;
  registryPath: string;
  dryRun: boolean;
  applied: boolean;
  refusal?: string;
  entries: Array<{
    id: string;
    harness: string;
    action: "import" | "skip";
    reason?: string;
    note?: string;
    homePath?: string;
    vaultHasCredentials?: boolean;
    homeExists?: boolean;
    homeHasCredentials?: boolean;
    penalty?: number;
    /** v18: an old record without any credential imports as `auth_needed`, never a usable-looking `ok`. */
    status?: AccountStatus;
  }>;
  counts: { import: number; skip: number };
  byHarness: Record<string, { import: number; skip: number }>;
  /** The env-only bee backfill run right after a real import (absent on dry-run). */
  backfill?: AccountBackfillResult;
}

/** `account.backfill {dryRun?}` — env-only bees → bees.account by home path. */
export interface AccountBackfillResult extends DedupMarkers {
  dryRun: boolean;
  bound: Array<{ beeId: string; account: string; home: string }>;
  unmatched: Array<{ beeId: string; home: string }>;
}

/**
 * `bee.swapAccount {beeId, account}` — account is a selector; same-harness only (`harness_mismatch`),
 * `account_paused` refused, `account_not_found`. Rebinds the bee (account +
 * home env), then: a live runtime is stopped and revived with resume
 * (`stop_then_revive`, the stop command id); a stopped bee is just rebound
 * (`rebind_only`; the next wake resumes on the new account). Claude
 * cross-account moves are rekeyed: the conversation resumes under a NEW
 * session id (`--resume <seed> --fork-session`) — and since the CLI resolves
 * that seed inside its own config dir, the transcript (`projects/<cwd-key>/
 * <seed>.jsonl` + its sibling dir) is carried from the source home into the
 * destination home first (`transcript`: copied / already present / none to
 * carry). A seed with no transcript anywhere refuses the swap
 * (`transcript_unavailable`) and leaves the bee untouched.
 */
export interface SwapAccountResult extends DedupMarkers {
  beeId: string;
  from: string | null;
  to: string;
  action: "stop_then_revive" | "rebind_only" | "noop";
  commandId: number | null;
  rekeyed: boolean;
  transcript: "copied" | "present" | "none";
}

// ---------------------------------------------------------------------------
// v6 pre-flip verbs — shapes. All mutations take the optional idempotencyKey.
// ---------------------------------------------------------------------------

/**
 * `bee.rename {beeId, name}` — names follow createBee's rules (non-empty,
 * NOT unique: the id is the identity). `applied:false` = already that name.
 * Audit `bee.renamed`.
 */
export interface RenameResult extends DedupMarkers {
  bee: BeeRow;
  applied: boolean;
}

/** `config.get` — resolved auto-titler settings (defaults applied). */
export interface NamingConfigView {
  auto: boolean;
  backend: "codex-app-server" | "openai-api" | "claude-cli";
  tool: "codex" | "claude";
  model: string;
  effort: string;
  /** The API key itself is write-only and never crosses this read boundary. */
  apiKeyConfigured: boolean;
  command?: string;
}

export interface ConfigGetResult {
  naming: NamingConfigView;
  configPath: string;
}

/** `config.patch {naming}` — last-write-wins merge of naming keys. */
export interface ConfigPatchResult extends DedupMarkers {
  naming: NamingConfigView;
  configPath: string;
}

/** `naming.usage` — all-time automatic-naming attempts, latency, tokens, and estimated API cost. */
export interface NamingUsageResult {
  usage: NamingUsageSummary;
}

/**
 * `bee.tag {beeId, add?: string[], remove?: string[]}` — remove first, then
 * add; order preserved; duplicates collapse. Apiary uses `apiary:workspace=…`
 * tags for workspace membership, so tag-after-spawn = moving a bee between
 * workspaces. Audit `bee.tagged` (payload carries the full new list).
 */
export interface TagResult extends DedupMarkers {
  bee: BeeRow;
  applied: boolean;
  added: string[];
  removed: string[];
}

/**
 * `bee.interrupt {beeId}` — stop the CURRENT TURN without ending the runtime
 * (claude stream-json control_request interrupt; codex turn/interrupt; tmux
 * C-c). `interrupted:false` + `reason` is a RESULT, never an error: `idle`
 * (nothing to interrupt), `no_process` (no live runtime), `not_ready`
 * (booting / dying / re-adopted without a channel), `unsupported` (harness
 * has no in-band interrupt). The turn_ended that follows a successful
 * interrupt is an ordinary observation. Audit `bee.interrupted` (informational).
 */
export interface InterruptResult extends DedupMarkers {
  beeId: string;
  generation: number | null;
  interrupted: boolean;
  reason?: "idle" | "no_process" | "not_ready" | "unsupported";
}

/**
 * `bee.fork {beeId, name?, prompt?, id?}` — a NEW bee with the source's
 * agent / substrate / cwd / args / env / title / tags, `parentId` = source,
 * `forkedFrom` = source, and provider-session continuity: the fork's FIRST
 * runtime forks the source's conversation (`forkSeed` = the source's provider
 * session id → claude `--resume <seed> --fork-session`, codex `thread/fork`)
 * into a NEW session of its own, which the daemon records on the fork when
 * its runtime reports it (the seed is consumed then). A `spawn` command is
 * enqueued (`commandId`); `prompt` is enqueued as the fork's first mailbox
 * message (`messageId`). Cell-substrate bees cannot be forked
 * (`invalid_request` — the cell checkout is single-tenant). Audit:
 * `bee.created` (+ `bee.forked`, informational).
 */
export interface ForkResult extends DedupMarkers {
  beeId: string;
  commandId: number;
  forkedFrom: string;
  /** The source's provider session id the fork will fork from; null when the source had none (fork boots fresh). */
  forkSeed: string | null;
  messageId: number | null;
  bee: BeeRow;
}

/** `bee.children {beeId}` — bees whose parentId is this bee (any lifecycle), as view results. */
export interface ChildrenResult {
  beeId: string;
  children: ViewResult[];
}

/**
 * `question.ask {beeId, text, options?}` — a bee asks the operator (called
 * from the bee's runtime: `hive v2 ask "…"` reads HIVE_BEE_ID). Row is open
 * until `question.answer`. Audit `question.asked`.
 */
export interface QuestionAskResult extends DedupMarkers {
  question: MirrorQuestionRow;
}

/**
 * `question.answer {questionId, answer, answeredBy?}` — marks answered AND
 * delivers the answer to the bee as an ordinary mailbox message prefixed
 * `[answer to question <id>]` (send()'s wake/unarchive rules apply). A
 * non-open question is `invalid_request`. Audit `question.answered`.
 */
export interface QuestionAnswerResult extends DedupMarkers {
  question: MirrorQuestionRow;
  messageId: number;
  /** The send_wake enqueued for the delivery, when one was needed. */
  commandId: number | null;
  unarchived: boolean;
}

/** `question.list {beeId?, open?}` */
export interface QuestionListResult {
  questions: MirrorQuestionRow[];
}

/**
 * `seal.create {beeId, title, body, refs?}` — metadata only, tied to the
 * bee's current generation. Audit `seal.created`.
 */
export interface SealCreateResult extends DedupMarkers {
  seal: MirrorSealRow;
}

/** `seal.list {beeId?}` */
export interface SealListResult {
  seals: MirrorSealRow[];
}

/** `seal.get {sealId}` — `seal_not_found` when absent. */
export interface SealGetResult {
  seal: MirrorSealRow;
}

// ---------------------------------------------------------------------------
// v11 — agent task lists. Mutations take the optional idempotencyKey.
// ---------------------------------------------------------------------------

/** `task.add {list|beeId, title, body?, context?, originKind?, originSender?, auto?, questId?}` */
export interface TaskAddResult extends DedupMarkers {
  task: MirrorTaskRow;
  warning?: string;
}

/** `task.list {list?, beeId?, statuses?}` */
export interface TaskListResult {
  list: string | null;
  tasks: MirrorTaskRow[];
}

/** `task.get {taskId}` — `task_not_found` when absent. */
export interface TaskGetResult {
  task: MirrorTaskRow;
}

/** `task.transition {taskId, action, reason?}` */
export interface TaskTransitionResult extends DedupMarkers {
  task: MirrorTaskRow;
}

/** `task.claim {list, claimant}` — `task` is null when the list has nothing pending. */
export interface TaskClaimResult extends DedupMarkers {
  task: MirrorTaskRow | null;
}

/** `task.move {taskId, before?, after?}` */
export interface TaskMoveResult extends DedupMarkers {
  task: MirrorTaskRow;
}

/** `task.edit {taskId, title?, body?, auto?}` */
export interface TaskEditResult extends DedupMarkers {
  task: MirrorTaskRow;
}

/** `task.lists` */
export interface TaskListsResult {
  lists: Array<{ id: string; total: number }>;
}

/** `task.supply.get {beeId}` */
export interface TaskSupplyGetResult {
  supply: MirrorTaskSupplyRow;
}

/** `task.supply.set {beeId, on?, limit?}` */
export interface TaskSupplySetResult extends DedupMarkers {
  supply: MirrorTaskSupplyRow;
}

export type { TaskTransitionAction };

/**
 * The substrates the daemon can spawn onto (contract §1: tmux | hsr | cell).
 * `spawn` takes `substrate?` (default `hsr`) and, for `cell`, a `cell`
 * object (SpawnCellParams). Tmux runs the interactive TUI; hsr/cell run the
 * headless adapter protocol.
 * v6: `spawn` also takes `parentId?` — the calling bee (the CLI fills it from
 * HIVE_BEE_ID; apiary passes it explicitly). The parent must exist
 * (`bee_not_found` otherwise); the child's runtime env is stamped
 * HIVE_BEE / HIVE_BEE_ID / HIVE_PARENT.
 */
export const SPAWN_SUBSTRATES = ["hsr", "cell", "tmux"] as const;
export type SpawnSubstrate = (typeof SPAWN_SUBSTRATES)[number];

/**
 * `spawn { substrate: "cell", cell: {…} }` — the cell half of a cell spawn.
 * The daemon reserves the cell (seed `box/cell.json`) in the same call and
 * records the bee with `substrate = "cell"` and `cwd` = the space checkout
 * (`<cells-root>/<wrapper>/<repo>-space-<id>`); the first runtime start
 * provisions against that ledger. `cwd` in the spawn params is ignored for
 * cell spawns (the cell owns the cwd). All substrates also accept an optional
 * `env: Record<string,string>`; the daemon validates and persists it on the
 * bee, while account/home env remains daemon-owned and wins on reserved keys.
 */
export interface SpawnCellParams {
  /** The origin repository (working-tree root) the cell is provisioned from. */
  originRepo: string;
  /** Commit-ish to materialize; default = the origin's HEAD. Resolved to a full sha at spawn. */
  sha?: string;
  /**
   * Warm artifact dirs (A5, CoW-only): `true` = the node's per-repo list for
   * this origin (`cells.warm[originRepo]`), `false`/absent = cold, or an
   * explicit list of working-tree-relative dirs.
   */
  warm?: boolean | string[];
  /** Per-cell sandbox override (A4); absent = node-kind default / node-wide override. */
  sandbox?: boolean;
}

/**
 * `bee.setArgs` (schema v5). Params: `{ beeId, args: string[] | null }` —
 * null clears. Bee-scoped; the CURRENT runtime is untouched (stop/revive to
 * apply). `applied:false` = the value was already exactly that.
 * `spawn` also accepts `args?: string[]` (the bee's initial per-bee args) and
 * `revive` accepts `args?: string[] | null` (replace them as the revive runs).
 */
export interface SetArgsResult extends DedupMarkers {
  bee: BeeRow;
  applied: boolean;
}

/**
 * `bee.setIdleTimeout` (schema v18). Params: `{ beeId, idleTimeoutMs: number | null }`
 * — null = inherit the node's `idleWindowMs`, 0 = never reap, >0 = reap after
 * that many ms idle. Read by the reaper every tick, so it applies to the
 * CURRENT runtime. `spawn` also accepts `idleTimeoutMs?` (the same values).
 * `applied:false` = the value was already exactly that.
 */
export interface SetIdleTimeoutResult extends DedupMarkers {
  bee: BeeRow;
  applied: boolean;
}

/**
 * `send {beeId, body, sender?, urgency?, idempotencyKey?}` — v8 adds
 * `urgency?: 'now'|'next'|'idle'` (spec 01 Q2 amendment; omitted = 'next').
 * Urgency governs when the message becomes eligible for delivery (`now`
 * interrupts the current turn; `idle` waits for the runtime to leave
 * `running`); it never reorders the per-bee FIFO and never affects the
 * revive-on-message wake. An unknown urgency is `invalid_request`.
 */
export interface SendRpcResult extends DedupMarkers {
  messageId: number;
  /** The send_wake enqueued in the same transaction, when one was needed. */
  commandId: number | null;
  unarchived: boolean;
}

export interface MutationResult extends DedupMarkers {
  commandId: number;
}

export interface ViewResult {
  view: BeeView;
  bee: BeeRow | null;
  runtime: RuntimeRow | null;
}

export interface ListResult {
  views: ViewResult[];
}

export interface MailboxResult {
  messages: MessageRow[];
}

export interface CommandsResult {
  commands: CommandRow[];
}

/**
 * `audit.tail {beeId?, afterSeq?, limit?}` — a bounded read of the audit log
 * (the same rows the watch stream pushes as deltas). `afterSeq` returns only
 * rows with seq > afterSeq (a follow cursor); `limit` keeps the LAST n rows
 * after filtering (default 100, capped at 1000). Kind filtering is client-side.
 */
export interface AuditTailResult {
  rows: AuditRow[];
}

export interface DeployInfoResult {
  protocol: string;
  /** v16 (additive): the capability tags this daemon offers (also in the hello). */
  capabilities: readonly DaemonCapability[];
  daemonVersion: string;
  nodeVersion: string;
  pid: number;
  startedAt: number;
  dataDir: string;
  socketPath: string;
  storePath: string;
}

/**
 * `node.harnesses {}` — the node's honest per-harness capability facts:
 * whether each configured agent's executable is actually runnable BY THIS
 * DAEMON, where it resolved from, and (when cheaply probeable) its version.
 * Resolution uses the exact core rule the spawn path uses (F8: probe truth
 * == spawn truth); a stale bun/mise leftover is therefore visible as
 * `source:"fallback"` + its real path instead of masquerading as a working
 * install. `version` is a bounded `--version` of the resolved binary,
 * cached by (path, mtime); null when absent or the probe fails.
 */
export interface NodeHarnessesResult {
  harnesses: HarnessFact[];
}

export interface HarnessFact {
  /** Agent/harness name from the node's `agents` config. */
  harness: string;
  /** The configured command, before resolution. */
  command: string;
  /** Whether the daemon can resolve a runnable executable right now. */
  present: boolean;
  /** Resolved absolute path (the exact path a spawn would exec); null when absent. */
  path: string | null;
  source: ExecutableResolutionSource | null;
  version: string | null;
}

export interface HealthResult {
  protocol: string;
  pid: number;
  startedAt: number;
  uptimeMs: number;
  ticks: number;
  lastTickAt: number | null;
  tickErrors: number;
  stopping: boolean;
  lastBoot: BootReport | null;
  i1Violations: number;
  bees: { total: number; active: number; archived: number };
  /** v18: the node-wide idle-timeout in effect (config `idleWindowMs`); 0 = reaper disabled. */
  idleTimeoutMs: number;
}

export interface SnapshotResult {
  seq: number;
  views: ViewResult[];
  /** Mirror-shaped registry rows (WP6a): store rows verbatim, snapshot-consistent with `seq`. */
  templates: MirrorTemplateRow[];
  tracks: MirrorTrackRow[];
  /** v6 (additive): questions + seals, store rows verbatim, snapshot-consistent with `seq`. */
  questions: MirrorQuestionRow[];
  seals: MirrorSealRow[];
  /** v7 (additive): accounts + latest limits, store rows verbatim. */
  accounts: MirrorAccountRow[];
  accountLimits: MirrorAccountLimitsRow[];
  /** v11 (additive): agent task lists + per-bee auto-supply, store rows verbatim. */
  tasks: MirrorTaskRow[];
  taskSupply: MirrorTaskSupplyRow[];
  /** v16 (additive): account login flows, store rows verbatim. */
  loginFlows: MirrorLoginFlowRow[];
}

// ---------------------------------------------------------------------------
// Template / track / package verb shapes (WP6a)
// ---------------------------------------------------------------------------

export interface TemplateListResult {
  templates: MirrorTemplateRow[];
}

export interface TemplateGetResult {
  template: MirrorTemplateRow;
}

export interface TemplatePutResult extends DedupMarkers {
  template: MirrorTemplateRow;
  outcome: "created" | "updated" | "unchanged";
}

export interface TemplateDeleteResult extends DedupMarkers {
  template: MirrorTemplateRow;
}

export interface TemplateExportResult {
  /** The parsed package document. */
  package: TemplatePackage;
  /** Canonical serialized text (what belongs in a file, byte-stable). */
  text: string;
}

export interface TemplateImportResult extends DedupMarkers {
  template: MirrorTemplateRow;
  outcome: "created" | "updated" | "unchanged";
}

export interface TrackListResult {
  tracks: MirrorTrackRow[];
}

export interface TrackGetResult {
  track: MirrorTrackRow;
}

export interface TrackPutResult extends DedupMarkers {
  track: MirrorTrackRow;
  outcome: "created" | "updated" | "unchanged";
}

export interface TrackDeleteResult extends DedupMarkers {
  track: MirrorTrackRow;
}

export interface TrackExportResult {
  package: TrackPackage;
  text: string;
}

export interface TrackImportResult extends DedupMarkers {
  track: MirrorTrackRow;
  outcome: "created" | "updated" | "unchanged";
}

export type ImportLocalConfigResult = LocalConfigImportReport & DedupMarkers;

/**
 * `import.fromFrozen` (WP7). Params: `{ root?: string, dryRun?: boolean,
 * force?: boolean }` — root defaults to the node's old-world store (~/.hive).
 * Result is core's FrozenImportReport verbatim: `applied:false` + `refusal`
 * when the FROZEN marker is missing or the preflight found live old-world
 * runtimes (never an RPC error — the report IS the answer).
 */
export type ImportFromFrozenResult = FrozenImportReport & DedupMarkers;

// ---------------------------------------------------------------------------
// Cell verb shapes (WP6 §5.1 / spec 05 points 4 + 6)
// ---------------------------------------------------------------------------

/**
 * `cell.capture` — params `{ beeId, targetBranch, mode: "merge"|"rebase",
 * idempotencyKey? }`. Result = the driver's CaptureReport verbatim (plus the
 * dedup markers): refusals (`target_checked_out` | `target_moved` |
 * `no_cell_head`) and conflicts are RESULTS, never `ok:false` errors, so a
 * replayed key returns the same report. A failed land leaves the origin's
 * ref set bit-identical (A1). Errors: `bee_not_found`; `invalid_request`
 * for a bee that is not on the cell substrate / a bad mode.
 */
export type CellCaptureMode = "merge" | "rebase";

/**
 * Cell results carry their OWN `status` (the report outcome), so they take
 * only the `deduped` replay marker — withIdempotency never overlays the
 * command status onto a result that already has a status of its own.
 */
export interface CellDedupMarker {
  deduped?: boolean;
}

/** `cell.capture` params. */
export interface CellCaptureParams {
  beeId: string;
  /** Branch in the origin to land onto (created if absent). */
  targetBranch: string;
  mode: CellCaptureMode;
  idempotencyKey?: string;
}

export interface CellCaptureResult extends CellDedupMarker {
  status: "landed" | "nothing_to_capture" | "conflict" | "refused";
  targetBranch: string;
  mode: CellCaptureMode;
  /** The cell HEAD that was captured. */
  cellHead: string | null;
  /** The target tip the operation started from (null = branch created). */
  baseTarget: string | null;
  /** The commit the target branch now points at (landed only). */
  resultSha: string | null;
  /** Conflicted paths (conflict only) — staged for the operator, never auto-resolved. */
  conflicts: string[];
  /** Refusal reason (refused only). */
  reason: "target_checked_out" | "target_moved" | "no_cell_head" | null;
}

/** The driver's DirtyReport verbatim (A2 — the three causes). */
export interface CellDirtyReport {
  dirty: boolean;
  /** Uncommitted working-tree changes in the space. */
  uncommitted: boolean;
  /** Cell HEAD commits the origin repo does not contain. */
  unpushed: boolean;
  /** The origin could not be consulted (missing/moved) — treated as dirty. */
  originUnknown: boolean;
}

/**
 * `cell.remove` — params `{ beeId, force?, idempotencyKey? }`. `deleted` =
 * the cell directory is gone AND the bee's lifecycle `delete` was enqueued
 * in the same call (`commandId`); `refused` = dirty without force (report
 * carries the causes; nothing changed; `commandId` null); `absent` = no
 * cell on disk (bee delete still enqueued). A bee with a live runtime is
 * `runtime_refused` (stop it first); a non-cell bee is `invalid_request`.
 */
/** `cell.remove` params. `force` = the `--force` equivalent (A2). */
export interface CellRemoveParams {
  beeId: string;
  force?: boolean;
  idempotencyKey?: string;
}

export interface CellRemoveResult extends CellDedupMarker {
  status: "deleted" | "refused" | "absent";
  forced: boolean;
  report: CellDirtyReport | null;
  /** The lifecycle delete command (deleted | absent). */
  commandId: number | null;
}

export class RpcError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}
