/**
 * Runner-host bootstrap & deploy (APIA-90, Phase B).
 *
 * `bootstrapRunnerHost` deploys the hive HSR runner-host bundle onto a remote
 * node over ssh and registers it as a `remote-hsr` node:
 *
 *   1. precheck   — ssh <endpoint> "node --version"  (require >= minNodeMajor)
 *   2. mkdir      — ssh <endpoint> "mkdir -p ~/.hive/runner-host"
 *   3. deploy     — build the bundle locally (ensureRunnerHostBundle), verify any
 *                   remote copy by SHA-256, and pipe it to a temp path before an
 *                   atomic mv into place when deploy is needed.
 *   4. handshake  — ssh <endpoint> "node <remotePath> --version"; assert it matches
 *                   the deployed version.
 *   5. register   — write/refresh the NodeRecord (kind remote-hsr, endpoint,
 *                   runnerHostVersion).
 *
 * All ssh goes through an INJECTABLE exec hook (mirrors ssh-tmux's execHook) so
 * the whole flow is unit-testable without a real host. The transport reuses the
 * ssh-tmux ControlMaster options for connection multiplexing.
 *
 * NO remote tmux: the runner-host's JSON-RPC socket is what a remote-hsr bee's
 * control plane rides on (forwarded over ssh in APIA-92).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  loadNode,
  registerNode,
  updateNode,
  LOCAL_NODE_NAME,
  type NodeRecord,
} from "../node.js";
import { ensureRunnerHostBundle, type RunnerHostBundle } from "./buildRunnerHostBundle.js";
import { defaultSshExecHook, type SshExecHook } from "./sshExec.js";

// The ssh exec hook + type live in ./sshExec.js (single source shared with
// remoteTransport.ts); re-exported so existing `bootstrap` importers keep working.
export type { SshExecHook };

/**
 * Bootstrap ssh operations (version probe, mkdir, bundle deploy, handshake) are
 * interactive/long-running — the cat-pipe deploy can stream a multi-hundred-KB
 * bundle — so they run WITHOUT a wall-clock bound (`timeoutMs: 0`). The daemon
 * tick path (remoteTransport) uses the same hook WITH the default bound.
 */
const unboundedSshExecHook: SshExecHook = (argv, input) => defaultSshExecHook(argv, input, { timeoutMs: 0 });

const DEFAULT_MIN_NODE_MAJOR = 18;
const REMOTE_DIR = "~/.hive/runner-host";
const MISSING_MARKER = "__HIVE_RH_MISSING__";
const REMOTE_SHA256_SCRIPT =
  "const { createHash } = require('node:crypto');" +
  "const { readFileSync } = require('node:fs');" +
  "process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'));";

// Same connection-multiplexing defaults as ssh-tmux (see that file's rationale),
// plus accept-new so a first-contact bootstrap does not wedge on host-key TOFU.
const DEFAULT_SSH_ARGS: string[] = [
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=~/.ssh/hive-%C",
  "-o", "ControlPersist=60",
  "-o", "StrictHostKeyChecking=accept-new",
];

export type BootstrapParams = {
  name: string;
  endpoint: string;
  sshCommand?: string;
  sshArgs?: string[];
  capabilities?: string[];
  description?: string;
  /** Minimum remote node major version (default 18). */
  minNodeMajor?: number;
};

export type BootstrapDeps = {
  execHook?: SshExecHook;
  /** Override the bundle build (tests). Defaults to ensureRunnerHostBundle(). */
  ensureBundle?: () => Promise<RunnerHostBundle>;
  /** Read the local bundle file to pipe to the remote. Defaults to fs readFile. */
  readBundle?: (path: string) => Promise<string>;
};

export type BootstrapResult = {
  node: NodeRecord;
  version: string;
  /** true if the bundle was copied; false if the remote already had this version. */
  deployed: boolean;
  remotePath: string;
};

/** The remote path a given version's bundle lands at (tilde-expanded remote-side). */
export function remoteBundlePath(version: string): string {
  return `${REMOTE_DIR}/hive-runner-host-${version}.mjs`;
}

