/**
 * Per-harness identity recipes (spec 08 "Vault"): how a provider's login
 * materializes on disk, so a login flow can capture credentials out of a
 * home into the vault and activation can copy them back into an EMPTY home.
 * Ported from the old src/drivers.ts `identity` table — data only.
 *
 * `credentialFiles[0]` is the PRIMARY credential: a home/vault without it is
 * not logged in (the rest are supporting snapshots). `configFiles` are
 * preserved when present but never gate anything.
 */
import { HARNESS_HOME_ENV } from "./import-frozen.ts";
import type { LoginFieldDescriptor, LoginMethodDescriptor } from "./loginFlow.ts";

export interface IdentityRecipe {
  /** Home-relative credential files; the same relative paths are used inside the vault. */
  credentialFiles: string[];
  /** Extra home-relative copies written on activation, keyed by canonical credential file. */
  activationMirrors?: Record<string, string>;
  /** Non-credential, home-relative config files preserved with an account. */
  configFiles?: string[];
  /** Explicit extra env for activated spawns. "{home}" expands to the home path. */
  extraEnv?: Record<string, string>;
  /**
   * Where the MACHINE's own CLI keeps these files (the "vendor home"): the
   * default dir under $HOME when the harness's home env var
   * (HARNESS_HOME_ENV) is unset, plus recipe-relative files that live
   * somewhere else on the machine. `account.add {importExisting:true}` copies
   * the vendor home's credential into the account's vault from here.
   */
  vendorHome: VendorHomeSpec;
  /**
   * The harness's own login invocation for CLI-driven login methods. Prefer a
   * native login subcommand when the harness exposes one; bare interactive
   * TUIs are reserved for tools whose login still lives in the TUI. Node
   * config `agents.<a>.login` overrides it.
   */
  login: { command: string; args: string[] };
  /**
   * The tmux-independent login contract (2026-08-28): the methods the
   * account can be logged in with, how each one runs, and how the daemon
   * recognizes progress. Data only — the daemon's flow service interprets it.
   */
  loginFlow: LoginRecipe;
}

/**
 * The machine-side layout of a recipe's files. Path templates expand
 * `{HOME}`, `{VENDOR_HOME}`, `{XDG_DATA_HOME}` (default `{HOME}/.local/share`)
 * and `{XDG_CONFIG_HOME}` (default `{HOME}/.config`).
 */
export interface VendorHomeSpec {
  /** The default vendor home, relative to $HOME (`.codex`, `.claude`, …). */
  dir: string;
  /**
   * Recipe-relative files that do NOT sit at `<vendorHome>/<rel>` on the
   * machine. `unsetOnly` entries apply only while the home env var is unset
   * (the CLI folds them into the configured dir otherwise).
   */
  relocated?: Record<string, { path: string; unsetOnly?: boolean }>;
}

/** One machine-side file the import considers, keyed by its recipe-relative name. */
export interface VendorHomeFile {
  rel: string;
  path: string;
  role: "credential" | "config";
}

export interface VendorHomeResolution {
  harness: string;
  /** The env var that relocates the vendor home (undefined for harnesses without one). */
  homeEnv: string | undefined;
  /** Whether `vendorHome` came from that env var (vs the recipe default under $HOME). */
  fromEnv: boolean;
  vendorHome: string;
  /** Every recipe file's machine-side path (credential files first, primary first). */
  files: VendorHomeFile[];
}

// ---------------------------------------------------------------------------
// Login recipes — the extension point for a new provider. Adding a provider
// = one IdentityRecipe (with loginFlow) + a conformance fixture; no client
// code. Apiary renders whatever descriptors ride on the flow row.
// ---------------------------------------------------------------------------

/**
 * How a method executes:
 *  - `direct`: Honeybee talks to the provider itself (typed OAuth/API-key
 *    integration in the daemon; `runner` names it). No CLI, no terminal.
 *  - `cli`: the harness's own login CLI runs inside a Honeybee-owned native
 *    PTY worker (never tmux); `cues` drive the parser that turns output into
 *    typed progress. Provider-specific parsing lives HERE, not in clients.
 */
export type LoginMethodRun =
  | { mode: "direct"; runner: "claude_oauth" | "codex_api_key" | "opencode_api_key" }
  | { mode: "cli"; cli: LoginCliSpec };

