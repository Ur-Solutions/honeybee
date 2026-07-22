import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.js";

// ──────────────────────────────────────────────────────────────────────────
// Per-tool home defaults. Activation copies the vault's credential/config
// snapshots over a home, which typically carries stale onboarding/trust/model
// state — so these seeders re-merge the defaults a hive-managed home needs on
// EVERY activation (merged, never blindly replaced, so operator/vault keys
// survive; a malformed file is left untouched rather than clobbered).
// ──────────────────────────────────────────────────────────────────────────

// Default spawn model for hive-managed claude homes (alias for the latest Opus =
// Opus 4.8, 1M-context). Seeded into settings.json only when no model is set.
const CLAUDE_HOME_DEFAULT_MODEL = "opus[1m]";

const CODEX_HOME_DEFAULTS: Record<string, string> = {
  model: `"gpt-5.5"`,
  model_reasoning_effort: `"xhigh"`,
  service_tier: `"fast"`,
};

const CODEX_NOTICE_DEFAULTS: Record<string, string> = {
  hide_full_access_warning: "true",
};

// claude persists its one-time "Bypass Permissions mode" acceptance as
// `skipDangerousModePermissionPrompt: true` in settings.json. settings.json is
// a recipe credential file, so activation re-stamps the vault's copy over the
// home on EVERY spawn — wiping the flag and resurfacing the dialog on every
// launch (a bee then sits at it until the boot-ms timeout). Re-assert the flag
// into the activated home so honeybee's bypass-mode bees never see the dialog.
// Merged, not replaced: model/theme and any other keys the vault carries
// survive. A malformed settings.json is left untouched rather than clobbered.
export async function seedClaudeHomeDefaults(homePath: string): Promise<boolean> {
  const path = join(homePath, "settings.json");
  const existing = await readFile(path, "utf8").catch(() => "");
  const next = withClaudeSettingsDefaults(existing);
  if (next === existing) return false;
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, next, { mode: 0o600 });
  return true;
}

function withClaudeSettingsDefaults(input: string): string {
  let parsed: Record<string, unknown> = {};
  if (input.trim()) {
    try {
      const value = JSON.parse(input);
      if (!value || typeof value !== "object" || Array.isArray(value)) return input;
      parsed = value as Record<string, unknown>;
    } catch {
      return input;
    }
  }
  let changed = false;
  if (parsed.skipDangerousModePermissionPrompt !== true) {
    parsed.skipDangerousModePermissionPrompt = true;
    changed = true;
  }
  // Default the spawn model to Opus so a hive-managed claude home never falls
  // back to the CLI's built-in default (which has pointed at retired models like
  // Fable, hard-failing every spawn). Seeded only when ABSENT — an explicit
  // model the operator/vault set is left untouched. Mirrors CODEX_HOME_DEFAULTS.
  if (typeof parsed.model !== "string" || parsed.model.trim().length === 0) {
    parsed.model = CLAUDE_HOME_DEFAULT_MODEL;
    changed = true;
  }
  if (!changed) return input;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function seedCodexHomeDefaults(homePath: string): Promise<boolean> {
  const path = join(homePath, "config.toml");
  const existing = await readFile(path, "utf8").catch(() => "");
  const next = mergeCodexConfigDefaults(existing);
  if (next === existing) return false;
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, next, { mode: 0o600 });
  return true;
}

function mergeCodexConfigDefaults(input: string): string {
  let lines = tomlLines(input);
  lines = withTopLevelTomlDefaults(lines, CODEX_HOME_DEFAULTS);
  lines = withTomlSectionDefaults(lines, "notice", CODEX_NOTICE_DEFAULTS);
  return `${lines.join("\n")}\n`;
}

export function tomlLines(input: string): string[] {
  const trimmed = input.replace(/\s+$/u, "");
  return trimmed.length === 0 ? [] : trimmed.split(/\r?\n/u);
}

function withTopLevelTomlDefaults(lines: string[], defaults: Record<string, string>): string[] {
  const insertAt = firstTomlSectionIndex(lines);
  const topLevel = lines.slice(0, insertAt === -1 ? lines.length : insertAt);
  const existing = new Set<string>();
  for (const line of topLevel) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/u);
    if (match) existing.add(match[1]!);
  }
  const missing = Object.entries(defaults)
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => `${key} = ${value}`);
  if (missing.length === 0) return lines;
  if (insertAt === -1) return [...lines, ...missing];
  return [...lines.slice(0, insertAt), ...missing, ...lines.slice(insertAt)];
}

function withTomlSectionDefaults(lines: string[], section: string, defaults: Record<string, string>): string[] {
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return [...lines, ...(lines.length > 0 && lines[lines.length - 1] !== "" ? [""] : []), header, ...formatTomlDefaults(defaults)];
  }
  const nextSection = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  const end = nextSection === -1 ? lines.length : nextSection;
  const existing = new Set<string>();
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/u);
    if (match) existing.add(match[1]!);
  }
  const missing = Object.entries(defaults)
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => `${key} = ${value}`);
  if (missing.length === 0) return lines;
  return [...lines.slice(0, start + 1), ...missing, ...lines.slice(start + 1)];
}

function firstTomlSectionIndex(lines: string[]): number {
  return lines.findIndex((line) => /^\s*\[/.test(line));
}

function formatTomlDefaults(defaults: Record<string, string>): string[] {
  return Object.entries(defaults).map(([key, value]) => `${key} = ${value}`);
}

/**
 * Seed claude's per-home acceptance state so opening a hive home does not
 * re-ask the startup questions (bypass-permissions consent, folder trust,
 * onboarding) every single time. Activation copies the vaulted .claude.json
 * snapshot over the home's copy, wiping whatever was answered last session —
 * so the acceptances must be re-merged after every activation, not just once.
 */
export async function seedClaudeHomeAcceptance(homePath: string, opts: { yolo?: boolean; trustCwd?: string } = {}): Promise<void> {
  const path = join(homePath, ".claude.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable: start from the acceptances alone.
  }
  config.hasCompletedOnboarding = true;
  if (opts.yolo) config.bypassPermissionsModeAccepted = true;
  if (opts.trustCwd) {
    const rawProjects = config.projects;
    const projects = rawProjects && typeof rawProjects === "object" && !Array.isArray(rawProjects) ? (rawProjects as Record<string, unknown>) : {};
    const rawEntry = projects[opts.trustCwd];
    const entry = rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry) ? (rawEntry as Record<string, unknown>) : {};
    entry.hasTrustDialogAccepted = true;
    entry.hasCompletedProjectOnboarding = true;
    projects[opts.trustCwd] = entry;
    config.projects = projects;
  }
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
