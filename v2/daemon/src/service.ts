/**
 * Platform service management behind ONE interface (spec 04 behavior 6):
 * launchd (macOS) and a systemd user unit (Linux), with install / uninstall /
 * start / stop / status.
 *
 * All process execution goes through an injected ExecRunner — CI tests the
 * interface with a recording runner and never touches launchctl/systemctl;
 * the rendered service files are pure functions covered by snapshot tests.
 * Real service files are exercised only by the platform smokes (manual
 * checklist until CI owns it).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecRunner = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface ServiceSpec {
  /** Service label / unit name (e.g. dev.honeybee.hive.v2). */
  label: string;
  /** Full argv of the daemon process (absolute paths — services have no PATH). */
  execArgs: string[];
  /** Daemon stdout/stderr destination. */
  logPath: string;
  workingDir?: string;
  /** Extra environment for the daemon (e.g. HIVE_V2_DATA_DIR). */
  env?: Record<string, string>;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  detail: string;
}

export interface ServiceManager {
  readonly platform: "launchd" | "systemd";
  /** Absolute path of the service file this manager owns. */
  readonly servicePath: string;
  /** Render the service file contents (pure; snapshot-tested). */
  renderServiceFile(): string;
  /** Write the service file (and register it where the platform needs that). */
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Pure renderer: the launchd user agent plist. */
export function renderLaunchdPlist(spec: ServiceSpec): string {
  const args = spec.execArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envBlock =
    spec.env && Object.keys(spec.env).length > 0
      ? `
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(spec.env)
  .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
  .join("\n")}
  </dict>`
      : "";
  const cwdBlock = spec.workingDir
    ? `
  <key>WorkingDirectory</key>
  <string>${xmlEscape(spec.workingDir)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>${envBlock}${cwdBlock}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.logPath)}</string>
</dict>
</plist>
`;
}

function unitEscape(s: string): string {
  // systemd exec args: quote every arg; escape backslashes and quotes.
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Pure renderer: the systemd user unit. */
export function renderSystemdUnit(spec: ServiceSpec): string {
  const exec = spec.execArgs.map(unitEscape).join(" ");
  const envLines = spec.env
    ? Object.entries(spec.env)
        .map(([k, v]) => `Environment=${unitEscape(`${k}=${v}`)}\n`)
        .join("")
    : "";
  const cwdLine = spec.workingDir ? `WorkingDirectory=${spec.workingDir}\n` : "";
  return `[Unit]
Description=Honeybee v2 hive daemon (${spec.label})

[Service]
Type=simple
ExecStart=${exec}
${cwdLine}${envLines}Restart=always
RestartSec=2
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
}

async function must(run: ExecRunner, cmd: string, args: string[]): Promise<ExecResult> {
  const res = await run(cmd, args);
  if (res.code !== 0) {
    throw new ServiceError(`${cmd} ${args.join(" ")} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res;
}

export interface LaunchdDeps {
  exec: ExecRunner;
  /** LaunchAgents directory (injected; default ~/Library/LaunchAgents at the call site). */
  agentsDir: string;
  uid: number;
}

export class LaunchdServiceManager implements ServiceManager {
  readonly platform = "launchd" as const;
  readonly servicePath: string;
  private readonly spec: ServiceSpec;
  private readonly deps: LaunchdDeps;

  constructor(spec: ServiceSpec, deps: LaunchdDeps) {
    this.spec = spec;
    this.deps = deps;
    this.servicePath = join(deps.agentsDir, `${spec.label}.plist`);
  }

  renderServiceFile(): string {
    return renderLaunchdPlist(this.spec);
  }

  private get domainTarget(): string {
    return `gui/${this.deps.uid}`;
  }

  async install(): Promise<void> {
    mkdirSync(dirname(this.servicePath), { recursive: true });
    writeFileSync(this.servicePath, this.renderServiceFile());
  }

  async uninstall(): Promise<void> {
    await this.deps.exec("launchctl", ["bootout", `${this.domainTarget}/${this.spec.label}`]);
    rmSync(this.servicePath, { force: true });
  }

  async start(): Promise<void> {
    // bootstrap loads + starts (RunAtLoad); an already-loaded service errors,
    // so kickstart it instead for idempotent start semantics.
    const res = await this.deps.exec("launchctl", ["bootstrap", this.domainTarget, this.servicePath]);
    if (res.code !== 0) {
      await must(this.deps.exec, "launchctl", [
        "kickstart",
        `${this.domainTarget}/${this.spec.label}`,
      ]);
    }
  }

  async stop(): Promise<void> {
    await must(this.deps.exec, "launchctl", ["bootout", `${this.domainTarget}/${this.spec.label}`]);
  }

  async status(): Promise<ServiceStatus> {
    const res = await this.deps.exec("launchctl", ["print", `${this.domainTarget}/${this.spec.label}`]);
    if (res.code !== 0) {
      return { installed: false, running: false, detail: "not loaded in launchd" };
    }
    const running = /state = running/.test(res.stdout);
    return { installed: true, running, detail: running ? "launchd: state = running" : "launchd: loaded, not running" };
  }
}

export interface SystemdDeps {
  exec: ExecRunner;
  /** systemd user unit directory (injected; default ~/.config/systemd/user at the call site). */
  unitDir: string;
}

export class SystemdServiceManager implements ServiceManager {
  readonly platform = "systemd" as const;
  readonly servicePath: string;
  private readonly spec: ServiceSpec;
  private readonly deps: SystemdDeps;

  constructor(spec: ServiceSpec, deps: SystemdDeps) {
    this.spec = spec;
    this.deps = deps;
    this.servicePath = join(deps.unitDir, `${spec.label}.service`);
  }

  renderServiceFile(): string {
    return renderSystemdUnit(this.spec);
  }

  async install(): Promise<void> {
    mkdirSync(dirname(this.servicePath), { recursive: true });
    writeFileSync(this.servicePath, this.renderServiceFile());
    await must(this.deps.exec, "systemctl", ["--user", "daemon-reload"]);
  }

  async uninstall(): Promise<void> {
    await this.deps.exec("systemctl", ["--user", "disable", "--now", `${this.spec.label}.service`]);
    rmSync(this.servicePath, { force: true });
    await must(this.deps.exec, "systemctl", ["--user", "daemon-reload"]);
  }

  async start(): Promise<void> {
    await must(this.deps.exec, "systemctl", ["--user", "start", `${this.spec.label}.service`]);
  }

  async stop(): Promise<void> {
    await must(this.deps.exec, "systemctl", ["--user", "stop", `${this.spec.label}.service`]);
  }

  async status(): Promise<ServiceStatus> {
    const res = await this.deps.exec("systemctl", ["--user", "is-active", `${this.spec.label}.service`]);
    const state = res.stdout.trim() || res.stderr.trim();
    if (res.code === 0) return { installed: true, running: true, detail: `systemd: ${state}` };
    if (state === "inactive" || state === "failed") {
      return { installed: true, running: false, detail: `systemd: ${state}` };
    }
    return { installed: false, running: false, detail: `systemd: ${state || "unknown unit"}` };
  }
}

export function createServiceManager(
  platform: NodeJS.Platform,
  spec: ServiceSpec,
  deps: { exec: ExecRunner; dir: string; uid: number },
): ServiceManager {
  if (platform === "darwin") {
    return new LaunchdServiceManager(spec, { exec: deps.exec, agentsDir: deps.dir, uid: deps.uid });
  }
  if (platform === "linux") {
    return new SystemdServiceManager(spec, { exec: deps.exec, unitDir: deps.dir });
  }
  throw new ServiceError(`unsupported platform for service management: ${platform}`);
}