export interface LoginCliCue {
  /** Regex source (flags `i`) matched against the cleaned output tail. */
  match: string;
  /** For prompts: the field to request when the cue is seen. */
  field?: LoginFieldDescriptor;
}

export interface LoginCliSpec {
  /** Override of `recipe.login` for this method (e.g. `codex login --device-auth`). */
  command?: { command: string; args: string[] };
  /** Whether the CLI needs a real terminal (a pipe-backed worker is refused with `pty_unavailable` when true and no PTY backend exists). */
  tty: boolean;
  /** Extra env the worker sets (BROWSER=true stops CLIs from opening a second browser tab). */
  env?: Record<string, string>;
  cues: {
    /** Authorization URL regex (one capture group = the URL). Default: the first https URL. */
    url?: string;
    /** Device/user code regex (one capture group = the code). */
    userCode?: string;
    /** Prompts that request typed input; the first matching cue wins. */
    prompts: LoginCliCue[];
    /** Output that means the CLI failed definitively (bounded, safe); the flow fails with `cli_failed`. */
    failure?: string[];
  };
  /**
   * How a successful login is recognized — always by the credential landing
   * (never by process exit): the home's primary file mtime, or the external
   * provider store's digest (macOS Keychain for Claude, Cursor's global store).
   */
  landing: "home_mtime" | "external_digest";
}

export interface LoginRecipe {
  methods: Array<LoginMethodDescriptor & { run: LoginMethodRun }>;
  /** Method chosen when the client does not pick one (local pairing). */
  defaultMethodId: string;
  /** Method chosen for a remote node (must be remoteCapable); absent = the default when it is remoteCapable, else refuse. */
  remoteDefaultMethodId?: string;
}

/** The safe descriptor part of a recipe method (what rides on the flow row). */
export function loginMethodDescriptor(method: LoginMethodDescriptor & { run: LoginMethodRun }): LoginMethodDescriptor {
  return { id: method.id, kind: method.kind, label: method.label, description: method.description, remoteCapable: method.remoteCapable, fields: method.fields.map((f) => ({ ...f })) };
}

function field(partial: Partial<LoginFieldDescriptor> & Pick<LoginFieldDescriptor, "id" | "label">): LoginFieldDescriptor {
  return {
    help: null,
    required: true,
    secret: false,
    inputType: "text",
    placeholder: null,
    pattern: null,
    options: null,
    scope: null,
    ...partial,
  };
}

/** The authorization-code field (browser + code flows). */
export const LOGIN_FIELD_CODE: LoginFieldDescriptor = field({
  id: "code",
  label: "Authorization code",
  help: "Paste the code the sign-in page shows after you approve access.",
  secret: true,
  inputType: "password",
  placeholder: "Paste the code here",
});

const LOGIN_FIELD_API_KEY: LoginFieldDescriptor = field({
  id: "apiKey",
  label: "API key",
  secret: true,
  inputType: "password",
  placeholder: "sk-…",
});

/**
 * OpenCode providers that authenticate with a plain API key
 * (`auth.json[provider] = {type:"api", key}`). Base URL / organization /
 * project are persisted as non-secret provider options in the account
 * home's `opencode.json` (OPENCODE_CONFIG_DIR relocates it per account).
 */
export const OPENCODE_API_KEY_PROVIDERS: ReadonlyArray<{ id: string; label: string; baseUrl?: boolean; organization?: boolean; project?: boolean }> = [
  { id: "anthropic", label: "Anthropic", baseUrl: true },
  { id: "openai", label: "OpenAI", baseUrl: true, organization: true, project: true },
  { id: "google", label: "Google AI Studio (Gemini)", baseUrl: true },
  { id: "xai", label: "xAI (Grok)", baseUrl: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: true },
  { id: "groq", label: "Groq", baseUrl: true },
  { id: "mistral", label: "Mistral", baseUrl: true },
  { id: "deepseek", label: "DeepSeek", baseUrl: true },
  { id: "togetherai", label: "Together AI", baseUrl: true },
  { id: "fireworks-ai", label: "Fireworks AI", baseUrl: true },
  { id: "cerebras", label: "Cerebras", baseUrl: true },
  { id: "minimax-coding-plan", label: "MiniMax coding plan" },
  { id: "zai-coding-plan", label: "Z.AI coding plan" },
];

