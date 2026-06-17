// Pure unit tests for the Linear adapter (WORKSPACES_AND_QUESTS_PRD §8.3, §16
// #6). The live Linear API CANNOT be exercised here (no token, no network in
// CI), so every test injects a STUB `fetchImpl`. We assert exactly the request
// the adapter BUILDS (endpoint, headers, GraphQL body/variables) and how it
// PARSES a stubbed response — the live network path is the operator's to verify
// with a real token. No test makes a real network call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiTokenLinearAdapter, isLinearIdentifier, loadLinearAdapter } from "../src/linear.js";

type Captured = { url: string; init: RequestInit; body: { query: string; variables: Record<string, unknown> } };

/**
 * Build a stub `fetch` that returns canned JSON payloads in order (one per call)
 * and records every request. A payload of `{ status }` simulates a non-2xx; a
 * payload of `{ throws: true }` simulates a transport failure.
 */
function stubFetch(payloads: Array<Record<string, unknown> | { status: number } | { throws: true }>): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const payload = payloads[i++] ?? {};
    const bodyStr = typeof init?.body === "string" ? init.body : "{}";
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(bodyStr) });
    if ("throws" in payload && payload.throws) throw new Error("network down");
    if ("status" in payload && typeof payload.status === "number") {
      return { ok: false, status: payload.status, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("isLinearIdentifier accepts well-formed identifiers and rejects junk", () => {
  for (const ok of ["ENG-1234", "A1-7", "ABC-1", "X9Z-42"]) assert.equal(isLinearIdentifier(ok), true, ok);
  for (const bad of ["eng-1234", "ENG_1234", "1234", "ENG-", "-1", "ENG 1", "../etc", ""]) {
    assert.equal(isLinearIdentifier(bad), false, bad);
  }
});

test("loadLinearAdapter is the offline gate: null without a key, an adapter with one", () => {
  assert.equal(loadLinearAdapter({}), null, "no LINEAR_API_KEY ⇒ null (offline)");
  assert.equal(loadLinearAdapter({ LINEAR_API_KEY: "   " }), null, "blank LINEAR_API_KEY ⇒ null");
  const adapter = loadLinearAdapter({ LINEAR_API_KEY: "lin_api_secret" });
  assert.ok(adapter, "a set LINEAR_API_KEY ⇒ an adapter");
  assert.equal(typeof adapter!.fetchIssue, "function");
  assert.equal(typeof adapter!.closeIssue, "function");
});

test("fetchIssue builds the expected GraphQL POST and parses the issue", async () => {
  const { fetchImpl, calls } = stubFetch([
    { data: { issue: { id: "uuid-1", identifier: "ENG-1234", title: "Fix the parser", description: "details", url: "https://linear.app/x/ENG-1234" } } },
  ]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "lin_secret", fetchImpl });
  const issue = await adapter.fetchIssue("ENG-1234");

  // Request construction.
  assert.equal(calls.length, 1, "exactly one request");
  assert.equal(calls[0]!.url, "https://api.linear.app/graphql", "POSTs to the GraphQL endpoint");
  assert.equal((calls[0]!.init.method ?? "").toUpperCase(), "POST");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "lin_secret", "token goes verbatim in Authorization (no Bearer)");
  assert.match(headers["content-type"], /application\/json/);
  assert.match(calls[0]!.body.query, /issue\(id: \$id\)/, "queries issue(id: $id)");
  assert.deepEqual(calls[0]!.body.variables, { id: "ENG-1234" }, "passes the identifier as $id");

  // Response parsing.
  assert.deepEqual(issue, {
    id: "uuid-1",
    identifier: "ENG-1234",
    title: "Fix the parser",
    description: "details",
    url: "https://linear.app/x/ENG-1234",
  });
});

test("fetchIssue returns null (no throw) on a GraphQL error", async () => {
  const { fetchImpl } = stubFetch([{ errors: [{ message: "Entity not found" }] }]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.fetchIssue("ENG-9999"), null, "GraphQL error ⇒ null, no throw");
});

test("fetchIssue returns null (no throw) on a not-found (null issue) response", async () => {
  const { fetchImpl } = stubFetch([{ data: { issue: null } }]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.fetchIssue("ENG-9999"), null, "null issue ⇒ null, no throw");
});

