/**
 * The account fields needed to resolve an operator-typed selector. Keeping the
 * matcher generic lets the daemon use authoritative AccountRows while the
 * CLI's daemon-down read path applies the exact same semantics to mirror rows.
 */
export interface AccountMatchCandidate {
  id: string;
  harness: string;
  label: string;
}

export type AccountMatchKind = "id" | "label" | "substring";

export type AccountMatchResult<T extends AccountMatchCandidate> =
  | { ok: true; account: T; kind: AccountMatchKind; scopedHarness: string | null }
  | { ok: false; reason: "not_found"; matches: []; scopedHarness: string | null }
  | { ok: false; reason: "ambiguous"; matches: T[]; scopedHarness: string | null };

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function matchInPool<T extends AccountMatchCandidate>(
  accounts: readonly T[],
  query: string,
  scopedHarness: string | null,
): AccountMatchResult<T> {
  const raw = query.trim();
  const needle = normalized(raw);
  if (needle.length === 0) return { ok: false, reason: "not_found", matches: [], scopedHarness };

  // IDs are the stable identity and therefore outrank a label that happens to
  // equal another account's id. Preserve a unique result at every tier; never
  // let registration order decide an ambiguous operator request.
  const exactIds = accounts.filter((account) => normalized(account.id) === needle);
  if (exactIds.length === 1) return { ok: true, account: exactIds[0]!, kind: "id", scopedHarness };
  if (exactIds.length > 1) return { ok: false, reason: "ambiguous", matches: exactIds, scopedHarness };

  const exactLabels = accounts.filter((account) => normalized(account.label) === needle);
  if (exactLabels.length === 1) return { ok: true, account: exactLabels[0]!, kind: "label", scopedHarness };
  if (exactLabels.length > 1) return { ok: false, reason: "ambiguous", matches: exactLabels, scopedHarness };

  const partial = accounts.filter((account) =>
    normalized(account.id).includes(needle) || normalized(account.label).includes(needle)
  );
  if (partial.length === 1) return { ok: true, account: partial[0]!, kind: "substring", scopedHarness };
  if (partial.length > 1) return { ok: false, reason: "ambiguous", matches: partial, scopedHarness };
  return { ok: false, reason: "not_found", matches: [], scopedHarness };
}

/**
 * Resolve an account selector using the v1-compatible precedence:
 *
 *  1. exact id, then exact label
 *  2. one unique id/label substring
 *  3. if the full selector did not resolve, interpret `<harness>-<query>` and
 *     repeat inside that harness (for example `claude-gmail`)
 *
 * Matching is case-insensitive and ambiguity is returned explicitly. The
 * caller decides which typed transport/domain error to expose.
 */
export function matchAccount<T extends AccountMatchCandidate>(
  accounts: readonly T[],
  selector: string,
): AccountMatchResult<T> {
  const direct = matchInPool(accounts, selector, null);
  if (direct.ok) return direct;

  const raw = selector.trim();
  const dash = raw.indexOf("-");
  if (dash <= 0 || dash === raw.length - 1) return direct;
  const prefix = normalized(raw.slice(0, dash));
  const scoped = accounts.filter((account) => normalized(account.harness) === prefix);
  if (scoped.length === 0) return direct;

  // Like v1, the harness shorthand is a fallback even when the full token was
  // ambiguous: explicit scoping may be exactly what disambiguates it.
  const shorthand = matchInPool(scoped, raw.slice(dash + 1), scoped[0]!.harness);
  return !shorthand.ok && shorthand.reason === "not_found" ? direct : shorthand;
}