function opencodeFields(): LoginFieldDescriptor[] {
  return [
    field({
      id: "provider",
      label: "Provider",
      help: "Which model provider this key belongs to.",
      inputType: "select",
      options: OPENCODE_API_KEY_PROVIDERS.map((p) => ({ value: p.id, label: p.label })),
    }),
    { ...LOGIN_FIELD_API_KEY, help: "Stored only in this account's OpenCode auth store." },
    ...OPENCODE_API_KEY_PROVIDERS.filter((p) => p.baseUrl).map((p) =>
      field({ id: "baseUrl", label: "Base URL", help: "Optional. A custom API endpoint for this provider.", required: false, inputType: "url", placeholder: "https://…", scope: p.id }),
    ),
    ...OPENCODE_API_KEY_PROVIDERS.filter((p) => p.organization).map((p) =>
      field({ id: "organization", label: "Organization ID", help: "Optional. Sent as the provider's organization header.", required: false, scope: p.id }),
    ),
    ...OPENCODE_API_KEY_PROVIDERS.filter((p) => p.project).map((p) =>
      field({ id: "project", label: "Project ID", help: "Optional. Sent as the provider's project header.", required: false, scope: p.id }),
    ),
  ];
}

/** Generic cue set for CLIs that print a sign-in URL and may ask for a pasted code or an API key. */
const GENERIC_URL = "(https?://[^\\s'\"<>)\\]]+)";
// A prompt is a line that ENDS in a prompt terminator (`:` / `>`); a device
// line such as "Enter this one-time code: ABCD-1234" ends in the code and
// is never an ask.
const GENERIC_PROMPTS: LoginCliCue[] = [
  { match: "(paste|enter)[^\\n]{0,60}\\b(code|token)\\b[^\\n]{0,40}[:>]\\s*$", field: LOGIN_FIELD_CODE },
  { match: "(paste|enter)[^\\n]{0,60}\\bapi[ -]?key\\b[^\\n]{0,40}[:>]\\s*$", field: LOGIN_FIELD_API_KEY },
];
const GENERIC_USER_CODE = "\\b(?:code|enter)[^\\n]{0,40}?\\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\\b";
const GENERIC_FAILURE = ["\\b(login|authentication|authorization) (failed|error|denied)\\b", "\\binvalid (code|token|api key)\\b"];
const AGY_AUTH_URL = `(?:Authentication required\\. Please visit the URL to log in:\\s*)?${GENERIC_URL}`;
const AGY_CODE_PROMPT: LoginCliCue = {
  match: "(?:Or,\\s*)?paste the authorization code here and press Enter:\\s*$",
  field: LOGIN_FIELD_CODE,
};
const AGY_FAILURE = ["\\bauthentication (?:failed or )?timed out\\b"];

