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
  type HealthResult,
  type ListResult,
  type MailboxResult,
  type CommandsResult,
  type SendRpcResult,
  type SnapshotResult,
  type SpawnResult,
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
}

const VALUE_FLAGS = new Set([
  "--agent",
  "--cwd",
  "--title",
  "--tag",
  "--sender",
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
]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const tags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      if (a === "--tag") tags.push(v);
      else flags.set(a, v);
    } else {
      flags.set(a, true);
    }
  }
  return { positional, flags, tags };
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
  const status =
    v.view.runtimeState === "stopped"
      ? `stopped(${v.view.exitCause})`
      : (v.view.runtimeState ?? "no-runtime");
  const derived = v.view.working ? "working" : v.view.waitingForYou ? "waiting-for-you" : "quiet";
  const prefix = stale ? "stale: " : "";
  return `${prefix}${bee?.id ?? v.view.beeId}  ${bee?.name ?? "?"}  agent=${bee?.agent ?? "?"}  gen=${v.view.generation ?? 0}  ${status}  ${derived}  ${v.view.lifecycle ?? "deleted"}${flags}`;
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

async function cmdSpawn(ctx: CliContext, parsed: Parsed): Promise<number> {
  const name = parsed.positional[1];
  if (!name) throw new Error("usage: hive v2 spawn <name> --agent <agent> [--cwd dir] [--title t] [--tag t]... [--idempotency-key k]");
  const agent = (parsed.flags.get("--agent") as string | undefined) ?? "claude";
  const cwd = resolve((parsed.flags.get("--cwd") as string | undefined) ?? process.cwd());
  const result = await withClient(ctx, (c) =>
    c.request<SpawnResult>("spawn", {
      name,
      agent,
      cwd,
      title: parsed.flags.get("--title") as string | undefined,
      tags: parsed.tags,
      idempotencyKey: parsed.flags.get("--idempotency-key") as string | undefined,
    }),
  );
  emit(
    ctx,
    [`${result.deduped ? "deduped: already " : ""}spawned ${result.beeId} (command ${result.commandId}${result.status ? ` ${result.status}` : ""})`],
    result,
    false,
  );
  return 0;
}

async function cmdSend(ctx: CliContext, parsed: Parsed): Promise<number> {
  const [, needle, ...bodyParts] = parsed.positional;
  const body = bodyParts.join(" ");
  if (!needle || body.length === 0) {
    throw new Error("usage: hive v2 send <bee> <message…> [--sender s] [--wait] [--timeout ms] [--idempotency-key k]");
  }
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const result = await c.request<SendRpcResult>("send", {
      beeId,
      body,
      sender: parsed.flags.get("--sender") as string | undefined,
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
  if (!needle) throw new Error(`usage: hive v2 ${verb} <bee>`);
  return withClient(ctx, async (c) => {
    const list = await c.request<ListResult>("list");
    const beeId = resolveBeeIn(list.views, needle);
    const result = await c.request<{ commandId: number }>(verb, { beeId });
    emit(ctx, [`${verb} ${beeId} enqueued (command ${result.commandId})`], { beeId, ...result }, false);
    return 0;
  });
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
  spawn <name> --agent <a> [--cwd d] [--title t] [--tag t]... [--idempotency-key k]
  send <bee> <message…> [--sender s] [--wait] [--timeout ms] [--idempotency-key k]
  stop | revive | archive | unarchive | delete <bee>
  (--idempotency-key: spec 06 §4.2 one-key rule — a replayed key returns the
   original outcome, marked deduped, instead of executing twice)

Reads (RPC; read-only store fallback labeled STALE when daemon is down):
  view <bee> · list [--all|--archived] · mailbox <bee> · commands <bee>
  deploy-info · health

Templates + tracks + packages (spec 06 §1.4.1 — rows are truth, files are packages):
  template list [--scope s] · get|export <id|name> [--out f] · put --file f [--id id]
  template delete <id|name> · import <package.json> [--scope s] [--source label]
  track    list [--scope s] · get|export <id|name> [--out f] · put --file f [--id id]
  track    delete <id|name> · import <package.json> [--scope s] [--source label]
  packages import-local [--dir d] [--scope s]   import ~/.hive-style local config (manual, v1)

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
