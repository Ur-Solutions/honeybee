/**
 * The thin v2 CLI (spec 04 "CLI"). Ships inside the existing `hive` binary as
 * `hive v2 <verb>` (src/cli.ts routes here) and as a standalone bin for tests.
 *
 * - Mutations and watch go through RPC ONLY.
 * - Reads fall back to the read-only store when the daemon is down; that
 *   output is clearly labeled stale (human: a STALE banner line on stderr and
 *   a `stale:` prefix column; json: `"stale": true`).
 * - `send --wait` (Q3 resolution): send returns the command/message ids
 *   immediately by default; --wait blocks until the delivery mark.
 * - `daemon install|start|stop|status` wraps the platform service layer.
 */
import { execFile, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultDataDir, loadNodeConfig, type ResolvedNodeConfig } from "../../daemon/src/config.ts";
import { runDaemon } from "../../daemon/src/main.ts";
import {
  createServiceManager,
  type ExecRunner,
  type ServiceManager,
} from "../../daemon/src/service.ts";
import { readFileSync, writeFileSync } from "node:fs";
import {
  RpcError,
  type AccountAddResult,
  type AccountBackfillResult,
  type AccountGetResult,
  type AccountImportRegistryResult,
  type AccountLimitsResult,
  type AccountListResult,
  type AccountLoginResult,
  type AccountRemoveResult,
  type AccountUpdateResult,
  type SwapAccountResult,
  type ChildrenResult,
  type ForkResult,
  type HealthResult,
  type InterruptResult,
  type ListResult,
  type MailboxResult,
  type CommandsResult,
  type CellCaptureResult,
  type CellRemoveResult,
  type QuestionAnswerResult,
  type QuestionAskResult,
  type QuestionListResult,
  type RenameResult,
  type SealCreateResult,
  type SealGetResult,
  type SealListResult,
  type SendRpcResult,
  type SnapshotResult,
  type SetArgsResult,
  type SpawnResult,
  type TagResult,
  type ImportFromFrozenResult,
  type ImportLocalConfigResult,
  type TemplateDeleteResult,
  type TemplateExportResult,
  type TemplateGetResult,
  type TemplateImportResult,
  type TemplateListResult,
  type TemplatePutResult,
  type TrackDeleteResult,
  type TrackExportResult,
  type TrackGetResult,
  type TrackImportResult,
  type TrackListResult,
  type TrackPutResult,
  type ViewResult,
  type WatchFrame,
} from "../../daemon/src/protocol.ts";
import { DaemonDownError, RpcClient } from "./client.ts";
import { ReadOnlyStore } from "./readonly.ts";
import { freezeRoot, type AuditRow, type FrozenImportReport, type ImportPlanEntry } from "../../core/src/index.ts";
import { realPreflightProbes } from "../../daemon/src/import-probes.ts";
import { hostname } from "node:os";
import type { AuditTailResult } from "../../daemon/src/protocol.ts";
import {
  lastAssistantText,
  renderTranscriptLines,
  type TranscriptTurn,
} from "../../driver-tmux/src/transcripts.ts";
import { sessionNameFor } from "../../driver-tmux/src/driver.ts";
import {
  claudeArgGrammar,
  codexArgGrammar,
  composeArgv,
  parseArgUnits,
  type ArgGrammar,
} from "../../adapters/src/args.ts";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  tags: string[];
  /** `--arg <x>` (repeatable): per-bee spawn args. */
  args: string[];
  /** Other repeatable value flags (v6): --add, --remove, --option, --ref. */
  lists: Map<string, string[]>;
  /** Everything after a bare `--`, verbatim (bee set-args). Null when no `--` was given. */
  rest: string[] | null;
}

/** Repeatable value flags collected into `lists` (v6 verbs). */
const LIST_FLAGS = new Set(["--add", "--remove", "--option", "--ref"]);

const VALUE_FLAGS = new Set([
  "--agent",
  "--cwd",
  "--title",
  "--tag",
  "--sender",
  "--urgency",
  "--timeout",
  "--lifecycle",
  "--bee",
  "--data-dir",
  "--config",
  "--socket",
  "--scope",
  "--source",
  "--file",
  "--out",
  "--dir",
  "--id",
  "--idempotency-key",
  "--root",
  "--arg",
  "--substrate",
  "--origin",
  "--sha",
  "--warm",
  "--onto",
  // v6
  "--parent",
  "--name",
  "--prompt",
  "--body",
  "--by",
  // v7 (accounts)
  "--account",
  "--home",
  "--penalty",
  "--harness",
  // CLI alignment (v1 reading/sugar verbs)
  "--kind",
  "--tail",
  "--idle-ms",
  // buz compatibility (contract B4a)
  "--tier",
  "--sender-human",
  ...LIST_FLAGS,
]);

/**
 * Flags taking an OPTIONAL value: `--warm dirs` or bare `--warm` (the cell
 * usage documents both). Bare form must not swallow the next token.
 */
const OPTIONAL_VALUE_FLAGS = new Set(["--warm"]);

/**
 * Every boolean flag the CLI understands. Kept explicit (with VALUE_FLAGS) so
 * an unknown flag is a LOUD error instead of a silently-ignored no-op: the
 * 2026-08-19 soak lost a spawn to `--substarte cell`, which parsed as an
 * unknown boolean plus a stray positional and quietly spawned an hsr claude.
 */
const BOOL_FLAGS = new Set([
  "--json",
  "--all",
  "--archived",
  "--verbose",
  "--dry-run",
  "--force",
  "--wait",
  "--follow",
  "--no-follow",
  "--raw",
  "--keep",
  "--seal",
  "--print",
  "--open",
  "--clear",
  "--rebase",
  "--from-frozen",
  "--no-parent",
  "--sandbox",
  "--no-sandbox",
]);

const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOL_FLAGS, ...OPTIONAL_VALUE_FLAGS]);

/** Cheap edit distance, for "did you mean --substrate?" on a typo. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] as number) + 1, (prev[j] as number) + 1, (prev[j - 1] as number) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] as number;
  }
  return prev[b.length] as number;
}

function unknownFlagError(flag: string): Error {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const known of KNOWN_FLAGS) {
    const d = editDistance(flag, known);
    if (d < bestScore) {
      bestScore = d;
      best = known;
    }
  }
  const hint = best && bestScore <= 3 ? ` — did you mean ${best}?` : "";
  return new Error(`unknown flag: ${flag}${hint}`);
}

/** Short-flag aliases (v1 ergonomics), expanded before classification. */
const SHORT_ALIASES: Record<string, string> = {
  "-p": "--prompt",
  "-n": "--tail",
  "-f": "--follow",
};

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const tags: string[] = [];
  const args: string[] = [];
  const lists = new Map<string, string[]>();
  let rest: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    if (raw === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    const a = SHORT_ALIASES[raw] ?? raw;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (!KNOWN_FLAGS.has(a)) throw unknownFlagError(raw);
    if (OPTIONAL_VALUE_FLAGS.has(a)) {
      // Value only when the next token is not another flag.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags.set(a, true);
      else flags.set(a, argv[++i] as string);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      if (a === "--tag") tags.push(v);
      else if (a === "--arg") args.push(v);
      else if (LIST_FLAGS.has(a)) lists.set(a, [...(lists.get(a) ?? []), v]);
      else flags.set(a, v);
    } else {
      flags.set(a, true);
    }
  }
  return { positional, flags, tags, args, lists, rest };
}

/**
 * v6 — the bee the CURRENT process runs inside, when it is a bee: the
 * HIVE_BEE_ID stamp the daemon puts on every runtime env. `hive v2 ask` /
 * `seal` default their bee to it; `spawn` fills `parentId` from it.
 */
