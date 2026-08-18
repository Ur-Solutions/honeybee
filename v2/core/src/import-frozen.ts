/**
 * `hive v2 import --from-frozen` — the WP7 importer (spec 07 B3/B4, §F).
 *
 * Brings the operator's ACTIVE old-world bees into the v2 store as records +
 * history: identity, name, tags, cwd, title, session-log pointer and — the
 * continuity guarantee — the harness-native provider session id, stored where
 * the daemon's revive path hands it back to the harness (claude `--resume`,
 * codex `thread/resume`). Runtimes are NOT migrated (runtime death is
 * uninteresting by contract; bees revive on message).
 *
 * Reads `<frozenRoot>/sessions/*.json` (the old SessionRecord json files) and
 * `<frozenRoot>/hsr/<name>/meta.json` (only as a fallback source for the
 * session id + live-pid preflight). Never writes into the frozen root.
 *
 * Old record knowledge is re-encoded here from reading src/store.ts
 * (SessionRecord), src/drivers.ts (homeEnv table) and src/hsr/runDir.ts
 * (meta.json) — no old code is imported.
 *
 * Selection (operator ruling, B4: "no zombie rows, no dead history"):
 *   import  — status "running", not archived, with something to continue or a
 *             runtime that was live/ready at freeze time
 *   skip    — done/dead (history), kill_failed (parked; stays in the frozen
 *             store), archived lifecycle, remote-node records, records with
 *             a terminal last observation AND no session id / transcript
 *             (zombie: nothing to continue), unusable/unparsable records,
 *             agents the v2 node cannot run, a cwd that no longer exists on
 *             this node (revive could not spawn — recreate it and re-run), and
 *             ids already present (idempotent re-run).
 *
 * Preflight (A2): refuses while old-world runtimes are live — the frozen
 * store's daemon lock pid, HSR host/child pids and tmux launcher pgids the
 * records point at, verified by pid + start-time through injected probes (the
 * daemon supplies real ones; tests supply fakes). `force` overrides.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreStore } from "./store.ts";

/** Marker file `hive v2 freeze` writes at the frozen root (B3). */
export const FROZEN_MARKER = "FROZEN";

/** Old-world harness → the env var that relocates its config/session home (src/drivers.ts homeEnv). */
export const HARNESS_HOME_ENV: Readonly<Record<string, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  opencode: "OPENCODE_CONFIG_DIR",
  grok: "GROK_HOME",
  kimi: "KIMI_CODE_HOME",
  cursor: "CURSOR_CONFIG_DIR",
};

/** Old-world harnesses with a v2 harness-native resume path (spec 07 §F). */
export const RESUME_CAPABLE_HARNESSES: readonly string[] = ["claude", "codex"];

/** Old `lastObservedState` spellings that mean "no live runtime" (src/store.ts TERMINAL_OBSERVED_STATES + crashed/wedged). */
const TERMINAL_OBSERVED = new Set(["dead", "crashed", "done", "sealed", "archived", "retired", "killed", "wedged"]);

