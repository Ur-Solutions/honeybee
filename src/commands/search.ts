// `hive search` / `hive seals` — search seals, ledger, and session records.
// Extracted from cli.ts (HIVE-15).
import { parseAge } from "../clean.js";
import { loadColony } from "../colony.js";
import { bold, cyan, dim, formatRelativeTime, green, isPretty, magenta, note, tildify, yellow } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { search, type SearchHit, type SearchOptions, type SearchTypeFilter } from "../search.js";

export async function cmdSearch(parsed: Parsed) {
  const options = await buildSearchOptions(parsed);
  await runSearch(parsed, options, "search");
}


export async function cmdSeals(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case "find": {
      // Strip the leading "find" and re-parse args[1] as the query. We keep
      // any --status/--colony/--bee flags but reject --type (the seals noun is
      // already a corpus restriction; mixing it with --type leads to surprise).
      if (parsed.flags.has("type")) {
        throw new Error("hive seals find ignores --type; the seals noun already restricts the corpus. Use 'hive search' for cross-corpus queries.");
      }
      const subParsed: Parsed = {
        command: "seals find",
        args: parsed.args.slice(1),
        flags: parsed.flags,
        rest: parsed.rest,
      };
      const options = await buildSearchOptions(subParsed);
      // Force corpus to seals only — the seals noun is the discoverability hook
      // for users who already know they want seals.
      options.types = new Set(["seals"]);
      await runSearch(subParsed, options, "seals find");
      return;
    }
    default:
      throw new Error(`Unknown seals subcommand: ${sub ?? "(none)"}\nUsage: hive seals find <query> [--status done] [--colony X] [--bee X] [--regex] [--case] [--since 7d] [--limit N] [--json]`);
  }
}


export async function buildSearchOptions(parsed: Parsed): Promise<SearchOptions> {
  const query = parsed.args[0];
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Usage: hive search <query> [--colony X] [--swarm X] [--bee X] [--type seals,ledger,sessions] [--status done] [--since 7d] [--regex] [--case] [--limit N] [--json]");
  }

  const limit = (() => {
    const raw = flag(parsed, "limit");
    if (raw === undefined) return 30;
    if (raw === true) throw new Error("--limit requires a number (use 0 for unlimited)");
    const parsedNum = Number(raw);
    if (!Number.isFinite(parsedNum) || parsedNum < 0) throw new Error(`Invalid --limit: ${String(raw)}`);
    return Math.floor(parsedNum);
  })();

  const types = parseTypeFilter(flag(parsed, "type"));
  const colony = typeof flag(parsed, "colony") === "string" ? String(flag(parsed, "colony")) : undefined;
  if (colony) {
    const record = await loadColony(colony);
    if (!record) throw new Error(`Unknown colony: ${colony}`);
  }
  const swarm = typeof flag(parsed, "swarm") === "string" ? String(flag(parsed, "swarm")).replace(/^@/, "") : undefined;
  const beeRaw = typeof flag(parsed, "bee") === "string" ? String(flag(parsed, "bee")) : undefined;
  if (beeRaw && (beeRaw.startsWith("@") || beeRaw.startsWith("colony:"))) {
    throw new Error(`--bee accepts only a bee name or id selector (got ${beeRaw}). Use --colony or --swarm for cohort filters.`);
  }
  const status = typeof flag(parsed, "status") === "string" ? String(flag(parsed, "status")) : undefined;

  const sinceMs = (() => {
    const raw = flag(parsed, "since");
    if (raw === undefined) return undefined;
    if (raw === true) throw new Error("--since requires a duration like 7d, 24h, 30m");
    const ageMs = parseAge(String(raw));
    return Date.now() - ageMs;
  })();

  return {
    query,
    limit,
    caseSensitive: truthy(flag(parsed, "case")),
    regex: truthy(flag(parsed, "regex")),
    ...(colony ? { colony } : {}),
    ...(swarm ? { swarm } : {}),
    ...(beeRaw ? { bee: beeRaw } : {}),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(status ? { status } : {}),
    ...(types ? { types } : {}),
  };
}


export function parseTypeFilter(raw: string | true | string[] | undefined): Set<SearchTypeFilter> | undefined {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("--type requires a value (e.g. --type seals,ledger,sessions)");
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const set = new Set<SearchTypeFilter>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed !== "seals" && trimmed !== "ledger" && trimmed !== "sessions") {
      throw new Error(`Invalid --type value: ${trimmed}. Use one or more of: seals, ledger, sessions.`);
    }
    set.add(trimmed);
  }
  if (set.size === 0) throw new Error("--type requires at least one value (seals|ledger|sessions)");
  return set;
}


export async function runSearch(parsed: Parsed, options: SearchOptions, verb: string): Promise<void> {
  const result = await search(options);
  const json = truthy(flag(parsed, "json"));
  if (json) {
    console.log(JSON.stringify({
      query: options.query,
      hits: result.hits.map((hit) => ({
        type: hit.type,
        path: hit.path,
        ...(hit.beeName ? { beeName: hit.beeName } : {}),
        snippet: hit.snippet,
        matchStartInSnippet: hit.matchStartInSnippet,
        matchEndInSnippet: hit.matchEndInSnippet,
        score: hit.score,
        matchedAt: hit.matchedAt,
      })),
      truncated: result.truncated,
    }, null, 2));
    return;
  }
  if (result.hits.length === 0) {
    if (isPretty()) console.log(dim(`no hits for ${JSON.stringify(options.query)}`));
    else console.log(`# no hits for ${options.query}`);
    return;
  }
  if (!isPretty()) {
    for (const hit of result.hits) {
      console.log(`${hit.type}\t${hit.matchedAt}\t${hit.beeName ?? "-"}\t${hit.path}\t${hit.snippet}`);
    }
    if (result.truncated) console.error(`# more results truncated; raise --limit (0 = unlimited)`);
    return;
  }
  for (const hit of result.hits) {
    console.log(formatHitPretty(hit));
  }
  if (result.truncated) console.error(note(`more results truncated; raise --limit (0 = unlimited)`));
  // Avoid an unused-variable warning when the verb isn't surfaced in pretty mode.
  void verb;
}


export function formatHitPretty(hit: SearchHit): string {
  const head = `${corpusBadge(hit.type)}  ${bold(hit.beeName ?? "-")}  ${dim(formatRelativeTime(hit.matchedAt))}`;
  const path = dim(tildify(hit.path));
  const snippet = highlightSnippet(hit.snippet, hit.matchStartInSnippet, hit.matchEndInSnippet);
  return `${head}\n  ${snippet}\n  ${path}`;
}


export function corpusBadge(type: SearchHit["type"]): string {
  switch (type) {
    case "seal":
      return magenta("seal");
    case "ledger":
      return cyan("ledger");
    case "session":
      return green("session");
  }
}


export function highlightSnippet(snippet: string, start: number, end: number): string {
  if (start < 0 || end <= start || end > snippet.length) return snippet;
  const before = snippet.slice(0, start);
  const match = snippet.slice(start, end);
  const after = snippet.slice(end);
  return `${before}${bold(yellow(match))}${after}`;
}