function selfBeeId(env: Record<string, string | undefined> = process.env): string | null {
  const id = env.HIVE_BEE_ID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

interface CliContext {
  cfg: ResolvedNodeConfig;
  io: CliIo;
  json: boolean;
}

function makeContext(parsed: Parsed, io: CliIo): CliContext {
  const dataDir = (parsed.flags.get("--data-dir") as string | undefined) ?? defaultDataDir();
  let cfg = loadNodeConfig(dataDir, parsed.flags.get("--config") as string | undefined);
  const socket = parsed.flags.get("--socket") as string | undefined;
  if (socket) cfg = { ...cfg, socketPath: socket };
  return { cfg, io, json: parsed.flags.get("--json") === true };
}

// ---------------------------------------------------------------------------
// bee resolution ladder (v10): exact id → exact handle (case-insensitive) →
// exact name → unique prefix of any of those. Ambiguity is a loud, listing
// error — never a guess.
// ---------------------------------------------------------------------------

function beeLabel(b: { id: string; handle: string | null; name: string }): string {
  return b.handle ? `${b.handle} (${b.name})` : `${b.id} (${b.name})`;
}

export function resolveBeeIn(views: ViewResult[], needle: string): string {
  const byId = views.find((v) => v.bee?.id === needle);
  if (byId?.bee) return byId.bee.id;
  const lower = needle.toLowerCase();
  const byHandle = views.find((v) => v.bee?.handle?.toLowerCase() === lower);
  if (byHandle?.bee) return byHandle.bee.id;
  const byName = views.filter((v) => v.bee?.name === needle);
  if (byName.length === 1 && byName[0]?.bee) return byName[0].bee.id;
  if (byName.length > 1) throw new Error(`bee name '${needle}' is ambiguous (${byName.length} matches) — use the handle or id`);
  // Prefix tier: 3+ chars so a stray letter never resolves by accident.
  if (needle.length >= 3) {
    const prefixed = views.filter((v) => {
      const b = v.bee;
      if (!b) return false;
      return b.id.startsWith(needle) || (b.handle != null && b.handle.toLowerCase().startsWith(lower)) || b.name.startsWith(needle);
    });
    if (prefixed.length === 1 && prefixed[0]?.bee) return prefixed[0].bee.id;
    if (prefixed.length > 1) {
      const listed = prefixed
        .slice(0, 6)
        .map((v) => (v.bee ? beeLabel(v.bee) : "?"))
        .join(", ");
      throw new Error(
        `'${needle}' is ambiguous (${prefixed.length} matches: ${listed}${prefixed.length > 6 ? ", …" : ""}) — add characters or use the handle/id`,
      );
    }
  }
  throw new RpcError("bee_not_found", `bee not found: ${needle}`);
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function viewLine(v: ViewResult, stale: boolean): string {
  const bee = v.bee;
  const flags = v.view.flags.length > 0 ? ` flags=${v.view.flags.join(",")}` : "";
  // Consecutive boot failures (the spawn-retry budget) — shown while non-zero
  // so an operator sees a bee that is backing off before it gets flagged.
  const failures = (bee?.spawnFailures ?? 0) > 0 ? ` bootFailures=${bee?.spawnFailures}` : "";
  const status =
    v.view.runtimeState === "stopped"
      ? `stopped(${v.view.exitCause})`
      : (v.view.runtimeState ?? "no-runtime");
  const derived = v.view.working ? "working" : v.view.waitingForYou ? "waiting-for-you" : "quiet";
  const prefix = stale ? "stale: " : "";
  const args = bee?.args && bee.args.length > 0 ? `  args=${JSON.stringify(bee.args)}` : "";
  const parent = bee?.parentId ? `  parent=${bee.parentId}` : "";
  const tags = bee?.tags && bee.tags.length > 0 ? `  tags=${bee.tags.join(",")}` : "";
  // Handle leads (the human tier); the canonical UUID rides at the end for
  // copy/paste and for scripts that grep by id.
  const lead = bee?.handle ?? bee?.id ?? v.view.beeId;
  const idTail = bee?.handle ? `  id=${bee.id}` : "";
  return `${prefix}${lead}  ${bee?.name ?? "?"}  agent=${bee?.agent ?? "?"}  gen=${v.view.generation ?? 0}  ${status}  ${derived}  ${v.view.lifecycle ?? "deleted"}${flags}${failures}${args}${parent}${tags}${idTail}`;
}

function emit(ctx: CliContext, human: string[], jsonValue: unknown, stale: boolean): void {
  if (ctx.json) {
    ctx.io.out(JSON.stringify(stale ? { stale: true, ...(jsonValue as object) } : jsonValue));
    return;
  }
  if (stale) {
    ctx.io.err(`STALE: daemon not running — read directly from ${ctx.cfg.storePath}`);
  }
  for (const line of human) ctx.io.out(line);
}

// ---------------------------------------------------------------------------
// RPC/fallback plumbing
// ---------------------------------------------------------------------------

async function withClient<T>(ctx: CliContext, fn: (client: RpcClient) => Promise<T>): Promise<T> {
  const client = await RpcClient.connect(ctx.cfg.socketPath);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/** Reads: RPC when the daemon is up, read-only store (labeled stale) when down. */
async function readPath<T>(
  ctx: CliContext,
  rpc: (client: RpcClient) => Promise<T>,
  fallback: (store: ReadOnlyStore) => T,
): Promise<{ result: T; stale: boolean }> {
  try {
    const result = await withClient(ctx, rpc);
    return { result, stale: false };
  } catch (err) {
    if (!(err instanceof DaemonDownError)) throw err;
    if (!existsSync(ctx.cfg.storePath)) {
      throw new Error(`daemon not running and no store at ${ctx.cfg.storePath}`);
    }
    let store: ReadOnlyStore;
    try {
      store = new ReadOnlyStore(ctx.cfg.storePath);
    } catch (openErr) {
      // The store is exclusively locked → a live daemon holds it (B9), so
      // "daemon down" was a misdiagnosis — the rpc failed some other way
      // (slow verb past its timeout, mid-restart socket). Surfacing SQLite's
      // bare "database is locked" here sent the 2026-08-19 soak down the
      // wrong trail; report what actually happened instead.
      if (openErr instanceof Error && /locked|busy/i.test(openErr.message)) {
        throw new Error(`daemon appears to be running (store is locked) but the request failed: ${err.message}`);
      }
      throw openErr;
    }
    try {
      return { result: fallback(store), stale: true };
    } catch (readErr) {
      // Same misdiagnosis, later symptom: the open can succeed and the first
      // query hit the exclusive lock instead.
      if (readErr instanceof Error && /locked|busy/i.test(readErr.message)) {
        throw new Error(`daemon appears to be running (store is locked) but the request failed: ${err.message}`);
      }
      throw readErr;
    } finally {
      store.close();
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const SPAWN_USAGE =
  "usage: hive v2 spawn <name> [agent] [--agent <agent>] [--account id|auto|none] [--cwd dir] [--title t] [--tag t]... [--arg a]... [--parent bee|--no-parent] [--idempotency-key k]\n" +
  "       hive v2 spawn <name> [agent] --substrate cell --origin <repo> [--sha s] [--warm dir,dir|--warm] [--sandbox|--no-sandbox]\n" +
  "       (agent may be positional — v1 ergonomics — or --agent; default claude)";

/** The spawn RPC path (name = positional[1]) — shared by spawn and the x/run sugar. */
async function spawnBee(ctx: CliContext, parsed: Parsed): Promise<SpawnResult & { agent: string; substrate: string }> {
  const name = parsed.positional[1];
  if (!name) throw new Error(SPAWN_USAGE);
  // Agent positionally (v1 took the harness as an argument: `hive spawn
  // <harness>`) or via --agent. Silently defaulting a typed-but-dropped agent
  // to claude is how the 2026-08-19 soak got a claude bee it asked to be
  // codex, so a conflict between the two forms is an error, not a precedence
  // puzzle.
  const positionalAgent = parsed.positional[2];
  const flagAgent = parsed.flags.get("--agent") as string | undefined;
  if (positionalAgent && flagAgent && positionalAgent !== flagAgent) {
    throw new Error(`${SPAWN_USAGE}\n(agent given twice and they disagree: '${positionalAgent}' vs --agent ${flagAgent})`);
  }
  const stray = parsed.positional[3];
  if (stray !== undefined) {
    throw new Error(`${SPAWN_USAGE}\n(unexpected argument '${stray}' — spawn takes <name> and an optional agent)`);
  }
  const agent = flagAgent ?? positionalAgent ?? "claude";
  const cwd = resolve((parsed.flags.get("--cwd") as string | undefined) ?? process.cwd());
  const substrate = (parsed.flags.get("--substrate") as string | undefined) ?? (parsed.flags.has("--origin") ? "cell" : "hsr");
  let cell: Record<string, unknown> | undefined;
  if (substrate === "cell") {
    const origin = parsed.flags.get("--origin") as string | undefined;
    if (!origin) throw new Error(`${SPAWN_USAGE}\n(--substrate cell requires --origin <repo>)`);
    const warmFlag = parsed.flags.get("--warm");
    const warm = warmFlag === undefined ? undefined : warmFlag === true ? true : warmFlag.split(",").map((d) => d.trim()).filter((d) => d.length > 0);
    const sandbox = parsed.flags.get("--sandbox") === true ? true : parsed.flags.get("--no-sandbox") === true ? false : undefined;
    cell = {
      originRepo: resolve(origin),
      ...(parsed.flags.has("--sha") ? { sha: parsed.flags.get("--sha") as string } : {}),
      ...(warm !== undefined ? { warm } : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
    };
  } else if (parsed.flags.has("--origin") || parsed.flags.has("--sha")) {
    throw new Error(`${SPAWN_USAGE}\n(--origin/--sha only apply to --substrate cell)`);
  }
  const result = await withClient(ctx, async (c) => {
    // v6 parenting: an explicit --parent (id or unique name) is strict; the
    // ambient HIVE_BEE_ID (this process IS a bee) is used iff that bee exists
    // on this node — a stamp from another node/world is dropped, not an error.
    const explicitParent = parsed.flags.get("--parent") as string | undefined;
    let parentId: string | undefined;
    if (explicitParent) {
      const list = await c.request<ListResult>("list");
      parentId = resolveBeeIn(list.views, explicitParent);
    } else if (parsed.flags.get("--no-parent") !== true) {
      const self = selfBeeId();
      if (self) {
        const list = await c.request<ListResult>("list");
        if (list.views.some((v) => v.bee?.id === self)) parentId = self;
      }
    }
    // v7: --account <id> | auto (default) | none (explicitly unbound).
    const accountFlag = parsed.flags.get("--account") as string | undefined;
    const account = accountFlag === undefined ? undefined : accountFlag === "none" ? null : accountFlag;
    return c.request<SpawnResult>("spawn", {
      name,
      agent,
      cwd,
      substrate,
      ...(cell ? { cell } : {}),
      title: parsed.flags.get("--title") as string | undefined,
      tags: parsed.tags,
      ...(parsed.args.length > 0 ? { args: parsed.args } : {}),
      ...(parentId ? { parentId } : {}),
      ...(account !== undefined ? { account } : {}),
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    });
  });
  return { ...result, agent, substrate };
}

async function cmdSpawn(ctx: CliContext, parsed: Parsed): Promise<number> {
  const result = await spawnBee(ctx, parsed);
  const accountNote = result.account ? `; account ${result.account}${result.accountReason ? ` — ${result.accountReason}` : ""}` : "";
  emit(
    ctx,
    // The confirmation names the agent + substrate actually used: a dropped
    // or defaulted agent must be visible at spawn time, not discovered in
    // `ls` an hour later (2026-08-19 soak).
    [`${result.deduped ? "deduped: already " : ""}spawned ${result.handle ?? result.beeId} (${result.handle ? `${result.beeId}; ` : ""}${result.agent}/${result.substrate}; command ${result.commandId}${result.status ? ` ${result.status}` : ""}${accountNote})`],
    result,
    false,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// v7 (spec 08): accounts + swap-account
// ---------------------------------------------------------------------------

function pct(v: number | null): string {
  return v === null ? "-" : `${Math.round(v)}%`;
}

function accountLine(a: AccountListResult["accounts"][number], limits: AccountListResult["limits"][number] | undefined, stale: boolean): string {
  const prefix = stale ? "stale: " : "";
  const usage = limits
    ? limits.readable
      ? `  weekly=${pct(limits.weeklyPct)} 5h=${pct(limits.fiveHourPct)}${limits.fableWeeklyPct !== null ? ` fable=${pct(limits.fableWeeklyPct)}` : ""}${limits.plan ? ` plan=${limits.plan}` : ""}`
      : `  limits=unreadable(${limits.error ?? "?"})`
    : "";
  const penalty = a.penalty > 0 ? `  penalty=${a.penalty}` : "";
  const login = a.lastLoginAt ? `  lastLogin=${new Date(a.lastLoginAt).toISOString()}` : "";
  return `${prefix}${a.id}  ${a.harness}  ${a.status}  ${a.homePath}${penalty}${usage}${login}`;
}

const ACCOUNT_USAGE =
  "usage: hive v2 account list [--harness h] | get <id> | add <harness> <label> [--id id] [--home dir] [--penalty n]\n" +
  "       hive v2 account remove|pause|unpause <id> | penalty <id> <0-100> | login <id> | limits [<id>]\n" +
  "       hive v2 account import [--root ~/.hive] [--dry-run] | backfill [--dry-run]";

async function cmdAccount(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1];
  const key = parsed.flags.get("--idempotency-key") as string | undefined;
  switch (sub) {
    case "list":
    case "ls": {
      const harness = parsed.flags.get("--harness") as string | undefined;
      const { result, stale } = await readPath(
        ctx,
        (c) => c.request<AccountListResult>("account.list", harness ? { harness } : {}),
        (store) => ({ accounts: store.accounts(harness), limits: store.accountLimits() }),
      );
      const byId = new Map(result.limits.map((l) => [l.account, l]));
      const lines = result.accounts.length === 0 ? [`${stale ? "stale: " : ""}no accounts`] : result.accounts.map((a) => accountLine(a, byId.get(a.id), stale));
      emit(ctx, lines, result, stale);
      return 0;
    }
    case "get":
    case "show": {
      const id = parsed.positional[2];
      if (!id) throw new Error(ACCOUNT_USAGE);
      const r = await withClient(ctx, (c) => c.request<AccountGetResult>("account.get", { id }));
      const lines = [
        accountLine(r.account, r.limits ?? undefined, false),
        `  credentialed=${r.credentialed}  bees=${r.bees.length > 0 ? r.bees.join(",") : "-"}${r.loginSeat ? `  loginSeat=${r.loginSeat.session} (${r.loginSeat.attach})` : ""}`,
      ];
      emit(ctx, lines, r, false);
      return 0;
    }
    case "add": {
      const [, , harness, label] = parsed.positional;
      if (!harness || !label) throw new Error(ACCOUNT_USAGE);
      const penaltyFlag = parsed.flags.get("--penalty") as string | undefined;
      const r = await withClient(ctx, (c) =>
        c.request<AccountAddResult>("account.add", {
          harness,
          label,
          ...(parsed.flags.has("--id") ? { id: parsed.flags.get("--id") as string } : {}),
          ...(parsed.flags.has("--home") ? { homePath: resolve(parsed.flags.get("--home") as string) } : {}),
          ...(penaltyFlag !== undefined ? { penalty: Number(penaltyFlag) } : {}),
          idempotencyKey: key,
        }),
      );
      emit(ctx, [`${r.deduped ? "deduped: " : ""}added account ${r.account.id} (${r.account.harness}; home ${r.account.homePath}) — log in with: hive v2 account login ${r.account.id}`], r, false);
      return 0;
    }
    case "remove":
    case "rm": {
      const id = parsed.positional[2];
      if (!id) throw new Error(ACCOUNT_USAGE);
      const r = await withClient(ctx, (c) => c.request<AccountRemoveResult>("account.remove", { id, idempotencyKey: key }));
      emit(ctx, [`${r.deduped ? "deduped: " : ""}removed account ${r.account.id}`], r, false);
      return 0;
    }
    case "pause":
    case "unpause": {
      const id = parsed.positional[2];
      if (!id) throw new Error(ACCOUNT_USAGE);
      const r = await withClient(ctx, (c) => c.request<AccountUpdateResult>(`account.${sub}`, { id, idempotencyKey: key }));
      emit(ctx, [`${r.deduped ? "deduped: " : ""}${r.applied ? `${sub}d` : "unchanged"} ${r.account.id} (status ${r.account.status})`], r, false);
      return 0;
    }
    case "penalty": {
      const [, , id, raw] = parsed.positional;
      if (!id || raw === undefined) throw new Error(ACCOUNT_USAGE);
      const penalty = Number(raw);
      const r = await withClient(ctx, (c) => c.request<AccountUpdateResult>("account.setPenalty", { id, penalty, idempotencyKey: key }));
      emit(ctx, [`${r.deduped ? "deduped: " : ""}${r.applied ? "set" : "unchanged"} penalty for ${r.account.id}: ${r.account.penalty}`], r, false);
      return 0;
    }
    case "login": {
      const id = parsed.positional[2];
      if (!id) throw new Error(ACCOUNT_USAGE);
      const r = await withClient(ctx, (c) => c.request<AccountLoginResult>("account.login", { id, idempotencyKey: key }));
      emit(
        ctx,
        [
          `${r.deduped ? "deduped: " : ""}${r.rejoined ? "rejoined" : "started"} the login seat for ${r.accountId}: complete the login in the seat, then detach`,
          `  ${r.seat.attach}`,
          "  (the daemon captures the credential into the vault and marks the account ok when it lands)",
        ],
        r,
        false,
      );
      return 0;
    }
    case "limits": {
      const id = parsed.positional[2];
      const r = await withClient(ctx, (c) => c.request<AccountLimitsResult>("account.limits", id ? { id } : {}));
      const lines = r.limits.map((l) =>
        l.readable
          ? `${l.account}  weekly=${pct(l.weeklyPct)} 5h=${pct(l.fiveHourPct)}${l.fableWeeklyPct !== null ? ` fable=${pct(l.fableWeeklyPct)}` : ""}${l.plan ? ` plan=${l.plan}` : ""}  fetched=${new Date(l.fetchedAt).toISOString()}`
          : `${l.account}  unreadable: ${l.error ?? "?"}`,
      );
      emit(ctx, lines.length > 0 ? lines : ["no accounts"], r, false);
      return 0;
    }
    case "import": {
      const root = parsed.flags.get("--root") as string | undefined;
      const dryRun = parsed.flags.get("--dry-run") === true;
      const r = await withClient(ctx, (c) => c.request<AccountImportRegistryResult>("account.importRegistry", { ...(root ? { root: resolve(root) } : {}), dryRun, idempotencyKey: key }));
      const lines: string[] = [];
      if (r.refusal) lines.push(`refused: ${r.refusal}`);
      lines.push(`${r.dryRun ? "dry-run: would import" : r.applied ? "imported" : "import"} ${r.counts.import} account(s), skip ${r.counts.skip} (from ${r.registryPath})`);
      for (const [harness, c] of Object.entries(r.byHarness)) lines.push(`  ${harness}: import ${c.import}, skip ${c.skip}`);
      for (const e of r.entries) {
        lines.push(`  ${e.action === "import" ? "+" : "="} ${e.id}  ${e.harness}${e.status === "paused" ? "  paused" : ""}${e.penalty ? `  penalty=${e.penalty}` : ""}  vaultCreds=${e.vaultHasCredentials ?? "?"} homeCreds=${e.homeHasCredentials ?? "?"}${e.reason ? `  (${e.reason})` : ""}${e.note ? `  note: ${e.note}` : ""}`);
      }
      if (r.backfill) lines.push(`backfill: bound ${r.backfill.bound.length} env-only bee(s); ${r.backfill.unmatched.length} unmatched`);
      emit(ctx, lines, r, false);
      return r.refusal ? 2 : 0;
    }
    case "backfill": {
      const dryRun = parsed.flags.get("--dry-run") === true;
      const r = await withClient(ctx, (c) => c.request<AccountBackfillResult>("account.backfill", { dryRun, idempotencyKey: key }));
      const lines = [
        `${r.dryRun ? "dry-run: would bind" : "bound"} ${r.bound.length} bee(s); ${r.unmatched.length} unmatched`,
        ...r.bound.map((b) => `  ${b.beeId} → ${b.account} (${b.home})`),
        ...r.unmatched.map((u) => `  ${u.beeId} unmatched home ${u.home}`),
      ];
      emit(ctx, lines, r, false);
      return 0;
    }
    default:
      throw new Error(ACCOUNT_USAGE);
  }
}

// ---------------------------------------------------------------------------
// v6 pre-flip verbs: rename, tag, interrupt, fork, children, ask/question, seal
// ---------------------------------------------------------------------------

async function cmdRename(ctx: CliContext, parsed: Parsed): Promise<number> {
  const [, needle, name] = parsed.positional;
  if (!needle || !name) throw new Error("usage: hive v2 rename <bee> <new-name> [--idempotency-key k]");
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const r = await c.request<RenameResult>("bee.rename", { beeId, name, idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined });
    emit(ctx, [`${r.deduped ? "deduped: " : ""}${r.applied ? "renamed" : "unchanged"} ${beeId} → ${JSON.stringify(r.bee.name)}`], r, false);
    return 0;
  });
}

async function cmdTag(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  const add = parsed.lists.get("--add") ?? [];
  const remove = parsed.lists.get("--remove") ?? [];
  if (!needle || (add.length === 0 && remove.length === 0)) {
    throw new Error("usage: hive v2 tag <bee> [--add t]... [--remove t]... [--idempotency-key k]");
  }
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const r = await c.request<TagResult>("bee.tag", {
      beeId,
      ...(add.length > 0 ? { add } : {}),
      ...(remove.length > 0 ? { remove } : {}),
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    });
    emit(ctx, [`${r.deduped ? "deduped: " : ""}${r.applied ? "tagged" : "unchanged"} ${beeId}: ${JSON.stringify(r.bee.tags)}${r.added.length > 0 ? ` +${r.added.join(",")}` : ""}${r.removed.length > 0 ? ` -${r.removed.join(",")}` : ""}`], r, false);
    return 0;
  });
}

async function cmdInterrupt(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 interrupt <bee> [--idempotency-key k]");
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const r = await c.request<InterruptResult>("bee.interrupt", { beeId, idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined });
    emit(ctx, [`${r.deduped ? "deduped: " : ""}${r.interrupted ? `interrupt sent to ${beeId} (generation ${r.generation})` : `no interrupt for ${beeId}: ${r.reason}`}`], r, false);
    return 0;
  });
}

async function cmdFork(ctx: CliContext, parsed: Parsed): Promise<number> {
  const [, needle, ...promptParts] = parsed.positional;
  if (!needle) throw new Error("usage: hive v2 fork <bee> [--name n] [--prompt p | prompt…] [--idempotency-key k]");
  const prompt = (parsed.flags.get("--prompt") as string | undefined) ?? (promptParts.length > 0 ? promptParts.join(" ") : undefined);
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const r = await c.request<ForkResult>("bee.fork", {
      beeId,
      ...(parsed.flags.has("--name") ? { name: parsed.flags.get("--name") as string } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    });
    emit(
      ctx,
      [`${r.deduped ? "deduped: already " : ""}forked ${beeId} → ${r.beeId} (${r.bee.name}; command ${r.commandId}${r.status ? ` ${r.status}` : ""}${r.forkSeed ? `; forks session ${r.forkSeed}` : "; source had no session — boots fresh"}${r.messageId != null ? `; prompt message ${r.messageId}` : ""})`],
      r,
      false,
    );
    return 0;
  });
}

async function cmdChildren(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 children <bee>");
  const { result, stale } = await readPath(
    ctx,
    async (c) => {
      const list = await c.request<ListResult>("list");
      return c.request<ChildrenResult>("bee.children", { beeId: resolveBeeIn(list.views, needle) });
    },
    (store) => {
      const beeId = resolveBeeIn(store.list(null), needle);
      return { beeId, children: store.children(beeId) };
    },
  );
  const lines = result.children.length === 0 ? [`${stale ? "stale: " : ""}no children`] : result.children.map((v) => viewLine(v, stale));
  emit(ctx, lines, result, stale);
  return 0;
}

/** The bee a bee-side verb (ask/seal) targets: --bee, else HIVE_BEE_ID. */
async function targetBee(c: RpcClient, parsed: Parsed, verb: string): Promise<string> {
  const flag = parsed.flags.get("--bee") as string | undefined;
  if (flag) {
    const list = await c.request<ListResult>("list");
    return resolveBeeIn(list.views, flag);
  }
  const self = selfBeeId();
  if (!self) throw new Error(`hive v2 ${verb}: not running inside a bee (HIVE_BEE_ID unset) — pass --bee <bee>`);
  return self;
}

async function cmdAsk(ctx: CliContext, parsed: Parsed): Promise<number> {
  const text = parsed.positional.slice(1).join(" ");
  if (text.length === 0) throw new Error("usage: hive v2 ask <question…> [--option o]... [--bee b] [--idempotency-key k]");
  const options = parsed.lists.get("--option");
  return withClient(ctx, async (c) => {
    const beeId = await targetBee(c, parsed, "ask");
    const r = await c.request<QuestionAskResult>("question.ask", {
      beeId,
      text,
      ...(options && options.length > 0 ? { options } : {}),
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    });
    emit(ctx, [`${r.deduped ? "deduped: " : ""}asked question ${r.question.id} (the answer arrives in your mailbox as "[answer to question ${r.question.id}] …")`], r, false);
    return 0;
  });
}

function questionLine(q: QuestionListResult["questions"][number], stale: boolean): string {
  const prefix = stale ? "stale: " : "";
  const opts = q.options && q.options.length > 0 ? ` options=${JSON.stringify(q.options)}` : "";
  const ans = q.status === "answered" ? `  answered by ${q.answeredBy}: ${q.answer}` : "";
  return `${prefix}${q.id}  bee=${q.beeId}  ${q.status}${opts}  ${q.text}${ans}`;
}

async function cmdQuestion(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1];
  const usage = "usage: hive v2 question list [--bee b] [--open] | question answer <question-id> <answer…> [--by who]";
  switch (sub) {
    case "list": {
      const open = parsed.flags.get("--open") === true ? true : undefined;
      const beeFlag = parsed.flags.get("--bee") as string | undefined;
      const { result, stale } = await readPath(
        ctx,
        async (c) => {
          const beeId = beeFlag ? resolveBeeIn((await c.request<ListResult>("list")).views, beeFlag) : undefined;
          return c.request<QuestionListResult>("question.list", { ...(beeId ? { beeId } : {}), ...(open !== undefined ? { open } : {}) });
        },
        (store) => {
          const beeId = beeFlag ? resolveBeeIn(store.list(null), beeFlag) : undefined;
          return { questions: store.questions({ ...(beeId ? { beeId } : {}), ...(open !== undefined ? { open } : {}) }) };
        },
      );
      const lines = result.questions.length === 0 ? [`${stale ? "stale: " : ""}no questions`] : result.questions.map((q) => questionLine(q, stale));
      emit(ctx, lines, result, stale);
      return 0;
    }
    case "answer":
      return cmdAnswer(ctx, { ...parsed, positional: parsed.positional.slice(1) });
    default:
      throw new Error(usage);
  }
}

