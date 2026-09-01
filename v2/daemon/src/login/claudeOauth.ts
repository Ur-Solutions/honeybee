/**
 * Claude OAuth runner — the direct PKCE authorization-code flow Claude Code
 * itself performs, run inside the daemon: the operator approves in the
 * browser and pastes back `code#state`; the daemon exchanges it, proves the
 * token against the usage endpoint, lands `.credentials.json` (0600) in the
 * account home (+ Keychain on macOS), and captures it into the vault.
 *
 * The PKCE verifier never leaves this process; `state` is an independent
 * nonce, so the mirrored authorization URL carries only the challenge.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeCredentials, safeAuthorizationUrl, type LoginFieldDescriptor, type LoginFlowRow } from "../../../core/src/index.ts";
import { seedClaudeHomeAcceptance, seedClaudeHomeDefaults, atomicWriteFileSync } from "../homeDefaults.ts";
import { STATIC_DETAIL, err } from "./common.ts";
import type { LoginRunner, LoginRunnerHost } from "./runner.ts";
import { CLAUDE_OAUTH_AUTHORIZE_URL, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_REDIRECT_URI, CLAUDE_OAUTH_SCOPES } from "./transports.ts";

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Build the Claude authorize URL for a verifier/state pair (pure; unit-tested). */
export function claudeAuthorizeUrl(codeVerifier: string, state: string): string {
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

/** The pasted Claude code is `code#state`; a bare code uses the flow's own state. */
export function splitClaudeCode(pasted: string, flowState: string): { code: string; state: string } | null {
  const trimmed = pasted.trim();
  if (trimmed.length === 0 || trimmed.length > 4096 || /\s/.test(trimmed)) return null;
  const hash = trimmed.indexOf("#");
  if (hash < 0) return { code: trimmed, state: flowState };
  const code = trimmed.slice(0, hash);
  const state = trimmed.slice(hash + 1);
  if (!code || !state) return null;
  return { code, state };
}

export class ClaudeOauthRunner implements LoginRunner {
  readonly kind = "claude_oauth" as const;
  private readonly host: LoginRunnerHost;
  private readonly codeVerifier = pkceVerifier();
  // Claude Code uses a full 256-bit base64url nonce for both PKCE material
  // and OAuth state. The provider validates this shape after approval.
  private readonly state = randomBytes(32).toString("base64url");

  constructor(host: LoginRunnerHost) {
    this.host = host;
  }

  async start(): Promise<LoginFlowRow> {
    const url = safeAuthorizationUrl(claudeAuthorizeUrl(this.codeVerifier, this.state));
    return this.host.patch(
      { phase: "waiting_input", detail: STATIC_DETAIL.code, authorizationUrl: url, inputFields: this.host.method.fields.map((f) => ({ ...f })) },
      "authorization url issued",
    );
  }

  async submit(values: Record<string, string>, _fields: readonly LoginFieldDescriptor[]): Promise<LoginFlowRow> {
    const host = this.host;
    const account = host.account;
    const split = splitClaudeCode(values.code ?? "", this.state);
    if (!split) return host.reask(err("invalid_input", "That does not look like an authorization code. Paste the whole code shown on the sign-in page."));
    const grant = await host.transports.claudeTokenExchange({ code: split.code, state: split.state, codeVerifier: this.codeVerifier, redirectUri: CLAUDE_OAUTH_REDIRECT_URI, clientId: CLAUDE_OAUTH_CLIENT_ID });
    if (!grant) return host.reask(err("invalid_credential", "The sign-in page rejected that code. Open the sign-in page again and paste a fresh code."));
    const ok = await host.transports.claudeTokenCheck(grant.accessToken);
    if (!ok) return host.reask(err("invalid_credential", "The credential did not authenticate. Open the sign-in page again and paste a fresh code."));
    if (!host.stillActive()) return host.flow() as LoginFlowRow;
    const subscriptionType = await host.transports.claudeSubscriptionType(grant.accessToken);
    const document = {
      claudeAiOauth: {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt,
        scopes: grant.scopes,
        ...(subscriptionType ? { subscriptionType } : {}),
      },
    };
    const raw = JSON.stringify(document);
    if (!parseClaudeCredentials(raw)) return host.reask(err("invalid_credential", "The provider returned an unusable credential."));
    // Home is authoritative: land the credential there (0600), seed the
    // home defaults a fresh Claude home needs, then capture into the vault.
    mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(account.homePath, ".credentials.json"), raw, 0o600);
    seedClaudeHomeDefaults(account.homePath);
    seedClaudeHomeAcceptance(account.homePath, { yolo: true });
    const keychainWritten = await host.accounts.writeClaudeKeychain(account, raw).catch(() => false);
    const captured = host.accounts.persistCredentialCapture(account, ".credentials.json", raw, { ".credentials.json": raw });
    if (!captured.ok) return host.fail(err("capture_failed", "The credential could not be saved into the account's vault."), true);
    host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=claude_oauth keychain=${keychainWritten} files=${captured.captured.join(",")}`);
    return host.succeed();
  }

  tick(_now: number): void {}

  async stop(): Promise<void> {}

  workerStatus(): null {
    return null;
  }
}
