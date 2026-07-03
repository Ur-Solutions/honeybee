/**
 * Per-node ephemeral credential delivery for remote HSR (APIA-93).
 *
 * SECURITY-SENSITIVE. This module implements the "ephemeral-token" auth policy:
 * it delivers a SINGLE account's SHORT-LIVED login into a remote node's per-bee
 * isolated home at spawn, and shreds it on kill. It NEVER copies the vault to a
 * remote, and NEVER re-implements OAuth — the claude path execs the GENUINE
 * `claude setup-token` binary to mint a real token.
 *
 * Guardrails (non-negotiable — mirrored in code below):
 *  - The local vault is NEVER copied wholesale to a remote; only THIS account's
 *    single primary credential (per the identity recipe) crosses the wire.
 *  - Delivered credentials are DESTROYED on kill (overwrite-then-unlink); they
 *    live only in the remote's per-bee isolated home for the bee's lifetime.
 *  - Credential material is base64/opaque in transit and is NEVER written to
 *    logs, the ledger, or error messages. `kindNote` carries no secret bytes.
 *  - Only the genuine harness runs remotely; nothing here spoofs a provider.
 *
 * Two sides live here:
 *  - MINT side (runs LOCALLY, in cli.ts spawnBee): mintEphemeralCredential —
 *    reads the account's vaulted primary credential / mints a setup-token.
 *  - DELIVER/SHRED side (runs ON THE REMOTE, in remoteHost.ts spawn/kill):
 *    writeDeliveredCredentials / recordDeliveredCredentials / shredDelivered-
 *    Credentials — pure fs, no accounts.ts import, so the runner-host bundle
 *    stays lean (esbuild DCE drops the mint side + its accounts.ts graph).
 *
 * Node builtins + the lightweight drivers/runDir modules only.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { homeEnvForAgent, identityRecipeForAgent } from "../drivers.js";
import { hsrRunDir } from "./runDir.js";
// accounts.ts is imported ONLY by the mint side; remoteHost.ts imports only the
// deliver/shred functions, so esbuild's tree-shake keeps accounts.ts out of the
// remote runner-host bundle. Keep it that way: no accounts symbol may be used by
// any export remoteHost.ts calls.
import { accountDir, defaultHomeForAccount, type AccountRecord } from "../accounts.js";

const execFileP = promisify(execFile);

// ── Wire shape (opaque; base64 in transit) ─────────────────────────────────

/** One credential file to write into the remote isolated home. */
export type EphemeralCredentialFile = {
  /** Path RELATIVE to the harness home (e.g. "auth.json", ".credentials.json"). */
  homeRelPath: string;
  /** File bytes, base64-encoded. Opaque — NEVER decode into a log/error. */
  contentB64: string;
  /** POSIX mode for the written file (0600). */
  mode: number;
};

/**
 * The short-lived material to ship to the remote isolated home. `files` are
 * written into the home; `env` is merged into the spawn env (e.g. a minted
 * token). `kindNote` is a secret-free, one-line description for the operator.
 */
export type EphemeralCredential = {
  files: EphemeralCredentialFile[];
  env?: Record<string, string>;
  kindNote: string;
};

// ── Per-kind policy table (allowance-registry style, so it's correctable) ───

type EphemeralKindPolicy = {
  /**
   * "mint-token"       — exec the genuine harness to mint a fresh short-lived
   *                       token, delivered via `tokenEnv` (claude setup-token).
   * "ship-primary-file"— ship the account's primary credential file into the
   *                       remote home (codex auth.json — the documented flow).
   */
  strategy: "mint-token" | "ship-primary-file";
  /** For "mint-token": the env var the token is delivered as. */
  tokenEnv?: string;
  /** Secret-free human note. */
  note: string;
};

const EPHEMERAL_POLICY: Record<string, EphemeralKindPolicy> = {
  // claude: mint a fresh 1-year OAuth token with the REAL binary. If the binary
  // is absent / not logged in, fall back to shipping .credentials.json (weaker).
  claude: {
    strategy: "mint-token",
    tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    note: "claude setup-token → CLAUDE_CODE_OAUTH_TOKEN",
  },
  // codex: ship auth.json (the identity recipe's primary credential) into the
  // remote CODEX_HOME. codex treats auth.json "like a password" (research §2).
  codex: {
    strategy: "ship-primary-file",
    note: "ship auth.json into remote CODEX_HOME",
  },
};

export type MintDeps = {
  /**
   * Injectable `claude setup-token` runner (tests inject a fake so no real token
   * is minted). Returns the token string, or null to trigger the file fallback.
   */
  runClaudeSetupToken?: (homePath: string) => Promise<string | null>;
};

/**
 * Mint the SHORT-LIVED credential material for `account` (harness `kind`) to
 * deliver to a remote isolated home. Never returns/ships more than this single
 * account's primary credential (or a purpose-minted token).
 */