async function cmdAnswer(ctx: CliContext, parsed: Parsed): Promise<number> {
  const [, questionId, ...answerParts] = parsed.positional;
  const answer = answerParts.join(" ");
  if (!questionId || answer.length === 0) throw new Error("usage: hive v2 answer <question-id> <answer…> [--by who] [--idempotency-key k]");
  return withClient(ctx, async (c) => {
    const r = await c.request<QuestionAnswerResult>("question.answer", {
      questionId,
      answer,
      ...(parsed.flags.has("--by") ? { answeredBy: parsed.flags.get("--by") as string } : {}),
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    });
    emit(ctx, [`${r.deduped ? "deduped: " : ""}answered question ${questionId} → delivered to ${r.question.beeId} as message ${r.messageId}${r.commandId != null ? ` (wake command ${r.commandId})` : ""}`], r, false);
    return 0;
  });
}

function sealLine(sl: SealListResult["seals"][number], stale: boolean): string {
  const refs = sl.refs.length > 0 ? ` refs=${JSON.stringify(sl.refs)}` : "";
  return `${stale ? "stale: " : ""}${sl.id}  bee=${sl.beeId}  gen=${sl.generation ?? "-"}  ${sl.title}${refs}`;
}

/**
 * `hive v2 seal "<title>" --body <text> [--ref r]... [--bee b]` (create; the
 * bee defaults to HIVE_BEE_ID) · `seal list [--bee b]` · `seal get <id>`.
 */
async function cmdSeal(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1];
  const usage = "usage: hive v2 seal <title> [--body text] [--ref r]... [--bee b] | seal list [--bee b] | seal get <seal-id>";
  if (!sub) throw new Error(usage);
  if (sub === "list") {
    const beeFlag = parsed.flags.get("--bee") as string | undefined;
    const { result, stale } = await readPath(
      ctx,
      async (c) => {
        const beeId = beeFlag ? resolveBeeIn((await c.request<ListResult>("list")).views, beeFlag) : undefined;
        return c.request<SealListResult>("seal.list", beeId ? { beeId } : {});
      },
      (store) => {
        const beeId = beeFlag ? resolveBeeIn(store.list(null), beeFlag) : undefined;
        return { seals: store.seals(beeId ? { beeId } : {}) };
      },
    );
    const lines = result.seals.length === 0 ? [`${stale ? "stale: " : ""}no seals`] : result.seals.map((sl) => sealLine(sl, stale));
    emit(ctx, lines, result, stale);
    return 0;
  }
  if (sub === "get") {
    const id = parsed.positional[2];
    if (!id) throw new Error(usage);
    const { result, stale } = await readPath(
      ctx,
      (c) => c.request<SealGetResult>("seal.get", { sealId: id }),
      (store) => {
        const seal = store.seal(id);
        if (!seal) throw new RpcError("seal_not_found", `seal not found: ${id}`);
        return { seal };
      },
    );
    emit(ctx, [sealLine(result.seal, stale), ...result.seal.body.split("\n").map((l) => `${stale ? "stale: " : ""}  ${l}`)], result, stale);
    return 0;
  }
  const title = sub;
  const body = (parsed.flags.get("--body") as string | undefined) ?? (parsed.rest ? parsed.rest.join(" ") : "");
  const refs = parsed.lists.get("--ref") ?? [];
  return withClient(ctx, async (c) => {
    const beeId = await targetBee(c, parsed, "seal");
    const r = await c.request<SealCreateResult>("seal.create", {
      beeId,
      title,
      body,
      ...(refs.length > 0 ? { refs } : {}),
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    });
    emit(ctx, [`${r.deduped ? "deduped: " : ""}sealed ${r.seal.id} for ${beeId} (generation ${r.seal.generation ?? "-"}): ${r.seal.title}`], r, false);
    return 0;
  });
}

async function cmdSend(ctx: CliContext, parsed: Parsed): Promise<number> {
  const [, needle, ...bodyParts] = parsed.positional;
  const body = bodyParts.join(" ");
  if (!needle || body.length === 0) {
    throw new Error("usage: hive v2 send <bee> <message…> [--urgency now|next|idle] [--sender s] [--wait] [--timeout ms] [--idempotency-key k]");
  }
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const result = await c.request<SendRpcResult>("send", {
      beeId,
      body,
      sender: parsed.flags.get("--sender") as string | undefined,
      // v8: delivery urgency (validated by the daemon; omitted = next).
      urgency: parsed.flags.get("--urgency") as string | undefined,
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    });
    if (parsed.flags.get("--wait") !== true) {
      emit(
        ctx,
        [`${result.deduped ? "deduped: already " : ""}sent message ${result.messageId} to ${beeId}${result.commandId != null ? ` (wake command ${result.commandId})` : ""}`],
        result,
        false,
      );
      return 0;
    }
    // Q3: --wait blocks on the delivery mark — the mailbox row is the truth.
    const timeoutMs = Number(parsed.flags.get("--timeout") ?? 60_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { messages } = await c.request<MailboxResult>("mailbox", { beeId });
      const msg = messages.find((m) => m.id === result.messageId);
      if (msg?.deliveredAt != null) {
        emit(
          ctx,
          [`delivered message ${result.messageId} to ${beeId} (generation ${msg.deliveredGeneration})`],
          { ...result, deliveredAt: msg.deliveredAt, deliveredGeneration: msg.deliveredGeneration },
          false,
        );
        return 0;
      }
      if (Date.now() > deadline) {
        ctx.io.err(`timeout: message ${result.messageId} not delivered within ${timeoutMs}ms (it remains queued durably)`);
        return 1;
      }
      await sleep(100);
    }
  });
}

async function cmdMutation(
  ctx: CliContext,
  parsed: Parsed,
  verb: "stop" | "revive" | "archive" | "unarchive" | "delete",
): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error(`usage: hive v2 ${verb} <bee>${verb === "revive" ? " [--arg a]... | [-- <args…>]" : ""}`);
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    // revive may replace the per-bee args as it runs (`--arg` or `-- …`).
    const reviveArgs = verb === "revive" ? (parsed.rest ?? (parsed.args.length > 0 ? parsed.args : undefined)) : undefined;
    const result = await c.request<{ commandId: number }>(verb, { beeId, ...(reviveArgs !== undefined ? { args: reviveArgs } : {}) });
    emit(ctx, [`${verb} ${beeId} enqueued (command ${result.commandId})`], { beeId, ...result }, false);
    return 0;
  });
}

/**
 * `hive v2 cell capture <bee> --onto <branch> [--rebase]` /
 * `hive v2 cell remove <bee> [--force]` — the WP6 §5 exit path. Refusals and
 * conflicts are RESULTS: printed, exit 0 with `--json`; human mode exits 2
 * for a refused/conflicted capture and a refused remove so scripts can tell.
 */