export const SKIP_REASONS = [
  "unparsable",
  "unusable_record",
  "archived",
  "done",
  "kill_failed",
  "remote_node",
  "zombie_no_history",
  "unsupported_agent",
  "cwd_missing",
  "already_imported",
  "id_collision",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** How an imported bee will come back when messaged (exact, per harness). */
export type ResumeMode =
  /** harness-native resume with the recorded provider session id */
  | "harness_native"
  /** the harness could resume, but the record carries no session id → fresh runtime on the same session log */
  | "fresh_no_session_id"
  /** the v2 adapter has no resume path for this harness → fresh runtime */
  | "fresh_no_resume_path";

/** The subset of the old SessionRecord the importer reads (see src/store.ts). */
export interface FrozenRecord {
  path: string;
  id: string;
  name: string;
  agent: string;
  cwd: string;
  status: string;
  substrate: string | null;
  title: string | null;
  tags: string[];
  providerSessionId: string | null;
  transcriptPath: string | null;
  homePath: string | null;
  accountId: string | null;
  lastObservedState: string | null;
  lifecycle: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  node: string | null;
  model: string | null;
  runtimeGeneration: number | null;
  /** Old-world process identities (HSR runner host / tmux launcher) for the preflight. */
  runnerPid: number | null;
  runnerStartedAt: number | null;
  launcherPgid: number | null;
  launcherStartedAt: number | null;
  tmuxTarget: string | null;
}

export interface FrozenReadResult {
  records: FrozenRecord[];
  /** Files that could not be read as a usable record (path → reason; whatever identity was legible). */
  unreadable: Array<{ path: string; reason: SkipReason; detail: string; id: string | null; name: string | null; agent: string | null }>;
}

export interface ImportPlanEntry {
  path: string;
  originalId: string;
  name: string;
  agent: string;
  action: "import" | "skip";
  reason: SkipReason | null;
  resume: ResumeMode | null;
  /** The v2 bee this record maps to (null when skipped before mapping). */
  bee: FrozenBeeInput | null;
  /** Human-readable notes (e.g. substrate mapping, session id source). */
  notes: string[];
}

/** The createBee input + provenance the importer derives from one record. */
export interface FrozenBeeInput {
  id: string;
  name: string;
  agent: string;
  substrate: string;
  cwd: string;
  title: string | undefined;
  tags: string[];
  sessionLogPath: string | undefined;
  providerSessionId: string | undefined;
  env: Record<string, string>;
  createdAt: number | undefined;
  provenance: Record<string, unknown>;
}

export interface FrozenImportPlan {
  frozenRoot: string;
  entries: ImportPlanEntry[];
  counts: { import: number; skip: number; byReason: Partial<Record<SkipReason, number>>; byResume: Partial<Record<ResumeMode, number>> };
}

/** One live old-world runtime the preflight found. */
export interface LiveOldRuntime {
  kind: "old_daemon" | "hsr_host" | "hsr_child" | "tmux_launcher" | "tmux_session";
  detail: string;
  pid: number | null;
  beeId: string | null;
}

export interface PreflightProbes {
  /**
   * True when `pid` is alive AND (start time unknown OR within tolerance of
   * `startedAtMs`). A null `startedAtMs` means "no stamp to verify" — alive
   * suffices. Conservative: unverifiable-but-alive counts as live.
   */
  pidLive(pid: number, startedAtMs: number | null): boolean;
  /** True when a tmux session named `target` exists (best-effort; false when tmux is absent). */
  tmuxSessionLive(target: string): boolean;
}

export interface PreflightResult {
  frozenRoot: string;
  markerPresent: boolean;
  live: LiveOldRuntime[];
  ok: boolean;
}

export interface FrozenImportOptions {
  /** Report only; write nothing. Preflight still runs and is reported. */
  dryRun?: boolean;
  /** Import even when the preflight found live old-world runtimes (A2 override). */
  force?: boolean;
  /** Agents the v2 node can spawn (daemon: Object.keys(cfg.agents)); absent = accept all. */
  knownAgents?: readonly string[];
  /** Process/tmux probes (the daemon supplies real ones). Absent = preflight cannot see runtimes → treated as none live. */
  probes?: PreflightProbes;
  now?: () => number;
}

export interface FrozenImportReport {
  frozenRoot: string;
  dryRun: boolean;
  /** False when the import was refused (marker missing / preflight); `refusal` says why. */
  applied: boolean;
  refusal: string | null;
  preflight: PreflightResult;
  plan: FrozenImportPlan;
  imported: Array<{ beeId: string; name: string; agent: string; resume: ResumeMode }>;
}

// ---------------------------------------------------------------------------
// reading the frozen store
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isoMs(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Old ProcessBirthFingerprint.startedAt is `ps lstart` text ("Mon Aug 17 06:41:42 2026") — parseable by Date. */
function fingerprintMs(fp: unknown): number | null {
  if (!fp || typeof fp !== "object") return null;
  const started = (fp as Record<string, unknown>).startedAt;
  return isoMs(started);
}

/** Parse one old SessionRecord json object into the importer's view of it. */
export type ParsedFrozenRecord =
  | { record: FrozenRecord }
  | { reason: SkipReason; detail: string; id: string | null; name: string | null; agent: string | null };

export function parseFrozenRecord(path: string, raw: unknown): ParsedFrozenRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { reason: "unparsable", detail: "not a json object", id: null, name: null, agent: null };
  }
  const r = raw as Record<string, unknown>;
  const name = str(r.name);
  const agent = str(r.agent);
  const cwd = str(r.cwd);
  const status = str(r.status);
  const id = str(r.id) ?? str(r.uuid) ?? name;
  if (!name || !agent || !cwd || !status || !id) {
    const missing = [!name && "name", !agent && "agent", !cwd && "cwd", !status && "status", !id && "id"].filter(Boolean).join(",");
    return { reason: "unusable_record", detail: `missing ${missing}`, id, name, agent };
  }
  const sm = r.stateMachine && typeof r.stateMachine === "object" ? (r.stateMachine as Record<string, unknown>) : {};
  const tags = Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  return {
    record: {
      path,
      id,
      name,
      agent,
      cwd,
      status,
      substrate: str(r.substrate),
      title: str(r.title),
      tags,
      providerSessionId: str(r.providerSessionId),
      transcriptPath: str(r.transcriptPath),
      homePath: str(r.homePath),
      accountId: str(r.accountId),
      lastObservedState: str(r.lastObservedState),
      lifecycle: str(sm.lifecycle),
      createdAt: isoMs(r.createdAt),
      updatedAt: isoMs(r.updatedAt),
      node: str(r.node),
      model: str(r.model),
      runtimeGeneration: num(r.runtimeGeneration),
      runnerPid: num(r.runnerPid),
      runnerStartedAt: fingerprintMs(r.runnerFingerprint),
      launcherPgid: num(r.launcherPgid),
      launcherStartedAt: fingerprintMs(r.launcherFingerprint),
      tmuxTarget: str(r.tmuxTarget),
    },
  };
}

