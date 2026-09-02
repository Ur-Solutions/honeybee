/**
 * Harness CLI argv conventions (per-bee spawn args, schema v4).
 *
 * A bee's final argv is the composition of layers — the agent spec's base
 * args (harness plumbing: `-p --input-format stream-json …`), the node's
 * per-agent default args, the bee's own args (`bees.args`), and the resume
 * selector — with ONE documented precedence rule:
 *
 *   base args < node default args < bee args < resume args
 *
 *   - a valued flag repeated across (or within) layers is de-duplicated: the
 *     LATER occurrence wins and keeps its (later) position; earlier ones are
 *     dropped (`--model opus … --model fable` → one `--model fable`);
 *   - a boolean flag is idempotent: the FIRST occurrence is kept, repeats are
 *     dropped (`--dangerously-skip-permissions` twice → once);
 *   - a keyed flag (`codex -c key=value`) de-duplicates per KEY (later wins);
 *     different keys coexist;
 *   - aliases fold onto their canonical spelling for de-dup only (`-m` and
 *     `--model` are the same flag) — the surviving token keeps its spelling;
 *   - `--flag=value` and `--flag value` are the same flag;
 *   - tokens the grammar does not know (unknown flags, positionals such as
 *     `app-server` or a fake-agent script path) pass through VERBATIM in
 *     place — never re-ordered, never de-duplicated. The grammar is a
 *     conservative allow-list of the flags whose semantics we know.
 *
 * Pure functions; the daemon's resolveSpawnSpec is the one caller.
 */

export interface ArgGrammar {
  /** Flags that take exactly one value (`--model X`, `--model=X`). */
  valueFlags: ReadonlySet<string>;
  /** Flags that take no value. */
  booleanFlags: ReadonlySet<string>;
  /** Flags whose value is `key=value` and that repeat per key (`-c`). */
  keyedFlags: ReadonlySet<string>;
  /** Alias → canonical flag spelling (for de-dup identity). */
  aliases: Readonly<Record<string, string>>;
}

/** One parsed argv unit: a known flag (+ value) or a verbatim token. */
export interface ArgUnit {
  /** The tokens exactly as they will appear in argv. */
  tokens: string[];
  /** De-dup identity: `flag`, `flag:key`, or null (verbatim — never de-duplicated). */
  identity: string | null;
  kind: "value" | "boolean" | "keyed" | "verbatim";
  /** Canonical flag spelling (known units only). */
  flag: string | null;
  /** The value (value/keyed units). */
  value: string | null;
}

function splitEq(token: string): { flag: string; value: string } | null {
  if (!token.startsWith("-")) return null;
  const eq = token.indexOf("=");
  if (eq <= 0) return null;
  return { flag: token.slice(0, eq), value: token.slice(eq + 1) };
}

/** Tokenize argv into units under a grammar. Pure. */
export function parseArgUnits(grammar: ArgGrammar, argv: readonly string[]): ArgUnit[] {
  const canon = (flag: string): string => grammar.aliases[flag] ?? flag;
  const units: ArgUnit[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i] as string;
    const eq = splitEq(tok);
    if (eq) {
      const flag = canon(eq.flag);
      if (grammar.valueFlags.has(flag)) {
        units.push({ tokens: [tok], identity: flag, kind: "value", flag, value: eq.value });
        continue;
      }
      if (grammar.keyedFlags.has(flag)) {
        const key = eq.value.split("=")[0] ?? eq.value;
        units.push({ tokens: [tok], identity: `${flag}:${key}`, kind: "keyed", flag, value: eq.value });
        continue;
      }
      units.push({ tokens: [tok], identity: null, kind: "verbatim", flag: null, value: null });
      continue;
    }
    const flag = canon(tok);
    if (grammar.valueFlags.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined) {
        // dangling valued flag: keep verbatim, let the harness complain
        units.push({ tokens: [tok], identity: null, kind: "verbatim", flag: null, value: null });
        continue;
      }
      units.push({ tokens: [tok, value], identity: flag, kind: "value", flag, value });
      i += 1;
      continue;
    }
    if (grammar.keyedFlags.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined) {
        units.push({ tokens: [tok], identity: null, kind: "verbatim", flag: null, value: null });
        continue;
      }
      const key = value.split("=")[0] ?? value;
      units.push({ tokens: [tok, value], identity: `${flag}:${key}`, kind: "keyed", flag, value });
      i += 1;
      continue;
    }
    if (grammar.booleanFlags.has(flag)) {
      units.push({ tokens: [tok], identity: flag, kind: "boolean", flag, value: null });
      continue;
    }
    units.push({ tokens: [tok], identity: null, kind: "verbatim", flag: null, value: null });
  }
  return units;
}

/**
 * Compose argv layers under the precedence rule above. Layers are given
 * lowest-precedence first. Returns the flat argv.
 */
export function composeArgv(grammar: ArgGrammar, layers: ReadonlyArray<readonly string[] | null | undefined>): string[] {
  const units = layers.flatMap((layer) => parseArgUnits(grammar, layer ?? []));
  return dedupeUnits(units).flatMap((u) => u.tokens);
}