export const ACCOUNT_RECIPES: Readonly<Record<string, IdentityRecipe>> = {
  claude: {
    // With CLAUDE_CONFIG_DIR set, all three live inside the config dir. On
    // macOS the OAuth credential itself is the Keychain item for the home
    // (see daemon keychain.ts); the vault keeps it as .credentials.json.
    credentialFiles: [".credentials.json", ".claude.json", "settings.json"],
    // Without CLAUDE_CONFIG_DIR the machine keeps `.claude.json` at $HOME
    // (the rest under ~/.claude); on macOS the credential itself is the
    // Keychain item for ~/.claude, which the daemon's import reads directly.
    vendorHome: { dir: ".claude", relocated: { ".claude.json": { path: "{HOME}/.claude.json", unsetOnly: true } } },
    // Claude Code 2.1.x exposes this directly. Starting the auth flow avoids
    // relying on a correctly-timed `/login` keystroke after TUI boot.
    login: { command: "claude", args: ["auth", "login"] },
    loginFlow: {
      defaultMethodId: "claude-oauth",
      methods: [
        {
          id: "claude-oauth",
          kind: "browser_code",
          label: "Sign in with Claude",
          description: "Approve access in your browser, then paste the code it shows you.",
          remoteCapable: true,
          fields: [LOGIN_FIELD_CODE],
          run: { mode: "direct", runner: "claude_oauth" },
        },
      ],
    },
  },
  codex: {
    credentialFiles: ["auth.json"],
    // Keep the legacy mirror for older Codex auth discovery, but do not set
    // HOME: developer tools inside Codex must see the user's real home.
    activationMirrors: { "auth.json": ".codex/auth.json" },
    configFiles: ["config.toml"],
    vendorHome: { dir: ".codex" },
    login: { command: "codex", args: ["login"] },
    loginFlow: {
      defaultMethodId: "codex-browser",
      remoteDefaultMethodId: "codex-device",
      methods: [
        {
          id: "codex-browser",
          kind: "browser",
          label: "Sign in with ChatGPT",
          description: "Approve access in your browser; Codex finishes the sign-in on this computer.",
          // `codex login` listens on localhost:1455 for the callback — the browser must run on the node.
          remoteCapable: false,
          fields: [],
          run: {
            mode: "cli",
            cli: {
              tty: false,
              env: { BROWSER: "true" },
              cues: { url: GENERIC_URL, prompts: [], failure: GENERIC_FAILURE },
              landing: "home_mtime",
            },
          },
        },
        {
          id: "codex-device",
          kind: "device_code",
          label: "Sign in with a device code",
          description: "Open the sign-in page anywhere and enter the code shown here.",
          remoteCapable: true,
          fields: [],
          run: {
            mode: "cli",
            cli: {
              command: { command: "codex", args: ["login", "--device-auth"] },
              tty: false,
              env: { BROWSER: "true" },
              cues: { url: GENERIC_URL, userCode: GENERIC_USER_CODE, prompts: [], failure: GENERIC_FAILURE },
              landing: "home_mtime",
            },
          },
        },
        {
          id: "codex-api-key",
          kind: "api_key",
          label: "Use an OpenAI API key",
          description: "Paste an OpenAI API key; it is checked against the API before it is saved.",
          remoteCapable: true,
          fields: [{ ...LOGIN_FIELD_API_KEY, help: "Stored only in this account's Codex auth file." }],
          run: { mode: "direct", runner: "codex_api_key" },
        },
      ],
    },
  },
  opencode: {
    // opencode keeps auth under $XDG_DATA_HOME/opencode/auth.json; the
    // activated home carries a private xdg-data/ subtree for it.
    credentialFiles: ["xdg-data/opencode/auth.json"],
    // Non-secret provider options (base URL / headers) live in the account's
    // own opencode.json (OPENCODE_CONFIG_DIR = the account home).
    configFiles: ["opencode.json"],
    extraEnv: { XDG_DATA_HOME: "{home}/xdg-data" },
    // The machine's opencode keeps its auth store under XDG data, never in
    // OPENCODE_CONFIG_DIR — the account home's private xdg-data/ mirrors it.
    vendorHome: { dir: ".config/opencode", relocated: { "xdg-data/opencode/auth.json": { path: "{XDG_DATA_HOME}/opencode/auth.json" } } },
    login: { command: "opencode", args: ["auth", "login"] },
    loginFlow: {
      defaultMethodId: "opencode-api-key",
      methods: [
        {
          id: "opencode-api-key",
          kind: "credential_fields",
          label: "Use a provider API key",
          description: "Pick the provider and paste its API key. OpenCode stores it in this account's auth store.",
          remoteCapable: true,
          fields: opencodeFields(),
          run: { mode: "direct", runner: "opencode_api_key" },
        },
      ],
    },
  },
  grok: {
    credentialFiles: ["auth.json"],
    configFiles: ["config.toml"],
    vendorHome: { dir: ".grok" },
    login: { command: "grok", args: [] },
    loginFlow: {
      defaultMethodId: "grok-cli",
      methods: [
        {
          id: "grok-cli",
          kind: "browser_code",
          label: "Sign in with Grok",
          description: "Approve access in your browser; paste back a code if Grok asks for one.",
          remoteCapable: true,
          fields: [],
          run: {
            mode: "cli",
            cli: {
              tty: true,
              env: { BROWSER: "true" },
              cues: { url: GENERIC_URL, userCode: GENERIC_USER_CODE, prompts: GENERIC_PROMPTS, failure: GENERIC_FAILURE },
              landing: "home_mtime",
            },
          },
        },
      ],
    },
  },
  kimi: {
    credentialFiles: ["credentials/kimi-code.json"],
    configFiles: ["config.toml", "tui.toml"],
    vendorHome: { dir: ".kimi" },
    login: { command: "kimi", args: [] },
    loginFlow: {
      defaultMethodId: "kimi-cli",
      methods: [
        {
          id: "kimi-cli",
          kind: "browser_code",
          label: "Sign in with Kimi",
          description: "Approve access in your browser; enter the code Kimi shows if it asks for one.",
          remoteCapable: true,
          fields: [],
          run: {
            mode: "cli",
            cli: {
              tty: true,
              env: { BROWSER: "true" },
              cues: { url: GENERIC_URL, userCode: GENERIC_USER_CODE, prompts: GENERIC_PROMPTS, failure: GENERIC_FAILURE },
              landing: "home_mtime",
            },
          },
        },
      ],
    },
  },
  agy: {
    credentialFiles: [".gemini/antigravity-cli/antigravity-oauth-token"],
    configFiles: [".gemini/antigravity/antigravity_state.pbtxt"],
    extraEnv: { HOME: "{home}" },
    vendorHome: {
      dir: ".gemini",
      relocated: {
        ".gemini/antigravity-cli/antigravity-oauth-token": { path: "{HOME}/.gemini/antigravity-cli/antigravity-oauth-token" },
        ".gemini/antigravity/antigravity_state.pbtxt": { path: "{HOME}/.gemini/antigravity/antigravity_state.pbtxt" },
      },
    },
    login: { command: "agy", args: [] },
    loginFlow: {
      defaultMethodId: "agy-cli",
      methods: [
        {
          id: "agy-cli",
          kind: "browser_code",
          label: "Sign in with agy",
          description: "Approve access in your browser, then paste the authorization code.",
          remoteCapable: true,
          fields: [],
          run: {
            mode: "cli",
            cli: {
              tty: true,
              env: { BROWSER: "true" },
              cues: { url: AGY_AUTH_URL, prompts: [AGY_CODE_PROMPT], failure: AGY_FAILURE },
              landing: "home_mtime",
            },
          },
        },
      ],
    },
  },
  cursor: {
    // cursor-agent's credential store is NOT home-relative (machine-global
    // keychain / $XDG_CONFIG_HOME); the vault keeps a canonical auth.json.
    credentialFiles: ["auth.json", "cli-config.json"],
    // The machine-global credential store (Keychain / global auth.json) is
    // read by the daemon's Cursor bridge; only cli-config.json is home-relative.
    vendorHome: { dir: ".cursor" },
    login: { command: "cursor-agent", args: ["login"] },
    loginFlow: {
      defaultMethodId: "cursor-browser",
      methods: [
        {
          id: "cursor-browser",
          kind: "browser",
          label: "Sign in with Cursor",
          description: "Approve access in your browser; Cursor finishes the sign-in by itself.",
          // cursor-agent polls Cursor's auth session; no loopback callback.
          remoteCapable: true,
          fields: [],
          run: {
            mode: "cli",
            cli: {
              tty: false,
              env: { BROWSER: "true" },
              cues: { url: GENERIC_URL, prompts: [], failure: GENERIC_FAILURE },
              landing: "external_digest",
            },
          },
        },
      ],
    },
  },
};

