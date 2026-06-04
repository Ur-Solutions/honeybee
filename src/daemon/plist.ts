import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Default label for the Honeybee LaunchAgent. The plist filename is
 * `<DEFAULT_LABEL>.plist` under ~/Library/LaunchAgents/.
 */
export const DEFAULT_LAUNCH_LABEL = "dev.honeybee.hive";

export type RenderPlistOptions = {
  label: string;
  programArguments: string[];
  workingDirectory?: string;
  stdOutPath: string;
  stdErrPath: string;
  keepAlive?: boolean;
  runAtLoad?: boolean;
  /** Optional EnvironmentVariables dictionary (e.g. HIVE_STORE_ROOT). */
  environmentVariables?: Record<string, string>;
};

/**
 * Render a macOS launchd plist as a UTF-8 XML string. Pure function — no IO.
 *
 * Validates that all paths are absolute and the programArguments array is
 * non-empty (launchctl bootstrap will refuse otherwise).
 */
export function renderPlist(options: RenderPlistOptions): string {
  if (!options.label || options.label.length === 0) {
    throw new Error("renderPlist: label is required");
  }
  if (!Array.isArray(options.programArguments) || options.programArguments.length === 0) {
    throw new Error("renderPlist: programArguments must be a non-empty array");
  }
  for (const arg of options.programArguments) {
    if (typeof arg !== "string" || arg.length === 0) {
      throw new Error("renderPlist: programArguments entries must be non-empty strings");
    }
  }
  // The first program argument is the binary; require it to be absolute so
  // launchd doesn't probe $PATH (which is not set under user-domain launchctl).
  if (!isAbsolute(options.programArguments[0]!)) {
    throw new Error(`renderPlist: programArguments[0] must be an absolute path (got ${options.programArguments[0]})`);
  }
  if (!isAbsolute(options.stdOutPath)) {
    throw new Error(`renderPlist: stdOutPath must be absolute (got ${options.stdOutPath})`);
  }
  if (!isAbsolute(options.stdErrPath)) {
    throw new Error(`renderPlist: stdErrPath must be absolute (got ${options.stdErrPath})`);
  }
  if (options.workingDirectory !== undefined && !isAbsolute(options.workingDirectory)) {
    throw new Error(`renderPlist: workingDirectory must be absolute (got ${options.workingDirectory})`);
  }

  const keepAlive = options.keepAlive !== false;
  const runAtLoad = options.runAtLoad !== false;

  const args = options.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const envBlock = renderEnvironmentVariables(options.environmentVariables);
  const wdBlock = options.workingDirectory
    ? `  <key>WorkingDirectory</key>\n  <string>${escapeXml(options.workingDirectory)}</string>\n`
    : "";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(options.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    args,
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <${runAtLoad ? "true" : "false"}/>`,
    `  <key>KeepAlive</key>`,
    `  <${keepAlive ? "true" : "false"}/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(options.stdOutPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(options.stdErrPath)}</string>`,
    wdBlock.trimEnd(),
    envBlock.trimEnd(),
    `</dict>`,
    `</plist>`,
    ``,
  ]
    .filter((line) => line.length > 0 || line === "")
    .join("\n");
}

function renderEnvironmentVariables(env: Record<string, string> | undefined): string {
  if (!env) return "";
  const entries = Object.entries(env).filter(([key, value]) => typeof key === "string" && typeof value === "string");
  if (entries.length === 0) return "";
  const lines: string[] = [`  <key>EnvironmentVariables</key>`, `  <dict>`];
  for (const [key, value] of entries) {
    lines.push(`    <key>${escapeXml(key)}</key>`);
    lines.push(`    <string>${escapeXml(value)}</string>`);
  }
  lines.push(`  </dict>`);
  return `${lines.join("\n")}\n`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a systemd `--user` unit file as documentation. Honeybee does NOT
 * auto-install on Linux in Phase 2 — this helper exists so `hive daemon install`
 * can print a copy-paste recovery snippet on non-macOS hosts.
 */
export type RenderSystemdUnitOptions = {
  description?: string;
  programArguments: string[];
  workingDirectory?: string;
  environmentVariables?: Record<string, string>;
};

export function renderSystemdUnit(options: RenderSystemdUnitOptions): string {
  if (!Array.isArray(options.programArguments) || options.programArguments.length === 0) {
    throw new Error("renderSystemdUnit: programArguments must be a non-empty array");
  }
  const execStart = options.programArguments.map(shellEscape).join(" ");
  const description = options.description ?? "Honeybee hive daemon";
  const wd = options.workingDirectory ? `WorkingDirectory=${options.workingDirectory}\n` : "";
  const envLines = options.environmentVariables
    ? Object.entries(options.environmentVariables)
        .map(([k, v]) => `Environment=${k}=${shellEscape(v)}`)
        .join("\n")
    : "";
  return [
    `[Unit]`,
    `Description=${description}`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${execStart}`,
    wd.trimEnd(),
    envLines,
    `Restart=always`,
    `RestartSec=2`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Return the LaunchAgents directory for the current user. Honeybee never
 * writes outside ~/Library/LaunchAgents/ for plist installation.
 */
export function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

/**
 * Return the absolute path to the Honeybee plist for the given label.
 * Throws if `label` looks like it could escape the LaunchAgents directory.
 */
export function plistPathForLabel(label: string): string {
  if (!label || /[/\\]/.test(label) || label.includes("..")) {
    throw new Error(`plistPathForLabel: invalid label ${JSON.stringify(label)}`);
  }
  return join(launchAgentsDir(), `${label}.plist`);
}