/** Read every `<root>/sessions/*.json`. Read-only; per-file failures are reported, never thrown. */
export function readFrozenSessions(frozenRoot: string): FrozenReadResult {
  const dir = join(frozenRoot, "sessions");
  const out: FrozenReadResult = { records: [], unreadable: [] };
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      out.unreadable.push({ path, reason: "unparsable", detail: err instanceof Error ? err.message : String(err), id: null, name: null, agent: null });
      continue;
    }
    const parsed = parseFrozenRecord(path, raw);
    if ("record" in parsed) out.records.push(parsed.record);
    else out.unreadable.push({ path, reason: parsed.reason, detail: parsed.detail, id: parsed.id, name: parsed.name, agent: parsed.agent });
  }
  return out;
}

/** HSR run-dir meta (old src/hsr/runDir.ts): host/child pids + the harness session id. */
export interface HsrMeta {
  hostPid: number | null;
  hostStartedAt: number | null;
  childPid: number | null;
  childStartedAt: number | null;
  sessionId: string | null;
}

export function readHsrMeta(frozenRoot: string, beeName: string): HsrMeta | null {
  const path = join(frozenRoot, "hsr", beeName, "meta.json");
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      hostPid: num(m.hostPid),
      hostStartedAt: fingerprintMs(m.hostFingerprint),
      childPid: num(m.childPid),
      childStartedAt: fingerprintMs(m.childFingerprint),
      sessionId: str(m.sessionId),
    };
  } catch {
    return null;
  }
}

