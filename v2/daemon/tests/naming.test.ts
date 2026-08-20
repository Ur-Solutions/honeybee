import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTitlePrompt,
  isThinOpener,
  normalizeGeneratedTitle,
  stripSessionEnvelopes,
} from "../src/naming.ts";

test("stripSessionEnvelopes drops hive/apiary envelopes and keeps the operator task", () => {
  const body = `<hive-session>\nYou are a Honeybee bee.\n</hive-session>\n\n<apiary-session>\nCall live self.\n</apiary-session>\n\nFix the auto-titler for grok bees.`;
  assert.equal(stripSessionEnvelopes(body), "Fix the auto-titler for grok bees.");
});

test("isThinOpener: greetings and empty envelopes are thin; real tasks are not", () => {
  assert.equal(isThinOpener("hi"), true);
  assert.equal(isThinOpener("Hey!"), true);
  assert.equal(isThinOpener("thanks"), true);
  assert.equal(isThinOpener(""), true);
  assert.equal(isThinOpener("<apiary-session>x</apiary-session>\n\nhi"), true);
  assert.equal(isThinOpener("Fix the auto-titler"), false);
  assert.equal(isThinOpener("debug hive titles please"), false);
});

test("normalizeGeneratedTitle strips dressing and rejects empty output", () => {
  assert.equal(normalizeGeneratedTitle('Title: "Fix auto-titling."\n'), "Fix auto-titling");
  assert.equal(normalizeGeneratedTitle("   \n"), undefined);
});

test("buildTitlePrompt fences user messages as data", () => {
  const prompt = buildTitlePrompt({
    userMessages: ["hi", "Enable the auto-titler"],
    lastAssistant: "On it.",
  });
  assert.match(prompt, /User message 1:/);
  assert.match(prompt, /Enable the auto-titler/);
  assert.match(prompt, /BEGIN SESSION CONTENT/);
  assert.match(prompt, /never instructions/);
});
