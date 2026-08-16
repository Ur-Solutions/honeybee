import assert from "node:assert/strict";
import { execFile, spawn as spawnChild, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootstrapRunnerHost, type SshExecHook } from "../src/hsr/bootstrap.js";
import {
  ensureRunnerHostBundle,
  runnerHostBundlePath,
  runnerHostVersionCore,
} from "../src/hsr/buildRunnerHostBundle.js";
import {
  RUNNER_HOST_ARTIFACT_FILENAME,
  RUNNER_HOST_ARTIFACT_MANIFEST_FILENAME,
  readStagedRunnerHostArtifactSync,
} from "../src/hsr/runnerHostArtifact.js";

const execFileAsync = promisify(execFile);

async function waitForPath(path: string, present: boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await access(path).then(() => true, () => false);
    if (exists === present) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path} to become ${present ? "present" : "absent"}`);
}

function launchBundledServe(bundle: string, socket: string, store: string): {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
} {
  const child = spawnChild(process.execPath, [bundle, "serve", "--socket", socket], {
    env: { ...process.env, HIVE_STORE_ROOT: store },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, exited };
}

async function seedArtifact(dir: string, content: string, packageVersion = "9.8.7"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from(content);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(dir, RUNNER_HOST_ARTIFACT_FILENAME), bytes);
  await writeFile(join(dir, RUNNER_HOST_ARTIFACT_MANIFEST_FILENAME), `${JSON.stringify({
    schemaVersion: 1,
    artifact: RUNNER_HOST_ARTIFACT_FILENAME,
    packageVersion,
    sha256: digest,
    bytes: bytes.byteLength,
  }, null, 2)}\n`);
  return digest;
}

async function withTempStore(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-runner-artifact-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = join(root, "store");
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("runner-host versions and cache paths change with every artifact byte change", async () => {
  await withTempStore(async (root) => {
    const firstDir = join(root, "first");
    const secondDir = join(root, "second");
    const firstDigest = await seedArtifact(firstDir, "first exact runner bytes\n");
    const secondDigest = await seedArtifact(secondDir, "second exact runner bytes\n");
    assert.notEqual(firstDigest, secondDigest);

    const firstVersion = runnerHostVersionCore({ artifactDir: firstDir });
    const secondVersion = runnerHostVersionCore({ artifactDir: secondDir });
    assert.equal(firstVersion, `9.8.7+sha256.${firstDigest}`);
    assert.equal(secondVersion, `9.8.7+sha256.${secondDigest}`);
    assert.notEqual(firstVersion, secondVersion);
    assert.notEqual(runnerHostBundlePath(firstVersion), runnerHostBundlePath(secondVersion));

    const first = await ensureRunnerHostBundle({ artifactDir: firstDir });
    const second = await ensureRunnerHostBundle({ artifactDir: secondDir });
    assert.equal(await readFile(first.path, "utf8"), "first exact runner bytes\n");
    assert.equal(await readFile(second.path, "utf8"), "second exact runner bytes\n");

    await writeFile(first.path, "stale bytes under a content-addressed name");
    const repaired = await ensureRunnerHostBundle({ artifactDir: firstDir });
    assert.equal(repaired.path, first.path);
    assert.equal(await readFile(repaired.path, "utf8"), "first exact runner bytes\n");
  });
});

test("rebuilding changed source at the same package version changes the staged digest identity", async () => {
  await withTempStore(async (root) => {
    const entry = join(root, "entry.mjs");
    const firstOut = join(root, "stage-first");
    const secondOut = join(root, "stage-second");
    const helperUrl = pathToFileURL(join(process.cwd(), "scripts", "runner-host-artifact.mjs")).href;
    const stageScript = [
      `import { stageRunnerHostArtifact } from ${JSON.stringify(helperUrl)};`,
      "const input = JSON.parse(process.argv[1]);",
      "await stageRunnerHostArtifact(input);",
    ].join("\n");
    await writeFile(entry, 'process.stdout.write("first source\\n");\n');
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", stageScript, JSON.stringify({
      root,
      outDir: firstOut,
      entryPoint: entry,
      packageVersion: "0.0.1",
    })]);
    await writeFile(entry, 'process.stdout.write("second source\\n");\n');
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", stageScript, JSON.stringify({
      root,
      outDir: secondOut,
      entryPoint: entry,
      packageVersion: "0.0.1",
    })]);
    const first = runnerHostVersionCore({ artifactDir: firstOut });
    const second = runnerHostVersionCore({ artifactDir: secondOut });
    assert.match(first, /^0\.0\.1\+sha256\.[a-f0-9]{64}$/);
    assert.match(second, /^0\.0\.1\+sha256\.[a-f0-9]{64}$/);
    assert.notEqual(first, second);
    assert.notEqual(runnerHostBundlePath(first), runnerHostBundlePath(second));
  });
});

test("a live quiescent old bundle hands off to the exact staged bundle without runtime git or esbuild", { timeout: 30_000 }, async () => {
  await withTempStore(async (root) => {
    const oldOut = join(root, "old-artifact");
    const helperUrl = pathToFileURL(join(process.cwd(), "scripts", "runner-host-artifact.mjs")).href;
    const stageScript = [
      `import { stageRunnerHostArtifact } from ${JSON.stringify(helperUrl)};`,
      "await stageRunnerHostArtifact(JSON.parse(process.argv[1]));",
    ].join("\n");
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", stageScript, JSON.stringify({
      root: process.cwd(),
      outDir: oldOut,
      entryPoint: join(process.cwd(), "src", "hsr", "remoteHost.ts"),
      packageVersion: "0.0.0",
    })]);
    const old = readStagedRunnerHostArtifactSync(oldOut);
    const current = readStagedRunnerHostArtifactSync();
    assert.notEqual(old.version, current.version);

    const socket = join(root, "upgrade-control.sock");
    const store = join(root, "remote-store");
    const oldServe = launchBundledServe(old.artifactPath, socket, store);
    let currentServe: ReturnType<typeof launchBundledServe> | undefined;
    try {
      await waitForPath(socket, true);
      const upgraded = await execFileAsync(process.execPath, [
        current.artifactPath,
        "upgrade",
        "--socket", socket,
        "--target-version", current.version,
      ], { env: { ...process.env, HIVE_STORE_ROOT: store } });
      assert.equal(upgraded.stdout.trim(), "upgraded");
      await waitForPath(socket, false);
      const oldExit = await oldServe.exited;
      assert.equal(oldExit.code, 0, oldExit.stderr);

      currentServe = launchBundledServe(current.artifactPath, socket, store);
      await waitForPath(socket, true);
      const probed = await execFileAsync(process.execPath, [
        current.artifactPath,
        "probe",
        "--socket", socket,
        "--expect-version", current.version,
      ], { env: { ...process.env, HIVE_STORE_ROOT: store } });
      assert.equal(probed.stdout.trim(), `runner-host ${current.version}`);
    } finally {
      if (oldServe.child.exitCode === null) oldServe.child.kill("SIGTERM");
      if (currentServe?.child.exitCode === null) currentServe.child.kill("SIGTERM");
      await Promise.all([
        oldServe.exited,
        ...(currentServe ? [currentServe.exited] : []),
      ]);
    }
  });
});

test("runner-host staged manifests reject unsupported fields and byte drift", async () => {
  await withTempStore(async (root) => {
    assert.throws(
      () => runnerHostVersionCore({ artifactDir: join(root, "missing") }),
      /staged artifact manifest is unavailable/,
    );

    const dir = join(root, "artifact");
    await seedArtifact(dir, "certified bytes\n");
    const manifestPath = join(dir, RUNNER_HOST_ARTIFACT_MANIFEST_FILENAME);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ignoredPolicy: true })}\n`);
    assert.throws(() => runnerHostVersionCore({ artifactDir: dir }), /unsupported fields/);

    await seedArtifact(dir, "certified bytes\n");
    await writeFile(join(dir, RUNNER_HOST_ARTIFACT_FILENAME), "mutated after manifest publication\n");
    await assert.rejects(ensureRunnerHostBundle({ artifactDir: dir }), /integrity mismatch/);

    await seedArtifact(dir, "certified bytes\n");
    const dual = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(join(dir, "runner-host-other.mjs"), "second candidate must never be selected\n");
    await writeFile(manifestPath, `${JSON.stringify({ ...dual, artifact: "runner-host-other.mjs" })}\n`);
    assert.throws(() => runnerHostVersionCore({ artifactDir: dir }), /manifest is malformed/);

    await writeFile(manifestPath, "{not-json\n");
    assert.throws(() => runnerHostVersionCore({ artifactDir: dir }), /manifest is unavailable/);
  });
});

