/**
 * Provider transports the direct runners talk to (Claude OAuth token
 * exchange / validation, OpenAI + Anthropic key checks). Injected so the
 * service tests never touch the network; the defaults are the real
 * providers with one bounded timeout.
 */

export interface ClaudeTokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export type KeyCheck = "valid" | "invalid" | "unverified";

export interface LoginTransports {
  /** Exchange a pasted `code#state` for tokens (PKCE). null = the provider rejected it. Throws on transport failure. */
  claudeTokenExchange: (input: { code: string; state: string; codeVerifier: string; redirectUri: string; clientId: string }) => Promise<ClaudeTokenGrant | null>;
  /** Prove the access token authenticates (the usage endpoint) — the validation step. Throws on transport failure; false on 401/403. */
  claudeTokenCheck: (accessToken: string) => Promise<boolean>;
  /** Best-effort subscription type for the credential document (Claude Code reads it); null when unknown. */
  claudeSubscriptionType: (accessToken: string) => Promise<string | null>;
  /** OpenAI API key check (`GET /v1/models`). */
  openaiKeyCheck: (apiKey: string, baseUrl?: string) => Promise<KeyCheck>;
  /** Anthropic API key check (`GET /v1/models`). */
  anthropicKeyCheck: (apiKey: string, baseUrl?: string) => Promise<KeyCheck>;
}

// Claude Code's public OAuth client id (the one the CLI itself uses).
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Keep this contract aligned with `claude auth login`. Anthropic moved the
// Claude Code OAuth surface in 2.1.233; the retired claude.ai/console URLs
// reach the sign-in UI but are rejected after approval as "Invalid format".
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

async function checkedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function keyCheckFromStatus(status: number): KeyCheck {
  if (status === 401 || status === 403) return "invalid";
  if (status >= 200 && status < 300) return "valid";
  return "unverified";
}

export function defaultLoginTransports(timeoutMs: number): LoginTransports {
  return {
    claudeTokenExchange: async ({ code, state, codeVerifier, redirectUri, clientId }) => {
      const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, state, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 400 || response.status === 401 || response.status === 403) return null;
      const body = (await checkedJson(response)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
      if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") return null;
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
        scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : CLAUDE_OAUTH_SCOPES,
      };
    },
    claudeTokenCheck: async (accessToken) => {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    },
    claudeSubscriptionType: async (accessToken) => {
      try {
        const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
          headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { organization?: { organization_type?: unknown }; account?: { has_claude_max?: unknown; has_claude_pro?: unknown } };
        const type = body.organization?.organization_type;
        if (typeof type === "string" && type.startsWith("claude_")) return type.slice("claude_".length);
        if (body.account?.has_claude_max === true) return "max";
        if (body.account?.has_claude_pro === true) return "pro";
        return null;
      } catch {
        return null;
      }
    },
    openaiKeyCheck: async (apiKey, baseUrl) => {
      const response = await fetch(`${(baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return keyCheckFromStatus(response.status);
    },
    anthropicKeyCheck: async (apiKey, baseUrl) => {
      const response = await fetch(`${(baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "")}/models`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return keyCheckFromStatus(response.status);
    },
  };
}
