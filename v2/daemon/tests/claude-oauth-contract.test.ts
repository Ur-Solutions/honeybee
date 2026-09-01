import assert from "node:assert/strict";
import test from "node:test";
import type { LoginFlowRow } from "../../core/src/index.ts";
import { ClaudeOauthRunner, claudeAuthorizeUrl } from "../src/login/claudeOauth.ts";
import type { LoginRunnerHost } from "../src/login/runner.ts";
import {
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_REDIRECT_URI,
  CLAUDE_OAUTH_SCOPES,
  CLAUDE_OAUTH_TOKEN_URL,
} from "../src/login/transports.ts";

test("claude oauth matches the current Claude Code authorization contract", async () => {
  assert.equal(CLAUDE_OAUTH_AUTHORIZE_URL, "https://claude.com/cai/oauth/authorize");
  assert.equal(CLAUDE_OAUTH_TOKEN_URL, "https://platform.claude.com/v1/oauth/token");
  assert.equal(CLAUDE_OAUTH_REDIRECT_URI, "https://platform.claude.com/oauth/code/callback");
  assert.deepEqual(CLAUDE_OAUTH_SCOPES, [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ]);

  let authorizationUrl: string | null = null;
  const host = {
    method: { fields: [] },
    patch: (patch: { authorizationUrl?: string | null }) => {
      authorizationUrl = patch.authorizationUrl ?? null;
      return patch as LoginFlowRow;
    },
  } as unknown as LoginRunnerHost;
  await new ClaudeOauthRunner(host).start();

  assert.ok(authorizationUrl);
  const url = new URL(authorizationUrl);
  assert.equal(url.origin + url.pathname, CLAUDE_OAUTH_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("redirect_uri"), CLAUDE_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get("scope"), CLAUDE_OAUTH_SCOPES.join(" "));
  assert.match(url.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(url.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("claude oauth URL encoding stays stable for known verifier and state", () => {
  const url = new URL(claudeAuthorizeUrl("a".repeat(43), "b".repeat(43)));
  assert.equal(url.searchParams.get("state"), "b".repeat(43));
  assert.equal(url.searchParams.get("scope"), CLAUDE_OAUTH_SCOPES.join(" "));
});
