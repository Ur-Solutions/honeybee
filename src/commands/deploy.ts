// `hive deploy` — versioned runtime deploys (reset WP0, spec 00). The
// orchestration lives in src/deployRuntime.ts; this module wires the CLI
// surface plus the two production hooks: the real clean-checkout build and
// the real daemon restart. Tests drive deployRuntime with injected hooks and
// never reach the code in this file's hook implementations.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  CURRENT_LINK_NAME,
  DEFAULT_KEEP_VERSIONS,
  currentDeployTarget,
  deployVersion,
  readDeployHistory,
  rollbackDeploy,
  rollbackTargetEntry,
  runtimeRoot,
  type BuildArtifactContext,
  type RestartDaemonContext,
} from "../deployRuntime.js";
import { storeRoot } from "../fsx.js";
import { actionLine, bold, dim, formatRelativeTime, isPretty, note, tildify, yellow } from "../format.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";

const execFileAsync = promisify(execFile);

const USAGE = [
  "Usage: hive deploy [<sha>] [--keep <n>]   build+verify <sha> (default HEAD) in a temp checkout, install to ~/.hive/runtime/<sha>, retarget current, restart daemon",
  "       refuses a <sha> that does not contain the deployed commit (silent-revert guard); --allow-non-descendant overrides",
  "       hive deploy --rollback             retarget current to the previous deploy and restart the daemon",
  "       hive deploy --list [--json]        show the deploy history",
  "       hive deploy --init                 print the manual steps that make the global `hive` resolve through ~/.hive/runtime/current",
].join("\n");

export async function cmdDeploy(parsed: Parsed): Promise<void> {
  const wantsList = truthy(flag(parsed, "list"));
  const wantsInit = truthy(flag(parsed, "init"));
  const wantsRollback = truthy(flag(parsed, "rollback"));
  const modes = [wantsList, wantsInit, wantsRollback].filter(Boolean).length;
  if (modes > 1 || (modes === 1 && parsed.args.length > 0)) throw new Error(USAGE);
  if (wantsList) return deployList(parsed);
  if (wantsInit) return deployInit();
  if (wantsRollback) return deployRollback();
  if (parsed.args.length > 1) throw new Error(USAGE);
  return deployRun(parsed);
}