/** The de-dup pass over already-parsed units (exported for the importer's canonicalization). */
export function dedupeUnits(units: readonly ArgUnit[]): ArgUnit[] {
  // valued/keyed: last wins (its position); boolean: first wins.
  const lastIndex = new Map<string, number>();
  const firstIndex = new Map<string, number>();
  units.forEach((u, i) => {
    if (u.identity === null) return;
    if (!firstIndex.has(u.identity)) firstIndex.set(u.identity, i);
    lastIndex.set(u.identity, i);
  });
  return units.filter((u, i) => {
    if (u.identity === null) return true;
    if (u.kind === "boolean") return firstIndex.get(u.identity) === i;
    return lastIndex.get(u.identity) === i;
  });
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

/** `claude` CLI flags the composer knows (the conservative allow-list). */
export const claudeArgGrammar: ArgGrammar = {
  valueFlags: new Set([
    "--model",
    "--effort",
    "--resume",
    "--session-id",
    "--append-system-prompt",
    "--system-prompt",
    "--permission-mode",
    "--input-format",
    "--output-format",
    "--max-turns",
    "--fallback-model",
    "--agent",
    "--settings",
    "--mcp-config",
    "--allowedTools",
    "--disallowedTools",
    "--add-dir",
    "--max-budget-usd",
    "--json-schema",
    "--betas",
  ]),
  booleanFlags: new Set(["-p", "--print", "--verbose", "--dangerously-skip-permissions", "--continue", "-c", "--include-partial-messages", "--replay-user-messages", "--fork-session"]),
  keyedFlags: new Set(),
  aliases: { "-r": "--resume", "-c": "--continue" },
};

// ---------------------------------------------------------------------------
// agy
// ---------------------------------------------------------------------------

/** `agy` print-mode flags the composer knows. */
export const agyArgGrammar: ArgGrammar = {
  valueFlags: new Set([
    "--model",
    "--effort",
    "--conversation",
    "--print-timeout",
    "--agent",
    "--project",
    "--log-file",
    "--add-dir",
    "--mode",
  ]),
  booleanFlags: new Set(["--dangerously-skip-permissions"]),
  keyedFlags: new Set(),
  aliases: {},
};

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

/** `codex` CLI flags the composer knows. `-c key=value` is keyed (per key). */
export const codexArgGrammar: ArgGrammar = {
  valueFlags: new Set(["--model", "--ask-for-approval", "--sandbox", "--profile", "--cd", "--image"]),
  booleanFlags: new Set(["--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--search", "--oss"]),
  keyedFlags: new Set(["--config"]),
  aliases: { "-m": "--model", "-c": "--config", "-a": "--ask-for-approval", "-s": "--sandbox", "-p": "--profile", "-C": "--cd", "-i": "--image" },
};

/** `grok` / `grok agent` flags the composer knows. */
export const grokArgGrammar: ArgGrammar = {
  valueFlags: new Set(["--model", "--effort", "--permission-mode", "--debug-file", "--leader-socket", "--agent-profile"]),
  booleanFlags: new Set(["--no-auto-update", "--no-leader", "--always-approve", "--debug", "--leader"]),
  keyedFlags: new Set(),
  aliases: { "-m": "--model", "--reasoning-effort": "--effort" },
};

/**
 * `grok agent … stdio` only accepts a few flags on the `stdio` subcommand.
 * Model/effort belong on `grok agent` *before* `stdio`. Bee args that
 * compose after `stdio` are lifted in front of it.
 */
export function grokSpawnPlan(argv: readonly string[]): { argv: string[]; model: string | undefined } {
  const before: string[] = [];
  const after: string[] = [];
  const lifted: string[] = [];
  let model: string | undefined;
  let seenStdio = false;
  for (const u of parseArgUnits(grokArgGrammar, argv)) {
    if (u.flag === "--model" && u.value !== null) {
      model = u.value;
      lifted.push("--model", u.value);
      continue;
    }
    if (u.flag === "--effort" && u.value !== null) {
      lifted.push("--effort", u.value);
      continue;
    }
    if (!seenStdio && u.kind === "verbatim" && u.tokens.length === 1 && u.tokens[0] === "stdio") {
      seenStdio = true;
      continue;
    }
    (seenStdio ? after : before).push(...u.tokens);
  }
  return { argv: [...before, ...lifted, ...(seenStdio ? ["stdio"] : []), ...after], model };
}

/**
 * What a composed codex argv means for the v2 codex adapter, which drives
 * `codex app-server` (JSON-RPC) rather than the TUI: the app-server ignores
 * TUI model/approval flags, so they are LIFTED into the thread request —
 *   `-m X` / `--model X`                          → thread/start|resume `model`
 *   `--dangerously-bypass-approvals-and-sandbox`  → approvalPolicy "never" +
 *                                                    sandbox "danger-full-access"
 *                                                    (the adapter's standing
 *                                                    policy; absorbed, no-op)
 *   `--full-auto`, `-a/--ask-for-approval`, `-s/--sandbox` → dropped (the
 *                                                    adapter's policy is fixed)
 * and everything else (`-c key=value` config overrides — root-level codex
 * flags the app-server honours, e.g. `-c model_reasoning_effort="high"` —
 * plus positionals such as `app-server` and unknown tokens) stays on argv.
 */
export function codexSpawnPlan(argv: readonly string[]): { argv: string[]; model: string | undefined; absorbed: string[] } {
  const out: string[] = [];
  const absorbed: string[] = [];
  let model: string | undefined;
  for (const u of parseArgUnits(codexArgGrammar, argv)) {
    if (u.flag === "--model" && u.value !== null) {
      model = u.value;
      absorbed.push(...u.tokens);
      continue;
    }
    if (u.flag === "--dangerously-bypass-approvals-and-sandbox" || u.flag === "--full-auto" || u.flag === "--ask-for-approval" || u.flag === "--sandbox") {
      absorbed.push(...u.tokens);
      continue;
    }
    out.push(...u.tokens);
  }
  return { argv: out, model, absorbed };
}
