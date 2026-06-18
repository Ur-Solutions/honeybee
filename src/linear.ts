/**
 * Linear adapter (WORKSPACES_AND_QUESTS_PRD §8.3, §13, §16 decision #6) — the
 * ONLY Linear-aware module in hive. Everything else (cli.ts) talks to the
 * `LinearAdapter` interface, never to Linear directly, so hive core has no hard
 * dependency on Linear and works fully offline.
 *
 * TRANSPORT — API token. The PRD's open-question #6 names an MCP-backed default
 * with an API-token fallback; the operator chose the API-token transport because
 * a standalone CLI process cannot drive the Linear MCP itself (the MCP is a
 * Claude-side connection). So this module ships ONLY the API-token adapter. It
 * POSTs GraphQL to https://api.linear.app/graphql with `Authorization: <token>`.
 *
 * INJECTABLE FETCH — the live Linear API CANNOT be exercised here (no token in
 * CI, no network in tests). To keep the query/mutation CONSTRUCTION, the
 * response PARSING and the offline/no-adapter path all unit-testable, the
 * adapter is built around an injectable `fetchImpl` (defaulting to global
 * `fetch`). Tests pass a stub `fetchImpl`; the live network path is the
 * operator's to verify with a real token. We do NOT claim the live calls are
 * tested — only the request we build and the way we parse a stubbed response.
 *
 * SIDE-EFFECT-GATED & BEST-EFFORT — `fetchIssue` (a READ) runs only on
 * `quest create --linear`; `closeIssue` (a WRITE) runs only on
 * `quest done --close-linear`. Neither ever throws on a normal API/network
 * failure: `fetchIssue` returns null and `closeIssue` returns false (each with a
 * dim warning), because a Linear hiccup must never break `quest create`/`done`.
 */
import { dim } from "./format.js";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url?: string;
}

export interface LinearAdapter {
  /** Fetch an issue by its human identifier (e.g. "ENG-1234"). null = miss/error. */
  fetchIssue(identifier: string): Promise<LinearIssue | null>;
  /** Transition an issue to a completed state. true = done, false = best-effort fail. */
  closeIssue(identifier: string): Promise<boolean>;
}

/** Linear's GraphQL endpoint. */
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/**
 * A Linear human identifier: an uppercase team key, then `-`, then a number
 * (e.g. "ENG-1234", "A1-7"). Validated BEFORE any network call so obviously-bad
 * input is rejected cleanly (and never reaches the API).
 */
const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export function isLinearIdentifier(value: string): boolean {
  return LINEAR_IDENTIFIER_RE.test(value);
}

export type LinearAdapterOptions = {
  apiKey: string;
  /**
   * Injectable transport (defaults to the global `fetch`). This is the seam that
   * makes the adapter unit-testable without a token or the network.
   */
  fetchImpl?: typeof fetch;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

/** Emit a dim, single-line warning to stderr (never throws). */
function warn(message: string): void {
  console.error(dim(`hive: linear: ${message}`));
}

/**
 * The API-token adapter. Best-effort by construction: every public method
 * swallows transport/GraphQL errors into a null/false result + a dim warning so
 * a Linear failure can never break a quest operation.
 */
class ApiTokenLinearAdapter implements LinearAdapter {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LinearAdapterOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * POST a GraphQL operation. Returns the typed `data` on success, or null on a
   * transport error, a non-2xx status, malformed JSON, or GraphQL `errors`.
   * NEVER throws — callers map null to their own miss/fail outcome.
   */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Linear's API expects the token verbatim in Authorization (no "Bearer ").
          authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      warn(`request failed: ${(error as Error).message}`);
      return null;
    }
    if (!response.ok) {
      warn(`HTTP ${response.status} from Linear`);
      return null;
    }
    let payload: GraphQLResponse<T>;
    try {
      payload = (await response.json()) as GraphQLResponse<T>;
    } catch (error) {
      warn(`could not parse response: ${(error as Error).message}`);
      return null;
    }
    if (payload.errors && payload.errors.length > 0) {
      warn(payload.errors.map((e) => e.message ?? "unknown error").join("; "));
      return null;
    }
    return payload.data ?? null;
  }

  async fetchIssue(identifier: string): Promise<LinearIssue | null> {
    if (!isLinearIdentifier(identifier)) {
      warn(`not a Linear identifier: ${identifier}`);
      return null;
    }
    // ASSUMPTION (untestable here without a token): Linear's `issue(id: $id)`
    // query accepts a HUMAN IDENTIFIER ("ENG-1234"), not just the internal UUID
    // — this is documented Linear API behaviour. If a future Linear API change
    // breaks that, switch to the `issues(filter: { ... })` search variant.
    // closeIssue does its OWN independent state-resolution query; this read does
    // not fetch the team.
    const data = await this.graphql<{ issue: RawIssue | null }>(
      `query IssueByIdentifier($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
  }
}`,
      { id: identifier },
    );
    if (!data || !data.issue) {
      // A null issue is a normal "not found" — not an error to throw on.
      if (data) warn(`issue not found: ${identifier}`);
      return null;
    }
    return normalizeIssue(data.issue);
  }

  async closeIssue(identifier: string): Promise<boolean> {
    if (!isLinearIdentifier(identifier)) {
      warn(`not a Linear identifier: ${identifier}`);
      return false;
    }
    // Step 1: resolve the issue's internal id + its team's workflow states. We
    // need the team's states because the "completed" state id is per-team.
    const resolved = await this.graphql<{ issue: RawIssueWithStates | null }>(
      `query IssueStates($id: String!) {
  issue(id: $id) {
    id
    team {
      states {
        nodes {
          id
          name
          type
        }
      }
    }
  }
}`,
      { id: identifier },
    );
    if (!resolved || !resolved.issue) {
      warn(`could not resolve issue to close: ${identifier}`);
      return false;
    }
    const states = resolved.issue.team?.states?.nodes ?? [];
    const completed = pickCompletedState(states);
    if (!completed) {
      warn(`no completed workflow state found for ${identifier}`);
      return false;
    }
    // Step 2: transition the issue to the completed state.
    const updated = await this.graphql<{ issueUpdate: { success?: boolean } | null }>(
      `mutation CloseIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}`,
      { id: resolved.issue.id, stateId: completed.id },
    );
    if (!updated || !updated.issueUpdate || updated.issueUpdate.success !== true) {
      warn(`issueUpdate did not succeed for ${identifier}`);
      return false;
    }
    return true;
  }
}