async function cmdCell(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1];
  const needle = parsed.positional[2];
  const usage = "usage: hive v2 cell capture <bee> --onto <branch> [--rebase] [--idempotency-key k] | cell remove <bee> [--force] [--idempotency-key k]";
  switch (sub) {
    case "capture": {
      const onto = parsed.flags.get("--onto") as string | undefined;
      if (!needle || !onto) throw new Error(usage);
      const mode = parsed.flags.get("--rebase") === true ? "rebase" : "merge";
      return withClient(ctx, async (c) => {
        const list = await c.request<ListResult>("list");
        const beeId = resolveBeeIn(list.views, needle);
        const r = await c.request<CellCaptureResult>("cell.capture", {
          beeId,
          targetBranch: onto,
          mode,
          idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
        });
        const dedup = r.deduped ? "deduped: " : "";
        const lines: string[] = [];
        switch (r.status) {
          case "landed":
            lines.push(`${dedup}landed ${r.cellHead?.slice(0, 12)} onto ${r.targetBranch} (${r.mode}) → ${r.resultSha}${r.baseTarget == null ? " (branch created)" : ""}`);
            break;
          case "nothing_to_capture":
            lines.push(`${dedup}nothing to capture: ${r.targetBranch} already contains ${r.cellHead?.slice(0, 12)}`);
            break;
          case "conflict":
            lines.push(`${dedup}conflict: ${r.mode} of ${r.cellHead?.slice(0, 12)} onto ${r.targetBranch} (${r.baseTarget?.slice(0, 12)}) — your repository was not modified`);
            for (const path of r.conflicts) lines.push(`  ${path}`);
            break;
          case "refused":
            lines.push(`${dedup}refused (${r.reason}) — your repository was not modified`);
            break;
        }
        emit(ctx, lines, { beeId, ...r }, false);
        return ctx.json || r.status === "landed" || r.status === "nothing_to_capture" ? 0 : 2;
      });
    }
    case "remove":
    case "rm": {
      if (!needle) throw new Error(usage);
      return withClient(ctx, async (c) => {
        const list = await c.request<ListResult>("list");
        const beeId = resolveBeeIn(list.views, needle);
        const r = await c.request<CellRemoveResult>("cell.remove", {
          beeId,
          force: parsed.flags.get("--force") === true,
          idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
        });
        const dedup = r.deduped ? "deduped: " : "";
        const lines: string[] = [];
        if (r.status === "refused") {
          const causes = [
            r.report?.uncommitted ? "uncommitted changes" : null,
            r.report?.unpushed ? "uncaptured commits" : null,
            r.report?.originUnknown ? "origin unreachable" : null,
          ].filter((x) => x != null);
          lines.push(`${dedup}refused: cell is dirty (${causes.join(", ")}) — pass --force to delete anyway (work is lost)`);
        } else {
          lines.push(`${dedup}cell ${r.status}${r.forced ? " (forced)" : ""}; delete ${beeId} enqueued (command ${r.commandId})`);
        }
        emit(ctx, lines, { beeId, ...r }, false);
        return ctx.json || r.status !== "refused" ? 0 : 2;
      });
    }
    default:
      throw new Error(usage);
  }
}

/**
 * `hive v2 bee set-args <bee> -- <args…>` / `bee set-args <bee> --clear` /
 * `bee args <bee>` — per-bee spawn args (schema v5). Takes effect on the
 * bee's NEXT runtime (stop or revive to apply).
 */
async function cmdBee(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1];
  const needle = parsed.positional[2];
  const usage = "usage: hive v2 bee set-args <bee> -- <args…> | bee set-args <bee> --clear | bee args <bee> | bee swap-account <bee> <account>";
  switch (sub) {
    case "swap-account": {
      const account = parsed.positional[3];
      if (!needle || !account) throw new Error(usage);
      return withClient(ctx, async (c) => {
        const list = await c.request<ListResult>("list");
        const beeId = resolveBeeIn(list.views, needle);
        const r = await c.request<SwapAccountResult>("bee.swapAccount", { beeId, account, idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined });
        const what = r.action === "noop" ? "already on" : r.action === "stop_then_revive" ? `swapping to` : "rebound to";
        emit(
          ctx,
          [`${r.deduped ? "deduped: " : ""}${beeId} ${what} ${r.to}${r.from ? ` (from ${r.from})` : ""}${r.rekeyed ? "; conversation resumes under a new session id" : ""}${r.commandId != null ? ` (stop ${r.commandId} → revive)` : ""}`],
          r,
          false,
        );
        return 0;
      });
    }
    case "set-args": {
      if (!needle) throw new Error(usage);
      const clear = parsed.flags.get("--clear") === true;
      const args = clear ? null : (parsed.rest ?? (parsed.args.length > 0 ? parsed.args : null));
      if (!clear && (args === null || args.length === 0)) throw new Error(`${usage}\n(pass the args after \`--\`, or --clear to remove them)`);
      return withClient(ctx, async (c) => {
        const list = await c.request<ListResult>("list");
        const beeId = resolveBeeIn(list.views, needle);
        const result = await c.request<SetArgsResult>("bee.setArgs", {
          beeId,
          args,
          idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
        });
        emit(
          ctx,
          [
            `${result.applied ? "set" : "unchanged"} args for ${beeId}: ${result.bee.args ? JSON.stringify(result.bee.args) : "(none)"}` +
              " — applies to the next runtime (stop or revive)",
          ],
          result,
          false,
        );
        return 0;
      });
    }
    case "args": {
      if (!needle) throw new Error(usage);
      const { result, stale } = await readPath(
        ctx,
        async (c) => {
          const list = await c.request<ListResult>("list");
          return c.request<ViewResult>("view", { beeId: resolveBeeIn(list.views, needle) });
        },
        (store) => store.view(resolveBeeIn(store.list(null), needle)),
      );
      const args = result.bee?.args ?? null;
      emit(ctx, [`${result.bee?.id ?? needle} args: ${args ? JSON.stringify(args) : "(none)"}`], { beeId: result.bee?.id ?? null, args }, stale);
      return 0;
    }
    default:
      throw new Error(usage);
  }
}

async function cmdView(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 view <bee>");
  const { result, stale } = await readPath(
    ctx,
    async (c) => {
      const list = await c.request<ListResult>("list");
      const beeId = resolveBeeIn(list.views, needle);
      return c.request<ViewResult>("view", { beeId });
    },
    (store) => {
      const beeId = resolveBeeIn(store.list(null), needle);
      return store.view(beeId);
    },
  );
  emit(ctx, [viewLine(result, stale)], result, stale);
  return 0;
}

async function cmdList(ctx: CliContext, parsed: Parsed): Promise<number> {
  const lifecycle =
    parsed.flags.get("--archived") === true
      ? "archived"
      : parsed.flags.get("--all") === true
        ? null
        : ((parsed.flags.get("--lifecycle") as string | undefined) ?? "active");
  const { result, stale } = await readPath(
    ctx,
    (c) => c.request<ListResult>("list", lifecycle == null ? {} : { lifecycle }),
    (store) => ({ views: store.list(lifecycle) }),
  );
  const lines = result.views.length === 0 ? [stale ? "stale: no bees" : "no bees"] : result.views.map((v) => viewLine(v, stale));
  emit(ctx, lines, result, stale);
  return 0;
}

async function cmdMailbox(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 mailbox <bee>");
  const { result, stale } = await readPath(
    ctx,
    async (c) => {
      const list = await c.request<ListResult>("list");
      const beeId = resolveBeeIn(list.views, needle);
      return c.request<MailboxResult>("mailbox", { beeId });
    },
    (store) => {
      const beeId = resolveBeeIn(store.list(null), needle);
      return { messages: store.mailbox(beeId) };
    },
  );
  const prefix = stale ? "stale: " : "";
  const lines = result.messages.map(
    (m) =>
      `${prefix}#${m.id} from=${m.sender} ${m.deliveredAt == null ? "undelivered" : `delivered(gen ${m.deliveredGeneration})`}  ${m.body}`,
  );
  emit(ctx, lines.length > 0 ? lines : [`${prefix}mailbox empty`], result, stale);
  return 0;
}

// ---------------------------------------------------------------------------
// buz compatibility (contract B4a: buz IS the mailbox)
// ---------------------------------------------------------------------------

/** v1 tier → v2 urgency (the Q2 amendment's mapping). */
const TIER_TO_URGENCY: Record<string, string> = {
  interrupt: "now",
  "next-tool": "next",
  queue: "idle",
  passive: "idle",
};

/**
 * `hive v2 buz <send|inbox|…>` — the v1 buz surface mapped onto the mailbox.
 * Imported bees carry preambles and histories that speak
 * `hive buz send <bee> --sender <me> -p "<body>"`; this keeps that muscle
 * memory working. Tiers map onto urgency; everything lands in the ONE
 * mailbox — there is no buz store. Sender defaults to the ambient
 * HIVE_BEE_ID (a bee messaging a peer), exactly the old default.
 */
async function cmdBuz(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1];
  switch (sub) {
    case "send": {
      const target = parsed.positional[2];
      const prompt =
        (parsed.flags.get("--prompt") as string | undefined) ?? parsed.positional.slice(3).join(" ");
      if (!target || prompt.length === 0) {
        throw new Error(
          "usage: hive v2 buz send <bee> -p <body> [--sender <bee>|--sender-human <name>] " +
            "[--tier interrupt|next-tool|queue|passive | --urgency now|next|idle] [--wait]",
        );
      }
      const tier = parsed.flags.get("--tier") as string | undefined;
      if (tier !== undefined && TIER_TO_URGENCY[tier] === undefined) {
        throw new Error(
          `buz: unknown tier "${tier}" — tiers map onto urgency: interrupt→now, next-tool→next, queue/passive→idle`,
        );
      }
      const senderHuman = parsed.flags.get("--sender-human") as string | undefined;
      if (senderHuman !== undefined && parsed.flags.has("--sender")) {
        throw new Error("buz: --sender and --sender-human are mutually exclusive");
      }
      const sender = senderHuman
        ? `human:${senderHuman}`
        : ((parsed.flags.get("--sender") as string | undefined) ?? process.env.HIVE_BEE_ID);
      const fwd: Parsed = { ...parsed, positional: ["send", target, prompt], flags: new Map(parsed.flags) };
      fwd.flags.delete("--prompt");
      fwd.flags.delete("--tier");
      fwd.flags.delete("--sender-human");
      if (sender !== undefined) fwd.flags.set("--sender", sender);
      if (tier !== undefined && !parsed.flags.has("--urgency")) {
        fwd.flags.set("--urgency", TIER_TO_URGENCY[tier] as string);
      }
      return cmdSend(ctx, fwd);
    }
    case "inbox": {
      const target = parsed.positional[2] ?? process.env.HIVE_BEE_ID;
      if (!target) {
        throw new Error("usage: hive v2 buz inbox [bee]   (defaults to HIVE_BEE_ID inside a bee)");
      }
      return cmdMailbox(ctx, { ...parsed, positional: ["mailbox", target] });
    }
    case "outbox":
    case "queue":
    case "quarantine":
    case "requeue":
    case "read":
    case "cancel":
    case "reconcile":
    case "purge":
    case "config": {
      ctx.io.err(
        `hive v2 buz ${sub}: retired — buz is the mailbox now (one store, no tier machinery).\n` +
          "  queued/undelivered:  hive v2 mailbox <bee>\n" +
          "  delivery history:    hive v2 events --bee <bee> --kind 'mail.*'\n" +
          "  send with urgency:   hive v2 send <bee> <msg> --urgency now|next|idle",
      );
      return 1;
    }
    default:
      throw new Error(
        "usage: hive v2 buz <send|inbox> …   (buz is the mailbox: send maps to `send`, inbox to `mailbox`)",
      );
  }
}

async function cmdCommands(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 commands <bee>");
  const { result, stale } = await readPath(
    ctx,
    async (c) => {
      const list = await c.request<ListResult>("list");
      const beeId = resolveBeeIn(list.views, needle);
      return c.request<CommandsResult>("commands", { beeId });
    },
    (store) => {
      const beeId = resolveBeeIn(store.list(null), needle);
      return { commands: store.commands(beeId) };
    },
  );
  const prefix = stale ? "stale: " : "";
  const lines = result.commands.map(
    (cmd) =>
      `${prefix}#${cmd.id} ${cmd.verb} ${cmd.status}${cmd.failureCause ? `(${cmd.failureCause})` : ""} gen=${cmd.targetGeneration ?? "-"} attempts=${cmd.attempts}`,
  );
  emit(ctx, lines.length > 0 ? lines : [`${prefix}no commands`], result, stale);
  return 0;
}

async function cmdDeployInfo(ctx: CliContext): Promise<number> {
  const result = await withClient(ctx, (c) => c.request("deployInfo"));
  emit(ctx, [JSON.stringify(result, null, 2)], result, false);
  return 0;
}

async function cmdHealth(ctx: CliContext): Promise<number> {
  const result = await withClient(ctx, (c) => c.request<HealthResult>("health"));
  emit(
    ctx,
    [
      `daemon pid=${result.pid} up=${Math.round(result.uptimeMs / 1000)}s ticks=${result.ticks} tickErrors=${result.tickErrors}`,
      `bees total=${result.bees.total} active=${result.bees.active} archived=${result.bees.archived}`,
      `i1Violations=${result.i1Violations}`,
    ],
    result,
    false,
  );
  return 0;
}

async function cmdWatch(ctx: CliContext, parsed: Parsed): Promise<number> {
  const filterBee = parsed.flags.get("--bee") as string | undefined;
  const client = await RpcClient.connect(ctx.cfg.socketPath);
  const printSnapshot = (snap: SnapshotResult): void => {
    ctx.io.out(`snapshot seq=${snap.seq} bees=${snap.views.length}`);
    for (const v of snap.views) {
      if (filterBee && v.bee?.id !== filterBee && v.bee?.name !== filterBee) continue;
      ctx.io.out(viewLine(v, false));
    }
  };
  client.onEvent = (frame: WatchFrame) => {
    if (frame.type === "gap") {
      // Fail-closed cursor: on any gap, refetch the snapshot.
      ctx.io.out(`gap → refetching snapshot (seq=${frame.seq})`);
      void client.request<SnapshotResult>("snapshot").then(printSnapshot);
      return;
    }
    for (const ev of frame.events) {
      if (filterBee && ev.beeId !== filterBee) continue; // whole-node stream, client-side filter (Q2)
      ctx.io.out(`${ev.seq} ${ev.kind}${ev.beeId ? ` bee=${ev.beeId}` : ""}`);
    }
  };
  const snap = await client.request<SnapshotResult>("watch");
  printSnapshot(snap);
  await new Promise<void>((resolveDone) => {
    client.onClose = () => resolveDone();
    process.once("SIGINT", () => {
      client.close();
      resolveDone();
    });
  });
  return 0;
}

