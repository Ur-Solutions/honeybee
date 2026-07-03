// `hive account`/activate/login/swap-account/usage/limits — provider account vault.
// Extracted from cli.ts (HIVE-15).
import { accountEmail, accountHasCredentials, accountsRegistryPath, activateAccountIntoHome, addAccount, captureAccountFromHome, defaultHomeForAccount, findAccount, listAccounts, removeAccount, syncAccountCredentialsToVault, syncAllAccountCredentialsToVault, type AccountChainSyncOutcome, type AccountRecord } from "../accounts.js";
import { canonicalAgentKind, resolveAgent, resolveHome } from "../agents.js";
import { parseAge } from "../clean.js";
import { identityEnvForAgent, identityRecipeForAgent, type IdentityRecipe } from "../drivers.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, formatTimeUntil, green, isPretty, note, red, tildify, yellow } from "../format.js";
import { credentialDigest, readClaudeKeychain } from "../keychain.js";
import { cachedAccountLimits, paceDelta, sortAccountsForLimitsDisplay, windowRolledOver, type AccountLimits, type WindowUsage } from "../limits.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { resolveSelector } from "../selectors.js";
import { storeRoot } from "../store.js";
import { localSubstrate } from "../substrates/index.js";
import { swapAccount } from "../swap.js";
import { isRecentlyExhausted, listUsageAccounts, usageSummary } from "../usage.js";
import { clampUsageInterval, runUsageTui } from "../usageTui.js";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { safeTmuxTarget, sleep, ttlFlagMs } from "../cli/shared.js";

export async function cmdAccount(parsed: Parsed) {
  const sub = parsed.args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      await accountList(parsed);
      break;
    case "add": {
      const [, tool, label] = parsed.args;
      if (!tool || !label) throw new Error("Usage: hive account add <tool> <label> [--email <addr>] [--provider <id>] [--model <id>]");
      const email = typeof flag(parsed, "email") === "string" ? String(flag(parsed, "email")) : undefined;
      const provider = typeof flag(parsed, "provider") === "string" ? String(flag(parsed, "provider")) : undefined;
      const model = typeof flag(parsed, "model") === "string" ? String(flag(parsed, "model")) : undefined;
      const account = await addAccount(tool, label, { email, provider, model });
      if (isPretty()) console.log(actionLine("ok", "account", [bold(account.id), account.tool, account.provider ?? "?", account.label]));
      else console.log(`${account.id}\t${account.tool}\t${account.provider ?? ""}\t${account.label}`);
      console.log(note(`vault dir ready; capture credentials with: hive account login ${account.tool} ${account.label}`));
      for (const warning of claudeIdentityWarnings([account])) console.log(warning);
      break;
    }
    case "login": {
      const [, tool, label] = parsed.args;
      if (!tool || !label) throw new Error("Usage: hive account login <tool> <label> [--provider <id>] [--model <id>]");
      const kind = canonicalAgentKind(tool).toLowerCase();
      const accounts = await listAccounts();
      const existing = accounts.find((candidate) => candidate.tool === kind && candidate.label === label.trim());
      // Auto-create path: a CLI with no canonical provider (opencode) makes
      // addAccount throw unless --provider is supplied. Thread the flags so a
      // first-time `account login` of such a CLI can name its provider; for
      // single-provider CLIs (claude/codex/grok/kimi) they default and this is
      // byte-identical to before.
      const provider = typeof flag(parsed, "provider") === "string" ? String(flag(parsed, "provider")) : undefined;
      const model = typeof flag(parsed, "model") === "string" ? String(flag(parsed, "model")) : undefined;
      const account = existing ?? (await addAccount(tool, label, { provider, model }));
      // Before the interactive seat so it isn't buried under login output.
      for (const warning of claudeIdentityWarnings([account])) console.log(warning);
      await runLoginSeat(parsed, account);
      break;
    }
    case "capture": {
      const query = parsed.args[1];
      if (!query) throw new Error("Usage: hive account capture <account> --home <1|2|3|path>");
      const account = await findAccount(query);
      const homeFlag = flag(parsed, "home");
      if (typeof homeFlag !== "string") throw new Error("--home <1|2|3|path> is required: which home should credentials be captured from?");
      const homePath = resolveHome(account.tool, homeFlag);
      const captured = await captureAccountFromHome(account, homePath);
      if (isPretty()) console.log(actionLine("ok", "capture", [bold(account.id), dim(tildify(homePath)), `${captured.length} file(s)`]));
      else console.log(`captured\t${account.id}\t${homePath}\t${captured.join(",")}`);
      break;
    }
    case "remove":
    case "rm": {
      const query = parsed.args[1];
      if (!query) throw new Error("Usage: hive account remove <account>");
      const account = await removeAccount(query);
      if (isPretty()) console.log(actionLine("ok", "remove", [bold(account.id)]));
      else console.log(`removed\t${account.id}`);
      break;
    }
    case "sync": {
      // Pull rotated/refreshed credentials from account homes back into the
      // vault. Claude rotates OAuth chains; Codex rewrites auth.json on token
      // refresh. One account when named, otherwise every supported account.
      const query = parsed.args[1];
      const outcomes: AccountChainSyncOutcome[] = query
        ? await (async () => {
            const account = await findAccount(query);
            if (!identityRecipeForAgent(account.tool)) {
              throw new Error(`credential sync only applies to accounts with identity recipes; ${account.id} is ${account.tool}`);
            }
            const result = await syncAccountCredentialsToVault(account);
            return [{ account: account.id, vaultUpdated: result.vaultUpdated }];
          })()
        : await syncAllAccountCredentialsToVault();
      for (const outcome of outcomes) {
        const state = outcome.error ? red(`error: ${outcome.error}`) : outcome.vaultUpdated ? green("vault updated") : dim("already fresh");
        if (isPretty()) console.log(actionLine(outcome.error ? "warn" : "ok", "sync", [bold(outcome.account), state]));
        else console.log(`synced\t${outcome.account}\t${outcome.error ?? (outcome.vaultUpdated ? "updated" : "fresh")}`);
      }
      if (outcomes.length === 0) console.log(note("no accounts with identity recipes registered; nothing to sync"));
      break;
    }
    default:
      throw new Error(`Unknown account subcommand: ${sub}. Use: list|add|login|capture|sync|remove`);
  }
}


