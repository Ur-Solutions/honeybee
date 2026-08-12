/**
 * `hive cell-cred mint` — SECURITY-CRITICAL standalone entry point to the
 * ephemeral-credential mint (APIA-93). It mints the SAME short-lived,
 * refresh-blanked / provider-filtered credential material that an
 * account-bound remote-HSR spawn delivers (src/commands/spawn.ts →
 * mintEphemeralCredential) and prints it as a single pure-JSON object on
 * STDOUT, so the Apiary desktop can shell out to it and deposit the material to
 * the Apiary Cloud gateway.
 *
 * INVARIANTS (do not weaken):
 *  - The ONLY channel credential bytes ever touch is the stdout JSON. Nothing
 *    else — no banner, no log line, no note — is written to stdout, because the
 *    desktop captures stdout verbatim.
 *  - stderr, the ledger, and any note path stay SECRET-FREE. Failures surface a
 *    secret-free message and exit non-zero; a mint error NEVER prints partial
 *    creds and NEVER echoes token bytes (fail-closed).
 *  - The emitted material is mintEphemeralCredential's output UNCHANGED — this
 *    command never re-derives, decodes, or re-blanks it.
 */
import { canonicalAgentKind } from "../agents.js";
import { stringFlag } from "../cli/shared.js";
import { ephemeralHarnesses, ephemeralPolicyFor, harnessSupportsRemoteHsr } from "../hsr/harness.js";
import { mintEphemeralCredential, type EphemeralCredential } from "../hsr/remoteCreds.js";
import type { Parsed } from "../parse.js";
// Reuse spawn's EXACT account resolver (named + `auto`) so a minted credential
// binds to the same account a real account-bound spawn would pick — never a new
// resolver.
import { resolveAccountFlag } from "./spawn.js";

const USAGE = [
  "Usage: hive cell-cred mint <account|auto> --harness <claude|codex|grok|kimi|opencode> [--json]",
  "  Mint a short-lived ephemeral credential for the account + harness and print it as JSON on stdout.",
  "  stdout is PURE JSON — { \"files\": [{ homeRelPath, contentB64, mode }], \"env\": { … }, \"note\": string }.",
  "  Nothing else is written to stdout; every error and diagnostic goes to stderr with a non-zero exit.",
].join("\n");

export async function cmdCellCred(parsed: Parsed): Promise<void> {
  const verb = parsed.args[0];
  if (verb !== "mint") throw new Error(USAGE);
  await cellCredMint(parsed);
}

async function cellCredMint(parsed: Parsed): Promise<void> {
  // 1. Harness FIRST — cheap, secret-free validation that fails closed before we
  //    ever touch the vault or mint any material.
  const harnessArg = stringFlag(parsed, ["harness"]);
  if (!harnessArg) throw new Error(`--harness <claude|codex|grok|kimi|opencode> is required\n${USAGE}`);
  const kind = canonicalAgentKind(harnessArg).toLowerCase();
  // cursor (and any remote-HSR local-only harness) is rejected with a clear
  // message — its credential store is machine-global and is never delivered off
  // this box, so there is nothing to mint. Reject BEFORE resolving an account.
  if (!harnessSupportsRemoteHsr(kind)) {
    throw new Error(
      `harness "${kind}" is local-only: ephemeral credential delivery is not implemented for it, so no credential can be minted`,
    );
  }
  if (!ephemeralPolicyFor(kind)) {
    throw new Error(
      `ephemeral credential delivery is not wired for harness "${kind}" (supported: ${ephemeralHarnesses().join(", ")})`,
    );
  }

  // 2. Account selector — positional (`cell-cred mint <account>`) OR `--account`,
  //    matching hive's other account-taking commands. `auto` picks the
  //    least-loaded account exactly as a spawn would.
  const accountQuery = stringFlag(parsed, ["account"]) ?? parsed.args[1];
  if (!accountQuery) {
    throw new Error(`an account selector is required (positional or --account <label|id|auto>)\n${USAGE}`);
  }
  const account = await resolveAccountFlag(accountQuery, kind, undefined, false);

  // 3. Mint the SAME material the spawn delivery path produces (grok/kimi refresh
  //    blanked, opencode single-provider filtered, codex access-token-only). We
  //    emit it UNCHANGED — never re-derive it.
  let credential: EphemeralCredential;
  try {
    credential = await mintEphemeralCredential(account, kind);
  } catch (error) {
    // Fail closed: surface ONLY the (secret-free) message — never partial creds,
    // never token bytes. mint messages are secret-free by construction.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not mint an ephemeral credential for ${account.id} (${kind}): ${message}`);
  }

  // 4. The ONLY place credential bytes are written: the stdout JSON. A single
  //    pure-JSON object, no banners/log lines, captured verbatim by the desktop.
  //    `env` is normalized to {} for file-only strategies so the shape is always
  //    { files, env }. `note` is mintEphemeralCredential's secret-free kindNote.
  const payload = {
    files: credential.files,
    env: credential.env ?? {},
    note: credential.kindNote,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
