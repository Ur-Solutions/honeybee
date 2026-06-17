import assert from "node:assert/strict";
import { test } from "node:test";
import { exhaustionForAgent } from "../src/drivers.js";

test("opencode/grok/kimi exhaustion matchers fire on limit panes and stay null on normal ones", () => {
  // opencode — conservative: usage limit | rate limit | quota reached/exceeded.
  const oc = exhaustionForAgent("opencode", "❯ ...\nProvider error: usage limit reached. Resets at 7pm.");
  assert.ok(oc, "opencode usage-limit pane matches");
  assert.match(oc!.resetHint ?? "", /Resets at 7pm/i);
  assert.ok(exhaustionForAgent("opencode", "Error: quota exceeded for this provider"), "opencode quota exceeded matches");
  assert.ok(exhaustionForAgent("opencode", "429 rate limit hit"), "opencode rate limit matches");
  assert.equal(exhaustionForAgent("opencode", "Ask anything\n❯ all good"), null, "opencode normal pane -> null");

  // grok — rate limit | usage limit reached.
  assert.ok(exhaustionForAgent("grok", "rate limit exceeded, try again in 5 minutes"), "grok rate limit matches");
  const grokHit = exhaustionForAgent("grok", "usage limit reached. Try again in 2 hours.");
  assert.ok(grokHit, "grok usage limit reached matches");
  assert.match(grokHit!.resetHint ?? "", /Try again in 2 hours/i);
  assert.equal(exhaustionForAgent("grok", "Grok Build\n❯ ready"), null, "grok normal pane -> null");

  // kimi — usage limit | quota reached/exceeded.
  assert.ok(exhaustionForAgent("kimi", "You have hit your usage limit"), "kimi usage limit matches");
  assert.ok(exhaustionForAgent("kimi", "quota reached for kimi-for-coding"), "kimi quota reached matches");
  assert.equal(exhaustionForAgent("kimi", "context: 12.3%\nNext-Gen Agents"), null, "kimi normal pane -> null");
});

test("the conservative patterns do not false-positive on benign phrasing", () => {
  // Mentions of "limit" without the rate/usage/quota framing must not trip.
  assert.equal(exhaustionForAgent("opencode", "set the token limit to 4000"), null);
  assert.equal(exhaustionForAgent("grok", "the speed limit is 60"), null);
  assert.equal(exhaustionForAgent("kimi", "no limit on creativity here"), null);

  // "usage limit" with a NON-exhaustion verb must not trip — the limit phrase
  // needs an adjacent reached/hit/exceeded, not just any sentence mentioning it.
  assert.equal(exhaustionForAgent("opencode", "To increase your usage limit, upgrade your plan"), null);
  assert.equal(exhaustionForAgent("kimi", "Learn about your usage limit in settings"), null);
  // ...but the genuine exhaustion phrasings still fire (verb before or after).
  assert.ok(exhaustionForAgent("kimi", "You have hit your usage limit"));
  assert.ok(exhaustionForAgent("opencode", "usage limit reached"));
});