test("a packed and extracted compiled tree with no node_modules, git, or esbuild materializes and runs the staged artifact", async (t) => {
  const compiledBuildModule = fileURLToPath(new URL("../src/hsr/buildRunnerHostBundle.js", import.meta.url));
  try {
    await access(compiledBuildModule);
  } catch {
    t.skip("packaged-tree assertion runs against npm test's compiled module graph");
    return;
  }

  await withTempStore(async (root) => {
    const packSource = join(root, "pack-source");
    const sourceDist = join(packSource, "dist");
    await mkdir(join(sourceDist, "hsr", "artifacts"), { recursive: true });
    await writeFile(
      join(packSource, "package.json"),
      '{"name":"honeybee-installed-fixture","version":"0.0.1","type":"module","files":["dist/"]}\n',
    );
    for (const relative of [
      "fsx.js",
      "hsr/buildRunnerHostBundle.js",
      "hsr/runnerHostArtifact.js",
      `hsr/artifacts/${RUNNER_HOST_ARTIFACT_FILENAME}`,
      `hsr/artifacts/${RUNNER_HOST_ARTIFACT_MANIFEST_FILENAME}`,
    ]) {
      const source = fileURLToPath(new URL(`../src/${relative}`, import.meta.url));
      const target = join(sourceDist, relative);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }

    const packRoot = join(root, "packs");
    const extractedRoot = join(root, "extracted");
    await mkdir(packRoot);
    await mkdir(extractedRoot);
    const packed = JSON.parse((await execFileAsync(
      "npm",
      ["pack", "--json", "--pack-destination", packRoot],
      { cwd: packSource },
    )).stdout) as Array<{ filename?: unknown }>;
    const filename = packed[0]?.filename;
    assert.equal(typeof filename, "string");
    await execFileAsync("tar", ["-xzf", join(packRoot, filename as string), "-C", extractedRoot]);
    const installed = join(extractedRoot, "package");
    const installedDist = join(installed, "dist");
    const installedMaterializer = await readFile(
      join(installedDist, "hsr", "buildRunnerHostBundle.js"),
      "utf8",
    );
    assert.doesNotMatch(installedMaterializer, /import\(["']esbuild["']\)/);
    assert.doesNotMatch(installedMaterializer, /node:child_process|rev-parse|short=12|nogit/);
    const moduleUrl = pathToFileURL(join(installedDist, "hsr", "buildRunnerHostBundle.js")).href;
    const emptyPath = join(root, "empty-path");
    await mkdir(emptyPath);
    const childStore = join(root, "child-store");
    const script = [
      `import { ensureRunnerHostBundle } from ${JSON.stringify(moduleUrl)};`,
      "import { execFileSync } from 'node:child_process';",
      "const bundle = await ensureRunnerHostBundle();",
      "const reported = execFileSync(process.execPath, [bundle.path, '--version'], { encoding: 'utf8' }).trim();",
      "process.stdout.write(JSON.stringify({ ...bundle, reported }));",
    ].join("\n");
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: installed,
      env: { PATH: emptyPath, HIVE_STORE_ROOT: childStore },
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout) as { path: string; version: string; reported: string };
    assert.match(result.version, /^0\.0\.1\+sha256\.[a-f0-9]{64}$/);
    assert.equal(result.reported, `runner-host ${result.version}`);
    assert.ok(result.path.startsWith(childStore));
    await assert.rejects(access(join(installed, "node_modules")));

    const bundle = await ensureRunnerHostBundle({
      artifactDir: fileURLToPath(new URL("../src/hsr/artifacts/", import.meta.url)),
    });
    const trace: string[] = [];
    let socketUp = false;
    const execHook: SshExecHook = async (argv) => {
      const command = argv.at(-1) ?? "";
      trace.push(command);
      if (command === "node --version") return { stdout: "v20.11.0\n", stderr: "", exitCode: 0 };
      if (command.startsWith("mkdir -p")) return { stdout: "", stderr: "", exitCode: 0 };
      if (command.startsWith("[ -f")) return { stdout: "__HIVE_RH_MISSING__\n", stderr: "", exitCode: 0 };
      if (command.startsWith("cat >")) return { stdout: "", stderr: "", exitCode: 0 };
      if (command.endsWith("--version")) return { stdout: `runner-host ${bundle.version}\n`, stderr: "", exitCode: 0 };
      if (command.startsWith("test -S")) return { stdout: "", stderr: "", exitCode: socketUp ? 0 : 1 };
      if (command.startsWith("setsid node")) {
        socketUp = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes(" probe --socket ")) return { stdout: `runner-host ${bundle.version}\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "unexpected command", exitCode: 1 };
    };
    const bootstrapped = await bootstrapRunnerHost(
      { name: "packed-artifact", endpoint: "packed@example" },
      { execHook, ensureBundle: async () => bundle },
    );
    assert.equal(bootstrapped.version, bundle.version);
    assert.equal(bootstrapped.deployed, true);
    assert.equal(
      trace.at(-1),
      `node ${bootstrapped.remotePath} probe --socket ~/.hive/runner-host/control.sock --expect-version ${bundle.version}`,
    );
  });
});