// ---------------------------------------------------------------------------
// templates + tracks + packages (WP6a)
// ---------------------------------------------------------------------------

interface RegistryRowLike {
  id: string;
  name: string;
  scope: string;
  source: string;
  updatedAt: number;
}

function resolveRegistryRow<T extends RegistryRowLike>(rows: T[], needle: string, what: string): T {
  const byId = rows.find((r) => r.id === needle);
  if (byId) return byId;
  const byName = rows.filter((r) => r.name === needle);
  if (byName.length === 1) return byName[0] as T;
  if (byName.length > 1) {
    throw new Error(`${what} name '${needle}' is ambiguous across scopes (${byName.map((r) => r.scope).join(", ")}) — use the id`);
  }
  throw new Error(`${what} not found: ${needle}`);
}

function registryLine(prefix: string, r: RegistryRowLike, extra: string): string {
  return `${prefix}${r.id}  ${r.name}  scope=${r.scope}  source=${r.source}  ${extra}`;
}

async function cmdTemplate(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1] ?? "list";
  const scope = parsed.flags.get("--scope") as string | undefined;
  switch (sub) {
    case "list":
    case "ls": {
      const { result, stale } = await readPath(
        ctx,
        (c) => c.request<TemplateListResult>("template.list", scope ? { scope } : {}),
        (store) => ({ templates: store.listTemplates().filter((t) => scope == null || t.scope === scope) }),
      );
      const lines = result.templates.map((t) => registryLine(stale ? "stale: " : "", t, `agent=${t.agent}`));
      emit(ctx, lines.length > 0 ? lines : [`${stale ? "stale: " : ""}no templates`], result, stale);
      return 0;
    }
    case "get":
    case "show": {
      const needle = parsed.positional[2];
      if (!needle) throw new Error("usage: hive v2 template get <id|name>");
      const { result, stale } = await readPath(
        ctx,
        async (c) => {
          const { templates } = await c.request<TemplateListResult>("template.list");
          return c.request<TemplateGetResult>("template.get", { id: resolveRegistryRow(templates, needle, "template").id });
        },
        (store) => ({ template: resolveRegistryRow(store.listTemplates(), needle, "template") }),
      );
      emit(ctx, [JSON.stringify(result.template, null, 2)], result, stale);
      return 0;
    }
    case "put": {
      const file = parsed.flags.get("--file") as string | undefined;
      if (!file) throw new Error("usage: hive v2 template put --file fields.json [--id id]");
      const result = await withClient(ctx, (c) =>
        c.request<TemplatePutResult>("template.put", {
          fields: JSON.parse(readFileSync(resolve(file), "utf8")),
          id: parsed.flags.get("--id") as string | undefined,
        }),
      );
      emit(ctx, [`${result.outcome} template ${result.template.id} (${result.template.name})`], result, false);
      return 0;
    }
    case "delete":
    case "rm": {
      const needle = parsed.positional[2];
      if (!needle) throw new Error("usage: hive v2 template delete <id|name>");
      const result = await withClient(ctx, async (c) => {
        const { templates } = await c.request<TemplateListResult>("template.list");
        return c.request<TemplateDeleteResult>("template.delete", { id: resolveRegistryRow(templates, needle, "template").id });
      });
      emit(ctx, [`deleted template ${result.template.id} (${result.template.name})`], result, false);
      return 0;
    }
    case "export": {
      const needle = parsed.positional[2];
      if (!needle) throw new Error("usage: hive v2 template export <id|name> [--out file.json]");
      const result = await withClient(ctx, async (c) => {
        const { templates } = await c.request<TemplateListResult>("template.list");
        return c.request<TemplateExportResult>("template.export", { id: resolveRegistryRow(templates, needle, "template").id });
      });
      const out = parsed.flags.get("--out") as string | undefined;
      if (out) {
        writeFileSync(resolve(out), result.text);
        emit(ctx, [`exported template package to ${resolve(out)}`], result, false);
      } else {
        ctx.io.out(result.text.trimEnd());
      }
      return 0;
    }
    case "import": {
      const file = parsed.flags.get("--file") as string | undefined ?? parsed.positional[2];
      if (!file) throw new Error("usage: hive v2 template import <package.json> [--scope s] [--source label]");
      const path = resolve(file);
      const result = await withClient(ctx, (c) =>
        c.request<TemplateImportResult>("template.import", {
          package: JSON.parse(readFileSync(path, "utf8")),
          source: (parsed.flags.get("--source") as string | undefined) ?? path,
          scope,
          label: path,
        }),
      );
      emit(ctx, [`${result.outcome} template ${result.template.id} (${result.template.name}) from ${path}`], result, false);
      return 0;
    }
    default:
      throw new Error("usage: hive v2 template <list|get|put|delete|export|import>");
  }
}

async function cmdTrack(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1] ?? "list";
  const scope = parsed.flags.get("--scope") as string | undefined;
  switch (sub) {
    case "list":
    case "ls": {
      const { result, stale } = await readPath(
        ctx,
        (c) => c.request<TrackListResult>("track.list", scope ? { scope } : {}),
        (store) => ({ tracks: store.listTracks().filter((t) => scope == null || t.scope === scope) }),
      );
      const lines = result.tracks.map((t) => registryLine(stale ? "stale: " : "", t, `steps=${t.steps.length}`));
      emit(ctx, lines.length > 0 ? lines : [`${stale ? "stale: " : ""}no tracks`], result, stale);
      return 0;
    }
    case "get":
    case "show": {
      const needle = parsed.positional[2];
      if (!needle) throw new Error("usage: hive v2 track get <id|name>");
      const { result, stale } = await readPath(
        ctx,
        async (c) => {
          const { tracks } = await c.request<TrackListResult>("track.list");
          return c.request<TrackGetResult>("track.get", { id: resolveRegistryRow(tracks, needle, "track").id });
        },
        (store) => ({ track: resolveRegistryRow(store.listTracks(), needle, "track") }),
      );
      emit(ctx, [JSON.stringify(result.track, null, 2)], result, stale);
      return 0;
    }
    case "put": {
      const file = parsed.flags.get("--file") as string | undefined;
      if (!file) throw new Error("usage: hive v2 track put --file fields.json [--id id]");
      const result = await withClient(ctx, (c) =>
        c.request<TrackPutResult>("track.put", {
          fields: JSON.parse(readFileSync(resolve(file), "utf8")),
          id: parsed.flags.get("--id") as string | undefined,
        }),
      );
      emit(ctx, [`${result.outcome} track ${result.track.id} (${result.track.name})`], result, false);
      return 0;
    }
    case "delete":
    case "rm": {
      const needle = parsed.positional[2];
      if (!needle) throw new Error("usage: hive v2 track delete <id|name>");
      const result = await withClient(ctx, async (c) => {
        const { tracks } = await c.request<TrackListResult>("track.list");
        return c.request<TrackDeleteResult>("track.delete", { id: resolveRegistryRow(tracks, needle, "track").id });
      });
      emit(ctx, [`deleted track ${result.track.id} (${result.track.name})`], result, false);
      return 0;
    }
    case "export": {
      const needle = parsed.positional[2];
      if (!needle) throw new Error("usage: hive v2 track export <id|name> [--out file.json]");
      const result = await withClient(ctx, async (c) => {
        const { tracks } = await c.request<TrackListResult>("track.list");
        return c.request<TrackExportResult>("track.export", { id: resolveRegistryRow(tracks, needle, "track").id });
      });
      const out = parsed.flags.get("--out") as string | undefined;
      if (out) {
        writeFileSync(resolve(out), result.text);
        emit(ctx, [`exported track package to ${resolve(out)}`], result, false);
      } else {
        ctx.io.out(result.text.trimEnd());
      }
      return 0;
    }
    case "import": {
      const file = parsed.flags.get("--file") as string | undefined ?? parsed.positional[2];
      if (!file) throw new Error("usage: hive v2 track import <package.json> [--scope s] [--source label]");
      const path = resolve(file);
      const result = await withClient(ctx, (c) =>
        c.request<TrackImportResult>("track.import", {
          package: JSON.parse(readFileSync(path, "utf8")),
          source: (parsed.flags.get("--source") as string | undefined) ?? path,
          scope,
          label: path,
        }),
      );
      emit(ctx, [`${result.outcome} track ${result.track.id} (${result.track.name}) from ${path}`], result, false);
      return 0;
    }
    default:
      throw new Error("usage: hive v2 track <list|get|put|delete|export|import>");
  }
}

async function cmdPackages(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1];
  switch (sub) {
    case "import-local": {
      // Manual invocation only (v1): the FUTURE auto-import hook lives in
      // core/packages.ts, deliberately uncalled.
      const dir = parsed.flags.get("--dir") as string | undefined;
      const result = await withClient(ctx, (c) =>
        c.request<ImportLocalConfigResult>("packages.importLocalConfig", {
          ...(dir ? { dir: resolve(dir) } : {}),
          scope: parsed.flags.get("--scope") as string | undefined,
        }),
      );
      const lines = [
        `imported local config from ${result.dir}`,
        ...result.templates.map((t) => `  template ${t.name}: ${t.outcome} (${t.id})`),
        ...result.tracks.map((t) => `  track ${t.name}: ${t.outcome} (${t.id})`),
        ...result.skipped.map((s) => `  skipped ${s.path}: ${s.reason}`),
      ];
      emit(ctx, lines, result, false);
      return 0;
    }
    default:
      throw new Error("usage: hive v2 packages import-local [--dir d] [--scope s]");
  }
}

// ---------------------------------------------------------------------------
// v1-alignment: sugar verbs (x, run, wait, here) + reading verbs
// (transcript, tail, last, events) + set-model / usage / attach sugar
// ---------------------------------------------------------------------------

/** One bee's view+row, by id or unique name — RPC first, read-only fallback. */
async function readBee(ctx: CliContext, needle: string): Promise<{ result: ViewResult; stale: boolean }> {
  return readPath(
    ctx,
    async (c) => {
      const list = await c.request<ListResult>("list");
      return c.request<ViewResult>("view", { beeId: resolveBeeIn(list.views, needle) });
    },
    (store) => store.view(resolveBeeIn(store.list(null), needle)),
  );
}