/** The safe descriptors of a harness's login methods (what a flow row carries); [] for unknown harnesses. */
export function loginMethodsFor(harness: string): LoginMethodDescriptor[] {
  return (ACCOUNT_RECIPES[harness]?.loginFlow.methods ?? []).map(loginMethodDescriptor);
}

/** The recipe method (with its `run`) by id, or undefined. */
export function loginMethodFor(harness: string, methodId: string): (LoginMethodDescriptor & { run: LoginMethodRun }) | undefined {
  return ACCOUNT_RECIPES[harness]?.loginFlow.methods.find((m) => m.id === methodId);
}

/**
 * The method a flow starts with: an explicit choice (validated), else the
 * recipe default — the remote default when the node is remote from the
 * browser. Returns null (typed refusal upstream) when the remote node has no
 * remote-capable method at all.
 */
export function defaultLoginMethodId(harness: string, opts: { remote?: boolean; requested?: string | null } = {}): string | null {
  const recipe = ACCOUNT_RECIPES[harness]?.loginFlow;
  if (!recipe) return null;
  if (opts.requested) {
    const method = recipe.methods.find((m) => m.id === opts.requested);
    if (!method) return null;
    if (opts.remote && !method.remoteCapable) return null;
    return method.id;
  }
  if (opts.remote) {
    const preferred = recipe.remoteDefaultMethodId ?? recipe.defaultMethodId;
    const chosen = recipe.methods.find((m) => m.id === preferred && m.remoteCapable) ?? recipe.methods.find((m) => m.remoteCapable);
    return chosen?.id ?? null;
  }
  return recipe.defaultMethodId;
}