test("fetchIssue returns null (no throw) on a transport failure", async () => {
  const { fetchImpl } = stubFetch([{ throws: true }]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.fetchIssue("ENG-1"), null, "network failure ⇒ null, no throw");
});

test("fetchIssue rejects a bad identifier BEFORE any fetch", async () => {
  const { fetchImpl, calls } = stubFetch([{ data: { issue: { id: "x" } } }]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.fetchIssue("not-an-id"), null, "bad id ⇒ null");
  assert.equal(calls.length, 0, "no network call was made for a bad identifier");
});

test("closeIssue resolves states then issueUpdates, returns true on success", async () => {
  const { fetchImpl, calls } = stubFetch([
    {
      data: {
        issue: {
          id: "uuid-1",
          team: {
            states: {
              nodes: [
                { id: "s-backlog", name: "Backlog", type: "backlog" },
                { id: "s-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      },
    },
    { data: { issueUpdate: { success: true } } },
  ]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  const ok = await adapter.closeIssue("ENG-1234");
  assert.equal(ok, true);

  assert.equal(calls.length, 2, "a state-resolution query then an update mutation");
  // Step 1: state resolution, keyed by the human identifier.
  assert.match(calls[0]!.body.query, /states/, "first call resolves workflow states");
  assert.deepEqual(calls[0]!.body.variables, { id: "ENG-1234" });
  // Step 2: issueUpdate against the RESOLVED internal id with the completed state.
  assert.match(calls[1]!.body.query, /issueUpdate/, "second call is the issueUpdate mutation");
  assert.deepEqual(calls[1]!.body.variables, { id: "uuid-1", stateId: "s-done" }, "updates the internal id to the completed state");
});

test("closeIssue picks a state literally named Done when no completed-type exists", async () => {
  const { fetchImpl, calls } = stubFetch([
    {
      data: {
        issue: {
          id: "uuid-2",
          team: { states: { nodes: [{ id: "s-x", name: "done", type: "custom" }] } },
        },
      },
    },
    { data: { issueUpdate: { success: true } } },
  ]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.closeIssue("ENG-7"), true);
  assert.deepEqual(calls[1]!.body.variables, { id: "uuid-2", stateId: "s-x" }, "falls back to the Done-named state");
});

test("closeIssue returns false (no throw) when no completed state exists", async () => {
  const { fetchImpl, calls } = stubFetch([
    { data: { issue: { id: "uuid-3", team: { states: { nodes: [{ id: "s-a", name: "Backlog", type: "backlog" }] } } } } },
  ]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.closeIssue("ENG-3"), false, "no completed/Done state ⇒ false");
  assert.equal(calls.length, 1, "never reaches the update mutation");
});

test("closeIssue returns false (no throw) when issueUpdate does not succeed", async () => {
  const { fetchImpl } = stubFetch([
    { data: { issue: { id: "uuid-4", team: { states: { nodes: [{ id: "s-done", name: "Done", type: "completed" }] } } } } },
    { data: { issueUpdate: { success: false } } },
  ]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.closeIssue("ENG-4"), false, "issueUpdate success:false ⇒ false");
});

test("closeIssue returns false (no throw) on an API error during resolution", async () => {
  const { fetchImpl } = stubFetch([{ errors: [{ message: "rate limited" }] }]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.closeIssue("ENG-5"), false, "GraphQL error on resolve ⇒ false");
});

test("closeIssue returns false (no throw) on a non-2xx during update", async () => {
  const { fetchImpl } = stubFetch([
    { data: { issue: { id: "uuid-6", team: { states: { nodes: [{ id: "s-done", name: "Done", type: "completed" }] } } } } },
    { status: 500 },
  ]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.closeIssue("ENG-6"), false, "HTTP 500 on update ⇒ false");
});

test("closeIssue rejects a bad identifier BEFORE any fetch", async () => {
  const { fetchImpl, calls } = stubFetch([{ data: { issue: { id: "x" } } }]);
  const adapter = createApiTokenLinearAdapter({ apiKey: "k", fetchImpl });
  assert.equal(await adapter.closeIssue("garbage"), false);
  assert.equal(calls.length, 0, "no network call for a bad identifier");
});