function numFlag(parsed: Parsed, flag: string, fallback: number): number {
  const raw = parsed.flags.get(flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a number`);
  return n;
}

/** The prompt for x/run: --prompt/-p wins, else the trailing positionals. */
function promptOf(parsed: Parsed, fromIndex: number): string {
  const flagged = parsed.flags.get("--prompt") as string | undefined;
  if (flagged !== undefined) return flagged;
  return parsed.positional.slice(fromIndex).join(" ");
}

/**
 * `hive v2 x <name> <prompt…>` — spawn + first send, fire-and-forget (the v1
 * `x` shape). The mailbox is durable, so the prompt needs no readiness wait:
 * delivery lands when the bee boots. Spawn flags pass through
 * (--agent/--account/--cwd/--tag/--arg/--parent…).
 */
async function cmdX(ctx: CliContext, parsed: Parsed): Promise<number> {
  const name = parsed.positional[1];
  const prompt = promptOf(parsed, 2);
  if (!name || prompt.length === 0) {
    throw new Error("usage: hive v2 x <name> <prompt…> [--agent a] [--account id|auto|none] [--cwd d] [--tag t]... [--arg a]...");
  }
  const spawned = await spawnBee(ctx, { ...parsed, positional: ["spawn", name] });
  const sent = await withClient(ctx, (c) =>
    c.request<SendRpcResult>("send", { beeId: spawned.beeId, body: prompt, sender: "operator" }),
  );
  emit(
    ctx,
    [`spawned ${spawned.handle ?? spawned.beeId} (${spawned.handle ? `${spawned.beeId}; ` : ""}command ${spawned.commandId}); sent message ${sent.messageId} (${prompt.length} chars) — inspect with: hive v2 tail ${name} | wait ${name}`],
    { ...spawned, messageId: sent.messageId },
    false,
  );
  return 0;
}

/**
 * Idle-wait loop: done when the runtime is idle/stopped AND no mailbox message
 * is undelivered, sustained for `idleMs`. `requireOutputAfter` (run) also
 * demands output evidence newer than the delivery before the short settle —
 * a turn that produces none still completes after the long settle.
 */
async function waitForBeeIdle(
  c: RpcClient,
  beeId: string,
  opts: { timeoutMs: number; idleMs: number; requireOutputAfter?: number },
): Promise<{ outcome: "idle" | "timeout"; view: ViewResult }> {
  const pollMs = 100;
  const shortStreak = Math.max(1, Math.round(opts.idleMs / pollMs));
  const longStreak = Math.max(shortStreak, 15); // no-output fallback: ~1.5s of quiet
  const deadline = Date.now() + opts.timeoutMs;
  let streak = 0;
  for (;;) {
    const view = await c.request<ViewResult>("view", { beeId });
    const state = view.view.runtimeState;
    const quiet = state === "idle" || state === "stopped";
    let base = quiet;
    if (base) {
      const { messages } = await c.request<MailboxResult>("mailbox", { beeId });
      base = messages.every((m) => m.deliveredAt != null);
    }
    streak = base ? streak + 1 : 0;
    if (base) {
      const outputSeen =
        opts.requireOutputAfter === undefined ||
        (view.bee?.lastOutputAt != null && view.bee.lastOutputAt >= opts.requireOutputAfter);
      if ((outputSeen && streak >= shortStreak) || streak >= longStreak) return { outcome: "idle", view };
    }
    if (Date.now() > deadline) return { outcome: "timeout", view };
    await sleep(pollMs);
  }
}

/** `hive v2 wait <bee> [--timeout ms] [--idle-ms ms]` — block until the bee settles. */
async function cmdWait(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 wait <bee> [--timeout ms] [--idle-ms ms]");
  const timeoutMs = numFlag(parsed, "--timeout", 600_000);
  const idleMs = numFlag(parsed, "--idle-ms", 300);
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const { outcome, view } = await waitForBeeIdle(c, beeId, { timeoutMs, idleMs });
    if (outcome === "timeout") {
      ctx.io.err(`timeout: ${beeId} still ${view.view.runtimeState ?? "booting"} after ${timeoutMs}ms`);
      return 1;
    }
    emit(ctx, [viewLine(view, false)], view, false);
    if (view.view.blocked) {
      // v1 parity: a blocked bee did not finish its turn — exit non-zero so
      // `wait && archive` chains do not file a bee stalled on a flag.
      ctx.io.err(`blocked: ${view.view.flags.join(", ")}`);
      return 1;
    }
    return 0;
  });
}

/**
 * `hive v2 run <name> -p <prompt>` — spawn, send, wait for the reply, print it,
 * archive (--keep to leave the bee for inspection). The v1 one-shot shape.
 */
async function cmdRun(ctx: CliContext, parsed: Parsed): Promise<number> {
  const name = parsed.positional[1];
  const prompt = promptOf(parsed, 2);
  if (!name || prompt.length === 0) {
    throw new Error("usage: hive v2 run <name> -p <prompt> [--agent a] [--account id|auto|none] [--cwd d] [--timeout ms] [--keep]");
  }
  const timeoutMs = numFlag(parsed, "--timeout", 600_000);
  const keep = parsed.flags.get("--keep") === true;
  const spawned = await spawnBee(ctx, { ...parsed, positional: ["spawn", name] });
  return withClient(ctx, async (c) => {
    const sent = await c.request<SendRpcResult>("send", { beeId: spawned.beeId, body: prompt, sender: "operator" });
    // Delivery mark first (the mailbox row is the truth), then turn completion.
    const deadline = Date.now() + timeoutMs;
    let deliveredAt: number | null = null;
    while (deliveredAt == null) {
      const { messages } = await c.request<MailboxResult>("mailbox", { beeId: spawned.beeId });
      deliveredAt = messages.find((m) => m.id === sent.messageId)?.deliveredAt ?? null;
      if (deliveredAt == null) {
        if (Date.now() > deadline) {
          ctx.io.err(`timeout: message ${sent.messageId} not delivered within ${timeoutMs}ms — kept ${spawned.beeId} (it remains queued durably)`);
          return 1;
        }
        await sleep(100);
      }
    }
    const { outcome, view } = await waitForBeeIdle(c, spawned.beeId, {
      timeoutMs: Math.max(0, deadline - Date.now()),
      idleMs: 300,
      requireOutputAfter: deliveredAt,
    });
    if (outcome === "timeout") {
      ctx.io.err(`timeout: ${spawned.beeId} did not finish within ${timeoutMs}ms — kept; inspect with: hive v2 tail ${name}`);
      return 1;
    }
    const logPath = view.bee?.sessionLogPath ?? null;
    const reply = logPath && existsSync(logPath)
      ? lastAssistantText(renderTranscriptLines(view.bee?.agent ?? "", readSessionLogLines(logPath)))
      : null;
    let archiveCommandId: number | null = null;
    if (!keep) {
      const r = await c.request<{ commandId: number }>("archive", { beeId: spawned.beeId });
      archiveCommandId = r.commandId;
    }
    if (ctx.json) {
      emit(ctx, [], { beeId: spawned.beeId, messageId: sent.messageId, reply, archived: !keep, archiveCommandId, blocked: view.view.blocked }, false);
    } else {
      ctx.io.out(reply ?? "(no assistant text in the session log)");
      ctx.io.err(keep ? `kept ${spawned.beeId}; clean up with: hive v2 archive ${name}` : `archived ${spawned.beeId} (command ${archiveCommandId})`);
    }
    return view.view.blocked ? 1 : 0;
  });
}

/** `hive v2 here [--json]` — this process's own bee (the HIVE_BEE_ID stamp). */
async function cmdHere(ctx: CliContext, _parsed: Parsed): Promise<number> {
  const id = selfBeeId();
  if (!id) throw new Error("hive v2 here: not running inside a bee (HIVE_BEE_ID unset)");
  try {
    const { result, stale } = await readBee(ctx, id);
    const bee = result.bee;
    emit(
      ctx,
      [`here ${id}  ${bee?.name ?? "?"}  agent=${bee?.agent ?? "?"}  cwd=${bee?.cwd ?? "?"}`],
      { id, name: bee?.name ?? null, agent: bee?.agent ?? null, cwd: bee?.cwd ?? null, parentId: bee?.parentId ?? null, account: bee?.account ?? null },
      stale,
    );
  } catch {
    // The stamp is real even when this node cannot resolve it (other node / no store).
    emit(ctx, [`here ${id}  (not resolvable on this node)`], { id, name: null }, false);
  }
  return 0;
}

// --- session-log reading (transcript / tail / last) ------------------------

function readSessionLogLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return text.split("\n").filter((l) => l.trim().length > 0);
}

/** Human rendering of readable turns: role-tagged first line, indented continuations. */
function turnLines(turns: readonly TranscriptTurn[], prefix = ""): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    const body = turn.text.split("\n");
    out.push(`${prefix}[${turn.role}] ${body[0] ?? ""}`);
    for (const cont of body.slice(1)) out.push(`${prefix}  ${cont}`);
  }
  return out;
}

/** The bee's session log path, loudly absent when never written. */
function sessionLogOf(bee: ViewResult["bee"], needle: string): string {
  const path = bee?.sessionLogPath ?? null;
  if (!path) throw new Error(`no session log recorded for ${bee?.id ?? needle}`);
  if (!existsSync(path)) {
    throw new Error(`session log for ${bee?.id ?? needle} not found at ${path} (written on the first runtime boot)`);
  }
  return path;
}

/**
 * Follow a file's appended lines (tail -f): poll, read past the cursor, emit
 * whole lines. Returns on SIGINT.
 */
async function followFileLines(path: string, fromBytes: number, onLine: (line: string) => void): Promise<void> {
  let pos = fromBytes;
  let rest = "";
  await new Promise<void>((resolveDone) => {
    let stopped = false;
    const onSigint = (): void => {
      stopped = true;
    };
    process.once("SIGINT", onSigint);
    const timer = setInterval(() => {
      if (stopped) {
        clearInterval(timer);
        process.removeListener("SIGINT", onSigint);
        resolveDone();
        return;
      }
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        return; // rotated/removed: keep waiting
      }
      if (size < pos) pos = 0; // truncated: restart from the top
      if (size === pos) return;
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - pos);
        const read = readSync(fd, buf, 0, buf.length, pos);
        pos += read;
        rest += buf.toString("utf8", 0, read);
      } finally {
        closeSync(fd);
      }
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim().length > 0) onLine(line);
    }, 250);
    timer.unref?.();
  });
}

/**
 * `hive v2 transcript <bee> [--tail n] [--raw] [--follow]` — the bee's session
 * log (verbatim native stream) rendered as readable turns; tool traffic is
 * elided to one-liners. `--raw` = the jsonl verbatim. File truth: works with
 * the daemon down (only the bee lookup is stale-labeled).
 */
async function cmdTranscript(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 transcript <bee> [--tail n] [--raw] [--follow]");
  const { result, stale } = await readBee(ctx, needle);
  const bee = result.bee;
  const path = sessionLogOf(bee, needle);
  const harness = bee?.agent ?? "";
  const raw = parsed.flags.get("--raw") === true;
  const tailN = parsed.flags.has("--tail") ? numFlag(parsed, "--tail", 0) : null;
  const lines = readSessionLogLines(path);
  if (!ctx.json) ctx.io.err(`${stale ? "STALE: daemon not running — " : ""}# session log ${path} (${harness})`);
  if (raw) {
    const shown = tailN != null ? lines.slice(-tailN) : lines;
    if (ctx.json) emit(ctx, [], { path, harness, lines: shown }, stale);
    else for (const line of shown) ctx.io.out(line);
  } else {
    const turns = renderTranscriptLines(harness, lines);
    const shown = tailN != null ? turns.slice(-tailN) : turns;
    if (ctx.json) emit(ctx, [], { path, harness, turns: shown }, stale);
    else for (const line of turnLines(shown)) ctx.io.out(line);
  }
  if (parsed.flags.get("--follow") !== true) return 0;
  await followFileLines(path, statSync(path).size, (line) => {
    if (raw) ctx.io.out(line);
    else for (const l of turnLines(renderTranscriptLines(harness, [line]))) ctx.io.out(l);
  });
  return 0;
}

/**
 * `hive v2 tail <bee> [-n lines] [--raw] [--no-follow]` — follow recent output
 * like `tail -f`. v1's tail followed the PANE (readable text); v2's ground
 * truth is the session log, so it renders that log by default and keeps the
 * verbatim stream behind --raw. `transcript` is the same rendering with
 * history/roles; tail is the live tail of it.
 */
async function cmdTail(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 tail <bee> [-n lines] [--raw] [--no-follow]");
  const { result, stale } = await readBee(ctx, needle);
  const path = sessionLogOf(result.bee, needle);
  const harness = result.bee?.agent ?? "";
  // v1 `tail` showed the PANE — readable recent output. A pane-less bee
  // (hsr/cell) has only the structured session log, and dumping it verbatim
  // made `tail` mean something different per substrate (contract §6 says it
  // must not). Render by default; --raw is the verbatim stream.
  const raw = parsed.flags.get("--raw") === true;
  const backlog = numFlag(parsed, "--tail", 40);
  if (stale) ctx.io.err(`STALE: daemon not running — read directly from ${ctx.cfg.storePath}`);
  ctx.io.err(`# session log ${path} (${harness})`);
  const lines = readSessionLogLines(path);
  if (raw) for (const line of lines.slice(-backlog)) ctx.io.out(line);
  else for (const line of turnLines(renderTranscriptLines(harness, lines)).slice(-backlog)) ctx.io.out(line);
  if (parsed.flags.get("--no-follow") === true) return 0;
  await followFileLines(path, statSync(path).size, (line) => {
    if (raw) ctx.io.out(line);
    else for (const l of turnLines(renderTranscriptLines(harness, [line]))) ctx.io.out(l);
  });
  return 0;
}

/**
 * `hive v2 last <bee> [--seal]` — the most recent assistant message from the
 * session log; falls back to the latest seal (title/body) when the log has
 * no assistant text. `--seal` skips straight to the seal (v1 shape).
 */
async function cmdLast(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 last <bee> [--seal]");
  const { result, stale } = await readBee(ctx, needle);
  const bee = result.bee;
  if (!bee) throw new RpcError("bee_not_found", `bee not found: ${needle}`);

  const latestSeal = async (): Promise<SealListResult["seals"][number] | null> => {
    const { result: seals } = await readPath(
      ctx,
      (c) => c.request<SealListResult>("seal.list", { beeId: bee.id }),
      (store) => ({ seals: store.seals({ beeId: bee.id }) }),
    );
    return seals.seals.length > 0 ? (seals.seals[seals.seals.length - 1] as SealListResult["seals"][number]) : null;
  };

  if (parsed.flags.get("--seal") === true) {
    const seal = await latestSeal();
    if (!seal) throw new Error(`no seal recorded for ${bee.id}`);
    emit(ctx, [JSON.stringify(seal, null, 2)], { seal }, stale);
    return 0;
  }

  const path = bee.sessionLogPath;
  const text = path && existsSync(path)
    ? lastAssistantText(renderTranscriptLines(bee.agent, readSessionLogLines(path)))
    : null;
  if (text != null) {
    if (!ctx.json) ctx.io.err(`${stale ? "STALE: daemon not running — " : ""}# session log ${path} (${bee.agent})`);
    emit(ctx, [text], { beeId: bee.id, source: "session_log", text }, stale);
    return 0;
  }
  const seal = await latestSeal();
  if (seal) {
    if (!ctx.json) ctx.io.err("# no assistant text in the session log — latest seal");
    emit(ctx, [seal.title, ...seal.body.split("\n")], { beeId: bee.id, source: "seal", seal }, stale);
    return 0;
  }
  throw new Error(`no assistant output or seal recorded for ${bee.id}`);
}

// --- events (audit-row tail) ------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : ch === "?" ? "." : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}

function auditLine(row: AuditRow, prefix: string): string {
  const payload = JSON.stringify(row.payload);
  const summary = payload.length > 160 ? `${payload.slice(0, 157)}…` : payload;
  return `${prefix}${new Date(row.ts).toISOString()}  #${row.seq}  ${row.kind}${row.beeId ? `  bee=${row.beeId}` : ""}  ${summary}`;
}

/**
 * `hive v2 events [--bee b] [--kind glob] [--tail n] [--follow]` — the audit
 * log is a complete ordered record of every write; this is its tail (the v1
 * `events` shape over the v2 ledger). Kind filtering is a client-side glob
 * (`--kind 'bee.*'`). Works with the daemon down (stale, read-only).
 */
async function cmdEvents(ctx: CliContext, parsed: Parsed): Promise<number> {
  const kindGlob = parsed.flags.get("--kind") as string | undefined;
  const matcher = kindGlob ? globToRegExp(kindGlob) : null;
  const beeFlag = parsed.flags.get("--bee") as string | undefined;
  const limit = numFlag(parsed, "--tail", 50);
  const follow = parsed.flags.get("--follow") === true;

  const readRows = (afterSeq: number, n: number): Promise<{ result: AuditTailResult; stale: boolean }> =>
    readPath(
      ctx,
      async (c) => {
        const beeId = beeFlag ? resolveBeeIn((await c.request<ListResult>("list")).views, beeFlag) : undefined;
        return c.request<AuditTailResult>("audit.tail", { afterSeq, limit: n, ...(beeId ? { beeId } : {}) });
      },
      (store) => {
        const beeId = beeFlag ? resolveBeeIn(store.list(null), beeFlag) : undefined;
        return { rows: store.auditRows(afterSeq, beeId).slice(-n) };
      },
    );

  const { result, stale } = await readRows(0, limit);
  const rows = matcher ? result.rows.filter((r) => matcher.test(r.kind)) : result.rows;
  const prefix = stale ? "stale: " : "";
  emit(
    ctx,
    rows.length > 0 ? rows.map((r) => auditLine(r, prefix)) : [`${prefix}no events`],
    { rows },
    stale,
  );
  if (!follow) return 0;

  // Follow: poll the cursor. Works daemon-up (RPC) and daemon-down (stale poll).
  let lastSeq = result.rows.length > 0 ? (result.rows[result.rows.length - 1] as AuditRow).seq : 0;
  let stopped = false;
  const onSigint = (): void => {
    stopped = true;
  };
  process.once("SIGINT", onSigint);
  try {
    while (!stopped) {
      await sleep(300);
      if (stopped) break;
      const next = await readRows(lastSeq, 1000);
      for (const row of next.result.rows) {
        lastSeq = Math.max(lastSeq, row.seq);
        if (matcher && !matcher.test(row.kind)) continue;
        ctx.io.out(ctx.json ? JSON.stringify(row) : auditLine(row, next.stale ? "stale: " : ""));
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  return 0;
}

// --- set-model (sugar over bee.setArgs) ------------------------------------

function grammarForAgent(agent: string): ArgGrammar | null {
  if (agent === "claude") return claudeArgGrammar;
  if (agent === "codex") return codexArgGrammar;
  return null;
}

/**
 * Replace/inject the model selector in a bee's per-bee args. Known harness
 * grammars go through the composition helpers (later valued flag wins, alias
 * folding, `--model=x` handled); unknown harnesses get a conservative
 * in-place replace of `--model/-m`. `model: null` strips the selector.
 * Exported for tests.
 */
export function withModelArg(agent: string, args: string[] | null, model: string | null): string[] | null {
  const grammar = grammarForAgent(agent);
  const current = args ?? [];
  if (model === null) {
    const next = grammar
      ? parseArgUnits(grammar, current)
          .filter((u) => u.identity !== "--model")
          .flatMap((u) => u.tokens)
      : stripGenericModel(current);
    return next.length === 0 ? null : next;
  }
  if (grammar) return composeArgv(grammar, [current, ["--model", model]]);
  const next = [...current];
  for (let i = 0; i < next.length; i += 1) {
    const tok = next[i] as string;
    if ((tok === "--model" || tok === "-m") && i + 1 < next.length) {
      next[i + 1] = model;
      return next;
    }
    if (tok.startsWith("--model=")) {
      next[i] = `--model=${model}`;
      return next;
    }
  }
  return [...next, "--model", model];
}

function stripGenericModel(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i] as string;
    if (tok === "--model" || tok === "-m") {
      i += 1; // skip the value
      continue;
    }
    if (tok.startsWith("--model=")) continue;
    out.push(tok);
  }
  return out;
}

/**
 * `hive v2 set-model <bee> <model> | --clear` — v1's set-model, v2-shaped:
 * per-bee args surgery over `bee.setArgs`. Unlike v1 it does NOT relaunch in
 * place — the daemon owns runtimes; the change applies on the NEXT runtime
 * (stop or revive to apply now).
 */
async function cmdSetModel(ctx: CliContext, parsed: Parsed): Promise<number> {
  const usage = "usage: hive v2 set-model <bee> <model> | set-model <bee> --clear";
  const [, needle, model] = parsed.positional;
  const clear = parsed.flags.get("--clear") === true;
  if (!needle || (!model && !clear)) throw new Error(usage);
  if (model && clear) throw new Error(`set-model: pass either <model> or --clear, not both\n${usage}`);
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const bee = list.views.find((v) => v.bee?.id === beeId)?.bee;
    const args = withModelArg(bee?.agent ?? "", bee?.args ?? null, clear ? null : (model as string));
    const r = await c.request<SetArgsResult>("bee.setArgs", {
      beeId,
      args,
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    });
    emit(
      ctx,
      [
        `${r.applied ? "set" : "unchanged"} model for ${beeId}: ${clear ? "harness default" : model} — args ${r.bee.args ? JSON.stringify(r.bee.args) : "(none)"}` +
          " — applies to the next runtime (stop or revive to apply)",
      ],
      r,
      false,
    );
    return 0;
  });
}

