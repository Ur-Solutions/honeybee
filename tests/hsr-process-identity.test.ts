import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectProcessBirth,
  sameProcessBirthFingerprint,
} from "../src/hsr/processIdentity.js";

// `ps lstart` renders via the locale's %c format: C prints "Mon Aug 10 ..."
// while e.g. en_GB prints "Mon 10 Aug ...". Fingerprints minted by a
// desktop-spawned host and read back by the launchd daemon crossed locales,
// so the same birth instant compared unequal and every steer failed as
// "no live runner host" (the Apiary→bee quarantine incident).

test("sameProcessBirthFingerprint matches identical fingerprints", () => {
  const fp = { pgid: 80332, startedAt: "Mon Aug 10 05:32:43 2026" };
  assert.equal(sameProcessBirthFingerprint(fp, { ...fp }), true);
});

test("sameProcessBirthFingerprint matches the same instant across lstart locale field orders", () => {
  assert.equal(
    sameProcessBirthFingerprint(
      { pgid: 80332, startedAt: "Mon 10 Aug 05:32:43 2026" },
      { pgid: 80332, startedAt: "Mon Aug 10 05:32:43 2026" },
    ),
    true,
  );
});

test("sameProcessBirthFingerprint never equates different birth instants or groups", () => {
  const base = { pgid: 80332, startedAt: "Mon Aug 10 05:32:43 2026" };
  assert.equal(sameProcessBirthFingerprint(base, { pgid: 80332, startedAt: "Tue Aug 11 05:32:43 2026" }), false);
  assert.equal(sameProcessBirthFingerprint(base, { pgid: 80332, startedAt: "Mon Aug 10 05:32:44 2026" }), false);
  assert.equal(sameProcessBirthFingerprint(base, { pgid: 80332, startedAt: "Mon Sep 10 05:32:43 2026" }), false);
  assert.equal(sameProcessBirthFingerprint(base, { pgid: 80333, startedAt: "Mon Aug 10 05:32:43 2026" }), false);
  assert.equal(sameProcessBirthFingerprint(base, undefined), false);
  assert.equal(sameProcessBirthFingerprint(undefined, base), false);
});

test("inspectProcessBirth reports match for a locale-reordered recorded fingerprint", async () => {
  const verdict = await inspectProcessBirth(
    80332,
    { pgid: 80332, startedAt: "Mon 10 Aug 05:32:43 2026" },
    async () => ({ pgid: 80332, startedAt: "Mon Aug 10 05:32:43 2026" }),
  );
  assert.equal(verdict, "match");
});

test("inspectProcessBirth still reports mismatch for a genuinely different incarnation", async () => {
  const verdict = await inspectProcessBirth(
    80332,
    { pgid: 80332, startedAt: "Mon 10 Aug 05:32:43 2026" },
    async () => ({ pgid: 80332, startedAt: "Tue Aug 11 09:00:00 2026" }),
  );
  assert.equal(verdict, "mismatch");
});