export async function mintEphemeralCredential(
  account: AccountRecord,
  kind: string,
  deps: MintDeps = {},
): Promise<EphemeralCredential> {
  const policy = EPHEMERAL_POLICY[kind];
  if (!policy) {
    throw new Error(`ephemeral-token delivery is not wired for harness "${kind}" (supported: ${Object.keys(EPHEMERAL_POLICY).join(", ")})`);
  }

  if (policy.strategy === "mint-token") {
    const run = deps.runClaudeSetupToken ?? defaultRunClaudeSetupToken;
    // Mint against the account's LOCAL home so the token belongs to this account.
    const token = await run(defaultHomeForAccount(account));
    if (token && policy.tokenEnv) {
      // Token rides in `env` (usable as-is by the child); it is opaque and must
      // never be logged. kindNote deliberately omits the token bytes.
      return {
        files: [],
        env: { [policy.tokenEnv]: token },
        kindNote: `${kind}: minted setup-token, delivered as ${policy.tokenEnv} (no credential file on remote)`,
      };
    }
    // Fallback: ship the primary credential file like codex. WEAKER guarantee —
    // it is the vault snapshot's refresh chain, not a purpose-minted token.
    const file = await requirePrimaryCredential(account, kind);
    return {
      files: [file],
      kindNote: `${kind}: setup-token unavailable; fell back to shipping ${file.homeRelPath} (weaker guarantee)`,
    };
  }

  // ship-primary-file
  const file = await requirePrimaryCredential(account, kind);
  return {
    files: [file],
    kindNote: `${kind}: shipped ${file.homeRelPath} into the remote isolated home (0600)`,
  };
}

/** Default: exec the GENUINE `claude setup-token` against the account's home. */
async function defaultRunClaudeSetupToken(homePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("claude", ["setup-token"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: homePath },
      timeout: 120_000,
      maxBuffer: 1 << 20,
    });
    return extractSetupToken(stdout);
  } catch {
    // Binary missing / not logged in / non-interactive refusal → fall back.
    return null;
  }
}

/** Pull the token out of `claude setup-token` output (secret-free failure = null). */
function extractSetupToken(raw: string): string | null {
  const explicit = raw.match(/sk-ant-[A-Za-z0-9_-]+/);
  if (explicit) return explicit[0];
  const last = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return last && /^[A-Za-z0-9_.-]{20,}$/.test(last) ? last : null;
}

/**
 * Read THIS account's single primary credential file (recipe.credentialFiles[0])
 * from the vault (preferred) or its dedicated home, base64-encoded. NEVER reads
 * the whole vault or the supporting snapshots — only the one login file.
 */
async function requirePrimaryCredential(account: AccountRecord, kind: string): Promise<EphemeralCredentialFile> {
  const recipe = identityRecipeForAgent(kind);
  if (!recipe || recipe.credentialFiles.length === 0) {
    throw new Error(`harness "${kind}" has no identity recipe; cannot mint an ephemeral credential`);
  }
  const primary = recipe.credentialFiles[0]!;
  const candidates = [join(accountDir(account), primary), join(defaultHomeForAccount(account), primary)];
  for (const path of candidates) {
    const buf = await readFile(path).catch(() => null);
    if (buf) return { homeRelPath: primary, contentB64: buf.toString("base64"), mode: 0o600 };
  }
  throw new Error(`no primary credential (${primary}) found for account ${account.id}; capture it first with: hive account login ${account.tool} ${account.label}`);
}

// ── Deliver / shred side (runs ON THE REMOTE — pure fs, no accounts import) ──

/** The `creds` payload carried over the spawn RPC (deliver side). */
export type DeliveredCredentials = {
  files?: EphemeralCredentialFile[];
  env?: Record<string, string>;
};

/**
 * The harness home dir for a resolved spec, read out of its env (CLAUDE_CONFIG_DIR
 * / CODEX_HOME / …). Undefined when the harness has no home env.
 */
export function homeDirForSpec(kind: string, env: Record<string, string>): string | undefined {
  const homeEnv = homeEnvForAgent(kind);
  return homeEnv ? env[homeEnv] : undefined;
}

/**
 * Write the delivered credential files into the freshly-created isolated home
 * (0700 dir, 0600 files) BEFORE the runner forks. Returns the absolute paths
 * written, for the run-dir record `kill` shreds. Secrets are never logged.
 */
export async function writeDeliveredCredentials(homeDir: string, creds: DeliveredCredentials): Promise<string[]> {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const file of creds.files ?? []) {
    const target = join(homeDir, file.homeRelPath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const mode = file.mode ?? 0o600;
    await writeFile(target, Buffer.from(file.contentB64, "base64"), { mode });
    // writeFile's create mode is masked by umask; re-assert so it is exactly 0600.
    await chmod(target, mode).catch(() => undefined);
    written.push(target);
  }
  return written;
}

function deliveredCredsPath(bee: string): string {
  return join(hsrRunDir(bee), "delivered-creds.json");
}

/** Record delivered credential paths in the bee's run dir so `kill` can shred them. */
export async function recordDeliveredCredentials(bee: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await mkdir(hsrRunDir(bee), { recursive: true, mode: 0o700 });
  await writeFile(deliveredCredsPath(bee), `${JSON.stringify({ paths }, null, 2)}\n`, { mode: 0o600 });
}

/** Read back the delivered credential paths (empty when none/unreadable). */
export async function readDeliveredCredentials(bee: string): Promise<string[]> {
  try {
    const raw = await readFile(deliveredCredsPath(bee), "utf8");
    const parsed = JSON.parse(raw) as { paths?: unknown };
    return Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Destroy every delivered credential file so nothing persists on the remote
 * after the bee dies. Best-effort shred: overwrite the bytes then unlink.
 */
export async function shredDeliveredCredentials(bee: string): Promise<void> {
  const paths = await readDeliveredCredentials(bee);
  for (const path of paths) {
    await overwriteThenUnlink(path);
  }
  await rm(deliveredCredsPath(bee), { force: true }).catch(() => undefined);
}

async function overwriteThenUnlink(path: string): Promise<void> {
  try {
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && info.size > 0) {
      await writeFile(path, Buffer.alloc(info.size, 0), { mode: 0o600 }).catch(() => undefined);
    }
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}