// --- usage (account_limits rendering, the v1 `usage` table) ----------------

function usageBar(pct: number): string {
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function timeUntil(atMs: number | null, now: number): string {
  if (atMs == null) return "";
  const delta = atMs - now;
  if (delta <= 0) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function usageWindowCell(pct: number | null, resetsAt: number | null, now: number, bar: boolean): string {
  if (pct == null) return "-";
  const clamped = Math.max(0, Math.min(100, pct));
  const reset = resetsAt != null ? ` ⟳ ${timeUntil(resetsAt, now)}` : "";
  return `${bar ? `${usageBar(clamped)} ` : ""}${String(Math.round(clamped)).padStart(3)}%${reset}`;
}

/** "live" for a fresh row, else "<age> ago". */
function fetchedAgo(fetchedAt: number, now: number): string {
  const ageMs = now - fetchedAt;
  if (ageMs < 60_000) return "live";
  return `${timeUntil(now + ageMs, now)} ago`;
}

/**
 * `hive v2 usage [account]` — where the accounts stand against the providers'
 * real 5h/weekly/fable windows (v1's `usage`/`limits` table). Daemon up: the
 * rows are refreshed via `account.limits`; down: the cached snapshots, stale.
 */
async function cmdUsage(ctx: CliContext, parsed: Parsed): Promise<number> {
  const id = parsed.positional[1];
  const { result, stale } = await readPath(
    ctx,
    // Sweep-sized timeout: the daemon probes every account live (serialized,
    // one bounded fetch each) — the default 10s rpc timeout fires mid-sweep.
    (c) => c.request<AccountLimitsResult>("account.limits", id ? { id } : {}, 120_000),
    (store) => ({ limits: store.accountLimits().filter((l) => id === undefined || l.account === id) }),
  );
  if (result.limits.length === 0) {
    emit(ctx, [`${stale ? "stale: " : ""}no accounts${id ? ` matching ${id}` : ""} — add one with: hive v2 account add <harness> <label>`], result, stale);
    return 0;
  }
  const now = Date.now();
  const rows = result.limits.map((l) =>
    l.readable
      ? [
          l.account,
          l.plan ?? "-",
          usageWindowCell(l.fiveHourPct, l.fiveHourResetsAt, now, true),
          usageWindowCell(l.weeklyPct, l.weeklyResetsAt, now, true),
          usageWindowCell(l.fableWeeklyPct, l.fableResetsAt, now, false),
          fetchedAgo(l.fetchedAt, now),
        ]
      : [l.account, "-", `unreadable: ${l.error ?? "?"}`, "", "", ""],
  );
  const headers = ["ACCOUNT", "PLAN", "5H", "WEEKLY", "FABLE", "AS-OF"];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] as number)).join("  ").trimEnd();
  const prefix = stale ? "stale: " : "";
  emit(ctx, [`${prefix}${line(headers)}`, ...rows.map((r) => `${prefix}${line(r)}`)], result, stale);
  return 0;
}

// --- attach ----------------------------------------------------------------

/**
 * `hive v2 attach <bee> [--print]` — tmux-substrate bees only: attach the
 * driver's recorded session (`hive-v2-<bee>-g<generation>`). hsr/cell bees
 * are pane-less by design and are refused with the v2 way to watch them.
 */
async function cmdAttach(ctx: CliContext, parsed: Parsed): Promise<number> {
  const needle = parsed.positional[1];
  if (!needle) throw new Error("usage: hive v2 attach <bee> [--print]");
  const { result } = await readBee(ctx, needle);
  const bee = result.bee;
  if (!bee) throw new RpcError("bee_not_found", `bee not found: ${needle}`);
  if (bee.substrate !== "tmux") {
    const how = bee.substrate === "cell" ? "a cell bee (headless harness inside its checkout)" : `an ${bee.substrate} bee (pane-less runner)`;
    ctx.io.err(
      `hive v2 attach: ${bee.id} is ${how} — there is no terminal to attach.\n` +
        `watch it with: hive v2 tail ${needle}  |  hive v2 transcript ${needle} --follow\n` +
        `talk to it with: hive v2 send ${needle} <message…>`,
    );
    return 1;
  }
  const generation = result.view.generation;
  if (generation == null) throw new Error(`hive v2 attach: ${bee.id} has no recorded runtime generation`);
  const session = sessionNameFor(bee.id, generation);
  const command = `tmux attach-session -t =${session}`;
  if (parsed.flags.get("--print") === true || ctx.json) {
    emit(ctx, [command], { beeId: bee.id, session, command }, false);
    return 0;
  }
  const res = spawnSync("tmux", ["attach-session", "-t", `=${session}`], { stdio: "inherit" });
  if (res.error) throw new Error(`tmux attach failed: ${res.error.message}`);
  return res.status ?? 0;
}

// ---------------------------------------------------------------------------
// WP7 cutover: freeze the old world, import its active bees (spec 07 B3/B4)
// ---------------------------------------------------------------------------