export async function accountList(parsed: Parsed) {
  const accounts = await listAccounts();
  const now = Date.now();
  const json = truthy(flag(parsed, "json"));
  const accountRows = await Promise.all(accounts.map(async (account) => {
    const [summary, hasCreds] = await Promise.all([
      usageSummary(account.id, now),
      accountHasCredentials(account),
    ]);
    const exhausted = isRecentlyExhausted(summary, now);
    if (json) {
      return {
        json: { ...account, credentials: hasCreds, exhausted, lastExhaustedAt: summary.lastExhaustedAt ?? null, resetHint: summary.lastResetHint ?? null },
        row: null,
      };
    }
    const state = !hasCreds ? yellow("no-creds") : exhausted ? red("exhausted") : green("ok");
    return {
      json: null,
      row: [
        account.id,
        account.tool,
        account.provider ?? "-",
        account.label,
        isPretty() ? state : !hasCreds ? "no-creds" : exhausted ? "exhausted" : "ok",
        summary.lastExhaustedAt ? formatRelativeTime(summary.lastExhaustedAt) : "-",
        summary.lastResetHint ?? "-",
      ],
    };
  }));
  if (json) {
    console.log(JSON.stringify(accountRows.map((entry) => entry.json), null, 2));
    return;
  }
  const rows = accountRows.map((entry) => entry.row).filter((row): row is string[] => row !== null);
  if (rows.length === 0) {
    console.log(note("no accounts registered; add one with: hive account add <tool> <label>"));
    return;
  }
  console.log(formatTable(
    [{ header: "ACCOUNT" }, { header: "TOOL" }, { header: "PROVIDER" }, { header: "LABEL" }, { header: "STATE" }, { header: "EXHAUSTED" }, { header: "RESET" }],
    rows,
  ));
}