/** Stream a build/restart step; the child's output is the progress report. */
async function runStep(command: string, args: string[], cwd: string, log: (line: string) => void): Promise<void> {
  log(`deploy: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(`deploy: '${command} ${args.join(" ")}' exited with ${result.code ?? `signal ${result.signal}`}`);
  }
}

/**
 * The production build: export the committed tree (never the developer tree),
 * install deps, run the check suite + full tests, build, then materialize the
 * exact published file set (npm pack) with production-only node_modules. The
 * returned stage directory is self-sufficient — nothing in it resolves back
 * into the repo.
 */
export async function buildDeployArtifact(
  { repoRoot, sha, workDir, log }: BuildArtifactContext,
): Promise<{ artifactDir: string }> {
  const checkout = join(workDir, "checkout");
  await mkdir(checkout, { recursive: true });
  const tarPath = join(workDir, "source.tar");
  await runStep("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tarPath, sha], workDir, log);
  await runStep("tar", ["-xf", tarPath, "-C", checkout], workDir, log);

  await runStep("npm", ["ci"], checkout, log);
  await runStep("npm", ["run", "check"], checkout, log);
  await runStep("npm", ["run", "build"], checkout, log);
  if (existsSync(join(storeRoot(), "FROZEN"))) {
    // Post-flip node (WP7): the old suite's CLI-shelling tests don't override
    // the store root, so on a frozen machine they route into v2 and hang
    // (2026-08-19: deploy gate deadlocked against its own flip). The v2
    // battery is the gate for what actually ships; the old suite keeps
    // running in repo CI until WP8 removes the old tree.
    log("deploy: frozen node — gating on the v2 battery instead of the legacy suite");
    for (const script of ["v2:test", "v2:daemon", "v2:driver", "v2:harness"]) {
      await runStep("npm", ["run", script], checkout, log);
    }
  } else {
    await runStep("npm", ["test"], checkout, log);
  }

  // npm pack gives exactly the `files` set a real install would receive; the
  // lockfile rides along so the stage can `npm ci --omit=dev` production deps.
  const packDest = join(workDir, "pack");
  await mkdir(packDest, { recursive: true });
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDest], { cwd: checkout });
  const filename = (JSON.parse(stdout) as Array<{ filename?: string }>)?.[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0 || basename(filename) !== filename) {
    throw new Error(`deploy: npm pack returned an invalid filename (${String(filename)})`);
  }
  const stage = join(workDir, "stage");
  await mkdir(stage, { recursive: true });
  await runStep("tar", ["-xzf", join(packDest, filename), "-C", stage, "--strip-components", "1"], workDir, log);
  await cp(join(checkout, "package-lock.json"), join(stage, "package-lock.json"));
  await runStep("npm", ["ci", "--omit=dev"], stage, log);
  return { artifactDir: stage };
}

/**
 * The production restart, run THROUGH the `current` symlink so the LaunchAgent
 * plist binds the stable path — future deploys then only move the symlink.
 */
export async function restartDeployedDaemon({ root, log }: RestartDaemonContext): Promise<void> {
  if (process.platform !== "darwin") {
    log("deploy: daemon restart skipped (launchctl unavailable on this platform; restart the daemon manually)");
    return;
  }
  const cli = join(root, CURRENT_LINK_NAME, "dist", "cli.js");
  if (existsSync(join(root, "..", "FROZEN"))) {
    // WP7 B5: the old store is frozen — the flip is live. A routine deploy
    // must manage the V2 service and never resurrect the old daemon (the
    // freeze marker is the same switch that makes plain `hive` mean v2).
    await runStep(process.execPath, [cli, "v2", "daemon", "install"], root, log);
    try {
      await runStep(process.execPath, [cli, "v2", "daemon", "stop"], root, log);
    } catch {
      log("deploy: v2 daemon was not running (fresh start)");
    }
    await runStep(process.execPath, [cli, "v2", "daemon", "start"], root, log);
    return;
  }
  await runStep(process.execPath, [cli, "daemon", "install", "--force"], root, log);
  await runStep(process.execPath, [cli, "daemon", "restart"], root, log);
}

async function resolveHoneybeeRepoRoot(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }));
  } catch {
    throw new Error("deploy: run this from inside the honeybee repo (not a git repository here)");
  }
  const repoRoot = stdout.trim();
  let name: unknown;
  try {
    name = (JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== "honeybee") {
    throw new Error(`deploy: ${repoRoot} is not the honeybee repo (package ${String(name ?? "unknown")})`);
  }
  return repoRoot;
}

async function deployRun(parsed: Parsed): Promise<void> {
  const repoRoot = await resolveHoneybeeRepoRoot();
  const ref = parsed.args[0];
  const keep = numberFlag(parsed, ["keep"], DEFAULT_KEEP_VERSIONS);
  const log = (line: string) => console.log(isPretty() ? dim(line) : line);
  const outcome = await deployVersion({
    repoRoot,
    ...(ref !== undefined ? { ref } : {}),
    keep,
    log,
    ...(parsed.flags.has("allow-non-descendant") ? { allowNonDescendant: true } : {}),
    hooks: { buildArtifact: buildDeployArtifact, restartDaemon: restartDeployedDaemon },
  });
  if (isPretty()) {
    console.log(actionLine("ok", "deploy", [
      bold(outcome.sha.slice(0, 12)),
      dim(`→ ${tildify(outcome.installedDir)}`),
    ]));
    console.log(dim(`  artifact: ${outcome.artifactHash.slice(0, 12)}  previous: ${outcome.previousSha?.slice(0, 12) ?? "none"}  pruned: ${outcome.pruned.length}`));
  } else {
    console.log(`deploy\t${outcome.sha}\t${outcome.artifactHash}\t${outcome.installedDir}\t${outcome.pruned.length}`);
  }
}

async function deployRollback(): Promise<void> {
  const log = (line: string) => console.log(isPretty() ? dim(line) : line);
  const outcome = await rollbackDeploy({
    log,
    hooks: { restartDaemon: restartDeployedDaemon },
  });
  if (isPretty()) {
    console.log(actionLine("ok", "deploy", [
      bold("rollback"),
      dim(`${outcome.from.slice(0, 12)} → ${outcome.sha.slice(0, 12)}`),
    ]));
  } else {
    console.log(`rollback\t${outcome.from}\t${outcome.sha}`);
  }
}

async function deployList(parsed: Parsed): Promise<void> {
  const root = runtimeRoot();
  const entries = await readDeployHistory(root);
  const currentSha = await currentDeployTarget(root);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ root, current: currentSha, entries }, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log(note(`no deploys recorded under ${tildify(root)} — run: hive deploy`));
    return;
  }
  const pretty = isPretty();
  const rollback = rollbackTargetEntry(entries, currentSha);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const isCurrent = entry.sha === currentSha && !entries.slice(index + 1).some((later) => later.sha === currentSha);
    const marker = isCurrent ? "current" : "";
    if (pretty) {
      const sha = isCurrent ? bold(entry.sha.slice(0, 12)) : entry.sha.slice(0, 12);
      const when = formatRelativeTime(entry.at);
      const badge = isCurrent ? ` ${yellow("← current")}` : "";
      console.log(`${sha}  ${dim(entry.artifactHash.slice(0, 12))}  ${dim(when)}  ${dim(entry.by)}${badge}`);
    } else {
      console.log(`${entry.sha}\t${entry.at}\t${entry.artifactHash}\t${entry.by}\t${marker}`);
    }
  }
  if (pretty && rollback) console.log(dim(`rollback target: ${rollback.sha.slice(0, 12)}`));
}

type PathState =
  | { kind: "missing" }
  | { kind: "symlink"; target: string }
  | { kind: "directory" }
  | { kind: "file" };

async function inspectPath(path: string): Promise<PathState> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return { kind: "missing" };
  }
  if (stats.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
  if (stats.isDirectory()) return { kind: "directory" };
  return { kind: "file" };
}

/**
 * Print-only by design: rewiring the live global npm tree from inside a
 * process that is currently EXECUTING out of that tree (and that npm will
 * happily clobber on the next `npm i -g`) is exactly the class of hazard this
 * spec exists to remove. The one-time migration is four commands; the
 * operator runs them deliberately.
 */
async function deployInit(): Promise<void> {
  const root = runtimeRoot();
  const currentDir = join(root, CURRENT_LINK_NAME);
  const deployed = existsSync(join(currentDir, "dist", "cli.js"));
  let prefix: string;
  try {
    prefix = (await execFileAsync("npm", ["prefix", "-g"])).stdout.trim();
  } catch {
    throw new Error("deploy: cannot determine the npm global prefix (`npm prefix -g` failed)");
  }
  const pkgDir = join(prefix, "lib", "node_modules", "honeybee");
  const binPath = join(prefix, "bin", "hive");
  const pkgState = await inspectPath(pkgDir);
  const binState = await inspectPath(binPath);

  const pretty = isPretty();
  const heading = (line: string) => console.log(pretty ? bold(line) : line);
  const detail = (line: string) => console.log(pretty ? dim(line) : line);

  heading("hive deploy --init — migrate the global `hive` onto ~/.hive/runtime/current");
  detail("");
  detail(`  runtime root:    ${tildify(root)} ${deployed ? "(current deployed)" : "(NOTHING DEPLOYED YET)"}`);
  detail(`  global package:  ${pkgDir} [${pkgState.kind === "symlink" ? `symlink → ${pkgState.target}` : pkgState.kind}]`);
  detail(`  global bin:      ${binPath} [${binState.kind === "symlink" ? `symlink → ${binState.target}` : binState.kind}]`);
  detail("");
  if (pkgState.kind === "symlink" && pkgState.target.startsWith(currentDir)) {
    console.log(note("already migrated: the global package resolves through runtime/current."));
    return;
  }
  console.log("This step is print-only (it never rewires the live tree itself). Run, in order:");
  console.log("");
  let step = 1;
  if (!deployed) {
    console.log(`  ${step++}. hive deploy`);
    console.log("     # install a first version under ~/.hive/runtime before switching resolution");
  }
  if (pkgState.kind === "directory" || pkgState.kind === "file") {
    console.log(`  ${step++}. mv "${pkgDir}" "${pkgDir}.pre-runtime"`);
    console.log("     # keep the old npm-installed tree as an escape hatch; delete it once the migration is verified");
  }
  console.log(`  ${step++}. ln -s "${currentDir}" "${pkgDir}.new" && mv -h "${pkgDir}.new" "${pkgDir}"`);
  console.log("     # atomic swap (BSD mv -h: replace the link itself, never follow it)");
  if (binState.kind === "missing" || binState.kind === "symlink") {
    console.log(`  ${step++}. ln -sfn "../lib/node_modules/honeybee/dist/cli.js" "${binPath}"`);
    console.log("     # npm-style relative bin shim; resolves through the package symlink, i.e. through runtime/current");
  }
  console.log(`  ${step++}. hive daemon install --force && hive daemon restart`);
  console.log("     # rebind the LaunchAgent plist to the runtime/current CLI path");
  console.log(`  ${step}. readlink "${pkgDir}" && hive deploy --list`);
  console.log("     # verify: the package resolves through runtime/current and history shows the active sha");
  console.log("");
  console.log(note("warning: any future `npm i -g honeybee` / `npm update -g` will clobber the symlink — redo the ln/mv step after such commands (or simply never run them again; `hive deploy` replaces them)."));
}
