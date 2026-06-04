import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storeRoot } from "./fsx.js";

export type BeeConfig = {
  yolo?: boolean;
  home?: string;
  command?: string;
};

export type HiveConfig = {
  bees?: Record<string, BeeConfig>;
  briefFooter?: string;
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
  } catch {
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

function normalizeConfig(value: unknown): HiveConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  const config: HiveConfig = {};
  if (typeof object.briefFooter === "string") config.briefFooter = object.briefFooter;
  if (object.bees && typeof object.bees === "object" && !Array.isArray(object.bees)) {
    const bees: Record<string, BeeConfig> = {};
    for (const [key, raw] of Object.entries(object.bees as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const bee: BeeConfig = {};
      const r = raw as Record<string, unknown>;
      if (typeof r.yolo === "boolean") bee.yolo = r.yolo;
      if (typeof r.home === "string" && r.home.length > 0) bee.home = r.home;
      if (typeof r.command === "string" && r.command.length > 0) bee.command = r.command;
      bees[key] = bee;
    }
    config.bees = bees;
  }
  return config;
}

