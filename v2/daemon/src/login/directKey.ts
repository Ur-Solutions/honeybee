/**
 * Direct API-key runner — Codex (OpenAI key → `auth.json`) and OpenCode
 * (provider + key → `xdg-data/opencode/auth.json`, non-secret provider
 * options → `opencode.json`). The key is checked against the provider's
 * API where one is known, written to the account home with restrictive
 * modes, and captured into the vault. The typed values live in local
 * variables for one submit and are never logged or stored on the row.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OPENCODE_API_KEY_PROVIDERS, recipeFor, type IdentityRecipe, type LoginFieldDescriptor, type LoginFlowRow } from "../../../core/src/index.ts";
import { atomicWriteFileSync } from "../homeDefaults.ts";
import { STATIC_DETAIL, err, readJsonObject, writePrivateJson, writePrivateRaw } from "./common.ts";
import type { LoginRunner, LoginRunnerHost } from "./runner.ts";
import type { KeyCheck } from "./transports.ts";

/** Reject keys that are obviously not keys (whitespace, control chars, absurd length). Never logs the value. */
export function plausibleApiKey(value: string): boolean {
  return value.length >= 8 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

/** Non-secret, bounded field values (base URL / organization / project). */
export function plausibleOption(value: string, kind: "url" | "text"): boolean {
  if (value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (kind !== "url") return true;
  try {
    const url = new URL(value);
    // A key is sent to this host during the check: https, or loopback http (local proxies).
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

export class DirectKeyRunner implements LoginRunner {
  readonly kind = "direct_key" as const;
  private readonly host: LoginRunnerHost;
  private readonly runner: "codex_api_key" | "opencode_api_key";

  constructor(host: LoginRunnerHost, runner: "codex_api_key" | "opencode_api_key") {
    this.host = host;
    this.runner = runner;
  }

  async start(): Promise<LoginFlowRow> {
    return this.host.patch({ phase: "waiting_input", detail: STATIC_DETAIL.input, inputFields: this.host.method.fields.map((f) => ({ ...f })) }, "fields requested");
  }

  async submit(values: Record<string, string>, _fields: readonly LoginFieldDescriptor[]): Promise<LoginFlowRow> {
    const apiKey = (values.apiKey ?? "").trim();
    if (!plausibleApiKey(apiKey)) return this.host.reask(err("invalid_input", "That does not look like an API key."));
    return this.runner === "codex_api_key" ? this.completeCodex(apiKey) : this.completeOpencode(apiKey, values);
  }

  private async completeCodex(apiKey: string): Promise<LoginFlowRow> {
    const host = this.host;
    const account = host.account;
    const check = await host.transports.openaiKeyCheck(apiKey);
    if (check === "invalid") return host.reask(err("invalid_credential", "OpenAI rejected that API key."));
    if (check === "unverified") return host.reask(err("network_error", "OpenAI could not be reached to check the key. Try again."));
    if (!host.stillActive()) return host.flow() as LoginFlowRow;
    const raw = `${JSON.stringify({ OPENAI_API_KEY: apiKey, tokens: null, last_refresh: null }, null, 2)}\n`;
    mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(account.homePath, "auth.json"), raw, 0o600);
    const recipe = recipeFor("codex") as IdentityRecipe;
    for (const [canonical, mirror] of Object.entries(recipe.activationMirrors ?? {})) {
      if (canonical === "auth.json") writePrivateRaw(join(account.homePath, mirror), raw);
    }
    const captured = host.accounts.persistCredentialCapture(account, "auth.json", raw, {});
    if (!captured.ok) return host.fail(err("capture_failed", "The credential could not be saved into the account's vault."), true);
    host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=codex_api_key files=${captured.captured.join(",")}`);
    return host.succeed();
  }

  private async completeOpencode(apiKey: string, values: Record<string, string>): Promise<LoginFlowRow> {
    const host = this.host;
    const account = host.account;
    const provider = (values.provider ?? "").trim();
    const known = OPENCODE_API_KEY_PROVIDERS.find((p) => p.id === provider);
    if (!known) return host.reask(err("invalid_input", "Pick a provider."));
    const options: Record<string, unknown> = {};
    const headers: Record<string, string> = {};
    const baseUrl = (values.baseUrl ?? "").trim();
    if (baseUrl) {
      if (!known.baseUrl || !plausibleOption(baseUrl, "url")) return host.reask(err("invalid_input", "The base URL must be an http(s) URL."));
      options.baseURL = baseUrl;
    }
    const organization = (values.organization ?? "").trim();
    if (organization) {
      if (!known.organization || !plausibleOption(organization, "text")) return host.reask(err("invalid_input", "Invalid organization id."));
      headers["OpenAI-Organization"] = organization;
    }
    const project = (values.project ?? "").trim();
    if (project) {
      if (!known.project || !plausibleOption(project, "text")) return host.reask(err("invalid_input", "Invalid project id."));
      headers["OpenAI-Project"] = project;
    }
    let check: KeyCheck = "unverified";
    if (provider === "openai") check = await host.transports.openaiKeyCheck(apiKey, baseUrl || undefined);
    else if (provider === "anthropic") check = await host.transports.anthropicKeyCheck(apiKey, baseUrl || undefined);
    if (check === "invalid") return host.reask(err("invalid_credential", `${known.label} rejected that API key.`));
    if (!host.stillActive()) return host.flow() as LoginFlowRow;
    host.patch({ provider }, "provider");
    const authPath = join(account.homePath, "xdg-data", "opencode", "auth.json");
    const auth = readJsonObject(authPath);
    auth[provider] = { type: "api", key: apiKey };
    writePrivateJson(authPath, auth);
    if (Object.keys(options).length > 0 || Object.keys(headers).length > 0) {
      const configPath = join(account.homePath, "opencode.json");
      const config = readJsonObject(configPath);
      const providers = (config.provider && typeof config.provider === "object" && !Array.isArray(config.provider) ? config.provider : {}) as Record<string, unknown>;
      const entry = (providers[provider] && typeof providers[provider] === "object" ? providers[provider] : {}) as Record<string, unknown>;
      const existingOptions = (entry.options && typeof entry.options === "object" ? entry.options : {}) as Record<string, unknown>;
      const existingHeaders = (existingOptions.headers && typeof existingOptions.headers === "object" ? existingOptions.headers : {}) as Record<string, unknown>;
      entry.options = { ...existingOptions, ...options, ...(Object.keys(headers).length > 0 ? { headers: { ...existingHeaders, ...headers } } : {}) };
      providers[provider] = entry;
      config.provider = providers;
      writePrivateJson(configPath, config);
    }
    const raw = readFileSync(authPath, "utf8");
    const captured = host.accounts.persistCredentialCapture(account, "xdg-data/opencode/auth.json", raw, {});
    if (!captured.ok) return host.fail(err("capture_failed", "The credential could not be saved into the account's vault."), true);
    host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=opencode_api_key provider=${provider} verified=${check === "valid"} files=${captured.captured.join(",")}`);
    return host.succeed(check === "valid" ? undefined : `Saved. ${known.label} keys are checked by format only; OpenCode verifies them on first use.`);
  }

  tick(_now: number): void {}

  async stop(): Promise<void> {}

  workerStatus(): null {
    return null;
  }
}