// Interactive (re)login seat: a scratch home + the tool's own login flow in a
// detached tmux session; once credential files land we capture them into the
// vault and tear the seat down.
export async function runLoginSeat(parsed: Parsed, account: AccountRecord) {
  const recipe = identityRecipeForAgent(account.tool);
  if (!recipe) throw new Error(`Tool ${account.tool} has no identity recipe`);
  // Capture must gate on the PRIMARY credential: tools write supporting files
  // (claude's .claude.json) the moment they boot, long before any login.
  const primary = recipe.credentialFiles[0]!;
  const seatHome = resolve(storeRoot(), "login-homes", account.id);
  await mkdir(seatHome, { recursive: true, mode: 0o700 });
  const target = safeTmuxTarget(`login-${account.id}`);
  const substrate = localSubstrate();
  const markerPath = resolve(seatHome, ".login-seat-started");

  if (!(await substrate.hasSession(target))) {
    if (recipe.seedLoginSeat === false) {
      // The tool's sign-in flow only triggers when the primary credential is
      // absent; the seat home persists across attempts, so stale creds from a
      // previous seat must go too.
      await clearSeatCredentials(recipe, seatHome);
    } else if (await accountHasCredentials(account)) {
      // Re-login starts from the existing creds when we have them.
      await activateAccountIntoHome(account, seatHome).catch(() => undefined);
    }
    // The marker is the freshness baseline: its mtime for the credentials
    // file, its recorded digest for the keychain entry (claude on macOS logs
    // in to the Keychain, not the file). Written post-activation so re-seeded
    // old creds stay stale.
    const keychainBaseline = account.tool === "claude" ? await readClaudeKeychain(seatHome) : null;
    const marker = { account: account.id, keychainDigest: keychainBaseline ? credentialDigest(keychainBaseline) : null };
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    const spec = resolveAgent(account.tool, [], { home: seatHome, identity: true, yolo: false });
    await substrate.newSession(target, process.cwd(), {
      command: spec.command,
      args: spec.args,
      env: spec.env,
      tmuxOptions: spec.tmuxOptions,
    });
  } else {
    // A seat from a previous attempt is still up — rejoin it.
    console.log(note(`rejoining the running login seat for ${account.id}`));
  }

  const attachHint = `tmux attach -t ${target}`;
  if (isPretty()) console.log(actionLine("ok", "login-seat", [bold(account.id), dim(attachHint)]));
  else console.log(`login-seat\t${account.id}\t${target}`);

  if (truthy(flag(parsed, "no-wait"))) {
    console.log(note(`complete the ${account.tool} login in the seat (${attachHint}), then run: hive account capture ${account.id} --home ${seatHome}`));
    return;
  }

  const baselineMs = (await stat(markerPath).catch(() => null))?.mtimeMs ?? Date.now();
  const baselineDigest = await readMarkerKeychainDigest(markerPath);
  const loggedIn = async (): Promise<boolean> => {
    const info = await stat(resolve(seatHome, primary)).catch(() => null);
    if (info?.isFile() && info.mtimeMs >= baselineMs) return true;
    if (account.tool !== "claude") return false;
    // claude on macOS logs in to the Keychain, not the credentials file.
    const current = await readClaudeKeychain(seatHome);
    return Boolean(current) && credentialDigest(current!) !== baselineDigest;
  };
  const captureIfLoggedIn = async (): Promise<boolean> => {
    if (!(await loggedIn())) return false;
    const captured = await captureAccountFromHome(account, seatHome);
    await substrate.kill(target).catch(() => undefined);
    if (isPretty()) console.log(actionLine("ok", "capture", [bold(account.id), `${captured.length} file(s)`]));
    else console.log(`captured\t${account.id}\t${captured.join(",")}`);
    return true;
  };

  // Interactive: put the user in the seat; capture when they detach or the
  // tool exits. Inside an existing tmux client attach would nest — fall back
  // to the headless poll loop there.
  if (process.stdout.isTTY && process.stdin.isTTY && !process.env.TMUX) {
    console.log(note(`complete the ${account.tool} login, then detach (ctrl-b d) or quit the tool`));
    try {
      await substrate.attachSession(target);
    } catch {
      // attach failed (no client?); fall through to polling
    }
    if (await captureIfLoggedIn()) return;
    if (await substrate.hasSession(target)) {
      throw new Error(`Login not completed (no fresh credentials in ${primary} or the keychain); the seat is still running — rerun hive login ${account.id} or ${attachHint}`);
    }
    throw new Error(`Login seat exited without producing ${primary}; rerun: hive login ${account.id}`);
  }

  console.log(note(`complete the ${account.tool} login in the seat (${attachHint}); waiting for ${primary}`));
  const timeoutMs = numberFlag(parsed, ["timeout-ms", "timeout"], 600_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await captureIfLoggedIn()) return;
    if (!(await substrate.hasSession(target))) {
      throw new Error(`Login seat exited without producing ${primary}; rerun: hive login ${account.id}`);
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${primary} in ${seatHome}; the seat is still running — ${attachHint}`);
}


export async function clearSeatCredentials(recipe: IdentityRecipe, seatHome: string): Promise<void> {
  const files = [...recipe.credentialFiles, ...Object.values(recipe.activationMirrors ?? {})];
  for (const file of files) {
    await rm(resolve(seatHome, file), { force: true });
  }
}


export async function readMarkerKeychainDigest(markerPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { keychainDigest?: unknown };
    return typeof parsed.keychainDigest === "string" ? parsed.keychainDigest : null;
  } catch {
    // Pre-keychain marker format (plain text) — no baseline recorded.
    return null;
  }
}


export async function cmdActivate(parsed: Parsed) {
  const query = parsed.args[0];
  if (!query) throw new Error("Usage: hive activate <account> [--home <1|2|3|path>]");
  const account = await findAccount(query);
  const homeFlag = flag(parsed, "home");
  const homePath = typeof homeFlag === "string" ? resolveHome(account.tool, homeFlag) : defaultHomeForAccount(account);
  const written = await activateAccountIntoHome(account, homePath, { onWarn: (message) => console.error(note(message)) });
  if (isPretty()) console.log(actionLine("ok", "activate", [bold(account.id), dim(tildify(homePath)), `${written.length} file(s)`]));
  else console.log(`activated\t${account.id}\t${homePath}\t${written.join(",")}`);
  const identityEnv = identityEnvForAgent(account.tool, homePath);
  const envHint = Object.entries(identityEnv).map(([key, value]) => `${key}=${value}`).join(" ");
  console.log(note(`spawn with: hive spawn ${account.tool} --home ${homePath}${envHint ? ` (identity env: ${envHint})` : ""}`));
}


export async function cmdLogin(parsed: Parsed) {
  const query = parsed.args[0];
  if (!query) throw new Error("Usage: hive login <account> [--no-wait] [--popup]");
  const account = await findAccount(query);
  if (truthy(flag(parsed, "popup"))) {
    // The mesh tmux binding wraps this in display-popup; print the canonical form.
    console.log(`tmux display-popup -E "hive login ${account.id}"`);
    return;
  }
  await runLoginSeat(parsed, account);
}


export async function cmdSwapAccount(parsed: Parsed) {
  const [beeQuery, accountQuery] = parsed.args;
  if (!beeQuery || !accountQuery) throw new Error("Usage: hive swap-account <bee> <account>");
  const target = await resolveSelector(beeQuery);
  if (target.kind !== "bee") throw new Error("swap-account targets a single bee");
  const record = target.record;
  const account = await findAccount(accountQuery, record.agent);
  const updated = await swapAccount(record, account);
  if (isPretty()) console.log(actionLine("ok", "swap", [bold(updated.name), `${record.accountId ?? "unbound"} → ${account.id}`, dim(updated.providerSessionId ?? "fresh session")]));
  else console.log(`swapped\t${updated.name}\t${account.id}`);
}


export async function cmdUsageSamples(parsed: Parsed) {
  const query = parsed.args[0];
  const now = Date.now();
  const accounts = await listAccounts();
  const ids = query
    ? [(await findAccount(query)).id]
    : [...new Set([...accounts.map((account) => account.id), ...(await listUsageAccounts())])];

  const summaries = await Promise.all(ids.map((id) => usageSummary(id, now)));

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }
  if (summaries.length === 0) {
    console.log(note("no usage recorded; usage accrues for account-bound bees (hive spawn <tool> --account <a>)"));
    return;
  }
  const rows = summaries.map((summary) => {
    const exhausted = isRecentlyExhausted(summary, now);
    return [
      summary.account,
      `${formatTokens(summary.windowInputTokens)}/${formatTokens(summary.windowOutputTokens)}`,
      summary.lastSample ? formatRelativeTime(summary.lastSample.ts) : "-",
      summary.lastExhaustedAt ? formatRelativeTime(summary.lastExhaustedAt) : "-",
      isPretty() ? (exhausted ? red("exhausted") : green("ok")) : exhausted ? "exhausted" : "ok",
      summary.lastResetHint ?? "-",
    ];
  });
  console.log(formatTable(
    [{ header: "ACCOUNT" }, { header: "5H IN/OUT" }, { header: "SAMPLED" }, { header: "EXHAUSTED" }, { header: "STATE" }, { header: "RESET" }],
    rows,
  ));
  console.log(note("token sums are directional estimates from transcripts, not authoritative quota"));
}


export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}


// `hive limits`: progress against the providers' REAL 5h/weekly windows.
// claude is queried live (the same endpoint as Claude Code's /usage panel);
// codex is the newest rate_limits snapshot its CLI wrote to disk (stamped).
export async function cmdLimits(parsed: Parsed) {
  const query = parsed.args[0];
  const accounts = query ? [await findAccount(query)] : sortAccountsForLimitsDisplay(await listAccounts());
  if (accounts.length === 0) {
    console.log(note("no accounts registered; add some with: hive account add <tool> <label> && hive login <account>"));
    return;
  }
  // Live reads refresh the on-disk cache; --ttl serves entries younger than
  // the given age instead of paying the provider round-trips.
  const ttlMs = ttlFlagMs(parsed);
  const live = wantsUsageLive(parsed);
  if (live && truthy(flag(parsed, "json"))) throw new Error("--live is interactive; drop --json");

  // --live: an auto-refreshing full-screen dashboard. Needs a real TTY on both
  // ends; without one we fall through to the static table plus a note. Enter
  // BEFORE the eager sweep below — the dashboard does its own seed-then-live
  // reads, and paying an extra full live sweep per launch is how pollers get
  // rate-limited. The dashboard's ttl-less live reads keep the shared limits
  // cache warm for `hive spawn --account auto`.
  if (live && process.stdout.isTTY && process.stdin.isTTY) {
    const intervalMs = usageIntervalFlagMs(parsed);
    await runUsageTui({
      // Instant first paint from a generous cache read, then straight to live.
      seedLimits: () => cachedAccountLimits(accounts, { ttlMs: 24 * 60 * 60 * 1000 }),
      fetchLimits: () => cachedAccountLimits(accounts, {}),
      warnings: claudeIdentityWarnings(accounts),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
    });
    return;
  }

  const results = await cachedAccountLimits(accounts, ttlMs !== undefined ? { ttlMs } : {});

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const rows = results.map((result) => [
    result.account,
    result.plan ?? "-",
    limitCell(result.fiveHour, result),
    limitCell(result.weekly, result),
    terseLimitCell(result.fableWeekly, result),
    result.cached ? `cache ${formatRelativeTime(result.asOf)}` : result.asOf ? formatRelativeTime(result.asOf) : result.ok ? "live" : "-",
  ]);
  console.log(formatTable(
    [{ header: "ACCOUNT" }, { header: "PLAN" }, { header: "5H" }, { header: "WEEKLY" }, { header: "FABLE" }, { header: "AS-OF" }],
    rows,
  ));
  for (const result of results.filter((candidate) => !candidate.ok)) {
    console.log(note(`${result.account}: ${result.error}`));
  }
  for (const warning of claudeIdentityWarnings(accounts)) console.log(warning);
  console.log(note("pace = used% − elapsed% of the window: ▲ burning faster than it refills, ▼ headroom, ● on pace"));
  if (live) console.log(note("--live needs a TTY; printed once"));
}


/** True when any of the live-dashboard flag spellings is present. */
export function wantsUsageLive(parsed: Parsed): boolean {
  return truthy(flag(parsed, "live")) || truthy(flag(parsed, "dashboard")) || truthy(flag(parsed, "follow")) || truthy(flag(parsed, "f"));
}


/**
 * Loud warnings for claude accounts with no resolvable email. Every identity
 * guard — profile verification of candidate tokens, imposter parking, vault
 * mirroring, foreign-chain evacuation — keys off the account email, so an
 * email-less account silently reads (and can be overwritten by) ANOTHER
 * account's credentials. That state looks healthy right up until two accounts
 * swap identities, hence loud.
 */
export function claudeIdentityWarnings(accounts: AccountRecord[]): string[] {
  return accounts
    .filter((account) => account.tool === "claude" && !accountEmail(account))
    .map((account) => {
      const text = `⚠ ${account.id}: no email on record — identity checks DISABLED; usage may show another account's data and its vault can be overwritten. Fix: add "email": "<addr>" to this account in ${tildify(accountsRegistryPath())}`;
      return isPretty() ? bold(red(text)) : text;
    });
}