/** The old daemon lock (`<root>/daemon/daemon.lock`: {pid, startedAt ISO, …}). */
export function readOldDaemonLock(frozenRoot: string): { pid: number; startedAt: number | null } | null {
  const path = join(frozenRoot, "daemon", "daemon.lock");
  if (!existsSync(path)) return null;
  try {
    const l = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const pid = num(l.pid);
    if (pid == null) return null;
    return { pid, startedAt: isoMs(l.startedAt) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// planning (pure)
// ---------------------------------------------------------------------------

/** Old substrate value → v2 substrate (contract §1: tmux | hsr | cell). */
export function mapSubstrate(old: string | null): string {
  if (old === "hsr") return "hsr";
  // Absent = local-tmux in the old system (back-compat default), "local-tmux" explicit.
  return "tmux";
}

export function resumeModeFor(agent: string, providerSessionId: string | null): ResumeMode {
  if (!RESUME_CAPABLE_HARNESSES.includes(agent)) return "fresh_no_resume_path";
  return providerSessionId ? "harness_native" : "fresh_no_session_id";
}

/** Map one active old record to a v2 createBee input + provenance payload. */
export function mapFrozenRecord(record: FrozenRecord, frozenRoot: string, meta: HsrMeta | null): { bee: FrozenBeeInput; notes: string[] } {
  const notes: string[] = [];
  let providerSessionId = record.providerSessionId;
  if (!providerSessionId && meta?.sessionId) {
    providerSessionId = meta.sessionId;
    notes.push("provider session id taken from hsr/<name>/meta.json (record lacked it)");
  }
  const substrate = mapSubstrate(record.substrate);
  if (substrate !== (record.substrate ?? "local-tmux")) notes.push(`substrate ${record.substrate ?? "(absent=local-tmux)"} → ${substrate}`);
  const env: Record<string, string> = {};
  const homeEnv = HARNESS_HOME_ENV[record.agent];
  if (record.homePath && homeEnv) {
    env[homeEnv] = record.homePath;
    notes.push(`${homeEnv}=${record.homePath}`);
  } else if (record.homePath) {
    notes.push(`homePath ${record.homePath} not applied: no known home env var for agent ${record.agent}`);
  }
  if (record.agent === "claude" && substrate === "tmux" && providerSessionId) {
    notes.push("claude interactive (tmux) session → headless resume is unverified (old finding: the two claude session stores are disjoint)");
  }
  const bee: FrozenBeeInput = {
    id: record.id,
    name: record.name,
    agent: record.agent,
    substrate,
    cwd: record.cwd,
    title: record.title ?? undefined,
    tags: record.tags,
    sessionLogPath: record.transcriptPath ?? undefined,
    providerSessionId: providerSessionId ?? undefined,
    env,
    createdAt: record.createdAt ?? undefined,
    provenance: {
      imported_from: "frozen",
      frozenRoot,
      recordPath: record.path,
      originalId: record.id,
      originalName: record.name,
      agent: record.agent,
      substrate: record.substrate,
      status: record.status,
      lastObservedState: record.lastObservedState,
      lifecycle: record.lifecycle,
      providerSessionId: providerSessionId,
      providerSessionIdSource: record.providerSessionId ? "record" : providerSessionId ? "hsr_meta" : null,
      transcriptPath: record.transcriptPath,
      homePath: record.homePath,
      accountId: record.accountId,
      model: record.model,
      runtimeGeneration: record.runtimeGeneration,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
  return { bee, notes };
}

export interface PlanContext {
  frozenRoot: string;
  knownAgents?: readonly string[];
  /** Whether a bee cwd exists on this node (default: fs check). Injectable for pure tests. */
  cwdExists?: (cwd: string) => boolean;
  /** Existing v2 bees by id → importedFrom marker (null = v2-born). */
  existing: (id: string) => { importedFrom: string | null } | null;
  hsrMeta: (beeName: string) => HsrMeta | null;
}

/** Decide import/skip (+ reason, resume mode) for every record. Pure given the context functions. */
export function planFrozenImport(read: FrozenReadResult, ctx: PlanContext): FrozenImportPlan {
  const entries: ImportPlanEntry[] = [];
  const skip = (path: string, originalId: string, name: string, agent: string, reason: SkipReason, note?: string): ImportPlanEntry => ({
    path,
    originalId,
    name,
    agent,
    action: "skip",
    reason,
    resume: null,
    bee: null,
    notes: note ? [note] : [],
  });
  for (const u of read.unreadable) entries.push(skip(u.path, u.id ?? "?", u.name ?? "?", u.agent ?? "?", u.reason, u.detail));
  for (const r of read.records) {
    if (r.lifecycle === "archived") {
      entries.push(skip(r.path, r.id, r.name, r.agent, "archived"));
      continue;
    }
    if (r.status === "done" || r.status === "dead") {
      entries.push(skip(r.path, r.id, r.name, r.agent, "done", `status ${r.status}`));
      continue;
    }
    if (r.status === "kill_failed") {
      entries.push(skip(r.path, r.id, r.name, r.agent, "kill_failed", "parked in the frozen store (operator ruling)"));
      continue;
    }
    if (r.status !== "running") {
      entries.push(skip(r.path, r.id, r.name, r.agent, "unusable_record", `unknown status ${r.status}`));
      continue;
    }
    if (r.node) {
      entries.push(skip(r.path, r.id, r.name, r.agent, "remote_node", `owned by node ${r.node}`));
      continue;
    }
    const meta = ctx.hsrMeta(r.name);
    const sessionId = r.providerSessionId ?? meta?.sessionId ?? null;
    if (r.lastObservedState && TERMINAL_OBSERVED.has(r.lastObservedState) && !sessionId && !r.transcriptPath) {
      entries.push(skip(r.path, r.id, r.name, r.agent, "zombie_no_history", `last observed ${r.lastObservedState}, no session id, no transcript`));
      continue;
    }
    if (ctx.knownAgents && !ctx.knownAgents.includes(r.agent)) {
      entries.push(skip(r.path, r.id, r.name, r.agent, "unsupported_agent", `no v2 agent spec/adapter for '${r.agent}'`));
      continue;
    }
    if (!(ctx.cwdExists ?? existsSync)(r.cwd)) {
      entries.push(skip(r.path, r.id, r.name, r.agent, "cwd_missing", `cwd ${r.cwd} does not exist on this node — recreate it and re-run (idempotent)`));
      continue;
    }
    const existing = ctx.existing(r.id);
    if (existing) {
      entries.push(
        existing.importedFrom === "frozen"
          ? skip(r.path, r.id, r.name, r.agent, "already_imported", "same id already in the v2 store (re-run is a no-op)")
          : skip(r.path, r.id, r.name, r.agent, "id_collision", "a v2-born bee already holds this id"),
      );
      continue;
    }
    const { bee, notes } = mapFrozenRecord(r, ctx.frozenRoot, meta);
    const resume = resumeModeFor(r.agent, bee.providerSessionId ?? null);
    entries.push({ path: r.path, originalId: r.id, name: r.name, agent: r.agent, action: "import", reason: null, resume, bee, notes });
  }
  const counts: FrozenImportPlan["counts"] = { import: 0, skip: 0, byReason: {}, byResume: {} };
  for (const e of entries) {
    if (e.action === "import") {
      counts.import += 1;
      if (e.resume) counts.byResume[e.resume] = (counts.byResume[e.resume] ?? 0) + 1;
    } else {
      counts.skip += 1;
      if (e.reason) counts.byReason[e.reason] = (counts.byReason[e.reason] ?? 0) + 1;
    }
  }
  return { frozenRoot: ctx.frozenRoot, entries, counts };
}

// ---------------------------------------------------------------------------
// preflight (A2)
// ---------------------------------------------------------------------------

/**
 * Find live old-world runtimes: the frozen store's daemon (lock pid), every
 * candidate record's HSR host/child pids (record + hsr meta) and tmux
 * launcher pgid / session. Only ACTIVE candidates are probed — a parked
 * kill_failed row's stale pid is not this import's business.
 */
export function preflightFrozen(
  frozenRoot: string,
  read: FrozenReadResult,
  probes: PreflightProbes | undefined,
  hsrMeta: (beeName: string) => HsrMeta | null,
): PreflightResult {
  const live: LiveOldRuntime[] = [];
  const markerPresent = existsSync(join(frozenRoot, FROZEN_MARKER));
  if (!probes) return { frozenRoot, markerPresent, live, ok: true };
  const lock = readOldDaemonLock(frozenRoot);
  if (lock && probes.pidLive(lock.pid, lock.startedAt)) {
    live.push({ kind: "old_daemon", detail: `old daemon pid ${lock.pid} is alive (${join(frozenRoot, "daemon", "daemon.lock")})`, pid: lock.pid, beeId: null });
  }
  for (const r of read.records) {
    if (r.status !== "running") continue; // parked/dead rows are not this import's business
    const seen = new Set<number>();
    const probe = (kind: LiveOldRuntime["kind"], pid: number | null, startedAt: number | null, what: string): void => {
      if (pid == null || pid <= 0 || seen.has(pid)) return;
      seen.add(pid);
      if (probes.pidLive(pid, startedAt)) live.push({ kind, detail: `${what} pid ${pid} is alive (bee ${r.id} ${r.name})`, pid, beeId: r.id });
    };
    probe("hsr_host", r.runnerPid, r.runnerStartedAt, "hsr runner");
    const meta = hsrMeta(r.name);
    if (meta) {
      probe("hsr_host", meta.hostPid, meta.hostStartedAt, "hsr host");
      probe("hsr_child", meta.childPid, meta.childStartedAt, "hsr child");
    }
    probe("tmux_launcher", r.launcherPgid, r.launcherStartedAt, "tmux launcher");
    if (r.tmuxTarget && r.substrate !== "hsr" && probes.tmuxSessionLive(r.tmuxTarget)) {
      live.push({ kind: "tmux_session", detail: `tmux session '${r.tmuxTarget}' exists (bee ${r.id} ${r.name})`, pid: null, beeId: r.id });
    }
  }
  return { frozenRoot, markerPresent, live, ok: live.length === 0 };
}

// ---------------------------------------------------------------------------
// freeze (B3) — the ONE write into the old root, and it is the operator's
// ---------------------------------------------------------------------------

export interface FreezeOptions {
  probes?: PreflightProbes;
  /** Freeze even if the old daemon lock pid is alive. */
  force?: boolean;
  now?: () => number;
  /** Written into the marker for forensics (hostname, pid, cli). */
  by?: string;
}

export interface FreezeResult {
  frozenRoot: string;
  markerPath: string;
  /** "written" | "already_frozen" | "refused" */
  outcome: "written" | "already_frozen" | "refused";
  refusal: string | null;
}

/**
 * `hive v2 freeze <root>`: mark the old-world store frozen by writing
 * `<root>/FROZEN` (json: frozenAt, by). Refuses while the old daemon is alive
 * (its lock pid verified by pid + start-time), unless `force`. Idempotent —
 * an existing marker is left untouched. Nothing else in the root is written.
 */
export function freezeRoot(frozenRoot: string, opts: FreezeOptions = {}): FreezeResult {
  const markerPath = join(frozenRoot, FROZEN_MARKER);
  if (!existsSync(frozenRoot) || !existsSync(join(frozenRoot, "sessions"))) {
    return { frozenRoot, markerPath, outcome: "refused", refusal: `no old-world store at ${frozenRoot} (expected <root>/sessions/)` };
  }
  if (existsSync(markerPath)) return { frozenRoot, markerPath, outcome: "already_frozen", refusal: null };
  const lock = readOldDaemonLock(frozenRoot);
  if (lock && opts.probes && !opts.force && opts.probes.pidLive(lock.pid, lock.startedAt)) {
    return {
      frozenRoot,
      markerPath,
      outcome: "refused",
      refusal: `old daemon pid ${lock.pid} is alive (${join(frozenRoot, "daemon", "daemon.lock")}) — stop it first (\`hive daemon stop\`) or pass --force`,
    };
  }
  const now = opts.now ?? Date.now;
  writeFileSync(
    markerPath,
    `${JSON.stringify({ frozenAt: new Date(now()).toISOString(), by: opts.by ?? "hive v2 freeze", note: "old-world store frozen for the v2 cutover (spec 07 B3); files stay readable; remove this marker to unfreeze (rollback §C)" }, null, 2)}\n`,
    { flag: "wx" },
  );
  return { frozenRoot, markerPath, outcome: "written", refusal: null };
}

// ---------------------------------------------------------------------------
// the importer
// ---------------------------------------------------------------------------

/**
 * Import active old-world bees from a frozen root into the v2 store. Refuses
 * (report.applied=false, report.refusal set) when the FROZEN marker is absent
 * or the preflight finds live old-world runtimes (unless `force`). Idempotent:
 * ids are preserved, so a re-run skips everything as `already_imported`.
 * Every write is one store transaction per bee: createBee (with the provider
 * session id, env, provenance) → runtime 1 stopped(stopped_by_system) (the
 * old runtime is gone by definition; revive mints generation 2) → the
 * `bee.imported` audit row.
 */
export function importFromFrozen(store: CoreStore, frozenRoot: string, opts: FrozenImportOptions = {}): FrozenImportReport {
  const dryRun = opts.dryRun === true;
  const read = readFrozenSessions(frozenRoot);
  const hsrMeta = (name: string): HsrMeta | null => readHsrMeta(frozenRoot, name);
  const plan = planFrozenImport(read, {
    frozenRoot,
    knownAgents: opts.knownAgents,
    existing: (id) => {
      const bee = store.getBee(id);
      return bee ? { importedFrom: bee.importedFrom } : null;
    },
    hsrMeta,
  });
  const preflight = preflightFrozen(frozenRoot, read, opts.probes, hsrMeta);
  const report: FrozenImportReport = { frozenRoot, dryRun, applied: false, refusal: null, preflight, plan, imported: [] };

  if (!existsSync(frozenRoot) || !existsSync(join(frozenRoot, "sessions"))) {
    report.refusal = `no old-world store at ${frozenRoot} (expected <root>/sessions/)`;
    return report;
  }
  if (!preflight.markerPresent) {
    report.refusal = `${join(frozenRoot, FROZEN_MARKER)} is missing — run \`hive v2 freeze --root ${frozenRoot}\` first (B3: stop the old daemon, mark the store frozen)`;
    return report;
  }
  if (!preflight.ok && !opts.force) {
    report.refusal =
      `old-world runtimes are still live (${preflight.live.length}); stop them (B1 quiesce) or re-run with --force:\n` +
      preflight.live.map((l) => `  - ${l.detail}`).join("\n");
    return report;
  }
  if (dryRun) return report;

  const now = opts.now ?? Date.now;
  for (const entry of plan.entries) {
    if (entry.action !== "import" || !entry.bee) continue;
    const b = entry.bee;
    store.transact(() => {
      store.createBee({
        id: b.id,
        name: b.name,
        agent: b.agent,
        substrate: b.substrate,
        cwd: b.cwd,
        title: b.title,
        tags: b.tags,
        sessionLogPath: b.sessionLogPath,
        providerSessionId: b.providerSessionId,
        env: b.env,
        importedFrom: "frozen",
        createdAt: b.createdAt,
      });
      // The old runtime is not migrated (contract: runtime death is uninteresting).
      // Generation 1 exists only so revive-on-message mints generation 2 cleanly.
      store.updateRuntimeState(b.id, 1, "stopped", { exitCause: "stopped_by_system" });
      store.recordImportProvenance(b.id, { ...b.provenance, importedAt: now(), resume: entry.resume });
    });
    report.imported.push({ beeId: b.id, name: b.name, agent: b.agent, resume: entry.resume ?? "fresh_no_resume_path" });
  }
  report.applied = true;
  return report;
}
