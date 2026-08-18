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
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
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
import { freezeRoot, type FrozenImportReport, type ImportPlanEntry } from "../../core/src/index.ts";
import { realPreflightProbes } from "../../daemon/src/import-probes.ts";
import { hostname } from "node:os";

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
  ...LIST_FLAGS,
]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const tags: string[] = [];
  const args: string[] = [];
  const lists = new Map<string, string[]>();
  let rest: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
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
// bee resolution (exact id, else unique name)
// ---------------------------------------------------------------------------

function resolveBeeIn(views: ViewResult[], needle: string): string {
  const byId = views.find((v) => v.bee?.id === needle);
  if (byId?.bee) return byId.bee.id;
  const byName = views.filter((v) => v.bee?.name === needle);
  if (byName.length === 1 && byName[0]?.bee) return byName[0].bee.id;
  if (byName.length > 1) throw new Error(`bee name '${needle}' is ambiguous (${byName.length} matches) — use the id`);
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
  return `${prefix}${bee?.id ?? v.view.beeId}  ${bee?.name ?? "?"}  agent=${bee?.agent ?? "?"}  gen=${v.view.generation ?? 0}  ${status}  ${derived}  ${v.view.lifecycle ?? "deleted"}${flags}${failures}${args}${parent}${tags}`;
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
    const store = new ReadOnlyStore(ctx.cfg.storePath);
    try {
      return { result: fallback(store), stale: true };
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
  "usage: hive v2 spawn <name> --agent <agent> [--account id|auto|none] [--cwd dir] [--title t] [--tag t]... [--arg a]... [--parent bee|--no-parent] [--idempotency-key k]\n" +
  "       hive v2 spawn <name> --agent <agent> --substrate cell --origin <repo> [--sha s] [--warm dir,dir|--warm] [--sandbox|--no-sandbox]";

async function cmdSpawn(ctx: CliContext, parsed: Parsed): Promise<number> {
  const name = parsed.positional[1];
  if (!name) throw new Error(SPAWN_USAGE);
  const agent = (parsed.flags.get("--agent") as string | undefined) ?? "claude";
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
  const accountNote = result.account ? `; account ${result.account}${result.accountReason ? ` — ${result.accountReason}` : ""}` : "";
  emit(
    ctx,
    [`${result.deduped ? "deduped: already " : ""}spawned ${result.beeId} (command ${result.commandId}${result.status ? ` ${result.status}` : ""}${accountNote})`],
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

export function serviceExecArgs(dataDir: string, env: Record<string, string | undefined> = process.env): string[] {
  if (env.HIVE_V2_SERVICE_ARGS) return JSON.parse(env.HIVE_V2_SERVICE_ARGS) as string[];
  const entry = resolve(process.argv[1] ?? "");
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
      env: { HIVE_V2_DATA_DIR: ctx.cfg.dataDir },
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

const HELP = `hive v2 — Honeybee reset stack (WP4)

Usage: hive v2 <command> [args] [--data-dir d] [--socket s] [--json]

Mutations (RPC, daemon must be running):
  spawn <name> --agent <a> [--cwd d] [--title t] [--tag t]... [--arg a]... [--idempotency-key k]
  spawn <name> --agent <a> --substrate cell --origin <repo> [--sha s] [--warm [d,d]] [--sandbox|--no-sandbox]
                                             spawn into a provisioned cell (spec 05): the bee's cwd is
                                             the cell checkout; --sha defaults to the origin's HEAD
  cell capture <bee> --onto <branch> [--rebase]   land the cell's commits onto an origin branch
                                             (merge by default); refusals/conflicts are results
  cell remove <bee> [--force]                delete the cell (dirty guard, A2) + delete the bee
  send <bee> <message…> [--urgency now|next|idle] [--sender s] [--wait] [--timeout ms] [--idempotency-key k]
                          urgency: now = interrupt the current turn, then deliver;
                          next = the next accept point (default); idle = wait until the turn ends
  stop | revive | archive | unarchive | delete <bee>
  revive <bee> [--arg a]... | [-- <args…>]   (revive with replacement per-bee args)
  bee set-args <bee> -- <args…> | --clear    per-bee harness args (--model, --effort, …);
  bee args <bee>                             layered over the agent spec on the NEXT runtime
  rename <bee> <new-name>                    rename (names are labels; the id is the identity)
  tag <bee> [--add t]... [--remove t]...     edit tags (apiary:workspace=… moves a bee between workspaces)
  interrupt <bee>                            stop the current TURN, keep the runtime (idle = no-op)
  fork <bee> [--name n] [--prompt p|prompt…] new bee, same shape, continues the source's conversation
                                             in a NEW session; parentId = forkedFrom = source
  spawn … [--parent <bee>|--no-parent]       parenting: filled from HIVE_BEE_ID when spawning from a bee
  ask <question…> [--option o]... [--bee b]  (from inside a bee) ask the operator; the answer comes back as mail
  answer <question-id> <answer…> [--by who]  answer an open question (also: question answer …)
  seal <title> [--body t] [--ref r]... [--bee b]   record a seal for this bee (metadata; current generation)
  spawn … [--account <id>|auto|none]         account binding (spec 08): auto (default) = the calibrated
                                             least-loaded pick; an explicit id is validated
  bee swap-account <bee> <account>           move a bee to another account of the SAME harness
                                             (stop → rebind → revive with resume; claude gets a new session id)
  account list [--harness h] · get <id>      accounts + latest limits (read-only fallback when the daemon is down)
  account add <harness> <label> [--id id] [--home dir] [--penalty n]
  account remove|pause|unpause <id> · penalty <id> <0-100>
  account login <id>                         the login seat: a detached tmux session running the harness's
                                             own login against the account's home; captured to the vault
  account limits [<id>]                      refresh + show provider limits (feeds the auto pick)
  account import [--root ~/.hive] [--dry-run] import the OLD vault registry (read-only) into rows + backfill
  account backfill [--dry-run]               bind env-only (imported) bees to accounts by home path
  (--idempotency-key: spec 06 §4.2 one-key rule — a replayed key returns the
   original outcome, marked deduped, instead of executing twice)

Reads (RPC; read-only store fallback labeled STALE when daemon is down):
  view <bee> · list [--all|--archived] · mailbox <bee> · commands <bee>
  children <bee> · question list [--bee b] [--open] · seal list [--bee b] · seal get <id>
  deploy-info · health

Templates + tracks + packages (spec 06 §1.4.1 — rows are truth, files are packages):
  template list [--scope s] · get|export <id|name> [--out f] · put --file f [--id id]
  template delete <id|name> · import <package.json> [--scope s] [--source label]
  track    list [--scope s] · get|export <id|name> [--out f] · put --file f [--id id]
  track    delete <id|name> · import <package.json> [--scope s] [--source label]
  packages import-local [--dir d] [--scope s]   import ~/.hive-style local config (manual, v1)

Cutover (spec 07 B3/B4 — freeze the old world, import its active bees):
  freeze [--root r] [--force]                 write <root>/FROZEN (refuses while the old daemon is alive)
  import --from-frozen [--root r] [--dry-run] [--force] [--verbose]
                                              import active old-world bees (records + provider session
                                              ids for harness-native resume); refuses while old
                                              runtimes are live; idempotent; root defaults to ~/.hive

Watch:
  watch [--bee id]        whole-node change stream (snapshot + seq deltas)

Daemon:
  daemon run              run the daemon in the foreground
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
      case "view":
        return await cmdView(ctx, parsed);
      case "list":
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
