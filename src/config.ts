import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storeRoot } from "./fsx.js";

export type BeeConfig = {
  yolo?: boolean;
  home?: string;
  command?: string;
  /**
   * Canonical agent kind this bee is an alias of. Lets an arbitrary bee name
   * (e.g. "minimax", "kimi", "glm") inherit another kind's driver — readiness,
   * transcripts, home env, identity recipe — while carrying its own command and
   * home. Used by canonicalAgentKind/resolveProfile in agents.ts.
   */
  kind?: string;
};

export type NamingConfig = {
  /** Daemon auto-titles untitled bees from their initial transcript (default: true). */
  auto?: boolean;
  /** Builtin generator CLI: "claude" (default) or "codex". */
  tool?: "claude" | "codex";
  /** Model passed to the generator (default: "haiku" for claude; codex uses its configured default). */
  model?: string;
  /** Custom generator command, run via sh -c: prompt on stdin, title on stdout. Overrides tool/model. */
  command?: string;
};

export type HiveConfig = {
  bees?: Record<string, BeeConfig>;
  briefFooter?: string;
  naming?: NamingConfig;
};

export const DEFAULT_BRIEF_FOOTER =
  "\n\n(Context only — do not start work yet. Acknowledge briefly, then wait for a follow-up message with the task.)";

export function briefFooter(): string {
  const override = loadConfig().briefFooter;
  return typeof override === "string" ? override : DEFAULT_BRIEF_FOOTER;
}

let cached: HiveConfig | undefined;

export function configPath(): string {
  return join(storeRoot(), "config.json");
}

export function loadConfig(): HiveConfig {
  if (cached) return cached;
  const path = configPath();
  if (!existsSync(path)) {
    cached = {};
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    cached = normalizeConfig(parsed);
  } catch (error) {
    // Warn (once per process — the result is cached) instead of silently
    // dropping the user's yolo flags / home / command overrides on the floor.
    console.error(`hive: ignoring unreadable config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    cached = {};
  }
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}

export function beeConfig(kind: string): BeeConfig {
  const bees = loadConfig().bees ?? {};
  return bees[kind] ?? {};
}

export type ResolvedNamingConfig = {
  auto: boolean;
  tool: "claude" | "codex";
  model?: string;
  command?: string;
};

export function namingConfig(): ResolvedNamingConfig {
  const naming = loadConfig().naming ?? {};
  const tool = naming.tool ?? "claude";
  // Cheap models on purpose: titles are a few words, never worth a frontier call.
  const model = naming.model ?? (tool === "claude" ? "haiku" : undefined);
  return {
    auto: naming.auto !== false,
    tool,
    ...(model ? { model } : {}),
    ...(naming.command ? { command: naming.command } : {}),
  };
}

function normalizeConfig(value: unknown): HiveConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  const config: HiveConfig = {};
  if (typeof object.briefFooter === "string") config.briefFooter = object.briefFooter;
  if (object.naming && typeof object.naming === "object" && !Array.isArray(object.naming)) {
    const r = object.naming as Record<string, unknown>;
    const naming: NamingConfig = {};
    if (typeof r.auto === "boolean") naming.auto = r.auto;
    if (r.tool === "claude" || r.tool === "codex") naming.tool = r.tool;
    if (typeof r.model === "string" && r.model.length > 0) naming.model = r.model;
    if (typeof r.command === "string" && r.command.length > 0) naming.command = r.command;
    config.naming = naming;
  }
  if (object.bees && typeof object.bees === "object" && !Array.isArray(object.bees)) {
    const bees: Record<string, BeeConfig> = {};
    for (const [key, raw] of Object.entries(object.bees as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const bee: BeeConfig = {};
      const r = raw as Record<string, unknown>;
      if (typeof r.yolo === "boolean") bee.yolo = r.yolo;
      if (typeof r.home === "string" && r.home.length > 0) bee.home = r.home;
      if (typeof r.command === "string" && r.command.length > 0) bee.command = r.command;
      if (typeof r.kind === "string" && r.kind.length > 0) bee.kind = r.kind;
      bees[key] = bee;
    }
    config.bees = bees;
  }
  return config;
}