/** The env var that selects a harness's home (CLAUDE_CONFIG_DIR, CODEX_HOME, …); undefined for unknown harnesses. */
export function homeEnvFor(harness: string): string | undefined {
  return HARNESS_HOME_ENV[harness];
}

export function recipeFor(harness: string): IdentityRecipe | undefined {
  return ACCOUNT_RECIPES[harness];
}

/**
 * The machine's real vendor home for a harness and the machine-side path of
 * every recipe file: the home env var when set in `env`, else the recipe's
 * default dir under `home`; relocated files per the recipe. Pure — the
 * caller decides what exists. null for a harness without a recipe.
 */
export function resolveVendorHome(
  harness: string,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): VendorHomeResolution | null {
  const recipe = ACCOUNT_RECIPES[harness];
  if (!recipe) return null;
  const homeEnv = HARNESS_HOME_ENV[harness];
  const fromEnvValue = homeEnv ? env[homeEnv]?.trim() : undefined;
  const fromEnv = fromEnvValue !== undefined && fromEnvValue.length > 0;
  const vendorHome = fromEnv ? (fromEnvValue as string) : joinHome(home, recipe.vendorHome.dir);
  const vars: Record<string, string> = {
    HOME: home,
    VENDOR_HOME: vendorHome,
    XDG_DATA_HOME: env.XDG_DATA_HOME?.trim() || joinHome(home, ".local/share"),
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME?.trim() || joinHome(home, ".config"),
  };
  const expand = (template: string): string => template.replace(/\{(HOME|VENDOR_HOME|XDG_DATA_HOME|XDG_CONFIG_HOME)\}/g, (_, k: string) => vars[k] as string);
  const locate = (rel: string): string => {
    const relocated = recipe.vendorHome.relocated?.[rel];
    if (relocated && (!relocated.unsetOnly || !fromEnv)) return expand(relocated.path);
    return joinHome(vendorHome, rel);
  };
  return {
    harness,
    homeEnv,
    fromEnv,
    vendorHome,
    files: [
      ...recipe.credentialFiles.map((rel): VendorHomeFile => ({ rel, path: locate(rel), role: "credential" })),
      ...(recipe.configFiles ?? []).map((rel): VendorHomeFile => ({ rel, path: locate(rel), role: "config" })),
    ],
  };
}

/** `join` without importing node:path into a data module: `<base>/<rel>` with one separator. */
function joinHome(base: string, rel: string): string {
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

/** The account id for (harness, label): `<harness>-<safe(label)>`, lower-cased — the old registry's rule. */
export function accountIdFor(harness: string, label: string): string {
  return safeName(`${harness}-${label.trim()}`).toLowerCase();
}

/** The old store's safeName (src/store.ts): each byte outside [A-Za-z0-9_.:-] becomes `-` (`tormod@thto.no` → `tormod-thto.no`). */
export function safeName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/g, "-");
  if (/^[.]*$/.test(sanitized)) return sanitized.replace(/[.]/g, "-") || "-";
  return sanitized;
}

/** Recipe extra env with `{home}` expanded (empty for harnesses without extras). */
export function recipeEnvFor(harness: string, homePath: string): Record<string, string> {
  const recipe = ACCOUNT_RECIPES[harness];
  if (!recipe?.extraEnv) return {};
  return Object.fromEntries(Object.entries(recipe.extraEnv).map(([k, v]) => [k, v.replaceAll("{home}", homePath)]));
}
