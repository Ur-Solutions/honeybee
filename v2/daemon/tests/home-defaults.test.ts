import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_HOME_DEFAULT_MODEL,
  CLAUDE_HOME_DEFAULT_OUTPUT_STYLE,
  withClaudeSettingsDefaults,
} from "../src/homeDefaults.ts";

test("claude settings defaults seed Concise outputStyle when absent", () => {
  const next = JSON.parse(withClaudeSettingsDefaults(`{\n  "model": "opus"\n}`)) as Record<string, unknown>;
  assert.equal(next.model, "opus", "explicit model is left alone");
  assert.equal(next.skipDangerousModePermissionPrompt, true);
  assert.equal(next.outputStyle, CLAUDE_HOME_DEFAULT_OUTPUT_STYLE);
});

test("claude settings defaults do not clobber an explicit outputStyle", () => {
  const next = JSON.parse(
    withClaudeSettingsDefaults(`{\n  "outputStyle": "Explanatory",\n  "theme": "dark"\n}`),
  ) as Record<string, unknown>;
  assert.equal(next.outputStyle, "Explanatory");
  assert.equal(next.theme, "dark");
  assert.equal(next.model, CLAUDE_HOME_DEFAULT_MODEL);
});

test("empty claude settings get the hive model and Concise outputStyle", () => {
  const next = JSON.parse(withClaudeSettingsDefaults("")) as Record<string, unknown>;
  assert.equal(next.model, CLAUDE_HOME_DEFAULT_MODEL);
  assert.equal(next.outputStyle, CLAUDE_HOME_DEFAULT_OUTPUT_STYLE);
  assert.equal(next.skipDangerousModePermissionPrompt, true);
});