/** The old-world store root: --root, else HIVE_STORE_ROOT (the old CLI's own override, src/fsx.ts), else ~/.hive. */
function frozenRootOf(parsed: Parsed): string {
  const flag = parsed.flags.get("--root") as string | undefined;
  return resolve(flag ?? process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive"));
}

/**
 * `hive v2 freeze [--root r] [--force]` — B3. Local: writes `<root>/FROZEN`
 * (the ONE write into the old root, the operator's), refusing while the old
 * daemon's lock pid is alive. Does not need the v2 daemon.
 */
async function cmdFreeze(ctx: CliContext, parsed: Parsed): Promise<number> {
  const root = frozenRootOf(parsed);
  const result = freezeRoot(root, {
    probes: realPreflightProbes(),
    force: parsed.flags.get("--force") === true,
    by: `hive v2 freeze (host ${hostname()}, pid ${process.pid})`,
  });
  const lines =
    result.outcome === "written"
      ? [`frozen: ${result.markerPath} written — the old-world store at ${root} is now read-only by convention (remove the marker to unfreeze, spec 07 §C)`]
      : result.outcome === "already_frozen"
        ? [`already frozen: ${result.markerPath} exists`]
        : [`refused: ${result.refusal}`];
  emit(ctx, lines, result, false);
  return result.outcome === "refused" ? 1 : 0;
}

function planEntryLine(e: ImportPlanEntry): string {
  if (e.action === "import") {
    const bee = e.bee;
    const resume =
      e.resume === "harness_native"
        ? `resume=native(${bee?.providerSessionId ?? "?"})`
        : e.resume === "fresh_no_session_id"
          ? "resume=FRESH(no provider session id)"
          : "resume=FRESH(no v2 resume path)";
    const notes = e.notes.length > 0 ? `  [${e.notes.join("; ")}]` : "";
    return `  import ${e.originalId}  ${e.name}  agent=${e.agent} substrate=${bee?.substrate ?? "?"}  ${resume}${notes}`;
  }
  const notes = e.notes.length > 0 ? `  (${e.notes.join("; ")})` : "";
  return `  skip   ${e.originalId}  ${e.name}  agent=${e.agent}  reason=${e.reason}${notes}`;
}

function importReportLines(report: FrozenImportReport, verbose: boolean): string[] {
  const c = report.plan.counts;
  const lines: string[] = [];
  lines.push(`${report.dryRun ? "dry-run: " : ""}import --from-frozen ${report.frozenRoot}`);
  lines.push(`  marker: ${report.preflight.markerPresent ? "FROZEN present" : "FROZEN MISSING"}`);
  lines.push(
    `  preflight: ${report.preflight.ok ? "no live old-world runtimes" : `${report.preflight.live.length} live old-world runtime(s)`}`,
  );
  for (const l of report.preflight.live) lines.push(`    - ${l.detail}`);
  lines.push(`  plan: would import ${c.import}, skip ${c.skip}`);
  const byReason = Object.entries(c.byReason).map(([k, v]) => `${k}=${v}`).join(" ");
  if (byReason) lines.push(`    skipped by reason: ${byReason}`);
  const byResume = Object.entries(c.byResume).map(([k, v]) => `${k}=${v}`).join(" ");
  if (byResume) lines.push(`    resume modes:      ${byResume}`);
  const shown = verbose ? report.plan.entries : report.plan.entries.filter((e) => e.action === "import" || (e.reason !== "done" && e.reason !== "already_imported"));
  for (const e of shown) lines.push(planEntryLine(e));
  if (!verbose) {
    const hidden = report.plan.entries.length - shown.length;
    if (hidden > 0) lines.push(`  (… ${hidden} done/already-imported rows hidden; --verbose lists all)`);
  }
  if (report.refusal) lines.push(`REFUSED: ${report.refusal}`);
  else if (report.dryRun) lines.push("dry-run: nothing written");
  else lines.push(`imported ${report.imported.length} bee(s)`);
  return lines;
}

/**
 * `hive v2 import --from-frozen [--root r] [--dry-run] [--force] [--verbose]`
 * — B4. RPC only (the daemon is the sole writer); refusals are reports, not
 * errors, and exit 1.
 */
async function cmdImport(ctx: CliContext, parsed: Parsed): Promise<number> {
  if (parsed.flags.get("--from-frozen") !== true) {
    throw new Error("usage: hive v2 import --from-frozen [--root r] [--dry-run] [--force] [--verbose] [--idempotency-key k]");
  }
  const root = frozenRootOf(parsed);
  const result = await withClient(ctx, (c) =>
    c.request<ImportFromFrozenResult>("import.fromFrozen", {
      root,
      dryRun: parsed.flags.get("--dry-run") === true,
      force: parsed.flags.get("--force") === true,
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    }),
  );
  emit(ctx, importReportLines(result, parsed.flags.get("--verbose") === true), result, false);
  return result.applied || result.dryRun ? 0 : 1;
}

// ---------------------------------------------------------------------------
// daemon service subcommands
// ---------------------------------------------------------------------------

const realExec: ExecRunner = (cmd, args) =>
  new Promise((resolveExec) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      const code = error == null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolveExec({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function serviceLabel(env: Record<string, string | undefined> = process.env): string {
  // NEVER the old daemon's label (dev.honeybee.hive) — the v2 service is a
  // separate unit until WP7 flips the default.
  return env.HIVE_V2_SERVICE_LABEL ?? "dev.honeybee.hive.v2";
}

export function serviceEnv(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  // launchd/systemd start services with a bare PATH (/usr/bin:/bin:…) that
  // cannot resolve the harness binaries (claude/codex/…) living in
  // user-managed dirs — every spawn would die instantly with a mute ENOENT
  // (2026-08-19 soak finding). Bake the installing shell's PATH into the
  // unit, exactly like the v1 daemon install does.
  return { HIVE_V2_DATA_DIR: dataDir, ...(env.PATH ? { PATH: env.PATH } : {}) };
}

export function serviceExecArgs(dataDir: string, env: Record<string, string | undefined> = process.env): string[] {
  if (env.HIVE_V2_SERVICE_ARGS) return JSON.parse(env.HIVE_V2_SERVICE_ARGS) as string[];
  // Prefer the versioned-runtime entry over argv[1]: the PATH `hive` shim can
  // drift (2026-08-19: it pointed at a working checkout), and the `current`
  // symlink is the deploy contract — a service pinned to it follows every
  // deploy across restarts.
  const runtimeEntry = join(homedir(), ".hive", "runtime", "current", "dist", "cli.js");
  const entry = existsSync(runtimeEntry) ? runtimeEntry : resolve(process.argv[1] ?? "");
  // Invoked through the old hive binary → the daemon runs as `hive v2 daemon
  // run`; invoked through the standalone v2 bin → no `v2` prefix.
  const viaHive = !/[/\\]v2[/\\]/.test(entry);
  return [process.execPath, entry, ...(viaHive ? ["v2"] : []), "daemon", "run", "--data-dir", dataDir];
}

function buildServiceManager(ctx: CliContext): ServiceManager {
  const platform = process.platform;
  const dir =
    process.env.HIVE_V2_SERVICE_DIR ??
    (platform === "darwin" ? join(homedir(), "Library", "LaunchAgents") : join(homedir(), ".config", "systemd", "user"));
  return createServiceManager(
    platform,
    {
      label: serviceLabel(),
      execArgs: serviceExecArgs(ctx.cfg.dataDir),
      logPath: ctx.cfg.logPath,
      env: serviceEnv(ctx.cfg.dataDir),
    },
    { exec: realExec, dir, uid: process.getuid?.() ?? 0 },
  );
}

async function cmdDaemon(ctx: CliContext, parsed: Parsed): Promise<number> {
  const sub = parsed.positional[1];
  switch (sub) {
    case "run":
      // Foreground daemon — what the service files execute.
      return runDaemon(["--data-dir", ctx.cfg.dataDir, "--socket", ctx.cfg.socketPath]);
    case "install": {
      const mgr = buildServiceManager(ctx);
      await mgr.install();
      emit(ctx, [`installed ${mgr.platform} service at ${mgr.servicePath}`], { servicePath: mgr.servicePath }, false);
      return 0;
    }
    case "uninstall": {
      const mgr = buildServiceManager(ctx);
      await mgr.uninstall();
      emit(ctx, [`uninstalled ${mgr.platform} service`], { servicePath: mgr.servicePath }, false);
      return 0;
    }
    case "start": {
      const mgr = buildServiceManager(ctx);
      await mgr.start();
      emit(ctx, [`started ${serviceLabel()}`], { label: serviceLabel() }, false);
      return 0;
    }
    case "stop": {
      const mgr = buildServiceManager(ctx);
      await mgr.stop();
      emit(ctx, [`stopped ${serviceLabel()}`], { label: serviceLabel() }, false);
      return 0;
    }
    case "status": {
      // The daemon's own word first; the service manager's second.
      try {
        const health = await withClient(ctx, (c) => c.request<HealthResult>("health"));
        emit(
          ctx,
          [`daemon: running (pid ${health.pid}, ${health.ticks} ticks, ${health.i1Violations} i1 violations)`],
          { running: true, health },
          false,
        );
        return 0;
      } catch (err) {
        if (!(err instanceof DaemonDownError)) throw err;
      }
      const mgr = buildServiceManager(ctx);
      if (existsSync(mgr.servicePath)) {
        const status = await mgr.status();
        emit(
          ctx,
          [`daemon: not reachable at ${ctx.cfg.socketPath}; service ${status.detail}`],
          { running: false, service: status },
          false,
        );
      } else {
        emit(
          ctx,
          [`daemon: not running (socket ${ctx.cfg.socketPath}; no service installed)`],
          { running: false, service: null },
          false,
        );
      }
      return 0;
    }
    default:
      throw new Error("usage: hive v2 daemon <run|install|uninstall|start|stop|status>");
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const HELP = `hive v2 — Honeybee reset stack

Usage: hive v2 <command> [args] [--data-dir d] [--socket s] [--json]
  Mutations go through the daemon (RPC). Reads fall back to the read-only
  store when the daemon is down — that output is clearly labeled STALE.
  (--idempotency-key on any mutation: spec 06 §4.2 one-key rule — a replayed
   key returns the original outcome, marked deduped, instead of executing twice.)

Spawn & run:
  spawn <name> --agent <a> [--cwd d] [--title t] [--tag t]... [--arg a]... [--account <id>|auto|none]
  spawn … [--parent <bee>|--no-parent]        parenting: filled from HIVE_BEE_ID when spawning from a bee
  spawn <name> --agent <a> --substrate cell --origin <repo> [--sha s] [--warm [d,d]] [--sandbox|--no-sandbox]
                                              spawn into a provisioned cell (the bee's cwd is the checkout)
  x <name> <prompt…>                          spawn + first send, fire-and-forget (--agent/--account/--cwd…)
  run <name> -p <prompt> [--keep] [--timeout ms]   spawn, send, wait, print the reply, archive (--keep skips)
  fork <bee> [--name n] [--prompt p|prompt…]  new bee, same shape, continues the source's conversation

Message:
  send <bee> <message…> [--urgency now|next|idle] [--sender s] [--wait] [--timeout ms]
                          urgency: now = interrupt the current turn, then deliver;
                          next = the next accept point (default); idle = wait until the turn ends
  ask <question…> [--option o]... [--bee b]   (from inside a bee) ask the operator; the answer returns as mail
  answer <question-id> <answer…> [--by who]   answer an open question (also: question answer …)
  question list [--bee b] [--open]
  seal <title> [--body t] [--ref r]... [--bee b]   record a seal (metadata; current generation)
  seal list [--bee b] · seal get <id>
  buz send <bee> -p <body> [--sender b|--sender-human n] [--tier t]   v1 compat: a mailbox send
                          (tiers map onto urgency: interrupt→now, next-tool→next, queue/passive→idle)
  buz inbox [bee]                             v1 compat: the mailbox (defaults to self inside a bee)

Observe:
  list [--all|--archived]                     all bees with state (aliases: ls, ps)
  view <bee> · mailbox <bee> · commands <bee> · children <bee>
  transcript <bee> [--tail n] [--raw] [--follow]   the session log rendered as readable turns (alias: tx)
  tail <bee> [-n lines] [--raw] [--no-follow] follow recent output (rendered; --raw = verbatim log)
  last <bee> [--seal]                         the most recent assistant message (fallback: latest seal)
  wait <bee> [--timeout ms] [--idle-ms ms]    block until the bee is idle/stopped with no queued mail
  events [--bee b] [--kind glob] [--tail n] [--follow]   audit-row tail (the ledger of every write)
  here [--json]                               this process's own bee (the HIVE_BEE_ID stamp)
  usage [account]                             provider 5h/weekly/fable windows per account (alias: limits)
  watch [--bee id]                            whole-node change stream (snapshot + seq deltas)
  deploy-info · health

Manage bees:
  stop | revive | archive | unarchive | delete <bee>
  revive <bee> [--arg a]... | [-- <args…>]    (revive with replacement per-bee args)
  interrupt <bee>                             stop the current TURN, keep the runtime (idle = no-op)
  rename <bee> <new-name>                     rename (names are labels; the id is the identity)
  tag <bee> [--add t]... [--remove t]...      edit tags (apiary:workspace=… moves a bee between workspaces)
  bee set-args <bee> -- <args…> | --clear     per-bee harness args (--model, --effort, …);
  bee args <bee>                              layered over the agent spec on the NEXT runtime
  set-model <bee> <model> | --clear           model surgery on the per-bee args (applies next runtime)
  attach <bee> [--print]                      tmux-substrate bees only (hsr/cell are pane-less: use tail)
  cell capture <bee> --onto <branch> [--rebase]   land the cell's commits onto an origin branch
  cell remove <bee> [--force]                 delete the cell (dirty guard) + delete the bee

Accounts:
  account list [--harness h] · get <id>       accounts + latest limits
  account add <harness> <label> [--id id] [--home dir] [--penalty n]
  account remove|pause|unpause <id> · penalty <id> <0-100>
  login <account>                             the login seat (also: account login <id>)
  swap-account <bee> <account>                move a bee to another account of the SAME harness
                                              (stop → rebind → revive with resume; claude gets a new session id)
  account limits [<id>]                       refresh + show provider limits (feeds the auto pick)
  account import [--root ~/.hive] [--dry-run] · account backfill [--dry-run]

Templates & tracks (rows are truth, files are packages):
  template list [--scope s] · get|export <id|name> [--out f] · put --file f [--id id]
  template delete <id|name> · import <package.json> [--scope s] [--source label]
  track    list [--scope s] · get|export <id|name> [--out f] · put --file f [--id id]
  track    delete <id|name> · import <package.json> [--scope s] [--source label]
  packages import-local [--dir d] [--scope s]

Cutover (freeze the old world, import its active bees):
  freeze [--root r] [--force]                 write <root>/FROZEN (refuses while the old daemon is alive)
  import --from-frozen [--root r] [--dry-run] [--force] [--verbose]

Daemon:
  daemon run                                  run the daemon in the foreground
  daemon install|uninstall|start|stop|status`;

export async function runV2Cli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const command = parsed.positional[0] ?? "help";
  try {
    const ctx = makeContext(parsed, io);
    switch (command) {
      case "spawn":
        return await cmdSpawn(ctx, parsed);
      case "send":
        return await cmdSend(ctx, parsed);
      case "buz":
        return await cmdBuz(ctx, parsed);
      case "stop":
      case "revive":
      case "archive":
      case "unarchive":
      case "delete":
        return await cmdMutation(ctx, parsed, command);
      case "bee":
        return await cmdBee(ctx, parsed);
      case "rename":
        return await cmdRename(ctx, parsed);
      case "tag":
        return await cmdTag(ctx, parsed);
      case "interrupt":
        return await cmdInterrupt(ctx, parsed);
      case "fork":
        return await cmdFork(ctx, parsed);
      case "children":
        return await cmdChildren(ctx, parsed);
      case "ask":
        return await cmdAsk(ctx, parsed);
      case "question":
        return await cmdQuestion(ctx, parsed);
      case "answer":
        return await cmdAnswer(ctx, parsed);
      case "seal":
        return await cmdSeal(ctx, parsed);
      case "cell":
        return await cmdCell(ctx, parsed);
      case "account":
        return await cmdAccount(ctx, parsed);
      case "x":
        return await cmdX(ctx, parsed);
      case "run":
        return await cmdRun(ctx, parsed);
      case "wait":
        return await cmdWait(ctx, parsed);
      case "here":
        return await cmdHere(ctx, parsed);
      case "transcript":
      case "tx":
        return await cmdTranscript(ctx, parsed);
      case "tail":
        return await cmdTail(ctx, parsed);
      case "last":
        return await cmdLast(ctx, parsed);
      case "events":
        return await cmdEvents(ctx, parsed);
      case "set-model":
        return await cmdSetModel(ctx, parsed);
      case "usage":
      case "limits":
        return await cmdUsage(ctx, parsed);
      case "attach":
        return await cmdAttach(ctx, parsed);
      case "login": {
        const id = parsed.positional[1];
        if (!id) throw new Error("usage: hive v2 login <account>");
        return await cmdAccount(ctx, { ...parsed, positional: ["account", "login", id] });
      }
      case "swap-account": {
        const [, bee, account] = parsed.positional;
        if (!bee || !account) throw new Error("usage: hive v2 swap-account <bee> <account>");
        return await cmdBee(ctx, { ...parsed, positional: ["bee", "swap-account", bee, account] });
      }
      case "view":
        return await cmdView(ctx, parsed);
      case "list":
      case "ls":
      case "ps":
        return await cmdList(ctx, parsed);
      case "mailbox":
        return await cmdMailbox(ctx, parsed);
      case "commands":
        return await cmdCommands(ctx, parsed);
      case "deploy-info":
        return await cmdDeployInfo(ctx);
      case "health":
        return await cmdHealth(ctx);
      case "watch":
        return await cmdWatch(ctx, parsed);
      case "template":
        return await cmdTemplate(ctx, parsed);
      case "track":
        return await cmdTrack(ctx, parsed);
      case "packages":
        return await cmdPackages(ctx, parsed);
      case "freeze":
        return await cmdFreeze(ctx, parsed);
      case "import":
        return await cmdImport(ctx, parsed);
      case "daemon":
        return await cmdDaemon(ctx, parsed);
      case "help":
      case "--help":
        io.out(HELP);
        return 0;
      default:
        io.err(`unknown v2 command: ${command}`);
        io.out(HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof DaemonDownError) {
      io.err(`${err.message} — start it with: hive v2 daemon run (or daemon start)`);
      return 1;
    }
    if (err instanceof RpcError) {
      io.err(`error (${err.code}): ${err.message}`);
      return 1;
    }
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