type RawIssue = {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
};

type RawState = { id?: unknown; name?: unknown; type?: unknown };

type RawIssueWithStates = {
  id?: unknown;
  team?: { states?: { nodes?: RawState[] } } | null;
};

/** Parse a raw GraphQL issue into a LinearIssue (string-coerce, drop blanks). */
function normalizeIssue(raw: RawIssue): LinearIssue {
  const issue: LinearIssue = {
    id: typeof raw.id === "string" ? raw.id : "",
    identifier: typeof raw.identifier === "string" ? raw.identifier : "",
    title: typeof raw.title === "string" ? raw.title : "",
  };
  if (typeof raw.description === "string" && raw.description.length > 0) issue.description = raw.description;
  if (typeof raw.url === "string" && raw.url.length > 0) issue.url = raw.url;
  return issue;
}

/**
 * Pick the workflow state to transition to: the first state of type "completed",
 * else a state literally named "Done" (case-insensitive). Returns undefined when
 * neither exists (caller treats that as a best-effort fail).
 */
function pickCompletedState(states: RawState[]): { id: string } | undefined {
  const valid = states.filter(
    (s): s is { id: string; name: string; type: string } =>
      typeof s.id === "string" && typeof s.name === "string" && typeof s.type === "string",
  );
  const byType = valid.find((s) => s.type === "completed");
  if (byType) return { id: byType.id };
  const byName = valid.find((s) => s.name.toLowerCase() === "done");
  return byName ? { id: byName.id } : undefined;
}

/** Construct the API-token adapter directly (used by tests with a stub fetch). */
export function createApiTokenLinearAdapter(options: LinearAdapterOptions): LinearAdapter {
  return new ApiTokenLinearAdapter(options);
}

/**
 * The single offline-safe gate. Returns the API-token adapter when
 * `LINEAR_API_KEY` is set (read from `env` ?? `process.env`), else null. A null
 * return means "Linear is not configured" — callers MUST treat that as the
 * offline no-op (record the id, no enrichment / nothing to close), never an
 * error. This is the one place that decides whether Linear is wired at all.
 */
export function loadLinearAdapter(env: NodeJS.ProcessEnv = process.env): LinearAdapter | null {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) return null;
  // TEST-ONLY seam (mirrors HIVE_TMUX_SOCKET / HIVE_CLAUDE_CMD): with a key set,
  // HIVE_LINEAR_FIXTURE swaps the live GraphQL adapter for a canned one so the
  // CLI wiring (create-seeding, done close-back) is exercised end-to-end with no
  // network. The API-token adapter's GraphQL protocol stays covered by the
  // injected-fetchImpl unit tests; this only stands in for the transport.
  const fixture = env.HIVE_LINEAR_FIXTURE;
  if (fixture && fixture.trim().length > 0) return createFixtureLinearAdapter(fixture);
  return createApiTokenLinearAdapter({ apiKey: apiKey.trim() });
}

/**
 * TEST-ONLY adapter built from a JSON fixture (the value of HIVE_LINEAR_FIXTURE):
 *   { "issue": { "id","identifier","title","description?","url?" } | null,
 *     "close": true|false }
 * fetchIssue returns the fixture issue (or null = miss); closeIssue returns the
 * fixture's `close` boolean. Never touches the network. A malformed fixture
 * degrades to a miss/false, mirroring the live adapter's best-effort contract.
 */
function createFixtureLinearAdapter(raw: string): LinearAdapter {
  let spec: { issue?: LinearIssue | null; close?: boolean } = {};
  try {
    spec = JSON.parse(raw) as typeof spec;
  } catch {
    // malformed fixture → behave like a configured-but-empty adapter
  }
  return {
    async fetchIssue(): Promise<LinearIssue | null> {
      return spec.issue ?? null;
    },
    async closeIssue(): Promise<boolean> {
      return spec.close === true;
    },
  };
}