function parseNodeMajor(versionOut: string): number | null {
  const match = /v?(\d+)\./.exec(versionOut.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function bootstrapRunnerHost(
  params: BootstrapParams,
  deps: BootstrapDeps = {},
): Promise<BootstrapResult> {
  const exec = deps.execHook ?? unboundedSshExecHook;
  const ensureBundle = deps.ensureBundle ?? (() => ensureRunnerHostBundle());
  const readBundle = deps.readBundle ?? ((path: string) => readFile(path, "utf8"));
  const minMajor = params.minNodeMajor ?? DEFAULT_MIN_NODE_MAJOR;

  const sshBinary = params.sshCommand ?? "ssh";
  // User-provided sshArgs replace the defaults wholesale (same rule as ssh-tmux).
  const sshArgs = params.sshArgs && params.sshArgs.length > 0 ? [...params.sshArgs] : DEFAULT_SSH_ARGS;

  // Remote commands are passed as ONE string so the remote login shell expands
  // `~` and interprets `&&`/`||`. The version core is [A-Za-z0-9.+-] only, so the
  // interpolated remote paths need no quoting.
  const runRemote = (remoteCommand: string, input?: string) =>
    exec([sshBinary, ...sshArgs, params.endpoint, remoteCommand], input);

  // 1. Precheck: a node runtime of a sufficient major must exist on the remote.
  const nodeCheck = await runRemote("node --version");
  if (nodeCheck.exitCode !== 0) {
    throw new Error(
      `runner-host bootstrap: remote "${params.endpoint}" has no usable \`node\` on PATH ` +
        `(ssh exit ${nodeCheck.exitCode}: ${nodeCheck.stderr.trim() || nodeCheck.stdout.trim() || "no output"}). ` +
        `Install Node.js >= ${minMajor} on the node.`,
    );
  }
  const major = parseNodeMajor(nodeCheck.stdout || nodeCheck.stderr);
  if (major === null) {
    throw new Error(`runner-host bootstrap: could not parse remote node version from "${nodeCheck.stdout.trim()}"`);
  }
  if (major < minMajor) {
    throw new Error(`runner-host bootstrap: remote node ${nodeCheck.stdout.trim()} is too old; need >= ${minMajor}`);
  }

  // 2. Ensure the remote runner-host dir exists.
  const mkdir = await runRemote(`mkdir -p ${REMOTE_DIR}`);
  if (mkdir.exitCode !== 0) {
    throw new Error(`runner-host bootstrap: mkdir on remote failed (exit ${mkdir.exitCode}): ${mkdir.stderr.trim()}`);
  }

  // 3. Build the bundle locally and deploy it (idempotent).
  const bundle = await ensureBundle();
  const remotePath = remoteBundlePath(bundle.version);
  const content = await readBundle(bundle.path);
  const expectedHash = sha256Hex(content);

  const hashCommand = `node -e ${shellQuote(REMOTE_SHA256_SCRIPT)}`;
  const remoteHash = await runRemote(`[ -f ${remotePath} ] && ${hashCommand} ${remotePath} || echo ${MISSING_MARKER}`);
  const alreadyThere = remoteHash.exitCode === 0 && remoteHash.stdout.trim() === expectedHash;

  let deployed = false;
  if (!alreadyThere) {
    const tempPath = `${remotePath}.tmp.$$`;
    const copyCommand = [
      `cat > ${tempPath}`,
      `[ "$(${hashCommand} ${tempPath})" = ${expectedHash} ]`,
      `mv -f ${tempPath} ${remotePath}`,
    ].join(" && ");
    const copy = await runRemote(copyCommand, content);
    if (copy.exitCode !== 0) {
      throw new Error(`runner-host bootstrap: copy to remote failed (exit ${copy.exitCode}): ${copy.stderr.trim()}`);
    }
    deployed = true;
  }

  // 4. Handshake: the deployed bundle must report the version we built.
  const handshake = await runRemote(`node ${remotePath} --version`);
  if (handshake.exitCode !== 0) {
    throw new Error(`runner-host bootstrap: --version handshake failed (exit ${handshake.exitCode}): ${handshake.stderr.trim() || handshake.stdout.trim()}`);
  }
  const reported = handshake.stdout.trim();
  // The deployed bundle freezes its version via an esbuild define, so its
  // --version must equal `runner-host <bundle.version>` exactly.
  const expected = `runner-host ${bundle.version}`;
  if (reported !== expected) {
    throw new Error(`runner-host bootstrap: version handshake mismatch — remote reported "${reported}", expected "${expected}"`);
  }

  // 5. Register / refresh the NodeRecord.
  const existing = await loadNode(params.name);
  const hasRealRecord = existing !== null && !(params.name === LOCAL_NODE_NAME && existing.createdAt === "1970-01-01T00:00:00.000Z");

  let node: NodeRecord;
  if (hasRealRecord && existing) {
    if (existing.kind !== "remote-hsr") {
      throw new Error(`Node ${params.name} already exists as ${existing.kind}. Unregister it first: hive node unregister ${params.name}`);
    }
    node = await updateNode(params.name, {
      endpoint: params.endpoint,
      runnerHostVersion: bundle.version,
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.capabilities ? { capabilities: params.capabilities } : {}),
      ...(params.sshCommand !== undefined ? { sshCommand: params.sshCommand } : {}),
      ...(params.sshArgs ? { sshArgs: params.sshArgs } : {}),
    });
  } else {
    node = await registerNode({
      name: params.name,
      kind: "remote-hsr",
      endpoint: params.endpoint,
      runnerHostVersion: bundle.version,
      ...(params.capabilities ? { capabilities: params.capabilities } : {}),
      ...(params.description ? { description: params.description } : {}),
      ...(params.sshCommand ? { sshCommand: params.sshCommand } : {}),
      ...(params.sshArgs ? { sshArgs: params.sshArgs } : {}),
    });
  }

  return { node, version: bundle.version, deployed, remotePath };
}