/**
 * `--interval <dur>` for `hive usage --live`: same duration grammar as `--ttl`
 * (30s, 5m). Undefined when absent so the TUI keeps its 60s default; clamped to
 * a 10s floor by the TUI so it can never hammer provider endpoints.
 */
export function usageIntervalFlagMs(parsed: Parsed): number | undefined {
  const raw = flag(parsed, "interval");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("--interval needs a duration (e.g. 30s, 5m)");
  return clampUsageInterval(parseAge(raw));
}


export function limitCell(window: WindowUsage | undefined, result: AccountLimits): string {
  if (!result.ok || !window) return "-";
  const now = Date.now();
  // A snapshot whose reset boundary has passed describes a window that has
  // already rolled over: it's fresh (0%) and nothing is pending a reset.
  if (windowRolledOver(window, now)) {
    return `${limitBar(0)}   0%`;
  }
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const pace = paceDelta(window, now);
  const paceSuffix = pace === null ? "" : ` ${formatPace(pace)}`;
  const reset = window.resetsAt ? ` ⟳ ${formatTimeUntil(window.resetsAt)}` : "";
  return `${limitBar(percent)} ${String(Math.round(percent)).padStart(3)}%${reset}${paceSuffix}`;
}


/** Bar-less cell for narrow columns (Fable included usage): `42% ⟳ 3d`. */
export function terseLimitCell(window: WindowUsage | undefined, result: AccountLimits): string {
  if (!result.ok || !window) return "-";
  if (windowRolledOver(window)) return "0%";
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const text = `${Math.round(percent)}%`;
  const colored = !isPretty() ? text : percent >= 90 ? red(text) : percent >= 70 ? yellow(text) : green(text);
  return window.resetsAt ? `${colored} ⟳ ${formatTimeUntil(window.resetsAt)}` : colored;
}


export function formatPace(delta: number): string {
  const rounded = Math.round(delta);
  if (Math.abs(rounded) <= 2) return isPretty() ? dim("●") : "=0";
  const label = rounded > 0 ? `▲+${rounded}` : `▼${rounded}`;
  if (!isPretty()) return rounded > 0 ? `+${rounded}` : `${rounded}`;
  if (rounded > 0) return rounded >= 15 ? red(label) : yellow(label);
  return green(label);
}


export function limitBar(percent: number): string {
  const width = 10;
  const filled = Math.round((percent / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  if (!isPretty()) return bar;
  if (percent >= 90) return red(bar);
  if (percent >= 70) return yellow(bar);
  return green(bar);
}
